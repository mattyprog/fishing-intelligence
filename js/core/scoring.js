/**
 * Punteggio di pesca per ora e per giornata (docs/ARCHITETTURA.md, §8). Modulo puro.
 *
 * Punteggio orario = media pesata dei fattori disponibili (i pesi dei fattori null si
 * ridistribuiscono) × limitatori continui dei fattori cardine (mare, stagione, acqua, luce),
 * poi i tetti fissi del contratto (mare < 0.15 → 35, stagione < 0.15 → 45) e quelli di sicurezza.
 * I limitatori servono a non far saturare il punteggio: con la sola media pesata un fattore
 * cardine scarso costerebbe al massimo il suo peso e 4 specie su 6 finirebbero sopra 90.
 */

import { SAFETY } from '../config.js';
import { moonPhase } from './astronomy.js';
import { windName } from './format.js';
import { withArticle } from './species.js';

export const WEIGHTS = { sea: 0.34, wind: 0.14, light: 0.14, season: 0.12, water: 0.10, pressure: 0.08, tide: 0.04, moon: 0.04 };

const LABELS = { sea: 'Mare', wind: 'Vento', light: 'Luce', season: 'Stagione', water: 'Acqua', pressure: 'Pressione', tide: 'Marea', moon: 'Luna' };

// Forza dei limitatori: con il fattore a v il punteggio si moltiplica per 1 - a * (1 - v)
const LIMITERS = { sea: 0.4, season: 0.5, water: 0.35, light: 0.5 };
// Tetti del contratto; sopra la soglia il tetto risale fino a 100 (a fullAt) per non creare gradini
const HARD_CAPS = [
  { key: 'sea', below: 0.15, max: 35, fullAt: 0.6 },
  { key: 'season', below: 0.15, max: 45, fullAt: 0.6 }
];

function capFor(c, v) {
  if (v < c.below) return c.max;
  return c.max + (100 - c.max) * Math.min(1, (v - c.below) / (c.fullAt - c.below));
}

const VERDICTS = {
  ottimo: 'Ottimo',
  buono: 'Buono',
  discreto: 'Discreto',
  difficile: 'Difficile',
  pericolo: 'Pericolo',
  nd: 'n.d.'
};

const HOUR_MS = 3600000;
const MONTHS = ['gennaio', 'febbraio', 'marzo', 'aprile', 'maggio', 'giugno', 'luglio', 'agosto', 'settembre', 'ottobre', 'novembre', 'dicembre'];
const LIGHT_NAMES = { dawn: 'alba', day: 'giorno', dusk: 'tramonto', night: 'notte' };
const LIGHT_WHEN = { dawn: "all'alba", day: 'di giorno', dusk: 'al tramonto', night: 'di notte' };

const clamp01 = (x) => Math.max(0, Math.min(1, x));
const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
const round = (x, d = 0) => Math.round(x * 10 ** d) / 10 ** d;
const cap = (s) => (s ? s.charAt(0).toUpperCase() + s.slice(1) : s);
const avg = (list) => (list.length ? list.reduce((a, b) => a + b, 0) / list.length : null);
const f1 = (x) => (isNum(x) ? x.toFixed(1) : 'n.d.');
const f0 = (x) => (isNum(x) ? String(Math.round(x)) : 'n.d.');

/* ------------------------------ Curve dei fattori ------------------------------ */

function trapezoid(x, min, optMin, optMax, max) {
  if (x < optMin) return optMin <= min ? (x < min ? 0 : 1) : clamp01((x - min) / (optMin - min));
  if (x <= optMax) return 1;
  return max <= optMax ? 0 : clamp01((max - x) / (max - optMax));
}

/** Interpolazione lineare tra punti [x, y], costante fuori dagli estremi. */
function piecewise(x, pts) {
  if (x <= pts[0][0]) return pts[0][1];
  for (let i = 1; i < pts.length; i++) {
    const [x1, y1] = pts[i];
    if (x <= x1) {
      const [x0, y0] = pts[i - 1];
      return y0 + ((y1 - y0) * (x - x0)) / (x1 - x0);
    }
  }
  return pts[pts.length - 1][1];
}

function periodFit(p, { optMin, optMax }) {
  if (p < optMin) return clamp01(1 - (optMin - p) / 3);
  if (p > optMax) return clamp01(1 - (p - optMax) / 4);
  return 1;
}

/** Il bonus di fase vale rispetto alla fase migliore della specie, così non si perde nel tetto a 1. */
function phaseMultiplier(phase, sp) {
  if (!phase || !isNum(sp.seaPhase[phase])) return 1;
  const best = Math.max(...Object.values(sp.seaPhase));
  return 1 - (best - sp.seaPhase[phase]);
}

function seaValue(h, sp) {
  if (!isNum(h.waveM)) return null;
  const base = trapezoid(h.waveM, sp.wave.min, sp.wave.optMin, sp.wave.optMax, sp.wave.max);
  const pf = isNum(h.wavePeriodS) ? periodFit(h.wavePeriodS, sp.period) : 1;
  return clamp01(base * (0.75 + 0.25 * pf) * phaseMultiplier(h.seaPhase, sp));
}

function windMismatch(incidence, pref) {
  if (pref === 'any' || !incidence) return 0;
  if (incidence === pref) return 0;
  return incidence === 'cross' ? 1 : 2;
}

function windValue(h, sp) {
  if (!isNum(h.windKmh)) return null;
  const { optMin, optMax, max } = sp.wind;
  const v = h.windKmh;
  let base;
  if (v < optMin) base = 0.6 + (0.4 * v) / optMin; // poco vento non è una penalità forte
  else if (v <= optMax) base = 1;
  else base = clamp01((max - v) / (max - optMax));
  // Con vento debole la direzione conta poco: la correzione cresce fino a 8 km/h
  const strength = Math.min(1, v / 8);
  let value = base * (1 - 0.15 * windMismatch(h.windIncidence, sp.windPreference) * strength);
  if (isNum(h.gustKmh)) value -= Math.max(0, Math.min(0.5, (h.gustKmh - max) / 30));
  return clamp01(value);
}

function lightValue(h, sp) {
  return h.light && isNum(sp.light[h.light]) ? sp.light[h.light] : null;
}

function seasonValue(time, sp) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(time || ''));
  if (!m) return null;
  const month = Number(m[2]) - 1;
  const dim = new Date(Date.UTC(Number(m[1]), month + 1, 0)).getUTCDate();
  // months[i] vale a metà mese: si interpola tra i due mesi vicini
  const pos = month + (Number(m[3]) - 0.5) / dim - 0.5;
  const i0 = Math.floor(pos);
  const t = pos - i0;
  const a = sp.months[(i0 + 12) % 12];
  const b = sp.months[(i0 + 13) % 12];
  return a + (b - a) * t;
}

function waterValue(h, sp) {
  if (!isNum(h.seaTempC)) return null;
  const w = sp.waterTemp;
  return trapezoid(h.seaTempC, w.min, w.optMin, w.optMax, w.max);
}

const PRESSURE_FALLING = [[-1, 1], [-0.3, 0.6], [0.3, 0.6], [1, 0.4]];
const PRESSURE_STABLE = [[-2, 0.35], [-1, 0.55], [-0.3, 1], [0.3, 1], [1, 0.8]];

function pressureValue(h, sp) {
  if (!isNum(h.pressureTrend3h)) return null;
  return piecewise(h.pressureTrend3h, sp.pressure === 'falling' ? PRESSURE_FALLING : PRESSURE_STABLE);
}

/** Variazione del livello del mare in m/h attorno all'ora. */
function tideSlope(h, prev, next) {
  const p = isNum(prev?.seaLevelM) ? prev.seaLevelM : null;
  const n = isNum(next?.seaLevelM) ? next.seaLevelM : null;
  const c = isNum(h.seaLevelM) ? h.seaLevelM : null;
  if (p !== null && n !== null) return (n - p) / 2;
  if (c !== null && n !== null) return n - c;
  if (c !== null && p !== null) return c - p;
  return null;
}

function tideValue(slope) {
  return slope === null ? null : piecewise(slope, [[-0.02, 0.5], [0, 0.7], [0.02, 1]]);
}

function moonFraction(h, day) {
  if (isNum(day?.moon?.fraction)) return day.moon.fraction;
  return isNum(h.epochMs) ? moonPhase(h.epochMs).fraction : null;
}

/** Tradizione: luna nuova e piena (1) meglio dei quarti (0.5). Peso basso. */
function moonValue(fraction) {
  return fraction === null ? null : 0.5 + 0.5 * Math.abs(Math.cos(2 * Math.PI * fraction));
}

/* --------------------------------- Sicurezza --------------------------------- */

const isThunder = (h) => Boolean(h) && SAFETY.thunderCodes.includes(h.weatherCode);

function hourSafety(h, prev, next) {
  const reasons = [];
  let level = 'ok';
  const raise = (lv) => {
    if (lv === 'danger' || level === 'ok') level = lv;
  };
  if (isNum(h.waveM) && h.waveM >= SAFETY.waveCautionM) {
    raise(h.waveM >= SAFETY.waveDangerM ? 'danger' : 'caution');
    reasons.push(`Onda ${f1(h.waveM)} m`);
  }
  if (isNum(h.gustKmh) && h.gustKmh >= SAFETY.gustCautionKmh) {
    raise(h.gustKmh >= SAFETY.gustDangerKmh ? 'danger' : 'caution');
    reasons.push(`Raffiche a ${f0(h.gustKmh)} km/h`);
  }
  if (isNum(h.windKmh) && h.windKmh >= SAFETY.windCautionKmh) {
    raise(h.windKmh >= SAFETY.windDangerKmh ? 'danger' : 'caution');
    reasons.push(`Vento a ${f0(h.windKmh)} km/h`);
  }
  if (isThunder(h)) {
    raise('danger');
    reasons.push('Temporale');
  } else if (isThunder(prev) || isThunder(next)) {
    raise('danger');
    reasons.push("Temporale nell'ora vicina");
  }
  return { level, reasons };
}

/* ------------------------------- Punteggio orario ------------------------------- */

function limiterProduct(values) {
  let g = 1;
  for (const [key, a] of Object.entries(LIMITERS)) {
    if (values[key] !== null) g *= 1 - a * (1 - values[key]);
  }
  return g;
}

/**
 * Punteggio di un'ora per una specie.
 * opts.prev e opts.next (ore vicine) servono per il temporale adiacente e per il verso della marea:
 * senza, la sicurezza guarda solo l'ora e la marea resta null.
 */
export function scoreHour(hour, species, { day, prev, next } = {}) {
  const values = {
    sea: seaValue(hour, species),
    wind: windValue(hour, species),
    light: lightValue(hour, species),
    season: seasonValue(hour.time, species),
    water: waterValue(hour, species),
    pressure: pressureValue(hour, species),
    tide: tideValue(tideSlope(hour, prev, next)),
    moon: moonValue(moonFraction(hour, day))
  };
  const parts = Object.fromEntries(Object.keys(WEIGHTS).map((k) => [k, { value: values[k] === null ? null : round(values[k], 3) }]));
  const safety = hourSafety(hour, prev, next);
  let score = null;
  if (values.sea !== null) {
    let sum = 0;
    let wsum = 0;
    for (const [k, w] of Object.entries(WEIGHTS)) {
      if (values[k] === null) continue;
      sum += w * values[k];
      wsum += w;
    }
    score = (100 * sum * limiterProduct(values)) / wsum;
    for (const c of HARD_CAPS) if (values[c.key] !== null) score = Math.min(score, capFor(c, values[c.key]));
    if (safety.level === 'danger') score = Math.min(score, SAFETY.dangerCap);
    if (safety.level === 'caution') score = Math.min(score, SAFETY.cautionCap);
    score = Math.round(Math.max(0, Math.min(100, score)));
  }
  return { score, safety: safety.level, safetyReasons: safety.reasons, parts };
}

/** Verdetto dal punteggio; la sicurezza vince sempre. */
export function verdictFor(score, safetyLevel) {
  let key;
  if (safetyLevel === 'danger') key = 'pericolo';
  else if (!isNum(score)) key = 'nd';
  else if (score >= 75) key = 'ottimo';
  else if (score >= 60) key = 'buono';
  else if (score >= 45) key = 'discreto';
  else key = 'difficile';
  return { key, label: VERDICTS[key] };
}

/* ------------------------------ Valutazione giornata ------------------------------ */

function scoreRange(forecast, day, species) {
  const out = [];
  for (let i = day.startIndex; i < day.endIndex; i++) {
    const h = forecast.hours[i];
    const r = scoreHour(h, species, { day, prev: forecast.hours[i - 1], next: forecast.hours[i + 1] });
    out.push({ index: i, hour: h, ...r });
  }
  return out;
}

/** Migliore finestra di len ore consecutive tra quelle date; ok(h) decide se un'ora è ammessa. */
function bestRun(rows, len, ok) {
  let best = null;
  for (let s = 0; s + len <= rows.length; s++) {
    const slice = rows.slice(s, s + len);
    if (slice.some((r) => r.score === null || !ok(r))) continue;
    if (slice.some((r, k) => k > 0 && r.index !== slice[k - 1].index + 1)) continue;
    const mean = avg(slice.map((r) => r.score));
    if (!best || mean > best.mean) best = { rows: slice, mean };
  }
  return best;
}

function findWindow(eligible) {
  const len = Math.min(3, eligible.length);
  for (let l = len; l >= 1; l--) {
    const run = bestRun(eligible, l, (r) => r.safety !== 'danger');
    if (run) return { run, safe: true };
  }
  const any = bestRun(eligible, len, () => true);
  return any ? { run: any, safe: false } : null;
}

const pad2 = (n) => String(n).padStart(2, '0');

/** Etichetta della finestra secondo l'ora centrale: mattina 5-12, pomeriggio 12-17, sera 17-22, notte. */
function windowLabel(startHour, len, isToday) {
  const end = (startHour + len) % 24;
  const mid = (startHour + len / 2) % 24;
  let part;
  if (mid >= 5 && mid < 12) part = 0;
  else if (mid >= 12 && mid < 17) part = 1;
  else if (mid >= 17 && mid < 22) part = 2;
  else part = 3;
  const words = isToday ? ['stamattina', 'oggi', 'stasera', 'stanotte'] : ['mattina', 'pomeriggio', 'sera', 'notte'];
  const overnight = part === 3 || end < startHour;
  const range = overnight ? `${pad2(startHour)}-${pad2(end)}` : `${startHour}-${end}`;
  return `${words[part]} ${range}`;
}

function endTimeOf(hour) {
  const d = new Date(Date.parse(`${hour.time}:00Z`) + HOUR_MS);
  return `${pad2(d.getUTCHours())}:${pad2(d.getUTCMinutes())}`;
}

function mostCommon(list) {
  const counts = new Map();
  for (const v of list) if (v !== null && v !== undefined) counts.set(v, (counts.get(v) || 0) + 1);
  let best = null;
  let n = 0;
  for (const [v, c] of counts) if (c > n) [best, n] = [v, c];
  return best;
}

function windowStats(rows, forecast) {
  const hs = rows.map((r) => r.hour);
  const pick = (k) => hs.map((h) => h[k]).filter(isNum);
  const slopes = rows.map((r) => tideSlope(r.hour, forecast.hours[r.index - 1], forecast.hours[r.index + 1])).filter(isNum);
  const mid = hs[Math.floor(hs.length / 2)];
  return {
    waveM: avg(pick('waveM')),
    periodS: avg(pick('wavePeriodS')),
    phase: mostCommon(hs.map((h) => h.seaPhase)),
    windKmh: avg(pick('windKmh')),
    gustKmh: pick('gustKmh').length ? Math.max(...pick('gustKmh')) : null,
    windDirDeg: mid.windDirDeg,
    incidence: mostCommon(hs.map((h) => h.windIncidence)),
    lights: [...new Set(hs.map((h) => h.light).filter(Boolean))],
    seaTempC: avg(pick('seaTempC')),
    pressureHpa: avg(pick('pressureHpa')),
    trend: avg(pick('pressureTrend3h')),
    tideSlope: avg(slopes),
    time: hs[0].time
  };
}

/* --------------------------------- Testi --------------------------------- */

function rangeJudge(x, { min, optMin, optMax, max }, words) {
  if (x < min) return words[0];
  if (x < optMin) return words[1];
  if (x <= optMax) return words[2];
  if (x < max) return words[3];
  return words[4];
}

const SEA_WORDS = ['troppo poca', "un po' scarsa", 'giusta', "un po' formata", 'troppo formata'];
const WATER_WORDS = ['troppo fredda', "un po' fredda", 'giusta', "un po' calda", 'troppo calda'];
const PHASE_TEXT = { scaduta: 'Mare in scaduta', montante: 'Mare in aumento', stabile: 'Mare stabile' };

function bestMonthsText(months) {
  const top = Math.max(...months);
  const good = months.map((v) => v >= Math.min(0.9, top));
  // la serie è ciclica: si parte dal primo mese buono preceduto da uno non buono
  let start = good.findIndex((g, i) => g && !good[(i + 11) % 12]);
  if (start < 0) return 'tutto l\'anno';
  let end = start;
  while (good[(end + 1) % 12] && (end + 1) % 12 !== start) end = (end + 1) % 12;
  return start === end ? `a ${MONTHS[start]}` : `da ${MONTHS[start]} a ${MONTHS[end]}`;
}

function trendText(t) {
  if (!isNum(t)) return 'tendenza n.d.';
  if (t <= -2) return 'in calo rapido';
  if (t <= -1) return 'in calo';
  if (t >= 1) return 'in aumento';
  return 'stabile';
}

function lightsText(lights) {
  return lights.map((l) => LIGHT_NAMES[l]).join(' e ');
}

function factorTexts(key, value, st, sp, day) {
  const art = withArticle(sp);
  if (value === null) {
    return { title: `${LABELS[key]} n.d.`, detail: 'Dato non disponibile: il suo peso passa agli altri fattori.' };
  }
  switch (key) {
    case 'sea': {
      // Si giudica il valore mostrato (un decimale): 0.83 m letto come "0.8 m" non è "un po' formata"
      const judge = rangeJudge(round(st.waveM, 1), sp.wave, SEA_WORDS);
      const phase = st.phase ? `${PHASE_TEXT[st.phase]}${phaseMultiplier(st.phase, sp) === 1 ? ', la fase che preferisce' : ''}. ` : '';
      let per = '';
      if (isNum(st.periodS)) {
        const fit = st.periodS < sp.period.optMin ? 'onda corta e disordinata' : st.periodS > sp.period.optMax ? 'onda lunga e potente' : 'onda regolare';
        per = `Periodo ${f0(st.periodS)} s, ${fit}. `;
      }
      return {
        title: `Onda ${f1(st.waveM)} m, ${judge} per ${art}`,
        detail: `${phase}${per}Per ${art} va bene da ${sp.wave.optMin} a ${sp.wave.optMax} m.`
      };
    }
    case 'wind': {
      const dir = { onshore: ' dal mare', offshore: ' da terra', cross: ' laterale' }[st.incidence] || '';
      let note = '';
      if (st.windKmh > sp.wind.max) note = ', troppo forte';
      else if (st.windKmh > sp.wind.optMax) note = ", un po' forte";
      else if (windMismatch(st.incidence, sp.windPreference) === 2 && st.windKmh >= 8) note = ', direzione sfavorevole';
      else if (sp.windPreference === 'offshore' && st.incidence === 'offshore' && st.windKmh >= 5) note = ', aiuta il lancio';
      else if (sp.windPreference === 'onshore' && st.incidence === 'onshore' && st.windKmh >= 5) note = ', muove il mare sotto riva';
      const name = windName(st.windDirDeg).name;
      const gust = isNum(st.gustKmh) ? ` con raffiche fino a ${f0(st.gustKmh)} km/h` : '';
      return {
        title: `Vento ${f0(st.windKmh)} km/h${dir}${note}`,
        detail: `${name === 'n.d.' ? 'Direzione n.d.' : name}${gust}. Per ${art} va bene fino a ${sp.wind.optMax} km/h.`
      };
    }
    case 'light': {
      const judge = value >= 0.85 ? 'luce ideale' : value >= 0.6 ? 'luce buona' : 'luce poco adatta';
      const best = Object.entries(sp.light).filter(([, v]) => v >= 0.9).map(([k]) => LIGHT_WHEN[k]);
      return {
        title: `${cap(lightsText(st.lights))}, ${judge} per ${art}`,
        detail: `${cap(art)} rende di più ${best.join(' e ') || LIGHT_WHEN.dusk}.`
      };
    }
    case 'season': {
      const month = MONTHS[Number(st.time.slice(5, 7)) - 1];
      const judge = value >= 0.85 ? 'piena stagione' : value >= 0.6 ? 'buona stagione' : value >= 0.35 ? 'stagione scarsa' : 'fuori stagione';
      const limit = value < 0.6 ? ' In questo periodo il punteggio resta contenuto anche con il mare giusto.' : '';
      return {
        title: `${cap(month)}, ${judge} per ${art}`,
        detail: `Il periodo migliore va ${bestMonthsText(sp.months)}.${limit}`
      };
    }
    case 'water': {
      const judge = rangeJudge(st.seaTempC, sp.waterTemp, WATER_WORDS);
      return {
        title: `Acqua a ${f1(st.seaTempC)} °C, ${judge}`,
        detail: `Per ${art} l'ideale è tra ${sp.waterTemp.optMin} e ${sp.waterTemp.optMax} °C.`
      };
    }
    case 'pressure': {
      const pref = sp.pressure === 'falling'
        ? `Il calo della pressione spesso mette in movimento ${art}.`
        : `${cap(art)} preferisce la pressione stabile.`;
      const delta = isNum(st.trend) ? ` Variazione di ${st.trend > 0 ? '+' : ''}${st.trend.toFixed(1)} hPa in 3 ore.` : '';
      return { title: `Pressione ${f0(st.pressureHpa)} hPa, ${trendText(st.trend)}`, detail: `${pref}${delta}` };
    }
    case 'tide': {
      const s = st.tideSlope;
      const title = s > 0.005 ? 'Marea in salita' : s < -0.005 ? 'Marea in discesa' : 'Marea ferma';
      return { title, detail: "L'acqua che sale porta il pesce verso riva. Il livello viene dal modello: indica il giro di marea, non serve per navigare." };
    }
    case 'moon': {
      const m = day?.moon;
      return {
        title: m ? `${m.phaseName}, illuminata al ${Math.round(m.illuminationPct)}%` : 'Luna',
        detail: 'Per tradizione luna nuova e luna piena portano più movimento. Nel punteggio pesa poco.'
      };
    }
    default:
      return { title: LABELS[key], detail: '' };
  }
}

function buildFactors(rows, st, sp, day) {
  const values = {};
  for (const k of Object.keys(WEIGHTS)) {
    const vs = rows.map((r) => r.parts[k].value).filter(isNum);
    values[k] = vs.length ? avg(vs) : null;
  }
  const wsum = Object.entries(WEIGHTS).reduce((a, [k, w]) => a + (values[k] === null ? 0 : w), 0) || 1;
  return Object.entries(WEIGHTS).map(([key, weight]) => {
    const value = values[key];
    const maxPoints = value === null ? 0 : Math.round((100 * weight) / wsum);
    const impact = value === null ? 'neutral' : value >= 0.75 ? 'positive' : value < 0.45 ? 'negative' : 'neutral';
    return {
      key,
      label: LABELS[key],
      weight,
      value: value === null ? null : round(value, 2),
      points: value === null ? null : Math.round((100 * weight * value) / wsum),
      maxPoints,
      impact,
      ...factorTexts(key, value, st, sp, day)
    };
  });
}

function positivePhrase(f, st, sp, day) {
  switch (f.key) {
    case 'sea': return st.phase === 'scaduta' ? 'scaduta in corso' : 'onda giusta';
    case 'wind': return st.incidence === 'offshore' ? 'vento da terra' : st.incidence === 'onshore' ? 'vento dal mare' : 'vento giusto';
    case 'light': {
      const best = [...st.lights].sort((a, b) => sp.light[b] - sp.light[a])[0];
      return { dawn: "luce dell'alba", dusk: 'luce del tramonto', night: 'ore di buio', day: 'luce del giorno' }[best] || 'luce giusta';
    }
    case 'season': return 'piena stagione';
    case 'water': return `acqua a ${f0(st.seaTempC)} °C`;
    case 'pressure': return isNum(st.trend) && st.trend <= -1 ? 'pressione in calo' : 'pressione stabile';
    case 'tide': return 'marea in salita';
    case 'moon': return day?.moon ? day.moon.phaseName.toLowerCase() : 'luna favorevole';
    default: return '';
  }
}

/**
 * Frase breve sul fattore che pesa di più contro. subj ("l'orata ") si usa dopo "ma",
 * vuoto quando la specie è già nominata nella frase.
 */
function negativeClause(f, st, sp, subj = '') {
  switch (f.key) {
    case 'sea':
      if (isNum(st.waveM) && st.waveM > sp.wave.optMax) return st.waveM >= sp.wave.max ? 'il mare è troppo formato' : "il mare è un po' formato";
      if (isNum(st.waveM) && st.waveM < sp.wave.optMin) return st.waveM <= sp.wave.min ? 'il mare è troppo calmo' : 'il mare è scarso';
      return st.phase === 'montante' ? 'il mare sta montando' : 'il mare non è il migliore';
    case 'wind':
      if (isNum(st.windKmh) && st.windKmh > sp.wind.optMax) return 'il vento è forte';
      return 'il vento gira dalla parte sbagliata';
    case 'light':
      if (st.lights.length === 1 && st.lights[0] === 'night') return `col buio ${subj}rende meno`;
      if (st.lights.length === 1 && st.lights[0] === 'day') return `con la luce del giorno ${subj}rende meno`;
      return 'la luce non aiuta';
    case 'season': return f.value < 0.45 ? `${subj}è fuori stagione` : 'la stagione non è la migliore';
    case 'water': return isNum(st.seaTempC) && st.seaTempC < sp.waterTemp.optMin ? "l'acqua è fredda" : "l'acqua è calda";
    case 'pressure': return 'la pressione non aiuta';
    case 'tide': return 'la marea scende';
    case 'moon': return 'la luna è al quarto';
    default: return 'le condizioni non aiutano';
  }
}

function fit90(...candidates) {
  const s = candidates.find((c) => c.length <= 90);
  return s || `${candidates[candidates.length - 1].slice(0, 89).replace(/\s+\S*$/, '')}.`;
}

/** 'mattina 6-9' → 'di mattina 6-9'; le etichette di oggi ('stasera 18-21') restano come sono. */
function whenText(label) {
  return /^(mattina|pomeriggio|sera|notte) /.test(label) ? `di ${label}` : label;
}

function rankedFactors(factors) {
  const loss = (f) => (WEIGHTS[f.key] + (LIMITERS[f.key] || 0)) * (1 - f.value);
  const known = factors.filter((f) => f.value !== null);
  return {
    pos: known.filter((f) => f.impact === 'positive').sort((a, b) => b.points - a.points),
    neg: known.filter((f) => f.impact !== 'positive').sort((a, b) => loss(b) - loss(a))
  };
}

function buildHeadline({ score, verdict, bestWindow, factors, st, sp, day, safety }) {
  const art = withArticle(sp);
  if (verdict.key === 'pericolo') {
    const why = safety.reasonsText ? `: ${safety.reasonsText.toLowerCase()}` : '';
    return fit90(`Giornata da evitare${why}.`, 'Giornata da evitare: condizioni pericolose da riva.');
  }
  if (score === null) return 'Punteggio non disponibile: mancano i dati del mare.';
  const { pos, neg } = rankedFactors(factors);
  const p = pos.slice(0, 2).map((f) => positivePhrase(f, st, sp, day));
  const n = neg.map((f) => negativeClause(f, st, sp));
  const nSubj = neg.map((f) => negativeClause(f, st, sp, `${art} `));
  const when = bestWindow ? whenText(bestWindow.label) : '';
  const reasons = p.length === 2 ? `${p[0]} e ${p[1]}` : p[0] || 'condizioni nella media';
  switch (verdict.key) {
    case 'ottimo':
      return fit90(`${cap(when)} è il momento giusto: ${reasons}.`, `${cap(when)} è il momento giusto: ${p[0] || reasons}.`);
    case 'buono':
      return fit90(`Buona occasione ${when}: ${reasons}.`, `Buona occasione ${when}: ${p[0] || reasons}.`);
    case 'discreto':
      return fit90(`Si può provare ${when}, ma ${nSubj[0] || 'senza grandi attese'}.`, `Si può provare ${when}, ma ${n[0] || 'senza grandi attese'}.`, `Si può provare ${when}.`);
    default: {
      const first = n[0] || 'le condizioni non aiutano';
      const wait = first === 'il mare è troppo formato' ? ', meglio aspettare che cali' : '';
      return fit90(`Giornata difficile per ${art}: ${first}${wait}.`, `Giornata difficile per ${art}: ${first}.`);
    }
  }
}

/* -------------------------------- Sicurezza del giorno -------------------------------- */

function runsByLevel(rows) {
  const runs = [];
  for (const r of rows) {
    const last = runs[runs.length - 1];
    if (last && last.level === r.safety && last.rows[last.rows.length - 1].index === r.index - 1) last.rows.push(r);
    else runs.push({ level: r.safety, rows: [r] });
  }
  return runs.filter((run) => run.level !== 'ok');
}

function reasonsOf(rows) {
  const hs = rows.map((r) => r.hour);
  const maxOf = (k) => {
    const v = hs.map((h) => h[k]).filter(isNum);
    return v.length ? Math.max(...v) : null;
  };
  const out = [];
  const wave = maxOf('waveM');
  const gust = maxOf('gustKmh');
  const wind = maxOf('windKmh');
  if (wave !== null && wave >= SAFETY.waveCautionM) out.push(`onda ${f1(wave)} m`);
  if (gust !== null && gust >= SAFETY.gustCautionKmh) out.push(`raffiche a ${f0(gust)} km/h`);
  if (wind !== null && wind >= SAFETY.windCautionKmh) out.push(`vento a ${f0(wind)} km/h`);
  if (rows.some((r) => r.safetyReasons.some((s) => s.startsWith('Temporale')))) out.push('temporali');
  return out;
}

function joinIt(list) {
  if (list.length <= 1) return list[0] || '';
  return `${list.slice(0, -1).join(', ')} e ${list[list.length - 1]}`;
}

function buildSafety(eligible) {
  const runs = runsByLevel(eligible);
  const alerts = runs.map((run) => ({
    level: run.level,
    fromTime: run.rows[0].hour.time.slice(11, 16),
    toTime: endTimeOf(run.rows[run.rows.length - 1].hour),
    text: cap(joinIt(reasonsOf(run.rows))) || 'Condizioni impegnative'
  }));
  const dangerRows = eligible.filter((r) => r.safety === 'danger');
  const cautionRows = eligible.filter((r) => r.safety === 'caution');
  const capitaneria = 'controlla gli avvisi della Capitaneria';
  if (dangerRows.length) {
    const reasons = cap(joinIt(reasonsOf(dangerRows)));
    if (dangerRows.length === eligible.length) {
      return {
        level: 'danger',
        alerts,
        reasonsText: reasons,
        text: `${reasons}: non è giornata. Resta lontano dal bagnasciuga e ${capitaneria}.`
      };
    }
    const first = alerts.find((a) => a.level === 'danger');
    const more = alerts.filter((a) => a.level === 'danger').length > 1 ? ' e in altre ore' : '';
    return {
      level: 'danger',
      alerts,
      reasonsText: reasons,
      text: `${reasons} dalle ${first.fromTime} alle ${first.toTime}${more}: in quelle ore resta lontano dal bagnasciuga e ${capitaneria}.`
    };
  }
  if (cautionRows.length) {
    const reasons = cap(joinIt(reasonsOf(cautionRows)));
    return {
      level: 'caution',
      alerts,
      reasonsText: reasons,
      text: `${reasons}: mare impegnativo. Tieni l'attrezzatura lontana dalla risacca, non entrare in acqua e ${capitaneria}.`
    };
  }
  return {
    level: 'ok',
    alerts,
    reasonsText: '',
    text: `Nessuna soglia di sicurezza superata. Prima di uscire ${capitaneria}.`
  };
}

/* ---------------------------------- Giornata ---------------------------------- */

function missingData(forecast, eligible) {
  const out = [];
  if (!forecast.has.marine) out.push("dati del mare (onda, temperatura dell'acqua, marea)");
  if (!forecast.has.weather) out.push('dati meteo (vento, pressione, temporali)');
  if (forecast.has.marine && !forecast.has.seaTemp) out.push("temperatura dell'acqua");
  if (forecast.has.marine && !forecast.has.seaLevel) out.push('livello del mare (marea)');
  if (forecast.has.marine && eligible.length && eligible.every((r) => !isNum(r.hour.waveM))) out.push("altezza dell'onda in questa giornata");
  return out;
}

function confidenceFor(forecast, refRow) {
  if (!forecast.has.weather || !forecast.has.marine) return 'bassa';
  const nowHour = forecast.hours[forecast.nowIndex] || forecast.hours[0];
  const lead = refRow && nowHour ? (refRow.hour.epochMs - nowHour.epochMs) / HOUR_MS : 0;
  let level = lead <= 48 ? 'alta' : lead <= 96 ? 'media' : 'bassa';
  if (level === 'alta' && (!forecast.has.seaTemp || !forecast.has.seaLevel)) level = 'media';
  return level;
}

/** Valutazione di una giornata di pesca per una specie (DayEvaluation). */
export function evaluateDay(forecast, dayIndex, species) {
  const day = forecast.days[dayIndex];
  const rows = scoreRange(forecast, day, species);
  const firstEligible = forecast.nowIndex >= 0 ? Math.max(day.startIndex, forecast.nowIndex) : day.startIndex;
  const eligible = rows.filter((r) => r.index >= firstEligible);
  const found = findWindow(eligible);
  const safety = buildSafety(eligible);
  const todayDate = forecast.hours[forecast.nowIndex]?.time.slice(0, 10);
  const isToday = dayIndex === 0 || day.date === todayDate;

  let score = null;
  let bestWindow = null;
  if (found) {
    score = Math.round(found.run.mean);
    if (found.safe) {
      const r = found.run.rows;
      bestWindow = {
        startIndex: r[0].index,
        endIndex: r[r.length - 1].index + 1,
        startTime: r[0].hour.time.slice(11, 16),
        endTime: endTimeOf(r[r.length - 1].hour),
        score,
        label: windowLabel(Number(r[0].hour.time.slice(11, 13)), r.length, isToday)
      };
    }
  }
  const verdict = verdictFor(score, found && !found.safe ? 'danger' : bestWindow ? 'ok' : safety.level === 'danger' ? 'danger' : 'ok');
  const refRows = found ? found.run.rows : eligible.length ? eligible : rows;
  const st = windowStats(refRows, forecast);
  const factors = buildFactors(refRows, st, species, day);
  const headline = buildHeadline({ score, verdict, bestWindow, factors, st, sp: species, day, safety });
  const { reasonsText, ...safetyOut } = safety;
  return {
    dayIndex,
    date: day.date,
    score,
    verdict,
    bestWindow,
    hourly: rows.map((r) => ({ index: r.index, time: r.hour.time, score: r.score, safety: r.safety })),
    safety: safetyOut,
    factors,
    headline,
    confidence: confidenceFor(forecast, refRows[0]),
    missing: missingData(forecast, eligible)
  };
}

/** Una DayEvaluation per ogni giornata della previsione. */
export function evaluateForecast(forecast, species) {
  if (!forecast || !species) return [];
  return forecast.days.map((_, i) => evaluateDay(forecast, i, species));
}
