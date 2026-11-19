/**
 * Utilità per il DOM condivise da tutte le viste: selettori, escape, eventi delegati,
 * toast, sheet (pannello dal basso) e conferma.
 */

import { icon } from './icons.js';

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

export function escapeHtml(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

class RawHtml {
  constructor(value) {
    this.value = String(value ?? '');
  }
  toString() {
    return this.value;
  }
}

/** Marca una stringa come HTML già sicuro, da non passare per l'escape dentro html``. */
export const raw = (str) => new RawHtml(str);

/**
 * Template tag: fa l'escape di ogni valore interpolato.
 * Gli array vengono concatenati; raw(...) e i risultati di altri html`` passano intatti.
 */
export function html(strings, ...values) {
  let out = '';
  strings.forEach((chunk, i) => {
    out += chunk;
    if (i < values.length) out += renderValue(values[i]);
  });
  return new RawHtml(out);
}

function renderValue(v) {
  if (v === null || v === undefined || v === false) return '';
  if (v instanceof RawHtml) return v.value;
  if (Array.isArray(v)) return v.map(renderValue).join('');
  return escapeHtml(v);
}

/** Delega di eventi: handler(evento, elementoCheCorrispondeAlSelettore). */
export function on(root, event, selector, handler) {
  root.addEventListener(event, (ev) => {
    const target = ev.target instanceof Element ? ev.target.closest(selector) : null;
    if (target && root.contains(target)) handler(ev, target);
  });
}

/** Valori dei campi con attributo name. Le checkbox diventano booleani. */
export function formData(formEl) {
  const out = {};
  for (const el of formEl.querySelectorAll('[name]')) {
    if (el.type === 'checkbox') out[el.name] = el.checked;
    else if (el.type === 'radio') {
      if (el.checked) out[el.name] = el.value;
    } else out[el.name] = el.value;
  }
  return out;
}

const DATE_TIME = new Intl.DateTimeFormat('it-IT', {
  day: 'numeric',
  month: 'short',
  year: 'numeric',
  hour: '2-digit',
  minute: '2-digit'
});
const DATE_ONLY = new Intl.DateTimeFormat('it-IT', { day: 'numeric', month: 'short', year: 'numeric' });

export function fmtDateTime(iso) {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? 'n.d.' : DATE_TIME.format(d);
}

export function fmtDate(iso) {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? 'n.d.' : DATE_ONLY.format(d);
}

// ---------------------------------------------------------------------------
// Toast
// ---------------------------------------------------------------------------
export function toast(message, type = 'info') {
  const host = $('#toasts');
  if (!host) return;
  const el = document.createElement('div');
  el.className = `toast toast-${type}`;
  el.setAttribute('role', type === 'error' ? 'alert' : 'status');
  el.textContent = message;
  host.appendChild(el);
  setTimeout(() => {
    el.classList.add('toast-out');
    setTimeout(() => el.remove(), 220);
  }, type === 'error' ? 5200 : 3200);
}

// ---------------------------------------------------------------------------
// Sheet: pannello modale che sale dal basso (su schermi larghi è centrato)
// ---------------------------------------------------------------------------
function setContent(target, content) {
  if (content === null || content === undefined || content === '') return;
  if (content instanceof Node) target.appendChild(content);
  else target.innerHTML = String(content);
}

const openSheets = new Set();

/** Chiude ogni pannello aperto: serve quando si cambia vista (anche col tasto indietro). */
export function closeAllSheets() {
  for (const close of Array.from(openSheets)) close();
}

export function openSheet({ title = '', body = '', footer = '', onClose = null, wide = false } = {}) {
  const dlg = document.createElement('dialog');
  dlg.className = `sheet${wide ? ' sheet-wide' : ''}`;
  dlg.innerHTML = `
    <div class="sheet-panel">
      <header class="sheet-header">
        <h2 class="sheet-title"></h2>
        <button type="button" class="btn-icon sheet-close" aria-label="Chiudi">${icon('x')}</button>
      </header>
      <div class="sheet-body"></div>
      <footer class="sheet-footer"></footer>
    </div>`;
  $('.sheet-title', dlg).textContent = title;
  setContent($('.sheet-body', dlg), body);
  const footerEl = $('.sheet-footer', dlg);
  setContent(footerEl, footer);
  if (!footerEl.childNodes.length) footerEl.remove();

  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    openSheets.delete(close);
    if (dlg.open) dlg.close();
    dlg.remove();
    if (typeof onClose === 'function') onClose();
  };
  openSheets.add(close);

  $('.sheet-close', dlg).addEventListener('click', close);
  // Tocco sullo sfondo: il bersaglio è il dialog stesso, non il pannello
  dlg.addEventListener('click', (ev) => {
    if (ev.target === dlg) close();
  });
  dlg.addEventListener('cancel', (ev) => {
    ev.preventDefault();
    close();
  });

  ($('#sheets') || document.body).appendChild(dlg);
  if (typeof dlg.showModal === 'function') dlg.showModal();
  else dlg.setAttribute('open', '');
  return { el: dlg, close };
}

export function confirmDialog({
  title = 'Confermi?',
  message = '',
  confirmLabel = 'Elimina',
  cancelLabel = 'Annulla',
  danger = true
} = {}) {
  return new Promise((resolve) => {
    let answer = false;
    const body = document.createElement('p');
    body.className = 'confirm-text';
    body.textContent = message;

    const footer = document.createElement('div');
    footer.className = 'sheet-actions';
    footer.innerHTML = `
      <button type="button" class="btn btn-ghost" data-act="no"></button>
      <button type="button" class="btn ${danger ? 'btn-danger' : 'btn-primary'}" data-act="yes"></button>`;
    $('[data-act="no"]', footer).textContent = cancelLabel;
    $('[data-act="yes"]', footer).textContent = confirmLabel;

    const sheet = openSheet({ title, body, footer, onClose: () => resolve(answer) });
    sheet.el.classList.add('sheet-confirm');
    $('[data-act="no"]', footer).addEventListener('click', () => sheet.close());
    $('[data-act="yes"]', footer).addEventListener('click', () => {
      answer = true;
      sheet.close();
    });
  });
}
