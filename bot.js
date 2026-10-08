// Bot Telegram per creare e gestire le tessere dei locali da remoto, senza toccare il codice.
// Il gestore del servizio scrive al bot, risponde a poche domande (con pulsanti) e la tessera è subito online:
// pagina di iscrizione, cassa, dashboard, timbro NFC e classe Google Wallet.
//
// Attivazione: variabile TELEGRAM_BOT_TOKEN (il token che dà @BotFather).
// Accesso: solo il proprietario. È TELEGRAM_OWNER_ID se impostata, altrimenti la prima persona che scrive /start
// (il bot lo ricorda). Su un server pubblico (https) usa il webhook, in locale interroga Telegram (polling).
// I gestori dei locali possono collegarsi con un link d'invito: vedono solo i numeri del proprio locale.
// Il bot manda anche: backup settimanale, report settimanale, avvisi quando qualcosa non va.
const crypto = require('crypto');
const express = require('express');
const db = require('./db');

// Il token può essere una variabile d'ambiente oppure un "Secret File" di Render con lo stesso nome
// (Render lo mette in /etc/secrets/ e nella cartella dell'app).
function readSecret(name) {
  if (process.env[name]) return process.env[name].trim();
  for (const file of [`/etc/secrets/${name}`, require('path').join(__dirname, name)]) {
    try { return require('fs').readFileSync(file, 'utf8').trim().replace(new RegExp(`^${name}\\s*=\\s*`), '').replace(/^["']|["']$/g, ''); } catch {}
  }
  return '';
}
const TOKEN = readSecret('TELEGRAM_BOT_TOKEN');
const API = `https://api.telegram.org/bot${TOKEN}`;
const hash = (s) => crypto.createHash('sha256').update(`${s}:${TOKEN}`).digest('hex');
const HOOK_PATH = `/telegram/${hash('path').slice(0, 24)}`;
const HOOK_SECRET = hash('secret').slice(0, 48);

let M = null;           // operazioni sui locali (vedi "manager" in server.js)
let ownerId = null;
let botUsername = '';
let invites = {};       // codice d'invito -> { slug, exp }: link per collegare un gestore al suo locale
const saveTg = () => db.saveKey('telegram', { ownerId, invites });
let call = telegram;    // sostituibile nei test
const sessions = new Map(); // chat -> modulo in corso { mode, step, data, slug, field }

async function telegram(method, params = {}, file) {
  let body, headers;
  if (file) {
    body = new FormData();
    for (const [k, v] of Object.entries(params)) body.append(k, typeof v === 'object' ? JSON.stringify(v) : String(v));
    body.append(file.field, new Blob([file.buf], { type: file.type }), file.name);
  } else {
    body = JSON.stringify(params);
    headers = { 'Content-Type': 'application/json' };
  }
  const res = await fetch(`${API}/${method}`, { method: 'POST', body, headers });
  const data = await res.json().catch(() => ({}));
  if (!data.ok) throw new Error(`Telegram ${method}: ${data.description || res.status}`);
  return data.result;
}

// ---------- Avvio ----------

function mount(app) {
  if (!TOKEN) return;
  app.post(HOOK_PATH, express.json(), (req, res) => {
    if (req.get('x-telegram-bot-api-secret-token') !== HOOK_SECRET) return res.status(401).end();
    res.json({ ok: true }); // risposta immediata, l'elaborazione continua
    handleUpdate(req.body).catch((err) => console.error(`[bot] ${err.message}`));
  });
}

async function start(manager, { api, username } = {}) {
  M = manager;
  if (api) call = api;
  if (username) botUsername = username;
  if (!TOKEN && !api) {
    console.log('[bot] Telegram DISATTIVATO: imposta TELEGRAM_BOT_TOKEN per gestire i locali dal bot.');
    return;
  }
  const saved = (await db.loadKey('telegram')) || {};
  ownerId = Number(process.env.TELEGRAM_OWNER_ID) || saved.ownerId || null;
  invites = saved.invites || {};
  if (api) return;
  try {
    const me = await call('getMe');
    botUsername = me.username;
    await call('setMyCommands', {
      commands: [
        { command: 'nuova', description: 'Crea la tessera di un nuovo locale' },
        { command: 'locali', description: 'I tuoi locali: link, numeri, modifiche' },
        { command: 'report', description: 'Report della settimana di tutti i locali' },
        { command: 'backup', description: 'Copia completa dei dati, subito' },
        { command: 'annulla', description: 'Interrompi l\'operazione in corso' },
        { command: 'aiuto', description: 'Cosa sa fare il bot' },
      ],
    });
    if (M.publicUrl.startsWith('https://')) {
      await call('setWebhook', { url: M.publicUrl + HOOK_PATH, secret_token: HOOK_SECRET, allowed_updates: ['message', 'callback_query'] });
      console.log(`[bot] Telegram attivo: @${me.username} (webhook)`);
    } else {
      await call('deleteWebhook');
      console.log(`[bot] Telegram attivo: @${me.username} (polling, server locale)`);
      poll();
    }
  } catch (err) {
    console.error(`[bot] avvio non riuscito: ${err.message}`);
  }
}

async function poll() {
  let offset = 0;
  for (;;) {
    try {
      const updates = await call('getUpdates', { offset, timeout: 30, allowed_updates: ['message', 'callback_query'] });
      for (const u of updates) {
        offset = u.update_id + 1;
        await handleUpdate(u).catch((err) => console.error(`[bot] ${err.message}`));
      }
    } catch (err) {
      console.error(`[bot] ${err.message}`);
      await new Promise((r) => setTimeout(r, 5000));
    }
  }
}

// ---------- Utilità per i messaggi ----------

const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const kb = (rows) => ({ inline_keyboard: rows });
const btn = (text, data) => ({ text, callback_data: data });
const urlBtn = (text, url) => ({ text, url });

function send(chat, text, keyboard) {
  return call('sendMessage', {
    chat_id: chat, text, parse_mode: 'HTML', disable_web_page_preview: true,
    ...(keyboard && { reply_markup: keyboard }),
  });
}

async function sendPhoto(chat, buf, caption, keyboard) {
  return call('sendPhoto', {
    chat_id: chat, caption, parse_mode: 'HTML', ...(keyboard && { reply_markup: keyboard }),
  }, { field: 'photo', buf, type: 'image/png', name: 'anteprima.png' });
}

const COLORS = [
  ['🔴 Rosso', '#b3261e'], ['🟢 Verde', '#1b5e20'], ['🔵 Blu', '#0d47a1'],
  ['⚫ Nero', '#212121'], ['🟠 Arancio', '#d84315'], ['🟤 Marrone', '#5d4037'],
  ['🟣 Viola', '#6a1b9a'], ['🩷 Rosa', '#ad1457'], ['🩵 Azzurro', '#00838f'],
];
const colorName = (hex) => (COLORS.find(([, h]) => h === hex) || [hex])[0];

// ---------- Domande del modulo ----------
// Ogni campo: domanda, eventuali pulsanti, controllo della risposta. "optional" = si può saltare.

const FIELDS = {
  name: {
    label: 'Nome del locale',
    ask: () => ['🏷️ <b>Come si chiama il locale?</b>\n<i>Es. Pizzeria Da Mario, Bar Luna</i>'],
    parse: (t) => (t.length >= 2 && t.length <= 50 ? { value: t } : { error: 'Scrivi un nome tra 2 e 50 caratteri.' }),
  },
  theme: {
    label: 'Tipo di timbro',
    ask: () => ['🎨 <b>Che timbro vuoi sulla tessera?</b>\nSono le icone che si riempiono a ogni visita.',
      kb(chunk(Object.entries(M.themes).map(([k, t]) => btn(`${k === 'logo' ? '🖼️' : t.emoji} ${t.label}`, `v:${k}`)), 2))],
  },
  stampsForReward: {
    label: 'Timbri per il premio',
    ask: () => ['🔢 <b>Quanti timbri servono per il premio?</b>\nTocca un numero o scrivine uno da 3 a 12.',
      kb([[4, 5, 6, 8].map((n) => btn(String(n), `v:${n}`)), [10, 12].map((n) => btn(String(n), `v:${n}`))])],
    parse: (t) => {
      const n = Number(t);
      return Number.isInteger(n) && n >= 3 && n <= 12 ? { value: n } : { error: 'Scrivi un numero da 3 a 12.' };
    },
  },
  rewardText: {
    label: 'Premio',
    ask: () => ['🎁 <b>Qual è il premio?</b>\n<i>Es. Una pizza margherita omaggio · Un caffè gratis · Un dolce della casa</i>'],
    parse: (t) => (t.length >= 3 && t.length <= 80 ? { value: t } : { error: 'Descrivi il premio in 3–80 caratteri.' }),
  },
  rewardShort: {
    label: 'Premio (versione breve)',
    ask: () => ['✂️ <b>Versione breve del premio</b> (sul fronte della tessera Wallet, max 22 caratteri)\n<i>Es. Margherita gratis</i>'],
    parse: (t) => (t.length >= 2 && t.length <= 22 ? { value: t } : { error: 'Massimo 22 caratteri.' }),
  },
  brandColor: {
    label: 'Colore',
    ask: () => ['🎨 <b>Colore della tessera?</b>\nTocca un colore oppure scrivi un codice come <code>#b3261e</code>.',
      kb(chunk(COLORS.map(([n, h]) => btn(n, `v:${h}`)), 3))],
    parse: (t) => (/^#?[0-9a-f]{6}$/i.test(t) ? { value: `#${t.replace('#', '').toLowerCase()}` } : { error: 'Codice colore non valido (es. #b3261e).' }),
  },
  logo: {
    label: 'Logo',
    optional: true,
    ask: () => ['🖼️ <b>Mandami il logo del locale</b> come foto o come file (meglio PNG quadrato).\nSe non ce l\'hai, tocca Salta: userò il timbro scelto come logo.',
      kb([[btn('⏭️ Salta', 'skip')]])],
  },
  reviewUrl: {
    label: 'Link recensioni Google',
    optional: true,
    settings: true,
    ask: () => ['⭐ <b>Link per lasciare una recensione su Google</b>\nDal profilo Google del locale: <i>Chiedi recensioni → Condividi</i> (inizia con https://g.page/… o https://search.google.com/…).',
      kb([[btn('⏭️ Salta', 'skip')]])],
    parse: (t) => (/^https:\/\/\S+$/.test(t) ? { value: t } : { error: 'Il link deve iniziare con https://' }),
  },
  phone: {
    label: 'Telefono',
    optional: true,
    settings: true,
    ask: () => ['📞 <b>Numero di telefono per prenotare</b> (compare nella tessera)', kb([[btn('⏭️ Salta', 'skip')]])],
    parse: (t) => (/^\+?[\d\s./-]{6,30}$/.test(t) ? { value: t } : { error: 'Numero non valido.' }),
  },
  mapsUrl: {
    label: 'Link Google Maps',
    optional: true,
    settings: true,
    ask: () => ['📍 <b>Link Google Maps del locale</b> (Condividi → Copia link)', kb([[btn('⏭️ Salta', 'skip')]])],
    parse: (t) => (/^https:\/\/\S+$/.test(t) ? { value: t } : { error: 'Il link deve iniziare con https://' }),
  },
};

// Ordine delle domande per una nuova tessera
const CREATE_STEPS = ['name', 'theme', 'stampsForReward', 'rewardText', 'brandColor', 'logo', 'reviewUrl', 'phone'];
const EDITABLE = ['name', 'rewardText', 'rewardShort', 'stampsForReward', 'theme', 'brandColor', 'logo', 'reviewUrl', 'phone', 'mapsUrl'];

function chunk(arr, n) {
  const out = [];
  for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n));
  return out;
}

function ask(chat, field, prefix = '') {
  const [text, keyboard] = FIELDS[field].ask();
  return send(chat, prefix + text, keyboard);
}

// ---------- Gestione dei messaggi ----------

async function handleUpdate(u) {
  if (!M) return;
  const msg = u.message || (u.callback_query && u.callback_query.message);
  if (!msg) return;
  const chat = msg.chat.id;
  const from = (u.message || u.callback_query).from;
  if (u.callback_query) call('answerCallbackQuery', { callback_query_id: u.callback_query.id }).catch(() => {});

  const firstText = u.message ? (u.message.text || '').trim() : '';
  const invite = firstText.match(/^\/start g_([A-Za-z0-9_-]+)$/);
  if (!ownerId && !invite) {
    // Primo contatto: chi scrive per primo diventa il proprietario del bot
    ownerId = from.id;
    saveTg();
    await send(chat, `🔐 Ciao ${esc(from.first_name)}! Da ora questo bot risponde solo a te.`);
  }
  if (from.id !== ownerId) {
    if (invite) return redeemInvite(chat, from, invite[1]);
    if (M.managedBy(chat).length) return managerUpdate(chat, u);
    return send(chat, `⛔ Questo bot è privato. (Il tuo ID Telegram è <code>${from.id}</code>)`);
  }

  if (u.callback_query) return onButton(chat, u.callback_query.data || '', msg);
  if (u.message.photo || (u.message.document && /^image\//.test(u.message.document.mime_type || ''))) return onImage(chat, u.message);
  const text = (u.message.text || '').trim();
  if (text.startsWith('/')) return onCommand(chat, text.split(/[\s@]/)[0].toLowerCase());
  return onText(chat, text);
}

async function onCommand(chat, cmd) {
  if (cmd === '/start' || cmd === '/aiuto' || cmd === '/help') return menu(chat);
  if (cmd === '/nuova') return startCreate(chat);
  if (cmd === '/locali') return listShops(chat);
  if (cmd === '/backup') return sendBackup('💾 Backup su richiesta', chat);
  if (cmd === '/report') return sendReport(chat, M.all());
  if (cmd === '/annulla') {
    sessions.delete(chat);
    return send(chat, '👌 Operazione annullata.', kb([[btn('🏠 Menu', 'menu')]]));
  }
  return menu(chat);
}

function menu(chat) {
  return send(chat,
    '👋 <b>Tessere fedeltà</b>\n\n' +
    '➕ <b>Nuova tessera</b>: rispondi a qualche domanda e il locale ha subito pagina di iscrizione, cassa, dashboard, timbro NFC e tessera Google Wallet.\n' +
    '📋 <b>I miei locali</b>: link, PIN della cassa, numeri, modifiche.\n\n' +
    'In ogni momento: /annulla',
    kb([[btn('➕ Nuova tessera', 'new'), btn('📋 I miei locali', 'list')], [btn('📈 Report settimana', 'report'), btn('💾 Backup ora', 'backup')]]));
}

function startCreate(chat) {
  sessions.set(chat, { mode: 'create', step: 0, data: {} });
  return ask(chat, CREATE_STEPS[0], '➕ <b>Nuova tessera</b> — 8 domande veloci (le ultime si possono saltare).\n\n');
}

async function onText(chat, text) {
  const s = sessions.get(chat);
  if (s && s.mode === 'staff') return addStaffNamed(chat, s.slug, text);
  if (!s || !s.field && s.mode !== 'create') return menu(chat);
  const field = s.mode === 'create' ? CREATE_STEPS[s.step] : s.field;
  if (!field) return send(chat, 'Usa i pulsanti qui sopra 👆');
  const f = FIELDS[field];
  if (!f.parse) return send(chat, field === 'logo' ? 'Mandami il logo come foto o file, oppure tocca Salta.' : 'Usa i pulsanti qui sopra 👆');
  const r = f.parse(text);
  if (r.error) return send(chat, `⚠️ ${r.error}`);
  return answer(chat, s, field, r.value);
}

async function onImage(chat, message) {
  const s = sessions.get(chat);
  const field = s && (s.mode === 'create' ? CREATE_STEPS[s.step] : s.field);
  if (field !== 'logo') return send(chat, 'Per cambiare il logo: 📋 I miei locali → locale → ✏️ Modifica → Logo.');
  try {
    const fileId = message.photo ? message.photo[message.photo.length - 1].file_id : message.document.file_id;
    const file = await call('getFile', { file_id: fileId });
    const res = await fetch(`https://api.telegram.org/file/bot${TOKEN}/${file.file_path}`);
    const logo = await M.prepareLogo(Buffer.from(await res.arrayBuffer()));
    return answer(chat, s, 'logo', logo);
  } catch (err) {
    console.error(`[bot] logo: ${err.message}`);
    return send(chat, '⚠️ Non riesco a leggere questa immagine. Prova con un PNG o un JPG.');
  }
}

// Risposta valida a una domanda del modulo
async function answer(chat, s, field, value) {
  if (s.mode === 'edit') return applyEdit(chat, s, field, value);
  s.data[field] = value;
  if (s.review) { s.review = false; s.step = CREATE_STEPS.length; return summary(chat, s); }
  s.step++;
  if (s.step < CREATE_STEPS.length) return ask(chat, CREATE_STEPS[s.step], value === null ? '' : '✅\n');
  return summary(chat, s);
}

async function summary(chat, s) {
  const d = s.data;
  const t = M.themes[d.theme];
  const text =
    `📝 <b>Riepilogo</b>\n\n` +
    `🏷️ <b>${esc(d.name)}</b>\n` +
    `${t.emoji} Timbro: ${esc(t.label)}\n` +
    `🎁 Ogni <b>${d.stampsForReward}</b> timbri: ${esc(d.rewardText)}\n` +
    `🎨 Colore: ${esc(colorName(d.brandColor))}\n` +
    `🖼️ Logo: ${d.logo ? 'caricato' : 'generato dal timbro'}\n` +
    `⭐ Recensioni: ${d.reviewUrl ? esc(d.reviewUrl) : '—'}\n` +
    `📞 Telefono: ${d.phone ? esc(d.phone) : '—'}`;
  const keyboard = kb([[btn('✅ Crea la tessera', 'create')], [btn('✏️ Cambia qualcosa', 'fix'), btn('❌ Annulla', 'cancel')]]);
  try {
    const img = await M.preview({ shop: { slug: `anteprima-${chat}`, ...d, imgVersion: Date.now() } });
    return sendPhoto(chat, img, text, keyboard);
  } catch (err) {
    console.error(`[bot] anteprima: ${err.message}`);
    return send(chat, text, keyboard);
  }
}

async function onButton(chat, data, msg) {
  const s = sessions.get(chat);
  const [action, arg] = [data.split(':')[0], data.split(':').slice(1).join(':')];

  if (action === 'menu') return menu(chat);
  if (action === 'report') return sendReport(chat, M.all());
  if (action === 'backup') return sendBackup('💾 Backup su richiesta', chat);
  if (action === 'rep1') { const ctx = M.get(arg); return ctx && sendReport(chat, [ctx]); }

  // dipendenti con PIN personale
  if (action === 'staff') return showStaff(chat, arg);
  if (action === 'staffadd') {
    sessions.set(chat, { mode: 'staff', slug: arg });
    return send(chat, '👤 Come si chiama il dipendente? (es. Giulia)');
  }
  if (action === 'staffdel') {
    const [slug, id] = arg.split('|');
    M.removeStaff(slug, id);
    await send(chat, '🗑️ Dipendente rimosso: il suo PIN non funziona più.');
    return showStaff(chat, slug);
  }

  // gestori collegati su Telegram
  if (action === 'inv') return createInvite(chat, arg);
  if (action === 'mgrdel') {
    const [slug, id] = arg.split('|');
    M.removeManager(slug, Number(id));
    call('sendMessage', { chat_id: Number(id), text: '🔒 Il tuo accesso al bot è stato rimosso.' }).catch(() => {});
    await send(chat, '🔒 Gestore scollegato.');
    return showShop(chat, slug);
  }
  if (action === 'new') return startCreate(chat);
  if (action === 'list') return listShops(chat);
  if (action === 'cancel') { sessions.delete(chat); return send(chat, '👌 Annullato.', kb([[btn('🏠 Menu', 'menu')]])); }

  // risposte con pulsante alle domande del modulo
  if (action === 'v' || action === 'skip') {
    if (!s) return menu(chat);
    const field = s.mode === 'create' ? CREATE_STEPS[s.step] : s.field;
    if (!field) return;
    if (action === 'skip') {
      if (!FIELDS[field].optional) return;
      return answer(chat, s, field, null);
    }
    const value = field === 'stampsForReward' ? Number(arg) : arg;
    return answer(chat, s, field, value);
  }

  if (action === 'fix' && s && s.mode === 'create') {
    return send(chat, 'Cosa vuoi cambiare?', kb(chunk(CREATE_STEPS.map((f) => btn(FIELDS[f].label, `fixf:${f}`)), 2)));
  }
  if (action === 'fixf' && s && s.mode === 'create') {
    s.step = CREATE_STEPS.indexOf(arg);
    s.review = true;
    return ask(chat, arg);
  }
  if (action === 'create' && s && s.mode === 'create') return createShop(chat, s);

  // locali esistenti
  if (action === 'shop') return showShop(chat, arg);
  if (action === 'edit') {
    return send(chat, '✏️ Cosa vuoi modificare?',
      kb([...chunk(EDITABLE.map((f) => btn(FIELDS[f].label, `editf:${arg}|${f}`)), 2), [btn('⬅️ Indietro', `shop:${arg}`)]]));
  }
  if (action === 'editf') {
    const [slug, field] = arg.split('|');
    sessions.set(chat, { mode: 'edit', slug, field });
    const f = FIELDS[field];
    const extra = f.optional ? '\n<i>Salta = togli il valore attuale.</i>' : '';
    const [text, keyboard] = f.ask();
    return send(chat, text + extra, keyboard);
  }
  if (action === 'preview') {
    const ctx = M.get(arg);
    if (!ctx) return send(chat, 'Locale non trovato.');
    return sendPhoto(chat, await M.preview(ctx), `${ctx.cfg.emoji} <b>${esc(ctx.cfg.pizzeriaName)}</b> — anteprima dei timbri`);
  }
  if (action === 'pin') {
    const ctx = M.get(arg);
    if (!ctx) return;
    if (ctx.shop.legacy) return send(chat, 'Il PIN di questo locale è la variabile STAFF_PIN su Render: si cambia da lì.');
    return send(chat, '🔑 Generare un nuovo PIN? Il vecchio smetterà di funzionare su tutti i telefoni della cassa.',
      kb([[btn('✅ Sì, nuovo PIN', `pinok:${arg}`), btn('❌ No', `shop:${arg}`)]]));
  }
  if (action === 'pinok') {
    const pin = M.resetPin(arg);
    return send(chat, pin ? `🔑 Nuovo PIN della cassa: <code>${pin}</code>` : 'Locale non trovato.', kb([[btn('⬅️ Torna al locale', `shop:${arg}`)]]));
  }
  if (action === 'del') {
    const ctx = M.get(arg);
    if (!ctx || ctx.shop.legacy) return;
    const { members } = M.stats(ctx);
    return send(chat,
      `🗑️ Eliminare <b>${esc(ctx.cfg.pizzeriaName)}</b>?\n\nSi cancellano ${members} clienti e tutti i loro timbri. ` +
      'Le pagine smettono di funzionare. <b>Non si può annullare.</b>',
      kb([[btn('🗑️ Sì, elimina per sempre', `delok:${arg}`)], [btn('❌ No, tienilo', `shop:${arg}`)]]));
  }
  if (action === 'delok') {
    const r = await M.remove(arg);
    return send(chat, r.error ? `⚠️ ${esc(r.error)}` : '🗑️ Locale eliminato.', kb([[btn('📋 I miei locali', 'list')]]));
  }
  return menu(chat);
}

async function createShop(chat, s) {
  sessions.delete(chat);
  await send(chat, '⏳ Creo la tessera, le immagini e la classe Google Wallet…');
  const r = await M.create(s.data);
  if (r.error) {
    sessions.set(chat, s);
    return send(chat, `⚠️ ${esc(r.error)}`, kb([[btn('✏️ Cambia qualcosa', 'fix'), btn('❌ Annulla', 'cancel')]]));
  }
  const { ctx } = r;
  const L = M.links(ctx);
  const warn = r.warnings.length ? `\n\n⚠️ ${r.warnings.map(esc).join('\n⚠️ ')}` : '';
  return send(chat,
    `🎉 <b>${esc(ctx.cfg.pizzeriaName)}</b> è online!\n\n` +
    `🔑 PIN cassa e dashboard: <code>${ctx.cfg.staffPin}</code>\n\n` +
    `🖨️ QR da tavolo (da stampare): ${L.poster}\n` +
    `👥 Iscrizione clienti: ${L.signup}\n` +
    `🧾 Cassa: ${L.staff}\n` +
    `📊 Dashboard e notifiche: ${L.admin}\n` +
    `📲 Da scrivere nel timbro NFC:\n<code>${esc(L.nfc)}</code>\n\n` +
    `Per provarla: apri il link di iscrizione dal telefono e crea una tessera.${warn}`,
    kb([[urlBtn('🖨️ QR da tavolo', L.poster), urlBtn('🧾 Cassa', L.staff)], [btn('📋 I miei locali', 'list'), btn('➕ Nuova', 'new')]]));
}

async function listShops(chat) {
  const all = M.all();
  if (!all.length) return send(chat, 'Nessun locale ancora.', kb([[btn('➕ Nuova tessera', 'new')]]));
  const lines = all.map((ctx) => {
    const k = M.stats(ctx);
    return `${ctx.cfg.emoji} <b>${esc(ctx.cfg.pizzeriaName)}</b> — ${k.members} iscritti, ${k.stampsLast7} timbri in 7 giorni`;
  });
  return send(chat, `📋 <b>I tuoi locali</b> (${all.length})\n\n${lines.join('\n')}`,
    kb([...all.map((ctx) => [btn(`${ctx.cfg.emoji} ${ctx.cfg.pizzeriaName}`, `shop:${ctx.shop.slug}`)]), [btn('➕ Nuova tessera', 'new')]]));
}

async function showShop(chat, slug) {
  const ctx = M.get(slug);
  if (!ctx) return send(chat, 'Locale non trovato.', kb([[btn('📋 I miei locali', 'list')]]));
  const { cfg } = ctx;
  const k = M.stats(ctx);
  const L = M.links(ctx);
  const st = M.settings(ctx);
  const pin = ctx.shop.legacy ? 'variabile STAFF_PIN su Render' : `<code>${cfg.staffPin}</code>`;
  const text =
    `${cfg.emoji} <b>${esc(cfg.pizzeriaName)}</b>\n` +
    `🎁 Ogni ${cfg.stampsForReward} timbri: ${esc(cfg.rewardText)}\n\n` +
    `👥 Iscritti: <b>${k.members}</b> (nuovi in 7 giorni: ${k.newLast7})\n` +
    `${cfg.emoji} Timbri: <b>${k.stamps}</b> (ultimi 7 giorni: ${k.stampsLast7})\n` +
    `🔁 Clienti tornati: ${k.returning} · 🎁 premi consegnati: ${k.rewardsRedeemed}\n` +
    `📣 Con consenso marketing: ${k.marketingConsent}\n\n` +
    `🔑 PIN: ${pin}\n` +
    `👥 Iscrizione: ${L.signup}\n` +
    `🧾 Cassa: ${L.staff}\n` +
    `📊 Dashboard: ${L.admin}\n` +
    `📲 NFC: <code>${esc(L.nfc)}</code>\n` +
    `⭐ Recensioni: ${st.reviewUrl ? esc(st.reviewUrl) : '—'} · 📞 ${st.phone ? esc(st.phone) : '—'}\n` +
    `👤 Dipendenti con PIN: ${(ctx.shop.staff || []).length} · 🤝 Gestori su Telegram: ${(ctx.shop.managers || []).map((m) => esc(m.name)).join(', ') || '—'}`;
  const rows = [
    [urlBtn('📊 Dashboard', L.admin), urlBtn('🖨️ QR tavolo', L.poster)],
    [btn('✏️ Modifica', `edit:${slug}`), btn('🖼️ Anteprima', `preview:${slug}`)],
    [btn('👤 Dipendenti', `staff:${slug}`), btn('🤝 Accesso gestore', `inv:${slug}`)],
    [btn('📈 Report', `rep1:${slug}`), ...(ctx.shop.managers || []).slice(0, 1).map((m) => btn(`🔒 Scollega ${m.name}`.slice(0, 30), `mgrdel:${slug}|${m.chatId}`))],
    [btn('🔑 Nuovo PIN', `pin:${slug}`), ...(ctx.shop.legacy ? [] : [btn('🗑️ Elimina', `del:${slug}`)])],
    [btn('⬅️ I miei locali', 'list')],
  ];
  return send(chat, text, kb(rows));
}

async function applyEdit(chat, s, field, value) {
  sessions.delete(chat);
  const input = { [field]: value === null && field !== 'logo' ? '' : value };
  const r = await M.update(s.slug, input);
  if (r.error) {
    sessions.set(chat, s);
    return send(chat, `⚠️ ${esc(r.error)}`);
  }
  const warn = r.warnings && r.warnings.length ? `\n⚠️ ${r.warnings.map(esc).join('\n⚠️ ')}` : '';
  await send(chat, `✅ ${esc(FIELDS[field].label)} aggiornato. Le tessere già emesse si aggiornano da sole nei prossimi minuti.${warn}`,
    kb([[btn('✏️ Altra modifica', `edit:${s.slug}`), btn('⬅️ Torna al locale', `shop:${s.slug}`)]]));
}

// ---------- Dipendenti ----------

async function showStaff(chat, slug) {
  const ctx = M.get(slug);
  if (!ctx) return;
  const staff = ctx.shop.staff || [];
  const lines = staff.map((p) => `• <b>${esc(p.name)}</b> — PIN <code>${p.pin}</code>`).join('\n') || '<i>Nessuno: tutti usano il PIN del gestore.</i>';
  return send(chat,
    `👤 <b>Dipendenti di ${esc(ctx.cfg.pizzeriaName)}</b>\n\n${lines}\n\n` +
    'Ognuno entra in Cassa con il suo PIN: nello storico vedi chi ha dato ogni timbro. ' +
    'Il PIN dei dipendenti apre solo la Cassa, non la dashboard.',
    kb([[btn('➕ Aggiungi dipendente', `staffadd:${slug}`)],
      ...staff.map((p) => [btn(`🗑️ Rimuovi ${p.name}`, `staffdel:${slug}|${p.id}`)]),
      [btn('⬅️ Torna al locale', `shop:${slug}`)]]));
}

async function addStaffNamed(chat, slug, name) {
  sessions.delete(chat);
  const r = M.addStaff(slug, name);
  if (r.error) { sessions.set(chat, { mode: 'staff', slug }); return send(chat, `⚠️ ${esc(r.error)}`); }
  await send(chat, `✅ <b>${esc(r.person.name)}</b> aggiunto. Il suo PIN della Cassa: <code>${r.person.pin}</code>`);
  return showStaff(chat, slug);
}

// ---------- Gestori dei locali ----------

async function createInvite(chat, slug) {
  const ctx = M.get(slug);
  if (!ctx) return;
  if (!botUsername) return send(chat, 'Il bot non conosce ancora il suo nome: riprova tra un minuto.');
  const code = crypto.randomBytes(9).toString('base64url');
  invites[code] = { slug, exp: Date.now() + 7 * 86400e3 };
  for (const [k, v] of Object.entries(invites)) if (v.exp < Date.now()) delete invites[k];
  saveTg();
  const link = `https://t.me/${botUsername}?start=g_${code}`;
  return send(chat,
    `🤝 <b>Accesso per il gestore di ${esc(ctx.cfg.pizzeriaName)}</b>\n\n` +
    `Mandagli questo link (vale 7 giorni, una sola volta):\n${link}\n\n` +
    'Aprendolo vedrà nel bot <b>solo i numeri del suo locale</b> e riceverà il report ogni lunedì. ' +
    'Non può creare né modificare tessere.',
    kb([[btn('⬅️ Torna al locale', `shop:${slug}`)]]));
}

async function redeemInvite(chat, from, code) {
  const inv = invites[code];
  if (!inv || inv.exp < Date.now() || !M.get(inv.slug)) return send(chat, '⛔ Link non valido o scaduto: chiedine uno nuovo.');
  delete invites[code];
  saveTg();
  const ctx = M.addManager(inv.slug, chat, [from.first_name, from.last_name].filter(Boolean).join(' '));
  alert(`🤝 ${from.first_name || 'Un gestore'} si è collegato al bot per ${ctx.cfg.pizzeriaName}.`, `mgr|${chat}`, 0);
  await send(chat, `👋 Benvenuto! Da ora vedi qui i numeri di <b>${esc(ctx.cfg.pizzeriaName)}</b> e ricevi il report ogni lunedì.`);
  return managerMenu(chat);
}

// Il gestore vede solo i suoi locali: numeri, link e report
async function managerUpdate(chat, u) {
  const data = u.callback_query ? u.callback_query.data || '' : '';
  const mine = M.managedBy(chat);
  if (data.startsWith('mrep:')) {
    const ctx = mine.find((c) => c.shop.slug === data.slice(5));
    if (ctx) return sendReport(chat, [ctx]);
  }
  return managerMenu(chat);
}

function managerMenu(chat) {
  const mine = M.managedBy(chat);
  const text = mine.map((ctx) => {
    const k = M.stats(ctx);
    const L = M.links(ctx);
    return `${ctx.cfg.emoji} <b>${esc(ctx.cfg.pizzeriaName)}</b>\n` +
      `👥 Iscritti: <b>${k.members}</b> (nuovi in 7 giorni: ${k.newLast7})\n` +
      `${ctx.cfg.emoji} Timbri: <b>${k.stamps}</b> (ultimi 7 giorni: ${k.stampsLast7})\n` +
      `🔁 Clienti tornati: ${k.returning} · 🎁 premi consegnati: ${k.rewardsRedeemed}\n` +
      `📊 Dashboard: ${L.admin}\n🧾 Cassa: ${L.staff}`;
  }).join('\n\n');
  return send(chat, text || 'Nessun locale collegato.',
    kb(mine.map((ctx) => [btn(`📈 Report ${ctx.cfg.pizzeriaName}`.slice(0, 40), `mrep:${ctx.shop.slug}`)])));
}

// ---------- Report settimanale ----------

function reportText(ctx) {
  const w = M.weekly(ctx);
  const diff = w.stamps - w.stampsPrev;
  const trend = w.stampsPrev ? ` (${diff >= 0 ? '+' : ''}${Math.round((diff / w.stampsPrev) * 100)}% rispetto alla settimana prima)` : '';
  const staff = Object.entries(w.byStaff).sort((a, b) => b[1] - a[1]).map(([n, c]) => `${esc(n)} ${c}`).join(' · ');
  return `${ctx.cfg.emoji} <b>${esc(ctx.cfg.pizzeriaName)}</b>\n` +
    `${ctx.cfg.emoji} Timbri: <b>${w.stamps}</b>${trend}\n` +
    `🧑‍🤝‍🧑 Clienti passati: <b>${w.visitors}</b> · 🆕 nuovi iscritti: <b>${w.newMembers}</b>\n` +
    `🎁 Premi consegnati: ${w.redeemed} · ⏳ a un timbro dal premio: ${w.kpi.nearReward}\n` +
    `💤 Clienti che non tornano da 30+ giorni: ${w.kpi.inactive30}` +
    (staff ? `\n👤 Timbri dati da: ${staff}` : '');
}

function sendReport(chat, list) {
  if (!list.length) return send(chat, 'Nessun locale.');
  return send(chat, `📈 <b>Ultimi 7 giorni</b>\n\n${list.map(reportText).join('\n\n')}`);
}

// Ogni lunedì: al proprietario il riepilogo di tutti i locali, a ogni gestore quello del suo
async function sendWeeklyReports() {
  if (ownerId) await sendReport(ownerId, M.all());
  for (const ctx of M.all()) {
    for (const m of ctx.shop.managers || []) {
      await call('sendMessage', { chat_id: m.chatId, text: `📈 <b>La tua settimana</b>\n\n${reportText(ctx)}`, parse_mode: 'HTML' })
        .catch((err) => console.error(`[bot] report a ${m.chatId}: ${err.message}`));
    }
  }
}

// ---------- Backup ----------
// Copia completa (tutti i locali, clienti, timbri, impostazioni) in un file compresso mandato su Telegram.
// Da tenere: se il database si rompe, da qui si ricostruisce tutto.
async function sendBackup(caption, chat = ownerId) {
  if (!chat) return;
  const data = await M.backup();
  const gz = require('zlib').gzipSync(JSON.stringify(data));
  const day = new Date().toISOString().slice(0, 10);
  const n = data.locali.reduce((t, l) => t + l.dati.customers.length, 0);
  return call('sendDocument', {
    chat_id: chat, parse_mode: 'HTML',
    caption: `${caption}: ${data.locali.length} locali, ${n} clienti.\n<i>Conservalo: contiene dati personali dei clienti.</i>`,
  }, { field: 'document', buf: gz, type: 'application/gzip', name: `backup-tessere-${day}.json.gz` });
}

// ---------- Avvisi al proprietario ----------
// Lo stesso avviso (key) non si ripete prima di cooldownMs: niente raffiche di messaggi.
const alerted = new Map();
function alert(text, key = text, cooldownMs = 6 * 3600e3) {
  if (!ownerId || !M || (!TOKEN && call === telegram)) return;
  const last = alerted.get(key) || 0;
  if (Date.now() - last < cooldownMs) return;
  alerted.set(key, Date.now());
  call('sendMessage', { chat_id: ownerId, text }).catch((err) => console.error(`[bot] avviso: ${err.message}`));
}

const enabled = () => !!M && !!ownerId && (!!TOKEN || call !== telegram);

module.exports = { mount, start, handleUpdate, alert, enabled, sendBackup, sendWeeklyReports };
