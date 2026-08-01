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
            _LOGGER.info("Attempting login to Wisenet WAVE at %s", url)
            async with self.session.post(url, json=payload, timeout=10, ssl=False) as response:
                if response.status in (200, 201):
                    data = await response.json()
                    self._token = data.get("token")
                    if self._token:
                        _LOGGER.info("Successfully authenticated with Wisenet WAVE.")
                        return True
                    _LOGGER.error("Wisenet WAVE response did not contain a valid token.")
                    return False
                else:
                    _LOGGER.error("Wisenet WAVE Login failed with HTTP status: %s", response.status)
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
        """Test authentication and connectivity."""
        if not await self.async_login():
            return False
            
        url = f"{self.base_url}/rest/v4/system/info"
        headers = await self._get_headers()
        try:
            async with self.session.get(url, headers=headers, timeout=10, ssl=False) as response:
                if response.status == 200:
                    return True
                _LOGGER.error("System info request failed with status: %s", response.status)
                return False
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