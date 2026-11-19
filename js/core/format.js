/**
 * Formattazione di numeri, venti, stato del mare e codici meteo.
 * Modulo puro: nessuna dipendenza dal DOM né dal fuso del dispositivo.
 */

const NA = 'n.d.';

/** Numero con decimali fissi, 'n.d.' se manca. */
export function fmtNum(n, decimals = 0) {
  if (n === null || n === undefined || n === '' || !Number.isFinite(Number(n))) return NA;
  return Number(n).toFixed(decimals);
}

/** Numero con unità ('0.6 m'), 'n.d.' se manca. */
export function fmtUnit(n, unit, decimals = 0) {
  const s = fmtNum(n, decimals);
  return s === NA ? NA : `${s} ${unit}`;
}

const CARDINALS = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE', 'S', 'SSO', 'SO', 'OSO', 'O', 'ONO', 'NO', 'NNO'];
const WIND_NAMES = ['Tramontana', 'Grecale', 'Levante', 'Scirocco', 'Ostro', 'Libeccio', 'Ponente', 'Maestrale'];

/** Direzione di provenienza in gradi → punto cardinale (16, con O per ovest) e nome del vento. */
export function windName(deg) {
  if (deg === null || deg === undefined || !Number.isFinite(Number(deg))) return { cardinal: NA, name: NA };
  const d = ((Number(deg) % 360) + 360) % 360;
  return {
    cardinal: CARDINALS[Math.round(d / 22.5) % 16],
    name: WIND_NAMES[Math.round(d / 45) % 8]
  };
}

/**
 * Stato del mare secondo la scala Douglas usata nei bollettini italiani:
 * calmo 0 m, quasi calmo fino a 0.1, poco mosso fino a 0.5, mosso fino a 1.25,
 * molto mosso fino a 2.5, agitato oltre (la scala distingue "molto agitato" sopra i 4 m).
 */
export function seaStateLabel(waveM) {
  if (waveM === null || waveM === undefined || !Number.isFinite(Number(waveM))) return NA;
  const h = Number(waveM);
  if (h < 0.005) return 'calmo';
  if (h <= 0.1) return 'quasi calmo';
  if (h <= 0.5) return 'poco mosso';
  if (h <= 1.25) return 'mosso';
  if (h <= 2.5) return 'molto mosso';
  return 'agitato';
}

const WMO = {
  0: ['Sereno', 'sun'],
  1: ['Poco nuvoloso', 'cloud-sun'],
  2: ['Parzialmente nuvoloso', 'cloud-sun'],
  3: ['Coperto', 'cloud'],
  45: ['Nebbia', 'fog'],
  48: ['Nebbia con brina', 'fog'],
  51: ['Pioviggine debole', 'rain'],
  53: ['Pioviggine', 'rain'],
  55: ['Pioviggine fitta', 'rain'],
  56: ['Pioviggine gelata', 'rain'],
  57: ['Pioviggine gelata fitta', 'rain'],
  61: ['Pioggia debole', 'rain'],
  63: ['Pioggia', 'rain'],
  65: ['Pioggia forte', 'rain'],
  66: ['Pioggia gelata', 'rain'],
  67: ['Pioggia gelata forte', 'rain'],
  71: ['Neve debole', 'cloud'],
  73: ['Neve', 'cloud'],
  75: ['Neve forte', 'cloud'],
  77: ['Neve a granuli', 'cloud'],
  80: ['Rovesci deboli', 'rain'],
  81: ['Rovesci', 'rain'],
  82: ['Rovesci forti', 'rain'],
  85: ['Rovesci di neve', 'cloud'],
  86: ['Rovesci di neve forti', 'cloud'],
  95: ['Temporale', 'bolt'],
  96: ['Temporale con grandine', 'bolt'],
  99: ['Temporale forte con grandine', 'bolt']
};

/** Codice meteo WMO → { label, icon } con icon tra sun, cloud-sun, cloud, fog, rain, bolt. */
export function weatherLabel(code) {
  const entry = Number.isInteger(code) ? WMO[code] : undefined;
  if (!entry) return { label: NA, icon: 'cloud' };
  return { label: entry[0], icon: entry[1] };
}
