"""API Client for Wisenet WAVE."""
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
        self.base_url = f"http://{host}:{port}"

    async def async_test_connection(self) -> bool:
        """Test authentication and connectivity."""
        url = f"{self.base_url}/rest/v4/system/info"
        auth = aiohttp.BasicAuth(self.username, self.password)
        try:
            async with self.session.get(url, auth=auth, timeout=10) as response:
                return response.status == 200
        except Exception as err:
            _LOGGER.error("Error connecting to Wisenet WAVE: %s", err)
            return False

    async def async_get_cameras(self) -> list:
        """Fetch list of devices/cameras from Wisenet WAVE."""
        url = f"{self.base_url}/rest/v4/devices"
        auth = aiohttp.BasicAuth(self.username, self.password)
        try:
            async with self.session.get(url, auth=auth, timeout=10) as response:
                if response.status == 200:
                    data = await response.json()
                    # Filter for actual camera devices
                    return [dev for dev in data if dev.get("deviceType") in ("Camera", "IO")]
                return []
        except Exception as err:
            _LOGGER.error("Error fetching cameras: %s", err)
            return []