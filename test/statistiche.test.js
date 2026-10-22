// Calcolo delle statistiche di tutti i locali (statistiche.js) su dati inventati, senza server.
const test = require('node:test');
const assert = require('node:assert');
const { compute } = require('../statistiche');

const DAY = 86400000;
const NOW = Date.parse('2026-10-22T12:00:00Z');
const at = (daysAgo, hour = 12) => new Date(NOW - daysAgo * DAY + (hour - 12) * 3600e3).toISOString();

// Locale finto con lo stesso aspetto di un ctx vero: scheda, configurazione e archivio
function fakeShop({ slug, theme = 'caffe', legacy = false, createdDaysAgo = 40, customers, events, campaigns = [] }) {
  return {
    shop: { slug, name: `Locale ${slug}`, theme, legacy, createdAt: at(createdDaysAgo) },
    cfg: { stampsForReward: 3 },
    db: {
      customers, events, campaigns,
      getSettings: () => ({ avgTicket: 4 }),
      stateOf: (id, n) => ({ earned: Math.floor(events.filter((e) => e.customerId === id && e.type === 'stamp').length / n) }),
    },
  };
}
let seq = 0;
const stamp = (customerId, daysAgo, extra = {}) => ({ id: `e${++seq}`, type: 'stamp', customerId, at: at(daysAgo), by: 'staff', who: 'Gestore', ...extra });

const bar = fakeShop({
  slug: 'bar',
  customers: [
    { id: 'a', name: 'Anna', email: 'anna@x.it', createdAt: at(35), consentMarketing: true, walletSaved: true },
    { id: 'b', name: 'Bruno', email: 'bruno@x.it', createdAt: at(35) },
    { id: 'c', name: 'Carla', email: 'carla@x.it', createdAt: at(2) },
  ],
  events: [
    // Anna: iscritta 35 giorni fa, torna dopo 3 giorni e poi spesso (premio al 3° timbro)
    stamp('a', 35), stamp('a', 32), stamp('a', 20), stamp('a', 10), stamp('a', 8), stamp('a', 5), stamp('a', 3),
    { id: 'r1', type: 'redeem', customerId: 'a', at: at(19) },
    // Bruno: solo il giorno dell'iscrizione
    stamp('b', 35),
    // Carla: iscritta da 2 giorni, timbro NFC di notte
    stamp('c', 2, { by: 'nfc', at: new Date(NOW - 2 * DAY + 11 * 3600e3).toISOString() }),
    // un timbro annullato non conta
    stamp('b', 1, { id: 'x1' }), { id: 'v1', type: 'void', customerId: 'b', ref: 'x1', at: at(1) },
  ],
  campaigns: [{ status: 'sent', auto: 'inactive', sentAt: at(15), recipients: ['b'] }],
});
const demo = fakeShop({ slug: 'demo', legacy: true, customers: [{ id: 'd', name: 'Demo', email: 'd@x.it', createdAt: at(5) }], events: [stamp('d', 5)] });

test('numeri di un locale: iscritti, ritorni, premi, controlli', () => {
  const s = compute([bar, demo], NOW).shops.find((x) => x.slug === 'bar');
  assert.strictEqual(s.members, 3);
  assert.strictEqual(s.consent, 1);
  assert.strictEqual(s.wallet, 1);
  assert.deepStrictEqual(s.returned7, { n: 1, d: 2, pct: 50 }, 'Anna sì, Bruno no; Carla è iscritta da troppo poco');
  assert.deepStrictEqual(s.returned30, { n: 1, d: 2, pct: 50 });
  assert.strictEqual(s.neverBack, 1, 'Bruno');
  assert.strictEqual(s.stamps, 9, 'il timbro annullato non conta');
  assert.strictEqual(s.rewards.redeemed, 1);
  assert.strictEqual(s.rewards.avgDaysToFirst, 15, 'Anna arriva al 3° timbro dopo 15 giorni');
  assert.strictEqual(s.messages.inactive, 1);
  assert.deepStrictEqual(s.missYouBack, { n: 0, d: 1, pct: 0 });
  assert.strictEqual(s.nfc30, 1);
  assert.strictEqual(s.nfcNight30, 1, 'NFC alle 23 in Italia');
  assert.strictEqual(s.fromNfc, 0);
  assert.strictEqual(s.money.returnVisits30, 5, 'ultimi 30 giorni, senza il primo timbro di ogni cliente (quello di Carla)');
  assert.strictEqual(s.money.estimate30, 20);
  assert.strictEqual(s.pilot.activated, false, '3 iscritti, non 20');
  assert.strictEqual(s.weeklyStamps.reduce((a, b) => a + b, 0), 9);
});

test('totali senza il locale demo, mai dati dei clienti', () => {
  const r = compute([bar, demo], NOW);
  assert.strictEqual(r.totals.shops, 1);
  assert.strictEqual(r.totals.members, 3);
  const text = JSON.stringify(r);
  for (const personal of ['Anna', 'anna@x.it', 'Bruno', 'Carla', 'Demo']) assert.ok(!text.includes(personal), personal);
});
