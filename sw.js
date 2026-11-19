/**
 * Fishing Intelligence · service worker.
 *
 * - File dell'app (stessa origine): stale-while-revalidate. Si risponde subito dalla copia
 *   salvata e in background si scarica quella nuova; offline le pagine ripiegano su index.html.
 * - Tile delle mappe: prima la copia salvata (max 300 voci, 14 giorni). Si salvano solo le tile
 *   che l'utente ha già guardato: il precaricamento in blocco è vietato dalla politica di OpenStreetMap.
 * - API (Open-Meteo, Nominatim, Supabase): NON si intercettano. L'app ha la sua cache con età
 *   esplicita; una cache del service worker senza scadenza mostrerebbe previsioni vecchie come fresche.
 * - Aggiornamento: nessun skipWaiting automatico. La nuova versione parte quando l'app manda
 *   { type: 'SKIP_WAITING' } (oppure alla chiusura di tutte le schede).
 */

// Tenere allineata a APP.version di js/config.js (lo verifica tests/static-check.mjs).
const VERSION = '2.0.0';

const CACHE_PREFIX = 'fi2-';
// Cache lasciate dalla versione 1: non servono più e occupano spazio (c'erano anche le risposte delle API).
const LEGACY_CACHE_PREFIX = 'fishing-intel-';
const SHELL_CACHE = `${CACHE_PREFIX}shell-${VERSION}`;
const TILE_CACHE = `${CACHE_PREFIX}tiles-${VERSION}`;

const TILE_MAX_ENTRIES = 300;
const TILE_MAX_AGE_MS = 14 * 24 * 60 * 60 * 1000;
const CACHED_AT_HEADER = 'x-fi-cached-at';

const TILE_HOSTS = new Set(['tile.openstreetmap.org', 'server.arcgisonline.com', 'tiles.openseamap.org']);

// Un file mancante (non ancora scritto) non deve far fallire l'installazione: vedi precache().
// Una voce per riga: tests/static-check.mjs legge questo elenco.
const PRECACHE = [
  './',
  './index.html',
  './manifest.webmanifest',
  './css/tokens.css',
  './css/base.css',
  './css/components.css',
  './css/view-forecast.css',
  './css/view-gear.css',
  './css/view-diary.css',
  './css/view-settings.css',
  './js/config.js',
  './js/state.js',
  './js/theme-boot.js',
  './js/app.js',
  './js/forecast-controller.js',
  './js/cloud.js',
  './js/core/format.js',
  './js/core/astronomy.js',
  './js/core/species.js',
  './js/core/spots.js',
  './js/core/forecast.js',
  './js/core/scoring.js',
  './js/core/tactics.js',
  './js/core/casting.js',
  './js/core/stats.js',
  './js/services/weather-api.js',
  './js/services/geocoding.js',
  './js/services/storage.js',
  './js/services/backup.js',
  './js/services/sync.js',
  './js/services/supabase.js',
  './js/ui/dom.js',
  './js/ui/icons.js',
  './js/ui/charts.js',
  './js/ui/map.js',
  './js/ui/spot-sheet.js',
  './js/ui/onboarding.js',
  './js/ui/views/forecast.js',
  './js/ui/views/gear.js',
  './js/ui/views/diary.js',
  './js/ui/views/settings.js',
  './vendor/leaflet/leaflet.js',
  './vendor/leaflet/leaflet.css',
  './vendor/leaflet/images/layers.png',
  './vendor/leaflet/images/layers-2x.png',
  './vendor/leaflet/images/marker-icon.png',
  './vendor/leaflet/images/marker-icon-2x.png',
  './vendor/leaflet/images/marker-shadow.png',
  './assets/icons/icon.svg',
  './assets/icons/icon-192.png',
  './assets/icons/icon-512.png',
  './assets/icons/icon-maskable-512.png'
];

/** Aggiunge i file uno per uno e ignora quelli che danno errore. */
async function precache() {
  const cache = await caches.open(SHELL_CACHE);
  await Promise.allSettled(
    // cache: 'reload' salta la cache HTTP del browser, così il guscio è davvero quello nuovo.
    PRECACHE.map((url) => cache.add(new Request(url, { cache: 'reload' })))
  );
}

self.addEventListener('install', (event) => {
  event.waitUntil(precache());
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const keep = new Set([SHELL_CACHE, TILE_CACHE]);
      const names = await caches.keys();
      const stale = names.filter((n) => (n.startsWith(CACHE_PREFIX) && !keep.has(n)) || n.startsWith(LEGACY_CACHE_PREFIX));
      await Promise.all(stale.map((n) => caches.delete(n)));
      await self.clients.claim();
    })()
  );
});

self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'SKIP_WAITING') {
    self.skipWaiting();
  }
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;
  // Richiesta speciale degli strumenti di sviluppo: il fetch dentro il worker darebbe errore.
  if (request.cache === 'only-if-cached' && request.mode !== 'same-origin') return;

  const url = new URL(request.url);

  if (TILE_HOSTS.has(url.hostname)) {
    event.respondWith(tileCacheFirst(event, request));
    return;
  }

  // Tutto il resto fuori dalla nostra origine (API, CDN, Supabase) passa direttamente alla rete.
  if (url.origin !== self.location.origin) return;

  event.respondWith(appStaleWhileRevalidate(event, request));
});

/** File dell'app: risposta subito dalla copia salvata, aggiornamento in background. */
async function appStaleWhileRevalidate(event, request) {
  const cache = await caches.open(SHELL_CACHE);
  const isNavigation = request.mode === 'navigate';
  // Per le pagine la query (per esempio ?utm=) non deve far perdere la copia salvata.
  const cached = await cache.match(request, { ignoreSearch: isNavigation });

  const update = fetch(request)
    .then(async (response) => {
      if (response.ok && response.type === 'basic') {
        try {
          await cache.put(request, response.clone());
        } catch (err) {
          // Spazio esaurito: la risposta di rete resta valida, si perde solo la copia.
        }
      }
      return response;
    })
    .catch(() => null);

  if (cached) {
    event.waitUntil(update);
    return cached;
  }

  const response = await update;
  if (response) return response;

  if (isNavigation) {
    const shell = await cache.match('./index.html');
    if (shell) return shell;
  }
  return new Response('Non disponibile senza rete.', {
    status: 503,
    headers: { 'Content-Type': 'text/plain; charset=utf-8' }
  });
}

/** Tile: prima la copia salvata se ha meno di 14 giorni, altrimenti rete; offline vale anche la scaduta. */
async function tileCacheFirst(event, request) {
  const cache = await caches.open(TILE_CACHE);
  const cached = await cache.match(request, { ignoreVary: true });

  if (cached && !isExpired(cached)) return cached;

  try {
    const response = await fetch(request);
    // Le risposte opache (senza CORS) non si salvano: in quota pesano molto più della tile vera.
    if (response.ok && response.status === 200 && response.type !== 'opaque') {
      event.waitUntil(storeTile(cache, request, response.clone()).catch(() => {}));
    }
    return response;
  } catch (err) {
    if (cached) return cached;
    return Response.error();
  }
}

function isExpired(response) {
  const cachedAt = Number(response.headers.get(CACHED_AT_HEADER));
  return !Number.isFinite(cachedAt) || Date.now() - cachedAt > TILE_MAX_AGE_MS;
}

async function storeTile(cache, request, response) {
  const blob = await response.blob();
  const headers = new Headers({
    'Content-Type': response.headers.get('Content-Type') || 'image/png',
    [CACHED_AT_HEADER]: String(Date.now())
  });
  await cache.put(request, new Response(blob, { status: 200, headers }));
  await trimTiles(cache);
}

/** Tiene al massimo TILE_MAX_ENTRIES voci togliendo le più vecchie (le chiavi sono in ordine di inserimento). */
async function trimTiles(cache) {
  const keys = await cache.keys();
  const excess = keys.length - TILE_MAX_ENTRIES;
  if (excess > 0) {
    await Promise.all(keys.slice(0, excess).map((key) => cache.delete(key)));
  }
}
