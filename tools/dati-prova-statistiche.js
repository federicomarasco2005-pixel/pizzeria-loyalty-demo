// Dati di prova per l'anteprima della pagina delle statistiche: 3 locali inventati con clienti e visite realistici.
// Solo su file, in una cartella vuota, mai sul database vero. Uso (PowerShell):
//   $env:DATA_DIR="C:/Users/feder/AppData/Local/Temp/f5m-statistiche-data"; node tools/dati-prova-statistiche.js
// Poi l'anteprima "statistiche-anteprima" di .claude/launch.json (porta 3002) stampa il link di prova.
const path = require('path');
if (process.env.DATABASE_URL || !process.env.DATA_DIR) {
  console.error('Serve DATA_DIR (una cartella vuota) e niente DATABASE_URL: questi dati sono finti.');
  process.exit(1);
}
const db = require(path.join(__dirname, '..', 'db'));
const shops = require(path.join(__dirname, '..', 'shops'));

let seed = 42;
const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
const pick = (a) => a[Math.floor(rnd() * a.length)];
const DAY = 86400000, NOW = Date.now();
const NAMES = ['Luca', 'Giulia', 'Marco', 'Sara', 'Paolo', 'Elena', 'Andrea', 'Chiara', 'Matteo', 'Anna', 'Davide', 'Marta', 'Simone', 'Laura', 'Fabio', 'Irene'];

async function shopWith({ name, theme, stamps, daysAgo, customers, ticket, profile }) {
  const { ctx } = await shops.create({ name, rewardText: theme === 'pizza' ? 'Una margherita omaggio' : 'Un caffè omaggio', stampsForReward: stamps, brandColor: '#3949ab', theme });
  const start = NOW - daysAgo * DAY;
  ctx.shop.createdAt = new Date(start).toISOString();
  shops.addStaff(ctx.shop.slug, 'Giulia'); // salva anche la data di installazione
  ctx.db.updateSettings({ avgTicket: ticket });
  const visits = [];
  for (let i = 0; i < customers; i++) {
    // iscrizioni più numerose nei primi giorni
    const signup = start + Math.pow(rnd(), 1.8) * (NOW - start - 3600e3);
    const c = ctx.db.createCustomer({ name: pick(NAMES), email: `prova${i}@${ctx.shop.slug}.example`, consentMarketing: rnd() < 0.6 });
    c.createdAt = new Date(profile.hour(signup)).toISOString();
    if (rnd() < 0.45) c.walletSaved = true;
    const loyal = rnd();
    let t = Date.parse(c.createdAt) + 60e3;
    visits.push({ c, t, nfc: rnd() < 0.15 });
    while (true) {
      if (loyal < profile.never) break;
      t += profile.gap(loyal) * DAY;
      if (t > NOW || (loyal < profile.stop && t - Date.parse(c.createdAt) > 25 * DAY)) break;
      visits.push({ c, t: profile.hour(t), nfc: rnd() < 0.2 });
    }
  }
  visits.sort((a, b) => a.t - b.t);
  const count = new Map();
  for (const v of visits) {
    if (v.t > NOW) continue;
    const e = ctx.db.addEvent({ type: 'stamp', customerId: v.c.id, by: v.nfc ? 'nfc' : 'staff', who: v.nfc ? null : (rnd() < 0.5 ? 'Giulia' : 'Gestore') });
    e.at = new Date(v.t).toISOString();
    const n = (count.get(v.c.id) || 0) + 1;
    count.set(v.c.id, n);
    if (n % stamps === 0 && rnd() < 0.8) {
      const r = ctx.db.addEvent({ type: 'redeem', customerId: v.c.id, by: 'staff', who: 'Gestore' });
      r.at = new Date(v.t + 120e3).toISOString();
    }
  }
  // "Ci manchi" mandato 12 giorni fa ai clienti fermi
  const sleeping = ctx.db.customers.filter((c) => c.consentMarketing && rnd() < 0.3).map((c) => c.id);
  const camp = ctx.db.createCampaign({ title: 'Ci manchi!', body: 'prova', segment: 'manual', ids: sleeping, promo: true, auto: 'inactive', sendAt: new Date(NOW - 12 * DAY).toISOString(), recipients: [], keepDays: 3 });
  ctx.db.updateCampaign(camp.id, { status: 'sent', sentAt: new Date(NOW - 12 * DAY).toISOString(), recipients: sleeping });
  ctx.db.updateSettings({}); // riscrive il file con le date sistemate
  console.log(`${name}: ${ctx.db.customers.length} clienti, ${ctx.db.events.length} operazioni`);
}

const atHour = (lo, hi) => (t) => { const d = new Date(t); d.setHours(lo + Math.floor(rnd() * (hi - lo)), Math.floor(rnd() * 60)); return d.getTime(); };
const eveningWeekend = (t) => { const d = new Date(t); while (![4, 5, 6, 0].includes(d.getDay())) d.setDate(d.getDate() + 1); d.setHours(19 + Math.floor(rnd() * 3), Math.floor(rnd() * 60)); return d.getTime(); };

(async () => {
  await db.init();
  await shops.init('http://localhost:3002');
  await shopWith({ name: 'Bar Luna', theme: 'caffe', stamps: 10, daysAgo: 45, customers: 70, ticket: 3.5,
    profile: { never: 0.3, stop: 0.45, gap: (l) => 1 + rnd() * (l > 0.8 ? 2 : 6), hour: atHour(7, 12) } });
  await shopWith({ name: 'Pizzeria Sole', theme: 'pizza', stamps: 6, daysAgo: 38, customers: 45, ticket: 22,
    profile: { never: 0.4, stop: 0.55, gap: (l) => 6 + rnd() * (l > 0.8 ? 6 : 16), hour: eveningWeekend } });
  await shopWith({ name: 'Caffè Centrale', theme: 'caffe', stamps: 8, daysAgo: 9, customers: 14, ticket: 3,
    profile: { never: 0.4, stop: 0.5, gap: () => 1 + rnd() * 3, hour: atHour(7, 11) } });
  await db.flush();
  console.log('fatto');
  process.exit(0);
})();
