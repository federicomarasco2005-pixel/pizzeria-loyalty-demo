// Notifiche web della tessera (Web Push), soprattutto per chi non ha la tessera nel Google Wallet: iPhone
// (tessera salvata sulla Home, iOS 16.4 o più recente) e Android senza Wallet. Se il locale manda gli avvisi
// "Wallet e tessera web insieme" (bot > Automazioni, channelOf in server.js) le può attivare anche chi ha il Wallet.
// Il cliente tocca "Attiva le notifiche" nella tessera: il telefono dà un indirizzo di consegna (di Apple, Google o
// Mozilla) che salviamo nella sua scheda (customer.webPush, al massimo 5 dispositivi). Il messaggio viaggia cifrato:
// chi lo consegna non lo legge. Chiavi: VAPID_PUBLIC_KEY (anche in render.yaml) e VAPID_PRIVATE_KEY (solo su Render);
// senza tutte e due le notifiche web sono spente e la tessera non mostra il pulsante.
const webpush = require('web-push');

const MAX_DEVICES = 5;
let ready = false;

function init({ subject }) {
  const pub = (process.env.VAPID_PUBLIC_KEY || '').trim();
  const priv = (process.env.VAPID_PRIVATE_KEY || '').trim();
  ready = false;
  if (!pub || !priv) {
    console.log('[notifiche web] spente: mancano VAPID_PUBLIC_KEY e VAPID_PRIVATE_KEY');
    return;
  }
  try {
    webpush.setVapidDetails(subject, pub, priv);
    ready = true;
    console.log('[notifiche web] attive');
  } catch (err) {
    console.error(`[notifiche web] chiavi non valide: ${err.message}`);
  }
}
const enabled = () => ready;
const publicKey = () => (ready ? process.env.VAPID_PUBLIC_KEY.trim() : null);

// Iscrizione mandata dal telefono: solo indirizzo https e le due chiavi del browser, di lunghezza ragionevole
function clean(sub) {
  if (!sub || typeof sub.endpoint !== 'string' || !/^https:\/\/[^\s]+$/.test(sub.endpoint) || sub.endpoint.length > 1000) return null;
  const k = sub.keys || {};
  if (typeof k.p256dh !== 'string' || typeof k.auth !== 'string' || k.p256dh.length > 200 || k.auth.length > 100) return null;
  return { endpoint: sub.endpoint, keys: { p256dh: k.p256dh, auth: k.auth } };
}

// Elenco dei dispositivi con quello nuovo (lo stesso indirizzo non si ripete; oltre il massimo esce il più vecchio)
const addTo = (list = [], sub) => [...list.filter((s) => s.endpoint !== sub.endpoint), { ...sub, at: new Date().toISOString() }].slice(-MAX_DEVICES);

let sender = (sub, payload, options) => webpush.sendNotification(sub, payload, options);

// Manda il messaggio a tutti i dispositivi del cliente. gone = indirizzi scaduti (telefono cambiato, notifiche
// disattivate), da togliere dalla scheda.
async function send(subs = [], message) {
  const payload = JSON.stringify(message);
  let sent = 0;
  const gone = [];
  for (const s of subs) {
    try {
      await sender({ endpoint: s.endpoint, keys: s.keys }, payload, { TTL: 3 * 24 * 3600 });
      sent++;
    } catch (err) {
      if (err.statusCode === 404 || err.statusCode === 410) gone.push(s.endpoint);
      else console.error(`[notifiche web] invio non riuscito: ${err.statusCode || ''} ${err.message}`);
    }
  }
  return { sent, gone };
}

module.exports = { init, enabled, publicKey, clean, addTo, send, setSender: (fn) => { sender = fn; } };
