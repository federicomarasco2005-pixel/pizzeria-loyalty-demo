# Demo tessera fedeltà Google Wallet — Pizzeria

Prototipo del ciclo minimo del progetto: **QR al tavolo → iscrizione → tessera in Google Wallet → timbro in cassa → premio → dashboard**.

| Pagina | URL | Chi la usa |
|---|---|---|
| Iscrizione | `/` | Cliente (dal QR al tavolo) |
| Tessera web | `/card/<token>` | Cliente (anche iPhone, come fallback) |
| Cassa | `/staff.html` | Cameriere/cassiere (PIN) |
| Dashboard | `/admin.html` | Titolare (PIN) |
| QR da tavolo | `/poster.html` | Da stampare |

Regola di default: **6 timbri = 1 margherita omaggio** (modificabile in `.env`).

---

## 1. Avvio rapido (senza Google, 2 minuti)

```bash
npm install
copy .env.example .env
npm start
```

Apri http://localhost:3000. Senza credenziali Google la demo funziona con la **tessera web** (stessa logica, stesso QR). Utile come piano B.

---

## 2. Configurare Google Wallet (≈ 30–45 minuti, fallo entro venerdì/sabato)

1. **Google Cloud** → https://console.cloud.google.com
   - crea un progetto (es. `loyalty-demo`);
   - *API e servizi → Libreria* → abilita **Google Wallet API**;
   - *IAM → Account di servizio* → crea un account di servizio → *Chiavi → Aggiungi chiave → JSON*;
   - salva il file come `service-account.json` nella cartella del progetto (**non condividerlo, non caricarlo su GitHub**).
2. **Google Pay & Wallet Console** → https://pay.google.com/business/console
   - crea il profilo business e apri la sezione **Google Wallet API**;
   - copia l'**Issuer ID** (numero lungo);
   - in **Utenti**, invita l'email dell'account di servizio (`...@...iam.gserviceaccount.com`) con accesso *Sviluppatore*.
3. In `.env` imposta `GOOGLE_ISSUER_ID=` con l'Issuer ID.
4. Riavvia: nel terminale deve comparire `[wallet] classe creata`. Se compare un errore di permessi, aspetta qualche minuto (la propagazione dei permessi non è immediata) e riavvia.

### ⚠️ Modalità demo di Google
Finché Google non approva l'account per la pubblicazione, i pass sono in **demo mode**: mostrano l'etichetta di test e possono essere salvati **solo dagli account Google aggiunti nella console** (utenti dell'account issuer / utenti di test — verifica la voce esatta nella console).

Per lunedì:
- aggiungi **il tuo account Google** e provalo sul tuo Android;
- se vuoi che il titolare lo provi sul suo telefono, chiedigli prima l'email Gmail e aggiungilo;
- se ha un **iPhone**: Google Wallet su iOS non c'è → mostra la tessera web (Apple Wallet richiede l'Apple Developer Program, ~99 $/anno: è la fase successiva).

La richiesta di accesso alla pubblicazione si fa dalla stessa console quando si passa al pilota vero.

---

## 3. Renderlo raggiungibile dai telefoni (HTTPS)

Serve un URL HTTPS pubblico: per la fotocamera della pagina Cassa, per il QR del tavolo e perché Google scarichi il logo.

**Opzione consigliata per la demo — tunnel Cloudflare dal tuo PC:**

```bash
winget install Cloudflare.cloudflared
```

```bash
cloudflared tunnel --url http://localhost:3000
```

Copia l'URL `https://....trycloudflare.com` che stampa, mettilo in `.env` come `PUBLIC_URL=` e riavvia `npm start` (la classe Wallet viene aggiornata con il nuovo logo). L'URL cambia a ogni avvio del tunnel: **ristampa il poster QR dopo l'ultimo riavvio**.

Alternativa più stabile: deploy su Render/Railway con `PUBLIC_URL` fisso (attenzione: senza disco persistente i dati si azzerano a ogni deploy — per una demo va bene).

---

## 4. Più locali e bot Telegram

Lo stesso server ospita più locali: ognuno ha il suo indirizzo (`/da-mario/`, `/bar-luna/`…) con iscrizione, tessera,
cassa (`/staff`), dashboard (`/admin`), QR da tavolo (`/poster`), timbro NFC (`/tap/…`), PIN e classe Google Wallet propri.
Il primo locale nasce dalle variabili qui sotto; i vecchi link (`/card/…`, `/tap/…`, `/staff.html`) portano a lui.

**Nuovi locali dal telefono, con il bot Telegram:**
1. Su Telegram apri **@BotFather** → `/newbot` → scegli nome e username → copia il token.
2. Su Render: servizio → **Environment** → aggiungi `TELEGRAM_BOT_TOKEN` = token → salva (il servizio riparte).
3. Apri il tuo bot e scrivi `/start`: **la prima persona che scrive diventa il proprietario**, gli altri vengono rifiutati
   (in alternativa imposta `TELEGRAM_OWNER_ID`).
4. `/nuova`: nome, tipo di timbro (pizza, caffè, burger, gelato, birra, stella o logo), timbri per il premio, premio,
   colore, logo (foto), link recensioni, telefono → anteprima → **Crea**. Ricevi link, PIN e indirizzo da scrivere nel chip NFC.
5. `/locali`: numeri di ogni locale, modifiche (premio, colore, logo…), nuovo PIN, elimina.

**Cosa fa anche il bot:**
- `/backup` (e ogni lunedì in automatico): copia completa di tutti i dati in un file `.json.gz`. Conservalo: contiene dati personali.
- `/report` (e ogni lunedì): timbri, clienti passati, nuovi iscritti, premi, chi ha dato i timbri.
- Avvisi: nuova versione online (non a ogni risveglio del server), Google Wallet che rifiuta un aggiornamento, 5 PIN sbagliati, locale senza timbri da 3 giorni.
- Scheda locale → **👤 Dipendenti**: un PIN personale per dipendente (solo Cassa; nello storico si vede chi ha timbrato).
- Scheda locale → **🤝 Accesso gestore**: link d'invito; il gestore vede nel bot solo i numeri del suo locale e riceve il report.

**Sicurezza e privacy:**
- Un'email già iscritta non riapre la tessera: servono codice tessera + email. Recupero e PIN: blocco di 15 minuti dopo 5 errori.
- Pagina `/<locale>/privacy` (informativa e regolamento: **testo di base da far verificare a un consulente**).
- Dalla tessera il cliente scarica i suoi dati, li cancella, revoca il consenso alle offerte. Dalla dashboard il gestore può cancellare un cliente.
- Tessere senza visite da 24 mesi: cancellate in automatico.

**Dati:** su Postgres una riga per cliente / timbro / campagna (al primo avvio il vecchio archivio viene copiato nelle tabelle e resta come copia).
Animazioni del Wallet e invii programmati riprendono dopo un riavvio.

**Test:** `npm test` (database anche Postgres simulato, server, bot). Su GitHub partono a ogni modifica (`.github/workflows/test.yml`).

Le immagini (timbri, GIF animate, icone, logo) sono generate dal server (`images.js`): niente script da lanciare.

## 5. Personalizzare il primo locale

In `.env`: `PIZZERIA_NAME`, `PROGRAM_NAME`, `REWARD_TEXT`, `STAMPS_FOR_REWARD`, `BRAND_COLOR`, `STAFF_PIN`.
Logo: sostituisci `public/logo.png` (PNG quadrato, ideale 660×660) con quello del locale — prendilo dal loro sito/Instagram.
Se cambi nome o colore dopo aver già creato la classe Wallet, al riavvio viene aggiornata; per ripartire da zero cambia `GOOGLE_CLASS_SUFFIX`.

Prima della demo: Dashboard → **Azzera dati demo**.

---

## 6. Copione demo (5 minuti)

Servono: il tuo telefono Android (cliente), un secondo telefono o tablet (cassa), il poster QR stampato, PC con server + tunnel acceso.

1. **Il problema** (30s): "Le tessere di carta si perdono e non vi dicono chi torna. Un'app nessuno la scarica."
2. **Iscrizione** (1 min): inquadri il poster → nome + email → *Aggiungi a Google Wallet* → la tessera col logo della pizzeria è nel Wallet. Fai notare: due consensi separati, il marketing è facoltativo.
3. **Cassa** (1 min): sull'altro telefono apri `/staff.html`, inquadri il QR nel Wallet → **+1 timbro**. Il pass nel Wallet si aggiorna da solo (pochi secondi; se tarda, la tessera web è istantanea).
4. **Premio** (1 min): tocca +1 fino al 6° → arriva la notifica "Premio sbloccato" → **Consegna premio**. Mostra **Annulla ultima** (errori tracciati, niente furbizie).
5. **Dashboard** (1 min): iscritti, clienti tornati, premi, clienti a un timbro dal premio, inattivi da 30 giorni. "Questi sono i clienti a cui scrivere."
6. **Chiusura** (30s): proposta pilota — "operativo in 7 giorni, 60 giorni di prova, report finale" (prezzo pilota da testare: 149–299 € una tantum, vedi documento di progetto).

Prova generale completa almeno una volta domenica, con il tunnel acceso e i due telefoni.

---

## Cosa c'è e cosa no (da dire onestamente)

**C'è:** iscrizione con consensi separati, pass Google Wallet aggiornabile, QR con token opaco (nessun dato personale nel codice), ledger append-only con annulli tracciati, protezione doppio tap, ricerca manuale come fallback, dashboard.

**Non c'è ancora (prototipo):** Apple Wallet, integrazione con la cassa/POS, email automatiche, login vero per lo staff (solo PIN), informativa privacy reale, database di produzione, export/cancellazione dati self-service. 

## File

- `server.js` — API e pagine (ogni locale sotto `/<slug>/`)
- `shops.js` — registro dei locali (creazione, modifica, configurazione)
- `bot.js` — bot Telegram (locali, dipendenti, gestori, report, backup, avvisi)
- `test/` — test automatici
- `images.js` — timbri, GIF, icone e logo generati per ogni locale
- `wallet.js` — Google Wallet (una classe per locale, oggetti, notifiche, link di salvataggio)
- `db.js` — archivio per locale (Postgres o file in `data/`) e calcolo saldo dal ledger
- `public/` — pagine cliente, cassa, dashboard, poster
