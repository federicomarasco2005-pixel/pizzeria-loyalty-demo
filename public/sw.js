// Service worker: rende la tessera installabile come app e la apre subito.
// La pagina della tessera si mostra dalla copia salvata (anche se il server gratuito sta dormendo,
// ~50 s al risveglio) e intanto si scarica quella nuova; i dati veri arrivano poi dalla pagina stessa
// (api/card e aggiornamenti live). Senza rete resta l'ultima versione vista.
// v4: svuota le copie salvate con la versione vecchia (sotto), che altrimenti resterebbero per sempre.
const CACHE = 'tessera-v4';
const SHELL = ['/style.css', '/common.js'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

const isCardPage = (url) => /\/card\/[^/]+$/.test(url.pathname);
const cacheable = (url) => isCardPage(url) || /\/(logo\.png|stamps\/|icons\/)/.test(url.pathname) || SHELL.includes(url.pathname);
// La tessera si salva sempre senza ?…: una sola copia, quella dell'ultima apertura. Prima la copia arrivata con ?welcome
// (iscrizione) restava la prima trovata e il telefono mostrava per sempre la pagina del giorno dell'iscrizione.
const keyOf = (req, url) => (isCardPage(url) ? url.origin + url.pathname : req);

// Le API e gli aggiornamenti live non passano mai dalla cache.
self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin || url.pathname.includes('/api/')) return;
  const key = keyOf(e.request, url);
  const fresh = fetch(e.request).then((res) => {
    if (res.ok && cacheable(url)) {
      const copy = res.clone();
      caches.open(CACHE).then((c) => c.put(key, copy));
    }
    return res;
  });
  // Arrivo dal timbro NFC, dall'iscrizione o dal buono premio (?from=, ?welcome, ?premio): serve la pagina
  // appena generata, con il saldo vero
  if (isCardPage(url) && !['from', 'welcome', 'premio'].some((p) => url.searchParams.has(p))) {
    // Tessera: subito la copia salvata (se c'è), intanto si aggiorna per la prossima apertura
    e.waitUntil(fresh.catch(() => {}));
    e.respondWith(caches.match(key).then((hit) => hit || fresh));
    return;
  }
  // Tutto il resto: prima la rete (sempre aggiornato), la copia salvata solo se offline
  e.respondWith(fresh.catch(() => caches.match(e.request)));
});

// Notifiche web della tessera (notifiche-web.js sul server): il messaggio arriva cifrato e qui si mostra.
// Toccandola si apre la tessera (quella già aperta, se c'è).
self.addEventListener('push', (e) => {
  let m = {};
  try { m = e.data ? e.data.json() : {}; } catch {}
  e.waitUntil(self.registration.showNotification(m.title || 'La tua tessera', {
    body: m.body || '', icon: m.icon, badge: m.icon, tag: m.tag, data: { url: m.url || '/' },
  }));
});

self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  const url = (e.notification.data && e.notification.data.url) || '/';
  const path = new URL(url, location.origin).pathname;
  e.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((list) => {
    const open = list.find((c) => new URL(c.url).pathname === path);
    return open ? open.focus() : self.clients.openWindow(url);
  }));
});
