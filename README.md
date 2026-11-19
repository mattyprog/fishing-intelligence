# Fishing Intelligence

Previsioni di pesca da riva: dice se e quando conviene uscire, per la specie che cerchi, sul
litorale laziale o su qualunque spiaggia aggiungi tu. È una web app in italiano pensata per il
telefono, che si può installare e che funziona anche con poco segnale.

Versione 2.0.0.

## Cosa fa

- **Oggi**: un punteggio da 0 a 100 per la specie scelta, la finestra migliore della giornata,
  i sette giorni seguenti, il grafico ora per ora (punteggio, onda, vento, marea), le condizioni
  del momento, il confronto tra gli spot e un piano di pesca con piombo, terminale, esche e
  distanza di lancio.
- **Sicurezza prima del punteggio**: con onda da 2.1 m, vento da 42 km/h, raffiche da 55 km/h o
  temporale la giornata è "pericolo", qualunque sia il resto.
- **Attrezzatura**: canne ed esche, con il calcolo del piombo che ogni canna può lanciare e dello
  shock leader che serve.
- **Diario**: le catture con posizione, mappa e il mare di quel momento; col tempo dice dove,
  quando e con che esca prendi di più. Segnala i pesci sotto la taglia minima.
- **Impostazioni**: tema, copia e ripristino dei dati, esportazione per Excel, regole di pesca,
  come nasce il punteggio, fonti.

I dati restano sul dispositivo. Nessun account è richiesto.

## Avvio

Serve solo Node 20 o successivo. Non ci sono pacchetti da installare.

```bash
npm start          # http://localhost:8080
npm test           # test con node --test
npm run check      # controlli statici: precache, import, icone, versioni
```

`PORT` e `HOST` cambiano porta e indirizzo del server di sviluppo (`HOST=0.0.0.0` per provarla
dal telefono sulla stessa rete: l'installazione e il GPS richiedono però HTTPS o `localhost`).

Durante lo sviluppo il service worker risponde dalla copia salvata e aggiorna in background:
dopo una modifica serve un ricaricamento forzato (Ctrl+Maiusc+R), oppure due ricaricamenti.

## Struttura

```
index.html              guscio dell'app e Content Security Policy
css/                    tokens (temi), base, componenti, un foglio per vista
js/config.js            versione, endpoint, soglie di sicurezza, cloud
js/core/                logica pura, senza DOM né rete: previsioni, punteggio, tattiche,
                        lancio, astronomia, specie, statistiche
js/services/            Open-Meteo con cache a scadenza, ricerca dei luoghi, dati locali,
                        copia e ripristino, sincronizzazione
js/ui/                  viste, fogli, grafici, mappa
sw.js                   service worker (guscio e tessere delle mappe già viste)
tests/                  test con node:test e risposte reali di Open-Meteo come riferimento
vendor/leaflet/         Leaflet 1.9.4 in locale
supabase/schema.sql     schema per la sincronizzazione facoltativa
docs/ARCHITETTURA.md    contratti tra i moduli, scelte e limiti noti
```

Niente build e niente dipendenze a runtime: i moduli ES si caricano così come sono.

## Dati e fonti

- Meteo e mare: [Open-Meteo](https://open-meteo.com), licenza CC BY 4.0. Le previsioni si
  riscaricano dopo 30 minuti; senza rete resta l'ultima copia, e oltre le 24 ore il punteggio
  non viene più mostrato.
- Mappe: OpenStreetMap, Esri World Imagery, OpenSeaMap. Ricerca dei luoghi: Nominatim.
- Sole e luna: calcolati sul dispositivo.
- Taglie minime e limiti: regolamento (UE) 2019/1241 e DPR 1639/1968, controllati a novembre 2026.

Un dato che manca si legge "n.d.": l'app non mostra valori di ripiego.

## Aggiornamento dalla versione 1

Chi usava la versione 1 sullo stesso indirizzo ritrova spot, attrezzatura, esche e catture: la
conversione avviene al primo avvio. Gli esempi che la versione 1 inseriva da sola vengono marcati
come tali e si tolgono con un tocco da Diario o Impostazioni. La copia originale resta nel
browser finché non si sceglie "Cancella tutti i dati".

## Sincronizzazione (facoltativa)

Spenta per impostazione predefinita. Per accenderla chi pubblica l'app deve:

1. creare un progetto [Supabase](https://supabase.com) ed eseguire `supabase/schema.sql`
   nell'editor SQL;
2. scrivere indirizzo del progetto e chiave pubblica (anon) in `CLOUD` dentro `js/config.js`.

Da quel momento in Impostazioni compare la sezione Account. La chiave anon è pubblica per
natura: i dati sono protetti dalle regole di accesso per riga definite nello schema.

Questa parte non è mai stata provata contro un progetto Supabase reale: vedi i limiti qui sotto.

## Pubblicazione

È un sito statico: basta servire la cartella su HTTPS (Netlify, Cloudflare Pages, GitHub Pages).
Non vanno pubblicate `tests/`, `docs/`, `supabase/` e `server.js`, che servono solo allo sviluppo.
A ogni rilascio la versione va cambiata insieme in `package.json`, `js/config.js` e `sw.js`
(`npm run check` verifica che coincidano).

## Limiti noti

- **Il punteggio è una stima.** Le preferenze delle specie vengono dall'esperienza dei pescatori
  del Tirreno, non da misure, e i pesi sono tarature.
- **Il mare sotto costa è indicativo.** I modelli hanno celle di alcuni chilometri: per ogni spot
  l'app dice a che distanza si trova il punto del modello. Il livello del mare serve a leggere il
  giro di marea, non per la navigazione.
- **Sincronizzazione non collaudata sul campo.** Coda, fusione e cancellazioni sono coperte dai
  test con un cloud simulato; lo schema è stato eseguito su PostgreSQL locale (PGlite). Accesso,
  rinnovo della sessione e regole di accesso su Supabase vero non sono stati provati.
- **Provata nel browser del computer** in formato telefono, non su telefoni veri: installazione,
  icone e GPS su iOS e Android restano da verificare.
- **Cambio dell'ora.** Open-Meteo usa l'ora di oggi anche per i giorni dopo il cambio: l'app lo
  segnala nella giornata interessata, ma non riscrive gli orari.
- **Non sostituisce i bollettini ufficiali** né le ordinanze della Capitaneria.

## Licenze

Leaflet è distribuito con licenza BSD a due clausole (`vendor/leaflet/LICENSE`).
