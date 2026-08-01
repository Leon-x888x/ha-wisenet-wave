"""Camera platform for Wisenet WAVE with native WebRTC support."""
import urllib.parse
import logging

from homeassistant.components.camera import Camera, CameraEntityFeature
from homeassistant.components.camera.webrtc import WebRTCAnswer, WebRTCError, WebRTCSendMessage
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
    # Ein Options-Wechsel löst bereits einen vollständigen Reload aus (siehe
    # __init__.py: update_listener), die Entitäten werden also korrekt neu erstellt.
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
        # stream=0 fordert den nativen Hauptstream (hohe Qualität) an, OHNE
        # serverseitiges Transcoding zu erzwingen (das "resolution"-Param tut das
        # und überlastet schwächere WAVE-Server, was zu Rucklern führt).
        safe_password = urllib.parse.quote(self.client.password)
        return f"rtsp://{self.client.username}:{safe_password}@{self.client.host}:{self.client.port}/{self._cam_id}?stream=0"


class WisenetWaveWebRTCCamera(WisenetWaveCameraBase):
    """Native-WebRTC-Variante (aktuelle Home-Assistant-API, ersetzt async_handle_web_rtc_offer)."""

    async def async_handle_async_webrtc_offer(
        self, offer_sdp: str, session_id: str, send_message: WebRTCSendMessage
    ) -> None:
        """Handle the async WebRTC offer by forwarding it to the Wisenet WAVE server."""
        answer_sdp = await self.client.async_send_webrtc_offer(self._cam_id, offer_sdp)
        if answer_sdp:
            send_message(WebRTCAnswer(answer_sdp))
        else:
            _LOGGER.error("Wisenet WAVE returned no WebRTC answer for camera %s", self._cam_id)
            send_message(
                WebRTCError(
                    "wisenet_wave_webrtc_failed",
                    "Wisenet WAVE server did not return a WebRTC answer",
                )
            )

    async def async_on_webrtc_candidate(self, session_id: str, candidate) -> None:
        """Handle a WebRTC candidate from the frontend.

        Der WAVE-Server tauscht SDP Offer/Answer in einem einzigen REST-Aufruf aus
        (non-trickle ICE) - es gibt daher keine einzeln nachzureichenden Candidates.
        """
        return

    @callback
    def close_webrtc_session(self, session_id: str) -> None:
        """Clean up when the frontend closes the WebRTC session."""
        return