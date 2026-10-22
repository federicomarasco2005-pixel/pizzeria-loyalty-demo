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
const pdf = require('./pdf');
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

// Protezioni di base su tutte le risposte: le pagine non si aprono dentro siti altrui (cassa e dashboard),
// il browser non indovina il tipo dei file e non manda ad altri siti l'indirizzo della pagina (con il token della tessera).
app.use((req, res, next) => {
  res.set({
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'same-origin',
    'X-Frame-Options': 'SAMEORIGIN',
    'Content-Security-Policy': "frame-ancestors 'self'",
  });
  next();
});

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const wrap = (fn) => (req, res, next) => fn(req, res, next).catch(next);
const PUBLIC_DIR = path.join(__dirname, 'public');

// ---------- Sottodomini dei locali (SHOP_DOMAIN, es. da-mario.f5m.it) ----------
// Una richiesta a <slug>.f5m.it diventa internamente /<slug>/…: pagine e API sono le stesse dell'indirizzo con il percorso.
// I file comuni (/style.css, /common.js…) restano comuni. Un indirizzo vecchio (locale rinominato) porta al nuovo.
const GLOBAL_FILES = new Set(['/style.css', '/f5m.css', '/common.js', '/sw.js', '/wallet-button-it.svg', '/robots.txt', '/vendor/html5-qrcode.min.js']);
app.use((req, res, next) => {
  const domain = shops.shopDomain();
  const host = String(req.hostname || '').toLowerCase();
  if (!domain || !host.endsWith(`.${domain}`)) return next();
  const sub = host.slice(0, -domain.length - 1);
  if (sub === 'www') return res.redirect(301, `https://${domain}${req.originalUrl}`);
  const found = shops.resolve(sub);
  if (!found) return res.redirect(302, `https://${domain}/`);
  const { slug } = found.ctx.shop;
  if (found.alias) return res.redirect(301, `https://${slug}.${domain}${req.originalUrl}`);
  req.subdomain = slug;
  if (!GLOBAL_FILES.has(req.path) && req.path !== `/${slug}` && !req.path.startsWith(`/${slug}/`)) req.url = `/${slug}${req.url}`;
  next();
});

// Dominio principale (es. https://f5m.it/): la pagina di presentazione del servizio, con i contatti per l'assistenza.
// È il dominio dei sottodomini (SHOP_DOMAIN) oppure quello dell'indirizzo pubblico, se è un dominio proprio.
const mainHost = () => {
  if (shops.shopDomain()) return shops.shopDomain();
  const h = new URL(PUBLIC_URL).hostname;
  return h === 'localhost' || h.endsWith('.onrender.com') ? null : h;
};
const isMainDomain = (req) => !!mainHost() && String(req.hostname || '').toLowerCase() === mainHost();
app.get(['/', '/assistenza'], (req, res, next) => {
  if (!isMainDomain(req)) return next();
  res.type('html').set('Cache-Control', 'no-cache').send(readPage('home.html')
    .replace(/\{\{BRAND\}\}/g, process.env.BRAND_NAME || 'F5M')
    .replace(/\{\{EMAIL\}\}/g, process.env.SUPPORT_EMAIL || ''));
});

// Modulo "Richiedi una demo" della pagina principale: la richiesta arriva sul bot Telegram e resta salvata.
// Anti-spam: campo nascosto (i robot lo compilano) e al massimo 3 richieste all'ora per indirizzo.
const leadHits = new Map(); // ip -> orari delle ultime richieste
app.post('/api/lead', wrap(async (req, res) => {
  if (req.body.website) return res.json({ ok: true }); // campo trappola compilato: robot, si ignora in silenzio
  const now = Date.now();
  const hits = (leadHits.get(req.ip) || []).filter((t) => now - t < 3600e3);
  if (hits.length >= 3) return res.status(429).json({ error: 'Hai già inviato alcune richieste: ti ricontattiamo presto.' });
  const f = (k, max) => String(req.body[k] || '').trim().slice(0, max);
  const lead = { locale: f('locale', 80), nome: f('nome', 60), contatto: f('contatto', 100), messaggio: f('messaggio', 500), at: new Date().toISOString() };
  if (lead.locale.length < 2 || lead.nome.length < 2 || lead.contatto.length < 5) {
    return res.status(400).json({ error: 'Scrivi il tuo nome, il nome del locale e un telefono o un\'email.' });
  }
  if (req.body.consent !== true) return res.status(400).json({ error: 'Serve il consenso per essere ricontattato.' });
  hits.push(now);
  leadHits.set(req.ip, hits);
  if (leadHits.size > 5000) leadHits.delete(leadHits.keys().next().value);
  const leads = (await db.loadKey('leads')) || [];
  leads.push(lead);
  db.saveKey('leads', leads.slice(-500));
  bot.alert(`📩 Nuova richiesta dal sito\n🏪 ${lead.locale}\n👤 ${lead.nome}\n📞 ${lead.contatto}${lead.messaggio ? `\n💬 ${lead.messaggio}` : ''}`, `lead|${lead.at}`, 0);
  console.log(`[sito] nuova richiesta di demo: ${lead.locale}`);
  res.json({ ok: true });
}));

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
// Pubblico (lo chiamano il keepalive e i ping esterni): risponde sempre, ma fa il giro delle campagne al massimo una volta al minuto
let lastCron = 0;
app.get('/api/cron', wrap(async (req, res) => {
  if (Date.now() - lastCron >= 60000) {
    lastCron = Date.now();
    await processDueCampaigns();
  }
  res.json({ ok: true });
}));

bot.mount(app);
// Scanner QR della Cassa: la libreria si serve da qui (node_modules), non da un sito esterno
app.get('/vendor/html5-qrcode.min.js', (req, res) => {
  res.set('Cache-Control', 'public, max-age=86400').sendFile(path.join(__dirname, 'node_modules', 'html5-qrcode', 'html5-qrcode.min.js'));
});
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
    const data = { SHOP: { slug: cfg.slug, legacy: !!req.ctx.shop.legacy, prefix: cfg.codePrefix, aliases: req.ctx.shop.aliases || [] }, CFG: publicConfig(cfg) };
    if (extra) Object.assign(data, await extra(req, res));
    // dopo style.css, così questi valori hanno la precedenza
    const vars = `<style>:root { --brand: ${cfg.brandColor}; --stamp-on: url(/${cfg.slug}/stamps/icon.png?v=${cfg.imgVersion}); --stamp-off: url(/${cfg.slug}/stamps/icon-empty.png?v=${cfg.imgVersion}); }</style>`;
    let html = readPage(file).replace('</head>', `  ${vars}\n</head>`)
      .replace(/#b3261e/g, cfg.brandColor)
      .replace(/🍕/g, cfg.emoji)
      .replace(/PZ-/g, `${cfg.codePrefix}-`);
    // i dati si aggiungono dopo le sostituzioni, così restano intatti
    // sul sottodominio del locale gli indirizzi relativi partono dalla radice (da-mario.f5m.it/api/…)
    const head = `<base href="${req.subdomain ? '/' : `/${cfg.slug}/`}">
  <script>${Object.entries(data).map(([k, v]) => `window.${k} = ${inlineJson(v)};`).join(' ')}</script>`;
    html = html.replace('<head>', `<head>\n  ${head}`);
    res.type('html').set('Cache-Control', 'no-cache').send(html);
  });
}

const shop = express.Router({ mergeParams: true });
app.use('/:slug', (req, res, next) => {
  const found = shops.resolve(req.params.slug);
  if (!found) return next();
  // indirizzo vecchio di un locale rinominato: stesso percorso con l'indirizzo nuovo
  if (found.alias) return res.redirect(301, `${found.ctx.cfg.baseUrl}${req.originalUrl.slice(req.params.slug.length + 1)}`);
  req.ctx = found.ctx;
  shop(req, res, next);
});

// Chi riscansiona il QR del tavolo con il telefono già iscritto ritrova subito la sua tessera
// (riconosciuta dal cookie), invece del modulo di iscrizione che gli chiederebbe il codice tessera.
shop.get('/', (req, res, next) => {
  const token = getCardCookie(req);
  if (!token || !req.ctx.db.findByToken(token)) return next();
  res.set('Cache-Control', 'no-store').redirect(`${req.subdomain ? '' : `/${req.ctx.shop.slug}`}/card/${encodeURIComponent(token)}${query(req)}`);
}, page('index.html'));
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
// Logo largo dell'intestazione Wallet: il locale legacy ha il suo file, gli altri lo hanno generato
shop.get('/wide-logo.png', wrap(async (req, res) => {
  if (req.ctx.shop.legacy) return res.sendFile(path.join(PUBLIC_DIR, 'wide-logo.png'));
  return sendImage(req, res, 'wide-logo.png');
}));

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
const slugCookie = (slug) => `card_${slug.replace(/[^a-z0-9]/g, '_')}`;
const cookieName = (ctx) => slugCookie(ctx.shop.slug);
function getCookie(req, name) {
  const m = (req.headers.cookie || '').match(new RegExp(`(?:^|;\\s*)${name}=([^;]+)`));
  return m ? decodeURIComponent(m[1]) : null;
}
// anche i cookie degli indirizzi precedenti del locale (se è stato rinominato)
function getCardCookie(req) {
  for (const name of [cookieName(req.ctx), ...(req.ctx.shop.aliases || []).map(slugCookie)]) {
    const v = getCookie(req, name);
    if (v) return v;
  }
  return req.ctx.shop.legacy ? getCookie(req, 'card') : null;
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
    rewardShort: cfg.rewardShort,
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

// ---------- Premio ritirato dal telefono del cliente ----------
// Per i locali dove il personale non usa la Cassa: il cliente tocca "Usa il premio" davanti al cameriere,
// la tessera mostra una schermata "PREMIO VALIDO" animata con l'orologio che scorre (uno screenshot non basta)
// e il premio risulta già consegnato.
// Tocco sbagliato? Il cliente annulla dalla tessera entro 5 minuti, ma solo finché non tocca "Fatto":
// "Fatto" chiude il ritiro sul server (customer.redeemClosed), così la schermata non torna più e il premio
// non si può riavere, nemmeno ricaricando o da un altro telefono. Dopo, l'annullo si fa solo dalla Cassa.
// Attivo di default; il locale lo può spegnere dal bot.
const SELF_UNDO_MS = 5 * 60 * 1000;
const selfRedeemOn = (ctx) => ctx.db.getSettings().selfRedeem !== false;

// ultimo ritiro fatto dal cliente, se è ancora aperto (non chiuso con "Fatto" e nei 5 minuti)
function recentSelfRedeem(ctx, customer) {
  const evs = ctx.db.eventsOf(customer.id);
  const voided = new Set(evs.filter((e) => e.type === 'void').map((e) => e.ref));
  const e = evs.filter((x) => x.type === 'redeem' && x.by === 'customer' && !voided.has(x.id)).pop();
  if (!e || customer.redeemClosed === e.id || Date.now() - Date.parse(e.at) > SELF_UNDO_MS) return null;
  return { id: e.id, at: e.at, undoUntil: new Date(Date.parse(e.at) + SELF_UNDO_MS).toISOString() };
}

shop.post('/api/card/:token/redeem', (req, res) => {
  const { ctx } = req;
  const customer = ctx.db.findByToken(req.params.token);
  if (!customer) return res.status(404).json({ error: 'Tessera non trovata.' });
  if (!selfRedeemOn(ctx)) return res.status(403).json({ error: 'Per ritirare il premio mostra la tessera in cassa.' });
  if (req.body.requestId && ctx.db.findByRequestId(req.body.requestId)) return res.json({ redeem: recentSelfRedeem(ctx, customer) });
  if (ctx.db.stateOf(customer.id, ctx.cfg.stampsForReward).rewards < 1) return res.status(400).json({ error: 'Non hai premi da ritirare.' });
  ctx.db.addEvent({ type: 'redeem', customerId: customer.id, requestId: req.body.requestId, by: 'customer' });
  broadcast(ctx, customer, 'redeem');
  staffBroadcast(ctx, { type: 'redeem', name: customer.name, code: customer.code, token: customer.token });
  syncWallet(ctx, customer);
  console.log(`[premi] ${ctx.shop.slug}: ${customer.code} ha ritirato il premio dal telefono`);
  res.json({ redeem: recentSelfRedeem(ctx, customer) });
});

shop.post('/api/card/:token/redeem/undo', (req, res) => {
  const { ctx } = req;
  const customer = ctx.db.findByToken(req.params.token);
  if (!customer) return res.status(404).json({ error: 'Tessera non trovata.' });
  const r = recentSelfRedeem(ctx, customer);
  if (!r || r.id !== req.body.id) return res.status(400).json({ error: 'Non si può più annullare: chiedi in cassa.' });
  ctx.db.addEvent({ type: 'void', customerId: customer.id, ref: r.id, by: 'customer' });
  broadcast(ctx, customer, 'undo');
  staffBroadcast(ctx, { type: 'redeem-undo', name: customer.name, code: customer.code });
  syncWallet(ctx, customer);
  res.json({ ok: true });
});

// "Fatto" sulla schermata PREMIO VALIDO: il ritiro è definitivo, non si annulla più dalla tessera
shop.post('/api/card/:token/redeem/close', (req, res) => {
  const { ctx } = req;
  const customer = ctx.db.findByToken(req.params.token);
  if (!customer) return res.status(404).json({ error: 'Tessera non trovata.' });
  const r = recentSelfRedeem(ctx, customer);
  if (r && r.id === req.body.id) ctx.db.updateCustomer(customer.id, { redeemClosed: r.id });
  res.json({ ok: true });
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
  qrCache.delete(customer.code);
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

// QR della tessera mostrato in cassa: contiene il codice tessera (es. PZ-AB12C), non il token.
// Il token apre la tessera (dati, cancellazione, premio): chi fotografa il QR sul telefono di un cliente
// non deve poterlo usare. Il codice da solo non apre niente; la Cassa lo riconosce solo con il PIN.
// Il codice non cambia mai: il QR si disegna una volta sola.
const qrCache = new Map();
async function qrOf(code) {
  if (!qrCache.has(code)) {
    if (qrCache.size > 2000) qrCache.delete(qrCache.keys().next().value);
    qrCache.set(code, await QRCode.toDataURL(code, { margin: 1, width: 360 }));
  }
  return qrCache.get(code);
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
    qr: await qrOf(customer.code),
    saveUrl: wallet.enabled() ? wallet.saveUrl(customer) : null,
    walletSaved: !!customer.walletSaved,
    reviewUrl: ctx.db.getSettings().reviewUrl || null,
    messages: ctx.db.messagesFor(customer.id).slice(0, 5),
    consentMarketing: !!customer.consentMarketing,
    selfRedeem: selfRedeemOn(ctx),
    lastRedeem: recentSelfRedeem(ctx, customer),
    rewardText: ctx.cfg.rewardText,
    history: historyOf(ctx, customer),
    servedAt: Date.now(), // la pagina capisce se arriva dalla copia salvata nel telefono (sw.js)
  };
}

// Ultime operazioni della tessera, dalla più recente: timbri (con il premio sbloccato) e premi ritirati.
// Le operazioni annullate non compaiono.
function historyOf(ctx, customer, limit = 8) {
  const evs = ctx.db.eventsOf(customer.id);
  const voided = new Set(evs.filter((e) => e.type === 'void').map((e) => e.ref));
  const n = ctx.cfg.stampsForReward;
  const out = [];
  let stamps = 0;
  for (const e of evs) {
    if (voided.has(e.id)) continue;
    if (e.type === 'stamp') {
      stamps++;
      const reward = stamps >= n;
      if (reward) stamps -= n;
      out.push({ type: 'stamp', at: e.at, reward });
    } else if (e.type === 'redeem') {
      out.push({ type: 'redeem', at: e.at });
    }
  }
  return out.slice(-limit).reverse();
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
// I blocchi stanno nel database (chiave "attempts"): il server gratuito si riavvia spesso e non deve azzerarli.
// Si contano anche i PIN sbagliati di tutto il locale: se nell'ultima ora sono 20 o più (qualcuno prova da più
// indirizzi), ogni indirizzo si blocca al primo errore. Il personale con il PIN giusto continua a lavorare.
const attempts = {
  map: new Map(), MAX: 5, LOCK_MS: 15 * 60 * 1000, KEEP_MS: 24 * 3600e3,
  shopFails: new Map(), SHOP_MAX: 20, // slug -> orari dei PIN sbagliati nell'ultima ora
  saveTimer: null,
  check(k) {
    const f = this.map.get(k);
    return f && f.until > Date.now() ? Math.ceil((f.until - Date.now()) / 60000) : 0;
  },
  fail(k, lockNow = false) {
    const f = this.map.get(k);
    const n = f && !(f.until && f.until <= Date.now()) ? f.n + 1 : 1;
    const until = n >= this.MAX || lockNow ? Date.now() + this.LOCK_MS : 0;
    this.map.set(k, { n, until, at: Date.now() });
    if (this.map.size > 5000) this.map.delete(this.map.keys().next().value);
    this.save();
    return !!until;
  },
  ok(k) { if (this.map.delete(k)) this.save(); },
  // PIN sbagliati di tutto il locale nell'ultima ora, questo compreso
  shopFail(slug) {
    const now = Date.now();
    const list = (this.shopFails.get(slug) || []).filter((t) => now - t < 3600e3);
    list.push(now);
    this.shopFails.set(slug, list);
    return list.length;
  },
  // Una scrittura sola per una raffica di errori. Contengono indirizzi IP: si tengono al massimo 24 ore.
  save() {
    clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => {
      const now = Date.now();
      const ip = [...this.map].filter(([, f]) => f.until > now || now - (f.at || 0) < this.KEEP_MS);
      db.saveKey('attempts', { ip, shop: [...this.shopFails] });
    }, 1000);
  },
  async load() {
    const saved = await db.loadKey('attempts');
    if (!saved) return;
    const now = Date.now();
    for (const [k, f] of saved.ip || []) if (f.until > now || now - (f.at || 0) < this.KEEP_MS) this.map.set(k, f);
    for (const [slug, list] of saved.shop || []) this.shopFails.set(slug, list.filter((t) => now - t < 3600e3));
  },
};

// Chi sta usando la cassa: il gestore (PIN principale) o un dipendente (PIN personale, creato dal bot)
function checkPin(req, pin) {
  const { ctx } = req;
  const k = `pin|${ctx.shop.slug}|${req.ip}`;
  const locked = attempts.check(k);
  if (locked) return { error: `Troppi tentativi sbagliati: riprova tra ${locked} minuti.`, status: 429 };
  const who = shops.whoHasPin(ctx.shop, String(pin || ''));
  if (who) { attempts.ok(k); return { who }; }
  if (pin) {
    const many = attempts.shopFail(ctx.shop.slug) >= attempts.SHOP_MAX;
    if (attempts.fail(k, many)) {
      if (many) bot.alert(`🔐 ${ctx.cfg.pizzeriaName}: ${attempts.SHOP_MAX} o più PIN sbagliati nell'ultima ora, da più indirizzi. Ora ogni indirizzo si blocca al primo errore.`, `pinshop|${ctx.shop.slug}`);
      else bot.alert(`🔐 ${ctx.cfg.pizzeriaName}: 5 PIN sbagliati di fila su cassa/dashboard (indirizzo ${req.ip}). Bloccato per 15 minuti.`, `pin|${ctx.shop.slug}`);
    }
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

// Cliente aperto dalla Cassa: QR scansionato o codice scritto. Il QR delle tessere contiene il codice tessera;
// i QR mostrati prima (con il token) restano validi.
shop.get('/api/staff/customer/:id', requirePin, (req, res) => {
  const raw = String(req.params.id || '').trim();
  const customer = req.ctx.db.findByToken(raw) || req.ctx.db.findByCode(raw.toUpperCase());
  if (!customer) return res.status(404).json({ error: 'Tessera non riconosciuta.' });
  res.json(customerView(req.ctx, customer));
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

// Avvisi live per la Cassa. EventSource non può mandare header, ma il PIN non deve finire negli indirizzi
// (restano nei log e nella cronologia): la Cassa chiede col PIN un biglietto, valido una volta per 60 secondi,
// e apre gli avvisi con quello. Se la connessione cade, ne chiede uno nuovo.
const staffStreams = new Map(); // slug -> Set di risposte aperte
const streamTickets = new Map(); // biglietto -> { slug, until }
shop.post('/api/staff/stream-ticket', requirePin, (req, res) => {
  const now = Date.now();
  for (const [t, v] of streamTickets) if (v.until < now) streamTickets.delete(t);
  const ticket = crypto.randomBytes(18).toString('base64url');
  streamTickets.set(ticket, { slug: req.ctx.shop.slug, until: now + 60000 });
  res.json({ ticket });
});
shop.get('/api/staff/stream', (req, res) => {
  const t = streamTickets.get(String(req.query.t || ''));
  streamTickets.delete(String(req.query.t || ''));
  if (!t || t.slug !== req.ctx.shop.slug || t.until < Date.now()) return res.status(401).end();
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
    segmentLabel: c.auto ? `🤖 Automatico: ${(AUTOMATIONS[c.auto] || {}).label || c.auto}` : (SEGMENTS[c.segment] || {}).label,
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
  if (!jobsState) jobsState = (await db.loadKey('jobs')) || {};
  const now = romeNow();
  const due = (name, cond) => cond && jobsState[name] !== now.day;
  const mark = (name) => { jobsState[name] = now.day; db.saveKey('jobs', jobsState); };
  if (bot.enabled() && due('weekly', now.weekday === 'Mon' && now.hour >= 9)) {
    mark('weekly');
    await bot.sendBackup('🗓️ Backup settimanale automatico').catch((err) => console.error(`[bot] backup: ${err.message}`));
    await bot.sendWeeklyReports().catch((err) => console.error(`[bot] report: ${err.message}`));
  }
  // il 1° del mese: report del mese appena chiuso, in PDF, a te e ai gestori
  if (bot.enabled() && due('monthly', now.day.endsWith('-01') && now.hour >= 9)) {
    mark('monthly');
    await bot.sendMonthlyReports().catch((err) => console.error(`[bot] report mensile: ${err.message}`));
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
  // messaggi automatici ai clienti: in tarda mattinata, prima del pranzo
  if (due('auto', now.hour >= 11 && now.hour < 21)) {
    mark('auto');
    for (const ctx of shops.all()) await runAutomations(ctx).catch((err) => console.error(`[auto] ${ctx.shop.slug}: ${err.message}`));
  }
}

// ---------- Messaggi automatici ----------
// Ogni giorno il server guarda i clienti di ogni locale e manda da solo, nella tessera (Wallet e web):
//   near     "Ti manca 1 timbro"            una volta per ogni premio, se il cliente è passato da poco
//   review   "Lasciaci una recensione"      una volta sola, dopo la 3ª visita (se il locale ha il link)
//   inactive "Ci manchi"                    dopo 21 giorni senza visite, solo a chi ha dato il consenso alle offerte
// Al massimo un messaggio automatico al giorno per cliente. Si attivano/disattivano dal bot (scheda del locale).
// I messaggi passano dalle campagne: stesso limite di notifiche Google, compaiono nello storico della dashboard.
const AUTOMATIONS = {
  near: {
    label: 'Ti manca 1 timbro', promo: false,
    text: (cfg) => ({ title: `Ti manca 1 timbro! ${cfg.emoji}`, body: `Alla prossima visita da ${cfg.pizzeriaName}: ${cfg.rewardText.toLowerCase()}.` }),
    due: (c, s, cfg) => s.stamps === cfg.stampsForReward - 1 && recent(s.lastVisitAt, 30) && (c.autoSent || {}).near !== s.earned,
    mark: (c, s) => ({ near: s.earned }),
  },
  review: {
    label: 'Richiesta di recensione', promo: false,
    text: (cfg) => ({ title: `Ti piace ${cfg.pizzeriaName}?`, body: 'Lasciaci una recensione su Google: per noi conta tantissimo. Trovi il link nella tua tessera.' }),
    due: (c, s, cfg, settings) => !!settings.reviewUrl && s.visits >= 3 && recent(s.lastVisitAt, 3) && !(c.autoSent || {}).review,
    mark: () => ({ review: true }),
  },
  inactive: {
    label: 'Ci manchi (21 giorni)', promo: true,
    text: (cfg) => ({ title: `Ci manchi! ${cfg.emoji}`, body: `È da un po' che non passi da ${cfg.pizzeriaName}: i tuoi timbri ti aspettano. ${cfg.rewardText} è più vicino di quanto pensi!` }),
    due: (c, s) => s.visits >= 1 && !recent(s.lastVisitAt, 21) && recent(s.lastVisitAt, 120) && (c.autoSent || {}).inactive !== s.lastVisitAt,
    mark: (c, s) => ({ inactive: s.lastVisitAt }),
  },
};
const recent = (iso, days) => !!iso && Date.now() - Date.parse(iso) < days * DAY_MS;
const autoEnabled = (ctx, key) => (ctx.db.getSettings().auto || {})[key] !== false; // attive di default

async function runAutomations(ctx) {
  const { cfg } = ctx;
  const settings = ctx.db.getSettings();
  const done = new Set(); // un solo messaggio automatico per cliente in questo giro
  for (const [key, a] of Object.entries(AUTOMATIONS)) {
    if (!autoEnabled(ctx, key)) continue;
    const chosen = [];
    for (const c of ctx.db.customers) {
      if (done.has(c.id) || (a.promo && !c.consentMarketing)) continue;
      const s = ctx.db.stateOf(c.id, cfg.stampsForReward);
      if (!a.due(c, s, cfg, settings)) continue;
      chosen.push(c.id);
      done.add(c.id);
      // segnato subito: se il server riparte a metà, nessuno riceve due volte lo stesso messaggio
      ctx.db.updateCustomer(c.id, { autoSent: { ...(c.autoSent || {}), ...a.mark(c, s) } });
    }
    if (!chosen.length) continue;
    const campaign = ctx.db.createCampaign({
      ...a.text(cfg), segment: 'manual', ids: chosen, promo: a.promo, auto: key,
      sendAt: new Date().toISOString(), recipients: [], keepDays: 3,
    });
    await sendCampaign(ctx, campaign);
    console.log(`[auto] ${ctx.shop.slug}: "${a.label}" a ${chosen.length} clienti`);
  }
}

// ---------- Numeri di un mese (report mensile) ----------
const MONTHS = ['gennaio', 'febbraio', 'marzo', 'aprile', 'maggio', 'giugno', 'luglio', 'agosto', 'settembre', 'ottobre', 'novembre', 'dicembre'];

function monthNumbers(ctx, monthsAgo = 1) {
  const { cfg } = ctx;
  const n = cfg.stampsForReward;
  const now = new Date();
  const start = new Date(now.getFullYear(), now.getMonth() - monthsAgo, 1);
  const end = new Date(now.getFullYear(), now.getMonth() - monthsAgo + 1, 1);
  const prevStart = new Date(now.getFullYear(), now.getMonth() - monthsAgo - 1, 1);
  const { active } = stats(ctx);
  const inRange = (iso, a, b) => { const t = Date.parse(iso); return t >= a.getTime() && t < b.getTime(); };

  // prima visita di ogni cliente: le visite successive sono "di ritorno"
  const firstStamp = new Map();
  for (const e of active) if (e.type === 'stamp' && !firstStamp.has(e.customerId)) firstStamp.set(e.customerId, e.id);

  const numbers = (a, b) => {
    const stamps = active.filter((e) => e.type === 'stamp' && inRange(e.at, a, b));
    const visitors = new Set(stamps.map((e) => e.customerId));
    const repeat = stamps.filter((e) => firstStamp.get(e.customerId) !== e.id);
    return {
      stamps: stamps.length,
      visitors: visitors.size,
      returning: new Set(repeat.map((e) => e.customerId)).size,
      returningVisits: repeat.length,
      newMembers: ctx.db.customers.filter((c) => inRange(c.createdAt, a, b)).length,
      redeemed: active.filter((e) => e.type === 'redeem' && inRange(e.at, a, b)).length,
    };
  };
  const kpi = { ...numbers(start, end), members: ctx.db.customers.length, consent: ctx.db.customers.filter((c) => c.consentMarketing).length };

  // settimane del mese: 1-7, 8-14, 15-21, 22-fine
  const days = new Date(end - 1).getDate();
  const mon = MONTHS[start.getMonth()].slice(0, 3);
  const weeks = [[1, 7], [8, 14], [15, 21], [22, days]].map(([a, b]) => ({
    label: `${a}-${b} ${mon}`,
    stamps: active.filter((e) => e.type === 'stamp' && inRange(e.at, new Date(start.getFullYear(), start.getMonth(), a), new Date(start.getFullYear(), start.getMonth(), b + 1))).length,
  }));

  // consigli calcolati sui clienti di oggi
  const settings = ctx.db.getSettings();
  const views = ctx.db.customers.map((c) => ({ c, s: ctx.db.stateOf(c.id, n) }));
  const near = views.filter(({ s }) => s.stamps === n - 1).length;
  const sleeping = views.filter(({ c, s }) => c.consentMarketing && s.lastVisitAt && !recent(s.lastVisitAt, 30)).length;
  const tips = [];
  if (near) tips.push(`${near} ${near === 1 ? 'cliente è' : 'clienti sono'} a un timbro dal premio: ricevono già il promemoria automatico.`);
  if (sleeping) tips.push(`${sleeping} clienti con il consenso alle offerte non passano da più di 30 giorni: prova un'offerta dalla dashboard (Notifiche > "Non tornano da 30+ giorni").`);
  if (!settings.reviewUrl) tips.push('Aggiungi il link per le recensioni Google: dopo la 3ª visita i clienti ricevono la richiesta in automatico.');
  if (kpi.newMembers < 10) tips.push('Pochi nuovi iscritti: proponi la tessera a ogni scontrino ("Hai la nostra tessera? Inquadra qui") e tieni il QR su ogni tavolo.');
  if (!settings.avgTicket) tips.push('Indica lo scontrino medio (dal bot, Modifica > Scontrino medio): il report stimerà l\'incasso portato dai clienti tornati.');
  if (!tips.length) tips.push('Ottimo mese: continua così e prova un\'offerta per i giorni più vuoti.');

  return {
    monthLabel: `${MONTHS[start.getMonth()]} ${start.getFullYear()}`,
    kpi, prev: numbers(prevStart, start), weeks, tips: tips.slice(0, 4),
    avgTicket: Number(settings.avgTicket) || 0,
  };
}

// ---------- Wallet sync ----------

const classReady = new Set(); // slug dei locali con la classe Google già creata/aggiornata
async function ensureClass(ctx, { force = false } = {}) {
  if (!wallet.enabled() || (classReady.has(ctx.shop.slug) && !force)) return;
  // loghi pronti prima che Google li scarichi
  await images.get(shops.imageSpec(ctx.shop), 'logo.png');
  if (!ctx.shop.legacy) await images.get(shops.imageSpec(ctx.shop), 'wide-logo.png');
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

// Indirizzi dei locali cambiati (es. passaggio ai sottodomini): le tessere Wallet già emesse ricevono i link nuovi.
// Una volta sola: gli indirizzi aggiornati si ricordano nel database.
async function refreshLinksIfMoved() {
  if (!wallet.enabled()) return;
  const saved = (await db.loadKey('baseUrls')) || {};
  const now = Object.fromEntries(shops.all().map((ctx) => [ctx.shop.dataKey, ctx.cfg.baseUrl]));
  for (const ctx of shops.all()) {
    if (saved[ctx.shop.dataKey] && saved[ctx.shop.dataKey] !== now[ctx.shop.dataKey]) {
      console.log(`[wallet] ${ctx.shop.slug}: nuovo indirizzo ${now[ctx.shop.dataKey]}, aggiorno ${ctx.db.customers.length} tessere`);
      await syncAll(ctx);
    }
  }
  db.saveKey('baseUrls', now);
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
  get domain() { return shops.shopDomain(); },
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
    // Nuovo indirizzo (sottodominio): il vecchio resta e porta al nuovo; tessere Wallet aggiornate con i link nuovi
    if ('slug' in input) {
      const r = shops.rename(slug, input.slug);
      if (r.error || !r.oldSlug) return r;
      classReady.delete(r.oldSlug);
      const warnings = [];
      try {
        await images.warm(shops.imageSpec(r.ctx.shop));
        await ensureClass(r.ctx, { force: true });
      } catch (err) {
        warnings.push(`Google Wallet: ${err.message}`);
      }
      warmGifs(r.ctx);
      syncAll(r.ctx);
      console.log(`[locali] ${r.oldSlug} → ${r.ctx.shop.slug}`);
      return { ctx: r.ctx, warnings };
    }
    // Scontrino medio (solo per la stima dell'incasso nel report mensile)
    if ('avgTicket' in input) {
      const ctx = shops.get(slug);
      if (!ctx) return { error: 'Locale non trovato.' };
      const v = input.avgTicket === '' || input.avgTicket === null ? 0 : Number(String(input.avgTicket).replace(',', '.'));
      if (!Number.isFinite(v) || v < 0 || v > 1000) return { error: 'Scrivi un importo in euro, es. 18 o 22,50.' };
      ctx.db.updateSettings({ avgTicket: v || null });
      return { ctx };
    }
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
  // Messaggi automatici: stato e interruttori (scheda del locale nel bot)
  automations: (ctx) => Object.entries(AUTOMATIONS).map(([key, a]) => ({
    key, label: a.label, on: autoEnabled(ctx, key), promo: a.promo,
    note: key === 'review' && !ctx.db.getSettings().reviewUrl ? 'serve il link recensioni' : '',
  })),
  setAutomation(slug, key, on) {
    const ctx = shops.get(slug);
    if (!ctx || !AUTOMATIONS[key]) return null;
    ctx.db.updateSettings({ auto: { ...(ctx.db.getSettings().auto || {}), [key]: !!on } });
    return ctx;
  },
  runAutomations: (ctx) => runAutomations(ctx),
  // Premio ritirato dal telefono del cliente (acceso di default)
  selfRedeem: (ctx) => selfRedeemOn(ctx),
  setSelfRedeem(slug, on) {
    const ctx = shops.get(slug);
    if (!ctx) return null;
    ctx.db.updateSettings({ selfRedeem: !!on });
    return ctx;
  },
  // Kit di lancio in PDF: QR da tavolo, adesivi, istruzioni per il personale, testi per i social
  async launchKit(ctx) {
    const { cfg } = ctx;
    const links = manager.links(ctx);
    return pdf.launchKit({
      name: cfg.pizzeriaName, programName: cfg.programName, rewardText: cfg.rewardText, stampsForReward: cfg.stampsForReward,
      brandColor: cfg.brandColor, links, brand: process.env.BRAND_NAME || 'F5M',
      logo: (await images.get(shops.imageSpec(ctx.shop), 'logo.png')).buf,
      qr: await QRCode.toBuffer(links.signup, { margin: 1, width: 700 }),
    });
  },
  // Report di un mese in PDF (monthsAgo = 1: il mese appena chiuso; 0: il mese in corso)
  async monthlyReport(ctx, monthsAgo = 1) {
    const { cfg } = ctx;
    const r = monthNumbers(ctx, monthsAgo);
    return pdf.monthlyReport({
      ...r, name: cfg.pizzeriaName, brandColor: cfg.brandColor, brand: process.env.BRAND_NAME || 'F5M',
      logo: (await images.get(shops.imageSpec(ctx.shop), 'logo.png')).buf,
    });
  },
  monthNumbers: (ctx, monthsAgo = 1) => monthNumbers(ctx, monthsAgo),
  preview: (ctx) => images.preview(shops.imageSpec(ctx.shop)),
  prepareLogo: (buffer) => images.prepareLogo(buffer),
  themes: images.THEMES,
};

// Avviso su Telegram solo quando è online una NUOVA versione (Render indica il commit in RENDER_GIT_COMMIT).
// I semplici risvegli del server gratuito, che si addormenta dopo 15 minuti senza visite, non avvisano più.
async function announceDeploy() {
  const commit = process.env.RENDER_GIT_COMMIT;
  if (!commit) return; // in locale: nessun avviso
  const last = await db.loadKey('deploy');
  if (last && last.commit === commit) return;
  await db.saveKey('deploy', { commit, at: new Date().toISOString() });
  bot.alert(`🚀 Nuova versione online (${commit.slice(0, 7)}): ${shops.all().length} locali, database ${db.usingPostgres() ? 'Postgres' : 'file'}.`, `deploy|${commit}`, 0);
}

const ready = (async () => {
  await db.init();
  await attempts.load();
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
    await refreshLinksIfMoved();
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
    bot.start(manager).then(announceDeploy).catch((err) => console.error(`[bot] ${err.message}`));
    resolve();
  }));
})();

module.exports = { manager, ready }; // per i test
