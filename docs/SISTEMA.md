# Tessere fedeltà digitali: come funziona tutto il sistema

*Stato aggiornato al 22 ottobre 2026. Documento per riprendere il lavoro da zero: leggilo prima di toccare qualcosa. Lo stato del giorno e le cose da fare sono in `HANDOFF.md`.*

---

## 1. In breve

Un servizio di **tessere fedeltà digitali per ristoranti, bar e pizzerie**. Il cliente non scarica nessuna app.

- **Il cliente** si iscrive dal telefono (QR sul tavolo o timbro NFC). La sua tessera vive in due posti:
  - una **pagina web animata**, salvabile sulla schermata Home, anche su iPhone;
  - una **tessera Google Wallet**, solo su Android, che si aggiorna da sola.
- **Il locale** dà un timbro a ogni visita:
  - dalla **Cassa** (telefono o tablet, scansione del QR o ricerca);
  - oppure con un **timbro fisico con chip NFC**, che appoggia sul telefono del cliente.
  
  Ogni N timbri il cliente ha diritto a un premio.
- **Il gestore del locale** ha una dashboard: numeri, clienti, notifiche push nel Wallet, impostazioni.
- **Il proprietario del servizio** (Federico) gestisce tutti i locali da un **bot Telegram**:
  - crea un locale nuovo rispondendo a 8 domande;
  - modifica i locali, gestisce PIN e dipendenti;
  - riceve report, backup e avvisi.

Un **solo server** ospita **tutti i locali**, ognuno con il suo indirizzo: `/<slug>/`, per esempio `/da-mario/` o `/eldorado/`.

---

## 2. Dove sta tutto

| Cosa | Dove |
|---|---|
| Codice sul PC | `C:\Users\feder\Desktop\Clode\Clode\loyalty-demo` (spostato dal vecchio PC `C:\Users\OEM\Desktop\Clode` il 10 ottobre 2026) |
| Repository | GitHub `federicomarasco2005-pixel/pizzeria-loyalty-demo` (pubblico, ramo `main`) |
| Hosting | Render, piano gratuito, servizio `pizzeria-loyalty-demo` (id `srv-dav3bnvpn0mc739u1bng`), regione Frankfurt |
| Sito live | **https://f5m.it** (indirizzo principale dal 10/10/2026). https://pizzeria-loyalty-demo.onrender.com resta attivo: lo usano chip NFC, QR e tessere già emessi |
| Dominio proprio | **f5m.it**, comprato su Aruba il 10/10/2026 (scade 10/10/2027, rinnovo automatico, solo dominio + DNS). Aggiunto a Render tramite `render.yaml` (`domains:`). DNS su Aruba fatti: A `@` → `216.24.57.1`, CNAME `www` → `pizzeria-loyalty-demo.onrender.com`, più `*`, `_acme-challenge` e `_cf-custom-hostname` per i sottodomini. `PUBLIC_URL=https://f5m.it`. Manca ancora il certificato di Render per `*.f5m.it` (verificato il 22/10). |
| Google Wallet console | **Pubblicazione approvata da Google il 19/10/2026** (pratica 05701322). Nome pubblico **F5M**, profilo attività completo (MCC 5734, sito, assistenza, email e telefono), profilo pagamenti "Privato" collegato. Qualsiasi account Android può salvare la tessera. |
| Database | Postgres gratuito di Render (`pizzeria-loyalty-db`), collegato con `DATABASE_URL`. **Scade il 31/10/2026**: spostamento su Neon fissato entro il 28–29/10 (`tools/copia-database.ps1`) |
| Bot Telegram | **@GestioneFedelta_bot** (proprietario: Federico, il primo che ha scritto `/start`) |
| Google Wallet | Issuer ID `3388000000023194584`, service account `wallet-issuer@pizzeria-loyalty-demo.iam.gserviceaccount.com` |
| Keepalive | GitHub Actions `.github/workflows/keepalive.yml` chiama `/api/cron`: è programmato ogni 10 minuti, ma GitHub lo esegue solo ogni qualche ora, quindi il server gratuito si addormenta comunque |
| Test automatici | GitHub Actions `.github/workflows/test.yml`: a ogni modifica su `main` |
| Documento strategico | Solo sul PC di Federico (`contesto\analisi-web-wallet-punchpass.md`), non nel repository: web al centro, Wallet come promemoria, NFC sicuro |

**Segreti, mai nel repository:**
- `service-account.json`, la chiave Google: è sul PC; su Render sta nella variabile `GOOGLE_SA_JSON`.
- `STAFF_PIN`: il PIN del primo locale, variabile su Render.
- `TELEGRAM_BOT_TOKEN`: su Render come **Secret File**, non come variabile. `bot.js` lo legge da `/etc/secrets/`.

Tutti e tre sono esclusi da `.gitignore`.

### Locali attivi
| Slug | Nome | Note |
|---|---|---|
| `da-mario` | Pizzeria Da Mario | Locale demo originale ("legacy"). Classe Wallet `pizzeria_demo_v1`, archivio `db`, PIN da `STAFF_PIN`, logo e logo largo da file, non eliminabile. Ci sono 3 clienti di prova ("Test Claude" è la tessera salvata nel Wallet di Federico, più "Federico" e "Francesco"). |
| `eldorado` | Eldorado | Creato da Federico con il bot l'8 ottobre 2026. |
| `football` | (da completare) | Visto nei log di Render il 10 ottobre 2026, creato con il bot. |
| ? | (da verificare) | Dal 21/10/2026 `/api/config` conta 4 locali: il quarto non è noto, chiedere a Federico. |

---

### Novità del 10–12 ottobre 2026
- **Online su https://f5m.it**: pagina del servizio (marchio F5M) con assistenza (`/assistenza`, email Gmail di Federico). I locali sono su `f5m.it/<indirizzo>`; onrender.com continua a funzionare.
- **Sottodomini dei locali** (`da-mario.f5m.it`): codice pronto, DNS su Aruba pronto (`*`, `_acme-challenge`, `_cf-custom-hostname`), dominio `*.f5m.it` su Render. **Manca il certificato di Render per `*.f5m.it`**: quando c'è, togliere il commento a `SHOP_DOMAIN` in `render.yaml` e pubblicare. Le tessere Wallet ricevono i link nuovi da sole.
- **Bot**: "Indirizzo (sottodominio)" tra le modifiche (il vecchio indirizzo resta e porta al nuovo), "Scontrino medio", pulsanti **Kit di lancio (PDF)**, **Report del mese (PDF)**, **Automazioni**.
- **Messaggi automatici** (ogni giorno dalle 11, max 1 al giorno per cliente, nella tessera Wallet e web): "Ti manca 1 timbro", richiesta di recensione dopo la 3ª visita (serve il link recensioni), "Ci manchi" dopo 21 giorni (solo con consenso). Accesi di default, si spengono dal bot.
- **Kit di lancio PDF** (QR da tavolo, adesivi, istruzioni personale, testi social) mandato dal bot alla creazione di un locale.
- **Report mensile PDF** il 1° del mese a proprietario e gestori.
- **Dashboard dei locali (14 ottobre 2026, versione demo)**: nuova grafica (barra laterale, colori F5M). Panoramica con solo iscritti, clienti e ultime operazioni; Notifiche "In arrivo"; Impostazioni senza timbro NFC; tolto "Azzera dati demo". Le API del server sono rimaste tutte: si possono riattivare.
- **"Usa il premio" dalla tessera del cliente**: schermata PREMIO VALIDO animata con orologio (anti-screenshot), premio segnato come consegnato (`by: 'customer'`), annullabile dalla tessera per 5 minuti finché il cliente non tocca "Fatto" (poi solo dalla Cassa): "Fatto" chiude il ritiro sul server (`customer.redeemClosed`), la schermata non torna più. Acceso di default, interruttore nel bot (scheda locale).
- **Auto-deploy** vero dopo i test (app Render installata su GitHub; `autoDeployTrigger: checksPass` nel Blueprint).
- **Database**: strumento di copia verificata `tools/copia-database.ps1` pronto per passare a Neon (gratis) prima della scadenza del Postgres Render (~31 ottobre).

### Novità del 13–22 ottobre 2026
- **Sito f5m.it** con particelle 3D, demo interattiva, modulo "Richiedi una demo" (arriva sul bot) e assistenza.
- **Nuova grafica F5M** per dashboard, Cassa e QR da tavolo (stile comune in `public/f5m.css`).
- **Tessera web "carta vera"** e **Wallet** con logo largo per tutti i locali, testi in inglese e buono premio (15–16/10).
- **Google Wallet approvato** per tutti il 19/10.
- **Plancia sul PC** e **agente del mattino** nel cloud con avvisi Telegram (18/10, fuori dal repository).
- **Validazione** (21–22/10): documento di scope, niente funzioni nuove fino alla fine del pilota.

## 3. Come si pubblica una modifica (IMPORTANTE)

Dal 10 ottobre 2026 (nuovo PC) `loyalty-demo` è una copia git collegata a GitHub (`origin/main`). Node 24 e Git sono installati.

1. Modifica i file in locale e lancia **`npm test`**: devono passare tutti, oggi sono 37.
2. Pubblica con git: `git add …`, `git commit`, `git push`.
   - Il login GitHub (account **federicomarasco2005-pixel**) è già salvato su questo PC: `git push` funziona.
   - Ripiego, se git non va: caricare i file dal browser su `github.com/federicomarasco2005-pixel/pizzeria-loyalty-demo/upload/main/<cartella>` (una cartella per commit).
3. Su GitHub partono i test (workflow `test`).
4. Render ha **Auto-Deploy = "After CI Checks Pass"**: se i test passano, **pubblica da solo** (circa 1–2 minuti), e il bot Telegram scrive "🚀 Nuova versione online".
   - Funziona davvero dal 10 ottobre 2026: prima mancava l'app Render su GitHub e ogni deploy andava fatto a mano. Ora l'app è installata sul solo repository `pizzeria-loyalty-demo`.
5. Se serve pubblicare a mano: Render → **Manual Deploy → "Deploy latest commit"**.

   **MAI "Deploy a specific commit"**: spegne l'auto-deploy, è già successo.
6. Verifica nei log di Render (Logs): devono comparire `[db] Postgres collegato…`, `[locali] N: …`, `[bot] Telegram attivo…` e `classe aggiornata`.

---

## 4. Architettura del codice

```
server.js    Express: pagine per locale, API cliente/cassa/dashboard, NFC, notifiche, lavori periodici, "manager" per il bot
shops.js     Registro dei locali (creazione/modifica/eliminazione, slug, PIN, dipendenti, gestori Telegram, configurazione)
db.js        Archivio per locale: in memoria + Postgres (tabelle) o file JSON; ledger dei timbri; campagne; export/cancellazione
wallet.js    Google Wallet REST: una classe per locale, oggetti (tessere), messaggi/notifiche, link "Salva", disattivazione
images.js    Genera sul server timbri, GIF animate, icone e logo per ogni locale (@napi-rs/canvas + gifenc)
bot.js       Bot Telegram (webhook su Render, polling in locale)
public/      Pagine (uguali per tutti i locali): index, card, tap, staff, admin, poster, privacy + common.js, style.css, sw.js
test/        db.test.js, server.test.js, bot.test.js (node:test; Postgres simulato con pg-mem)
tools/       Vecchi script PowerShell per le immagini del primo locale (non più necessari: ora fa tutto images.js)
render.yaml  Blueprint Render (servizio + database)
```

### 4.1 Più locali, una sola base di codice
- Ogni richiesta `/<slug>/...` passa da un middleware che carica il locale in `req.ctx`:
  - `ctx.shop` è la scheda salvata;
  - `ctx.db` è l'archivio dei clienti;
  - `ctx.cfg` è la configurazione calcolata.
- Le pagine HTML sono **le stesse per tutti**. Il server, in `page()` dentro server.js, inserisce:
  - `<base href="/slug/">`, così tutti i link e le chiamate `api/...` sono relativi al locale;
  - `window.SHOP = {slug, legacy, prefix}`;
  - i colori `--brand`, le icone dei timbri `--stamp-on` e `--stamp-off`, l'emoji del tema al posto di 🍕, il prefisso dei codici al posto di `PZ-`.
- **Vecchi link**, prima del multi-locale: `/`, `/staff.html`, `/admin.html`, `/poster.html`, `/card/<token>` e `/tap/<segreto>` vengono **reindirizzati** al locale giusto.
  - Il locale si trova dal token o dal segreto NFC.
  - Per questo continuano a funzionare il timbro NFC già scritto, le tessere nel Wallet e le icone installate.
- Memoria del telefono: le chiavi `localStorage` sono per locale (`cardToken:<slug>`, `staffPin:<slug>`), e così il cookie `card_<slug>`. Il primo locale legge anche le vecchie chiavi senza slug.

### 4.2 Scheda di un locale (registro `shops`, chiave kv `shops`)
| Campo | Significato |
|---|---|
| `slug` | indirizzo |
| `name` | nome del locale |
| `programName` | nome del programma fedeltà |
| `rewardText`, `rewardShort` | testo del premio, completo e breve |
| `stampsForReward` | timbri per il premio, da 3 a 12 |
| `brandColor` | colore della tessera |
| `theme` | tipo di timbro: pizza, caffe, burger, gelato, birra, stella, logo |
| `codePrefix` | prefisso dei codici cliente |
| `staffPin` | PIN del gestore, 6 cifre; per il locale legacy è null e si usa `STAFF_PIN` |
| `staff[]` | dipendenti `{id, name, pin}` |
| `managers[]` | gestori collegati su Telegram `{chatId, name}` |
| `classSuffix` | suffisso della classe Google; unico, con un timestamp, perché le classi non si cancellano |
| `dataKey` | archivio: `db` per il legacy, `shop:<slug>` per gli altri |
| `logo` | logo in base64 |
| `imgVersion` | versione delle immagini: sale a ogni cambio estetico e obbliga Google a riscaricarle |
| `legacy` | true solo per il locale demo originale |

### 4.3 Dati (db.js)
- **Tutto in memoria**: le letture sono istantanee. Ogni modifica si scrive subito:
  - **Postgres** (su Render), con le tabelle `customers`, `events`, `campaigns`, `notifications` (una riga per elemento, colonna `store` = dataKey) e `kv` (registro dei locali, impostazioni del locale `settings:<key>`, stato del bot `telegram`, lavori periodici `jobs`, segno di migrazione `migrated:<key>`);
  - **file JSON** in `data/` (in locale; `DATA_DIR` per cambiarla).
- **Ledger append-only**: eventi `signup`, `stamp`, `redeem`, `void` (annullo).
  - Il saldo (timbri e premi) **non è mai salvato**: si ricalcola da un indice degli eventi per cliente (`stateOf`).
  - Ogni evento registra `by` (`staff` o `nfc`) e `who` (nome del dipendente o "Gestore").
- **Migrazione** (8 ottobre 2026): il vecchio archivio "tutto in uno" (riga kv `db`) è stato copiato nelle tabelle: 3 clienti e 53 eventi per da-mario, 0 per eldorado. La vecchia riga è rimasta come copia di sicurezza.
- I tentativi, le pause e i timer di cortesia stanno in memoria. Quello che deve sopravvivere a un riavvio è salvato:
  - `customer.settleAt`, la fine dell'animazione nel Wallet;
  - lo stato delle campagne (`pending`, `sentTo`);
  - lo stato dei lavori periodici (`jobs`).

### 4.4 Google Wallet (wallet.js)
- **Una classe per locale** (`loyaltyClass`) con:
  - logo, nome e colore;
  - logo largo, solo per il locale legacy;
  - `cardTemplateOverride`, una riga "Timbri · Premio · Codice" sul fronte.
- **Un oggetto per cliente** (`loyaltyObject`, id `<issuer>.c_<customerId>`):
  - aggiornato con **PUT completo**, senza leggerlo prima;
  - i messaggi del pass li decide il server: resta solo l'ultimo messaggio attivo, con scadenza;
  - QR del Wallet spento di default (`WALLET_QR=on` per riaccenderlo); se acceso contiene il codice tessera, non il token.
  - Testi anche in inglese (`localizedHeader/Body`, `localizedLabel`, `localizedDescription`): Google mostra la lingua del telefono. Il testo del premio resta quello scritto dal locale.
  - **Buono premio**: con un premio da ritirare la tessera ha collegato un'offerta Google (`linkedOfferIds`, classe `<classSuffix>_premio`, oggetto `c_<id>_premio`); ritirato il premio il buono diventa `COMPLETED`.
  - Ripieghi automatici su un rifiuto di Google (400), fino al riavvio: prima la GIF, poi il buono collegato, poi le traduzioni. La tessera si aggiorna comunque.
- **Immagine principale**: striscia 3:1 (1032×336) con i timbri.
  - Subito dopo un timbro c'è una **GIF animata**: il timbro entra girando con il "+1". Si riproduce una volta sola e l'ultimo fotogramma dura circa 11 minuti.
  - Dopo `WALLET_ANIM_MINUTES` (default 2) il server rimette il **PNG fisso**.
  - Se Google rifiuta la GIF si torna automaticamente alle immagini fisse.
- **Notifica a ogni timbro**: un messaggio `TEXT_AND_NOTIFY` ("☕ +1 timbro! Sei a 3/8") che scade da solo.
  - **Limite Google: 3 notifiche push per tessera ogni 24 ore** (contate in `notifications`).
  - Oltre il limite il messaggio arriva senza notifica.
- `hasUsers` dice se la tessera è stata salvata: in quel caso il pulsante "Aggiungi a Google Wallet" sparisce dalla tessera web.
- **All'avvio** le classi vengono aggiornate solo quando il sito risponde, perché Google scarica subito logo e immagini dal nostro server.
- **Cancellazione cliente**: l'oggetto viene messo `INACTIVE` e svuotato del nome.

### 4.5 Immagini (images.js)
- Generate al volo, tenute in memoria (fino a circa 400 file) e preparate in anticipo prima di passarle a Google. Generarne un set richiede circa 0,3 s.
- Indirizzi per locale: `stamps/grid-N-k.png`, `stamps/anim-N-k.gif`, `stamps/anim-N-reward.gif`, `stamps/icon(-empty).png`, `icons/icon-192|512|apple-touch-icon.png`, `logo.png`, `wide-logo.png` (logo largo del Wallet: timbro + nome in Inter, font in `fonts/`; il locale legacy usa il file `public/wide-logo.png`).
- 6 temi disegnati come forme vettoriali, senza font né emoji sul server. Il tema "logo" usa il logo caricato.
- I timbri "spenti" sono la versione in grigio scuro di quelli pieni.
- Il "+1" è disegnato come forma: il server non ha bisogno di font.

### 4.6 Timbro NFC
- Il chip contiene `https://pizzeria-loyalty-demo.onrender.com/<slug>/tap/<segreto>`. Il locale legacy può avere anche il vecchio `/tap/<segreto>`, che viene reindirizzato.
- Il gestore lo appoggia sul telefono del cliente, il telefono apre la pagina `tap` e il server riconosce il cliente:
  1. dalla memoria della pagina (`localStorage`) o dal cookie HttpOnly `card_<slug>`, che dura circa 400 giorni e resiste alla pulizia di Safari;
  2. se il telefono è sconosciuto, la pagina propone **"Sono nuovo"**: iscrizione e primo timbro subito;
  3. oppure **"Ho già la tessera"**, con codice tessera ed email. Tentativi limitati.
- **Protezioni**:
  - segreto rigenerabile dalla dashboard (i chip vecchi smettono di funzionare);
  - **un timbro NFC ogni 3 ore** per cliente (`nfcCooldownHours`);
  - NFC disattivabile;
  - **avviso live in Cassa** con il pulsante "Annulla".
- Scrivere il chip: dalla dashboard con Chrome su Android (Web NFC), altrimenti con l'app NFC Tools.

### 4.7 Pagine (public/)
| Pagina | Indirizzo | Cosa fa |
|---|---|---|
| index.html | `/<slug>/` | Iscrizione (nome, email, consenso al regolamento obbligatorio, marketing facoltativo). Email già usata: modulo di recupero con codice ed email. |
| card.html | `/<slug>/card/<token>` | Tessera animata, aggiornata in tempo reale. Contiene: pulsante "Aggiungi a Google Wallet" (nascosto su iPhone o se già salvata), "📲 Salva sul telefono" (guida passo passo per iPhone, installazione per Android), fronte con timbri, barra di avanzamento, premio e codice; retro con il QR (si gira toccando la tessera o "Mostra il QR in cassa"), QR a tutto schermo con lo schermo sempre acceso (si apre da solo con `?qr=1`), riflesso lucido che segue dito/inclinazione, recensione Google, messaggi del locale, ultime visite, "Privacy e impostazioni" chiuso in fondo (consenso, privacy, scarica i miei dati, elimina la tessera). Modalità scura automatica; inglese se il telefono non è in italiano (`?lang=en|it` per forzarla). Il service worker la apre subito dalla copia salvata (anche col server addormentato) e la pagina si aggiorna appena il server risponde; la rilettura ogni 15 s solo se la connessione live è caduta. Ogni tessera ha il suo manifest, così l'icona sulla Home riapre proprio quella tessera. |
| tap.html | `/<slug>/tap/<segreto>` | Timbro NFC (vedi 4.6). |
| staff.html | `/<slug>/staff` | Cassa: PIN, scanner QR (libreria servita da `/vendor/html5-qrcode.min.js`), ricerca (il codice completo apre subito la tessera), +1 timbro, consegna premio, annulla, feed live dei timbri NFC. I dipendenti non vedono il link alla dashboard. |
| admin.html | `/<slug>/admin` | Dashboard, **solo con il PIN del gestore**. **Panoramica**: numeri, clienti (con 🗑️ per cancellarli), storico con chi ha timbrato. **Notifiche**: segmenti, consenso, durata del messaggio (1/3/7/14 giorni), programmazione, storico, annulla, "elimina dalle tessere". **Impostazioni**: link recensione, Maps, telefono, NFC. |
| poster.html | `/<slug>/poster` | QR da tavolo da stampare. |
| privacy.html | `/<slug>/privacy` | Informativa e regolamento del locale. |
| sw.js | `/sw.js` | Service worker: prima la rete, la copia salvata solo se si è offline. |

**Tempo reale**: Server-Sent Events, su `api/card/<token>/stream` per la tessera e su `api/staff/stream?t=<biglietto>` per la Cassa. Il biglietto si chiede con il PIN a `api/staff/stream-ticket` e vale una volta per 60 secondi: il PIN non finisce mai in un indirizzo.

### 4.8 Sicurezza e privacy
- **PIN**: il PIN del gestore (6 cifre per i locali nuovi) apre Cassa e dashboard; il PIN di un dipendente apre solo la Cassa.
  - **Dopo 5 errori dallo stesso indirizzo IP: blocco di 15 minuti** e avviso su Telegram. I blocchi sono salvati nel database (kv `attempts`, al massimo 24 ore) e sopravvivono ai riavvii.
  - Con 20 o più PIN sbagliati in un'ora su un locale (tentativi da più indirizzi), ogni indirizzo si blocca al primo errore e arriva un avviso. Il PIN giusto continua a funzionare.
  - Il PIN viaggia nell'header `x-staff-pin` ed è ricordato nel `localStorage` del dispositivo della cassa.
- **Iscrizione**: un'email già iscritta **non** restituisce la tessera.
  - Il recupero richiede codice ed email (`/api/recover`), con lo stesso blocco dopo 5 errori.
- Il token della tessera è opaco (16 byte casuali, nessun dato personale) e apre la tessera: per questo **non è nel QR**. Il QR contiene il codice tessera (es. `PZ-AB12C`), che da solo non apre niente: la Cassa lo riconosce solo con il PIN (`api/staff/customer/<codice o token>`; i QR vecchi con il token restano validi).
- **Intestazioni di sicurezza** su tutte le risposte: `X-Frame-Options: SAMEORIGIN` e `frame-ancestors 'self'`, `X-Content-Type-Options: nosniff`, `Referrer-Policy: same-origin`. `/api/cron` è pubblico ma fa il giro delle campagne al massimo una volta al minuto.
- **GDPR**:
  - informativa per locale (il locale è il titolare dei dati, il servizio è il responsabile del trattamento);
  - export JSON dei dati, senza il token;
  - autocancellazione dalla tessera e cancellazione dalla dashboard;
  - revoca del consenso;
  - **cancellazione automatica dopo 24 mesi senza visite** (controllo giornaliero);
  - i messaggi promozionali vanno solo a chi ha dato il consenso marketing.

### 4.9 Bot Telegram (bot.js)
- **Webhook** su `https://…/telegram/<hash>`, con un secret token nell'header. In locale, senza https, usa il **polling**.
- **Accesso**:
  - il **proprietario** è chi ha scritto `/start` per primo (salvato in kv `telegram`), oppure `TELEGRAM_OWNER_ID`;
  - **i gestori** si collegano con un link d'invito `t.me/GestioneFedelta_bot?start=g_<codice>` (vale 7 giorni, una volta sola). Vedono solo i numeri del loro locale e i link, e ricevono il report;
  - tutti gli altri vengono rifiutati.
- **Comandi del proprietario**: `/nuova`, `/locali`, `/report`, `/backup`, `/annulla`, `/aiuto`.
- **`/nuova`**: nome → tema → timbri → premio → colore → logo (foto) → link recensione → telefono → riepilogo con anteprima → **Crea**.
  - Il bot risponde con il PIN, i link (iscrizione, cassa, dashboard, poster) e l'URL da scrivere nel chip NFC.
- **Scheda di un locale**:
  - numeri e link;
  - ✏️ Modifica (nome, premio, premio breve, timbri, tema, colore, logo, recensione, telefono, Maps): le tessere già emesse si aggiornano da sole;
  - 🖼️ Anteprima;
  - 👤 Dipendenti (aggiungi o rimuovi, ognuno con il suo PIN);
  - 🤝 Accesso gestore, 🔒 Scollega;
  - 📈 Report;
  - 🔑 Nuovo PIN;
  - 🗑️ Elimina (con conferma; non per il locale legacy).
- **Automatici**:
  - **lunedì dalle 9**: backup (file `backup-tessere-AAAA-MM-GG.json.gz` con tutti i dati) e report settimanale a proprietario e gestori;
  - **ogni giorno dalle 10**: controllo dei locali senza timbri da 3 o più giorni e cancellazioni per privacy.
- **Avvisi** (lo stesso avviso non si ripete prima di 6 ore):
  - server avviato (al massimo uno all'ora);
  - Google Wallet che rifiuta un aggiornamento;
  - 5 PIN sbagliati;
  - locale fermo;
  - nuovo gestore collegato.

### 4.10 Notifiche del gestore (dashboard → Notifiche)
- **Segmenti**: tutti, a 1 timbro dal premio, con un premio da ritirare, inattivi da 30 o più giorni, mai tornati, nuovi negli ultimi 7 giorni, scelti a mano.
- Invio subito o **programmato**: le campagne vengono controllate ogni 30 secondi e da `/api/cron`.
- Ogni campagna si ricorda a chi è già stata inviata: se il server riparte a metà riprende senza doppioni.
- Il messaggio resta nella tessera per `keepDays`, poi sparisce. "Elimina dalle tessere" lo toglie subito.

---

## 5. Variabili d'ambiente

| Variabile | Uso |
|---|---|
| `DATABASE_URL` | Postgres (se manca: file in `data/`) |
| `DATABASE_SSL` | `true` se il database esterno richiede SSL |
| `GOOGLE_ISSUER_ID` | Issuer Google Wallet (se manca: niente Wallet, solo la tessera web) |
| `GOOGLE_SA_JSON` / `GOOGLE_KEY_FILE` | Chiave della service account (contenuto JSON oppure file, di default `./service-account.json`) |
| `STAFF_PIN` | PIN del gestore del locale legacy |
| `TELEGRAM_BOT_TOKEN` | Token del bot (variabile **oppure** Secret File su Render) |
| `TELEGRAM_OWNER_ID` | Facoltativa: fissa il proprietario del bot |
| `PUBLIC_URL` | URL pubblico (su Render basta `RENDER_EXTERNAL_URL`, che è automatica) |
| `PIZZERIA_NAME`, `PROGRAM_NAME`, `REWARD_TEXT`, `REWARD_SHORT`, `STAMPS_FOR_REWARD`, `BRAND_COLOR`, `GOOGLE_CLASS_SUFFIX`, `LEGACY_SLUG` | Usate **solo la prima volta** per creare il locale legacy. Dopo vale il registro `shops`. |
| `LOGO_URL`, `WIDE_LOGO_URL` | Logo del locale legacy (`WIDE_LOGO_URL=off` per toglierlo) |
| `WALLET_QR` | `on` per il QR dentro la tessera Wallet |
| `WALLET_ANIM_MINUTES` | Durata della GIF prima di tornare all'immagine fissa (default 2) |
| `STAMP_COOLDOWN_SEC` | Pausa minima tra due timbri dalla cassa (default 0) |
| `DATA_DIR`, `PORT` | Cartella dei dati locali e porta |

---

## 6. Cosa funziona (verificato)

- Più locali sullo stesso server, creati dal bot. Eldorado è stato creato da Federico l'8 ottobre 2026.
- Iscrizione, tessera web animata e in tempo reale, Cassa, dashboard, poster.
- Google Wallet (pubblicazione approvata il 19/10/2026): salvataggio, aggiornamento automatico, GIF una sola volta e poi immagine fissa, notifiche "+1", messaggi con scadenza, pulsante nascosto quando la tessera è già salvata. Provato sul telefono di Federico.
- Timbro NFC: provato con il timbro fisico di Federico, valido per più clienti, iscrizione al momento, pausa di 3 ore, avviso in Cassa.
- Tessera web installabile: prompt su Android verificato, guida per iPhone.
- Bot Telegram: online (webhook), creazione dei locali verificata dal vivo. Dipendenti, gestori, report, backup e avvisi sono coperti dai test, **non ancora provati dal vivo** da Federico.
- Postgres a tabelle e migrazione: eseguiti dal vivo l'8 ottobre 2026, senza perdite.
- Sicurezza (email già usata, blocco PIN e recupero) e privacy (export, cancellazione): coperti dai test e pubblicati.
- 37 test automatici, che passano in locale e su GitHub. Auto-deploy dopo i test attivo su Render.

---

## 7. Cosa non va / limiti noti (in ordine di urgenza)

1. **Database gratuito di Render**: scade il **31/10/2026** (poi viene cancellato verso il 14/11) e **non ha backup**.
   - Se scade si perde tutto. L'unica copia è il backup settimanale su Telegram, più `/backup`.
   - Soluzione scelta: **Neon gratuito** (non scade), copiando i dati con `tools/copia-database.ps1`. Fissato entro il 28–29/10/2026.
2. **Indirizzo onrender.com scritto ovunque**: nei chip NFC, nelle tessere Wallet, nei QR stampati e nelle icone. Se cambia l'hosting, tutto questo smette di funzionare.
   - In parte risolto: dal 10/10/2026 c'è **f5m.it** e i link nuovi usano quello. Chip e QR già fatti con onrender.com funzionano finché resta attivo il servizio su Render.
3. **Google Wallet**: la modalità demo è finita. **Il 19/10/2026 Google ha approvato la pubblicazione**: chiunque con Android può salvare la tessera.
4. **Testi legali**: l'informativa privacy e il regolamento sono una base, **da far verificare a un consulente**. Manca l'accordo scritto (nomina a responsabile del trattamento) con ogni locale.
5. **Pubblicazione**: risolto. Git e login GitHub funzionano; Render pubblica da solo dopo i test.
6. **Timbro NFC copiabile**: chi fotografa o copia l'URL del chip può timbrarsi da casa. Lo limitano la pausa di 3 ore e l'avviso in Cassa, ma non lo eliminano.
   - Soluzione: chip **NTAG 424 DNA** (codice diverso a ogni tocco). Da comprare e implementare.
7. **Server gratuito**: il keepalive di GitHub non basta, quindi il server si addormenta dopo 15 minuti e la prima richiesta impiega 30–50 secondi. Per il pilota serve un server sveglio negli orari dei locali: un servizio gratuito che chiama `/api/cron` ogni 10 minuti, oppure il piano Render da 7 $/mese (decide Federico).
   - Le immagini stanno in memoria e si rigenerano dopo ogni riavvio: la prima richiesta è più lenta.
   - I blocchi dei PIN sono salvati nel database dal 22/10/2026 e non si azzerano più ai riavvii.
8. **Velocità e limiti di Google**: l'aggiornamento del Wallet e le notifiche arrivano dopo secondi o minuti, decide Google. Massimo 3 notifiche push per tessera al giorno. Le GIF nell'immagine principale non sono documentate ufficialmente: oggi funzionano, e se Google le rifiuta c'è il ripiego automatico.
9. **iPhone**: niente Apple Wallet. Serve l'Apple Developer Program (99 €/anno) più lo sviluppo dei pass `.pkpass`. Su iPhone oggi c'è solo la tessera web salvata sulla Home.
10. **Recupero della tessera**: funziona solo con codice ed email; non c'è l'invio di email. Chi perde il codice lo chiede in cassa, dove lo staff lo cerca per nome.
11. **Scalabilità**: tutti i dati di tutti i locali vengono caricati in memoria all'avvio. Va bene fino a decine di migliaia di clienti. Oltre servono query su database invece della memoria.
    - `findByRequestId` scorre tutti gli eventi: va bene oggi, da indicizzare in futuro.
12. **Accesso dei gestori**: login solo con PIN, nessun account con password o email. Il PIN resta nel browser del dispositivo della cassa.
13. **Logo largo dei locali nuovi**: generato dal server con il font Inter (`fonts/`, licenza OFL). Cambiando il nome del locale si rigenera.
14. **Nessun pagamento** (abbonamenti, Stripe) e **nessun report via email**: solo Telegram.

---

## 8. Cose da sapere per non rompere niente

- **Fino alla fine del pilota niente funzioni nuove**: valgono le regole del documento di scope (originale su claude.ai, link in `CLAUDE.md`). Ammessi senza prove: database, sicurezza, privacy, server sveglio, errori.
- **Mai cambiare il `classSuffix`** di un locale esistente: le tessere già nei Wallet si staccherebbero. Per lo stesso motivo **mai rinominare lo slug** e **mai rigenerare il segreto NFC** senza riscrivere i chip.
- **Il locale legacy `da-mario`** usa l'archivio `db`, la classe `pizzeria_demo_v1` e il PIN `STAFF_PIN`. Non è eliminabile.
- **Cambiare tema, colore, numero di timbri o logo** fa salire `imgVersion`: le immagini vengono rigenerate e le tessere riaggiornate.
- Cambiare il numero di timbri su un locale con clienti **ricalcola** i saldi dal ledger: per esempio da 6 a 8 timbri, chi aveva 7 timbri non ha più il premio.
- **Le classi Google non si possono cancellare.** Se elimini un locale, la sua classe resta su Google (innocua).
- Prima di ogni pubblicazione: `npm test`. Dopo: controlla i log di Render.
- Le pagine usano indirizzi **relativi** (`api/...`, `card/...`, `logo.png`) per via di `<base href>`. Un percorso nuovo che inizia con `/` salta il locale. Gli unici assoluti voluti sono `/style.css`, `/f5m.css`, `/common.js`, `/sw.js`, `/wallet-button-it.svg` e `/vendor/html5-qrcode.min.js`.

---

## 9. Comandi utili

Avvio in locale (porta 3000, dati in `data/`; senza `.env` niente Google né Telegram):
```bash
npm start
```

Tutti i test:
```bash
npm test
```

Prova di salute del sito live:
```bash
curl https://f5m.it/api/config
```

---

## 10. Storia in breve

1. **Demo per una pizzeria**: tessera web più Google Wallet, Cassa con QR, dashboard. Pubblicata su Render e GitHub.
2. **Tessera Wallet curata**:
   - stile "Planxadito's", con la striscia dei timbri in evidenza e il QR tolto;
   - GIF animate che girano una sola volta;
   - notifica "+1";
   - link per la recensione Google;
   - notifiche del gestore con segmenti e limiti di Google;
   - messaggi che si possono eliminare e scadono da soli.
3. **Timbro NFC fisico**: valido per tutti i clienti, iscrizione al primo tocco. Tessera web salvabile sul telefono (soprattutto per iPhone).
4. **Più locali e bot Telegram**: creazione dei locali dal telefono, immagini generate dal server, 6 temi.
5. **Punti gratuiti della lista "prima dei clienti veri"**:
   - tabelle Postgres;
   - sicurezza dell'iscrizione e del PIN;
   - privacy;
   - dipendenti e gestori;
   - report, backup e avvisi;
   - operazioni che sopravvivono ai riavvii;
   - test e auto-deploy.

**Prossimi passi possibili**, quando ci sarà budget:
- ~~dominio proprio~~ fatto (f5m.it, 10/10);
- database su Neon gratuito (entro il 28–29/10);
- ~~richiesta di pubblicazione Google Wallet~~ fatta (approvata il 19/10);
- verifica legale dei testi;
- chip NTAG 424 DNA;
- Stripe per gli abbonamenti dei locali;
- Apple Wallet.
