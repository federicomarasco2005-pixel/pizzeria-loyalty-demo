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

## Pubblicare
- **`npm test` deve passare** prima di ogni pubblicazione.
- **Prima di pubblicare mostra a Federico l'anteprima** e aspetta il suo "pubblica".
- Ogni push su `main` va online: GitHub lancia i test e, se passano, Render pubblica da solo in 1–2 minuti. Su `main` pubblica solo con l'ok di Federico; altrimenti lavora su un ramo o una pull request.
- Su Render **mai "Deploy a specific commit"**: spegne l'auto-deploy. Per pubblicare a mano: "Deploy latest commit".
- Dopo la pubblicazione controlla che il sito risponda: `curl https://f5m.it/api/config`.

## Comandi
```bash
npm install
npm test      # node:test, Postgres simulato con pg-mem
npm start     # porta 3000, dati in data/; senza .env niente Google né Telegram
```
