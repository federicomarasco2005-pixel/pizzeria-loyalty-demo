// Sottodomini dei locali (SHOP_DOMAIN), pagina principale del dominio e cambio di indirizzo di un locale.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');

const PORT = 3800 + Math.floor(Math.random() * 90);
const DOMAIN = 'f5m.test';
let server;

// Richiesta con un "Host" a scelta (come se arrivasse da da-mario.f5m.test)
function get(host, p, { method = 'GET', body } = {}) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const req = http.request({ host: '127.0.0.1', port: PORT, path: p, method, headers: { host, ...(data && { 'content-type': 'application/json' }) } }, (res) => {
      let text = '';
      res.on('data', (c) => { text += c; });
      res.on('end', () => { let json = {}; try { json = JSON.parse(text); } catch {} resolve({ status: res.statusCode, headers: res.headers, text, json }); });
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

test.before(async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tessere-dom-'));
  server = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
    env: { ...process.env, PORT: String(PORT), DATA_DIR: dataDir, STAFF_PIN: '135790', DATABASE_URL: '', GOOGLE_ISSUER_ID: '', TELEGRAM_BOT_TOKEN: '',
      PUBLIC_URL: `https://${DOMAIN}`, SHOP_DOMAIN: DOMAIN, BRAND_NAME: 'F5M', SUPPORT_EMAIL: 'aiuto@example.com' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  for (let i = 0; i < 100; i++) {
    try { if ((await get(`localhost:${PORT}`, '/api/config')).status === 200) return; } catch {}
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('server non partito');
});
test.after(() => server && server.kill());

test('dominio principale: pagina del servizio e assistenza', async () => {
  const home = await get(DOMAIN, '/');
  assert.strictEqual(home.status, 200);
  assert.match(home.text, /F5M/);
  assert.match(home.text, /aiuto@example\.com/);
  assert.doesNotMatch(home.text, /\{\{/);
  assert.strictEqual((await get(DOMAIN, '/assistenza')).status, 200);
  const www = await get(`www.${DOMAIN}`, '/x?y=1');
  assert.strictEqual(www.status, 301);
  assert.strictEqual(www.headers.location, `https://${DOMAIN}/x?y=1`);
});

test('sottodominio del locale: pagine, API e tessera', async () => {
  const host = `da-mario.${DOMAIN}`;
  const page = await get(host, '/');
  assert.strictEqual(page.status, 200);
  assert.match(page.text, /<base href="\/">/);
  assert.strictEqual((await get(host, '/api/config')).json.pizzeriaName, 'Pizzeria Da Mario');
  assert.match((await get(host, '/style.css')).headers['content-type'], /css/);
  assert.strictEqual((await get(host, '/stamps/grid-6-2.png')).headers['content-type'], 'image/png');

  const signup = await get(host, '/api/signup', { method: 'POST', body: { name: 'Anna', email: 'anna@x.it', acceptTerms: true } });
  assert.ok(signup.json.token);
  const card = await get(host, `/card/${signup.json.token}`);
  assert.match(card.text, /window\.CARD = \{/);
  assert.match(card.headers['set-cookie'][0], /card_da_mario=/);

  // l'indirizzo con il percorso continua a funzionare anche sul dominio principale
  assert.strictEqual((await get(DOMAIN, '/da-mario/api/config')).json.pizzeriaName, 'Pizzeria Da Mario');
  // sottodominio inesistente: si torna alla pagina principale
  const none = await get(`nessuno.${DOMAIN}`, '/');
  assert.strictEqual(none.status, 302);
  assert.strictEqual(none.headers.location, `https://${DOMAIN}/`);
});

test('cambio di indirizzo: il vecchio resta e porta al nuovo', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tessere-ren-'));
  process.env.DATA_DIR = dir;
  process.env.SHOP_DOMAIN = DOMAIN;
  for (const m of ['../db', '../shops']) delete require.cache[require.resolve(m)];
  const db = require('../db');
  const shops = require('../shops');
  await db.init();
  await shops.init(`https://${DOMAIN}`);
  const { ctx } = await shops.create({ name: 'Bar Luna', rewardText: 'Un caffè gratis', stampsForReward: 8, brandColor: '#123456', theme: 'caffe' });
  ctx.db.createCustomer({ name: 'Bea', email: 'bea@x.it' });
  assert.strictEqual(ctx.cfg.baseUrl, `https://bar-luna.${DOMAIN}`);

  assert.match(shops.rename('bar-luna', 'Luna Bar!').error, /minuscole/);
  assert.match(shops.rename('bar-luna', 'www').error, /riservato/);
  assert.match(shops.rename('bar-luna', 'da-mario').error, /già usato/);

  const r = shops.rename('bar-luna', 'luna');
  assert.strictEqual(r.oldSlug, 'bar-luna');
  assert.strictEqual(r.ctx.cfg.baseUrl, `https://luna.${DOMAIN}`);
  assert.strictEqual(shops.get('bar-luna'), null);
  assert.deepStrictEqual(shops.resolve('bar-luna'), { ctx: r.ctx, alias: true });
  assert.strictEqual(shops.resolve('luna').alias, false);
  assert.strictEqual(r.ctx.db.customers[0].name, 'Bea', 'clienti e dati restano gli stessi');
  assert.match((await shops.create({ name: 'Bar Luna', rewardText: 'Altro', stampsForReward: 5, brandColor: '#654321', theme: 'stella' })).ctx.shop.slug,
    /^bar-luna-\d$/, 'un indirizzo vecchio non viene dato a un altro locale');

  // tornare all'indirizzo di prima è permesso
  assert.ok(!shops.rename('luna', 'bar-luna').error);
  assert.deepStrictEqual(shops.get('bar-luna').shop.aliases, ['luna']);
  await db.flush();
});
