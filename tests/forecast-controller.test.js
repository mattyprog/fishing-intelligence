import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { installFakeStorage, uninstallStorage } from './helpers/fake-storage.js';
import { API } from '../js/config.js';
import { state } from '../js/state.js';
import { initStorage, saveSpot, deleteSpot, setPrefs, getPrefs } from '../js/services/storage.js';
import { exportBackup, importBackup } from '../js/services/backup.js';
import { refreshForecast, selectSpot, handleDataChanged } from '../js/forecast-controller.js';

const load = (name) => JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8'));
const WEATHER = load('open-meteo-weather.json');
const MARINE = load('open-meteo-marine.json');

let savedFetch;
let calls;

beforeEach(() => {
  installFakeStorage();
  savedFetch = globalThis.fetch;
  calls = [];
  globalThis.fetch = async (url) => {
    calls.push(String(url));
    const body = String(url).startsWith(API.marine) ? MARINE : WEATHER;
    return { ok: true, status: 200, json: async () => body };
  };
  initStorage();
  state.spotId = 'salto-di-fondi';
  state.speciesId = 'orata';
  state.dayIndex = 0;
  state.forecast = null;
  state.forecastMeta = null;
  state.evaluations = null;
});

afterEach(() => {
  globalThis.fetch = savedFetch;
  uninstallStorage();
});

const mySpot = (extra = {}) => ({ name: 'Foce', lat: 41.22, lng: 13.76, coast_orientation_deg: 210, ...extra });

test('ripristino che elimina lo spot attivo: selezione e previsioni passano a uno spot che esiste', async () => {
  const empty = exportBackup();
  const mine = saveSpot(mySpot());
  await selectSpot(mine.id);
  assert.equal(state.spotId, mine.id);
  assert.equal(state.forecast.spotId, mine.id);

  importBackup(empty, { mode: 'replace' });
  await handleDataChanged({ kind: 'all' });
  assert.equal(state.spotId, 'salto-di-fondi');
  assert.equal(state.forecast.spotId, 'salto-di-fondi', 'le previsioni mostrate sono dello spot scritto in alto');
  assert.equal(getPrefs().spotId, 'salto-di-fondi');
});

test('spot attivo eliminato da un\'altra parte (sincronizzazione): si passa a quello delle preferenze', async () => {
  const mine = saveSpot(mySpot());
  await selectSpot(mine.id);
  deleteSpot(mine.id);
  await handleDataChanged({ kind: 'spots', source: 'sync' });
  assert.notEqual(state.spotId, mine.id);
  assert.equal(state.forecast.spotId, state.spotId);
});

test('ripristino con altre preferenze: specie e spot seguono la copia', async () => {
  setPrefs({ spotId: 'capratica', speciesId: 'spigola' });
  const backup = exportBackup();
  setPrefs({ spotId: 'salto-di-fondi', speciesId: 'orata' });
  await refreshForecast();
  assert.equal(state.forecast.spotId, 'salto-di-fondi');

  importBackup(backup, { mode: 'replace' });
  await handleDataChanged({ kind: 'all' });
  assert.equal(state.speciesId, 'spigola');
  assert.equal(state.spotId, 'capratica');
  assert.equal(state.forecast.spotId, 'capratica');
});

test('spot attivo spostato da una sincronizzazione: le previsioni si riscaricano per il nuovo punto', async () => {
  const mine = saveSpot(mySpot());
  await selectSpot(mine.id);
  calls.length = 0;

  // nessun cambiamento: niente da fare
  assert.equal(handleDataChanged({ kind: 'spots', source: 'sync' }), undefined);
  assert.equal(calls.length, 0);

  saveSpot({ ...mySpot({ lat: 41.4, lng: 13.1 }), id: mine.id, client_id: mine.id });
  await handleDataChanged({ kind: 'spots', source: 'sync' });
  assert.equal(calls.length, 2, 'due richieste: meteo e mare per le nuove coordinate');
  assert.equal(state.forecast.lat, 41.4);
  assert.equal(state.forecast.lng, 13.1);
});

test('una modifica qualunque ai dati non fa ricaricare nulla', async () => {
  await refreshForecast();
  calls.length = 0;
  assert.equal(handleDataChanged({ kind: 'catches' }), undefined);
  assert.equal(handleDataChanged({ kind: 'prefs' }), undefined);
  assert.equal(handleDataChanged(), undefined);
  assert.equal(calls.length, 0);
  assert.equal(state.spotId, 'salto-di-fondi');
});
