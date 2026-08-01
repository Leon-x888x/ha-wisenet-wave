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
        # HTTPS nutzen, da WAVE verschlüsselte Verbindungen erzwingt
        self.base_url = f"https://{host}:{port}"

    async def async_test_connection(self) -> bool:
        """Test authentication and connectivity."""
        url = f"{self.base_url}/rest/v4/system/info"
        auth = aiohttp.BasicAuth(self.username, self.password)
        
        try:
            _LOGGER.info("Connecting to Wisenet WAVE at %s", url)
            # ssl=False ignoriert Zertifikatsfehler bei lokaler IP-Adresse
            async with self.session.get(url, auth=auth, timeout=10, ssl=False) as response:
                _LOGGER.info("Wisenet WAVE API Response Status: %s", response.status)
                
                if response.status == 200:
                    return True
                elif response.status in (401, 403):
                    _LOGGER.error("Wisenet WAVE Auth Failed (%s): Digest/Basic Auth disabled or wrong password.", response.status)
                    return False
                else:
                    _LOGGER.error("Wisenet WAVE returned HTTP %s", response.status)
                    return False
                    
        except aiohttp.ClientConnectorError as err:
            _LOGGER.error("Cannot reach Wisenet WAVE server (Connection error): %s", err)
            return False
        except Exception as err:
            _LOGGER.error("Unexpected error connecting to Wisenet WAVE: %s", err)
            return False

    async def async_get_cameras(self) -> list:
        """Fetch list of devices/cameras from Wisenet WAVE."""
        url = f"{self.base_url}/rest/v4/devices"
        auth = aiohttp.BasicAuth(self.username, self.password)
        try:
            async with self.session.get(url, auth=auth, timeout=10, ssl=False) as response:
                if response.status == 200:
                    data = await response.json()
                    return [dev for dev in data if dev.get("deviceType") in ("Camera", "IO")]
                return []
        except Exception as err:
            _LOGGER.error("Error fetching cameras: %s", err)
            return []