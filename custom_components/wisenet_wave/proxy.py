"""HTTP proxy view that forwards HLS requests to the Wisenet WAVE server.

This makes sure the user's browser/device only ever talks to Home Assistant.
Home Assistant fetches the playlist and video segments from the WAVE server
on the client's behalf (using the Bearer token internally) and streams the
bytes back. The Bearer token never leaves the HA server.
"""
import logging
import urllib.parse
from datetime import timedelta

import aiohttp
from aiohttp import web
from homeassistant.components.http import HomeAssistantView
from homeassistant.components.http.auth import async_sign_path
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
        entry_data = self.hass.data.get(DOMAIN, {}).get(entry_id)
        if entry_data is None:
            return web.Response(status=404, text="Unknown Wisenet WAVE entry")

        client = entry_data.client
        target_url = f"{client.base_url}/{urllib.parse.quote(path, safe='/')}"

        # Strip HA's own signed-URL params (authSig is only meant for HA's
        # own auth validation, never for the WAVE server). Forwarding it
        # upstream is pointless and, worse, WAVE sometimes echoes query
        # params back into playlist entries it returns - if we forward our
        # authSig, it can come back to us embedded in a sub-playlist and
        # get signed a second time on top of itself (see _rewrite_playlist).
        upstream_params = [
            (k, v) for k, v in request.query.items() if k != "authSig"
        ]
        if upstream_params:
            target_url += f"?{urllib.parse.urlencode(upstream_params)}"

        # WAVE servers can require Basic auth for HLS even when REST uses Bearer.
        auth_attempts = ("basic", "bearer", "refresh") if client.hls_prefers_basic_auth else (
            "bearer", "refresh", "basic"
        )
        rejected_token = None
        upstream_response = None

        for attempt in auth_attempts:
            request_kwargs = {"ssl": False, "timeout": 15}
            headers = {}
            if attempt == "basic":
                request_kwargs["auth"] = aiohttp.BasicAuth(client.username, client.password)
            else:
                if attempt == "refresh" and rejected_token is None:
                    continue
                headers = await client._get_headers(rejected_token)
                if not headers:
                    continue
            if (byte_range := request.headers.get("Range")) is not None:
                headers["Range"] = byte_range
            try:
                async with client.session.get(
                    target_url, headers=headers, **request_kwargs
                ) as resp:
                    body = await resp.read()
                    response_headers = {
                        key: resp.headers[key]
                        for key in ("Content-Type", "Content-Range", "Accept-Ranges", "Retry-After")
                        if key in resp.headers
                    }
                    if resp.status in (401, 403, 404, 502):
                        if resp.status in (401, 403) and attempt == "bearer":
                            rejected_token = headers["Authorization"]
                        upstream_response = web.Response(
                            body=body, status=resp.status, headers=response_headers
                        )
                        continue

                    if resp.status < 300:
                        client.hls_prefers_basic_auth = attempt == "basic"
                        if resp.status == 200 and path.endswith(".m3u8"):
                            body = self._rewrite_playlist(body, entry_id, path)
                    return web.Response(body=body, status=resp.status, headers=response_headers)
            except (aiohttp.ClientError, TimeoutError) as err:
                _LOGGER.warning("Wisenet WAVE HLS request failed for %s: %s", path, err)
                return web.Response(status=502, text="Bad Gateway (Wisenet WAVE unreachable)")

        if upstream_response is not None:
            return upstream_response
        return web.Response(status=502, text="Could not authenticate with Wisenet WAVE")

    def _rewrite_playlist(self, body: bytes, entry_id: str, playlist_path: str) -> bytes:
        """Rewrite segment/sub-playlist URIs in an m3u8 to point back through the proxy.

        Every rewritten line is itself signed, so the browser never needs to
        send an Authorization header - the signature in the URL is enough.
        """
        proxy_prefix = f"/api/wisenet_wave/proxy/{entry_id}/"
        text = body.decode("utf-8", errors="ignore")
        out_lines = []

        for line in text.splitlines():
            stripped = line.strip()
            if stripped and not stripped.startswith("#"):
                # Some WAVE manifests use server-relative hls/ paths without a slash.
                reference = "/" + stripped if stripped.startswith("hls/") else stripped
                parsed = urllib.parse.urlsplit(urllib.parse.urljoin(f"/{playlist_path}", reference))
                rel_path = parsed.path.lstrip("/")
                query_pairs = urllib.parse.parse_qsl(parsed.query, keep_blank_values=True)

                # Drop any authSig that may already be present (e.g. because
                # this line came from a nested/live sub-playlist that already
                # went through the proxy once, or because the client's own
                # authSig got echoed back by the WAVE server). Signing on top
                # of an existing authSig instead of replacing it produces a
                # URL with duplicate authSig params that can never validate,
                # which is what caused the endless "invalid authentication"
                # ban loop.
                query_pairs = [(k, v) for k, v in query_pairs if k != "authSig"]

                new_line = proxy_prefix + rel_path
                if query_pairs:
                    new_line += f"?{urllib.parse.urlencode(query_pairs)}"

                # Segment-/Sub-Playlist-Link signieren, damit der Browser ihn
                # ohne Auth-Header direkt laden kann.
                new_line = async_sign_path(self.hass, new_line, timedelta(hours=2))

                out_lines.append(new_line)
            else:
                out_lines.append(line)

        return ("\n".join(out_lines)).encode("utf-8")