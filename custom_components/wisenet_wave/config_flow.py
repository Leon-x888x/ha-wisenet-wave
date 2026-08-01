"""Config flow and Options flow for Wisenet WAVE integration."""
import voluptuous as vol
from homeassistant import config_entries
from homeassistant.core import callback
from homeassistant.helpers.aiohttp_client import async_get_clientsession

from .const import (
    DOMAIN, 
    CONF_HOST, 
    CONF_PORT, 
    CONF_USERNAME, 
    CONF_PASSWORD, 
    DEFAULT_PORT,
    CONF_STREAM_TYPE,
    STREAM_TYPE_RTSP,
    STREAM_TYPE_WEBRTC
)
from .api import WisenetWaveApiClient

class WisenetWaveConfigFlow(config_entries.ConfigFlow, domain=DOMAIN):
    """Handle a config flow for Wisenet WAVE."""

    VERSION = 1

    @staticmethod
    @callback
    def async_get_options_flow(config_entry):
        """Get the options flow for this handler."""
        return WisenetWaveOptionsFlowHandler()

    async def async_step_user(self, user_input=None):
        """Handle the initial step."""
        errors = {}

        if user_input is not None:
            session = async_get_clientsession(self.hass)
            client = WisenetWaveApiClient(
                user_input[CONF_HOST],
                user_input[CONF_PORT],
                user_input[CONF_USERNAME],
                user_input[CONF_PASSWORD],
                session,
            )

            if await client.async_test_connection():
                return self.async_create_entry(
                    title=f"Wisenet WAVE ({user_input[CONF_HOST]})",
                    data=user_input,
                )
            else:
                errors["base"] = "cannot_connect"

        schema = vol.Schema(
            {
                vol.Required(CONF_HOST, default="192.168.1.133"): str,
                vol.Required(CONF_PORT, default=DEFAULT_PORT): int,
                vol.Required(CONF_USERNAME, default="admin"): str,
                vol.Required(CONF_PASSWORD): str,
            }
        )

        return self.async_show_form(step_id="user", data_schema=schema, errors=errors)


class WisenetWaveOptionsFlowHandler(config_entries.OptionsFlow):
    """Handle options flow for Wisenet WAVE."""

    def __init__(self, config_entry: config_entries.ConfigEntry) -> None:
        """Initialize options flow."""

    async def async_step_init(self, user_input=None):
        """Manage the options."""
        if user_input is not None:
            return self.async_create_entry(title="", data=user_input)

        # Hole den aktuellen Wert (Standard ist RTSP, falls noch nichts gewählt wurde)
        current_stream = self.config_entry.options.get(CONF_STREAM_TYPE, STREAM_TYPE_RTSP)

        # Ein simples, kugelsicheres Dropdown-Menü
        options_schema = vol.Schema({
            vol.Required(
                CONF_STREAM_TYPE, 
                default=current_stream
            ): vol.In({
                STREAM_TYPE_RTSP: "RTSP Stream (Standard)",
                STREAM_TYPE_WEBRTC: "WebRTC Direkt-Stream (Nativ / 0 Latenz)",
            })
        })

        return self.async_show_form(step_id="init", data_schema=options_schema)