# Passaggio di consegne — F5M tessere fedeltà

*Aggiornato il 22 ottobre 2026. Leggi questo file per primo, poi `docs/SISTEMA.md` (architettura completa) e `CLAUDE.md` (regole).*

---

## 1. Chi è Federico e come lavorare con lui

- Non è uno sviluppatore. **Rispondi in italiano semplice**, frasi corte, niente gergo; fai tu tutto il lavoro tecnico.
- **Lui fa solo**: login (Render, GitHub, Aruba, Google, Neon…), pagamenti, modifiche DNS su Aruba (il sistema di sicurezza blocca Claude sulle modifiche DNS: preparagli i valori esatti e il modulo aperto).
- **Prima di pubblicare fagli vedere l'anteprima** e aspetta "pubblica". Lo ha chiesto più volte: anteprima locale nel browser integrato, poi commit + push solo con il suo ok.
- Gli piacciono le cose curate e "da prodotto vero"; prova lui da PC e da telefono e dà feedback visivo.

---

## 2. Dove stiamo (stato al 22/10/2026)

| Cosa | Stato |
|---|---|
| Sito | **https://f5m.it** online: landing scura F5M con particelle 3D interattive, demo interattiva, modulo "Richiedi una demo" (arriva sul bot), sezione Assistenza |
| Locali | `da-mario`, `eldorado`, `football` su `https://f5m.it/<indirizzo>/` (vecchio onrender.com ancora funzionante). **Il 21/10 il server ne conta 4** (`/api/config` → `shops: 4`): chiedere a Federico se ne ha creato uno dal bot |
| Sottodomini (`da-mario.f5m.it`) | Codice pronto e testato, DNS su Aruba fatto (`*`, `_acme-challenge`, `_cf-custom-hostname`), `*.f5m.it` aggiunto su Render. **Manca il certificato HTTPS di Render per `*.f5m.it`** (bloccato da giorni). Quando c'è: togliere il commento a `SHOP_DOMAIN` in `render.yaml` |
| Dashboard locali | Nuova grafica F5M "versione demo": Panoramica (iscritti, clienti, ultime operazioni), Notifiche "In arrivo", Impostazioni (recensioni, contatti) |
| Cassa e QR da tavolo | Nuova grafica F5M (stile comune in `public/f5m.css`). **Fotocamera della Cassa da provare su un telefono vero** |
| Google Wallet | **✅ Approvato da Google il 19/10** (email "F5M is approved to access Google Wallet API", pratica 05701322): qualsiasi account Android può salvare la tessera, tutti i locali e i buoni premio; i locali nuovi non richiedono altre richieste; la modalità demo non torna più. Da fare: prova con un account non di prova (Federico). Profilo attività completo: nome pubblico **F5M**, MCC 5734, sito, assistenza, email e telefono; profilo pagamenti "Privato" già esistente di Federico collegato. Logo F5M (`contesto/wallet-pubblicazione/logo-f5m-1024.png`) non risultava salvato: facoltativo, da ricaricare. Provato da Federico sul suo Android il 16/10: funziona. Novità 16/10: logo largo generato per tutti i locali (font Inter in `fonts/`), testi in inglese, **buono premio** collegato (Offer) con link "🎁 Ritira il premio" (`?premio=1`) |
| Tessera web | Nuova (16/10): apertura immediata dalla copia salvata (service worker), premio + barra sul fronte, retro con QR (la carta si gira), QR a tutto schermo con schermo acceso, riflesso lucido, ultime visite, modalità scura, inglese (`?lang=en`), "Privacy e impostazioni" chiuso in fondo |
| Database | **Postgres gratuito di Render: scade ~31 ottobre 2026**, cancellato ~14 novembre. Nessun backup automatico tranne quello settimanale sul bot. Il 21/10 Federico ha detto "per ora non farlo"; il 22/10 ha fissato lo spostamento **entro il 28–29/10** (servono ~30 minuti; dal 24/10 l'agente del mattino lo ricorda su Telegram) |
| Validazione (21/10) | Analisi con il **Founder's Playbook** di Anthropic: il prodotto è da fase MVP, ma la fase Idea non è chiusa (nessuna intervista scritta, nessun locale vero, nessun ricavo). Piano: fermare le nuove funzioni, intervistare 10–12 locali, poi pilota con 3–5 locali paganti. **Kit interviste** pronto in un documento privato: https://claude.ai/artifact/N7H4vAeWMW5wPLTaGbG8q7 (scheda principale = kit; scheda "Trento nord" = 42 locali in 4 giri con stato, contatti e messaggi). Zona scelta da Federico: **Trento nord**. **Documento di scope** (21/10, privato): https://claude.ai/artifact/RBSZgKsgR2jffbS5eSSGnw (cosa fa F5M, cosa non fa, le tre prove per aggiungere una funzione, idee parcheggiate). Il 22/10: ipotesi, concorrenti e prezzo del pilota pronti nel kit |
| Server | Render gratuito: si addormenta dopo 15 min e al risveglio Render mostra la sua pagina "SERVICE WAKING UP" (~30–50 s). Proposto un pinger gratuito (cron-job.org su `https://f5m.it/api/cron` ogni 10 min, 744 h/mese stanno nelle 750 gratuite) o Starter 7 $/mese: Federico il 16/10 ha detto **di no per ora** |
| Test | 33 test, tutti verdi (`npm test`) |
| Pubblicazione | `git push` da questo PC funziona; Render pubblica da solo dopo i test (app Render installata su GitHub) |
| Plancia e agente (18/10) | **Plancia sul PC** (quella che usa Federico): icona "Plancia progetti" sul desktop → `plancia/plancia.html`, rigenerata ogni ora da `plancia/genera.js` (attività di Windows "Plancia progetti"; grafica in `plancia/modello.html`, test una volta al giorno). `genera.js` è sparito dal PC la sera del 19/10 e la Plancia è rimasta ferma fino al 21/10, quando è stato ricreato: se la data "Aggiornata" in alto è vecchia, controllare che il file esista. Le parti scritte a mano stanno in `plancia/dati.json`: **aggiornarle a fine sessione**. Copia online privata: https://claude.ai/artifact/WhL3toHeEeWei68vNqvoGd (separata dal sito). **Agente del mattino** nel cloud (routine `trig_01RVyQGptw7ZibaH4dZ5cVxc`, ogni giorno 06:00 UTC, solo lettura, mai push) che aggiorna la Plancia e scrive su Telegram (@AggiornaF5M_bot) solo se serve: sempre il lunedì, sempre negli ultimi 7 giorni prima del 31/10 se il database non è spostato, altrimenti solo se c'è un problema (silenzio = tutto ok). Verificato il 21/10: messaggi del 19 e 21 consegnati. Il 21/10 corretto il prompt: leggere i file della Plancia un `path` alla volta (con `paths` la lettura falliva e la Plancia online non si aggiornava). Token del bot solo nella variabile `F5M_AVVISI_TOKEN` dell'ambiente cloud, mai nel repo |
| Timbro 3D | La versione del 16/10 (kit di stampa, `serve.js`) è **persa** nel ripristino delle 20:05; resta una versione più vecchia in `timbro-3d/timbro.html` e la bozza dell'11/10 su claude.ai |

---

## 3. Cosa fare adesso (in ordine di urgenza)

1. **🔴 Database prima del 31 ottobre.** Piano scelto: **Neon gratuito** (non scade). Federico l'ha fissato **entro il 28–29/10**.
   - Federico: crea account su neon.tech (con GitHub) → tu crei il progetto a Francoforte.
   - Copia dati: `tools/copia-database.ps1` (chiede le due stringhe a schermo, le incolla lui; verifica "IDENTICO" tabella per tabella; il vecchio DB non viene toccato).
   - Federico incolla la stringa Neon in `DATABASE_URL` su Render. **Attenzione**: in `render.yaml` `DATABASE_URL` è `fromDatabase` → cambiarla in `sync: false`, altrimenti il Blueprint la rimette com'era. Poi verifica avvio, clienti, un timbro di prova. Prima di tutto: `/backup` dal bot.
   - Nello stesso database ci sono anche le richieste di demo arrivate dal sito (chiave `leads`).
2. **🟠 Validazione con i locali (Founder's Playbook)** — la cosa più importante dopo il database:
   - **Niente nuove funzioni** finché un locale vero non le chiede (Playbook p. 17–18). Le regole sono nel **documento di scope** (fatto il 21/10, link sopra): una funzione nuova entra solo se la chiedono almeno 3 locali diversi, la richiesta poggia su un fatto (soldi o tempo già spesi, locale che non parte senza, data e prezzo) e non basta quello che c'è. Un'idea nuova va tra le "idee parcheggiate" del documento, non nel codice. Ammessi senza prove: database, sicurezza, privacy, server sveglio negli orari dei locali, errori e piccoli ritocchi.
   - **Interviste**: Federico usa il kit (link sopra), 10–12 titolari di Trento nord, domande sul passato. Claude aiuta con la sintesi ogni 5 interviste (prompt pronto nel kit) e tiene aggiornato il registro.
   - Soglie decise prima di iniziare (nel kit): "regge" se almeno metà ha già speso soldi o tempo sul problema e almeno 3 accettano un pilota a pagamento con una data.
   - Poi **pilota con 3–5 locali veri, non amici, paganti** (bonifico, niente Stripe da costruire) e metriche decise prima (Playbook p. 19).
3. **🟠 Sicurezza (dalla revisione del 14/10)** — da fare prima del primo locale vero:
   - **QR della tessera = chiave completa**: chi fotografa il QR mostrato in cassa può esportare i dati (email), cancellare la tessera, usare il premio. Fare un codice separato per il QR (valido solo in Cassa con PIN), mantenendo compatibili i QR già emessi.
   - **Cassa carica `html5-qrcode` da unpkg senza controllo d'integrità** → copia locale in `public/` (o hash SRI).
   - **Blocco PIN solo in memoria** (si azzera a ogni riavvio, frequente sul piano gratuito) → salvarlo nel database + limite per locale. Verificare che `STAFF_PIN` su Render sia impostato (altrimenti da-mario ha PIN `1234`).
   - Minori: PIN nell'URL degli avvisi live della Cassa (`api/staff/stream?pin=`), mancano header di sicurezza (frame-ancestors, nosniff, referrer), `/api/cron` pubblico.
   - **Privacy**: manca l'accordo scritto con ogni locale (nomina a responsabile del trattamento) e i testi legali non sono verificati da un consulente (vedi `docs/SISTEMA.md` §7).
4. **✅ Google Wallet approvato il 19/10.** Resta solo la prova di Federico: salvare la tessera con un account Android non di prova. Un solo issuer per tutti i locali. Apple Wallet (99 €/anno, nessuna approvazione Apple): consigliato quando c'è il primo locale vero, dopo database e sicurezza.
5. **🟡 Certificato `*.f5m.it`.** Se ancora assente: farsi mostrare da Federico lo stato del dominio nel pannello Render (a Claude la sezione domini non compare perché il servizio è gestito dal Blueprint) o scrivere al supporto Render.
6. **🟡 Da verificare con Federico**: fotocamera della Cassa su telefono vero; effetto tocco delle particelle su telefono vero; quale sia il **4° locale** sul server. (Wallet su Android: provato il 16/10, ok.)
7. **🟡 Timbro NFC fisico (prototipo 3D)**: in `timbro-3d/` sul PC (non nel repo, non pubblicato: Federico ha detto di non pubblicarlo). Sigillo classico manico legno + testa ottone con chip NTAG Ø 25 nella faccia, supporto rotondo con il nome. Si apre con la configurazione `timbro-3d` di `.claude/launch.json` (porta 3002) o `node timbro-3d/serve.js`. Pulsante "Kit di stampa" = ZIP con 3 STL + adesivo PNG. Prossimo passo: stampa di prova per confermare le misure.
8. **Più avanti** (solo dopo il pilota, quando c'è budget): server Render Starter ~7 $/mese (via l'attesa di 50 s), Apple Wallet, chip NFC NTAG 424 DNA, Stripe per gli abbonamenti, email automatiche (Brevo), prezzi sulla landing (non ancora decisi).

---

## 4. Cosa è stato fatto in queste sessioni (9–22 ottobre)

- Progetto spostato sul nuovo PC, Node 24 + Git installati, cartella collegata a GitHub.
- **Tessera web istantanea** (dati nella pagina, saldo nell'avviso live, niente attese di Google) e **Wallet più veloce** (GIF in un thread separato e preparate all'avvio, aggiornamenti in coda).
- Bot: avviso solo per **nuova versione** (non a ogni risveglio), **kit di lancio PDF**, **report mensile PDF**, **messaggi automatici** ("Ti manca 1 timbro", recensione dopo la 3ª visita, "Ci manchi" a 21 giorni con consenso), scontrino medio, cambio indirizzo del locale, interruttore "premio dal telefono del cliente".
- **"Usa il premio"** dalla tessera: schermata PREMIO VALIDO animata (anti-screenshot); il cliente annulla entro 5 minuti ma non dopo aver toccato "Fatto"; poi solo la Cassa.
- Dominio **f5m.it** comprato su Aruba, collegato a Render, sito ufficiale F5M, sottodomini pronti.
- Nuova grafica per **dashboard, Cassa, QR da tavolo**.
- Strumento di **copia verificata del database** (`tools/copia-database.js` + `.ps1`).
- 16/10: tessera web rifatta ("carta vera", vedi tabella), Wallet con logo largo per tutti, inglese e buono premio; premio dal telefono: "Fatto" lo rende definitivo (`customer.redeemClosed`); prototipo 3D del timbro NFC.
- 18/10: Plancia sul PC, agente del mattino nel cloud, avvisi Telegram a fine lavoro per le sessioni nel cloud.
- 19/10: Google Wallet approvato.
- 21/10: controllo generale (sito, Wallet attivo, 33 test verdi, avvisi Telegram consegnati); ricreato `plancia/genera.js`; ripristinato `CLAUDE.md` sul PC (aveva perso la sezione "Sessioni nel cloud"); corretto il prompt dell'agente del mattino.
- 21/10: analisi della piattaforma con il **Founder's Playbook** (fase, criteri d'uscita, passi saltati); **kit interviste** (profilo del locale, domande, scheda appunti, registro, messaggi, segnali) e **elenco di 42 locali di Trento nord** con contatti per scrivere, tutto nel documento privato su claude.ai. Consiglio su Apple Wallet: farlo dopo database e sicurezza, quando parte il primo locale vero.
- 21/10: **documento di scope** (privato su claude.ai): per chi è F5M, il nucleo del pilota, cosa non fa, lavori ammessi senza prove, le tre prove per aggiungere una funzione, idee parcheggiate (Apple Wallet ora richiede una prova dal pilota), quando si rivede. Copia sul PC: `contesto/SCOPE.md`.
- 21–22/10: nel kit interviste privato tre schede nuove: **Ipotesi e avvocato del diavolo**, **Concorrenti e lamentele** (almeno 6 servizi di tessere su Wallet senza app a 0–15 €/mese; SumUp Fedeltà gratis per chi ha il POS SumUp; nessuno con timbro NFC; Couponoo, Tesserando e Fedelya non risultano) e **Prezzo del pilota** (deciso da Federico il 22/10; le cifre stanno solo nel kit e in `contesto/`). Rilanci su SumUp, Satispay e tessere sul telefono aggiunti alle domande 7 e 9.
- 22/10: scritta la prima memoria di Claude (era vuota); `docs/SISTEMA.md` riportato allo stato attuale (era fermo al 9/10); aggiunto un `CLAUDE.md` in `Desktop\Clode`, la cartella da cui partono le sessioni sul PC.

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
| Dopo modifiche alla tessera l'anteprima mostra la versione vecchia | Il service worker apre la tessera dalla copia salvata: nel browser di anteprima svuotare le cache (`caches.keys()` → `caches.delete`) prima di ricaricare |
| Il browser di anteprima chiude da solo i `confirm()` | Normale: per provare "Usa il premio" sostituire `window.confirm` da JS |
| File del PC tornati indietro o spariti senza motivo (16/10 alle 20:05: codice riportato al commit `4dd657c`; 19/10 verso le 23:07: sparito `plancia/genera.js`, `CLAUDE.md` modificato) | Causa sconosciuta, nessuna sessione di Claude. **A inizio sessione `git status`** in `loyalty-demo/`: se ci sono modifiche che non riconosci, confrontale con i commit (`git diff <commit>`) prima di toccarle e ripristina con `git checkout HEAD -- <file>`; GitHub ha sempre la versione buona |
| Google Maps nel browser integrato non carica le schede dei locali | Succede quando il pannello del browser è **nascosto**: la lista dei risultati funziona, le schede no. Per telefoni e contatti usare la ricerca Google normale (pagina testuale) |
| Google chiede "non sono un robot" dopo ~35 ricerche di fila | **Non superarlo mai**: fermarsi; per poche ricerche ancora usare Bing |
| Numeri ed email nel "riassunto AI" di Google | A volte sono sbagliati (es. un'email su un dominio che non esiste): segnarli "da confermare"; tenere separati quelli pubblicati dal locale. Escludere email con nome e cognome di persone e le partite IVA (11 cifre che iniziano con 0) |
| Leggere un PDF sul PC | Mancano `pdftoppm` e Python: installare `pdfjs-dist` in una cartella temporanea (scratchpad) ed estrarre il testo con uno script Node |
| Pagine su claude.ai (artifact): niente download diretti né `fetch` esterni | Usare la capacità `downloads` (solo alcuni formati: STL no, ZIP sì) e includere i dati nella pagina |
| Sessione aperta in `Desktop\Clode` (un livello sopra il progetto): `CLAUDE.md` e HANDOFF non venivano letti da soli | Dal 22/10 c'è un `CLAUDE.md` anche in `Desktop\Clode` che rimanda a `Clode/CLAUDE.md` e a questo file |

---

## 6. Promemoria tecnici utili

- **Regole d'oro** (anche in `CLAUDE.md`): mai cambiare `classSuffix`, slug o segreto NFC di un locale esistente (per gli slug ora c'è il cambio con alias dal bot); segreti mai nel repo (è **pubblico**); `npm test` prima di pubblicare.
- **Anteprime**: `.claude/launch.json` (nella cartella sopra al repo) ha `loyalty-demo-clode` (porta 3000, PIN locale `1234`, dati in `data/`) e `f5m-landing` (porta 3001, landing su f5m.localhost).
- **Stile**: landing in `public/home.html` (tutto dentro, particelle in canvas 2D); dashboard/Cassa/QR usano `public/f5m.css` + regole proprie. Font da Bunny Fonts (privacy).
- **Variabili Render importanti**: `PUBLIC_URL=https://f5m.it`, `BRAND_NAME=F5M`, `SUPPORT_EMAIL`, `SHOP_DOMAIN` (commentata finché manca il certificato), `GOOGLE_SA_JSON`, `STAFF_PIN`, `TELEGRAM_BOT_TOKEN` (Secret File).
- **Documentazione**: se aggiorni `docs/SISTEMA.md` aggiorna anche `contesto/SISTEMA.md` sul PC (la copia nel repo non contiene i prezzi). Stesso discorso per questo file: `contesto/HANDOFF.md` ha in più una sezione privata (strategia, prezzi del pilota) che **non va mai nel repo pubblico**. Mai nel repo neanche i contatti dei locali: stanno solo nel documento privato su claude.ai.
- **Documenti privati su claude.ai**: documento di scope https://claude.ai/artifact/RBSZgKsgR2jffbS5eSSGnw (da rileggere prima di proporre funzioni nuove; copia sul PC: `contesto/SCOPE.md`); kit interviste + elenco Trento nord https://claude.ai/artifact/N7H4vAeWMW5wPLTaGbG8q7 (si modifica con gli strumenti "docs"; copia sul PC delle schede senza contatti: `contesto/VALIDAZIONE.md`); Plancia online https://claude.ai/artifact/WhL3toHeEeWei68vNqvoGd.
