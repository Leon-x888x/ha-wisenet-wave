"""API Client for Wisenet WAVE using Bearer Token Authentication."""
import aiohttp
import logging
import time

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
        self._token_expires_at = 0
        # Manche WAVE-Server-Versionen akzeptieren am /hls/-Endpunkt keinen
        # Bearer-Token (nur klassische Basic-Auth). Sobald der Proxy das
        # einmal herausgefunden hat, merken wir es uns hier, damit nicht
        # JEDE einzelne Playlist-/Segment-Anfrage (bei Live-Streams alle
        # paar Sekunden!) erst zwei fehlschlagende Bearer-Versuche
        # durchlaufen muss, bevor Basic-Auth versucht wird. Das war die
        # Hauptursache für die spürbaren Latenzen/Aussetzer im Player.
        self.hls_prefers_basic_auth = False

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
                        self._token_expires_at = time.time() + 55 * 60
                        return True
                    return False
                return False
        except Exception as err:
            _LOGGER.error("Error logging in to Wisenet WAVE: %s", err)
            return False

    async def _get_headers(self, force_refresh: bool = False) -> dict:
        """Ensure we have a valid token and return authorization headers."""
        if force_refresh or not self._token or time.time() >= self._token_expires_at:
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
        (Bewegungserkennung). Nutzt die moderne REST-v4-API
        GET /rest/v4/devices/{id}/footage (Nachfolger der alten
        ec2/recordedTimePeriods-Legacy-API).

        Wichtig: periodType=motion braucht laut API-Doku zusätzlich einen
        "motion"-Parameter mit einem Koordinaten-Rechteck
        ({x},{y},{width}x{height}, normiert 0..1), das den zu
        durchsuchenden Bildbereich angibt. Ohne diesen Parameter liefert
        der Server sonst schlicht die kompletten Aufnahme-Zeiträume zurück
        (nicht nach Bewegung gefiltert) - das war der eigentliche Bug.
        Hier wird der komplette Bildbereich (0,0,1x1) übergeben.

        Gibt immer ein Tupel (periods, error) zurück statt bei Fehlern
        einfach still eine leere Liste zu liefern - so kann die Karte dem
        Nutzer zeigen, WARUM keine Einfärbung da ist, statt nur grau zu
        bleiben. Bei Erfolg ist error None.
        """
        # "detailLevelMs" fasst Chunks zusammen, die näher als X ms
        # beieinander liegen. Bei großen Zeitfenstern (mehrere Tage/Wochen)
        # grob genug wählen, damit die Antwort nicht ausufert.
        span_ms = max(end_ms - start_ms, 1)
        detail = max(60_000, min(span_ms // 1000, 3_600_000))

        url = f"{self.base_url}/rest/v4/devices/{camera_id}/footage"
        params = {
            "startTimeMs": str(start_ms),
            "endTimeMs": str(end_ms),
            "detailLevelMs": str(detail),
            "periodType": periods_type,
            "keepSmallChunks": "true",  # kurze Bewegungs-Events nicht verschlucken
        }
        if periods_type == "motion":
            # Gesamten Bildbereich als Bewegungsfenster durchsuchen.
            params["motion"] = "0,0,1x1"

        for attempt in range(2):
            headers = await self._get_headers(force_refresh=attempt > 0)
            if not headers:
                return [], "Keine gültige Authentifizierung (Login fehlgeschlagen)"

            try:
                async with self.session.get(
                    url, headers=headers, params=params, timeout=15, ssl=False
                ) as response:
                    if response.status in (401, 403):
                        self._token = None
                        self._token_expires_at = 0
                        _LOGGER.warning(
                            "wisenet_wave: Token für footage (%s) für %s ungültig, versuche erneut",
                            periods_type, camera_id,
                        )
                        continue
                    if response.status != 200:
                        body_snippet = (await response.text())[:300]
                        _LOGGER.warning(
                            "wisenet_wave: /rest/v4/devices/%s/footage (%s) antwortete mit "
                            "HTTP %s. URL: %s | Antwort: %s",
                            camera_id, periods_type, response.status, url, body_snippet,
                        )
                        return [], f"HTTP {response.status} von {url}"
                    data = await response.json()
                    if isinstance(data, list):
                        return data, None
                    _LOGGER.warning(
                        "wisenet_wave: /rest/v4/devices/%s/footage (%s) lieferte "
                        "unerwartetes Format (kein JSON-Array): %s",
                        camera_id, periods_type, str(data)[:300],
                    )
                    return [], "Unerwartetes Antwortformat vom WAVE-Server"
            except Exception as err:  # noqa: BLE001
                _LOGGER.warning(
                    "wisenet_wave: Fehler beim Abrufen von footage (%s) für %s: %s",
                    periods_type, camera_id, err,
                )
                return [], str(err)

        return [], "Keine gültige Authentifizierung (Login fehlgeschlagen)"

    def get_hls_archive_url(self, camera_id: str, timestamp_ms: int) -> str:
        """
        Generiert die HLS-Stream-URL für eine bestimmte Zeit.
        timestamp_ms: Unix-Timestamp in Millisekunden.
        """
        import urllib.parse
        safe_password = urllib.parse.quote(self.password)
        
        # Wisenet WAVE HLS Endpunkt für Archive.
        # Explicitly request the high-resolution variant instead of relying
        # on the server's automatic substream selection.
        return f"https://{self.username}:{safe_password}@{self.host}:{self.port}/hls/{camera_id}.m3u8?hi&pos={timestamp_ms}"