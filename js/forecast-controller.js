/**
 * Unico punto che carica le previsioni e calcola i punteggi.
 * Aggiorna lo stato condiviso ed emette gli eventi che le viste ascoltano.
 */

import { CACHE } from './config.js';
import { state, bus } from './state.js';
import { getSpot, listSpots, setPrefs } from './services/storage.js';
import { loadForecast } from './services/weather-api.js';
import { evaluateForecast } from './core/scoring.js';
import { SPECIES, getSpecies } from './core/species.js';

let loadToken = 0;

/** Le preferenze sono un comodo, non un requisito: se non si salvano la scelta vale lo stesso. */
function rememberPrefs(partial) {
  try {
    setPrefs(partial);
  } catch (err) {
    console.warn('Preferenza non salvata:', err?.message || err);
  }
}

export function currentSpot() {
  return getSpot(state.spotId) || listSpots()[0];
}

export function currentSpecies() {
  return getSpecies(state.speciesId) || SPECIES[0];
}

/** Vero se le previsioni in memoria sono troppo vecchie per mostrare un punteggio. */
export function isForecastExpired() {
  const age = state.forecastMeta?.ageMs;
  return Number.isFinite(age) && age > CACHE.usableMs;
}

function recompute() {
  if (!state.forecast || isForecastExpired()) {
    state.evaluations = null;
    return;
  }
  try {
    state.evaluations = evaluateForecast(state.forecast, currentSpecies());
  } catch (err) {
    console.error('Calcolo del punteggio non riuscito:', err);
    state.evaluations = null;
  }
  const days = state.forecast.days?.length || 0;
  if (state.dayIndex >= days) state.dayIndex = 0;
}

export async function refreshForecast({ force = false } = {}) {
  const spot = currentSpot();
  const token = ++loadToken;
  state.loading = true;
  bus.emit('forecast:loading');

  let result;
  try {
    result = await loadForecast(spot, { force });
  } catch (err) {
    result = {
      forecast: null,
      meta: { source: 'none', fetchedAt: null, ageMs: null, partial: {}, error: String(err?.message || err) }
    };
  }

  // Nel frattempo l'utente può aver cambiato spot: una risposta superata si scarta
  if (token !== loadToken) return;

  state.forecast = result.forecast;
  state.forecastMeta = result.meta;
  state.loading = false;
  recompute();
  bus.emit('forecast:updated');
}

export function selectSpot(id) {
  if (!getSpot(id)) return Promise.resolve();
  state.spotId = id;
  state.dayIndex = 0;
  state.forecast = null;
  state.forecastMeta = null;
  state.evaluations = null;
  rememberPrefs({ spotId: id });
  bus.emit('selection:changed');
  return refreshForecast();
}

export function selectSpecies(id) {
  if (!getSpecies(id)) return;
  state.speciesId = id;
  rememberPrefs({ speciesId: id });
  recompute();
  bus.emit('selection:changed');
  bus.emit('forecast:updated');
}

export function selectDay(index) {
  const days = state.forecast?.days?.length || 0;
  if (index < 0 || index >= days) return;
  state.dayIndex = index;
  bus.emit('selection:changed');
}

/** Riscarica quando l'app torna in primo piano o torna la rete, se i dati non sono più freschi. */
export function installAutoRefresh() {
  const maybeRefresh = () => {
    if (document.visibilityState !== 'visible' || state.loading) return;
    const fetchedAt = state.forecastMeta?.fetchedAt ? Date.parse(state.forecastMeta.fetchedAt) : 0;
    if (!fetchedAt || Date.now() - fetchedAt > CACHE.freshMs) refreshForecast();
  };
  document.addEventListener('visibilitychange', maybeRefresh);
  window.addEventListener('online', maybeRefresh);
}
