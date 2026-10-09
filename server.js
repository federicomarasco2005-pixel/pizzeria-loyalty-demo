require('dotenv').config();
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const express = require('express');
const QRCode = require('qrcode');
const db = require('./db');
const shops = require('./shops');
const images = require('./images');
const wallet = require('./wallet');
const bot = require('./bot');

const PORT = Number(process.env.PORT) || 3000;
// Su Render RENDER_EXTERNAL_URL è impostata automaticamente.
const PUBLIC_URL = (process.env.PUBLIC_URL || process.env.RENDER_EXTERNAL_URL || `http://localhost:${PORT}`).replace(/\/$/, '');
const STAMP_COOLDOWN_SEC = Number(process.env.STAMP_COOLDOWN_SEC) || 0;

// Più locali sullo stesso server: ogni locale ha le sue pagine sotto /<slug>/ (es. /da-mario/, /bar-luna/).
// In tutto il codice "ctx" è il locale della richiesta: ctx.shop (scheda), ctx.db (clienti), ctx.cfg (configurazione).

const app = express();
app.set('trust proxy', 1); // Render è dietro proxy: serve per sapere se la richiesta è HTTPS
app.use(express.json({ limit: '2mb' }));

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const wrap = (fn) => (req, res, next) => fn(req, res, next).catch(next);
const PUBLIC_DIR = path.join(__dirname, 'public');

// ---------- Vecchi indirizzi (prima che ci fossero più locali) ----------
// Le tessere già nel Wallet, le icone già installate e il timbro NFC già scritto usano ancora questi link.

const legacy = () => `/${shops.defaultSlug()}`;
const query = (req) => (req.originalUrl.includes('?') ? req.originalUrl.slice(req.originalUrl.indexOf('?')) : '');

app.get('/', (req, res) => res.redirect(`${legacy()}/`));
for (const [file, page] of [['/index.html', ''], ['/staff.html', 'staff'], ['/admin.html', 'admin'], ['/poster.html', 'poster']]) {
  app.get(file, (req, res) => res.redirect(`${legacy()}/${page}`));
}
app.get('/card/:token', (req, res) => {
  const found = shops.findByToken(req.params.token);
  res.redirect(`/${found ? found.ctx.shop.slug : shops.defaultSlug()}/card/${encodeURIComponent(req.params.token)}${query(req)}`);
});
app.get('/tap/:secret', (req, res) => {
  const ctx = shops.findByNfcSecret(req.params.secret);
  res.redirect(`/${ctx ? ctx.shop.slug : shops.defaultSlug()}/tap/${encodeURIComponent(req.params.secret)}`);
});
// Controllo di salute di Render e ping esterno (tiene sveglio il server gratuito)
app.get('/api/config', (req, res) => res.json({ ok: true, shops: shops.all().length, walletEnabled: wallet.enabled() }));
app.get('/api/cron', wrap(async (req, res) => {
  await processDueCampaigns();
  res.json({ ok: true });
}));

bot.mount(app);
app.use(express.static(PUBLIC_DIR, { index: false }));

// ---------- Pagine del locale ----------

// Le pagine sono le stesse per tutti i locali: il server aggiunge l'indirizzo di base (<base href="/slug/">),
// colori, icona dei timbri ed emoji del locale.
// Nella pagina c'è già anche la configurazione del locale (window.CFG) e, per la tessera, i suoi dati (window.CARD):
// la pagina si disegna subito, senza aspettare altre richieste al server.
const pageFiles = new Map(); // file -> contenuto (letto una volta)
const readPage = (file) => {
  if (!pageFiles.has(file)) pageFiles.set(file, fs.readFileSync(path.join(PUBLIC_DIR, file), 'utf8'));
  return pageFiles.get(file);
};
// JSON dentro <script>: "<" scritto come <, così un testo con "</script>" non chiude il blocco
const inlineJson = (v) => JSON.stringify(v).replace(/</g, '\\u003c');

function page(file, extra) {
  return wrap(async (req, res) => {
    const { cfg } = req.ctx;
    const data = { SHOP: { slug: cfg.slug, legacy: !!req.ctx.shop.legacy, prefix: cfg.codePrefix }, CFG: publicConfig(cfg) };
    if (extra) Object.assign(data, await extra(req, res));
    // dopo style.css, così questi valori hanno la precedenza
    const vars = `<style>:root { --brand: ${cfg.brandColor}; --stamp-on: url(/${cfg.slug}/stamps/icon.png?v=${cfg.imgVersion}); --stamp-off: url(/${cfg.slug}/stamps/icon-empty.png?v=${cfg.imgVersion}); }</style>`;
    let html = readPage(file).replace('</head>', `  ${vars}\n</head>`)
      .replace(/#b3261e/g, cfg.brandColor)
      .replace(/🍕/g, cfg.emoji)
      .replace(/PZ-/g, `${cfg.codePrefix}-`);
    // i dati si aggiungono dopo le sostituzioni, così restano intatti
    const head = `<base href="/${cfg.slug}/">
  <script>${Object.entries(data).map(([k, v]) => `window.${k} = ${inlineJson(v)};`).join(' ')}</script>`;
    html = html.replace('<head>', `<head>\n  ${head}`);
    res.type('html').set('Cache-Control', 'no-cache').send(html);
  });
}

const shop = express.Router({ mergeParams: true });
app.use('/:slug', (req, res, next) => {
  const ctx = shops.get(req.params.slug);
  if (!ctx) return next();
  req.ctx = ctx;
  shop(req, res, next);
});

shop.get('/', page('index.html'));
for (const name of ['staff', 'admin', 'poster']) {
  shop.get([`/${name}`, `/${name}.html`], page(`${name}.html`));
}
shop.get('/card/:token', page('card.html', async (req, res) => {
  const customer = req.ctx.db.findByToken(req.params.token);
  if (!customer) return {};
  setCardCookie(req, res, customer.token); // aprire la tessera "collega" questo telefono
  return { CARD: await cardData(req.ctx, customer) };
}));
shop.get(['/privacy', '/privacy.html'], page('privacy.html'));
shop.get('/tap/:secret', page('tap.html'));

// Immagini del locale (generate al volo, vedi images.js)
async function sendImage(req, res, file) {
  const img = await images.get(shops.imageSpec(req.ctx.shop), file);
  if (!img) return res.status(404).end();
  res.type(img.type).set('Cache-Control', 'public, max-age=3600').send(img.buf);
}
shop.get('/logo.png', wrap((req, res) => sendImage(req, res, 'logo.png')));
shop.get('/stamps/:file', wrap((req, res) => sendImage(req, res, `stamps/${req.params.file}`)));
shop.get('/icons/:file', wrap((req, res) => sendImage(req, res, `icons/${req.params.file}`)));
shop.get('/wide-logo.png', (req, res) => {
  if (!req.ctx.shop.legacy) return res.status(404).end();
  res.sendFile(path.join(PUBLIC_DIR, 'wide-logo.png'));
});

// App "Cassa" installabile sul telefono del locale
shop.get('/manifest.json', (req, res) => {
  const { cfg } = req.ctx;
  res.type('application/manifest+json').json({
    name: `Cassa ${cfg.pizzeriaName}`, short_name: 'Cassa', start_url: `/${cfg.slug}/staff`, scope: `/${cfg.slug}/`,
    display: 'standalone', background_color: '#fbf6ee', theme_color: cfg.brandColor,
    icons: [{ src: `/${cfg.slug}/icons/icon-512.png`, sizes: '512x512', type: 'image/png' }],
  });
});

// ---------- Riconoscere il telefono del cliente ----------
// Oltre alla memoria della pagina (localStorage) salviamo la tessera in un cookie del server:
// su iPhone Safari può cancellare la memoria delle pagine dopo 7 giorni senza visite,
// mentre i cookie impostati dal server durano molto di più. Serve al timbro NFC.
// Un cookie per locale (card_<slug>); il primo locale legge anche il vecchio cookie "card".
const cookieName = (ctx) => `card_${ctx.shop.slug.replace(/[^a-z0-9]/g, '_')}`;
function getCookie(req, name) {
  const m = (req.headers.cookie || '').match(new RegExp(`(?:^|;\\s*)${name}=([^;]+)`));
  return m ? decodeURIComponent(m[1]) : null;
}
function getCardCookie(req) {
  return getCookie(req, cookieName(req.ctx)) || (req.ctx.shop.legacy ? getCookie(req, 'card') : null);
}
function setCardCookie(req, res, token) {
  const secure = req.secure ? '; Secure' : '';
  res.append('Set-Cookie', `${cookieName(req.ctx)}=${encodeURIComponent(token)}; Max-Age=34560000; Path=/; HttpOnly; SameSite=Lax${secure}`);
}

// Dati di iscrizione validati (usato dall'iscrizione normale e da quella al timbro NFC)
function readSignup(body) {
  const name = String(body.name || '').trim().slice(0, 60);
  const email = String(body.email || '').trim().toLowerCase().slice(0, 120);
  if (!name) return { error: 'Inserisci il tuo nome.' };
  if (!EMAIL_RE.test(email)) return { error: 'Email non valida.' };
  if (!body.acceptTerms) return { error: 'Devi accettare il regolamento per iscriverti.' };
  return { name, email, consentMarketing: !!body.consentMarketing };
}

// ---------- Cliente ----------

function publicConfig(cfg) {
  return {
    pizzeriaName: cfg.pizzeriaName,
    programName: cfg.programName,
    rewardText: cfg.rewardText,
    stampsForReward: cfg.stampsForReward,
    brandColor: cfg.brandColor,
    emoji: cfg.emoji,
    walletEnabled: wallet.enabled(),
  };
}
shop.get('/api/config', (req, res) => res.json(publicConfig(req.ctx.cfg)));

shop.post('/api/signup', wrap(async (req, res) => {
  const ctx = req.ctx;
  const data = readSignup(req.body);
  if (data.error) return res.status(400).json({ error: data.error });

  // Email già iscritta: la tessera NON viene restituita (chi conosce l'email di un altro non deve poterla aprire).
  // Per ritrovarla servono codice tessera + email (/api/recover).
  if (ctx.db.findByEmail(data.email)) {
    return res.status(409).json({
      emailExists: true,
      error: 'Con questa email c\'è già una tessera. Inserisci il codice tessera (lo trovi nel Wallet o sulla tessera) per riaprirla.',
    });
  }
  const customer = ctx.db.createCustomer(data);

  // la tessera Wallet si crea in parallelo: il cliente vede subito la sua tessera web
  syncWallet(ctx, customer);
  setCardCookie(req, res, customer.token);
  res.json({ token: customer.token });
}));

// Ritrova la tessera con codice + email (telefono nuovo, tessera persa). Tentativi limitati.
shop.post('/api/recover', (req, res) => {
  const { ctx } = req;
  const k = `recover|${ctx.shop.slug}|${req.ip}`;
  const lock = attempts.check(k);
  if (lock) return res.status(429).json({ error: `Troppi tentativi: riprova tra ${lock} minuti.` });
  const customer = findByCode(ctx, req.body.code, req.body.email);
  if (!customer) {
    attempts.fail(k);
    return res.status(404).json({ error: 'Codice o email non corretti.' });
  }
  attempts.ok(k);
  setCardCookie(req, res, customer.token);
  res.json({ token: customer.token });
});

// Codice tessera scritto in qualsiasi modo ("ab12c", "PZ-AB12C", "pz ab12c") + email
function findByCode(ctx, rawCode, rawEmail) {
  const prefix = ctx.cfg.codePrefix;
  const raw = String(rawCode || '').trim().toUpperCase().replace(/[\s-]/g, '');
  const code = `${prefix}-${raw.replace(new RegExp(`^${prefix}`), '')}`;
  return ctx.db.findByCodeAndEmail(code, String(rawEmail || '').trim().toLowerCase());
}

// ---------- Privacy: i dati del cliente, scaricabili e cancellabili da lui stesso ----------
shop.get('/api/card/:token/export', (req, res) => {
  const { ctx } = req;
  const customer = ctx.db.findByToken(req.params.token);
  if (!customer) return res.status(404).json({ error: 'Tessera non trovata.' });
  const data = { locale: ctx.cfg.pizzeriaName, esportato: new Date().toISOString(), ...ctx.db.exportCustomer(customer.id) };
  res.set('Content-Disposition', `attachment; filename="tessera-${customer.code}.json"`).json(data);
});

// Consenso alle offerte: il cliente lo può dare o revocare dalla sua tessera
shop.post('/api/card/:token/consent', (req, res) => {
  const { ctx } = req;
  const customer = ctx.db.findByToken(req.params.token);
  if (!customer) return res.status(404).json({ error: 'Tessera non trovata.' });
  const on = req.body.consentMarketing === true;
  ctx.db.updateCustomer(customer.id, { consentMarketing: on, consentAt: new Date().toISOString() });
  res.json({ consentMarketing: on });
});

// Contatto del locale (pagina privacy)
shop.get('/api/contact', (req, res) => res.json({ phone: req.ctx.db.getSettings().phone || null }));

shop.post('/api/card/:token/delete', wrap(async (req, res) => {
  const { ctx } = req;
  const customer = ctx.db.findByToken(req.params.token);
  if (!customer) return res.status(404).json({ error: 'Tessera non trovata.' });
  if (req.body.confirm !== true) return res.status(400).json({ error: 'Conferma richiesta.' });
  await removeCustomer(ctx, customer);
  res.append('Set-Cookie', `${cookieName(ctx)}=; Max-Age=0; Path=/`);
  res.json({ ok: true });
}));

// Cancella un cliente: tessera Wallet disattivata, dati eliminati
async function removeCustomer(ctx, customer) {
  clearTimeout(settleTimers.get(customer.id));
  qrCache.delete(customer.token);
  await ctx.db.deleteCustomer(customer.id);
  // prima finiscono gli aggiornamenti del pass già partiti (quelli in coda vedono il cliente cancellato e saltano),
  // poi il pass si disattiva: nessun aggiornamento può riattivarlo dopo
  await walletQueues.get(customer.id);
  if (wallet.enabled()) await wallet.deactivate(customer).catch((err) => console.error(`[wallet] ${err.message}`));
  console.log(`[privacy] ${ctx.shop.slug}: cliente ${customer.code} cancellato`);
}

shop.get('/api/card/:token', wrap(async (req, res) => {
  const { ctx } = req;
  const customer = ctx.db.findByToken(req.params.token);
  if (!customer) return res.status(404).json({ error: 'Tessera non trovata.' });
  setCardCookie(req, res, customer.token); // aprire la tessera "collega" questo telefono
  res.json(await cardData(ctx, customer));
}));

// Versione della tessera: cresce a ogni operazione. La pagina ignora una risposta più vecchia di
// quello che già mostra (es. una lettura partita prima di un timbro arrivato in tempo reale).
const versionOf = (ctx, customer) => ctx.db.eventsOf(customer.id).length;

// QR della tessera: il token non cambia mai, si disegna una volta sola
const qrCache = new Map();
async function qrOf(token) {
  if (!qrCache.has(token)) {
    if (qrCache.size > 2000) qrCache.delete(qrCache.keys().next().value);
    qrCache.set(token, await QRCode.toDataURL(token, { margin: 1, width: 360 }));
  }
  return qrCache.get(token);
}

// Dati della tessera web (API e pagina). Non aspetta mai Google: se la tessera è nel Wallet lo
// si scopre in background e la pagina viene avvisata in tempo reale.
async function cardData(ctx, customer) {
  const state = ctx.db.stateOf(customer.id, ctx.cfg.stampsForReward);
  checkWalletSaved(ctx, customer);
  return {
    name: customer.name,
    code: customer.code,
    stamps: state.stamps,
    rewards: state.rewards,
    stampsForReward: ctx.cfg.stampsForReward,
    v: versionOf(ctx, customer),
    qr: await qrOf(customer.token),
    saveUrl: wallet.enabled() ? wallet.saveUrl(customer) : null,
    walletSaved: !!customer.walletSaved,
    reviewUrl: ctx.db.getSettings().reviewUrl || null,
    messages: ctx.db.messagesFor(customer.id).slice(0, 5),
    consentMarketing: !!customer.consentMarketing,
  };
}

// Aggiornamenti in tempo reale per la tessera web (Server-Sent Events).
const streams = new Map(); // token -> Set di risposte aperte (i token sono unici fra tutti i locali)

shop.get('/api/card/:token/stream', (req, res) => {
  const { token } = req.params;
  if (!req.ctx.db.findByToken(token)) return res.status(404).end();
  res.set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
  res.flushHeaders();
  res.write('retry: 3000\n\n');
  if (!streams.has(token)) streams.set(token, new Set());
  streams.get(token).add(res);
  const ping = setInterval(() => res.write(': ping\n\n'), 25000);
  req.on('close', () => {
    clearInterval(ping);
    streams.get(token).delete(res);
  });
});

// L'evento contiene già il nuovo saldo: la tessera aperta lo mostra subito, senza chiedere altro al server.
function broadcast(ctx, customer, type, extra = {}) {
  const clients = streams.get(customer.token);
  if (!clients || !clients.size) return;
  const n = ctx.cfg.stampsForReward;
  const s = ctx.db.stateOf(customer.id, n);
  const payload = `data: ${JSON.stringify({ type, stamps: s.stamps, rewards: s.rewards, stampsForReward: n, v: versionOf(ctx, customer), ...extra })}\n\n`;
  clients.forEach((res) => res.write(payload));
}

// La tessera è già nel Google Wallet del cliente? Una volta confermato da Google resta salvato;
// prima di allora si chiede a Google al massimo ogni 20 secondi, in background.
const savedChecks = new Map(); // customerId -> timestamp ultimo controllo
function checkWalletSaved(ctx, customer) {
  if (customer.walletSaved || !wallet.enabled()) return;
  const last = savedChecks.get(customer.id) || 0;
  if (Date.now() - last < 20000) return;
  savedChecks.set(customer.id, Date.now());
  wallet.isSaved(customer).then((saved) => {
    if (!saved || !ctx.db.findByToken(customer.token)) return;
    ctx.db.updateCustomer(customer.id, { walletSaved: true });
    broadcast(ctx, customer, 'wallet'); // la tessera web nasconde il pulsante "Aggiungi a Google Wallet"
  }, () => {});
}

// La tessera web si può installare sul telefono come un'app (icona sulla schermata Home),
// senza store: questo "manifest" dice al telefono nome, icona e indirizzo della tessera.
shop.get('/card/:token/manifest.webmanifest', (req, res) => {
  const { ctx } = req;
  const { cfg } = ctx;
  if (!ctx.db.findByToken(req.params.token)) return res.status(404).end();
  const base = `/${cfg.slug}`;
  const v = `?v=${cfg.imgVersion}`;
  res.type('application/manifest+json').json({
    name: `Tessera ${cfg.pizzeriaName}`,
    short_name: `Tessera ${cfg.emoji}`,
    description: `${cfg.programName}: i tuoi timbri sempre a portata di mano`,
    id: `${base}/card/${req.params.token}`,
    start_url: `${base}/card/${req.params.token}`,
    scope: `${base}/`,
    display: 'standalone',
    orientation: 'portrait',
    background_color: cfg.brandColor,
    theme_color: cfg.brandColor,
    icons: [
      { src: `${base}/icons/icon-192.png${v}`, sizes: '192x192', type: 'image/png', purpose: 'any' },
      { src: `${base}/icons/icon-512.png${v}`, sizes: '512x512', type: 'image/png', purpose: 'any' },
      { src: `${base}/icons/icon-512.png${v}`, sizes: '512x512', type: 'image/png', purpose: 'maskable' },
    ],
  });
});

shop.get('/api/poster-qr', wrap(async (req, res) => {
  const url = `${req.ctx.cfg.baseUrl}/`;
  res.json({ url, qr: await QRCode.toDataURL(url, { margin: 1, width: 800 }) });
}));

// ---------- Staff / Admin (protetti dal PIN del locale) ----------

// Tentativi sbagliati (PIN, recupero tessera): dopo 5 errori dallo stesso indirizzo, blocco di 15 minuti.
const attempts = {
  map: new Map(), MAX: 5, LOCK_MS: 15 * 60 * 1000,
  check(k) {
    const f = this.map.get(k);
    return f && f.until > Date.now() ? Math.ceil((f.until - Date.now()) / 60000) : 0;
  },
  fail(k) {
    const f = this.map.get(k);
    const n = f && !(f.until && f.until <= Date.now()) ? f.n + 1 : 1;
    const until = n >= this.MAX ? Date.now() + this.LOCK_MS : 0;
    this.map.set(k, { n, until });
    if (this.map.size > 5000) this.map.delete(this.map.keys().next().value);
    return !!until;
  },
  ok(k) { this.map.delete(k); },
};

// Chi sta usando la cassa: il gestore (PIN principale) o un dipendente (PIN personale, creato dal bot)
function checkPin(req, pin) {
  const { ctx } = req;
  const k = `pin|${ctx.shop.slug}|${req.ip}`;
  const locked = attempts.check(k);
  if (locked) return { error: `Troppi tentativi sbagliati: riprova tra ${locked} minuti.`, status: 429 };
  const who = shops.whoHasPin(ctx.shop, String(pin || ''));
  if (who) { attempts.ok(k); return { who }; }
  if (pin && attempts.fail(k)) {
    bot.alert(`🔐 ${ctx.cfg.pizzeriaName}: 5 PIN sbagliati di fila su cassa/dashboard (indirizzo ${req.ip}). Bloccato per 15 minuti.`, `pin|${ctx.shop.slug}`);
  }
  return { error: 'PIN errato.', status: 401 };
}

function requirePin(req, res, next) {
  const r = checkPin(req, req.get('x-staff-pin'));
  if (r.error) return res.status(r.status).json({ error: r.error });
  req.who = r.who;
  next();
}

// Dashboard, notifiche e impostazioni: solo il gestore
function requireManager(req, res, next) {
  requirePin(req, res, () => {
    if (req.who.role !== 'manager') return res.status(403).json({ error: 'Serve il PIN del gestore.' });
    next();
  });
}

function customerView(ctx, customer) {
  const s = ctx.db.stateOf(customer.id, ctx.cfg.stampsForReward);
  return {
    token: customer.token,
    code: customer.code,
    name: customer.name,
    email: customer.email,
    stamps: s.stamps,
    rewards: s.rewards,
    visits: s.visits,
    stampsForReward: ctx.cfg.stampsForReward,
    lastVisitAt: s.lastVisitAt,
    canUndo: !!s.lastOp,
  };
}

function loadCustomer(req, res) {
  const customer = req.ctx.db.findByToken(String(req.body.token || req.params.token || ''));
  if (!customer) res.status(404).json({ error: 'Tessera non riconosciuta.' });
  return customer;
}

shop.post('/api/staff/login', requirePin, (req, res) => res.json({ ok: true, role: req.who.role, name: req.who.name }));

shop.get('/api/staff/customer/:token', requirePin, (req, res) => {
  const customer = loadCustomer(req, res);
  if (customer) res.json(customerView(req.ctx, customer));
});

shop.get('/api/staff/search', requirePin, (req, res) => {
  res.json(req.ctx.db.search(String(req.query.q || '')).map((c) => customerView(req.ctx, c)));
});

shop.post('/api/staff/stamp', requirePin, wrap(async (req, res) => {
  const { ctx } = req;
  const customer = loadCustomer(req, res);
  if (!customer) return;
  if (ctx.db.findByRequestId(req.body.requestId)) return res.json({ ...customerView(ctx, customer), duplicate: true });

  const before = ctx.db.stateOf(customer.id, ctx.cfg.stampsForReward);
  if (STAMP_COOLDOWN_SEC && before.lastVisitAt && Date.now() - Date.parse(before.lastVisitAt) < STAMP_COOLDOWN_SEC * 1000) {
    return res.status(429).json({ error: `Timbro già assegnato da meno di ${STAMP_COOLDOWN_SEC} secondi.` });
  }
  const { rewardEarned } = await addStamp(ctx, customer, { requestId: req.body.requestId, by: 'staff', who: req.who.name });
  res.json({ ...customerView(ctx, customer), rewardEarned });
}));

// Assegna un timbro (usato dalla Cassa e dal timbro NFC): ledger, tessera web live, Wallet.
async function addStamp(ctx, customer, { requestId, by, who }) {
  const n = ctx.cfg.stampsForReward;
  const before = ctx.db.stateOf(customer.id, n);
  const event = ctx.db.addEvent({ type: 'stamp', customerId: customer.id, requestId, by, who });
  const after = ctx.db.stateOf(customer.id, n);
  const rewardEarned = after.earned > before.earned;
  broadcast(ctx, customer, rewardEarned ? 'reward' : 'stamp');
  // Il Wallet si aggiorna in parallelo: la Cassa e la tessera web non aspettano Google.
  walletAfterStamp(ctx, customer, after, rewardEarned).catch((err) => console.error(`[wallet] ${err.message}`));
  return { before, after, rewardEarned, event };
}

// Aggiorna il pass (GIF animata) e manda subito la notifica come messaggio Google
// ("+1 timbro"), che si legge meglio del generico "saldo aggiornato" e scade da solo.
// Se il cliente ha già ricevuto 3 notifiche nelle ultime 24 ore (limite Google) non si manda nulla:
// il pass si aggiorna comunque.
async function walletAfterStamp(ctx, customer, after, rewardEarned) {
  if (!wallet.enabled()) return;
  const { cfg } = ctx;
  await syncWallet(ctx, customer, null, { animated: true });
  if (ctx.db.canPush(customer.id)) {
    const n = cfg.stampsForReward;
    const missing = n - after.stamps;
    const msg = rewardEarned
      ? { header: 'Premio sbloccato! 🎉', body: `${cfg.rewardText}: mostra la tessera alla prossima visita.` }
      : { header: `${cfg.emoji} +1 timbro! Sei a ${after.stamps}/${n}`,
          body: missing === 1 ? `Ti manca 1 timbro per: ${cfg.rewardText.toLowerCase()}.` : `Ti mancano ${missing} timbri per: ${cfg.rewardText.toLowerCase()}.` };
    const r = await wallet.notify(customer, msg.header, msg.body, {
      push: true, expiresAt: Date.now() + SETTLE_MS,
    });
    if (r.push) ctx.db.logNotification(customer.id, rewardEarned ? 'reward' : 'stamp', true);
  }
  settleWallet(ctx, customer);
}

// Dopo l'animazione la tessera Wallet torna all'immagine fissa (timbri fermi) e l'avviso
// "+1 timbro" sparisce dai dettagli, così riaprendola più tardi non riparte nulla.
const settleTimers = new Map();
const SETTLE_MS = (Number(process.env.WALLET_ANIM_MINUTES) || 2) * 60 * 1000;
function settleWallet(ctx, customer, at = Date.now() + SETTLE_MS) {
  clearTimeout(settleTimers.get(customer.id));
  if (customer.settleAt !== new Date(at).toISOString()) ctx.db.updateCustomer(customer.id, { settleAt: new Date(at).toISOString() });
  settleTimers.set(customer.id, setTimeout(async () => {
    settleTimers.delete(customer.id);
    await syncWallet(ctx, customer, null, { animated: false });
    if (ctx.db.findByToken(customer.token)) ctx.db.updateCustomer(customer.id, { settleAt: null });
  }, Math.max(0, at - Date.now())));
}

// All'avvio: le tessere rimaste "animate" (server ripartito durante i 2 minuti) tornano ferme
function resumeSettles() {
  for (const ctx of shops.all()) {
    for (const c of ctx.db.customers) if (c.settleAt) settleWallet(ctx, c, Math.max(Date.parse(c.settleAt), Date.now() + 5000));
  }
}

// ---------- Timbro NFC del gestore ----------
// Il chip NFC del timbro (o un adesivo) contiene l'indirizzo /<slug>/tap/<segreto>. Il gestore lo avvicina al telefono
// del cliente, che lo apre: la pagina riconosce la tessera memorizzata su quel telefono e aggiunge il punto.
// Protezioni: segreto rigenerabile, un timbro NFC per visita (pausa configurabile), avviso live in Cassa.

function nfcSecret(ctx) {
  let { nfcSecret: s } = ctx.db.getSettings();
  if (!s) {
    s = crypto.randomBytes(9).toString('base64url');
    ctx.db.updateSettings({ nfcSecret: s });
  }
  return s;
}
const nfcUrl = (ctx) => `${ctx.cfg.baseUrl}/tap/${nfcSecret(ctx)}`;
const nfcCooldownHours = (ctx) => {
  const h = Number(ctx.db.getSettings().nfcCooldownHours);
  return Number.isFinite(h) && h >= 0 ? h : 3;
};

shop.post('/api/tap', wrap(async (req, res) => {
  const { ctx } = req;
  const settings = ctx.db.getSettings();
  if (settings.nfcEnabled === false) return res.status(403).json({ error: 'Il timbro con NFC è disattivato: chiedi in cassa.' });
  if (String(req.body.secret || '') !== nfcSecret(ctx)) {
    return res.status(403).json({ error: 'Questo timbro NFC non è più valido: chiedi il punto in cassa.' });
  }

  // Lo stesso timbro NFC vale per tutti i clienti: è il telefono a dire chi è.
  // 1) tessera ricordata su questo telefono (memoria della pagina o cookie del server)
  const token = req.body.token || getCardCookie(req);
  let customer = token ? ctx.db.findByToken(String(token)) : null;
  let isNew = false;

  if (!customer && req.body.signup) {
    // 2) cliente nuovo: si iscrive sul momento e riceve subito il primo timbro
    const data = readSignup(req.body.signup);
    if (data.error) return res.status(400).json({ error: data.error, needLogin: true });
    if (ctx.db.findByEmail(data.email)) {
      return res.status(409).json({
        emailExists: true, needLogin: true,
        error: 'Con questa email c\'è già una tessera: inserisci il codice tessera per collegarla a questo telefono.',
      });
    }
    customer = ctx.db.createCustomer(data);
    isNew = true;
  } else if (!customer && req.body.code && req.body.email) {
    // 3) ha già la tessera ma questo telefono non la conosce: codice tessera + email (tentativi limitati)
    const k = `recover|${ctx.shop.slug}|${req.ip}`;
    const lock = attempts.check(k);
    if (lock) return res.status(429).json({ error: `Troppi tentativi: riprova tra ${lock} minuti.`, needLogin: true });
    customer = findByCode(ctx, req.body.code, req.body.email);
    if (!customer) {
      attempts.fail(k);
      return res.status(404).json({ error: 'Codice o email non corretti.', needLogin: true });
    }
    attempts.ok(k);
  }
  if (!customer) return res.status(404).json({ needLogin: true });
  setCardCookie(req, res, customer.token);

  if (req.body.requestId && ctx.db.findByRequestId(req.body.requestId)) {
    return res.json({ token: customer.token, duplicate: true });
  }
  const last = ctx.db.lastStampBy(customer.id, 'nfc');
  const waitMs = last ? Date.parse(last.at) + nfcCooldownHours(ctx) * 3600e3 - Date.now() : 0;
  if (waitMs > 0) {
    const next = new Date(Date.now() + waitMs).toLocaleTimeString('it-IT', { hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Rome' });
    return res.status(429).json({
      token: customer.token,
      error: `Hai già ricevuto il punto per questa visita. Il prossimo sarà possibile dalle ${next}.`,
    });
  }

  const { before, after, rewardEarned } = await addStamp(ctx, customer, { requestId: req.body.requestId, by: 'nfc' });
  staffBroadcast(ctx, { type: 'nfc', name: customer.name, code: customer.code, token: customer.token, stamps: after.stamps, rewardEarned, isNew });
  res.json({ token: customer.token, before: { stamps: before.stamps, rewards: before.rewards }, rewardEarned, isNew });
}));

// Avvisi live per la Cassa (EventSource non può mandare header: il PIN arriva in query)
const staffStreams = new Map(); // slug -> Set di risposte aperte
shop.get('/api/staff/stream', (req, res) => {
  if (checkPin(req, req.query.pin).error) return res.status(401).end();
  const { slug } = req.ctx.shop;
  res.set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
  res.flushHeaders();
  res.write('retry: 3000\n\n');
  if (!staffStreams.has(slug)) staffStreams.set(slug, new Set());
  staffStreams.get(slug).add(res);
  const ping = setInterval(() => res.write(': ping\n\n'), 25000);
  req.on('close', () => { clearInterval(ping); staffStreams.get(slug).delete(res); });
});
function staffBroadcast(ctx, event) {
  const payload = `data: ${JSON.stringify(event)}\n\n`;
  (staffStreams.get(ctx.shop.slug) || []).forEach((res) => res.write(payload));
}

function nfcView(ctx) {
  const s = ctx.db.getSettings();
  return { url: nfcUrl(ctx), enabled: s.nfcEnabled !== false, cooldownHours: nfcCooldownHours(ctx) };
}

shop.get('/api/admin/nfc', requireManager, (req, res) => res.json(nfcView(req.ctx)));

shop.post('/api/admin/nfc', requireManager, (req, res) => {
  const patch = {};
  if (typeof req.body.enabled === 'boolean') patch.nfcEnabled = req.body.enabled;
  if (req.body.cooldownHours !== undefined) {
    const h = Number(req.body.cooldownHours);
    if (!Number.isFinite(h) || h < 0 || h > 48) return res.status(400).json({ error: 'Pausa non valida (0–48 ore).' });
    patch.nfcCooldownHours = h;
  }
  // Nuovo segreto: i chip scritti prima smettono di funzionare
  if (req.body.regenerate) patch.nfcSecret = crypto.randomBytes(9).toString('base64url');
  req.ctx.db.updateSettings(patch);
  res.json(nfcView(req.ctx));
});

shop.post('/api/staff/redeem', requirePin, wrap(async (req, res) => {
  const { ctx } = req;
  const customer = loadCustomer(req, res);
  if (!customer) return;
  if (ctx.db.findByRequestId(req.body.requestId)) return res.json({ ...customerView(ctx, customer), duplicate: true });
  if (ctx.db.stateOf(customer.id, ctx.cfg.stampsForReward).rewards < 1) {
    return res.status(400).json({ error: 'Nessun premio disponibile.' });
  }
  ctx.db.addEvent({ type: 'redeem', customerId: customer.id, requestId: req.body.requestId, by: 'staff', who: req.who.name });
  broadcast(ctx, customer, 'redeem');
  syncWallet(ctx, customer); // la Cassa non aspetta Google
  res.json(customerView(ctx, customer));
}));

// Annulla l'ultima operazione (timbro o riscatto) con un evento "void": il ledger resta tracciato.
shop.post('/api/staff/undo', requirePin, wrap(async (req, res) => {
  const { ctx } = req;
  const customer = loadCustomer(req, res);
  if (!customer) return;
  const { lastOp } = ctx.db.stateOf(customer.id, ctx.cfg.stampsForReward);
  if (!lastOp) return res.status(400).json({ error: 'Nessuna operazione da annullare.' });
  ctx.db.addEvent({ type: 'void', customerId: customer.id, ref: lastOp.id, by: 'staff', who: req.who.name });
  broadcast(ctx, customer, 'undo');
  syncWallet(ctx, customer); // la Cassa non aspetta Google
  res.json(customerView(ctx, customer));
}));

// Numeri del locale (dashboard e bot Telegram)
function stats(ctx) {
  const { cfg } = ctx;
  const now = Date.now();
  const DAY = 86400000;
  const views = ctx.db.customers.map((c) => customerView(ctx, c));
  const voided = new Set(ctx.db.events.filter((e) => e.type === 'void').map((e) => e.ref));
  const active = ctx.db.events.filter((e) => e.type !== 'void' && !voided.has(e.id));
  return {
    views, active, voided,
    kpi: {
      members: views.length,
      marketingConsent: ctx.db.customers.filter((c) => c.consentMarketing).length,
      stamps: active.filter((e) => e.type === 'stamp').length,
      stampsLast7: active.filter((e) => e.type === 'stamp' && now - Date.parse(e.at) < 7 * DAY).length,
      returning: views.filter((v) => v.visits >= 2).length,
      rewardsEarned: views.reduce((n, v) => n + Math.floor((v.visits) / cfg.stampsForReward), 0),
      rewardsRedeemed: active.filter((e) => e.type === 'redeem').length,
      nearReward: views.filter((v) => v.stamps === cfg.stampsForReward - 1).length,
      inactive30: views.filter((v) => v.lastVisitAt && now - Date.parse(v.lastVisitAt) > 30 * DAY).length,
      newLast7: ctx.db.customers.filter((c) => now - Date.parse(c.createdAt) < 7 * DAY).length,
    },
  };
}

shop.get('/api/admin/stats', requireManager, (req, res) => {
  const { ctx } = req;
  const { cfg } = ctx;
  const { views, voided, kpi } = stats(ctx);
  const nameOf = Object.fromEntries(ctx.db.customers.map((c) => [c.id, c.name]));
  res.json({
    pizzeriaName: cfg.pizzeriaName,
    stampsForReward: cfg.stampsForReward,
    rewardText: cfg.rewardText,
    walletEnabled: wallet.enabled(),
    kpi,
    customers: views.sort((a, b) => (b.lastVisitAt || '').localeCompare(a.lastVisitAt || '')),
    events: ctx.db.events.slice(-25).reverse().map((e) => ({
      type: e.type, by: e.by, who: e.who || null, at: e.at, name: nameOf[e.customerId] || '?', voided: voided.has(e.id),
    })),
  });
});

shop.post('/api/admin/customers/:token/delete', requireManager, wrap(async (req, res) => {
  const customer = req.ctx.db.findByToken(req.params.token);
  if (!customer) return res.status(404).json({ error: 'Cliente non trovato.' });
  await removeCustomer(req.ctx, customer);
  res.json({ ok: true });
}));

shop.post('/api/admin/reset', requireManager, (req, res) => {
  req.ctx.db.reset();
  res.json({ ok: true });
});

// ---------- Impostazioni del locale ----------

shop.get('/api/admin/settings', requireManager, (req, res) => res.json(req.ctx.db.getSettings()));

// Controlla i link del locale. Restituisce un messaggio d'errore oppure null.
function checkLinks({ reviewUrl, mapsUrl, phone }) {
  for (const [url, what] of [[reviewUrl, 'della recensione'], [mapsUrl, 'di Google Maps']]) {
    if (url && !/^https:\/\/\S+$/.test(url)) return `Il link ${what} deve iniziare con https://`;
  }
  if (phone && !/^\+?[\d\s./-]{6,}$/.test(phone)) return 'Numero di telefono non valido.';
  return null;
}

shop.post('/api/admin/settings', requireManager, (req, res) => {
  const reviewUrl = String(req.body.reviewUrl || '').trim();
  const mapsUrl = String(req.body.mapsUrl || '').trim();
  const phone = String(req.body.phone || '').trim().slice(0, 30);
  const error = checkLinks({ reviewUrl, mapsUrl, phone });
  if (error) return res.status(400).json({ error });
  const settings = req.ctx.db.updateSettings({ reviewUrl, mapsUrl, phone });
  // Aggiorna in background le tessere già emesse (i link compaiono nei dettagli del pass).
  syncAll(req.ctx);
  res.json(settings);
});

// ---------- Notifiche del gestore ----------

const DAY_MS = 24 * 60 * 60 * 1000;
const SEGMENTS = {
  all: { label: 'Tutti gli iscritti', test: () => true },
  near: { label: 'A 1 timbro dal premio', test: (s, c, n) => s.stamps === n - 1 },
  reward: { label: 'Con un premio da ritirare', test: (s) => s.rewards > 0 },
  inactive: {
    label: 'Non tornano da 30+ giorni',
    test: (s, c) => Date.now() - Date.parse(s.lastVisitAt || c.createdAt) > 30 * DAY_MS,
  },
  never: { label: 'Iscritti ma mai tornati', test: (s) => s.visits === 0 },
  new: { label: 'Iscritti negli ultimi 7 giorni', test: (s, c) => Date.now() - Date.parse(c.createdAt) < 7 * DAY_MS },
  manual: { label: 'Scelti a mano', test: () => true },
};

// Calcola i destinatari al momento dell'invio (così un invio programmato usa dati aggiornati).
// I messaggi promozionali vanno solo a chi ha dato il consenso marketing.
function resolveAudience(ctx, { segment, ids = [], promo }) {
  const n = ctx.cfg.stampsForReward;
  const seg = SEGMENTS[segment] || SEGMENTS.all;
  const pool = segment === 'manual' ? ctx.db.customers.filter((c) => ids.includes(c.id)) : ctx.db.customers;
  const inSegment = pool.filter((c) => seg.test(ctx.db.stateOf(c.id, n), c, n));
  const recipients = promo ? inSegment.filter((c) => c.consentMarketing) : inSegment;
  return {
    recipients,
    excludedNoConsent: inSegment.length - recipients.length,
    pushable: recipients.filter((c) => ctx.db.canPush(c.id)).length,
  };
}

shop.get('/api/admin/segments', requireManager, (req, res) => {
  const { ctx } = req;
  res.json({
    pushLimit: db.PUSH_LIMIT,
    segments: Object.entries(SEGMENTS).map(([key, s]) => ({
      key, label: s.label, count: key === 'manual' ? null : resolveAudience(ctx, { segment: key }).recipients.length,
    })),
    customers: ctx.db.customers.map((c) => ({
      id: c.id, name: c.name, code: c.code, consentMarketing: c.consentMarketing, pushesLast24h: ctx.db.pushesLast24h(c.id),
    })),
  });
});

shop.post('/api/admin/audience', requireManager, (req, res) => {
  const a = resolveAudience(req.ctx, req.body);
  res.json({ count: a.recipients.length, pushable: a.pushable, textOnly: a.recipients.length - a.pushable, excludedNoConsent: a.excludedNoConsent });
});

shop.get('/api/admin/campaigns', requireManager, (req, res) => {
  const { ctx } = req;
  res.json([...ctx.db.campaigns].reverse().slice(0, 30).map((c) => ({
    ...c,
    segmentLabel: (SEGMENTS[c.segment] || {}).label,
    ...(c.status === 'sent' && { active: ctx.db.isActive(c), expiresAt: ctx.db.expiryOf(c) }),
  })));
});

shop.post('/api/admin/campaigns', requireManager, wrap(async (req, res) => {
  const { ctx } = req;
  const title = String(req.body.title || '').trim();
  const body = String(req.body.body || '').trim();
  if (!title || title.length > 60) return res.status(400).json({ error: 'Titolo obbligatorio, massimo 60 caratteri.' });
  if (!body || body.length > 300) return res.status(400).json({ error: 'Testo obbligatorio, massimo 300 caratteri.' });
  if (!SEGMENTS[req.body.segment]) return res.status(400).json({ error: 'Scegli i destinatari.' });
  const ids = Array.isArray(req.body.ids) ? req.body.ids.map(String) : [];
  if (req.body.segment === 'manual' && !ids.length) return res.status(400).json({ error: 'Seleziona almeno un cliente.' });

  let sendAt = new Date();
  if (req.body.sendAt) {
    sendAt = new Date(req.body.sendAt);
    if (isNaN(sendAt)) return res.status(400).json({ error: 'Data di invio non valida.' });
  }
  const keepDays = [1, 3, 7, 14].includes(Number(req.body.keepDays)) ? Number(req.body.keepDays) : 3;
  const campaign = ctx.db.createCampaign({
    title, body, segment: req.body.segment, ids, promo: req.body.promo !== false,
    sendAt: sendAt.toISOString(), recipients: [], keepDays,
  });
  if (sendAt <= new Date()) await sendCampaign(ctx, campaign);
  res.json(ctx.db.findCampaign(campaign.id));
}));

shop.post('/api/admin/campaigns/:id/cancel', requireManager, (req, res) => {
  const c = req.ctx.db.findCampaign(req.params.id);
  if (!c || c.status !== 'scheduled') return res.status(400).json({ error: 'Invio non annullabile.' });
  res.json(req.ctx.db.updateCampaign(c.id, { status: 'cancelled' }));
});

// Toglie un messaggio già inviato da tutte le tessere (Wallet e web)
shop.post('/api/admin/campaigns/:id/remove', requireManager, (req, res) => {
  const c = req.ctx.db.findCampaign(req.params.id);
  if (!c || c.status !== 'sent') return res.status(400).json({ error: 'Messaggio non trovato.' });
  req.ctx.db.updateCampaign(c.id, { removed: true });
  cleanCampaign(req.ctx, c);
  res.json({ ok: true });
});

// Ritocca le tessere dei destinatari: il messaggio scaduto/eliminato sparisce dai dettagli
async function cleanCampaign(ctx, campaign) {
  ctx.db.updateCampaign(campaign.id, { cleaned: true });
  for (const id of campaign.recipients) {
    const customer = ctx.db.customers.find((c) => c.id === id);
    if (!customer) continue;
    broadcast(ctx, customer, 'message-removed');
    await syncWallet(ctx, customer);
  }
}

async function sendCampaign(ctx, campaign) {
  // Il messaggio resta nella tessera per keepDays giorni, poi sparisce da solo.
  const expiresAt = campaign.expiresAt || new Date(Date.now() + (campaign.keepDays || 3) * DAY_MS).toISOString();
  // destinatari fissati al primo tentativo; se il server riparte a metà si riprende da dove era rimasto
  if (campaign.status !== 'sending') {
    const a = resolveAudience(ctx, campaign);
    ctx.db.updateCampaign(campaign.id, {
      status: 'sending', expiresAt, pending: a.recipients.map((c) => c.id), sentTo: [],
      results: { total: a.recipients.length, push: 0, textOnly: 0, failed: 0, excludedNoConsent: a.excludedNoConsent },
    });
  }
  const results = campaign.results;
  const done = new Set(campaign.sentTo || []);
  const recipients = (campaign.pending || []).map((id) => ctx.db.customers.find((c) => c.id === id)).filter(Boolean);
  for (const customer of recipients) {
    if (done.has(customer.id)) continue;
    if (wallet.enabled()) {
      const r = await wallet.notify(customer, campaign.title, campaign.body, {
        push: ctx.db.canPush(customer.id), messageId: `c_${campaign.id}`, expiresAt,
      });
      if (!r.ok) results.failed++;
      else if (r.push) { results.push++; ctx.db.logNotification(customer.id, 'campaign', true); }
      else results.textOnly++;
    }
    // La tessera web aperta mostra subito il messaggio.
    broadcast(ctx, customer, 'message', { title: campaign.title, body: campaign.body });
    done.add(customer.id);
    ctx.db.updateCampaign(campaign.id, { sentTo: [...done], results });
  }
  ctx.db.updateCampaign(campaign.id, {
    status: 'sent', sentAt: new Date().toISOString(), recipients: recipients.map((c) => c.id), results, pending: undefined, sentTo: undefined,
  });
  // Nella tessera resta solo l'ultimo messaggio: i precedenti vengono tolti subito
  if (wallet.enabled()) (async () => { for (const c of recipients) await syncWallet(ctx, c); })();
  console.log(`[notifiche] ${ctx.shop.slug}: "${campaign.title}" inviata a ${results.total} (push ${results.push}, solo testo ${results.textOnly}, errori ${results.failed})`);
}

// Invia le campagne programmate scadute di tutti i locali. Chiamato ogni 30 secondi e da /api/cron
// (un ping esterno tiene sveglio il server gratuito, che altrimenti va in pausa).
let sending = false;
async function processDueCampaigns() {
  if (sending) return;
  sending = true;
  try {
    for (const ctx of shops.all()) {
      for (const c of ctx.db.dueCampaigns()) await sendCampaign(ctx, c);
      // invii interrotti da un riavvio
      for (const c of ctx.db.campaigns.filter((x) => x.status === 'sending')) await sendCampaign(ctx, c);
      // messaggi scaduti: si tolgono dalle tessere (Google li nasconde già alla scadenza)
      for (const c of ctx.db.campaignsToClean()) await cleanCampaign(ctx, c);
    }
    await runJobs();
  } catch (err) {
    console.error(`[notifiche] ${err.message}`);
  } finally {
    sending = false;
  }
}

// ---------- Lavori periodici (salvati: un riavvio non li fa saltare né ripetere) ----------
// Lunedì dalle 9: backup e report settimanale su Telegram. Ogni giorno dalle 10: controllo dei locali fermi.
const romeNow = () => {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Rome', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', weekday: 'short', hourCycle: 'h23' })
    .formatToParts(new Date()).map((x) => [x.type, x.value]));
  return { day: `${p.year}-${p.month}-${p.day}`, hour: Number(p.hour), weekday: p.weekday };
};
let jobsState = null;
async function runJobs() {
  if (!bot.enabled()) return;
  if (!jobsState) jobsState = (await db.loadKey('jobs')) || {};
  const now = romeNow();
  const due = (name, cond) => cond && jobsState[name] !== now.day;
  const mark = (name) => { jobsState[name] = now.day; db.saveKey('jobs', jobsState); };
  if (due('weekly', now.weekday === 'Mon' && now.hour >= 9)) {
    mark('weekly');
    await bot.sendBackup('🗓️ Backup settimanale automatico').catch((err) => console.error(`[bot] backup: ${err.message}`));
    await bot.sendWeeklyReports().catch((err) => console.error(`[bot] report: ${err.message}`));
  }
  if (due('daily', now.hour >= 10)) {
    mark('daily');
    for (const ctx of shops.all()) {
      // privacy: tessere senza visite da 24 mesi vengono cancellate (come scritto nell'informativa)
      const limit = Date.now() - 730 * DAY_MS;
      for (const c of [...ctx.db.customers]) {
        const s = ctx.db.stateOf(c.id, ctx.cfg.stampsForReward);
        if (Date.parse(s.lastVisitAt || c.createdAt) < limit) await removeCustomer(ctx, c);
      }
      const last = ctx.db.events.filter((e) => e.type === 'stamp').pop();
      const days = last ? (Date.now() - Date.parse(last.at)) / DAY_MS : 0;
      // locale che timbrava e da 3 giorni non riceve timbri: forse il timbro NFC o la cassa non funzionano
      if (days >= 3 && days < 30 && ctx.db.customers.length >= 3) {
        bot.alert(`💤 ${ctx.cfg.pizzeriaName}: nessun timbro da ${Math.floor(days)} giorni. Il timbro NFC e la cassa funzionano?`, `idle|${ctx.shop.slug}`, 3 * DAY_MS);
      }
    }
  }
}

// ---------- Wallet sync ----------

const classReady = new Set(); // slug dei locali con la classe Google già creata/aggiornata
async function ensureClass(ctx, { force = false } = {}) {
  if (!wallet.enabled() || (classReady.has(ctx.shop.slug) && !force)) return;
  await images.get(shops.imageSpec(ctx.shop), 'logo.png'); // pronto prima che Google lo scarichi
  await wallet.ensureClass(ctx.cfg);
  classReady.add(ctx.shop.slug);
}

// Aggiornamenti dello stesso pass uno alla volta, nell'ordine: ora che la Cassa non li aspetta,
// due aggiornamenti in parallelo potrebbero arrivare a Google invertiti e lasciare un saldo vecchio.
// Il saldo si legge al momento dell'invio, quindi l'ultimo aggiornamento è sempre quello giusto.
const walletQueues = new Map(); // customerId -> ultimo aggiornamento in coda
function syncWallet(ctx, customer, message, options = {}) {
  if (!wallet.enabled()) return Promise.resolve();
  const next = (walletQueues.get(customer.id) || Promise.resolve()).then(() => syncWalletNow(ctx, customer, message, options));
  walletQueues.set(customer.id, next);
  next.then(() => { if (walletQueues.get(customer.id) === next) walletQueues.delete(customer.id); });
  return next;
}

async function syncWalletNow(ctx, customer, message, options) {
  if (!ctx.db.findByToken(customer.token)) return; // cliente cancellato nel frattempo
  try {
    await ensureClass(ctx);
    const state = ctx.db.stateOf(customer.id, ctx.cfg.stampsForReward);
    // l'immagine dei timbri si prepara prima: quando Google la scarica è già pronta
    await images.get(shops.imageSpec(ctx.shop), `stamps/${wallet.heroFile(ctx.cfg, state, options.animated === true)}`);
    await wallet.upsertObject(ctx.cfg, customer, state, {
      ...options, ...ctx.db.getSettings(),
      messages: ctx.db.messagesFor(customer.id, 1).map((m) => ({ id: m.id, header: m.title, body: m.body, expiresAt: m.expiresAt })),
    });
    if (options.notifyOnUpdate) ctx.db.logNotification(customer.id, 'stamp', true);
    if (message) {
      const r = await wallet.notify(customer, message.header, message.body, { push: ctx.db.canPush(customer.id) });
      if (r.push) ctx.db.logNotification(customer.id, 'reward', true);
    }
  } catch (err) {
    // Il ledger è la fonte autorevole: un errore Wallet non blocca l'operazione in cassa.
    console.error(`[wallet] ${ctx.shop.slug}: ${err.message}`);
    bot.alert(`⚠️ Google Wallet ha rifiutato un aggiornamento per ${ctx.cfg.pizzeriaName}:\n${err.message.slice(0, 300)}`, `wallet|${ctx.shop.slug}|${err.message.slice(0, 60)}`);
  }
}

// Animazioni del Wallet preparate in anticipo (in un thread separato, vedi images.js):
// al momento del timbro il pass si aggiorna subito, senza aspettare la GIF.
async function warmGifs(ctx) {
  if (!wallet.enabled()) return;
  const t = Date.now();
  await images.warm(shops.imageSpec(ctx.shop), { gifs: true })
    .then(() => console.log(`[wallet] ${ctx.shop.slug}: animazioni pronte (${Date.now() - t} ms)`))
    .catch((err) => console.error(`[wallet] ${ctx.shop.slug}: animazioni non preparate: ${err.message}`));
}

// Aggiorna in background tutte le tessere di un locale (es. dopo un cambio di premio, colore o link)
async function syncAll(ctx) {
  for (const c of [...ctx.db.customers]) await syncWallet(ctx, c);
}

app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: 'Errore interno.' });
});

// ---------- Operazioni sui locali (usate dal bot Telegram) ----------

const manager = {
  publicUrl: PUBLIC_URL,
  all: () => shops.all(),
  get: (slug) => shops.get(slug),
  stats: (ctx) => stats(ctx).kpi,
  links(ctx) {
    const b = ctx.cfg.baseUrl;
    return { signup: `${b}/`, staff: `${b}/staff`, admin: `${b}/admin`, poster: `${b}/poster`, nfc: nfcUrl(ctx) };
  },
  settings: (ctx) => ctx.db.getSettings(),
  async create(input) {
    const linkError = checkLinks(input);
    if (linkError) return { error: linkError };
    const r = await shops.create(input);
    if (r.error) return r;
    const warnings = [];
    try {
      await images.warm(shops.imageSpec(r.ctx.shop));
      await ensureClass(r.ctx, { force: true });
    } catch (err) {
      warnings.push(`Google Wallet: ${err.message}`);
    }
    if (!wallet.enabled()) warnings.push('Google Wallet non è configurato su questo server: funziona solo la tessera web.');
    warmGifs(r.ctx);
    return { ctx: r.ctx, warnings };
  },
  async update(slug, input) {
    if (['reviewUrl', 'mapsUrl', 'phone'].some((k) => k in input)) {
      const ctx = shops.get(slug);
      if (!ctx) return { error: 'Locale non trovato.' };
      const patch = {};
      for (const k of ['reviewUrl', 'mapsUrl', 'phone']) if (k in input) patch[k] = String(input[k] || '').trim();
      const error = checkLinks(patch);
      if (error) return { error };
      ctx.db.updateSettings(patch);
      syncAll(ctx);
      return { ctx };
    }
    const r = shops.update(slug, input);
    if (r.error) return r;
    const warnings = [];
    try {
      if (r.visual) await images.warm(shops.imageSpec(r.ctx.shop));
      await ensureClass(r.ctx, { force: true });
    } catch (err) {
      warnings.push(`Google Wallet: ${err.message}`);
    }
    if (r.visual) warmGifs(r.ctx);
    syncAll(r.ctx); // le tessere già emesse si aggiornano in background
    return { ctx: r.ctx, warnings };
  },
  resetPin: (slug) => shops.resetPin(slug),
  addStaff: (slug, name) => shops.addStaff(slug, name),
  removeStaff: (slug, id) => shops.removeStaff(slug, id),
  addManager: (slug, chatId, name) => shops.addManager(slug, chatId, name),
  removeManager: (slug, chatId) => shops.removeManager(slug, chatId),
  managedBy: (chatId) => shops.all().filter((ctx) => (ctx.shop.managers || []).some((m) => m.chatId === chatId)),
  // Settimana appena trascorsa di un locale: numeri per il report
  weekly(ctx) {
    const WEEK = 7 * DAY_MS, now = Date.now();
    const { kpi, active } = stats(ctx);
    const inWeek = (e, from, to) => Date.parse(e.at) >= now - from && Date.parse(e.at) < now - to;
    const stamps = active.filter((e) => e.type === 'stamp');
    const thisWeek = stamps.filter((e) => inWeek(e, WEEK, 0));
    const lastWeek = stamps.filter((e) => inWeek(e, 2 * WEEK, WEEK));
    const byStaff = {};
    for (const e of thisWeek) { const k = e.by === 'nfc' ? 'Timbro NFC' : (e.who || 'Cassa'); byStaff[k] = (byStaff[k] || 0) + 1; }
    return {
      kpi,
      newMembers: ctx.db.customers.filter((c) => now - Date.parse(c.createdAt) < WEEK).length,
      stamps: thisWeek.length,
      stampsPrev: lastWeek.length,
      visitors: new Set(thisWeek.map((e) => e.customerId)).size,
      redeemed: active.filter((e) => e.type === 'redeem' && inWeek(e, WEEK, 0)).length,
      byStaff,
    };
  },
  // Copia completa di tutti i locali (per il backup su Telegram)
  async backup() {
    await db.flush();
    return {
      creato: new Date().toISOString(),
      versione: 1,
      locali: shops.all().map((ctx) => ({ scheda: ctx.shop, dati: ctx.db.snapshot() })),
    };
  },
  remove: (slug) => shops.remove(slug),
  preview: (ctx) => images.preview(shops.imageSpec(ctx.shop)),
  prepareLogo: (buffer) => images.prepareLogo(buffer),
  themes: images.THEMES,
};

const ready = (async () => {
  await db.init();
  await shops.init(PUBLIC_URL);
  wallet.init({
    issuerId: process.env.GOOGLE_ISSUER_ID || '',
    keyJson: process.env.GOOGLE_SA_JSON || '', // contenuto del JSON della service account (hosting)
    keyFile: path.resolve(__dirname, process.env.GOOGLE_KEY_FILE || './service-account.json'),
    origin: PUBLIC_URL,
  });
  // Classi Google aggiornate solo quando il sito è raggiungibile: Google scarica subito logo e immagini
  // dal nostro server, e su Render il traffico arriva qualche secondo dopo l'avvio.
  // Se fallisce si riprova da sola al primo timbro (vedi ensureClass in syncWallet).
  (async function updateClasses() {
    for (let i = 0; i < 20; i++) {
      const ok = await fetch(`${PUBLIC_URL}/api/config`).then((r) => r.ok, () => false);
      if (ok) break;
      await new Promise((r) => setTimeout(r, 5000));
    }
    for (const ctx of shops.all()) {
      await ensureClass(ctx).catch((err) => console.error(`[wallet] ${ctx.shop.slug}: ${err.message}`));
    }
    for (const ctx of shops.all()) await warmGifs(ctx);
  })();
  resumeSettles();
  setInterval(processDueCampaigns, 30000);
  processDueCampaigns();
  await new Promise((resolve) => app.listen(PORT, () => {
    console.log(`\nTessere fedeltà — ${shops.all().length} locali`);
    console.log(`  Locale:        http://localhost:${PORT}`);
    console.log(`  URL pubblico:  ${PUBLIC_URL}`);
    for (const ctx of shops.all()) console.log(`  ${ctx.cfg.pizzeriaName.padEnd(28)} ${ctx.cfg.baseUrl}/  (cassa: /staff, dashboard: /admin)`);
    console.log('');
    bot.start(manager).then(() => bot.alert(`🔄 Server avviato (${shops.all().length} locali, database: ${db.usingPostgres() ? 'Postgres' : 'file'}).`, 'start', 60 * 60 * 1000));
    resolve();
  }));
})();

module.exports = { manager, ready }; // per i test
