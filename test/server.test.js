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
const STATS_KEY = 'chiave-di-prova-delle-statistiche-0123456789';
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

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tessere-srv-'));
// Avvia il server (anche di nuovo, sulla stessa cartella dati: serve a provare cosa sopravvive a un riavvio)
async function startServer() {
  server = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
    env: { ...process.env, PORT: String(PORT), DATA_DIR: dataDir, STAFF_PIN: PIN, DATABASE_URL: '', GOOGLE_ISSUER_ID: '', TELEGRAM_BOT_TOKEN: '', PUBLIC_URL: B, STATS_KEY },
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
}
test.before(startServer);
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

test('QR del tavolo riscansionato da un telefono già iscritto: si apre la sua tessera', async () => {
  const cookie = (await api(`${S}/card/${anna}`)).headers.get('set-cookie').split(';')[0];
  const back = await api(`${S}/?lang=en`, { cookie });
  assert.strictEqual(back.status, 302);
  assert.strictEqual(back.headers.get('location'), `${S}/card/${anna}?lang=en`);
  assert.strictEqual((await api(`${S}/`)).status, 200, 'telefono nuovo: modulo di iscrizione');
  assert.strictEqual((await api(`${S}/`, { cookie: 'card_da_mario=sconosciuto' })).status, 200, 'tessera che non esiste più: modulo di iscrizione');
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
  assert.ok(Date.parse(stats.data.customers[0].createdAt), 'data d\'iscrizione per ordinare l\'elenco');
});

test('tessera installabile: manifest della singola tessera, che dice a Chrome come riconoscerla installata', async () => {
  const m = JSON.parse((await api(`${S}/card/${anna}/manifest.webmanifest`)).text);
  assert.strictEqual(m.id, `${S}/card/${anna}`);
  assert.strictEqual(m.start_url, `${S}/card/${anna}`);
  assert.deepStrictEqual(m.related_applications, [{ platform: 'webapp', url: `${B}${S}/card/${anna}/manifest.webmanifest` }]);
  assert.strictEqual((await api(`${S}/card/inventato/manifest.webmanifest`)).status, 404);
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

test('tessera: ultime visite, senza le operazioni annullate', async () => {
  await api(`${S}/api/staff/stamp`, { method: 'POST', pin: PIN, body: { token: anna, requestId: 'r-hist' } });
  await api(`${S}/api/staff/undo`, { method: 'POST', pin: PIN, body: { token: anna } });
  const { data } = await api(`${S}/api/card/${anna}`);
  assert.strictEqual(data.history.length, 2);
  assert.ok(data.history.every((h) => h.type === 'stamp' && !h.reward));
  assert.ok(data.history[0].at >= data.history[1].at, 'dalla più recente');
});

test('logo largo del Wallet: file per il locale legacy, generato per gli altri', async () => {
  const legacy = await fetch(`${B}${S}/wide-logo.png`);
  assert.strictEqual(legacy.status, 200);
  assert.strictEqual(legacy.headers.get('content-type'), 'image/png');
  const images = require('../images');
  const img = await images.get({ slug: 'prova', name: 'Bar Pasticceria Il Lungo Nome', theme: 'caffe', brandColor: '#123456', stampsForReward: 8 }, 'wide-logo.png');
  assert.strictEqual(img.type, 'image/png');
  assert.deepStrictEqual([img.buf.readUInt32BE(16), img.buf.readUInt32BE(20)], [1280, 400]);
});

test('premio ritirato dal telefono del cliente, annullabile', async () => {
  const gino = (await api(`${S}/api/signup`, { method: 'POST', body: { name: 'Gino', email: 'gino@x.it', acceptTerms: true } })).data.token;
  assert.strictEqual((await api(`${S}/api/card/${gino}/redeem`, { method: 'POST', body: {} })).status, 400, 'niente premio, niente ritiro');
  for (let i = 0; i < 6; i++) await api(`${S}/api/staff/stamp`, { method: 'POST', pin: PIN, body: { token: gino, requestId: `g${i}` } });
  let card = (await api(`${S}/api/card/${gino}`)).data;
  assert.strictEqual(card.rewards, 1);
  assert.strictEqual(card.selfRedeem, true, 'attivo di default');

  const r = await api(`${S}/api/card/${gino}/redeem`, { method: 'POST', body: { requestId: 'gr1' } });
  assert.strictEqual(r.status, 200);
  assert.ok(r.data.redeem.id);
  assert.strictEqual(Date.parse(r.data.redeem.undoUntil) - Date.parse(r.data.redeem.at), 5 * 60000, 'annullabile per 5 minuti');
  card = (await api(`${S}/api/card/${gino}`)).data;
  assert.strictEqual(card.rewards, 0);
  assert.strictEqual(card.lastRedeem.id, r.data.redeem.id, 'ricaricando la pagina la schermata PREMIO VALIDO torna');
  assert.strictEqual((await api(`${S}/api/card/${gino}/redeem`, { method: 'POST', body: { requestId: 'gr2' } })).status, 400, 'un premio si usa una volta');
  const stats = (await api(`${S}/api/admin/stats`, { pin: PIN })).data;
  assert.ok(stats.events.some((e) => e.type === 'redeem' && e.by === 'customer'), 'nello storico della dashboard');

  assert.strictEqual((await api(`${S}/api/card/${gino}/redeem/undo`, { method: 'POST', body: { id: 'sbagliato' } })).status, 400);
  assert.strictEqual((await api(`${S}/api/card/${gino}/redeem/undo`, { method: 'POST', body: { id: r.data.redeem.id } })).status, 200);
  card = (await api(`${S}/api/card/${gino}`)).data;
  assert.strictEqual(card.rewards, 1, 'annullato: il premio è di nuovo disponibile');
  assert.strictEqual(card.lastRedeem, null);

  // "Fatto": il ritiro è definitivo, il premio non si può più riavere
  const r2 = await api(`${S}/api/card/${gino}/redeem`, { method: 'POST', body: { requestId: 'gr3' } });
  assert.strictEqual((await api(`${S}/api/card/${gino}/redeem/close`, { method: 'POST', body: { id: r2.data.redeem.id } })).status, 200);
  assert.strictEqual((await api(`${S}/api/card/${gino}/redeem/undo`, { method: 'POST', body: { id: r2.data.redeem.id } })).status, 400, 'dopo "Fatto" niente annullo');
  card = (await api(`${S}/api/card/${gino}`)).data;
  assert.strictEqual(card.rewards, 0);
  assert.strictEqual(card.lastRedeem, null, 'ricaricando la schermata non torna');
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

test('QR della tessera: contiene il codice, non il token; la Cassa lo apre solo con il PIN', async () => {
  const QRCode = require('qrcode');
  const card = (await api(`${S}/api/card/${anna}`)).data;
  assert.strictEqual(card.qr, await QRCode.toDataURL(card.code, { margin: 1, width: 360 }), 'il QR è il codice tessera');
  assert.strictEqual((await api(`${S}/api/card/${encodeURIComponent(card.code)}`)).status, 404, 'il codice non apre la tessera');
  assert.strictEqual((await api(`${S}/api/staff/customer/${encodeURIComponent(card.code)}`)).status, 401, 'senza PIN niente');
  const byCode = await api(`${S}/api/staff/customer/${encodeURIComponent(card.code.toLowerCase())}`, { pin: PIN });
  assert.strictEqual(byCode.data.name, 'Anna');
  const byOldQr = await api(`${S}/api/staff/customer/${anna}`, { pin: PIN });
  assert.strictEqual(byOldQr.data.name, 'Anna', 'i QR mostrati prima (con il token) valgono ancora');
});

test('protezioni di base: intestazioni, scanner della Cassa servito da qui', async () => {
  const r = await api(`${S}/staff`);
  assert.strictEqual(r.headers.get('x-frame-options'), 'SAMEORIGIN');
  assert.strictEqual(r.headers.get('x-content-type-options'), 'nosniff');
  assert.strictEqual(r.headers.get('referrer-policy'), 'same-origin');
  assert.match(r.headers.get('content-security-policy'), /frame-ancestors 'self'/);
  assert.ok(!r.text.includes('unpkg.com'), 'nessuna libreria da siti esterni');
  const lib = await fetch(`${B}/vendor/html5-qrcode.min.js`);
  assert.strictEqual(lib.status, 200);
  assert.match(lib.headers.get('content-type'), /javascript/);
});

test('avvisi live della Cassa: biglietto valido una volta, mai il PIN nell\'indirizzo', async () => {
  assert.strictEqual((await fetch(`${B}${S}/api/staff/stream?pin=${PIN}`)).status, 401, 'il PIN nell\'indirizzo non vale più');
  assert.strictEqual((await api(`${S}/api/staff/stream-ticket`, { method: 'POST' })).status, 401, 'il biglietto si chiede col PIN');
  const { ticket } = (await api(`${S}/api/staff/stream-ticket`, { method: 'POST', pin: PIN })).data;
  const ctrl = new AbortController();
  const ok = await fetch(`${B}${S}/api/staff/stream?t=${ticket}`, { signal: ctrl.signal });
  assert.strictEqual(ok.status, 200);
  ctrl.abort();
  assert.strictEqual((await fetch(`${B}${S}/api/staff/stream?t=${ticket}`)).status, 401, 'lo stesso biglietto non vale due volte');
});

test('statistiche per Claude: solo con la chiave, solo numeri', async () => {
  const get = (key) => fetch(`${B}/api/statistiche`, { headers: key ? { authorization: `Bearer ${key}` } : {} });
  assert.strictEqual((await get()).status, 404, 'senza chiave non esiste');
  assert.strictEqual((await get('sbagliata')).status, 404);
  const r = await get(STATS_KEY);
  assert.strictEqual(r.status, 200);
  const text = await r.text();
  const data = JSON.parse(text);
  assert.deepStrictEqual(data.shops.map((s) => s.slug), ['da-mario']);
  assert.ok(data.shops[0].members >= 1);
  for (const personal of ['Anna', 'anna@x.it', anna]) assert.ok(!text.includes(personal), `niente dati dei clienti (${personal})`);
  // la pagina senza il link del bot è chiusa e non contiene numeri
  const page = await api('/statistiche');
  assert.strictEqual(page.status, 401);
  assert.match(page.text, /window\.STATS = null/);
  assert.match(page.headers.get('x-robots-tag'), /noindex/);
});

test('PIN sbagliato 5 volte: blocco', async () => {
  // stessa macchina dei test precedenti: il blocco PIN è separato da quello del recupero tessera
  for (let i = 0; i < 5; i++) assert.strictEqual((await api(`${S}/api/staff/login`, { method: 'POST', pin: '000000' })).status, 401);
  const locked = await api(`${S}/api/staff/login`, { method: 'POST', pin: PIN });
  assert.strictEqual(locked.status, 429);
});

test('il blocco PIN resta dopo un riavvio del server', async () => {
  await new Promise((r) => setTimeout(r, 1500)); // il blocco si salva un attimo dopo l'ultimo errore
  server.kill();
  await new Promise((r) => server.once('exit', r));
  await startServer();
  assert.strictEqual((await api(`${S}/api/staff/login`, { method: 'POST', pin: PIN })).status, 429);
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

