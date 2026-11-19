/**
 * Sincronizzazione con il cloud tramite un adattatore iniettabile.
 *
 * Adattatore: {
 *   getUser(): Promise<{ id, email } | null>,
 *   pull(table, sinceIso | null): Promise<record[]>,   // lapidi comprese
 *   push(table, records): Promise<void>                 // upsert per client_id
 * }
 * I record scaricati possono avere synced_at, l'ora del server dell'ultima scrittura: serve come
 * cursore per scaricare solo le novità. Non si usa updated_at come cursore perché è l'ora del
 * dispositivo che ha modificato: una modifica fatta offline e inviata giorni dopo ha un
 * updated_at vecchio e andrebbe persa. Senza synced_at si riscarica tutto a ogni giro.
 *
 * Un giro: scarica e fonde tabella per tabella (vince updated_at più recente, le lapidi valgono
 * come versioni), poi invia ciò che è in coda leggendo la versione attuale di ogni record, poi
 * toglie dalla coda solo le versioni inviate davvero. I record is_demo non si inviano mai.
 */

import { bus } from '../state.js';
import { isCloudConfigured } from '../config.js';
import {
  KINDS,
  TABLE_OF,
  StorageError,
  getAllRecords,
  getQueue,
  queueLength,
  updateQueue,
  getSyncMeta,
  commitChanges,
  normalizeRecord,
  compareVersions,
  withQueued,
  withoutQueued,
  isV1DemoId,
  nowIso
} from './storage.js';

export const SYNC_TABLES = Object.freeze(KINDS.map((k) => TABLE_OF[k]));

const PUSH_CHUNK = 200;
// si riscarica un minuto prima del cursore: copre le scritture del server arrivate fuori ordine
const CURSOR_OVERLAP_MS = 60 * 1000;
const DEFAULT_DEBOUNCE_MS = 3000;
const NETWORK_MESSAGE = 'Sincronizzazione non riuscita: controlla la connessione e riprova.';

let adapter = null;
let running = null;
let syncing = false;
let lastError = null;
let auto = null;

function isOnline() {
  const nav = globalThis.navigator;
  return !(nav && nav.onLine === false);
}

export function getSyncStatus() {
  let pending = 0;
  let lastSyncAt = null;
  try {
    pending = queueLength();
    lastSyncAt = getSyncMeta()?.lastSyncAt ?? null;
  } catch {
    // memoria non leggibile: stato vuoto
  }
  return {
    enabled: isCloudConfigured() && adapter !== null,
    online: isOnline(),
    pending,
    lastSyncAt,
    syncing,
    error: lastError
  };
}

function emitStatus() {
  bus.emit('sync:status', getSyncStatus());
}

// ogni scrittura locale cambia il numero di modifiche in attesa
bus.on('data:changed', (payload) => {
  emitStatus();
  if (payload?.source !== 'sync') scheduleAuto();
});

function isAdapter(a) {
  return a && typeof a.getUser === 'function' && typeof a.pull === 'function' && typeof a.push === 'function';
}

/**
 * Imposta (o toglie, con null) l'adattatore cloud.
 * Con autoSync (predefinito) sincronizza subito, dopo ogni modifica locale (con un ritardo di
 * debounceMs), al ritorno della rete e a ogni 'auth:changed' sul bus.
 */
export function setCloudAdapter(next, { autoSync = true, debounceMs = DEFAULT_DEBOUNCE_MS } = {}) {
  if (next != null && !isAdapter(next)) throw new TypeError('Adattatore cloud non valido: servono getUser, pull e push.');
  stopAuto();
  adapter = next || null;
  lastError = null;
  if (adapter && autoSync) startAuto(debounceMs);
  emitStatus();
}

function startAuto(delayMs) {
  auto = { delayMs, timer: null, offs: [] };
  auto.offs.push(bus.on('auth:changed', () => scheduleAuto(0)));
  if (typeof globalThis.addEventListener === 'function') {
    const onOnline = () => scheduleAuto(0);
    globalThis.addEventListener('online', onOnline);
    globalThis.addEventListener('offline', emitStatus);
    auto.offs.push(() => {
      globalThis.removeEventListener('online', onOnline);
      globalThis.removeEventListener('offline', emitStatus);
    });
  }
  scheduleAuto(0);
}

function stopAuto() {
  if (!auto) return;
  clearTimeout(auto.timer);
  for (const off of auto.offs) off();
  auto = null;
}

function scheduleAuto(delayMs) {
  if (!auto) return;
  clearTimeout(auto.timer);
  auto.timer = setTimeout(() => {
    if (auto) auto.timer = null;
    syncNow();
  }, delayMs ?? auto.delayMs);
  auto.timer?.unref?.();
}

/**
 * Avvia un giro di sincronizzazione; se è già in corso restituisce la stessa Promise.
 * Non rifiuta mai: → { ok, pulled, pushed, skipped?: 'disabled'|'offline'|'signed-out', error? }.
 * Senza cloud configurato o senza adattatore è un no-op.
 */
export function syncNow() {
  if (running) return running;
  running = runSync().finally(() => {
    running = null;
  });
  return running;
}

async function runSync() {
  const cloud = adapter;
  const result = { ok: false, pulled: 0, pushed: 0 };
  if (!cloud || !isCloudConfigured()) return { ...result, skipped: 'disabled' };
  if (!isOnline()) {
    emitStatus();
    return { ...result, skipped: 'offline' };
  }

  syncing = true;
  lastError = null;
  emitStatus();
  try {
    const user = await cloud.getUser();
    if (!user || !user.id) return { ...result, skipped: 'signed-out' };

    let meta = getSyncMeta();
    // altro utente (o primo giro): si riparte da uno scaricamento completo
    if (!meta || meta.userId !== user.id) meta = { userId: user.id, lastSyncAt: null, cursors: {} };

    for (const kind of KINDS) {
      const table = TABLE_OF[kind];
      const cursor = meta.cursors?.[table] ?? null;
      const since = cursor ? new Date(Date.parse(cursor) - CURSOR_OVERLAP_MS).toISOString() : null;
      const remote = await cloud.pull(table, since);
      if (!Array.isArray(remote)) throw new Error(`Risposta non valida dal cloud per ${table}.`);
      meta = { ...meta, cursors: { ...meta.cursors, [table]: maxSyncedAt(remote, cursor) } };
      result.pulled += mergeRemote(kind, remote, { full: since === null, meta });
    }

    for (const kind of KINDS) result.pushed += await pushKind(cloud, kind);

    commitChanges({ syncMeta: { ...meta, lastSyncAt: nowIso() } });
    result.ok = true;
    return result;
  } catch (err) {
    lastError = err instanceof StorageError ? err.message : NETWORK_MESSAGE;
    if (!(err instanceof StorageError)) console.warn('Sincronizzazione non riuscita:', err);
    return { ...result, ok: false, error: lastError };
  } finally {
    syncing = false;
    emitStatus();
  }
}

function maxSyncedAt(records, previous) {
  let max = Date.parse(previous);
  for (const r of records) {
    const t = Date.parse(r?.synced_at);
    if (Number.isFinite(t) && !(t <= max)) max = t;
  }
  return Number.isFinite(max) ? new Date(max).toISOString() : null;
}

const isQueued = (queue, kind, record) =>
  queue.some((e) => e.kind === kind && e.client_id === record.client_id && e.updated_at === record.updated_at);

/**
 * Fonde i record scaricati con quelli locali e salva tutto insieme (record, coda, cursore).
 * full: lo scaricamento è completo, quindi ciò che manca sul cloud va inviato (un cloud vuoto
 * non svuota il locale). Restituisce quanti record locali sono cambiati.
 */
function mergeRemote(kind, remote, { full, meta }) {
  const byId = new Map(getAllRecords(kind).map((r) => [r.client_id, r]));
  let queue = getQueue();
  const seen = new Set();
  let applied = 0;
  let tombstones = 0;

  for (const raw of remote) {
    const id = raw?.client_id;
    // dati dimostrativi della v1 finiti sul cloud per errore: non si importano
    if (typeof id !== 'string' || isV1DemoId(id)) continue;
    let rec;
    try {
      rec = normalizeRecord(kind, raw, { keepTimestamps: true });
    } catch (err) {
      console.warn(`Record ${id} di ${TABLE_OF[kind]} scartato: ${err.message}`);
      continue;
    }
    seen.add(id);
    const cur = byId.get(id);
    if (!cur) {
      byId.set(id, rec);
      // Anche la lapide di un record mai visto qui si conserva: se più tardi si unisce una vecchia
      // copia che lo contiene ancora, senza lapide tornerebbe in vita solo su questo dispositivo
      // (il cloud rifiuta la versione vecchia). Non cambia nulla di visibile, quindi non si annuncia.
      if (rec.deleted_at) tombstones++;
      else applied++;
      continue;
    }
    if (cur.is_demo) continue;
    const cmp = compareVersions(rec, cur);
    if (cmp > 0) {
      byId.set(id, rec);
      queue = withoutQueued(queue, kind, id);
      applied++;
    } else if (cmp < 0) {
      if (!isQueued(queue, kind, cur)) queue = withQueued(queue, kind, cur);
    } else {
      // stessa versione: il cloud ce l'ha già
      queue = withoutQueued(queue, kind, id, cur.updated_at);
    }
  }

  if (full) {
    for (const r of byId.values()) {
      if (!r.is_demo && !seen.has(r.client_id) && !isQueued(queue, kind, r)) queue = withQueued(queue, kind, r);
    }
  }

  const changes = { queue, syncMeta: meta };
  if (applied || tombstones) changes[kind] = [...byId.values()];
  commitChanges(changes, { kind: applied ? kind : null, source: 'sync' });
  return applied;
}

/** Forma inviata al cloud: is_demo non è una colonna. */
function toCloud(record) {
  const { is_demo, ...rest } = record;
  return rest;
}

async function pushKind(cloud, kind) {
  const entries = getQueue().filter((e) => e.kind === kind);
  if (!entries.length) return 0;
  const current = new Map(getAllRecords(kind).map((r) => [r.client_id, r]));
  const batch = [];
  const orphans = new Set();
  for (const e of entries) {
    const r = current.get(e.client_id);
    if (!r || r.is_demo) orphans.add(e.client_id);
    else batch.push(r);
  }
  if (orphans.size) updateQueue((q) => q.filter((e) => !(e.kind === kind && orphans.has(e.client_id))));

  let pushed = 0;
  for (let i = 0; i < batch.length; i += PUSH_CHUNK) {
    const chunk = batch.slice(i, i + PUSH_CHUNK);
    await cloud.push(TABLE_OF[kind], chunk.map(toCloud));
    // si rilegge la coda attuale: una modifica salvata durante l'invio ha una versione nuova e resta
    const sent = new Map(chunk.map((r) => [r.client_id, r.updated_at]));
    updateQueue((q) => q.filter((e) => !(e.kind === kind && sent.get(e.client_id) === e.updated_at)));
    pushed += chunk.length;
    emitStatus();
  }
  return pushed;
}
