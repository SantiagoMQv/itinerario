// Service worker: guarda la app y los mapas para poder usarla sin conexión en China.
// Los nombres de caché deben coincidir con los de src/offline.ts.
const CACHE_APP = 'app-v1';
const CACHE_MAPA = 'mapa-v1';
const HOST_MAPA = 'tiles.openfreemap.org';

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches
      .open(CACHE_APP)
      .then((c) => c.addAll(['./', 'manifest.webmanifest', 'icono.svg']))
      .catch(() => {}),
  );
  self.skipWaiting();
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    (async () => {
      for (const k of await caches.keys()) if (k !== CACHE_APP && k !== CACHE_MAPA) await caches.delete(k);
      await self.clients.claim();
    })(),
  );
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (req.mode === 'navigate') {
    e.respondWith(redPrimero(req, CACHE_APP, new URL('./', self.registration.scope).href));
  } else if (url.origin === self.location.origin) {
    e.respondWith(cachePrimero(req, CACHE_APP));
  } else if (url.hostname === HOST_MAPA) {
    // El estilo y el índice de teselas cambian con cada versión del mapa: mejor pedirlos a la red.
    // Teselas, fuentes e iconos no cambian para una misma URL.
    const indice = url.pathname.startsWith('/styles/') || /^\/[a-z_]+\/?$/.test(url.pathname);
    e.respondWith(indice ? redPrimero(req, CACHE_MAPA) : cachePrimero(req, CACHE_MAPA, claveTesela(req.url)));
  }
});

/**
 * Las URLs de las teselas llevan la versión semanal del mapa. Se guardan sin ella para que
 * las descargadas antes del viaje sigan sirviendo aunque luego salga una versión nueva.
 * Igual que en src/offline.ts.
 */
function claveTesela(url) {
  return url.replace(/\/planet\/[^/]+\/(\d+\/\d+\/\d+\.pbf)$/, '/planet/$1');
}

async function cachePrimero(req, nombre, clave = req) {
  const cache = await caches.open(nombre);
  const guardada = await cache.match(clave, { ignoreVary: true });
  if (guardada) return guardada;
  const resp = await fetch(req);
  if (resp.ok) cache.put(clave, resp.clone()).catch(() => {});
  return resp;
}

/** Red primero, pero si tarda más de 4 s o falla se usa la copia guardada. */
async function redPrimero(req, nombre, clave = req) {
  const cache = await caches.open(nombre);
  const red = fetch(req).then((resp) => {
    if (resp.ok) cache.put(clave, resp.clone()).catch(() => {});
    return resp;
  });
  const espera = new Promise((ok) => setTimeout(ok, 4000));
  try {
    const resp = await Promise.race([red, espera]);
    if (resp) return resp;
  } catch {
    // Sin conexión: se usa la caché.
  }
  const guardada = await cache.match(clave, { ignoreVary: true, ignoreSearch: true });
  return guardada ?? red;
}
