import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { installFakeStorage, uninstallStorage } from './helpers/fake-storage.js';
import {
  initStorage,
  saveGear,
  saveBait,
  saveCatch,
  saveSpot,
  deleteGear,
  listGear,
  listBaits,
  listCatches,
  listSpots,
  getPrefs,
  setPrefs,
  getAllRecords,
  getQueue,
  clearAllData,
  setClock,
  StorageError,
  ValidationError
} from '../js/services/storage.js';
import {
  exportBackup,
  validateBackup,
  importBackup,
  catchesToCsv,
  parseBackupText,
  MAX_BACKUP_BYTES,
  MAX_RECORDS_PER_KIND
} from '../js/services/backup.js';

let storage;
let now;
const setNow = (iso) => {
  now = Date.parse(iso);
};

const rod = (extra = {}) => ({ category: 'canna_surf', name: 'Surf 4.20', min_cast_g: 100, max_cast_g: 200, ...extra });
const fish = (extra = {}) => ({
  species: 'Orata',
  weight_g: 1180,
  length_cm: 41.5,
  lat: 41.2889,
  lng: 13.3461,
  caught_at: '2026-11-18T18:30:00.000Z',
  ...extra
});

function v1Backup() {
  return {
    app: 'Fishing Intelligence',
    exportedAt: '2026-11-01T10:00:00.000Z',
    customLocations: [
      { id: 'spot-1', name: 'Scoglio', lat: 41.27, lng: 13.35, coast_orientation_deg: 210, isCustom: true, updated_at: '2026-10-01T10:00:00.000Z' }
    ],
    gearItems: [
      { client_id: 'gear-default-1', category: 'canna_surf', name: 'Demo', updated_at: '2026-09-01T10:00:00.000Z' },
      { client_id: 'gear-99', category: 'canna_fondo', name: 'Mia', updated_at: '2026-10-01T10:00:00.000Z' }
    ],
    baitsInventory: [{ client_id: 'bait-9', name: 'Bibi', category: 'sipunculide', quantity: 2, available: true, updated_at: '2026-10-01T10:00:00.000Z' }],
    catches: [
      { client_id: 'catch-9', species: 'Spigola', weight_g: 1650, lat: 41.28, lng: 13.22, caught_at: '2026-11-12T05:00:00.000Z', weather_snapshot: { waveHeightM: 0.9 }, updated_at: '2026-11-12T06:00:00.000Z' }
    ]
  };
}

beforeEach(() => {
  storage = installFakeStorage();
  now = Date.parse('2026-11-19T10:00:00.000Z');
  setClock(() => now);
  initStorage();
});

afterEach(() => {
  setClock(null);
  uninstallStorage();
});

describe('exportBackup', () => {
  test('forma v2, niente lapidi, demo inclusi e marcati', () => {
    storage = installFakeStorage();
    storage.setJson('fi_gear_items_v1', [{ client_id: 'gear-default-1', category: 'canna_surf', name: 'Demo', updated_at: '2026-09-01T10:00:00.000Z' }]);
    initStorage();
    const kept = saveGear(rod());
    const gone = saveGear(rod({ name: 'Da eliminare' }));
    deleteGear(gone.client_id);
    saveSpot({ name: 'Mio spot', lat: 41.3, lng: 13.3, coast_orientation_deg: 200 });
    saveCatch(fish());

    const b = exportBackup();
    assert.equal(b.app, 'Fishing Intelligence');
    assert.equal(b.schema, 2);
    assert.equal(b.exportedAt, '2026-11-19T10:00:00.000Z');
    assert.deepEqual(b.gear.map((g) => g.client_id).sort(), [kept.client_id, 'gear-default-1'].sort());
    assert.equal(b.gear.find((g) => g.client_id === 'gear-default-1').is_demo, true);
    assert.equal(b.spots.length, 1);
    assert.equal(b.catches.length, 1);
    assert.equal(b.prefs.spotId, 'salto-di-fondi');
    assert.ok(!JSON.stringify(b).includes('deleted_at'));
  });

  test('andata e ritorno: export, svuota, import replace', () => {
    saveGear(rod());
    saveBait({ name: 'Bibi', quantity: 2 });
    saveCatch(fish({ notes: 'con "virgolette"' }));
    saveSpot({ name: 'Mio spot', lat: 41.3, lng: 13.3, coast_orientation_deg: 200 });
    setPrefs({ theme: 'dark', spotId: 'capratica' });
    const before = { gear: listGear(), baits: listBaits(), catches: listCatches(), spots: listSpots() };
    const text = JSON.stringify(exportBackup());

    clearAllData();
    assert.equal(listGear().length, 0);
    const counts = importBackup(parseBackupText(text), { mode: 'replace' });
    assert.deepEqual(counts, { spots: 1, gear: 1, baits: 1, catches: 1 });

    const strip = (list) => list.map(({ updated_at, ...r }) => r);
    assert.deepEqual(strip(listGear()), strip(before.gear));
    assert.deepEqual(strip(listBaits()), strip(before.baits));
    assert.deepEqual(strip(listCatches()), strip(before.catches));
    assert.deepEqual(strip(listSpots()), strip(before.spots));
    assert.equal(getPrefs().theme, 'dark');
    assert.equal(getPrefs().spotId, 'capratica');
  });
});

describe('validateBackup', () => {
  test('accetta il formato v1 e marca i demo', () => {
    const res = validateBackup(v1Backup());
    assert.equal(res.ok, true, res.errors.join(' | '));
    assert.deepEqual(res.counts, { spots: 1, gear: 2, baits: 1, catches: 1 });
    importBackup(v1Backup(), { mode: 'merge' });
    assert.equal(listGear().find((g) => g.client_id === 'gear-default-1').is_demo, true);
    assert.equal(listGear().find((g) => g.client_id === 'gear-99').is_demo, false);
    assert.equal(listSpots().at(-1).id, 'spot-1');
  });

  test('rifiuta ciò che non è un backup', () => {
    for (const bad of [null, 42, 'ciao', [], {}, { foo: 1 }, { app: 'Altro', schema: 2 }]) {
      const res = validateBackup(bad);
      assert.equal(res.ok, false, JSON.stringify(bad));
      assert.ok(res.errors.length > 0);
    }
    assert.match(validateBackup({ app: 'Fishing Intelligence', schema: 3 }).errors[0], /versione più recente/);
  });

  test('coordinate mancanti: errore con il numero del record, nessun ripiego', () => {
    const b = v1Backup();
    b.catches.push({ client_id: 'catch-10', species: 'Orata', weight_g: 500, caught_at: '2026-11-12T05:00:00.000Z', updated_at: '2026-11-12T06:00:00.000Z' });
    const res = validateBackup(b);
    assert.equal(res.ok, false);
    assert.match(res.errors[0], /^Cattura 2: /);
  });

  test('client_id ripetuto nello stesso file', () => {
    const b = v1Backup();
    b.gearItems.push({ ...b.gearItems[1], name: 'Doppione' });
    const res = validateBackup(b);
    assert.equal(res.ok, false);
    assert.match(res.errors[0], /ripetuto/);
  });

  test('oltre 5000 record per tipo: rifiutato', () => {
    const b = { app: 'Fishing Intelligence', schema: 2, exportedAt: '2026-11-19T10:00:00.000Z', spots: [], gear: [], baits: [], catches: [] };
    b.baits = Array.from({ length: MAX_RECORDS_PER_KIND + 1 }, (_, i) => ({ client_id: `b${i}`, name: 'x', quantity: 1, updated_at: '2026-11-01T10:00:00.000Z' }));
    const res = validateBackup(b);
    assert.equal(res.ok, false);
    assert.match(res.errors[0], /5000/);
  });

  test('oltre 2 MB: rifiutato, sia come oggetto sia come testo', () => {
    const b = { app: 'Fishing Intelligence', schema: 2, spots: [], gear: [], baits: [], catches: [], padding: 'x'.repeat(MAX_BACKUP_BYTES) };
    const res = validateBackup(b);
    assert.equal(res.ok, false);
    assert.match(res.errors[0], /2 MB/);
    assert.throws(() => parseBackupText(JSON.stringify(b)), (e) => e instanceof ValidationError && /2 MB/.test(e.message));
    assert.throws(() => parseBackupText('{ non json'), ValidationError);
    assert.equal(parseBackupText('\uFEFF{"a":1}').a, 1);
  });

  test('weather_snapshot dal backup ridotto alla forma Snapshot', () => {
    const b = v1Backup();
    b.catches[0].weather_snapshot = { waveHeightM: 0.9, seaPhase: '"><script>alert(1)</script>', light: 'night', score: Infinity, x: '<b>' };
    importBackup(b, { mode: 'merge' });
    assert.deepEqual(listCatches()[0].weather_snapshot, { waveHeightM: 0.9, light: 'night' });
  });
});

describe('importBackup', () => {
  test('file non valido: nessuna scrittura, neanche parziale', () => {
    saveGear(rod());
    const before = storage.snapshot();
    const b = v1Backup();
    b.catches.push({ client_id: 'catch-rotta', species: 'Orata', weight_g: 500, lat: 999, lng: 13, caught_at: '2026-11-12T05:00:00.000Z' });
    assert.throws(
      () => importBackup(b, { mode: 'merge' }),
      (e) => e instanceof ValidationError && Array.isArray(e.errors) && e.errors.length === 1
    );
    assert.deepEqual(storage.snapshot(), before);
    assert.equal(listGear().length, 1);
  });

  test('scrittura atomica: se il browser rifiuta una chiave non cambia niente', () => {
    saveGear(rod());
    const before = storage.snapshot();
    storage.failWrites = (key) => key === 'fi2_catches';
    assert.throws(() => importBackup(v1Backup(), { mode: 'merge' }), (e) => e instanceof StorageError && e.code === 'quota');
    assert.deepEqual(storage.snapshot(), before);
    assert.equal(listGear().length, 1);
    assert.equal(listBaits().length, 0);
  });

  test('modalità non valida', () => {
    assert.throws(() => importBackup(v1Backup(), { mode: 'mescola' }), (e) => e.field === 'mode');
  });

  test('merge: per client_id vince updated_at più recente', () => {
    setNow('2026-11-19T10:00:00.000Z');
    const local = saveGear(rod({ client_id: 'g-1', name: 'Locale nuova' }));
    saveGear(rod({ client_id: 'g-2', name: 'Locale vecchia' }));
    const b = {
      app: 'Fishing Intelligence',
      schema: 2,
      exportedAt: '2026-11-19T10:00:00.000Z',
      gear: [
        { ...rod(), client_id: 'g-1', name: 'Backup vecchia', updated_at: '2026-11-01T10:00:00.000Z' },
        { ...rod(), client_id: 'g-2', name: 'Backup nuova', updated_at: '2026-11-19T10:30:00.000Z' },
        { ...rod(), client_id: 'g-3', name: 'Solo nel backup', updated_at: '2026-11-02T10:00:00.000Z' }
      ]
    };
    const counts = importBackup(b, { mode: 'merge' });
    assert.deepEqual(counts, { spots: 0, gear: 2, baits: 0, catches: 0 });
    const byId = Object.fromEntries(listGear().map((g) => [g.client_id, g.name]));
    assert.deepEqual(byId, { 'g-1': 'Locale nuova', 'g-2': 'Backup nuova', 'g-3': 'Solo nel backup' });
    assert.equal(listGear().find((g) => g.client_id === 'g-1').updated_at, local.updated_at);
    assert.ok(getQueue().some((e) => e.client_id === 'g-3'), 'i record importati vanno sincronizzati');
  });

  test('replace: ciò che non è nel backup diventa lapide, i demo spariscono', () => {
    storage = installFakeStorage();
    storage.setJson('fi_baits_inventory_v1', [{ client_id: 'bait-default-1', name: 'Demo', quantity: 1, updated_at: '2026-09-01T10:00:00.000Z' }]);
    initStorage();
    assert.equal(listBaits()[0].is_demo, true);
    const old = saveGear(rod({ name: 'Non nel backup' }));
    setNow('2026-11-19T11:00:00.000Z');
    importBackup({ app: 'Fishing Intelligence', schema: 2, exportedAt: '2026-11-19T10:00:00.000Z', gear: [{ ...rod(), client_id: 'g-new', updated_at: '2026-11-01T10:00:00.000Z' }] }, { mode: 'replace' });
    assert.deepEqual(listGear().map((g) => g.client_id), ['g-new']);
    assert.equal(listGear()[0].updated_at, '2026-11-19T11:00:00.000Z', 'il ripristino diventa la versione più recente');
    const tomb = getAllRecords('gear').find((r) => r.client_id === old.client_id);
    assert.ok(tomb.deleted_at);
    assert.ok(getQueue().some((e) => e.client_id === old.client_id && e.updated_at === tomb.updated_at));
    assert.equal(listBaits().length, 0);
    assert.ok(!getAllRecords('baits').length);
  });
});

describe('catchesToCsv', () => {
  test('BOM, intestazione, separatore ; e righe', () => {
    const csv = catchesToCsv([
      {
        client_id: 'c1',
        species: 'Orata',
        weight_g: 1180,
        length_cm: 41.5,
        released: true,
        bait_used: 'Bibi',
        gear_used: 'Surf; 4.20',
        location_name: 'Salto di Fondi',
        lat: 41.2889,
        lng: -3.5,
        caught_at: '2026-11-18T18:30:00.000Z',
        weather_snapshot: { waveHeightM: 0.45, wavePeriodS: 5.8, windSpeedKmh: 14, pressureHpa: 1019, seaTempC: 17.2, score: 84 },
        notes: 'Disse "bella"\nseconda riga'
      }
    ], { timeZone: 'UTC' });
    assert.ok(csv.startsWith('\uFEFF'));
    const lines = csv.slice(1).split('\r\n');
    assert.equal(lines[0], 'data;ora;specie;peso_g;lunghezza_cm;rilasciata;esca;canna;spot;lat;lng;onda_m;periodo_s;vento_kmh;pressione_hpa;acqua_c;punteggio;note');
    assert.equal(
      lines[1],
      '2026-11-18;18:30;Orata;1180;41,5;sì;Bibi;"Surf; 4.20";Salto di Fondi;41,2889;-3,5;0,45;5,8;14;1019;17,2;84;"Disse ""bella""\nseconda riga"'
    );
    assert.equal(lines[2], '', 'la riga finisce con CRLF');
    assert.equal(lines.length, 3);
  });

  test('dati assenti: celle vuote', () => {
    const csv = catchesToCsv([{ species: 'Mormora', weight_g: null, length_cm: 30, lat: 41, lng: 13, caught_at: '2026-11-18T05:00:00.000Z', released: false, weather_snapshot: {}, notes: null }], { timeZone: 'UTC' });
    assert.equal(csv.slice(1).split('\r\n')[1], '2026-11-18;05:00;Mormora;;30;no;;;;41;13;;;;;;;');
  });

  test('protezione dalla formula injection sulle celle di testo', () => {
    const csv = catchesToCsv([
      { species: '=HYPERLINK("http://x")', weight_g: 1, lat: 41, lng: -13, caught_at: '2026-11-18T05:00:00.000Z', bait_used: '+39', gear_used: '-2', location_name: '@SUM(A1)', notes: '  =1+1' }
    ], { timeZone: 'UTC' });
    const row = csv.slice(1).split('\r\n')[1];
    assert.ok(row.includes(`"'=HYPERLINK(""http://x"")"`), row);
    assert.ok(row.includes(";'+39;'-2;'@SUM(A1);"), row);
    assert.ok(row.endsWith(";'  =1+1"), row);
    assert.ok(row.includes(';41;-13;'), 'i numeri negativi restano numeri');
  });

  test('salta le lapidi e usa il fuso indicato', () => {
    const csv = catchesToCsv([
      { client_id: 'x', deleted_at: '2026-11-18T05:00:00.000Z' },
      { species: 'Spigola', weight_g: 900, lat: 41, lng: 13, caught_at: '2026-11-18T23:30:00.000Z' }
    ], { timeZone: 'Europe/Rome' });
    const lines = csv.slice(1).split('\r\n').filter(Boolean);
    assert.equal(lines.length, 2);
    assert.ok(lines[1].startsWith('2026-11-19;00:30;Spigola;'));
  });
});
