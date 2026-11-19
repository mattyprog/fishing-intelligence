/**
 * Adattatore Supabase per sync.js, più accesso e uscita dall'account.
 * Lo SDK si carica da CLOUD.sdkUrl con un tag <script> solo se il cloud è configurato in
 * js/config.js: l'utente finale non vede né inserisce mai URL o chiavi.
 *
 * Sottile di proposito: traduce pull/push nelle query e gli errori in italiano. Si appoggia
 * a supabase/schema.sql (colonne deleted_at e synced_at, trigger delle versioni).
 */

import { CLOUD, isCloudConfigured } from '../config.js';

const COLUMNS = Object.freeze({
  custom_locations: ['client_id', 'name', 'region', 'lat', 'lng', 'coast_orientation_deg', 'seabed_type', 'notes'],
  gear_items: ['client_id', 'category', 'name', 'brand', 'length_m', 'min_cast_g', 'max_cast_g', 'optimal_cast_g', 'reel_model', 'main_line_mm', 'shock_leader_mm', 'status', 'notes'],
  baits_inventory: ['client_id', 'name', 'category', 'quantity', 'available', 'target_species', 'water_condition', 'notes'],
  catches: ['client_id', 'species', 'species_id', 'weight_g', 'length_cm', 'bait_used', 'gear_used', 'location_name', 'spot_id', 'lat', 'lng', 'caught_at', 'released', 'weather_snapshot', 'notes']
});
const VERSION_COLUMNS = ['created_at', 'updated_at', 'deleted_at'];
const PAGE_SIZE = 1000; // limite di righe per risposta dell'API di Supabase
const AUTH_STORAGE_KEY = 'fi2_auth';

let sdkPromise = null;
let clientPromise = null;

function loadSdk() {
  if (typeof globalThis.supabase?.createClient === 'function') return Promise.resolve(globalThis.supabase);
  if (typeof document === 'undefined') return Promise.reject(new Error('Il cloud non è disponibile in questo ambiente.'));
  if (!sdkPromise) {
    sdkPromise = new Promise((resolve, reject) => {
      const script = document.createElement('script');
      script.src = CLOUD.sdkUrl;
      script.async = true;
      script.crossOrigin = 'anonymous';
      script.onload = () => {
        if (typeof globalThis.supabase?.createClient === 'function') resolve(globalThis.supabase);
        else reject(new Error('Il modulo del cloud non si è caricato correttamente.'));
      };
      script.onerror = () => {
        sdkPromise = null;
        script.remove();
        reject(new Error('Non riesco a collegarmi al cloud. Controlla la connessione e riprova.'));
      };
      document.head.appendChild(script);
    });
  }
  return sdkPromise;
}

async function getClient() {
  if (!clientPromise) {
    clientPromise = loadSdk()
      .then((sdk) =>
        sdk.createClient(CLOUD.url.trim(), CLOUD.anonKey.trim(), {
          auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true, storageKey: AUTH_STORAGE_KEY }
        })
      )
      .catch((err) => {
        clientPromise = null;
        throw err;
      });
  }
  return clientPromise;
}

const toUser = (u) => (u && u.id ? { id: u.id, email: u.email ?? null } : null);

function cloudError(error) {
  const err = new Error('Il cloud ha rifiutato la richiesta. Riprova più tardi.');
  err.cause = error;
  return err;
}

function authError(error) {
  const msg = String(error?.message || '').toLowerCase();
  let text = 'Operazione non riuscita. Riprova tra poco.';
  if (msg.includes('invalid login credentials')) text = 'Email o password non corretti.';
  else if (msg.includes('email not confirmed')) text = "Conferma prima l'indirizzo email con il messaggio che hai ricevuto.";
  else if (msg.includes('already registered') || msg.includes('already been registered')) text = 'Esiste già un account con questa email.';
  else if (msg.includes('password') && (msg.includes('at least') || msg.includes('should be') || msg.includes('weak'))) text = 'Password troppo corta o troppo semplice: scegline una più lunga.';
  else if (msg.includes('rate limit') || error?.status === 429) text = 'Troppi tentativi. Aspetta qualche minuto e riprova.';
  else if (msg.includes('invalid email') || msg.includes('unable to validate email')) text = "L'indirizzo email non è valido.";
  else if (msg.includes('fetch') || msg.includes('network')) text = 'Connessione assente o instabile. Riprova.';
  const err = new Error(text);
  err.cause = error;
  return err;
}

function checkCredentials(email, password) {
  if (typeof email !== 'string' || !email.trim()) throw new Error('Scrivi la tua email.');
  if (typeof password !== 'string' || !password) throw new Error('Scrivi la password.');
}

function columnsOf(table) {
  const cols = COLUMNS[table];
  if (!cols) throw new Error(`Tabella non prevista: ${table}`);
  return cols;
}

/**
 * → Promise<adattatore | null>. null se il cloud non è configurato.
 * Adattatore: { getUser, pull, push, signIn, signUp, signOut, onAuthChange }.
 */
export async function createSupabaseAdapter() {
  if (!isCloudConfigured()) return null;
  const client = await getClient();

  async function requireUser() {
    const { data, error } = await client.auth.getSession();
    if (error) throw authError(error);
    const user = toUser(data?.session?.user);
    if (!user) throw new Error('Accedi al tuo account per sincronizzare.');
    return user;
  }

  return {
    async getUser() {
      const { data, error } = await client.auth.getSession();
      if (error) throw authError(error);
      return toUser(data?.session?.user);
    },

    /** Righe dell'utente (lapidi comprese) scritte sul server dopo sinceIso, in pagine da 1000. */
    async pull(table, sinceIso) {
      const cols = [...columnsOf(table), ...VERSION_COLUMNS, 'synced_at'].join(',');
      const user = await requireUser();
      const rows = [];
      for (let from = 0; ; from += PAGE_SIZE) {
        let q = client.from(table).select(cols).eq('user_id', user.id);
        if (sinceIso) q = q.gt('synced_at', sinceIso);
        q = q.order('synced_at', { ascending: true }).order('client_id', { ascending: true }).range(from, from + PAGE_SIZE - 1);
        const { data, error } = await q;
        if (error) throw cloudError(error);
        const page = Array.isArray(data) ? data : [];
        rows.push(...page);
        if (page.length < PAGE_SIZE) break;
      }
      return rows;
    },

    /**
     * Record vivi: upsert per (user_id, client_id), con deleted_at null per far rivivere una riga.
     * Lapidi: solo update di deleted_at e updated_at, così non servono gli altri campi obbligatori;
     * se la riga sul cloud non esiste non c'è niente da cancellare.
     */
    async push(table, records) {
      const cols = columnsOf(table);
      if (!Array.isArray(records) || !records.length) return;
      const user = await requireUser();
      const alive = [];
      const tombs = [];
      for (const r of records) (r.deleted_at ? tombs : alive).push(r);
      if (alive.length) {
        const rows = alive.map((r) => {
          const row = { user_id: user.id };
          for (const c of cols) row[c] = r[c] ?? null;
          row.created_at = r.created_at;
          row.updated_at = r.updated_at;
          row.deleted_at = null;
          return row;
        });
        const { error } = await client.from(table).upsert(rows, { onConflict: 'user_id,client_id' });
        if (error) throw cloudError(error);
      }
      for (const t of tombs) {
        const { error } = await client
          .from(table)
          .update({ deleted_at: t.deleted_at, updated_at: t.updated_at })
          .eq('user_id', user.id)
          .eq('client_id', t.client_id);
        if (error) throw cloudError(error);
      }
    },

    async signIn(email, password) {
      checkCredentials(email, password);
      const { data, error } = await client.auth.signInWithPassword({ email: email.trim(), password });
      if (error) throw authError(error);
      return toUser(data?.user);
    },

    /** → { user, needsConfirmation }: needsConfirmation se il progetto chiede di confermare l'email. */
    async signUp(email, password, displayName) {
      checkCredentials(email, password);
      const name = typeof displayName === 'string' && displayName.trim() ? displayName.trim().slice(0, 80) : email.trim().split('@')[0];
      const { data, error } = await client.auth.signUp({
        email: email.trim(),
        password,
        options: { data: { display_name: name } }
      });
      if (error) throw authError(error);
      return { user: toUser(data?.user), needsConfirmation: !data?.session };
    },

    async signOut() {
      const { error } = await client.auth.signOut();
      if (error) throw authError(error);
    },

    /** cb(user | null, evento). Restituisce la funzione per smettere di ascoltare. */
    onAuthChange(cb) {
      const { data } = client.auth.onAuthStateChange((event, session) => {
        // la documentazione di Supabase sconsiglia di usare il client dentro questa callback:
        // si rimanda al giro successivo
        setTimeout(() => {
          try {
            cb(toUser(session?.user), event);
          } catch (err) {
            console.warn("Errore in un ascoltatore dell'account:", err);
          }
        }, 0);
      });
      return () => data?.subscription?.unsubscribe();
    }
  };
}
