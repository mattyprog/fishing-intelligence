/**
 * Fishing Intelligence · avvio dell'app.
 * Prepara i dati locali, il tema, la navigazione tra le quattro viste e il service worker.
 */

import { state, bus } from './state.js';
import { $, $$, toast, closeAllSheets } from './ui/dom.js';
import { icon } from './ui/icons.js';
import { initStorage, getPrefs, setPrefs, getSpot, listSpots } from './services/storage.js';
import { SPECIES, getSpecies } from './core/species.js';
import { refreshForecast, installAutoRefresh } from './forecast-controller.js';

const VIEWS = {
  forecast: { hash: 'oggi', load: () => import('./ui/views/forecast.js') },
  gear: { hash: 'attrezzatura', load: () => import('./ui/views/gear.js') },
  diary: { hash: 'diario', load: () => import('./ui/views/diary.js') },
  settings: { hash: 'impostazioni', load: () => import('./ui/views/settings.js') }
};

const mounted = new Map();
let activeView = null;

// ---------------------------------------------------------------- Tema

/** In automatico l'app è scura se lo chiede il sistema oppure se allo spot è buio. */
function resolveTheme(pref) {
  if (pref === 'dark' || pref === 'light') return pref;
  const systemLight = window.matchMedia?.('(prefers-color-scheme: light)').matches;
  if (!systemLight) return 'dark';
  const sun = state.forecast?.days?.[0]?.sun;
  const now = Date.now();
  if (sun?.sunrise?.epochMs && sun?.sunset?.epochMs) {
    return now >= sun.sunrise.epochMs && now < sun.sunset.epochMs ? 'light' : 'dark';
  }
  const hour = new Date().getHours();
  return hour >= 7 && hour < 18 ? 'light' : 'dark';
}

function applyTheme() {
  const theme = resolveTheme(getPrefs().theme);
  document.documentElement.setAttribute('data-theme', theme);
  $('meta[name="theme-color"]')?.setAttribute('content', theme === 'light' ? '#f5f7fa' : '#0b1220');
  const btn = $('#btn-theme');
  if (btn) {
    btn.innerHTML = icon(theme === 'light' ? 'moon' : 'sun');
    btn.setAttribute('aria-label', theme === 'light' ? 'Passa al tema scuro' : 'Passa al tema chiaro');
  }
}

function initTheme() {
  applyTheme();
  $('#btn-theme')?.addEventListener('click', () => {
    const next = document.documentElement.getAttribute('data-theme') === 'light' ? 'dark' : 'light';
    try {
      setPrefs({ theme: next });
    } catch (err) {
      // Senza memoria locale il tema cambia lo stesso, solo per questa sessione
      document.documentElement.setAttribute('data-theme', next);
      return;
    }
    applyTheme();
  });
  window.matchMedia?.('(prefers-color-scheme: light)').addEventListener?.('change', applyTheme);
  bus.on('data:changed', ({ kind } = {}) => {
    if (kind === 'prefs' || kind === 'all') applyTheme();
  });
  bus.on('forecast:updated', applyTheme);
  setInterval(applyTheme, 5 * 60 * 1000);
}

// ---------------------------------------------------------------- Navigazione

function parseHash() {
  const raw = window.location.hash.replace(/^#/, '');
  const [name, query = ''] = raw.split('?');
  const viewId = Object.keys(VIEWS).find((id) => VIEWS[id].hash === name) || 'forecast';
  return { viewId, params: Object.fromEntries(new URLSearchParams(query)) };
}

export function navigate(viewId, params = {}) {
  const view = VIEWS[viewId];
  if (!view) return;
  const query = new URLSearchParams(params).toString();
  const target = `#${view.hash}${query ? `?${query}` : ''}`;
  if (window.location.hash === target) showView(viewId, params);
  else window.location.hash = target;
}

async function showView(viewId, params = {}) {
  // Un pannello rimasto aperto coprirebbe la vista nuova (succede col tasto indietro)
  if (activeView && activeView !== viewId) closeAllSheets();
  activeView = viewId;
  $$('.view').forEach((el) => el.classList.toggle('is-active', el.id === `view-${viewId}`));
  $$('.tab').forEach((el) => {
    if (el.dataset.view === viewId) el.setAttribute('aria-current', 'page');
    else el.removeAttribute('aria-current');
  });
  window.scrollTo(0, 0);

  const root = $(`#view-${viewId}`);
  try {
    if (!mounted.has(viewId)) {
      const mod = await VIEWS[viewId].load();
      mod.mount(root, { state, bus, navigate });
      mounted.set(viewId, mod);
    }
    // Se nel frattempo l'utente è passato a un'altra vista non serve mostrarla
    if (activeView === viewId) mounted.get(viewId).show?.(params);
  } catch (err) {
    console.error(`Vista "${viewId}" non caricata:`, err);
    root.innerHTML = `
      <div class="empty">
        <div class="empty-icon">${icon('alert', { size: 28 })}</div>
        <p class="empty-title">Questa sezione non si è aperta</p>
        <p class="empty-text">Controlla la connessione e riprova.</p>
        <button type="button" class="btn btn-primary" data-retry>Riprova</button>
      </div>`;
    $('[data-retry]', root)?.addEventListener('click', () => window.location.reload());
  }
}

function initNavigation() {
  $$('[data-icon]').forEach((el) => {
    el.innerHTML = icon(el.dataset.icon, { size: 24 });
  });
  $$('.tab').forEach((el) => el.addEventListener('click', () => navigate(el.dataset.view)));
  window.addEventListener('hashchange', () => {
    const { viewId, params } = parseHash();
    showView(viewId, params);
  });
}

// ---------------------------------------------------------------- Rete e aggiornamenti

function initNetworkStatus() {
  const pill = $('#net-pill');
  const update = () => pill?.classList.toggle('is-offline', !navigator.onLine);
  window.addEventListener('online', update);
  window.addEventListener('offline', update);
  update();
}

function showUpdateBanner(worker) {
  if ($('#update-banner')) return;
  const bar = document.createElement('div');
  bar.id = 'update-banner';
  bar.className = 'toast toast-success update-banner';
  bar.innerHTML = `<span>È pronta una versione nuova.</span> <button type="button" class="btn-link">Aggiorna</button>`;
  $('button', bar).addEventListener('click', () => {
    worker.postMessage({ type: 'SKIP_WAITING' });
    bar.remove();
  });
  $('#toasts')?.appendChild(bar);
}

function initServiceWorker() {
  if (!('serviceWorker' in navigator)) return;
  const secure = window.location.protocol === 'https:' || ['localhost', '127.0.0.1'].includes(window.location.hostname);
  if (!secure) return;

  let reloading = false;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (reloading) return;
    reloading = true;
    window.location.reload();
  });

  navigator.serviceWorker
    .register('./sw.js')
    .then((reg) => {
      if (reg.waiting && navigator.serviceWorker.controller) showUpdateBanner(reg.waiting);
      reg.addEventListener('updatefound', () => {
        const worker = reg.installing;
        worker?.addEventListener('statechange', () => {
          if (worker.state === 'installed' && navigator.serviceWorker.controller) showUpdateBanner(worker);
        });
      });
    })
    .catch((err) => console.warn('Service worker non registrato:', err));
}

// ---------------------------------------------------------------- Avvio

async function start() {
  // initStorage non lancia: se il browser rifiuta il salvataggio lo dice nel risultato
  const boot = initStorage();
  const storageOk = !boot.error;
  if (!storageOk) console.error('Memoria locale non disponibile:', boot.error);
  // Dati della versione precedente che non si sono potuti leggere: restano dov'erano, ma va detto
  if (boot.skipped) {
    setTimeout(() => toast(`${boot.skipped} ${boot.skipped === 1 ? 'elemento' : 'elementi'} della versione precedente non ${boot.skipped === 1 ? 'era leggibile e non è stato importato' : 'erano leggibili e non sono stati importati'}.`, 'error'), 1200);
  }

  const prefs = getPrefs();
  state.spotId = getSpot(prefs.spotId) ? prefs.spotId : listSpots()[0]?.id;
  state.speciesId = getSpecies(prefs.speciesId) ? prefs.speciesId : SPECIES[0].id;

  initTheme();
  initNavigation();
  initNetworkStatus();
  initServiceWorker();

  if (!storageOk) {
    toast('Il browser non permette di salvare i dati: catture e attrezzatura non verranno conservate.', 'error');
  }

  if (!prefs.onboarded && storageOk) {
    try {
      const { runOnboarding } = await import('./ui/onboarding.js');
      await runOnboarding();
    } catch (err) {
      console.error('Primo avvio non completato:', err);
    }
  }

  const { viewId, params } = parseHash();
  await showView(viewId, params);

  installAutoRefresh();
  refreshForecast();

  // Il cloud è facoltativo e non deve mai rallentare l'avvio
  import('./cloud.js').then((m) => m.initCloud()).catch((err) => console.warn('Cloud non avviato:', err));
}

// Il browser offre l'installazione quando vuole: si tiene da parte per le Impostazioni
window.addEventListener('beforeinstallprompt', (ev) => {
  ev.preventDefault();
  state.installPrompt = ev;
  bus.emit('install:available');
});
window.addEventListener('appinstalled', () => {
  state.installPrompt = null;
  bus.emit('install:available');
});

start();
