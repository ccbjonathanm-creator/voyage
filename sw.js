/* Voyage — service worker : met la coquille de l'app en cache pour un fonctionnement hors-ligne.
   Les appels réseau (Gemini, Open-Meteo, OpenStreetMap) ne sont JAMAIS mis en cache :
   ce sont des données fraîches, elles partent toujours au réseau. */
const CACHE = 'boussole-v6';
const ASSETS = [
  './',
  './index.html',
  './styles.css',
  './app.js',
  './manifest.webmanifest',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/icon-maskable-512.png',
  './icons/favicon-64.png',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(ASSETS)));
});

self.addEventListener('message', (e) => {
  if (e.data && e.data.type === 'SKIP_WAITING') self.skipWaiting();
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  if (e.request.method !== 'GET') return;
  const url = new URL(e.request.url);

  // Toutes les API externes partent au réseau, jamais de cache.
  const externes = ['generativelanguage.googleapis.com', 'api.groq.com', 'open-meteo.com', 'nominatim.openstreetmap.org'];
  if (externes.some((h) => url.hostname.endsWith(h))) return;

  const isCore = e.request.mode === 'navigate'
    || /\.(html|js|css|webmanifest)$/.test(url.pathname);

  if (isCore) {
    // Réseau d'abord en contournant le cache HTTP (no-store) pour que les MAJ arrivent ;
    // le cache SW sert de secours hors-ligne.
    e.respondWith(
      fetch(e.request, { cache: 'no-store' }).then((res) => {
        const copy = res.clone();
        caches.open(CACHE).then((c) => c.put(e.request, copy)).catch(() => {});
        return res;
      }).catch(() => caches.match(e.request).then((hit) => hit || caches.match('./index.html')))
    );
  } else {
    // Cache d'abord pour le reste (icônes) : figé.
    e.respondWith(
      caches.match(e.request).then((hit) => hit || fetch(e.request).then((res) => {
        const copy = res.clone();
        caches.open(CACHE).then((c) => c.put(e.request, copy)).catch(() => {});
        return res;
      }))
    );
  }
});
