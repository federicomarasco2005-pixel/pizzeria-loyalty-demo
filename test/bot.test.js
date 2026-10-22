// Bot Telegram con un finto Telegram: creazione locale, dipendenti, gestore collegato, report, backup, avvisi.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');

const PORT = 3990 + Math.floor(Math.random() * 9);
Object.assign(process.env, {
  PORT: String(PORT), DATA_DIR: fs.mkdtempSync(path.join(os.tmpdir(), 'tessere-bot-')), DATABASE_URL: '',
  GOOGLE_ISSUER_ID: '', TELEGRAM_BOT_TOKEN: '', STAFF_PIN: '111111', PUBLIC_URL: `http://localhost:${PORT}`,
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
const MANAGER = { id: 2, first_name: 'Mario' };
const STRANGER = { id: 3, first_name: 'X' };
const msg = (from, text) => bot.handleUpdate({ message: { chat: { id: from.id }, from, text } });
const tap = (from, data) => bot.handleUpdate({ callback_query: { id: 'q', from, data, message: { chat: { id: from.id } } } });
const last = (chat) => [...sent].reverse().find((m) => m.chat === chat);
const buttons = (m) => (m.kb ? m.kb.inline_keyboard.flat() : []);

test.before(async () => {
  await ready;
  await bot.start(manager, { api: fakeTelegram });
});
test.after(() => setTimeout(() => process.exit(0), 50));

test('il primo che scrive diventa proprietario, gli altri sono rifiutati', async () => {
  await msg(OWNER, '/start');
  assert.match(sent[0].text, /risponde solo a te/);
  await msg(STRANGER, '/start');
  assert.match(last(3).text, /privato/);
});

test('creazione di un locale con il modulo', async () => {
  await tap(OWNER, 'new');
  await msg(OWNER, 'Bar Test Luna');
  await tap(OWNER, 'v:caffe');
  await tap(OWNER, 'v:8');
  await msg(OWNER, 'Un cappuccino omaggio');
  await tap(OWNER, 'v:#5d4037');
  await tap(OWNER, 'skip');
  await tap(OWNER, 'skip');
  await tap(OWNER, 'skip');
  assert.strictEqual(last(1).method, 'sendPhoto', 'riepilogo con anteprima');
  const before = sent.length;
  await tap(OWNER, 'create');
  const after = sent.slice(before).filter((m) => m.chat === 1);
  assert.ok(after.some((m) => /è online/.test(m.text)), 'conferma con PIN e link');
  const kit = after.find((m) => m.method === 'sendDocument');
  assert.ok(kit, 'il kit di lancio arriva subito dopo');
  assert.strictEqual(kit.file.type, 'application/pdf');
  assert.strictEqual(kit.file.buf.subarray(0, 4).toString(), '%PDF');
  const ctx = manager.get('bar-test-luna');
  assert.ok(ctx);
  assert.strictEqual(ctx.cfg.stampsForReward, 8);
  assert.strictEqual(ctx.cfg.codePrefix, 'TL');
});

test('dipendente con PIN personale: entra in cassa, non in dashboard', async () => {
  await tap(OWNER, 'staffadd:bar-test-luna');
  await msg(OWNER, 'Giulia');
  const person = manager.get('bar-test-luna').shop.staff[0];
  assert.strictEqual(person.name, 'Giulia');
  const B = `http://localhost:${PORT}/bar-test-luna`;
  const login = await fetch(`${B}/api/staff/login`, { method: 'POST', headers: { 'x-staff-pin': person.pin } }).then((r) => r.json());
  assert.deepStrictEqual([login.role, login.name], ['staff', 'Giulia']);
  const admin = await fetch(`${B}/api/admin/stats`, { headers: { 'x-staff-pin': person.pin } });
  assert.strictEqual(admin.status, 403);
  await tap(OWNER, `staffdel:bar-test-luna|${person.id}`);
  const gone = await fetch(`${B}/api/staff/login`, { method: 'POST', headers: { 'x-staff-pin': person.pin } });
  assert.strictEqual(gone.status, 401);
});

test('gestore collegato con link d\'invito: vede solo il suo locale', async () => {
  await bot.start(manager, { api: fakeTelegram, username: 'TestBot' });
  await tap(OWNER, 'inv:bar-test-luna');
  const link = last(1).text.match(/start=g_([\w-]+)/);
  assert.ok(link, 'link d\'invito');
  await msg(MANAGER, `/start g_${link[1]}`);
  assert.ok(sent.slice(-3).some((m) => m.chat === 2 && /Benvenuto/.test(m.text)));
  assert.match(last(2).text, /Bar Test Luna/);
  assert.deepStrictEqual(manager.managedBy(2).map((c) => c.shop.slug), ['bar-test-luna']);
  await msg(MANAGER, '/nuova');
  assert.doesNotMatch(last(2).text, /Come si chiama/, 'il gestore non può creare locali');
  await msg(MANAGER, `/start g_${link[1]}`);
  assert.match(last(2).text, /non valido/, 'link usabile una volta sola');
});

test('report settimanale a proprietario e gestore', async () => {
  const before = sent.length;
  await bot.sendWeeklyReports();
  const out = sent.slice(before);
  assert.ok(out.some((m) => m.chat === 1 && /Ultimi 7 giorni/.test(m.text)));
  assert.ok(out.some((m) => m.chat === 2 && /La tua settimana/.test(m.text)));
});

test('backup: file compresso con tutti i locali', async () => {
  await tap(OWNER, 'backup');
  const doc = last(1);
  assert.strictEqual(doc.method, 'sendDocument');
  const data = JSON.parse(zlib.gunzipSync(doc.file.buf));
  assert.deepStrictEqual(data.locali.map((l) => l.scheda.slug).sort(), ['bar-test-luna', 'da-mario']);
});

test('statistiche: link monouso solo per il proprietario, avviso a ogni accesso, uscita da tutti i dispositivi', async () => {
  const B = `http://localhost:${PORT}`;
  await msg(MANAGER, '/statistiche');
  assert.doesNotMatch(last(2).text, /statistiche\/entra/, 'il gestore non riceve il link');
  await msg(STRANGER, '/statistiche');
  assert.match(last(3).text, /privato/);
  assert.strictEqual((await fetch(`${B}/statistiche`)).status, 401, 'senza link la pagina è chiusa');

  await msg(OWNER, '/statistiche');
  const ticket = (last(1).text.match(/statistiche\/entra#t=([\w-]+)/) || [])[1];
  assert.ok(ticket, 'link nel messaggio, con il codice dopo "#"');
  const entra = (t) => fetch(`${B}/statistiche/entra`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ticket: t }) });
  const before = sent.length;
  const ok = await entra(ticket);
  assert.strictEqual(ok.status, 200);
  const cookie = ok.headers.get('set-cookie').split(';')[0];
  await new Promise((r) => setTimeout(r, 20));
  assert.ok(sent.slice(before).some((m) => m.chat === 1 && /Statistiche aperte/.test(m.text)), 'avviso al proprietario');
  const page = await fetch(`${B}/statistiche`, { headers: { cookie } });
  assert.strictEqual(page.status, 200);
  assert.match(await page.text(), /window\.STATS = \{.*"bar-test-luna"/);
  assert.strictEqual((await entra(ticket)).status, 403, 'il link vale una volta sola');
  assert.strictEqual((await entra('inventato')).status, 403);

  await msg(OWNER, '/statistiche_esci');
  assert.strictEqual((await fetch(`${B}/statistiche`, { headers: { cookie } })).status, 401, 'chiuse su tutti i dispositivi');

  // pulsante "Esci da tutti i dispositivi" della pagina
  await msg(OWNER, '/statistiche');
  const again = await entra(last(1).text.match(/#t=([\w-]+)/)[1]);
  const cookie2 = again.headers.get('set-cookie').split(';')[0];
  assert.strictEqual((await fetch(`${B}/statistiche/esci`, { method: 'POST', headers: { cookie: cookie2 } })).status, 200);
  assert.strictEqual((await fetch(`${B}/statistiche`, { headers: { cookie: cookie2 } })).status, 401);
});

test('avvisi: lo stesso avviso non si ripete subito', async () => {
  const before = sent.length;
  bot.alert('prova', 'k1');
  bot.alert('prova', 'k1');
  await new Promise((r) => setTimeout(r, 20));
  assert.strictEqual(sent.slice(before).filter((m) => m.text === 'prova').length, 1);
});
