"""API Client for Wisenet WAVE using Bearer Token Authentication."""
import asyncio
import logging
import time
from urllib.parse import quote

import aiohttp

_LOGGER = logging.getLogger(__name__)

class WisenetWaveConnectionError(Exception):
    """WAVE could not provide the device list."""


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
        self._login_retry_at = 0
        self._login_lock = asyncio.Lock()
        # Manche WAVE-Server-Versionen akzeptieren am /hls/-Endpunkt keinen
        # Bearer-Token (nur klassische Basic-Auth). Sobald der Proxy das
        # einmal herausgefunden hat, merken wir es uns hier, damit nicht
        # JEDE einzelne Playlist-/Segment-Anfrage (bei Live-Streams alle
        # paar Sekunden!) erst zwei fehlschlagende Bearer-Versuche
        # durchlaufen muss, bevor Basic-Auth versucht wird. Das war die
        # Hauptursache für die spürbaren Latenzen/Aussetzer im Player.
        self.hls_prefers_basic_auth = False

    async def _login(self) -> bool:
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
                        self._token_expires_at = time.monotonic() + 55 * 60
                        return True
                    return False
                return False
        except Exception as err:
            _LOGGER.error("Error logging in to Wisenet WAVE: %s", err)
            return False

    async def _get_headers(self, rejected_token: str | None = None) -> dict:
        """Reuse a valid token or serialize the login for concurrent requests."""
        async with self._login_lock:
            now = time.monotonic()
            if self._token and self._token_expires_at > now:
                authorization = f"Bearer {self._token}"
                if authorization != rejected_token:
                    return {"Authorization": authorization}

            self._token = None
            if now < self._login_retry_at:
                return {}
            if not await self._login():
                self._login_retry_at = time.monotonic() + 2
                return {}
            self._login_retry_at = 0
            return {"Authorization": f"Bearer {self._token}"}

    async def async_test_connection(self) -> bool:
        """Test authentication and connectivity using the devices endpoint."""
        try:
            await self.async_get_cameras()
        except WisenetWaveConnectionError:
            return False
        return True

    async def async_get_cameras(self) -> list[dict]:
        """Fetch devices, distinguishing an empty list from a failed request."""
        headers = await self._get_headers()
        url = f"{self.base_url}/rest/v4/devices"
        try:
            for attempt in range(2):
                if not headers:
                    raise WisenetWaveConnectionError("Could not log in to Wisenet WAVE")
                async with self.session.get(
                    url, headers=headers, timeout=10, ssl=False
                ) as response:
                    if response.status not in (401, 403) or attempt:
                        response.raise_for_status()
                        devices = await response.json()
                        break
                headers = await self._get_headers(headers["Authorization"])
        except (aiohttp.ClientError, TimeoutError, ValueError) as err:
            raise WisenetWaveConnectionError("Could not fetch Wisenet WAVE devices") from err

        if not isinstance(devices, list):
            raise WisenetWaveConnectionError("Invalid Wisenet WAVE device list")
        return [
            device for device in devices
            if isinstance(device, dict)
            and device.get("deviceType") in ("Camera", "IO")
            and isinstance(device.get("id"), str)
            and device["id"]
        ]

    async def async_get_recorded_periods(
        self, camera_id: str, start_ms: int, end_ms: int, periods_type: str = "recording"
    ) -> tuple[list, str | None]:
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

        url = f"{self.base_url}/rest/v4/devices/{quote(camera_id, safe='')}/footage"
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

        rejected_token = None
        for attempt in range(2):
            headers = await self._get_headers(rejected_token)
            if not headers:
                return [], "Keine gültige Authentifizierung (Login fehlgeschlagen)"

            try:
                async with self.session.get(
                    url, headers=headers, params=params, timeout=15, ssl=False
                ) as response:
                    if response.status in (401, 403):
                        rejected_token = headers["Authorization"]
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