"""Camera platform for Wisenet WAVE with native WebRTC support."""
import urllib.parse
from homeassistant.components.camera import Camera, CameraEntityFeature
from homeassistant.config_entries import ConfigEntry
from homeassistant.core import HomeAssistant
from homeassistant.helpers.entity import DeviceInfo

from .const import DOMAIN, CONF_STREAM_TYPE, STREAM_TYPE_WEBRTC, STREAM_TYPE_RTSP

async def async_setup_entry(hass: HomeAssistant, entry: ConfigEntry, async_add_entities):
    """Set up camera entities from Wisenet WAVE API."""
    client = hass.data[DOMAIN][entry.entry_id]
    raw_cameras = await client.async_get_cameras()

    entities = [WisenetWaveCamera(client, cam, entry) for cam in raw_cameras]
    async_add_entities(entities)

class WisenetWaveCamera(Camera):
    """Representation of a Wisenet WAVE camera."""

    def __init__(self, client, camera_info, entry: ConfigEntry):
        super().__init__()
        self.client = client
        self.cam_info = camera_info
        self.entry = entry
        self._cam_id = camera_info.get("id")
        self._attr_name = camera_info.get("name", "Wisenet Camera")
        self._attr_unique_id = f"wisenet_wave_{self._cam_id}"
        
        # Unterstützte Features aktivieren (Stream)
        self._attr_supported_features = CameraEntityFeature.STREAM

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

    async def async_stream_source(self) -> str | None:
        """Return the RTSP stream URL for the camera."""
        safe_password = urllib.parse.quote(self.client.password)
        return f"rtsp://{self.client.username}:{safe_password}@{self.client.host}:{self.client.port}/{self._cam_id}?resolution=high"

    async def async_handle_web_rtc_offer(self, offer_sdp: str) -> str | None:
        """Handle WebRTC SDP offer natively via Wisenet WAVE API."""
        # Prüfen, ob WebRTC in den Optionen aktiviert ist
        stream_type = self.entry.options.get(CONF_STREAM_TYPE, STREAM_TYPE_RTSP)
        
        if stream_type == STREAM_TYPE_WEBRTC:
            # Sende das Browser-Angebot an WAVE und gib die Server-Antwort zurück
            answer_sdp = await self.client.async_send_webrtc_offer(self._cam_id, offer_sdp)
            if answer_sdp:
                return answer_sdp
                
        # Fallback auf Standard-Verhalten
        return await super().async_handle_web_rtc_offer(offer_sdp)