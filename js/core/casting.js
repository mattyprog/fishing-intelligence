/**
 * Carico di lancio: piombo più esca rispetto al potere di lancio della canna, e shock leader.
 * Modulo puro.
 */

const isNum = (v) => typeof v === 'number' && Number.isFinite(v);

// Peso di un innesco medio (regola pratica, non una misura). È il valore da cui parte il calcolo
// in Attrezzatura e quello che il piano di pesca somma al piombo: un numero solo, così le due
// viste giudicano una canna allo stesso modo finché l'utente non sceglie un altro innesco.
// 15 e non meno: con il piombo da 85 g del mare calmo una canna da 100-200 g resta nel suo campo.
export const TYPICAL_BAIT_G = 15;

// Regola pratica per lo shock leader nel lancio di potenza
const LEADER_RULES = [
  { fromG: 135, minMm: 0.5 },
  { fromG: 105, minMm: 0.45 }
];

function leaderAdvice(totalG, currentMm) {
  const rule = LEADER_RULES.find((r) => totalG >= r.fromG) || null;
  const requiredMm = rule ? rule.minMm : null;
  const hasCurrent = isNum(currentMm);
  if (requiredMm === null) {
    return {
      requiredMm: null,
      currentMm: hasCurrent ? currentMm : null,
      ok: null,
      text: 'Sotto i 105 g lo shock leader non ha una soglia minima, ma resta consigliato nei lanci di potenza.'
    };
  }
  const need = `Con ${Math.round(totalG)} g serve uno shock leader di almeno ${requiredMm.toFixed(2)} mm.`;
  if (!hasCurrent) return { requiredMm, currentMm: null, ok: null, text: `${need} Indica quello montato per controllarlo.` };
  const ok = currentMm >= requiredMm;
  return {
    requiredMm,
    currentMm,
    ok,
    text: ok
      ? `${need} Il tuo da ${currentMm.toFixed(2)} mm va bene.`
      : `${need} Il tuo da ${currentMm.toFixed(2)} mm è troppo sottile: rischi di perdere il piombo in lancio.`
  };
}

/**
 * @param {{ rod: object|null, leadG: number, baitG: number|null }} input
 * @returns {{ totalG:number|null, loadPct:number|null, status:'ok'|'limit'|'overload'|'underload'|'unknown',
 *   title:string, advice:string, leader:object }}
 */
export function evaluateCasting({ rod, leadG, baitG }) {
  const lead = isNum(leadG) ? leadG : null;
  const bait = isNum(baitG) && baitG >= 0 ? baitG : null;
  const totalG = lead === null ? null : lead + (bait ?? 0);
  const baitNote = lead !== null && bait === null ? ' Peso dell\'esca non indicato: è contato solo il piombo.' : '';
  const leader = totalG === null
    ? { requiredMm: null, currentMm: isNum(rod?.shock_leader_mm) ? rod.shock_leader_mm : null, ok: null, text: 'Indica il peso del piombo.' }
    : leaderAdvice(totalG, rod?.shock_leader_mm);

  const min = rod?.min_cast_g;
  const max = rod?.max_cast_g;
  if (totalG === null || !isNum(min) || !isNum(max) || max <= 0) {
    return {
      totalG,
      loadPct: null,
      status: 'unknown',
      title: totalG === null ? 'Peso del piombo mancante' : 'Dati di lancio della canna mancanti',
      advice: totalG === null
        ? 'Indica il peso del piombo per controllare il carico.'
        : `Carico totale ${Math.round(totalG)} g. Aggiungi alla canna il potere di lancio minimo e massimo per controllarlo.${baitNote}`,
      leader
    };
  }

  const loadPct = Math.round((totalG / max) * 100);
  const range = `La canna lavora da ${min} a ${max} g.`;
  let status;
  let title;
  let advice;
  if (totalG > max) {
    status = 'overload';
    title = 'Troppo pesante per questa canna';
    advice = `Carico ${Math.round(totalG)} g, oltre il massimo. ${range} Usa un piombo più leggero o una canna più potente: forzare il lancio può spezzare il fusto.`;
  } else if (totalG > max * 0.9) {
    status = 'limit';
    title = 'Al limite della canna';
    advice = `Carico ${Math.round(totalG)} g, al ${loadPct}% del massimo. ${range} Lancia in modo progressivo, senza strappi.`;
  } else if (totalG < min) {
    status = 'underload';
    title = 'Troppo leggero per questa canna';
    advice = `Carico ${Math.round(totalG)} g, sotto il minimo. ${range} La canna non si carica e il lancio resta corto.`;
  } else {
    status = 'ok';
    title = 'Carico giusto per questa canna';
    advice = `Carico ${Math.round(totalG)} g, al ${loadPct}% del massimo. ${range}`;
  }
  return { totalG, loadPct, status, title, advice: `${advice}${baitNote}`, leader };
}
