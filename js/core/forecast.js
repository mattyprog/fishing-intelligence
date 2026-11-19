/**
 * Previsione di uno spot: unisce le risposte Open-Meteo meteo e mare in ore e giornate di pesca.
 * Modulo puro. Le ore si allineano per istante (mai per indice) e un dato assente resta null.
 */

import { sunTimes, moonPhase, moonTimes } from './astronomy.js';

const HOUR_MS = 3600000;
const DAY_MS = 86400000;
const FISHING_DAY_START_HOUR = 5;
const LIGHT_MARGIN_MS = 45 * 60000;
const TIDE_MIN_RANGE_M = 0.03;
const MAX_HOURS = 24 * 32;

const WEATHER_FIELDS = {
  airTempC: 'temperature_2m',
  precipMm: 'precipitation',
  precipProb: 'precipitation_probability',
  weatherCode: 'weather_code',
  cloudCover: 'cloud_cover',
  windKmh: 'wind_speed_10m',
  gustKmh: 'wind_gusts_10m',
  windDirDeg: 'wind_direction_10m',
  pressureHpa: 'pressure_msl'
};

const MARINE_FIELDS = {
  waveM: 'wave_height',
  wavePeriodS: 'wave_period',
  waveDirDeg: 'wave_direction',
  windWaveM: 'wind_wave_height',
  swellM: 'swell_wave_height',
  swellPeriodS: 'swell_wave_period',
  seaTempC: 'sea_surface_temperature',
  seaLevelM: 'sea_level_height_msl',
  currentKmh: 'ocean_current_velocity'
};

const SPEED_FIELDS = new Set(['windKmh', 'gustKmh', 'currentKmh']);
const SPEED_TO_KMH = { 'km/h': 1, kmh: 1, 'm/s': 3.6, ms: 3.6, kn: 1.852, mph: 1.609344 };

const WEEKDAYS = ['Domenica', 'Lunedì', 'Martedì', 'Mercoledì', 'Giovedì', 'Venerdì', 'Sabato'];
const WEEKDAYS_SHORT = ['Dom', 'Lun', 'Mar', 'Mer', 'Gio', 'Ven', 'Sab'];

const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const pad = (n) => String(n).padStart(2, '0');

/** 'YYYY-MM-DDTHH:MM' locale → epochMs UTC, dato lo scarto dello spot. */
export function localToEpoch(time, utcOffsetSeconds) {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(String(time || ''));
  if (!m) return null;
  return Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]) - utcOffsetSeconds * 1000;
}

/** epochMs → 'YYYY-MM-DDTHH:MM' locale allo spot. */
export function epochToLocal(epochMs, utcOffsetSeconds) {
  const d = new Date(epochMs + utcOffsetSeconds * 1000);
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}T${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
}

function stamp(epochMs, offset) {
  return Number.isFinite(epochMs) ? { time: epochToLocal(epochMs, offset).slice(11, 16), epochMs } : null;
}

/** Indicizza un blocco Open-Meteo per istante; null se il blocco non è utilizzabile. */
function indexBlock(block) {
  const times = block?.hourly?.time;
  if (!Array.isArray(times) || times.length === 0) return null;
  const offset = Number.isFinite(block.utc_offset_seconds) ? block.utc_offset_seconds : 0;
  const byEpoch = new Map();
  times.forEach((t, i) => {
    const e = localToEpoch(t, offset);
    if (e !== null) byEpoch.set(e, i);
  });
  return byEpoch.size ? { block, offset, byEpoch, units: block.hourly_units || {} } : null;
}

function speedFactor(units, key) {
  const u = String(units[key] || 'km/h').toLowerCase().replace(/\s/g, '');
  return SPEED_TO_KMH[u] ?? null;
}

function fillFields(hour, idx, fields) {
  if (!idx) return;
  const i = idx.byEpoch.get(hour.epochMs);
  if (i === undefined) return;
  for (const [key, src] of Object.entries(fields)) {
    let v = num(idx.block.hourly[src]?.[i]);
    if (v !== null && SPEED_FIELDS.has(key)) {
      const f = speedFactor(idx.units, src);
      v = f === null ? null : Math.round(v * f * 10) / 10;
    }
    if (key === 'weatherCode' && v !== null) v = Math.round(v);
    hour[key] = v;
  }
}

function emptyHour(epochMs, offset) {
  const h = { time: epochToLocal(epochMs, offset), epochMs };
  for (const k of [...Object.keys(WEATHER_FIELDS), 'pressureTrend3h', ...Object.keys(MARINE_FIELDS)]) h[k] = null;
  h.seaPhase = null;
  h.light = null;
  h.windIncidence = null;
  return h;
}

/** Fase del mare all'ora i (vedi docs/ARCHITETTURA.md, §6). */
function seaPhaseAt(hours, i) {
  const w = hours[i].waveM;
  const w6 = i >= 6 ? hours[i - 6].waveM : null;
  if (w === null || w6 === null) return null;
  let peak = -Infinity;
  for (let k = Math.max(0, i - 36); k <= i; k++) {
    if (hours[k].waveM !== null) peak = Math.max(peak, hours[k].waveM);
  }
  if (w6 > 0 && w <= w6 * 0.88 && peak >= 0.8) return 'scaduta';
  if (w >= w6 * 1.15 && w > 0.4) return 'montante';
  return 'stabile';
}

/** Differenza angolare tra provenienza del vento e direzione verso cui guarda la spiaggia. */
export function windIncidenceFor(windDirDeg, coastDeg) {
  if (!Number.isFinite(windDirDeg) || !Number.isFinite(coastDeg)) return null;
  const diff = Math.abs((((windDirDeg - coastDeg) % 360) + 540) % 360 - 180);
  if (diff <= 50) return 'onshore';
  if (diff >= 130) return 'offshore';
  return 'cross';
}

/** Luce dell'ora: si classifica il centro dell'ora (l'ora 17 vale per le 17:00-18:00). */
function lightAt(epochMs, sun) {
  if (sun.sunrise === null || sun.sunset === null) return null;
  const mid = epochMs + HOUR_MS / 2;
  const dawnStart = sun.dawn ?? sun.sunrise;
  const dawnEnd = sun.sunrise + LIGHT_MARGIN_MS;
  const duskStart = sun.sunset - LIGHT_MARGIN_MS;
  const duskEnd = sun.dusk ?? sun.sunset;
  if (mid >= dawnStart && mid < dawnEnd) return 'dawn';
  if (mid >= dawnEnd && mid < duskStart) return 'day';
  if (mid >= duskStart && mid < duskEnd) return 'dusk';
  return 'night';
}

/* --------------------------------- Maree --------------------------------- */

/** Vertice della parabola per i tre punti attorno all'indice i: affina istante e livello. */
function refineExtreme(hours, i) {
  const a = hours[i - 1]?.seaLevelM ?? null;
  const b = hours[i].seaLevelM;
  const c = hours[i + 1]?.seaLevelM ?? null;
  if (a === null || c === null) return { epochMs: hours[i].epochMs, levelM: b };
  const denom = a - 2 * b + c;
  const delta = denom === 0 ? 0 : Math.max(-0.5, Math.min(0.5, (a - c) / (2 * denom)));
  return { epochMs: hours[i].epochMs + delta * HOUR_MS, levelM: b - 0.25 * (a - c) * delta };
}

/**
 * Massimi e minimi con isteresi: un estremo vale solo quando il livello torna indietro di
 * almeno 3 cm, così le increspature del modello non diventano maree. Il primo e l'ultimo
 * punto di ogni tratto continuo non si confermano: non si sa cosa c'era prima o dopo.
 */
function findExtrema(hours) {
  const out = [];
  let mode = null;
  let hi = -1;
  let lo = -1;
  let first = -1;
  const y = (i) => hours[i].seaLevelM;
  const emit = (type, i) => out.push({ type, ...refineExtreme(hours, i) });
  for (let i = 0; i < hours.length; i++) {
    if (y(i) === null) {
      mode = null;
      hi = lo = first = -1;
      continue;
    }
    if (first < 0) {
      first = hi = lo = i;
      continue;
    }
    if (mode === null) {
      if (y(i) > y(hi)) hi = i;
      if (y(i) < y(lo)) lo = i;
      if (y(hi) - y(lo) >= TIDE_MIN_RANGE_M) {
        mode = hi > lo ? 'up' : 'down';
        if (mode === 'up' && lo !== first) emit('low', lo);
        if (mode === 'down' && hi !== first) emit('high', hi);
      }
    } else if (mode === 'up') {
      if (y(i) > y(hi)) hi = i;
      else if (y(hi) - y(i) >= TIDE_MIN_RANGE_M) {
        emit('high', hi);
        mode = 'down';
        lo = i;
      }
    } else if (y(i) < y(lo)) {
      lo = i;
    } else if (y(i) - y(lo) >= TIDE_MIN_RANGE_M) {
      emit('low', lo);
      mode = 'up';
      hi = i;
    }
  }
  return out;
}

function findTides(hours, offset) {
  return findExtrema(hours).map((t) => {
    const epochMs = Math.round(t.epochMs / 60000) * 60000;
    return { type: t.type, time: epochToLocal(epochMs, offset).slice(11, 16), epochMs, levelM: Math.round(t.levelM * 100) / 100 };
  });
}

/* -------------------------------- Giornate -------------------------------- */

function summarize(hs) {
  const vals = (k) => hs.map((h) => h[k]).filter((v) => v !== null);
  const min = (k) => (vals(k).length ? Math.min(...vals(k)) : null);
  const max = (k) => (vals(k).length ? Math.max(...vals(k)) : null);
  const precip = vals('precipMm');
  const sst = vals('seaTempC');
  return {
    waveMinM: min('waveM'),
    waveMaxM: max('waveM'),
    windMaxKmh: max('windKmh'),
    gustMaxKmh: max('gustKmh'),
    airMinC: min('airTempC'),
    airMaxC: max('airTempC'),
    weatherCode: max('weatherCode'), // i codici WMO crescono con la severità
    precipMm: precip.length ? Math.round(precip.reduce((a, b) => a + b, 0) * 10) / 10 : null,
    seaTempC: sst.length ? Math.round((sst.reduce((a, b) => a + b, 0) / sst.length) * 10) / 10 : null
  };
}

function dayLabels(dateUtcMs, todayUtcMs) {
  const diff = Math.round((dateUtcMs - todayUtcMs) / DAY_MS);
  const d = new Date(dateUtcMs);
  if (diff === 0) return ['Oggi', 'Oggi'];
  if (diff === 1) return ['Domani', 'Domani'];
  if (diff === -1) return ['Stanotte', 'Stanotte'];
  return [`${WEEKDAYS[d.getUTCDay()]} ${d.getUTCDate()}`, WEEKDAYS_SHORT[d.getUTCDay()]];
}

/** Sorgere e tramonto della luna dentro la giornata di pesca (05:00-05:00), non nel giorno solare. */
function moonEventsInWindow(date, start, end, { lat, lng, offset }) {
  const next = new Date(Date.parse(`${date}T00:00:00Z`) + DAY_MS).toISOString().slice(0, 10);
  const a = moonTimes(date, lat, lng, offset);
  const b = moonTimes(next, lat, lng, offset);
  const pick = (...list) => list.find((t) => t !== null && t >= start && t < end) ?? null;
  return { rise: pick(a.rise, b.rise), set: pick(a.set, b.set) };
}

function firstIndexAtOrAfter(hours, epochMs) {
  const i = hours.findIndex((h) => h.epochMs >= epochMs);
  return i === -1 ? hours.length : i;
}

/* ----------------------------- Cambio dell'ora ----------------------------- */

const zoneFormatters = new Map();

/** Scarto reale del fuso in quell'istante, in secondi; null se il dispositivo non conosce il fuso. */
function zoneOffsetSeconds(timeZone, epochMs) {
  try {
    let fmt = zoneFormatters.get(timeZone);
    if (!fmt) {
      fmt = new Intl.DateTimeFormat('en-US', {
        timeZone,
        hourCycle: 'h23',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit'
      });
      zoneFormatters.set(timeZone, fmt);
    }
    const p = {};
    for (const part of fmt.formatToParts(new Date(epochMs))) p[part.type] = Number(part.value);
    const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
    return Number.isFinite(asUtc) ? Math.round((asUtc - epochMs) / 1000) : null;
  } catch (err) {
    return null;
  }
}

/**
 * Open-Meteo applica a tutta la risposta lo scarto orario valido adesso, anche oltre un cambio
 * dell'ora (verificato sulla risposta reale a cavallo del 25 ottobre 2026: 24 ore per giorno,
 * sempre +1). Gli istanti restano giusti, ma dopo il cambio le ore indicate differiscono di
 * un'ora dall'orologio. Le ore non si riscrivono: si segnala la giornata.
 * Contano solo le ore non ancora passate.
 * @returns {{ hours: number, fromTime: string|null }|null} hours: quanto l'orologio sarà avanti (+1)
 *   o indietro (-1) rispetto alle ore indicate; fromTime: da che ora indicata, null se tutta la giornata
 */
function clockShiftFor(dayHours, timeZone, offset, now) {
  if (!timeZone) return null;
  const ahead = dayHours.filter((h) => h.epochMs + HOUR_MS > now);
  if (!ahead.length) return null;
  const shiftAt = (h) => {
    const real = zoneOffsetSeconds(timeZone, h.epochMs);
    return real === null ? null : Math.round((real - offset) / 3600);
  };
  // Il cambio avviene al più una volta nella giornata: bastano i due estremi per escluderlo
  const first = shiftAt(ahead[0]);
  const last = shiftAt(ahead[ahead.length - 1]);
  if (first === null || last === null || (first === 0 && last === 0)) return null;
  if (first !== 0) return { hours: first, fromTime: null };
  const start = ahead.find((h) => shiftAt(h) !== 0);
  return { hours: last, fromTime: start ? start.time.slice(11, 16) : null };
}

function buildDays(hours, tides, ctx) {
  const { offset, now, lat, lng, timeZone } = ctx;
  if (!hours.length) return [];
  const local = new Date(now + offset * 1000);
  const todayUtc = Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate());
  const firstUtc = local.getUTCHours() < FISHING_DAY_START_HOUR ? todayUtc - DAY_MS : todayUtc;
  const last = hours[hours.length - 1].epochMs;
  const days = [];
  for (let k = 0; k < 400; k++) {
    const dateUtc = firstUtc + k * DAY_MS;
    const start = dateUtc + FISHING_DAY_START_HOUR * HOUR_MS - offset * 1000;
    const end = start + DAY_MS;
    if (start > last) break;
    if (end <= hours[0].epochMs) continue;
    const startIndex = firstIndexAtOrAfter(hours, start);
    const endIndex = firstIndexAtOrAfter(hours, end);
    if (endIndex <= startIndex) continue;
    const date = new Date(dateUtc).toISOString().slice(0, 10);
    const [label, labelShort] = dayLabels(dateUtc, todayUtc);
    const sun = sunTimes(date, lat, lng);
    const moon = moonPhase(start + 12 * HOUR_MS);
    const mt = moonEventsInWindow(date, start, end, ctx);
    days.push({
      date,
      label,
      labelShort,
      startIndex,
      endIndex,
      sun: Object.fromEntries(Object.entries(sun).map(([key, v]) => [key, stamp(v, offset)])),
      moon: { ...moon, rise: stamp(mt.rise, offset), set: stamp(mt.set, offset) },
      tides: tides.filter((t) => t.epochMs >= start && t.epochMs < end),
      clockShift: clockShiftFor(hours.slice(startIndex, endIndex), timeZone, offset, now),
      summary: summarize(hours.slice(startIndex, endIndex))
    });
  }
  return days;
}

function haversineKm(lat1, lng1, lat2, lng2) {
  const r = Math.PI / 180;
  const a = Math.sin(((lat2 - lat1) * r) / 2) ** 2
    + Math.cos(lat1 * r) * Math.cos(lat2 * r) * Math.sin(((lng2 - lng1) * r) / 2) ** 2;
  return 6371 * 2 * Math.asin(Math.sqrt(a));
}

/* ------------------------------- Costruzione ------------------------------- */

function buildHours(w, m, offset, spot) {
  const epochs = [...(w?.byEpoch.keys() || []), ...(m?.byEpoch.keys() || [])];
  const first = Math.min(...epochs);
  // Difesa da risposte anomale: al massimo 32 giorni di ore
  const lastEpoch = Math.min(Math.max(...epochs), first + MAX_HOURS * HOUR_MS);
  const hours = [];
  for (let e = first; e <= lastEpoch; e += HOUR_MS) {
    const h = emptyHour(e, offset);
    fillFields(h, w, WEATHER_FIELDS);
    fillFields(h, m, MARINE_FIELDS);
    hours.push(h);
  }
  const sunByDate = new Map();
  hours.forEach((h, i) => {
    if (i >= 3 && h.pressureHpa !== null && hours[i - 3].pressureHpa !== null) {
      h.pressureTrend3h = Math.round((h.pressureHpa - hours[i - 3].pressureHpa) * 100) / 100;
    }
    h.seaPhase = seaPhaseAt(hours, i);
    h.windIncidence = windIncidenceFor(h.windDirDeg, Number(spot.coast_orientation_deg));
    const midDate = epochToLocal(h.epochMs + HOUR_MS / 2, offset).slice(0, 10);
    if (!sunByDate.has(midDate)) sunByDate.set(midDate, sunTimes(midDate, spot.lat, spot.lng));
    h.light = lightAt(h.epochMs, sunByDate.get(midDate));
  });
  return hours;
}

/**
 * @param {{ weather: object|null, marine: object|null, spot: object, now: number }} input
 * @returns {object|null} Forecast (docs/ARCHITETTURA.md, §6), null se mancano entrambi i blocchi
 */
export function buildForecast({ weather, marine, spot, now }) {
  const w = indexBlock(weather);
  const m = indexBlock(marine);
  if ((!w && !m) || !spot || !Number.isFinite(now)) return null;
  const offset = (w || m).offset;
  const hours = buildHours(w, m, offset, spot);
  const nowIndex = hours.findIndex((h) => now >= h.epochMs && now < h.epochMs + HOUR_MS);
  const tides = findTides(hours, offset);
  const gLat = num(marine?.latitude);
  const gLng = num(marine?.longitude);
  const timeZone = (w || m).block.timezone ?? null;
  return {
    spotId: spot.id ?? null,
    lat: spot.lat,
    lng: spot.lng,
    timezone: timeZone,
    utcOffsetSeconds: offset,
    marineGrid: m && gLat !== null && gLng !== null
      ? { lat: gLat, lng: gLng, distanceKm: Math.round(haversineKm(spot.lat, spot.lng, gLat, gLng) * 10) / 10 }
      : null,
    has: {
      weather: Boolean(w),
      marine: Boolean(m),
      seaTemp: hours.some((h) => h.seaTempC !== null),
      seaLevel: hours.some((h) => h.seaLevelM !== null)
    },
    hours,
    nowIndex,
    days: buildDays(hours, tides, { offset, now, lat: spot.lat, lng: spot.lng, timeZone })
  };
}
