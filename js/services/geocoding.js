/**
 * Ricerca di luoghi con Nominatim (OpenStreetMap), nel rispetto della sua politica d'uso:
 * al massimo una richiesta al secondo (coda con attesa), risultati in cache, nessun
 * autocompletamento: si chiama solo quando l'utente conferma la ricerca.
 */

import { API } from '../config.js';

const MIN_INTERVAL_MS = 1000;
const MIN_QUERY_LENGTH = 3;

const cache = new Map();
let queue = Promise.resolve();
let lastRequestAt = 0;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function buildUrl(q, countryCodes) {
  const cc = countryCodes ? `&countrycodes=${encodeURIComponent(countryCodes)}` : '';
  return `${API.geocode}?q=${encodeURIComponent(q)}&format=jsonv2&limit=6&accept-language=it${cc}`;
}

async function fetchPlaces(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), API.timeoutMs);
  try {
    const res = await fetch(url, { signal: controller.signal, headers: { Accept: 'application/json' } });
    if (!res.ok) throw new Error(`Ricerca non riuscita: il servizio ha risposto con errore ${res.status}.`);
    const data = await res.json().catch(() => null);
    if (!Array.isArray(data)) throw new Error('Ricerca non riuscita: risposta non leggibile.');
    return data;
  } catch (err) {
    if (err?.name === 'AbortError') throw new Error('Ricerca non riuscita: il servizio non ha risposto in tempo.');
    if (err instanceof TypeError) throw new Error('Ricerca non riuscita: controlla la connessione.');
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

function toPlace(item) {
  const lat = Number.parseFloat(item?.lat);
  const lng = Number.parseFloat(item?.lon);
  if (!Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) return null;
  const fullName = typeof item.display_name === 'string' ? item.display_name : '';
  const name = (typeof item.name === 'string' && item.name.trim()) || fullName.split(',')[0].trim();
  if (!name) return null;
  return { name, fullName: fullName || name, lat: Number(lat.toFixed(5)), lng: Number(lng.toFixed(5)) };
}

/**
 * Cerca luoghi per nome. Query sotto i 3 caratteri → [] senza richiesta.
 * @param {string} query
 * @param {{ countryCodes?: string|null }} [opts] countryCodes null per cercare in tutto il mondo
 * @returns {Promise<{ name: string, fullName: string, lat: number, lng: number }[]>}
 */
export function searchPlaces(query, { countryCodes = 'it' } = {}) {
  const q = String(query ?? '').trim().replace(/\s+/g, ' ');
  if (q.length < MIN_QUERY_LENGTH) return Promise.resolve([]);
  const key = `${countryCodes || '*'}|${q.toLowerCase()}`;
  const copy = (list) => list.map((p) => ({ ...p }));
  if (cache.has(key)) return Promise.resolve(copy(cache.get(key)));

  const run = queue.then(async () => {
    if (cache.has(key)) return cache.get(key); // una richiesta uguale in coda ha già risposto
    const wait = lastRequestAt + MIN_INTERVAL_MS - Date.now();
    if (wait > 0) await sleep(wait);
    lastRequestAt = Date.now();
    const places = (await fetchPlaces(buildUrl(q, countryCodes))).map(toPlace).filter(Boolean);
    cache.set(key, places);
    return places;
  });
  queue = run.catch(() => {});
  return run.then(copy);
}
