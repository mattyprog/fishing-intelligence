import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fmtNum, windName, seaStateLabel, weatherLabel } from '../js/core/format.js';
import { SPECIES, CATCH_SPECIES, REGULATIONS, getSpecies, legalSizeFor } from '../js/core/species.js';
import { buildTactics, recommendedLead } from '../js/core/tactics.js';
import { evaluateCasting } from '../js/core/casting.js';
import { computeCatchStats, computeInsights } from '../js/core/stats.js';
import { buildForecast } from '../js/core/forecast.js';
import { evaluateForecast } from '../js/core/scoring.js';
import { PREDEFINED_SPOTS } from '../js/core/spots.js';
import { ICON_NAMES } from '../js/ui/icons.js';

const load = (name) => JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8'));
const SPOT = PREDEFINED_SPOTS.find((s) => s.id === 'salto-di-fondi');
const FORECAST = buildForecast({
  weather: load('open-meteo-weather.json'),
  marine: load('open-meteo-marine.json'),
  spot: SPOT,
  now: Date.UTC(2026, 10, 19, 16, 15)
});

/* --------------------------------- format --------------------------------- */

test('fmtNum: decimali fissi, n.d. se manca', () => {
  assert.equal(fmtNum(0.6, 1), '0.6');
  assert.equal(fmtNum(12), '12');
  assert.equal(fmtNum(1018.26, 0), '1018');
  assert.equal(fmtNum(0, 1), '0.0');
  assert.equal(fmtNum(null, 1), 'n.d.');
  assert.equal(fmtNum(undefined), 'n.d.');
  assert.equal(fmtNum(NaN), 'n.d.');
});

test('windName: 16 punti cardinali con O e nomi italiani dei venti', () => {
  const cases = [
    [0, 'N', 'Tramontana'], [45, 'NE', 'Grecale'], [90, 'E', 'Levante'], [135, 'SE', 'Scirocco'],
    [180, 'S', 'Ostro'], [225, 'SO', 'Libeccio'], [270, 'O', 'Ponente'], [315, 'NO', 'Maestrale'],
    [359, 'N', 'Tramontana'], [202, 'SSO', 'Ostro'], [240, 'OSO', 'Libeccio'], [250, 'OSO', 'Ponente'], [290, 'ONO', 'Ponente'], [-90, 'O', 'Ponente'], [720, 'N', 'Tramontana']
  ];
  for (const [deg, cardinal, name] of cases) assert.deepEqual(windName(deg), { cardinal, name }, String(deg));
  assert.deepEqual(windName(null), { cardinal: 'n.d.', name: 'n.d.' });
});

test('seaStateLabel: scala Douglas con soglie 0.1, 0.5, 1.25, 2.5 m', () => {
  assert.equal(seaStateLabel(0), 'calmo');
  assert.equal(seaStateLabel(0.08), 'quasi calmo');
  assert.equal(seaStateLabel(0.1), 'quasi calmo');
  assert.equal(seaStateLabel(0.3), 'poco mosso');
  assert.equal(seaStateLabel(0.5), 'poco mosso');
  assert.equal(seaStateLabel(0.9), 'mosso');
  assert.equal(seaStateLabel(1.25), 'mosso');
  assert.equal(seaStateLabel(2.4), 'molto mosso');
  assert.equal(seaStateLabel(3), 'agitato');
  assert.equal(seaStateLabel(4.5), 'agitato');
  assert.equal(seaStateLabel(null), 'n.d.');
});

test('weatherLabel: etichette italiane e solo icone ammesse', () => {
  const allowed = ['sun', 'cloud-sun', 'cloud', 'fog', 'rain', 'bolt'];
  for (const code of [0, 1, 2, 3, 45, 48, 51, 53, 55, 56, 57, 61, 63, 65, 66, 67, 71, 73, 75, 77, 80, 81, 82, 85, 86, 95, 96, 99]) {
    const w = weatherLabel(code);
    assert.ok(allowed.includes(w.icon), `${code} → ${w.icon}`);
    assert.ok(ICON_NAMES.includes(w.icon));
    assert.ok(w.label.length > 2 && w.label !== 'n.d.', String(code));
  }
  assert.deepEqual(weatherLabel(0), { label: 'Sereno', icon: 'sun' });
  assert.equal(weatherLabel(95).icon, 'bolt');
  assert.equal(weatherLabel(45).icon, 'fog');
  assert.equal(weatherLabel(63).icon, 'rain');
  assert.equal(weatherLabel(null).label, 'n.d.');
  assert.equal(weatherLabel(1234).label, 'n.d.');
});

/* --------------------------------- species --------------------------------- */

test('SPECIES: 6 profili completi e coerenti', () => {
  assert.deepEqual(SPECIES.map((s) => s.id), ['orata', 'sarago', 'mormora', 'spigola', 'ombrina', 'serra']);
  assert.deepEqual(SPECIES.map((s) => s.short), ['OR', 'SA', 'MO', 'SP', 'OM', 'PS']);
  for (const s of SPECIES) {
    assert.ok(s.name && s.scientificName && s.summary, s.id);
    const w = s.wave;
    assert.ok(w.min <= w.optMin && w.optMin < w.optMax && w.optMax <= w.max, `${s.id} onda`);
    assert.ok(s.period.optMin < s.period.optMax);
    assert.ok(s.wind.optMin < s.wind.optMax && s.wind.optMax < s.wind.max);
    assert.ok(['onshore', 'offshore', 'any'].includes(s.windPreference));
    assert.deepEqual(Object.keys(s.seaPhase).sort(), ['montante', 'scaduta', 'stabile']);
    for (const v of Object.values(s.seaPhase)) assert.ok(v >= -0.15 && v <= 0.15);
    const t = s.waterTemp;
    assert.ok(t.min < t.optMin && t.optMin < t.optMax && t.optMax < t.max);
    assert.equal(s.months.length, 12);
    for (const v of s.months) assert.ok(v >= 0 && v <= 1);
    assert.deepEqual(Object.keys(s.light).sort(), ['dawn', 'day', 'dusk', 'night']);
    assert.ok(['falling', 'stable'].includes(s.pressure));
    assert.ok(s.baits.length >= 3);
    for (const k of ['rigCalm', 'rigRough', 'where', 'when']) assert.ok(s.tactics[k].length > 10);
    assert.ok(Object.isFrozen(s));
  }
  assert.equal(getSpecies('ombrina').minLegalSizeCm, null);
  assert.equal(getSpecies('serra').minLegalSizeCm, null);
  assert.equal(getSpecies('spigola').minLegalSizeCm, 25);
  assert.equal(getSpecies('nessuna'), null);
});

test('testi delle specie nello stile richiesto', () => {
  for (const s of SPECIES) {
    for (const t of [s.summary, ...Object.values(s.tactics)]) {
      assert.doesNotMatch(t, /[!&—–]/, t);
      assert.doesNotMatch(t, /\b[A-Z]{4,}\b/, t);
    }
  }
});

test('taglie minime e regole con le fonti', () => {
  assert.equal(CATCH_SPECIES.length, 18);
  assert.ok(CATCH_SPECIES.some((s) => s.id === 'altro' && s.minLegalSizeCm === null));
  assert.deepEqual(legalSizeFor('orata'), { cm: 20, source: 'Reg. (UE) 2019/1241, allegato IX' });
  assert.equal(legalSizeFor('Sarago maggiore').cm, 23);
  assert.equal(legalSizeFor('branzino').cm, 25);
  assert.equal(legalSizeFor('SPARAGLIONE').cm, 12);
  assert.equal(legalSizeFor('Pagello fragolino').cm, 15);
  assert.equal(legalSizeFor('sarago testa nera').cm, 18);
  assert.equal(legalSizeFor('Triglia').cm, 11);
  assert.equal(legalSizeFor('ombrina'), null);
  assert.equal(legalSizeFor('pesce serra'), null);
  assert.equal(legalSizeFor('pesce sconosciuto'), null);
  assert.equal(legalSizeFor(''), null);
  assert.equal(REGULATIONS.dailyLimitKg, 5);
  assert.equal(REGULATIONS.maxHooksPerRod, 3);
  assert.equal(REGULATIONS.sources.length, 3);
  for (const s of REGULATIONS.sources) assert.match(s.url, /^https:\/\//);
  assert.ok(REGULATIONS.sources.some((s) => /1639\/1968/.test(s.label) && /142/.test(s.label) && /138/.test(s.label)));
});

/* --------------------------------- tactics --------------------------------- */

test('piombo consigliato per altezza e periodo dell\'onda', () => {
  assert.equal(recommendedLead(0.3, 5).grams, 85);
  assert.equal(recommendedLead(0.45, 5).grams, 110);
  assert.equal(recommendedLead(0.84, 6).grams, 110);
  assert.equal(recommendedLead(0.85, 6).grams, 130);
  assert.equal(recommendedLead(1.0, 6.9).grams, 130);
  assert.equal(recommendedLead(1.0, 7).grams, 150);
  assert.equal(recommendedLead(1.35, 5).grams, 150);
  assert.match(recommendedLead(1.5, 8).shape, /piramide/);
  assert.equal(recommendedLead(null, 6), null);
});

const GEAR = [
  { client_id: 'a', category: 'canna_surf', name: 'Surf pesante', min_cast_g: 100, max_cast_g: 200, status: 'pronta' },
  { client_id: 'b', category: 'canna_fondo', name: 'Leggera', min_cast_g: 40, max_cast_g: 110, status: 'pronta' },
  { client_id: 'c', category: 'canna_surf', name: 'Media', min_cast_g: 80, max_cast_g: 160, status: 'riserva' },
  { client_id: 'd', category: 'canna_surf', name: 'Rotta', min_cast_g: 80, max_cast_g: 160, status: 'manutenzione' },
  { client_id: 'e', category: 'canna_surf', name: 'Senza dati', min_cast_g: null, max_cast_g: null, status: 'pronta' },
  { client_id: 'f', category: 'mulinello_filo', name: 'Mulinello', min_cast_g: 50, max_cast_g: 200, status: 'pronta' },
  { client_id: 'g', category: 'canna_surf', name: 'Pesantissima', min_cast_g: 150, max_cast_g: 250, status: 'pronta' }
];

const BAITS = [
  { client_id: 'b1', name: 'Americano (Bloodworm)', quantity: 3, available: true, target_species: ['orata'] },
  { client_id: 'b2', name: 'Bibi', quantity: 0, available: true, target_species: ['orata'] },
  { client_id: 'b3', name: 'Cannolicchio fresco', quantity: 1, available: false, target_species: ['orata'] },
  { client_id: 'b4', name: 'Sarda / Trancio di Mugine', quantity: 2, available: true, target_species: ['spigola', 'serra'] },
  { client_id: 'b5', name: 'Vermi di rimessa', quantity: 2, available: true, target_species: ['orata'] }
];

function evalFor(id) {
  return evaluateForecast(FORECAST, getSpecies(id));
}

test('buildTactics: canne compatibili, esche incrociate, terminale, dove e quando', () => {
  const ev = evalFor('orata').find((e) => e.date === '2026-11-24');
  const t = buildTactics({ evaluation: ev, forecast: FORECAST, species: getSpecies('orata'), spot: SPOT, gear: GEAR, baits: BAITS });
  const hs = FORECAST.hours.slice(ev.bestWindow.startIndex, ev.bestWindow.endIndex);
  const wave = hs.reduce((a, h) => a + h.waveM, 0) / hs.length;
  assert.equal(t.lead.grams, recommendedLead(wave, hs.reduce((a, h) => a + h.wavePeriodS, 0) / hs.length).grams);
  const g = t.lead.grams;
  const okNames = t.rods.ok.map((r) => r.name);
  for (const r of t.rods.ok) assert.ok(r.min_cast_g <= g + 15 && r.max_cast_g >= g);
  assert.ok(!okNames.includes('Rotta') && !okNames.includes('Senza dati') && !okNames.includes('Mulinello'));
  for (const r of t.rods.overloaded) assert.ok(r.max_cast_g < g);
  const baits = Object.fromEntries(t.baits.map((b) => [b.name, b.have]));
  assert.equal(baits.Americano, true);
  assert.equal(baits.Bibi, false); // quantità zero
  assert.equal(baits.Cannolicchio, false); // non disponibile
  assert.equal(baits['Vermi di rimessa'], true); // esca dell'utente indicata per l'orata
  assert.equal(t.rig, wave >= 0.7 ? getSpecies('orata').tactics.rigRough : getSpecies('orata').tactics.rigCalm);
  assert.match(t.where, /sabbia media/);
  assert.ok(t.when.startsWith(ev.bestWindow.label.charAt(0).toUpperCase()));
});

test('buildTactics: mare formato, giornata pericolosa e dati mancanti', () => {
  const t150 = buildTactics({
    evaluation: { dayIndex: 0, bestWindow: { startIndex: 0, endIndex: 1, label: 'oggi 14-17' } },
    forecast: { hours: [{ waveM: 1.4, wavePeriodS: 8 }], days: [] },
    species: getSpecies('sarago'), spot: null, gear: GEAR, baits: BAITS
  });
  assert.equal(t150.lead.grams, 150);
  assert.deepEqual(t150.rods.ok.map((r) => r.name), ['Surf pesante', 'Media', 'Pesantissima']);
  assert.deepEqual(t150.rods.overloaded.map((r) => r.name), ['Leggera']);
  assert.equal(t150.rig, getSpecies('sarago').tactics.rigRough);
  const spigola = buildTactics({ evaluation: null, forecast: null, species: getSpecies('spigola'), spot: null, gear: [], baits: BAITS });
  assert.deepEqual(spigola.lead, { grams: null, shape: null });
  assert.deepEqual(spigola.rods, { ok: [], overloaded: [] });
  assert.match(spigola.rig, /Onda n\.d\./);
  const sb = Object.fromEntries(spigola.baits.map((b) => [b.name, b.have]));
  assert.equal(sb.Sarda, true);
  assert.equal(sb['Trancio di cefalo'], true); // mugine = cefalo
  const danger = buildTactics({ evaluation: evalFor('orata')[0], forecast: FORECAST, species: getSpecies('orata'), spot: SPOT, gear: GEAR, baits: [] });
  assert.match(danger.when, /non ci sono ore sicure/);
  assert.equal(danger.lead.grams, 150);
});

/* --------------------------------- casting --------------------------------- */

test('evaluateCasting: stati del carico', () => {
  const rod = { min_cast_g: 100, max_cast_g: 200, shock_leader_mm: 0.5 };
  assert.equal(evaluateCasting({ rod, leadG: 150, baitG: 20 }).status, 'ok');
  const limit = evaluateCasting({ rod, leadG: 170, baitG: 15 });
  assert.equal(limit.status, 'limit');
  assert.equal(limit.totalG, 185);
  assert.equal(limit.loadPct, 93);
  assert.equal(evaluateCasting({ rod, leadG: 190, baitG: 15 }).status, 'overload');
  assert.equal(evaluateCasting({ rod, leadG: 80, baitG: 10 }).status, 'underload');
  assert.equal(evaluateCasting({ rod: { min_cast_g: null, max_cast_g: null }, leadG: 100, baitG: 10 }).status, 'unknown');
  assert.equal(evaluateCasting({ rod: null, leadG: 100, baitG: 10 }).status, 'unknown');
  const noBait = evaluateCasting({ rod, leadG: 150, baitG: null });
  assert.equal(noBait.totalG, 150);
  assert.match(noBait.advice, /esca non indicato/);
  for (const r of [limit, noBait]) {
    assert.ok(r.title && r.advice);
    assert.doesNotMatch(`${r.title} ${r.advice} ${r.leader.text}`, /[!&—–]/);
  }
});

test('evaluateCasting: shock leader da 105 g almeno 0.45 mm, da 135 g almeno 0.50 mm', () => {
  const thin = { min_cast_g: 80, max_cast_g: 200, shock_leader_mm: 0.45 };
  const a = evaluateCasting({ rod: thin, leadG: 130, baitG: 10 });
  assert.equal(a.leader.requiredMm, 0.5);
  assert.equal(a.leader.ok, false);
  const b = evaluateCasting({ rod: thin, leadG: 100, baitG: 10 });
  assert.equal(b.leader.requiredMm, 0.45);
  assert.equal(b.leader.ok, true);
  const c = evaluateCasting({ rod: thin, leadG: 85, baitG: 10 });
  assert.equal(c.leader.requiredMm, null);
  const d = evaluateCasting({ rod: { min_cast_g: 80, max_cast_g: 200 }, leadG: 150, baitG: 0 });
  assert.equal(d.leader.ok, null);
  assert.match(d.leader.text, /0\.50 mm/);
});

/* --------------------------------- stats --------------------------------- */

const C = (o) => ({ species: 'Orata', weight_g: null, length_cm: 30, bait_used: 'Bibi', location_name: 'Salto di Fondi', released: false, is_demo: false, weather_snapshot: {}, ...o });

test('computeCatchStats: pesi mancanti gestiti, record, preferiti', () => {
  assert.deepEqual(computeCatchStats([]), {
    count: 0, totalWeightKg: null, avgWeightG: null, record: null,
    topSpot: null, topSpotCount: 0, topBait: null, topBaitCount: 0, released: 0
  });
  const list = [
    C({ weight_g: 1200 }), C({ weight_g: null, length_cm: 45 }), C({ weight_g: 800, bait_used: 'Americano', released: true }),
    C({ weight_g: 0, location_name: 'Sperlonga' })
  ];
  const s = computeCatchStats(list);
  assert.equal(s.count, 4);
  assert.equal(s.totalWeightKg, 2);
  assert.equal(s.avgWeightG, 1000);
  assert.equal(s.record.weight_g, 1200);
  assert.equal(s.topSpot, 'Salto di Fondi');
  assert.equal(s.topSpotCount, 3);
  assert.equal(s.topBait, 'Bibi');
  assert.equal(s.topBaitCount, 3);
  assert.equal(s.released, 1);
  const onlyLength = computeCatchStats([C({ length_cm: 30 }), C({ length_cm: 41 })]);
  assert.equal(onlyLength.totalWeightKg, null);
  assert.equal(onlyLength.record.length_cm, 41);
});

test('computeInsights: solo con almeno 5 catture reali, i dimostrativi non contano', () => {
  const demo = Array.from({ length: 10 }, () => C({ is_demo: true, weather_snapshot: { light: 'dusk' } }));
  const real = Array.from({ length: 4 }, () => C({ weather_snapshot: { light: 'night', waveHeightM: 0.6, seaPhase: 'scaduta' } }));
  assert.deepEqual(computeInsights([...demo, ...real]), []);
  const five = [...real, C({ species: 'Sarago maggiore', released: true, weather_snapshot: { light: 'night' } }), ...demo];
  const ins = computeInsights(five);
  assert.ok(ins.length >= 3);
  const text = ins.map((i) => `${i.title}: ${i.text}`).join('\n');
  assert.match(text, /Orata: 4 catture su 5/);
  assert.match(text, /di notte/);
  assert.match(text, /mare mosso/);
  assert.match(text, /scaduta/);
  assert.match(text, /un pesce su 5/);
  assert.doesNotMatch(text, /tramonto/); // il tramonto viene solo dai dimostrativi
  for (const i of ins) assert.doesNotMatch(`${i.title} ${i.text}`, /[!&—–]|undefined|NaN/);
});
