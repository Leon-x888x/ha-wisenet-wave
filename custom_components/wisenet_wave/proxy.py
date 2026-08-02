"""HTTP proxy view that forwards HLS requests to the Wisenet WAVE server.

This makes sure the user's browser/device only ever talks to Home Assistant.
Home Assistant fetches the playlist and video segments from the WAVE server
on the client's behalf (using the Bearer token internally) and streams the
bytes back. The Bearer token never leaves the HA server.
"""
import logging
import urllib.parse

from aiohttp import web
from homeassistant.components.http import HomeAssistantView
from homeassistant.core import HomeAssistant

from .const import DOMAIN

_LOGGER = logging.getLogger(__name__)


class WisenetWaveProxyView(HomeAssistantView):
    """Proxy HLS playlist and segment requests through Home Assistant."""

    url = "/api/wisenet_wave/proxy/{entry_id}/{path:.*}"
    name = "api:wisenet_wave:proxy"
    requires_auth = True  # Only logged-in HA users/sessions may use this

    def __init__(self, hass: HomeAssistant):
        self.hass = hass

    async def get(self, request: web.Request, entry_id: str, path: str) -> web.Response:
        client = self.hass.data.get(DOMAIN, {}).get(entry_id)
        if client is None:
            return web.Response(status=404, text="Unknown Wisenet WAVE entry")

        headers = await client._get_headers()
        target_url = f"{client.base_url}/{path}"
        if request.query_string:
            target_url += f"?{request.query_string}"

        try:
            async with client.session.get(
                target_url, headers=headers, ssl=False, timeout=15
            ) as resp:
                body = await resp.read()
                content_type = resp.headers.get("Content-Type", "application/octet-stream")

                if path.endswith(".m3u8"):
                    body = self._rewrite_playlist(body, client.base_url, entry_id)

                return web.Response(body=body, status=resp.status, content_type=content_type)
        except Exception as err:  # noqa: BLE001
            _LOGGER.error("Wisenet WAVE proxy error for %s: %s", target_url, err)
            return web.Response(status=502, text="Bad Gateway (Wisenet WAVE unreachable)")

    @staticmethod
    def _rewrite_playlist(body: bytes, base_url: str, entry_id: str) -> bytes:
        """Rewrite segment/sub-playlist URIs in an m3u8 to point back through the proxy."""
        proxy_prefix = f"/api/wisenet_wave/proxy/{entry_id}/"
        text = body.decode("utf-8", errors="ignore")
        out_lines = []

        for line in text.splitlines():
            stripped = line.strip()
            if stripped and not stripped.startswith("#"):
                if stripped.startswith("http://") or stripped.startswith("https://"):
                    parsed = urllib.parse.urlparse(stripped)
                    rel_path = parsed.path.lstrip("/")
                    query = parsed.query
                else:
                    parts = stripped.split("?", 1)
                    rel_path = parts[0].lstrip("/")
                    query = parts[1] if len(parts) > 1 else ""

                new_line = proxy_prefix + rel_path
                if query:
                    new_line += f"?{query}"
                out_lines.append(new_line)
            else:
                out_lines.append(line)

        return ("\n".join(out_lines)).encode("utf-8")