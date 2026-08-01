"""Camera platform for Wisenet WAVE with native WebRTC support."""
import urllib.parse
import logging
import json
import asyncio
import aiohttp

from homeassistant.components.camera import Camera, CameraEntityFeature
from homeassistant.components.camera.webrtc import (
    RTCIceCandidateInit,
    WebRTCAnswer,
    WebRTCCandidate,
    WebRTCError,
    WebRTCSendMessage,
)
from homeassistant.config_entries import ConfigEntry
from homeassistant.core import HomeAssistant, callback
from homeassistant.helpers.entity import DeviceInfo

from .const import DOMAIN, CONF_STREAM_TYPE, STREAM_TYPE_WEBRTC, STREAM_TYPE_RTSP

_LOGGER = logging.getLogger(__name__)

# Wie lange wir maximal auf die SDP-Answer vom WAVE-Server warten, bevor wir
# dem Frontend einen Fehler statt eines endlosen Standbilds melden.
WEBRTC_ANSWER_TIMEOUT = 8


def _sdp_parse_sections(sdp: str) -> tuple[list[str], list[list[str]]]:
    """Split an SDP string into (session-level lines, list of m= blocks)."""
    lines = sdp.replace("\r\n", "\n").split("\n")
    session_lines: list[str] = []
    m_blocks: list[list[str]] = []
    current: list[str] | None = None
    for line in lines:
        if line.startswith("m="):
            if current is not None:
                m_blocks.append(current)
            current = [line]
        elif current is not None:
            current.append(line)
        else:
            session_lines.append(line)
    if current is not None:
        m_blocks.append(current)
    return session_lines, m_blocks


def _sdp_media_type(block: list[str]) -> str:
    return block[0][2:].split(" ", 1)[0]


def _sdp_mid(block: list[str]) -> str | None:
    for line in block:
        if line.startswith("a=mid:"):
            return line[len("a=mid:"):].strip()
    return None


def _sdp_with_mid(block: list[str], new_mid: str) -> list[str]:
    out = []
    replaced = False
    for line in block:
        if line.startswith("a=mid:"):
            out.append(f"a=mid:{new_mid}")
            replaced = True
        else:
            out.append(line)
    if not replaced:
        out.append(f"a=mid:{new_mid}")
    return out


def _sdp_fix_setup_for_answer(block: list[str]) -> list[str]:
    """An SDP answer's a=setup must be 'active' or 'passive', never 'actpass'
    (that's only legal in an offer). Wisenet WAVE always emits 'actpass'
    since it builds its SDP the same way regardless of role. Since WAVE
    declares itself ice-lite (the passive/server side), we pin it to
    'passive' so the browser (active) initiates the DTLS handshake.
    """
    out = []
    for line in block:
        if line.strip().lower() == "a=setup:actpass":
            out.append("a=setup:passive")
        else:
            out.append(line)
    return out


def _sdp_rejected_block(media_type: str, mid: str) -> list[str]:
    proto = "UDP/TLS/RTP/SAVPF" if media_type in ("video", "audio") else "UDP/DTLS/SCTP"
    fmt = "0" if media_type in ("video", "audio") else "webrtc-datachannel"
    return [
        f"m={media_type} 0 {proto} {fmt}",
        "c=IN IP4 0.0.0.0",
        f"a=mid:{mid}",
        "a=setup:passive",
        "a=inactive",
    ]


def _align_answer_to_offer(offer_sdp: str, answer_sdp: str) -> str:
    """Reorder/filter the m= sections of `answer_sdp` to exactly match the
    count, order and mid values of `offer_sdp`'s m= sections.

    Wisenet WAVE builds its SDP independently of the offer it receives
    (e.g. it always includes a datachannel m-line even if the browser never
    asked for one), which browsers reject with "order of m-lines in answer
    doesn't match order in offer". This rebuilds a spec-compliant answer.
    """
    try:
        _, offer_blocks = _sdp_parse_sections(offer_sdp)
        answer_session, answer_blocks = _sdp_parse_sections(answer_sdp)

        remaining_by_type: dict[str, list[list[str]]] = {}
        for block in answer_blocks:
            remaining_by_type.setdefault(_sdp_media_type(block), []).append(block)

        aligned_blocks: list[list[str]] = []
        used_mids: list[str] = []
        for offer_block in offer_blocks:
            media_type = _sdp_media_type(offer_block)
            offer_mid = _sdp_mid(offer_block)
            pool = remaining_by_type.get(media_type, [])
            if pool:
                chosen = pool.pop(0)
                mid_val = offer_mid if offer_mid is not None else _sdp_mid(chosen)
                if offer_mid is not None:
                    chosen = _sdp_with_mid(chosen, offer_mid)
                chosen = _sdp_fix_setup_for_answer(chosen)
                aligned_blocks.append(chosen)
            else:
                mid_val = offer_mid if offer_mid is not None else str(len(aligned_blocks))
                aligned_blocks.append(_sdp_rejected_block(media_type, mid_val))
            used_mids.append(mid_val)

        new_session = []
        for line in answer_session:
            if line.startswith("a=group:BUNDLE"):
                new_session.append("a=group:BUNDLE " + " ".join(used_mids))
            else:
                new_session.append(line)

        result_lines = new_session + [l for block in aligned_blocks for l in block]
        return "\r\n".join(result_lines) + "\r\n"
    except Exception:
        # If anything about the SDP shape surprises us, fall back to the
        # original answer rather than breaking the whole connection attempt.
        _LOGGER.exception("Failed to align Wisenet WAVE answer SDP to offer, using it unmodified")
        return answer_sdp


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
        # Session_id als Key, True sobald für diese Session eine SDP-Answer kam
        self._answered_sessions: dict[str, bool] = {}
        # Session_id als Key, ursprünglicher Browser-Offer (für SDP-Angleichung)
        self._offers: dict[str, str] = {}

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
        self._answered_sessions[session_id] = False
        self._offers[session_id] = offer_sdp

        # 2. Send the SDP Offer via JSON
        # WICHTIG: Wisenet WAVE erwartet SDP-Nachrichten NICHT flach als
        # {"type": ..., "sdp": ...}, sondern verpackt unter dem Key "sdp".
        offer_payload = {
            "sdp": {
                "type": "offer",
                "sdp": offer_sdp
            }
        }
        _LOGGER.debug("Sending WebRTC offer to WAVE for camera %s (session %s)", self._cam_id, session_id)
        _LOGGER.debug("Browser offer SDP for session %s:\n%s", session_id, offer_sdp)
        await ws.send_json(offer_payload)

        # 3. Start a background task to listen for the Answer and ICE candidates
        self.hass.async_create_task(self._listen_to_webrtc_websocket(session_id, ws, send_message))

        # 4. Watchdog: if no "answer" arrives in time, the WAVE server likely
        # rejected the stream profile silently (e.g. resolution/bitrate/codec
        # not supported by its WebRTC gateway). Without this, the frontend
        # just keeps showing the last still image forever with no error.
        self.hass.async_create_task(self._watch_for_answer_timeout(session_id, send_message))

    async def _watch_for_answer_timeout(
        self, session_id: str, send_message: WebRTCSendMessage
    ) -> None:
        """Abort with a visible error if no SDP answer shows up in time."""
        await asyncio.sleep(WEBRTC_ANSWER_TIMEOUT)
        ws = self._active_sessions.get(session_id)
        if ws is not None and not self._answered_sessions.get(session_id, False):
            # Session is still open and was never cleaned up by a real answer/close
            # -> we timed out waiting for the answer.
            _LOGGER.error(
                "No WebRTC answer received from Wisenet WAVE for camera %s within %ss "
                "(session %s). The WAVE server likely accepted the WebSocket but never "
                "answered the offer - check if the current stream profile/resolution/"
                "codec for 'primary' is actually supported by its WebRTC gateway.",
                self._cam_id, WEBRTC_ANSWER_TIMEOUT, session_id,
            )
            send_message(WebRTCError("timeout", "No SDP answer received from Wisenet WAVE server in time"))
            self.close_webrtc_session(session_id)

    async def _listen_to_webrtc_websocket(
        self, session_id: str, ws: aiohttp.ClientWebSocketResponse, send_message: WebRTCSendMessage
    ) -> None:
        """Listen to incoming messages (Answer, Candidates) from the WAVE server."""
        got_answer = False
        try:
            async for msg in ws:
                if msg.type == aiohttp.WSMsgType.TEXT:
                    _LOGGER.debug("WebRTC WS message for camera %s: %s", self._cam_id, msg.data)
                    try:
                        data = json.loads(msg.data)

                        # Wisenet WAVE verpackt SDP unter "sdp" und ICE-Candidates
                        # unter "ice" (statt eines flachen {"type": ...} Objekts).
                        # WAVE labelt seine eigene SDP dabei intern immer als
                        # "offer" - inhaltlich ist es aber die Antwort auf unseren
                        # Browser-Offer (sendonly passend zu recvonly), daher wird
                        # der reine SDP-Text unabhängig vom "type"-Feld weitergegeben.
                        sdp_wrapper = data.get("sdp")
                        ice_wrapper = data.get("ice")

                        if isinstance(sdp_wrapper, dict) and "sdp" in sdp_wrapper:
                            got_answer = True
                            self._answered_sessions[session_id] = True
                            offer_sdp = self._offers.get(session_id, "")
                            aligned_sdp = _align_answer_to_offer(offer_sdp, sdp_wrapper["sdp"])
                            _LOGGER.debug(
                                "Aligned WAVE answer for session %s (offer m-lines=%d, "
                                "raw answer m-lines=%d, aligned m-lines=%d):\n%s",
                                session_id,
                                offer_sdp.count("\nm="),
                                sdp_wrapper["sdp"].count("\nm="),
                                aligned_sdp.count("m="),
                                aligned_sdp,
                            )
                            send_message(WebRTCAnswer(aligned_sdp))

                        elif isinstance(ice_wrapper, dict) and "candidate" in ice_wrapper:
                            sdp_mid = ice_wrapper.get("sdpMid")
                            send_message(
                                WebRTCCandidate(
                                    RTCIceCandidateInit(
                                        ice_wrapper["candidate"],
                                        sdp_mid=str(sdp_mid) if sdp_mid is not None else None,
                                        sdp_m_line_index=ice_wrapper.get("sdpMLineIndex") or 0,
                                    )
                                )
                            )

                        # Fallback: falls doch mal das flache Format kommt (z.B.
                        # ältere WAVE-Version oder andere Endpunkte).
                        elif data.get("type") == "answer" and "sdp" in data:
                            got_answer = True
                            self._answered_sessions[session_id] = True
                            offer_sdp = self._offers.get(session_id, "")
                            aligned_sdp = _align_answer_to_offer(offer_sdp, data["sdp"])
                            send_message(WebRTCAnswer(aligned_sdp))

                        elif data.get("type") == "candidate" and "candidate" in data:
                            fallback_mid = data.get("sdpMid")
                            send_message(
                                WebRTCCandidate(
                                    RTCIceCandidateInit(
                                        data["candidate"],
                                        sdp_mid=str(fallback_mid) if fallback_mid is not None else None,
                                        sdp_m_line_index=data.get("sdpMLineIndex"),
                                    )
                                )
                            )

                        elif data.get("type") == "error" or "error" in data:
                            _LOGGER.error("WebRTC Server Error for %s: %s", self._cam_id, data)
                            send_message(WebRTCError("webrtc_error", str(data.get("error", "Unknown error"))))

                    except json.JSONDecodeError:
                        _LOGGER.debug("Received non-JSON message on WebRTC WS for %s", self._cam_id)

                elif msg.type in (aiohttp.WSMsgType.CLOSED, aiohttp.WSMsgType.ERROR):
                    if not got_answer:
                        _LOGGER.error(
                            "WebRTC WS for camera %s closed/errored before any SDP answer "
                            "was received (session %s) - close_code=%s",
                            self._cam_id, session_id, getattr(ws, "close_code", None),
                        )
                    else:
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
            # HA's RTCIceCandidateInit uses snake_case (sdp_m_line_index, sdp_mid)
            # in newer Core versions, older ones used camelCase - support both.
            sdp_m_line_index = getattr(candidate, "sdp_m_line_index", None)
            if sdp_m_line_index is None:
                sdp_m_line_index = getattr(candidate, "sdpMLineIndex", None)
            sdp_mid = getattr(candidate, "sdp_mid", None)
            if sdp_mid is None:
                sdp_mid = getattr(candidate, "sdpMid", None)

            payload = {
                "ice": {
                    "candidate": candidate.candidate,
                    "sdpMLineIndex": sdp_m_line_index,
                    "sdpMid": sdp_mid
                }
            }
            try:
                await ws.send_json(payload)
            except Exception as err:
                _LOGGER.warning("Failed to send ICE candidate to WAVE for %s: %s", self._cam_id, err)

    @callback
    def close_webrtc_session(self, session_id: str) -> None:
        """Clean up when the frontend closes the WebRTC session or connection drops."""
        ws = self._active_sessions.pop(session_id, None)
        self._answered_sessions.pop(session_id, None)
        self._offers.pop(session_id, None)
        if ws and not ws.closed:
            # We schedule the closing so we don't block the callback
            self.hass.async_create_task(ws.close())