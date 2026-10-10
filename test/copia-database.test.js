// Copia del database (tools/copia-database.js): dati identici, saldi uguali, destinazione non vuota rifiutata.
const test = require('node:test');
const assert = require('node:assert');
const { newDb } = require('pg-mem');

function freshDb() {
  delete require.cache[require.resolve('../db')];
  return require('../db');
}
const memPool = () => { const { Pool } = newDb().adapters.createPg(); return new Pool(); };

test('copia completa: stessi clienti, stessi saldi, contenuto identico', async () => {
  const src = memPool();
  const db = freshDb();
  await db.init({ pool: src });
  await db.saveKey('shops', [{ slug: 'da-mario', name: 'Da Mario' }, { slug: 'eldorado', name: 'Eldorado' }]);
  const store = await db.openStore('db');
  const a = store.createCustomer({ name: 'Anna', email: 'anna@x.it', consentMarketing: true });
  const b = store.createCustomer({ name: 'Bruno', email: 'bruno@x.it' });
  for (let i = 0; i < 8; i++) store.addEvent({ type: 'stamp', customerId: a.id, by: 'staff', who: 'Giulia' });
  const last = store.addEvent({ type: 'stamp', customerId: b.id, by: 'nfc' });
  store.addEvent({ type: 'void', customerId: b.id, ref: last.id });
  store.addEvent({ type: 'redeem', customerId: a.id });
  store.updateSettings({ reviewUrl: 'https://g.page/x', nfcSecret: 'abc' });
  store.createCampaign({ title: 'Promo', body: 'Ciao', segment: 'all', recipients: [a.id] });
  store.logNotification(a.id, 'stamp', true);
  const other = await db.openStore('shop:eldorado');
  other.createCustomer({ name: 'Carlo', email: 'carlo@x.it' });
  await db.flush();

  const dst = memPool();
  const logs = [];
  delete require.cache[require.resolve('../tools/copia-database')];
  const report = await require('../tools/copia-database').copy(src, dst, (l) => logs.push(l));
  assert.ok(report.every((r) => r.identical), logs.join('\n'));
  assert.deepStrictEqual(Object.fromEntries(report.map((r) => [r.table, r.rows])),
    { kv: report.find((r) => r.table === 'kv').rows, customers: 3, events: 14, campaigns: 1, notifications: 1 });

  // Il server, riaprendo la copia, vede gli stessi dati
  const db2 = freshDb();
  await db2.init({ pool: dst, skipSchema: true });
  const again = await db2.openStore('db');
  assert.deepStrictEqual(again.customers.map((c) => c.email), ['anna@x.it', 'bruno@x.it']);
  assert.deepStrictEqual(again.stateOf(a.id, 6), store.stateOf(a.id, 6));
  assert.deepStrictEqual(again.stateOf(b.id, 6), store.stateOf(b.id, 6));
  assert.strictEqual(again.getSettings().nfcSecret, 'abc');
  assert.strictEqual(again.campaigns[0].title, 'Promo');
  assert.deepStrictEqual((await db2.loadKey('shops')).map((s) => s.slug), ['da-mario', 'eldorado']);
  assert.strictEqual((await db2.openStore('shop:eldorado')).customers[0].name, 'Carlo');
});

test('destinazione non vuota: copia rifiutata, nulla viene toccato', async () => {
  const src = memPool();
  const db = freshDb();
  await db.init({ pool: src });
  (await db.openStore('db')).createCustomer({ name: 'Anna', email: 'anna@x.it' });
  await db.flush();

  const dst = memPool();
  const dbDst = freshDb();
  await dbDst.init({ pool: dst });
  (await dbDst.openStore('db')).createCustomer({ name: 'Già presente', email: 'x@x.it' });
  await dbDst.flush();

  delete require.cache[require.resolve('../tools/copia-database')];
  await assert.rejects(require('../tools/copia-database').copy(src, dst, () => {}, { createSchema: false }), /non è vuota/);
  const { rows } = await dst.query('SELECT COUNT(*)::int AS n FROM customers');
  assert.strictEqual(rows[0].n, 1);
});
