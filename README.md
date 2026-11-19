# 🎣 Fishing Intelligence — PWA Surfcasting & Pesca da Riva

**Fishing Intelligence** è una Progressive Web App (PWA) mobile-first in italiano progettata per la pianificazione tecnica delle sessioni di pesca dalla spiaggia (**surfcasting**, **beach ledgering** e **pesca a fondo**), la gestione dell'**Arsenale** (canne, mulinelli, shock leader, esche) con verifica dinamica del *casting weight*, e il **Diario Georeferenziato delle Catture** su mappa interattiva **Leaflet**.

---

## 📁 Struttura del Progetto

```text
fishing-intelligence/
├── index.html                  # Shell HTML5 semantica, bottom navigation mobile e modali <dialog> accessibili
├── manifest.webmanifest        # Web App Manifest valido con icone SVG/PNG e shortcuts PWA
├── sw.js                       # Service Worker con cache versionata (Network-First + fallback offline)
├── server.js                   # Server HTTP locale zero-dipendenze (Node.js) su porta 8080
├── verify.js                   # Suite di verifica automatica (ID DOM, asset PWA, astronomia, scoring)
├── package.json                # Script npm (start, dev, verify)
├── .env.example                # Template variabili d'ambiente per Supabase
├── css/
│   └── styles.css              # CSS3 responsive mobile-first (Tema Notte/Radar + Tema Sole Alto Contrasto)
├── js/
│   ├── config.js               # Configurazione endpoint API e credenziali Supabase (file o UI)
│   ├── data.js                 # Spot costieri predefiniti (Salto di Fondi, Capratica, Sperlonga, Gaeta, ecc.) e profili specie
│   ├── astronomy.js            # Calcolo astronomico NOAA (Alba, Tramonto, Crepuscolo) e ciclo lunare sinodico Meeus
│   ├── weather.js              # Integrazione reale Open-Meteo Weather API + Marine API + OSM Nominatim
│   ├── scoring.js              # Motore di scoring 0-100 trasparente e spiegabile con penalità di sicurezza marina
│   ├── storage.js              # Persistenza Offline-First in localStorage + coda di sincronizzazione (fi_sync_queue_v1)
│   ├── supabase.js             # Client Supabase Auth (email/password) e CRUD PostgreSQL protetto da RLS
│   ├── map.js                  # Gestore mappa Leaflet multi-layer (OSM, Satellite Esri, Topo, OpenSeaMap) + GPS
│   └── app.js                  # Controller principale dell'applicazione
├── assets/
│   └── icons/
│       ├── icon.svg            # Icona vettoriale radar/onda
│       ├── icon-192.png        # Icona PWA 192x192
│       └── icon-512.png        # Icona PWA 512x512
└── supabase/
    └── schema.sql              # Schema SQL PostgreSQL completo con trigger e Row Level Security (RLS)
```

---

## 🚀 1. Avvio Rapido in Locale

L'applicazione utilizza ES Modules nativi e non richiede bundle pesanti: funziona immediatamente tramite qualsiasi server HTTP locale (necessario per il caricamento dei moduli ES6 e la registrazione del Service Worker `sw.js`).

### Opzione A — Con Node.js (Consigliata, zero pacchetti da installare)
```bash
cd fishing-intelligence
npm start
```
*(In alternativa: `node server.js`)*
Apri il browser su: **`http://localhost:8080`**

### Opzione B — Con Python 3
```bash
cd fishing-intelligence
python -m http.server 8080
```
Apri il browser su: **`http://localhost:8080`**

### Esecuzione dei Test di Integrità
Per verificare che tutti gli ID HTML, gli asset del Service Worker, i calcoli astronomici e il motore di scoring funzionino senza errori:
```bash
npm run verify
```

---

## 🗄️ 2. Configurazione Backend & Database Supabase

L'app funziona **da subito al 100% in Modalità Ospite / Offline** salvando i dati localmente. Per attivare l'autenticazione utente e la sincronizzazione cloud su **Supabase**:

1. **Crea un progetto gratuito su [Supabase](https://supabase.com/)**.
2. **Esegui lo schema SQL**:
   - Nel pannello di controllo Supabase, apri **SQL Editor** → **New Query**.
   - Copia e incolla l'intero contenuto del file [`supabase/schema.sql`](./supabase/schema.sql) e clicca su **Run**.
   - Lo script crea le tabelle `profiles`, `custom_locations`, `gear_items`, `baits_inventory` e `catches`, attiva i trigger `updated_at` e abilita la **Row Level Security (RLS)** su tutte le tabelle (`auth.uid() = user_id`).
3. **Configura `SUPABASE_URL` e `SUPABASE_ANON_KEY`**:
   - Vai in **Project Settings** → **API** su Supabase e copia **Project URL** e **anon public key**.
   - **Metodo 1 (Direttamente dall'interfaccia dell'app)**: Clicca sul pulsante **👤 Account** in alto a destra nell'app → apri il menu **⚙️ Configurazione Connessione Supabase (URL & Anon Key)** → incolla URL e Anon Key e clicca su **Salva Credenziali Cloud**.
   - **Metodo 2 (Da codice)**: Inserisci i valori nelle costanti `DEFAULT_SUPABASE_URL` e `DEFAULT_SUPABASE_ANON_KEY` in [`js/config.js`](./js/config.js).

---

## 🌐 3. Pubblicazione Online (Deploy Statico PWA)

Poiché la PWA è interamente client-side con persistenza duale (LocalStorage + Supabase Cloud) e chiamate CORS dirette a Open-Meteo e Supabase, puoi pubblicarla gratuitamente in pochi secondi su qualsiasi hosting HTTPS statico (HTTPS è obbligatorio in produzione per `navigator.geolocation` e `serviceWorker`):

- **Netlify**: Trascina la cartella `fishing-intelligence` su [app.netlify.com/drop](https://app.netlify.com/drop) oppure collega il repository Git (Build command: *vuoto*, Publish directory: `.`).
- **Vercel**: Esegui `npx vercel` dentro la cartella `fishing-intelligence`.
- **GitHub Pages / Cloudflare Pages**: Pubblica la root della directory del progetto.
