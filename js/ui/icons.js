/**
 * Icone SVG in linea (tratto 1.75, colore ereditato dal testo).
 * Uso: icon('wave') oppure icon('wave', { size: 32, cls: 'muted' }).
 */

const P = {
  radar: '<circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="5"/><circle cx="12" cy="12" r="1"/><path d="M12 3v4M12 12l5.5-5.5"/>',
  rod: '<path d="M4 20 19 5"/><path d="M19 5c1.5 1.5 1.5 4 0 5.500"/><path d="M19 10.500V14"/><circle cx="19" cy="15.500" r="1.500"/><circle cx="8" cy="16" r="2"/>',
  'map-pin': '<path d="M20 10c0 5.500-8 12-8 12S4 15.500 4 10a8 8 0 0 1 16 0Z"/><circle cx="12" cy="10" r="3"/>',
  settings: '<path d="M4 6h10M18 6h2M4 12h4M12 12h8M4 18h12M20 18h0"/><circle cx="16" cy="6" r="2"/><circle cx="10" cy="12" r="2"/><circle cx="18" cy="18" r="2"/>',
  wave: '<path d="M2 8c2.500 0 2.500 2 5 2s2.500-2 5-2 2.500 2 5 2 2.500-2 5-2"/><path d="M2 14c2.500 0 2.500 2 5 2s2.500-2 5-2 2.500 2 5 2 2.500-2 5-2"/>',
  wind: '<path d="M3 8h10a3 3 0 1 0-3-3"/><path d="M3 12h16a3 3 0 1 1-3 3"/><path d="M3 16h7a2.500 2.500 0 1 1-2.500 2.500"/>',
  gauge: '<path d="M4 18a9 9 0 1 1 16 0"/><path d="m12 13 4-5"/><circle cx="12" cy="13" r="1.200"/>',
  thermometer: '<path d="M14 14.800V5a2 2 0 0 0-4 0v9.800a4 4 0 1 0 4 0Z"/><path d="M12 9v6"/>',
  moon: '<path d="M20 14.500A8 8 0 0 1 9.500 4a8 8 0 1 0 10.500 10.500Z"/>',
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.900 4.900l1.400 1.400M17.700 17.700l1.400 1.400M2 12h2M20 12h2M4.900 19.100l1.400-1.400M17.700 6.300l1.400-1.400"/>',
  sunrise: '<path d="M3 18h18M5 22h14"/><path d="M6.500 18a5.500 5.500 0 0 1 11 0"/><path d="M12 9V3M9 6l3-3 3 3"/>',
  sunset: '<path d="M3 18h18M5 22h14"/><path d="M6.500 18a5.500 5.500 0 0 1 11 0"/><path d="M12 3v6M9 6l3 3 3-3"/>',
  tide: '<path d="M2 17c2.500 0 2.500 2 5 2s2.500-2 5-2 2.500 2 5 2 2.500-2 5-2"/><path d="M8 4v8M5 7l3-3 3 3"/><path d="M16 12V4M13 9l3 3 3-3"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  calendar: '<rect x="3" y="5" width="18" height="16" rx="2"/><path d="M3 10h18M8 3v4M16 3v4"/>',
  alert: '<path d="M10.300 3.900 2.400 17.500A2 2 0 0 0 4.100 20.500h15.800a2 2 0 0 0 1.700-3L13.700 3.900a2 2 0 0 0-3.400 0Z"/><path d="M12 9v4M12 17h0"/>',
  shield: '<path d="M12 3 4 6v6c0 4.500 3.200 8 8 9 4.800-1 8-4.500 8-9V6l-8-3Z"/><path d="m9 12 2 2 4-4"/>',
  check: '<path d="m5 12.500 4.500 4.500L19 7.500"/>',
  x: '<path d="M6 6l12 12M18 6 6 18"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  minus: '<path d="M5 12h14"/>',
  refresh: '<path d="M20 11a8 8 0 0 0-14.500-4.500L4 8"/><path d="M4 4v4h4"/><path d="M4 13a8 8 0 0 0 14.500 4.500L20 16"/><path d="M20 20v-4h-4"/>',
  search: '<circle cx="11" cy="11" r="7"/><path d="m20 20-3.500-3.500"/>',
  crosshair: '<circle cx="12" cy="12" r="7"/><path d="M12 2v4M12 18v4M2 12h4M18 12h4"/><circle cx="12" cy="12" r="1"/>',
  filter: '<path d="M3 5h18l-7 8.500V19l-4 2v-7.500L3 5Z"/>',
  trash: '<path d="M4 7h16M10 11v6M14 11v6"/><path d="M6 7l1 12a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-12"/><path d="M9 7V4h6v3"/>',
  edit: '<path d="M4 20h4L19 9l-4-4L4 16v4Z"/><path d="m13.500 6.500 4 4"/>',
  'chevron-down': '<path d="m6 9 6 6 6-6"/>',
  'chevron-right': '<path d="m9 6 6 6-6 6"/>',
  'chevron-left': '<path d="m15 6-6 6 6 6"/>',
  info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v5M12 8h0"/>',
  scale: '<path d="M12 4v16M7 20h10"/><path d="M5 7h14"/><path d="m5 7-3 7a3 3 0 0 0 6 0L5 7ZM19 7l-3 7a3 3 0 0 0 6 0l-3-7Z"/>',
  fish: '<path d="M3 12c3-4.500 7-6 11-6 3 0 5.500 2 7 6-1.500 4-4 6-7 6-4 0-8-1.500-11-6Z"/><path d="M3 12 1 8.500M3 12l-2 3.500"/><circle cx="16.500" cy="10.500" r=".800"/><path d="M11 9.500c1 1.500 1 3.500 0 5"/>',
  download: '<path d="M12 4v11M7.500 10.500 12 15l4.500-4.500"/><path d="M4 20h16"/>',
  upload: '<path d="M12 15V4M7.500 8.500 12 4l4.500 4.500"/><path d="M4 20h16"/>',
  layers: '<path d="m12 3 9 5-9 5-9-5 9-5Z"/><path d="m3 13 9 5 9-5"/>',
  cloud: '<path d="M7 18a4.500 4.500 0 0 1-.500-9 6 6 0 0 1 11.500 1.500 3.800 3.800 0 0 1-.500 7.500H7Z"/>',
  'cloud-off': '<path d="M3 3l18 18"/><path d="M8.500 9.200A4.500 4.500 0 0 0 7 18h11"/><path d="M11 5.500a6 6 0 0 1 7 5 3.800 3.800 0 0 1 2.500 5.500"/>',
  user: '<circle cx="12" cy="8" r="4"/><path d="M4 21a8 8 0 0 1 16 0"/>',
  'log-out': '<path d="M9 4H6a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h3"/><path d="M15 16l4-4-4-4M19 12H9"/>',
  external: '<path d="M14 4h6v6M20 4l-9 9"/><path d="M18 14v4a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4"/>',
  star: '<path d="m12 3 2.700 5.600 6.100.900-4.400 4.300 1 6.100L12 17l-5.400 2.900 1-6.100L3.200 9.500l6.100-.900L12 3Z"/>',
  droplet: '<path d="M12 3s6 6.200 6 11a6 6 0 0 1-12 0c0-4.800 6-11 6-11Z"/>',
  ruler: '<path d="m3 16 13-13 5 5L8 21l-5-5Z"/><path d="m7 12 2 2M10 9l2 2M13 6l2 2"/>',
  list: '<path d="M8 6h12M8 12h12M8 18h12M4 6h0M4 12h0M4 18h0"/>',
  rain: '<path d="M7 15a4.500 4.500 0 0 1-.500-9 6 6 0 0 1 11.500 1.500 3.800 3.800 0 0 1-.500 7.500"/><path d="M8 18l-1 3M12 18l-1 3M16 18l-1 3"/>',
  bolt: '<path d="M7 14a4.500 4.500 0 0 1-.500-9 6 6 0 0 1 11.500 1.500A3.800 3.800 0 0 1 18 14"/><path d="m12.500 11-3 5h4l-2 5"/>',
  'cloud-sun': '<path d="M12 3v1.500M5.600 5.600l1 1M3 12h1.500M18.400 5.600l-1 1"/><path d="M8 11a4 4 0 0 1 7.500-2"/><path d="M9 20a3.500 3.500 0 0 1-.300-7 4.800 4.800 0 0 1 9.200 1.200 3 3 0 0 1-.400 5.800H9Z"/>',
  fog: '<path d="M7 13a4.500 4.500 0 0 1-.500-9 6 6 0 0 1 11.500 1.500 3.800 3.800 0 0 1-.500 7.500"/><path d="M4 17h16M6 21h12"/>',
  compass: '<circle cx="12" cy="12" r="9"/><path d="m15.500 8.500-2 5-5 2 2-5 5-2Z"/>',
  arrow: '<path d="M12 20V5M6 11l6-6 6 6"/>'
};

export const ICON_NAMES = Object.keys(P);

export function icon(name, { size = 20, cls = '' } = {}) {
  const body = P[name] || P.info;
  const klass = cls ? `icon ${cls}` : 'icon';
  return `<svg class="${klass}" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">${body}</svg>`;
}
