// Registro dei locali. Ogni locale ha il suo indirizzo (/<slug>/), il suo archivio di clienti,
// il suo PIN della cassa, la sua classe Google Wallet e le sue immagini.
// Il primo locale (la demo originale) nasce dalle variabili d'ambiente e conserva i dati e le tessere già emesse.
const path = require('path');
const crypto = require('crypto');
const db = require('./db');
const { THEMES } = require('./images');

const REGISTRY_KEY = 'shops';
// Parole che non possono essere l'indirizzo di un locale (sono pagine o file del sito)
const RESERVED = new Set(['api', 'card', 'tap', 'stamps', 'icons', 'telegram', 'admin', 'staff', 'poster', 'static', 'public',
  'sw.js', 'style.css', 'common.js', 'logo.png', 'manifest.json', 'favicon.ico', 'index.html', 'robots.txt']);

let publicUrl = '';
let list = [];                 // record dei locali, come salvati
const contexts = new Map();    // slug -> { shop, db, cfg }

const save = () => db.saveKey(REGISTRY_KEY, list);

function legacyFromEnv() {
  const e = process.env;
  return {
    slug: e.LEGACY_SLUG || 'da-mario',
    name: e.PIZZERIA_NAME || 'Pizzeria Da Mario',
    programName: e.PROGRAM_NAME || 'Tessera Amici della Pizza',
    rewardText: e.REWARD_TEXT || 'Una pizza margherita omaggio',
    rewardShort: e.REWARD_SHORT || 'Margherita gratis',
    stampsForReward: Math.max(1, Number(e.STAMPS_FOR_REWARD) || 6),
    brandColor: e.BRAND_COLOR || '#b3261e',
    theme: 'pizza',
    codePrefix: 'PZ',
    staffPin: null, // il PIN resta quello della variabile STAFF_PIN
    classSuffix: e.GOOGLE_CLASS_SUFFIX || 'pizzeria_demo_v1',
    dataKey: 'db',  // archivio delle versioni precedenti
    legacy: true,
    imgVersion: 1,
    createdAt: new Date().toISOString(),
  };
}

async function init(url) {
  publicUrl = url;
  list = (await db.loadKey(REGISTRY_KEY)) || [];
  if (!list.length) {
    list.push(legacyFromEnv());
    save();
  }
  for (const shop of list) await openContext(shop);
  console.log(`[locali] ${list.length}: ${list.map((s) => s.slug).join(', ')}`);
}

async function openContext(shop) {
  const store = await db.openStore(shop.dataKey, { codePrefix: shop.codePrefix });
  const ctx = { shop, db: store, get cfg() { return cfgOf(shop); } };
  contexts.set(shop.slug, ctx);
  return ctx;
}

// Configurazione completa di un locale, nel formato usato da server e Wallet
function cfgOf(shop) {
  const baseUrl = `${publicUrl}/${shop.slug}`;
  const v = shop.imgVersion || 1;
  return {
    slug: shop.slug,
    pizzeriaName: shop.name,
    programName: shop.programName,
    rewardText: shop.rewardText,
    rewardShort: shop.rewardShort,
    stampsForReward: shop.stampsForReward,
    brandColor: shop.brandColor,
    theme: shop.theme,
    emoji: (THEMES[shop.theme] || THEMES.stella).emoji,
    codePrefix: shop.codePrefix,
    staffPin: shop.staffPin || process.env.STAFF_PIN || '1234',
    classSuffix: shop.classSuffix,
    baseUrl,
    // logo del primo locale: per compatibilità può restare su un indirizzo esterno (LOGO_URL)
    logoUrl: (shop.legacy && process.env.LOGO_URL) || `${baseUrl}/logo.png?v=${v}`,
    wideLogoUrl: shop.legacy && process.env.WIDE_LOGO_URL !== 'off' ? `${baseUrl}/wide-logo.png` : '',
    stampsImageBase: `${baseUrl}/stamps`,
    imgVersion: v,
    walletQr: process.env.WALLET_QR === 'on',
  };
}

// Dati per generare le immagini (vedi images.js)
function imageSpec(shop) {
  return {
    slug: shop.slug, theme: shop.theme, stampsForReward: shop.stampsForReward, brandColor: shop.brandColor,
    imgVersion: shop.imgVersion || 1, logo: shop.logo || null,
    logoFile: shop.legacy && !shop.logo ? path.join(__dirname, 'public', 'logo.png') : null,
  };
}

const get = (slug) => contexts.get(String(slug || '').toLowerCase()) || null;
const all = () => [...contexts.values()];
const defaultSlug = () => (list[0] ? list[0].slug : 'da-mario');

function slugify(name) {
  return String(name).normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'locale';
}

function uniqueSlug(name) {
  const base = slugify(name);
  let slug = base, i = 2;
  while (contexts.has(slug) || RESERVED.has(slug)) slug = `${base}-${i++}`;
  return slug;
}

// Iniziali dei codici cliente: dalle parole "importanti" del nome (es. "Bar Luna" → LU)
function prefixFor(name) {
  const skip = new Set(['pizzeria', 'ristorante', 'bar', 'caffe', 'trattoria', 'osteria', 'gelateria', 'pub', 'da', 'la', 'il', 'lo', 'le', 'i', 'di', 'del', 'della', 'e', 'al', 'alla', 'the']);
  const words = slugify(name).split('-').filter(Boolean);
  const main = words.filter((w) => !skip.has(w) && /^[a-z]/.test(w));
  const letters = (main.length >= 2 ? main[0][0] + main[1][0] : (main[0] || words[0] || 'ts').slice(0, 2)).toUpperCase();
  return letters.replace(/[^A-Z]/g, 'X').padEnd(2, 'X');
}

const newPin = () => String(crypto.randomInt(0, 1e6)).padStart(6, '0');

// Valida e normalizza i campi modificabili di un locale. Restituisce { error } oppure i valori puliti.
function clean(input, { partial = false } = {}) {
  const out = {};
  const has = (k) => input[k] !== undefined && input[k] !== null;
  const str = (k, max) => String(input[k]).trim().slice(0, max);
  if (has('name') || !partial) {
    out.name = has('name') ? str('name', 50) : '';
    if (out.name.length < 2) return { error: 'Il nome del locale è troppo corto.' };
  }
  if (has('programName')) out.programName = str('programName', 50);
  if (has('rewardText') || !partial) {
    out.rewardText = has('rewardText') ? str('rewardText', 80) : '';
    if (out.rewardText.length < 3) return { error: 'Descrivi il premio (es. "Una pizza margherita omaggio").' };
  }
  if (has('rewardShort')) out.rewardShort = str('rewardShort', 22);
  if (has('stampsForReward') || !partial) {
    const n = Number(input.stampsForReward);
    if (!Number.isInteger(n) || n < 3 || n > 12) return { error: 'I timbri per il premio devono essere tra 3 e 12.' };
    out.stampsForReward = n;
  }
  if (has('brandColor') || !partial) {
    const c = has('brandColor') ? str('brandColor', 7) : '';
    if (!/^#[0-9a-fA-F]{6}$/.test(c)) return { error: 'Colore non valido: usa il formato #RRGGBB (es. #b3261e).' };
    out.brandColor = c.toLowerCase();
  }
  if (has('theme') || !partial) {
    if (!THEMES[input.theme]) return { error: 'Tipo di timbro non valido.' };
    out.theme = input.theme;
  }
  if ('logo' in input) out.logo = input.logo || null; // PNG in base64 (già preparato da images.prepareLogo)
  return out;
}

// Nomi brevi automatici, se il gestore non li indica
function defaults(shop) {
  if (!shop.programName) shop.programName = `Tessera fedeltà ${shop.name}`.slice(0, 50);
  if (!shop.rewardShort) {
    const r = shop.rewardText.replace(/^(una?|un'|il|lo|la|1)\s+/i, '');
    shop.rewardShort = (r.charAt(0).toUpperCase() + r.slice(1)).slice(0, 22);
  }
}

async function create(input) {
  const data = clean(input);
  if (data.error) return data;
  const slug = uniqueSlug(input.slug || data.name);
  const shop = {
    slug, ...data,
    codePrefix: prefixFor(data.name),
    staffPin: newPin(),
    // suffisso unico: le classi Google non si possono cancellare, un locale ricreato ne usa una nuova
    classSuffix: `shop_${slug.replace(/-/g, '_')}_${Date.now().toString(36)}`,
    dataKey: `shop:${slug}`,
    imgVersion: 1,
    createdAt: new Date().toISOString(),
  };
  defaults(shop);
  list.push(shop);
  save();
  const ctx = await openContext(shop);
  // link facoltativi del locale (stessi campi della pagina Impostazioni della dashboard)
  const settings = {};
  for (const k of ['reviewUrl', 'mapsUrl', 'phone']) if (input[k]) settings[k] = String(input[k]).trim();
  if (Object.keys(settings).length) ctx.db.updateSettings(settings);
  return { ctx };
}

// Campi che cambiano l'aspetto delle immagini: le immagini prendono una nuova versione
const VISUAL = ['theme', 'brandColor', 'stampsForReward', 'logo'];

function update(slug, input) {
  const ctx = get(slug);
  if (!ctx) return { error: 'Locale non trovato.' };
  const data = clean(input, { partial: true });
  if (data.error) return data;
  const visual = VISUAL.some((k) => k in data && data[k] !== ctx.shop[k]);
  Object.assign(ctx.shop, data);
  if ('rewardText' in data && !('rewardShort' in data)) { ctx.shop.rewardShort = ''; defaults(ctx.shop); }
  if (visual) ctx.shop.imgVersion = (ctx.shop.imgVersion || 1) + 1;
  save();
  return { ctx, visual };
}

function resetPin(slug) {
  const ctx = get(slug);
  if (!ctx) return null;
  ctx.shop.staffPin = newPin();
  save();
  return ctx.shop.staffPin;
}

async function remove(slug) {
  const ctx = get(slug);
  if (!ctx) return { error: 'Locale non trovato.' };
  if (ctx.shop.legacy) return { error: 'Il locale demo originale non si può eliminare.' };
  list = list.filter((s) => s.slug !== slug);
  contexts.delete(slug);
  save();
  await db.deleteKey(ctx.shop.dataKey);
  return { ok: true };
}

// Tessera (token) → locale. Serve ai vecchi link senza indirizzo del locale.
function findByToken(token) {
  for (const ctx of contexts.values()) {
    const customer = ctx.db.findByToken(token);
    if (customer) return { ctx, customer };
  }
  return null;
}

const findByNfcSecret = (secret) => all().find((ctx) => ctx.db.getSettings().nfcSecret === secret) || null;

module.exports = {
  init, get, all, defaultSlug, cfgOf, imageSpec, create, update, resetPin, remove, findByToken, findByNfcSecret, RESERVED,
};
