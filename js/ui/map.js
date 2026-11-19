/**
 * Fishing Intelligence · mappa di base (Leaflet in locale) e posizione GPS.
 * Qui non ci sono marker specifici: le viste li aggiungono sulla mappa che ricevono.
 * Per i popup le viste usano js/ui/dom.js (escapeHtml), non questo modulo.
 */

const LEAFLET_JS = './vendor/leaflet/leaflet.js';
const LEAFLET_CSS = './vendor/leaflet/leaflet.css';
const LEAFLET_IMAGES = './vendor/leaflet/images/';
const LOAD_TIMEOUT_MS = 20000;

const ERR_LOAD = 'Non riesco a caricare la mappa. Controlla la connessione e riprova.';

let leafletPromise = null;

function loadStylesheet(href) {
  return new Promise((resolve, reject) => {
    const link = document.createElement('link');
    link.rel = 'stylesheet';
    link.href = href;
    link.dataset.leaflet = 'css';
    link.addEventListener('load', () => resolve());
    link.addEventListener('error', () => {
      link.remove();
      reject(new Error(ERR_LOAD));
    });
    document.head.appendChild(link);
  });
}

function loadScript(src) {
  return new Promise((resolve, reject) => {
    // Se L c'è già (caricata in un tentativo precedente) non si inserisce un secondo script.
    if (window.L && window.L.map) {
      resolve();
      return;
    }
    const script = document.createElement('script');
    script.src = src;
    script.async = true;
    script.dataset.leaflet = 'js';
    script.addEventListener('load', () => resolve());
    script.addEventListener('error', () => {
      script.remove();
      reject(new Error(ERR_LOAD));
    });
    document.head.appendChild(script);
  });
}

function withTimeout(promise, ms) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(ERR_LOAD)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/**
 * Carica una sola volta Leaflet (script e stile) e restituisce L.
 * Le chiamate in corso condividono la stessa Promise; dopo un errore si può riprovare.
 */
export function ensureLeaflet() {
  if (leafletPromise) return leafletPromise;

  leafletPromise = withTimeout(Promise.all([loadStylesheet(LEAFLET_CSS), loadScript(LEAFLET_JS)]), LOAD_TIMEOUT_MS)
    .then(() => {
      const L = window.L;
      if (!L || typeof L.map !== 'function') throw new Error(ERR_LOAD);
      L.Icon.Default.imagePath = LEAFLET_IMAGES;
      return L;
    })
    .catch((err) => {
      // Si ripulisce quanto inserito, così un nuovo tentativo riparte da zero.
      leafletPromise = null;
      document.querySelectorAll('link[data-leaflet]').forEach((el) => el.remove());
      if (!window.L) document.querySelectorAll('script[data-leaflet]').forEach((el) => el.remove());
      throw new Error(ERR_LOAD, { cause: err });
    });

  return leafletPromise;
}

const TILE_COMMON = {
  maxZoom: 19,
  // Con CORS le tile non sono "opache": il service worker può conservarle senza gonfiare la quota.
  crossOrigin: true
};

/**
 * Crea la mappa dentro `container`.
 * @param {HTMLElement} container
 * @param {{ center: [number, number], zoom?: number, layersControl?: boolean }} opts
 * @returns {Promise<{ L: object, map: object, destroy: () => void }>}
 */
export async function createMap(container, { center, zoom = 12, layersControl = true } = {}) {
  if (!(container instanceof Element)) {
    throw new Error('Manca il riquadro in cui mostrare la mappa.');
  }
  if (!Array.isArray(center) || center.length !== 2 || !center.every((n) => Number.isFinite(n))) {
    throw new Error('Il centro della mappa non è valido.');
  }

  const L = await ensureLeaflet();

  if (container._leaflet_id) {
    throw new Error('In questo riquadro c\'è già una mappa.');
  }

  const map = L.map(container, {
    center,
    zoom: Number.isFinite(zoom) ? zoom : 12,
    zoomControl: false,
    attributionControl: false
  });

  L.control.zoom({ position: 'topleft', zoomInTitle: 'Ingrandisci', zoomOutTitle: 'Riduci' }).addTo(map);
  L.control
    .attribution({ position: 'bottomright', prefix: '<a href="https://leafletjs.com" target="_blank" rel="noopener">Leaflet</a>' })
    .addTo(map);

  const base = L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
    ...TILE_COMMON,
    attribution:
      '&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a>'
  });
  const satellite = L.tileLayer(
    'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
    { ...TILE_COMMON, attribution: 'Immagini &copy; Esri, Maxar, Earthstar Geographics' }
  );
  // OpenSeaMap arriva a zoom 18: oltre quello si ingrandisce l'ultima tile invece di sparire.
  const seamarks = L.tileLayer('https://tiles.openseamap.org/seamark/{z}/{x}/{y}.png', {
    ...TILE_COMMON,
    maxNativeZoom: 18,
    attribution: '&copy; OpenSeaMap'
  });

  base.addTo(map);

  if (layersControl) {
    const control = L.control
      .layers({ Mappa: base, Satellite: satellite }, { 'Carta nautica': seamarks }, { collapsed: true, position: 'topright' })
      .addTo(map);
    const toggle = control.getContainer().querySelector('.leaflet-control-layers-toggle');
    if (toggle) {
      toggle.title = 'Strati della mappa';
      toggle.setAttribute('aria-label', 'Strati della mappa');
    }
  }

  let destroyed = false;
  let observer = null;

  // Dopo il primo frame il contenitore ha le sue misure vere (sheet e schede appena aperte).
  requestAnimationFrame(() => {
    if (!destroyed) map.invalidateSize();
  });

  // Una vista nascosta e poi mostrata cambia dimensione: la mappa si riallinea da sola.
  if (typeof ResizeObserver === 'function') {
    observer = new ResizeObserver(() => {
      if (!destroyed) map.invalidateSize();
    });
    observer.observe(container);
  }

  function destroy() {
    if (destroyed) return;
    destroyed = true;
    if (observer) observer.disconnect();
    map.remove();
  }

  return { L, map, destroy };
}

function gpsError(code, message) {
  const err = new Error(message);
  err.code = code;
  return err;
}

/**
 * Legge la posizione del dispositivo.
 * @returns {Promise<{ lat: number, lng: number, accuracyM: number | null }>}
 */
export function requestGps() {
  return new Promise((resolve, reject) => {
    if (typeof navigator === 'undefined' || !navigator.geolocation) {
      reject(gpsError('unsupported', 'Questo dispositivo o questo browser non permette di leggere la posizione.'));
      return;
    }

    navigator.geolocation.getCurrentPosition(
      (pos) => {
        const { latitude, longitude, accuracy } = pos.coords;
        if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) {
          reject(gpsError('unavailable', 'La posizione ricevuta non è valida. Riprova all\'aperto.'));
          return;
        }
        resolve({
          lat: latitude,
          lng: longitude,
          accuracyM: Number.isFinite(accuracy) ? Math.round(accuracy) : null
        });
      },
      (err) => {
        if (err && err.code === 1) {
          reject(gpsError('denied', 'Non hai dato il permesso di usare la posizione. Puoi consentirlo dalle impostazioni del browser.'));
        } else if (err && err.code === 3) {
          reject(gpsError('timeout', 'Il GPS ci mette troppo a rispondere. Riprova all\'aperto, con il GPS acceso.'));
        } else {
          reject(gpsError('unavailable', 'Posizione non disponibile. Controlla che il GPS sia acceso e riprova all\'aperto.'));
        }
      },
      { enableHighAccuracy: true, timeout: 10000, maximumAge: 0 }
    );
  });
}
