/**
 * Backup dei dati dell'utente: esportazione, validazione, importazione atomica, CSV delle catture.
 *
 * L'importazione valida tutto il file prima di scrivere: se un solo record non va, il file si
 * rifiuta per intero e non si scrive niente. La scrittura poi è tutto o niente (storage.js).
 */

import { APP } from '../config.js';
import {
  KINDS,
  ValidationError,
  normalizeRecord,
  fromV1Record,
  normalizePrefs,
  compareVersions,
  nextVersion,
  withQueued,
  withoutQueued,
  getAllRecords,
  getQueue,
  getPrefs,
  commitChanges,
  isPredefinedSpotId,
  nowIso,
  DEFAULT_PREFS
} from './storage.js';

export const MAX_BACKUP_BYTES = 2 * 1024 * 1024;
export const MAX_RECORDS_PER_KIND = 5000;
const MAX_ERRORS_SHOWN = 20;
const DAY_MS = 24 * 60 * 60 * 1000;

const V1_FIELDS = { spots: 'customLocations', gear: 'gearItems', baits: 'baitsInventory', catches: 'catches' };
const LABEL = { spots: 'Spot', gear: 'Attrezzatura', baits: 'Esca', catches: 'Cattura' };
const SECTION = { spots: 'degli spot', gear: "dell'attrezzatura", baits: 'delle esche', catches: 'delle catture' };
const TOO_MANY = {
  spots: 'Troppi spot nel file: il massimo è 5000.',
  gear: 'Troppa attrezzatura nel file: il massimo è 5000 elementi.',
  baits: 'Troppe esche nel file: il massimo è 5000.',
  catches: 'Troppe catture nel file: il massimo è 5000.'
};
const NOT_A_BACKUP = 'Il file non è un backup di Fishing Intelligence.';

const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const lowerFirst = (s) => s.charAt(0).toLowerCase() + s.slice(1);

function stripDeleted(record) {
  const { deleted_at, ...rest } = record;
  return rest;
}

/** → { app, schema: 2, exportedAt, spots, gear, baits, catches, prefs }. Senza lapidi; i demo restano con is_demo true. */
export function exportBackup() {
  const out = { app: APP.name, schema: 2, exportedAt: nowIso() };
  for (const kind of KINDS) out[kind] = getAllRecords(kind).filter((r) => !r.deleted_at).map(stripDeleted);
  out.prefs = getPrefs();
  return out;
}

/** Testo del file → oggetto. Lancia ValidationError se è troppo grande o non è JSON. */
export function parseBackupText(text) {
  if (typeof text !== 'string') throw new ValidationError('file', 'Non riesco a leggere il file.');
  // ogni carattere vale almeno un byte: oltre questa lunghezza è sicuramente troppo grande
  if (text.length > MAX_BACKUP_BYTES || utf8Bytes(text) > MAX_BACKUP_BYTES) {
    throw new ValidationError('file', 'Il file è troppo grande: il massimo è 2 MB.');
  }
  try {
    return JSON.parse(text.replace(/^\uFEFF/, ''));
  } catch {
    throw new ValidationError('file', 'Il file è danneggiato o non è un backup.');
  }
}

function utf8Bytes(text) {
  if (text.length * 3 <= MAX_BACKUP_BYTES) return text.length;
  return new TextEncoder().encode(text).length;
}

/**
 * Valida tutto il backup e prepara i record normalizzati.
 * → { ok, errors, counts, format: 'v2'|'v1'|null, data: { spots, gear, baits, catches, prefs } }
 */
function prepareBackup(obj) {
  const counts = { spots: 0, gear: 0, baits: 0, catches: 0 };
  const data = { spots: [], gear: [], baits: [], catches: [], prefs: null };
  const fail = (message) => ({ ok: false, errors: [message], counts, format: null, data });

  if (!isPlainObject(obj)) return fail(NOT_A_BACKUP);
  let text;
  try {
    text = JSON.stringify(obj);
  } catch {
    return fail(NOT_A_BACKUP);
  }
  if (utf8Bytes(text) > MAX_BACKUP_BYTES) return fail('Il file è troppo grande: il massimo è 2 MB.');

  let format;
  if (obj.schema !== undefined) {
    if (obj.schema === 2) format = 'v2';
    else if (Number(obj.schema) > 2) return fail("Il backup viene da una versione più recente dell'app: aggiorna l'app e riprova.");
    else return fail('Versione del backup non riconosciuta.');
  } else if (Object.values(V1_FIELDS).some((f) => Array.isArray(obj[f]))) {
    format = 'v1';
  } else {
    return fail(NOT_A_BACKUP);
  }
  if (obj.app !== undefined && (typeof obj.app !== 'string' || !obj.app.includes('Fishing Intelligence'))) return fail(NOT_A_BACKUP);

  const errors = [];
  const now = nowIso();
  for (const kind of KINDS) {
    const list = obj[format === 'v2' ? kind : V1_FIELDS[kind]];
    if (list === undefined || list === null) continue;
    if (!Array.isArray(list)) {
      errors.push(`La sezione ${SECTION[kind]} non è un elenco.`);
      continue;
    }
    if (list.length > MAX_RECORDS_PER_KIND) {
      errors.push(TOO_MANY[kind]);
      continue;
    }
    const seen = new Set();
    list.forEach((raw, i) => {
      // le lapidi non fanno parte di un backup: si ignorano
      if (format === 'v2' && isPlainObject(raw) && raw.deleted_at) return;
      try {
        const rec =
          format === 'v2'
            ? normalizeRecord(kind, raw, { keepTimestamps: true, allowDemo: true, maxFutureMs: DAY_MS })
            : fromV1Record(kind, raw, now);
        if (kind === 'spots' && isPredefinedSpotId(rec.client_id)) {
          throw new ValidationError('client_id', 'Gli spot predefiniti non si possono modificare.');
        }
        if (seen.has(rec.client_id)) throw new ValidationError('client_id', 'Identificativo ripetuto nel file.');
        seen.add(rec.client_id);
        data[kind].push(rec);
      } catch (err) {
        if (!(err instanceof ValidationError)) throw err;
        errors.push(`${LABEL[kind]} ${i + 1}: ${lowerFirst(err.message)}`);
      }
    });
    counts[kind] = data[kind].length;
  }
  if (format === 'v2' && isPlainObject(obj.prefs)) data.prefs = normalizePrefs(obj.prefs);

  if (errors.length > MAX_ERRORS_SHOWN) {
    const extra = errors.length - MAX_ERRORS_SHOWN;
    errors.splice(MAX_ERRORS_SHOWN, extra, extra === 1 ? 'E un altro errore.' : `E altri ${extra} errori.`);
  }
  return { ok: errors.length === 0, errors, counts, format, data };
}

/** → { ok, errors: string[], counts: { spots, gear, baits, catches } }. Accetta anche il formato v1. */
export function validateBackup(obj) {
  const { ok, errors, counts } = prepareBackup(obj);
  return { ok, errors, counts };
}

/**
 * Importa un backup già letto (oggetto). Tutto o niente.
 * - merge: per client_id vince updated_at più recente.
 * - replace: i dati locali diventano quelli del backup. Ciò che non c'è diventa lapide (così la
 *   cancellazione arriva anche al cloud) e i record importati diventano la versione più recente.
 * → counts { spots, gear, baits, catches } dei record scritti.
 * Lancia ValidationError (con .errors) se il file non è valido, StorageError se il browser rifiuta.
 */
export function importBackup(obj, { mode = 'merge' } = {}) {
  if (mode !== 'merge' && mode !== 'replace') throw new ValidationError('mode', 'Modalità di importazione non valida.');
  const prep = prepareBackup(obj);
  if (!prep.ok) {
    const err = new ValidationError('file', prep.errors[0]);
    err.errors = prep.errors;
    throw err;
  }

  const counts = { spots: 0, gear: 0, baits: 0, catches: 0 };
  const changes = {};
  let queue = getQueue();
  const track = (kind, rec) => {
    queue = rec.is_demo ? withoutQueued(queue, kind, rec.client_id) : withQueued(queue, kind, rec);
  };

  for (const kind of KINDS) {
    const local = getAllRecords(kind);
    const byId = new Map(local.map((r) => [r.client_id, r]));
    const incoming = prep.data[kind];

    if (mode === 'merge') {
      for (const rec of incoming) {
        const cur = byId.get(rec.client_id);
        if (cur && compareVersions(rec, cur) <= 0) continue;
        byId.set(rec.client_id, rec);
        track(kind, rec);
        counts[kind]++;
      }
    } else {
      const keep = new Set(incoming.map((r) => r.client_id));
      for (const cur of local) {
        if (keep.has(cur.client_id)) continue;
        if (cur.is_demo) {
          byId.delete(cur.client_id);
          queue = withoutQueued(queue, kind, cur.client_id);
        } else if (!cur.deleted_at) {
          const t = nextVersion(cur.updated_at);
          const tomb = { client_id: cur.client_id, is_demo: false, created_at: cur.created_at, updated_at: t, deleted_at: t };
          byId.set(cur.client_id, tomb);
          track(kind, tomb);
        }
      }
      for (const rec of incoming) {
        const cur = byId.get(rec.client_id);
        const newest = cur && Date.parse(cur.updated_at) > Date.parse(rec.updated_at) ? cur.updated_at : rec.updated_at;
        const next = { ...rec, updated_at: nextVersion(newest) };
        byId.set(rec.client_id, next);
        track(kind, next);
        counts[kind]++;
      }
    }
    changes[kind] = [...byId.values()];
  }
  changes.queue = queue;

  // Lo spot scelto deve esistere anche dopo l'importazione: sostituendo (o unendo una copia che
  // contiene cancellazioni) quello attuale può essere sparito
  const spotExists = (id) => isPredefinedSpotId(id) || changes.spots.some((s) => s.client_id === id && !s.deleted_at);
  const current = getPrefs();
  let prefs = mode === 'replace' && prep.data.prefs ? { ...prep.data.prefs, onboarded: current.onboarded } : null;
  if (prefs && !spotExists(prefs.spotId)) prefs.spotId = current.spotId;
  if (!spotExists((prefs || current).spotId)) prefs = { ...(prefs || current), spotId: DEFAULT_PREFS.spotId };
  if (prefs) changes.prefs = prefs;

  commitChanges(changes, { kind: 'all' });
  return counts;
}

// ---------------------------------------------------------------------------
// CSV
// ---------------------------------------------------------------------------

const CSV_COLUMNS = [
  'data', 'ora', 'specie', 'peso_g', 'lunghezza_cm', 'rilasciata', 'esca', 'canna', 'spot', 'lat', 'lng',
  'onda_m', 'periodo_s', 'vento_kmh', 'pressione_hpa', 'acqua_c', 'punteggio', 'note'
];

/** Cella di testo: apostrofo davanti a = + - @ (formula injection) e virgolette quando servono. */
function textCell(value) {
  if (value === null || value === undefined) return '';
  let s = String(value);
  if (/^[=+\-@\t\r]/.test(s.trimStart())) s = `'${s}`;
  if (/[";\r\n]/.test(s) || /^\s|\s$/.test(s)) s = `"${s.replace(/"/g, '""')}"`;
  return s;
}

/** Cella numerica con la virgola decimale, come la legge un foglio di calcolo italiano. */
function numberCell(value, maxDecimals) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return '';
  const f = 10 ** maxDecimals;
  return String(Math.round(value * f) / f).replace('.', ',');
}

function dateTimeCells(iso, timeZone) {
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return ['', ''];
  const fmt = new Intl.DateTimeFormat('en-GB', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23'
  });
  const p = Object.fromEntries(fmt.formatToParts(new Date(ms)).map((x) => [x.type, x.value]));
  return [`${p.year}-${p.month}-${p.day}`, `${p.hour}:${p.minute}`];
}

/**
 * Catture → CSV con separatore ';', BOM iniziale e righe CRLF.
 * Data e ora nel fuso del dispositivo, oppure in options.timeZone (es. 'Europe/Rome').
 */
export function catchesToCsv(catches, { timeZone } = {}) {
  const rows = [CSV_COLUMNS.join(';')];
  for (const c of Array.isArray(catches) ? catches : []) {
    if (!isPlainObject(c) || c.deleted_at) continue;
    const s = isPlainObject(c.weather_snapshot) ? c.weather_snapshot : {};
    const [date, time] = dateTimeCells(c.caught_at, timeZone);
    rows.push(
      [
        date,
        time,
        textCell(c.species),
        numberCell(c.weight_g, 0),
        numberCell(c.length_cm, 1),
        c.released === true ? 'sì' : 'no',
        textCell(c.bait_used),
        textCell(c.gear_used),
        textCell(c.location_name),
        numberCell(c.lat, 6),
        numberCell(c.lng, 6),
        numberCell(s.waveHeightM, 2),
        numberCell(s.wavePeriodS, 1),
        numberCell(s.windSpeedKmh, 0),
        numberCell(s.pressureHpa, 0),
        numberCell(s.seaTempC, 1),
        numberCell(s.score, 0),
        textCell(c.notes)
      ].join(';')
    );
  }
  return `\uFEFF${rows.join('\r\n')}\r\n`;
}
