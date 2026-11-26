console.info('[wisenet-wave-card] Version 0.1.5 geladen');

const HLS_RETRY_DELAYS = [1000, 2000, 4000, 8000, 15000];
const HLS_RECOVERY_NOTICE_MS = 2500;
const HLS_RECOVERY_NOTICE = 'Verbindung zum Stream wird wiederhergestellt …';
const TIMELINE_RETRY_MS = 15000;
const TIMELINE_REQUEST_LIMIT = 4;
const TIMELINE_REFRESH_MS = 30000;
const FULLSCREEN_CONTROLS_MS = 3000;
const SEEK_STEP_MS = 10000;
const VIDEO_ZOOM_LEVELS = [1, 1.5, 2, 3, 4];
const MAX_VIDEO_ZOOM = VIDEO_ZOOM_LEVELS[VIDEO_ZOOM_LEVELS.length - 1];
const VIDEO_ZOOM_FORMAT = new Intl.NumberFormat('de-DE', { maximumFractionDigits: 2 });
const PLAYHEAD_UPDATE_MS = 125;
const PLAYBACK_CHECK_MS = 1000;
const PLAYBACK_STALL_MS = 7000;
const VIDEO_FRAME_STALL_MS = 12000;
const PREVIEW_INTERVAL_MS = 10000;
const PREVIEW_TIMEOUT_MS = 8000;
let hlsLibraryPromise;

function loadHlsLibrary() {
  if (window.Hls) return Promise.resolve(window.Hls);
  if (!hlsLibraryPromise) {
    hlsLibraryPromise = new Promise((resolve, reject) => {
      const script = document.createElement('script');
      const failed = () => {
        clearTimeout(timeout);
        script.remove();
        reject(new Error('HLS.js konnte nicht geladen werden'));
      };
      const timeout = setTimeout(failed, 8000);
      script.src = 'https://cdn.jsdelivr.net/npm/hls.js@1.7.4';
      script.onload = () => {
        clearTimeout(timeout);
        if (window.Hls) resolve(window.Hls);
        else failed();
      };
      script.onerror = failed;
      document.head.appendChild(script);
    }).catch((error) => {
      hlsLibraryPromise = null;
      throw error;
    });
  }
  return hlsLibraryPromise;
}

class WisenetWaveCard extends HTMLElement {
  // Wird aufgerufen, wenn die Karte in HA konfiguriert wird
  setConfig(config) {
    if (!config.entity && !config.camera_id) {
      throw new Error('Du musst entweder "entity" (z.B. camera.terrasse) oder "camera_id" angeben!');
    }
    if (this._listeners) this.disconnectedCallback();
    this.config = config;

    // Zeitleisten-Zustand
    this._viewEnd = Date.now();
    this._viewStart = this._viewEnd - 60 * 60 * 1000; // Start: letzte Stunde
    this._playheadMs = this._viewEnd;
    this._isLive = true;
    this._followLiveTimeline = true;
    this._periodsCache = new Map(); // Tagesschlüssel -> {recording:[], motion:[]}
    this._pendingFetches = new Set();
    this._dragState = null;
    this._pinchState = null;
    this._fetchDebounce = null;
    this._rafId = null;
    this._loadWatchdogId = null;
    this._playbackMonitor = null;
    this._timelineRetryTimer = null;
    this._timelineActive = false;
    this._timelineWaitingForCamera = false;
    this._timelineRetryAt = 0;
    this._hlsRetryTimer = null;
    this._hlsRecoveryNoticeTimer = null;
    this._hlsRetryCount = 0;
    this._activeStreamToken = (this._activeStreamToken ?? 0) + 1;
    this._currentStreamUrl = null;
    this._streamStartMs = null;
    this._streamMode = 'live';
    this._waitingForCamera = false;
    this._playbackRequested = false;
    this._playbackPaused = false;
    this._fullscreenControlsTimer = null;
    this._seekFeedbackTimer = null;
    this._cardVisible = false;
    this._previewTimer = null;
    this._previewRequest = null;
    this._previewObjectUrl = null;
    this._videoZoom = 1;
    this._videoOffsetX = 0;
    this._videoOffsetY = 0;
    if (this.isConnected && this._hass) this.hass = this._hass;
  }

  // Ermittelt die interne Wisenet-Kamera-ID: entweder direkt aus camera_id,
  // oder aus dem "wisenet_camera_id"-Attribut der angegebenen Entity.
  resolveCameraId() {
    if (this.config.camera_id) {
      return this.config.camera_id;
    }
    const stateObj = this._hass?.states[this.config.entity];
    if (!stateObj) {
      this.errorEl && (this.errorEl.innerText = `Entity ${this.config.entity} nicht gefunden.`);
      return null;
    }
    const camId = stateObj.attributes.wisenet_camera_id;
    if (!camId) {
      this.errorEl && (this.errorEl.innerText = `Entity ${this.config.entity} hat kein wisenet_camera_id-Attribut. Bitte Integration aktualisieren.`);
      return null;
    }
    return camId;
  }

  _cameraServiceData() {
    const entity = this._hass?.states?.[this.config.entity];
    const cameraId = this.resolveCameraId();
    if (!cameraId) return null;

    const entryId = this.config.config_entry_id || entity?.attributes.wisenet_entry_id;
    return entryId
      ? { camera_id: cameraId, config_entry_id: entryId }
      : { camera_id: cameraId };
  }

  connectedCallback() {
    if (this._hass) this.hass = this._hass;
  }

  // Home Assistant Objekt (wird bei jeder Änderung von HA aktualisiert)
  set hass(hass) {
    this._hass = hass;
    if (!this.isConnected || !this.config || !hass) return;
    if (!this.content) {
      this._listeners = new AbortController();
      const { signal } = this._listeners;
      this.innerHTML = `
        <ha-card>
          <style>
            .wwc-content { padding: 0 16px 16px; }
            .wwc-player { position: relative; }
            .wwc-player:fullscreen { width: 100%; height: 100%; background: #000; }
            .wwc-player:fullscreen .wwc-video-wrap { height: 100%; border-radius: 0; aspect-ratio: auto; }
            .wwc-player:fullscreen .wwc-video-zoom { top: 8px; bottom: auto; }
            .wwc-player:fullscreen .wwc-player-controls {
              position: absolute; inset: auto 0 0; padding: 24px 16px 12px;
              padding-bottom: max(12px, env(safe-area-inset-bottom));
              background: linear-gradient(transparent, rgba(0,0,0,0.92) 36%);
              --primary-text-color: #fff; --secondary-text-color: #e0e0e0;
              --divider-color: rgba(255,255,255,0.24);
              color: #fff; transition: opacity 150ms;
            }
            .wwc-player:fullscreen.wwc-controls-hidden .wwc-player-controls:not(:focus-within):not(:hover) {
              opacity: 0; pointer-events: none;
            }
            .wwc-seek-feedback {
              position: absolute; top: 32%; left: 50%; transform: translateX(-50%);
              padding: 8px 16px; border-radius: 999px; background: rgba(0,0,0,0.75);
              color: #fff; font-size: 18px; font-variant-numeric: tabular-nums; pointer-events: none;
            }
            @media (prefers-reduced-motion: reduce) {
              .wwc-player:fullscreen .wwc-player-controls { transition: none; }
            }
            .wwc-video-wrap { position: relative; width: 100%; aspect-ratio: 16 / 9; background: #000; border-radius: 4px; overflow: hidden; }
            .wwc-video-wrap video { width: 100%; height: 100%; display: block; object-fit: contain; background: #000; }
            .wwc-video-preview { display: none; position: absolute; inset: 0; pointer-events: none; }
            .wwc-video-preview img { display: block; width: 100%; height: 100%; object-fit: contain; }
            .wwc-video-idle .wwc-video-preview { display: block; }
            .wwc-video-start {
              position: absolute; top: 50%; left: 50%; transform: translate(-50%, -50%);
              display: grid; place-items: center; width: 56px; height: 56px;
              border: 1px solid rgba(255,255,255,0.6); border-radius: 50%; color: #fff;
              background: rgba(0,0,0,0.72); cursor: pointer;
            }
            .wwc-video-start ha-icon { --mdc-icon-size: 32px; }
            .wwc-video-start[hidden] { display: none; }
            .wwc-video-start:hover { background: rgba(0,0,0,0.88); }
            .wwc-video-start:focus-visible { outline: 2px solid #fff; outline-offset: 3px; }
            .wwc-video-wrap:not(.wwc-video-idle) { touch-action: none; }
            .wwc-video-wrap.wwc-video-pannable:not(.wwc-video-idle) { cursor: grab; user-select: none; }
            .wwc-video-wrap.wwc-video-dragging { cursor: grabbing; }
            .wwc-video-zoom {
              position: absolute; right: 8px; bottom: 8px; display: flex; align-items: center;
              border-radius: 8px; background: rgba(0,0,0,0.75); color: #fff;
              touch-action: manipulation;
            }
            .wwc-video-zoom button { color: inherit; border-radius: 8px; width: 40px; height: 40px; }
            .wwc-video-zoom button:hover:not(:disabled) { background: rgba(255,255,255,0.2); }
            .wwc-video-zoom button:focus-visible { outline: 2px solid currentColor; outline-offset: -2px; }
            .wwc-video-zoom-reset { min-width: 44px; font-size: 12px; font-variant-numeric: tabular-nums; }
            .wwc-video-idle .wwc-video-zoom { display: none; }
            .wwc-live-badge {
              position: absolute; top: 8px; left: 8px; display: none; align-items: center; gap: 5px;
              background: rgba(0,0,0,0.55); color: #fff; font-size: 11px; font-weight: 600;
              padding: 3px 8px 3px 6px; border-radius: 10px; letter-spacing: 0.02em; pointer-events: none;
            }
            .wwc-live-badge-dot {
              width: 7px; height: 7px; border-radius: 50%; background: var(--error-color, #db4437);
              animation: wwc-pulse 1.4s ease-in-out infinite;
            }
            @keyframes wwc-pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.35; } }
            .wwc-video-wrap video.wwc-live-no-controls {
              cursor: default;
              -webkit-user-select: none;
              user-select: none;
            }
            .wwc-video-wrap video.wwc-live-no-controls::-webkit-media-controls {
              display: none !important;
            }
            .wwc-video-wrap video.wwc-live-no-controls::cue {
              display: none;
            }
            .wwc-toolbar { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; margin-top: 12px; }
            .wwc-btn {
              display: flex; align-items: center; justify-content: center;
              width: 32px; height: 32px; padding: 0; border-radius: 50%;
              border: none; background: transparent; color: var(--primary-text-color);
              cursor: pointer;
              flex: 0 0 auto;
            }
            .wwc-btn:hover { background: var(--divider-color, rgba(0,0,0,0.08)); }
            .wwc-btn:disabled { opacity: 0.45; cursor: not-allowed; }
            .wwc-btn[hidden] { display: none; }
            .wwc-btn ha-icon { --mdc-icon-size: 20px; }
            .wwc-time { font-family: var(--code-font-family, monospace); font-size: 13px; color: var(--secondary-text-color); min-width: 120px; white-space: nowrap; }
            .wwc-spacer { flex: 1 1 0; min-width: 0; }
            .wwc-live-btn {
              font-size: 12px; font-weight: 500; padding: 4px 10px; border-radius: 12px;
              border: 1px solid var(--divider-color); background: none; cursor: pointer;
              color: var(--secondary-text-color); display: flex; align-items: center; gap: 4px;
              flex: 0 0 auto;
            }
            .wwc-live-btn.active { color: var(--error-color, #db4437); border-color: var(--error-color, #db4437); }
            .wwc-live-dot { width: 6px; height: 6px; border-radius: 50%; background: currentColor; }
            .wwc-timeline-wrap { margin-top: 10px; }
            .wwc-timeline-labels { display: flex; justify-content: space-between; font-size: 10px; color: var(--secondary-text-color); padding: 0 2px 2px; height: 12px; }
            .wwc-canvas { width: 100%; height: 46px; display: block; border-radius: 4px; cursor: pointer; touch-action: none; background: var(--divider-color, #e0e0e0); }
            .wwc-legend { display: flex; align-items: center; justify-content: space-between; margin-top: 6px; }
            .wwc-legend-items { display: flex; gap: 14px; font-size: 11px; color: var(--secondary-text-color); }
            .wwc-legend-dot { width: 8px; height: 8px; border-radius: 2px; display: inline-block; margin-right: 4px; vertical-align: -1px; }
            .wwc-zoom-controls { display: flex; gap: 4px; }
          </style>
          <div class="card-content wwc-content">
            <div class="wwc-player" tabindex="-1">
              <div class="wwc-video-wrap">
                <video id="wave-video" muted playsinline></video>
                <div class="wwc-video-preview" aria-hidden="true"></div>
                <div class="wwc-live-badge" id="wave-live-badge"><span class="wwc-live-badge-dot"></span>LIVE</div>
                <div class="wwc-seek-feedback" role="status" hidden></div>
                <button type="button" class="wwc-video-start" id="wave-video-start" aria-label="Video starten" title="Video starten"><ha-icon icon="mdi:play"></ha-icon></button>
                <div class="wwc-video-zoom" role="group" aria-label="Videozoom">
                  <button type="button" class="wwc-btn" id="wave-video-zoom-out" title="Video verkleinern" aria-label="Video verkleinern"><ha-icon icon="mdi:minus"></ha-icon></button>
                  <button type="button" class="wwc-btn wwc-video-zoom-reset" id="wave-video-zoom-reset" title="Videozoom zurücksetzen">1×</button>
                  <button type="button" class="wwc-btn" id="wave-video-zoom-in" title="Video vergrößern" aria-label="Video vergrößern"><ha-icon icon="mdi:plus"></ha-icon></button>
                </div>
              </div>

              <div class="wwc-player-controls">
                <div class="wwc-toolbar">
                  <button type="button" class="wwc-btn" id="wave-skip-back" title="10 Sekunden zurück (←)" aria-keyshortcuts="ArrowLeft"><ha-icon icon="mdi:rewind-10"></ha-icon></button>
                  <button type="button" class="wwc-btn" id="wave-play-pause" title="Stream starten" aria-label="Stream starten" aria-keyshortcuts="Space K"><ha-icon icon="mdi:play"></ha-icon></button>
                  <button type="button" class="wwc-btn" id="wave-skip-fwd" title="10 Sekunden vor (→)" aria-keyshortcuts="ArrowRight"><ha-icon icon="mdi:fast-forward-10"></ha-icon></button>
                  <button type="button" class="wwc-btn" id="wave-stop" title="Stream stoppen" aria-label="Stream stoppen" hidden><ha-icon icon="mdi:stop"></ha-icon></button>
                  <button type="button" class="wwc-btn" id="wave-mute" title="Stumm/Ton an (M)" aria-keyshortcuts="M"><ha-icon icon="mdi:volume-off"></ha-icon></button>
                  <button type="button" class="wwc-btn" id="wave-fullscreen" title="Vollbild (F)" aria-label="Vollbild" aria-keyshortcuts="F"><ha-icon icon="mdi:fullscreen"></ha-icon></button>
                  <span class="wwc-time" id="wave-time-label">--</span>
                  <div class="wwc-spacer"></div>
                  <button class="wwc-live-btn" id="wave-live-btn"><span class="wwc-live-dot"></span>Live</button>
                </div>

                <div class="wwc-timeline-wrap">
                  <div class="wwc-timeline-labels" id="wave-timeline-labels"></div>
                  <canvas class="wwc-canvas" id="wave-canvas" height="46"></canvas>
                  <div class="wwc-legend">
                    <div class="wwc-legend-items">
                      <span><span class="wwc-legend-dot" style="background:var(--success-color,#43a047)"></span>Aufnahme</span>
                      <span><span class="wwc-legend-dot" style="background:var(--error-color,#db4437)"></span>Bewegung</span>
                    </div>
                    <div class="wwc-zoom-controls">
                      <button class="wwc-btn" id="wave-zoom-out" title="Rauszoomen"><ha-icon icon="mdi:magnify-minus-outline"></ha-icon></button>
                      <button class="wwc-btn" id="wave-zoom-in" title="Reinzoomen"><ha-icon icon="mdi:magnify-plus-outline"></ha-icon></button>
                    </div>
                  </div>
                </div>

                <div id="wave-timeline-error" style="color: var(--error-color, red); margin-top: 8px; font-size: 12px;"></div>
                <div id="wave-error" style="color: var(--error-color, red); margin-top: 8px; font-size: 12px;"></div>
              </div>
            </div>
          </div>
        </ha-card>
      `;
      this.querySelector('ha-card').setAttribute('header', this.config.title || 'Wisenet WAVE Archiv');
      this.content = this.querySelector('.card-content');
      this.videoEl = this.querySelector('#wave-video');
      this.playerEl = this.querySelector('.wwc-player');
      this.videoWrapEl = this.querySelector('.wwc-video-wrap');
      this.previewEl = this.querySelector('.wwc-video-preview');
      this.seekFeedbackEl = this.querySelector('.wwc-seek-feedback');
      this.errorEl = this.querySelector('#wave-error');
      this.timelineErrorEl = this.querySelector('#wave-timeline-error');
      this.canvasEl = this.querySelector('#wave-canvas');
      this.labelsEl = this.querySelector('#wave-timeline-labels');
      this.timeLabelEl = this.querySelector('#wave-time-label');
      this.liveBtnEl = this.querySelector('#wave-live-btn');
      this.playPauseBtnEl = this.querySelector('#wave-play-pause');
      this.stopBtnEl = this.querySelector('#wave-stop');
      this.startVideoBtnEl = this.querySelector('#wave-video-start');
      this.liveBadgeEl = this.querySelector('#wave-live-badge');

      this._setupTransportControls();
      this._setupVideoZoom();
      this._setupTimelineInteraction();
      this._setupVideoEvents();
      this._observeCardVisibility();
      this._syncVideoUi();

      this._resizeCanvas();
      this._updateTimeLabel();
      this._drawTimeline();

      window.addEventListener('resize', () => {
        this._resizeCanvas();
        this._drawTimeline();
        this._refreshVideoLayout();
      }, { signal });
      document.addEventListener('visibilitychange', () => {
        this._syncPreview();
        this._syncTimeline();
        if (document.visibilityState === 'visible') {
          this._refreshVideoLayout();
        }
      }, { signal });

      // Bug-Fix: Beim ersten Rendern der Karte hat das HA-Dashboard-Grid
      // (Masonry-Layout) die tatsächliche Breite der Karte oft noch nicht
      // final berechnet - `_resizeCanvas()` oben liest dann eine falsche
      // (z.B. 0px) Breite aus getBoundingClientRect(). Ein normales
      // Layout-Update danach (Sidebar auf/zu, Grid-Neuberechnung, Tab-
      // Wechsel) löst aber KEIN "window resize"-Event aus, wodurch die
      // Zeitleiste dauerhaft falsch/leer bleibt - bis irgendein Event
      // zufällig doch ein window-resize auslöst (z.B. Fullscreen rein+raus,
      // was der Browser immer mit einem resize-Event begleitet).
      // Der ResizeObserver beobachtet die tatsächliche Elementgröße direkt
      // und behebt das zuverlässig, auch beim allerersten Layout-Durchlauf.
      if (window.ResizeObserver) {
        this._canvasResizeObserver = new ResizeObserver(() => {
          this._resizeCanvas();
          this._drawTimeline();
          this._renderVideoZoom();
        });
        this._canvasResizeObserver.observe(this.querySelector('.wwc-timeline-wrap'));
        this._canvasResizeObserver.observe(this.videoWrapEl);
      } else {
        // Fallback für sehr alte Browser ohne ResizeObserver: nach dem
        // ersten Layout-Durchlauf (nächster Frame) nochmal neu messen.
        requestAnimationFrame(() => {
          if (signal.aborted) return;
          this._resizeCanvas();
          this._drawTimeline();
        });
      }

    } else if (this._playbackRequested && !this._playbackPaused && this._waitingForCamera && this._cameraServiceData()) {
      this._startPlayback();
    }
    this._syncPreview();
    this._syncTimeline();
  }

  _observeCardVisibility() {
    this._cardVisible = !window.IntersectionObserver;
    if (!window.IntersectionObserver) return;
    const observer = new IntersectionObserver(([entry]) => {
      if (this._visibilityObserver !== observer) return;
      this._cardVisible = entry.isIntersecting;
      this._syncPreview();
      this._syncTimeline();
    });
    this._visibilityObserver = observer;
    observer.observe(this.playerEl);
  }

  _previewSource() {
    const states = this._hass.states;
    if (!states) return null;
    const { entity, camera_id: cameraId, config_entry_id: entryId } = this.config;
    const configured = entity && states[entity];
    if (configured && (!cameraId || configured.attributes.wisenet_camera_id === cameraId) &&
        (!entryId || configured.attributes.wisenet_entry_id === entryId)) {
      return configured.attributes.entity_picture;
    }
    if (!cameraId) return null;
    const matching = Object.values(states).filter((state) => state.entity_id.startsWith('camera.') &&
      state.attributes.wisenet_camera_id === cameraId &&
      (!entryId || state.attributes.wisenet_entry_id === entryId));
    return matching.length === 1 ? matching[0].attributes.entity_picture : null;
  }

  _syncPreview() {
    if (!this._cardVisible || document.hidden || this._playbackRequested) {
      this._stopPreview();
      return;
    }
    if (this._previewTimer !== null || !this._previewSource()) return;
    this._refreshPreview();
    this._previewTimer = setInterval(() => this._refreshPreview(), PREVIEW_INTERVAL_MS);
  }

  _stopPreview() {
    clearInterval(this._previewTimer);
    this._previewTimer = null;
    this._previewRequest?.abort();
    this._previewRequest = null;
  }

  async _refreshPreview() {
    if (this._previewRequest) return;
    const source = this._previewSource();
    if (!source) return;
    const request = new AbortController();
    this._previewRequest = request;
    const timeout = setTimeout(() => request.abort(), PREVIEW_TIMEOUT_MS);
    let imageUrl;
    try {
      const response = await fetch(source, { cache: 'no-store', signal: request.signal });
      if (!response.ok) return;
      imageUrl = URL.createObjectURL(await response.blob());
      const image = new Image();
      image.alt = '';
      image.src = imageUrl;
      await image.decode();
      if (request.signal.aborted) return;
      this.previewEl.replaceChildren(image);
      if (this._previewObjectUrl) URL.revokeObjectURL(this._previewObjectUrl);
      this._previewObjectUrl = imageUrl;
      imageUrl = null;
    } catch {
      // Keep the last successful image when a single snapshot fails.
    } finally {
      clearTimeout(timeout);
      if (imageUrl) URL.revokeObjectURL(imageUrl);
      if (this._previewRequest === request) this._previewRequest = null;
    }
  }

  _setupTransportControls() {
    this.startVideoBtnEl.addEventListener('click', () => this._togglePlayback());
    this.playPauseBtnEl.addEventListener('click', () => this._togglePlayback());
    this.stopBtnEl.addEventListener('click', () => this._stopPlayback());
    this.querySelector('#wave-skip-back').addEventListener('click', () => this._skip(-SEEK_STEP_MS));
    this.querySelector('#wave-skip-fwd').addEventListener('click', () => this._skip(SEEK_STEP_MS));
    this.liveBtnEl.addEventListener('click', () => this.seekTo(Date.now(), { isLive: true }));
    this.querySelector('#wave-zoom-in').addEventListener('click', () => this._zoomBy(0.5, null));
    this.querySelector('#wave-zoom-out').addEventListener('click', () => this._zoomBy(2, null));

    this.muteBtnEl = this.querySelector('#wave-mute');
    this.muteBtnEl.addEventListener('click', () => this._toggleMute());

    this.fullscreenBtnEl = this.querySelector('#wave-fullscreen');
    this.fullscreenBtnEl.hidden = !this.playerEl.requestFullscreen;
    this.fullscreenBtnEl.addEventListener('click', () => this._toggleFullscreen());
    const { signal } = this._listeners;
    document.addEventListener('fullscreenchange', () => {
      const fullscreen = this.playerEl.matches(':fullscreen');
      const label = fullscreen ? 'Vollbild verlassen' : 'Vollbild';
      this.fullscreenBtnEl.title = `${label} (F)`;
      this.fullscreenBtnEl.setAttribute('aria-label', label);
      this.fullscreenBtnEl.querySelector('ha-icon').setAttribute('icon', fullscreen ? 'mdi:fullscreen-exit' : 'mdi:fullscreen');
      if (fullscreen) this.playerEl.focus({ preventScroll: true });
      this._showFullscreenControls();
    }, { signal });
    document.addEventListener('keydown', (event) => this._handleFullscreenKey(event), { signal });
    const revealControls = () => {
      if (this.playerEl.matches(':fullscreen')) this._showFullscreenControls();
    };
    this.playerEl.addEventListener('pointermove', revealControls, { signal });
    this.playerEl.addEventListener('pointerdown', revealControls, { signal });
    this.playerEl.addEventListener('click', (event) => {
      if (event.detail > 0 && event.target.closest?.('button') && this.playerEl.matches(':fullscreen')) {
        this.playerEl.focus({ preventScroll: true });
      }
    }, { signal });
  }

  _toggleMute() {
    this.videoEl.muted = !this.videoEl.muted;
    this._syncMuteIcon();
  }

  _syncMuteIcon() {
    const muted = this.videoEl.muted || this.videoEl.volume === 0;
    this.muteBtnEl.querySelector('ha-icon').setAttribute('icon', muted ? 'mdi:volume-off' : 'mdi:volume-high');
  }

  async _toggleFullscreen() {
    try {
      if (this.playerEl.matches(':fullscreen')) await document.exitFullscreen();
      else await this.playerEl.requestFullscreen?.();
    } catch {
      // The document or an embedding page can disallow fullscreen.
    }
  }

  _showFullscreenControls() {
    clearTimeout(this._fullscreenControlsTimer);
    this._fullscreenControlsTimer = null;
    this.playerEl.classList.remove('wwc-controls-hidden');
    if (this.playerEl.matches(':fullscreen') && !this.videoEl.paused && !this._playbackPaused) {
      this._fullscreenControlsTimer = setTimeout(() => {
        this._fullscreenControlsTimer = null;
        this.playerEl.classList.add('wwc-controls-hidden');
      }, FULLSCREEN_CONTROLS_MS);
    }
  }

  _handleFullscreenKey(event) {
    if (!this.playerEl.matches(':fullscreen') || event.defaultPrevented || event.altKey ||
        event.ctrlKey || event.metaKey) return;
    const target = event.composedPath()[0];
    if (target.isContentEditable || target.closest?.('input, textarea, select, [role="textbox"]')) return;
    const key = event.key.toLowerCase();
    if (key === ' ' && target.closest?.('button')) return;
    if (![' ', 'k', 'arrowleft', 'arrowright', 'arrowup', 'arrowdown', 'm', 'f'].includes(key)) return;
    event.preventDefault();
    this._showFullscreenControls();
    if (event.repeat) return;
    switch (key) {
      case ' ':
      case 'k': this._togglePlayback(); break;
      case 'arrowleft': this._skip(-SEEK_STEP_MS); break;
      case 'arrowright': this._skip(SEEK_STEP_MS); break;
      case 'arrowup':
      case 'arrowdown':
        this.videoEl.volume = Math.max(0, Math.min(1, this.videoEl.volume + (key === 'arrowup' ? 0.1 : -0.1)));
        this.videoEl.muted = false;
        this._syncMuteIcon();
        break;
      case 'm': this._toggleMute(); break;
      case 'f': this._toggleFullscreen(); break;
    }
  }

  _skip(deltaMs) {
    if (this._isLive && deltaMs > 0) return;
    const now = Date.now();
    const target = (this._isLive ? now : this._playheadMs) + deltaMs;
    if (this.playerEl.matches(':fullscreen')) {
      clearTimeout(this._seekFeedbackTimer);
      this.seekFeedbackEl.textContent = target >= now ? 'Live' : deltaMs < 0 ? '−10 s' : '+10 s';
      this.seekFeedbackEl.hidden = false;
      this._seekFeedbackTimer = setTimeout(() => {
        this._seekFeedbackTimer = null;
        this.seekFeedbackEl.hidden = true;
      }, 800);
    }
    this.seekTo(Math.min(target, now), { isLive: target >= now });
  }

  _setupVideoZoom() {
    const wrap = this.videoWrapEl;
    const { signal } = this._listeners;
    const zoomIn = this.querySelector('#wave-video-zoom-in');
    const zoomOut = this.querySelector('#wave-video-zoom-out');
    const reset = this.querySelector('#wave-video-zoom-reset');
    this._videoZoomControls = { zoomIn, zoomOut, reset };
    zoomIn.addEventListener('click', () => this._setVideoZoom(this._nextVideoZoom(1)), { signal });
    zoomOut.addEventListener('click', () => this._setVideoZoom(this._nextVideoZoom(-1)), { signal });
    reset.addEventListener('click', () => this._setVideoZoom(1), { signal });
    this.videoEl.addEventListener('resize', () => this._renderVideoZoom(), { signal });

    const videoAnchors = (...points) => {
      const { width, height } = this._videoImageSize();
      const rect = wrap.getBoundingClientRect();
      if (!width || !height || !rect.width || !rect.height) return null;
      return points.map(({ x, y }) => ({
        x: ((x - rect.left) / rect.width - 0.5) * wrap.clientWidth / width,
        y: ((y - rect.top) / rect.height - 0.5) * wrap.clientHeight / height,
      }));
    };

    let wheelDelta = 0;
    let lastWheelAt = 0;
    wrap.addEventListener('wheel', (event) => {
      if (!this._playbackRequested) return;
      const mode = event.deltaMode;
      const { deltaX, deltaY } = event;
      if (event.ctrlKey || event.metaKey || !deltaY || Math.abs(deltaX) > Math.abs(deltaY)) return;
      const step = deltaY < 0 ? 1 : -1;
      const zoom = this._nextVideoZoom(step);
      if (zoom === this._videoZoom) {
        wheelDelta = 0;
        return;
      }
      const anchors = videoAnchors({ x: event.clientX, y: event.clientY });
      if (!anchors) return;
      event.preventDefault();
      const now = performance.now();
      if (now - lastWheelAt > 180 || Math.sign(wheelDelta) !== Math.sign(deltaY)) wheelDelta = 0;
      lastWheelAt = now;
      wheelDelta += deltaY * (mode === 1 ? 16 : mode === 2 ? wrap.clientHeight : 1);
      if (Math.abs(wheelDelta) < 40) return;
      wheelDelta = 0;
      this._setVideoZoom(zoom, anchors[0]);
    }, { passive: false, signal });

    const pointers = new Map();
    const updateDragCursor = () => {
      wrap.classList.toggle('wwc-video-dragging', pointers.size > 0 && this._videoZoom > 1);
    };
    wrap.addEventListener('pointerdown', (event) => {
      if (!this._playbackRequested || event.button !== 0 || event.target.closest('button')) return;
      const touch = event.pointerType === 'touch';
      if (pointers.size >= 2 || (pointers.size && (!touch || !pointers.values().next().value.touch)) ||
          (!touch && this._videoZoom === 1)) return;
      pointers.set(event.pointerId, { x: event.clientX, y: event.clientY, touch });
      wrap.setPointerCapture(event.pointerId);
      updateDragCursor();
    }, { signal });
    wrap.addEventListener('pointermove', (event) => {
      const previous = pointers.get(event.pointerId);
      if (!previous || !this._playbackRequested) return;
      const current = { ...previous, x: event.clientX, y: event.clientY };
      pointers.set(event.pointerId, current);

      let zoom = this._videoZoom;
      let from = previous;
      let to = current;
      if (pointers.size === 2) {
        const other = [...pointers.values()].find((point) => point !== current);
        const before = Math.hypot(previous.x - other.x, previous.y - other.y);
        const after = Math.hypot(current.x - other.x, current.y - other.y);
        if (before >= 1) zoom *= after / before;
        from = { x: (previous.x + other.x) / 2, y: (previous.y + other.y) / 2 };
        to = { x: (current.x + other.x) / 2, y: (current.y + other.y) / 2 };
      } else if (zoom === 1) {
        return;
      }
      const anchors = videoAnchors(from, to);
      if (anchors) this._setVideoZoom(zoom, ...anchors);
      updateDragCursor();
    }, { signal });
    const releasePointer = (event) => {
      if (pointers.delete(event.pointerId)) updateDragCursor();
    };
    for (const type of ['pointerup', 'pointercancel', 'lostpointercapture']) {
      wrap.addEventListener(type, releasePointer, { signal });
    }
    this._renderVideoZoom();
  }

  _nextVideoZoom(direction) {
    if (direction > 0) return VIDEO_ZOOM_LEVELS.find((level) => level > this._videoZoom + 0.0001) ?? MAX_VIDEO_ZOOM;
    const index = VIDEO_ZOOM_LEVELS.findIndex((level) => level >= this._videoZoom - 0.0001);
    return VIDEO_ZOOM_LEVELS[Math.max(0, index - 1)];
  }

  _setVideoZoom(zoom, from = { x: 0, y: 0 }, to = from) {
    const previous = this._videoZoom;
    this._videoZoom = Math.max(1, Math.min(MAX_VIDEO_ZOOM, zoom));
    const ratio = this._videoZoom / previous;
    this._videoOffsetX = (this._videoOffsetX - from.x) * ratio + to.x;
    this._videoOffsetY = (this._videoOffsetY - from.y) * ratio + to.y;
    this._renderVideoZoom();
  }

  _videoImageSize() {
    const { clientWidth, clientHeight } = this.videoWrapEl;
    const { videoWidth, videoHeight } = this.videoEl;
    if (!videoWidth || !videoHeight) return { width: clientWidth, height: clientHeight };
    const fit = Math.min(clientWidth / videoWidth, clientHeight / videoHeight);
    return { width: videoWidth * fit, height: videoHeight * fit };
  }

  _renderVideoZoom() {
    const zoom = this._videoZoom;
    const wrap = this.videoWrapEl;
    const { zoomIn, zoomOut, reset } = this._videoZoomControls;
    const label = `${VIDEO_ZOOM_FORMAT.format(zoom)}×`;
    zoomIn.disabled = zoom === MAX_VIDEO_ZOOM;
    zoomOut.disabled = reset.disabled = zoom === 1;
    if (reset.textContent !== label || !reset.hasAttribute('aria-label')) {
      reset.textContent = label;
      reset.setAttribute('aria-label', `Videozoom ${label}, zurücksetzen`);
    }
    wrap.classList.toggle('wwc-video-pannable', zoom > 1);

    const { width, height } = this._videoImageSize();
    if (!width || !height) return;
    const limitX = Math.max(0, (zoom - wrap.clientWidth / width) / 2);
    const limitY = Math.max(0, (zoom - wrap.clientHeight / height) / 2);
    this._videoOffsetX = Math.max(-limitX, Math.min(limitX, this._videoOffsetX));
    this._videoOffsetY = Math.max(-limitY, Math.min(limitY, this._videoOffsetY));
    this.videoEl.style.transform = zoom === 1 ? '' :
      `translate(${this._videoOffsetX * width}px, ${this._videoOffsetY * height}px) scale(${zoom})`;
  }

  _setupVideoEvents() {
    const { signal } = this._listeners;
    this.videoEl.addEventListener('play', () => {
      this._showFullscreenControls();
      this._startPlayheadLoop();
      this._startLoadWatchdog();
    }, { signal });
    this.videoEl.addEventListener('pause', () => {
      this._showFullscreenControls();
      this._stopPlayheadLoop();
    }, { signal });
    this.videoEl.addEventListener('error', () => {
      if (!this.hls && this._currentStreamUrl && this.videoEl.error) {
        this._queueStreamRetry('Videofehler', this._activeStreamToken);
      }
    }, { signal });
    this.videoEl.addEventListener('ended', () => {
      if (this.videoEl.ended && this._streamMode === 'archive' && this._playbackRequested) this._stopPlayback();
    }, { signal });
    // Bug-Fix: Nach jedem Stream-Wechsel (Seek, Skip vor/zurück, Reload,
    // Live<->Archiv) lädt der Browser neue Video-Dimensionen ins gleiche
    // <video>-Element. "object-fit: contain" wird dabei nicht immer sofort
    // korrekt neu berechnet, wodurch das Bild kurz (oder dauerhaft, bis ein
    // Resize/Fullscreen-Event zufällig nachhilft) mit falschem
    // Seitenverhältnis/schwarzen Balken angezeigt wird. "loadedmetadata"
    // feuert zuverlässig, sobald die echten Dimensionen des neuen Streams
    // bekannt sind - genau der richtige Zeitpunkt für den Reflow-Trick.
    this.videoEl.addEventListener('loadedmetadata', () => {
      // Diagnose-Log: zeigt die TATSÄCHLICHE Auflösung/Seitenverhältnis des
      // gerade geladenen Videos, plus (falls vorhanden) die von hls.js
      // gewählte Qualitätsstufe. Damit lässt sich unterscheiden, ob das
      // Balken-Problem an einem Renderingfehler liegt (Auflösung stimmt,
      // Darstellung nicht) oder daran, dass der Server tatsächlich ein
      // Video mit anderem Seitenverhältnis ausliefert (z.B. weil im
      // Archiv-Modus eine andere Qualitätsstufe/"lo"-Variante als im
      // Live-Modus gewählt wird).
      const vw = this.videoEl.videoWidth;
      const vh = this.videoEl.videoHeight;
      const level = this.hls && this.hls.currentLevel >= 0 ? this.hls.levels?.[this.hls.currentLevel] : null;
      console.info(
        `[wisenet-wave-card] loadedmetadata: video=${vw}x${vh} (Seitenverhältnis ${(vw / vh).toFixed(3)}), ` +
        `Modus=${this._streamMode}, hls-Level=${this.hls?.currentLevel ?? 'n/a'}` +
        (level ? ` (${level.width}x${level.height}, bitrate=${level.bitrate})` : ''),
      );
      this._refreshVideoLayout();
    }, { signal });
  }

  _startLoadWatchdog() {
    if (this._loadWatchdogId !== null || !this._currentStreamUrl ||
        !this._playbackRequested || this._playbackPaused) return;
    const now = performance.now();
    this._playbackMonitor = {
      checkedAt: now,
      time: this.videoEl.currentTime,
      timeAdvancedAt: now,
      frames: null,
      framesAdvancedAt: now,
      stableSince: null,
    };
    this._loadWatchdogId = setInterval(() => this._checkPlayback(), PLAYBACK_CHECK_MS);
  }

  _playVideo() {
    if (!this._playbackRequested || this._playbackPaused) return;
    this._startLoadWatchdog();
    const monitor = this._playbackMonitor;
    this.videoEl.play().catch((error) => {
      if (error.name === 'NotAllowedError' && monitor && this._playbackMonitor === monitor) {
        this._stopPlayback();
        this.errorEl.innerText = 'Der Browser hat den Stream angehalten. Bitte erneut starten.';
      }
    });
  }

  _checkPlayback() {
    const video = this.videoEl;
    const monitor = this._playbackMonitor;
    const now = performance.now();
    const frameCounts = video.videoWidth ? video.getVideoPlaybackQuality?.() : null;
    const frames = frameCounts?.totalVideoFrames > 0 ?
      frameCounts.totalVideoFrames - frameCounts.droppedVideoFrames : null;
    const resumed = now - monitor.checkedAt > 3 * PLAYBACK_CHECK_MS;
    monitor.checkedAt = now;

    if (document.hidden || resumed || video.seeking) {
      monitor.time = video.currentTime;
      monitor.frames = frames;
      monitor.timeAdvancedAt = monitor.framesAdvancedAt = now;
      monitor.stableSince = null;
      return;
    }

    const advanced = !video.paused && Math.abs(video.currentTime - monitor.time) >= 0.05;
    const frameAdvanced = frames === null || frames !== monitor.frames;
    if (advanced) {
      monitor.time = video.currentTime;
      monitor.timeAdvancedAt = now;
    }
    if (frameAdvanced) {
      monitor.frames = frames;
      monitor.framesAdvancedAt = now;
    }
    if (advanced && frameAdvanced) {
      if (this._hlsRetryTimer !== null && !this._cancelRetryOnProgress) return;
      this._clearHlsRetry();
      this._clearHlsRecoveryNotice();
      monitor.stableSince ??= now;
      if (now - monitor.stableSince >= 10000) this._hlsRetryCount = 0;
    } else {
      monitor.stableSince = null;
    }

    if (now - monitor.timeAdvancedAt >= PLAYBACK_STALL_MS ||
        now - monitor.framesAdvancedAt >= VIDEO_FRAME_STALL_MS) {
      this._queueStreamRetry('Wiedergabe steht still', this._activeStreamToken, true);
    }
  }

  _clearLoadWatchdog() {
    clearInterval(this._loadWatchdogId);
    this._loadWatchdogId = null;
    this._playbackMonitor = null;
  }

  _syncVideoUi() {
    const isLive = this._streamMode === 'live' || this._isLive;

    // Bug-Fix: vorher wurde das controls-Attribut nach dem Setzen sofort
    // wieder entfernt ("this.videoEl.controls = !isLive;" gefolgt von
    // "removeAttribute('controls')"), wodurch der Player in Live- UND
    // Archiv-Modus immer identisch aussah (native Steuerleiste je nach
    // Browser-Timing mal da, mal weg - unabhängig vom Modus). Jetzt: nie
    // native Controls, immer die eigene Toolbar - eindeutig und ohne
    // Race-Conditions.
    this.videoEl.removeAttribute('controls');
    this.videoEl.setAttribute('controlslist', 'nodownload noplaybackrate nofullscreen');
    this.videoEl.classList.toggle('wwc-live-no-controls', isLive);
    this.videoEl.style.setProperty('pointer-events', 'none');

    if (this.liveBadgeEl) {
      this.liveBadgeEl.style.display = isLive && this._playbackRequested && !this._playbackPaused ? 'flex' : 'none';
    }

    const skipFwdBtn = this.querySelector('#wave-skip-fwd');
    skipFwdBtn.disabled = isLive;
    const playbackLabel = !this._playbackRequested ? 'Stream starten' :
      this._playbackPaused ? 'Stream fortsetzen' : 'Stream pausieren';
    const waiting = !this._playbackRequested || (this._playbackPaused && !this._currentStreamUrl);
    this.videoWrapEl.classList.toggle('wwc-video-idle', waiting);
    this.startVideoBtnEl.hidden = this._playbackRequested && !this._playbackPaused;
    this.startVideoBtnEl.setAttribute('aria-label', this._playbackPaused ? 'Video fortsetzen' : 'Video starten');
    this.startVideoBtnEl.title = this._playbackPaused ? 'Video fortsetzen' : 'Video starten';
    this.stopBtnEl.hidden = !this._playbackRequested;
    this.playPauseBtnEl.setAttribute('title', playbackLabel);
    this.playPauseBtnEl.setAttribute('aria-label', playbackLabel);
    this.playPauseBtnEl.querySelector('ha-icon').setAttribute('icon',
      this._playbackRequested && !this._playbackPaused ? 'mdi:pause' : 'mdi:play');
    this._syncPreview();
    this._showFullscreenControls();
  }

  _startPlayheadLoop() {
    if (this._rafId) return;
    let lastDraw = -Infinity;
    const tick = (now) => {
      if (now - lastDraw >= PLAYHEAD_UPDATE_MS && this._streamStartMs != null && !this.videoEl.paused) {
        lastDraw = now;
        if (this._isLive && this._followLiveTimeline) {
          const span = this._viewEnd - this._viewStart;
          const now = Date.now();
          this._viewEnd = now;
          this._viewStart = now - span;
        }
        this._playheadMs = this._streamStartMs + this.videoEl.currentTime * 1000;
        this._updateTimeLabel();
        this._drawTimeline();
      }
      this._rafId = requestAnimationFrame(tick);
    };
    this._rafId = requestAnimationFrame(tick);
  }

  _stopPlayheadLoop() {
    if (this._rafId) {
      cancelAnimationFrame(this._rafId);
      this._rafId = null;
    }
  }

  // ---------- Zeitleisten-Interaktion (Zoom / Pan / Klick) ----------

  _setupTimelineInteraction() {
    const canvas = this.canvasEl;
    const { signal } = this._listeners;

    canvas.addEventListener('wheel', (ev) => {
      ev.preventDefault();
      const rect = canvas.getBoundingClientRect();
      const x = ev.clientX - rect.left;
      const factor = ev.deltaY > 0 ? 1.3 : 1 / 1.3;
      this._zoomBy(factor, x / rect.width);
    }, { passive: false });

    canvas.addEventListener('mousedown', (ev) => {
      this._dragState = { startX: ev.clientX, moved: false, origStart: this._viewStart, origEnd: this._viewEnd };
    });
    window.addEventListener('mousemove', (ev) => {
      if (!this._dragState) return;
      const dx = ev.clientX - this._dragState.startX;
      if (Math.abs(dx) > 3) {
        this._dragState.moved = true;
        this._followLiveTimeline = false;
      }
      const rect = canvas.getBoundingClientRect();
      const span = this._dragState.origEnd - this._dragState.origStart;
      const deltaMs = (dx / rect.width) * span;
      this._viewStart = this._dragState.origStart - deltaMs;
      this._viewEnd = this._dragState.origEnd - deltaMs;
      this._clampView();
      this._drawTimeline();
    }, { signal });
    window.addEventListener('mouseup', (ev) => {
      if (!this._dragState) return;
      const wasDrag = this._dragState.moved;
      this._dragState = null;
      this._scheduleFetch();
      if (!wasDrag) {
        const rect = canvas.getBoundingClientRect();
        const x = ev.clientX - rect.left;
        if (x >= 0 && x <= rect.width) {
          const t = this._viewStart + (x / rect.width) * (this._viewEnd - this._viewStart);
          this.seekTo(t);
        }
      }
    }, { signal });

    // Touch: 1 Finger = Pan/Klick, 2 Finger = Pinch-Zoom
    canvas.addEventListener('touchstart', (ev) => {
      if (ev.touches.length === 1) {
        const t = ev.touches[0];
        this._dragState = { startX: t.clientX, moved: false, origStart: this._viewStart, origEnd: this._viewEnd };
      } else if (ev.touches.length === 2) {
        this._dragState = null;
        this._pinchState = {
          startDist: this._touchDist(ev.touches),
          origStart: this._viewStart,
          origEnd: this._viewEnd,
        };
      }
    }, { passive: true });

    canvas.addEventListener('touchmove', (ev) => {
      const rect = canvas.getBoundingClientRect();
      if (ev.touches.length === 1 && this._dragState) {
        const dx = ev.touches[0].clientX - this._dragState.startX;
        if (Math.abs(dx) > 3) {
          this._dragState.moved = true;
          this._followLiveTimeline = false;
        }
        const span = this._dragState.origEnd - this._dragState.origStart;
        const deltaMs = (dx / rect.width) * span;
        this._viewStart = this._dragState.origStart - deltaMs;
        this._viewEnd = this._dragState.origEnd - deltaMs;
        this._clampView();
        this._drawTimeline();
      } else if (ev.touches.length === 2 && this._pinchState) {
        this._followLiveTimeline = false;
        const dist = this._touchDist(ev.touches);
        const factor = this._pinchState.startDist / Math.max(dist, 1);
        const span = this._pinchState.origEnd - this._pinchState.origStart;
        const center = this._pinchState.origStart + span / 2;
        const newSpan = this._clampSpan(span * factor);
        this._viewStart = center - newSpan / 2;
        this._viewEnd = center + newSpan / 2;
        this._clampView();
        this._drawTimeline();
      }
    }, { passive: true });

    canvas.addEventListener('touchend', (ev) => {
      if (ev.touches.length === 0) {
        const wasDrag = this._dragState && this._dragState.moved;
        const dragState = this._dragState;
        this._dragState = null;
        this._pinchState = null;
        this._scheduleFetch();
        if (dragState && !wasDrag && ev.changedTouches.length) {
          const rect = canvas.getBoundingClientRect();
          const x = ev.changedTouches[0].clientX - rect.left;
          const t = this._viewStart + (x / rect.width) * (this._viewEnd - this._viewStart);
          this.seekTo(t);
        }
      }
    });
  }

  _touchDist(touches) {
    const dx = touches[0].clientX - touches[1].clientX;
    const dy = touches[0].clientY - touches[1].clientY;
    return Math.sqrt(dx * dx + dy * dy);
  }

  _clampSpan(span) {
    const MIN_SPAN = 5 * 60 * 1000;        // 5 Minuten
    const MAX_SPAN = 60 * 24 * 60 * 60 * 1000; // 60 Tage
    return Math.min(Math.max(span, MIN_SPAN), MAX_SPAN);
  }

  // Verhindert, dass man den sichtbaren Bereich per Zoom/Pan komplett aus
  // dem sinnvollen Bereich schiebt: nicht in die Zukunft über "jetzt"
  // hinaus (da rechts davon sowieso nie Aufnahmen liegen können).
  _clampView() {
    const nowBuffer = Date.now() + 5000;
    if (this._viewEnd > nowBuffer) {
      const span = this._viewEnd - this._viewStart;
      this._viewEnd = nowBuffer;
      this._viewStart = nowBuffer - span;
    }
  }

  // factor < 1 = reinzoomen, factor > 1 = rauszoomen. anchorRatio (0..1):
  // Position im Canvas, die beim Zoom fix bleiben soll (null = Mitte).
  _zoomBy(factor, anchorRatio) {
    this._followLiveTimeline = false;
    const span = this._viewEnd - this._viewStart;
    const ratio = anchorRatio == null ? 0.5 : anchorRatio;
    const anchorTime = this._viewStart + span * ratio;
    const newSpan = this._clampSpan(span * factor);
    this._viewStart = anchorTime - newSpan * ratio;
    this._viewEnd = this._viewStart + newSpan;
    this._clampView();
    this._drawTimeline();
    this._scheduleFetch();
  }

  _resizeCanvas() {
    const rect = this.canvasEl.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    this.canvasEl.width = Math.max(1, Math.floor(rect.width * dpr));
    this.canvasEl.height = Math.max(1, Math.floor(46 * dpr));
  }

  _refreshVideoLayout() {
    this._renderVideoZoom();
    if (!this.videoEl || !this._currentStreamUrl) return;
    // Bug-Fix: Dieser Reflow-Trick wurde bisher nur im Live-Modus
    // ausgeführt ("if (!isLive) return;"). Genau dasselbe Rendering-Problem
    // (Video wird mit falschem Seitenverhältnis/schwarzen Balken
    // dargestellt, bis irgendein Layout-Ereignis einen Neuaufbau erzwingt)
    // tritt aber genauso im Archiv-Modus auf - z.B. nach Skip vor/zurück
    // oder Neuladen der Karte, wenn ein neuer Stream mit anderen
    // Dimensionen ins selbe <video>-Element geladen wird und der Browser
    // "object-fit: contain" nicht sofort neu berechnet. Die frühere
    // isLive-Einschränkung war also selbst der Bug - jetzt für beide Modi.
    this.videoEl.style.visibility = 'hidden';
    this.videoEl.offsetHeight;
    this.videoEl.style.visibility = 'visible';
  }

  // ---------- Daten laden ----------

  _syncTimeline() {
    const active = this._cardVisible && !document.hidden;
    if (active === this._timelineActive) {
      if (active && this._timelineWaitingForCamera && this.resolveCameraId()) this._scheduleFetch();
      return;
    }
    this._timelineActive = active;
    if (active) {
      this._scheduleFetch();
    } else {
      clearTimeout(this._fetchDebounce);
      clearTimeout(this._timelineRetryTimer);
      this._fetchDebounce = null;
      this._timelineRetryTimer = null;
    }
  }

  _scheduleFetch() {
    clearTimeout(this._fetchDebounce);
    if (!this._timelineActive) return;
    this._fetchDebounce = setTimeout(() => {
      this._fetchDebounce = null;
      this._fetchVisiblePeriods();
    }, 250);
  }

  _dayKey(ms) {
    return new Date(ms).toISOString().slice(0, 10);
  }

  _scheduleTimelineRetry(delay) {
    if (!this._timelineActive) return;
    const deadline = Date.now() + delay;
    if (this._timelineRetryTimer !== null && this._timelineRetryAt <= deadline) return;
    clearTimeout(this._timelineRetryTimer);
    this._timelineRetryAt = deadline;
    this._timelineRetryTimer = setTimeout(() => {
      this._timelineRetryTimer = null;
      this._fetchVisiblePeriods();
    }, delay);
  }

  async _fetchVisiblePeriods() {
    if (!this._timelineActive) return;
    const { signal } = this._listeners;
    const camera = this._cameraServiceData();
    this._timelineWaitingForCamera = !camera;
    if (!camera) return;

    const now = Date.now();
    if (this._isLive && this._followLiveTimeline && !this._dragState && !this._pinchState) {
      const span = this._viewEnd - this._viewStart;
      this._viewEnd = now;
      this._viewStart = now - span;
      if (!this._playbackRequested) {
        this._playheadMs = now;
        this._updateTimeLabel();
      }
      this._drawTimeline();
    }
    const bufferMs = (this._viewEnd - this._viewStart) * 0.5;
    const from = this._viewStart - bufferMs;
    const to = Math.min(now + 1, this._viewEnd + bufferMs);
    const dayMs = 24 * 60 * 60 * 1000;
    const requests = [];
    const keys = [];
    let hasMore = false;
    for (let dayStart = Math.floor(from / dayMs) * dayMs; dayStart < to; dayStart += dayMs) {
      const key = `${camera.camera_id}_${this._dayKey(dayStart)}`;
      keys.push(key);
      const cached = this._periodsCache.get(key);
      const fetchAt = cached?.retryAt ?? cached?.refreshAt;
      if (this._pendingFetches.has(key) || (cached && fetchAt === undefined)) continue;
      if (fetchAt > now) {
        this._scheduleTimelineRetry(fetchAt - now);
        continue;
      }
      if (this._pendingFetches.size >= TIMELINE_REQUEST_LIMIT) {
        hasMore = true;
        continue;
      }
      this._pendingFetches.add(key);
      requests.push(this._fetchTimelineDay(camera, key, dayStart, dayStart + dayMs, signal));
    }
    this._visibleTimelineKeys = keys;
    await Promise.all(requests);
    if (signal.aborted || !this._timelineActive) return;
    if (hasMore) this._scheduleTimelineRetry(requests.length ? 0 : 1000);
    const hasError = this._visibleTimelineKeys.some((key) => this._periodsCache.get(key)?.retryAt);
    this.timelineErrorEl.innerText = hasError ? 'Zeitleiste vorübergehend unvollständig.' : '';
  }

  async _fetchTimelineDay(camera, key, start, end, signal) {
    let data;
    try {
      const result = await this._hass.callWS({
        type: 'call_service',
        domain: 'wisenet_wave',
        service: 'get_timeline',
        service_data: { ...camera, start_ms: start, end_ms: Math.min(end, Date.now()) },
        return_response: true,
      });
      data = result?.response ?? { error: 'Leere Antwort' };
    } catch (error) {
      data = { error };
    }
    if (signal.aborted) return;

    this._pendingFetches.delete(key);
    if (data.error) {
      console.warn('wisenet_wave: Zeitleistenabfrage fehlgeschlagen', data.error);
      const previous = this._periodsCache.get(key);
      data.recording = data.recording?.length ? data.recording : previous?.recording ?? [];
      data.motion = data.motion?.length ? data.motion : previous?.motion ?? [];
      const retryDelay = Math.min((previous?.retryDelay ?? TIMELINE_RETRY_MS / 2) * 2, 120000);
      data.retryAt = Date.now() + retryDelay;
      data.retryDelay = retryDelay;
      this._scheduleTimelineRetry(retryDelay);
    } else if (end > Date.now()) {
      data.refreshAt = Date.now() + TIMELINE_REFRESH_MS;
      this._scheduleTimelineRetry(TIMELINE_REFRESH_MS);
    }
    this._periodsCache.set(key, data);
    if (this._timelineActive) this._drawTimeline();
  }

  // ---------- Zeichnen ----------

  _periodsLookIdentical(a, b) {
    if (!Array.isArray(a) || !Array.isArray(b)) return false;
    if (a.length === 0 || a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) {
      const pa = a[i], pb = b[i];
      if (String(pa.startTimeMs ?? pa.start) !== String(pb.startTimeMs ?? pb.start)) return false;
      if (String(pa.durationMs ?? pa.duration) !== String(pb.durationMs ?? pb.duration)) return false;
    }
    return true;
  }

  _drawTimeline() {
    const ctx = this.canvasEl.getContext('2d');
    const dpr = window.devicePixelRatio || 1;
    const w = this.canvasEl.width;
    const h = this.canvasEl.height;
    const viewSpan = this._viewEnd - this._viewStart;

    ctx.clearRect(0, 0, w, h);

    const styles = getComputedStyle(this);
    const bg = styles.getPropertyValue('--divider-color').trim() || '#e0e0e0';
    const recColor = styles.getPropertyValue('--success-color').trim() || '#43a047';
    const motColor = styles.getPropertyValue('--error-color').trim() || '#db4437';
    const playheadColor = styles.getPropertyValue('--primary-text-color').trim() || '#000';

    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, w, h);

    const camId = this.resolveCameraId();
    const dayMs = 24 * 60 * 60 * 1000;
    const from = Math.floor(this._viewStart / dayMs) * dayMs;
    const to = this._viewEnd + dayMs;

    const drawPeriods = (periods, color) => {
      if (!periods) return;
      ctx.fillStyle = color;
      for (const p of periods) {
        const startMs = Number(p.startTimeMs ?? p.start ?? 0);
        const durMs = Number(p.durationMs ?? p.duration ?? 0);
        // WAVE liefert durationMs = -1 für Perioden, die noch laufen (z.B.
        // die aktuell aufgezeichnete Chunk). Die zeichnen wir bis "jetzt",
        // statt sie fälschlich auf 1 Minute zu verkürzen.
        const endMs = durMs < 0 ? Date.now() : (durMs > 0 ? startMs + durMs : startMs + 60000);
        if (endMs < this._viewStart || startMs > this._viewEnd) continue;
        const x1 = ((Math.max(startMs, this._viewStart) - this._viewStart) / viewSpan) * w;
        const x2 = ((Math.min(endMs, this._viewEnd) - this._viewStart) / viewSpan) * w;
        ctx.fillRect(x1, 0, Math.max(x2 - x1, 2 * dpr), h);
      }
    };

    for (let dayStart = from; dayStart < to; dayStart += dayMs) {
      const key = `${camId}_${this._dayKey(dayStart)}`;
      const data = this._periodsCache.get(key);
      if (data) {
        drawPeriods(data.recording, recColor);
        // Manche WAVE-Server liefern bei periodsType=motion exakt dieselben
        // Perioden wie bei recording zurück (keine echte Bewegungs-
        // Filterung verfügbar). Dann würde der rote Bewegungs-Balken den
        // grünen Aufnahme-Balken komplett verdecken und fälschlich
        // "durchgehend Bewegung" suggerieren - also in dem Fall lieber gar
        // nicht zeichnen, statt irreführend alles rot einzufärben.
        if (!this._periodsLookIdentical(data.recording, data.motion)) {
          drawPeriods(data.motion, motColor);
        } else if (!this._motionUnavailableWarned) {
          this._motionUnavailableWarned = true;
          console.warn(
            '[wisenet-wave-card] "motion"-Perioden sind identisch mit "recording" - dein WAVE-Server ' +
            'scheint periodsType=motion nicht separat zu unterstützen. Bewegungs-Einfärbung wird deshalb ausgeblendet.'
          );
        }
      }
    }

    // Playhead
    if (this._playheadMs >= this._viewStart && this._playheadMs <= this._viewEnd) {
      const x = ((this._playheadMs - this._viewStart) / viewSpan) * w;
      ctx.fillStyle = playheadColor;
      ctx.fillRect(Math.max(0, x - 1 * dpr), 0, 2 * dpr, h);
    }

    this._drawLabels(viewSpan);
  }

  _drawLabels(viewSpan) {
    const hour = 60 * 60 * 1000;
    const day = 24 * hour;
    let step, formatter;

    if (viewSpan <= 2 * hour) {
      step = 10 * 60 * 1000; // 10 Min
      formatter = (d) => d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    } else if (viewSpan <= 2 * day) {
      step = hour;
      formatter = (d) => d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    } else if (viewSpan <= 14 * day) {
      step = day;
      formatter = (d) => d.toLocaleDateString([], { day: '2-digit', month: '2-digit' });
    } else {
      step = 7 * day;
      formatter = (d) => d.toLocaleDateString([], { day: '2-digit', month: '2-digit' });
    }

    const first = Math.ceil(this._viewStart / step) * step;
    const labels = [];
    for (let t = first; t <= this._viewEnd; t += step) {
      const ratio = (t - this._viewStart) / viewSpan;
      labels.push({ ratio, text: formatter(new Date(t)) });
    }

    this.labelsEl.innerHTML = labels.map(
      (l) => `<span>${l.text}</span>`
    ).join('');
    this.labelsEl.style.position = 'relative';
    this.labelsEl.querySelectorAll('span').forEach((el, i) => {
      el.style.position = 'absolute';
      el.style.left = `${(labels[i].ratio * 100).toFixed(2)}%`;
      el.style.transform = 'translateX(-14px)';
    });
  }

  _updateTimeLabel() {
    const d = new Date(this._playheadMs);
    this.timeLabelEl.innerText = d.toLocaleString([], {
      day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit',
    });
    if (this.liveBtnEl) {
      this.liveBtnEl.classList.toggle('active', this._isLive && Math.abs(Date.now() - this._playheadMs) < 15000);
    }
  }

  // ---------- Wiedergabe ----------

  _startPlayback() {
    this._playbackRequested = true;
    this._playbackPaused = false;
    return this.seekTo(this._isLive ? Date.now() : this._playheadMs, { isLive: this._isLive });
  }

  _togglePlayback() {
    if (!this._playbackRequested) return this._startPlayback();
    if (this._playbackPaused) {
      if (this._isLive || !this._currentStreamUrl || this.videoEl.error) return this._startPlayback();
      this._playbackPaused = false;
      this.hls?.startLoad(this.videoEl.currentTime);
      this._playVideo();
      this._syncVideoUi();
      return;
    }

    this._playbackPaused = true;
    if (this._streamMode === 'archive' && this._streamStartMs !== null) {
      this._playheadMs = this._streamStartMs + this.videoEl.currentTime * 1000;
    }
    const needsRestart = this._hlsRetryTimer !== null || this.videoEl.error || this.videoEl.readyState < 2;
    this._clearHlsRetry();
    this._clearHlsRecoveryNotice();
    this._clearLoadWatchdog();
    if (needsRestart) {
      this._activeStreamToken += 1;
      this._waitingForCamera = false;
      this._releasePlayer();
    } else {
      this.hls?.stopLoad();
      this.videoEl.pause();
    }
    this._syncVideoUi();
    this._updateTimeLabel();
    this._drawTimeline();
  }

  _stopPlayback() {
    if (this._streamMode === 'archive' && this._streamStartMs !== null) {
      this._playheadMs = this._streamStartMs + this.videoEl.currentTime * 1000;
    }
    this._playbackRequested = false;
    this._playbackPaused = false;
    this._waitingForCamera = false;
    this._activeStreamToken += 1;
    this._clearHlsRetry();
    this._clearHlsRecoveryNotice();
    this._releasePlayer();
    this.errorEl.innerText = '';
    this._syncVideoUi();
    this._updateTimeLabel();
    this._drawTimeline();
  }

  async seekTo(timestampMs, options = {}) {
    this._clearHlsRetry();
    this._clearHlsRecoveryNotice();
    this._hlsRetryCount = 0;
    const token = ++this._activeStreamToken;

    this.errorEl.innerText = '';
    this._playheadMs = timestampMs;
    this._isLive = options.isLive ?? (Math.abs(Date.now() - timestampMs) < 15000);
    this._followLiveTimeline = this._isLive;
    this._streamMode = this._isLive ? 'live' : 'archive';
    if (this._isLive) {
      const span = this._viewEnd - this._viewStart;
      this._viewEnd = Date.now();
      this._viewStart = this._viewEnd - span;
    }
    if (this._playbackPaused) this._releasePlayer();
    this._syncVideoUi();
    this._updateTimeLabel();
    this._drawTimeline();
    this._scheduleFetch();
    if (!this._playbackRequested || this._playbackPaused) return;
    await this._requestStream(timestampMs, this._streamMode, token);
  }

  async _requestStream(timestampMs, mode, token) {
    this._releasePlayer();
    const camera = this._cameraServiceData();
    this._waitingForCamera = !camera;
    if (!camera) return;

    try {
      const response = await this._hass.callWS({
        type: 'call_service',
        domain: 'wisenet_wave',
        service: 'get_archive',
        service_data: {
          ...camera,
          timestamp_ms: Math.round(timestampMs),
          stream_mode: mode,
        },
        return_response: true,
      });
      if (token !== this._activeStreamToken) return;

      const url = response.response.url;
      if (!url) throw new Error('Keine Stream-URL');
      this._streamStartMs = mode === 'live' ? Date.now() : timestampMs;
      await this._initHlsPlayer(url, mode, token);
    } catch (error) {
      if (token !== this._activeStreamToken) return;
      console.warn('wisenet_wave: Stream konnte nicht gestartet werden', error);
      this._queueStreamRetry('Stream konnte nicht gestartet werden', token);
    }
  }

  _clearHlsRetry() {
    clearTimeout(this._hlsRetryTimer);
    this._hlsRetryTimer = null;
  }

  _showHlsRecoveryNotice(token) {
    if (this._hlsRecoveryNoticeTimer !== null || this.errorEl.innerText === HLS_RECOVERY_NOTICE) return;
    this._hlsRecoveryNoticeTimer = setTimeout(() => {
      this._hlsRecoveryNoticeTimer = null;
      if (token === this._activeStreamToken && this._playbackRequested) {
        this.errorEl.innerText = HLS_RECOVERY_NOTICE;
      }
    }, HLS_RECOVERY_NOTICE_MS);
  }

  _clearHlsRecoveryNotice() {
    clearTimeout(this._hlsRecoveryNoticeTimer);
    this._hlsRecoveryNoticeTimer = null;
    if (this.errorEl.innerText === HLS_RECOVERY_NOTICE) this.errorEl.innerText = '';
  }

  _queueStreamRetry(reason, token, cancelOnProgress = false) {
    if (token !== this._activeStreamToken || !this._playbackRequested || this._playbackPaused) return;
    if (this._hlsRetryTimer !== null) {
      if (!cancelOnProgress) this._cancelRetryOnProgress = false;
      return;
    }
    const delay = HLS_RETRY_DELAYS[this._hlsRetryCount];
    if (delay === undefined) {
      this._stopPlayback();
      this.errorEl.innerText = `HLS Fehler: ${reason}`;
      return;
    }

    const mode = this._streamMode;
    this._hlsRetryCount += 1;
    this._cancelRetryOnProgress = cancelOnProgress;
    this._showHlsRecoveryNotice(token);
    this._hlsRetryTimer = setTimeout(() => {
      this._hlsRetryTimer = null;
      if (token !== this._activeStreamToken || !this._playbackRequested) return;
      const timestamp = mode === 'live' ? Date.now() : this._playheadMs;
      this._requestStream(timestamp, mode, token);
    }, delay);
  }

  _releasePlayer() {
    this._clearLoadWatchdog();
    this._stopPlayheadLoop();
    this._currentStreamUrl = null;
    this._streamStartMs = null;
    const player = this.hls;
    const video = this.videoEl;
    const hadSource = player || video.hasAttribute('src') || video.srcObject;
    this.hls = null;
    player?.destroy();
    video.pause();
    if (hadSource) {
      video.removeAttribute('src');
      if (video.srcObject) video.srcObject = null;
      video.load();
    }
  }

  async _initHlsPlayer(url, mode, token) {
    const nativeHls = this.videoEl.canPlayType('application/vnd.apple.mpegurl');
    let Hls = window.Hls;
    if (!Hls) {
      try {
        Hls = await loadHlsLibrary();
      } catch (error) {
        if (!nativeHls) throw error;
      }
    }
    if (token !== this._activeStreamToken) return;

    this._currentStreamUrl = url;
    this._startLoadWatchdog();
    if (Hls?.isSupported()) {
      const player = new Hls({
        liveSyncDurationCount: 3,
        liveMaxLatencyDurationCount: 6,
        maxBufferLength: 20,
        maxBufferHole: 1.5,
        liveDurationInfinity: mode === 'live',
        startPosition: -1,
      });
      this.hls = player;
      let triedMediaRecovery = false;
      player.on(Hls.Events.MANIFEST_PARSED, () => {
        if (token !== this._activeStreamToken || this.hls !== player) return;
        this._playVideo();
      });
      player.on(Hls.Events.ERROR, (_event, data) => {
        if (!data.fatal || token !== this._activeStreamToken || this.hls !== player || this._playbackPaused) return;
        console.warn('wisenet_wave: HLS-Wiedergabe unterbrochen', data.type, data.details);
        if (!triedMediaRecovery && data.type === Hls.ErrorTypes.MEDIA_ERROR &&
            this.videoEl.error?.code === MediaError.MEDIA_ERR_DECODE &&
            (this._hlsRetryTimer === null || this._cancelRetryOnProgress)) {
          triedMediaRecovery = true;
          this._clearHlsRetry();
          this._clearLoadWatchdog();
          this._startLoadWatchdog();
          const resume = () => {
            if (token === this._activeStreamToken && this.hls === player) this._playVideo();
          };
          player.once(Hls.Events.MEDIA_ATTACHED, resume);
          try {
            player.recoverMediaError();
            return;
          } catch (error) {
            player.off(Hls.Events.MEDIA_ATTACHED, resume);
            console.warn('wisenet_wave: HLS-Decoder konnte nicht zurückgesetzt werden', error);
          }
        }
        this._queueStreamRetry(data.details ?? data.type, token);
      });
      player.loadSource(url);
      player.attachMedia(this.videoEl);
    } else if (nativeHls) {
      this.videoEl.src = url;
      this._playVideo();
    } else {
      throw new Error('Dieser Browser unterstützt keine HLS-Wiedergabe');
    }
  }

  // Diese Zeile sagt HA, wie groß die Karte im Raster ist
  getCardSize() {
    return 4;
  }

  disconnectedCallback() {
    if (!this._listeners) return;
    this._listeners.abort();
    this._listeners = null;
    this._playbackRequested = false;
    this._playbackPaused = false;
    this._waitingForCamera = false;
    this._activeStreamToken += 1;

    this._canvasResizeObserver?.disconnect();
    this._canvasResizeObserver = null;
    this._visibilityObserver?.disconnect();
    this._visibilityObserver = null;
    this._cardVisible = false;
    this._timelineActive = false;
    clearTimeout(this._fullscreenControlsTimer);
    clearTimeout(this._seekFeedbackTimer);
    this._stopPreview();
    if (this._previewObjectUrl) URL.revokeObjectURL(this._previewObjectUrl);
    this._previewObjectUrl = null;
    this._clearHlsRetry();
    this._clearHlsRecoveryNotice();
    this._releasePlayer();
    clearTimeout(this._fetchDebounce);
    clearTimeout(this._timelineRetryTimer);
    this._fetchDebounce = null;
    this._timelineRetryTimer = null;
    this._pendingFetches.clear();
    this._dragState = null;
    this._pinchState = null;

    this.content = null;
  }
}

// Registriere die neue HTML-Karte im Browser
customElements.define('wisenet-wave-card', WisenetWaveCard);
