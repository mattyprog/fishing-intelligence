/**
 * Statistiche e osservazioni sul diario delle catture. Modulo puro.
 * Le osservazioni (insight) usano solo catture reali: i record dimostrativi (is_demo) sono esclusi.
 */

import { seaStateLabel } from './format.js';

const MIN_REAL_CATCHES = 5;
const MIN_SAMPLE = 3;

const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
const clean = (s) => (typeof s === 'string' ? s.trim() : '');

const LIGHT_WHEN = { dawn: "all'alba", day: 'di giorno', dusk: 'al tramonto', night: 'di notte' };
const PHASE_WITH = { scaduta: 'con il mare in scaduta', montante: 'con il mare in aumento', stabile: 'con il mare stabile' };

function weightOf(c) {
  return isNum(c?.weight_g) && c.weight_g > 0 ? c.weight_g : null;
}

/** Valore più frequente → { name, count } (a parità vince il primo incontrato), null se nessuno. */
function topOf(list, keyFn) {
  const counts = new Map();
  for (const item of list) {
    const k = keyFn(item);
    if (k) counts.set(k, (counts.get(k) || 0) + 1);
  }
  let best = null;
  for (const [name, count] of counts) if (!best || count > best.count) best = { name, count };
  return best;
}

function recordOf(list) {
  const withWeight = list.filter((c) => weightOf(c) !== null);
  if (withWeight.length) return withWeight.reduce((a, b) => (weightOf(b) > weightOf(a) ? b : a));
  const withLength = list.filter((c) => isNum(c?.length_cm) && c.length_cm > 0);
  if (withLength.length) return withLength.reduce((a, b) => (b.length_cm > a.length_cm ? b : a));
  return null;
}

/**
 * topSpot e topBait sono i nomi più frequenti (stringhe), con il conteggio a parte.
 * @returns {{ count:number, totalWeightKg:number|null, avgWeightG:number|null, record:object|null,
 *   topSpot:string|null, topSpotCount:number, topBait:string|null, topBaitCount:number, released:number }}
 */
export function computeCatchStats(catches) {
  const list = Array.isArray(catches) ? catches.filter(Boolean) : [];
  const weights = list.map(weightOf).filter((w) => w !== null);
  const total = weights.reduce((a, b) => a + b, 0);
  const spot = topOf(list, (c) => clean(c.location_name) || clean(c.spot_id));
  const bait = topOf(list, (c) => clean(c.bait_used));
  return {
    count: list.length,
    totalWeightKg: weights.length ? Math.round(total / 10) / 100 : null,
    avgWeightG: weights.length ? Math.round(total / weights.length) : null,
    record: recordOf(list),
    topSpot: spot ? spot.name : null,
    topSpotCount: spot ? spot.count : 0,
    topBait: bait ? bait.name : null,
    topBaitCount: bait ? bait.count : 0,
    released: list.filter((c) => c.released === true).length
  };
}

function snapshotTop(list, key, map) {
  const values = list.map((c) => map(c.weather_snapshot?.[key])).filter(Boolean);
  if (values.length < MIN_SAMPLE) return null;
  const top = topOf(values, (v) => v);
  return top ? { ...top, sample: values.length } : null;
}

/** Osservazioni semplici sul diario, solo con almeno 5 catture reali. */
export function computeInsights(catches) {
  const real = (Array.isArray(catches) ? catches : []).filter((c) => c && c.is_demo !== true);
  if (real.length < MIN_REAL_CATCHES) return [];
  const out = [];
  const n = real.length;

  const species = topOf(real, (c) => clean(c.species));
  if (species && species.count >= 2) {
    out.push({ title: 'La specie che prendi di più', text: `${species.name}: ${species.count} catture su ${n}.` });
  }
  const bait = topOf(real, (c) => clean(c.bait_used));
  if (bait && bait.count >= 2) {
    out.push({ title: "L'esca che rende di più", text: `${bait.name}: ${bait.count} catture su ${n}.` });
  }
  const light = snapshotTop(real, 'light', (v) => (LIGHT_WHEN[v] ? v : null));
  if (light && light.count >= 2) {
    out.push({ title: 'Il momento migliore', text: `${light.count} catture su ${light.sample} sono arrivate ${LIGHT_WHEN[light.name]}.` });
  }
  const sea = snapshotTop(real, 'waveHeightM', (v) => (isNum(v) ? seaStateLabel(v) : null));
  if (sea && sea.count >= 2) {
    out.push({ title: 'Il mare che ti porta pesce', text: `${sea.count} catture su ${sea.sample} con mare ${sea.name}.` });
  }
  const phase = snapshotTop(real, 'seaPhase', (v) => (PHASE_WITH[v] ? v : null));
  if (phase && phase.count >= 2) {
    out.push({ title: 'La fase del mare', text: `${phase.count} catture su ${phase.sample} ${PHASE_WITH[phase.name]}.` });
  }
  const spot = topOf(real, (c) => clean(c.location_name));
  if (spot && spot.count >= 2) {
    out.push({ title: 'Lo spot più produttivo', text: `${spot.name}: ${spot.count} catture su ${n}.` });
  }
  const released = real.filter((c) => c.released === true).length;
  if (released > 0) {
    out.push({ title: 'Rilasci', text: `Hai rilasciato ${released === 1 ? 'un pesce' : `${released} pesci`} su ${n}.` });
  }
  return out;
}
