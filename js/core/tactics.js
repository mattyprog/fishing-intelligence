/**
 * Consigli pratici per la giornata: piombo, canne adatte, terminale, esche, dove e quando.
 * Modulo puro: lavora su valutazione, previsione e attrezzatura già caricate.
 */

const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
const cap = (s) => (s ? s.charAt(0).toUpperCase() + s.slice(1) : s);
const avg = (list) => (list.length ? list.reduce((a, b) => a + b, 0) / list.length : null);

// Oltre questa onda si passa al terminale da mare mosso
const ROUGH_SEA_M = 0.7;

/** Piombo per altezza e periodo dell'onda; null se l'onda non è nota. */
export function recommendedLead(waveM, periodS) {
  if (!isNum(waveM)) return null;
  if (waveM >= 1.35 || (waveM >= 1.0 && isNum(periodS) && periodS >= 7)) {
    return { grams: 150, shape: 'piramide o spike, per tenere il fondo con la corrente forte' };
  }
  if (waveM >= 0.85) return { grams: 130, shape: 'piramide o cono, ad alta tenuta' };
  if (waveM >= 0.45) return { grams: 110, shape: 'piramide leggera, a tenuta media' };
  return { grams: 85, shape: 'ogiva o siluro, per lanciare lontano con il mare calmo' };
}

function referenceHours(evaluation, forecast) {
  if (!forecast?.hours) return [];
  const w = evaluation?.bestWindow;
  if (w) return forecast.hours.slice(w.startIndex, w.endIndex);
  const day = forecast.days?.[evaluation?.dayIndex ?? 0];
  return day ? forecast.hours.slice(day.startIndex, day.endIndex) : [];
}

function isUsableRod(g) {
  return (g?.category === 'canna_surf' || g?.category === 'canna_fondo')
    && g.status !== 'manutenzione'
    && isNum(g.min_cast_g) && isNum(g.max_cast_g);
}

function rodsFor(gear, leadG) {
  if (!isNum(leadG)) return { ok: [], overloaded: [] };
  const rods = (Array.isArray(gear) ? gear : []).filter(isUsableRod);
  return {
    ok: rods.filter((r) => r.min_cast_g <= leadG + 15 && r.max_cast_g >= leadG),
    overloaded: rods.filter((r) => r.max_cast_g < leadG)
  };
}

const SYNONYMS = [[/\bmug+ine\b/g, 'cefalo'], [/\bbloodworm\b/g, 'americano'], [/\bkoreano\b/g, 'coreano']];

function norm(str) {
  let s = String(str || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  for (const [re, to] of SYNONYMS) s = s.replace(re, to);
  return s.replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();
}

function sameBait(wanted, ownedName) {
  const a = norm(wanted);
  const b = norm(ownedName);
  if (!a || !b) return false;
  if (b.includes(a) || a.includes(b)) return true;
  const first = b.split(' ')[0];
  return first.length >= 4 && a.split(' ').includes(first);
}

function baitsFor(species, baits) {
  const owned = (Array.isArray(baits) ? baits : []).filter((b) => b && b.available && Number(b.quantity) > 0);
  const list = species.baits.map((name) => ({ name, have: owned.some((b) => sameBait(name, b.name)) }));
  // Esche dell'utente indicate per questa specie che non sono già in elenco
  for (const b of owned) {
    const targets = Array.isArray(b.target_species) ? b.target_species : [];
    if (targets.includes(species.id) && !list.some((x) => sameBait(x.name, b.name))) list.push({ name: b.name, have: true });
  }
  return list;
}

/**
 * @returns {{ when: string, rig: string, lead: {grams:number|null, shape:string|null},
 *   rods: {ok: object[], overloaded: object[]}, baits: {name:string, have:boolean}[], where: string }}
 */
export function buildTactics({ evaluation, forecast, species, spot, gear = [], baits = [] }) {
  const hours = referenceHours(evaluation, forecast);
  const waveM = avg(hours.map((h) => h.waveM).filter(isNum));
  const periodS = avg(hours.map((h) => h.wavePeriodS).filter(isNum));
  const lead = recommendedLead(waveM, periodS) || { grams: null, shape: null };

  let rig;
  if (waveM === null) rig = `Onda n.d. Con il mare calmo: ${species.tactics.rigCalm} Con il mare mosso: ${species.tactics.rigRough}`;
  else rig = waveM >= ROUGH_SEA_M ? species.tactics.rigRough : species.tactics.rigCalm;

  let when;
  if (evaluation?.bestWindow) when = `${cap(evaluation.bestWindow.label)}. ${species.tactics.when}`;
  else if (evaluation?.verdict?.key === 'pericolo') when = `In questa giornata non ci sono ore sicure: aspetta che il mare cali. ${species.tactics.when}`;
  else when = species.tactics.when;

  const seabed = spot?.seabed_type ? ` Fondale dello spot: ${String(spot.seabed_type).toLowerCase()}.` : '';
  return {
    when,
    rig,
    lead,
    rods: rodsFor(gear, lead.grams),
    baits: baitsFor(species, baits),
    where: `${species.tactics.where}${seabed}`
  };
}
