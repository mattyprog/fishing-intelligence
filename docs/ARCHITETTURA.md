# Fishing Intelligence 2.0 · Architettura e contratti

Documento di riferimento per chi lavora sul codice. Definisce struttura, forme dei dati e firme
delle funzioni condivise. **Le firme qui sotto sono un contratto**: se devi deviare, non farlo in
silenzio, scrivilo nel resoconto finale.

## 1. Principi

1. **Nessun dato inventato.** Un dato che manca vale `null` e in interfaccia si legge "n.d.".
   Mai valori di ripiego plausibili (1015 hPa, 0.4 m, ecc.). Mai meteo sintetico.
2. **Vanilla JS a moduli ES, nessun build, nessuna dipendenza npm a runtime.** Node 22 per i test
   (`node --test`). Il progetto ha `"type": "module"`.
3. **`js/core/` è puro**: niente DOM, niente `fetch`, niente `localStorage`, niente `Date.now()`
   implicito (l'istante corrente si passa come argomento). Deve girare in Node così com'è.
4. **Tempo**: le ore delle previsioni sono stringhe locali allo spot `YYYY-MM-DDTHH:MM`
   (Open-Meteo con `timezone=auto`) più `epochMs`. Non usare mai il fuso del dispositivo né
   `Europe/Rome` cablato per interpretarle. Per mostrare un'ora: `time.slice(11, 16)`.
5. **Sicurezza prima del punteggio**: un'ora pericolosa non può mai risultare "buona".
6. **Testi**: italiano semplice, da pescatore esperto. Niente MAIUSCOLO, niente punti
   esclamativi, niente "&", niente inglese se c'è l'italiano, niente lineette lunghe.
   Numeri con unità: `0.6 m`, `12 km/h`, `1018 hPa`. Niente emoji come icone: si usa `icon()`.
7. **XSS**: ogni stringa che arriva da utente, backup, cloud o API passa da `escapeHtml()` oppure
   da `textContent`. I numeri si validano con `Number.isFinite` prima di interpolarli.
8. Commenti nel codice in italiano, brevi, solo dove spiegano un perché.

## 2. Struttura

```
index.html                 guscio: header, 4 <section>, barra in basso, contenitori sheet/toast
css/tokens.css             variabili di design (tema scuro e chiaro)
css/base.css               reset, tipografia, layout, barra di navigazione
css/components.css         bottoni, chip, card, form, sheet, toast, stati vuoti, tile
css/view-forecast.css      una per vista: forecast, gear, diary, settings
js/config.js               costanti dell'app, soglie di sicurezza, endpoint, cloud
js/state.js                stato condiviso + bus di eventi
js/app.js                  avvio, router delle viste, tema, service worker
js/core/                   PURO (vedi principio 3)
  format.js  astronomy.js  species.js  spots.js  forecast.js  scoring.js  tactics.js
  casting.js  stats.js
js/services/
  weather-api.js           fetch Open-Meteo + cache con età esplicita
  geocoding.js             ricerca luoghi (Nominatim) con limite 1 richiesta al secondo
  storage.js               persistenza locale versionata (localStorage)
  backup.js                esporta, valida, importa, CSV
  sync.js                  coda e fusione con il cloud (adattatore iniettabile)
  supabase.js              adattatore Supabase (caricato solo se il cloud è configurato)
js/ui/
  dom.js  icons.js  charts.js  map.js  spot-sheet.js  onboarding.js
  views/forecast.js  views/gear.js  views/diary.js  views/settings.js
tests/                     *.test.js (node:test) + fixtures/ (risposte reali Open-Meteo)
vendor/leaflet/            Leaflet 1.9.4 in locale (js, css, immagini)
supabase/schema.sql
```

## 3. Stato, bus, viste

`js/state.js`

```js
export const state = {
  spotId, speciesId,            // selezione corrente (persistita nelle preferenze)
  dayIndex,                     // giorno selezionato nella vista Oggi (0 = oggi)
  forecast, forecastMeta,       // vedi §6 e §7, null finché non caricati
  evaluations,                  // DayEvaluation[] per la specie corrente (§8)
  user                          // utente cloud oppure null
};
export const bus = { on(evt, fn), off(evt, fn), emit(evt, payload) };
```

Eventi del bus: `data:changed` `{kind}` con kind tra `spots | gear | baits | catches | prefs | all`
(lo emette `storage.js` a ogni scrittura), `forecast:updated`, `selection:changed`,
`auth:changed`, `sync:status`.

Ogni vista esporta:

```js
export function mount(root, ctx) {}   // una volta: costruisce il DOM dentro root e collega gli eventi
export function show(params) {}       // ogni volta che la vista diventa visibile
```

`ctx = { state, bus, navigate(viewId, params) }`, con viewId tra `forecast | gear | diary | settings`.
Le viste si aggiornano ascoltando il bus, non chiamandosi tra loro.

## 4. Interfaccia condivisa

`js/ui/dom.js`

```js
$(sel, root = document)                 // querySelector
$$(sel, root = document)                // Array di querySelectorAll
escapeHtml(str)
html(strings, ...values)                // template tag: fa l'escape di ogni valore; raw(x) lo salta
raw(str)
on(root, event, selector, handler)      // delega eventi; handler(ev, elementoCorrispondente)
toast(message, type = 'info')           // 'info' | 'success' | 'error'
openSheet({ title, body, footer, onClose, wide })  // body/footer: stringa HTML o Node. Ritorna { el, close() }
confirmDialog({ title, message, confirmLabel = 'Elimina', cancelLabel = 'Annulla', danger = true })  // Promise<boolean>
formData(formEl)                        // oggetto { name: value } dei campi con attributo name
fmtDateTime(iso)  fmtDate(iso)          // it-IT, per le date del diario
```

`js/ui/icons.js`: `icon(name, { size = 20, cls = '' } = {})` restituisce una stringa `<svg>`
(tratto 1.75, `currentColor`). Nomi disponibili: `radar rod map-pin settings wave wind gauge
thermometer moon sun sunrise sunset tide clock calendar alert shield check x plus minus refresh
search crosshair filter trash edit chevron-down chevron-right chevron-left info scale fish download
upload layers cloud cloud-off user log-out external star droplet ruler list`.

Classi CSS pronte (`css/components.css`), da usare senza reinventarle:

- Layout: `.stack` (colonna, gap 12) `.stack-sm` `.row` (riga centrata, gap 8) `.row-between`
  `.grid-2` `.grid-3` `.muted` `.small` `.label` (etichetta 12 px maiuscoletto) `.num` (cifre tabellari)
  `.hidden`
- Card: `.card` `.card-title` `.card-sub` `.section-title`
- Bottoni: `.btn` + `.btn-primary | .btn-ghost | .btn-danger`, `.btn-sm`, `.btn-block`, `.btn-icon`
  (quadrato 44 px), `.fab` (tondo fisso in basso a destra, sopra la barra)
- Chip: `.chip` (statico) `.chip-btn` (selezionabile, stato `aria-pressed="true"`),
  `.chips` (riga scorrevole)
- Verdetto: `.v-ottimo .v-buono .v-discreto .v-difficile .v-pericolo .v-nd` impostano la variabile
  `--v`; `.badge` (pillola piena con colore `--v`), `.dot` (pallino), `.v-text` (testo colorato)
- Form: `.field` (label + controllo in colonna) `.input` `.select` `.textarea` `.field-row`
  (due campi affiancati) `.help` `.error-text` `.check` (checkbox con etichetta) `.stepper`
  (bottone meno, valore, bottone più)
- Liste: `.list` `.list-item` (riga con contenuto e azioni) `.item-title` `.item-sub` `.item-actions`
- Tile numeriche: `.tiles` (griglia) `.tile` `.tile-label` `.tile-value` `.tile-sub`
- Stato vuoto: `.empty` con `.empty-icon` `.empty-title` `.empty-text`
- Avvisi: `.notice` + `.notice-info | .notice-warn | .notice-danger`
- Sheet: gestito da `openSheet()`; dentro si usano `.sheet-actions` per i bottoni in fondo

- Altro: `.segmented` (scelta tra 2 o 3 opzioni, bottoni con `aria-pressed`), `.nav-row` (riga
  cliccabile a tutta larghezza), `.meter` (barra: `<div class="meter"><span style="width:60%">`),
  `.details` + `.details-body` (blocco espandibile su `<details>`), `.table` dentro `.table-wrap`,
  `.btn-link`, `.chip-ok | .chip-warn | .chip-off`, `.skeleton`, `.spinner`, `.grow`, `.truncate`,
  `.row-wrap`

L'elenco completo e aggiornato è `css/components.css`: leggilo prima di scrivere una vista.

Ogni vista può aggiungere regole solo nel proprio `css/view-*.css`, con prefisso di classe
dedicato (`.gear-…`, `.diary-…`, `.settings-…`). Colori solo tramite variabili di `tokens.css`.

`js/ui/map.js` (Leaflet in locale, caricato solo quando serve):

```js
ensureLeaflet()                         // Promise<L>: carica una volta vendor/leaflet/leaflet.js e leaflet.css
createMap(container, { center: [lat, lng], zoom = 12, layersControl = true })
                                        // Promise<{ L, map, destroy() }>. Strati: Mappa (OpenStreetMap),
                                        // Satellite (Esri World Imagery), Carta nautica (OpenSeaMap, sovrapposta)
requestGps()                            // Promise<{ lat, lng, accuracyM }>; in errore, Error con messaggio in italiano
```

`js/forecast-controller.js` è l'unico che carica le previsioni: `refreshForecast({ force })`,
`selectSpot(id)`, `selectSpecies(id)`, `selectDay(i)`. Aggiorna `state` ed emette
`forecast:updated` e `selection:changed`.

## 5. Dati dell'utente (`js/services/storage.js`)

Chiavi `localStorage` con prefisso `fi2_`. Alla prima esecuzione migra le chiavi v1 (`fi_*_v1`)
senza cancellarle. I record v1 con `client_id` che inizia per `gear-default-`, `bait-default-`,
`catch-default-` sono i dati dimostrativi della v1: si importano con `is_demo: true`.
**Nessun dato dimostrativo viene più creato.**

```js
initStorage()                       // idempotente → { migrated: boolean, demoCount: number }
getPrefs()  setPrefs(partial)       // Prefs
listSpots()  getSpot(id)  saveSpot(data)  deleteSpot(id)     // predefiniti (da core/spots.js) + personali
listGear()   saveGear(data)   deleteGear(clientId)
listBaits()  saveBait(data)   deleteBait(clientId)
listCatches() saveCatch(data) deleteCatch(clientId)          // ordinate per caught_at decrescente
countDemoRecords()  removeDemoRecords()                      // → numero di record
clearAllData()
storageUsage()                      // → { bytes, quotaBytes | null }
class StorageError extends Error    // code: 'quota' | 'unavailable'
class ValidationError extends Error // field, message in italiano
```

Le funzioni `save*` validano, completano (`client_id`, `created_at`, `updated_at`), scrivono,
accodano l'operazione di sincronizzazione ed emettono `data:changed`. Se la scrittura fallisce
lanciano `StorageError`: la vista non deve mostrare "salvato". Le `delete*` lasciano una lapide
(`deleted_at`) che le `list*` non restituiscono.

```
Prefs  { spotId, speciesId, theme: 'auto'|'dark'|'light', onboarded: boolean }
Spot   { id, client_id, name, region, lat, lng, coast_orientation_deg, seabed_type, notes,
         isCustom, updated_at }
         coast_orientation_deg: 0..359, direzione verso cui GUARDA la spiaggia (da terra al mare aperto)
Gear   { client_id, category: 'canna_surf'|'canna_fondo'|'mulinello_filo'|'accessorio', name, brand,
         length_m, min_cast_g, max_cast_g, optimal_cast_g, reel_model, main_line_mm,
         shock_leader_mm, status: 'pronta'|'riserva'|'manutenzione', notes,
         is_demo, created_at, updated_at }            // i numerici opzionali valgono null se assenti
Bait   { client_id, name, category: 'anellide'|'sipunculide'|'mollusco'|'crostaceo'|'pesce'|'altro',
         quantity, available, target_species: string[], water_condition:
         'tutte'|'calmo_poco_mosso'|'mosso_scaduta', notes, is_demo, created_at, updated_at }
Catch  { client_id, species (nome mostrato), species_id (id di CATCH_SPECIES o null),
         weight_g (null ammesso), length_cm (null ammesso), bait_used, gear_used, location_name,
         spot_id (o null), lat, lng, caught_at (ISO UTC), released: boolean,
         weather_snapshot: Snapshot | {}, notes, is_demo, created_at, updated_at }
         vincolo: almeno uno tra weight_g e length_cm
Snapshot { waveHeightM, wavePeriodS, windSpeedKmh, windDirDeg, pressureHpa, seaTempC, seaPhase,
           light, score }                              // tutti opzionali, numeri validati
```

`backup.js`: `exportBackup()` → oggetto `{ app, schema: 2, exportedAt, spots, gear, baits,
catches, prefs }`; `validateBackup(obj)` → `{ ok, errors: string[], counts }` (accetta anche il
formato v1); `importBackup(obj, { mode: 'merge'|'replace' })` atomico → `counts`;
`catchesToCsv(catches)` → stringa CSV con separatore `;` e BOM.

`sync.js`: `getSyncStatus()` → `{ enabled, online, pending, lastSyncAt, syncing, error }`,
`syncNow()`, `setCloudAdapter(adapter)`. Fusione per record: vince `updated_at` più recente, le
lapidi si propagano. La logica si testa con un adattatore finto in memoria.

## 6. Previsioni (`js/core/forecast.js`)

```js
buildForecast({ weather, marine, spot, now })  // weather/marine: JSON Open-Meteo o null; now: epochMs → Forecast
```

```
Forecast {
  spotId, lat, lng, timezone, utcOffsetSeconds,
  marineGrid: { lat, lng, distanceKm } | null,     // cella del modello marino effettivamente usata
  has: { weather, marine, seaTemp, seaLevel },     // quali blocchi di dati ci sono
  hours: Hour[],                                   // continue, crescenti, una per ora (da ieri 00:00)
  nowIndex,                                        // indice dell'ora corrente in hours, -1 se fuori
  days: Day[]                                      // giornate di pesca a partire da quella corrente
}
Hour {
  time, epochMs,
  airTempC, precipMm, precipProb, weatherCode, cloudCover,
  windKmh, gustKmh, windDirDeg, pressureHpa,
  pressureTrend3h,          // hPa nelle ultime 3 ore (valore a t meno valore a t-3h), null ai bordi
  waveM, wavePeriodS, waveDirDeg, windWaveM, swellM, swellPeriodS,
  seaTempC, seaLevelM, currentKmh,
  seaPhase,                 // 'scaduta' | 'montante' | 'stabile' | null
  light,                    // 'night' | 'dawn' | 'day' | 'dusk'
  windIncidence             // 'onshore' | 'offshore' | 'cross' | null
}                           // ogni dato assente è null
Day {
  date, label, labelShort,  // '2026-11-19', 'Oggi' / 'Domani' / 'Sabato 21', 'Oggi' / 'Dom' / 'Sab'
  startIndex, endIndex,     // intervallo in hours, endIndex escluso
  sun:  { dawn, sunrise, noon, sunset, dusk },     // ciascuno { time: 'HH:MM', epochMs } o null
  moon: { phaseKey, phaseName, illuminationPct, ageDays, rise, set },  // rise/set come sopra
  tides: [{ type: 'high'|'low', time, epochMs, levelM }],
  summary: { waveMinM, waveMaxM, windMaxKmh, gustMaxKmh, airMinC, airMaxC, weatherCode,
             precipMm, seaTempC }
}
```

- **Giornata di pesca**: va dalle 05:00 alle 05:00 del giorno dopo, perché le sessioni notturne
  non si spezzano a mezzanotte. `days[0]` è la giornata che contiene `now` (alle 02:00 di notte è
  ancora quella di ieri). L'ultima giornata può essere più corta.
- **Fase del mare** (`seaPhase`): `scaduta` se l'onda è calata di almeno il 12% nelle ultime 6 ore
  e nelle 36 ore precedenti c'è stato un picco di almeno 0.8 m; `montante` se è cresciuta di
  almeno il 15% in 6 ore e supera 0.4 m; altrimenti `stabile`. `null` senza dati d'onda.
- **Incidenza del vento**: differenza angolare tra provenienza del vento e
  `coast_orientation_deg`: fino a 50° `onshore` (dal mare), da 130° `offshore` (da terra), in mezzo `cross`.
- **Maree**: massimi e minimi locali di `seaLevelM` affinati con interpolazione parabolica.
  Il livello è un dato di modello: serve a leggere il giro di marea, non per la navigazione.

## 7. Caricamento (`js/services/weather-api.js`)

```js
loadForecast(spot, { force = false, now = Date.now() })   // → { forecast: Forecast|null, meta }
loadForecasts(spots, { now })                             // più spot in 2 richieste → Map<spotId, { forecast, meta }>
meta { source: 'network'|'cache'|'stale'|'none', fetchedAt (ISO|null), ageMs,
       partial: { weather: boolean, marine: boolean }, error: string|null }
```

Si salvano in `localStorage` le risposte grezze con l'ora di scarico e la previsione si
ricostruisce a ogni lettura. Fresca fino a 30 minuti; senza rete si usa la copia salvata e
`source` diventa `stale`. Oltre 24 ore la vista nasconde il punteggio. Il service worker **non**
mette in cache le API.

## 8. Punteggio (`js/core/scoring.js`)

```js
export const WEIGHTS = { sea: 0.34, wind: 0.14, light: 0.14, season: 0.12, water: 0.10,
                         pressure: 0.08, tide: 0.04, moon: 0.04 };
scoreHour(hour, species, { day })   // → { score: 0..100|null, safety: 'ok'|'caution'|'danger',
                                    //     safetyReasons: string[], parts: { [chiave]: { value: 0..1|null } } }
evaluateDay(forecast, dayIndex, species)   // → DayEvaluation
evaluateForecast(forecast, species)        // → DayEvaluation[] (una per giornata)
verdictFor(score, safetyLevel)             // → { key, label }
```

```
DayEvaluation {
  dayIndex, date,
  score,                    // 0..100 intero, oppure null se mancano i dati del mare
  verdict: { key: 'ottimo'|'buono'|'discreto'|'difficile'|'pericolo'|'nd', label },
  bestWindow: { startIndex, endIndex, startTime, endTime, score, label } | null,   // label: 'stasera 18-21'
  hourly: [{ index, time, score, safety }],            // per il grafico orario
  safety: { level: 'ok'|'caution'|'danger', text, alerts: [{ level, fromTime, toTime, text }] },
  factors: [{ key, label, weight, value, points, maxPoints, impact: 'positive'|'neutral'|'negative',
              title, detail }],                         // riferiti alla finestra migliore
  headline,                 // una frase, massimo 90 caratteri
  confidence: 'alta'|'media'|'bassa',
  missing: string[]         // dati non disponibili, in chiaro
}
```

- Punteggio orario: media pesata dei fattori disponibili (i pesi dei fattori `null` si
  ridistribuiscono). Senza onda il punteggio è `null`. Curve continue (trapezi), niente gradini.
- Un fattore cardine molto basso limita il totale: mare sotto 0.15 → massimo 35; stagione sotto
  0.15 → massimo 45.
- Sicurezza per ogni ora: `danger` con onda ≥ 2.1 m, raffiche ≥ 55 km/h, vento ≥ 42 km/h o
  temporale (codici 95, 96, 99, anche nell'ora prima o dopo); `caution` con onda ≥ 1.5 m,
  raffiche ≥ 42 km/h o vento ≥ 30 km/h. `danger` limita il punteggio a 15, `caution` a 75.
- Punteggio della giornata: media della migliore finestra di 3 ore consecutive non pericolose,
  solo tra le ore non ancora passate. Se tutte le ore sono pericolose: verdetto `pericolo`.
- Verdetto: 75 e oltre `ottimo`, da 60 `buono`, da 45 `discreto`, sotto `difficile`.
- Affidabilità: `alta` fino a 2 giorni, `media` fino a 4, `bassa` oltre o con dati mancanti.

## 9. Altri moduli puri

```js
// species.js
SPECIES            // 6 profili: orata, sarago, mormora, spigola, ombrina, serra
CATCH_SPECIES      // elenco più ampio per il diario: { id, name, scientificName, minLegalSizeCm|null }
getSpecies(id)  legalSizeFor(idONome)   // → { cm, source } | null
REGULATIONS        // { dailyLimitKg: 5, maxHooksPerRod: 3, sources: [{ label, url }] }
// spots.js
PREDEFINED_SPOTS
// tactics.js
buildTactics({ evaluation, forecast, species, spot, gear, baits })
  // → { when, rig, lead: { grams, shape }, rods: { ok: Gear[], overloaded: Gear[] },
  //     baits: [{ name, have: boolean }], where }
// casting.js
evaluateCasting({ rod, leadG, baitG })
  // → { totalG, loadPct, status: 'ok'|'limit'|'overload'|'underload'|'unknown', title, advice, leader }
// stats.js
computeCatchStats(catches)      // → { count, totalWeightKg, avgWeightG, record: Catch|null, topSpot, topBait, released }
computeInsights(catches)        // → [{ title, text }] solo con almeno 5 catture reali (non demo)
// astronomy.js
sunTimes(dateYMD, lat, lng)     // → { dawn, sunrise, noon, sunset, dusk } in epochMs (null se non esiste)
moonPhase(epochMs)              // → { phaseKey, phaseName, illuminationPct, ageDays, fraction }
moonTimes(dateYMD, lat, lng, utcOffsetSeconds)   // → { rise, set } in epochMs o null
// format.js
windName(deg)                   // → { cardinal: 'SSO', name: 'Libeccio' }
seaStateLabel(waveM)            // → 'calmo' | 'quasi calmo' | 'poco mosso' | 'mosso' | 'molto mosso' | 'agitato'
weatherLabel(code)              // → { label, icon } con icon tra i nomi di icons.js
fmtNum(n, decimals)             // 'n.d.' se null
```

## 10. Fatti verificati (19 novembre 2026)

- Taglie minime (Reg. UE 2019/1241, allegato IX parte A, Mediterraneo): spigola 25 cm, sarago
  maggiore 23, sarago pizzuto 18, sarago testa nera (fasciato) 18, sparaglione 12, mormora 20,
  orata 20, pagello fragolino 15, pagello bastardo 17, pagro 18, triglie 11, sogliola 20,
  sgombro 18, sugarello 15, nasello 20, cernie 45. Ombrina, pesce serra e leccia stella non hanno
  una taglia minima nell'allegato.
- DPR 1639/1968: art. 142, massimo 5 kg al giorno per pescatore, salvo pesce singolo di peso
  superiore; art. 138, canne con non più di tre ami.
- Comunicazione MASAF (tesserino) obbligatoria, gratuita, annuale, dal portale SIAN.
- Open-Meteo: variabili marine `sea_surface_temperature`, `sea_level_height_msl`,
  `ocean_current_velocity`, `wind_wave_height`, `swell_wave_*` disponibili sul Pontino;
  `timezone=auto`, `past_days=1`, più coordinate separate da virgola in una sola richiesta.
  Uso gratuito solo non commerciale, meno di 10.000 chiamate al giorno, licenza CC BY 4.0.
- OpenStreetMap: URL `https://tile.openstreetmap.org/{z}/{x}/{y}.png`, attribuzione visibile,
  niente scaricamento in blocco. Nominatim: massimo 1 richiesta al secondo, niente
  autocompletamento, risultati in cache.
