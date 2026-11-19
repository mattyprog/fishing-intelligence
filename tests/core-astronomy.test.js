import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sunTimes, moonPhase, moonTimes } from '../js/core/astronomy.js';

const FONDI = [41.2889, 13.3461];
const ROME = [41.8919, 12.5113];
const MIN = 60000;

const near = (actual, expected, tolMs, msg) =>
  assert.ok(Math.abs(actual - expected) <= tolMs, `${msg}: scarto ${Math.round((actual - expected) / 1000)} s`);

test('sunTimes: alba e tramonto a Salto di Fondi coincidono con Open-Meteo entro 3 minuti', () => {
  const s = sunTimes('2026-11-19', ...FONDI);
  // Open-Meteo: sunrise 06:59 e sunset 16:44 locali (UTC+1)
  near(s.sunrise, Date.UTC(2026, 10, 19, 5, 59), 3 * MIN, 'alba');
  near(s.sunset, Date.UTC(2026, 10, 19, 15, 44), 3 * MIN, 'tramonto');
  assert.ok(s.dawn < s.sunrise && s.sunrise < s.noon && s.noon < s.sunset && s.sunset < s.dusk);
  const civil = (s.sunrise - s.dawn) / MIN;
  assert.ok(civil > 25 && civil < 35, `crepuscolo civile mattutino di ${civil} minuti`);
});

test('sunTimes: estate, giornata lunga', () => {
  const s = sunTimes('2026-06-21', ...FONDI);
  const hours = (s.sunset - s.sunrise) / 3600000;
  assert.ok(hours > 15 && hours < 15.4, `durata del giorno ${hours}`);
});

test('sunTimes: null dove il sole non sorge e con input non validi', () => {
  const polar = sunTimes('2026-12-21', 80, 10);
  assert.equal(polar.sunrise, null);
  assert.equal(polar.sunset, null);
  assert.ok(Number.isFinite(polar.noon));
  assert.deepEqual(sunTimes('non-una-data', ...FONDI), { dawn: null, sunrise: null, noon: null, sunset: null, dusk: null });
  assert.equal(sunTimes('2026-11-19', 95, 13).sunrise, null);
});

test('sunTimes e moonTimes non dipendono dal fuso del dispositivo', () => {
  const prev = process.env.TZ;
  const a = [sunTimes('2026-11-19', ...FONDI), moonTimes('2026-11-19', ...FONDI, 3600)];
  process.env.TZ = 'America/Los_Angeles';
  const b = [sunTimes('2026-11-19', ...FONDI), moonTimes('2026-11-19', ...FONDI, 3600)];
  process.env.TZ = 'Asia/Tokyo';
  const c = [sunTimes('2026-11-19', ...FONDI), moonTimes('2026-11-19', ...FONDI, 3600)];
  if (prev === undefined) delete process.env.TZ;
  else process.env.TZ = prev;
  assert.deepEqual(a, b);
  assert.deepEqual(a, c);
});

test('moonPhase: luna nuova, primo quarto e luna piena di novembre 2026', () => {
  const nuova = moonPhase(Date.UTC(2026, 10, 9, 7, 2));
  assert.ok(nuova.illuminationPct < 3, `nuova ${nuova.illuminationPct}%`);
  assert.equal(nuova.phaseKey, 'new');
  assert.equal(nuova.phaseName, 'Luna nuova');
  assert.ok(nuova.ageDays < 0.3 || nuova.ageDays > 29.3, `età ${nuova.ageDays}`);

  const quarto = moonPhase(Date.UTC(2026, 10, 17, 11, 48));
  assert.ok(quarto.illuminationPct >= 40 && quarto.illuminationPct <= 60, `primo quarto ${quarto.illuminationPct}%`);
  assert.equal(quarto.phaseKey, 'first_quarter');
  assert.equal(quarto.phaseName, 'Primo quarto');
  assert.ok(Math.abs(quarto.fraction - 0.25) < 0.01);

  const piena = moonPhase(Date.UTC(2026, 10, 24, 14, 53));
  assert.ok(piena.illuminationPct > 97, `piena ${piena.illuminationPct}%`);
  assert.equal(piena.phaseKey, 'full');
  assert.equal(piena.phaseName, 'Luna piena');
  assert.ok(Math.abs(piena.fraction - 0.5) < 0.01);
  assert.ok(piena.ageDays > 14 && piena.ageDays < 16.5, `età ${piena.ageDays}`);
});

test('moonPhase: le 13 lune piene del 2026 superano il 97%', () => {
  const fulls = [[0, 3], [1, 1], [2, 3], [3, 2], [4, 1], [4, 31], [5, 29], [6, 29], [7, 28], [8, 26], [9, 26], [10, 24], [11, 24]];
  for (const [m, d] of fulls) {
    const p = moonPhase(Date.UTC(2026, m, d, 12));
    assert.ok(p.illuminationPct > 97, `${d}/${m + 1}: ${p.illuminationPct}%`);
  }
});

test('moonPhase: non è il semplice ciclo sinodico (luna crescente e calante distinte)', () => {
  const crescente = moonPhase(Date.UTC(2026, 10, 12, 12));
  const calante = moonPhase(Date.UTC(2026, 11, 5, 12));
  assert.equal(crescente.phaseKey, 'waxing_crescent');
  assert.equal(calante.phaseKey, 'waning_crescent');
  assert.equal(moonPhase(Date.UTC(2026, 10, 27, 12)).phaseName, 'Gibbosa calante');
  // 3.2 giorni dopo la luna nuova: falce sottile, circa 11%
  assert.ok(crescente.illuminationPct > 8 && crescente.illuminationPct < 16, `${crescente.illuminationPct}%`);
});

test('moonPhase: in un mese compaiono tutti gli 8 nomi italiani', () => {
  const names = new Set();
  for (let t = Date.UTC(2026, 10, 1); t < Date.UTC(2026, 11, 2); t += 6 * 3600000) names.add(moonPhase(t).phaseName);
  assert.deepEqual([...names].sort(), ['Gibbosa calante', 'Gibbosa crescente', 'Luna calante', 'Luna crescente',
    'Luna nuova', 'Luna piena', 'Primo quarto', 'Ultimo quarto']);
});

test('moonTimes: sorgere e tramonto a Roma coincidono con timeanddate entro 5 minuti', () => {
  // Riferimenti timeanddate.com, Roma, novembre 2026, ora locale UTC+1
  const ref = {
    '2026-11-09': ['07:09', '16:34'],
    '2026-11-17': ['13:02', '23:53'],
    '2026-11-19': ['13:44', '00:57'],
    '2026-11-24': ['16:12', '07:04'],
    '2026-11-03': ['00:21', '14:12']
  };
  const toMs = (date, hhmm) => Date.parse(`${date}T${hhmm}:00Z`) - 3600000;
  for (const [date, [rise, set]] of Object.entries(ref)) {
    const t = moonTimes(date, ...ROME, 3600);
    near(t.rise, toMs(date, rise), 5 * MIN, `sorgere ${date}`);
    near(t.set, toMs(date, set), 5 * MIN, `tramonto ${date}`);
  }
});

test('moonTimes: null se nel giorno locale l\'evento non avviene', () => {
  assert.equal(moonTimes('2026-11-18', ...ROME, 3600).set, null);
  assert.equal(moonTimes('2026-11-02', ...ROME, 3600).rise, null);
  assert.deepEqual(moonTimes('xx', ...ROME, 3600), { rise: null, set: null });
});

test('moonTimes: con la luna piena sorge vicino al tramonto del sole', () => {
  const m = moonTimes('2026-11-24', ...FONDI, 3600);
  const s = sunTimes('2026-11-24', ...FONDI);
  assert.ok(Math.abs(m.rise - s.sunset) < 60 * MIN);
});
