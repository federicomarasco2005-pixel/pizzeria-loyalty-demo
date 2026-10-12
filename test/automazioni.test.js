// Messaggi automatici ai clienti, kit di lancio e report mensile in PDF, comandi del bot.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const PORT = 3700 + Math.floor(Math.random() * 90);
Object.assign(process.env, {
  PORT: String(PORT), DATA_DIR: fs.mkdtempSync(path.join(os.tmpdir(), 'tessere-auto-')), DATABASE_URL: '',
  GOOGLE_ISSUER_ID: '', TELEGRAM_BOT_TOKEN: '', STAFF_PIN: '222222', PUBLIC_URL: `http://localhost:${PORT}`,
});
const { manager, ready } = require('../server');
const bot = require('../bot');

const sent = [];
const fakeTelegram = async (method, params, file) => {
  if (method === 'answerCallbackQuery') return true;
  sent.push({ method, chat: params.chat_id, text: params.text || params.caption || '', kb: params.reply_markup, file });
  return { message_id: sent.length };
};
const OWNER = { id: 1, first_name: 'Federico' };
const tap = (data) => bot.handleUpdate({ callback_query: { id: 'q', from: OWNER, data, message: { chat: { id: 1 } } } });
const DAY = 86400000;
let ctx;

// cliente con n timbri, l'ultimo "giorni fa"
function customer(name, { stamps = 0, daysAgo = 0, consent = false } = {}) {
  const c = ctx.db.createCustomer({ name, email: `${name.toLowerCase()}@x.it`, consentMarketing: consent });
  for (let i = 0; i < stamps; i++) {
    const e = ctx.db.addEvent({ type: 'stamp', customerId: c.id, by: 'staff' });
    e.at = new Date(Date.now() - daysAgo * DAY - (stamps - i) * 60000).toISOString();
  }
  return c;
}

test.before(async () => {
  await ready;
  await bot.start(manager, { api: fakeTelegram });
  await bot.handleUpdate({ message: { chat: { id: 1 }, from: OWNER, text: '/start' } });
  const r = await manager.create({ name: 'Trattoria Prova', rewardText: 'Un dolce omaggio', stampsForReward: 6, brandColor: '#2e7d32', theme: 'pizza', reviewUrl: 'https://g.page/prova' });
  ctx = r.ctx;
});
test.after(() => setTimeout(() => process.exit(0), 50));

test('messaggi automatici: ognuno al cliente giusto, una volta sola', async () => {
  const anna = customer('Anna', { stamps: 5 });                         // a 1 timbro dal premio
  const bruno = customer('Bruno', { stamps: 3, daysAgo: 1 });           // 3ª visita ieri: recensione
  const carla = customer('Carla', { stamps: 2, daysAgo: 30, consent: true }); // non torna da 30 giorni, consenso
  const dario = customer('Dario', { stamps: 2, daysAgo: 30 });          // non torna, ma niente consenso alle offerte
  customer('Elena', { stamps: 1 });                                    // niente da mandare

  await manager.runAutomations(ctx);
  const auto = (key) => ctx.db.campaigns.filter((c) => c.auto === key);
  assert.deepStrictEqual(auto('near').map((c) => c.recipients), [[anna.id]]);
  assert.deepStrictEqual(auto('review').map((c) => c.recipients), [[bruno.id]]);
  assert.deepStrictEqual(auto('inactive').map((c) => c.recipients), [[carla.id]]);
  assert.ok(!ctx.db.campaigns.some((c) => c.recipients.includes(dario.id)), 'senza consenso: niente "ci manchi"');
  assert.match(auto('near')[0].title, /Ti manca 1 timbro/);
  assert.strictEqual(ctx.db.messagesFor(anna.id)[0].title, auto('near')[0].title, 'il messaggio compare nella tessera web');

  // il giorno dopo: nessun messaggio ripetuto. Anna (5 visite) riceve ora la richiesta di recensione,
  // che ieri era rimandata perché si manda un solo messaggio automatico al giorno per cliente.
  await manager.runAutomations(ctx);
  assert.deepStrictEqual(auto('near').length, 1);
  assert.deepStrictEqual(auto('inactive').length, 1);
  assert.deepStrictEqual(auto('review').map((c) => c.recipients), [[bruno.id], [anna.id]]);
  const n = ctx.db.campaigns.length;
  await manager.runAutomations(ctx);
  assert.strictEqual(ctx.db.campaigns.length, n, 'terzo giorno: niente di nuovo');

  // spento dal bot: un nuovo cliente vicino al premio non riceve "ti manca 1 timbro"
  await tap(`autot:${ctx.shop.slug}|near|0`);
  assert.strictEqual(manager.automations(ctx).find((a) => a.key === 'near').on, false);
  assert.match(sent.at(-1).text, /Messaggi automatici/);
  const franco = customer('Franco', { stamps: 5 });
  await manager.runAutomations(ctx);
  assert.ok(!auto('near').some((c) => c.recipients.includes(franco.id)));
  manager.setAutomation(ctx.shop.slug, 'near', true);
});

test('kit di lancio e report del mese in PDF, anche dal bot', async () => {
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
