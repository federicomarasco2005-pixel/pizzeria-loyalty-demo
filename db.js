// Archivio: clienti + ledger append-only degli eventi, tenuti in memoria.
// Persistenza su Postgres (se DATABASE_URL è impostata, es. su Render) oppure su file JSON in locale.
// Il saldo (timbri/premi) non è mai salvato: si ricalcola sempre dal ledger.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const FILE = path.join(__dirname, 'data', 'db.json');
const empty = () => ({ customers: [], events: [], campaigns: [], notifications: [], settings: {} });

// Archivi creati con versioni precedenti: aggiunge le sezioni mancanti.
function normalize(data) {
  return { ...empty(), ...data, settings: { ...(data && data.settings) } };
}

let db = empty();
let pool = null;
let saving = Promise.resolve();

async function init() {
  if (process.env.DATABASE_URL) {
    const { Pool } = require('pg');
    pool = new Pool({
      connectionString: process.env.DATABASE_URL,
      ssl: process.env.DATABASE_SSL === 'true' ? { rejectUnauthorized: false } : undefined,
    });
    await pool.query('CREATE TABLE IF NOT EXISTS kv (k TEXT PRIMARY KEY, v JSONB NOT NULL)');
    const { rows } = await pool.query("SELECT v FROM kv WHERE k = 'db'");
    if (rows[0]) db = normalize(rows[0].v);
    console.log(`[db] Postgres: ${db.customers.length} clienti caricati`);
  } else {
    try {
      db = normalize(JSON.parse(fs.readFileSync(FILE, 'utf8')));
    } catch {
      db = empty();
    }
    console.log(`[db] file locale: ${db.customers.length} clienti caricati`);
  }
}

function persist() {
  if (pool) {
    const snapshot = JSON.stringify(db);
    saving = saving
      .then(() => pool.query(
        "INSERT INTO kv (k, v) VALUES ('db', $1) ON CONFLICT (k) DO UPDATE SET v = EXCLUDED.v",
        [snapshot],
      ))
      .catch((err) => console.error(`[db] salvataggio fallito: ${err.message}`));
    return;
  }
  fs.mkdirSync(path.dirname(FILE), { recursive: true });
  const tmp = FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(db, null, 2));
  fs.renameSync(tmp, FILE);
}

const id = (bytes = 8) => crypto.randomBytes(bytes).toString('hex');

function shortCode() {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code;
  do {
    code = 'PZ-' + Array.from(crypto.randomBytes(5), (b) => alphabet[b % alphabet.length]).join('');
  } while (db.customers.some((c) => c.code === code));
  return code;
}

function createCustomer({ name, email, consentMarketing }) {
  const now = new Date().toISOString();
  const customer = {
    id: id(),
    token: crypto.randomBytes(16).toString('base64url'), // token opaco nel QR, nessun dato personale
    code: shortCode(),
    name,
    email,
    consentMarketing: !!consentMarketing,
    consentAt: now,
    createdAt: now,
  };
  db.customers.push(customer);
  addEvent({ type: 'signup', customerId: customer.id });
  return customer;
}

const findByEmail = (email) => db.customers.find((c) => c.email === email);
const findByToken = (token) => db.customers.find((c) => c.token === token);

function search(q) {
  q = q.toLowerCase().trim();
  if (!q) return [];
  return db.customers
    .filter((c) => c.name.toLowerCase().includes(q) || c.email.includes(q) || c.code.toLowerCase().includes(q))
    .slice(0, 10);
}

function addEvent({ type, customerId, ref = null, requestId = null, by = null }) {
  const event = { id: id(), type, customerId, ref, requestId, by, at: new Date().toISOString() };
  db.events.push(event);
  persist();
  return event;
}

const findByRequestId = (requestId) => requestId && db.events.find((e) => e.requestId === requestId);

// Rigioca il ledger del cliente e restituisce lo stato corrente.
function stateOf(customerId, stampsForReward) {
  const evs = db.events.filter((e) => e.customerId === customerId);
  const voided = new Set(evs.filter((e) => e.type === 'void').map((e) => e.ref));
  const s = { stamps: 0, rewards: 0, earned: 0, redeemed: 0, visits: 0, lastVisitAt: null, lastOp: null };
  for (const e of evs) {
    if (e.type === 'void' || voided.has(e.id)) continue;
    if (e.type === 'stamp') {
      s.stamps++;
      s.visits++;
      s.lastVisitAt = e.at;
      s.lastOp = e;
      if (s.stamps >= stampsForReward) {
        s.stamps -= stampsForReward;
        s.rewards++;
        s.earned++;
      }
    } else if (e.type === 'redeem') {
      s.rewards--;
      s.redeemed++;
      s.lastOp = e;
    }
  }
  return s;
}

// Azzera clienti e operazioni della demo, mantenendo le impostazioni del locale.
function reset() {
  db = { ...empty(), settings: db.settings };
  persist();
}

// ---------- Impostazioni del locale ----------

const getSettings = () => db.settings;

function updateSettings(patch) {
  db.settings = { ...db.settings, ...patch };
  persist();
  return db.settings;
}

// ---------- Notifiche (limite Google: 3 push per pass ogni 24 ore) ----------

const PUSH_LIMIT = 3;
const DAY = 24 * 60 * 60 * 1000;

function pushesLast24h(customerId, now = Date.now()) {
  return db.notifications.filter((n) => n.customerId === customerId && n.push && now - Date.parse(n.at) < DAY).length;
}

const canPush = (customerId) => pushesLast24h(customerId) < PUSH_LIMIT;

function logNotification(customerId, kind, push) {
  db.notifications.push({ customerId, kind, push, at: new Date().toISOString() });
  // tiene solo gli ultimi 7 giorni: servono solo per il conteggio
  const cutoff = Date.now() - 7 * DAY;
  db.notifications = db.notifications.filter((n) => Date.parse(n.at) > cutoff);
  persist();
}

// ---------- Campagne del gestore ----------

function createCampaign(data) {
  const c = { id: id(6), createdAt: new Date().toISOString(), status: 'scheduled', results: null, ...data };
  db.campaigns.push(c);
  persist();
  return c;
}

const findCampaign = (cid) => db.campaigns.find((c) => c.id === cid);

function updateCampaign(cid, patch) {
  const c = findCampaign(cid);
  if (!c) return null;
  Object.assign(c, patch);
  persist();
  return c;
}

const dueCampaigns = (now = Date.now()) =>
  db.campaigns.filter((c) => c.status === 'scheduled' && Date.parse(c.sendAt) <= now);

// Messaggi già inviati a un cliente (mostrati anche nella tessera web).
const messagesFor = (customerId) =>
  db.campaigns
    .filter((c) => c.status === 'sent' && c.recipients.includes(customerId))
    .map((c) => ({ id: c.id, title: c.title, body: c.body, at: c.sentAt }))
    .sort((a, b) => b.at.localeCompare(a.at));

module.exports = {
  get customers() { return db.customers; },
  get events() { return db.events; },
  get campaigns() { return db.campaigns; },
  init, createCustomer, findByEmail, findByToken, search, addEvent, findByRequestId, stateOf, reset,
  getSettings, updateSettings,
  PUSH_LIMIT, pushesLast24h, canPush, logNotification,
  createCampaign, findCampaign, updateCampaign, dueCampaigns, messagesFor,
};
