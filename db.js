// Archivio: un "negozio" di dati per ogni locale (clienti, ledger append-only degli eventi, campagne, impostazioni).
// I dati stanno in memoria (letture istantanee) e ogni modifica viene scritta subito:
//   - Postgres (DATABASE_URL impostata, es. su Render): tabelle vere, UNA RIGA per cliente / timbro / campagna.
//     Un timbro scrive una sola riga, non l'intero archivio.
//   - In locale: un file JSON per locale in data/.
// Ogni locale ha la sua chiave ("store"): 'db' per il primo locale (compatibile con le versioni precedenti), 'shop:<slug>' per gli altri.
// Il saldo (timbri/premi) non è mai salvato come numero modificabile: si ricalcola dal ledger, con un indice per cliente.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
let pool = null;
let saving = Promise.resolve();

// options.pool: un Pool già pronto (usato dai test con un Postgres in memoria)
async function init(options = {}) {
  if (options.pool) pool = options.pool;
  else if (!process.env.DATABASE_URL) {
    console.log('[db] file locali in data/');
    return;
  }
  else {
    const { Pool } = require('pg');
    pool = new Pool({
      connectionString: process.env.DATABASE_URL,
      ssl: process.env.DATABASE_SSL === 'true' ? { rejectUnauthorized: false } : undefined,
    });
  }
  if (!options.skipSchema) await pool.query(`
    CREATE TABLE IF NOT EXISTS kv (k TEXT PRIMARY KEY, v JSONB NOT NULL);
    CREATE TABLE IF NOT EXISTS customers (store TEXT NOT NULL, id TEXT NOT NULL, seq BIGSERIAL, data JSONB NOT NULL, PRIMARY KEY (store, id));
    CREATE TABLE IF NOT EXISTS events (store TEXT NOT NULL, id TEXT NOT NULL, seq BIGSERIAL, customer_id TEXT, at TIMESTAMPTZ, data JSONB NOT NULL, PRIMARY KEY (store, id));
    CREATE INDEX IF NOT EXISTS events_store_seq ON events (store, seq);
    CREATE TABLE IF NOT EXISTS campaigns (store TEXT NOT NULL, id TEXT NOT NULL, seq BIGSERIAL, data JSONB NOT NULL, PRIMARY KEY (store, id));
    CREATE TABLE IF NOT EXISTS notifications (store TEXT NOT NULL, customer_id TEXT, at TIMESTAMPTZ, data JSONB NOT NULL);
    CREATE INDEX IF NOT EXISTS notifications_store_at ON notifications (store, at);
  `);
  console.log('[db] Postgres collegato (tabelle clienti, eventi, campagne)');
}

const usingPostgres = () => !!pool;
const fileOf = (key) => path.join(DATA_DIR, `${key.replace(/[^a-z0-9_-]/gi, '_')}.json`);

// Scritture in coda: sempre nell'ordine in cui avvengono, mai in parallelo.
function run(sql, params) {
  saving = saving.then(() => pool.query(sql, params))
    .catch((err) => console.error(`[db] scrittura fallita: ${err.message}`));
  return saving;
}
const flush = () => saving;

async function loadKey(key) {
  if (pool) {
    const { rows } = await pool.query('SELECT v FROM kv WHERE k = $1', [key]);
    return rows[0] ? rows[0].v : null;
  }
  try {
    return JSON.parse(fs.readFileSync(fileOf(key), 'utf8'));
  } catch {
    return null;
  }
}

function saveKey(key, value) {
  if (pool) {
    return run('INSERT INTO kv (k, v) VALUES ($1, $2) ON CONFLICT (k) DO UPDATE SET v = EXCLUDED.v', [key, JSON.stringify(value)]);
  }
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const file = fileOf(key);
  fs.writeFileSync(file + '.tmp', JSON.stringify(value, null, 2));
  fs.renameSync(file + '.tmp', file);
}

async function deleteKey(key) {
  await saving;
  if (pool) {
    for (const t of ['customers', 'events', 'campaigns', 'notifications']) await pool.query(`DELETE FROM ${t} WHERE store = $1`, [key]);
    await pool.query('DELETE FROM kv WHERE k = ANY($1)', [[key, `settings:${key}`, `migrated:${key}`]]);
  } else {
    fs.rmSync(fileOf(key), { force: true });
  }
}

const id = (bytes = 8) => crypto.randomBytes(bytes).toString('hex');
const empty = () => ({ customers: [], events: [], campaigns: [], notifications: [], settings: {} });
function normalize(data) {
  return { ...empty(), ...data, settings: { ...(data && data.settings) } };
}

// Carica i dati di un locale da Postgres. La prima volta copia nelle tabelle l'archivio "tutto in uno"
// delle versioni precedenti (che resta nella tabella kv come copia di sicurezza).
async function loadTables(key) {
  const migrated = await loadKey(`migrated:${key}`);
  if (!migrated) {
    const old = await loadKey(key);
    if (old) {
      const d = normalize(old);
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        for (const c of d.customers) await client.query('INSERT INTO customers (store, id, data) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING', [key, c.id, c]);
        for (const e of d.events) await client.query('INSERT INTO events (store, id, customer_id, at, data) VALUES ($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING', [key, e.id, e.customerId, e.at, e]);
        for (const c of d.campaigns) await client.query('INSERT INTO campaigns (store, id, data) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING', [key, c.id, c]);
        for (const n of d.notifications) await client.query('INSERT INTO notifications (store, customer_id, at, data) VALUES ($1,$2,$3,$4)', [key, n.customerId, n.at, n]);
        await client.query('INSERT INTO kv (k, v) VALUES ($1,$2) ON CONFLICT (k) DO UPDATE SET v = EXCLUDED.v', [`settings:${key}`, d.settings]);
        await client.query('INSERT INTO kv (k, v) VALUES ($1,$2) ON CONFLICT (k) DO UPDATE SET v = EXCLUDED.v', [`migrated:${key}`, { at: new Date().toISOString() }]);
        await client.query('COMMIT');
        console.log(`[db] ${key}: archivio spostato nelle tabelle (${d.customers.length} clienti, ${d.events.length} eventi)`);
      } catch (err) {
        await client.query('ROLLBACK');
        throw err;
      } finally {
        client.release();
      }
    } else {
      await pool.query('INSERT INTO kv (k, v) VALUES ($1,$2) ON CONFLICT (k) DO NOTHING', [`migrated:${key}`, { at: new Date().toISOString() }]);
    }
  }
  const q = async (sql) => (await pool.query(sql, [key])).rows.map((r) => r.data);
  return {
    customers: await q('SELECT data FROM customers WHERE store = $1 ORDER BY seq'),
    events: await q('SELECT data FROM events WHERE store = $1 ORDER BY seq'),
    campaigns: await q('SELECT data FROM campaigns WHERE store = $1 ORDER BY seq'),
    notifications: await q("SELECT data FROM notifications WHERE store = $1 AND at > now() - interval '7 days' ORDER BY at"),
    settings: (await loadKey(`settings:${key}`)) || {},
  };
}

const PUSH_LIMIT = 3;
const DAY = 24 * 60 * 60 * 1000;

// Archivio dei dati di un locale. codePrefix: iniziali dei codici cliente (es. "PZ" → PZ-AB12C).
async function openStore(key, { codePrefix = 'PZ' } = {}) {
  let db = normalize(pool ? await loadTables(key) : await loadKey(key));

  // Indice degli eventi per cliente: il saldo si ricalcola guardando solo gli eventi di quel cliente
  let byCustomer = new Map();
  const indexEvent = (e) => {
    if (!byCustomer.has(e.customerId)) byCustomer.set(e.customerId, []);
    byCustomer.get(e.customerId).push(e);
  };
  const reindex = () => { byCustomer = new Map(); db.events.forEach(indexEvent); };
  reindex();
  const eventsOf = (customerId) => byCustomer.get(customerId) || [];

  // ---- scrittura: una riga alla volta su Postgres, file intero in locale ----
  const saveFile = () => { if (!pool) saveKey(key, db); };
  const put = {
    customer: (c) => (pool ? run('INSERT INTO customers (store, id, data) VALUES ($1,$2,$3) ON CONFLICT (store, id) DO UPDATE SET data = EXCLUDED.data', [key, c.id, c]) : saveFile()),
    event: (e) => (pool ? run('INSERT INTO events (store, id, customer_id, at, data) VALUES ($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING', [key, e.id, e.customerId, e.at, e]) : saveFile()),
    campaign: (c) => (pool ? run('INSERT INTO campaigns (store, id, data) VALUES ($1,$2,$3) ON CONFLICT (store, id) DO UPDATE SET data = EXCLUDED.data', [key, c.id, c]) : saveFile()),
    notification: (n) => (pool ? run('INSERT INTO notifications (store, customer_id, at, data) VALUES ($1,$2,$3,$4)', [key, n.customerId, n.at, n]) : saveFile()),
    settings: () => (pool ? saveKey(`settings:${key}`, db.settings) : saveFile()),
  };

  function shortCode() {
    const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    let code;
    do {
      code = `${codePrefix}-` + Array.from(crypto.randomBytes(5), (b) => alphabet[b % alphabet.length]).join('');
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
    put.customer(customer);
    addEvent({ type: 'signup', customerId: customer.id });
    return customer;
  }

  function updateCustomer(customerId, patch) {
    const c = db.customers.find((x) => x.id === customerId);
    if (!c) return null;
    Object.assign(c, patch);
    put.customer(c);
    return c;
  }

  // Cancellazione su richiesta del cliente (GDPR): via la scheda e tutti i suoi eventi e notifiche.
  async function deleteCustomer(customerId) {
    db.customers = db.customers.filter((c) => c.id !== customerId);
    db.events = db.events.filter((e) => e.customerId !== customerId);
    db.notifications = db.notifications.filter((n) => n.customerId !== customerId);
    for (const c of db.campaigns) {
      if (c.recipients && c.recipients.includes(customerId)) {
        c.recipients = c.recipients.filter((x) => x !== customerId);
        put.campaign(c);
      }
    }
    reindex();
    if (pool) {
      for (const t of ['events', 'notifications']) run(`DELETE FROM ${t} WHERE store = $1 AND customer_id = $2`, [key, customerId]);
      run('DELETE FROM customers WHERE store = $1 AND id = $2', [key, customerId]);
      await flush();
    } else saveFile();
  }

  // Tutti i dati di un cliente, in chiaro (diritto di accesso / portabilità)
  function exportCustomer(customerId) {
    const c = db.customers.find((x) => x.id === customerId);
    if (!c) return null;
    const { token, ...profile } = c;
    return {
      cliente: profile,
      operazioni: eventsOf(customerId).map(({ type, at, by, ref, id: eid }) => ({ id: eid, tipo: type, data: at, da: by, annulla: ref })),
      messaggi_ricevuti: db.campaigns.filter((x) => x.recipients && x.recipients.includes(customerId))
        .map((x) => ({ titolo: x.title, testo: x.body, inviato: x.sentAt })),
    };
  }

  const findByEmail = (email) => db.customers.find((c) => c.email === email);
  const findByCodeAndEmail = (code, email) =>
    db.customers.find((c) => c.code === code && c.email === email);
  const findByToken = (token) => db.customers.find((c) => c.token === token);

  // Ultimo timbro (non annullato) assegnato da una certa fonte, es. 'nfc'
  function lastStampBy(customerId, by) {
    const evs = eventsOf(customerId);
    const voided = new Set(evs.filter((e) => e.type === 'void').map((e) => e.ref));
    return evs.filter((e) => e.type === 'stamp' && e.by === by && !voided.has(e.id)).pop() || null;
  }

  function search(q) {
    q = q.toLowerCase().trim();
    if (!q) return [];
    return db.customers
      .filter((c) => c.name.toLowerCase().includes(q) || c.email.includes(q) || c.code.toLowerCase().includes(q))
      .slice(0, 10);
  }

  function addEvent({ type, customerId, ref = null, requestId = null, by = null, who = null }) {
    const event = { id: id(), type, customerId, ref, requestId, by, ...(who && { who }), at: new Date().toISOString() };
    db.events.push(event);
    indexEvent(event);
    put.event(event);
    return event;
  }

  const findByRequestId = (requestId) => requestId && db.events.find((e) => e.requestId === requestId);

  // Rigioca il ledger del cliente e restituisce lo stato corrente.
  function stateOf(customerId, stampsForReward) {
    const evs = eventsOf(customerId);
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
  async function reset() {
    db = { ...empty(), settings: db.settings };
    reindex();
    if (pool) {
      for (const t of ['customers', 'events', 'campaigns', 'notifications']) run(`DELETE FROM ${t} WHERE store = $1`, [key]);
      await flush();
    } else saveFile();
  }

  // ---------- Impostazioni del locale ----------

  const getSettings = () => db.settings;

  function updateSettings(patch) {
    db.settings = { ...db.settings, ...patch };
    put.settings();
    return db.settings;
  }

  // ---------- Notifiche (limite Google: 3 push per pass ogni 24 ore) ----------

  function pushesLast24h(customerId, now = Date.now()) {
    return db.notifications.filter((n) => n.customerId === customerId && n.push && now - Date.parse(n.at) < DAY).length;
  }

  const canPush = (customerId) => pushesLast24h(customerId) < PUSH_LIMIT;

  function logNotification(customerId, kind, push) {
    const n = { customerId, kind, push, at: new Date().toISOString() };
    db.notifications.push(n);
    // tiene solo gli ultimi 7 giorni: servono solo per il conteggio
    const cutoff = Date.now() - 7 * DAY;
    db.notifications = db.notifications.filter((x) => Date.parse(x.at) > cutoff);
    put.notification(n);
    if (pool && Math.random() < 0.05) run("DELETE FROM notifications WHERE store = $1 AND at < now() - interval '7 days'", [key]);
  }

  // ---------- Campagne del gestore ----------

  function createCampaign(data) {
    const c = { id: id(6), createdAt: new Date().toISOString(), status: 'scheduled', results: null, ...data };
    db.campaigns.push(c);
    put.campaign(c);
    return c;
  }

  const findCampaign = (cid) => db.campaigns.find((c) => c.id === cid);

  function updateCampaign(cid, patch) {
    const c = findCampaign(cid);
    if (!c) return null;
    Object.assign(c, patch);
    put.campaign(c);
    return c;
  }

  const dueCampaigns = (now = Date.now()) =>
    db.campaigns.filter((c) => c.status === 'scheduled' && Date.parse(c.sendAt) <= now);

  // Scadenza di un messaggio inviato (i messaggi di versioni precedenti valgono 3 giorni).
  const expiryOf = (c) => c.expiresAt || new Date(Date.parse(c.sentAt) + 3 * DAY).toISOString();
  const isActive = (c, now = Date.now()) => c.status === 'sent' && !c.removed && Date.parse(expiryOf(c)) > now;

  // Messaggi ancora validi per un cliente, dal più recente. Nella tessera Wallet ne resta solo
  // l'ultimo (limit 1) per non affollare i dettagli; la tessera web ne mostra qualcuno in più.
  const messagesFor = (customerId, limit = 3) =>
    db.campaigns
      .filter((c) => isActive(c) && c.recipients.includes(customerId))
      .map((c) => ({ id: `c_${c.id}`, title: c.title, body: c.body, at: c.sentAt, expiresAt: expiryOf(c) }))
      .sort((a, b) => b.at.localeCompare(a.at))
      .slice(0, limit);

  // Messaggi scaduti o eliminati ancora da togliere dalle tessere
  const campaignsToClean = () =>
    db.campaigns.filter((c) => c.status === 'sent' && !c.cleaned && !isActive(c));

  // Copia completa (backup)
  const snapshot = () => JSON.parse(JSON.stringify(db));

  return {
    key,
    get customers() { return db.customers; },
    get events() { return db.events; },
    get campaigns() { return db.campaigns; },
    createCustomer, updateCustomer, deleteCustomer, exportCustomer, findByEmail, findByCodeAndEmail, lastStampBy, findByToken, search,
    addEvent, findByRequestId, stateOf, eventsOf, reset,
    getSettings, updateSettings,
    PUSH_LIMIT, pushesLast24h, canPush, logNotification,
    createCampaign, findCampaign, updateCampaign, dueCampaigns, messagesFor, campaignsToClean, expiryOf, isActive,
    snapshot,
  };
}

module.exports = { init, loadKey, saveKey, deleteKey, openStore, flush, usingPostgres, PUSH_LIMIT };
