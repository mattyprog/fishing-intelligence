/**
 * Collegamento facoltativo al cloud. Si attiva solo se chi pubblica l'app ha compilato
 * CLOUD in js/config.js: altrimenti non carica nulla e l'app lavora solo sul dispositivo.
 */

import { isCloudConfigured } from './config.js';
import { state, bus } from './state.js';
import { setCloudAdapter } from './services/sync.js';

let adapter = null;

export function getCloud() {
  return adapter;
}

export async function initCloud() {
  if (!isCloudConfigured()) return null;
  try {
    const { createSupabaseAdapter } = await import('./services/supabase.js');
    adapter = await createSupabaseAdapter();
    if (!adapter) return null;

    state.user = await adapter.getUser();
    // Da qui sync.js sincronizza da solo: subito, dopo ogni modifica locale,
    // al ritorno della rete e a ogni cambio di account.
    setCloudAdapter(adapter);

    adapter.onAuthChange((user) => {
      state.user = user || null;
      bus.emit('auth:changed');
    });
    bus.emit('auth:changed');
    return adapter;
  } catch (err) {
    console.warn('Cloud non disponibile:', err);
    adapter = null;
    return null;
  }
}
