// Integrazione Google Wallet (loyalty pass) tramite REST API + link "Salva in Google Wallet" firmato JWT.
// Se le credenziali non sono configurate il modulo resta disattivato e la demo usa solo la tessera web.
const fs = require('fs');
const jwt = require('jsonwebtoken');
const { GoogleAuth } = require('google-auth-library');

const BASE = 'https://walletobjects.googleapis.com/walletobjects/v1';

let cfg = null;
let creds = null;
let auth = null;

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
const classId = () => `${cfg.issuerId}.${cfg.classSuffix}`;
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

function classBody() {
  return {
    id: classId(),
    issuerName: cfg.pizzeriaName,
    programName: cfg.programName,
    programLogo: {
      sourceUri: { uri: cfg.logoUrl },
      contentDescription: { defaultValue: { language: 'it-IT', value: `Logo ${cfg.pizzeriaName}` } },
    },
    hexBackgroundColor: cfg.brandColor,
    countryCode: 'IT',
    reviewStatus: 'UNDER_REVIEW',
  };
}

// Crea la classe del programma se non esiste, altrimenti la aggiorna (nome, logo, colore).
async function ensureClass() {
  const url = `${BASE}/loyaltyClass/${classId()}`;
  try {
    await request('GET', url);
  } catch (err) {
    if (status(err) !== 404) throw new Error(`lettura classe fallita: ${describe(err)}`);
    await request('POST', `${BASE}/loyaltyClass`, classBody());
    console.log(`[wallet] classe creata: ${classId()}`);
    return;
  }
  await request('PATCH', url, classBody());
  console.log(`[wallet] classe aggiornata: ${classId()}`);
}

// extras.reviewUrl: link "Lascia una recensione su Google" (impostato dal gestore in Dashboard)
function objectBody(customer, state, extras = {}) {
  const n = cfg.stampsForReward;
  const missing = n - state.stamps;
  const links = [{ id: 'web', uri: `${cfg.publicUrl}/card/${customer.token}`, description: '🍕 Apri la tessera animata' }];
  if (extras.reviewUrl) links.unshift({ id: 'review', uri: extras.reviewUrl, description: '⭐ Lascia una recensione su Google' });
  return {
    id: objectId(customer),
    classId: classId(),
    state: 'ACTIVE',
    accountId: customer.code,
    accountName: customer.name,
    loyaltyPoints: { label: 'Timbri', balance: { string: `${state.stamps} / ${n}` } },
    secondaryLoyaltyPoints: { label: 'Premi disponibili', balance: { int: state.rewards } },
    barcode: { type: 'QR_CODE', value: customer.token, alternateText: customer.code },
    // Griglia dei timbri (immagine principale della tessera): un file per ogni stato,
    // URL diverso = Google la ricarica. Formato 1032x812 come da linee guida Google Wallet.
    heroImage: {
      sourceUri: { uri: `${cfg.stampsImageBase}/grid-${n}-${Math.min(state.stamps, n)}.png` },
      contentDescription: { defaultValue: { language: 'it-IT', value: `${state.stamps} timbri su ${n}` } },
    },
    textModulesData: [
      {
        id: 'stato',
        header: state.rewards > 0 ? 'Hai un premio da ritirare!' : 'Prossimo premio',
        body: state.rewards > 0
          ? `Mostra questa tessera in cassa: ${cfg.rewardText.toLowerCase()}.`
          : `Ti ${missing === 1 ? 'manca 1 timbro' : `mancano ${missing} timbri`} per: ${cfg.rewardText.toLowerCase()}.`,
      },
      {
        id: 'regole',
        header: 'Come funziona',
        body: `Mostra il QR a ogni visita: ricevi 1 timbro. Ogni ${n} timbri: ${cfg.rewardText.toLowerCase()}.`,
      },
    ],
    linksModuleData: { uris: links },
  };
}

// notifyOnUpdate: Google avvisa il telefono quando cambia il saldo (max 3 notifiche al giorno per pass).
async function upsertObject(customer, state, { notifyOnUpdate = false, ...extras } = {}) {
  const body = objectBody(customer, state, extras);
  try {
    await request('PATCH', `${BASE}/loyaltyObject/${body.id}`,
      notifyOnUpdate ? { ...body, notifyPreference: 'notifyOnUpdate' } : body);
  } catch (err) {
    if (status(err) !== 404) throw new Error(`aggiornamento pass fallito: ${describe(err)}`);
    await request('POST', `${BASE}/loyaltyObject`, body);
  }
}

// Messaggio nei dettagli del pass. push=true: anche notifica sul telefono (TEXT_AND_NOTIFY).
// Google consente al massimo 3 notifiche push per pass ogni 24 ore: se la quota è finita
// il messaggio viene comunque aggiunto alla tessera, senza notifica.
// Restituisce { ok, push } con quello che è stato effettivamente inviato.
async function notify(customer, header, body, { push = true, messageId } = {}) {
  const url = `${BASE}/loyaltyObject/${objectId(customer)}/addMessage`;
  const message = (type) => ({ message: { id: messageId || `m_${Date.now()}`, header, body, messageType: type } });
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

function saveUrl(customer) {
  const token = jwt.sign(
    {
      iss: creds.client_email,
      aud: 'google',
      typ: 'savetowallet',
      origins: [cfg.publicUrl],
      payload: { loyaltyObjects: [{ id: objectId(customer) }] },
    },
    creds.private_key,
    { algorithm: 'RS256' },
  );
  return `https://pay.google.com/gp/v/save/${token}`;
}

module.exports = { init, enabled, ensureClass, upsertObject, notify, saveUrl };
