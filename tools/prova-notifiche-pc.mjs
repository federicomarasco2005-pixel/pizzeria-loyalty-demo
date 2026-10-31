// Prova completa delle notifiche web sul PC (30/10/2026): server locale -> servizio push di Google (FCM) -> Chrome
// (profilo temporaneo, non quello di Federico) -> service worker -> notifica mostrata + ricevuta al server.
// Prima: anteprima "notifiche-prova" di .claude/launch.json (porta 3004, PIN 246810, chiavi VAPID di prova).
// Uso: node tools/prova-notifiche-pc.mjs [headful]   (Chrome installato in CHROME_PATH o nel percorso sotto)
// Il profilo di Chrome sta in un percorso corto: con uno lungo CacheStorage fallisce (limite di Windows) e il
// service worker non si installa. Il cliente di prova si sceglie per codice: le prove precedenti restano nei dati.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const CHROME = process.env.CHROME_PATH || 'C:/Users/feder/AppData/Local/Google/Chrome/Application/chrome.exe';
const HEADLESS = process.argv[2] !== 'headful';
const BASE = 'http://localhost:3004';
const SLUG = 'da-mario';
const PIN = '246810';
const DATA = 'C:/Users/feder/AppData/Local/Temp/f5m-notifiche-prova/db.json';
const PORT = 9339;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

const profile = path.join(process.env.TEMP || 'C:/Temp', 'f5mchr'); // percorso corto (vedi sopra)
fs.rmSync(profile, { recursive: true, force: true });
const chrome = spawn(CHROME, [
  `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`, '--no-first-run', '--no-default-browser-check',
  ...(HEADLESS ? ['--headless=new'] : ['--window-position=-2400,-2400', '--window-size=480,800']), 'about:blank',
], { stdio: 'ignore' });

async function json(url) {
  for (let i = 0; i < 60; i++) {
    try { return await (await fetch(url)).json(); } catch { await sleep(250); }
  }
  throw new Error(`nessuna risposta da ${url}`);
}

let ws;
let seq = 0;
const pending = new Map();
const cdp = (method, params = {}, sessionId) => new Promise((resolve, reject) => {
  setTimeout(() => reject(new Error(`cdp ${method}: nessuna risposta`)), 20000);
  const id = ++seq;
  pending.set(id, { resolve, reject });
  ws.send(JSON.stringify({ id, method, params, ...(sessionId && { sessionId }) }));
});

async function main() {
  const ver = await json(`http://127.0.0.1:${PORT}/json/version`);
  log('Chrome', ver.Browser, HEADLESS ? '(headless)' : '(finestra fuori schermo)');
  ws = new WebSocket(ver.webSocketDebuggerUrl);
  await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) {
      const p = pending.get(m.id);
      pending.delete(m.id);
      if (m.error) p.reject(new Error(JSON.stringify(m.error))); else p.resolve(m.result);
    }
  };

  // 1. cliente nuovo sul server di prova
  const signup = await (await fetch(`${BASE}/${SLUG}/api/signup`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'Prova Push', email: `push${Date.now()}@example.com`, acceptTerms: true }),
  })).json();
  const { token } = signup;
  log('tessera creata');

  // 2. permesso delle notifiche (come se il cliente avesse toccato "Consenti")
  await cdp('Browser.grantPermissions', { origin: BASE, permissions: ['notifications'] });

  // 3. tessera aperta in Chrome: tocco su "Attiva le notifiche"
  const open = async () => {
    const { targetId } = await cdp('Target.createTarget', { url: `${BASE}/${SLUG}/card/${token}` });
    const { sessionId } = await cdp('Target.attachToTarget', { targetId, flatten: true });
    await cdp('Runtime.enable', {}, sessionId);
    const evaluate = async (expression) => {
      const r = await cdp('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }, sessionId);
      if (r.exceptionDetails) throw new Error((r.exceptionDetails.exception && r.exceptionDetails.exception.description) || r.exceptionDetails.text);
      return r.result.value;
    };
    return { targetId, evaluate };
  };
  let page = await open();
  for (let i = 0; i < 40; i++) {
    const ready = await page.evaluate(`(async () => { const b = document.getElementById('notifyBtn'); return !!(b && b.offsetParent) && !!(await navigator.serviceWorker.getRegistration()); })()`).catch(() => false);
    if (ready) break;
    await sleep(250);
  }
  await page.evaluate(`document.getElementById('notifyBtn').click()`);
  let devices = 0;
  for (let i = 0; i < 180 && !devices; i++) {
    await sleep(500);
    devices = (await (await fetch(`${BASE}/${SLUG}/api/card/${token}`)).json()).webPush;
  }
  const endpoint = await page.evaluate(`(async () => { const s = await (await navigator.serviceWorker.ready).pushManager.getSubscription(); return s && s.endpoint; })()`);
  if (!devices) throw new Error(`iscrizione non arrivata al server (indirizzo: ${endpoint})`);
  log(`iscrizione salvata dal server: ${new URL(endpoint).host} …${endpoint.slice(-10)}`);

  // 4. messaggio dalla dashboard, a questo cliente
  const H = { 'Content-Type': 'application/json', 'x-staff-pin': PIN };
  const seg = await (await fetch(`${BASE}/${SLUG}/api/admin/segments`, { headers: H })).json();
  const myCode = (await (await fetch(`${BASE}/${SLUG}/api/card/${token}`)).json()).code;
  const me = seg.customers.find((c) => c.code === myCode); // per codice: i giri precedenti hanno lasciato altri "Prova Push"
  const sendMsg = async (title) => {
    const r = await fetch(`${BASE}/${SLUG}/api/admin/campaigns`, {
      method: 'POST', headers: H, body: JSON.stringify({ title, body: 'Messaggio di prova', segment: 'manual', ids: [me.id], promo: false, keepDays: 1 }),
    });
    const c = await r.json();
    return { tag: `c_${c.id}`, results: c.results };
  };
  const ackOf = () => { try { return JSON.parse(fs.readFileSync(DATA, 'utf8')).customers.find((c) => c.id === me.id).webPushAck || null; } catch { return null; } };
  const waitAck = async (tag, ms = 30000) => {
    for (let t = 0; t < ms; t += 500) {
      const a = ackOf();
      if (a && a.tag === tag) return a;
      await sleep(500);
    }
    return null;
  };

  // prova A: tessera aperta
  const a = await sendMsg('Prova A: tessera aperta');
  log('prova A inviata', JSON.stringify(a.results));
  const ackA = await waitAck(a.tag);
  log('prova A ricevuta:', ackA ? JSON.stringify(ackA) : 'NESSUNA');
  const shown = await page.evaluate(`(async () => (await (await navigator.serviceWorker.ready).getNotifications()).map((n) => n.title))()`);
  log('notifiche mostrate da Chrome:', JSON.stringify(shown));

  // prova B: tessera chiusa (resta solo Chrome, come un telefono con l'app chiusa ma Chrome libero di partire)
  await cdp('Target.closeTarget', { targetId: page.targetId });
  await sleep(3000);
  const b = await sendMsg('Prova B: tessera chiusa');
  log('prova B inviata', JSON.stringify(b.results));
  const ackB = await waitAck(b.tag);
  log('prova B ricevuta:', ackB ? JSON.stringify(ackB) : 'NESSUNA');
  page = await open();
  await sleep(1500);
  const shown2 = await page.evaluate(`(async () => (await (await navigator.serviceWorker.ready).getNotifications()).map((n) => n.title))()`);
  log('notifiche mostrate da Chrome:', JSON.stringify(shown2));
}

main().then(() => { log('fine'); }, (err) => { log('ERRORE', err.message); process.exitCode = 1; })
  .finally(() => { try { ws && ws.close(); } catch {} chrome.kill(); setTimeout(() => { fs.rmSync(profile, { recursive: true, force: true }); process.exit(); }, 800); });
