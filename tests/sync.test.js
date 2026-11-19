import { test, describe, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { FakeStorage, installFakeStorage, uninstallStorage } from './helpers/fake-storage.js';
import { bus } from '../js/state.js';
import { CLOUD } from '../js/config.js';
import {
  initStorage,
  saveGear,
  saveCatch,
  saveSpot,
  deleteGear,
  deleteCatch,
  listGear,
  listCatches,
  listSpots,
  getQueue,
  removeDemoRecords,
  countDemoRecords,
  setClock
} from '../js/services/storage.js';
import { syncNow, getSyncStatus, setCloudAdapter, SYNC_TABLES } from '../js/services/sync.js';
import { exportBackup, importBackup } from '../js/services/backup.js';

const USER = { id: 'user-1', email: 'pescatore@example.it' };
const clone = (v) => JSON.parse(JSON.stringify(v));

/**
 * Cloud finto in memoria: una riga per (utente, client_id), synced_at assegnato dal "server"
 * a ogni scrittura, guardia sulle versioni vecchie come il trigger di schema.sql.
 */
class FakeCloud {
  constructor() {
    this.tables = new Map(SYNC_TABLES.map((t) => [t, new Map()]));
    this.serverMs = Date.parse('2026-11-19T07:00:00.000Z');
    this.log = [];
    this.hooks = {};
  }

  rows(table, userId = USER.id) {
    return [...this.tables.get(table).values()].filter((r) => r.user_id === userId);
  }

  row(table, clientId, userId = USER.id) {
    return this.tables.get(table).get(`${userId}:${clientId}`) ?? null;
  }

  seed(table, record, userId = USER.id) {
    this.serverMs += 1000;
    this.tables.get(table).set(`${userId}:${record.client_id}`, { ...clone(record), user_id: userId, synced_at: new Date(this.serverMs).toISOString() });
  }

  adapter(user = USER) {
    const cloud = this;
    return {
      async getUser() {
        return user ? { ...user } : null;
      },
      async pull(table, since) {
        cloud.log.push({ op: 'pull', table, since });
        await Promise.resolve();
        if (cloud.hooks.pull) await cloud.hooks.pull(table, since);
        return cloud
          .rows(table, user.id)
          .filter((r) => !since || Date.parse(r.synced_at) > Date.parse(since))
          .map(clone);
      },
      async push(table, records) {
        cloud.log.push({ op: 'push', table, ids: records.map((r) => r.client_id) });
        for (const r of records) assert.ok(!('is_demo' in r), 'is_demo non va mai inviato');
        if (cloud.hooks.push) await cloud.hooks.push(table, records);
        for (const r of records) {
          const cur = cloud.row(table, r.client_id, user.id);
          if (cur && Date.parse(r.updated_at) < Date.parse(cur.updated_at)) continue;
          cloud.seed(table, r, user.id);
        }
      }
    };
  }
}

let cloud;
let now;
const at = (iso) => {
  now = Date.parse(iso);
};

function device() {
  return { storage: new FakeStorage() };
}

/** Passa a un dispositivo: il suo localStorage diventa quello globale e lo storage si ricarica. */
function use(dev) {
  installFakeStorage(dev.storage);
  initStorage();
}

const rod = (extra = {}) => ({ category: 'canna_surf', name: 'Surf 4.20', min_cast_g: 100, max_cast_g: 200, ...extra });
const fish = (extra = {}) => ({ species: 'Orata', weight_g: 900, lat: 41.29, lng: 13.35, caught_at: '2026-11-18T18:00:00.000Z', ...extra });

const savedCloud = { url: CLOUD.url, anonKey: CLOUD.anonKey };

before(() => {
  CLOUD.url = 'https://progettofinto.supabase.co';
  CLOUD.anonKey = 'chiave-anonima-finta-abbastanza-lunga';
});

after(() => {
  CLOUD.url = savedCloud.url;
  CLOUD.anonKey = savedCloud.anonKey;
});

beforeEach(() => {
  cloud = new FakeCloud();
  at('2026-11-19T10:00:00.000Z');
  setClock(() => now);
  setCloudAdapter(cloud.adapter(), { autoSync: false });
});

afterEach(() => {
  setCloudAdapter(null);
  setClock(null);
  uninstallStorage();
});

describe('quando il cloud non c\'è', () => {
  test('senza configurazione o senza adattatore è un no-op che non lancia', async () => {
    use(device());
    saveGear(rod());
    CLOUD.url = '';
    try {
      assert.equal(getSyncStatus().enabled, false);
      const res = await syncNow();
      assert.equal(res.ok, false);
      assert.equal(res.skipped, 'disabled');
    } finally {
      CLOUD.url = 'https://progettofinto.supabase.co';
    }
    setCloudAdapter(null);
    assert.equal(getSyncStatus().enabled, false);
    assert.equal((await syncNow()).skipped, 'disabled');
    assert.equal(cloud.log.length, 0);
    assert.equal(getSyncStatus().pending, 1);
  });

  test('utente non collegato: non scarica e non invia', async () => {
    setCloudAdapter(cloud.adapter(null), { autoSync: false });
    use(device());
    saveGear(rod());
    const res = await syncNow();
    assert.equal(res.skipped, 'signed-out');
    assert.equal(cloud.log.length, 0);
    assert.equal(getQueue().length, 1);
  });

  test('offline: non parte', async () => {
    use(device());
    const original = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
    Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { onLine: false } });
    try {
      assert.equal(getSyncStatus().online, false);
      assert.equal((await syncNow()).skipped, 'offline');
    } finally {
      if (original) Object.defineProperty(globalThis, 'navigator', original);
    }
    assert.equal(cloud.log.length, 0);
  });

  test('adattatore incompleto: errore subito', () => {
    assert.throws(() => setCloudAdapter({ getUser() {} }), TypeError);
  });
});

describe('due dispositivi', () => {
  test('primo giro: il locale va sul cloud e arriva sull\'altro dispositivo', async () => {
    const a = device();
    const b = device();
    use(a);
    const g = saveGear(rod());
    const s = saveSpot({ name: 'Foce', lat: 41.3, lng: 13.3, coast_orientation_deg: 200 });
    const res = await syncNow();
    assert.equal(res.ok, true);
    assert.equal(res.pushed, 2);
    assert.equal(getQueue().length, 0);
    assert.ok(getSyncStatus().lastSyncAt);
    assert.equal(cloud.row('gear_items', g.client_id).name, 'Surf 4.20');
    assert.equal(cloud.row('custom_locations', s.client_id).deleted_at, null);

    use(b);
    await syncNow();
    assert.deepEqual(listGear().map((x) => x.client_id), [g.client_id]);
    assert.ok(listSpots().some((x) => x.id === s.id && x.isCustom));
  });

  test('un cloud vuoto non svuota il locale', async () => {
    use(device());
    saveGear(rod());
    saveCatch(fish());
    // coda persa (per esempio dati arrivati da una versione precedente): il giro completo la ricostruisce
    globalThis.localStorage.setItem('fi2_sync_queue', '[]');
    initStorage();
    assert.equal(getQueue().length, 0);
    const res = await syncNow();
    assert.equal(res.ok, true);
    assert.equal(listGear().length, 1);
    assert.equal(listCatches().length, 1);
    assert.equal(cloud.rows('gear_items').length, 1);
    assert.equal(cloud.rows('catches').length, 1);
  });

  test('cancellazione offline poi sincronizzazione: il record non ricompare', async () => {
    const a = device();
    const b = device();
    use(a);
    const g = saveGear(rod());
    await syncNow();
    use(b);
    await syncNow();
    assert.equal(listGear().length, 1);

    use(a);
    at('2026-11-19T11:00:00.000Z');
    deleteGear(g.client_id);
    const res = await syncNow();
    assert.equal(res.ok, true);
    assert.equal(listGear().length, 0, 'la versione viva sul cloud è più vecchia della lapide');
    assert.ok(cloud.row('gear_items', g.client_id).deleted_at);
    assert.equal(getQueue().length, 0);

    await syncNow();
    assert.equal(listGear().length, 0);

    use(b);
    await syncNow();
    assert.equal(listGear().length, 0, 'la lapide arriva anche sull\'altro dispositivo');
  });

  test('una vecchia copia non riporta in vita ciò che è stato cancellato su un altro dispositivo', async () => {
    const a = device();
    const b = device();
    const c = device();
    use(a);
    const g = saveGear(rod({ name: 'Venduta' }));
    const oldBackup = exportBackup();
    await syncNow();

    use(b);
    await syncNow();
    at('2026-11-19T11:00:00.000Z');
    deleteGear(g.client_id);
    await syncNow();
    assert.ok(cloud.row('gear_items', g.client_id).deleted_at);

    // Un terzo dispositivo, che quella canna non l'ha mai vista, riceve solo la lapide
    use(c);
    at('2026-11-19T11:05:00.000Z');
    const events = [];
    const off = bus.on('data:changed', (p) => events.push(p));
    await syncNow();
    off();
    assert.equal(listGear().length, 0);
    assert.ok(!events.some((p) => p?.kind === 'gear'), 'una lapide per un record mai visto non annuncia cambiamenti');

    // Poi ci unisce la copia fatta prima della cancellazione
    at('2026-11-19T11:10:00.000Z');
    importBackup(oldBackup, { mode: 'merge' });
    assert.equal(listGear().length, 0, 'la lapide è più recente della copia');
    const res = await syncNow();
    assert.equal(res.ok, true);
    assert.equal(listGear().length, 0);
    assert.equal(getQueue().length, 0);
    assert.ok(cloud.row('gear_items', g.client_id).deleted_at, 'il cloud resta com\'era');
  });

  test('cancellazioni sull\'altro dispositivo svuotano il locale', async () => {
    const a = device();
    const b = device();
    use(a);
    saveCatch(fish({ species: 'Uno' }));
    saveCatch(fish({ species: 'Due' }));
    await syncNow();
    use(b);
    await syncNow();
    at('2026-11-19T12:00:00.000Z');
    for (const c of listCatches()) deleteCatch(c.client_id);
    await syncNow();
    use(a);
    await syncNow();
    assert.equal(listCatches().length, 0);
  });

  for (const firstToSync of ['a', 'b']) {
    test(`modifica concorrente: vince la più recente (sincronizza prima ${firstToSync})`, async () => {
      const devs = { a: device(), b: device() };
      use(devs.a);
      const g = saveGear(rod({ name: 'Originale' }));
      await syncNow();
      use(devs.b);
      await syncNow();

      use(devs.a);
      at('2026-11-19T11:00:00.000Z');
      saveGear({ ...listGear()[0], name: 'Modifica di A' });
      use(devs.b);
      at('2026-11-19T11:05:00.000Z');
      saveGear({ ...listGear()[0], name: 'Modifica di B' });

      at('2026-11-19T11:10:00.000Z');
      const order = firstToSync === 'a' ? ['a', 'b', 'a'] : ['b', 'a', 'b', 'a'];
      for (const d of order) {
        use(devs[d]);
        const res = await syncNow();
        assert.equal(res.ok, true);
      }
      for (const d of ['a', 'b']) {
        use(devs[d]);
        assert.equal(listGear()[0].name, 'Modifica di B', `dispositivo ${d}`);
        assert.equal(getQueue().length, 0);
      }
      assert.equal(cloud.row('gear_items', g.client_id).name, 'Modifica di B');
    });
  }

  test('a parità di updated_at la scelta è la stessa su ogni dispositivo', async () => {
    const a = device();
    const b = device();
    use(a);
    const g = saveGear(rod({ client_id: 'g-pari', name: 'Base' }));
    await syncNow();
    use(b);
    await syncNow();
    at('2026-11-19T11:00:00.000Z');
    use(a);
    saveGear({ ...g, name: 'Alfa' });
    use(b);
    saveGear({ ...g, name: 'Beta' });
    for (const d of [a, b, a, b]) {
      use(d);
      await syncNow();
    }
    use(a);
    const nameA = listGear()[0].name;
    use(b);
    assert.equal(listGear()[0].name, nameA);
  });

  test('cursore del server: una modifica offline con orario vecchio arriva comunque', async () => {
    const a = device();
    const b = device();
    use(a);
    const g = saveGear(rod({ name: 'Prima' }));
    await syncNow();
    use(b);
    await syncNow();
    // B modifica offline alle 10:30 (orario del suo orologio) e resta scollegato
    at('2026-11-19T10:30:00.000Z');
    saveGear({ ...listGear()[0], name: 'Fatta offline' });
    // A sincronizza più tardi e vede record con updated_at successivo alla modifica di B:
    // un cursore basato su updated_at salterebbe la modifica di B
    use(a);
    at('2026-11-19T15:00:00.000Z');
    saveCatch(fish());
    await syncNow();
    await syncNow();
    assert.ok(cloud.log.filter((l) => l.op === 'pull' && l.table === 'gear_items').at(-1).since, 'i giri successivi scaricano solo le novità');
    // B torna online il giorno dopo
    use(b);
    at('2026-11-20T09:00:00.000Z');
    await syncNow();
    use(a);
    await syncNow();
    assert.equal(listGear().find((x) => x.client_id === g.client_id).name, 'Fatta offline');
  });

  test('cambio di utente: si riparte da uno scaricamento completo', async () => {
    use(device());
    saveGear(rod());
    await syncNow();
    setCloudAdapter(cloud.adapter({ id: 'user-2', email: 'altro@example.it' }), { autoSync: false });
    cloud.log = [];
    await syncNow();
    assert.ok(cloud.log.filter((l) => l.op === 'pull').every((l) => l.since === null));
    assert.equal(cloud.rows('gear_items', 'user-2').length, 1);
  });
});

describe('coda', () => {
  test('salvataggio durante l\'invio: la nuova versione non si perde', async () => {
    use(device());
    const g = saveGear(rod({ name: 'v1' }));
    await syncNow();
    at('2026-11-19T11:00:00.000Z');
    saveGear({ ...g, name: 'v2' });

    let newCatch;
    cloud.hooks.push = async (table) => {
      if (table !== 'gear_items') return;
      cloud.hooks.push = null;
      // l'utente salva mentre la richiesta è in viaggio
      at('2026-11-19T11:00:05.000Z');
      saveGear({ ...listGear()[0], name: 'v3' });
      newCatch = saveCatch(fish());
    };
    const res = await syncNow();
    assert.equal(res.ok, true);
    assert.equal(cloud.row('gear_items', g.client_id).name, 'v2', 'è partita la versione letta prima del salvataggio');
    const pendingGear = getQueue().filter((e) => e.kind === 'gear');
    assert.equal(pendingGear.length, 1, 'la versione v3 resta in coda');
    assert.equal(pendingGear[0].updated_at, listGear()[0].updated_at);
    assert.ok(cloud.row('catches', newCatch.client_id), 'la cattura salvata durante l\'invio parte nello stesso giro');

    await syncNow();
    assert.equal(cloud.row('gear_items', g.client_id).name, 'v3');
    assert.equal(getQueue().length, 0);
  });

  test('errore di rete a metà dell\'invio: si toglie solo ciò che è partito', async () => {
    use(device());
    const g = saveGear(rod());
    const c = saveCatch(fish());
    cloud.hooks.push = async (table) => {
      if (table === 'catches') throw new TypeError('Failed to fetch');
    };
    const warnings = [];
    const originalWarn = console.warn;
    console.warn = (...args) => warnings.push(args);
    let res;
    try {
      res = await syncNow();
    } finally {
      console.warn = originalWarn;
    }
    assert.equal(res.ok, false);
    assert.match(res.error, /controlla la connessione/);
    assert.equal(warnings.length, 1);
    const status = getSyncStatus();
    assert.equal(status.syncing, false);
    assert.equal(status.error, res.error);
    assert.equal(status.pending, 1);
    assert.deepEqual(getQueue().map((e) => e.client_id), [c.client_id]);
    assert.ok(cloud.row('gear_items', g.client_id));
    assert.equal(status.lastSyncAt, null);

    cloud.hooks.push = null;
    const again = await syncNow();
    assert.equal(again.ok, true);
    assert.equal(getQueue().length, 0);
    assert.equal(getSyncStatus().error, null);
    assert.ok(cloud.row('catches', c.client_id));
  });

  test('errore durante lo scaricamento: la coda resta intera', async () => {
    use(device());
    saveGear(rod());
    saveCatch(fish());
    cloud.hooks.pull = async (table) => {
      if (table === 'baits_inventory') throw new Error('timeout');
    };
    const originalWarn = console.warn;
    console.warn = () => {};
    try {
      assert.equal((await syncNow()).ok, false);
    } finally {
      console.warn = originalWarn;
    }
    assert.equal(getQueue().length, 2);
    assert.equal(cloud.log.filter((l) => l.op === 'push').length, 0);
  });

  test('un solo giro alla volta: la seconda chiamata riceve la stessa Promise', async () => {
    use(device());
    saveGear(rod());
    const p1 = syncNow();
    const p2 = syncNow();
    assert.equal(p1, p2);
    await p1;
    assert.equal(cloud.log.filter((l) => l.op === 'pull').length, SYNC_TABLES.length);
    assert.equal(cloud.log.filter((l) => l.op === 'push').length, 1);
    const p3 = syncNow();
    assert.notEqual(p3, p1, 'finito il giro se ne può avviare un altro');
    await p3;
  });

  test('sync:status annuncia inizio, fine e modifiche in attesa', async () => {
    use(device());
    const seen = [];
    const off = bus.on('sync:status', (s) => seen.push({ syncing: s.syncing, pending: s.pending }));
    try {
      saveGear(rod());
      await syncNow();
    } finally {
      off();
    }
    assert.deepEqual(seen[0], { syncing: false, pending: 1 });
    assert.ok(seen.some((s) => s.syncing === true));
    assert.deepEqual(seen.at(-1), { syncing: false, pending: 0 });
  });
});

describe('dati dimostrativi e dati dal cloud', () => {
  test('i record is_demo non vanno mai sul cloud e quelli v1 sul cloud non tornano', async () => {
    const dev = device();
    dev.storage.setJson('fi_gear_items_v1', [
      { client_id: 'gear-default-1', category: 'canna_surf', name: 'Demo', updated_at: '2026-09-01T10:00:00.000Z' },
      { client_id: 'gear-777', category: 'canna_surf', name: 'Vera', updated_at: '2026-10-01T10:00:00.000Z' }
    ]);
    // la v1 aveva caricato sul cloud anche i suoi dati dimostrativi
    cloud.seed('gear_items', { client_id: 'gear-default-2', category: 'canna_fondo', name: 'Demo v1 sul cloud', updated_at: '2026-09-01T10:00:00.000Z', created_at: '2026-09-01T10:00:00.000Z', deleted_at: null });
    use(dev);
    assert.equal(countDemoRecords(), 1);
    saveGear({ ...listGear().find((g) => g.client_id === 'gear-default-1'), name: 'Demo modificata' });

    await syncNow();
    const ids = cloud.rows('gear_items').map((r) => r.client_id).sort();
    assert.deepEqual(ids, ['gear-777', 'gear-default-2']);
    assert.ok(!listGear().some((g) => g.client_id === 'gear-default-2'));

    removeDemoRecords();
    await syncNow();
    assert.deepEqual(listGear().map((g) => g.client_id), ['gear-777']);
  });

  test('un demo finito in coda per qualsiasi motivo non parte e lascia la coda', async () => {
    const dev = device();
    dev.storage.setJson('fi_catches_v1', [
      { client_id: 'catch-default-1', species: 'Orata', weight_g: 1000, lat: 41.2, lng: 13.3, caught_at: '2026-11-01T10:00:00.000Z', updated_at: '2026-09-01T10:00:00.000Z' }
    ]);
    use(dev);
    dev.storage.setJson('fi2_sync_queue', [{ kind: 'catches', client_id: 'catch-default-1', updated_at: '2026-09-01T10:00:00.000Z', queued_at: '2026-11-19T10:00:00.000Z' }]);
    initStorage();
    assert.equal(getQueue().length, 1);
    const res = await syncNow();
    assert.equal(res.ok, true);
    assert.equal(res.pushed, 0);
    assert.equal(cloud.rows('catches').length, 0);
    assert.equal(getQueue().length, 0);
    assert.equal(listCatches()[0].is_demo, true);
  });

  test('weather_snapshot e campi in più dal cloud: ridotti alla forma prevista', async () => {
    cloud.seed('catches', {
      client_id: 'c-cloud',
      species: '<b>Orata</b>',
      weight_g: 800,
      length_cm: null,
      lat: 41.2,
      lng: 13.4,
      caught_at: '2026-11-17T06:00:00+00:00',
      released: false,
      weather_snapshot: { waveHeightM: 0.7, seaPhase: '<img src=x onerror=alert(1)>', light: 'dawn', score: '99', extra: 1 },
      notes: null,
      created_at: '2026-11-17T06:10:00+00:00',
      updated_at: '2026-11-17T06:10:00+00:00',
      deleted_at: null,
      is_demo: true,
      user_id: 'user-1',
      colonna_nuova: 'ignorata'
    });
    cloud.seed('catches', { client_id: 'c-rotta', species: 'Orata', weight_g: 800, lat: 999, lng: 13, caught_at: '2026-11-17T06:00:00Z', updated_at: '2026-11-17T06:10:00Z' });
    use(device());
    const warnings = [];
    const originalWarn = console.warn;
    console.warn = (...args) => warnings.push(args.join(' '));
    try {
      await syncNow();
    } finally {
      console.warn = originalWarn;
    }
    const list = listCatches();
    assert.equal(list.length, 1, 'il record con coordinate impossibili si scarta');
    assert.equal(warnings.length, 1);
    const c = list[0];
    assert.deepEqual(c.weather_snapshot, { waveHeightM: 0.7, light: 'dawn' });
    assert.equal(c.is_demo, false);
    assert.equal(c.caught_at, '2026-11-17T06:00:00.000Z');
    assert.ok(!('colonna_nuova' in c) && !('user_id' in c) && !('synced_at' in c));
    assert.equal(c.species, '<b>Orata</b>', 'il testo resta testo: l\'escape lo fa la vista');
    assert.equal(getQueue().length, 0, 'ciò che arriva dal cloud non torna indietro');
  });
});

// ---------------------------------------------------------------------------
// Adattatore Supabase con un SDK finto: verifica la traduzione verso le query,
// non il comportamento di un progetto reale.
// ---------------------------------------------------------------------------

class FakeQuery {
  constructor(db, table) {
    this.db = db;
    this.q = { table, filters: [], op: 'select' };
  }
  select(cols) {
    this.q.cols = cols;
    return this;
  }
  eq(col, v) {
    this.q.filters.push(['eq', col, v]);
    return this;
  }
  gt(col, v) {
    this.q.filters.push(['gt', col, v]);
    return this;
  }
  order(col, opts) {
    (this.q.order ||= []).push([col, opts?.ascending]);
    return this;
  }
  range(from, to) {
    this.q.range = [from, to];
    return this;
  }
  upsert(rows, opts) {
    Object.assign(this.q, { op: 'upsert', rows, opts });
    return this;
  }
  update(values) {
    Object.assign(this.q, { op: 'update', values });
    return this;
  }
  then(resolve, reject) {
    this.db.queries.push(this.q);
    if (this.db.error) return Promise.resolve({ data: null, error: this.db.error }).then(resolve, reject);
    let data = null;
    if (this.q.op === 'select') {
      const [from, to] = this.q.range || [0, Infinity];
      data = this.db.rows.slice(from, to + 1);
    }
    return Promise.resolve({ data, error: null }).then(resolve, reject);
  }
}

describe('adattatore Supabase (SDK finto)', () => {
  const db = { rows: [], queries: [], error: null, created: [] };
  const fakeSdk = {
    createClient(url, key, options) {
      db.created.push({ url, key, options });
      return {
        auth: {
          async getSession() {
            return { data: { session: { user: { id: 'u-9', email: 'a@b.it', other: 'x' } } }, error: null };
          },
          async signInWithPassword() {
            return { data: null, error: { message: 'Invalid login credentials', status: 400 } };
          },
          async signUp({ options }) {
            db.signUpOptions = options;
            return { data: { user: { id: 'u-10', email: 'n@b.it' }, session: null }, error: null };
          },
          async signOut() {
            return { error: null };
          },
          onAuthStateChange() {
            return { data: { subscription: { unsubscribe() {} } } };
          }
        },
        from: (table) => new FakeQuery(db, table)
      };
    }
  };

  let createSupabaseAdapter;
  before(async () => {
    globalThis.supabase = fakeSdk;
    ({ createSupabaseAdapter } = await import('../js/services/supabase.js'));
  });
  after(() => {
    delete globalThis.supabase;
  });
  beforeEach(() => {
    db.rows = [];
    db.queries = [];
    db.error = null;
  });

  test('senza cloud configurato restituisce null e non crea client', async () => {
    CLOUD.url = '';
    try {
      assert.equal(await createSupabaseAdapter(), null);
      assert.equal(db.created.length, 0);
    } finally {
      CLOUD.url = 'https://progettofinto.supabase.co';
    }
  });

  test('getUser, push con user_id e colonne ammesse, lapidi con update', async () => {
    const ad = await createSupabaseAdapter();
    assert.equal(db.created.length, 1);
    assert.equal(db.created[0].url, 'https://progettofinto.supabase.co');
    assert.deepEqual(await ad.getUser(), { id: 'u-9', email: 'a@b.it' });

    await ad.push('gear_items', [
      { client_id: 'g1', category: 'canna_surf', name: 'X', brand: null, length_m: null, min_cast_g: 1, max_cast_g: 2, optimal_cast_g: null, reel_model: null, main_line_mm: null, shock_leader_mm: null, status: 'pronta', notes: null, created_at: 't0', updated_at: 't1', deleted_at: null, estraneo: 'no' },
      { client_id: 'g2', created_at: 't0', updated_at: 't2', deleted_at: 't2' }
    ]);
    const up = db.queries.find((q) => q.op === 'upsert');
    assert.equal(up.table, 'gear_items');
    assert.deepEqual(up.opts, { onConflict: 'user_id,client_id' });
    assert.equal(up.rows.length, 1);
    assert.equal(up.rows[0].user_id, 'u-9');
    assert.equal(up.rows[0].deleted_at, null);
    assert.ok(!('estraneo' in up.rows[0]));
    const upd = db.queries.find((q) => q.op === 'update');
    assert.deepEqual(upd.values, { deleted_at: 't2', updated_at: 't2' });
    assert.deepEqual(upd.filters, [['eq', 'user_id', 'u-9'], ['eq', 'client_id', 'g2']]);
    await assert.rejects(() => ad.push('tabella_strana', []), /Tabella/);
  });

  test('pull: filtro su synced_at e pagine da 1000', async () => {
    const ad = await createSupabaseAdapter();
    db.rows = Array.from({ length: 1500 }, (_, i) => ({ client_id: `c${i}` }));
    const rows = await ad.pull('catches', '2026-11-19T10:00:00.000Z');
    assert.equal(rows.length, 1500);
    const selects = db.queries.filter((q) => q.op === 'select');
    assert.equal(selects.length, 2);
    assert.deepEqual(selects[0].range, [0, 999]);
    assert.deepEqual(selects[1].range, [1000, 1999]);
    assert.ok(selects[0].filters.some(([op, col, v]) => op === 'gt' && col === 'synced_at' && v === '2026-11-19T10:00:00.000Z'));
    assert.ok(selects[0].cols.includes('synced_at') && selects[0].cols.includes('weather_snapshot'));
    db.queries = [];
    await ad.pull('catches', null);
    assert.ok(!db.queries[0].filters.some(([op]) => op === 'gt'));
  });

  test('errori in italiano', async () => {
    const ad = await createSupabaseAdapter();
    await assert.rejects(() => ad.signIn('a@b.it', 'sbagliata'), /Email o password non corretti/);
    await assert.rejects(() => ad.signIn('', 'x'), /Scrivi la tua email/);
    const res = await ad.signUp('n@b.it', 'password1', 'Matteo');
    assert.deepEqual(res, { user: { id: 'u-10', email: 'n@b.it' }, needsConfirmation: true });
    assert.equal(db.signUpOptions.data.display_name, 'Matteo');
    db.error = { message: 'permission denied for table catches', code: '42501' };
    await assert.rejects(() => ad.pull('catches', null), (e) => /cloud/.test(e.message) && e.cause === db.error);
  });
});
