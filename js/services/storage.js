/**
 * Persistenza locale versionata (localStorage, chiavi fi2_).
 *
 * - Ogni scrittura è tutto o niente: se il browser rifiuta, si lancia StorageError, le chiavi già
 *   scritte si ripristinano e la cache in memoria resta com'era.
 * - Le cancellazioni lasciano una lapide minima { client_id, deleted_at, ... } che serve alla
 *   sincronizzazione; le list*() non la restituiscono.
 * - Un dato assente vale null: nessun valore di ripiego.
 *
 * Oltre alle funzioni del contratto (docs/ARCHITETTURA.md §5) esporta alcune funzioni di basso
 * livello (getAllRecords, commitChanges, normalizeRecord, ...) usate da backup.js e sync.js.
 */

import { bus } from '../state.js';
import { PREDEFINED_SPOTS } from '../core/spots.js';
import { speciesIdFor } from '../core/species.js';

export const KEYS = Object.freeze({
  meta: 'fi2_meta',
  prefs: 'fi2_prefs',
  spots: 'fi2_spots',
  gear: 'fi2_gear',
  baits: 'fi2_baits',
  catches: 'fi2_catches',
  queue: 'fi2_sync_queue',
  syncMeta: 'fi2_sync_meta'
});

const V1_KEYS = Object.freeze({
  initialized: 'fi_initialized_v1',
  prefs: 'fi_prefs_v1',
  spots: 'fi_custom_locations_v1',
  gear: 'fi_gear_items_v1',
  baits: 'fi_baits_inventory_v1',
  catches: 'fi_catches_v1',
  queue: 'fi_sync_queue_v1',
  lastSync: 'fi_last_sync_at_v1'
});

const V1_WEATHER_CACHE_PREFIX = 'fi_weather_cache_v1_';
// Previsioni salvate da weather-api.js (stesso prefisso di CACHE.prefix in config.js)
const FORECAST_CACHE_PREFIX = 'fi2_fc_';

/** Collezioni di record dell'utente e tabella cloud corrispondente. */
export const KINDS = Object.freeze(['spots', 'gear', 'baits', 'catches']);
export const TABLE_OF = Object.freeze({
  spots: 'custom_locations',
  gear: 'gear_items',
  baits: 'baits_inventory',
  catches: 'catches'
});
export const KIND_OF_TABLE = Object.freeze(Object.fromEntries(KINDS.map((k) => [TABLE_OF[k], k])));

export const GEAR_CATEGORIES = Object.freeze(['canna_surf', 'canna_fondo', 'mulinello_filo', 'accessorio']);
export const GEAR_STATUSES = Object.freeze(['pronta', 'riserva', 'manutenzione']);
export const BAIT_CATEGORIES = Object.freeze(['anellide', 'sipunculide', 'mollusco', 'crostaceo', 'pesce', 'altro']);
export const WATER_CONDITIONS = Object.freeze(['tutte', 'calmo_poco_mosso', 'mosso_scaduta']);
export const THEMES = Object.freeze(['auto', 'dark', 'light']);
export const SEA_PHASES = Object.freeze(['scaduta', 'montante', 'stabile']);
export const LIGHT_PHASES = Object.freeze(['night', 'dawn', 'day', 'dusk']);

export const DEFAULT_PREFS = Object.freeze({
  spotId: 'salto-di-fondi',
  speciesId: 'orata',
  theme: 'auto',
  onboarded: false
});

const LIMITS = Object.freeze({ name: 80, text: 120, notes: 1000, id: 100, tag: 40, tags: 20 });
const DAY_MS = 24 * 60 * 60 * 1000;
const EPOCH_ISO = new Date(0).toISOString();
const V1_DEMO_PREFIXES = ['gear-default-', 'bait-default-', 'catch-default-'];
const PREDEFINED_IDS = new Set(PREDEFINED_SPOTS.map((s) => s.id));
const CLIENT_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_.:-]*$/;

// ---------------------------------------------------------------------------
// Errori
// ---------------------------------------------------------------------------

const STORAGE_MESSAGES = {
  quota: 'Memoria del dispositivo piena: i dati non sono stati salvati. Esporta un backup ed elimina qualcosa che non ti serve.',
  unavailable: 'Il browser non permette di salvare su questo dispositivo: i dati non sono stati salvati.'
};

export class StorageError extends Error {
  constructor(code, cause) {
    const c = code === 'quota' ? 'quota' : 'unavailable';
    super(STORAGE_MESSAGES[c]);
    this.name = 'StorageError';
    this.code = c;
    if (cause) this.cause = cause;
  }
}

export class ValidationError extends Error {
  constructor(field, message) {
    super(message);
    this.name = 'ValidationError';
    this.field = field;
  }
}

// ---------------------------------------------------------------------------
// Orologio (sostituibile nei test)
// ---------------------------------------------------------------------------

let clock = () => Date.now();

/** Solo per i test: sostituisce l'orologio. Senza funzione torna a Date.now. */
export function setClock(fn) {
  clock = typeof fn === 'function' ? fn : () => Date.now();
}

export const nowMs = () => clock();
export const nowIso = () => new Date(clock()).toISOString();

/** Versione per una nuova scrittura: mai precedente a quella che sostituisce, anche se l'orologio torna indietro. */
export function nextVersion(prevIso) {
  const now = clock();
  const prev = Date.parse(prevIso);
  return new Date(Number.isFinite(prev) && prev >= now ? prev + 1 : now).toISOString();
}

export function newClientId() {
  try {
    if (typeof globalThis.crypto?.randomUUID === 'function') return globalThis.crypto.randomUUID();
  } catch {
    // contesto non sicuro (http): si usa il ripiego
  }
  const rnd = () => Math.random().toString(36).slice(2, 10);
  return `${Date.now().toString(36)}-${rnd()}${rnd()}`;
}

export function isV1DemoId(id) {
  return typeof id === 'string' && V1_DEMO_PREFIXES.some((p) => id.startsWith(p));
}

export function isPredefinedSpotId(id) {
  return PREDEFINED_IDS.has(id);
}

// ---------------------------------------------------------------------------
// Accesso a localStorage
// ---------------------------------------------------------------------------

function getStore() {
  try {
    const s = globalThis.localStorage;
    return s && typeof s.getItem === 'function' && typeof s.setItem === 'function' ? s : null;
  } catch {
    return null;
  }
}

function canRead(store) {
  try {
    store.getItem(KEYS.meta);
    return true;
  } catch {
    return false;
  }
}

function readRaw(store, key) {
  try {
    return store.getItem(key);
  } catch {
    return null;
  }
}

function readJson(store, key, fallback) {
  const raw = readRaw(store, key);
  if (raw === null || raw === undefined) return fallback;
  try {
    return JSON.parse(raw);
  } catch {
    console.warn(`Dati illeggibili nella chiave ${key}: ignorati.`);
    return fallback;
  }
}

function isQuotaError(err) {
  return (
    err?.name === 'QuotaExceededError' ||
    err?.name === 'NS_ERROR_DOM_QUOTA_REACHED' ||
    err?.code === 22 ||
    err?.code === 1014
  );
}

/** Chiave non ancora inizializzabile (inizializzazione fallita): le scritture si rifiutano. */
let blockedCode = null;

/**
 * Scrive più chiavi come un'unica operazione: se una fallisce si ripristinano le precedenti.
 * value undefined = rimuovi la chiave.
 */
/** Scrive tutte le chiavi o nessuna: al primo errore rimette com'erano quelle già scritte. */
function writeAll(store, prepared) {
  const done = [];
  try {
    for (const [key, text] of prepared) {
      done.push([key, store.getItem(key)]);
      if (text === null) store.removeItem(key);
      else store.setItem(key, text);
    }
  } catch (err) {
    for (const [key, prev] of done.reverse()) {
      try {
        if (prev === null) store.removeItem(key);
        else store.setItem(key, prev);
      } catch {
        // il ripristino libera spazio o riscrive ciò che c'era: non dovrebbe fallire
      }
    }
    throw err;
  }
}

/** Elimina le previsioni salvate (si riscaricano). Restituisce quante chiavi ha tolto. */
function dropForecastCache(store) {
  const stale = [];
  try {
    for (let i = 0; i < store.length; i++) {
      const k = store.key(i);
      if (k && k.startsWith(FORECAST_CACHE_PREFIX)) stale.push(k);
    }
    for (const k of stale) store.removeItem(k);
  } catch {
    return 0;
  }
  return stale.length;
}

function persist(entries, { force = false } = {}) {
  if (blockedCode && !force) throw new StorageError(blockedCode);
  const store = getStore();
  if (!store) throw new StorageError('unavailable');
  const prepared = entries.map(([key, value]) => [key, value === undefined ? null : JSON.stringify(value)]);
  try {
    writeAll(store, prepared);
  } catch (err) {
    // Spazio esaurito: le previsioni salvate si possono riscaricare, i dati dell'utente no.
    // Si liberano quelle e si riprova una volta.
    if (isQuotaError(err) && dropForecastCache(store) > 0) {
      try {
        writeAll(store, prepared);
        return;
      } catch (err2) {
        throw new StorageError(isQuotaError(err2) ? 'quota' : 'unavailable', err2);
      }
    }
    throw new StorageError(isQuotaError(err) ? 'quota' : 'unavailable', err);
  }
}

// ---------------------------------------------------------------------------
// Cache in memoria
// ---------------------------------------------------------------------------

const STATE_KEYS = Object.freeze({
  prefs: KEYS.prefs,
  spots: KEYS.spots,
  gear: KEYS.gear,
  baits: KEYS.baits,
  catches: KEYS.catches,
  queue: KEYS.queue,
  syncMeta: KEYS.syncMeta
});

let cache = null;

const clone = (v) => (v === undefined ? undefined : typeof structuredClone === 'function' ? structuredClone(v) : JSON.parse(JSON.stringify(v)));

function emptyState() {
  return { prefs: { ...DEFAULT_PREFS }, spots: [], gear: [], baits: [], catches: [], queue: [], syncMeta: null };
}

function sanitizeStored(list) {
  if (!Array.isArray(list)) return [];
  const byId = new Map();
  for (const r of list) {
    if (r && typeof r === 'object' && typeof r.client_id === 'string' && r.client_id) byId.set(r.client_id, r);
  }
  return [...byId.values()];
}

function sanitizeQueue(list) {
  if (!Array.isArray(list)) return [];
  return list.filter((e) => e && KINDS.includes(e.kind) && typeof e.client_id === 'string');
}

function sanitizeSyncMeta(meta) {
  return meta && typeof meta === 'object' && !Array.isArray(meta) ? meta : null;
}

function loadState(store) {
  const s = emptyState();
  s.prefs = normalizePrefs(readJson(store, KEYS.prefs, null));
  for (const kind of KINDS) s[kind] = sanitizeStored(readJson(store, STATE_KEYS[kind], []));
  s.queue = sanitizeQueue(readJson(store, KEYS.queue, []));
  s.syncMeta = sanitizeSyncMeta(readJson(store, KEYS.syncMeta, null));
  return s;
}

function ensureLoaded() {
  if (!cache) {
    const store = getStore();
    cache = store && canRead(store) ? loadState(store) : emptyState();
  }
  return cache;
}

function emitKinds(kind, source) {
  const kinds = Array.isArray(kind) ? kind : kind ? [kind] : [];
  for (const k of kinds) bus.emit('data:changed', source ? { kind: k, source } : { kind: k });
}

/**
 * Scrive insieme più parti dello stato (prefs, spots, gear, baits, catches, queue, syncMeta)
 * e aggiorna la cache solo se il browser ha accettato. Uso interno di backup.js e sync.js.
 * kind: tipo (o elenco di tipi) da annunciare con data:changed; source facoltativo nel payload.
 */
export function commitChanges(changes, { kind = null, source = null } = {}) {
  ensureLoaded();
  const names = Object.keys(changes);
  for (const name of names) {
    if (!(name in STATE_KEYS)) throw new Error(`Parte dello stato sconosciuta: ${name}`);
  }
  persist(names.map((name) => [STATE_KEYS[name], changes[name]]));
  for (const name of names) cache[name] = clone(changes[name]);
  emitKinds(kind, source);
}

// ---------------------------------------------------------------------------
// Lettura e validazione dei campi
// ---------------------------------------------------------------------------

const isBlank = (v) => v === undefined || v === null || (typeof v === 'string' && v.trim() === '');
const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

function readText(data, field, max) {
  const v = data[field];
  if (isBlank(v)) return null;
  if (typeof v !== 'string' && typeof v !== 'number') throw new ValidationError(field, 'Valore non valido.');
  return String(v).trim().slice(0, max);
}

function readName(data, field, emptyMsg, longMsg) {
  const v = data[field];
  if (isBlank(v) || (typeof v !== 'string' && typeof v !== 'number')) throw new ValidationError(field, emptyMsg);
  const s = String(v).replace(/\s+/g, ' ').trim();
  if (s.length > LIMITS.name) throw new ValidationError(field, longMsg);
  return s;
}

const NUMBER_RE = /^[-+]?(\d+\.?\d*|\.\d+)([eE][-+]?\d+)?$/;

/** Numero da form o da JSON: accetta la virgola decimale. Assente = null. */
function readNumber(value, field, message) {
  if (isBlank(value)) return null;
  let n = Number.NaN;
  if (typeof value === 'number') n = value;
  else if (typeof value === 'string') {
    const t = value.trim().replace(',', '.');
    if (NUMBER_RE.test(t)) n = Number(t);
  }
  if (!Number.isFinite(n)) throw new ValidationError(field, message);
  return n;
}

function readCoordinate(data, field, min, max, missingMsg, rangeMsg) {
  const n = readNumber(data[field], field, rangeMsg);
  if (n === null) throw new ValidationError(field, missingMsg);
  if (n < min || n > max) throw new ValidationError(field, rangeMsg);
  return Math.round(n * 1e6) / 1e6;
}

const TRUE_WORDS = new Set(['true', 'on', '1', 'si', 'sì', 'yes']);
const FALSE_WORDS = new Set(['false', 'off', '0', 'no']);

function readBool(v, fallback) {
  if (v === true || v === false) return v;
  if (v === 1) return true;
  if (v === 0) return false;
  if (typeof v === 'string') {
    const t = v.trim().toLowerCase();
    if (TRUE_WORDS.has(t)) return true;
    if (FALSE_WORDS.has(t)) return false;
  }
  return fallback;
}

/** Istante valido in ISO UTC, oppure null. */
export function toIso(v) {
  let ms = Number.NaN;
  if (v instanceof Date) ms = v.getTime();
  else if (typeof v === 'number') ms = v;
  else if (typeof v === 'string' && v.trim()) ms = Date.parse(v.trim());
  if (!Number.isFinite(ms) || Math.abs(ms) > 8.64e15) return null;
  return new Date(ms).toISOString();
}

function readClientId(v, generate) {
  if (isBlank(v)) {
    if (generate) return newClientId();
    throw new ValidationError('client_id', 'Identificativo del record mancante.');
  }
  if (typeof v !== 'string' && typeof v !== 'number') throw new ValidationError('client_id', 'Identificativo del record non valido.');
  const s = String(v).trim();
  if (s.length > LIMITS.id || !CLIENT_ID_RE.test(s)) throw new ValidationError('client_id', 'Identificativo del record non valido.');
  return s;
}

function readTags(v, field) {
  if (isBlank(v)) return [];
  let items;
  if (Array.isArray(v)) items = v;
  else if (typeof v === 'string') items = v.split(',');
  else throw new ValidationError(field, 'Elenco non valido.');
  const out = [];
  for (const item of items) {
    if (typeof item !== 'string') continue;
    const t = item.trim().slice(0, LIMITS.tag);
    if (t && !out.includes(t)) out.push(t);
    if (out.length >= LIMITS.tags) break;
  }
  return out;
}

function readEnum(data, field, allowed, fallback, message) {
  const v = data[field];
  if (isBlank(v)) {
    if (fallback === undefined) throw new ValidationError(field, message);
    return fallback;
  }
  if (!allowed.includes(v)) throw new ValidationError(field, message);
  return v;
}

// ---------------------------------------------------------------------------
// Forme dei record
// ---------------------------------------------------------------------------

const SNAPSHOT_NUMBERS = [
  ['waveHeightM', 0, 30],
  ['wavePeriodS', 0, 40],
  ['windSpeedKmh', 0, 400],
  ['windDirDeg', 0, 360],
  ['pressureHpa', 850, 1100],
  ['seaTempC', -5, 45]
];

/**
 * Riduce un weather_snapshot alla forma Snapshot: solo le chiavi previste, numeri finiti in un
 * intervallo sensato, seaPhase e light solo tra i valori ammessi. Tutto il resto si scarta.
 */
export function normalizeSnapshot(raw) {
  const out = {};
  if (!isPlainObject(raw)) return out;
  const num = (key, min, max) => {
    if (!Object.hasOwn(raw, key)) return;
    const v = raw[key];
    if (typeof v === 'number' && Number.isFinite(v) && v >= min && v <= max) out[key] = v;
  };
  for (const [key, min, max] of SNAPSHOT_NUMBERS) num(key, min, max);
  if (Object.hasOwn(raw, 'seaPhase') && SEA_PHASES.includes(raw.seaPhase)) out.seaPhase = raw.seaPhase;
  if (Object.hasOwn(raw, 'light') && LIGHT_PHASES.includes(raw.light)) out.light = raw.light;
  num('score', 0, 100);
  return out;
}

const ORIENTATION_MSG = "L'orientamento della spiaggia deve essere un numero intero da 0 a 359.";

function spotFields(d) {
  const name = readName(d, 'name', 'Scrivi il nome dello spot.', 'Il nome dello spot può avere al massimo 80 caratteri.');
  const lat = readCoordinate(d, 'lat', -90, 90, 'Indica la latitudine dello spot.', 'La latitudine deve essere un numero tra -90 e 90.');
  const lng = readCoordinate(d, 'lng', -180, 180, 'Indica la longitudine dello spot.', 'La longitudine deve essere un numero tra -180 e 180.');
  const deg = readNumber(d.coast_orientation_deg, 'coast_orientation_deg', ORIENTATION_MSG);
  if (deg === null) throw new ValidationError('coast_orientation_deg', 'Indica verso dove guarda la spiaggia, in gradi da 0 a 359.');
  if (!Number.isInteger(deg) || deg < 0 || deg > 359) throw new ValidationError('coast_orientation_deg', ORIENTATION_MSG);
  return {
    name,
    region: readText(d, 'region', LIMITS.name),
    lat,
    lng,
    coast_orientation_deg: deg,
    seabed_type: readText(d, 'seabed_type', LIMITS.text),
    notes: readText(d, 'notes', LIMITS.notes)
  };
}

const GEAR_NAME_MSG = {
  canna_surf: 'Scrivi il nome della canna.',
  canna_fondo: 'Scrivi il nome della canna.',
  mulinello_filo: 'Scrivi il nome del mulinello.',
  accessorio: "Scrivi il nome dell'accessorio."
};

const GEAR_NUMBERS = [
  ['length_m', 'La lunghezza deve essere un numero.', 'La lunghezza non può essere negativa.'],
  ['min_cast_g', 'Il carico minimo deve essere un numero.', 'Il carico minimo non può essere negativo.'],
  ['max_cast_g', 'Il carico massimo deve essere un numero.', 'Il carico massimo non può essere negativo.'],
  ['optimal_cast_g', 'Il carico ideale deve essere un numero.', 'Il carico ideale non può essere negativo.'],
  ['main_line_mm', 'Il diametro del filo deve essere un numero.', 'Il diametro del filo non può essere negativo.'],
  ['shock_leader_mm', 'Il diametro dello shock leader deve essere un numero.', 'Il diametro dello shock leader non può essere negativo.']
];

function gearFields(d) {
  const category = readEnum(d, 'category', GEAR_CATEGORIES, undefined, "Scegli il tipo di attrezzatura.");
  const name = readName(d, 'name', GEAR_NAME_MSG[category], 'Il nome può avere al massimo 80 caratteri.');
  const nums = {};
  for (const [field, nanMsg, negMsg] of GEAR_NUMBERS) {
    const n = readNumber(d[field], field, nanMsg);
    if (n !== null && n < 0) throw new ValidationError(field, negMsg);
    nums[field] = n;
  }
  if (nums.min_cast_g !== null && nums.max_cast_g !== null && nums.max_cast_g < nums.min_cast_g) {
    throw new ValidationError('max_cast_g', 'Il carico massimo non può essere più basso del minimo.');
  }
  const status = readEnum(d, 'status', GEAR_STATUSES, 'pronta', "Stato dell'attrezzatura non valido.");
  return {
    category,
    name,
    brand: readText(d, 'brand', LIMITS.name),
    length_m: nums.length_m,
    min_cast_g: nums.min_cast_g,
    max_cast_g: nums.max_cast_g,
    optimal_cast_g: nums.optimal_cast_g,
    reel_model: readText(d, 'reel_model', LIMITS.name),
    main_line_mm: nums.main_line_mm,
    shock_leader_mm: nums.shock_leader_mm,
    status,
    notes: readText(d, 'notes', LIMITS.notes)
  };
}

const QUANTITY_MSG = 'La quantità deve essere un numero intero da 0 a 999.';

function baitFields(d) {
  const name = readName(d, 'name', "Scrivi il nome dell'esca.", "Il nome dell'esca può avere al massimo 80 caratteri.");
  const category = readEnum(d, 'category', BAIT_CATEGORIES, 'altro', 'Tipo di esca non valido.');
  const quantity = readNumber(d.quantity, 'quantity', QUANTITY_MSG);
  if (quantity === null) throw new ValidationError('quantity', 'Indica quante ne hai, anche 0.');
  if (!Number.isInteger(quantity) || quantity < 0 || quantity > 999) throw new ValidationError('quantity', QUANTITY_MSG);
  return {
    name,
    category,
    quantity,
    available: readBool(d.available, quantity > 0),
    target_species: readTags(d.target_species, 'target_species'),
    water_condition: readEnum(d, 'water_condition', WATER_CONDITIONS, 'tutte', 'Condizione del mare non valida.'),
    notes: readText(d, 'notes', LIMITS.notes)
  };
}

function catchFields(d, now) {
  const species = readName(d, 'species', 'Scrivi la specie catturata.', 'Il nome della specie può avere al massimo 80 caratteri.');

  let weight = readNumber(d.weight_g, 'weight_g', 'Il peso deve essere un numero, in grammi.');
  if (weight !== null) {
    if (weight <= 0) throw new ValidationError('weight_g', 'Il peso deve essere maggiore di zero.');
    if (weight > 200000) throw new ValidationError('weight_g', 'Il peso sembra troppo alto: controlla il valore in grammi.');
    weight = Math.round(weight);
    if (weight < 1) throw new ValidationError('weight_g', 'Il peso deve essere almeno 1 g.');
  }
  let length = readNumber(d.length_cm, 'length_cm', 'La lunghezza deve essere un numero, in centimetri.');
  if (length !== null) {
    if (length <= 0) throw new ValidationError('length_cm', 'La lunghezza deve essere maggiore di zero.');
    if (length > 500) throw new ValidationError('length_cm', 'La lunghezza sembra troppo alta: controlla il valore in centimetri.');
    length = Math.round(length * 10) / 10;
    if (length <= 0) throw new ValidationError('length_cm', 'La lunghezza deve essere maggiore di zero.');
  }
  if (weight === null && length === null) throw new ValidationError('weight_g', 'Indica almeno il peso o la lunghezza.');

  const lat = readCoordinate(d, 'lat', -90, 90, 'Indica il punto della cattura.', 'La latitudine deve essere un numero tra -90 e 90.');
  const lng = readCoordinate(d, 'lng', -180, 180, 'Indica il punto della cattura.', 'La longitudine deve essere un numero tra -180 e 180.');

  if (isBlank(d.caught_at)) throw new ValidationError('caught_at', 'Indica data e ora della cattura.');
  const caughtAt = toIso(d.caught_at);
  const caughtMs = Date.parse(caughtAt);
  if (!caughtAt || caughtMs < Date.UTC(1900, 0, 1)) throw new ValidationError('caught_at', 'Data della cattura non valida.');
  if (caughtMs > now + DAY_MS) throw new ValidationError('caught_at', 'La data della cattura non può essere nel futuro.');

  return {
    species,
    species_id: readText(d, 'species_id', LIMITS.id),
    weight_g: weight,
    length_cm: length,
    bait_used: readText(d, 'bait_used', LIMITS.text),
    gear_used: readText(d, 'gear_used', LIMITS.text),
    location_name: readText(d, 'location_name', LIMITS.text),
    spot_id: readText(d, 'spot_id', LIMITS.id),
    lat,
    lng,
    caught_at: caughtAt,
    released: readBool(d.released, false),
    weather_snapshot: normalizeSnapshot(d.weather_snapshot),
    notes: readText(d, 'notes', LIMITS.notes)
  };
}

const FIELDS = { spots: spotFields, gear: gearFields, baits: baitFields, catches: catchFields };

/**
 * Valida un record e lo riduce alla forma canonica.
 * - keepTimestamps false: scrittura dell'utente, restituisce { client_id, ...campi } e i tempi li
 *   mette chi salva.
 * - keepTimestamps true (backup, migrazione, cloud): conserva created_at, updated_at (obbligatorio)
 *   e deleted_at; una lapide diventa { client_id, is_demo, created_at, updated_at, deleted_at }.
 * Lancia ValidationError con field e messaggio in italiano.
 */
export function normalizeRecord(kind, data, { keepTimestamps = false, allowDemo = false, generateId = false, maxFutureMs = null } = {}) {
  if (!FIELDS[kind]) throw new Error(`Tipo di record sconosciuto: ${kind}`);
  if (!isPlainObject(data)) throw new ValidationError('record', 'Record non valido.');
  const rawId = kind === 'spots' && isBlank(data.client_id) ? data.id : data.client_id;
  const client_id = readClientId(rawId, generateId);
  if (kind === 'spots' && isPredefinedSpotId(client_id)) {
    throw new ValidationError('client_id', 'Gli spot predefiniti non si possono modificare.');
  }
  const now = clock();
  if (!keepTimestamps) return { client_id, ...FIELDS[kind](data, now) };

  const updated_at = toIso(data.updated_at);
  if (!updated_at) throw new ValidationError('updated_at', 'Data di modifica mancante o non valida.');
  if (maxFutureMs !== null && Date.parse(updated_at) > now + maxFutureMs) {
    throw new ValidationError('updated_at', 'La data di modifica è nel futuro.');
  }
  const created_at = toIso(data.created_at) || updated_at;
  const is_demo = allowDemo && data.is_demo === true;
  if (!isBlank(data.deleted_at)) {
    const deleted_at = toIso(data.deleted_at);
    if (!deleted_at) throw new ValidationError('deleted_at', 'Data di cancellazione non valida.');
    return { client_id, is_demo, created_at, updated_at, deleted_at };
  }
  return { client_id, ...FIELDS[kind](data, now), is_demo, created_at, updated_at, deleted_at: null };
}

/**
 * Converte un record della v1 (chiavi fi_*_v1 o backup v1). I record dimostrativi v1 diventano
 * is_demo; i campi mancanti restano null; i testi troppo lunghi si tagliano invece di rifiutarli.
 */
export function fromV1Record(kind, raw, nowIsoValue = nowIso()) {
  if (!isPlainObject(raw)) throw new ValidationError('record', 'Record non valido.');
  const id = kind === 'spots' ? (isBlank(raw.client_id) ? raw.id : raw.client_id) : raw.client_id;
  const d = { ...raw, client_id: id };
  delete d.id;
  for (const f of ['name', 'species']) {
    if (typeof d[f] === 'string') d[f] = d[f].trim().slice(0, LIMITS.name);
  }
  if (kind === 'spots' && !isBlank(d.coast_orientation_deg)) {
    const deg = Number(d.coast_orientation_deg);
    if (Number.isFinite(deg)) d.coast_orientation_deg = ((Math.round(deg) % 360) + 360) % 360;
  }
  // La v1 salvava solo il nome della specie: se è in elenco se ne ricava l'id
  if (kind === 'catches' && isBlank(d.species_id)) d.species_id = speciesIdFor(d.species);
  // "Spot Personalizzato" era il segnaposto che la v1 metteva al posto della zona
  if (kind === 'spots' && typeof d.region === 'string' && d.region.trim().toLowerCase() === 'spot personalizzato') d.region = null;
  d.updated_at = toIso(raw.updated_at) || toIso(raw.created_at) || EPOCH_ISO;
  d.created_at = toIso(raw.created_at) || toIso(raw.updated_at) || nowIsoValue;
  d.deleted_at = null;
  d.is_demo = isV1DemoId(id);
  return normalizeRecord(kind, d, { keepTimestamps: true, allowDemo: true });
}

/**
 * Ordine tra due versioni dello stesso record: > 0 se a è più recente di b.
 * Vince updated_at più recente; a parità vince la lapide, poi un confronto fisso del contenuto,
 * così ogni dispositivo sceglie lo stesso vincitore.
 */
export function compareVersions(a, b) {
  const ta = Date.parse(a.updated_at);
  const tb = Date.parse(b.updated_at);
  if (ta !== tb) return (Number.isFinite(ta) ? ta : -Infinity) > (Number.isFinite(tb) ? tb : -Infinity) ? 1 : -1;
  const da = a.deleted_at ? 1 : 0;
  const db = b.deleted_at ? 1 : 0;
  if (da !== db) return da - db;
  const ja = canonical(a);
  const jb = canonical(b);
  return ja === jb ? 0 : ja > jb ? 1 : -1;
}

function canonical(record) {
  const { is_demo, ...rest } = record;
  return JSON.stringify(rest);
}

// ---------------------------------------------------------------------------
// Coda di sincronizzazione
// ---------------------------------------------------------------------------

/** Coda con l'operazione per quel record aggiornata alla sua versione attuale (una per record). */
export function withQueued(queue, kind, record) {
  const rest = queue.filter((e) => !(e.kind === kind && e.client_id === record.client_id));
  rest.push({ kind, client_id: record.client_id, updated_at: record.updated_at, queued_at: nowIso() });
  return rest;
}

/** Coda senza l'operazione per quel record; con version, solo se riguarda proprio quella versione. */
export function withoutQueued(queue, kind, clientId, version = null) {
  return queue.filter((e) => !(e.kind === kind && e.client_id === clientId && (version === null || e.updated_at === version)));
}

export function getQueue() {
  return clone(ensureLoaded().queue);
}

export function queueLength() {
  return ensureLoaded().queue.length;
}

/** Applica una modifica alla coda e la salva (solo se cambia). */
export function updateQueue(mutator) {
  const current = ensureLoaded().queue;
  const next = mutator(clone(current));
  if (JSON.stringify(next) !== JSON.stringify(current)) commitChanges({ queue: next });
}

export function getSyncMeta() {
  return clone(ensureLoaded().syncMeta);
}

/** Tutti i record di un tipo, lapidi comprese (copie). Uso interno di backup.js e sync.js. */
export function getAllRecords(kind) {
  if (!KINDS.includes(kind)) throw new Error(`Tipo di record sconosciuto: ${kind}`);
  return clone(ensureLoaded()[kind]);
}

// ---------------------------------------------------------------------------
// Inizializzazione e migrazione
// ---------------------------------------------------------------------------

export function normalizePrefs(raw) {
  const p = { ...DEFAULT_PREFS };
  if (!isPlainObject(raw)) return p;
  if (typeof raw.spotId === 'string' && raw.spotId.trim()) p.spotId = raw.spotId.trim().slice(0, LIMITS.id);
  if (typeof raw.speciesId === 'string' && raw.speciesId.trim()) p.speciesId = raw.speciesId.trim().slice(0, LIMITS.id);
  if (THEMES.includes(raw.theme)) p.theme = raw.theme;
  if (typeof raw.onboarded === 'boolean') p.onboarded = raw.onboarded;
  return p;
}

function readV1(store) {
  const present = Object.values(V1_KEYS).some((k) => readRaw(store, k) !== null);
  if (!present) return null;
  const arr = (key) => {
    const v = readJson(store, key, []);
    return Array.isArray(v) ? v : [];
  };
  return {
    prefs: readJson(store, V1_KEYS.prefs, null),
    spots: arr(V1_KEYS.spots),
    gear: arr(V1_KEYS.gear),
    baits: arr(V1_KEYS.baits),
    catches: arr(V1_KEYS.catches),
    queue: arr(V1_KEYS.queue)
  };
}

function migrateV1(v1) {
  const now = nowIso();
  const state = emptyState();
  let queue = [];
  let skipped = 0;

  const p = isPlainObject(v1.prefs) ? v1.prefs : {};
  state.prefs = normalizePrefs({
    spotId: p.selectedLocationId,
    speciesId: p.selectedSpeciesId,
    theme: p.theme === 'sunlight' ? 'light' : 'auto',
    onboarded: true
  });

  for (const kind of KINDS) {
    const byId = new Map();
    for (const raw of v1[kind]) {
      try {
        const rec = fromV1Record(kind, raw, now);
        byId.set(rec.client_id, rec);
      } catch (err) {
        if (!(err instanceof ValidationError)) throw err;
        skipped++;
      }
    }
    state[kind] = [...byId.values()];
    for (const rec of state[kind]) if (!rec.is_demo) queue = withQueued(queue, kind, rec);
  }

  // Cancellazioni rimaste nella coda v1 (mai partite per un difetto della v1): senza lapide i
  // record ricomparirebbero dal cloud alla prima sincronizzazione.
  for (const op of v1.queue) {
    if (!isPlainObject(op) || op.action !== 'DELETE') continue;
    const kind = KIND_OF_TABLE[op.table];
    const id = typeof op.clientId === 'string' ? op.clientId.trim() : '';
    if (!kind || !id || !CLIENT_ID_RE.test(id) || id.length > LIMITS.id || isV1DemoId(id)) continue;
    if (kind === 'spots' && isPredefinedSpotId(id)) continue;
    if (state[kind].some((r) => r.client_id === id)) continue;
    const t = toIso(op.queuedAt) || now;
    const tomb = { client_id: id, is_demo: false, created_at: t, updated_at: t, deleted_at: t };
    state[kind].push(tomb);
    queue = withQueued(queue, kind, tomb);
  }

  const spotExists = (id) => isPredefinedSpotId(id) || state.spots.some((s) => s.client_id === id && !s.deleted_at);
  if (!spotExists(state.prefs.spotId)) state.prefs.spotId = DEFAULT_PREFS.spotId;

  state.queue = queue;
  return { state, skipped };
}

function countDemo(state) {
  let n = 0;
  for (const kind of KINDS) n += state[kind].filter((r) => r.is_demo && !r.deleted_at).length;
  return n;
}

/**
 * Carica i dati e, alla prima esecuzione della v2, migra le chiavi v1 senza cancellarle.
 * Non lancia: se il browser non permette di salvare restituisce error ('quota' | 'unavailable'),
 * tiene i dati in memoria e rifiuta le scritture successive con StorageError.
 * Restituisce { migrated, demoCount } (più skipped se alcuni record v1 non erano validi).
 */
export function initStorage() {
  blockedCode = null;
  cache = null;
  const store = getStore();
  if (!store || !canRead(store)) {
    cache = emptyState();
    blockedCode = 'unavailable';
    return { migrated: false, demoCount: 0, error: 'unavailable' };
  }

  const meta = readJson(store, KEYS.meta, null);
  if (isPlainObject(meta) && Number(meta.schema) >= 2) {
    cache = loadState(store);
    emitKinds('all');
    return { migrated: false, demoCount: countDemo(cache) };
  }

  const hasV2Data = KINDS.some((k) => readRaw(store, STATE_KEYS[k]) !== null);
  const v1 = hasV2Data ? null : readV1(store);
  let next;
  const result = { migrated: false };
  if (hasV2Data) {
    next = loadState(store);
  } else if (v1) {
    const m = migrateV1(v1);
    next = m.state;
    result.migrated = true;
    if (m.skipped) result.skipped = m.skipped;
    // Prima di scrivere: se la memoria è piena proprio per le previsioni della v1, senza questo
    // la migrazione fallirebbe senza poterle liberare
    dropV1WeatherCache(store);
  } else {
    next = emptyState();
    next.prefs = normalizePrefs(readJson(store, KEYS.prefs, null));
  }

  const entries = [];
  for (const [name, key] of Object.entries(STATE_KEYS)) {
    if (name === 'syncMeta' && !next.syncMeta) continue;
    entries.push([key, next[name]]);
  }
  // fi2_meta per ultima: finché manca, al prossimo avvio la migrazione riparte da capo
  entries.push([KEYS.meta, { schema: 2, migratedAt: nowIso() }]);
  try {
    persist(entries);
  } catch (err) {
    cache = next;
    blockedCode = err.code;
    return { ...result, migrated: false, demoCount: countDemo(next), error: err.code };
  }
  cache = next;
  emitKinds('all');
  return { ...result, demoCount: countDemo(next) };
}

/**
 * Le previsioni salvate dalla v1 (circa 55 KB per spot) non servono più. I dati dell'utente
 * della v1 invece restano come copia di sicurezza, finché non sceglie "Cancella tutti i dati".
 */
function dropV1WeatherCache(store) {
  try {
    const stale = [];
    for (let i = 0; i < store.length; i++) {
      const k = store.key(i);
      if (k && k.startsWith(V1_WEATHER_CACHE_PREFIX)) stale.push(k);
    }
    for (const k of stale) store.removeItem(k);
  } catch (err) {
    // Solo spazio recuperato in meno: non è un motivo per far fallire l'avvio
  }
}

// ---------------------------------------------------------------------------
// Preferenze
// ---------------------------------------------------------------------------

export function getPrefs() {
  return { ...ensureLoaded().prefs };
}

export function setPrefs(partial) {
  if (!isPlainObject(partial)) throw new ValidationError('prefs', 'Preferenze non valide.');
  const next = { ...ensureLoaded().prefs };
  if ('spotId' in partial) {
    if (typeof partial.spotId !== 'string' || !partial.spotId.trim()) throw new ValidationError('spotId', 'Scegli uno spot.');
    next.spotId = partial.spotId.trim();
  }
  if ('speciesId' in partial) {
    if (typeof partial.speciesId !== 'string' || !partial.speciesId.trim()) throw new ValidationError('speciesId', 'Scegli una specie.');
    next.speciesId = partial.speciesId.trim();
  }
  if ('theme' in partial) {
    if (!THEMES.includes(partial.theme)) throw new ValidationError('theme', 'Tema non valido.');
    next.theme = partial.theme;
  }
  if ('onboarded' in partial) next.onboarded = partial.onboarded === true;
  commitChanges({ prefs: next }, { kind: 'prefs' });
  return { ...next };
}

// ---------------------------------------------------------------------------
// Record: salvataggio, cancellazione, elenchi
// ---------------------------------------------------------------------------

function view(kind, record) {
  const copy = clone(record);
  return kind === 'spots' ? { id: copy.client_id, ...copy, isCustom: true } : copy;
}

function alive(kind) {
  return ensureLoaded()[kind].filter((r) => !r.deleted_at);
}

function saveRecord(kind, data) {
  const st = ensureLoaded();
  const fields = normalizeRecord(kind, data, { generateId: true });
  const list = st[kind];
  const idx = list.findIndex((r) => r.client_id === fields.client_id);
  const prev = idx >= 0 ? list[idx] : null;
  const updated_at = nextVersion(prev?.updated_at);
  const record = {
    ...fields,
    // un demo resta demo anche se modificato: non deve mai finire sul cloud
    is_demo: prev?.is_demo === true,
    created_at: prev?.created_at || updated_at,
    updated_at,
    deleted_at: null
  };
  const nextList = list.slice();
  if (idx >= 0) nextList[idx] = record;
  else nextList.push(record);
  const changes = { [kind]: nextList };
  if (!record.is_demo) changes.queue = withQueued(st.queue, kind, record);
  commitChanges(changes, { kind });
  return view(kind, record);
}

function deleteRecord(kind, clientId) {
  const st = ensureLoaded();
  const id = typeof clientId === 'string' ? clientId.trim() : String(clientId ?? '');
  const idx = st[kind].findIndex((r) => r.client_id === id && !r.deleted_at);
  if (idx < 0) return false;
  const prev = st[kind][idx];
  const nextList = st[kind].slice();
  const changes = {};
  if (prev.is_demo) {
    // mai stato sul cloud: sparisce del tutto
    nextList.splice(idx, 1);
    changes.queue = withoutQueued(st.queue, kind, id);
  } else {
    const t = nextVersion(prev.updated_at);
    nextList[idx] = { client_id: id, is_demo: false, created_at: prev.created_at, updated_at: t, deleted_at: t };
    changes.queue = withQueued(st.queue, kind, nextList[idx]);
  }
  changes[kind] = nextList;
  const kinds = [kind];
  if (kind === 'spots' && st.prefs.spotId === id) {
    changes.prefs = { ...st.prefs, spotId: DEFAULT_PREFS.spotId };
    kinds.push('prefs');
  }
  commitChanges(changes, { kind: kinds });
  return true;
}

export function listSpots() {
  return [
    ...PREDEFINED_SPOTS.map((s) => ({ ...s, updated_at: null })),
    ...alive('spots').map((r) => view('spots', r))
  ];
}

export function getSpot(id) {
  const pre = PREDEFINED_SPOTS.find((s) => s.id === id);
  if (pre) return { ...pre, updated_at: null };
  const rec = alive('spots').find((r) => r.client_id === id);
  return rec ? view('spots', rec) : null;
}

export function saveSpot(data) {
  if (isPlainObject(data) && (isPredefinedSpotId(data.client_id) || isPredefinedSpotId(data.id))) {
    throw new ValidationError('client_id', 'Gli spot predefiniti non si possono modificare.');
  }
  return saveRecord('spots', data);
}

export function deleteSpot(id) {
  if (isPredefinedSpotId(id)) throw new ValidationError('id', 'Gli spot predefiniti non si possono eliminare.');
  return deleteRecord('spots', id);
}

export function listGear() {
  return alive('gear').map((r) => view('gear', r));
}

export function saveGear(data) {
  return saveRecord('gear', data);
}

export function deleteGear(clientId) {
  return deleteRecord('gear', clientId);
}

export function listBaits() {
  return alive('baits').map((r) => view('baits', r));
}

export function saveBait(data) {
  return saveRecord('baits', data);
}

export function deleteBait(clientId) {
  return deleteRecord('baits', clientId);
}

export function listCatches() {
  return alive('catches')
    .slice()
    .sort((a, b) => Date.parse(b.caught_at) - Date.parse(a.caught_at) || (a.client_id < b.client_id ? -1 : 1))
    .map((r) => view('catches', r));
}

export function saveCatch(data) {
  return saveRecord('catches', data);
}

export function deleteCatch(clientId) {
  return deleteRecord('catches', clientId);
}

// ---------------------------------------------------------------------------
// Dati dimostrativi, pulizia, spazio
// ---------------------------------------------------------------------------

export function countDemoRecords() {
  return countDemo(ensureLoaded());
}

/** Elimina davvero (senza lapide) i record dimostrativi: non sono mai stati sul cloud. */
export function removeDemoRecords() {
  const st = ensureLoaded();
  const count = countDemo(st);
  if (!count) return 0;
  const changes = {};
  let queue = st.queue;
  for (const kind of KINDS) {
    const demoIds = new Set(st[kind].filter((r) => r.is_demo).map((r) => r.client_id));
    if (!demoIds.size) continue;
    changes[kind] = st[kind].filter((r) => !demoIds.has(r.client_id));
    queue = queue.filter((e) => !(e.kind === kind && demoIds.has(e.client_id)));
  }
  changes.queue = queue;
  commitChanges(changes, { kind: 'all' });
  return count;
}

/**
 * Svuota tutte le chiavi fi2_ (anche la cache delle previsioni). Restano: il tema, fi2_meta
 * (altrimenti al prossimo avvio si rimigrerebbe la v1) e la sessione cloud (fi2_auth*).
 * Il cloud non si tocca: con l'account ancora collegato la prossima sincronizzazione riscarica i dati.
 */
export function clearAllData() {
  const st = ensureLoaded();
  const store = getStore();
  if (!store) throw new StorageError('unavailable');
  const keys = [];
  try {
    for (let i = 0; i < store.length; i++) {
      const k = store.key(i);
      if (!k) continue;
      // Anche le copie lasciate dalla versione 1 (fi_*): "cancella tutto" deve voler dire tutto
      if ((k.startsWith('fi2_') && k !== KEYS.meta && !k.startsWith('fi2_auth')) || k.startsWith('fi_')) keys.push(k);
    }
  } catch (err) {
    throw new StorageError('unavailable', err);
  }
  const prefs = { ...DEFAULT_PREFS, theme: st.prefs.theme };
  const oldMeta = readJson(store, KEYS.meta, null);
  const meta = { schema: 2, migratedAt: isPlainObject(oldMeta) && oldMeta.migratedAt ? oldMeta.migratedAt : nowIso() };
  persist([...keys.map((k) => [k, undefined]), [KEYS.prefs, prefs], [KEYS.meta, meta]], { force: true });
  blockedCode = null;
  cache = { ...emptyState(), prefs };
  emitKinds('all');
}

/**
 * Spazio occupato dalle chiavi fi2_ e fi_ (caratteri UTF-16, 2 byte l'uno).
 * Asincrona perché quotaBytes viene da navigator.storage.estimate(), che riguarda tutto lo
 * spazio dell'origine e non solo localStorage (di solito limitato a circa 5 MB).
 * → Promise<{ bytes, quotaBytes | null }>
 */
export async function storageUsage() {
  let bytes = 0;
  const store = getStore();
  if (store) {
    try {
      for (let i = 0; i < store.length; i++) {
        const k = store.key(i);
        if (k && (k.startsWith('fi2_') || k.startsWith('fi_'))) bytes += (k.length + (store.getItem(k) || '').length) * 2;
      }
    } catch {
      // memoria non leggibile: si restituisce quanto contato
    }
  }
  let quotaBytes = null;
  try {
    const est = await globalThis.navigator?.storage?.estimate?.();
    if (est && Number.isFinite(est.quota) && est.quota > 0) quotaBytes = est.quota;
  } catch {
    quotaBytes = null;
  }
  return { bytes, quotaBytes };
}
