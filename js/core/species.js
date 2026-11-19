/**
 * Specie obiettivo, specie per il diario, taglie minime e regole della pesca sportiva.
 *
 * I profili delle 6 specie sono STIME DI SETTORE per la pesca da riva nel Tirreno centrale
 * (esperienza di surfcasting, non misure scientifiche): servono a confrontare le condizioni,
 * non a prevedere catture. Onda in metri, periodo in secondi, vento in km/h, acqua in °C.
 * seaPhase: bonus o malus (tra -0.15 e +0.15) per scaduta, montante e mare stabile.
 * months: 12 valori 0..1 da gennaio, riferiti alla metà del mese.
 */

import { LINKS } from '../config.js';

export const SPECIES = [
  {
    id: 'orata',
    name: 'Orata',
    scientificName: 'Sparus aurata',
    short: 'OR',
    summary: 'Ama il mare poco mosso o la fine della scaduta, la pressione stabile e le esche dure lanciate lontano.',
    minLegalSizeCm: 20,
    wave: { min: 0.1, optMin: 0.2, optMax: 0.8, max: 1.4 },
    period: { optMin: 4, optMax: 8 },
    wind: { optMin: 0, optMax: 20, max: 32 },
    windPreference: 'offshore',
    seaPhase: { scaduta: 0.1, montante: -0.1, stabile: 0 },
    waterTemp: { min: 13, optMin: 17, optMax: 25, max: 28 },
    months: [0.25, 0.2, 0.3, 0.5, 0.8, 0.9, 0.9, 0.9, 1, 1, 0.7, 0.4],
    light: { dawn: 0.9, day: 0.8, dusk: 1, night: 0.6 },
    pressure: 'stable',
    baits: ['Bibi', 'Americano', 'Granchio', 'Cannolicchio', 'Arenicola'],
    tactics: {
      rigCalm: 'Terminale lungo (long arm) da 160-200 cm in fluorocarbon 0.24-0.28 mm, amo beak n. 4-6.',
      rigRough: 'Terminale corto rovesciato da 110-130 cm in fluorocarbon 0.28-0.32 mm, con un piccolo galleggiante per staccare l\'esca dal fondo, amo n. 2-4.',
      where: 'Cerca il bordo esterno della secca, tra 80 e 130 m, o il confine tra acqua chiara e acqua velata, dove l\'orata cerca i molluschi.',
      when: 'Rende di più nelle due ore dopo l\'alba e nell\'ora prima del tramonto, meglio con la marea che sale.'
    }
  },
  {
    id: 'sarago',
    name: 'Sarago maggiore',
    scientificName: 'Diplodus sargus',
    short: 'SA',
    summary: 'Si muove con il mare formato e la schiuma, soprattutto di notte e con la pressione in calo.',
    minLegalSizeCm: 23,
    wave: { min: 0.4, optMin: 0.7, optMax: 1.6, max: 2.0 },
    period: { optMin: 5.5, optMax: 10 },
    wind: { optMin: 10, optMax: 30, max: 40 },
    windPreference: 'onshore',
    seaPhase: { scaduta: 0.15, montante: 0.05, stabile: -0.05 },
    waterTemp: { min: 11, optMin: 14, optMax: 21, max: 26 },
    months: [0.9, 0.9, 0.8, 0.7, 0.6, 0.5, 0.4, 0.4, 0.6, 0.8, 1, 1],
    light: { dawn: 0.8, day: 0.35, dusk: 0.9, night: 1 },
    pressure: 'falling',
    baits: ['Bibi', 'Cannolicchio', 'Americano', 'Sarda', 'Seppiolina'],
    tactics: {
      rigCalm: 'Due braccioli corti da 70-90 cm in fluorocarbon 0.25-0.28 mm, amo chinu n. 4-6.',
      rigRough: 'Trave da surfcasting con braccioli corti da 45-70 cm in fluorocarbon 0.30-0.35 mm, che reggono la risacca, amo n. 2-4.',
      where: 'Lancia subito dietro la linea dei frangenti o ai lati dei varchi dove l\'acqua torna al largo: lì la corrente accumula il cibo.',
      when: 'Dal crepuscolo per tutta la notte, soprattutto con il mare in scaduta e la marea alta.'
    }
  },
  {
    id: 'mormora',
    name: 'Mormora',
    scientificName: 'Lithognathus mormyrus',
    short: 'MO',
    summary: 'Pesce di sabbia che si avvicina con il mare calmo, nelle notti d\'estate, in cerca di vermi.',
    minLegalSizeCm: 20,
    wave: { min: 0.05, optMin: 0.1, optMax: 0.6, max: 1.1 },
    period: { optMin: 3, optMax: 7 },
    wind: { optMin: 0, optMax: 16, max: 28 },
    windPreference: 'any',
    seaPhase: { scaduta: 0.05, montante: -0.1, stabile: 0.05 },
    waterTemp: { min: 15, optMin: 18, optMax: 26, max: 29 },
    months: [0.15, 0.15, 0.25, 0.5, 0.8, 1, 1, 1, 0.9, 0.6, 0.35, 0.2],
    light: { dawn: 0.7, day: 0.3, dusk: 0.9, night: 1 },
    pressure: 'stable',
    baits: ['Arenicola', 'Americano', 'Coreano', 'Bibi', 'Cannolicchio'],
    tactics: {
      rigCalm: 'Trave a 2 o 3 ami con braccioli da 90-130 cm in fluorocarbon 0.18-0.22 mm, amo a gambo lungo n. 8-10 innescato con l\'ago.',
      rigRough: 'Trave a 2 ami con braccioli da 70-90 cm in fluorocarbon 0.22-0.25 mm, amo n. 6 e piombo a piramide.',
      where: 'Prova a ventaglio a 30, 60 e 90 m fino a trovare il branco nel canalone; trovata la distanza giusta, segnala il punto sul filo.',
      when: 'Dal tramonto alle prime tre ore di buio e nell\'ora prima dell\'alba.'
    }
  },
  {
    id: 'spigola',
    name: 'Spigola',
    scientificName: 'Dicentrarchus labrax',
    short: 'SP',
    summary: 'Caccia sotto riva nella risacca, con il mare in scaduta e l\'acqua velata, ai cambi di luce.',
    minLegalSizeCm: 25,
    wave: { min: 0.3, optMin: 0.6, optMax: 1.6, max: 2.0 },
    period: { optMin: 5, optMax: 10 },
    wind: { optMin: 8, optMax: 30, max: 40 },
    windPreference: 'onshore',
    seaPhase: { scaduta: 0.15, montante: 0.1, stabile: -0.05 },
    waterTemp: { min: 8, optMin: 11, optMax: 18, max: 24 },
    months: [1, 1, 0.9, 0.6, 0.4, 0.25, 0.2, 0.2, 0.35, 0.6, 0.9, 1],
    light: { dawn: 1, day: 0.35, dusk: 1, night: 0.85 },
    pressure: 'falling',
    baits: ['Americano', 'Sarda', 'Cannolicchio', 'Trancio di cefalo', 'Arenicola'],
    tactics: {
      rigCalm: 'Terminale lungo da 140-170 cm in fluorocarbon 0.26-0.30 mm, innesco abbondante di americano o due vermi su amo n. 2-4.',
      rigRough: 'Terminale corto da 90-120 cm in fluorocarbon 0.32-0.40 mm con trancio di sarda o di cefalo, oppure cannolicchio intero legato con filo elastico, amo n. 1/0-2.',
      where: 'Non trascurare i primi 15-35 m da riva: la spigola caccia nel gradino della risacca e nelle buche sotto riva.',
      when: 'Ai cambi di luce, all\'alba e al tramonto, e di notte con la luna nuova o piena.'
    }
  },
  {
    id: 'ombrina',
    name: 'Ombrina',
    scientificName: 'Umbrina cirrosa',
    short: 'OM',
    summary: 'Entra nei canaloni di sabbia durante la scaduta, quando l\'acqua è ancora torbida.',
    minLegalSizeCm: null,
    wave: { min: 0.25, optMin: 0.4, optMax: 1.2, max: 1.7 },
    period: { optMin: 4.5, optMax: 9 },
    wind: { optMin: 5, optMax: 25, max: 35 },
    windPreference: 'any',
    seaPhase: { scaduta: 0.15, montante: 0, stabile: -0.05 },
    waterTemp: { min: 15, optMin: 18, optMax: 25, max: 28 },
    months: [0.1, 0.1, 0.2, 0.4, 0.7, 1, 1, 1, 0.9, 0.7, 0.35, 0.15],
    light: { dawn: 0.8, day: 0.3, dusk: 1, night: 0.95 },
    pressure: 'stable',
    baits: ['Arenicola', 'Americano', 'Bibi', 'Cannolicchio'],
    tactics: {
      rigCalm: 'Terminale da 120-140 cm in fluorocarbon 0.24-0.28 mm, amo n. 4-6.',
      rigRough: 'Terminale corto da 85-110 cm in fluorocarbon 0.28-0.32 mm con innesco abbondante di americano o bibi, amo n. 2-4.',
      where: 'Lancia nelle buche tra il primo e il secondo banco di sabbia, dove la mareggiata ha smosso i vermi.',
      when: 'Al crepuscolo e nelle prime ore di buio, con il mare in scaduta.'
    }
  },
  {
    id: 'serra',
    name: 'Pesce serra',
    scientificName: 'Pomatomus saltatrix',
    short: 'PS',
    summary: 'Predatore delle acque calde: caccia al tramonto e di notte, vicino alle foci e nei canaloni.',
    minLegalSizeCm: null,
    wave: { min: 0.15, optMin: 0.3, optMax: 1.1, max: 1.6 },
    period: { optMin: 4, optMax: 8.5 },
    wind: { optMin: 5, optMax: 25, max: 35 },
    windPreference: 'any',
    // Ritoccato rispetto ai valori di partenza (scaduta +0.05, altri 0): il serra caccia il pesce
    // foraggio nell'acqua smossa e velata della scaduta, come la spigola.
    seaPhase: { scaduta: 0.15, montante: 0.05, stabile: -0.05 },
    waterTemp: { min: 16, optMin: 19, optMax: 26, max: 29 },
    months: [0.1, 0.1, 0.15, 0.3, 0.7, 0.9, 1, 1, 1, 0.9, 0.6, 0.2],
    light: { dawn: 1, day: 0.4, dusk: 1, night: 0.8 },
    pressure: 'stable',
    baits: ['Trancio di cefalo', 'Sarda', 'Seppiolina', 'Americano'],
    tactics: {
      rigCalm: 'Terminale da 120 cm in fluorocarbon 0.45 mm con 25 cm di cavetto d\'acciaio, due ami n. 2/0-3/0 sul trancio.',
      rigRough: 'Terminale corto da 90 cm in fluorocarbon 0.50 mm con cavetto, trancio legato bene con filo elastico.',
      where: 'Metti l\'esca al centro del canalone principale o vicino alle foci, con la frizione morbida.',
      when: 'Dal tramonto a mezzanotte e all\'alba.'
    }
  }
].map((s) => deepFreeze(s));

const SIZE_SOURCE = 'Reg. (UE) 2019/1241, allegato IX';

/** Specie per il diario. Taglie: Reg. (UE) 2019/1241, allegato IX, parte A (Mediterraneo). */
export const CATCH_SPECIES = [
  ['orata', 'Orata', 'Sparus aurata', 20],
  ['sarago', 'Sarago maggiore', 'Diplodus sargus', 23],
  ['mormora', 'Mormora', 'Lithognathus mormyrus', 20],
  ['spigola', 'Spigola', 'Dicentrarchus labrax', 25],
  ['ombrina', 'Ombrina', 'Umbrina cirrosa', null],
  ['serra', 'Pesce serra', 'Pomatomus saltatrix', null],
  ['sarago-fasciato', 'Sarago fasciato', 'Diplodus vulgaris', 18],
  ['sarago-pizzuto', 'Sarago pizzuto', 'Diplodus puntazzo', 18],
  ['sparaglione', 'Sparaglione', 'Diplodus annularis', 12],
  ['fragolino', 'Pagello fragolino', 'Pagellus erythrinus', 15],
  ['pagro', 'Pagro', 'Pagrus pagrus', 18],
  ['triglia', 'Triglia', 'Mullus spp.', 11],
  ['sogliola', 'Sogliola', 'Solea vulgaris', 20],
  ['leccia-stella', 'Leccia stella', 'Trachinotus ovatus', null],
  ['grongo', 'Grongo', 'Conger conger', null],
  ['cefalo', 'Cefalo', 'Mugilidae', null],
  ['sugarello', 'Sugarello', 'Trachurus spp.', 15],
  ['altro', 'Altra specie', null, null]
].map(([id, name, scientificName, minLegalSizeCm]) => Object.freeze({ id, name, scientificName, minLegalSizeCm }));

// Nomi comuni alternativi, per riconoscere le catture scritte a mano
const ALIASES = {
  branzino: 'spigola',
  'spigola (branzino)': 'spigola',
  sarago: 'sarago',
  'sarago testa nera': 'sarago-fasciato',
  serra: 'serra',
  pagello: 'fragolino',
  fragolino: 'fragolino',
  'triglia di scoglio': 'triglia',
  'triglia di fango': 'triglia',
  muggine: 'cefalo',
  mugine: 'cefalo',
  suro: 'sugarello',
  leccia: 'leccia-stella'
};

/** Regole della pesca sportiva in mare, con le fonti. */
export const REGULATIONS = Object.freeze({
  dailyLimitKg: 5,
  maxHooksPerRod: 3,
  sources: Object.freeze([
    { label: 'Reg. (UE) 2019/1241, allegato IX: taglie minime nel Mediterraneo', url: LINKS.taglieMinime },
    {
      label: 'DPR 1639/1968, art. 142 (5 kg al giorno salvo pesce singolo più pesante) e art. 138 (canne con non più di tre ami)',
      url: 'https://www.normattiva.it/uri-res/N2Ls?urn:nir:presidente.repubblica:decreto:1968-10-02;1639'
    },
    { label: 'Comunicazione annuale e gratuita della pesca sportiva (MASAF, portale SIAN)', url: LINKS.tesserino }
  ].map((s) => Object.freeze(s)))
});

const ARTICLES = { orata: "l'orata", sarago: 'il sarago', mormora: 'la mormora', spigola: 'la spigola', ombrina: "l'ombrina", serra: 'il serra' };

export function getSpecies(id) {
  return SPECIES.find((s) => s.id === id) || null;
}

/** Nome con articolo per i testi ("l'orata", "il sarago"). */
export function withArticle(species) {
  if (!species) return '';
  return ARTICLES[species.id] || String(species.name || '').toLowerCase();
}

function normalize(str) {
  return String(str || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function findCatchSpecies(idOrName) {
  const key = normalize(idOrName);
  if (!key) return null;
  const aliasId = ALIASES[key];
  return CATCH_SPECIES.find((s) => s.id === key || s.id === aliasId || normalize(s.name) === key
    || (s.scientificName && normalize(s.scientificName) === key)) || null;
}

/** Taglia minima per id o nome comune → { cm, source }, null se la specie non ne ha o non è nota. */
export function legalSizeFor(idOrName) {
  const sp = findCatchSpecies(idOrName);
  if (!sp || !Number.isFinite(sp.minLegalSizeCm)) return null;
  return { cm: sp.minLegalSizeCm, source: SIZE_SOURCE };
}

/** Id della specie a partire da un id o da un nome ("Sarago Maggiore" → "sarago"); null se non è in elenco. */
export function speciesIdFor(idOrName) {
  const sp = findCatchSpecies(idOrName);
  return sp ? sp.id : null;
}

function deepFreeze(obj) {
  for (const v of Object.values(obj)) if (v && typeof v === 'object') deepFreeze(v);
  return Object.freeze(obj);
}
