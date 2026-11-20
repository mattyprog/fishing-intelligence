/**
 * Vista "Oggi": risponde in pochi secondi a "vale la pena andare? quando? dove?".
 * In alto verdetto, finestra migliore e motivo; sotto i sette giorni, l'andamento orario,
 * le condizioni e, dietro un tocco, il perché del punteggio e il piano di pesca.
 */

import { CACHE, LINKS } from '../../config.js';
import { state, bus } from '../../state.js';
import { $, $$, html, raw, on, openSheet, toast } from '../dom.js';
import { icon } from '../icons.js';
import { hourChart, scoreArc, directionArrow } from '../charts.js';
import { listSpots, listGear, listBaits } from '../../services/storage.js';
import { loadForecasts } from '../../services/weather-api.js';
import { SPECIES, withArticle } from '../../core/species.js';
import { evaluateForecast } from '../../core/scoring.js';
import { buildTactics } from '../../core/tactics.js';
import { windName, seaStateLabel, weatherLabel, fmtNum } from '../../core/format.js';
import {
  refreshForecast,
  selectSpot,
  selectSpecies,
  selectDay,
  currentSpot,
  currentSpecies,
  isForecastExpired
} from '../../forecast-controller.js';
import { openSpotSheet } from '../spot-sheet.js';

let root = null;
let ctx = null;
let series = 'score';
let selectedHourIndex = -1;

const SERIES = [
  { key: 'score', label: 'Punteggio' },
  { key: 'wave', label: 'Onda' },
  { key: 'wind', label: 'Vento' },
  { key: 'tide', label: 'Marea' }
];

const PHASE_LABEL = { scaduta: 'in scaduta', montante: 'in aumento', stabile: 'stabile' };
const INCIDENCE_LABEL = { onshore: 'dal mare', offshore: 'da terra', cross: 'di traverso' };
const LIGHT_LABEL = { night: 'notte', dawn: 'alba', day: 'giorno', dusk: 'tramonto' };

// ---------------------------------------------------------------- Montaggio

export function mount(el, context) {
  root = el;
  ctx = context;
  root.innerHTML = `
    <div class="fc-pickers">
      <button type="button" class="fc-picker" data-act="pick-spot" aria-haspopup="dialog">
        ${icon('map-pin', { size: 18 })}<span class="fc-picker-text" data-slot="spot-name"></span>${icon('chevron-down', { size: 16 })}
      </button>
      <button type="button" class="fc-picker" data-act="pick-species" aria-haspopup="dialog">
        ${icon('fish', { size: 18 })}<span class="fc-picker-text" data-slot="species-name"></span>${icon('chevron-down', { size: 16 })}
      </button>
    </div>
    <div data-slot="body"></div>`;

  on(root, 'click', '[data-act]', handleAction);
  on(root, 'click', '.chart-hit', (ev, el2) => {
    const day = state.forecast?.days?.[state.dayIndex];
    if (!day) return;
    const index = day.startIndex + Number(el2.dataset.pos);
    selectedHourIndex = selectedHourIndex === index ? -1 : index;
    renderChart();
  });

  bus.on('forecast:loading', render);
  bus.on('forecast:updated', () => {
    selectedHourIndex = -1;
    render();
  });
  bus.on('selection:changed', () => {
    selectedHourIndex = -1;
    render();
  });
  bus.on('data:changed', ({ kind } = {}) => {
    if (kind === 'spots' || kind === 'all') render();
  });

  render();
}

export function show() {
  render();
}

function handleAction(ev, el) {
  const act = el.dataset.act;
  if (act === 'pick-spot') openSpotSheet();
  else if (act === 'pick-species') openSpeciesSheet();
  else if (act === 'refresh') {
    refreshForecast({ force: true }).then(() => {
      const meta = state.forecastMeta;
      if (meta?.source === 'network') toast('Previsioni aggiornate.', 'success');
      else if (meta?.source === 'stale') toast(navigator.onLine === false ? 'Senza rete: restano le ultime previsioni salvate.' : 'Aggiornamento non riuscito: restano le ultime previsioni salvate.', 'info');
    });
  } else if (act === 'day') selectDay(Number(el.dataset.day));
  else if (act === 'series') {
    series = el.dataset.series;
    renderChart();
  } else if (act === 'why') openFactorsSheet();
  else if (act === 'plan') openTacticsSheet();
  else if (act === 'table') openHourlySheet();
  else if (act === 'compare') openCompareSheet();
}

// ---------------------------------------------------------------- Disegno

function render() {
  if (!root) return;
  const spot = currentSpot();
  const species = currentSpecies();
  $('[data-slot="spot-name"]', root).textContent = spot?.name || 'Scegli lo spot';
  $('[data-slot="species-name"]', root).textContent = species?.name || 'Scegli la specie';

  const body = $('[data-slot="body"]', root);
  const { forecast, forecastMeta: meta } = state;

  if (state.loading && !forecast) {
    body.innerHTML = skeleton();
    return;
  }
  if (!forecast) {
    body.innerHTML = emptyState(meta);
    return;
  }
  if (isForecastExpired()) {
    body.innerHTML = expiredState(forecast, meta);
    return;
  }

  const dayIndex = Math.min(state.dayIndex, forecast.days.length - 1);
  const day = forecast.days[dayIndex];
  const evaluation = state.evaluations?.[dayIndex] || null;

  body.innerHTML = html`
    ${raw(verdictCard(forecast, day, evaluation, dayIndex, meta))}
    ${raw(safetyNotice(evaluation))}
    ${raw(clockShiftNotice(day))}
    ${raw(dayStrip(forecast, dayIndex))}
    <section class="card fc-chart-card">
      <div class="row-between">
        <h2 class="card-title">Ora per ora</h2>
        <span class="small muted">${day.label}</span>
      </div>
      <div class="chips fc-series" role="group" aria-label="Cosa mostrare nel grafico">
        ${SERIES.map(
          (s) => html`<button type="button" class="chip-btn" data-act="series" data-series="${s.key}" aria-pressed="${s.key === series ? 'true' : 'false'}">${s.label}</button>`
        )}
      </div>
      <div data-slot="chart"></div>
      <p class="small muted fc-hour-detail" data-slot="hour-detail" aria-live="polite"></p>
    </section>
    ${raw(conditionTiles(forecast, day, evaluation, dayIndex))}
    <div class="stack-sm fc-rows">
      ${raw(navRow('why', 'info', evaluation?.score != null ? `Perché ${evaluation.score}` : 'Perché questo giudizio'))}
      ${raw(navRow('plan', 'rod', 'Piano di pesca'))}
      ${raw(navRow('table', 'list', 'Tabella oraria'))}
      ${raw(navRow('compare', 'map-pin', 'Confronta gli spot'))}
    </div>
    ${raw(sunMoonLine(day))}
  `;
  renderChart();
}

function navRow(act, iconName, label) {
  return html`<button type="button" class="nav-row" data-act="${act}">
    <span class="row">${raw(icon(iconName))}<span>${label}</span></span>${raw(icon('chevron-right', { size: 18 }))}
  </button>`;
}

function skeleton() {
  return `
    <div class="card fc-verdict" aria-busy="true">
      <div class="skeleton" style="height:18px;width:40%"></div>
      <div class="skeleton" style="height:96px;width:168px;margin:16px auto"></div>
      <div class="skeleton" style="height:16px;width:80%;margin:0 auto"></div>
      <p class="small muted fc-meta">Scarico le previsioni…</p>
    </div>`;
}

function emptyState(meta) {
  const offline = typeof navigator !== 'undefined' && navigator.onLine === false;
  const text = offline
    ? 'Mi serve la rete per la prima previsione. Il diario e l\'attrezzatura funzionano comunque.'
    : 'Non sono riuscito a scaricare le previsioni. Riprova tra poco.';
  return html`
    <div class="card">
      <div class="empty">
        <div class="empty-icon">${raw(icon(offline ? 'cloud-off' : 'alert', { size: 28 }))}</div>
        <p class="empty-title">${offline ? 'Nessuna connessione' : 'Previsioni non disponibili'}</p>
        <p class="empty-text">${text}</p>
        <button type="button" class="btn btn-primary" data-act="refresh">${raw(icon('refresh', { size: 18 }))} Riprova</button>
      </div>
    </div>`.toString();
}

function expiredState(forecast, meta) {
  const day = forecast.days[0];
  return html`
    <div class="card">
      <div class="empty">
        <div class="empty-icon">${raw(icon('cloud-off', { size: 28 }))}</div>
        <p class="empty-title">Previsioni troppo vecchie</p>
        <p class="empty-text">Le ultime sono di ${fetchedLabel(meta)}: per un punteggio affidabile serve la rete.</p>
        <button type="button" class="btn btn-primary" data-act="refresh">${raw(icon('refresh', { size: 18 }))} Riprova</button>
      </div>
    </div>
    ${raw(day ? sunMoonLine(day) : '')}`.toString();
}

// ---------------------------------------------------------------- Card del verdetto

function verdictCard(forecast, day, evaluation, dayIndex, meta) {
  const species = currentSpecies();
  const hasScore = evaluation && Number.isFinite(evaluation.score);
  const key = evaluation?.verdict?.key || 'nd';
  const ref = referenceHour(forecast, day, evaluation, dayIndex);
  const wx = ref.hour && Number.isFinite(ref.hour.weatherCode) ? weatherLabel(ref.hour.weatherCode) : null;
  const windowLabel = evaluation?.bestWindow?.label;

  let headline = evaluation?.headline || '';
  if (!evaluation) headline = 'Punteggio non disponibile per questa giornata.';

  const better = betterDay(dayIndex);
  const confidence =
    evaluation && evaluation.confidence !== 'alta' && hasScore
      ? `Affidabilità ${evaluation.confidence}: le previsioni lontane cambiano spesso.`
      : '';

  return html`
    <section class="card fc-verdict v-${key}" aria-live="polite">
      <div class="row-between">
        <span class="label">${day.label} · ${species.name}</span>
        <span class="row small muted">
          ${wx ? raw(icon(wx.icon, { size: 18 })) : ''}
          ${ref.hour && Number.isFinite(ref.hour.airTempC) ? html`<span class="num">${Math.round(ref.hour.airTempC)}°</span>` : ''}
          <button type="button" class="btn-icon fc-refresh ${state.loading ? 'is-loading' : ''}" data-act="refresh" aria-label="Aggiorna le previsioni">${raw(icon('refresh', { size: 18 }))}</button>
        </span>
      </div>
      <div class="fc-score-wrap">
        ${raw(scoreArc(hasScore ? evaluation.score : null))}
        <div class="fc-score num">${hasScore ? evaluation.score : '--'}</div>
      </div>
      <div class="fc-verdict-line">
        <span class="badge">${evaluation?.verdict?.label || 'Non disponibile'}</span>
        ${windowLabel ? html`<span class="fc-window">${raw(icon('clock', { size: 16 }))} ${windowLabel}</span>` : ''}
      </div>
      <p class="fc-headline">${headline}</p>
      ${
        better
          ? html`<button type="button" class="fc-better" data-act="day" data-day="${better.dayIndex}">
              ${raw(icon('calendar', { size: 16 }))}
              <span>Meglio ${better.label}: <strong class="num">${better.score}</strong>${better.window ? `, ${better.window}` : ''}</span>
              ${raw(icon('chevron-right', { size: 16 }))}
            </button>`
          : ''
      }
      ${confidence ? html`<p class="small muted fc-meta">${confidence}</p>` : ''}
      <p class="small muted fc-meta">${metaLine(meta, evaluation)}</p>
    </section>`.toString();
}

/** Un giorno nettamente migliore di quello selezionato, se c'è. */
function betterDay(dayIndex) {
  const evals = state.evaluations;
  const days = state.forecast?.days;
  if (!evals || !days) return null;
  const current = evals[dayIndex];
  const base = Number.isFinite(current?.score) ? current.score : 0;
  let best = null;
  evals.forEach((ev, i) => {
    if (i === dayIndex || !Number.isFinite(ev?.score) || ev.verdict?.key === 'pericolo') return;
    if (ev.score >= 55 && ev.score >= base + 12 && (!best || ev.score > best.score)) {
      best = { dayIndex: i, score: ev.score, label: days[i].label.toLowerCase(), window: ev.bestWindow?.label || '' };
    }
  });
  return best;
}

function fetchedLabel(meta) {
  if (!meta?.fetchedAt) return 'data sconosciuta';
  const d = new Date(meta.fetchedAt);
  const time = d.toLocaleTimeString('it-IT', { hour: '2-digit', minute: '2-digit' });
  const today = new Date();
  const dayDiff = Math.round((new Date(today.getFullYear(), today.getMonth(), today.getDate()) - new Date(d.getFullYear(), d.getMonth(), d.getDate())) / 86400000);
  if (dayDiff === 0) return `oggi alle ${time}`;
  if (dayDiff === 1) return `ieri alle ${time}`;
  return `${d.toLocaleDateString('it-IT', { day: 'numeric', month: 'long' })} alle ${time}`;
}

function metaLine(meta, evaluation) {
  const parts = [];
  if (!meta) return '';
  if (meta.source === 'stale') {
    const offline = typeof navigator !== 'undefined' && navigator.onLine === false;
    parts.push(offline ? `Senza rete: previsioni di ${fetchedLabel(meta)}.` : `Aggiornamento non riuscito: restano le previsioni di ${fetchedLabel(meta)}.`);
  }
  else parts.push(`Dati Open-Meteo, aggiornati ${fetchedLabel(meta)}.`);
  if (evaluation?.missing?.length) parts.push(`Mancano: ${evaluation.missing.join(', ')}.`);
  parts.push('Il punteggio è una stima.');
  return parts.join(' ');
}

/**
 * Nei giorni a cavallo del cambio dell'ora le previsioni usano l'ora di oggi anche per i giorni
 * dopo il cambio: gli orari scritti restano un'ora indietro (o avanti) rispetto all'orologio.
 */
function clockShiftNotice(day) {
  const shift = day?.clockShift;
  if (!shift || !Number.isFinite(shift.hours) || shift.hours === 0) return '';
  const n = Math.abs(shift.hours);
  const amount = n === 1 ? "un'ora" : `${n} ore`;
  const direction = shift.hours > 0 ? 'avanti' : 'indietro';
  const when = shift.fromTime ? `dalle ${shift.fromTime}` : 'in questa giornata';
  return html`
    <div class="notice notice-info fc-safety" role="status">
      ${raw(icon('clock'))}
      <p><strong>Cambio dell'ora.</strong> Le previsioni usano ancora l'ora di oggi: ${when} il tuo orologio sarà ${amount} ${direction} rispetto agli orari scritti qui.</p>
    </div>`.toString();
}

function safetyNotice(evaluation) {
  const safety = evaluation?.safety;
  if (!safety || safety.level === 'ok') return '';
  const level = safety.level === 'danger' ? 'danger' : 'warn';
  // Il testo principale nomina già il primo intervallo pericoloso: sotto si elencano solo gli altri
  const all = safety.alerts || [];
  const firstDanger = level === 'danger' ? all.find((a) => a.level === 'danger') : null;
  const alerts = all.filter((a) => a !== firstDanger).slice(0, 3);
  const showTimes = alerts.length > 0 && (level === 'danger' || all.length > 1 || Boolean(evaluation.bestWindow));
  return html`
    <div class="notice notice-${level} fc-safety" role="${level === 'danger' ? 'alert' : 'status'}">
      ${raw(icon('alert'))}
      <div class="stack-sm">
        ${safety.text ? html`<p><strong>${safety.text}</strong></p>` : ''}
        ${showTimes ? alerts.map((a) => html`<p>Dalle ${a.fromTime} alle ${a.toTime}: ${a.text.charAt(0).toLowerCase() + a.text.slice(1)}.</p>`) : ''}
        ${level === 'danger' ? html`<p>Emergenze in mare: <a href="tel:1530">1530</a>. Avvisi ufficiali: <a href="${LINKS.meteoam}" target="_blank" rel="noopener">MeteoAM</a>.</p>` : ''}
      </div>
    </div>`.toString();
}

// ---------------------------------------------------------------- Sette giorni

function dayStrip(forecast, dayIndex) {
  const evals = state.evaluations || [];
  return html`
    <div class="fc-days" role="group" aria-label="Giornate">
      ${forecast.days.map((d, i) => {
        const ev = evals[i];
        const key = ev?.verdict?.key || 'nd';
        const score = Number.isFinite(ev?.score) ? ev.score : '--';
        // Finestra buona ma ore pericolose nel resto della giornata: va visto anche da qui
        const partDanger = ev?.safety?.level === 'danger' && key !== 'pericolo';
        return html`<button type="button" class="fc-day v-${key}" data-act="day" data-day="${i}" aria-pressed="${i === dayIndex ? 'true' : 'false'}" aria-label="${d.label}: ${ev?.verdict?.label || 'non disponibile'}${Number.isFinite(ev?.score) ? `, ${ev.score}` : ''}${partDanger ? ', con ore pericolose' : ''}">
          <span class="fc-day-name">${d.labelShort}</span>
          <span class="fc-day-score num">${score}</span>
          <span class="fc-day-marks"><span class="dot"></span>${partDanger ? html`<span class="fc-day-alert">${raw(icon('alert', { size: 12 }))}</span>` : ''}</span>
        </button>`;
      })}
    </div>`.toString();
}

// ---------------------------------------------------------------- Grafico orario

function renderChart() {
  const host = $('[data-slot="chart"]', root);
  const forecast = state.forecast;
  if (!host || !forecast) return;
  const dayIndex = Math.min(state.dayIndex, forecast.days.length - 1);
  const day = forecast.days[dayIndex];
  const evaluation = state.evaluations?.[dayIndex];
  const scoreByIndex = new Map((evaluation?.hourly || []).map((h) => [h.index, h]));

  $$('[data-act="series"]', root).forEach((b) => b.setAttribute('aria-pressed', b.dataset.series === series ? 'true' : 'false'));

  const items = [];
  for (let i = day.startIndex; i < day.endIndex; i++) {
    const hour = forecast.hours[i];
    const scored = scoreByIndex.get(i);
    let value = null;
    let cls = 'v-nd';
    if (series === 'score') {
      value = Number.isFinite(scored?.score) ? scored.score : null;
      cls = `v-${hourVerdictKey(scored)}`;
    } else if (series === 'wave') value = hour.waveM;
    else if (series === 'wind') value = hour.windKmh;
    else if (series === 'tide') value = Number.isFinite(hour.seaLevelM) ? hour.seaLevelM * 100 : null;
    items.push({ label: hour.time.slice(11, 13), value, cls, band: hour.light, index: i });
  }

  const win = evaluation?.bestWindow;
  const opts = {
    kind: series === 'score' ? 'bars' : 'line',
    nowPos: forecast.nowIndex >= day.startIndex && forecast.nowIndex < day.endIndex ? forecast.nowIndex - day.startIndex : -1,
    selectedPos: selectedHourIndex >= day.startIndex && selectedHourIndex < day.endIndex ? selectedHourIndex - day.startIndex : -1,
    window: win && series === 'score' ? [win.startIndex - day.startIndex, win.endIndex - 1 - day.startIndex] : null
  };
  if (series === 'score') Object.assign(opts, { min: 0, max: 100 });
  if (series === 'wave') Object.assign(opts, { min: 0, unit: 'm', decimals: 1 });
  if (series === 'wind') Object.assign(opts, { min: 0, unit: 'km/h', decimals: 0 });
  if (series === 'tide') Object.assign(opts, { unit: 'cm', decimals: 0 });

  const hasData = items.some((it) => it.value !== null);
  host.innerHTML = hasData
    ? hourChart(items, opts)
    : `<p class="small muted fc-chart-empty">${series === 'tide' ? 'Livello del mare non disponibile per questo spot.' : 'Dato non disponibile.'}</p>`;

  const detail = $('[data-slot="hour-detail"]', root);
  if (detail) detail.textContent = hourDetailText(forecast, scoreByIndex, win);
}

function hourVerdictKey(scored) {
  if (!scored || !Number.isFinite(scored.score)) return 'nd';
  if (scored.safety === 'danger') return 'pericolo';
  if (scored.score >= 75) return 'ottimo';
  if (scored.score >= 60) return 'buono';
  if (scored.score >= 45) return 'discreto';
  return 'difficile';
}

function hourDetailText(forecast, scoreByIndex, win) {
  if (selectedHourIndex < 0) {
    if (series === 'score' && win) return `La staffa segna la finestra migliore, ${win.startTime}-${win.endTime}. Tocca una barra per i dettagli.`;
    if (series === 'tide') return 'Livello del mare da modello, in centimetri. Serve a leggere il giro di marea, non per la navigazione.';
    return 'Tocca il grafico per i dettagli di un\'ora.';
  }
  const h = forecast.hours[selectedHourIndex];
  if (!h) return '';
  const scored = scoreByIndex.get(selectedHourIndex);
  const parts = [`Ore ${h.time.slice(11, 16)}`];
  if (Number.isFinite(scored?.score)) parts.push(`punteggio ${scored.score}`);
  if (Number.isFinite(h.waveM)) parts.push(`onda ${fmtNum(h.waveM, 1)} m${Number.isFinite(h.wavePeriodS) ? `, ${fmtNum(h.wavePeriodS, 0)} s` : ''}`);
  if (Number.isFinite(h.windKmh)) parts.push(`vento ${Math.round(h.windKmh)} km/h${Number.isFinite(h.windDirDeg) ? ` ${windName(h.windDirDeg).name}` : ''}`);
  if (Number.isFinite(h.seaTempC)) parts.push(`acqua ${fmtNum(h.seaTempC, 1)}°`);
  if (LIGHT_LABEL[h.light]) parts.push(LIGHT_LABEL[h.light]);
  if (scored?.safety === 'danger') parts.push('condizioni pericolose');
  return parts.join(' · ');
}

// ---------------------------------------------------------------- Condizioni

/** Ora di riferimento per i riquadri: adesso per oggi, l'inizio della finestra migliore per gli altri giorni. */
function referenceHour(forecast, day, evaluation, dayIndex) {
  const { hours, nowIndex } = forecast;
  if (dayIndex === 0 && nowIndex >= day.startIndex && nowIndex < day.endIndex) {
    return { hour: hours[nowIndex], index: nowIndex, label: 'Adesso' };
  }
  if (evaluation?.bestWindow) {
    const i = evaluation.bestWindow.startIndex;
    return { hour: hours[i], index: i, label: `Alle ${evaluation.bestWindow.startTime}` };
  }
  const i = Math.min(day.endIndex - 1, day.startIndex + 7);
  return { hour: hours[i], index: i, label: hours[i] ? `Alle ${hours[i].time.slice(11, 16)}` : '' };
}

function tile(iconName, label, value, sub, extra = '') {
  return html`<div class="tile">
    <div class="tile-label">${raw(icon(iconName, { size: 14 }))}<span>${label}</span>${raw(extra)}</div>
    <div class="tile-value">${value}</div>
    <div class="tile-sub">${sub}</div>
  </div>`;
}

function conditionTiles(forecast, day, evaluation, dayIndex) {
  const ref = referenceHour(forecast, day, evaluation, dayIndex);
  const h = ref.hour;
  if (!h) return '';

  const waveValue = Number.isFinite(h.waveM) ? `${fmtNum(h.waveM, 1)} m` : 'n.d.';
  const waveSub = Number.isFinite(h.waveM)
    ? [Number.isFinite(h.wavePeriodS) ? `${fmtNum(h.wavePeriodS, 0)} s` : null, seaStateLabel(Math.round(h.waveM * 10) / 10), PHASE_LABEL[h.seaPhase] && h.seaPhase !== 'stabile' ? PHASE_LABEL[h.seaPhase] : null]
        .filter(Boolean)
        .join(' · ')
    : 'dato del mare assente';

  const wn = Number.isFinite(h.windDirDeg) ? windName(h.windDirDeg) : null;
  const windValue = Number.isFinite(h.windKmh) ? `${Math.round(h.windKmh)} km/h` : 'n.d.';
  const windSub = [wn ? wn.name : null, INCIDENCE_LABEL[h.windIncidence] || null, Number.isFinite(h.gustKmh) && h.gustKmh >= (h.windKmh || 0) + 10 ? `raffiche ${Math.round(h.gustKmh)}` : null]
    .filter(Boolean)
    .join(' · ');

  const nextTides = (day.tides || []).filter((t) => t.epochMs >= h.epochMs).slice(0, 2);
  const tideName = (t) => (t.type === 'high' ? 'alta' : 'bassa');
  const tideValue = nextTides[0] ? nextTides[0].time : 'n.d.';
  const tideSub = nextTides[0]
    ? `${tideName(nextTides[0])} marea${nextTides[1] ? ` · poi ${tideName(nextTides[1])} ${nextTides[1].time}` : ` · ${tideRange(day)}`}`
    : (day.tides || []).length
      ? 'giri di marea già passati'
      : 'livello non disponibile';

  const trend = h.pressureTrend3h;
  const trendText = !Number.isFinite(trend)
    ? 'tendenza n.d.'
    : trend <= -1
      ? `in calo, ${fmtNum(trend, 1)} in 3 ore`
      : trend >= 1
        ? `in aumento, +${fmtNum(trend, 1)} in 3 ore`
        : 'stabile';

  const moon = day.moon || {};
  // Tra sorgere e tramonto si mostra il primo che deve ancora venire rispetto all'ora guardata
  const moonEvents = [
    moon.rise?.time ? { word: 'sorge', ...moon.rise } : null,
    moon.set?.time ? { word: 'tramonta', ...moon.set } : null
  ]
    .filter(Boolean)
    .sort((a, b) => (a.epochMs || 0) - (b.epochMs || 0));
  const moonNext = moonEvents.find((e) => Number.isFinite(e.epochMs) && e.epochMs >= h.epochMs) || null;
  const moonSub = [moon.phaseName ? moon.phaseName.toLowerCase() : null, moonNext ? `${moonNext.word} ${moonNext.time}` : null].filter(Boolean).join(' · ');

  return html`
    <div class="row-between fc-tiles-head">
      <h2 class="section-title">Condizioni</h2>
      <span class="small muted">${ref.label}</span>
    </div>
    <div class="tiles fc-tiles">
      ${tile('wave', 'Onda', waveValue, waveSub)}
      ${tile('wind', 'Vento', windValue, windSub || 'direzione n.d.', directionArrow(h.windDirDeg, { size: 16 }))}
      ${tile('tide', 'Marea', tideValue, tideSub)}
      ${tile('gauge', 'Pressione', Number.isFinite(h.pressureHpa) ? `${Math.round(h.pressureHpa)} hPa` : 'n.d.', trendText)}
      ${tile('thermometer', 'Acqua', Number.isFinite(h.seaTempC) ? `${fmtNum(h.seaTempC, 1)} °C` : 'n.d.', Number.isFinite(h.airTempC) ? `aria ${Math.round(h.airTempC)} °C` : 'temperatura del mare')}
      ${tile('moon', 'Luna', Number.isFinite(moon.illuminationPct) ? `${Math.round(moon.illuminationPct)}%` : 'n.d.', moonSub || 'fase n.d.')}
    </div>`.toString();
}

function tideRange(day) {
  const levels = (day.tides || []).map((t) => t.levelM).filter(Number.isFinite);
  if (levels.length < 2) return 'escursione minima';
  return `escursione ${Math.round((Math.max(...levels) - Math.min(...levels)) * 100)} cm`;
}

function sunMoonLine(day) {
  const sun = day.sun || {};
  const moon = day.moon || {};
  const bits = [
    sun.sunrise?.time ? html`<span class="row">${raw(icon('sunrise', { size: 16 }))} ${sun.sunrise.time}</span>` : '',
    sun.sunset?.time ? html`<span class="row">${raw(icon('sunset', { size: 16 }))} ${sun.sunset.time}</span>` : '',
    moon.phaseName ? html`<span class="row">${raw(icon('moon', { size: 16 }))} ${moon.phaseName}${moon.set?.time ? `, tramonta ${moon.set.time}` : ''}</span>` : ''
  ];
  return html`<div class="fc-sun small muted">${bits}</div>`.toString();
}

// ---------------------------------------------------------------- Sheet: specie

function openSpeciesSheet() {
  const body = document.createElement('div');
  body.className = 'list';
  body.setAttribute('role', 'radiogroup');
  body.innerHTML = SPECIES.map(
    (sp) => html`<button type="button" class="fc-option" role="radio" aria-checked="${sp.id === state.speciesId ? 'true' : 'false'}" data-species="${sp.id}">
      <span class="fc-code">${sp.short}</span>
      <span class="grow">
        <span class="item-title">${sp.name}</span>
        <span class="item-sub">${sp.summary}</span>
        <span class="item-sub">${Number.isFinite(sp.minLegalSizeCm) ? `Taglia minima ${sp.minLegalSizeCm} cm` : 'Nessuna taglia minima specifica'}</span>
      </span>
      ${sp.id === state.speciesId ? raw(icon('check')) : ''}
    </button>`
  ).join('');
  const sheet = openSheet({ title: 'Cosa cerchi', body });
  on(body, 'click', '[data-species]', (ev, el) => {
    selectSpecies(el.dataset.species);
    sheet.close();
  });
}

// ---------------------------------------------------------------- Sheet: perché

function openFactorsSheet() {
  const forecast = state.forecast;
  const evaluation = state.evaluations?.[state.dayIndex];
  if (!forecast || !evaluation) {
    toast('Punteggio non disponibile per questa giornata.', 'info');
    return;
  }
  const species = currentSpecies();
  const win = evaluation.bestWindow;
  const known = (evaluation.factors || []).filter((f) => Number.isFinite(f.value));
  const unknown = (evaluation.factors || []).filter((f) => !Number.isFinite(f.value));
  const article = withArticle(species);
  const intro = win
    ? `Vale per la finestra migliore, ${win.label}. Ogni barra dice quanto quella condizione è vicina all'ideale per ${article}.`
    : `Ogni barra dice quanto quella condizione è vicina all'ideale per ${article}.`;

  const body = html`
    <div class="stack">
      <p class="small muted">${intro}</p>
      ${known.map(
        (f) => html`<div class="fc-factor fc-factor-${f.impact}">
          <div class="row-between">
            <span class="item-title">${f.label}</span>
            <span class="num small muted">pesa ${Math.round(f.weight * 100)}%</span>
          </div>
          <div class="meter"><span style="width:${Math.max(3, Math.min(100, Math.round(f.value * 100)))}%"></span></div>
          <p class="small">${f.title}</p>
          <p class="small muted">${f.detail}</p>
        </div>`
      )}
      ${unknown.length ? html`<p class="small muted">Non disponibili: ${unknown.map((f) => f.label.toLowerCase()).join(', ')}. Il loro peso passa agli altri.</p>` : ''}
      ${evaluation.safety?.level !== 'ok' && evaluation.safety?.text ? html`<div class="notice notice-${evaluation.safety.level === 'danger' ? 'danger' : 'warn'}">${raw(icon('alert'))}<p>${evaluation.safety.text} La sicurezza limita il punteggio a prescindere dal resto.</p></div>` : ''}
      <p class="small muted">Mare, stagione, luce e acqua contano più del loro peso: se uno è lontano dall'ideale abbassa tutto il punteggio, perché senza quelle condizioni il pesce di solito non c'è. Luna e marea pesano poco perché le prove sono deboli.</p>
      <p class="small muted">È una stima costruita sulle abitudini note della specie. Il tuo diario, col tempo, vale di più.</p>
    </div>`;
  openSheet({ title: Number.isFinite(evaluation.score) ? `Perché ${evaluation.score}` : 'Perché questo giudizio', body });
}

// ---------------------------------------------------------------- Sheet: piano di pesca

function openTacticsSheet() {
  const forecast = state.forecast;
  const evaluation = state.evaluations?.[state.dayIndex];
  if (!forecast || !evaluation) {
    toast('Servono le previsioni per preparare il piano.', 'info');
    return;
  }
  const gear = listGear();
  let t;
  try {
    t = buildTactics({ evaluation, forecast, species: currentSpecies(), spot: currentSpot(), gear, baits: listBaits() });
  } catch (err) {
    console.error('Piano di pesca non calcolato:', err);
    toast('Non riesco a preparare il piano.', 'error');
    return;
  }

  const rodsOk = t.rods?.ok || [];
  const rodsOver = t.rods?.overloaded || [];
  const rodsUnder = t.rods?.underloaded || [];
  const hasRods = rodsOk.length + rodsOver.length + rodsUnder.length > 0;
  // Canne registrate ma non valutabili: in manutenzione o senza grammi di lancio
  const ownsRods = gear.some((g) => g.category === 'canna_surf' || g.category === 'canna_fondo');
  const block = (iconName, title, content) => html`<section class="fc-plan-block">
    <h3 class="row">${raw(icon(iconName, { size: 18 }))}<span>${title}</span></h3>
    ${content}
  </section>`;

  const body = html`
    <div class="stack">
      ${evaluation.safety?.level === 'danger' ? html`<div class="notice notice-danger">${raw(icon('alert'))}<p>${evaluation.safety.text}</p></div>` : ''}
      ${block('clock', 'Quando', html`<p class="small">${t.when}</p>`)}
      ${block(
        'scale',
        'Piombo e canna',
        html`<p class="small">${t.lead?.grams ? `Piombo da ${t.lead.grams} g${t.lead.shape ? `, ${t.lead.shape}` : ''}.` : 'Piombo: dato del mare assente.'}</p>
          ${
            hasRods
              ? html`<div class="row row-wrap">
                  ${rodsOk.map((r) => html`<span class="chip chip-ok">${raw(icon('check', { size: 14 }))}${r.name}</span>`)}
                  ${rodsOver.map((r) => html`<span class="chip chip-warn">${r.name}: troppo leggera</span>`)}
                  ${rodsUnder.map((r) => html`<span class="chip chip-off">${r.name}: troppo potente, si carica poco</span>`)}
                </div>
                ${rodsOk.length ? '' : html`<p class="small muted">Nessuna delle tue canne lavora bene con questo piombo più l'esca.</p>`}`
              : ownsRods
                ? html`<p class="small muted">Le tue canne sono in manutenzione o senza grammi di lancio: completa i dati in Attrezzatura.</p>`
                : html`<p class="small muted">Aggiungi le tue canne in Attrezzatura e ti dico quale regge questo piombo.</p>`
          }`
      )}
      ${block('rod', 'Terminale', html`<p class="small">${t.rig}</p>`)}
      ${block(
        'fish',
        'Esche',
        html`<div class="row row-wrap">
          ${(t.baits || []).map((b) => html`<span class="chip ${b.have ? 'chip-ok' : 'chip-off'}">${b.have ? raw(icon('check', { size: 14 })) : ''}${b.name}</span>`)}
        </div>
        <p class="small muted">Con il segno di spunta quelle che hai già in Attrezzatura.</p>`
      )}
      ${block('map-pin', 'Dove lanciare', html`<p class="small">${t.where}</p>`)}
    </div>`;
  openSheet({ title: 'Piano di pesca', body });
}

// ---------------------------------------------------------------- Sheet: tabella oraria

function openHourlySheet() {
  const forecast = state.forecast;
  if (!forecast) return;
  const dayIndex = Math.min(state.dayIndex, forecast.days.length - 1);
  const day = forecast.days[dayIndex];
  const scoreByIndex = new Map((state.evaluations?.[dayIndex]?.hourly || []).map((h) => [h.index, h]));
  const rows = [];
  for (let i = day.startIndex; i < day.endIndex; i++) {
    const h = forecast.hours[i];
    const s = scoreByIndex.get(i);
    rows.push(html`<tr class="${i === forecast.nowIndex ? 'is-now' : ''}">
      <td>${h.time.slice(11, 16)}</td>
      <td><span class="row"><span class="dot v-${hourVerdictKey(s)}"></span>${Number.isFinite(s?.score) ? s.score : 'n.d.'}</span></td>
      <td>${fmtNum(h.waveM, 1)}</td>
      <td>${fmtNum(h.wavePeriodS, 0)}</td>
      <td>${Number.isFinite(h.windKmh) ? Math.round(h.windKmh) : 'n.d.'}${Number.isFinite(h.windDirDeg) ? ` ${windName(h.windDirDeg).cardinal}` : ''}</td>
      <td>${Number.isFinite(h.gustKmh) ? Math.round(h.gustKmh) : 'n.d.'}</td>
      <td>${Number.isFinite(h.pressureHpa) ? Math.round(h.pressureHpa) : 'n.d.'}</td>
    </tr>`);
  }
  const body = html`
    <div class="table-wrap">
      <table class="table fc-hourly-table">
        <thead><tr><th>Ora</th><th>Punti</th><th>Onda m</th><th>Per. s</th><th>Vento km/h</th><th>Raff.</th><th>hPa</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </div>`;
  openSheet({ title: `Tabella oraria · ${day.label}`, body, wide: true });
}

// ---------------------------------------------------------------- Sheet: confronto tra spot

async function openCompareSheet() {
  const forecast = state.forecast;
  const day = forecast?.days?.[Math.min(state.dayIndex, (forecast?.days?.length || 1) - 1)];
  const species = currentSpecies();
  const body = document.createElement('div');
  body.className = 'stack';
  body.innerHTML = `<div class="row"><span class="spinner"></span><span class="small muted">Confronto gli spot…</span></div>`;
  const sheet = openSheet({ title: day ? `Dove conviene · ${day.label}` : 'Dove conviene', body });

  try {
    const spots = listSpots().slice(0, CACHE.maxSpots);
    const results = await loadForecasts(spots);
    const rowsData = spots
      .map((spot) => {
        const res = results.get(spot.id);
        if (!res?.forecast) return { spot, ev: null };
        const evals = evaluateForecast(res.forecast, species);
        const idx = day ? res.forecast.days.findIndex((d) => d.date === day.date) : 0;
        return { spot, ev: idx >= 0 ? evals[idx] : null };
      })
      .sort((a, b) => (Number.isFinite(b.ev?.score) ? b.ev.score : -1) - (Number.isFinite(a.ev?.score) ? a.ev.score : -1));

    body.innerHTML = html`
      <p class="small muted">Stessa giornata e stessa specie (${species.name.toLowerCase()}), spot per spot. Tocca uno spot per sceglierlo.</p>
      <div class="list">
        ${rowsData.map(
          ({ spot, ev }) => html`<button type="button" class="fc-option v-${ev?.verdict?.key || 'nd'}" data-spot="${spot.id}">
            <span class="fc-rank num v-text">${Number.isFinite(ev?.score) ? ev.score : '--'}</span>
            <span class="grow">
              <span class="item-title">${spot.name}</span>
              <span class="item-sub">${ev?.verdict?.label || 'Previsione non disponibile'}${ev?.bestWindow?.label ? ` · ${ev.bestWindow.label}` : ''}${ev?.safety?.level === 'danger' && ev?.verdict?.key !== 'pericolo' ? ' · pericolo in altre ore' : ''}</span>
            </span>
            ${spot.id === state.spotId ? raw(icon('check')) : raw(icon('chevron-right', { size: 18 }))}
          </button>`
        )}
      </div>`.toString();

    on(body, 'click', '[data-spot]', (ev, el) => {
      sheet.close();
      if (el.dataset.spot !== state.spotId) selectSpot(el.dataset.spot);
    });
  } catch (err) {
    console.error('Confronto tra spot non riuscito:', err);
    body.innerHTML = `<div class="notice notice-warn">${icon('alert')}<p>Non riesco a confrontare gli spot adesso. Serve la rete.</p></div>`;
  }
}
