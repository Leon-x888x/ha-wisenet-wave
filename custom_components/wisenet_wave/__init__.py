"""The Wisenet WAVE integration."""
import os
from datetime import timedelta
from homeassistant.components.http import StaticPathConfig
from homeassistant.components.http.auth import async_sign_path
from homeassistant.config_entries import ConfigEntry
from homeassistant.core import HomeAssistant, ServiceCall
from homeassistant.helpers.aiohttp_client import async_get_clientsession

from .const import DOMAIN, CONF_HOST, CONF_PORT, CONF_USERNAME, CONF_PASSWORD
from .api import WisenetWaveApiClient
from .proxy import WisenetWaveProxyView

PLATFORMS = ["camera"]

async def async_setup_entry(hass: HomeAssistant, entry: ConfigEntry) -> bool:
    """Set up Wisenet WAVE from a config entry."""
    session = async_get_clientsession(hass)
    client = WisenetWaveApiClient(
        entry.data[CONF_HOST],
        entry.data[CONF_PORT],
        entry.data[CONF_USERNAME],
        entry.data[CONF_PASSWORD],
        session,
    )

    hass.data.setdefault(DOMAIN, {})
    hass.data[DOMAIN][entry.entry_id] = client

    # --- Proxy-View einmalig registrieren, damit Geräte nur mit HA sprechen ---
    if not hass.data[DOMAIN].get("_proxy_registered"):
        hass.http.register_view(WisenetWaveProxyView(hass))
        hass.data[DOMAIN]["_proxy_registered"] = True
    # ---------------------------------------------------------------------

    # --- NEU: Frontend-Karte über die Integration hosten ---
    card_path = hass.config.path(f"custom_components/{DOMAIN}/wisenet-wave-card.js")
    if os.path.exists(card_path):
        await hass.http.async_register_static_paths(
            [StaticPathConfig(f"/{DOMAIN}_card/wisenet-wave-card.js", card_path, cache_headers=False)]
        )
    # -------------------------------------------------------

    await hass.config_entries.async_forward_entry_setups(entry, PLATFORMS)

    # --- Unser Custom Service für die Archiv-Abfrage ---
    async def handle_get_archive(call: ServiceCall):
        """Handler für den wisenet_wave.get_archive Service."""
        camera_id = call.data.get("camera_id")
        import time
        timestamp_ms = call.data.get("timestamp_ms", int(time.time() * 1000))

        # URL zeigt jetzt auf unseren eigenen HA-Proxy, nicht direkt auf den WAVE-Server.
        # Das Gerät des Nutzers spricht damit nur noch mit Home Assistant.
        # Signierte URL statt Auth-Header: das ist der HA-Standardweg für sowas
        # (genau wie bei den eingebauten Kamera-/Snapshot-URLs).
        stream_mode = call.data.get("stream_mode", "archive")
        if stream_mode == "live":
            proxy_url = f"/api/wisenet_wave/proxy/{entry.entry_id}/hls/{camera_id}.m3u8"
        else:
            proxy_url = f"/api/wisenet_wave/proxy/{entry.entry_id}/hls/{camera_id}.m3u8?pos={timestamp_ms}"
        signed_url = async_sign_path(hass, proxy_url, timedelta(hours=2))

        return {
            "url": signed_url,
            "mode": stream_mode,
        }

    hass.services.async_register(
        DOMAIN, "get_archive", handle_get_archive, supports_response=True
    )
    # ---------------------------------------------------------

    # --- NEU: Service für die Zeitleisten-Einfärbung (Aufnahme/Bewegung) ---
    def _periods_identical(a: list, b: list) -> bool:
        """Prüft, ob zwei Perioden-Listen inhaltlich exakt gleich sind."""
        if not a or not b or len(a) != len(b):
            return False
        for pa, pb in zip(a, b):
            if str(pa.get("startTimeMs")) != str(pb.get("startTimeMs")):
                return False
            if str(pa.get("durationMs")) != str(pb.get("durationMs")):
                return False
        return True

    async def handle_get_timeline(call: ServiceCall):
        """Handler für den wisenet_wave.get_timeline Service."""
        camera_id = call.data.get("camera_id")
        start_ms = call.data.get("start_ms")
        end_ms = call.data.get("end_ms")

        recording, rec_err = await client.async_get_recorded_periods(
            camera_id, start_ms, end_ms, "recording"
        )
        motion, mot_err = await client.async_get_recorded_periods(
            camera_id, start_ms, end_ms, "motion"
        )

        # Manche WAVE-Server liefern bei periodsType=motion keine echte
        # Filterung (identisch zu recording). Dann automatisch den
        # alternativen, ebenfalls von Nx/WAVE dokumentierten Wert
        # "analytics" probieren - falls DER sich wirklich unterscheidet,
        # nehmen wir den stattdessen.
        if not mot_err and _periods_identical(recording, motion):
            alt_motion, alt_err = await client.async_get_recorded_periods(
                camera_id, start_ms, end_ms, "analytics"
            )
            if not alt_err and not _periods_identical(recording, alt_motion):
                motion, mot_err = alt_motion, None
            else:
                mot_err = (
                    "Server liefert für periodsType=motion und =analytics beides Mal "
                    "identische Daten wie recording - keine getrennte Bewegungserkennung "
                    "über diese API verfügbar."
                )

        error = rec_err or mot_err

        return {
            "recording": recording,
            "motion": motion,
            "error": error,
        }

    hass.services.async_register(
        DOMAIN, "get_timeline", handle_get_timeline, supports_response=True
    )
    # -----------------------------------------------------------------

    return True

async def async_unload_entry(hass: HomeAssistant, entry: ConfigEntry) -> bool:
    """Unload a config entry."""
    unload_ok = await hass.config_entries.async_unload_platforms(entry, PLATFORMS)
    if unload_ok:
        hass.data[DOMAIN].pop(entry.entry_id)
    return unload_ok