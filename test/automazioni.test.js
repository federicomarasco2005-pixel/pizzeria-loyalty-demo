// Messaggi automatici ai clienti (con orologio finto: giorni e fasce orarie), prova dal bot, kit di lancio e report mensile in PDF.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const PORT = 3700 + Math.floor(Math.random() * 90);
const vapid = require('web-push').generateVAPIDKeys(); // chiavi di prova delle notifiche web
Object.assign(process.env, {
  PORT: String(PORT), DATA_DIR: fs.mkdtempSync(path.join(os.tmpdir(), 'tessere-auto-')), DATABASE_URL: '',
  GOOGLE_ISSUER_ID: '', TELEGRAM_BOT_TOKEN: '', STAFF_PIN: '222222', PUBLIC_URL: `http://localhost:${PORT}`,
  VAPID_PUBLIC_KEY: vapid.publicKey, VAPID_PRIVATE_KEY: vapid.privateKey,
});
const { manager, ready } = require('../server');
const bot = require('../bot');
const { compute } = require('../statistiche');
const notificheWeb = require('../notifiche-web');

const sent = [];
const fakeTelegram = async (method, params, file) => {
  if (method === 'answerCallbackQuery') return true;
  sent.push({ method, chat: params.chat_id, text: params.text || params.caption || '', kb: params.reply_markup, file });
  return { message_id: sent.length };
};
const OWNER = { id: 1, first_name: 'Federico' };
const tap = (data) => bot.handleUpdate({ callback_query: { id: 'q', from: OWNER, data, message: { chat: { id: 1 } } } });
const msg = (text) => bot.handleUpdate({ message: { chat: { id: 1 }, from: OWNER, text } });
const DAY = 86400000;
// ora italiana (ottobre 2026: ora legale, +02:00), es. at('2026-10-15T08:30') = giovedì 15 ottobre alle 8:30
const at = (s) => Date.parse(`${s}:00+02:00`);
let ctx, bar;

// cliente con timbri dati alle ore indicate (in ordine)
function customer(shop, name, times, { consent = false } = {}) {
  const c = shop.db.createCustomer({ name, email: `${name.toLowerCase()}@x.it`, consentMarketing: consent });
  c.createdAt = new Date(times.length ? at(times[0]) - 60000 : Date.now()).toISOString();
  for (const t of times) {
    const e = shop.db.addEvent({ type: 'stamp', customerId: c.id, by: 'staff' });
    e.at = new Date(at(t)).toISOString();
  }
  return c;
}
const day = (d, hh = '09:00') => `2026-10-${String(d).padStart(2, '0')}T${hh}`;
const auto = (shop, key) => shop.db.campaigns.filter((c) => c.auto === key && !c.test);
const to = (shop, key) => auto(shop, key).map((c) => c.recipients);

test.before(async () => {
  await ready;
  await bot.start(manager, { api: fakeTelegram });
  await msg('/start');
  ctx = (await manager.create({ name: 'Trattoria Prova', rewardText: 'Un dolce omaggio', stampsForReward: 6, brandColor: '#2e7d32', theme: 'pizza', reviewUrl: 'https://g.page/prova' })).ctx;
  bar = (await manager.create({ name: 'Bar Orari', rewardText: 'Un caffè omaggio', stampsForReward: 6, brandColor: '#5d4037', theme: 'caffe', reviewUrl: 'https://g.page/bar' })).ctx;
});
test.after(() => setTimeout(() => process.exit(0), 50));

test('bar (profilo giorno): ogni messaggio nella sua fascia, una volta sola, al massimo uno al giorno', async () => {
  assert.strictEqual(manager.autoProfile(bar), 'giorno');
  // giovedì 15 ottobre
  const near = customer(bar, 'Anna', [day(10), day(11), day(12), day(13), day(14)]);        // a 1 timbro dal premio, ultima visita ieri
  const nearToday = customer(bar, 'Aldo', [day(11), day(12), day(13), day(14), day(15, '07:30')]); // a 1 timbro, passato stamattina
  const rev = customer(bar, 'Bruno', [day(13), day(14), day(15, '07:00')]);                  // 3ª visita stamattina
  const miss = customer(bar, 'Carla', [day(1)], { consent: true });                          // 14 giorni senza visite, consenso
  const missNo = customer(bar, 'Dario', [day(1)]);                                           // 14 giorni, niente consenso
  const wait = customer(bar, 'Elena', [day(1), day(2), day(3), day(6), day(7), day(8)]);    // premio pronto da 7 giorni
  const both = customer(bar, 'Fabio', [day(10), day(11), day(12), day(13), day(14, '14:00')]); // a 1 timbro e già 5 visite

  await manager.runAutomations(bar, at(day(15, '07:50')));
  assert.strictEqual(bar.db.campaigns.length, 0, 'prima delle 8 non parte niente');

  await manager.runAutomations(bar, at(day(15, '08:30')));
  assert.deepStrictEqual(to(bar, 'near'), [[near.id, both.id]]);
  assert.deepStrictEqual(to(bar, 'inactive'), [[miss.id]]);
  assert.deepStrictEqual(to(bar, 'waiting'), [[wait.id]]);
  assert.deepStrictEqual(to(bar, 'review'), [], 'la recensione aspetta le 10 e 2 ore dalla visita');
  assert.ok(!bar.db.campaigns.some((c) => c.recipients.includes(missNo.id)), 'senza consenso: niente "ci manchi"');
  assert.ok(!bar.db.campaigns.some((c) => c.recipients.includes(nearToday.id)), '"ti manca 1 timbro" parte dal giorno dopo');
  assert.strictEqual(bar.db.messagesFor(near.id)[0].title, auto(bar, 'near')[0].title, 'il messaggio compare nella tessera web');

  await manager.runAutomations(bar, at(day(15, '10:00')));
  // Aldo (5 visite, passato alle 7:30) e Bruno: 2 ore dopo la visita. Fabio aspetta: oggi ha già ricevuto un messaggio
  assert.deepStrictEqual(to(bar, 'review'), [[nearToday.id, rev.id]]);
  const n = bar.db.campaigns.length;
  await manager.runAutomations(bar, at(day(15, '10:10')));
  await manager.runAutomations(bar, at(day(15, '21:30')));
  assert.strictEqual(bar.db.campaigns.length, n, 'niente di ripetuto, niente di sera');

  // venerdì: Aldo riceve "ti manca 1 timbro"; Anna e Fabio la recensione (5 visite, ultima 1–2 giorni fa)
  await manager.runAutomations(bar, at(day(16, '08:15')));
  assert.deepStrictEqual(to(bar, 'near').at(-1), [nearToday.id]);
  await manager.runAutomations(bar, at(day(16, '10:30')));
  assert.deepStrictEqual(to(bar, 'review').at(-1), [near.id, both.id]);

  // limite di 2 messaggi automatici in 7 giorni: con il premio pronto da 8 giorni, "il tuo premio ti aspetta" partirebbe…
  const gaia = customer(bar, 'Gaia', [day(9), day(10), day(11), day(12), day(13), day(14)]);
  const waitingOn22 = () => manager.autoPlan(bar, gaia, at(day(22, '08:30'))).find((p) => p.key === 'waiting').block;
  assert.strictEqual(waitingOn22(), null);
  // …ma non se nei 7 giorni prima ne ha già ricevuti 2
  bar.db.updateCustomer(gaia.id, { autoSent: { days: ['2026-10-20', '2026-10-21'] } });
  assert.match(waitingOn22(), /2 messaggi automatici in 7 giorni/);

  // spento dal bot: un cliente vicino al premio non riceve "ti manca 1 timbro"
  await tap(`autot:${bar.shop.slug}|near|0`);
  assert.strictEqual(manager.automations(bar).find((a) => a.key === 'near').on, false);
  assert.match(sent.at(-1).text, /Messaggi automatici/);
  const franco = customer(bar, 'Franco', [day(12), day(13), day(14), day(15), day(16)]);
  await manager.runAutomations(bar, at(day(17, '08:30')));
  assert.ok(!auto(bar, 'near').some((c) => c.recipients.includes(franco.id)));
  manager.setAutomation(bar.shop.slug, 'near', true);
});

test('pizzeria (profilo sera): "ti manca 1 timbro" il giovedì o venerdì pomeriggio, recensione il giorno dopo a pranzo', async () => {
  assert.strictEqual(manager.autoProfile(ctx), 'sera');
  const near = customer(ctx, 'Gino', [day(1, '21:00'), day(3, '21:00'), day(5, '21:00'), day(8, '21:00'), day(9, '21:00')]); // venerdì 9
  const rev = customer(ctx, 'Ivo', [day(2, '21:00'), day(9, '21:00'), day(14, '21:00')]);  // 3ª visita mercoledì 14 sera
  await manager.runAutomations(ctx, at(day(12, '18:00')));  // lunedì: troppo presto e giorno sbagliato
  await manager.runAutomations(ctx, at(day(14, '22:00')));  // mercoledì sera: fuori fascia
  assert.strictEqual(ctx.db.campaigns.length, 0);
  await manager.runAutomations(ctx, at(day(15, '13:00')));  // giovedì a pranzo: recensione
  assert.deepStrictEqual(to(ctx, 'review'), [[rev.id]]);
  await manager.runAutomations(ctx, at(day(15, '18:00')));  // giovedì pomeriggio: 6 giorni dopo, "ti manca 1 timbro"
  assert.deepStrictEqual(to(ctx, 'near'), [[near.id]]);
});

test('prova dal bot: stato della tessera e invio immediato, che non conta nelle statistiche', async () => {
  const c = customer(bar, 'Federico', [day(20), day(21)], { consent: false });
  sent.length = 0;
  await tap(`auto:${bar.shop.slug}`);
  assert.ok(sent.at(-1).kb.inline_keyboard.flat().some((b) => b.callback_data === `ptest:${bar.shop.slug}`));
  await tap(`ptest:${bar.shop.slug}`);
  await msg(c.code.split('-')[1].toLowerCase()); // anche senza prefisso e in minuscolo
  const plan = sent.at(-1);
  assert.match(plan.text, /Prova notifiche/);
  assert.match(plan.text, /Ti manca 1 timbro<\/b> — ha 2 timbri su 6/);
  assert.match(plan.text, /Ci manchi<\/b> — il cliente non ha dato il consenso/);

  const before = bar.db.campaigns.length;
  await tap(`psend:${bar.shop.slug}|${c.code}|near`);
  const test1 = bar.db.campaigns.at(-1);
  assert.strictEqual(bar.db.campaigns.length, before + 1);
  assert.deepStrictEqual([test1.test, test1.auto, test1.recipients], [true, 'near', [c.id]]);
  assert.match(sent.at(-1).text, /Wallet non è attivo/, 'nei test Google Wallet è spento');
  assert.strictEqual(bar.db.customers.find((x) => x.id === c.id).autoSent, undefined, 'la prova non segna il messaggio come mandato');
  await tap(`psend:${bar.shop.slug}|${c.code}|inactive`);
  assert.match(sent.at(-1).text, /consenso alle offerte/);
  const s = compute([bar]).shops[0];
  assert.strictEqual(s.messages.near, 3, 'le prove non contano nelle statistiche (3 veri: Anna e Fabio, poi Aldo)');
});

test('notifiche web: il telefono si iscrive dalla tessera, i messaggi arrivano lì se la tessera non è nel Wallet', async () => {
  const B = `http://localhost:${PORT}/${bar.shop.slug}`;
  const post = (p, body) => fetch(B + p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const delivered = [];
  let answer = 201;
  notificheWeb.setSender(async (sub, payload) => {
    if (answer !== 201) throw Object.assign(new Error('scaduta'), { statusCode: answer });
    delivered.push({ endpoint: sub.endpoint, ...JSON.parse(payload) });
  });
  const lia = customer(bar, 'Lia', [day(20), day(21)]);
  const sub = { endpoint: 'https://push.example.com/lia', keys: { p256dh: 'BHx'.padEnd(87, 'a'), auth: 'segreto123' } };

  // la tessera sa che le notifiche web ci sono (chiave pubblica nei dati della pagina)
  const page = await (await fetch(`${B}/card/${lia.token}`)).text();
  assert.ok(page.includes(vapid.publicKey));
  assert.strictEqual((await post(`/api/card/${lia.token}/push`, { subscription: { ...sub, endpoint: 'http://non-sicuro' } })).status, 400);
  assert.strictEqual((await post('/api/card/inventato/push', { subscription: sub })).status, 404);
  assert.strictEqual((await post(`/api/card/${lia.token}/push`, { subscription: sub })).status, 200);
  assert.strictEqual(bar.db.findByToken(lia.token).webPush.length, 1);

  // prova dal bot: arriva come notifica web, con il link alla tessera
  await tap(`psend:${bar.shop.slug}|${lia.code}|near`);
  assert.match(sent.at(-1).text, /con notifica web/);
  assert.strictEqual(delivered.length, 1);
  assert.match(delivered[0].title, /Ti manca 1 timbro/);
  assert.ok(delivered[0].title.startsWith(`${bar.shop.name} · `), 'dalla tendina si vede quale locale scrive');
  assert.ok(delivered[0].url.endsWith(`/card/${encodeURIComponent(lia.token)}`));

  // con la tessera nel Wallet le notifiche web non partono (niente doppioni)
  bar.db.updateCustomer(lia.id, { walletSaved: true });
  await tap(`psend:${bar.shop.slug}|${lia.code}|waiting`);
  assert.strictEqual(delivered.length, 1);
  bar.db.updateCustomer(lia.id, { walletSaved: false });

  // indirizzo scaduto (telefono cambiato): tolto dalla scheda
  answer = 410;
  await tap(`psend:${bar.shop.slug}|${lia.code}|review`);
  assert.strictEqual(bar.db.findByToken(lia.token).webPush.length, 0);
  answer = 201;

  // disattivate dalla tessera; l'export mostra solo il servizio, non le chiavi del telefono
  await post(`/api/card/${lia.token}/push`, { subscription: sub });
  const exp = await (await fetch(`${B}/api/card/${lia.token}/export`)).json();
  assert.deepStrictEqual(exp.notifiche_web.map((n) => n.servizio), ['push.example.com']);
  assert.ok(!JSON.stringify(exp).includes('segreto123'));
  assert.strictEqual((await post(`/api/card/${lia.token}/push/off`, { endpoint: sub.endpoint })).status, 200);
  assert.strictEqual(bar.db.findByToken(lia.token).webPush.length, 0);
});

test('kit di lancio e report del mese in PDF, anche dal bot', async () => {
  // visite di questo mese (il report guarda il mese in corso)
  for (let i = 0; i < 3; i++) {
    const c = ctx.db.createCustomer({ name: `Mese${i}`, email: `mese${i}@x.it` });
    for (let k = 0; k < 5; k++) ctx.db.addEvent({ type: 'stamp', customerId: c.id, by: 'staff' });
  }
  const kit = await manager.launchKit(ctx);
  assert.strictEqual(kit.subarray(0, 4).toString(), '%PDF');
  assert.ok(kit.length > 5000);

  const nums = manager.monthNumbers(ctx, 0);
  assert.ok(nums.kpi.stamps >= 13, `timbri del mese: ${nums.kpi.stamps}`);
  assert.strictEqual(nums.kpi.members, ctx.db.customers.length);
  assert.strictEqual(nums.weeks.length, 4);
  assert.ok(nums.tips.length >= 1);
  assert.strictEqual((await manager.monthlyReport(ctx, 0)).subarray(0, 4).toString(), '%PDF');

  sent.length = 0;
  await tap(`kit:${ctx.shop.slug}`);
  await tap(`mpdf:${ctx.shop.slug}`);
  assert.deepStrictEqual(sent.map((m) => m.method), ['sendDocument', 'sendDocument']);
  assert.match(sent[1].file.name, /^report-trattoria-prova-/);

  sent.length = 0;
  await bot.sendMonthlyReports();
  assert.ok(sent.length >= 1 && sent.every((m) => m.method === 'sendDocument' && m.chat === 1));
});

test('bot: interruttore del ritiro premio dal telefono del cliente', async () => {
  assert.strictEqual(manager.selfRedeem(ctx), true);
  await tap(`selfr:${ctx.shop.slug}`);
  assert.strictEqual(manager.selfRedeem(ctx), false);
  assert.ok(sent.some((m) => /Ritiro del premio dal telefono del cliente: spento/.test(m.text)));
  await tap(`selfr:${ctx.shop.slug}`);
  assert.strictEqual(manager.selfRedeem(ctx), true);
});

test('scontrino medio: importo valido, stima dell\'incasso nel report', async () => {
  assert.match((await manager.update(ctx.shop.slug, { avgTicket: 'tanti' })).error, /importo/);
  assert.ok(!(await manager.update(ctx.shop.slug, { avgTicket: '22,50' })).error);
  assert.strictEqual(manager.monthNumbers(ctx, 0).avgTicket, 22.5);
  assert.ok(!manager.monthNumbers(ctx, 0).tips.some((t) => /scontrino medio/.test(t)));
});
