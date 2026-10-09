// Server vero (processo separato) con dati in una cartella temporanea: i percorsi principali di clienti e cassa.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const PORT = 3900 + Math.floor(Math.random() * 90);
const B = `http://localhost:${PORT}`;
const PIN = '246810';
let server;

async function api(p, { method = 'GET', body, pin, cookie } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (pin) headers['x-staff-pin'] = pin;
  if (cookie) headers.cookie = cookie;
  const res = await fetch(B + p, { method, headers, body: body ? JSON.stringify(body) : undefined, redirect: 'manual' });
  const text = await res.text();
  let data = {}; try { data = JSON.parse(text); } catch {}
  return { status: res.status, data, text, headers: res.headers };
}

test.before(async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tessere-srv-'));
  server = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
    env: { ...process.env, PORT: String(PORT), DATA_DIR: dataDir, STAFF_PIN: PIN, DATABASE_URL: '', GOOGLE_ISSUER_ID: '', TELEGRAM_BOT_TOKEN: '', PUBLIC_URL: B },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let log = '';
  server.stdout.on('data', (d) => { log += d; });
  server.stderr.on('data', (d) => { log += d; });
  for (let i = 0; i < 100; i++) {
    try { if ((await fetch(`${B}/api/config`)).ok) return; } catch {}
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`server non partito:\n${log}`);
});
test.after(() => server && server.kill());

const S = '/da-mario';
let anna;

test('pagine e vecchi link', async () => {
  assert.strictEqual((await api('/')).headers.get('location'), '/da-mario/');
  assert.strictEqual((await api('/staff.html')).headers.get('location'), '/da-mario/staff');
  for (const p of ['/', '/staff', '/admin', '/poster', '/privacy']) {
    const r = await api(S + p);
    assert.strictEqual(r.status, 200, p);
    assert.match(r.text, /<base href="\/da-mario\/">/);
  }
  const img = await fetch(`${B}${S}/stamps/grid-6-2.png`);
  assert.strictEqual(img.headers.get('content-type'), 'image/png');
});

test('iscrizione; email già usata NON restituisce la tessera', async () => {
  const r = await api(`${S}/api/signup`, { method: 'POST', body: { name: 'Anna', email: 'anna@x.it', acceptTerms: true } });
  assert.strictEqual(r.status, 200);
  anna = r.data.token;
  const again = await api(`${S}/api/signup`, { method: 'POST', body: { name: 'Finto', email: 'ANNA@x.it ', acceptTerms: true } });
  assert.strictEqual(again.status, 409);
  assert.strictEqual(again.data.token, undefined);
  assert.strictEqual(again.data.emailExists, true);
});

test('recupero con codice + email, tentativi limitati', async () => {
  const card = await api(`${S}/api/card/${anna}`);
  const code = card.data.code;
  const ok = await api(`${S}/api/recover`, { method: 'POST', body: { code: code.toLowerCase().replace('-', ' '), email: 'anna@x.it' } });
  assert.strictEqual(ok.data.token, anna);
  for (let i = 0; i < 5; i++) {
    const bad = await api(`${S}/api/recover`, { method: 'POST', body: { code: 'PZ-ZZZZZ', email: 'anna@x.it' } });
    assert.strictEqual(bad.status, 404);
  }
  const locked = await api(`${S}/api/recover`, { method: 'POST', body: { code, email: 'anna@x.it' } });
  assert.strictEqual(locked.status, 429, 'dopo 5 errori anche il codice giusto è bloccato per un po\'');
});

test('cassa: timbro con PIN, dashboard solo per il gestore', async () => {
  const r = await api(`${S}/api/staff/stamp`, { method: 'POST', pin: PIN, body: { token: anna, requestId: 'r1' } });
  assert.strictEqual(r.data.stamps, 1);
  const dup = await api(`${S}/api/staff/stamp`, { method: 'POST', pin: PIN, body: { token: anna, requestId: 'r1' } });
  assert.strictEqual(dup.data.stamps, 1, 'stesso requestId: nessun doppio timbro');
  const stats = await api(`${S}/api/admin/stats`, { pin: PIN });
  assert.strictEqual(stats.data.kpi.members, 1);
  assert.strictEqual(stats.data.events.find((e) => e.type === 'stamp').who, 'Gestore');
});

test('tessera veloce: dati già nella pagina, nuovo saldo nell\'avviso in tempo reale', async () => {
  const page = await api(`${S}/card/${anna}`);
  const card = JSON.parse(page.text.match(/window\.CARD = (\{.*?\});/)[1]);
  assert.strictEqual(card.stamps, 1);
  assert.match(page.text, /window\.CFG = \{/);

  const ctrl = new AbortController();
  const stream = await fetch(`${B}${S}/api/card/${anna}/stream`, { signal: ctrl.signal });
  const reader = stream.body.getReader();
  await reader.read(); // "retry: 3000"
  await api(`${S}/api/staff/stamp`, { method: 'POST', pin: PIN, body: { token: anna, requestId: 'r2' } });
  let text = '';
  while (!text.includes('data:')) text += new TextDecoder().decode((await reader.read()).value);
  ctrl.abort();
  const ev = JSON.parse(text.slice(text.indexOf('data:') + 5));
  assert.strictEqual(ev.type, 'stamp');
  assert.strictEqual(ev.stamps, 2);
  assert.ok(ev.v > card.v, 'la versione cresce a ogni operazione');
});

test('timbro NFC: nuovo cliente iscritto sul momento, poi pausa', async () => {
  const { url } = (await api(`${S}/api/admin/nfc`, { pin: PIN })).data;
  const secret = url.split('/').pop();
  const first = await api(`${S}/api/tap`, { method: 'POST', body: { secret, requestId: 'n1' } });
  assert.strictEqual(first.status, 404);
  assert.strictEqual(first.data.needLogin, true, 'telefono sconosciuto: proposta di iscrizione');
  const join = await api(`${S}/api/tap`, { method: 'POST', body: { secret, requestId: 'n2', signup: { name: 'Carlo', email: 'carlo@x.it', acceptTerms: true } } });
  assert.strictEqual(join.data.isNew, true);
  const cookie = join.headers.get('set-cookie').split(';')[0];
  const again = await api(`${S}/api/tap`, { method: 'POST', cookie, body: { secret, requestId: 'n3' } });
  assert.strictEqual(again.status, 429, 'un timbro NFC per visita');
  const bad = await api(`${S}/api/tap`, { method: 'POST', cookie, body: { secret: 'vecchio', requestId: 'n4' } });
  assert.strictEqual(bad.status, 403);
});

test('PIN sbagliato 5 volte: blocco', async () => {
  // stessa macchina dei test precedenti: il blocco PIN è separato da quello del recupero tessera
  for (let i = 0; i < 5; i++) assert.strictEqual((await api(`${S}/api/staff/login`, { method: 'POST', pin: '000000' })).status, 401);
  const locked = await api(`${S}/api/staff/login`, { method: 'POST', pin: PIN });
  assert.strictEqual(locked.status, 429);
});

test('privacy: export e cancellazione dalla tessera', async () => {
  const exp = await api(`${S}/api/card/${anna}/export`);
  assert.strictEqual(exp.data.cliente.email, 'anna@x.it');
  assert.ok(!exp.text.includes(anna), 'il token non compare nell\'export');
  assert.strictEqual((await api(`${S}/api/card/${anna}/delete`, { method: 'POST', body: {} })).status, 400, 'serve la conferma');
  assert.strictEqual((await api(`${S}/api/card/${anna}/delete`, { method: 'POST', body: { confirm: true } })).status, 200);
  assert.strictEqual((await api(`${S}/api/card/${anna}`)).status, 404);
  const re = await api(`${S}/api/signup`, { method: 'POST', body: { name: 'Anna', email: 'anna@x.it', acceptTerms: true } });
  assert.strictEqual(re.status, 200, 'dopo la cancellazione ci si può iscrivere di nuovo');
});

