/**
 * Primo avvio: due scelte (spiaggia e specie) e si parte. Si può sempre saltare.
 */

import { state } from '../state.js';
import { $, html, raw, on } from './dom.js';
import { icon } from './icons.js';
import { listSpots, setPrefs } from '../services/storage.js';
import { SPECIES } from '../core/species.js';
import { requestGps } from './map.js';

function distanceKm(aLat, aLng, bLat, bLng) {
  const rad = Math.PI / 180;
  const dLat = (bLat - aLat) * rad;
  const dLng = (bLng - aLng) * rad;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(aLat * rad) * Math.cos(bLat * rad) * Math.sin(dLng / 2) ** 2;
  return 6371 * 2 * Math.asin(Math.sqrt(h));
}

export function runOnboarding() {
  return new Promise((resolve) => {
    const spots = listSpots();
    const choice = { spotId: state.spotId || spots[0]?.id, speciesId: state.speciesId || SPECIES[0].id };
    let step = 1;

    const dlg = document.createElement('dialog');
    dlg.className = 'onb';
    dlg.setAttribute('aria-label', 'Primo avvio');

    const finish = () => {
      state.spotId = choice.spotId;
      state.speciesId = choice.speciesId;
      try {
        setPrefs({ spotId: choice.spotId, speciesId: choice.speciesId, onboarded: true });
      } catch (err) {
        console.warn('Preferenze non salvate:', err);
      }
      if (dlg.open) dlg.close();
      dlg.remove();
      resolve();
    };

    const draw = (note = '') => {
      const stepOne = html`
        <h1>Scegli la tua spiaggia</h1>
        <p class="muted">Parto dal litorale pontino. Potrai aggiungere i tuoi spot, ovunque, quando vuoi.</p>
        <button type="button" class="btn btn-ghost" data-act="gps">${raw(icon('crosshair', { size: 18 }))} Trova lo spot più vicino a me</button>
        ${note ? html`<p class="small muted" role="status">${note}</p>` : ''}
        <div class="list" role="radiogroup" aria-label="Spot">
          ${spots.map(
            (s) => html`<button type="button" class="fc-option" role="radio" aria-checked="${s.id === choice.spotId ? 'true' : 'false'}" data-spot="${s.id}">
              <span class="grow"><span class="item-title">${s.name}</span><span class="item-sub">${s.region}</span></span>
              ${s.id === choice.spotId ? raw(icon('check')) : ''}
            </button>`
          )}
        </div>`;
      const stepTwo = html`
        <h1>Cosa peschi di solito?</h1>
        <p class="muted">Il punteggio cambia da specie a specie. La cambi con un tocco dalla schermata principale.</p>
        <div class="list" role="radiogroup" aria-label="Specie">
          ${SPECIES.map(
            (sp) => html`<button type="button" class="fc-option" role="radio" aria-checked="${sp.id === choice.speciesId ? 'true' : 'false'}" data-species="${sp.id}">
              <span class="fc-code">${sp.short}</span>
              <span class="grow"><span class="item-title">${sp.name}</span><span class="item-sub">${sp.summary}</span></span>
              ${sp.id === choice.speciesId ? raw(icon('check')) : ''}
            </button>`
          )}
        </div>
        <p class="small muted">I tuoi dati restano su questo telefono. Di sera l'app si fa scura da sola.</p>`;

      dlg.innerHTML = html`
        <div class="onb-panel">
          <header class="onb-head">
            <span class="label">Passo ${step} di 2</span>
            <button type="button" class="btn-link" data-act="skip">Salta</button>
          </header>
          <div class="onb-body stack">${step === 1 ? stepOne : stepTwo}</div>
          <footer class="onb-foot">
            ${step === 2 ? html`<button type="button" class="btn btn-ghost" data-act="back">Indietro</button>` : ''}
            <button type="button" class="btn btn-primary grow" data-act="next">${step === 1 ? 'Avanti' : 'Vai alle previsioni'}</button>
          </footer>
        </div>`.toString();
    };

    on(dlg, 'click', '[data-spot]', (ev, el) => {
      choice.spotId = el.dataset.spot;
      draw();
    });
    on(dlg, 'click', '[data-species]', (ev, el) => {
      choice.speciesId = el.dataset.species;
      draw();
    });
    on(dlg, 'click', '[data-act]', async (ev, el) => {
      const act = el.dataset.act;
      if (act === 'skip') finish();
      else if (act === 'back') {
        step = 1;
        draw();
      } else if (act === 'next') {
        if (step === 1) {
          step = 2;
          draw();
          $('.onb-body', dlg)?.scrollTo?.(0, 0);
        } else finish();
      } else if (act === 'gps') {
        el.disabled = true;
        try {
          const pos = await requestGps();
          const ranked = spots
            .map((s) => ({ s, km: distanceKm(pos.lat, pos.lng, s.lat, s.lng) }))
            .sort((a, b) => a.km - b.km);
          choice.spotId = ranked[0].s.id;
          const km = Math.round(ranked[0].km);
          draw(
            km > 40
              ? `Lo spot più vicino è ${ranked[0].s.name}, a circa ${km} km. Dopo potrai aggiungere la tua spiaggia.`
              : `Il più vicino è ${ranked[0].s.name}, a circa ${km} km.`
          );
        } catch (err) {
          draw(err.message || 'Posizione non disponibile: scegli dall\'elenco.');
        }
      }
    });
    dlg.addEventListener('cancel', (ev) => {
      ev.preventDefault();
      finish();
    });

    draw();
    document.body.appendChild(dlg);
    if (typeof dlg.showModal === 'function') dlg.showModal();
    else dlg.setAttribute('open', '');
  });
}
