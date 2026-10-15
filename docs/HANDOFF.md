# Passaggio di consegne — F5M tessere fedeltà

*Aggiornato il 15 ottobre 2026, a fine sessione. Leggi questo file per primo, poi `docs/SISTEMA.md` (architettura completa) e `CLAUDE.md` (regole).*

---

## 1. Chi è Federico e come lavorare con lui

- Non è uno sviluppatore. **Rispondi in italiano semplice**, frasi corte, niente gergo; fai tu tutto il lavoro tecnico.
- **Lui fa solo**: login (Render, GitHub, Aruba, Google, Neon…), pagamenti, modifiche DNS su Aruba (il sistema di sicurezza blocca Claude sulle modifiche DNS: preparagli i valori esatti e il modulo aperto).
- **Prima di pubblicare fagli vedere l'anteprima** e aspetta "pubblica". Lo ha chiesto più volte: anteprima locale nel browser integrato, poi commit + push solo con il suo ok.
- Gli piacciono le cose curate e "da prodotto vero"; prova lui da PC e da telefono e dà feedback visivo.

---

## 2. Dove stiamo (stato al 15/10/2026)

| Cosa | Stato |
|---|---|
| Sito | **https://f5m.it** online: landing scura F5M con particelle 3D interattive, demo interattiva, modulo "Richiedi una demo" (arriva sul bot), sezione Assistenza |
| Locali | `da-mario`, `eldorado`, `football` su `https://f5m.it/<indirizzo>/` (vecchio onrender.com ancora funzionante) |
| Sottodomini (`da-mario.f5m.it`) | Codice pronto e testato, DNS su Aruba fatto (`*`, `_acme-challenge`, `_cf-custom-hostname`), `*.f5m.it` aggiunto su Render. **Manca il certificato HTTPS di Render per `*.f5m.it`** (bloccato da giorni). Quando c'è: togliere il commento a `SHOP_DOMAIN` in `render.yaml` |
| Dashboard locali | Nuova grafica F5M "versione demo": Panoramica (iscritti, clienti, ultime operazioni), Notifiche "In arrivo", Impostazioni (recensioni, contatti) |
| Cassa e QR da tavolo | Nuova grafica F5M (stile comune in `public/f5m.css`). **Fotocamera della Cassa da provare su un telefono vero** |
| Google Wallet | Ancora in **modalità demo** (solo account di prova possono salvare la tessera). Richiesta di pubblicazione non ancora inviata |
| Database | **Postgres gratuito di Render: scade ~31 ottobre 2026**, cancellato ~14 novembre. Nessun backup automatico tranne quello settimanale sul bot |
| Server | Render gratuito: si addormenta dopo 15 min (~50 s al risveglio). Federico ha deciso di rimandare le spese |
| Test | 31 test, tutti verdi (`npm test`) |
| Pubblicazione | `git push` da questo PC funziona; Render pubblica da solo dopo i test (app Render installata su GitHub) |

---

## 3. Cosa fare adesso (in ordine di urgenza)

1. **🔴 Database prima del 31 ottobre.** Piano scelto: **Neon gratuito** (non scade).
   - Federico: crea account su neon.tech (con GitHub) → tu crei il progetto a Francoforte.
   - Copia dati: `tools/copia-database.ps1` (chiede le due stringhe a schermo, le incolla lui; verifica "IDENTICO" tabella per tabella; il vecchio DB non viene toccato).
   - Federico incolla la stringa Neon in `DATABASE_URL` su Render. **Attenzione**: in `render.yaml` `DATABASE_URL` è `fromDatabase` → cambiarla in `sync: false`, altrimenti il Blueprint la rimette com'era. Poi verifica avvio, clienti, un timbro di prova. Prima di tutto: `/backup` dal bot.
2. **🟠 Sicurezza (dalla revisione del 14/10)** — da fare prima dei clienti veri:
   - **QR della tessera = chiave completa**: chi fotografa il QR mostrato in cassa può esportare i dati (email), cancellare la tessera, usare il premio. Fare un codice separato per il QR (valido solo in Cassa con PIN), mantenendo compatibili i QR già emessi.
   - **Cassa carica `html5-qrcode` da unpkg senza controllo d'integrità** → copia locale in `public/` (o hash SRI).
   - **Blocco PIN solo in memoria** (si azzera a ogni riavvio, frequente sul piano gratuito) → salvarlo nel database + limite per locale. Verificare che `STAFF_PIN` su Render sia impostato (altrimenti da-mario ha PIN `1234`).
   - Minori: PIN nell'URL degli avvisi live della Cassa (`api/staff/stream?pin=`), mancano header di sicurezza (frame-ancestors, nosniff, referrer), `/api/cron` pubblico.
3. **🟠 Pubblicazione Google Wallet.** Console Google Pay & Wallet (merchant "FEDELTA" → nome pubblico scelto **F5M**/"lossless": da confermare). Servono: profilo pagamenti (lo compila Federico, persona fisica), sito `https://f5m.it`, assistenza `https://f5m.it/assistenza`, email di assistenza (la Gmail di Federico), screenshot della tessera dal suo Android, poi "Request publishing access". Un solo issuer per tutti i locali va bene; le classi nuove vengono approvate da sole.
4. **🟡 Certificato `*.f5m.it`.** Se ancora assente: farsi mostrare da Federico lo stato del dominio nel pannello Render (a Claude la sezione domini non compare perché il servizio è gestito dal Blueprint) o scrivere al supporto Render.
5. **🟡 Da verificare con Federico**: fotocamera della Cassa su telefono vero; effetto tocco delle particelle su telefono vero.
6. **Più avanti** (quando c'è budget): server Render Starter ~7 $/mese (via l'attesa di 50 s), Apple Wallet, chip NFC NTAG 424 DNA, Stripe per gli abbonamenti, email automatiche (Brevo), prezzi sulla landing (non ancora decisi).

---

## 4. Cosa è stato fatto in queste sessioni (9–15 ottobre)

- Progetto spostato sul nuovo PC, Node 24 + Git installati, cartella collegata a GitHub.
- **Tessera web istantanea** (dati nella pagina, saldo nell'avviso live, niente attese di Google) e **Wallet più veloce** (GIF in un thread separato e preparate all'avvio, aggiornamenti in coda).
- Bot: avviso solo per **nuova versione** (non a ogni risveglio), **kit di lancio PDF**, **report mensile PDF**, **messaggi automatici** ("Ti manca 1 timbro", recensione dopo la 3ª visita, "Ci manchi" a 21 giorni con consenso), scontrino medio, cambio indirizzo del locale, interruttore "premio dal telefono del cliente".
- **"Usa il premio"** dalla tessera: schermata PREMIO VALIDO animata (anti-screenshot), annullabile 10 minuti.
- Dominio **f5m.it** comprato su Aruba, collegato a Render, sito ufficiale F5M, sottodomini pronti.
- Nuova grafica per **dashboard, Cassa, QR da tavolo**.
- Strumento di **copia verificata del database** (`tools/copia-database.js` + `.ps1`).

---

## 5. Problemi incontrati e come li abbiamo risolti (da ricordare!)

| Problema | Soluzione / cosa sapere |
|---|---|
| Auto-deploy di Render non partiva mai (tutti i deploy erano manuali) | Mancava l'**app Render su GitHub**: installata sul solo repo. Ora ogni push con test verdi va online da solo |
| Il Blueprint rimetteva l'auto-deploy su "ogni commit" | In `render.yaml` serve `autoDeployTrigger: checksPass` |
| La sezione "Custom Domains" non compare nel pannello Render | Il servizio è **gestito dal Blueprint**: i domini si aggiungono in `render.yaml` (`domains:`) e si pubblicano |
| Messaggi "Server avviato" continui sul bot | Il server gratuito si addormenta; ora l'avviso parte solo se cambia `RENDER_GIT_COMMIT` |
| GitHub Actions "keepalive" ogni 10 min in realtà gira ogni qualche ora | Limite di GitHub. Federico non vuole un pinger esterno (cron-job.org) per ora |
| Modifiche DNS su Aruba bloccate per Claude | Le fa Federico: aprigli il pannello DNS e dagli tipo/nome/valore esatti |
| `.it` appena comprato: "Attesa Validazione DNS" | Normale per qualche ora; il pannello DNS compare solo dopo |
| Anteprima che mostra la versione vecchia della pagina | Il server tiene le pagine in memoria (`readPage`): **riavvia il server di anteprima** dopo ogni modifica a `public/*.html` |
| Particelle ferme nel browser integrato | Se il pannello è nascosto il browser **mette in pausa le animazioni**: non è un bug. Per gli screenshot si può far girare l'animazione con un timer (solo per prova) |
| La landing si vede solo sul dominio principale | Per l'anteprima c'è la configurazione **`f5m-landing`** in `.claude/launch.json` (http://f5m.localhost:3001) |
| Messaggi di commit con virgolette rotti in PowerShell | Usare lo strumento Bash con heredoc (`git commit -F - <<'EOF'`) |
| Inserimenti automatici nel codice con `\n` che diventavano a capo veri | Controllare sempre la sintassi dopo (`node -e "require('./bot')"`), meglio usare Edit/Read |
| Il pacchetto `pg-mem` (test) non sa ricreare tabelle esistenti | Opzione `createSchema: false` nello strumento di copia |

---

## 6. Promemoria tecnici utili

- **Regole d'oro** (anche in `CLAUDE.md`): mai cambiare `classSuffix`, slug o segreto NFC di un locale esistente (per gli slug ora c'è il cambio con alias dal bot); segreti mai nel repo (è **pubblico**); `npm test` prima di pubblicare.
- **Anteprime**: `.claude/launch.json` (nella cartella sopra al repo) ha `loyalty-demo-clode` (porta 3000, PIN locale `1234`, dati in `data/`) e `f5m-landing` (porta 3001, landing su f5m.localhost).
- **Stile**: landing in `public/home.html` (tutto dentro, particelle in canvas 2D); dashboard/Cassa/QR usano `public/f5m.css` + regole proprie. Font da Bunny Fonts (privacy).
- **Variabili Render importanti**: `PUBLIC_URL=https://f5m.it`, `BRAND_NAME=F5M`, `SUPPORT_EMAIL`, `SHOP_DOMAIN` (commentata finché manca il certificato), `GOOGLE_SA_JSON`, `STAFF_PIN`, `TELEGRAM_BOT_TOKEN` (Secret File).
- **Documentazione**: se aggiorni `docs/SISTEMA.md` aggiorna anche `contesto/SISTEMA.md` sul PC (la copia nel repo non contiene i prezzi). Stesso discorso per questo file (`contesto/HANDOFF.md`).
