// Archivio dei dati: saldo dal ledger, cancellazione (privacy), tabelle Postgres e migrazione dal vecchio formato.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'tessere-db-'));
const { newDb } = require('pg-mem');

// Ogni test usa una copia "fresca" del modulo (stato interno: pool e coda di scrittura)
function freshDb() {
  delete require.cache[require.resolve('../db')];
  return require('../db');
}

async function exercise(store) {
  const a = store.createCustomer({ name: 'Anna', email: 'anna@x.it', consentMarketing: true });
  const b = store.createCustomer({ name: 'Bruno', email: 'bruno@x.it' });
  for (let i = 0; i < 7; i++) store.addEvent({ type: 'stamp', customerId: a.id, by: 'staff', who: 'Giulia' });
  const last = store.addEvent({ type: 'stamp', customerId: b.id, by: 'nfc' });
  store.addEvent({ type: 'void', customerId: b.id, ref: last.id });
  store.addEvent({ type: 'redeem', customerId: a.id });
  return { a, b };
}

test('saldo ricalcolato dal ledger (timbri, premi, annulli)', async () => {
  const db = freshDb();
  await db.init();
  const store = await db.openStore('t1');
  const { a, b } = await exercise(store);
  assert.deepStrictEqual(
    (({ stamps, rewards, earned, redeemed, visits }) => ({ stamps, rewards, earned, redeemed, visits }))(store.stateOf(a.id, 6)),
    { stamps: 1, rewards: 0, earned: 1, redeemed: 1, visits: 7 });
  assert.strictEqual(store.stateOf(b.id, 6).stamps, 0, 'il timbro annullato non conta');
  assert.strictEqual(store.eventsOf(a.id).find((e) => e.type === 'stamp').who, 'Giulia');
});

test('file locale: i dati sopravvivono alla riapertura', async () => {
  const db = freshDb();
  await db.init();
  const s1 = await db.openStore('t2', { codePrefix: 'BL' });
  const { a } = await exercise(s1);
  assert.match(a.code, /^BL-[A-Z2-9]{5}$/);
  const s2 = await (freshDb()).openStore('t2');
  assert.strictEqual(s2.customers.length, 2);
  assert.strictEqual(s2.stateOf(a.id, 6).visits, 7);
});

test('cancellazione cliente ed esportazione dati', async () => {
  const db = freshDb();
  await db.init();
  const store = await db.openStore('t3');
  const { a, b } = await exercise(store);
  const exp = store.exportCustomer(a.id);
  assert.strictEqual(exp.cliente.email, 'anna@x.it');
  assert.strictEqual(exp.cliente.token, undefined, 'il token segreto non va nell\'export');
  assert.ok(exp.operazioni.length >= 8);
  await store.deleteCustomer(a.id);
  assert.strictEqual(store.findByEmail('anna@x.it'), undefined);
  assert.strictEqual(store.eventsOf(a.id).length, 0);
  assert.strictEqual(store.events.some((e) => e.customerId === a.id), false);
  assert.ok(store.findByEmail('bruno@x.it'), 'gli altri clienti restano');
  const reopened = await (freshDb()).openStore('t3');
  assert.strictEqual(reopened.customers.length, 1);
  assert.strictEqual(reopened.customers[0].id, b.id);
});

test('Postgres: una riga per evento, dati ricaricati uguali', async () => {
  const mem = newDb();
  const { Pool } = mem.adapters.createPg();
  let db = freshDb();
  await db.init({ pool: new Pool() });
  const store = await db.openStore('pg1');
  const { a, b } = await exercise(store);
  store.updateSettings({ reviewUrl: 'https://g.page/x' });
  await db.flush();
  const pool2 = new Pool();
  const { rows } = await pool2.query("SELECT count(*)::int AS n FROM events WHERE store = 'pg1'");
  assert.strictEqual(rows[0].n, store.events.length);

  db = freshDb();
  // il modulo nuovo usa lo stesso database (come dopo un riavvio del server)
  const again = await (async () => { const m = db; await m.init({ pool: pool2, skipSchema: true }); return m.openStore('pg1'); })();
  assert.strictEqual(again.customers.length, 2);
  assert.deepStrictEqual(again.stateOf(a.id, 6), store.stateOf(a.id, 6));
  assert.strictEqual(again.stateOf(b.id, 6).stamps, 0);
  assert.strictEqual(again.getSettings().reviewUrl, 'https://g.page/x');

  await again.deleteCustomer(a.id);
  const left = await pool2.query("SELECT count(*)::int AS n FROM events WHERE store = 'pg1' AND customer_id = $1", [a.id]);
  assert.strictEqual(left.rows[0].n, 0);
});

test('Postgres: migrazione dal vecchio archivio "tutto in uno"', async () => {
  const mem = newDb();
  const { Pool } = mem.adapters.createPg();
  const pool = new Pool();
  const db = freshDb();
  await db.init({ pool });
  // come lo salvavano le versioni precedenti: un'unica riga nella tabella kv
  const old = {
    customers: [{ id: 'c1', token: 't', code: 'PZ-AAAAA', name: 'Vecchio', email: 'v@x.it', createdAt: '2026-01-01T00:00:00Z' }],
    events: [
      { id: 'e1', type: 'signup', customerId: 'c1', at: '2026-01-01T00:00:00Z' },
      { id: 'e2', type: 'stamp', customerId: 'c1', by: 'staff', at: '2026-01-02T00:00:00Z' },
      { id: 'e3', type: 'stamp', customerId: 'c1', by: 'nfc', at: '2026-01-03T00:00:00Z' },
    ],
    campaigns: [], notifications: [], settings: { nfcSecret: 'abc' },
  };
  await pool.query("INSERT INTO kv (k, v) VALUES ('db', $1)", [JSON.stringify(old)]);
  const store = await db.openStore('db');
  assert.strictEqual(store.customers.length, 1);
  assert.strictEqual(store.stateOf('c1', 6).stamps, 2);
  assert.strictEqual(store.getSettings().nfcSecret, 'abc');
  // seconda apertura: niente doppioni
  const db2 = freshDb();
  await db2.init({ pool, skipSchema: true });
  const again = await db2.openStore('db');
  assert.strictEqual(again.events.length, 3);
});
