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

    async def async_get_webrtc_websocket(self, camera_id: str, stream: str = "primary"):
        """
        Open a WebSocket connection for WebRTC signaling (Offer/Answer/Candidates).
        Returns the active WebSocket response object or None if connection fails.
        """
        # We construct the REST endpoint; aiohttp ws_connect handles the WebSocket Upgrade
        url = f"{self.base_url}/rest/v4/devices/{camera_id}/webrtc?stream={stream}"
        
        for attempt in range(2):
            headers = await self._get_headers()
            if not headers:
                return None

            try:
                # Use ws_connect with ssl=False to match REST behavior for local IPs / self-signed certs
                ws = await self.session.ws_connect(url, headers=headers, ssl=False)
                return ws
            except aiohttp.WSServerHandshakeError as err:
                if err.status == 401 and attempt == 0:
                    _LOGGER.debug("Wisenet WebRTC token expired during WS handshake, re-authenticating")
                    self._token = None
                    continue
                _LOGGER.error("WebSocket Handshake Error for WebRTC on camera %s: %s", camera_id, err)
                return None
            except Exception as err:
                _LOGGER.error("Unexpected error opening WebRTC WebSocket to Wisenet WAVE: %s", err)
                return None
        return None