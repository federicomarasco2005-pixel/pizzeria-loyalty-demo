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

// extras (impostati dal gestore in Dashboard): reviewUrl, mapsUrl, phone
function objectBody(c, customer, state, extras = {}) {
  const n = c.stampsForReward;
  const missing = n - state.stamps;
  const cardUrl = `${c.baseUrl}/card/${customer.token}`;
  const links = [];
  if (!c.walletQr) links.push({ id: 'qr', uri: `${cardUrl}?qr=1`, description: '🔳 Mostra il QR per la cassa' });
  links.push({ id: 'web', uri: cardUrl, description: `${c.emoji} Apri la tessera animata` });
  if (extras.reviewUrl) links.push({ id: 'review', uri: extras.reviewUrl, description: '⭐ Lascia una recensione su Google' });
  if (extras.mapsUrl) links.push({ id: 'maps', uri: extras.mapsUrl, description: '📍 Come raggiungerci' });
  if (extras.phone) links.push({ id: 'tel', uri: `tel:${extras.phone.replace(/[^\d+]/g, '')}`, description: `📞 Chiama / prenota (${extras.phone})` });
  return {
    id: objectId(customer),
    classId: classId(c),
    state: 'ACTIVE',
    accountId: customer.code,
    accountName: customer.name,
    loyaltyPoints: { label: 'Timbri', balance: { string: `${state.stamps} / ${n}` } },
    secondaryLoyaltyPoints: { label: 'Premi disponibili', balance: { int: state.rewards } },
    // QR nel Wallet facoltativo (WALLET_QR=on): Google non permette di spostarlo né rimpicciolirlo,
    // quindi di default si toglie per lasciare spazio alle pizze. In cassa si usa il codice cliente
    // (mostrato sul fronte) oppure il QR della tessera web, raggiungibile dal link nei dettagli.
    ...(c.walletQr && { barcode: { type: 'QR_CODE', value: customer.token, alternateText: customer.code } }),
    // Striscia dei timbri (immagine principale della tessera): un file per ogni stato,
    // URL diverso = Google la ricarica. Formato 3:1, come la mostra il Wallet sulle carte fedeltà.
    // Animata (GIF): l'ultima pizza ottenuta entra girando con il "+1"; con un premio pronto le pizze "saltano".
    heroImage: {
      sourceUri: { uri: heroUri(c, state, extras.animated === true) },
      contentDescription: { defaultValue: { language: 'it-IT', value: `${state.stamps} timbri su ${n}` } },
    },
    textModulesData: [
      // i primi tre compaiono sul fronte della tessera (vedi classTemplateInfo)
      { id: 'timbri', header: 'Timbri', body: `${state.stamps} / ${n}` },
      { id: 'premio', header: 'Premio', body: state.rewards > 0 ? `🎁 ${state.rewards} da ritirare` : c.rewardShort },
      { id: 'codice', header: 'Codice', body: customer.code },
      {
        id: 'stato',
        header: state.rewards > 0 ? 'Hai un premio da ritirare!' : 'Prossimo premio',
        body: state.rewards > 0
          ? `Mostra questa tessera in cassa: ${c.rewardText.toLowerCase()}.`
          : `Ti ${missing === 1 ? 'manca 1 timbro' : `mancano ${missing} timbri`} per: ${c.rewardText.toLowerCase()}.`,
      },
      {
        id: 'regole',
        header: 'Come funziona',
        body: c.walletQr
          ? `Mostra il QR a ogni visita: ricevi 1 timbro. Ogni ${n} timbri: ${c.rewardText.toLowerCase()}.`
          : `A ogni visita apri questa tessera e avvicina il telefono in cassa: con il timbro NFC ricevi subito il punto. ` +
            `In alternativa di' il codice ${customer.code}. Ogni ${n} timbri: ${c.rewardText.toLowerCase()}.`,
      },
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
  const body = objectBody(c, customer, state, extras);
  try {
    await send(body);
  } catch (err) {
    const isGif = /\.gif(\?|$)/.test(body.heroImage.sourceUri.uri);
    if (!(isGif && status(err) === 400)) throw new Error(`aggiornamento pass fallito: ${describe(err)}`);
    // Google ha rifiutato la GIF: d'ora in poi immagini fisse.
    gifSupported = false;
    console.warn(`[wallet] GIF animata rifiutata (${describe(err)}): uso le immagini fisse`);
    await send(objectBody(c, customer, state, extras)).catch((e) => {
      throw new Error(`aggiornamento pass fallito: ${describe(e)}`);
    });
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

module.exports = { init, enabled, ensureClass, upsertObject, notify, saveUrl, isSaved, heroFile };
