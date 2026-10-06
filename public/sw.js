// Service worker minimo: rende la tessera installabile come app e, senza rete,
// mostra l'ultima versione già vista invece di una pagina di errore.
const CACHE = 'tessera-v2';
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

// Prima la rete (dati sempre aggiornati), la copia salvata solo se offline.
// Le API e gli aggiornamenti live non passano mai dalla cache.
self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin || url.pathname.includes('/api/')) return;
  e.respondWith(
    fetch(e.request)
      .then((res) => {
        if (res.ok && (url.pathname.includes('/card/') || /\/(logo\.png|stamps\/|icons\/)/.test(url.pathname) || SHELL.includes(url.pathname))) {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(e.request, copy));
        }
        return res;
      })
      .catch(() => caches.match(e.request)),
  );
});
