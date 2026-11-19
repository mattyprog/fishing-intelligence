/**
 * Vista "Diario": catture su mappa e in elenco, con numeri essenziali e modulo di registrazione.
 * La taglia minima di legge viene ricordata mentre si scrive la lunghezza.
 */

import { state, bus } from '../../state.js';
import { $, html, raw, on, openSheet, confirmDialog, toast, formData, fmtDateTime } from '../dom.js';
import { icon } from '../icons.js';
import {
  listCatches,
  saveCatch,
  deleteCatch,
  listSpots,
  getSpot,
  listGear,
  listBaits,
  countDemoRecords,
  removeDemoRecords
} from '../../services/storage.js';
import { CATCH_SPECIES, legalSizeFor } from '../../core/species.js';
import { computeCatchStats, computeInsights } from '../../core/stats.js';
import { windName } from '../../core/format.js';
import { createMap, requestGps } from '../map.js';

let root = null;
let filterSpecies = 'all';
let mapApi = null;
let mapPromise = null;
let markerLayer = null;

const PHASE_LABEL = { scaduta: 'mare in scaduta', montante: 'mare in aumento', stabile: 'mare stabile' };
const LIGHT_LABEL = { night: 'di notte', dawn: 'all\'alba', day: 'di giorno', dusk: 'al tramonto' };

const numOrNull = (v) => {
  if (v === null || v === undefined || String(v).trim() === '') return null;
  const n = Number(String(v).replace(',', '.'));
  return Number.isFinite(n) ? n : NaN;
};

function fmtWeight(g) {
  if (!Number.isFinite(g)) return null;
  return g >= 1000 ? `${(g / 1000).toFixed(2).replace(/0$/, '')} kg` : `${Math.round(g)} g`;
}

function fmtLength(cm) {
  return Number.isFinite(cm) ? `${Number(cm.toFixed(1))} cm` : null;
}

function sizeLine(c) {
  return [fmtWeight(c.weight_g), fmtLength(c.length_cm)].filter(Boolean).join(' · ') || 'misure non indicate';
}

function speciesCode(name) {
  return String(name || '?').trim().slice(0, 2).toUpperCase();
}

/** Vero se la cattura è sotto la taglia minima di legge e non è stata rilasciata. */
function isUndersized(c) {
  const legal = legalSizeFor(c.species_id || c.species);
  return Boolean(legal && Number.isFinite(c.length_cm) && c.length_cm < legal.cm && !c.released);
}

function toLocalInputValue(date) {
  const d = new Date(date.getTime() - date.getTimezoneOffset() * 60000);
  return d.toISOString().slice(0, 16);
}

// ---------------------------------------------------------------- Montaggio

export function mount(el) {
  root = el;
  root.innerHTML = `
    <h1 class="view-title">Diario</h1>
    <div data-slot="top"></div>
    <div class="card diary-map-card hidden" data-slot="map-card">
      <div class="diary-map" data-slot="map" aria-label="Mappa delle catture"></div>
    </div>
    <div data-slot="list"></div>
    <button type="button" class="fab" data-act="new" aria-label="Registra cattura">${icon('plus', { size: 26 })}</button>`;

  on(root, 'click', '[data-act]', (ev, el2) => {
    const { act, id } = el2.dataset;
    if (act === 'new') openCatchForm(null);
    else if (act === 'open') openCatchDetail(id);
    else if (act === 'filter') {
      filterSpecies = el2.dataset.species;
      render();
    } else if (act === 'remove-demo') removeDemo();
  });

  bus.on('data:changed', ({ kind } = {}) => {
    if (kind === 'catches' || kind === 'all') render();
  });
  render();
}

export function show(params = {}) {
  render();
  mapApi?.map.invalidateSize();
  if (params.nuova) {
    // Scorciatoia "Registra cattura": si apre una volta sola, poi l'indirizzo torna pulito
    window.history.replaceState(null, '', '#diario');
    openCatchForm(null);
  }
}

// ---------------------------------------------------------------- Disegno

function render() {
  if (!root) return;
  const all = listCatches();
  const top = $('[data-slot="top"]', root);
  const list = $('[data-slot="list"]', root);
  const mapCard = $('[data-slot="map-card"]', root);

  if (!all.length) {
    top.innerHTML = '';
    mapCard.classList.add('hidden');
    list.innerHTML = html`<div class="card">
      <div class="empty">
        <div class="empty-icon">${raw(icon('fish', { size: 28 }))}</div>
        <p class="empty-title">Nessuna cattura, per ora</p>
        <p class="empty-text">Registra la prima: col tempo il diario ti dirà dove, quando e con che esca prendi di più.</p>
        <button type="button" class="btn btn-primary" data-act="new">Registra cattura</button>
      </div>
    </div>`.toString();
    return;
  }

  const speciesNames = Array.from(new Set(all.map((c) => c.species))).sort((a, b) => a.localeCompare(b, 'it'));
  if (filterSpecies !== 'all' && !speciesNames.includes(filterSpecies)) filterSpecies = 'all';
  const shown = filterSpecies === 'all' ? all : all.filter((c) => c.species === filterSpecies);
  const demoCount = all.filter((c) => c.is_demo).length;

  let stats = null;
  let insights = [];
  try {
    stats = computeCatchStats(shown);
    insights = computeInsights(all) || [];
  } catch (err) {
    console.error('Statistiche del diario non calcolate:', err);
  }

  top.innerHTML = html`
    ${demoCount ? raw(demoNotice(demoCount)) : ''}
    ${stats ? raw(statsTiles(stats)) : ''}`.toString();

  mapCard.classList.remove('hidden');
  ensureMap().then(() => updateMarkers(shown));

  list.innerHTML = html`
    ${
      insights.length
        ? html`<section class="card diary-insights">
            <h2 class="card-title">Cosa dice il tuo diario</h2>
            <div class="list">
              ${insights.map((i) => html`<div class="list-item"><div><div class="item-title">${i.title}</div><div class="item-sub">${i.text}</div></div></div>`)}
            </div>
          </section>`
        : ''
    }
    <div class="row-between diary-head">
      <h2 class="section-title">Catture</h2>
      <span class="small muted num">${shown.length} ${shown.length === 1 ? 'cattura' : 'catture'}</span>
    </div>
    ${
      speciesNames.length > 1
        ? html`<div class="chips diary-filters" role="group" aria-label="Filtra per specie">
            <button type="button" class="chip-btn" data-act="filter" data-species="all" aria-pressed="${filterSpecies === 'all' ? 'true' : 'false'}">Tutte</button>
            ${speciesNames.map((name) => html`<button type="button" class="chip-btn" data-act="filter" data-species="${name}" aria-pressed="${filterSpecies === name ? 'true' : 'false'}">${name}</button>`)}
          </div>`
        : ''
    }
    <div class="card"><div class="list">${shown.map(catchItem)}</div></div>`.toString();
}

function demoNotice(count) {
  return html`<div class="notice notice-info diary-demo">
    ${raw(icon('info'))}
    <div class="stack-sm">
      <p>${count === 1 ? 'Una cattura è un esempio' : `${count} catture sono esempi`} della versione precedente: falsano i tuoi numeri.</p>
      <button type="button" class="btn-link" data-act="remove-demo">Rimuovi gli esempi</button>
    </div>
  </div>`.toString();
}

function statsTiles(stats) {
  const record = stats.record;
  const recordValue = record ? fmtWeight(record.weight_g) || fmtLength(record.length_cm) || 'n.d.' : 'n.d.';
  const tile = (iconName, label, value, sub) => html`<div class="tile">
    <div class="tile-label">${raw(icon(iconName, { size: 14 }))}<span>${label}</span></div>
    <div class="tile-value">${value}</div>
    <div class="tile-sub">${sub}</div>
  </div>`;
  const total = Number(stats.totalWeightKg);
  // Con una sola cattura per posto non esiste uno "spot migliore": lo si dice da due in su
  const hasTopSpot = Boolean(stats.topSpot) && stats.topSpotCount >= 2;
  const spotSub = hasTopSpot
    ? `${stats.topSpotCount} catture${stats.topBait && stats.topBaitCount >= 2 ? ` · esca più usata: ${stats.topBait}` : ''}`
    : 'Servono almeno due catture nello stesso posto.';
  return html`<div class="tiles diary-stats">
    ${tile('fish', 'Catture', stats.count, Number.isFinite(total) && total > 0 ? `${total.toFixed(1)} kg in tutto` : 'peso non indicato')}
    ${tile('scale', 'Record', recordValue, record ? record.species : 'nessuno')}
    ${tile('map-pin', 'Spot migliore', html`<span class="diary-tile-text">${hasTopSpot ? stats.topSpot : 'Ancora presto per dirlo'}</span>`, spotSub)}
  </div>`.toString();
}

function catchItem(c) {
  const under = isUndersized(c);
  return html`<button type="button" class="diary-item" data-act="open" data-id="${c.client_id}">
    <span class="diary-code">${speciesCode(c.species)}</span>
    <span class="grow">
      <span class="item-title">${c.species} · ${sizeLine(c)}</span>
      <span class="item-sub">${fmtDateTime(c.caught_at)} · ${c.location_name || 'posto non indicato'}</span>
      ${
        c.released || under || c.is_demo
          ? html`<span class="row row-wrap diary-chips">
              ${c.released ? html`<span class="chip chip-ok">Rilasciata</span>` : ''}
              ${under ? html`<span class="chip chip-warn">Sotto misura</span>` : ''}
              ${c.is_demo ? html`<span class="chip chip-off">Esempio</span>` : ''}
            </span>`
          : ''
      }
    </span>
    ${raw(icon('chevron-right', { size: 18 }))}
  </button>`;
}

async function removeDemo() {
  const count = countDemoRecords();
  const ok = await confirmDialog({
    title: 'Rimuovere gli esempi?',
    message: `Tolgo ${count} elementi di esempio da diario e attrezzatura. I tuoi dati restano dove sono.`,
    confirmLabel: 'Rimuovi',
    cancelLabel: 'Tieni'
  });
  if (!ok) return;
  try {
    removeDemoRecords();
    toast('Esempi rimossi.', 'success');
  } catch (err) {
    toast(err?.message || 'Non sono riuscito a rimuoverli.', 'error');
  }
}

// ---------------------------------------------------------------- Mappa

function ensureMap() {
  if (mapApi) return Promise.resolve(mapApi);
  if (mapPromise) return mapPromise;
  const host = $('[data-slot="map"]', root);
  const spot = getSpot(state.spotId);
  mapPromise = createMap(host, { center: [spot?.lat ?? 41.28, spot?.lng ?? 13.35], zoom: 10 })
    .then((api) => {
      mapApi = api;
      markerLayer = api.L.layerGroup().addTo(api.map);
      return api;
    })
    .catch(() => {
      mapPromise = null;
      host.innerHTML = `<p class="small muted diary-map-fallback">La mappa non è disponibile adesso. Il diario funziona comunque.</p>`;
      return null;
    });
  return mapPromise;
}

function updateMarkers(catches) {
  if (!mapApi || !markerLayer) return;
  const { L, map } = mapApi;
  markerLayer.clearLayers();
  const accent = getComputedStyle(document.documentElement).getPropertyValue('--accent').trim() || '#5cc8ff';
  const points = [];
  for (const c of catches) {
    if (!Number.isFinite(c.lat) || !Number.isFinite(c.lng)) continue;
    const marker = L.circleMarker([c.lat, c.lng], {
      radius: 9,
      color: accent,
      weight: 2,
      fillColor: accent,
      fillOpacity: c.released ? 0.15 : 0.7
    });
    marker.on('click', () => openCatchDetail(c.client_id));
    markerLayer.addLayer(marker);
    points.push([c.lat, c.lng]);
  }
  map.invalidateSize();
  if (points.length === 1) map.setView(points[0], 13);
  else if (points.length > 1) map.fitBounds(L.latLngBounds(points).pad(0.25), { maxZoom: 14 });
}

// ---------------------------------------------------------------- Dettaglio

function snapshotChips(snap) {
  if (!snap || typeof snap !== 'object') return [];
  const chips = [];
  if (Number.isFinite(snap.waveHeightM)) chips.push(`onda ${snap.waveHeightM.toFixed(1)} m${Number.isFinite(snap.wavePeriodS) ? `, ${Math.round(snap.wavePeriodS)} s` : ''}`);
  if (Number.isFinite(snap.windSpeedKmh)) chips.push(`vento ${Math.round(snap.windSpeedKmh)} km/h${Number.isFinite(snap.windDirDeg) ? ` ${windName(snap.windDirDeg).name}` : ''}`);
  if (Number.isFinite(snap.pressureHpa)) chips.push(`${Math.round(snap.pressureHpa)} hPa`);
  if (Number.isFinite(snap.seaTempC)) chips.push(`acqua ${snap.seaTempC.toFixed(1)} °C`);
  if (PHASE_LABEL[snap.seaPhase]) chips.push(PHASE_LABEL[snap.seaPhase]);
  if (LIGHT_LABEL[snap.light]) chips.push(LIGHT_LABEL[snap.light]);
  if (Number.isFinite(snap.score)) chips.push(`punteggio ${Math.round(snap.score)}`);
  return chips;
}

function openCatchDetail(id) {
  const c = listCatches().find((x) => x.client_id === id);
  if (!c) return;
  const legal = legalSizeFor(c.species_id || c.species);
  const under = isUndersized(c);
  const chips = snapshotChips(c.weather_snapshot);
  const row = (label, value) => (value ? html`<div class="diary-row"><span class="label">${label}</span><span>${value}</span></div>` : '');

  const body = html`<div class="stack">
    <div>
      <p class="diary-detail-size num">${sizeLine(c)}</p>
      <div class="row row-wrap">
        ${c.released ? html`<span class="chip chip-ok">Rilasciata</span>` : ''}
        ${c.is_demo ? html`<span class="chip chip-off">Esempio</span>` : ''}
      </div>
    </div>
    ${under ? html`<div class="notice notice-warn">${raw(icon('alert'))}<p>Sotto la taglia minima di ${legal.cm} cm: per legge va rilasciata.</p></div>` : ''}
    ${row('Quando', fmtDateTime(c.caught_at))}
    ${row('Dove', c.location_name)}
    ${row('Posizione', Number.isFinite(c.lat) && Number.isFinite(c.lng) ? `${c.lat.toFixed(4)}, ${c.lng.toFixed(4)}` : '')}
    ${row('Esca', c.bait_used)}
    ${row('Canna', c.gear_used)}
    ${row('Note', c.notes)}
    ${
      chips.length
        ? html`<div class="diary-row"><span class="label">Il mare in quel momento</span>
            <div class="row row-wrap">${chips.map((t) => html`<span class="chip">${t}</span>`)}</div>
          </div>`
        : ''
    }
  </div>`;

  const footer = document.createElement('div');
  footer.className = 'sheet-actions';
  footer.innerHTML = `
    <button type="button" class="btn btn-danger" data-act="delete">${icon('trash', { size: 18 })} Elimina</button>
    <button type="button" class="btn btn-primary" data-act="edit">${icon('edit', { size: 18 })} Modifica</button>`;

  const sheet = openSheet({ title: c.species, body, footer });
  on(footer, 'click', '[data-act="edit"]', () => {
    sheet.close();
    openCatchForm(c);
  });
  on(footer, 'click', '[data-act="delete"]', async () => {
    const ok = await confirmDialog({
      title: 'Eliminare questa cattura?',
      message: 'Non si può annullare.',
      cancelLabel: 'Tieni'
    });
    if (!ok) return;
    try {
      deleteCatch(c.client_id);
      sheet.close();
      toast('Cattura eliminata.', 'info');
    } catch (err) {
      toast(err?.message || 'Non sono riuscito a eliminarla.', 'error');
    }
  });
}

// ---------------------------------------------------------------- Modulo di registrazione

/** Condizioni dell'ora della cattura, prese dalle previsioni dello spot attivo se la coprono. */
function buildSnapshot(spotId, caughtMs) {
  const fc = state.forecast;
  if (!fc || !spotId || spotId !== state.spotId || !Array.isArray(fc.hours)) return null;
  const index = fc.hours.findIndex((h) => caughtMs >= h.epochMs && caughtMs < h.epochMs + 3600000);
  if (index < 0) return null;
  const h = fc.hours[index];
  let score = null;
  for (const ev of state.evaluations || []) {
    const hit = (ev.hourly || []).find((x) => x.index === index);
    if (hit && Number.isFinite(hit.score)) {
      score = hit.score;
      break;
    }
  }
  const snap = {
    waveHeightM: h.waveM,
    wavePeriodS: h.wavePeriodS,
    windSpeedKmh: h.windKmh,
    windDirDeg: h.windDirDeg,
    pressureHpa: h.pressureHpa,
    seaTempC: h.seaTempC,
    seaPhase: h.seaPhase,
    light: h.light,
    score
  };
  for (const key of Object.keys(snap)) {
    if (snap[key] === null || snap[key] === undefined) delete snap[key];
  }
  return Object.keys(snap).length ? snap : null;
}

function matchSpeciesId(c) {
  if (!c) return CATCH_SPECIES.some((s) => s.id === state.speciesId) ? state.speciesId : CATCH_SPECIES[0].id;
  if (c.species_id && CATCH_SPECIES.some((s) => s.id === c.species_id)) return c.species_id;
  const name = String(c.species || '').toLowerCase();
  const exact = CATCH_SPECIES.find((s) => s.name.toLowerCase() === name);
  if (exact) return exact.id;
  // I nomi della versione precedente avevano precisazioni tra parentesi, es. "Spigola (Branzino)"
  const first = name.split(/[\s(]/)[0];
  const loose = first ? CATCH_SPECIES.find((s) => s.name.toLowerCase().startsWith(first)) : null;
  return loose ? loose.id : 'altro';
}

function openCatchForm(existing) {
  const spots = listSpots();
  const rods = listGear().filter((g) => g.category === 'canna_surf' || g.category === 'canna_fondo');
  const baits = listBaits();
  const activeSpot = getSpot(state.spotId) || spots[0];
  const val = (v) => (v === null || v === undefined ? '' : v);

  const speciesId = matchSpeciesId(existing);
  const knownSpot = existing ? spots.find((s) => s.id === existing.spot_id) || spots.find((s) => s.name === existing.location_name) : activeSpot;
  const draft = {
    lat: existing ? existing.lat : activeSpot?.lat ?? null,
    lng: existing ? existing.lng : activeSpot?.lng ?? null
  };
  const hasSnapshot = existing && Object.keys(existing.weather_snapshot || {}).length > 0;
  let miniMap = null;
  let miniMarker = null;

  const body = document.createElement('form');
  body.className = 'stack';
  body.noValidate = true;
  body.innerHTML = html`
    <div class="field">
      <label for="catch-species">Specie</label>
      <select id="catch-species" name="species_id" class="select">
        ${CATCH_SPECIES.map((s) => html`<option value="${s.id}" ${s.id === speciesId ? raw('selected') : ''}>${s.name}</option>`)}
      </select>
    </div>
    <div class="field hidden" data-slot="other-species">
      <label for="catch-species-name">Nome della specie</label>
      <input id="catch-species-name" name="species_name" class="input" type="text" maxlength="60" value="${existing && speciesId === 'altro' ? val(existing.species) : ''}" />
    </div>
    <div class="field">
      <label for="catch-when">Quando</label>
      <input id="catch-when" name="caught_at" class="input" type="datetime-local" required value="${toLocalInputValue(existing ? new Date(existing.caught_at) : new Date())}" />
    </div>
    <div class="field-row">
      <div class="field">
        <label for="catch-weight">Peso (g)</label>
        <input id="catch-weight" name="weight_g" class="input" type="number" inputmode="numeric" min="1" max="100000" step="10" value="${val(existing?.weight_g)}" placeholder="Es. 950" />
      </div>
      <div class="field">
        <label for="catch-length">Lunghezza (cm)</label>
        <input id="catch-length" name="length_cm" class="input" type="number" inputmode="decimal" min="1" max="300" step="0.5" value="${val(existing?.length_cm)}" placeholder="Es. 38" />
      </div>
    </div>
    <p class="help" data-slot="legal">Basta uno dei due.</p>
    <label class="check"><input type="checkbox" name="released" ${existing?.released ? raw('checked') : ''} /><span>Rilasciata</span></label>

    <div class="field">
      <label for="catch-spot">Dove</label>
      <select id="catch-spot" name="spot_id" class="select">
        ${spots.map((s) => html`<option value="${s.id}" ${knownSpot && s.id === knownSpot.id ? raw('selected') : ''}>${s.name}</option>`)}
        <option value="" ${knownSpot ? '' : raw('selected')}>Altro posto</option>
      </select>
    </div>
    <div class="field hidden" data-slot="other-place">
      <label for="catch-place">Nome del posto</label>
      <input id="catch-place" name="location_name" class="input" type="text" maxlength="80" value="${existing && !knownSpot ? val(existing.location_name) : ''}" />
    </div>
    <div class="stack-sm">
      <p class="help" data-slot="coords"></p>
      <button type="button" class="btn btn-ghost btn-sm" data-act="gps">${raw(icon('crosshair', { size: 16 }))} Usa la mia posizione</button>
      <details class="details" data-slot="map-details">
        <summary><span>Correggi il punto sulla mappa</span>${raw(icon('chevron-down', { size: 18 }))}</summary>
        <div class="details-body"><div class="spot-map" data-slot="mini-map"></div></div>
      </details>
    </div>

    <div class="field-row">
      <div class="field">
        <label for="catch-bait">Esca</label>
        <input id="catch-bait" name="bait_used" class="input" type="text" maxlength="60" list="catch-bait-list" value="${val(existing?.bait_used)}" placeholder="Es. bibi" autocomplete="off" />
        <datalist id="catch-bait-list">${baits.map((b) => html`<option value="${b.name}"></option>`)}</datalist>
      </div>
      <div class="field">
        <label for="catch-gear">Canna</label>
        <select id="catch-gear" name="gear_used" class="select">
          <option value="">Non indicata</option>
          ${rods.map((r) => html`<option value="${r.name}" ${existing?.gear_used === r.name ? raw('selected') : ''}>${r.name}</option>`)}
          ${existing?.gear_used && !rods.some((r) => r.name === existing.gear_used) ? html`<option value="${existing.gear_used}" selected>${existing.gear_used}</option>` : ''}
        </select>
      </div>
    </div>
    <div class="field">
      <label for="catch-notes">Note (terminale, distanza, marea)</label>
      <textarea id="catch-notes" name="notes" class="textarea" maxlength="1000" placeholder="Es. long arm da 170 cm, a 90 metri sul secondo banco">${val(existing?.notes)}</textarea>
    </div>
    <label class="check"><input type="checkbox" name="attach" ${existing && !hasSnapshot ? '' : raw('checked')} /><span>${hasSnapshot ? 'Tieni le condizioni del mare già salvate' : 'Allega il mare di quel momento'}</span></label>
    <p class="help">Onda, vento, pressione e punteggio dell'ora della cattura, se le previsioni dello spot attivo la coprono.</p>
    <p class="error-text hidden" data-slot="error" role="alert"></p>`.toString();

  const footer = document.createElement('div');
  footer.className = 'sheet-actions';
  footer.innerHTML = `
    <button type="button" class="btn btn-ghost" data-act="cancel">Annulla</button>
    <button type="button" class="btn btn-primary" data-act="save">Salva cattura</button>`;

  const sheet = openSheet({
    title: existing ? 'Modifica cattura' : 'Registra cattura',
    body,
    footer,
    onClose: () => miniMap?.destroy()
  });

  const errorEl = $('[data-slot="error"]', body);
  const legalEl = $('[data-slot="legal"]', body);
  const coordsEl = $('[data-slot="coords"]', body);
  const showError = (msg) => {
    errorEl.textContent = msg || '';
    errorEl.classList.toggle('hidden', !msg);
    if (msg) errorEl.scrollIntoView({ block: 'nearest' });
  };

  const paintCoords = () => {
    coordsEl.textContent =
      Number.isFinite(draft.lat) && Number.isFinite(draft.lng)
        ? `Posizione: ${draft.lat.toFixed(4)}, ${draft.lng.toFixed(4)}`
        : 'Posizione non indicata: usa il GPS o la mappa.';
    if (miniMap && Number.isFinite(draft.lat) && Number.isFinite(draft.lng)) {
      if (!miniMarker) {
        miniMarker = miniMap.L.marker([draft.lat, draft.lng], { draggable: true }).addTo(miniMap.map);
        miniMarker.on('dragend', () => {
          const p = miniMarker.getLatLng();
          setPosition(p.lat, p.lng, false);
        });
      } else miniMarker.setLatLng([draft.lat, draft.lng]);
    }
  };
  const setPosition = (lat, lng, pan = true) => {
    draft.lat = Number(lat.toFixed(5));
    draft.lng = Number(lng.toFixed(5));
    paintCoords();
    if (pan && miniMap) miniMap.map.setView([draft.lat, draft.lng], Math.max(miniMap.map.getZoom(), 14));
  };

  const paintLegal = () => {
    const v = formData(body);
    const legal = legalSizeFor(v.species_id);
    const length = numOrNull(v.length_cm);
    legalEl.classList.remove('error-text');
    if (!legal) {
      legalEl.textContent = 'Basta uno dei due. Per questa specie non c\'è una taglia minima europea.';
      return;
    }
    if (Number.isFinite(length) && length < legal.cm && !v.released) {
      legalEl.textContent = `Sotto la taglia minima di ${legal.cm} cm: per legge va rilasciata.`;
      legalEl.classList.add('error-text');
    } else {
      legalEl.textContent = `Basta uno dei due. Taglia minima di legge: ${legal.cm} cm.`;
    }
  };

  const syncConditional = () => {
    const v = formData(body);
    $('[data-slot="other-species"]', body).classList.toggle('hidden', v.species_id !== 'altro');
    $('[data-slot="other-place"]', body).classList.toggle('hidden', v.spot_id !== '');
  };

  $('#catch-species', body).addEventListener('change', () => {
    syncConditional();
    paintLegal();
  });
  $('#catch-length', body).addEventListener('input', paintLegal);
  $('[name="released"]', body).addEventListener('change', paintLegal);
  $('#catch-spot', body).addEventListener('change', (ev) => {
    syncConditional();
    const spot = getSpot(ev.target.value);
    if (spot) setPosition(spot.lat, spot.lng);
  });
  $('[data-slot="map-details"]', body).addEventListener('toggle', (ev) => {
    if (!ev.target.open || miniMap) return;
    const center = [draft.lat ?? activeSpot?.lat ?? 41.28, draft.lng ?? activeSpot?.lng ?? 13.35];
    createMap($('[data-slot="mini-map"]', body), { center, zoom: 14 })
      .then((api) => {
        miniMap = api;
        api.map.on('click', (e) => setPosition(e.latlng.lat, e.latlng.lng, false));
        paintCoords();
      })
      .catch(() => {
        $('[data-slot="mini-map"]', body).innerHTML = `<p class="small muted">La mappa non è disponibile adesso.</p>`;
      });
  });
  on(body, 'click', '[data-act="gps"]', async (ev, btn) => {
    btn.disabled = true;
    try {
      const pos = await requestGps();
      setPosition(pos.lat, pos.lng);
      toast(`Posizione trovata, precisione ${Math.round(pos.accuracyM)} m.`, 'success');
    } catch (err) {
      toast(err?.message || 'Posizione non disponibile.', 'error');
    } finally {
      btn.disabled = false;
    }
  });
  body.addEventListener('submit', (ev) => ev.preventDefault());

  syncConditional();
  paintLegal();
  paintCoords();

  on(footer, 'click', '[data-act="cancel"]', () => sheet.close());
  on(footer, 'click', '[data-act="save"]', () => {
    const v = formData(body);
    const weight = numOrNull(v.weight_g);
    const length = numOrNull(v.length_cm);
    const when = new Date(v.caught_at);
    const speciesDef = CATCH_SPECIES.find((s) => s.id === v.species_id);
    const speciesName = v.species_id === 'altro' && v.species_name.trim() ? v.species_name.trim() : speciesDef?.name;
    const spot = getSpot(v.spot_id);
    const placeName = spot ? spot.name : v.location_name.trim();

    if (!speciesName) return showError('Scegli la specie.');
    if (Number.isNaN(when.getTime())) return showError('Indica data e ora della cattura.');
    if (when.getTime() > Date.now() + 5 * 60000) return showError('La data è nel futuro: controllala.');
    if (Number.isNaN(weight) || Number.isNaN(length)) return showError('Peso o lunghezza non sono numeri validi.');
    if ((weight === null || weight <= 0) && (length === null || length <= 0)) return showError('Scrivi almeno il peso o la lunghezza.');
    if (!placeName) return showError('Scrivi il nome del posto.');
    if (!Number.isFinite(draft.lat) || !Number.isFinite(draft.lng)) return showError('Indica la posizione con il GPS o sulla mappa.');

    let snapshot = existing?.weather_snapshot || {};
    if (!v.attach) snapshot = {};
    else if (!hasSnapshot) snapshot = buildSnapshot(spot?.id || null, when.getTime()) || {};

    try {
      saveCatch({
        ...(existing || {}),
        species: speciesName,
        species_id: v.species_id,
        weight_g: weight !== null && weight > 0 ? weight : null,
        length_cm: length !== null && length > 0 ? length : null,
        released: Boolean(v.released),
        bait_used: v.bait_used,
        gear_used: v.gear_used,
        location_name: placeName,
        spot_id: spot ? spot.id : null,
        lat: draft.lat,
        lng: draft.lng,
        caught_at: when.toISOString(),
        weather_snapshot: snapshot,
        notes: v.notes,
        is_demo: false
      });
      sheet.close();
      const attached = Object.keys(snapshot).length > 0;
      toast(existing ? 'Cattura aggiornata.' : attached ? 'Cattura registrata, con il mare di quel momento.' : 'Cattura registrata.', 'success');
    } catch (err) {
      showError(err?.message || 'Non sono riuscito a salvare la cattura.');
    }
  });
}
