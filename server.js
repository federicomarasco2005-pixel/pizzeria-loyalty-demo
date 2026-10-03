require('dotenv').config();
const path = require('path');
const crypto = require('crypto');
const express = require('express');
const QRCode = require('qrcode');
const db = require('./db');
const wallet = require('./wallet');

const PORT = Number(process.env.PORT) || 3000;
// Su Render RENDER_EXTERNAL_URL è impostata automaticamente.
const PUBLIC_URL = (process.env.PUBLIC_URL || process.env.RENDER_EXTERNAL_URL || `http://localhost:${PORT}`).replace(/\/$/, '');

const cfg = {
  pizzeriaName: process.env.PIZZERIA_NAME || 'Pizzeria Da Mario',
  programName: process.env.PROGRAM_NAME || 'Tessera Amici della Pizza',
  rewardText: process.env.REWARD_TEXT || 'Una pizza margherita omaggio',
  rewardShort: process.env.REWARD_SHORT || 'Margherita gratis', // versione breve per il fronte della tessera Wallet
  stampsForReward: Math.max(1, Number(process.env.STAMPS_FOR_REWARD) || 6),
  brandColor: process.env.BRAND_COLOR || '#b3261e',
  staffPin: process.env.STAFF_PIN || '1234',
  cooldownSec: Number(process.env.STAMP_COOLDOWN_SEC) || 0,
  publicUrl: PUBLIC_URL,
  issuerId: process.env.GOOGLE_ISSUER_ID || '',
  keyJson: process.env.GOOGLE_SA_JSON || '', // contenuto del JSON della service account (hosting)
  keyFile: path.resolve(__dirname, process.env.GOOGLE_KEY_FILE || './service-account.json'),
  classSuffix: process.env.GOOGLE_CLASS_SUFFIX || 'pizzeria_demo_v1',
  logoUrl: process.env.LOGO_URL || `${PUBLIC_URL}/logo.png`,
  // Cartella pubblica con le immagini stamps-<totale>-<n>.png (generate da tools/gen-stamps.ps1)
  stampsImageBase: (process.env.STAMPS_IMAGE_BASE || `${PUBLIC_URL}/stamps`).replace(/\/$/, ''),
  // Logo largo per l'intestazione del Wallet (tools/gen-wide-logo.ps1); WIDE_LOGO_URL=off per non usarlo
  wideLogoUrl: process.env.WIDE_LOGO_URL === 'off' ? '' : (process.env.WIDE_LOGO_URL || `${PUBLIC_URL}/wide-logo.png`),
  // QR dentro la tessera Wallet: di default spento per lasciare spazio alle pizze (WALLET_QR=on per riattivarlo)
  walletQr: process.env.WALLET_QR === 'on',
};

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const wrap = (fn) => (req, res, next) => fn(req, res, next).catch(next);

// ---------- Cliente ----------

app.get('/api/config', (req, res) => {
  res.json({
    pizzeriaName: cfg.pizzeriaName,
    programName: cfg.programName,
    rewardText: cfg.rewardText,
    stampsForReward: cfg.stampsForReward,
    brandColor: cfg.brandColor,
    walletEnabled: wallet.enabled(),
  });
});

app.post('/api/signup', wrap(async (req, res) => {
  const name = String(req.body.name || '').trim().slice(0, 60);
  const email = String(req.body.email || '').trim().toLowerCase().slice(0, 120);
  if (!name) return res.status(400).json({ error: 'Inserisci il tuo nome.' });
  if (!EMAIL_RE.test(email)) return res.status(400).json({ error: 'Email non valida.' });
  if (!req.body.acceptTerms) return res.status(400).json({ error: 'Devi accettare il regolamento per iscriverti.' });

  // Demo: se l'email esiste già restituiamo la tessera esistente invece di crearne una nuova.
  let customer = db.findByEmail(email);
  if (!customer) customer = db.createCustomer({ name, email, consentMarketing: !!req.body.consentMarketing });

  await syncWallet(customer);
  res.json({ token: customer.token });
}));

app.get('/api/card/:token', wrap(async (req, res) => {
  const customer = db.findByToken(req.params.token);
  if (!customer) return res.status(404).json({ error: 'Tessera non trovata.' });
  const state = db.stateOf(customer.id, cfg.stampsForReward);
  res.json({
    name: customer.name,
    code: customer.code,
    stamps: state.stamps,
    rewards: state.rewards,
    stampsForReward: cfg.stampsForReward,
    qr: await QRCode.toDataURL(customer.token, { margin: 1, width: 360 }),
    saveUrl: wallet.enabled() ? wallet.saveUrl(customer) : null,
    walletSaved: await walletSaved(customer),
    reviewUrl: db.getSettings().reviewUrl || null,
    messages: db.messagesFor(customer.id).slice(0, 5),
  });
}));

// Aggiornamenti in tempo reale per la tessera web (Server-Sent Events).
const streams = new Map(); // token -> Set di risposte aperte

app.get('/api/card/:token/stream', (req, res) => {
  const { token } = req.params;
  if (!db.findByToken(token)) return res.status(404).end();
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

function broadcast(customer, type, extra = {}) {
  const clients = streams.get(customer.token);
  if (!clients || !clients.size) return;
  const s = db.stateOf(customer.id, cfg.stampsForReward);
  const payload = `data: ${JSON.stringify({ type, stamps: s.stamps, rewards: s.rewards, ...extra })}\n\n`;
  clients.forEach((res) => res.write(payload));
}

// La tessera è già nel Google Wallet del cliente? Una volta confermato da Google resta salvato;
// prima di allora si richiede al massimo ogni 20 secondi (la pagina web interroga il server spesso).
const savedChecks = new Map(); // customerId -> timestamp ultimo controllo
async function walletSaved(customer) {
  if (customer.walletSaved) return true;
  if (!wallet.enabled()) return false;
  const last = savedChecks.get(customer.id) || 0;
  if (Date.now() - last < 20000) return false;
  savedChecks.set(customer.id, Date.now());
  if (await wallet.isSaved(customer)) {
    db.updateCustomer(customer.id, { walletSaved: true });
    return true;
  }
  return false;
}

app.get('/card/:token',(req, res) => res.sendFile(path.join(__dirname, 'public', 'card.html')));

app.get('/api/poster-qr', wrap(async (req, res) => {
  res.json({ url: PUBLIC_URL, qr: await QRCode.toDataURL(PUBLIC_URL, { margin: 1, width: 800 }) });
}));

// ---------- Staff / Admin (protetti da PIN) ----------

function requirePin(req, res, next) {
  if (req.get('x-staff-pin') !== cfg.staffPin) return res.status(401).json({ error: 'PIN errato.' });
  next();
}

function customerView(customer) {
  const s = db.stateOf(customer.id, cfg.stampsForReward);
  return {
    token: customer.token,
    code: customer.code,
    name: customer.name,
    email: customer.email,
    stamps: s.stamps,
    rewards: s.rewards,
    visits: s.visits,
    stampsForReward: cfg.stampsForReward,
    lastVisitAt: s.lastVisitAt,
    canUndo: !!s.lastOp,
  };
}

function loadCustomer(req, res) {
  const customer = db.findByToken(String(req.body.token || req.params.token || ''));
  if (!customer) res.status(404).json({ error: 'Tessera non riconosciuta.' });
  return customer;
}

app.post('/api/staff/login', requirePin, (req, res) => res.json({ ok: true }));

app.get('/api/staff/customer/:token', requirePin, (req, res) => {
  const customer = loadCustomer(req, res);
  if (customer) res.json(customerView(customer));
});

app.get('/api/staff/search', requirePin, (req, res) => {
  res.json(db.search(String(req.query.q || '')).map(customerView));
});

app.post('/api/staff/stamp', requirePin, wrap(async (req, res) => {
  const customer = loadCustomer(req, res);
  if (!customer) return;
  if (db.findByRequestId(req.body.requestId)) return res.json({ ...customerView(customer), duplicate: true });

  const before = db.stateOf(customer.id, cfg.stampsForReward);
  if (cfg.cooldownSec && before.lastVisitAt && Date.now() - Date.parse(before.lastVisitAt) < cfg.cooldownSec * 1000) {
    return res.status(429).json({ error: `Timbro già assegnato da meno di ${cfg.cooldownSec} secondi.` });
  }
  const { rewardEarned } = await addStamp(customer, { requestId: req.body.requestId, by: 'staff' });
  res.json({ ...customerView(customer), rewardEarned });
}));

// Assegna un timbro (usato dalla Cassa e dall'adesivo NFC): ledger, tessera web live, Wallet.
async function addStamp(customer, { requestId, by }) {
  const before = db.stateOf(customer.id, cfg.stampsForReward);
  const event = db.addEvent({ type: 'stamp', customerId: customer.id, requestId, by });
  const after = db.stateOf(customer.id, cfg.stampsForReward);
  const rewardEarned = after.earned > before.earned;
  broadcast(customer, rewardEarned ? 'reward' : 'stamp');

  // Premio: messaggio dedicato. Timbro normale: notifica di aggiornamento del saldo
  // (solo se il cliente non ha già ricevuto 3 notifiche nelle ultime 24 ore).
  // Nel Wallet la GIF animata si vede solo ora; dopo qualche minuto torna l'immagine fissa.
  await syncWallet(customer, rewardEarned && {
    header: 'Premio sbloccato! 🍕',
    body: `${cfg.rewardText}: mostra la tessera alla prossima visita.`,
  }, { notifyOnUpdate: !rewardEarned && db.canPush(customer.id), animated: true });
  settleWallet(customer);
  return { before, after, rewardEarned, event };
}

// Dopo l'animazione la tessera Wallet torna all'immagine fissa (pizze ferme),
// così riaprendola più tardi l'animazione non riparte.
const settleTimers = new Map();
const SETTLE_MS = (Number(process.env.WALLET_ANIM_MINUTES) || 3) * 60 * 1000;
function settleWallet(customer) {
  clearTimeout(settleTimers.get(customer.id));
  settleTimers.set(customer.id, setTimeout(() => {
    settleTimers.delete(customer.id);
    syncWallet(customer, null, { animated: false });
  }, SETTLE_MS));
}

// ---------- Timbro NFC del gestore ----------
// Il chip NFC del timbro (o un adesivo) contiene l'indirizzo /tap/<segreto>. Il gestore lo avvicina al telefono
// del cliente, che lo apre: la pagina riconosce la tessera memorizzata su quel telefono e aggiunge il punto.
// Protezioni: segreto rigenerabile, un timbro NFC per visita (pausa configurabile), avviso live in Cassa.

function nfcSecret() {
  let { nfcSecret: s } = db.getSettings();
  if (!s) {
    s = crypto.randomBytes(9).toString('base64url');
    db.updateSettings({ nfcSecret: s });
  }
  return s;
}
const nfcUrl = () => `${PUBLIC_URL}/tap/${nfcSecret()}`;
const nfcCooldownHours = () => {
  const h = Number(db.getSettings().nfcCooldownHours);
  return Number.isFinite(h) && h >= 0 ? h : 3;
};

app.get('/tap/:secret', (req, res) => res.sendFile(path.join(__dirname, 'public', 'tap.html')));

app.post('/api/tap', wrap(async (req, res) => {
  const settings = db.getSettings();
  if (settings.nfcEnabled === false) return res.status(403).json({ error: 'Il timbro con NFC è disattivato: chiedi in cassa.' });
  if (String(req.body.secret || '') !== nfcSecret()) {
    return res.status(403).json({ error: 'Questo timbro NFC non è più valido: chiedi il punto in cassa.' });
  }

  // Tessera salvata su questo telefono, oppure prima volta: codice tessera + email
  let customer = req.body.token ? db.findByToken(String(req.body.token)) : null;
  if (!customer && req.body.code && req.body.email) {
    const code = String(req.body.code).trim().toUpperCase().replace(/^(PZ-?)?/, 'PZ-');
    customer = db.findByCodeAndEmail(code, String(req.body.email).trim().toLowerCase());
    if (!customer) return res.status(404).json({ error: 'Codice o email non corretti.', needLogin: true });
  }
  if (!customer) return res.status(404).json({ needLogin: true });

  if (req.body.requestId && db.findByRequestId(req.body.requestId)) {
    return res.json({ token: customer.token, duplicate: true });
  }
  const last = db.lastStampBy(customer.id, 'nfc');
  const waitMs = last ? Date.parse(last.at) + nfcCooldownHours() * 3600e3 - Date.now() : 0;
  if (waitMs > 0) {
    const next = new Date(Date.now() + waitMs).toLocaleTimeString('it-IT', { hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Rome' });
    return res.status(429).json({
      token: customer.token,
      error: `Hai già ricevuto il punto per questa visita. Il prossimo sarà possibile dalle ${next}.`,
    });
  }

  const { before, after, rewardEarned } = await addStamp(customer, { requestId: req.body.requestId, by: 'nfc' });
  staffBroadcast({ type: 'nfc', name: customer.name, code: customer.code, token: customer.token, stamps: after.stamps, rewardEarned });
  res.json({ token: customer.token, before: { stamps: before.stamps, rewards: before.rewards }, rewardEarned });
}));

// Avvisi live per la Cassa (EventSource non può mandare header: il PIN arriva in query)
const staffStreams = new Set();
app.get('/api/staff/stream', (req, res) => {
  if (req.query.pin !== cfg.staffPin) return res.status(401).end();
  res.set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
  res.flushHeaders();
  res.write('retry: 3000\n\n');
  staffStreams.add(res);
  const ping = setInterval(() => res.write(': ping\n\n'), 25000);
  req.on('close', () => { clearInterval(ping); staffStreams.delete(res); });
});
function staffBroadcast(event) {
  const payload = `data: ${JSON.stringify(event)}\n\n`;
  staffStreams.forEach((res) => res.write(payload));
}

app.get('/api/admin/nfc', requirePin, (req, res) => {
  const s = db.getSettings();
  res.json({ url: nfcUrl(), enabled: s.nfcEnabled !== false, cooldownHours: nfcCooldownHours() });
});

app.post('/api/admin/nfc', requirePin, (req, res) => {
  const patch = {};
  if (typeof req.body.enabled === 'boolean') patch.nfcEnabled = req.body.enabled;
  if (req.body.cooldownHours !== undefined) {
    const h = Number(req.body.cooldownHours);
    if (!Number.isFinite(h) || h < 0 || h > 48) return res.status(400).json({ error: 'Pausa non valida (0–48 ore).' });
    patch.nfcCooldownHours = h;
  }
  // Nuovo segreto: i chip scritti prima smettono di funzionare
  if (req.body.regenerate) patch.nfcSecret = crypto.randomBytes(9).toString('base64url');
  db.updateSettings(patch);
  const s = db.getSettings();
  res.json({ url: nfcUrl(), enabled: s.nfcEnabled !== false, cooldownHours: nfcCooldownHours() });
});

app.post('/api/staff/redeem', requirePin, wrap(async (req, res) => {
  const customer = loadCustomer(req, res);
  if (!customer) return;
  if (db.findByRequestId(req.body.requestId)) return res.json({ ...customerView(customer), duplicate: true });
  if (db.stateOf(customer.id, cfg.stampsForReward).rewards < 1) {
    return res.status(400).json({ error: 'Nessun premio disponibile.' });
  }
  db.addEvent({ type: 'redeem', customerId: customer.id, requestId: req.body.requestId, by: 'staff' });
  broadcast(customer, 'redeem');
  await syncWallet(customer);
  res.json(customerView(customer));
}));

// Annulla l'ultima operazione (timbro o riscatto) con un evento "void": il ledger resta tracciato.
app.post('/api/staff/undo', requirePin, wrap(async (req, res) => {
  const customer = loadCustomer(req, res);
  if (!customer) return;
  const { lastOp } = db.stateOf(customer.id, cfg.stampsForReward);
  if (!lastOp) return res.status(400).json({ error: 'Nessuna operazione da annullare.' });
  db.addEvent({ type: 'void', customerId: customer.id, ref: lastOp.id, by: 'staff' });
  broadcast(customer, 'undo');
  await syncWallet(customer);
  res.json(customerView(customer));
}));

app.get('/api/admin/stats', requirePin, (req, res) => {
  const now = Date.now();
  const DAY = 86400000;
  const views = db.customers.map(customerView);
  const voided = new Set(db.events.filter((e) => e.type === 'void').map((e) => e.ref));
  const active = db.events.filter((e) => e.type !== 'void' && !voided.has(e.id));
  const nameOf = Object.fromEntries(db.customers.map((c) => [c.id, c.name]));

  res.json({
    pizzeriaName: cfg.pizzeriaName,
    stampsForReward: cfg.stampsForReward,
    rewardText: cfg.rewardText,
    walletEnabled: wallet.enabled(),
    kpi: {
      members: views.length,
      marketingConsent: db.customers.filter((c) => c.consentMarketing).length,
      stamps: active.filter((e) => e.type === 'stamp').length,
      returning: views.filter((v) => v.visits >= 2).length,
      rewardsEarned: views.reduce((n, v) => n + Math.floor((v.visits) / cfg.stampsForReward), 0),
      rewardsRedeemed: active.filter((e) => e.type === 'redeem').length,
      nearReward: views.filter((v) => v.stamps === cfg.stampsForReward - 1).length,
      inactive30: views.filter((v) => v.lastVisitAt && now - Date.parse(v.lastVisitAt) > 30 * DAY).length,
      newLast7: db.customers.filter((c) => now - Date.parse(c.createdAt) < 7 * DAY).length,
    },
    customers: views.sort((a, b) => (b.lastVisitAt || '').localeCompare(a.lastVisitAt || '')),
    events: db.events.slice(-25).reverse().map((e) => ({
      type: e.type, by: e.by, at: e.at, name: nameOf[e.customerId] || '?', voided: voided.has(e.id),
    })),
  });
});

app.post('/api/admin/reset', requirePin, (req, res) => {
  db.reset();
  res.json({ ok: true });
});

// ---------- Impostazioni del locale ----------

app.get('/api/admin/settings', requirePin, (req, res) => res.json(db.getSettings()));

app.post('/api/admin/settings', requirePin, (req, res) => {
  const reviewUrl = String(req.body.reviewUrl || '').trim();
  const mapsUrl = String(req.body.mapsUrl || '').trim();
  const phone = String(req.body.phone || '').trim().slice(0, 30);
  for (const [url, what] of [[reviewUrl, 'della recensione'], [mapsUrl, 'di Google Maps']]) {
    if (url && !/^https:\/\/\S+$/.test(url)) return res.status(400).json({ error: `Il link ${what} deve iniziare con https://` });
  }
  if (phone && !/^\+?[\d\s./-]{6,}$/.test(phone)) return res.status(400).json({ error: 'Numero di telefono non valido.' });
  const settings = db.updateSettings({ reviewUrl, mapsUrl, phone });
  // Aggiorna in background le tessere già emesse (i link compaiono nei dettagli del pass).
  (async () => { for (const c of db.customers) await syncWallet(c); })();
  res.json(settings);
});

// ---------- Notifiche del gestore ----------

const DAY_MS = 24 * 60 * 60 * 1000;
const SEGMENTS = {
  all: { label: 'Tutti gli iscritti', test: () => true },
  near: { label: 'A 1 timbro dal premio', test: (s) => s.stamps === cfg.stampsForReward - 1 },
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
function resolveAudience({ segment, ids = [], promo }) {
  const seg = SEGMENTS[segment] || SEGMENTS.all;
  const pool = segment === 'manual' ? db.customers.filter((c) => ids.includes(c.id)) : db.customers;
  const inSegment = pool.filter((c) => seg.test(db.stateOf(c.id, cfg.stampsForReward), c));
  const recipients = promo ? inSegment.filter((c) => c.consentMarketing) : inSegment;
  return {
    recipients,
    excludedNoConsent: inSegment.length - recipients.length,
    pushable: recipients.filter((c) => db.canPush(c.id)).length,
  };
}

app.get('/api/admin/segments', requirePin, (req, res) => {
  res.json({
    pushLimit: db.PUSH_LIMIT,
    segments: Object.entries(SEGMENTS).map(([key, s]) => ({
      key, label: s.label, count: key === 'manual' ? null : resolveAudience({ segment: key }).recipients.length,
    })),
    customers: db.customers.map((c) => ({
      id: c.id, name: c.name, code: c.code, consentMarketing: c.consentMarketing, pushesLast24h: db.pushesLast24h(c.id),
    })),
  });
});

app.post('/api/admin/audience', requirePin, (req, res) => {
  const a = resolveAudience(req.body);
  res.json({ count: a.recipients.length, pushable: a.pushable, textOnly: a.recipients.length - a.pushable, excludedNoConsent: a.excludedNoConsent });
});

app.get('/api/admin/campaigns', requirePin, (req, res) => {
  res.json([...db.campaigns].reverse().slice(0, 30).map((c) => ({ ...c, segmentLabel: (SEGMENTS[c.segment] || {}).label })));
});

app.post('/api/admin/campaigns', requirePin, wrap(async (req, res) => {
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
  const campaign = db.createCampaign({
    title, body, segment: req.body.segment, ids, promo: req.body.promo !== false,
    sendAt: sendAt.toISOString(), recipients: [],
  });
  if (sendAt <= new Date()) await sendCampaign(campaign);
  res.json(db.findCampaign(campaign.id));
}));

app.post('/api/admin/campaigns/:id/cancel', requirePin, (req, res) => {
  const c = db.findCampaign(req.params.id);
  if (!c || c.status !== 'scheduled') return res.status(400).json({ error: 'Invio non annullabile.' });
  res.json(db.updateCampaign(c.id, { status: 'cancelled' }));
});

let sending = false;
async function sendCampaign(campaign) {
  db.updateCampaign(campaign.id, { status: 'sending' });
  const { recipients, excludedNoConsent } = resolveAudience(campaign);
  const results = { total: recipients.length, push: 0, textOnly: 0, failed: 0, excludedNoConsent };
  for (const customer of recipients) {
    if (wallet.enabled()) {
      const r = await wallet.notify(customer, campaign.title, campaign.body, {
        push: db.canPush(customer.id), messageId: `c_${campaign.id}`,
      });
      if (!r.ok) results.failed++;
      else if (r.push) { results.push++; db.logNotification(customer.id, 'campaign', true); }
      else results.textOnly++;
    }
    // La tessera web aperta mostra subito il messaggio.
    broadcast(customer, 'message', { title: campaign.title, body: campaign.body });
  }
  db.updateCampaign(campaign.id, {
    status: 'sent', sentAt: new Date().toISOString(), recipients: recipients.map((c) => c.id), results,
  });
  console.log(`[notifiche] "${campaign.title}" inviata a ${results.total} (push ${results.push}, solo testo ${results.textOnly}, errori ${results.failed})`);
}

// Invia le campagne programmate scadute. Chiamato ogni 30 secondi e da /api/cron
// (un ping esterno tiene sveglio il server gratuito, che altrimenti va in pausa).
async function processDueCampaigns() {
  if (sending) return;
  sending = true;
  try {
    for (const c of db.dueCampaigns()) await sendCampaign(c);
  } catch (err) {
    console.error(`[notifiche] ${err.message}`);
  } finally {
    sending = false;
  }
}

app.get('/api/cron', wrap(async (req, res) => {
  await processDueCampaigns();
  res.json({ ok: true, scheduled: db.campaigns.filter((c) => c.status === 'scheduled').length });
}));

// ---------- Wallet sync ----------

let classReady = false;
async function ensureClassOnce() {
  if (classReady) return;
  await wallet.ensureClass();
  classReady = true;
}

async function syncWallet(customer, message, options = {}) {
  if (!wallet.enabled()) return;
  try {
    await ensureClassOnce();
    await wallet.upsertObject(customer, db.stateOf(customer.id, cfg.stampsForReward), {
      ...options, ...db.getSettings(),
    });
    if (options.notifyOnUpdate) db.logNotification(customer.id, 'stamp', true);
    if (message) {
      const r = await wallet.notify(customer, message.header, message.body, { push: db.canPush(customer.id) });
      if (r.push) db.logNotification(customer.id, 'reward', true);
    }
  } catch (err) {
    // Il ledger è la fonte autorevole: un errore Wallet non blocca l'operazione in cassa.
    console.error(`[wallet] ${err.message}`);
  }
}

app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: 'Errore interno.' });
});

(async () => {
  await db.init();
  if (wallet.init(cfg)) {
    try {
      await ensureClassOnce();
    } catch (err) {
      console.error(`[wallet] ${err.message}`);
    }
  }
  setInterval(processDueCampaigns, 30000);
  processDueCampaigns();
  app.listen(PORT, () => {
    console.log(`\n${cfg.pizzeriaName} — demo loyalty`);
    console.log(`  Locale:        http://localhost:${PORT}`);
    console.log(`  URL pubblico:  ${PUBLIC_URL}`);
    console.log(`  Iscrizione:    ${PUBLIC_URL}/`);
    console.log(`  Staff:         ${PUBLIC_URL}/staff.html`);
    console.log(`  Dashboard:     ${PUBLIC_URL}/admin.html`);
    console.log(`  QR da tavolo:  ${PUBLIC_URL}/poster.html\n`);
  });
})();
