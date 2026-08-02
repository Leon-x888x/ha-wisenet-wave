// Version-Marker: taucht in der Browser-Konsole auf. Wenn diese Zeile nach
// einem Reload NICHT erscheint (oder eine ältere Versionsnummer zeigt),
// läuft noch eine gecachte alte Datei - dann hilft nur ein Cache-Bust über
// die Lovelace-Ressourcen-URL (z.B. "...wisenet-wave-card.js?v=X").
console.info('[wisenet-wave-card] Version 2026-08-02-d geladen');

class WisenetWaveCard extends HTMLElement {
  // Wird aufgerufen, wenn die Karte in HA konfiguriert wird
  setConfig(config) {
    if (!config.entity && !config.camera_id) {
      throw new Error('Du musst entweder "entity" (z.B. camera.terrasse) oder "camera_id" angeben!');
    }
    this.config = config;

    // Zeitleisten-Zustand
    this._viewEnd = Date.now();
    this._viewStart = this._viewEnd - 60 * 60 * 1000; // Start: letzte Stunde
    this._playheadMs = this._viewEnd;
    this._isLive = false;
    this._periodsCache = new Map(); // Tagesschlüssel -> {recording:[], motion:[]}
    this._pendingFetches = new Set();
    this._dragState = null;
    this._pinchState = null;
    this._fetchDebounce = null;
    this._rafId = null;
    this._loadWatchdogId = null;
    this._timelineErrorShown = false;
    this._hlsRetryTimer = null;
    this._hlsRetryCount = 0;
    this._activeStreamToken = 0;
    this._currentStreamUrl = null;
    this._streamMode = 'archive';
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

  // Home Assistant Objekt (wird bei jeder Änderung von HA aktualisiert)
  set hass(hass) {
    this._hass = hass;
    if (!this.content) {
      this.innerHTML = `
        <ha-card header="${this.config.title || 'Wisenet WAVE Archiv'}">
          <style>
            .wwc-content { padding: 0 16px 16px; }
            .wwc-video-wrap { position: relative; width: 100%; aspect-ratio: 16 / 9; background: #000; border-radius: 4px; overflow: hidden; }
            .wwc-video-wrap video { width: 100%; height: 100%; display: block; object-fit: contain; background: #000; }
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
            .wwc-toolbar { display: flex; align-items: center; gap: 8px; margin-top: 12px; }
            .wwc-btn {
              display: flex; align-items: center; justify-content: center;
              width: 32px; height: 32px; padding: 0; border-radius: 50%;
              border: none; background: transparent; color: var(--primary-text-color);
              cursor: pointer;
            }
            .wwc-btn:hover { background: var(--divider-color, rgba(0,0,0,0.08)); }
            .wwc-btn:disabled { opacity: 0.45; cursor: not-allowed; }
            .wwc-btn ha-icon { --mdc-icon-size: 20px; }
            .wwc-time { font-family: var(--code-font-family, monospace); font-size: 13px; color: var(--secondary-text-color); min-width: 148px; }
            .wwc-spacer { flex: 1; }
            .wwc-live-btn {
              font-size: 12px; font-weight: 500; padding: 4px 10px; border-radius: 12px;
              border: 1px solid var(--divider-color); background: none; cursor: pointer;
              color: var(--secondary-text-color); display: flex; align-items: center; gap: 4px;
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
            <div class="wwc-video-wrap">
              <video id="wave-video" muted playsinline></video>
              <div class="wwc-live-badge" id="wave-live-badge"><span class="wwc-live-badge-dot"></span>LIVE</div>
            </div>

            <div class="wwc-toolbar">
              <button class="wwc-btn" id="wave-skip-back" title="10s zurück"><ha-icon icon="mdi:rewind-10"></ha-icon></button>
              <button class="wwc-btn" id="wave-play-pause" title="Abspielen/Pause"><ha-icon icon="mdi:play"></ha-icon></button>
              <button class="wwc-btn" id="wave-skip-fwd" title="10s vor"><ha-icon icon="mdi:fast-forward-10"></ha-icon></button>
              <button class="wwc-btn" id="wave-mute" title="Stumm/Ton an"><ha-icon icon="mdi:volume-off"></ha-icon></button>
              <button class="wwc-btn" id="wave-fullscreen" title="Vollbild"><ha-icon icon="mdi:fullscreen"></ha-icon></button>
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

            <div id="wave-error" style="color: var(--error-color, red); margin-top: 8px; font-size: 12px;"></div>
          </div>
        </ha-card>
      `;
      this.content = this.querySelector('.card-content');
      this.videoEl = this.querySelector('#wave-video');
      this.errorEl = this.querySelector('#wave-error');
      this.canvasEl = this.querySelector('#wave-canvas');
      this.labelsEl = this.querySelector('#wave-timeline-labels');
      this.timeLabelEl = this.querySelector('#wave-time-label');
      this.liveBtnEl = this.querySelector('#wave-live-btn');
      this.playPauseBtnEl = this.querySelector('#wave-play-pause');
      this.liveBadgeEl = this.querySelector('#wave-live-badge');

      this._setupTransportControls();
      this._setupTimelineInteraction();
      this._setupVideoEvents();
      this._syncVideoUi();

      // Erste Darstellung + initiale Daten laden
      this._resizeCanvas();
      this._scheduleFetch();
      this._updateTimeLabel();
      this._drawTimeline();

      window.addEventListener('resize', () => { this._resizeCanvas(); this._drawTimeline(); });

      // Standardmäßig direkt live starten, statt mit leerem Player zu warten
      this.seekTo(Date.now(), { isLive: true });
    }
  }

  _setupTransportControls() {
    this.querySelector('#wave-play-pause').addEventListener('click', () => {
      if (this.videoEl.paused) { this.videoEl.play(); } else { this.videoEl.pause(); }
    });
    this.querySelector('#wave-skip-back').addEventListener('click', () => {
      this.seekTo(this._playheadMs - 10000);
    });
    this.querySelector('#wave-skip-fwd').addEventListener('click', () => {
      this.seekTo(this._playheadMs + 10000);
    });
    this.liveBtnEl.addEventListener('click', () => {
      const now = Date.now();
      this._isLive = true;
      const span = this._viewEnd - this._viewStart;
      this._viewEnd = now;
      this._viewStart = now - span;
      this.seekTo(now, { isLive: true });
      this._scheduleFetch();
      this._drawTimeline();
    });
    this.querySelector('#wave-zoom-in').addEventListener('click', () => this._zoomBy(0.5, null));
    this.querySelector('#wave-zoom-out').addEventListener('click', () => this._zoomBy(2, null));

    const muteBtn = this.querySelector('#wave-mute');
    muteBtn.addEventListener('click', () => {
      this.videoEl.muted = !this.videoEl.muted;
      muteBtn.querySelector('ha-icon').setAttribute('icon', this.videoEl.muted ? 'mdi:volume-off' : 'mdi:volume-high');
    });

    this.querySelector('#wave-fullscreen').addEventListener('click', () => {
      const wrap = this.querySelector('.wwc-video-wrap');
      if (document.fullscreenElement) {
        document.exitFullscreen();
      } else if (wrap.requestFullscreen) {
        wrap.requestFullscreen();
      }
    });
  }

  _setupVideoEvents() {
    this.videoEl.addEventListener('play', () => {
      this.playPauseBtnEl.querySelector('ha-icon').setAttribute('icon', 'mdi:pause');
      this._startPlayheadLoop();
    });
    this.videoEl.addEventListener('pause', () => {
      this.playPauseBtnEl.querySelector('ha-icon').setAttribute('icon', 'mdi:play');
      this._stopPlayheadLoop();
    });
    this.videoEl.addEventListener('playing', () => this._clearLoadWatchdog());
  }

  // Verhindert einen dauerhaften Ladescreen, wenn für den angefragten
  // Zeitpunkt gar kein Videomaterial existiert (z.B. Live-Sprung auf eine
  // Kamera, die gerade nichts aufzeichnet). hls.js feuert in solchen Fällen
  // oft weder MANIFEST_PARSED noch einen fatalen Error - der Player bleibt
  // einfach ewig im Ladezustand hängen.
  _startLoadWatchdog() {
    this._clearLoadWatchdog();
    this._loadWatchdogId = setTimeout(() => {
      if (this.videoEl.readyState < 2) {
        this.errorEl.innerText = 'Für diesen Zeitpunkt ist kein Video verfügbar.';
        if (this.hls) { this.hls.destroy(); this.hls = null; }
      }
    }, 9000);
  }

  _clearLoadWatchdog() {
    if (this._loadWatchdogId) {
      clearTimeout(this._loadWatchdogId);
      this._loadWatchdogId = null;
    }
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
      this.liveBadgeEl.style.display = isLive ? 'flex' : 'none';
    }

    const skipBackBtn = this.querySelector('#wave-skip-back');
    const skipFwdBtn = this.querySelector('#wave-skip-fwd');
    skipBackBtn.disabled = isLive;
    skipFwdBtn.disabled = isLive;
    this.playPauseBtnEl.disabled = isLive;
    this.playPauseBtnEl.setAttribute('title', isLive ? 'Live-Ansicht pausieren nicht verfügbar' : 'Abspielen/Pause');
  }

  _startPlayheadLoop() {
    if (this._rafId) return;
    const tick = () => {
      if (this._streamStartMs != null && !this.videoEl.paused) {
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
      if (Math.abs(dx) > 3) this._dragState.moved = true;
      const rect = canvas.getBoundingClientRect();
      const span = this._dragState.origEnd - this._dragState.origStart;
      const deltaMs = (dx / rect.width) * span;
      this._viewStart = this._dragState.origStart - deltaMs;
      this._viewEnd = this._dragState.origEnd - deltaMs;
      this._clampView();
      this._drawTimeline();
    });
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
    });

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
        if (Math.abs(dx) > 3) this._dragState.moved = true;
        const span = this._dragState.origEnd - this._dragState.origStart;
        const deltaMs = (dx / rect.width) * span;
        this._viewStart = this._dragState.origStart - deltaMs;
        this._viewEnd = this._dragState.origEnd - deltaMs;
        this._clampView();
        this._drawTimeline();
      } else if (ev.touches.length === 2 && this._pinchState) {
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

  // ---------- Daten laden ----------

  _scheduleFetch() {
    if (this._fetchDebounce) clearTimeout(this._fetchDebounce);
    this._fetchDebounce = setTimeout(() => this._fetchVisiblePeriods(), 250);
  }

  _dayKey(ms) {
    return new Date(ms).toISOString().slice(0, 10);
  }

  async _fetchVisiblePeriods() {
    const camId = this.resolveCameraId();
    if (!camId) return;

    // Etwas Puffer links/rechts laden, damit Pan nicht sofort nachlädt
    const bufferMs = (this._viewEnd - this._viewStart) * 0.5;
    const from = this._viewStart - bufferMs;
    const to = this._viewEnd + bufferMs;

    const dayMs = 24 * 60 * 60 * 1000;
    const days = [];
    for (let t = Math.floor(from / dayMs) * dayMs; t < to; t += dayMs) {
      days.push(t);
    }

    for (const dayStart of days) {
      const key = `${camId}_${this._dayKey(dayStart)}`;
      if (this._periodsCache.has(key) || this._pendingFetches.has(key)) continue;
      this._pendingFetches.add(key);

      const dayEnd = dayStart + dayMs;
      this._hass.callWS({
        type: 'call_service',
        domain: 'wisenet_wave',
        service: 'get_timeline',
        service_data: { camera_id: camId, start_ms: dayStart, end_ms: dayEnd },
        return_response: true,
      }).then((response) => {
        const data = response?.response || { recording: [], motion: [] };
        this._periodsCache.set(key, data);
        this._pendingFetches.delete(key);
        console.info(
          `[wisenet-wave-card] Periods für ${key}: recording=${data.recording?.length ?? 0}, motion=${data.motion?.length ?? 0}, error=${data.error ?? 'keiner'}`,
          data,
        );
        if (data.error) {
          console.warn('wisenet_wave: Zeitleisten-Daten (Aufnahme/Bewegung) fehlgeschlagen:', data.error);
          if (!this._timelineErrorShown) {
            this._timelineErrorShown = true;
            this.errorEl.innerText = 'Aufnahme-/Bewegungsanzeige nicht verfügbar (Details im HA-Log unter "wisenet_wave").';
          }
        }
        this._drawTimeline();
      }).catch((err) => {
        console.warn('wisenet_wave: konnte Zeitleisten-Daten nicht laden', err);
        this._periodsCache.set(key, { recording: [], motion: [] }); // nicht endlos neu versuchen
        this._pendingFetches.delete(key);
      });
    }
  }

  // ---------- Zeichnen ----------

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
        drawPeriods(data.motion, motColor);
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

  async seekTo(timestampMs, options = {}) {
    this.errorEl.innerText = '';
    this._playheadMs = timestampMs;
    this._isLive = options.isLive === true || Math.abs(Date.now() - timestampMs) < 15000;
    this._streamMode = this._isLive ? 'live' : 'archive';
    this._syncVideoUi();
    this._hlsRetryCount = 0;
    this._clearHlsRetry();
    this._activeStreamToken += 1;
    this._currentStreamUrl = null;
    this._updateTimeLabel();
    this._drawTimeline();

    const camId = this.resolveCameraId();
    if (!camId) return;

    try {
      const response = await this._hass.callWS({
        type: 'call_service',
        domain: 'wisenet_wave',
        service: 'get_archive',
        service_data: {
          camera_id: camId,
          timestamp_ms: Math.round(timestampMs),
          stream_mode: this._streamMode,
        },
        return_response: true,
      });
      const url = response.response.url;
      this._currentStreamUrl = url;
      this._streamStartMs = this._isLive ? Date.now() : timestampMs;
      this._startLoadWatchdog();
      this.initHlsPlayer(url, { mode: this._streamMode, token: this._activeStreamToken });
    } catch (err) {
      console.error(err);
      this.errorEl.innerText = 'Fehler beim Abrufen der Stream-URL. Siehe Konsole.';
    }
  }

  _clearHlsRetry() {
    if (this._hlsRetryTimer) {
      clearTimeout(this._hlsRetryTimer);
      this._hlsRetryTimer = null;
    }
  }

  _handleHlsError(url, data, options = {}) {
    const token = options.token ?? this._activeStreamToken;
    if (token !== this._activeStreamToken) return;

    const details = data?.details || '';
    const isNetworkIssue = details.includes('NETWORK_ERROR') || details.includes('MEDIA_ERROR') || details.includes('MANIFEST_LOAD_ERROR') || details.includes('LEVEL_LOAD_ERROR');
    const shouldRetry = (data?.fatal || isNetworkIssue) && this._hlsRetryCount < 3;

    if (shouldRetry) {
      this._hlsRetryCount += 1;
      this._clearLoadWatchdog();
      this.errorEl.innerText = `Stream vorübergehend nicht verfügbar, versuche erneut (${this._hlsRetryCount}/3)...`;
      this._hlsRetryTimer = setTimeout(() => {
        this._hlsRetryTimer = null;
        this.initHlsPlayer(url, options);
      }, 1000 * this._hlsRetryCount);
      return;
    }

    this._clearLoadWatchdog();
    this.errorEl.innerText = `HLS Fehler: ${data?.type || details || 'network error'}`;
  }

  async initHlsPlayer(url, options = {}) {
    const token = options.token ?? this._activeStreamToken;

    // Dynamisches Laden der HLS.js Bibliothek
    if (!window.Hls) {
      await new Promise((resolve) => {
        const script = document.createElement('script');
        script.src = 'https://cdn.jsdelivr.net/npm/hls.js@latest';
        script.onload = resolve;
        document.head.appendChild(script);
      });
    }

    if (token !== this._activeStreamToken) return;

    if (Hls.isSupported()) {
      if (this.hls) {
        this.hls.destroy(); // Alten Stream beenden
      }

      this.hls = new Hls({
        liveSyncDurationCount: 3,
        maxBufferLength: 20,
        maxBufferHole: 1.5,
        liveDurationInfinity: options.mode === 'live',
      });

      this.hls.loadSource(url);
      this.hls.attachMedia(this.videoEl);
      this.hls.on(Hls.Events.MANIFEST_PARSED, () => {
        if (token !== this._activeStreamToken) return;
        this.errorEl.innerText = '';
        this._clearLoadWatchdog();
        this.videoEl.play().catch(() => {});
      });

      this.hls.on(Hls.Events.ERROR, (event, data) => {
        this._handleHlsError(url, data, { ...options, token });
      });
    } else if (this.videoEl.canPlayType('application/vnd.apple.mpegurl')) {
      // Fallback für Apple Safari (Safari braucht oft keinen XHR Setup Trick, wenn Token als Cookie da ist,
      // aber wir probieren es trotzdem, falls Safari nativ spielt).
      this.videoEl.src = url;
      this.videoEl.play().catch(() => {});
    }
  }

  // Diese Zeile sagt HA, wie groß die Karte im Raster ist
  getCardSize() {
    return 4;
  }
}

// Registriere die neue HTML-Karte im Browser
customElements.define('wisenet-wave-card', WisenetWaveCard);