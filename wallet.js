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

function objectBody(customer, state) {
  const n = cfg.stampsForReward;
  const missing = n - state.stamps;
  return {
    id: objectId(customer),
    classId: classId(),
    state: 'ACTIVE',
    accountId: customer.code,
    accountName: customer.name,
    loyaltyPoints: { label: 'Timbri', balance: { string: `${state.stamps} / ${n}` } },
    secondaryLoyaltyPoints: { label: 'Premi disponibili', balance: { int: state.rewards } },
    barcode: { type: 'QR_CODE', value: customer.token, alternateText: customer.code },
    // I "pallini" dei timbri: un'immagine diversa per ogni stato (URL diverso = Google la ricarica).
    heroImage: {
      sourceUri: { uri: `${cfg.stampsImageBase}/stamps-${n}-${Math.min(state.stamps, n)}.png` },
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
    linksModuleData: {
      uris: [{ id: 'web', uri: `${cfg.publicUrl}/card/${customer.token}`, description: 'Apri la tessera online' }],
    },
  };
}

// notifyOnUpdate: Google avvisa il telefono quando cambia il saldo (max 3 notifiche al giorno per pass).
async function upsertObject(customer, state, { notifyOnUpdate = false } = {}) {
  const body = objectBody(customer, state);
  try {
    await request('PATCH', `${BASE}/loyaltyObject/${body.id}`,
      notifyOnUpdate ? { ...body, notifyPreference: 'notifyOnUpdate' } : body);
  } catch (err) {
    if (status(err) !== 404) throw new Error(`aggiornamento pass fallito: ${describe(err)}`);
    await request('POST', `${BASE}/loyaltyObject`, body);
  }
}

// Messaggio sul pass con notifica sul telefono (Google limita le notifiche per pass/giorno).
async function notify(customer, header, body) {
  await request('POST', `${BASE}/loyaltyObject/${objectId(customer)}/addMessage`, {
    message: { id: `m_${Date.now()}`, header, body, messageType: 'TEXT_AND_NOTIFY' },
  }).catch((err) => console.warn(`[wallet] notifica non inviata: ${describe(err)}`));
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
