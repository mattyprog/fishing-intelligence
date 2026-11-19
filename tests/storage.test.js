import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { FakeStorage, installFakeStorage, installBrokenStorage, uninstallStorage } from './helpers/fake-storage.js';
import { bus } from '../js/state.js';
import { PREDEFINED_SPOTS } from '../js/core/spots.js';
import {
  initStorage,
  getPrefs,
  setPrefs,
  listSpots,
  getSpot,
  saveSpot,
  deleteSpot,
  listGear,
  saveGear,
  deleteGear,
  listBaits,
  saveBait,
  deleteBait,
  listCatches,
  saveCatch,
  deleteCatch,
  countDemoRecords,
  removeDemoRecords,
  clearAllData,
  storageUsage,
  StorageError,
  ValidationError,
  getAllRecords,
  getQueue,
  normalizeSnapshot,
  setClock
} from '../js/services/storage.js';

const T0 = Date.parse('2026-11-19T10:00:00.000Z');

let storage;
let now;

function setNow(iso) {
  now = Date.parse(iso);
}

/** Cattura gli eventi data:changed emessi durante fn. */
function captureEvents(fn) {
  const events = [];
  const off = bus.on('data:changed', (p) => events.push(p));
  try {
    fn();
  } finally {
    off();
  }
  return events;
}

const validCatch = (extra = {}) => ({
  species: 'Orata',
  weight_g: 1180,
  length_cm: 41.5,
  lat: 41.2889,
  lng: 13.3461,
  caught_at: '2026-11-18T18:30:00.000Z',
  ...extra
});

const validRod = (extra = {}) => ({
  category: 'canna_surf',
  name: 'Surf 4.20',
  length_m: 4.2,
  min_cast_g: 100,
  max_cast_g: 200,
  ...extra
});

const validSpot = (extra = {}) => ({
  name: 'Foce del Canneto',
  lat: 41.3,
  lng: 13.3,
  coast_orientation_deg: 200,
  ...extra
});

beforeEach(() => {
  storage = installFakeStorage();
  now = T0;
  setClock(() => now);
});

afterEach(() => {
  setClock(null);
  uninstallStorage();
});

describe('initStorage', () => {
  test('senza dati: collezioni vuote, nessun dato dimostrativo, onboarded false', () => {
    const res = initStorage();
    assert.deepEqual(res, { migrated: false, demoCount: 0 });
    assert.deepEqual(getPrefs(), { spotId: 'salto-di-fondi', speciesId: 'orata', theme: 'auto', onboarded: false });
    assert.equal(listGear().length, 0);
    assert.equal(listBaits().length, 0);
    assert.equal(listCatches().length, 0);
    assert.equal(listSpots().length, PREDEFINED_SPOTS.length);
    assert.equal(storage.getJson('fi2_meta').schema, 2);
    assert.deepEqual(storage.getJson('fi2_gear'), []);
  });

  test('è idempotente e non perde i dati già scritti', () => {
    initStorage();
    saveGear(validRod());
    const res = initStorage();
    assert.equal(res.migrated, false);
    assert.equal(listGear().length, 1);
  });

  test('localStorage negato: non lancia, le scritture danno StorageError unavailable', () => {
    installBrokenStorage();
    const res = initStorage();
    assert.equal(res.error, 'unavailable');
    assert.equal(listGear().length, 0);
    assert.throws(() => saveGear(validRod()), (err) => err instanceof StorageError && err.code === 'unavailable');
  });
});

describe('migrazione dalla v1', () => {
  function seedV1(extra = {}) {
    storage.setItem('fi_initialized_v1', 'true');
    storage.setJson('fi_prefs_v1', { selectedLocationId: 'capratica', selectedSpeciesId: 'spigola', selectedDayIndex: 0, theme: 'sunlight' });
    storage.setJson('fi_custom_locations_v1', [
      { id: 'spot-1', client_id: 'spot-1', name: 'Scoglio di casa', region: 'Fondi', lat: 41.27, lng: 13.35, coast_orientation_deg: 360, seabed_type: 'Sabbia', notes: '', isCustom: true, updated_at: '2026-10-01T10:00:00.000Z' },
      { id: 'spot-rotto', client_id: 'spot-rotto', name: 'Senza coordinate', lat: null, lng: null, coast_orientation_deg: 210, updated_at: '2026-10-01T10:00:00.000Z' }
    ]);
    storage.setJson('fi_gear_items_v1', [
      { client_id: 'gear-default-1', category: 'canna_surf', name: 'Canna demo', length_m: 4.2, min_cast_g: 100, max_cast_g: 200, status: 'pronta', updated_at: '2026-09-01T10:00:00.000Z' },
      { client_id: 'gear-170-ab', category: 'canna_fondo', name: 'La mia canna', brand: 'Trabucco', status: 'pronta', updated_at: '2026-10-02T10:00:00.000Z' }
    ]);
    storage.setJson('fi_baits_inventory_v1', [
      { client_id: 'bait-default-1', name: 'Americano', category: 'anellide', quantity: 3, available: true, target_species: ['orata'], water_condition: 'tutte', updated_at: '2026-09-01T10:00:00.000Z' }
    ]);
    storage.setJson('fi_catches_v1', [
      { client_id: 'catch-default-1', species: 'Orata', weight_g: 1180, length_cm: 41.5, bait_used: 'Bibi', location_name: 'Salto di Fondi', lat: 41.2892, lng: 13.3454, caught_at: '2026-11-10T18:00:00.000Z', released: false, weather_snapshot: { waveHeightM: 0.45, pressureHpa: 1019, score: 84 }, notes: 'demo', updated_at: '2026-09-01T10:00:00.000Z' },
      { client_id: 'catch-170-xy', species: 'Spigola', weight_g: 1650, length_cm: null, bait_used: 'Americano', location_name: 'Foce', lat: 41.28, lng: 13.22, caught_at: '2026-11-12T05:00:00.000Z', released: true, weather_snapshot: { waveHeightM: 0.9, seaPhase: '<img src=x onerror=alert(1)>', light: 'dawn', score: '88', extra: 'x' }, notes: 'vera', updated_at: '2026-11-12T06:00:00.000Z' }
    ]);
    storage.setJson('fi_sync_queue_v1', [
      { opId: 'op-1', table: 'catches', action: 'DELETE', clientId: 'catch-cancellata', record: null, queuedAt: '2026-11-13T09:00:00.000Z' },
      { opId: 'op-2', table: 'gear_items', action: 'DELETE', clientId: 'gear-default-3', record: null, queuedAt: '2026-11-13T09:00:00.000Z' }
    ]);
    for (const [k, v] of Object.entries(extra)) storage.setJson(k, v);
  }

  test('migra preferenze, spot, attrezzatura, esche e catture', () => {
    seedV1();
    const res = initStorage();
    assert.equal(res.migrated, true);
    assert.equal(res.demoCount, 3);

    assert.deepEqual(getPrefs(), { spotId: 'capratica', speciesId: 'spigola', theme: 'light', onboarded: true });

    const custom = listSpots().filter((s) => s.isCustom);
    assert.equal(custom.length, 1, 'lo spot senza coordinate non si migra con valori di ripiego');
    assert.equal(custom[0].id, 'spot-1');
    assert.equal(custom[0].coast_orientation_deg, 0, '360 gradi della v1 diventa 0');

    const gear = listGear();
    assert.equal(gear.length, 2);
    const mine = gear.find((g) => g.client_id === 'gear-170-ab');
    assert.equal(mine.is_demo, false);
    assert.equal(mine.length_m, null, 'un numero assente nella v1 resta null');
    assert.equal(mine.max_cast_g, null);
    assert.equal(mine.main_line_mm, null);
    assert.equal(gear.find((g) => g.client_id === 'gear-default-1').is_demo, true);

    assert.equal(listBaits()[0].is_demo, true);

    const catches = listCatches();
    assert.equal(catches.length, 2);
    const real = catches.find((c) => c.client_id === 'catch-170-xy');
    assert.equal(real.length_cm, null);
    assert.equal(real.species_id, 'spigola', "la v1 salvava solo il nome: l'id si ricava dall'elenco delle specie");
    assert.equal(catches.find((c) => c.client_id === 'catch-default-1').species_id, 'orata');
    assert.deepEqual(real.weather_snapshot, { waveHeightM: 0.9, light: 'dawn' });
    assert.equal(real.updated_at, '2026-11-12T06:00:00.000Z', 'la versione v1 si conserva');
  });

  test('le chiavi v1 restano come copia di sicurezza', () => {
    seedV1();
    const before = storage.getItem('fi_catches_v1');
    initStorage();
    assert.equal(storage.getItem('fi_catches_v1'), before);
    assert.equal(storage.getItem('fi_initialized_v1'), 'true');
  });

  test('il segnaposto "Spot Personalizzato" della v1 non diventa la zona dello spot', () => {
    seedV1({
      fi_custom_locations_v1: [
        { id: 'spot-9', client_id: 'spot-9', name: 'Foce', region: 'Spot Personalizzato', lat: 41.22, lng: 13.76, coast_orientation_deg: 210, seabed_type: 'Sabbia media / Canalone', notes: '', isCustom: true, updated_at: '2026-10-01T10:00:00.000Z' }
      ]
    });
    initStorage();
    const spot = listSpots().find((s) => s.id === 'spot-9');
    assert.equal(spot.region, null);
    assert.equal(spot.name, 'Foce');
  });

  test('le previsioni salvate dalla v1 si eliminano, i dati no', () => {
    seedV1({ 'fi_weather_cache_v1_salto-di-fondi': { hourly: [1, 2, 3] }, fi_weather_cache_v1_capratica: { hourly: [] } });
    initStorage();
    assert.equal(storage.getItem('fi_weather_cache_v1_salto-di-fondi'), null);
    assert.equal(storage.getItem('fi_weather_cache_v1_capratica'), null);
    assert.notEqual(storage.getItem('fi_gear_items_v1'), null);
  });

  test('una specie v1 fuori elenco resta senza id, con il suo nome', () => {
    seedV1({
      fi_catches_v1: [
        { client_id: 'catch-170-zz', species: 'Pesce sconosciuto', weight_g: 300, lat: 41.28, lng: 13.22, caught_at: '2026-11-12T05:00:00.000Z', released: false, updated_at: '2026-11-12T06:00:00.000Z' },
        { client_id: 'catch-170-sm', species: 'Sarago Maggiore', weight_g: 500, lat: 41.28, lng: 13.22, caught_at: '2026-11-12T05:00:00.000Z', released: false, updated_at: '2026-11-12T06:00:00.000Z' }
      ]
    });
    initStorage();
    const byId = Object.fromEntries(listCatches().map((c) => [c.client_id, c]));
    assert.equal(byId['catch-170-zz'].species_id, null);
    assert.equal(byId['catch-170-zz'].species, 'Pesce sconosciuto');
    assert.equal(byId['catch-170-sm'].species_id, 'sarago');
  });

  test('i record dimostrativi non vanno in coda, quelli veri sì; le cancellazioni v1 diventano lapidi', () => {
    seedV1();
    initStorage();
    const queued = getQueue().map((e) => `${e.kind}:${e.client_id}`).sort();
    assert.deepEqual(queued, ['catches:catch-170-xy', 'catches:catch-cancellata', 'gear:gear-170-ab', 'spots:spot-1']);
    const tomb = getAllRecords('catches').find((r) => r.client_id === 'catch-cancellata');
    assert.equal(tomb.deleted_at, '2026-11-13T09:00:00.000Z');
    assert.ok(!listCatches().some((c) => c.client_id === 'catch-cancellata'));
  });

  test('tema dark della v1 diventa auto', () => {
    seedV1({ fi_prefs_v1: { selectedLocationId: 'spot-1', selectedSpeciesId: 'orata', theme: 'dark' } });
    initStorage();
    assert.equal(getPrefs().theme, 'auto');
    assert.equal(getPrefs().spotId, 'spot-1');
  });

  test('una seconda esecuzione non migra di nuovo', () => {
    seedV1();
    initStorage();
    deleteGear('gear-170-ab');
    const res = initStorage();
    assert.equal(res.migrated, false);
    assert.equal(listGear().length, 1);
  });
});

describe('preferenze', () => {
  beforeEach(() => initStorage());

  test('setPrefs aggiorna, salva ed emette prefs', () => {
    const events = captureEvents(() => setPrefs({ theme: 'dark', spotId: 'capratica' }));
    assert.deepEqual(events, [{ kind: 'prefs' }]);
    assert.equal(getPrefs().theme, 'dark');
    assert.equal(storage.getJson('fi2_prefs').spotId, 'capratica');
  });

  test('tema non ammesso: ValidationError', () => {
    assert.throws(() => setPrefs({ theme: 'sunlight' }), (err) => err instanceof ValidationError && err.field === 'theme');
  });
});

describe('spot', () => {
  beforeEach(() => initStorage());

  test('listSpots: predefiniti più personali con id = client_id e isCustom', () => {
    const saved = saveSpot(validSpot());
    const all = listSpots();
    assert.equal(all.length, PREDEFINED_SPOTS.length + 1);
    const mine = all.at(-1);
    assert.equal(mine.isCustom, true);
    assert.equal(mine.id, saved.client_id);
    assert.equal(getSpot(saved.id).name, 'Foce del Canneto');
    assert.equal(getSpot('salto-di-fondi').isCustom, false);
    assert.equal(getSpot('non-esiste'), null);
  });

  test('orientamento della costa obbligatorio, intero da 0 a 359', () => {
    assert.throws(() => saveSpot(validSpot({ coast_orientation_deg: '' })), (e) => e.field === 'coast_orientation_deg');
    assert.throws(() => saveSpot(validSpot({ coast_orientation_deg: 360 })), (e) => e.field === 'coast_orientation_deg');
    assert.throws(() => saveSpot(validSpot({ coast_orientation_deg: 12.5 })), (e) => e.field === 'coast_orientation_deg');
    assert.equal(saveSpot(validSpot({ coast_orientation_deg: '0' })).coast_orientation_deg, 0);
  });

  test('nome e coordinate validati', () => {
    assert.throws(() => saveSpot(validSpot({ name: '  ' })), (e) => e instanceof ValidationError && e.field === 'name' && e.message === 'Scrivi il nome dello spot.');
    assert.throws(() => saveSpot(validSpot({ name: 'x'.repeat(81) })), (e) => e.field === 'name');
    assert.throws(() => saveSpot(validSpot({ lat: 91 })), (e) => e.field === 'lat');
    assert.throws(() => saveSpot(validSpot({ lng: -181 })), (e) => e.field === 'lng');
    assert.throws(() => saveSpot(validSpot({ lat: undefined })), (e) => e.field === 'lat');
    assert.equal(saveSpot(validSpot({ lat: '41,25' })).lat, 41.25);
  });

  test('gli spot predefiniti non si modificano né si eliminano', () => {
    assert.throws(() => saveSpot({ ...validSpot(), id: 'salto-di-fondi' }), ValidationError);
    assert.throws(() => deleteSpot('salto-di-fondi'), ValidationError);
  });

  test('eliminare lo spot selezionato riporta la scelta allo spot di partenza', () => {
    const s = saveSpot(validSpot());
    setPrefs({ spotId: s.id });
    deleteSpot(s.id);
    assert.equal(getPrefs().spotId, 'salto-di-fondi');
    assert.equal(getSpot(s.id), null);
  });
});

describe('attrezzatura', () => {
  beforeEach(() => initStorage());

  test('completa client_id, created_at e updated_at; emette gear', () => {
    let saved;
    const events = captureEvents(() => {
      saved = saveGear(validRod());
    });
    assert.deepEqual(events, [{ kind: 'gear' }]);
    assert.match(saved.client_id, /^[0-9a-f-]{36}$/);
    assert.equal(saved.created_at, '2026-11-19T10:00:00.000Z');
    assert.equal(saved.updated_at, '2026-11-19T10:00:00.000Z');
    assert.equal(saved.is_demo, false);
    assert.equal(saved.status, 'pronta');

    setNow('2026-11-19T11:00:00.000Z');
    const again = saveGear({ ...saved, name: 'Surf 4.50' });
    assert.equal(again.created_at, saved.created_at);
    assert.equal(again.updated_at, '2026-11-19T11:00:00.000Z');
    assert.equal(listGear().length, 1);
  });

  test('updated_at cresce anche se l\'orologio torna indietro', () => {
    const saved = saveGear(validRod());
    setNow('2026-11-19T09:00:00.000Z');
    const again = saveGear({ ...saved, name: 'Altra' });
    assert.ok(Date.parse(again.updated_at) > Date.parse(saved.updated_at));
  });

  test('i numerici assenti restano null, mai valori plausibili', () => {
    const g = saveGear({ category: 'canna_fondo', name: 'Solo nome' });
    for (const f of ['length_m', 'min_cast_g', 'max_cast_g', 'optimal_cast_g', 'main_line_mm', 'shock_leader_mm', 'brand', 'reel_model', 'notes']) {
      assert.equal(g[f], null, f);
    }
  });

  test('validazione', () => {
    assert.throws(() => saveGear(validRod({ name: '' })), (e) => e.field === 'name' && e.message === 'Scrivi il nome della canna.');
    assert.throws(() => saveGear({ category: 'mulinello_filo', name: '' }), (e) => e.message === 'Scrivi il nome del mulinello.');
    assert.throws(() => saveGear(validRod({ category: 'fucile' })), (e) => e.field === 'category');
    assert.throws(() => saveGear(validRod({ category: undefined })), (e) => e.field === 'category');
    assert.throws(() => saveGear(validRod({ length_m: -1 })), (e) => e.field === 'length_m');
    assert.throws(() => saveGear(validRod({ main_line_mm: 'abc' })), (e) => e.field === 'main_line_mm');
    assert.throws(() => saveGear(validRod({ min_cast_g: 150, max_cast_g: 100 })), (e) => e.field === 'max_cast_g');
    assert.throws(() => saveGear(validRod({ status: 'rotta' })), (e) => e.field === 'status');
    assert.equal(saveGear(validRod({ main_line_mm: '0,22' })).main_line_mm, 0.22);
    assert.equal(saveGear(validRod({ min_cast_g: 0 })).min_cast_g, 0);
  });

  test('list restituisce copie', () => {
    saveGear(validRod());
    const list = listGear();
    list[0].name = 'manomessa';
    list.push({});
    assert.equal(listGear()[0].name, 'Surf 4.20');
    assert.equal(listGear().length, 1);
  });

  test('delete lascia una lapide che le list non mostrano e che va in coda', () => {
    const g = saveGear(validRod());
    setNow('2026-11-19T12:00:00.000Z');
    assert.equal(deleteGear(g.client_id), true);
    assert.equal(listGear().length, 0);
    const tomb = getAllRecords('gear').find((r) => r.client_id === g.client_id);
    assert.equal(tomb.deleted_at, '2026-11-19T12:00:00.000Z');
    assert.equal(tomb.updated_at, '2026-11-19T12:00:00.000Z');
    const entry = getQueue().find((e) => e.client_id === g.client_id);
    assert.equal(entry.updated_at, tomb.updated_at);
    assert.equal(deleteGear(g.client_id), false);
  });
});

describe('esche', () => {
  beforeEach(() => initStorage());

  test('quantità intera 0..999, available segue la quantità se non indicato', () => {
    assert.equal(saveBait({ name: 'Bibi', quantity: 2 }).available, true);
    assert.equal(saveBait({ name: 'Arenicola', quantity: 0 }).available, false);
    assert.equal(saveBait({ name: 'Cannolicchio', quantity: 3, available: false }).available, false);
    assert.throws(() => saveBait({ name: 'X', quantity: 1000 }), (e) => e.field === 'quantity');
    assert.throws(() => saveBait({ name: 'X', quantity: 1.5 }), (e) => e.field === 'quantity');
    assert.throws(() => saveBait({ name: 'X' }), (e) => e.field === 'quantity');
    assert.throws(() => saveBait({ name: '', quantity: 1 }), (e) => e.message === "Scrivi il nome dell'esca.");
    assert.throws(() => saveBait({ name: 'X', quantity: 1, category: 'plastica' }), (e) => e.field === 'category');
    assert.throws(() => saveBait({ name: 'X', quantity: 1, water_condition: 'burrasca' }), (e) => e.field === 'water_condition');
  });

  test('specie bersaglio come elenco pulito', () => {
    const b = saveBait({ name: 'Bibi', quantity: 1, target_species: 'orata, sarago, ,orata' });
    assert.deepEqual(b.target_species, ['orata', 'sarago']);
    assert.equal(b.water_condition, 'tutte');
    assert.equal(b.category, 'altro');
    assert.equal(listBaits().length, 1);
    deleteBait(b.client_id);
    assert.equal(listBaits().length, 0);
  });
});

describe('catture', () => {
  beforeEach(() => initStorage());

  test('ordinate per caught_at decrescente', () => {
    saveCatch(validCatch({ caught_at: '2026-11-10T10:00:00.000Z', species: 'A' }));
    saveCatch(validCatch({ caught_at: '2026-11-18T10:00:00.000Z', species: 'B' }));
    saveCatch(validCatch({ caught_at: '2026-11-15T10:00:00.000Z', species: 'C' }));
    assert.deepEqual(listCatches().map((c) => c.species), ['B', 'C', 'A']);
  });

  test('peso o lunghezza: almeno uno, entrambi maggiori di zero, null ammesso', () => {
    const onlyLength = saveCatch(validCatch({ weight_g: '', length_cm: 33 }));
    assert.equal(onlyLength.weight_g, null);
    assert.equal(onlyLength.length_cm, 33);
    const onlyWeight = saveCatch(validCatch({ weight_g: 540, length_cm: null }));
    assert.equal(onlyWeight.length_cm, null);
    assert.throws(() => saveCatch(validCatch({ weight_g: null, length_cm: null })), (e) => e.field === 'weight_g');
    assert.throws(() => saveCatch(validCatch({ weight_g: 0 })), (e) => e.field === 'weight_g');
    assert.throws(() => saveCatch(validCatch({ length_cm: -3 })), (e) => e.field === 'length_cm');
  });

  test('coordinate non valide: errore, nessuna posizione di ripiego', () => {
    assert.throws(() => saveCatch(validCatch({ lat: undefined })), (e) => e.field === 'lat');
    assert.throws(() => saveCatch(validCatch({ lat: 'boh' })), (e) => e.field === 'lat');
    assert.throws(() => saveCatch(validCatch({ lng: 200 })), (e) => e.field === 'lng');
    assert.equal(listCatches().length, 0);
  });

  test('data valida e non oltre 24 ore nel futuro', () => {
    assert.throws(() => saveCatch(validCatch({ caught_at: undefined })), (e) => e.field === 'caught_at');
    assert.throws(() => saveCatch(validCatch({ caught_at: 'ieri sera' })), (e) => e.field === 'caught_at');
    assert.throws(() => saveCatch(validCatch({ caught_at: '2026-11-20T11:00:00.000Z' })), (e) => e.field === 'caught_at');
    const ok = saveCatch(validCatch({ caught_at: '2026-11-20T09:00:00.000Z' }));
    assert.equal(ok.caught_at, '2026-11-20T09:00:00.000Z');
  });

  test('specie obbligatoria, note tagliate a 1000 caratteri', () => {
    assert.throws(() => saveCatch(validCatch({ species: '' })), (e) => e.field === 'species');
    const c = saveCatch(validCatch({ notes: 'n'.repeat(1500), bait_used: '  Bibi  ' }));
    assert.equal(c.notes.length, 1000);
    assert.equal(c.bait_used, 'Bibi');
    assert.equal(c.released, false);
    assert.equal(c.spot_id, null);
    assert.equal(c.species_id, null);
  });

  test('weather_snapshot normalizzato alla forma Snapshot', () => {
    const c = saveCatch(validCatch({
      weather_snapshot: {
        waveHeightM: 0.6,
        wavePeriodS: Number.NaN,
        windSpeedKmh: '12',
        windDirDeg: 225,
        pressureHpa: 1018,
        seaTempC: 17.5,
        seaPhase: '<img src=x onerror=alert(1)>',
        light: 'dusk',
        score: 72,
        html: '<script>alert(1)</script>',
        __proto__: { polluted: true }
      }
    }));
    assert.deepEqual(c.weather_snapshot, { waveHeightM: 0.6, windDirDeg: 225, pressureHpa: 1018, seaTempC: 17.5, light: 'dusk', score: 72 });
    assert.deepEqual(saveCatch(validCatch({ weather_snapshot: 'ciao' })).weather_snapshot, {});
    assert.deepEqual(normalizeSnapshot({ seaPhase: 'scaduta', light: 'giorno', score: 101 }), { seaPhase: 'scaduta' });
  });

  test('deleteCatch', () => {
    const c = saveCatch(validCatch());
    deleteCatch(c.client_id);
    assert.equal(listCatches().length, 0);
  });
});

describe('memoria piena', () => {
  test('la scrittura fallita lancia StorageError quota e non cambia nulla', () => {
    initStorage();
    saveCatch(validCatch({ species: 'Prima' }));
    storage.quotaBytes = storage.usedBytes() + 200;
    const before = storage.snapshot();
    let events;
    assert.throws(
      () => {
        events = captureEvents(() => saveCatch(validCatch({ species: 'Seconda', notes: 'x'.repeat(900) })));
      },
      (err) => err instanceof StorageError && err.code === 'quota' && /non sono stati salvati/.test(err.message)
    );
    assert.equal(events, undefined);
    assert.deepEqual(listCatches().map((c) => c.species), ['Prima']);
    assert.deepEqual(storage.snapshot(), before, 'nessuna chiave scritta a metà');
  });

  test('se fallisce la seconda chiave si ripristina la prima', () => {
    initStorage();
    const before = storage.snapshot();
    storage.failWrites = (key) => key === 'fi2_sync_queue';
    assert.throws(() => saveGear(validRod()), StorageError);
    assert.deepEqual(storage.snapshot(), before);
    assert.equal(listGear().length, 0);
  });
});

describe('dati dimostrativi e pulizia', () => {
  function seedDemo() {
    storage.setJson('fi_gear_items_v1', [{ client_id: 'gear-default-1', category: 'canna_surf', name: 'Demo', updated_at: '2026-09-01T10:00:00.000Z' }]);
    storage.setJson('fi_catches_v1', [{ client_id: 'catch-default-1', species: 'Orata', weight_g: 1000, lat: 41.2, lng: 13.3, caught_at: '2026-11-01T10:00:00.000Z', updated_at: '2026-09-01T10:00:00.000Z' }]);
    initStorage();
  }

  test('countDemoRecords e removeDemoRecords eliminano senza lapide', () => {
    seedDemo();
    saveGear(validRod());
    assert.equal(countDemoRecords(), 2);
    let removed;
    const events = captureEvents(() => {
      removed = removeDemoRecords();
    });
    assert.equal(removed, 2);
    assert.deepEqual(events, [{ kind: 'all' }]);
    assert.equal(countDemoRecords(), 0);
    assert.equal(listGear().length, 1);
    assert.ok(!getAllRecords('gear').some((r) => r.client_id === 'gear-default-1'));
    assert.ok(!getAllRecords('catches').some((r) => r.client_id === 'catch-default-1'));
  });

  test('modificare un record dimostrativo non lo manda in coda', () => {
    seedDemo();
    const demo = listGear()[0];
    const edited = saveGear({ ...demo, name: 'Demo modificata', is_demo: false });
    assert.equal(edited.is_demo, true);
    assert.equal(getQueue().length, 0);
    deleteGear(demo.client_id);
    assert.equal(getAllRecords('gear').length, 0, 'un demo eliminato sparisce del tutto');
  });

  test('clearAllData tiene solo il tema e non rimigra la v1', () => {
    seedDemo();
    setPrefs({ theme: 'light', spotId: 'capratica', onboarded: true });
    saveGear(validRod());
    storage.setItem('fi2_fc_salto', '{"x":1}');
    storage.setItem('altra_app', 'resta');
    storage.setItem('fi_catches_v1', '[{"client_id":"vecchia"}]');
    clearAllData();
    assert.deepEqual(getPrefs(), { spotId: 'salto-di-fondi', speciesId: 'orata', theme: 'light', onboarded: false });
    assert.equal(listGear().length, 0);
    assert.equal(getQueue().length, 0);
    assert.equal(storage.getItem('fi2_fc_salto'), null);
    assert.equal(storage.getItem('altra_app'), 'resta');
    assert.equal(storage.getItem('fi_catches_v1'), null, 'anche la copia della v1 va cancellata');
    assert.equal(Object.keys(storage.snapshot()).filter((k) => k.startsWith('fi_')).length, 0);
    const res = initStorage();
    assert.equal(res.migrated, false);
    assert.equal(listGear().length, 0);
    assert.equal(getPrefs().onboarded, false);
  });
});

describe('storageUsage', () => {
  test('somma le chiavi fi2_ e fi_ in byte UTF-16', async () => {
    const fresh = new FakeStorage();
    installFakeStorage(fresh);
    fresh.setItem('fi2_x', 'abc');
    fresh.setItem('fi_y_v1', 'de');
    fresh.setItem('altro', 'zzzzzzzz');
    const usage = await storageUsage();
    assert.equal(usage.bytes, (5 + 3 + 7 + 2) * 2);
    assert.equal(usage.quotaBytes, null);
  });

  test('quotaBytes da navigator.storage.estimate se disponibile', async () => {
    const original = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
    Object.defineProperty(globalThis, 'navigator', {
      configurable: true,
      value: { storage: { estimate: async () => ({ usage: 10, quota: 5_000_000 }) } }
    });
    try {
      initStorage();
      assert.equal((await storageUsage()).quotaBytes, 5_000_000);
    } finally {
      if (original) Object.defineProperty(globalThis, 'navigator', original);
    }
  });
});
