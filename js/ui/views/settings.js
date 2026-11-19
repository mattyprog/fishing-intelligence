/**
 * Vista "Impostazioni": aspetto, copia e ripristino dei dati, account (solo se il cloud è
 * configurato da chi pubblica l'app), sicurezza, regole di pesca, come nasce il punteggio, crediti.
 */

import { APP, LINKS, isCloudConfigured } from '../../config.js';
import { state, bus } from '../../state.js';
import { $, html, raw, on, openSheet, confirmDialog, toast, formData, fmtDateTime } from '../dom.js';
import { icon } from '../icons.js';
import {
  getPrefs,
  setPrefs,
  listCatches,
  listGear,
  listBaits,
  listSpots,
  countDemoRecords,
  removeDemoRecords,
  clearAllData,
  storageUsage
} from '../../services/storage.js';
import { exportBackup, validateBackup, importBackup, catchesToCsv } from '../../services/backup.js';
import { getSyncStatus, syncNow } from '../../services/sync.js';
import { CATCH_SPECIES, REGULATIONS } from '../../core/species.js';
import { WEIGHTS } from '../../core/scoring.js';
import { getCloud } from '../../cloud.js';

let root = null;

const MAX_BACKUP_BYTES = 2 * 1024 * 1024;

const THEMES = [
  { key: 'auto', label: 'Automatico' },
  { key: 'dark', label: 'Scuro' },
  { key: 'light', label: 'Chiaro' }
];

const FACTOR_LABEL = {
  sea: 'Mare: altezza, periodo e fase dell\'onda',
  wind: 'Vento e direzione rispetto alla spiaggia',
  light: 'Luce: alba, giorno, tramonto, notte',
  season: 'Stagione della specie',
  water: 'Temperatura dell\'acqua',
  pressure: 'Pressione e sua tendenza',
  tide: 'Marea',
  moon: 'Luna'
};

// ---------------------------------------------------------------- Montaggio

export function mount(el) {
  root = el;
  root.innerHTML = `
    <h1 class="view-title">Impostazioni</h1>
    <div data-slot="body"></div>
    <input type="file" accept="application/json,.json" class="hidden" data-slot="file" />`;

  on(root, 'click', '[data-act]', handleAction);
  $('[data-slot="file"]', root).addEventListener('change', handleFile);

  bus.on('data:changed', render);
  bus.on('auth:changed', render);
  bus.on('sync:status', render);
  bus.on('install:available', render);
  render();
}

export function show() {
  render();
}

function handleAction(ev, el) {
  const act = el.dataset.act;
  if (act === 'theme') trySetPrefs({ theme: el.dataset.theme });
  else if (act === 'export') doExport();
  else if (act === 'import') $('[data-slot="file"]', root).click();
  else if (act === 'csv') doCsv();
  else if (act === 'remove-demo') removeDemo();
  else if (act === 'wipe') wipeAll();
  else if (act === 'install') doInstall();
  else if (act === 'sign-in') openAuthSheet('in');
  else if (act === 'sign-up') openAuthSheet('up');
  else if (act === 'sign-out') doSignOut();
  else if (act === 'sync') doSync();
}

function trySetPrefs(partial) {
  try {
    setPrefs(partial);
  } catch (err) {
    toast(err?.message || 'Preferenza non salvata.', 'error');
  }
}

// ---------------------------------------------------------------- Disegno

function render() {
  if (!root) return;
  // Non ridisegnare mentre l'utente legge una sezione aperta: si richiuderebbe
  const openIds = Array.from(root.querySelectorAll('details[open]')).map((d) => d.dataset.id);

  const prefs = getPrefs();
  const counts = {
    catches: listCatches().length,
    gear: listGear().length,
    baits: listBaits().length,
    spots: listSpots().filter((s) => s.isCustom).length
  };
  const demo = countDemoRecords();

  $('[data-slot="body"]', root).innerHTML = html`
    <section class="card stack">
      <h2 class="card-title">Aspetto</h2>
      <div class="segmented" role="group" aria-label="Tema">
        ${THEMES.map((t) => html`<button type="button" data-act="theme" data-theme="${t.key}" aria-pressed="${prefs.theme === t.key ? 'true' : 'false'}">${t.label}</button>`)}
      </div>
      <p class="help">In automatico l'app è chiara di giorno e scura dal tramonto all'alba.</p>
    </section>

    <section class="card stack">
      <div>
        <h2 class="card-title">I tuoi dati</h2>
        <p class="card-sub">${dataSummary(counts)} Restano su questo dispositivo${isCloudConfigured() && state.user ? ' e sul tuo account' : ''}.</p>
      </div>
      <div class="stack-sm">
        <button type="button" class="btn btn-block" data-act="export">${raw(icon('download', { size: 18 }))} Salva una copia</button>
        <button type="button" class="btn btn-block" data-act="import">${raw(icon('upload', { size: 18 }))} Ripristina da una copia</button>
        <button type="button" class="btn btn-block" data-act="csv" ${counts.catches ? '' : raw('disabled')}>${raw(icon('list', { size: 18 }))} Esporta il diario per Excel</button>
      </div>
      <p class="help" data-slot="usage">Se cancelli i dati del browser o cambi telefono, senza una copia il diario si perde.</p>
      ${demo ? html`<button type="button" class="btn-link settings-left" data-act="remove-demo">Rimuovi i ${demo} esempi della versione precedente</button>` : ''}
      <button type="button" class="btn btn-danger btn-block" data-act="wipe">${raw(icon('trash', { size: 18 }))} Cancella tutti i dati</button>
    </section>

    ${raw(accountCard())}
    ${state.installPrompt ? html`<section class="card stack">
      <div>
        <h2 class="card-title">Sulla schermata iniziale</h2>
        <p class="card-sub">Installa l'app: si apre come le altre e funziona anche con poco segnale.</p>
      </div>
      <button type="button" class="btn btn-primary btn-block" data-act="install">${raw(icon('download', { size: 18 }))} Installa</button>
    </section>` : ''}

    <h2 class="section-title">Da sapere</h2>
    <div class="stack-sm">
      ${raw(safetyDetails())}
      ${raw(rulesDetails())}
      ${raw(scoreDetails())}
      ${raw(creditsDetails())}
    </div>
    <p class="small muted settings-version">${APP.name} ${APP.version}</p>`.toString();

  for (const id of openIds) {
    const d = root.querySelector(`details[data-id="${id}"]`);
    if (d) d.open = true;
  }
  paintUsage();
}

function dataSummary(c) {
  const parts = [
    `${c.catches} ${c.catches === 1 ? 'cattura' : 'catture'}`,
    `${c.gear} ${c.gear === 1 ? 'attrezzo' : 'attrezzi'}`,
    `${c.baits} ${c.baits === 1 ? 'esca' : 'esche'}`,
    `${c.spots} ${c.spots === 1 ? 'spot personale' : 'spot personali'}`
  ];
  return `${parts.join(', ')}.`;
}

function paintUsage() {
  Promise.resolve()
    .then(() => storageUsage())
    .then((u) => {
      const el = root && $('[data-slot="usage"]', root);
      if (!el || !u || !Number.isFinite(u.bytes)) return;
      const kb = Math.max(1, Math.round(u.bytes / 1024));
      el.textContent = `Spazio usato: ${kb} KB. Se cancelli i dati del browser o cambi telefono, senza una copia il diario si perde.`;
    })
    .catch(() => {});
}

function details(id, iconName, title, content) {
  return html`<details class="details" data-id="${id}">
    <summary><span class="row">${raw(icon(iconName))}<span>${title}</span></span>${raw(icon('chevron-down', { size: 18 }))}</summary>
    <div class="details-body stack">${content}</div>
  </details>`.toString();
}

function safetyDetails() {
  const item = (title, text) => html`<div><h3>${title}</h3><p class="small muted">${text}</p></div>`;
  return details(
    'safety',
    'shield',
    'Sicurezza in spiaggia',
    html`
      ${item('Prima di uscire', 'Controlla gli avvisi di burrasca e le ordinanze della Capitaneria. Questa app aiuta a scegliere il momento, non sostituisce i bollettini ufficiali.')}
      ${item('Temporale: canne giù, subito', 'Le canne in carbonio conducono la corrente. Al primo tuono, anche lontano, abbassale e lascia la spiaggia aperta.')}
      ${item('Mare formato', 'Con onda sopra 1.5 m ogni tanto arriva una serie più grande che risale la spiaggia. Tieni attrezzatura e piedi lontani dal gradino.')}
      ${item('Di notte', 'Lampada frontale, telefono carico e qualcuno che sappia dove sei.')}
      <div class="notice notice-info">
        ${raw(icon('info'))}
        <p>Emergenze in mare: <a href="tel:1530">1530</a>, Guardia Costiera. Ogni altra emergenza: <a href="tel:112">112</a>. Bollettini del mare: <a href="${LINKS.meteoam}" target="_blank" rel="noopener">MeteoAM</a>.</p>
      </div>`
  );
}

function rulesDetails() {
  const withSize = CATCH_SPECIES.filter((s) => Number.isFinite(s.minLegalSizeCm)).sort((a, b) => a.name.localeCompare(b.name, 'it'));
  const withoutSize = CATCH_SPECIES.filter((s) => !Number.isFinite(s.minLegalSizeCm) && s.id !== 'altro').map((s) => s.name.toLowerCase());
  const dailyKg = REGULATIONS?.dailyLimitKg ?? 5;
  const hooks = REGULATIONS?.maxHooksPerRod ?? 3;
  return details(
    'rules',
    'ruler',
    'Regole di pesca',
    html`
      <ul class="settings-bullets small">
        <li>Al massimo ${dailyKg} kg al giorno a persona, oppure un solo pesce più pesante.</li>
        <li>Ogni canna può avere al massimo ${hooks} ami.</li>
        <li>Serve la comunicazione al ministero: è gratuita, vale un anno e fa da tesserino. <a href="${LINKS.tesserino}" target="_blank" rel="noopener">Si fa sul portale SIAN</a>.</li>
        <li>L'app europea RecFishing, obbligatoria da maggio 2026, riguarda chi pesca in apnea o dalla barca: da riva non serve. <a href="${LINKS.comunicazionePesca}" target="_blank" rel="noopener">Lo spiega la Guardia Costiera</a>.</li>
        <li>Il pescato non si può vendere.</li>
      </ul>
      <div>
        <h3>Taglie minime</h3>
        <div class="table-wrap">
          <table class="table">
            <thead><tr><th>Specie</th><th>Minimo</th></tr></thead>
            <tbody>${withSize.map((s) => html`<tr><td>${s.name}</td><td>${s.minLegalSizeCm} cm</td></tr>`)}</tbody>
          </table>
        </div>
        ${withoutSize.length ? html`<p class="small muted settings-gap">Senza taglia minima europea: ${withoutSize.join(', ')}. Rilasciare i piccoli resta una buona abitudine.</p>` : ''}
      </div>
      <p class="small muted">Riassunto delle regole nazionali ed europee, controllato a novembre 2026 su <a href="${LINKS.taglieMinime}" target="_blank" rel="noopener">regolamento UE 2019/1241</a> e DPR 1639/1968. Ordinanze locali e aree protette possono essere più severe: fanno fede le fonti ufficiali.</p>`
  );
}

function scoreDetails() {
  const entries = Object.entries(WEIGHTS || {}).sort((a, b) => b[1] - a[1]);
  return details(
    'score',
    'radar',
    'Come nasce il punteggio',
    html`
      <p class="small">Va da 0 a 100 e descrive la finestra migliore di tre ore della giornata, per la specie scelta. Confronta le previsioni con le abitudini note di quella specie.</p>
      <div class="stack-sm">
        ${entries.map(
          ([key, w]) => html`<div>
            <div class="row-between small"><span>${FACTOR_LABEL[key] || key}</span><span class="num muted">${Math.round(w * 100)}%</span></div>
            <div class="meter"><span style="width:${Math.round((w / (entries[0]?.[1] || 1)) * 100)}%"></span></div>
          </div>`
        )}
      </div>
      <p class="small muted">La sicurezza viene prima: con mare o vento pericolosi il giudizio è "pericolo", qualunque sia il resto.</p>
      <p class="small muted">È una stima. Le preferenze delle specie vengono dall'esperienza dei pescatori del Tirreno, non da misure. Luna e marea pesano poco perché le prove sono deboli. Oltre i quattro giorni le previsioni cambiano spesso.</p>`
  );
}

function creditsDetails() {
  const grid = state.forecast?.marineGrid;
  return details(
    'credits',
    'info',
    'Fonti e crediti',
    html`
      <ul class="settings-bullets small">
        <li>Meteo e mare: <a href="${LINKS.openMeteo}" target="_blank" rel="noopener">Open-Meteo</a>, licenza CC BY 4.0.</li>
        <li>Mappe: <a href="${LINKS.osmCopyright}" target="_blank" rel="noopener">OpenStreetMap</a>. Immagini satellitari: Esri. Carta nautica: OpenSeaMap. Ricerca dei luoghi: Nominatim.</li>
        <li>Sole e luna: calcolati sul dispositivo.</li>
      </ul>
      <p class="small muted">I dati del mare vengono da modelli con celle di alcuni chilometri: sotto costa sono indicativi.${grid && Number.isFinite(grid.distanceKm) ? ` Per lo spot attivo il punto del modello è a ${grid.distanceKm.toFixed(1)} km.` : ''} Il livello del mare serve a leggere il giro di marea, non per la navigazione.</p>`
  );
}

// ---------------------------------------------------------------- Account e sincronizzazione

function accountCard() {
  if (!isCloudConfigured()) return '';
  let status = null;
  try {
    status = getSyncStatus();
  } catch (err) {
    status = null;
  }
  if (!state.user) {
    return html`<section class="card stack">
      <div>
        <h2 class="card-title">Account</h2>
        <p class="card-sub">Senza account i dati restano solo su questo dispositivo. Con un account li ritrovi anche sugli altri.</p>
      </div>
      <div class="row">
        <button type="button" class="btn btn-primary grow" data-act="sign-in">Accedi</button>
        <button type="button" class="btn grow" data-act="sign-up">Crea account</button>
      </div>
    </section>`.toString();
  }
  const line = !status
    ? ''
    : status.syncing
      ? 'Sincronizzazione in corso…'
      : status.error
        ? `Ultimo tentativo non riuscito: ${status.error}`
        : status.pending
          ? `${status.pending} ${status.pending === 1 ? 'modifica' : 'modifiche'} da inviare.`
          : status.lastSyncAt
            ? `Tutto sincronizzato, ${fmtDateTime(status.lastSyncAt)}.`
            : 'Non ancora sincronizzato.';
  return html`<section class="card stack">
    <div>
      <h2 class="card-title">Account</h2>
      <p class="card-sub">${state.user.email || 'Accesso eseguito'}</p>
    </div>
    <p class="small ${status?.error ? 'error-text' : 'muted'}">${line}</p>
    <div class="row">
      <button type="button" class="btn grow" data-act="sync" ${status?.syncing ? raw('disabled') : ''}>${raw(icon('refresh', { size: 18 }))} Sincronizza</button>
      <button type="button" class="btn btn-ghost grow" data-act="sign-out">${raw(icon('log-out', { size: 18 }))} Esci</button>
    </div>
  </section>`.toString();
}

function openAuthSheet(mode) {
  const cloud = getCloud();
  if (!cloud) {
    toast('Il servizio di account non risponde. Riprova più tardi.', 'error');
    return;
  }
  const signUp = mode === 'up';
  const body = document.createElement('form');
  body.className = 'stack';
  body.noValidate = true;
  body.innerHTML = html`
    ${signUp ? html`<div class="field"><label for="auth-name">Nome</label><input id="auth-name" name="name" class="input" type="text" maxlength="40" autocomplete="nickname" /></div>` : ''}
    <div class="field"><label for="auth-email">Email</label><input id="auth-email" name="email" class="input" type="email" required autocomplete="email" inputmode="email" /></div>
    <div class="field"><label for="auth-password">Password</label><input id="auth-password" name="password" class="input" type="password" required minlength="8" autocomplete="${signUp ? 'new-password' : 'current-password'}" /></div>
    ${signUp ? html`<p class="help">Almeno 8 caratteri. I dati che hai già su questo dispositivo verranno caricati sul tuo account.</p>` : ''}
    <p class="error-text hidden" data-slot="error" role="alert"></p>`.toString();

  const footer = document.createElement('div');
  footer.className = 'sheet-actions';
  footer.innerHTML = `<button type="button" class="btn btn-primary" data-act="go">${signUp ? 'Crea account' : 'Accedi'}</button>`;
  const sheet = openSheet({ title: signUp ? 'Crea account' : 'Accedi', body, footer });
  const errorEl = $('[data-slot="error"]', body);
  const showError = (msg) => {
    errorEl.textContent = msg || '';
    errorEl.classList.toggle('hidden', !msg);
  };

  const submit = async () => {
    const v = formData(body);
    if (!/^\S+@\S+\.\S+$/.test(v.email.trim())) return showError('Scrivi un indirizzo email valido.');
    if (v.password.length < 8) return showError('La password deve avere almeno 8 caratteri.');
    const btn = $('[data-act="go"]', footer);
    btn.disabled = true;
    try {
      let message = 'Accesso eseguito.';
      if (signUp) {
        const res = await cloud.signUp(v.email.trim(), v.password, (v.name || '').trim());
        message = res?.needsConfirmation ? 'Account creato. Conferma l\'email che ti abbiamo mandato, poi accedi.' : 'Account creato.';
      } else await cloud.signIn(v.email.trim(), v.password);
      sheet.close();
      toast(message, 'success');
    } catch (err) {
      showError(err?.message || 'Accesso non riuscito.');
    } finally {
      btn.disabled = false;
    }
  };
  body.addEventListener('submit', (ev) => {
    ev.preventDefault();
    submit();
  });
  on(footer, 'click', '[data-act="go"]', submit);
}

async function doSignOut() {
  try {
    await getCloud()?.signOut();
    toast('Sei uscito. I dati restano su questo dispositivo.', 'info');
  } catch (err) {
    toast(err?.message || 'Non sono riuscito a uscire.', 'error');
  }
}

async function doSync() {
  const res = await syncNow();
  if (res?.ok) toast('Dati sincronizzati.', 'success');
  else if (res?.skipped === 'offline') toast('Senza rete: sincronizzo appena torna.', 'info');
  else if (res?.skipped === 'signed-out') toast('Accedi al tuo account per sincronizzare.', 'info');
  else toast(res?.error || 'Sincronizzazione non riuscita.', 'error');
}

// ---------------------------------------------------------------- Copia, ripristino, CSV

function download(filename, content, type) {
  const blob = new Blob([content], { type });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

function today() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function doExport() {
  try {
    download(`fishing-intelligence-copia-${today()}.json`, JSON.stringify(exportBackup(), null, 2), 'application/json');
    toast('Copia salvata nei download.', 'success');
  } catch (err) {
    toast(err?.message || 'Non sono riuscito a creare la copia.', 'error');
  }
}

function doCsv() {
  try {
    download(`fishing-intelligence-diario-${today()}.csv`, catchesToCsv(listCatches()), 'text/csv;charset=utf-8');
    toast('Diario esportato nei download.', 'success');
  } catch (err) {
    toast(err?.message || 'Non sono riuscito a esportare il diario.', 'error');
  }
}

async function handleFile(ev) {
  const input = ev.target;
  const file = input.files?.[0];
  input.value = '';
  if (!file) return;
  if (file.size > MAX_BACKUP_BYTES) {
    toast('Il file è troppo grande per essere una copia di questa app.', 'error');
    return;
  }
  let data;
  try {
    data = JSON.parse(await file.text());
  } catch (err) {
    toast('Il file non è una copia valida.', 'error');
    return;
  }
  let check;
  try {
    check = validateBackup(data);
  } catch (err) {
    check = { ok: false, errors: [err?.message || 'File non leggibile.'], counts: {} };
  }
  if (!check.ok) {
    const errors = (check.errors || []).slice(0, 5);
    openSheet({
      title: 'Copia non valida',
      body: html`<div class="stack">
        <p class="small">Non ho importato nulla: il file ha dei problemi.</p>
        <ul class="settings-bullets small muted">${errors.map((e) => html`<li>${e}</li>`)}</ul>
        ${(check.errors || []).length > errors.length ? html`<p class="small muted">E altri ${(check.errors || []).length - errors.length}.</p>` : ''}
      </div>`
    });
    return;
  }
  openImportSheet(data, check.counts || {});
}

function openImportSheet(data, counts) {
  const n = (k) => (Number.isFinite(counts[k]) ? counts[k] : 0);
  const body = html`<div class="stack">
    <p>La copia contiene ${dataSummary({ catches: n('catches'), gear: n('gear'), baits: n('baits'), spots: n('spots') })}</p>
    <p class="small muted">Unendo, i dati presenti restano e per le voci doppie vince la più recente. Sostituendo, i dati presenti su questo dispositivo vengono cancellati.</p>
  </div>`;
  const footer = document.createElement('div');
  footer.className = 'sheet-actions';
  footer.innerHTML = `
    <button type="button" class="btn btn-danger" data-mode="replace">Sostituisci</button>
    <button type="button" class="btn btn-primary" data-mode="merge">Unisci</button>`;
  const sheet = openSheet({ title: 'Ripristina da una copia', body, footer });
  on(footer, 'click', '[data-mode]', async (ev, btn) => {
    const mode = btn.dataset.mode;
    if (mode === 'replace') {
      const ok = await confirmDialog({
        title: 'Sostituire tutti i dati?',
        message: 'I dati presenti su questo dispositivo verranno cancellati e sostituiti con quelli della copia.',
        confirmLabel: 'Sostituisci',
        cancelLabel: 'Annulla'
      });
      if (!ok) return;
    }
    try {
      importBackup(data, { mode });
      sheet.close();
      toast('Dati ripristinati.', 'success');
    } catch (err) {
      toast(err?.message || 'Ripristino non riuscito: non ho cambiato nulla.', 'error');
    }
  });
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

async function wipeAll() {
  const ok = await confirmDialog({
    title: 'Cancellare tutti i dati?',
    message: 'Diario, attrezzatura, esche e spot personali verranno cancellati da questo dispositivo. Non si può annullare: se ti servono, prima salva una copia.',
    confirmLabel: 'Cancella tutto',
    cancelLabel: 'Annulla'
  });
  if (!ok) return;
  try {
    clearAllData();
    window.location.hash = '';
    window.location.reload();
  } catch (err) {
    toast(err?.message || 'Non sono riuscito a cancellare i dati.', 'error');
  }
}

async function doInstall() {
  const prompt = state.installPrompt;
  if (!prompt) return;
  try {
    prompt.prompt();
    await prompt.userChoice;
  } catch (err) {
    console.warn('Installazione non avviata:', err);
  }
  state.installPrompt = null;
  render();
}
