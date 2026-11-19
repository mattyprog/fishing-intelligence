/**
 * Vista "Attrezzatura": quanto piombo si può lanciare, canne ed esche.
 * Le canne e le esche segnate qui entrano nel piano di pesca della vista Oggi.
 */

import { bus } from '../../state.js';
import { $, html, raw, on, openSheet, confirmDialog, toast, formData } from '../dom.js';
import { icon } from '../icons.js';
import {
  listGear,
  saveGear,
  deleteGear,
  listBaits,
  saveBait,
  deleteBait,
  countDemoRecords,
  removeDemoRecords
} from '../../services/storage.js';
import { evaluateCasting } from '../../core/casting.js';
import { SPECIES } from '../../core/species.js';

let root = null;

const calc = { rodId: null, leadG: 110, baitG: 12 };

const CATEGORY_LABEL = {
  canna_surf: 'Canna da surfcasting',
  canna_fondo: 'Canna da fondo',
  mulinello_filo: 'Mulinello',
  accessorio: 'Accessorio'
};
const STATUS_LABEL = { pronta: 'Pronta', riserva: 'Di riserva', manutenzione: 'In manutenzione' };
const BAIT_CATEGORY_LABEL = {
  anellide: 'Verme',
  sipunculide: 'Bibi',
  mollusco: 'Mollusco',
  crostaceo: 'Crostaceo',
  pesce: 'Pesce o trancio',
  altro: 'Altro'
};
const WATER_LABEL = {
  tutte: 'Con ogni mare',
  calmo_poco_mosso: 'Mare calmo o poco mosso',
  mosso_scaduta: 'Mare mosso o in scaduta'
};
const BAIT_WEIGHTS = [
  { g: 5, label: 'Verme sottile, circa 5 g' },
  { g: 12, label: 'Innesco medio, circa 12 g' },
  { g: 25, label: 'Innesco voluminoso, circa 25 g' },
  { g: 40, label: 'Trancio di pesce, circa 40 g' }
];
const CAST_STATUS_CLASS = { ok: 'v-ottimo', limit: 'v-discreto', underload: 'v-discreto', overload: 'v-pericolo', unknown: 'v-nd' };

const isRod = (g) => g.category === 'canna_surf' || g.category === 'canna_fondo';
const numOrNull = (v) => {
  if (v === null || v === undefined || String(v).trim() === '') return null;
  const n = Number(String(v).replace(',', '.'));
  return Number.isFinite(n) ? n : NaN;
};

// ---------------------------------------------------------------- Montaggio

export function mount(el) {
  root = el;
  root.innerHTML = `<h1 class="view-title">Attrezzatura</h1><div data-slot="body"></div>`;

  on(root, 'click', '[data-act]', handleAction);
  on(root, 'change', '[data-calc]', handleCalcChange);

  bus.on('data:changed', ({ kind } = {}) => {
    if (kind === 'gear' || kind === 'baits' || kind === 'all') render();
  });
  render();
}

export function show() {
  render();
}

function handleAction(ev, el) {
  const { act, id } = el.dataset;
  if (act === 'add-gear') openGearForm(null);
  else if (act === 'edit-gear') openGearForm(listGear().find((g) => g.client_id === id) || null);
  else if (act === 'add-bait') openBaitForm(null);
  else if (act === 'edit-bait') openBaitForm(listBaits().find((b) => b.client_id === id) || null);
  else if (act === 'bait-minus' || act === 'bait-plus') changeBaitQuantity(id, act === 'bait-plus' ? 1 : -1);
  else if (act === 'lead-minus' || act === 'lead-plus') {
    calc.leadG = Math.max(20, Math.min(300, calc.leadG + (act === 'lead-plus' ? 5 : -5)));
    renderCalcResult();
  } else if (act === 'remove-demo') removeDemo();
}

function handleCalcChange(ev, el) {
  if (el.dataset.calc === 'rod') calc.rodId = el.value;
  if (el.dataset.calc === 'bait') calc.baitG = Number(el.value) || 12;
  renderCalcResult();
}

function trySave(fn, okMessage) {
  try {
    const saved = fn();
    if (okMessage) toast(okMessage, 'success');
    return saved;
  } catch (err) {
    toast(err?.message || 'Non sono riuscito a salvare.', 'error');
    return null;
  }
}

// ---------------------------------------------------------------- Disegno

function render() {
  if (!root) return;
  const gear = listGear();
  const baits = listBaits();
  const rods = gear.filter(isRod);
  const demoCount = gear.filter((g) => g.is_demo).length + baits.filter((b) => b.is_demo).length;
  if (!rods.some((r) => r.client_id === calc.rodId)) calc.rodId = rods[0]?.client_id || null;

  $('[data-slot="body"]', root).innerHTML = html`
    ${demoCount ? raw(demoNotice(demoCount)) : ''}
    ${raw(calcCard(rods))}

    <div class="row-between gear-head">
      <h2 class="section-title">Canne e mulinelli</h2>
      <button type="button" class="btn btn-sm" data-act="add-gear">${raw(icon('plus', { size: 16 }))} Aggiungi</button>
    </div>
    <div class="card">
      ${
        gear.length
          ? html`<div class="list">${gear.map(gearItem)}</div>`
          : html`<div class="empty">
              <div class="empty-icon">${raw(icon('rod', { size: 28 }))}</div>
              <p class="empty-title">Nessuna canna</p>
              <p class="empty-text">Aggiungi la tua canna principale: basta il lancio in grammi. Poi il calcolo del piombo lavora da solo.</p>
              <button type="button" class="btn btn-primary" data-act="add-gear">Aggiungi canna</button>
            </div>`
      }
    </div>

    <div class="row-between gear-head">
      <h2 class="section-title">Esche</h2>
      <button type="button" class="btn btn-sm" data-act="add-bait">${raw(icon('plus', { size: 16 }))} Aggiungi</button>
    </div>
    <div class="card">
      ${
        baits.length
          ? html`<div class="list">${baits.map(baitItem)}</div>`
          : html`<div class="empty">
              <div class="empty-icon">${raw(icon('droplet', { size: 28 }))}</div>
              <p class="empty-title">Nessuna esca segnata</p>
              <p class="empty-text">Segna quelle che hai davvero: nel piano di pesca vedrai subito cosa ti manca.</p>
              <button type="button" class="btn btn-primary" data-act="add-bait">Aggiungi esca</button>
            </div>`
      }
    </div>`.toString();

  renderCalcResult();
}

function demoNotice(count) {
  return html`<div class="notice notice-info gear-demo">
    ${raw(icon('info'))}
    <div class="stack-sm">
      <p>${count === 1 ? 'Un elemento è un esempio' : `${count} elementi sono esempi`} della versione precedente, non attrezzatura tua.</p>
      <button type="button" class="btn-link" data-act="remove-demo">Rimuovi gli esempi</button>
    </div>
  </div>`.toString();
}

function calcCard(rods) {
  if (!rods.length) {
    return html`<section class="card">
      <h2 class="card-title">Quanto piombo puoi lanciare</h2>
      <p class="card-sub">Aggiungi una canna con il suo lancio minimo e massimo: ti dico se il piombo che vuoi usare la carica bene o la mette a rischio.</p>
    </section>`.toString();
  }
  return html`<section class="card gear-calc">
    <h2 class="card-title">Quanto piombo puoi lanciare</h2>
    <div class="field">
      <label for="calc-rod">Canna</label>
      <select id="calc-rod" class="select" data-calc="rod">
        ${rods.map((r) => html`<option value="${r.client_id}" ${r.client_id === calc.rodId ? raw('selected') : ''}>${r.name}</option>`)}
      </select>
    </div>
    <div class="field-row">
      <div class="field">
        <span class="field-label" id="calc-lead-label">Piombo</span>
        <div class="stepper" role="group" aria-labelledby="calc-lead-label">
          <button type="button" data-act="lead-minus" aria-label="Cinque grammi in meno">${raw(icon('minus', { size: 18 }))}</button>
          <output data-slot="lead" class="num"></output>
          <button type="button" data-act="lead-plus" aria-label="Cinque grammi in più">${raw(icon('plus', { size: 18 }))}</button>
        </div>
      </div>
      <div class="field">
        <label for="calc-bait">Esca</label>
        <select id="calc-bait" class="select" data-calc="bait">
          ${BAIT_WEIGHTS.map((b) => html`<option value="${b.g}" ${b.g === calc.baitG ? raw('selected') : ''}>${b.label}</option>`)}
        </select>
      </div>
    </div>
    <div data-slot="calc-result" aria-live="polite"></div>
  </section>`.toString();
}

function renderCalcResult() {
  const host = $('[data-slot="calc-result"]', root);
  const leadEl = $('[data-slot="lead"]', root);
  if (leadEl) leadEl.textContent = `${calc.leadG} g`;
  if (!host) return;
  const rod = listGear().find((g) => g.client_id === calc.rodId);
  if (!rod) {
    host.innerHTML = '';
    return;
  }
  let res;
  try {
    res = evaluateCasting({ rod, leadG: calc.leadG, baitG: calc.baitG });
  } catch (err) {
    console.error('Calcolo del lancio non riuscito:', err);
    host.innerHTML = '';
    return;
  }
  const cls = CAST_STATUS_CLASS[res.status] || 'v-nd';
  const pct = Number.isFinite(res.loadPct) ? Math.max(0, Math.min(100, Math.round(res.loadPct))) : 0;
  const leader = typeof res.leader === 'string' ? res.leader : res.leader?.text || '';
  host.innerHTML = html`<div class="gear-result ${cls}">
    <div class="row-between">
      <strong class="v-text">${res.title}</strong>
      ${Number.isFinite(res.totalG) ? html`<span class="num small muted">${Math.round(res.totalG)} g in tutto${Number.isFinite(res.loadPct) ? `, ${Math.round(res.loadPct)}%` : ''}</span>` : ''}
    </div>
    ${res.status !== 'unknown' ? html`<div class="meter"><span style="width:${pct}%"></span></div>` : ''}
    <p class="small">${res.advice}</p>
    ${leader ? html`<p class="small muted">${leader}</p>` : ''}
  </div>`.toString();
}

function castRange(g) {
  const min = Number.isFinite(g.min_cast_g) ? g.min_cast_g : null;
  const max = Number.isFinite(g.max_cast_g) ? g.max_cast_g : null;
  if (min !== null && max !== null) return `lancio ${min}-${max} g`;
  if (max !== null) return `lancio fino a ${max} g`;
  return null;
}

function gearItem(g) {
  const sub = [
    CATEGORY_LABEL[g.category] || 'Attrezzatura',
    isRod(g) ? castRange(g) || 'lancio non indicato' : null,
    Number.isFinite(g.length_m) ? `${g.length_m.toFixed(2)} m` : null,
    g.brand || null
  ].filter(Boolean);
  return html`<div class="list-item">
    <div class="grow">
      <div class="item-title">${g.name}</div>
      <div class="item-sub">${sub.join(' · ')}</div>
      ${
        g.status !== 'pronta' || g.is_demo
          ? html`<div class="row row-wrap gear-chips">
              ${g.status !== 'pronta' ? html`<span class="chip ${g.status === 'manutenzione' ? 'chip-warn' : 'chip-off'}">${STATUS_LABEL[g.status] || g.status}</span>` : ''}
              ${g.is_demo ? html`<span class="chip chip-off">Esempio</span>` : ''}
            </div>`
          : ''
      }
    </div>
    <div class="item-actions">
      <button type="button" class="btn-icon" data-act="edit-gear" data-id="${g.client_id}" aria-label="Modifica ${g.name}">${raw(icon('edit', { size: 18 }))}</button>
    </div>
  </div>`;
}

function baitItem(b) {
  const qty = Number.isFinite(b.quantity) ? b.quantity : 0;
  const sub = [BAIT_CATEGORY_LABEL[b.category] || 'Esca', WATER_LABEL[b.water_condition] ? WATER_LABEL[b.water_condition].toLowerCase() : null, b.is_demo ? 'esempio' : null].filter(Boolean);
  return html`<div class="list-item gear-bait ${qty > 0 ? '' : 'is-empty'}">
    <div class="grow">
      <div class="item-title">${b.name}</div>
      <div class="item-sub">${sub.join(' · ')}</div>
    </div>
    <div class="item-actions">
      <div class="stepper" role="group" aria-label="Quantità di ${b.name}">
        <button type="button" data-act="bait-minus" data-id="${b.client_id}" aria-label="Una in meno" ${qty <= 0 ? raw('disabled') : ''}>${raw(icon('minus', { size: 18 }))}</button>
        <output class="num">${qty}</output>
        <button type="button" data-act="bait-plus" data-id="${b.client_id}" aria-label="Una in più">${raw(icon('plus', { size: 18 }))}</button>
      </div>
      <button type="button" class="btn-icon" data-act="edit-bait" data-id="${b.client_id}" aria-label="Modifica ${b.name}">${raw(icon('edit', { size: 18 }))}</button>
    </div>
  </div>`;
}

function changeBaitQuantity(id, delta) {
  const bait = listBaits().find((b) => b.client_id === id);
  if (!bait) return;
  const quantity = Math.max(0, Math.min(999, (Number(bait.quantity) || 0) + delta));
  trySave(() => saveBait({ ...bait, quantity, available: quantity > 0 }));
}

async function removeDemo() {
  const count = countDemoRecords();
  const ok = await confirmDialog({
    title: 'Rimuovere gli esempi?',
    message: `Tolgo ${count} elementi di esempio da attrezzatura e diario. I tuoi dati restano dove sono.`,
    confirmLabel: 'Rimuovi',
    cancelLabel: 'Tieni'
  });
  if (!ok) return;
  trySave(() => removeDemoRecords(), 'Esempi rimossi.');
}

// ---------------------------------------------------------------- Modulo: canna o mulinello

function openGearForm(existing) {
  const g = existing || { category: 'canna_surf', status: 'pronta' };
  const val = (v) => (v === null || v === undefined ? '' : v);

  const body = document.createElement('form');
  body.className = 'stack';
  body.noValidate = true;
  body.innerHTML = html`
    <div class="field">
      <label for="gear-category">Tipo</label>
      <select id="gear-category" name="category" class="select">
        ${Object.entries(CATEGORY_LABEL).map(([k, label]) => html`<option value="${k}" ${k === g.category ? raw('selected') : ''}>${label}</option>`)}
      </select>
    </div>
    <div class="field">
      <label for="gear-name">Nome o modello</label>
      <input id="gear-name" name="name" class="input" type="text" maxlength="80" required value="${val(g.name)}" placeholder="Es. Surf tre pezzi 4.20" />
    </div>
    <div data-rod-only class="stack">
      <div class="field-row">
        <div class="field">
          <label for="gear-min">Lancio minimo (g)</label>
          <input id="gear-min" name="min_cast_g" class="input" type="number" inputmode="numeric" min="0" max="400" step="5" value="${val(g.min_cast_g)}" placeholder="Es. 100" />
        </div>
        <div class="field">
          <label for="gear-max">Lancio massimo (g)</label>
          <input id="gear-max" name="max_cast_g" class="input" type="number" inputmode="numeric" min="0" max="400" step="5" value="${val(g.max_cast_g)}" placeholder="Es. 200" />
        </div>
      </div>
      <p class="help">Li trovi stampati sul fusto, vicino al manico. Servono per il calcolo del piombo.</p>
    </div>
    <details class="details">
      <summary><span>Altri dettagli</span>${raw(icon('chevron-down', { size: 18 }))}</summary>
      <div class="details-body stack">
        <div class="field">
          <label for="gear-brand">Marca</label>
          <input id="gear-brand" name="brand" class="input" type="text" maxlength="60" value="${val(g.brand)}" />
        </div>
        <div class="field-row" data-rod-only>
          <div class="field">
            <label for="gear-length">Lunghezza (m)</label>
            <input id="gear-length" name="length_m" class="input" type="number" inputmode="decimal" min="1" max="8" step="0.05" value="${val(g.length_m)}" />
          </div>
          <div class="field">
            <label for="gear-opt">Piombo ideale (g)</label>
            <input id="gear-opt" name="optimal_cast_g" class="input" type="number" inputmode="numeric" min="0" max="400" step="5" value="${val(g.optimal_cast_g)}" />
          </div>
        </div>
        <div class="field">
          <label for="gear-reel">Mulinello abbinato</label>
          <input id="gear-reel" name="reel_model" class="input" type="text" maxlength="60" value="${val(g.reel_model)}" />
        </div>
        <div class="field-row">
          <div class="field">
            <label for="gear-line">Filo in bobina (mm)</label>
            <input id="gear-line" name="main_line_mm" class="input" type="number" inputmode="decimal" min="0.08" max="1" step="0.01" value="${val(g.main_line_mm)}" />
          </div>
          <div class="field">
            <label for="gear-leader">Shock leader (mm)</label>
            <input id="gear-leader" name="shock_leader_mm" class="input" type="number" inputmode="decimal" min="0.1" max="1.2" step="0.01" value="${val(g.shock_leader_mm)}" />
          </div>
        </div>
        <div class="field">
          <label for="gear-status">Stato</label>
          <select id="gear-status" name="status" class="select">
            ${Object.entries(STATUS_LABEL).map(([k, label]) => html`<option value="${k}" ${k === (g.status || 'pronta') ? raw('selected') : ''}>${label}</option>`)}
          </select>
        </div>
        <div class="field">
          <label for="gear-notes">Note</label>
          <textarea id="gear-notes" name="notes" class="textarea" maxlength="500">${val(g.notes)}</textarea>
        </div>
      </div>
    </details>
    <p class="error-text hidden" data-slot="error" role="alert"></p>`.toString();

  const footer = document.createElement('div');
  footer.className = 'sheet-actions';
  footer.innerHTML = `
    ${existing ? `<button type="button" class="btn btn-danger" data-act="delete">${icon('trash', { size: 18 })} Elimina</button>` : ''}
    <button type="button" class="btn btn-primary" data-act="save">Salva</button>`;

  const sheet = openSheet({ title: existing ? 'Modifica attrezzatura' : 'Aggiungi attrezzatura', body, footer });
  const errorEl = $('[data-slot="error"]', body);
  const showError = (msg) => {
    errorEl.textContent = msg || '';
    errorEl.classList.toggle('hidden', !msg);
  };

  const syncCategory = () => {
    const rod = isRod({ category: $('#gear-category', body).value });
    body.querySelectorAll('[data-rod-only]').forEach((el) => el.classList.toggle('hidden', !rod));
  };
  $('#gear-category', body).addEventListener('change', syncCategory);
  syncCategory();
  body.addEventListener('submit', (ev) => ev.preventDefault());

  on(footer, 'click', '[data-act="save"]', () => {
    const v = formData(body);
    const rod = isRod(v);
    const numbers = {
      min_cast_g: rod ? numOrNull(v.min_cast_g) : null,
      max_cast_g: rod ? numOrNull(v.max_cast_g) : null,
      optimal_cast_g: rod ? numOrNull(v.optimal_cast_g) : null,
      length_m: rod ? numOrNull(v.length_m) : null,
      main_line_mm: numOrNull(v.main_line_mm),
      shock_leader_mm: numOrNull(v.shock_leader_mm)
    };
    if (!v.name.trim()) return showError('Scrivi il nome o il modello.');
    if (Object.values(numbers).some((n) => Number.isNaN(n))) return showError('Controlla i numeri: uno non è valido.');
    if (numbers.min_cast_g !== null && numbers.max_cast_g !== null && numbers.max_cast_g < numbers.min_cast_g) {
      return showError('Il lancio massimo deve essere più alto del minimo.');
    }
    try {
      saveGear({
        ...(existing || {}),
        category: v.category,
        name: v.name,
        brand: v.brand,
        reel_model: v.reel_model,
        status: v.status,
        notes: v.notes,
        ...numbers,
        is_demo: false
      });
      sheet.close();
      toast(existing ? 'Attrezzatura aggiornata.' : 'Attrezzatura aggiunta.', 'success');
    } catch (err) {
      showError(err?.message || 'Non sono riuscito a salvare.');
    }
  });

  on(footer, 'click', '[data-act="delete"]', async () => {
    const ok = await confirmDialog({
      title: 'Eliminare questa attrezzatura?',
      message: `"${existing.name}" verrà tolta dall'elenco. Non si può annullare.`,
      cancelLabel: 'Tieni'
    });
    if (!ok) return;
    try {
      deleteGear(existing.client_id);
      sheet.close();
      toast('Attrezzatura eliminata.', 'info');
    } catch (err) {
      showError(err?.message || 'Non sono riuscito a eliminare.');
    }
  });
}

// ---------------------------------------------------------------- Modulo: esca

function openBaitForm(existing) {
  const b = existing || { category: 'anellide', quantity: 1, water_condition: 'tutte', target_species: [] };
  const targets = new Set(Array.isArray(b.target_species) ? b.target_species : []);
  const val = (v) => (v === null || v === undefined ? '' : v);

  const body = document.createElement('form');
  body.className = 'stack';
  body.noValidate = true;
  body.innerHTML = html`
    <div class="field">
      <label for="bait-name">Nome dell'esca</label>
      <input id="bait-name" name="name" class="input" type="text" maxlength="60" required value="${val(b.name)}" placeholder="Es. americano, arenicola, bibi" />
    </div>
    <div class="field-row">
      <div class="field">
        <label for="bait-category">Tipo</label>
        <select id="bait-category" name="category" class="select">
          ${Object.entries(BAIT_CATEGORY_LABEL).map(([k, label]) => html`<option value="${k}" ${k === b.category ? raw('selected') : ''}>${label}</option>`)}
        </select>
      </div>
      <div class="field">
        <label for="bait-quantity">Quante ne hai</label>
        <input id="bait-quantity" name="quantity" class="input" type="number" inputmode="numeric" min="0" max="999" step="1" value="${val(b.quantity)}" />
      </div>
    </div>
    <p class="help">Scatole o porzioni. A zero resta in elenco come esca da ricomprare.</p>
    <div class="field">
      <label for="bait-water">Quando rende di più</label>
      <select id="bait-water" name="water_condition" class="select">
        ${Object.entries(WATER_LABEL).map(([k, label]) => html`<option value="${k}" ${k === b.water_condition ? raw('selected') : ''}>${label}</option>`)}
      </select>
    </div>
    <div class="field">
      <span class="field-label" id="bait-target-label">Per quali specie (facoltativo)</span>
      <div class="row row-wrap" role="group" aria-labelledby="bait-target-label">
        ${SPECIES.map((sp) => html`<button type="button" class="chip-btn" data-target="${sp.id}" aria-pressed="${targets.has(sp.id) ? 'true' : 'false'}">${sp.name}</button>`)}
      </div>
    </div>
    <div class="field">
      <label for="bait-notes">Note</label>
      <textarea id="bait-notes" name="notes" class="textarea" maxlength="500" placeholder="Es. innescare con l'ago e fermare con filo elastico">${val(b.notes)}</textarea>
    </div>
    <p class="error-text hidden" data-slot="error" role="alert"></p>`.toString();

  const footer = document.createElement('div');
  footer.className = 'sheet-actions';
  footer.innerHTML = `
    ${existing ? `<button type="button" class="btn btn-danger" data-act="delete">${icon('trash', { size: 18 })} Elimina</button>` : ''}
    <button type="button" class="btn btn-primary" data-act="save">Salva</button>`;

  const sheet = openSheet({ title: existing ? 'Modifica esca' : 'Aggiungi esca', body, footer });
  const errorEl = $('[data-slot="error"]', body);
  const showError = (msg) => {
    errorEl.textContent = msg || '';
    errorEl.classList.toggle('hidden', !msg);
  };

  on(body, 'click', '[data-target]', (ev, btn) => {
    const id = btn.dataset.target;
    if (targets.has(id)) targets.delete(id);
    else targets.add(id);
    btn.setAttribute('aria-pressed', targets.has(id) ? 'true' : 'false');
  });
  body.addEventListener('submit', (ev) => ev.preventDefault());

  on(footer, 'click', '[data-act="save"]', () => {
    const v = formData(body);
    const quantity = numOrNull(v.quantity);
    if (!v.name.trim()) return showError('Scrivi il nome dell\'esca.');
    if (quantity === null || Number.isNaN(quantity) || quantity < 0 || !Number.isInteger(quantity)) {
      return showError('Indica quante ne hai con un numero intero, anche zero.');
    }
    try {
      saveBait({
        ...(existing || {}),
        name: v.name,
        category: v.category,
        quantity,
        available: quantity > 0,
        water_condition: v.water_condition,
        target_species: Array.from(targets),
        notes: v.notes,
        is_demo: false
      });
      sheet.close();
      toast(existing ? 'Esca aggiornata.' : 'Esca aggiunta.', 'success');
    } catch (err) {
      showError(err?.message || 'Non sono riuscito a salvare.');
    }
  });

  on(footer, 'click', '[data-act="delete"]', async () => {
    const ok = await confirmDialog({
      title: 'Eliminare questa esca?',
      message: `"${existing.name}" verrà tolta dall'elenco. Non si può annullare.`,
      cancelLabel: 'Tieni'
    });
    if (!ok) return;
    try {
      deleteBait(existing.client_id);
      sheet.close();
      toast('Esca eliminata.', 'info');
    } catch (err) {
      showError(err?.message || 'Non sono riuscito a eliminare.');
    }
  });
}
