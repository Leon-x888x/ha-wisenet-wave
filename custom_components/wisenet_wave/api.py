"""API Client for Wisenet WAVE using Bearer Token Authentication."""
import aiohttp
import logging

_LOGGER = logging.getLogger(__name__)

class WisenetWaveApiClient:
    def __init__(self, host: str, port: int, username: str, password: str, session: aiohttp.ClientSession):
        self.host = host
        self.port = port
        self.username = username
        self.password = password
        self.session = session
        self.base_url = f"https://{host}:{port}"
        self._token = None

    async def async_login(self) -> bool:
        """Authenticate with Wisenet WAVE 6.x and retrieve a Bearer token."""
        url = f"{self.base_url}/rest/v4/login/sessions"
        payload = {
            "username": self.username,
            "password": self.password
        }
        
        try:
            async with self.session.post(url, json=payload, timeout=10, ssl=False) as response:
                if response.status in (200, 201):
                    data = await response.json()
                    self._token = data.get("token")
                    if self._token:
                        return True
                    return False
                return False
        except Exception as err:
            _LOGGER.error("Error logging in to Wisenet WAVE: %s", err)
            return False

    async def _get_headers(self) -> dict:
        """Ensure we have a valid token and return authorization headers."""
        if not self._token:
            await self.async_login()
        if self._token:
            return {"Authorization": f"Bearer {self._token}"}
        return {}

    async def async_test_connection(self) -> bool:
        """Test authentication and connectivity using devices endpoint."""
        if not await self.async_login():
            return False
            
        url = f"{self.base_url}/rest/v4/devices"
        headers = await self._get_headers()
        try:
            async with self.session.get(url, headers=headers, timeout=10, ssl=False) as response:
                return response.status == 200
        except Exception as err:
            _LOGGER.error("Unexpected error connecting to Wisenet WAVE: %s", err)
            return False

    async def async_get_cameras(self) -> list:
        """Fetch list of devices/cameras from Wisenet WAVE."""
        headers = await self._get_headers()
        if not headers:
            return []
            
        url = f"{self.base_url}/rest/v4/devices"
        try:
            async with self.session.get(url, headers=headers, timeout=10, ssl=False) as response:
                if response.status == 200:
                    data = await response.json()
                    return [dev for dev in data if dev.get("deviceType") in ("Camera", "IO")]
                return []
        except Exception as err:
            _LOGGER.error("Error fetching cameras: %s", err)
            return []

    async def async_send_webrtc_offer(self, camera_id: str, offer_sdp: str) -> str | None:
        """Send WebRTC SDP offer to Wisenet WAVE API and return SDP answer."""
        url = f"{self.base_url}/rest/v4/devices/{camera_id}/webrtc"
        payload = {"sdp": offer_sdp}

        for attempt in range(2):
            headers = await self._get_headers()
            if not headers:
                return None

            try:
                async with self.session.post(url, json=payload, headers=headers, timeout=10, ssl=False) as response:
                    if response.status in (200, 201):
                        data = await response.json()
                        return data.get("sdp")
                    if response.status == 401 and attempt == 0:
                        # Token abgelaufen -> einmal neu einloggen und erneut versuchen
                        _LOGGER.debug("Wisenet WebRTC token expired, re-authenticating")
                        self._token = None
                        continue
                    _LOGGER.error("Wisenet WebRTC SDP exchange failed with status %s", response.status)
                    return None
            except Exception as err:
                _LOGGER.error("Error exchanging WebRTC offer with Wisenet WAVE: %s", err)
                return None
        return None