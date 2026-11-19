/**
 * Stato condiviso dell'app e bus di eventi.
 * Le viste leggono lo stato e si aggiornano ascoltando il bus: non si chiamano tra loro.
 */

export const state = {
  spotId: null,
  speciesId: null,
  dayIndex: 0,
  forecast: null,
  forecastMeta: null,
  evaluations: null,
  loading: false,
  user: null,
  installPrompt: null
};

const listeners = new Map();

export const bus = {
  on(evt, fn) {
    if (!listeners.has(evt)) listeners.set(evt, new Set());
    listeners.get(evt).add(fn);
    return () => bus.off(evt, fn);
  },
  off(evt, fn) {
    listeners.get(evt)?.delete(fn);
  },
  emit(evt, payload) {
    for (const fn of listeners.get(evt) || []) {
      try {
        fn(payload);
      } catch (err) {
        console.error(`Errore in un ascoltatore di "${evt}":`, err);
      }
    }
  }
};
