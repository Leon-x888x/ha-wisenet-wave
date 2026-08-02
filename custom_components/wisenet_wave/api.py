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

    async def async_get_recorded_periods(
        self, camera_id: str, start_ms: int, end_ms: int, periods_type: str = "recording"
    ) -> list:
        """
        Holt Aufnahme- bzw. Bewegungs-Zeiträume für eine Kamera in einem Zeitfenster.

        periods_type: "recording" (durchgehende Aufnahme) oder "motion"
        (Bewegungserkennung). Nutzt den WAVE/Nx-Legacy-Endpunkt
        ec2/recordedTimePeriods, der auf so gut wie allen WAVE-Server-
        Versionen vorhanden ist. Liefert bei jedem Fehler (Server unterstützt
        den Endpunkt nicht, Timeout, ...) einfach eine leere Liste zurück,
        statt die ganze Karte crashen zu lassen - die Zeitleiste funktioniert
        dann weiterhin zum Navigieren, zeigt nur keine Einfärbung an.
        """
        headers = await self._get_headers()
        if not headers:
            return []

        # "detail" fasst Chunks zusammen, die näher als X ms beieinander
        # liegen. Bei großen Zeitfenstern (mehrere Tage/Wochen) grob genug
        # wählen, damit die Antwort nicht ausufert.
        span_ms = max(end_ms - start_ms, 1)
        detail = max(60_000, min(span_ms // 1000, 3_600_000))

        url = f"{self.base_url}/ec2/recordedTimePeriods"
        params = {
            "cameraId": camera_id,
            "startTime": str(start_ms),
            "endTime": str(end_ms),
            "format": "json",
            "flat": "true",
            "detail": str(detail),
            "periodsType": periods_type,
        }
        try:
            async with self.session.get(
                url, headers=headers, params=params, timeout=15, ssl=False
            ) as response:
                if response.status != 200:
                    _LOGGER.debug(
                        "recordedTimePeriods (%s) für %s antwortete mit Status %s",
                        periods_type, camera_id, response.status,
                    )
                    return []
                data = await response.json()
                # "flat=true" liefert direkt eine Liste von {startTimeMs, durationMs}
                if isinstance(data, list):
                    return data
                return []
        except Exception as err:  # noqa: BLE001
            _LOGGER.debug(
                "Fehler beim Abrufen von recordedTimePeriods (%s) für %s: %s",
                periods_type, camera_id, err,
            )
            return []

    def get_hls_archive_url(self, camera_id: str, timestamp_ms: int) -> str:
        """
        Generiert die HLS-Stream-URL für eine bestimmte Zeit.
        timestamp_ms: Unix-Timestamp in Millisekunden.
        """
        import urllib.parse
        safe_password = urllib.parse.quote(self.password)
        
        # Wisenet WAVE HLS Endpunkt für Archive. 
        # pos = Startzeitpunkt (Epoch in ms). 
        return f"https://{self.username}:{safe_password}@{self.host}:{self.port}/hls/{camera_id}.m3u8?pos={timestamp_ms}"