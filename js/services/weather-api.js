/**
 * Caricamento delle previsioni Open-Meteo (meteo e mare) con copia locale ed età esplicita.
 * In localStorage si salvano le risposte grezze; la previsione si ricostruisce a ogni lettura.
 */

import { API, CACHE } from '../config.js';
import { buildForecast } from '../core/forecast.js';

const WEATHER_VARS = [
  'temperature_2m', 'precipitation_probability', 'precipitation', 'weather_code', 'cloud_cover',
  'pressure_msl', 'wind_speed_10m', 'wind_direction_10m', 'wind_gusts_10m'
].join(',');

const MARINE_VARS = [
  'wave_height', 'wave_direction', 'wave_period', 'wind_wave_height', 'swell_wave_height',
  'swell_wave_period', 'swell_wave_direction', 'sea_surface_temperature', 'sea_level_height_msl',
  'ocean_current_velocity', 'ocean_current_direction'
].join(',');

const coords = (spots, key) => spots.map((s) => Number(s[key]).toFixed(4)).join(',');

/** URL della richiesta meteo per uno o più spot (coordinate separate da virgola). */
export function weatherUrl(spots) {
  const list = [].concat(spots);
  return `${API.weather}?latitude=${coords(list, 'lat')}&longitude=${coords(list, 'lng')}`
    + `&hourly=${WEATHER_VARS}&past_days=1&forecast_days=7&timezone=auto&wind_speed_unit=kmh`;
}

/** URL della richiesta mare per uno o più spot; cell_selection=sea sceglie la cella di mare. */
export function marineUrl(spots) {
  const list = [].concat(spots);
  return `${API.marine}?latitude=${coords(list, 'lat')}&longitude=${coords(list, 'lng')}`
    + `&hourly=${MARINE_VARS}&past_days=1&forecast_days=7&timezone=auto&cell_selection=sea`;
}

/* --------------------------------- Rete --------------------------------- */

async function fetchJson(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), API.timeoutMs);
  try {
    const res = await fetch(url, { signal: controller.signal, headers: { Accept: 'application/json' } });
    if (!res.ok) throw new Error(`il servizio ha risposto con errore ${res.status}`);
    let data;
    try {
      data = await res.json();
    } catch {
      throw new Error('risposta non leggibile');
    }
    if (data && !Array.isArray(data) && data.error) throw new Error('richiesta rifiutata dal servizio');
    return data;
  } catch (err) {
    if (err?.name === 'AbortError') throw new Error('il servizio non ha risposto in tempo');
    if (err instanceof TypeError) throw new Error('rete non raggiungibile');
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

const isBlock = (b) => Boolean(b) && Array.isArray(b.hourly?.time) && b.hourly.time.length > 0;

/** Risposta di più coordinate → array nello stesso ordine; null se la forma non torna. */
function asList(settled, count) {
  if (settled.status !== 'fulfilled') return null;
  const list = Array.isArray(settled.value) ? settled.value : [settled.value];
  return list.length === count ? list : null;
}

const reasonOf = (settled) => (settled.status === 'rejected' ? String(settled.reason?.message || 'errore sconosciuto') : 'risposta senza dati orari');

/* -------------------------------- Copia locale -------------------------------- */

function storage() {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

const keyFor = (spotId) => `${CACHE.prefix}${spotId}`;

const sameCoord = (a, b) => Number.isFinite(a) && Number.isFinite(b) && Math.abs(a - b) < 1e-5;

function readCache(spot) {
  const ls = storage();
  if (!ls) return null;
  try {
    const entry = JSON.parse(ls.getItem(keyFor(spot.id)) || 'null');
    if (!entry || !Number.isFinite(Date.parse(entry.fetchedAt))) return null;
    // La copia vale solo per il punto per cui è stata scaricata: uno spot spostato sulla mappa
    // tiene lo stesso id, ma il mare di prima non è più il suo
    if (!sameCoord(entry.lat, spot.lat) || !sameCoord(entry.lng, spot.lng)) return null;
    const weather = isBlock(entry.weather) ? entry.weather : null;
    const marine = isBlock(entry.marine) ? entry.marine : null;
    return weather || marine ? { fetchedAt: entry.fetchedAt, weather, marine } : null;
  } catch {
    return null;
  }
}

function cacheKeys(ls) {
  const keys = [];
  for (let i = 0; i < ls.length; i++) {
    const k = ls.key(i);
    if (k && k.startsWith(CACHE.prefix)) keys.push(k);
  }
  return keys;
}

function fetchedAtOf(ls, key) {
  try {
    return Date.parse(JSON.parse(ls.getItem(key) || 'null')?.fetchedAt) || 0;
  } catch {
    return 0;
  }
}

/** Tiene al massimo `max` voci, eliminando le più vecchie (mai quella appena scritta). */
function trimCache(ls, keepKey, max) {
  const others = cacheKeys(ls).filter((k) => k !== keepKey)
    .map((k) => ({ k, t: fetchedAtOf(ls, k) }))
    .sort((a, b) => a.t - b.t);
  while (others.length > max - 1) ls.removeItem(others.shift().k);
}

function writeCache(spot, entry) {
  const ls = storage();
  if (!ls) return;
  const key = keyFor(spot.id);
  const raw = JSON.stringify({ ...entry, lat: spot.lat, lng: spot.lng });
  try {
    ls.setItem(key, raw);
    trimCache(ls, key, CACHE.maxSpots);
  } catch {
    // Spazio esaurito: si libera la voce più vecchia e si riprova una volta, poi si rinuncia
    try {
      trimCache(ls, key, Math.max(1, cacheKeys(ls).filter((k) => k !== key).length));
      ls.setItem(key, raw);
    } catch {
      /* la copia locale è facoltativa */
    }
  }
}

/* --------------------------------- Risultato --------------------------------- */

const ageOf = (entry, now) => Math.max(0, now - Date.parse(entry.fetchedAt));
const isComplete = (entry) => Boolean(entry?.weather && entry?.marine);
const isFresh = (entry, now) => isComplete(entry) && ageOf(entry, now) < CACHE.freshMs;

function fromEntry(entry, spot, now, source, error) {
  return {
    forecast: buildForecast({ weather: entry.weather, marine: entry.marine, spot, now }),
    meta: {
      source,
      fetchedAt: entry.fetchedAt,
      ageMs: ageOf(entry, now),
      partial: { weather: !entry.weather, marine: !entry.marine },
      error
    }
  };
}

function describeErrors(wErr, mErr) {
  if (wErr && mErr) return wErr === mErr ? `Previsioni non scaricate: ${wErr}.` : `Previsioni non scaricate: meteo, ${wErr}; mare, ${mErr}.`;
  if (wErr) return `Dati meteo non disponibili: ${wErr}.`;
  if (mErr) return `Dati del mare non disponibili: ${mErr}.`;
  return null;
}

/** Decide cosa restituire per uno spot dati i blocchi scaricati (o null) e la copia salvata. */
function resolve(spot, now, weather, marine, wErr, mErr) {
  const cached = readCache(spot);
  const error = describeErrors(weather ? null : wErr, marine ? null : mErr);
  if (weather || marine) {
    const entry = { fetchedAt: new Date(now).toISOString(), weather, marine };
    // Un risultato parziale non sostituisce una copia completa ancora utilizzabile: si resta su
    // quella, dichiarata come non aggiornata, invece di far sparire mare e punteggio
    if (!isComplete(entry) && isComplete(cached) && ageOf(cached, now) < CACHE.usableMs) {
      return fromEntry(cached, spot, now, 'stale', error);
    }
    writeCache(spot, entry);
    return fromEntry(entry, spot, now, 'network', error);
  }
  if (cached) return fromEntry(cached, spot, now, 'stale', error);
  return {
    forecast: null,
    meta: { source: 'none', fetchedAt: null, ageMs: null, partial: { weather: true, marine: true }, error }
  };
}

/**
 * Previsione di uno spot: copia locale se fresca (meno di 30 minuti), altrimenti rete;
 * senza rete la copia salvata diventa 'stale', senza copia la previsione è null.
 * @returns {Promise<{ forecast: object|null, meta: object }>}
 */
export async function loadForecast(spot, { force = false, now = Date.now() } = {}) {
  const cached = readCache(spot);
  if (!force && cached && isFresh(cached, now)) return fromEntry(cached, spot, now, 'cache', null);
  const [w, m] = await Promise.allSettled([fetchJson(weatherUrl(spot)), fetchJson(marineUrl(spot))]);
  const weather = w.status === 'fulfilled' && isBlock(w.value) ? w.value : null;
  const marine = m.status === 'fulfilled' && isBlock(m.value) ? m.value : null;
  return resolve(spot, now, weather, marine, reasonOf(w), reasonOf(m));
}

/**
 * Più spot con 2 richieste in tutto (coordinate separate da virgola). Gli spot con copia fresca
 * non vengono richiesti. @returns {Promise<Map<string, { forecast, meta }>>} nell'ordine degli spot
 */
export async function loadForecasts(spots, { now = Date.now() } = {}) {
  const list = (Array.isArray(spots) ? spots : []).filter((s) => s && Number.isFinite(s.lat) && Number.isFinite(s.lng));
  const out = new Map();
  const toFetch = [];
  for (const s of list) {
    const cached = readCache(s);
    if (cached && isFresh(cached, now)) out.set(s.id, fromEntry(cached, s, now, 'cache', null));
    else toFetch.push(s);
  }
  if (toFetch.length) {
    const [w, m] = await Promise.allSettled([fetchJson(weatherUrl(toFetch)), fetchJson(marineUrl(toFetch))]);
    const wl = asList(w, toFetch.length);
    const ml = asList(m, toFetch.length);
    const wErr = wl ? 'risposta senza dati orari' : w.status === 'rejected' ? reasonOf(w) : 'risposta incompleta';
    const mErr = ml ? 'risposta senza dati orari' : m.status === 'rejected' ? reasonOf(m) : 'risposta incompleta';
    toFetch.forEach((s, i) => {
      const weather = wl && isBlock(wl[i]) ? wl[i] : null;
      const marine = ml && isBlock(ml[i]) ? ml[i] : null;
      out.set(s.id, resolve(s, now, weather, marine, wErr, mErr));
    });
  }
  return new Map(list.map((s) => [s.id, out.get(s.id)]));
}
