# ha-wisenet-wave

HA Wisenet WaveThis project integrates surveillance cameras from Wisenet Wave (Hanwha Vision) into Home Assistant.

## Updating the dashboard card

Install the current integration from `main` in HACS, or update the entire
`custom_components/wisenet_wave` directory manually. Restart Home Assistant
after updating the files.

Under **Settings → Dashboards → Resources**, edit the existing Wisenet WAVE
card resource. Set its type to **JavaScript module** and use this URL:

```text
/wisenet_wave_card/wisenet-wave-card.js?v=0.1.5
```

Use a single resource for the card. If the old resource points to
`/local/wisenet-wave-card.js`, replace it with the URL above to load the copy
from the installed integration. Reload the dashboard. Visible cards show a
snapshot that refreshes every 10 seconds while the stream is off. Use the
play button over the snapshot to start playback. The events timeline updates
while the card is visible, including before playback.
Pinch with two fingers over the video to zoom in or out (up to 4×). Drag
with one finger to move around the zoomed image.

In fullscreen, use **Space** or **K** to pause or resume, **← / →** to go
back or forward by 10 seconds, **↑ / ↓** for the volume, **M** to mute,
and **F** or **Esc** to exit fullscreen. The browser console shows
`[wisenet-wave-card] Version 0.1.5 geladen` when the updated module loads.

⚠️ DisclaimerThis is a private, unofficial project. It is not affiliated with, endorsed, or supported by Hanwha Vision or Home Assistant. All product names, logos, and brands (such as "Wisenet Wave" and "Home Assistant") are the property of their respective owners. Use this software at your own risk.
