import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { WEIGHTS, scoreHour, evaluateDay, evaluateForecast, verdictFor } from '../js/core/scoring.js';
import { buildForecast, localToEpoch, epochToLocal } from '../js/core/forecast.js';
import { SPECIES, getSpecies } from '../js/core/species.js';
import { PREDEFINED_SPOTS } from '../js/core/spots.js';

const load = (name) => JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8'));
const WEATHER = load('open-meteo-weather.json');
const MARINE = load('open-meteo-marine.json');
const SPOT = PREDEFINED_SPOTS.find((s) => s.id === 'salto-di-fondi');
const NOW = Date.UTC(2026, 10, 19, 16, 15);
const HOUR = 3600000;

/** Ora sintetica costruita a mano: ogni campo non indicato è un valore neutro e dichiarato. */
function hour(over = {}) {
  const h = {
    time: '2026-09-28T19:00',
    airTempC: 21, precipMm: 0, precipProb: 0, weatherCode: 1, cloudCover: 20,
    windKmh: 10, gustKmh: 16, windDirDeg: 30, pressureHpa: 1018, pressureTrend3h: 0,
    waveM: 0.5, wavePeriodS: 6, waveDirDeg: 210, windWaveM: null, swellM: null, swellPeriodS: null,
    seaTempC: 23, seaLevelM: null, currentKmh: null,
    seaPhase: 'stabile', light: 'dusk', windIncidence: 'offshore',
    ...over
  };
  h.epochMs = localToEpoch(h.time, 7200);
  return h;
}

const score = (id, h, opts) => scoreHour(h, getSpecies(id), opts);

// Scenario (a): orata, fine settembre, onda 0.5 m e 6 s, vento 10 km/h da terra, tramonto, acqua 23, pressione stabile
const SCENARIO_A = hour();
// Scenario (d): sarago, fine novembre, 1.2 m e 8 s in scaduta, vento 18 dal mare, notte, acqua 17, pressione in calo
const SCENARIO_D = hour({
  time: '2026-11-28T22:00', waveM: 1.2, wavePeriodS: 8, seaPhase: 'scaduta', windKmh: 18, gustKmh: 28,
  windDirDeg: 210, windIncidence: 'onshore', light: 'night', seaTempC: 17, pressureTrend3h: -1.5
});

test('i pesi sommano a 1', () => {
  const sum = Object.values(WEIGHTS).reduce((a, b) => a + b, 0);
  assert.ok(Math.abs(sum - 1) < 1e-9);
  assert.deepEqual(Object.keys(WEIGHTS), ['sea', 'wind', 'light', 'season', 'water', 'pressure', 'tide', 'moon']);
});

test('scoreHour: forma del risultato', () => {
  const r = score('orata', SCENARIO_A);
  assert.ok(Number.isInteger(r.score));
  assert.equal(r.safety, 'ok');
  assert.deepEqual(r.safetyReasons, []);
  assert.deepEqual(Object.keys(r.parts), Object.keys(WEIGHTS));
  for (const p of Object.values(r.parts)) assert.ok(p.value === null || (p.value >= 0 && p.value <= 1));
});

test('(a) orata a fine settembre in condizioni ideali: almeno 80', () => {
  const r = score('orata', SCENARIO_A);
  assert.ok(r.score >= 80, `punteggio ${r.score}`);
});

test('(b) stessa orata a metà gennaio con acqua a 13.5: al massimo 55, stagione negativa', () => {
  const h = hour({ time: '2026-01-15T17:00', seaTempC: 13.5 });
  const r = score('orata', h);
  assert.ok(r.score <= 55, `punteggio ${r.score}`);
  assert.ok(r.parts.season.value < 0.45);
  // stessa cosa nella valutazione della giornata: il fattore stagione è negativo
  const fc = syntheticForecast(() => ({ waveM: 0.5, wavePeriodS: 6, windKmh: 10, gustKmh: 16, windDirDeg: 30, seaTempC: 13.5 }), '2026-01-15T00:00');
  const ev = evaluateDay(fc, 0, getSpecies('orata'));
  assert.equal(ev.factors.find((f) => f.key === 'season').impact, 'negative');
  assert.ok(ev.score <= 55, `giornata ${ev.score}`);
});

test('(c) orata con onda 1.8 m: al massimo 35 e attenzione', () => {
  const r = score('orata', hour({ waveM: 1.8 }));
  assert.ok(r.score <= 35, `punteggio ${r.score}`);
  assert.equal(r.safety, 'caution');
});

test('(d) sarago a fine novembre in scaduta, di notte, vento dal mare: almeno 80', () => {
  const r = score('sarago', SCENARIO_D);
  assert.ok(r.score >= 80, `punteggio ${r.score}`);
});

test('(e) sarago ad agosto a mezzogiorno con mare piatto: al massimo 30', () => {
  const r = score('sarago', hour({ time: '2026-08-12T13:00', waveM: 0.15, wavePeriodS: 3, windKmh: 6, gustKmh: 10, light: 'day', seaTempC: 26 }));
  assert.ok(r.score <= 30, `punteggio ${r.score}`);
});

test('(f) mormora di notte a luglio: almeno 80; a mezzogiorno almeno 15 punti in meno', () => {
  const night = hour({ time: '2026-07-15T23:00', waveM: 0.3, wavePeriodS: 5, windKmh: 6, gustKmh: 10, light: 'night', seaTempC: 24 });
  const noon = { ...night, time: '2026-07-15T13:00', epochMs: localToEpoch('2026-07-15T13:00', 7200), light: 'day' };
  const a = score('mormora', night).score;
  const b = score('mormora', noon).score;
  assert.ok(a >= 80, `notte ${a}`);
  assert.ok(a - b >= 15, `notte ${a}, mezzogiorno ${b}`);
});

test('(g) spigola all\'alba di dicembre in scaduta: almeno 80; a luglio con calma piatta a mezzogiorno: al massimo 30', () => {
  const dec = hour({
    time: '2026-12-10T07:00', waveM: 1.1, wavePeriodS: 7, seaPhase: 'scaduta', windKmh: 20, gustKmh: 30,
    windIncidence: 'onshore', light: 'dawn', seaTempC: 14
  });
  assert.ok(score('spigola', dec).score >= 80, `dicembre ${score('spigola', dec).score}`);
  const jul = hour({ time: '2026-07-15T13:00', waveM: 0.1, wavePeriodS: 3, windKmh: 4, gustKmh: 8, light: 'day', seaTempC: 26 });
  assert.ok(score('spigola', jul).score <= 30, `luglio ${score('spigola', jul).score}`);
});

test('(h) onda 2.3 m: pericolo per ogni specie, punteggio al massimo 15', () => {
  for (const sp of SPECIES) {
    const r = scoreHour(hour({ waveM: 2.3 }), sp);
    assert.equal(r.safety, 'danger', sp.id);
    assert.ok(r.score <= 15, `${sp.id} ${r.score}`);
    assert.ok(r.safetyReasons.some((s) => s.includes('2.3 m')));
  }
  const fc = syntheticForecast(() => ({ waveM: 2.3 }));
  for (const sp of SPECIES) {
    const ev = evaluateDay(fc, 0, sp);
    assert.equal(ev.verdict.key, 'pericolo', sp.id);
    assert.ok(ev.score <= 15);
    assert.equal(ev.bestWindow, null);
    assert.equal(ev.safety.level, 'danger');
  }
});

test('(i) temporale: pericolo nell\'ora e in quelle adiacenti', () => {
  const fc = syntheticForecast((i) => ({ weatherCode: i === 12 ? 95 : 1 }));
  const ev = evaluateDay(fc, 0, getSpecies('orata'));
  const byIndex = Object.fromEntries(ev.hourly.map((h) => [h.index, h.safety]));
  assert.equal(byIndex[11], 'danger');
  assert.equal(byIndex[12], 'danger');
  assert.equal(byIndex[13], 'danger');
  assert.equal(byIndex[10], 'ok');
  assert.equal(byIndex[14], 'ok');
  assert.ok(ev.safety.alerts.some((a) => a.level === 'danger' && a.fromTime === '11:00' && a.toTime === '14:00' && /temporal/i.test(a.text)));
  assert.ok(ev.bestWindow.endIndex <= 11 || ev.bestWindow.startIndex >= 14);
  for (const code of [96, 99]) {
    const r = scoreHour(hour({ weatherCode: code }), getSpecies('orata'));
    assert.equal(r.safety, 'danger');
  }
  // senza le ore vicine si guarda solo l'ora
  assert.equal(scoreHour(hour(), getSpecies('orata'), { prev: hour({ weatherCode: 95 }) }).safety, 'danger');
});

test('(j) raffiche a 46 km/h: attenzione e tetto 75', () => {
  const r = score('sarago', { ...SCENARIO_D, gustKmh: 46 });
  assert.equal(r.safety, 'caution');
  assert.ok(r.score <= 75 && r.score >= 70, `punteggio ${r.score}`);
  const wind = score('orata', hour({ windKmh: 31, gustKmh: 35 }));
  assert.equal(wind.safety, 'caution');
  assert.equal(score('orata', hour({ windKmh: 43 })).safety, 'danger');
  assert.equal(score('orata', hour({ gustKmh: 56 })).safety, 'danger');
});

test('(k) nello scenario (a) al massimo una specie su 6 arriva a 90', () => {
  const scores = SPECIES.map((sp) => scoreHour(SCENARIO_A, sp).score);
  assert.ok(scores.filter((s) => s >= 90).length <= 1, scores.join(', '));
  assert.ok(new Set(scores).size >= 5, `punteggi poco distinti: ${scores.join(', ')}`);
});

test('(l) fixture reali con l\'orata: oggi è pericolo, almeno 4 punteggi distinti in 7 giornate', () => {
  const fc = buildForecast({ weather: WEATHER, marine: MARINE, spot: SPOT, now: NOW });
  const evs = evaluateForecast(fc, getSpecies('orata'));
  assert.equal(evs.length, 7);
  assert.equal(evs[0].verdict.key, 'pericolo');
  assert.equal(evs[0].safety.level, 'danger');
  assert.match(evs[0].safety.text, /2\.5 m/);
  assert.ok(new Set(evs.map((e) => e.score)).size >= 4, evs.map((e) => e.score).join(', '));
  assert.ok(evs.every((e) => e.score === null || (Number.isInteger(e.score) && e.score >= 0 && e.score <= 100)));
});

test('(m) senza dati marini il punteggio è null e missing lo dice', () => {
  const fc = buildForecast({ weather: WEATHER, marine: null, spot: SPOT, now: NOW });
  const evs = evaluateForecast(fc, getSpecies('orata'));
  for (const ev of evs) {
    assert.equal(ev.score, null);
    assert.ok(ev.missing.some((m) => /mare/i.test(m)), ev.missing.join(' / '));
    assert.equal(ev.confidence, 'bassa');
    assert.ok(['nd', 'pericolo'].includes(ev.verdict.key));
  }
  assert.equal(scoreHour(hour({ waveM: null }), getSpecies('orata')).score, null);
});

test('(n) senza temperatura dell\'acqua il punteggio si calcola e il peso si ridistribuisce', () => {
  const r = score('orata', hour({ seaTempC: null }));
  assert.ok(Number.isInteger(r.score) && r.score >= 80);
  assert.equal(r.parts.water.value, null);
  const marine = JSON.parse(JSON.stringify(MARINE));
  delete marine.hourly.sea_surface_temperature;
  const fc = buildForecast({ weather: WEATHER, marine, spot: SPOT, now: NOW });
  const evs = evaluateForecast(fc, getSpecies('orata'));
  assert.ok(evs.slice(1).some((e) => Number.isInteger(e.score) && e.score > 15));
  const water = evs[3].factors.find((f) => f.key === 'water');
  assert.equal(water.value, null);
  assert.equal(water.maxPoints, 0);
  assert.ok(evs[3].missing.some((m) => /acqua/i.test(m)));
});

test('(o) la finestra migliore non contiene ore pericolose né ore passate', () => {
  const fc = buildForecast({ weather: WEATHER, marine: MARINE, spot: SPOT, now: NOW });
  for (const sp of SPECIES) {
    for (const ev of evaluateForecast(fc, sp)) {
      if (!ev.bestWindow) continue;
      const w = ev.bestWindow;
      assert.ok(w.endIndex - w.startIndex >= 1 && w.endIndex - w.startIndex <= 3);
      assert.ok(w.startIndex >= fc.nowIndex, `${sp.id} ${ev.date}: finestra nel passato`);
      for (let i = w.startIndex; i < w.endIndex; i++) {
        assert.notEqual(ev.hourly.find((h) => h.index === i).safety, 'danger', `${sp.id} ${ev.date}`);
      }
      assert.equal(w.startTime, fc.hours[w.startIndex].time.slice(11, 16));
    }
  }
  // giornata con un varco di 2 ore tra ore pericolose: non è una finestra di pesca
  const gap = syntheticForecast((i) => ({ waveM: i >= 40 && i <= 41 ? 0.6 : 2.4 }));
  const ev = evaluateDay(gap, 1, getSpecies('orata'));
  assert.equal(ev.bestWindow, null);
  assert.equal(ev.verdict.key, 'pericolo');
  assert.ok(ev.score <= 15, `punteggio ${ev.score}`);
  assert.equal(ev.safety.level, 'danger');
});

test('una tregua di un\'ora in una giornata di temporali non diventa una giornata buona', () => {
  // Temporali ogni tre ore: con le ore adiacenti segnate, resta scoperta un'ora ogni tanto. Mare ideale.
  const storms = syntheticForecast((i) => ({ weatherCode: i % 4 === 0 ? 95 : 1 }));
  for (const sp of SPECIES) {
    const ev = evaluateDay(storms, 1, sp);
    const safeHours = ev.hourly.filter((h) => h.safety !== 'danger').length;
    assert.ok(safeHours > 0 && safeHours < ev.hourly.length, 'lo scenario deve avere ore sicure isolate');
    assert.equal(ev.verdict.key, 'pericolo', sp.id);
    assert.equal(ev.bestWindow, null, sp.id);
    assert.ok(ev.score <= 15, `${sp.id} ${ev.score}`);
  }
  // Con tre ore di fila senza pericolo la finestra esiste, e l'avviso sulle altre ore resta
  const morning = syntheticForecast((i) => ({ weatherCode: i >= 36 && i <= 48 ? 95 : 1 }));
  const ok = evaluateDay(morning, 1, getSpecies('orata'));
  assert.ok(ok.bestWindow);
  assert.equal(ok.bestWindow.endIndex - ok.bestWindow.startIndex, 3);
  assert.notEqual(ok.verdict.key, 'pericolo');
  assert.equal(ok.safety.level, 'danger');
});

test('a fine giornata bastano le ore rimaste, se sono tutte sicure', () => {
  // Sono le 03:10: alla giornata di pesca restano le 03 e le 04
  const at = (h, over) => {
    const now = localToEpoch('2026-09-29T00:00', 7200) + h * HOUR + 10 * 60000;
    return syntheticForecast(over, '2026-09-28T00:00', now);
  };
  const calm = evaluateDay(at(3, () => ({})), 0, getSpecies('mormora'));
  assert.equal(calm.bestWindow.endIndex - calm.bestWindow.startIndex, 2);
  assert.notEqual(calm.verdict.key, 'pericolo');
  // Se una delle due è pericolosa non c'è finestra
  const half = evaluateDay(at(3, (i) => ({ waveM: i === 27 ? 2.4 : 0.5 })), 0, getSpecies('mormora'));
  assert.equal(half.bestWindow, null);
  assert.equal(half.verdict.key, 'pericolo');
});

test('una finestra con mare impegnativo non è mai "ottimo"', () => {
  assert.equal(verdictFor(75, 'caution').key, 'buono');
  assert.equal(verdictFor(90, 'caution').key, 'buono');
  // Sarago a fine novembre con raffiche a 46 km/h tutto il giorno: le sue condizioni, ma con attenzione
  const fc = syntheticForecast(() => ({ waveM: 1.2, wavePeriodS: 8, windKmh: 18, gustKmh: 46, windDirDeg: 210, seaTempC: 17 }), '2026-11-28T00:00');
  const ev = evaluateDay(fc, 1, getSpecies('sarago'));
  assert.ok(ev.bestWindow);
  assert.ok(ev.score <= 75);
  assert.notEqual(ev.verdict.key, 'ottimo');
  assert.equal(ev.safety.level, 'caution');
});

test('finestra migliore: etichette per oggi e per i giorni dopo', () => {
  const fc = syntheticForecast(() => ({}));
  const sp = getSpecies('orata');
  const ev0 = evaluateDay(fc, 0, sp);
  assert.match(ev0.bestWindow.label, /^(stamattina|oggi|stasera|stanotte) \d{1,2}-\d{1,2}$/);
  const ev1 = evaluateDay(fc, 1, sp);
  assert.match(ev1.bestWindow.label, /^(mattina|pomeriggio|sera|notte) \d{1,2}-\d{1,2}$/);
  // l'orata con tutto uguale preferisce il tramonto: finestra della sera
  assert.match(ev1.bestWindow.label, /^sera 1[5-7]-(18|19|20)$/);
  assert.equal(ev1.bestWindow.endTime, `${String(Number(ev1.bestWindow.label.split(' ')[1].split('-')[1])).padStart(2, '0')}:00`);
});

test('verdictFor: soglie e sicurezza prima del punteggio', () => {
  assert.deepEqual(verdictFor(75, 'ok'), { key: 'ottimo', label: 'Ottimo' });
  assert.equal(verdictFor(74, 'ok').key, 'buono');
  assert.equal(verdictFor(60, 'caution').key, 'buono');
  assert.equal(verdictFor(59, 'ok').key, 'discreto');
  assert.equal(verdictFor(45, 'ok').key, 'discreto');
  assert.equal(verdictFor(44, 'ok').key, 'difficile');
  assert.equal(verdictFor(99, 'danger').key, 'pericolo');
  assert.equal(verdictFor(null, 'ok').key, 'nd');
  assert.equal(verdictFor(null, 'danger').key, 'pericolo');
});

test('curve continue: nessun gradino tra onde vicine', () => {
  const sp = getSpecies('sarago');
  let prev = null;
  for (let w = 0.3; w <= 2.05; w += 0.01) {
    const s = scoreHour(hour({ ...SCENARIO_D, waveM: Math.round(w * 100) / 100 }), sp);
    if (prev !== null && s.safety === prev.safety) {
      assert.ok(Math.abs(s.score - prev.score) <= 6, `salto a ${w.toFixed(2)} m: ${prev.score} → ${s.score}`);
    }
    prev = s;
  }
});

test('DayEvaluation: forma, testi brevi e nello stile richiesto', () => {
  const fc = buildForecast({ weather: WEATHER, marine: MARINE, spot: SPOT, now: NOW });
  for (const sp of SPECIES) {
    for (const ev of evaluateForecast(fc, sp)) {
      assert.deepEqual(Object.keys(ev).sort(), ['bestWindow', 'confidence', 'date', 'dayIndex', 'factors', 'headline', 'hourly', 'missing', 'safety', 'score', 'verdict'].sort());
      assert.ok(ev.headline.length <= 90, `${ev.headline.length}: ${ev.headline}`);
      assert.ok(['alta', 'media', 'bassa'].includes(ev.confidence));
      assert.equal(ev.factors.length, 8);
      const texts = [ev.headline, ev.safety.text, ...ev.safety.alerts.map((a) => a.text), ...ev.factors.flatMap((f) => [f.title, f.detail])];
      for (const t of texts) {
        assert.ok(t && typeof t === 'string');
        assert.doesNotMatch(t, /[!&—–]/, t);
        assert.doesNotMatch(t, /\b[A-Z]{4,}\b/, t);
        assert.doesNotMatch(t, /undefined|NaN|null/, t);
      }
      for (const f of ev.factors) {
        assert.ok(['positive', 'neutral', 'negative'].includes(f.impact));
        if (f.value !== null) assert.ok(f.points >= 0 && f.points <= f.maxPoints);
      }
      for (const a of ev.safety.alerts) assert.match(`${a.fromTime} ${a.toTime}`, /^\d{2}:\d{2} \d{2}:\d{2}$/);
    }
  }
});

test('affidabilità: alta nei primi due giorni, poi media e bassa', () => {
  const fc = buildForecast({ weather: WEATHER, marine: MARINE, spot: SPOT, now: NOW });
  const evs = evaluateForecast(fc, getSpecies('sarago'));
  assert.equal(evs[1].confidence, 'alta');
  assert.equal(evs[6].confidence, 'bassa');
  assert.ok(evs.some((e) => e.confidence === 'media'));
});

/**
 * Previsione sintetica di 3 giorni (dalle 00:00 di startLocal) con mare e meteo costanti,
 * personalizzabili ora per ora: over(i) restituisce i campi Open-Meteo da cambiare.
 */
function syntheticForecast(over, startLocal = '2026-09-28T00:00', now = null) {
  const n = 72;
  const start = localToEpoch(startLocal, 7200);
  const time = Array.from({ length: n }, (_, i) => epochToLocal(start + i * HOUR, 7200));
  const rows = time.map((_, i) => ({
    waveM: 0.5, wavePeriodS: 6, seaTempC: 23, windKmh: 10, gustKmh: 16, windDirDeg: 30, weatherCode: 1, pressure: 1018,
    ...over(i)
  }));
  const weather = {
    utc_offset_seconds: 7200, timezone: 'Europe/Rome',
    hourly: {
      time,
      temperature_2m: rows.map(() => 21), precipitation: rows.map(() => 0), precipitation_probability: rows.map(() => 0),
      weather_code: rows.map((r) => r.weatherCode), cloud_cover: rows.map(() => 20), pressure_msl: rows.map((r) => r.pressure),
      wind_speed_10m: rows.map((r) => r.windKmh), wind_direction_10m: rows.map((r) => r.windDirDeg), wind_gusts_10m: rows.map((r) => r.gustKmh)
    }
  };
  const marine = {
    latitude: 41.2, longitude: 13.37, utc_offset_seconds: 7200, timezone: 'Europe/Rome',
    hourly: {
      time,
      wave_height: rows.map((r) => r.waveM), wave_period: rows.map((r) => r.wavePeriodS), wave_direction: rows.map(() => 210),
      sea_surface_temperature: rows.map((r) => r.seaTempC)
    }
  };
  // now: le 05:00 locali del primo giorno, così tutte le ore della giornata sono future
  return buildForecast({ weather, marine, spot: SPOT, now: now ?? start + 5 * HOUR });
}
