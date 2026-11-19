import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { API, CACHE } from '../js/config.js';
import { loadForecast, loadForecasts, weatherUrl, marineUrl } from '../js/services/weather-api.js';
import { searchPlaces } from '../js/services/geocoding.js';
import { PREDEFINED_SPOTS } from '../js/core/spots.js';

const load = (name) => JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8'));
const WEATHER = load('open-meteo-weather.json');
const MARINE = load('open-meteo-marine.json');
const SPOT = PREDEFINED_SPOTS[0];
const SPOT2 = PREDEFINED_SPOTS[4];
const NOW = Date.UTC(2026, 10, 19, 16, 15);
const MIN = 60000;

/** localStorage finto in memoria, con quota facoltativa in caratteri. */
class MemoryStorage {
  constructor(quota = Infinity) {
    this.map = new Map();
    this.quota = quota;
  }
  get length() { return this.map.size; }
  key(i) { return [...this.map.keys()][i] ?? null; }
  getItem(k) { return this.map.has(k) ? this.map.get(k) : null; }
  setItem(k, v) {
    const used = [...this.map].reduce((a, [key, val]) => a + (key === k ? 0 : val.length), 0);
    if (used + String(v).length > this.quota) {
      const err = new Error('quota');
      err.name = 'QuotaExceededError';
      throw err;
    }
    this.map.set(k, String(v));
  }
  removeItem(k) { this.map.delete(k); }
}

const json = (body, status = 200) => ({ ok: status >= 200 && status < 300, status, json: async () => body });

/** fetch finto: risponde con le fixture, registra gli URL, si può far fallire per servizio. */
function installFetch({ weather = 'ok', marine = 'ok' } = {}) {
  const calls = [];
  globalThis.fetch = async (url, opts = {}) => {
    calls.push({ url: String(url), at: Date.now(), opts });
    const isMarine = String(url).startsWith(API.marine);
    const mode = isMarine ? marine : weather;
    const body = isMarine ? MARINE : WEATHER;
    if (mode === 'network') throw new TypeError('Failed to fetch');
    if (mode === 'http500') return json({ error: true }, 500);
    if (mode === 'apierror') return json({ error: true, reason: 'Parameter not valid' });
    if (mode === 'hang') {
      return new Promise((_, reject) => opts.signal?.addEventListener('abort', () => {
        const e = new Error('aborted');
        e.name = 'AbortError';
        reject(e);
      }));
    }
    const lats = new URL(url).searchParams.get('latitude').split(',');
    return json(lats.length > 1 ? lats.map(() => body) : body);
  };
  return calls;
}

let savedFetch;
let savedStorage;
beforeEach(() => {
  savedFetch = globalThis.fetch;
  savedStorage = globalThis.localStorage;
  globalThis.localStorage = new MemoryStorage();
});
afterEach(() => {
  globalThis.fetch = savedFetch;
  if (savedStorage === undefined) delete globalThis.localStorage;
  else globalThis.localStorage = savedStorage;
});

test('URL delle richieste: variabili, giorni, fuso automatico, unità e cella di mare', () => {
  const w = new URL(weatherUrl(SPOT));
  assert.equal(w.origin + w.pathname, API.weather);
  assert.equal(w.searchParams.get('latitude'), '41.2889');
  assert.equal(w.searchParams.get('longitude'), '13.3461');
  assert.equal(w.searchParams.get('hourly'), 'temperature_2m,precipitation_probability,precipitation,weather_code,cloud_cover,pressure_msl,wind_speed_10m,wind_direction_10m,wind_gusts_10m');
  assert.equal(w.searchParams.get('past_days'), '1');
  assert.equal(w.searchParams.get('forecast_days'), '7');
  assert.equal(w.searchParams.get('timezone'), 'auto');
  assert.equal(w.searchParams.get('wind_speed_unit'), 'kmh');
  const m = new URL(marineUrl(SPOT));
  assert.equal(m.origin + m.pathname, API.marine);
  assert.equal(m.searchParams.get('hourly'), 'wave_height,wave_direction,wave_period,wind_wave_height,swell_wave_height,swell_wave_period,swell_wave_direction,sea_surface_temperature,sea_level_height_msl,ocean_current_velocity,ocean_current_direction');
  assert.equal(m.searchParams.get('cell_selection'), 'sea');
  assert.equal(m.searchParams.get('timezone'), 'auto');
  assert.equal(new URL(weatherUrl([SPOT, SPOT2])).searchParams.get('latitude'), '41.2889,41.2128');
});

test('dalla rete: previsione completa e copia salvata con le risposte grezze', async () => {
  const calls = installFetch();
  const { forecast, meta } = await loadForecast(SPOT, { now: NOW });
  assert.equal(calls.length, 2);
  assert.ok(calls.every((c) => c.opts.signal instanceof AbortSignal));
  assert.equal(meta.source, 'network');
  assert.deepEqual(meta.partial, { weather: false, marine: false });
  assert.equal(meta.error, null);
  assert.equal(meta.ageMs, 0);
  assert.equal(meta.fetchedAt, new Date(NOW).toISOString());
  assert.equal(forecast.hours.length, 192);
  assert.equal(forecast.days.length, 7);
  const saved = JSON.parse(globalThis.localStorage.getItem(CACHE.prefix + SPOT.id));
  assert.equal(saved.fetchedAt, new Date(NOW).toISOString());
  assert.deepEqual(saved.weather, WEATHER);
  assert.deepEqual(saved.marine, MARINE);
});

test('copia fresca sotto i 30 minuti senza rete; force riscarica; oltre i 30 minuti si riscarica', async () => {
  let calls = installFetch();
  await loadForecast(SPOT, { now: NOW });
  calls.length = 0;
  const cached = await loadForecast(SPOT, { now: NOW + 10 * MIN });
  assert.equal(calls.length, 0);
  assert.equal(cached.meta.source, 'cache');
  assert.equal(cached.meta.ageMs, 10 * MIN);
  assert.equal(cached.forecast.nowIndex, 41);
  await loadForecast(SPOT, { now: NOW + 10 * MIN, force: true });
  assert.equal(calls.length, 2);
  calls = installFetch();
  const later = await loadForecast(SPOT, { now: NOW + 41 * MIN }); // 31 minuti dopo la copia forzata
  assert.equal(calls.length, 2);
  assert.equal(later.meta.source, 'network');
});

test('se una richiesta fallisce la previsione è parziale', async () => {
  installFetch({ marine: 'http500' });
  const r = await loadForecast(SPOT, { now: NOW });
  assert.equal(r.meta.source, 'network');
  assert.deepEqual(r.meta.partial, { weather: false, marine: true });
  assert.match(r.meta.error, /mare/i);
  assert.ok(r.forecast.hours.every((h) => h.waveM === null));
  assert.equal(r.forecast.has.marine, false);

  installFetch({ weather: 'apierror' });
  const r2 = await loadForecast(SPOT, { now: NOW, force: true });
  assert.deepEqual(r2.meta.partial, { weather: true, marine: false });
  assert.match(r2.meta.error, /meteo/i);
});

test('un risultato parziale non sostituisce una copia completa ancora utilizzabile', async () => {
  installFetch();
  await loadForecast(SPOT, { now: NOW });
  installFetch({ marine: 'network' });
  await loadForecast(SPOT, { now: NOW + 40 * MIN });
  const saved = JSON.parse(globalThis.localStorage.getItem(CACHE.prefix + SPOT.id));
  assert.equal(saved.fetchedAt, new Date(NOW).toISOString());
  assert.ok(saved.marine);
});

test('senza rete: copia salvata come stale, altrimenti nessuna previsione', async () => {
  installFetch();
  await loadForecast(SPOT, { now: NOW });
  installFetch({ weather: 'network', marine: 'network' });
  const stale = await loadForecast(SPOT, { now: NOW + 3 * 3600000 });
  assert.equal(stale.meta.source, 'stale');
  assert.equal(stale.meta.ageMs, 3 * 3600000);
  assert.match(stale.meta.error, /rete non raggiungibile/);
  assert.ok(stale.forecast);
  assert.equal(stale.forecast.nowIndex, 44);

  globalThis.localStorage = new MemoryStorage();
  const none = await loadForecast(SPOT, { now: NOW });
  assert.equal(none.forecast, null);
  assert.equal(none.meta.source, 'none');
  assert.equal(none.meta.fetchedAt, null);
  assert.deepEqual(none.meta.partial, { weather: true, marine: true });
  assert.ok(none.meta.error);
});

test('timeout con AbortController', async () => {
  const saved = API.timeoutMs;
  API.timeoutMs = 30;
  try {
    installFetch({ weather: 'hang', marine: 'hang' });
    const r = await loadForecast(SPOT, { now: NOW });
    assert.equal(r.meta.source, 'none');
    assert.match(r.meta.error, /in tempo/);
  } finally {
    API.timeoutMs = saved;
  }
});

test('copia locale illeggibile o senza localStorage: nessun errore', async () => {
  installFetch();
  globalThis.localStorage.setItem(CACHE.prefix + SPOT.id, '{non json');
  const r = await loadForecast(SPOT, { now: NOW });
  assert.equal(r.meta.source, 'network');
  delete globalThis.localStorage;
  const r2 = await loadForecast(SPOT, { now: NOW });
  assert.equal(r2.meta.source, 'network');
});

test('errori di quota ignorati senza rompere', async () => {
  installFetch();
  globalThis.localStorage = new MemoryStorage(1000);
  const r = await loadForecast(SPOT, { now: NOW });
  assert.equal(r.meta.source, 'network');
  assert.ok(r.forecast);
  assert.equal(globalThis.localStorage.length, 0);
});

test('al massimo CACHE.maxSpots copie: si elimina la più vecchia', async () => {
  installFetch();
  const spots = Array.from({ length: CACHE.maxSpots + 2 }, (_, i) => ({ ...SPOT, id: `spot-${i}` }));
  for (let i = 0; i < spots.length; i++) await loadForecast(spots[i], { now: NOW + i * MIN });
  const ls = globalThis.localStorage;
  const keys = Array.from({ length: ls.length }, (_, i) => ls.key(i)).filter((k) => k.startsWith(CACHE.prefix));
  assert.equal(keys.length, CACHE.maxSpots);
  assert.ok(!keys.includes(`${CACHE.prefix}spot-0`));
  assert.ok(!keys.includes(`${CACHE.prefix}spot-1`));
  assert.ok(keys.includes(`${CACHE.prefix}spot-${spots.length - 1}`));
});

test('loadForecasts: più spot in 2 richieste, risposte nello stesso ordine', async () => {
  const calls = installFetch();
  const map = await loadForecasts([SPOT, SPOT2], { now: NOW });
  assert.equal(calls.length, 2);
  assert.match(calls[0].url, /latitude=41\.2889,41\.2128/);
  assert.deepEqual([...map.keys()], [SPOT.id, SPOT2.id]);
  for (const { forecast, meta } of map.values()) {
    assert.equal(meta.source, 'network');
    assert.equal(forecast.hours.length, 192);
  }
  assert.equal(map.get(SPOT2.id).forecast.spotId, SPOT2.id);
  // la seconda volta le copie sono fresche: nessuna richiesta
  calls.length = 0;
  const again = await loadForecasts([SPOT, SPOT2], { now: NOW + 5 * MIN });
  assert.equal(calls.length, 0);
  assert.equal(again.get(SPOT.id).meta.source, 'cache');
});

test('loadForecasts: senza rete usa le copie salvate o restituisce none', async () => {
  installFetch();
  await loadForecast(SPOT, { now: NOW });
  installFetch({ weather: 'network', marine: 'network' });
  const map = await loadForecasts([SPOT, SPOT2], { now: NOW + 2 * 3600000 });
  assert.equal(map.get(SPOT.id).meta.source, 'stale');
  assert.equal(map.get(SPOT2.id).meta.source, 'none');
  assert.equal(map.get(SPOT2.id).forecast, null);
});

/* ------------------------------- geocoding ------------------------------- */

const NOMINATIM = [
  { name: 'Sperlonga', display_name: 'Sperlonga, Latina, Lazio, Italia', lat: '41.2601234', lon: '13.4318765' },
  { display_name: 'Spiaggia di Ponente, Sperlonga, Lazio, Italia', lat: '41.25', lon: '13.42' },
  { name: 'Rotto', display_name: 'Rotto', lat: 'x', lon: '13' }
];

function installGeoFetch() {
  const calls = [];
  globalThis.fetch = async (url) => {
    calls.push({ url: String(url), at: Date.now() });
    return json(NOMINATIM);
  };
  return calls;
}

test('searchPlaces: query corte senza richiesta, risultati puliti e in cache', async () => {
  const calls = installGeoFetch();
  assert.deepEqual(await searchPlaces('  sp '), []);
  assert.equal(calls.length, 0);
  const res = await searchPlaces('Sperlonga');
  assert.equal(calls.length, 1);
  const u = new URL(calls[0].url);
  assert.equal(u.origin + u.pathname, API.geocode);
  assert.equal(u.searchParams.get('q'), 'Sperlonga');
  assert.equal(u.searchParams.get('format'), 'jsonv2');
  assert.equal(u.searchParams.get('limit'), '6');
  assert.equal(u.searchParams.get('accept-language'), 'it');
  assert.equal(u.searchParams.get('countrycodes'), 'it');
  assert.deepEqual(res, [
    { name: 'Sperlonga', fullName: 'Sperlonga, Latina, Lazio, Italia', lat: 41.26012, lng: 13.43188 },
    { name: 'Spiaggia di Ponente', fullName: 'Spiaggia di Ponente, Sperlonga, Lazio, Italia', lat: 41.25, lng: 13.42 }
  ]);
  res[0].name = 'modificato';
  const again = await searchPlaces('sperlonga ');
  assert.equal(calls.length, 1);
  assert.equal(again[0].name, 'Sperlonga');
});

test('searchPlaces: mai più di una richiesta al secondo, filtro paese facoltativo', async () => {
  const calls = installGeoFetch();
  await Promise.all([searchPlaces('Terracina'), searchPlaces('Gaeta Serapo', { countryCodes: null })]);
  assert.equal(calls.length, 2);
  assert.ok(calls[1].at - calls[0].at >= 990, `intervallo ${calls[1].at - calls[0].at} ms`);
  assert.equal(new URL(calls[1].url).searchParams.get('countrycodes'), null);
});

test('searchPlaces: errori in italiano e niente cache degli errori', async () => {
  globalThis.fetch = async () => json([], 503);
  await assert.rejects(searchPlaces('Sabaudia'), /Ricerca non riuscita/);
  const calls = installGeoFetch();
  const res = await searchPlaces('Sabaudia');
  assert.equal(calls.length, 1);
  assert.equal(res.length, 2);
});
