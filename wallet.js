// Integrazione Google Wallet (loyalty pass) tramite REST API + link "Salva in Google Wallet" firmato JWT.
// Se le credenziali non sono configurate il modulo resta disattivato e la demo usa solo la tessera web.
// Un emittente (issuer) Google, una "classe" per ogni locale: le funzioni ricevono la configurazione del locale (c).
const fs = require('fs');
const jwt = require('jsonwebtoken');
const { GoogleAuth } = require('google-auth-library');

const BASE = 'https://walletobjects.googleapis.com/walletobjects/v1';

let cfg = null;
let creds = null;
let auth = null;

// config: { issuerId, keyJson, keyFile, origin } (comuni a tutti i locali)
function init(config) {
  cfg = config;
  if (!cfg.issuerId) return disabled('GOOGLE_ISSUER_ID non impostato');
  try {
    if (cfg.keyJson) creds = JSON.parse(cfg.keyJson);
    else if (fs.existsSync(cfg.keyFile)) creds = JSON.parse(fs.readFileSync(cfg.keyFile, 'utf8'));
    else return disabled(`chiave non trovata (GOOGLE_SA_JSON o ${cfg.keyFile})`);
  } catch (err) {
    return disabled(`chiave della service account non valida: ${err.message}`);
  }
  if (!creds.client_email || !creds.private_key) return disabled('chiave della service account incompleta');
  auth = new GoogleAuth({ credentials: creds, scopes: ['https://www.googleapis.com/auth/wallet_object.issuer'] });
  console.log(`[wallet] Google Wallet attivo (issuer ${cfg.issuerId}, service account ${creds.client_email})`);
  return true;
}

function disabled(reason) {
  console.log(`[wallet] Google Wallet DISATTIVATO: ${reason}. La demo userà solo la tessera web.`);
  return false;
}

const enabled = () => !!auth;
const classId = (c) => `${cfg.issuerId}.${c.classSuffix}`;
const objectId = (customer) => `${cfg.issuerId}.c_${customer.id}`;

async function request(method, url, data) {
  const client = await auth.getClient();
  const res = await client.request({ method, url, data });
  return res.data;
}

const status = (err) => err.response && err.response.status;

function describe(err) {
  const body = err.response && err.response.data;
  return body ? JSON.stringify(body.error || body) : err.message;
}

function classBody(c) {
  return {
    id: classId(c),
    issuerName: c.pizzeriaName,
    programName: c.programName,
    programLogo: {
      sourceUri: { uri: c.logoUrl },
      contentDescription: { defaultValue: { language: 'it-IT', value: `Logo ${c.pizzeriaName}` } },
    },
    // Logo largo: su Android sostituisce l'intestazione (logo rotondo + nome)
    ...(c.wideLogoUrl && {
      wideProgramLogo: {
        sourceUri: { uri: c.wideLogoUrl },
        contentDescription: { defaultValue: { language: 'it-IT', value: c.pizzeriaName } },
      },
    }),
    hexBackgroundColor: c.brandColor,
    countryCode: 'IT',
    reviewStatus: 'UNDER_REVIEW',
    // Fronte della tessera: una sola riga "Timbri · Premio · Codice".
    // Con una sola riga Google mette l'immagine delle pizze subito sopra.
    classTemplateInfo: {
      cardTemplateOverride: {
        cardRowTemplateInfos: [{
          threeItems: {
            startItem: { firstValue: { fields: [{ fieldPath: "object.textModulesData['timbri']" }] } },
            middleItem: { firstValue: { fields: [{ fieldPath: "object.textModulesData['premio']" }] } },
            endItem: { firstValue: { fields: [{ fieldPath: "object.textModulesData['codice']" }] } },
          },
        }],
      },
    },
  };
}

// Crea la classe del programma se non esiste, altrimenti la aggiorna (nome, logo, colore).
async function ensureClass(c) {
  const url = `${BASE}/loyaltyClass/${classId(c)}`;
  try {
    await request('GET', url);
  } catch (err) {
    if (status(err) !== 404) throw new Error(`lettura classe fallita: ${describe(err)}`);
    await request('POST', `${BASE}/loyaltyClass`, classBody(c));
    console.log(`[wallet] classe creata: ${classId(c)}`);
    return;
  }
  await request('PATCH', url, classBody(c));
  console.log(`[wallet] classe aggiornata: ${classId(c)}`);
}

// Se Google rifiuta le GIF (non documentate ufficialmente) si torna alle immagini fisse.
let gifSupported = true;

// animated=true solo subito dopo un timbro: la GIF si vede una volta, poi il server
// rimette l'immagine fissa (vedi settleWallet in server.js).
// Le immagini hanno una versione (c.imgVersion): cambiandola Google scarica di nuovo i file (li conserva per indirizzo).
function heroFile(c, state, animated) {
  const n = c.stampsForReward;
  const stamps = Math.min(state.stamps, n);
  const rewardReady = state.rewards > 0 && stamps === 0;
  if (animated && gifSupported && (rewardReady || stamps > 0)) {
    return rewardReady ? `anim-${n}-reward.gif` : `anim-${n}-${stamps}.gif`;
  }
  // premio pronto: tutti i timbri colorati; altrimenti i timbri attuali
  return `grid-${n}-${rewardReady ? n : stamps}.png`;
}
const heroUri = (c, state, animated) => `${c.stampsImageBase}/${heroFile(c, state, animated)}?v=${c.imgVersion}`;

// Testi in italiano con la traduzione inglese: Google mostra quella della lingua del telefono.
// Se Google rifiutasse i campi tradotti si torna ai soli testi italiani (vedi upsertObject).
let i18nSupported = true;
const loc = (it, en) => ({
  defaultValue: { language: 'it-IT', value: it },
  ...(en && en !== it && { translatedValues: [{ language: 'en', value: en }] }),
});
// Modulo di testo: header/body italiani, più le versioni tradotte se attive
function textModule(id, header, body, i18n) {
  const m = { id, header: header[0], body: body[0] };
  if (i18n) { m.localizedHeader = loc(...header); m.localizedBody = loc(...body); }
  return m;
}
function link(id, uri, description, i18n) {
  return { id, uri, description: description[0], ...(i18n && { localizedDescription: loc(...description) }) };
}

// extras (impostati dal gestore in Dashboard): reviewUrl, mapsUrl, phone
// extras.offerId: buono premio collegato (vedi syncOffer)
function objectBody(c, customer, state, extras = {}, { i18n = i18nSupported } = {}) {
  const n = c.stampsForReward;
  const missing = n - state.stamps;
  const reward = c.rewardText.toLowerCase();
  const cardUrl = `${c.baseUrl}/card/${customer.token}`;
  const links = [];
  if (!c.walletQr) links.push(link('qr', `${cardUrl}?qr=1`, ['🔳 Mostra il QR per la cassa', '🔳 Show the QR code at the till'], i18n));
  links.push(link('web', cardUrl, [`${c.emoji} Apri la tessera animata`, `${c.emoji} Open the animated card`], i18n));
  if (extras.reviewUrl) links.push(link('review', extras.reviewUrl, ['⭐ Lascia una recensione su Google', '⭐ Leave a Google review'], i18n));
  if (extras.mapsUrl) links.push(link('maps', extras.mapsUrl, ['📍 Come raggiungerci', '📍 How to find us'], i18n));
  if (extras.phone) {
    links.push(link('tel', `tel:${extras.phone.replace(/[^\d+]/g, '')}`,
      [`📞 Chiama / prenota (${extras.phone})`, `📞 Call / book (${extras.phone})`], i18n));
  }
  return {
    id: objectId(customer),
    classId: classId(c),
    state: 'ACTIVE',
    accountId: customer.code,
    accountName: customer.name,
    loyaltyPoints: { label: 'Timbri', ...(i18n && { localizedLabel: loc('Timbri', 'Stamps') }), balance: { string: `${state.stamps} / ${n}` } },
    secondaryLoyaltyPoints: {
      label: 'Premi disponibili', ...(i18n && { localizedLabel: loc('Premi disponibili', 'Rewards available') }), balance: { int: state.rewards },
    },
    ...(extras.offerId && { linkedOfferIds: [extras.offerId] }),
    // QR nel Wallet facoltativo (WALLET_QR=on): Google non permette di spostarlo né rimpicciolirlo,
    // quindi di default si toglie per lasciare spazio alle pizze. In cassa si usa il codice cliente
    // (mostrato sul fronte) oppure il QR della tessera web, raggiungibile dal link nei dettagli.
    // Come nella tessera web, il QR contiene il codice cliente e non il token (che apre la tessera).
    ...(c.walletQr && { barcode: { type: 'QR_CODE', value: customer.code, alternateText: customer.code } }),
    // Striscia dei timbri (immagine principale della tessera): un file per ogni stato,
    // URL diverso = Google la ricarica. Formato 3:1, come la mostra il Wallet sulle carte fedeltà.
    // Animata (GIF): l'ultima pizza ottenuta entra girando con il "+1"; con un premio pronto le pizze "saltano".
    heroImage: {
      sourceUri: { uri: heroUri(c, state, extras.animated === true) },
      contentDescription: { defaultValue: { language: 'it-IT', value: `${state.stamps} timbri su ${n}` } },
    },
    textModulesData: [
      // i primi tre compaiono sul fronte della tessera (vedi classTemplateInfo)
      textModule('timbri', ['Timbri', 'Stamps'], [`${state.stamps} / ${n}`], i18n),
      textModule('premio', ['Premio', 'Reward'],
        state.rewards > 0 ? [`🎁 ${state.rewards} da ritirare`, `🎁 ${state.rewards} to collect`] : [c.rewardShort], i18n),
      textModule('codice', ['Codice', 'Code'], [customer.code], i18n),
      state.rewards > 0
        ? textModule('stato', ['Hai un premio da ritirare!', 'You have a reward to collect!'],
          [`Mostra questa tessera in cassa: ${reward}.`, `Show this card at the till: ${reward}.`], i18n)
        : textModule('stato', ['Prossimo premio', 'Next reward'], [
          `Ti ${missing === 1 ? 'manca 1 timbro' : `mancano ${missing} timbri`} per: ${reward}.`,
          `${missing === 1 ? '1 more stamp' : `${missing} more stamps`} for: ${reward}.`,
        ], i18n),
      textModule('regole', ['Come funziona', 'How it works'], c.walletQr
        ? [`Mostra il QR a ogni visita: ricevi 1 timbro. Ogni ${n} timbri: ${reward}.`,
          `Show the QR code at every visit to get 1 stamp. Every ${n} stamps: ${reward}.`]
        : [`A ogni visita apri questa tessera e avvicina il telefono in cassa: con il timbro NFC ricevi subito il punto. ` +
            `In alternativa di' il codice ${customer.code}. Ogni ${n} timbri: ${reward}.`,
          `At every visit open this card and hold your phone near the NFC tag at the till to get your stamp. ` +
            `Or just say your code ${customer.code}. Every ${n} stamps: ${reward}.`], i18n),
    ],
    linksModuleData: { uris: links },
  };
}

// notifyOnUpdate: Google avvisa il telefono quando cambia il saldo (max 3 notifiche al giorno per pass).
// Messaggio Google Wallet con scadenza: dopo expiresAt Google smette di mostrarlo.
function walletMessage({ id, header, body, expiresAt }, type = 'TEXT') {
  return {
    id, header, body, messageType: type,
    ...(expiresAt && { displayInterval: { end: { date: new Date(expiresAt).toISOString() } } }),
  };
}

// extras.messages: i soli messaggi che devono restare nella tessera (decisi dal server).
// Sostituzione completa (PUT): tutto ciò che non è nell'elenco sparisce dal pass, compresi i
// messaggi scaduti o eliminati e gli avvisi "timbro aggiunto". Nessuna lettura preliminare: più veloce.
async function upsertObject(c, customer, state, { notifyOnUpdate = false, messages = [], ...extras } = {}) {
  const send = async (body) => {
    const full = { ...body, messages: messages.map((m) => walletMessage(m)) };
    try {
      await request('PUT', `${BASE}/loyaltyObject/${body.id}`,
        notifyOnUpdate ? { ...full, notifyPreference: 'notifyOnUpdate' } : full);
    } catch (err) {
      if (status(err) !== 404) throw err;
      await request('POST', `${BASE}/loyaltyObject`, full);
    }
  };
  // Buono premio collegato: se non si riesce a prepararlo la tessera si aggiorna comunque, senza buono
  const offerId = await syncOffer(c, customer, state, extras.selfRedeem !== false).catch((err) => {
    console.warn(`[wallet] buono premio non aggiornato: ${err.message}`);
    return null;
  });
  // Ripieghi su un rifiuto di Google (400), uno alla volta e fino al riavvio: prima la GIF, poi il buono
  // collegato, poi le traduzioni. Ogni ripiego toglie solo una parte; la tessera si aggiorna comunque.
  let opts = { ...extras, offerId };
  for (;;) {
    const body = objectBody(c, customer, state, opts);
    try {
      await send(body);
      return;
    } catch (err) {
      if (status(err) !== 400) throw new Error(`aggiornamento pass fallito: ${describe(err)}`);
      if (/\.gif(\?|$)/.test(body.heroImage.sourceUri.uri)) {
        gifSupported = false;
        console.warn(`[wallet] GIF animata rifiutata (${describe(err)}): uso le immagini fisse`);
      } else if (opts.offerId) {
        opts = { ...opts, offerId: null };
        offersSupported = false;
        console.warn(`[wallet] buono collegato rifiutato (${describe(err)}): tessere senza buono`);
      } else if (i18nSupported) {
        i18nSupported = false;
        console.warn(`[wallet] testi tradotti rifiutati (${describe(err)}): solo italiano`);
      } else {
        throw new Error(`aggiornamento pass fallito: ${describe(err)}`);
      }
    }
  }
}

// ---------- Buono premio ----------
// Con un premio da ritirare la tessera ha collegato un "buono" (Google Wallet Offer): compare come
// offerta a parte nel Wallet. Quando il premio è ritirato il buono risulta usato.
// Un buono per cliente (stesso id), riattivato a ogni nuovo premio.
let offersSupported = true;
const offerClassId = (c) => `${cfg.issuerId}.${c.classSuffix}_premio`;
const offerObjectId = (customer) => `${cfg.issuerId}.c_${customer.id}_premio`;
const offerClassReady = new Map(); // classSuffix -> firma dei dati con cui è stata creata/aggiornata

function offerClassBody(c) {
  return {
    id: offerClassId(c),
    issuerName: c.pizzeriaName,
    provider: c.pizzeriaName,
    title: c.rewardText,
    localizedTitle: loc(c.rewardText),
    redemptionChannel: 'INSTORE',
    reviewStatus: 'UNDER_REVIEW',
    hexBackgroundColor: c.brandColor,
    titleImage: {
      sourceUri: { uri: c.logoUrl },
      contentDescription: { defaultValue: { language: 'it-IT', value: `Logo ${c.pizzeriaName}` } },
    },
    details: `Premio della tessera fedeltà di ${c.pizzeriaName}. Mostralo in cassa per ritirarlo.`,
    localizedDetails: loc(`Premio della tessera fedeltà di ${c.pizzeriaName}. Mostralo in cassa per ritirarlo.`,
      `Loyalty card reward from ${c.pizzeriaName}. Show it at the till to collect it.`),
  };
}

async function ensureOfferClass(c) {
  const body = offerClassBody(c);
  const sign = JSON.stringify(body);
  if (offerClassReady.get(c.classSuffix) === sign) return;
  try {
    await request('PUT', `${BASE}/offerClass/${body.id}`, body);
  } catch (err) {
    if (status(err) !== 404) throw err;
    await request('POST', `${BASE}/offerClass`, body);
  }
  offerClassReady.set(c.classSuffix, sign);
}

// Restituisce l'id del buono da collegare alla tessera (solo con un premio da ritirare), altrimenti null.
// selfRedeem: il locale permette il ritiro del premio dal telefono del cliente (impostazione del locale)
async function syncOffer(c, customer, state, selfRedeem = true) {
  if (!offersSupported) return null;
  const id = offerObjectId(customer);
  const active = state.rewards > 0;
  if (!active && !state.earned) return null; // mai avuto un premio, quindi nessun buono da chiudere
  try {
    if (active) await ensureOfferClass(c);
    const body = {
      id, classId: offerClassId(c), state: active ? 'ACTIVE' : 'COMPLETED',
      ...(c.walletQr && { barcode: { type: 'QR_CODE', value: customer.code, alternateText: customer.code } }),
      heroImage: {
        sourceUri: { uri: `${c.stampsImageBase}/grid-${c.stampsForReward}-${c.stampsForReward}.png?v=${c.imgVersion}` },
        contentDescription: loc('Premio sbloccato', 'Reward unlocked'),
      },
      textModulesData: [textModule('premio', ['Premio', 'Reward'],
        [state.rewards > 1 ? `${c.rewardText} (×${state.rewards})` : c.rewardText], i18nSupported)],
      // Link al ritiro: la tessera web chiede subito "Usare il premio adesso?" (o, se il locale ha spento
      // il ritiro dal telefono, apre il QR a tutto schermo da mostrare in cassa). Vedi card.html (?premio=1).
      linksModuleData: {
        uris: [link('ritira', `${c.baseUrl}/card/${customer.token}?premio=1`, selfRedeem
          ? ['🎁 Ritira il premio', '🎁 Collect your reward']
          : ['🔳 Mostra il QR in cassa per ritirarlo', '🔳 Show the QR code at the till to collect it'], i18nSupported)],
      },
    };
    try {
      await request('PUT', `${BASE}/offerObject/${id}`, body);
    } catch (err) {
      if (status(err) !== 404 || !active) throw err;
      await request('POST', `${BASE}/offerObject`, body);
    }
    return active ? id : null;
  } catch (err) {
    if (status(err) === 404 && !active) return null; // buono mai creato
    if (status(err) === 400 || status(err) === 403) {
      offersSupported = false; // Google non accetta i buoni per questo issuer: si lascia stare
    }
    throw new Error(describe(err));
  }
}

// Messaggio nei dettagli del pass. push=true: anche notifica sul telefono (TEXT_AND_NOTIFY).
// Google consente al massimo 3 notifiche push per pass ogni 24 ore: se la quota è finita
// il messaggio viene comunque aggiunto alla tessera, senza notifica.
// Restituisce { ok, push } con quello che è stato effettivamente inviato.
// expiresAt: da quel momento Google non mostra più il messaggio nei dettagli della tessera.
async function notify(customer, header, body, { push = true, messageId, expiresAt } = {}) {
  const url = `${BASE}/loyaltyObject/${objectId(customer)}/addMessage`;
  const message = (type) => ({
    message: walletMessage({ id: messageId || `m_${Date.now()}`, header, body, expiresAt }, type),
  });
  try {
    await request('POST', url, message(push ? 'TEXT_AND_NOTIFY' : 'TEXT'));
    return { ok: true, push };
  } catch (err) {
    const quota = status(err) === 429 || /quota/i.test(describe(err));
    if (push && quota) {
      try {
        await request('POST', url, message('TEXT'));
        return { ok: true, push: false };
      } catch (err2) {
        console.warn(`[wallet] messaggio non inviato: ${describe(err2)}`);
        return { ok: false, push: false };
      }
    }
    console.warn(`[wallet] messaggio non inviato: ${describe(err)}`);
    return { ok: false, push: false, notSaved: status(err) === 404 };
  }
}

// Tessera cancellata su richiesta del cliente: il pass resta nel telefono ma disattivato e senza il nome.
async function deactivate(customer) {
  try {
    await request('PATCH', `${BASE}/loyaltyObject/${objectId(customer)}`, {
      state: 'INACTIVE', accountName: 'Tessera cancellata', accountId: '-', textModulesData: [], linksModuleData: { uris: [] }, messages: [],
      linkedOfferIds: [],
    });
  } catch (err) {
    if (status(err) !== 404) throw new Error(`disattivazione pass fallita: ${describe(err)}`);
  }
  // anche l'eventuale buono premio
  await request('PATCH', `${BASE}/offerObject/${offerObjectId(customer)}`, { state: 'INACTIVE' }).catch(() => {});
}

// La tessera è già stata salvata in un Google Wallet? (campo hasUsers del pass)
async function isSaved(customer) {
  try {
    const obj = await request('GET', `${BASE}/loyaltyObject/${objectId(customer)}`);
    return !!obj.hasUsers;
  } catch {
    return false;
  }
}

function saveUrl(customer) {
  const token = jwt.sign(
    {
      iss: creds.client_email,
      aud: 'google',
      typ: 'savetowallet',
      origins: [cfg.origin],
      payload: { loyaltyObjects: [{ id: objectId(customer) }] },
    },
    creds.private_key,
    { algorithm: 'RS256' },
  );
  return `https://pay.google.com/gp/v/save/${token}`;
}

module.exports = { init, enabled, ensureClass, upsertObject, notify, saveUrl, isSaved, heroFile, deactivate };
