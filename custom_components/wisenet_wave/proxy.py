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
        client = self.hass.data.get(DOMAIN, {}).get(entry_id)
        if client is None:
            return web.Response(status=404, text="Unknown Wisenet WAVE entry")

        target_url = f"{client.base_url}/{path}"

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

        # Bug-Fix-Versuch: Der /hls/-Streaming-Endpunkt von Wisenet WAVE
        # akzeptiert auf manchen Server-Versionen KEINEN Bearer-Token aus der
        # REST-v4-Login-API, sondern verlangt klassische HTTP-Basic-Auth
        # (Username/Passwort). Bisher haben wir hier ausschließlich Bearer
        # geschickt, was ohne jede Exception in unserem Code mit HTTP
        # 502/404 vom WAVE-Server selbst quittiert wurde (kein Log-Eintrag,
        # weil das eine "normale" HTTP-Antwort ist, keine Exception).
        # Strategie: erst Bearer versuchen (mit einem Retry bei 401/403 nach
        # Token-Refresh, wie bisher), und falls das WEITERHIN mit
        # 401/403/404/502 fehlschlägt, einmal zusätzlich mit Basic-Auth
        # probieren, bevor wir endgültig aufgeben.
        auth_attempts = [
            {"force_refresh": False, "basic": False},
            {"force_refresh": True, "basic": False},
            {"force_refresh": False, "basic": True},
        ]

        last_resp_status = None
        last_resp_body = None
        last_resp_content_type = None

        for attempt_info in auth_attempts:
            request_kwargs = {"ssl": False, "timeout": 15}
            if attempt_info["basic"]:
                request_kwargs["auth"] = aiohttp.BasicAuth(client.username, client.password)
                headers = {}
            else:
                headers = await client._get_headers(force_refresh=attempt_info["force_refresh"])
            try:
                async with client.session.get(
                    target_url, headers=headers, **request_kwargs
                ) as resp:
                    if resp.status in (401, 403, 404, 502):
                        if resp.status in (401, 403):
                            client._token = None
                            client._token_expires_at = 0
                        last_resp_status = resp.status
                        last_resp_body = await resp.read()
                        last_resp_content_type = resp.headers.get("Content-Type", "text/plain")
                        continue

                    body = await resp.read()
                    content_type = resp.headers.get("Content-Type", "application/octet-stream")

                    if path.endswith(".m3u8"):
                        body = self._rewrite_playlist(body, entry_id)

                    if attempt_info["basic"]:
                        _LOGGER.info(
                            "wisenet_wave: /hls/-Endpunkt hat mit Basic-Auth funktioniert, "
                            "nicht mit Bearer-Token (%s)", target_url,
                        )

                    return web.Response(body=body, status=resp.status, content_type=content_type)
            except Exception as err:  # noqa: BLE001
                _LOGGER.error("Wisenet WAVE proxy error for %s: %s", target_url, err)
                return web.Response(status=502, text="Bad Gateway (Wisenet WAVE unreachable)")

        # Alle Auth-Varianten fehlgeschlagen - die letzte Antwort vom
        # WAVE-Server durchreichen (statt eines generischen 502), damit man
        # in der Karte/den Dev-Tools sieht, was der Server WIRKLICH zurückgibt.
        return web.Response(
            body=last_resp_body or b"",
            status=last_resp_status or 502,
            content_type=last_resp_content_type or "text/plain",
        )

    def _rewrite_playlist(self, body: bytes, entry_id: str) -> bytes:
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
                if stripped.startswith("http://") or stripped.startswith("https://"):
                    parsed = urllib.parse.urlparse(stripped)
                    rel_path = parsed.path.lstrip("/")
                    query_pairs = urllib.parse.parse_qsl(parsed.query, keep_blank_values=True)
                else:
                    parts = stripped.split("?", 1)
                    rel_path = parts[0].lstrip("/")
                    query_pairs = (
                        urllib.parse.parse_qsl(parts[1], keep_blank_values=True)
                        if len(parts) > 1
                        else []
                    )

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