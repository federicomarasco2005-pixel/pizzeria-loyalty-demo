// Statistiche di tutti i locali, per il proprietario del servizio. Due sole entrate, nessun'altra:
//  - Federico: comando /statistiche del bot Telegram (solo il proprietario) → link valido 10 minuti e una volta sola
//    → sessione su quel dispositivo per 8 ore, con avviso su Telegram a ogni accesso;
//  - Claude: GET /api/statistiche con la chiave di sola lettura STATS_KEY (variabile su Render; senza, l'entrata è chiusa).
// Solo numeri e nomi dei locali: mai nomi, email o codici dei clienti. I locali non vedono questa pagina.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const db = require('./db');

const DAY = 24 * 60 * 60 * 1000;
const TICKET_MS = 10 * 60 * 1000;
const SESSION_MS = 8 * 60 * 60 * 1000;
const COOKIE = 'f5m_stat';
const LOG_KEY = 'statistiche';

const sha = (s) => crypto.createHash('sha256').update(String(s)).digest();
const hex = (s) => sha(s).toString('hex');
const random = () => crypto.randomBytes(32).toString('base64url');

// ---------- Calcolo ----------

// Giorno, giorno della settimana (0 = lunedì) e ora in Italia
const romeFmt = new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Rome', year: 'numeric', month: '2-digit', day: '2-digit', weekday: 'short', hour: '2-digit', hourCycle: 'h23' });
const WEEKDAYS = { Mon: 0, Tue: 1, Wed: 2, Thu: 3, Fri: 4, Sat: 5, Sun: 6 };
function rome(iso) {
  const p = Object.fromEntries(romeFmt.formatToParts(new Date(iso)).map((x) => [x.type, x.value]));
  return { day: `${p.year}-${p.month}-${p.day}`, wd: WEEKDAYS[p.weekday], hour: Number(p.hour) % 24 };
}
const ratio = (n, d) => ({ n, d, pct: d ? Math.round((n / d) * 100) : null });

function shopStats(ctx, now) {
  const { shop, cfg } = ctx;
  const N = cfg.stampsForReward;
  const ago = (iso) => now - Date.parse(iso);
  const voided = new Set(ctx.db.events.filter((e) => e.type === 'void').map((e) => e.ref));
  const active = ctx.db.events.filter((e) => e.type !== 'void' && !voided.has(e.id));
  const stamps = active.filter((e) => e.type === 'stamp');
  const stamps30 = stamps.filter((e) => ago(e.at) < 30 * DAY);
  const stamps60 = stamps.filter((e) => ago(e.at) < 60 * DAY);

  // timbri di ogni cliente, in ordine
  const byCustomer = new Map();
  for (const e of stamps) {
    if (!byCustomer.has(e.customerId)) byCustomer.set(e.customerId, []);
    byCustomer.get(e.customerId).push(e);
  }
  const customers = ctx.db.customers;

  // Ritorno: un iscritto che riceve un timbro in un giorno diverso da quello dell'iscrizione, entro 7 o 30 giorni
  const returned = (days) => {
    const eligible = customers.filter((c) => ago(c.createdAt) >= days * DAY);
    const back = eligible.filter((c) => {
      const signupDay = rome(c.createdAt).day;
      const limit = Date.parse(c.createdAt) + days * DAY;
      return (byCustomer.get(c.id) || []).some((e) => Date.parse(e.at) <= limit && rome(e.at).day !== signupDay);
    });
    return ratio(back.length, eligible.length);
  };

  // giorni tra una visita e l'altra, clienti abituali, dormienti, mai tornati
  let gaps = 0, gapDays = 0, regulars = 0, dormant = 0, neverBack = 0;
  for (const c of customers) {
    const evs = byCustomer.get(c.id) || [];
    const days = [...new Set(evs.map((e) => rome(e.at).day))];
    for (let i = 1; i < days.length; i++) { gaps++; gapDays += (Date.parse(days[i]) - Date.parse(days[i - 1])) / DAY; }
    if (new Set(evs.filter((e) => ago(e.at) < 30 * DAY).map((e) => rome(e.at).day)).size >= 4) regulars++;
    if (evs.length && ago(evs[evs.length - 1].at) > 30 * DAY) dormant++;
    const signupDay = rome(c.createdAt).day;
    if (ago(c.createdAt) > 30 * DAY && !evs.some((e) => rome(e.at).day !== signupDay)) neverBack++;
  }

  // premi: quanto ci vuole per il primo, chi torna dopo averlo ritirato
  const redeems = active.filter((e) => e.type === 'redeem');
  const firstReward = []; // giorni dall'iscrizione al timbro che completa il primo premio
  for (const c of customers) {
    const evs = byCustomer.get(c.id) || [];
    if (evs.length >= N) firstReward.push((Date.parse(evs[N - 1].at) - Date.parse(c.createdAt)) / DAY);
  }
  const oldRedeems = redeems.filter((e) => ago(e.at) > 30 * DAY);
  const backAfterReward = oldRedeems.filter((r) => (byCustomer.get(r.customerId) || []).some((e) => Date.parse(e.at) > Date.parse(r.at) && Date.parse(e.at) - Date.parse(r.at) <= 30 * DAY));

  // messaggi inviati negli ultimi 30 giorni (automatici e del locale) e chi torna dopo "Ci manchi"
  const sent = ctx.db.campaigns.filter((c) => c.status === 'sent' && c.sentAt);
  const messages = { near: 0, review: 0, inactive: 0, manual: 0 };
  for (const c of sent) if (ago(c.sentAt) < 30 * DAY) messages[c.auto || 'manual'] = (messages[c.auto || 'manual'] || 0) + (c.recipients || []).length;
  let missN = 0, missD = 0;
  for (const c of sent.filter((x) => x.auto === 'inactive' && ago(x.sentAt) > 7 * DAY && ago(x.sentAt) < 90 * DAY)) {
    for (const id of c.recipients || []) {
      missD++;
      if ((byCustomer.get(id) || []).some((e) => Date.parse(e.at) > Date.parse(c.sentAt) && Date.parse(e.at) - Date.parse(c.sentAt) <= 7 * DAY)) missN++;
    }
  }

  // giorni della settimana e ore (ultimi 60 giorni), timbri per settimana e iscritti per settimana (ultime 8)
  const weekday = Array(7).fill(0), hours = Array(24).fill(0);
  for (const e of stamps60) { const r = rome(e.at); weekday[r.wd]++; hours[r.hour]++; }
  const weekly = (list) => Array.from({ length: 8 }, (_, i) => list.filter((iso) => ago(iso) >= (7 - i) * 7 * DAY && ago(iso) < (8 - i) * 7 * DAY).length);

  // chi dà i timbri, timbri NFC di notte, peso dei 3 clienti con più timbri (segnali di falso successo)
  const staff = {};
  for (const e of stamps30) { const k = e.by === 'nfc' ? 'Timbro NFC' : (e.who || 'Cassa'); staff[k] = (staff[k] || 0) + 1; }
  const nfc30 = stamps30.filter((e) => e.by === 'nfc');
  const perCustomer30 = {};
  for (const e of stamps30) perCustomer30[e.customerId] = (perCustomer30[e.customerId] || 0) + 1;
  const top3 = Object.values(perCustomer30).sort((a, b) => b - a).slice(0, 3).reduce((a, b) => a + b, 0);

  // visite di ritorno (tutti i timbri tranne il primo di ogni cliente) e stima dell'incasso con lo scontrino medio
  const firstStamp = new Set([...byCustomer.values()].map((evs) => evs[0].id));
  const returnVisits30 = stamps30.filter((e) => !firstStamp.has(e.id)).length;
  const avgTicket = Number(ctx.db.getSettings().avgTicket) || 0;

  // pilota: giorni dall'installazione, locale attivato (20 iscritti in 7 giorni), settimane attive (15 timbri in 4 giorni)
  const start = Date.parse(shop.createdAt) || now;
  const day = Math.floor((now - start) / DAY);
  const weeks = [];
  for (let k = 0; k < 9 && start + k * 7 * DAY <= now; k++) {
    const inWeek = stamps.filter((e) => Date.parse(e.at) >= start + k * 7 * DAY && Date.parse(e.at) < start + (k + 1) * 7 * DAY);
    const complete = start + (k + 1) * 7 * DAY <= now;
    const activeWeek = inWeek.length >= 15 && new Set(inWeek.map((e) => rome(e.at).day)).size >= 4;
    weeks.push({ n: k + 1, stamps: inWeek.length, active: activeWeek, complete });
  }
  const signups7 = customers.filter((c) => Date.parse(c.createdAt) - start < 7 * DAY).length;
  const kind = shop.theme === 'pizza' ? 'pizzeria' : 'bar';

  return {
    slug: shop.slug,
    name: shop.name,
    demo: !!shop.legacy,
    kind,
    createdAt: shop.createdAt || null,
    stampsForReward: N,
    avgTicket,
    members: customers.length,
    newMembers7: customers.filter((c) => ago(c.createdAt) < 7 * DAY).length,
    newMembers30: customers.filter((c) => ago(c.createdAt) < 30 * DAY).length,
    consent: customers.filter((c) => c.consentMarketing).length,
    wallet: customers.filter((c) => c.walletSaved).length,
    fromNfc: customers.filter((c) => { const f = (byCustomer.get(c.id) || [])[0]; return f && f.by === 'nfc' && Date.parse(f.at) - Date.parse(c.createdAt) < 5 * 60 * 1000; }).length,
    stamps: stamps.length,
    stamps7: stamps.filter((e) => ago(e.at) < 7 * DAY).length,
    stamps30: stamps30.length,
    activeDays7: new Set(stamps.filter((e) => ago(e.at) < 7 * DAY).map((e) => rome(e.at).day)).size,
    weeklyStamps: weekly(stamps.map((e) => e.at)),
    weeklySignups: weekly(customers.map((c) => c.createdAt)),
    weekday,
    hours,
    returned7: returned(7),
    returned30: returned(30),
    visitsPerMember30: customers.length ? Math.round((stamps30.length / customers.length) * 10) / 10 : 0,
    avgGapDays: gaps ? Math.round(gapDays / gaps) : null,
    regulars,
    dormant,
    neverBack,
    rewards: {
      earned: customers.reduce((n, c) => n + ctx.db.stateOf(c.id, N).earned, 0),
      redeemed: redeems.length,
      avgDaysToFirst: firstReward.length ? Math.round(firstReward.reduce((a, b) => a + b, 0) / firstReward.length) : null,
      backAfter: ratio(new Set(backAfterReward.map((r) => r.customerId)).size, new Set(oldRedeems.map((r) => r.customerId)).size),
    },
    messages,
    missYouBack: ratio(missN, missD),
    money: { returnVisits30, estimate30: avgTicket ? Math.round(returnVisits30 * avgTicket) : null },
    staff: Object.entries(staff).map(([who, n]) => ({ who, stamps: n })).sort((a, b) => b.stamps - a.stamps),
    nfc30: nfc30.length,
    nfcNight30: nfc30.filter((e) => { const h = rome(e.at).hour; return h >= 22 || h < 6; }).length,
    top3Share: stamps30.length >= 20 ? Math.round((top3 / stamps30.length) * 100) : null,
    pilot: {
      day,
      activated: day >= 7 ? signups7 >= 20 : null,
      signups7,
      weeks,
      target7: kind === 'bar' ? 30 : null,
      target30: kind === 'bar' ? 50 : 30,
    },
  };
}

// Tutti i locali; i totali escludono il locale demo originale
function compute(list, now = Date.now()) {
  const all = list.map((ctx) => shopStats(ctx, now));
  const real = all.filter((s) => !s.demo);
  const sum = (f) => real.reduce((n, s) => n + f(s), 0);
  return {
    generatedAt: new Date(now).toISOString(),
    totals: {
      shops: real.length,
      members: sum((s) => s.members),
      newMembers7: sum((s) => s.newMembers7),
      stamps7: sum((s) => s.stamps7),
      stamps30: sum((s) => s.stamps30),
      returned7: ratio(sum((s) => s.returned7.n), sum((s) => s.returned7.d)),
      returned30: ratio(sum((s) => s.returned30.n), sum((s) => s.returned30.d)),
      rewardsRedeemed: sum((s) => s.rewards.redeemed),
      dormant: sum((s) => s.dormant),
      wallet: sum((s) => s.wallet),
      weeklyStamps: Array.from({ length: 8 }, (_, i) => sum((s) => s.weeklyStamps[i])),
    },
    shops: all,
  };
}

// ---------- Accessi ----------

const tickets = new Map();  // impronta del link monouso -> scadenza
const sessions = new Map(); // impronta della sessione -> { exp }
let accessLog = [];         // ultimi accessi: { at, who, device, ip }
let alert = () => {};

const device = (ua = '') => {
  const os = /iPhone|iPad/.test(ua) ? 'iPhone' : /Android/.test(ua) ? 'Android' : /Windows/.test(ua) ? 'Windows' : /Mac OS/.test(ua) ? 'Mac' : /curl|node|undici/i.test(ua) ? 'programma' : 'altro';
  const br = /Edg\//.test(ua) ? 'Edge' : /Chrome\//.test(ua) ? 'Chrome' : /Firefox\//.test(ua) ? 'Firefox' : /Safari\//.test(ua) ? 'Safari' : '';
  return br ? `${os}, ${br}` : os;
};
const maskIp = (ip = '') => ip.replace(/^::ffff:/, '').replace(/(\d+\.\d+)\.\d+\.\d+$/, '$1.x.x').replace(/^([0-9a-f]+:[0-9a-f]+):.*$/i, '$1:…');
const hhmm = (d = new Date()) => d.toLocaleTimeString('it-IT', { timeZone: 'Europe/Rome', hour: '2-digit', minute: '2-digit' });

function logAccess(req, who) {
  accessLog.unshift({ at: new Date().toISOString(), who, device: device(req.get('user-agent')), ip: maskIp(req.ip) });
  accessLog = accessLog.slice(0, 100);
  db.saveKey(LOG_KEY, { log: accessLog });
}

// Nuovo link monouso (lo chiede il bot per il proprietario). Il codice sta dopo "#": non arriva mai al server
// nell'indirizzo e non finisce nei registri; la pagina lo manda con un POST.
function newLink(publicUrl) {
  const now = Date.now();
  for (const [k, exp] of tickets) if (exp < now) tickets.delete(k);
  const t = random();
  tickets.set(hex(t), now + TICKET_MS);
  return `${publicUrl}/statistiche/entra#t=${t}`;
}

function sessionOf(req) {
  const m = (req.headers.cookie || '').match(new RegExp(`(?:^|;\\s*)${COOKIE}=([^;]+)`));
  if (!m) return null;
  const k = hex(m[1]);
  const s = sessions.get(k);
  if (!s) return null;
  if (s.exp < Date.now()) { sessions.delete(k); return null; }
  return s;
}

// Chiave di sola lettura per Claude: almeno 32 caratteri, confronto a tempo costante
const statsKey = () => (process.env.STATS_KEY || '').trim();
function keyOk(req) {
  const key = statsKey();
  const m = (req.get('authorization') || '').match(/^Bearer\s+(.+)$/i);
  return key.length >= 32 && !!m && crypto.timingSafeEqual(sha(m[1].trim()), sha(key));
}
const badKeys = new Map(); // ip -> [istanti degli errori]

const template = () => fs.readFileSync(path.join(__dirname, 'public', 'statistiche.html'), 'utf8');
const inlineJson = (v) => JSON.stringify(v).replace(/</g, '\\u003c');

function mount(app, { all, alert: notify }) {
  alert = notify;
  db.loadKey(LOG_KEY).then((v) => { if (v && v.log) accessLog = v.log; }).catch(() => {});
  const noStore = (res) => res.set({ 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex, nofollow' });
  const sendPage = (res, data, status = 200) => {
    const html = template().replace('</head>', `  <script>window.STATS = ${inlineJson(data.stats || null)}; window.ACCESSI = ${inlineJson(data.log || [])};</script>\n</head>`);
    noStore(res).status(status).type('html').send(html);
  };

  app.get('/statistiche', (req, res) => {
    if (!sessionOf(req)) return sendPage(res, {}, 401);
    sendPage(res, { stats: compute(all()), log: accessLog.slice(0, 30) });
  });
  // pagina del link: legge il codice dopo "#" e lo manda con un POST (le anteprime dei link non lo consumano)
  app.get('/statistiche/entra', (req, res) => sendPage(res, {}));
  app.post('/statistiche/entra', (req, res) => {
    noStore(res);
    const t = String((req.body && req.body.ticket) || '');
    const k = hex(t);
    const exp = tickets.get(k);
    tickets.delete(k); // una volta sola, anche se è scaduto
    if (!t || !exp || exp < Date.now()) {
      alert(`⚠️ Qualcuno ha aperto un link delle statistiche scaduto o già usato (${device(req.get('user-agent'))}, alle ${hhmm()}). Se non eri tu, non inoltrare i link del bot.`, 'stats-bad-ticket', 3600e3);
      return res.status(403).json({ error: 'Link scaduto o già usato: chiedine uno nuovo al bot con /statistiche.' });
    }
    const sid = random();
    sessions.set(hex(sid), { exp: Date.now() + SESSION_MS });
    const secure = req.secure ? '; Secure' : '';
    res.append('Set-Cookie', `${COOKIE}=${sid}; Max-Age=${SESSION_MS / 1000}; Path=/statistiche; HttpOnly; SameSite=Strict${secure}`);
    logAccess(req, 'Federico');
    alert(`🔐 Statistiche aperte alle ${hhmm()} (${device(req.get('user-agent'))}). Se non sei stato tu, scrivi /statistiche_esci al bot.`, `stats-login|${hex(sid)}`, 0);
    res.json({ ok: true });
  });
  // esce da tutti i dispositivi
  app.post('/statistiche/esci', (req, res) => {
    noStore(res);
    if (!sessionOf(req)) return res.status(401).json({ error: 'Non sei dentro.' });
    sessions.clear();
    res.append('Set-Cookie', `${COOKIE}=; Max-Age=0; Path=/statistiche`);
    res.json({ ok: true });
  });

  // Claude: stessi numeri in JSON, con la chiave di sola lettura. Senza chiave giusta la risposta è "non esiste".
  app.get('/api/statistiche', (req, res) => {
    noStore(res);
    if (!statsKey()) return res.status(404).json({ error: 'Non trovato.' });
    const now = Date.now();
    const recent = (badKeys.get(req.ip) || []).filter((t) => now - t < 3600e3);
    if (recent.length >= 10) return res.status(429).json({ error: 'Troppi tentativi.' });
    if (!keyOk(req)) {
      badKeys.set(req.ip, [...recent, now]);
      if (req.get('authorization')) alert(`⚠️ Qualcuno ha provato a leggere le statistiche con una chiave sbagliata (${maskIp(req.ip)}, alle ${hhmm()}).`, 'stats-bad-key');
      return res.status(404).json({ error: 'Non trovato.' });
    }
    logAccess(req, 'Claude');
    res.json(compute(all()));
  });
}

// Il bot: "esci da tutti i dispositivi" anche senza aprire la pagina
function closeAll() { sessions.clear(); tickets.clear(); }

// Solo in anteprima sul PC (mai su Render): link di prova stampato all'avvio, perché lì il bot non c'è
function devLink(publicUrl) {
  if (process.env.STATS_DEV_LINK !== '1' || process.env.RENDER) return null;
  return newLink(publicUrl);
}

module.exports = { mount, compute, newLink, closeAll, devLink };
