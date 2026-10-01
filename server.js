require('dotenv').config();
const path = require('path');
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
  });
}));

app.get('/card/:token', (req, res) => res.sendFile(path.join(__dirname, 'public', 'card.html')));

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
  db.addEvent({ type: 'stamp', customerId: customer.id, requestId: req.body.requestId, by: 'staff' });
  const after = db.stateOf(customer.id, cfg.stampsForReward);
  const rewardEarned = after.earned > before.earned;

  await syncWallet(customer, rewardEarned && {
    header: 'Premio sbloccato! 🍕',
    body: `${cfg.rewardText}: mostra la tessera alla prossima visita.`,
  });
  res.json({ ...customerView(customer), rewardEarned });
}));

app.post('/api/staff/redeem', requirePin, wrap(async (req, res) => {
  const customer = loadCustomer(req, res);
  if (!customer) return;
  if (db.findByRequestId(req.body.requestId)) return res.json({ ...customerView(customer), duplicate: true });
  if (db.stateOf(customer.id, cfg.stampsForReward).rewards < 1) {
    return res.status(400).json({ error: 'Nessun premio disponibile.' });
  }
  db.addEvent({ type: 'redeem', customerId: customer.id, requestId: req.body.requestId, by: 'staff' });
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
      type: e.type, at: e.at, name: nameOf[e.customerId] || '?', voided: voided.has(e.id),
    })),
  });
});

app.post('/api/admin/reset', requirePin, (req, res) => {
  db.reset();
  res.json({ ok: true });
});

// ---------- Wallet sync ----------

let classReady = false;
async function ensureClassOnce() {
  if (classReady) return;
  await wallet.ensureClass();
  classReady = true;
}

async function syncWallet(customer, message) {
  if (!wallet.enabled()) return;
  try {
    await ensureClassOnce();
    await wallet.upsertObject(customer, db.stateOf(customer.id, cfg.stampsForReward));
    if (message) await wallet.notify(customer, message.header, message.body);
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
