"""The Wisenet WAVE integration."""
import asyncio
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
        # Wisenet/WAVE supports separate HLS substreams. We request the
        # explicit high-resolution variant here instead of relying on the
        # server's automatic ABR/master-playlist selection.
        if stream_mode == "live":
            proxy_url = f"/api/wisenet_wave/proxy/{entry.entry_id}/hls/{camera_id}.m3u8?hi"
        else:
            proxy_url = f"/api/wisenet_wave/proxy/{entry.entry_id}/hls/{camera_id}.m3u8?hi&pos={timestamp_ms}"
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
    async def handle_get_timeline(call: ServiceCall):
        """Handler für den wisenet_wave.get_timeline Service."""
        camera_id = call.data.get("camera_id")
        start_ms = call.data.get("start_ms")
        end_ms = call.data.get("end_ms")

        # Aufnahme- und Bewegungsdaten parallel laden, damit die Leiste nicht
        # auf zwei langsame WAVE-Requests wartet.
        recording_task = client.async_get_recorded_periods(
            camera_id, start_ms, end_ms, "recording"
        )
        motion_task = client.async_get_recorded_periods(
            camera_id, start_ms, end_ms, "motion"
        )
        recording_result, motion_result = await asyncio.gather(
            recording_task, motion_task
        )

        recording, rec_err = recording_result
        motion, mot_err = motion_result

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