# Tessere fedeltà F5M — istruzioni per Claude

Servizio di tessere fedeltà digitali per locali (web + Google Wallet + timbro NFC + bot Telegram), online su https://f5m.it.
**All'inizio di ogni sessione leggi `docs/HANDOFF.md`**: stato attuale, cosa fare adesso, problemi già risolti.
**Prima di modifiche importanti leggi `docs/SISTEMA.md`**: architettura, dati, Wallet, NFC, bot, variabili d'ambiente, limiti noti.

Federico non è uno sviluppatore: rispondigli in italiano semplice e fai tu il lavoro tecnico. Login, pagamenti e DNS su Aruba li fa lui.

## Regole che non si violano
- **Mai cambiare `classSuffix`, `slug` o segreto NFC** di un locale esistente: le tessere nei Wallet e i chip NFC già scritti smetterebbero di funzionare.
- Il locale legacy `da-mario` usa archivio `db`, classe `pizzeria_demo_v1` e PIN da `STAFF_PIN`: non è eliminabile.
- **Segreti mai nel repository** (il repo è pubblico): `service-account.json`, `.env`, token del bot, PIN, `DATABASE_URL`. Stanno su Render.
- Nelle pagine di `public/` usa indirizzi **relativi** (`api/...`), per via di `<base href="/slug/">`. Unici assoluti voluti: `/style.css`, `/f5m.css` (stile F5M di dashboard, cassa e QR), `/common.js`, `/sw.js`, `/wallet-button-it.svg`.
- Il saldo dei timbri non si salva mai: si ricalcola dal ledger degli eventi (`db.js`).
- **Niente funzioni nuove fuori dal documento di scope** (https://claude.ai/artifact/RBSZgKsgR2jffbS5eSSGnw, si legge con gli strumenti docs). Durante interviste e pilota si lavora solo su nucleo, database, sicurezza, privacy ed errori. Un'idea nuova va tra le "idee parcheggiate" del documento, con la prova che manca.

## Pubblicare
- **`npm test` deve passare** prima di ogni pubblicazione.
- **Prima di pubblicare mostra a Federico l'anteprima** e aspetta il suo "pubblica".
- Ogni push su `main` va online: GitHub lancia i test e, se passano, Render pubblica da solo in 1–2 minuti. Su `main` pubblica solo con l'ok di Federico; altrimenti lavora su un ramo o una pull request.
- Su Render **mai "Deploy a specific commit"**: spegne l'auto-deploy. Per pubblicare a mano: "Deploy latest commit".
- Dopo la pubblicazione controlla che il sito risponda: `curl https://f5m.it/api/config`.

## Sessioni nel cloud: avvisa Federico a fine lavoro
Federico spesso avvia il lavoro dal telefono e poi chiude l'app. Se la variabile d'ambiente `F5M_AVVISI_TOKEN` esiste (c'è solo nell'ambiente cloud), **alla fine di ogni lavoro** mandagli un messaggio su Telegram (bot @AggiornaF5M_bot). Fallo anche quando ti fermi perché serve una sua decisione o un suo ok.
- Testo semplice, al massimo 6 righe: la prima dice ✅ fatto, ❓ serve una tua risposta oppure ⚠️ problema; poi cosa hai fatto, cosa resta da fare e la domanda, se c'è. Niente gergo.
- Scrivi il testo in UTF-8 in un file temporaneo fuori dal repository e invialo così:
  `curl -s -X POST "https://api.telegram.org/bot${F5M_AVVISI_TOKEN}/sendMessage" -d chat_id=8808507400 --data-urlencode text@/tmp/avviso.txt`
- Non stampare né salvare mai il valore di `F5M_AVVISI_TOKEN`.
- Eccezione: l'agente del mattino segue le sue istruzioni, che prevedono di scrivere solo quando serve.

## Comandi
```bash
npm install
npm test      # node:test, Postgres simulato con pg-mem
npm start     # porta 3000, dati in data/; senza .env niente Google né Telegram
```
