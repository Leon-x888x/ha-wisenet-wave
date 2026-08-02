"""The Wisenet WAVE integration."""
import os
from homeassistant.components.http import StaticPathConfig
from homeassistant.config_entries import ConfigEntry
from homeassistant.core import HomeAssistant, ServiceCall
from homeassistant.helpers.aiohttp_client import async_get_clientsession

from .const import DOMAIN, CONF_HOST, CONF_PORT, CONF_USERNAME, CONF_PASSWORD
from .api import WisenetWaveApiClient

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
        
        url = f"https://{client.host}:{client.port}/hls/{camera_id}.m3u8?pos={timestamp_ms}"
        token = client._token
        
        return {
            "url": url,
            "token": token
        }

    hass.services.async_register(
        DOMAIN, "get_archive", handle_get_archive, supports_response=True
    )
    # ---------------------------------------------------------

    return True

async def async_unload_entry(hass: HomeAssistant, entry: ConfigEntry) -> bool:
    """Unload a config entry."""
    unload_ok = await hass.config_entries.async_unload_platforms(entry, PLATFORMS)
    if unload_ok:
        hass.data[DOMAIN].pop(entry.entry_id)
    return unload_ok