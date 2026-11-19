/**
 * Scelta dello spot e modulo per aggiungere o modificare uno spot personale.
 */

import { state } from '../state.js';
import { $, html, raw, on, openSheet, confirmDialog, toast, formData } from './dom.js';
import { icon } from './icons.js';
import { listSpots, getSpot, saveSpot, deleteSpot, listCatches } from '../services/storage.js';
import { searchPlaces } from '../services/geocoding.js';
import { selectSpot } from '../forecast-controller.js';
import { createMap, requestGps } from './map.js';

const DIRECTIONS = [
  { deg: 0, label: 'N' },
  { deg: 45, label: 'NE' },
  { deg: 90, label: 'E' },
  { deg: 135, label: 'SE' },
  { deg: 180, label: 'S' },
  { deg: 225, label: 'SO' },
  { deg: 270, label: 'O' },
  { deg: 315, label: 'NO' }
];

export function openSpotSheet() {
  const body = document.createElement('div');
  body.className = 'stack';

  const draw = () => {
    const spots = listSpots();
    const mine = spots.filter((s) => s.isCustom);
    const preset = spots.filter((s) => !s.isCustom);
    const option = (s) => html`<div class="fc-option-row">
      <button type="button" class="fc-option" role="radio" aria-checked="${s.id === state.spotId ? 'true' : 'false'}" data-spot="${s.id}">
        <span class="grow">
          <span class="item-title">${s.name}</span>
          <span class="item-sub">${s.region || 'Spot personale'}</span>
        </span>
        ${s.id === state.spotId ? raw(icon('check')) : ''}
      </button>
      ${s.isCustom ? html`<button type="button" class="btn-icon" data-edit="${s.id}" aria-label="Modifica ${s.name}">${raw(icon('edit', { size: 18 }))}</button>` : ''}
    </div>`;

    body.innerHTML = html`
      ${mine.length ? html`<div><p class="label">I tuoi spot</p><div class="list" role="radiogroup">${mine.map(option)}</div></div>` : ''}
      <div>
        <p class="label">Litorale pontino e golfo di Gaeta</p>
        <div class="list" role="radiogroup">${preset.map(option)}</div>
      </div>`.toString();
  };
  draw();

  const footer = document.createElement('div');
  footer.className = 'sheet-actions';
  footer.innerHTML = `<button type="button" class="btn btn-primary btn-block" data-add>${icon('plus', { size: 18 })} Aggiungi spot</button>`;

  const sheet = openSheet({ title: 'Dove', body, footer });

  on(body, 'click', '[data-spot]', (ev, el) => {
    sheet.close();
    if (el.dataset.spot !== state.spotId) selectSpot(el.dataset.spot);
  });
  on(body, 'click', '[data-edit]', (ev, el) => {
    sheet.close();
    openSpotForm(getSpot(el.dataset.edit));
  });
  $('[data-add]', footer).addEventListener('click', () => {
    sheet.close();
    openSpotForm(null);
  });
}

export function openSpotForm(existing = null) {
  const current = getSpot(state.spotId);
  const draft = {
    name: existing?.name || '',
    lat: existing?.lat ?? null,
    lng: existing?.lng ?? null,
    coast_orientation_deg: existing?.coast_orientation_deg ?? null,
    seabed_type: existing?.seabed_type || '',
    notes: existing?.notes || ''
  };
  let mapApi = null;
  let marker = null;

  const body = document.createElement('form');
  body.className = 'stack';
  body.noValidate = true;
  body.innerHTML = html`
    <div class="field">
      <label for="spot-search">Cerca una località</label>
      <div class="row">
        <input id="spot-search" class="input grow" type="search" placeholder="Es. Sabaudia, Anzio, Ostia" autocomplete="off" enterkeyhint="search" />
        <button type="button" class="btn" data-act="search">${raw(icon('search', { size: 18 }))}<span>Cerca</span></button>
      </div>
      <div data-slot="results" class="list"></div>
    </div>
    <button type="button" class="btn btn-ghost" data-act="gps">${raw(icon('crosshair', { size: 18 }))} Usa la mia posizione</button>
    <div class="spot-map" data-slot="map" aria-label="Mappa: tocca il punto esatto della spiaggia"></div>
    <p class="help" data-slot="coords"></p>
    <div class="field">
      <label for="spot-name">Nome dello spot</label>
      <input id="spot-name" name="name" class="input" type="text" maxlength="80" required value="${draft.name}" placeholder="Es. Lido dei Pini, canalone sud" />
    </div>
    <div class="field">
      <span class="field-label" id="spot-dir-label">La spiaggia guarda verso</span>
      <div class="spot-dirs" role="radiogroup" aria-labelledby="spot-dir-label">
        ${DIRECTIONS.map((d) => html`<button type="button" class="chip-btn" role="radio" data-dir="${d.deg}" aria-checked="false">${d.label}</button>`)}
      </div>
      <p class="help">Mettiti con le spalle alla terra: la direzione in cui guardi il mare. Serve a capire se il vento arriva dal mare o da terra.</p>
    </div>
    <div class="field">
      <label for="spot-seabed">Fondale (facoltativo)</label>
      <input id="spot-seabed" name="seabed_type" class="input" type="text" maxlength="120" value="${draft.seabed_type}" placeholder="Es. sabbia con canalone a 60 metri" />
    </div>
    <div class="field">
      <label for="spot-notes">Note (facoltative)</label>
      <textarea id="spot-notes" name="notes" class="textarea" maxlength="500" placeholder="Es. buono in scaduta di libeccio">${draft.notes}</textarea>
    </div>
    <p class="error-text hidden" data-slot="error" role="alert"></p>`.toString();

  const footer = document.createElement('div');
  footer.className = 'sheet-actions';
  footer.innerHTML = `
    ${existing ? `<button type="button" class="btn btn-danger" data-act="delete">${icon('trash', { size: 18 })} Elimina</button>` : ''}
    <button type="button" class="btn btn-primary" data-act="save">Salva spot</button>`;

  const sheet = openSheet({
    title: existing ? 'Modifica spot' : 'Aggiungi spot',
    body,
    footer,
    onClose: () => mapApi?.destroy()
  });

  const coordsEl = $('[data-slot="coords"]', body);
  const errorEl = $('[data-slot="error"]', body);
  const showError = (msg) => {
    errorEl.textContent = msg;
    errorEl.classList.toggle('hidden', !msg);
  };

  const paintDirection = () => {
    for (const btn of body.querySelectorAll('[data-dir]')) {
      btn.setAttribute('aria-checked', Number(btn.dataset.dir) === draft.coast_orientation_deg ? 'true' : 'false');
    }
  };

  const setPosition = (lat, lng, { pan = true } = {}) => {
    draft.lat = Number(lat.toFixed(5));
    draft.lng = Number(lng.toFixed(5));
    coordsEl.textContent = `Posizione: ${draft.lat.toFixed(4)}, ${draft.lng.toFixed(4)}. Tocca la mappa o trascina il segnaposto per correggerla.`;
    if (mapApi) {
      if (!marker) {
        marker = mapApi.L.marker([draft.lat, draft.lng], { draggable: true }).addTo(mapApi.map);
        marker.on('dragend', () => {
          const p = marker.getLatLng();
          setPosition(p.lat, p.lng, { pan: false });
        });
      } else marker.setLatLng([draft.lat, draft.lng]);
      if (pan) mapApi.map.setView([draft.lat, draft.lng], Math.max(mapApi.map.getZoom(), 14));
    }
  };

  // Punto di partenza della mappa: lo spot in modifica, altrimenti quello attivo
  const startLat = draft.lat ?? current?.lat ?? 41.28;
  const startLng = draft.lng ?? current?.lng ?? 13.35;
  if (draft.lat === null) coordsEl.textContent = 'Cerca una località, usa la posizione oppure tocca la mappa nel punto della spiaggia.';
  // Per uno spot nuovo l'esposizione non si eredita: va scelta guardando la spiaggia
  paintDirection();

  createMap($('[data-slot="map"]', body), { center: [startLat, startLng], zoom: existing ? 14 : 11 })
    .then((api) => {
      mapApi = api;
      api.map.on('click', (ev) => setPosition(ev.latlng.lat, ev.latlng.lng, { pan: false }));
      if (draft.lat !== null) setPosition(draft.lat, draft.lng);
    })
    .catch(() => {
      $('[data-slot="map"]', body).classList.add('hidden');
      if (draft.lat !== null) setPosition(draft.lat, draft.lng);
    });

  const runSearch = async () => {
    const input = $('#spot-search', body);
    const host = $('[data-slot="results"]', body);
    const query = input.value.trim();
    if (query.length < 3) {
      host.innerHTML = `<p class="help">Scrivi almeno tre lettere.</p>`;
      return;
    }
    host.innerHTML = `<div class="row"><span class="spinner"></span><span class="small muted">Cerco…</span></div>`;
    try {
      const results = await searchPlaces(query);
      if (!results.length) {
        host.innerHTML = `<p class="help">Nessun risultato. Prova con il nome del comune oppure tocca la mappa.</p>`;
        return;
      }
      host.innerHTML = results
        .map(
          (r, i) => html`<button type="button" class="fc-option" data-result="${i}">
            <span class="grow"><span class="item-title">${r.name}</span><span class="item-sub">${r.fullName}</span></span>
          </button>`
        )
        .join('');
      host.onclick = (ev) => {
        const btn = ev.target.closest('[data-result]');
        if (!btn) return;
        const r = results[Number(btn.dataset.result)];
        setPosition(r.lat, r.lng);
        const nameInput = $('#spot-name', body);
        if (!nameInput.value.trim()) nameInput.value = r.name;
        host.innerHTML = `<p class="help">Ricerca di OpenStreetMap. Ora sposta il segnaposto sul punto esatto della spiaggia.</p>`;
      };
    } catch (err) {
      host.innerHTML = `<p class="help">La ricerca non risponde. Tocca la mappa o usa la posizione.</p>`;
    }
  };

  on(body, 'click', '[data-act="search"]', runSearch);
  $('#spot-search', body).addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter') {
      ev.preventDefault();
      runSearch();
    }
  });
  on(body, 'click', '[data-act="gps"]', async (ev, btn) => {
    btn.disabled = true;
    try {
      const pos = await requestGps();
      setPosition(pos.lat, pos.lng);
      toast(`Posizione trovata, precisione ${Math.round(pos.accuracyM)} m.`, 'success');
    } catch (err) {
      toast(err.message || 'Posizione non disponibile.', 'error');
    } finally {
      btn.disabled = false;
    }
  });
  on(body, 'click', '[data-dir]', (ev, btn) => {
    draft.coast_orientation_deg = Number(btn.dataset.dir);
    paintDirection();
  });
  body.addEventListener('submit', (ev) => ev.preventDefault());

  on(footer, 'click', '[data-act="save"]', () => {
    const values = formData(body);
    if (draft.lat === null || draft.lng === null) return showError('Indica la posizione: cerca una località, usa il GPS o tocca la mappa.');
    if (!values.name.trim()) return showError('Scrivi il nome dello spot.');
    if (draft.coast_orientation_deg === null) return showError('Indica verso dove guarda la spiaggia.');
    try {
      const saved = saveSpot({
        ...(existing ? { id: existing.id, client_id: existing.client_id } : {}),
        name: values.name,
        region: existing?.region || null,
        lat: draft.lat,
        lng: draft.lng,
        coast_orientation_deg: draft.coast_orientation_deg,
        seabed_type: values.seabed_type,
        notes: values.notes
      });
      sheet.close();
      toast(existing ? 'Spot aggiornato.' : 'Spot aggiunto.', 'success');
      selectSpot(saved.id);
    } catch (err) {
      showError(err.message || 'Non sono riuscito a salvare lo spot.');
    }
  });

  on(footer, 'click', '[data-act="delete"]', async () => {
    const used = listCatches().filter((c) => c.spot_id === existing.id).length;
    const ok = await confirmDialog({
      title: 'Eliminare questo spot?',
      message: used
        ? `Le ${used} catture registrate qui restano nel diario. Lo spot non si può recuperare.`
        : 'Lo spot non si può recuperare.',
      confirmLabel: 'Elimina',
      cancelLabel: 'Tieni'
    });
    if (!ok) return;
    try {
      const wasActive = state.spotId === existing.id;
      deleteSpot(existing.id);
      sheet.close();
      toast('Spot eliminato.', 'info');
      if (wasActive) selectSpot(listSpots()[0].id);
    } catch (err) {
      showError(err.message || 'Non sono riuscito a eliminare lo spot.');
    }
  });
}
