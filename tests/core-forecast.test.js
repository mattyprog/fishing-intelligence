import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { buildForecast, windIncidenceFor, localToEpoch, epochToLocal } from '../js/core/forecast.js';
import { PREDEFINED_SPOTS } from '../js/core/spots.js';

const load = (name) => JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8'));
const WEATHER = load('open-meteo-weather.json');
const MARINE = load('open-meteo-marine.json');
const SPOT = PREDEFINED_SPOTS.find((s) => s.id === 'salto-di-fondi');
const NOW = Date.UTC(2026, 10, 19, 16, 15); // 17:15 locali
const HOUR = 3600000;
const clone = (o) => JSON.parse(JSON.stringify(o));
const build = (over = {}) => buildForecast({ weather: WEATHER, marine: MARINE, spot: SPOT, now: NOW, ...over });

/** Blocco Open-Meteo sintetico: times locali e serie orarie date. */
function block(startLocal, n, series, offset = 3600) {
  const start = localToEpoch(startLocal, offset);
  const time = Array.from({ length: n }, (_, i) => epochToLocal(start + i * HOUR, offset));
  const hourly = { time };
  for (const [k, fn] of Object.entries(series)) hourly[k] = time.map((_, i) => fn(i));
  return { latitude: 41.2, longitude: 13.37, utc_offset_seconds: offset, timezone: 'Europe/Rome', hourly };
}

test('ore continue, crescenti, una per ora da ieri 00:00, epochMs dalla stringa locale', () => {
  const fc = build();
  assert.equal(fc.hours.length, 192);
  assert.equal(fc.hours[0].time, '2026-11-18T00:00');
  assert.equal(fc.hours[0].epochMs, Date.UTC(2026, 10, 18, 0, 0) - 3600 * 1000);
  for (let i = 1; i < fc.hours.length; i++) assert.equal(fc.hours[i].epochMs - fc.hours[i - 1].epochMs, HOUR);
  assert.equal(fc.hours.at(-1).time, '2026-11-25T23:00');
  assert.equal(fc.utcOffsetSeconds, 3600);
  assert.equal(fc.timezone, 'Europe/Rome');
  assert.equal(fc.spotId, 'salto-di-fondi');
});

test('nowIndex punta all\'ora corrente dello spot', () => {
  const fc = build();
  assert.equal(fc.nowIndex, 41);
  assert.equal(fc.hours[fc.nowIndex].time, '2026-11-19T17:00');
  assert.equal(build({ now: Date.UTC(2027, 0, 1) }).nowIndex, -1);
});

test('valori copiati senza invenzioni e senza arrotondamenti', () => {
  const fc = build();
  WEATHER.hourly.time.forEach((t, i) => {
    const h = fc.hours[i];
    assert.equal(h.time, t);
    assert.equal(h.pressureHpa, WEATHER.hourly.pressure_msl[i]);
    assert.equal(h.windKmh, WEATHER.hourly.wind_speed_10m[i]);
    assert.equal(h.weatherCode, WEATHER.hourly.weather_code[i]);
    assert.equal(h.waveM, MARINE.hourly.wave_height[i]);
    assert.equal(h.seaTempC, MARINE.hourly.sea_surface_temperature[i]);
    assert.equal(h.seaLevelM, MARINE.hourly.sea_level_height_msl[i]);
  });
  assert.deepEqual(fc.has, { weather: true, marine: true, seaTemp: true, seaLevel: true });
  assert.equal(fc.marineGrid.lat, MARINE.latitude);
  assert.ok(fc.marineGrid.distanceKm > 5 && fc.marineGrid.distanceKm < 15);
});

test('allineamento per istante: blocco marino spostato e con un altro scarto orario', () => {
  // Il mare arriva in UTC e senza le prime 10 ore: deve finire sulle stesse ore locali
  const marine = clone(MARINE);
  marine.utc_offset_seconds = 0;
  marine.hourly.time = marine.hourly.time.map((t) => epochToLocal(localToEpoch(t, 3600), 0));
  for (const k of Object.keys(marine.hourly)) marine.hourly[k] = marine.hourly[k].slice(10);
  const fc = build({ marine });
  assert.equal(fc.hours.length, 192);
  for (let i = 0; i < 10; i++) assert.equal(fc.hours[i].waveM, null);
  for (let i = 10; i < 192; i++) assert.equal(fc.hours[i].waveM, MARINE.hourly.wave_height[i], `ora ${fc.hours[i].time}`);
  assert.equal(fc.hours[50].airTempC, WEATHER.hourly.temperature_2m[50]);
});

test('un blocco nullo è tollerato, entrambi nulli → null', () => {
  const noMarine = build({ marine: null });
  assert.equal(noMarine.hours.length, 192);
  assert.ok(noMarine.hours.every((h) => h.waveM === null && h.seaPhase === null && h.seaTempC === null));
  assert.equal(noMarine.has.marine, false);
  assert.equal(noMarine.marineGrid, null);
  assert.equal(noMarine.days.length, 7);

  const noWeather = build({ weather: null });
  assert.ok(noWeather.hours.every((h) => h.windKmh === null && h.pressureTrend3h === null && h.windIncidence === null));
  assert.equal(noWeather.has.weather, false);
  assert.equal(noWeather.hours[41].waveM, MARINE.hourly.wave_height[41]);

  assert.equal(build({ weather: null, marine: null }), null);
  assert.equal(build({ weather: { hourly: {} }, marine: { error: true, reason: 'x' } }), null);
});

test('dato assente resta null, anche nelle grandezze derivate', () => {
  const weather = clone(WEATHER);
  weather.hourly.pressure_msl[50] = null;
  weather.hourly.wind_direction_10m[60] = null;
  const marine = clone(MARINE);
  marine.hourly.sea_surface_temperature[70] = null;
  delete marine.hourly.ocean_current_velocity;
  const fc = build({ weather, marine });
  assert.equal(fc.hours[50].pressureHpa, null);
  assert.equal(fc.hours[50].pressureTrend3h, null);
  assert.equal(fc.hours[53].pressureTrend3h, null);
  assert.equal(fc.hours[60].windIncidence, null);
  assert.equal(fc.hours[70].seaTempC, null);
  assert.ok(fc.hours.every((h) => h.currentKmh === null));
});

test('pressureTrend3h sui valori non arrotondati, null ai bordi', () => {
  const p = [1012.34, 1012.6, 1012.9, 1013.27, 1013.1, 1012.0, 1011.04];
  const weather = block('2026-11-19T00:00', p.length, { pressure_msl: (i) => p[i] });
  const fc = buildForecast({ weather, marine: null, spot: SPOT, now: localToEpoch('2026-11-19T02:00', 3600) });
  assert.deepEqual(fc.hours.slice(0, 3).map((h) => h.pressureTrend3h), [null, null, null]);
  assert.equal(fc.hours[3].pressureTrend3h, 0.93); // con valori arrotondati sarebbe 1
  assert.equal(fc.hours[6].pressureTrend3h, -2.23);

  const fix = build();
  for (let i = 3; i < 192; i++) {
    const expected = WEATHER.hourly.pressure_msl[i] - WEATHER.hourly.pressure_msl[i - 3];
    assert.ok(Math.abs(fix.hours[i].pressureTrend3h - expected) < 0.006);
  }
});

test('fase del mare: montante, scaduta, stabile, null senza dati', () => {
  // 12 ore a 0.5 m, poi sale fino a 1.4 m, poi cala
  const waves = [...Array(12).fill(0.5), 0.6, 0.75, 0.9, 1.05, 1.2, 1.3, 1.4, 1.4, 1.4, 1.35, 1.25, 1.15, 1.05, 0.95, 0.9, 0.85, ...Array(12).fill(0.85)];
  const marine = block('2026-11-19T00:00', waves.length, { wave_height: (i) => waves[i] });
  const fc = buildForecast({ weather: null, marine, spot: SPOT, now: localToEpoch('2026-11-19T06:00', 3600) });
  const phase = (i) => fc.hours[i].seaPhase;
  assert.equal(phase(3), null); // mancano le 6 ore precedenti
  assert.equal(phase(8), 'stabile');
  assert.equal(phase(15), 'montante');
  assert.equal(phase(26), 'scaduta');
  assert.equal(phase(39), 'stabile');

  // calo senza un picco di almeno 0.8 m nelle 36 ore: non è scaduta
  const small = [0.7, 0.7, 0.7, 0.7, 0.7, 0.7, 0.6, 0.55, 0.5, 0.45];
  const m2 = block('2026-11-19T00:00', small.length, { wave_height: (i) => small[i] });
  const f2 = buildForecast({ weather: null, marine: m2, spot: SPOT, now: localToEpoch('2026-11-19T06:00', 3600) });
  assert.equal(f2.hours[9].seaPhase, 'stabile');
});

test('luce: alba dal crepuscolo civile a 45 minuti dopo il sorgere, tramonto simmetrico', () => {
  const fc = build();
  const at = (t) => fc.hours.find((h) => h.time === `2026-11-19T${t}`).light;
  // 19/11: crepuscolo 06:29, alba 06:59, tramonto 16:44, fine crepuscolo 17:14; conta il centro dell'ora
  assert.equal(at('05:00'), 'night');
  assert.equal(at('06:00'), 'dawn');
  assert.equal(at('07:00'), 'dawn');
  assert.equal(at('08:00'), 'day');
  assert.equal(at('12:00'), 'day');
  assert.equal(at('15:00'), 'day');
  assert.equal(at('16:00'), 'dusk');
  assert.equal(at('17:00'), 'night');
  assert.equal(at('23:00'), 'night');
});

test('incidenza del vento rispetto alla spiaggia', () => {
  assert.equal(windIncidenceFor(197, 210), 'onshore');
  assert.equal(windIncidenceFor(260, 210), 'onshore');
  assert.equal(windIncidenceFor(24, 210), 'offshore');
  assert.equal(windIncidenceFor(80, 210), 'offshore');
  assert.equal(windIncidenceFor(279, 210), 'cross');
  assert.equal(windIncidenceFor(350, 10), 'onshore');
  assert.equal(windIncidenceFor(null, 210), null);
  assert.equal(windIncidenceFor(200, undefined), null);
  const fc = build();
  assert.equal(fc.hours[36].windIncidence, windIncidenceFor(WEATHER.hourly.wind_direction_10m[36], 210));
});

test('giornate di pesca 05:00-05:00 dalla giornata corrente, etichette in italiano', () => {
  const fc = build();
  assert.equal(fc.days.length, 7);
  const [d0, d1, d2] = fc.days;
  assert.deepEqual([d0.date, d0.label, d0.labelShort, d0.startIndex, d0.endIndex], ['2026-11-19', 'Oggi', 'Oggi', 29, 53]);
  assert.deepEqual([d1.label, d1.labelShort], ['Domani', 'Domani']);
  assert.deepEqual([d2.date, d2.label, d2.labelShort], ['2026-11-21', 'Sabato 21', 'Sab']);
  assert.equal(fc.days[3].label, 'Domenica 22');
  assert.equal(fc.hours[d0.startIndex].time, '2026-11-19T05:00');
  assert.equal(fc.hours[d0.endIndex - 1].time, '2026-11-20T04:00');
  const last = fc.days.at(-1);
  assert.equal(last.date, '2026-11-25');
  assert.equal(last.endIndex, 192);
  assert.equal(last.endIndex - last.startIndex, 19); // l'ultima giornata è più corta
});

test('alle 02:00 di notte la giornata corrente è ancora quella di ieri', () => {
  const fc = build({ now: Date.UTC(2026, 10, 20, 1, 30) }); // 02:30 locali del 20
  assert.equal(fc.days[0].date, '2026-11-19');
  assert.equal(fc.days[0].label, 'Stanotte');
  assert.equal(fc.days[1].date, '2026-11-20');
  assert.equal(fc.days[1].label, 'Oggi');
  assert.equal(fc.days[2].label, 'Domani');
});

test('etichette e giornate non dipendono dal fuso del dispositivo', () => {
  const prev = process.env.TZ;
  process.env.TZ = 'Pacific/Auckland';
  const nz = build();
  process.env.TZ = 'America/New_York';
  const ny = build();
  if (prev === undefined) delete process.env.TZ;
  else process.env.TZ = prev;
  assert.deepEqual(nz.days.map((d) => [d.date, d.label, d.startIndex]), ny.days.map((d) => [d.date, d.label, d.startIndex]));
  assert.deepEqual(nz.hours.map((h) => h.light), ny.hours.map((h) => h.light));
});

test('sole e luna della giornata', () => {
  const d0 = build().days[0];
  assert.ok(['06:58', '06:59', '07:00', '07:01', '07:02', '06:57', '06:56'].includes(d0.sun.sunrise.time));
  assert.ok(['16:43', '16:44', '16:45', '16:42', '16:41', '16:46', '16:47'].includes(d0.sun.sunset.time));
  assert.equal(d0.sun.dawn.time < d0.sun.sunrise.time, true);
  assert.ok(Number.isFinite(d0.sun.noon.epochMs));
  assert.equal(d0.moon.phaseName, 'Gibbosa crescente');
  assert.ok(d0.moon.illuminationPct > 60 && d0.moon.illuminationPct < 80);
  // sorgere e tramonto cercati dentro la giornata di pesca
  for (const e of [d0.moon.rise, d0.moon.set].filter(Boolean)) {
    assert.ok(e.epochMs >= build().hours[d0.startIndex].epochMs && e.epochMs < build().hours[d0.endIndex - 1].epochMs + HOUR);
  }
  const full = build().days.find((d) => d.date === '2026-11-24');
  assert.equal(full.moon.phaseKey, 'full');
});

test('maree dalla serie reale: alternate, dentro la giornata, livelli plausibili', () => {
  const fc = build();
  const levels = MARINE.hourly.sea_level_height_msl;
  for (const d of fc.days) {
    const start = fc.hours[d.startIndex].epochMs;
    const end = fc.hours[d.endIndex - 1].epochMs + HOUR;
    for (const t of d.tides) {
      assert.ok(t.epochMs >= start && t.epochMs < end);
      assert.ok(t.levelM >= Math.min(...levels) - 0.05 && t.levelM <= Math.max(...levels) + 0.05);
      assert.match(t.time, /^\d{2}:\d{2}$/);
    }
  }
  const all = fc.days.flatMap((d) => d.tides);
  assert.ok(all.length >= 14, `${all.length} maree`);
  for (let i = 1; i < all.length; i++) assert.notEqual(all[i].type, all[i - 1].type);
});

test('maree: interpolazione parabolica e scarto delle oscillazioni sotto 3 cm', () => {
  const PERIOD = 12.42;
  const peak0 = 7.3; // ora del primo massimo vero
  const level = (i) => 0.15 * Math.cos((2 * Math.PI * (i - peak0)) / PERIOD);
  const marine = block('2026-11-19T00:00', 72, { sea_level_height_msl: level });
  const fc = buildForecast({ weather: null, marine, spot: SPOT, now: localToEpoch('2026-11-19T06:00', 3600) });
  const highs = fc.days.flatMap((d) => d.tides).filter((t) => t.type === 'high');
  const t0 = localToEpoch('2026-11-19T00:00', 3600);
  for (const h of highs) {
    const k = Math.round(((h.epochMs - t0) / HOUR - peak0) / PERIOD);
    const truth = t0 + (peak0 + k * PERIOD) * HOUR;
    assert.ok(Math.abs(h.epochMs - truth) < 10 * 60000, `scarto ${(h.epochMs - truth) / 60000} min`);
    assert.ok(Math.abs(h.levelM - 0.15) <= 0.01);
  }

  // Livello piatto con un'increspatura di 2 cm: nessuna marea
  const flat = block('2026-11-19T00:00', 30, { sea_level_height_msl: (i) => (i === 12 ? -0.28 : -0.3) });
  const ff = buildForecast({ weather: null, marine: flat, spot: SPOT, now: localToEpoch('2026-11-19T06:00', 3600) });
  assert.equal(ff.days.flatMap((d) => d.tides).length, 0);
});

test('riepilogo della giornata', () => {
  const fc = build();
  const d0 = fc.days[0];
  const hs = fc.hours.slice(d0.startIndex, d0.endIndex);
  assert.equal(d0.summary.waveMaxM, Math.max(...hs.map((h) => h.waveM)));
  assert.equal(d0.summary.waveMinM, Math.min(...hs.map((h) => h.waveM)));
  assert.equal(d0.summary.gustMaxKmh, Math.max(...hs.map((h) => h.gustKmh)));
  assert.equal(d0.summary.weatherCode, 95);
  const precip = Math.round(hs.reduce((a, h) => a + h.precipMm, 0) * 10) / 10;
  assert.equal(d0.summary.precipMm, precip);
  assert.ok(d0.summary.seaTempC > 19 && d0.summary.seaTempC < 19.5);
  const dry = build({ marine: null }).days[0].summary;
  assert.equal(dry.waveMaxM, null);
  assert.equal(dry.seaTempC, null);
});
