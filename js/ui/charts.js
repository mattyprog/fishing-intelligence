/**
 * Grafici SVG senza librerie. Restituiscono stringhe SVG già sicure (solo numeri e classi note).
 * I colori arrivano dalle variabili CSS, così seguono il tema.
 */

const W = 360;
const PAD_L = 4;
const PAD_R = 4;
const PAD_T = 14;
const LABEL_H = 16;

const BAND_OPACITY = { night: 1, dawn: 0.5, dusk: 0.5, day: 0 };

function num(v, d = 1) {
  return Number(v.toFixed(d));
}

/**
 * Grafico orario a barre (punteggio) o a linea (onda, vento, marea).
 * items: [{ label, value (numero o null), cls (classe verdetto, solo barre), band, index }]
 * opts: { kind: 'bars'|'line', height, min, max, window: [da, a] posizioni incluse,
 *         nowPos, selectedPos, unit, decimals }
 */
export function hourChart(items, opts = {}) {
  const {
    kind = 'bars',
    height = 132,
    window: win = null,
    nowPos = -1,
    selectedPos = -1,
    unit = '',
    decimals = 1
  } = opts;

  const n = items.length;
  if (!n) return '';
  const plotW = W - PAD_L - PAD_R;
  const plotH = height - PAD_T - LABEL_H;
  const step = plotW / n;
  const baseY = PAD_T + plotH;

  const values = items.map((it) => (Number.isFinite(it.value) ? it.value : null));
  const present = values.filter((v) => v !== null);
  let min = Number.isFinite(opts.min) ? opts.min : present.length ? Math.min(...present) : 0;
  let max = Number.isFinite(opts.max) ? opts.max : present.length ? Math.max(...present) : 1;
  if (max - min < 1e-6) {
    max += 0.5;
    min -= 0.5;
  }
  const yOf = (v) => baseY - ((v - min) / (max - min)) * plotH;
  const xOf = (i) => PAD_L + i * step;

  let out = `<svg class="chart chart-${kind}" viewBox="0 0 ${W} ${height}" role="img" aria-hidden="true" preserveAspectRatio="xMidYMid meet">`;

  // Fasce di buio: notte piena, alba e tramonto più leggeri
  items.forEach((it, i) => {
    const op = BAND_OPACITY[it.band] ?? 0;
    if (op > 0) {
      out += `<rect class="chart-night" x="${num(xOf(i))}" y="${PAD_T}" width="${num(step + 0.3)}" height="${plotH}" opacity="${op}"/>`;
    }
  });

  out += `<line class="chart-axis" x1="${PAD_L}" y1="${baseY}" x2="${W - PAD_R}" y2="${baseY}"/>`;

  if (kind === 'bars') {
    const bw = Math.max(2, step - 2.5);
    items.forEach((it, i) => {
      const v = values[i];
      if (v === null) {
        out += `<rect class="chart-bar-empty" x="${num(xOf(i) + (step - bw) / 2)}" y="${num(baseY - 3)}" width="${num(bw)}" height="3" rx="1.5"/>`;
        return;
      }
      const h = Math.max(3, ((v - min) / (max - min)) * plotH);
      const dim = nowPos >= 0 && i < nowPos ? ' is-past' : '';
      out += `<rect class="chart-bar ${it.cls || 'v-nd'}${dim}" x="${num(xOf(i) + (step - bw) / 2)}" y="${num(baseY - h)}" width="${num(bw)}" height="${num(h)}" rx="2"/>`;
    });
  } else {
    // Linea spezzata nei punti senza dato, con area sotto
    let segment = [];
    const flush = () => {
      if (segment.length > 1) {
        const pts = segment.map(([x, y]) => `${num(x)},${num(y)}`).join(' ');
        const first = segment[0];
        const last = segment[segment.length - 1];
        out += `<polygon class="chart-area" points="${num(first[0])},${baseY} ${pts} ${num(last[0])},${baseY}"/>`;
        out += `<polyline class="chart-line" points="${pts}"/>`;
      } else if (segment.length === 1) {
        out += `<circle class="chart-dot" cx="${num(segment[0][0])}" cy="${num(segment[0][1])}" r="2"/>`;
      }
      segment = [];
    };
    values.forEach((v, i) => {
      if (v === null) flush();
      else segment.push([xOf(i) + step / 2, yOf(v)]);
    });
    flush();

    if (present.length) {
      const iMax = values.indexOf(Math.max(...present));
      const iMin = values.indexOf(Math.min(...present));
      const lab = (i, above) => {
        const x = Math.min(W - 26, Math.max(26, xOf(i) + step / 2));
        const y = above ? Math.max(10, yOf(values[i]) - 5) : Math.min(baseY - 3, yOf(values[i]) + 12);
        return `<text class="chart-value" x="${num(x)}" y="${num(y)}" text-anchor="middle">${values[i].toFixed(decimals)}${unit ? ' ' + unit : ''}</text>`;
      };
      out += lab(iMax, true);
      if (iMin !== iMax && values[iMax] - values[iMin] > (max - min) * 0.25) out += lab(iMin, false);
    }
  }

  // Finestra migliore: una staffa sopra le barre
  if (win && win[0] >= 0 && win[1] >= win[0]) {
    const x1 = xOf(win[0]) + 1;
    const x2 = xOf(win[1] + 1) - 1;
    out += `<path class="chart-window" d="M${num(x1)} ${PAD_T - 3}v-5h${num(x2 - x1)}v5"/>`;
  }

  if (nowPos >= 0 && nowPos < n) {
    const x = xOf(nowPos) + step / 2;
    out += `<line class="chart-now" x1="${num(x)}" y1="${PAD_T - 2}" x2="${num(x)}" y2="${baseY}"/>`;
  }

  if (selectedPos >= 0 && selectedPos < n) {
    out += `<rect class="chart-selected" x="${num(xOf(selectedPos))}" y="${PAD_T}" width="${num(step)}" height="${plotH}" rx="2"/>`;
  }

  // Etichette delle ore: una ogni tre
  items.forEach((it, i) => {
    if (i % 3 === 0) {
      out += `<text class="chart-label" x="${num(xOf(i) + step / 2)}" y="${height - 3}" text-anchor="middle">${String(it.label).replace(/[^0-9:]/g, '')}</text>`;
    }
  });

  // Bersagli per il tocco, una colonna per ora
  items.forEach((it, i) => {
    out += `<rect class="chart-hit" data-pos="${i}" x="${num(xOf(i))}" y="0" width="${num(step)}" height="${height}"/>`;
  });

  return out + '</svg>';
}

/** Arco del punteggio: mezzo anello che si riempie in proporzione. */
export function scoreArc(score, { size = 168 } = {}) {
  const r = 70;
  const cx = 84;
  const cy = 84;
  const len = Math.PI * r;
  const pct = Number.isFinite(score) ? Math.max(0, Math.min(100, score)) / 100 : 0;
  const d = `M${cx - r} ${cy}A${r} ${r} 0 0 1 ${cx + r} ${cy}`;
  return `<svg class="arc" viewBox="0 0 168 96" width="${size}" aria-hidden="true">
    <path class="arc-track" d="${d}"/>
    <path class="arc-fill" d="${d}" stroke-dasharray="${num(len * pct, 2)} ${num(len, 2)}"/>
  </svg>`;
}

/** Freccia orientata: indica la direzione verso cui va il vento o l'onda (provenienza + 180 gradi). */
export function directionArrow(fromDeg, { size = 18 } = {}) {
  if (!Number.isFinite(fromDeg)) return '';
  const rot = (fromDeg + 180) % 360;
  return `<svg class="icon dir-arrow" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" style="transform:rotate(${num(rot, 0)}deg)"><path d="M12 20V5M6 11l6-6 6 6"/></svg>`;
}
