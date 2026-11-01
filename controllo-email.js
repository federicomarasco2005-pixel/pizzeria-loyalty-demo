// Controllo dell'email all'iscrizione e quando il cliente la cambia dalla tessera. F5M non manda email: l'email
// serve a ritrovare la tessera (codice + email) su un telefono nuovo, quindi un errore di battitura la rende
// irrecuperabile. Qui il server controlla che il dominio dopo la @ possa ricevere posta (record MX, o almeno un
// indirizzo). Gli errori di battitura dei domini più comuni ("gmial.com") li suggerisce già la pagina (emailHint
// in public/common.js), prima dell'invio.
const dns = require('dns').promises;

const TIMEOUT_MS = 3000;
const cache = new Map(); // dominio -> true / false (solo risposte certe)

// true = il dominio riceve posta, false = non esiste o non ha posta, null = non si sa (DNS lento o irraggiungibile)
async function realLookup(domain) {
  const missing = (err) => err && (err.code === 'ENOTFOUND' || err.code === 'ENODATA');
  try {
    const mx = await dns.resolveMx(domain);
    return mx.some((r) => r.exchange); // "null MX" (exchange vuoto): il dominio dice di non ricevere posta
  } catch (err) {
    if (!missing(err)) return null;
  }
  // senza MX la posta va all'indirizzo del dominio stesso
  try { return (await dns.resolve4(domain)).length > 0; } catch (err) { return missing(err) ? false : null; }
}

// Nei test (node --test) niente DNS vero: le email di prova (@x.it) passano sempre, salvo setLookup.
let lookup = process.env.NODE_TEST_CONTEXT ? async () => true : realLookup;

async function domainOk(domain) {
  if (cache.has(domain)) return cache.get(domain);
  const r = await Promise.race([lookup(domain).catch(() => null), new Promise((ok) => setTimeout(ok, TIMEOUT_MS, null))]);
  if (r !== null) {
    if (cache.size > 2000) cache.clear();
    cache.set(domain, r);
  }
  return r;
}

// Messaggio d'errore per un'email (già nel formato giusto) il cui dominio non riceve posta; null se va bene o
// se il DNS non risponde: in quel caso meglio lasciar passare che bloccare un'iscrizione buona.
async function problem(email) {
  const domain = String(email).split('@').pop();
  if (await domainOk(domain) === false) return `L'indirizzo "${domain}" non esiste: controlla la parte dopo la @.`;
  return null;
}

module.exports = { problem, setLookup: (fn) => { lookup = fn; cache.clear(); } };
