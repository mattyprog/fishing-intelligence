/**
 * Spot predefiniti: litorale pontino e golfo di Gaeta.
 * Coordinate controllate con la geocodifica inversa di OpenStreetMap (novembre 2026).
 * coast_orientation_deg: direzione verso cui guarda la spiaggia, da terra al mare aperto.
 * Fondale e note sono indicazioni di massima: il fondale sabbioso cambia a ogni mareggiata.
 */

export const PREDEFINED_SPOTS = [
  {
    id: 'salto-di-fondi',
    name: 'Salto di Fondi',
    region: 'Fondi (LT)',
    lat: 41.2889,
    lng: 13.3461,
    coast_orientation_deg: 210,
    seabed_type: 'Sabbia media, canalone parallelo a riva',
    notes: 'Spiaggia aperta e regolare. Mormore e orate a distanza, spigole e saraghi nel primo canalone con il mare in scaduta.'
  },
  {
    id: 'capratica',
    name: 'Capratica',
    region: 'Fondi (LT)',
    lat: 41.2835,
    lng: 13.3772,
    coast_orientation_deg: 205,
    seabed_type: 'Sabbia fine, secche esterne e buche di risacca',
    notes: 'Tratto naturale con dune. Regge bene il mare da sud ovest e le buche si leggono facilmente.'
  },
  {
    id: 'sperlonga-ponente',
    name: 'Sperlonga, spiaggia di Ponente',
    region: 'Sperlonga (LT)',
    lat: 41.2582,
    lng: 13.4285,
    coast_orientation_deg: 215,
    seabed_type: 'Sabbia fine chiara, fondale che scende piano',
    notes: 'Acqua di solito più limpida. Orate e mormore nelle notti estive e autunnali.'
  },
  {
    id: 'terracina-badino',
    name: 'Terracina, foce di Porto Badino',
    region: 'Terracina (LT)',
    lat: 41.2838,
    lng: 13.2194,
    coast_orientation_deg: 195,
    seabed_type: 'Sabbia media con detrito portato dalla foce',
    notes: 'Corrente e acqua dolce richiamano spigole, ombrine, mormore e serra.'
  },
  {
    id: 'gaeta-serapo',
    name: 'Gaeta, spiaggia di Serapo',
    region: 'Gaeta (LT)',
    lat: 41.2128,
    lng: 13.5621,
    coast_orientation_deg: 200,
    seabed_type: 'Sabbia media tra due promontori rocciosi',
    notes: 'Baia riparata ai lati: tiene anche con mare importante. Saraghi e orate.'
  },
  {
    id: 'sabaudia-bufalara',
    name: 'Sabaudia, lungomare',
    region: 'Sabaudia (LT)',
    lat: 41.2674,
    lng: 13.0218,
    coast_orientation_deg: 235,
    seabed_type: 'Sabbia, gradino marcato e canaloni vicini a riva',
    notes: 'Spiaggia ad alta energia: canaloni profondi già a 25-40 metri.'
  },
  {
    id: 'circeo-la-cona',
    name: 'San Felice Circeo, La Cona',
    region: 'San Felice Circeo (LT)',
    lat: 41.2335,
    lng: 13.1065,
    coast_orientation_deg: 175,
    seabed_type: 'Misto di sabbia, ciottoli e posidonia',
    notes: 'Il promontorio ripara dai venti da nord ovest. Saraghi e orate.'
  },
  {
    id: 'scauri-minturno',
    name: 'Scauri',
    region: 'Minturno (LT)',
    lat: 41.2528,
    lng: 13.7115,
    coast_orientation_deg: 210,
    seabed_type: 'Sabbia scura, pendenza dolce',
    notes: 'Fondale ricco di telline e vermi. Mormore, ombrine e spigole con il mare in scaduta.'
  }
].map((s) => Object.freeze({ ...s, client_id: s.id, isCustom: false }));
