/**
 * Sole e luna per uno spot: alba, tramonto, crepuscoli, fase lunare, sorgere e tramonto della luna.
 * Sole: algoritmo NOAA (Meeus semplificato). Luna: termini principali di Meeus, cap. 47.
 * Tutti gli istanti sono epochMs UTC; il fuso del dispositivo non entra mai nei calcoli.
 */

const RAD = Math.PI / 180;
const DAY_MS = 86400000;
const J2000 = 2451545.0;
const AU_KM = 149597870.7;
const EARTH_RADIUS_KM = 6378.14;
const SYNODIC_DAYS = 29.530588853;

const ZENITH_SUN = 90.833; // rifrazione e semidiametro
const ZENITH_CIVIL = 96;

const toJulian = (ms) => ms / DAY_MS + 2440587.5;
const norm360 = (x) => ((x % 360) + 360) % 360;
const sind = (x) => Math.sin(x * RAD);
const cosd = (x) => Math.cos(x * RAD);

function parseYMD(dateYMD) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(dateYMD || ''));
  if (!m) return null;
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}

function validCoords(lat, lng) {
  return Number.isFinite(lat) && Number.isFinite(lng) && Math.abs(lat) <= 90 && Math.abs(lng) <= 180;
}

/* ---------------------------------- Sole ---------------------------------- */

/** Posizione apparente del sole (gradi), equazione del tempo (minuti), distanza (UA). */
function sunCoords(jd) {
  const T = (jd - J2000) / 36525;
  const L0 = norm360(280.46646 + T * (36000.76983 + T * 0.0003032));
  const M = 357.52911 + T * (35999.05029 - 0.0001537 * T);
  const e = 0.016708634 - T * (0.000042037 + 0.0000001267 * T);
  const C = sind(M) * (1.914602 - T * (0.004817 + 0.000014 * T))
    + sind(2 * M) * (0.019993 - 0.000101 * T)
    + sind(3 * M) * 0.000289;
  const omega = 125.04 - 1934.136 * T;
  const lambda = L0 + C - 0.00569 - 0.00478 * sind(omega);
  const eps0 = 23 + (26 + (21.448 - T * (46.815 + T * (0.00059 - T * 0.001813))) / 60) / 60;
  const eps = eps0 + 0.00256 * cosd(omega);
  const decl = Math.asin(sind(eps) * sind(lambda)) / RAD;
  const y = Math.tan((eps * RAD) / 2) ** 2;
  const eqTime = (4 / RAD) * (y * sind(2 * L0) - 2 * e * sind(M) + 4 * e * y * sind(M) * cosd(2 * L0)
    - 0.5 * y * y * sind(4 * L0) - 1.25 * e * e * sind(2 * M));
  const R = (1.000001018 * (1 - e * e)) / (1 + e * cosd(M + C));
  return { lambda, decl, eqTime, eps, R };
}

/** Istante UTC di un evento solare (zenit dato) con tre iterazioni sulla posizione del sole. */
function sunEvent(dayUtcMs, lat, lng, zenith, sign) {
  let t = dayUtcMs + (720 - 4 * lng) * 60000;
  for (let i = 0; i < 3; i++) {
    const { decl, eqTime } = sunCoords(toJulian(t));
    const noonMin = 720 - 4 * lng - eqTime;
    if (zenith === null) {
      t = dayUtcMs + noonMin * 60000;
      continue;
    }
    const cosH = cosd(zenith) / (cosd(lat) * cosd(decl)) - Math.tan(lat * RAD) * Math.tan(decl * RAD);
    if (cosH > 1 || cosH < -1) return null;
    const H = Math.acos(cosH) / RAD;
    t = dayUtcMs + (noonMin + sign * 4 * H) * 60000;
  }
  return Math.round(t);
}

/**
 * Alba civile, sorgere, mezzogiorno solare, tramonto e crepuscolo civile del giorno locale dateYMD.
 * @returns {{dawn:number|null, sunrise:number|null, noon:number|null, sunset:number|null, dusk:number|null}}
 */
export function sunTimes(dateYMD, lat, lng) {
  const ymd = parseYMD(dateYMD);
  const empty = { dawn: null, sunrise: null, noon: null, sunset: null, dusk: null };
  if (!ymd || !validCoords(lat, lng)) return empty;
  const day = Date.UTC(ymd[0], ymd[1] - 1, ymd[2]);
  return {
    dawn: sunEvent(day, lat, lng, ZENITH_CIVIL, -1),
    sunrise: sunEvent(day, lat, lng, ZENITH_SUN, -1),
    noon: sunEvent(day, lat, lng, null, 0),
    sunset: sunEvent(day, lat, lng, ZENITH_SUN, 1),
    dusk: sunEvent(day, lat, lng, ZENITH_CIVIL, 1)
  };
}

/* ---------------------------------- Luna ---------------------------------- */

// Termini principali di Meeus (tab. 47.A e 47.B): [D, M, M', F, longitudine (gradi), distanza (km)]
const MOON_LR = [
  [0, 0, 1, 0, 6.288774, -20905.355], [2, 0, -1, 0, 1.274027, -3699.111],
  [2, 0, 0, 0, 0.658314, -2955.968], [0, 0, 2, 0, 0.213618, -569.925],
  [0, 1, 0, 0, -0.185116, 48.888], [0, 0, 0, 2, -0.114332, -3.149],
  [2, 0, -2, 0, 0.058793, 246.158], [2, -1, -1, 0, 0.057066, -152.138],
  [2, 0, 1, 0, 0.053322, -170.733], [2, -1, 0, 0, 0.045758, -204.586],
  [0, 1, -1, 0, -0.040923, -129.62], [1, 0, 0, 0, -0.03472, 108.743],
  [0, 1, 1, 0, -0.030383, 104.755], [2, 0, 0, -2, 0.015327, 10.321],
  [0, 0, 1, 2, -0.012528, 0], [0, 0, 1, -2, 0.01098, 79.661],
  [4, 0, -1, 0, 0.010675, -34.782], [0, 0, 3, 0, 0.010034, -23.21],
  [4, 0, -2, 0, 0.008548, -21.636], [2, 1, -1, 0, -0.007888, 24.208],
  [2, 1, 0, 0, -0.006766, 30.824], [1, 0, -1, 0, -0.005163, -8.379],
  [1, 1, 0, 0, 0.004987, -16.675], [2, -1, 1, 0, 0.004036, -12.831],
  [2, 0, 2, 0, 0.003994, -10.445], [4, 0, 0, 0, 0.003861, -11.65],
  [2, 0, -3, 0, 0.003665, 14.403], [0, 1, -2, 0, -0.002689, -7.003],
  [2, 0, -1, 2, -0.002602, 0], [2, -1, -2, 0, 0.00239, 10.056],
  [1, 0, 1, 0, -0.002348, 6.322], [2, -2, 0, 0, 0.002236, -9.884]
];
// [D, M, M', F, latitudine (gradi)]
const MOON_B = [
  [0, 0, 0, 1, 5.128122], [0, 0, 1, 1, 0.280602], [0, 0, 1, -1, 0.277693],
  [2, 0, 0, -1, 0.173237], [2, 0, -1, 1, 0.055413], [2, 0, -1, -1, 0.046271],
  [2, 0, 0, 1, 0.032573], [0, 0, 2, 1, 0.017198], [2, 0, 1, -1, 0.009266],
  [0, 0, 2, -1, 0.008822], [2, -1, 0, -1, 0.008216], [2, 0, -2, -1, 0.004324],
  [2, 0, 1, 1, 0.0042], [2, 1, 0, -1, -0.003359]
];

/** Longitudine e latitudine eclittiche apparenti della luna (gradi) e distanza (km). */
function moonCoords(jd) {
  const T = (jd - J2000) / 36525;
  const Lp = 218.3164477 + 481267.88123421 * T;
  const D = 297.8501921 + 445267.1114034 * T;
  const M = 357.5291092 + 35999.0502909 * T;
  const Mp = 134.9633964 + 477198.8675055 * T;
  const F = 93.272095 + 483202.0175233 * T;
  const E = 1 - 0.002516 * T;
  let lon = 0;
  let dist = 0;
  for (const [d, m, mp, f, l, r] of MOON_LR) {
    const arg = d * D + m * M + mp * Mp + f * F;
    const k = Math.abs(m) === 1 ? E : Math.abs(m) === 2 ? E * E : 1;
    lon += k * l * sind(arg);
    dist += k * r * cosd(arg);
  }
  let lat = 0;
  for (const [d, m, mp, f, b] of MOON_B) {
    const k = Math.abs(m) === 1 ? E : 1;
    lat += k * b * sind(d * D + m * M + mp * Mp + f * F);
  }
  const omega = 125.04452 - 1934.136261 * T;
  return {
    lon: norm360(Lp + lon - 0.00478 * sind(omega)),
    lat,
    dist: 385000.56 + dist
  };
}

/** Elongazione in longitudine luna-sole (0..360) e angolo di fase. */
function moonGeometry(ms) {
  const jd = toJulian(ms);
  const sun = sunCoords(jd);
  const moon = moonCoords(jd);
  const elong = norm360(moon.lon - sun.lambda);
  const cosPsi = cosd(moon.lat) * cosd(moon.lon - sun.lambda);
  const psi = Math.acos(Math.max(-1, Math.min(1, cosPsi)));
  const Rkm = sun.R * AU_KM;
  const phaseAngle = Math.atan2(Rkm * Math.sin(psi), moon.dist - Rkm * Math.cos(psi));
  return { elong, illuminated: (1 + Math.cos(phaseAngle)) / 2 };
}

/** Istante dell'ultima luna nuova prima di ms (metodo di Newton sull'elongazione). */
function previousNewMoon(ms) {
  const rate = 360 / SYNODIC_DAYS; // gradi al giorno, in media
  let t = ms - (moonGeometry(ms).elong / rate) * DAY_MS;
  for (let i = 0; i < 8; i++) {
    let e = moonGeometry(t).elong;
    if (e > 180) e -= 360;
    t -= (e / rate) * DAY_MS;
    if (Math.abs(e) < 1e-5) break;
  }
  // Una luna nuova di pochi minuti dopo è lo stesso evento, entro la precisione del modello
  if (t > ms && t - ms > 3600000) return previousNewMoon(ms - DAY_MS * 2);
  return Math.min(t, ms);
}

const PHASES = [
  ['new', 'Luna nuova'], ['waxing_crescent', 'Luna crescente'],
  ['first_quarter', 'Primo quarto'], ['waxing_gibbous', 'Gibbosa crescente'],
  ['full', 'Luna piena'], ['waning_gibbous', 'Gibbosa calante'],
  ['last_quarter', 'Ultimo quarto'], ['waning_crescent', 'Luna calante']
];

// Le fasi principali valgono entro un giorno di moto lunare dall'istante esatto.
const PRINCIPAL_HALF_WIDTH = 360 / SYNODIC_DAYS;

function phaseIndex(elong) {
  for (let i = 0; i < 4; i++) {
    const target = i * 90;
    const diff = Math.abs(((elong - target + 540) % 360) - 180);
    if (diff <= PRINCIPAL_HALF_WIDTH) return i * 2;
  }
  return Math.floor(elong / 90) * 2 + 1;
}

/**
 * Fase della luna all'istante dato.
 * fraction: posizione nel ciclo (0 = luna nuova, 0.5 = luna piena), dall'elongazione reale.
 * @returns {{phaseKey:string, phaseName:string, illuminationPct:number, ageDays:number, fraction:number}}
 */
export function moonPhase(epochMs) {
  const { elong, illuminated } = moonGeometry(epochMs);
  const [phaseKey, phaseName] = PHASES[phaseIndex(elong)];
  const ageDays = (epochMs - previousNewMoon(epochMs)) / DAY_MS;
  const fraction = Math.round((elong / 360) * 10000) / 10000;
  return {
    phaseKey,
    phaseName,
    illuminationPct: Math.round(illuminated * 1000) / 10,
    ageDays: Math.round(ageDays * 10) / 10,
    fraction: fraction >= 1 ? 0 : fraction
  };
}

/** Altezza geocentrica della luna meno l'altezza apparente dell'orizzonte (gradi). */
function moonAltitudeOverHorizon(ms, lat, lng) {
  const jd = toJulian(ms);
  const { lon, lat: b, dist } = moonCoords(jd);
  const { eps } = sunCoords(jd);
  const ra = Math.atan2(sind(lon) * cosd(eps) - Math.tan(b * RAD) * sind(eps), cosd(lon));
  const dec = Math.asin(sind(b) * cosd(eps) + cosd(b) * sind(eps) * sind(lon));
  const T = (jd - J2000) / 36525;
  const gmst = norm360(280.46061837 + 360.98564736629 * (jd - J2000) + T * T * (0.000387933 - T / 38710000));
  const H = (gmst + lng) * RAD - ra;
  const alt = Math.asin(sind(lat) * Math.sin(dec) + cosd(lat) * Math.cos(dec) * Math.cos(H)) / RAD;
  const parallax = Math.asin(EARTH_RADIUS_KM / dist) / RAD;
  // Bordo superiore all'orizzonte con rifrazione standard (Meeus, cap. 15)
  return alt - (0.7275 * parallax - 0.5667);
}

function refineCrossing(a, b, fa, fb, lat, lng) {
  let lo = a;
  let hi = b;
  let flo = fa;
  for (let i = 0; i < 30 && hi - lo > 1000; i++) {
    const mid = (lo + hi) / 2;
    const fm = moonAltitudeOverHorizon(mid, lat, lng);
    if ((fm > 0) === (flo > 0)) {
      lo = mid;
      flo = fm;
    } else {
      hi = mid;
    }
  }
  return Math.round((lo + hi) / 2);
}

/**
 * Sorgere e tramonto della luna nel giorno locale dateYMD (dalle 00:00 alle 24:00 dello spot).
 * Campionamento orario dell'altezza e affinamento per bisezione. null se nel giorno non avviene.
 */
export function moonTimes(dateYMD, lat, lng, utcOffsetSeconds = 0) {
  const ymd = parseYMD(dateYMD);
  if (!ymd || !validCoords(lat, lng)) return { rise: null, set: null };
  const start = Date.UTC(ymd[0], ymd[1] - 1, ymd[2]) - (Number(utcOffsetSeconds) || 0) * 1000;
  let rise = null;
  let set = null;
  let prevT = start;
  let prevF = moonAltitudeOverHorizon(start, lat, lng);
  for (let h = 1; h <= 24; h++) {
    const t = start + h * 3600000;
    const f = moonAltitudeOverHorizon(t, lat, lng);
    if (prevF <= 0 && f > 0 && rise === null) rise = refineCrossing(prevT, t, prevF, f, lat, lng);
    if (prevF > 0 && f <= 0 && set === null) set = refineCrossing(prevT, t, prevF, f, lat, lng);
    prevT = t;
    prevF = f;
  }
  return { rise, set };
}
