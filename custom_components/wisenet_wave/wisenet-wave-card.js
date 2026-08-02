class WisenetWaveCard extends HTMLElement {
  // Wird aufgerufen, wenn die Karte in HA konfiguriert wird
  setConfig(config) {
    if (!config.entity && !config.camera_id) {
      throw new Error('Du musst entweder "entity" (z.B. camera.terrasse) oder "camera_id" angeben!');
    }
    this.config = config;
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
          <div class="card-content">
            <video id="wave-video" controls muted style="width: 100%; background: #000; border-radius: 4px;"></video>
            
            <div style="margin-top: 16px; display: flex; gap: 8px; align-items: center;">
              <input type="datetime-local" id="wave-time" style="padding: 8px; flex-grow: 1; border-radius: 4px; border: 1px solid #ccc;">
              <button id="wave-play" style="padding: 8px 16px; cursor: pointer; background: var(--primary-color); color: white; border: none; border-radius: 4px;">Abspielen</button>
            </div>
            <div id="wave-error" style="color: red; margin-top: 8px; font-size: 12px;"></div>
          </div>
        </ha-card>
      `;
      this.content = this.querySelector('.card-content');
      this.videoEl = this.querySelector('#wave-video');
      this.timeInputEl = this.querySelector('#wave-time');
      this.errorEl = this.querySelector('#wave-error');
      
      // Klick-Event für den Play-Button
      this.querySelector('#wave-play').addEventListener('click', () => this.playArchive());
    }
  }

  async playArchive() {
    this.errorEl.innerText = ""; // Fehler zurücksetzen
    const timeValue = this.timeInputEl.value;
    
    if (!timeValue) {
      this.errorEl.innerText = "Bitte wähle zuerst ein Datum und eine Uhrzeit aus.";
      return;
    }

    const camId = this.resolveCameraId();
    if (!camId) {
      return; // Fehlermeldung wurde bereits in resolveCameraId() gesetzt
    }

    // Zeitstempel in Millisekunden umwandeln
    const timestampMs = new Date(timeValue).getTime();

    try {
      // 1. Dienst im HA Backend aufrufen (unser Python Code!)
      const response = await this._hass.callWS({
        type: 'call_service',
        domain: 'wisenet_wave',
        service: 'get_archive',
        service_data: {
          camera_id: camId,
          timestamp_ms: timestampMs
        },
        return_response: true
      });

      const url = response.response.url;

      // 2. Video mit HLS.js abspielen. Die URL zeigt auf den HA-eigenen Proxy,
      //    der Browser schickt automatisch das HA-Login-Cookie mit (gleiche Origin).
      this.initHlsPlayer(url);

    } catch (err) {
      console.error(err);
      this.errorEl.innerText = "Fehler beim Abrufen der Archiv-URL. Siehe Konsole.";
    }
  }

  async initHlsPlayer(url) {
    // Dynamisches Laden der HLS.js Bibliothek
    if (!window.Hls) {
      await new Promise((resolve) => {
        const script = document.createElement('script');
        script.src = 'https://cdn.jsdelivr.net/npm/hls.js@latest';
        script.onload = resolve;
        document.head.appendChild(script);
      });
    }

    if (Hls.isSupported()) {
      if (this.hls) {
        this.hls.destroy(); // Alten Stream beenden
      }

      this.hls = new Hls();

      this.hls.loadSource(url);
      this.hls.attachMedia(this.videoEl);
      this.hls.on(Hls.Events.MANIFEST_PARSED, () => {
        this.videoEl.play();
      });
      
      this.hls.on(Hls.Events.ERROR, (event, data) => {
        if (data.fatal) {
          this.errorEl.innerText = "HLS Fehler: " + data.type;
        }
      });
    } else if (this.videoEl.canPlayType('application/vnd.apple.mpegurl')) {
      // Fallback für Apple Safari (Safari braucht oft keinen XHR Setup Trick, wenn Token als Cookie da ist, 
      // aber wir probieren es trotzdem, falls Safari nativ spielt).
      this.videoEl.src = url;
      this.videoEl.play();
    }
  }

  // Diese Zeile sagt HA, wie groß die Karte im Raster ist
  getCardSize() {
    return 4; 
  }
}

// Registriere die neue HTML-Karte im Browser
customElements.define('wisenet-wave-card', WisenetWaveCard);