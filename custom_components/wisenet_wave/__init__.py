"""The Wisenet WAVE integration."""

import asyncio
import time
from dataclasses import dataclass
from datetime import timedelta
from urllib.parse import quote, urlencode

import voluptuous as vol

from homeassistant.components.http import StaticPathConfig
from homeassistant.components.http.auth import async_sign_path
from homeassistant.config_entries import ConfigEntry
from homeassistant.core import HomeAssistant, ServiceCall, SupportsResponse
from homeassistant.exceptions import ConfigEntryNotReady, HomeAssistantError
from homeassistant.helpers import config_validation as cv
from homeassistant.helpers.aiohttp_client import async_get_clientsession
from homeassistant.helpers.typing import ConfigType

from .api import WisenetWaveApiClient, WisenetWaveConnectionError
from .const import CONF_HOST, CONF_PASSWORD, CONF_PORT, CONF_USERNAME, DOMAIN
from .proxy import WisenetWaveProxyView

PLATFORMS = ["camera"]
CAMERA_FIELDS = {
    vol.Required("camera_id"): vol.All(str, vol.Length(min=1)),
    vol.Optional("config_entry_id"): str,
}
ARCHIVE_SCHEMA = vol.Schema({
    **CAMERA_FIELDS,
    vol.Optional("timestamp_ms"): cv.positive_int,
    vol.Optional("stream_mode", default="archive"): vol.In(("live", "archive")),
})
TIMELINE_SCHEMA = vol.Schema({
    **CAMERA_FIELDS,
    vol.Required("start_ms"): cv.positive_int,
    vol.Required("end_ms"): cv.positive_int,
})


@dataclass
class WaveRuntimeData:
    client: WisenetWaveApiClient
    cameras: list[dict]


def _resolve_entry(
    hass: HomeAssistant, call: ServiceCall
) -> tuple[str, WaveRuntimeData]:
    """Find the loaded WAVE server for a camera service call."""
    entries = hass.data[DOMAIN]
    entry_id = call.data.get("config_entry_id")
    if entry_id is not None:
        if entry_id in entries:
            return entry_id, entries[entry_id]
        raise HomeAssistantError("The requested Wisenet WAVE server is not loaded")

    camera_id = call.data["camera_id"]
    matches = [
        (entry_id, data)
        for entry_id, data in entries.items()
        if any(camera["id"] == camera_id for camera in data.cameras)
    ]
    if len(matches) == 1:
        return matches[0]
    if matches:
        raise HomeAssistantError("Specify config_entry_id for this Wisenet WAVE camera")
    raise HomeAssistantError("No loaded Wisenet WAVE server has this camera")


async def async_setup(hass: HomeAssistant, config: ConfigType) -> bool:
    """Register resources shared by all WAVE server entries."""
    hass.data[DOMAIN] = {}
    hass.http.register_view(WisenetWaveProxyView(hass))
    await hass.http.async_register_static_paths([
        StaticPathConfig(
            f"/{DOMAIN}_card/wisenet-wave-card.js",
            hass.config.path(f"custom_components/{DOMAIN}/wisenet-wave-card.js"),
            cache_headers=False,
        )
    ])

    async def handle_get_archive(call: ServiceCall) -> dict:
        entry_id, _ = _resolve_entry(hass, call)
        camera_id = quote(call.data["camera_id"], safe="")
        stream_mode = call.data["stream_mode"]
        query = "hi"
        if stream_mode == "archive":
            timestamp = call.data.get("timestamp_ms", int(time.time() * 1000))
            query += "&" + urlencode({"pos": timestamp})
        path = f"/api/{DOMAIN}/proxy/{entry_id}/hls/{camera_id}.m3u8?{query}"
        return {
            "url": async_sign_path(hass, path, timedelta(hours=2)),
            "mode": stream_mode,
        }

    async def handle_get_timeline(call: ServiceCall) -> dict:
        _, data = _resolve_entry(hass, call)
        camera_id = call.data["camera_id"]
        start_ms, end_ms = call.data["start_ms"], call.data["end_ms"]
        if end_ms < start_ms:
            raise HomeAssistantError("end_ms must be at or after start_ms")
        (recording, rec_err), (motion, mot_err) = await asyncio.gather(
            data.client.async_get_recorded_periods(camera_id, start_ms, end_ms, "recording"),
            data.client.async_get_recorded_periods(camera_id, start_ms, end_ms, "motion"),
        )
        return {"recording": recording, "motion": motion, "error": rec_err or mot_err}

    hass.services.async_register(
        DOMAIN, "get_archive", handle_get_archive,
        schema=ARCHIVE_SCHEMA, supports_response=SupportsResponse.OPTIONAL,
    )
    hass.services.async_register(
        DOMAIN, "get_timeline", handle_get_timeline,
        schema=TIMELINE_SCHEMA, supports_response=SupportsResponse.OPTIONAL,
    )
    return True


async def async_setup_entry(hass: HomeAssistant, entry: ConfigEntry) -> bool:
    """Discover the cameras before loading a WAVE server entry."""
    client = WisenetWaveApiClient(
        entry.data[CONF_HOST],
        entry.data[CONF_PORT],
        entry.data[CONF_USERNAME],
        entry.data[CONF_PASSWORD],
        async_get_clientsession(hass),
    )
    try:
        cameras = await client.async_get_cameras()
    except WisenetWaveConnectionError as err:
        raise ConfigEntryNotReady(str(err)) from err

    entries = hass.data[DOMAIN]
    entries[entry.entry_id] = WaveRuntimeData(client, cameras)
    try:
        await hass.config_entries.async_forward_entry_setups(entry, PLATFORMS)
    except (Exception, asyncio.CancelledError):
        entries.pop(entry.entry_id, None)
        raise
    return True


async def async_unload_entry(hass: HomeAssistant, entry: ConfigEntry) -> bool:
    """Unload a WAVE server entry."""
    if not await hass.config_entries.async_unload_platforms(entry, PLATFORMS):
        return False
    hass.data[DOMAIN].pop(entry.entry_id, None)
    return True
