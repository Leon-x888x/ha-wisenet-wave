"""Camera platform for Wisenet WAVE with native WebRTC support."""
import urllib.parse
import logging
import json
import aiohttp

from homeassistant.components.camera import Camera, CameraEntityFeature
from homeassistant.components.camera.webrtc import WebRTCAnswer, WebRTCError, WebRTCSendMessage, WebRTCCandidate
from homeassistant.config_entries import ConfigEntry
from homeassistant.core import HomeAssistant, callback
from homeassistant.helpers.entity import DeviceInfo

from .const import DOMAIN, CONF_STREAM_TYPE, STREAM_TYPE_WEBRTC, STREAM_TYPE_RTSP

_LOGGER = logging.getLogger(__name__)


async def async_setup_entry(hass: HomeAssistant, entry: ConfigEntry, async_add_entities):
    """Set up camera entities from Wisenet WAVE API."""
    client = hass.data[DOMAIN][entry.entry_id]
    raw_cameras = await client.async_get_cameras()

    # Home Assistant erlaubt pro Kamera-Entität entweder natives WebRTC ODER den
    # RTSP/HLS-Weg (stream_source) - nicht beides gemischt in einer Klasse. Deshalb
    # wird hier je nach gewählter Option die passende Kamera-Klasse instanziiert.
    stream_type = entry.options.get(CONF_STREAM_TYPE, STREAM_TYPE_RTSP)
    camera_cls = WisenetWaveWebRTCCamera if stream_type == STREAM_TYPE_WEBRTC else WisenetWaveRTSPCamera

    entities = [camera_cls(client, cam, entry) for cam in raw_cameras]
    async_add_entities(entities)


class WisenetWaveCameraBase(Camera):
    """Shared logic for Wisenet WAVE cameras."""

    _attr_supported_features = CameraEntityFeature.STREAM

    def __init__(self, client, camera_info, entry: ConfigEntry):
        super().__init__()
        self.client = client
        self.cam_info = camera_info
        self.entry = entry
        self._cam_id = camera_info.get("id")
        self._attr_name = camera_info.get("name", "Wisenet Camera")
        self._attr_unique_id = f"wisenet_wave_{self._cam_id}"

    @property
    def device_info(self) -> DeviceInfo:
        """Connects entity to Home Assistant Device Registry."""
        return DeviceInfo(
            identifiers={(DOMAIN, self._cam_id)},
            name=self._attr_name,
            manufacturer=self.cam_info.get("vendor", "Hanwha / Wisenet"),
            model=self.cam_info.get("model", "WAVE Camera"),
        )

    async def async_camera_image(self, width=None, height=None) -> bytes | None:
        """Fetch thumbnail snapshot from camera via WAVE API using Bearer Token."""
        url = f"{self.client.base_url}/ec2/cameraThumbnail?cameraId={self._cam_id}"
        headers = await self.client._get_headers()
        try:
            async with self.client.session.get(url, headers=headers, timeout=5, ssl=False) as response:
                if response.status == 200:
                    return await response.read()
        except Exception:
            return None
        return None


class WisenetWaveRTSPCamera(WisenetWaveCameraBase):
    """RTSP-Variante: liefert eine Stream-Quelle, die HA per HLS (stream-Integration) ausspielt."""

    async def stream_source(self) -> str | None:
        """Return the RTSP stream URL for the camera.

        WICHTIG: Diese Methode muss exakt "stream_source" heißen (nicht
        "async_stream_source"), sonst erkennt Home Assistants Camera-Basisklasse
        die Überschreibung nicht und liefert immer None zurück!
        """
        # stream=primary fordert den nativen Hauptstream (hohe Qualität) an.
        safe_password = urllib.parse.quote(self.client.password)
        return f"rtsp://{self.client.username}:{safe_password}@{self.client.host}:{self.client.port}/{self._cam_id}?stream=primary"


class WisenetWaveWebRTCCamera(WisenetWaveCameraBase):
    """Native-WebRTC-Variante über V4 WebSocket Signalisierung."""

    def __init__(self, client, camera_info, entry: ConfigEntry):
        super().__init__(client, camera_info, entry)
        # Session_id als Key, WebSocket-Verbindung als Value
        self._active_sessions: dict[str, aiohttp.ClientWebSocketResponse] = {}

    async def async_handle_async_webrtc_offer(
        self, offer_sdp: str, session_id: str, send_message: WebRTCSendMessage
    ) -> None:
        """Handle the async WebRTC offer by sending it over a new WebSocket connection."""
        
        # 1. Open the WebSocket specifically for this stream
        ws = await self.client.async_get_webrtc_websocket(self._cam_id, stream="primary")
        if not ws:
            _LOGGER.error("Failed to open WebRTC WebSocket for camera %s", self._cam_id)
            send_message(WebRTCError("connection_failed", "Wisenet WAVE WebRTC WS connection failed"))
            return

        self._active_sessions[session_id] = ws

        # 2. Send the SDP Offer via JSON
        offer_payload = {
            "type": "offer",
            "sdp": offer_sdp
        }
        await ws.send_json(offer_payload)

        # 3. Start a background task to listen for the Answer and ICE candidates
        self.hass.async_create_task(self._listen_to_webrtc_websocket(session_id, ws, send_message))

    async def _listen_to_webrtc_websocket(
        self, session_id: str, ws: aiohttp.ClientWebSocketResponse, send_message: WebRTCSendMessage
    ) -> None:
        """Listen to incoming messages (Answer, Candidates) from the WAVE server."""
        try:
            async for msg in ws:
                if msg.type == aiohttp.WSMsgType.TEXT:
                    try:
                        data = json.loads(msg.data)
                        msg_type = data.get("type")

                        if msg_type == "answer" and "sdp" in data:
                            send_message(WebRTCAnswer(data["sdp"]))
                        
                        elif msg_type == "candidate" and "candidate" in data:
                            # Forward ICE candidates from Server to Home Assistant / Browser
                            # WebRTCCandidate signature requires checking if sdpMid/sdpMLineIndex are passed
                            send_message(
                                WebRTCCandidate(
                                    data["candidate"],
                                    data.get("sdpMLineIndex"),
                                    data.get("sdpMid")
                                )
                            )
                        elif msg_type == "error":
                            _LOGGER.error("WebRTC Server Error for %s: %s", self._cam_id, data)
                            send_message(WebRTCError("webrtc_error", str(data.get("error", "Unknown error"))))
                            
                    except json.JSONDecodeError:
                        _LOGGER.debug("Received non-JSON message on WebRTC WS for %s", self._cam_id)

                elif msg.type in (aiohttp.WSMsgType.CLOSED, aiohttp.WSMsgType.ERROR):
                    _LOGGER.debug("WebRTC WS closed/error for camera %s", self._cam_id)
                    break
        except Exception as err:
            _LOGGER.error("Exception in WebRTC WS listener for camera %s: %s", self._cam_id, err)
        finally:
            self.close_webrtc_session(session_id)

    async def async_on_webrtc_candidate(self, session_id: str, candidate) -> None:
        """Handle a WebRTC candidate from the HA frontend and send it to WAVE."""
        ws = self._active_sessions.get(session_id)
        if ws and not ws.closed:
            payload = {
                "type": "candidate",
                "candidate": candidate.candidate,
                "sdpMLineIndex": candidate.sdpMLineIndex,
                "sdpMid": candidate.sdpMid
            }
            try:
                await ws.send_json(payload)
            except Exception as err:
                _LOGGER.warning("Failed to send ICE candidate to WAVE for %s: %s", self._cam_id, err)

    @callback
    def close_webrtc_session(self, session_id: str) -> None:
        """Clean up when the frontend closes the WebRTC session or connection drops."""
        ws = self._active_sessions.pop(session_id, None)
        if ws and not ws.closed:
            # We schedule the closing so we don't block the callback
            self.hass.async_create_task(ws.close())