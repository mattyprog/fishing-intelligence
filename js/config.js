/**
 * Fishing Intelligence · configurazione dell'app.
 * Unico punto in cui cambiare nome, soglie di sicurezza, endpoint e collegamento al cloud.
 */

export const APP = {
  name: 'Fishing Intelligence',
  shortName: 'Fishing Intel',
  tagline: 'Previsioni di pesca da riva',
  version: '2.0.0',
  locale: 'it-IT'
};

export const API = {
  weather: 'https://api.open-meteo.com/v1/forecast',
  marine: 'https://marine-api.open-meteo.com/v1/marine',
  geocode: 'https://nominatim.openstreetmap.org/search',
  timeoutMs: 10000
};

export const CACHE = {
  prefix: 'fi2_fc_',
  freshMs: 30 * 60 * 1000, // sotto i 30 minuti non si riscarica
  usableMs: 24 * 60 * 60 * 1000, // oltre le 24 ore il punteggio non si mostra più
  maxSpots: 12
};

/** Soglie di sicurezza da riva. Valgono per ogni specie e vincono sul punteggio. */
export const SAFETY = {
  waveCautionM: 1.5,
  waveDangerM: 2.1,
  windCautionKmh: 30,
  windDangerKmh: 42,
  gustCautionKmh: 42,
  gustDangerKmh: 55,
  thunderCodes: [95, 96, 99],
  cautionCap: 75,
  dangerCap: 15
};

/**
 * Sincronizzazione cloud (Supabase), facoltativa.
 * La compila chi pubblica l'app: l'utente finale non vede mai questi valori.
 * Con i campi vuoti l'app lavora solo sul dispositivo e la sezione account resta nascosta.
 */
export const CLOUD = {
  url: '',
  anonKey: '',
  sdkUrl: 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.45.4/dist/umd/supabase.min.js'
};

export function isCloudConfigured() {
  return /^https:\/\/[a-z0-9-]+\.supabase\.co$/i.test(CLOUD.url.trim()) && CLOUD.anonKey.trim().length > 20;
}

export const LINKS = {
  meteoam: 'https://www.meteoam.it/it/meteo-mare',
  guardiaCostiera: 'https://www.guardiacostiera.gov.it',
  tesserino: 'https://www.sian.it/portale/servizi/comunicazione-pesca-sportiva-1',
  comunicazionePesca: 'https://www.guardiacostiera.gov.it/portale/comunicazione-di-pesca-sportiva-e-ricreativa',
  taglieMinime: 'https://eur-lex.europa.eu/legal-content/IT/TXT/?uri=CELEX:32019R1241',
  openMeteo: 'https://open-meteo.com',
  osmCopyright: 'https://www.openstreetmap.org/copyright'
};
