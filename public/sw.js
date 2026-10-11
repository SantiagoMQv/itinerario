// Protocolo v2 con src/politica-offline.ts: validadores contrastados en pruebas/offline.test.ts.
// Instalar/activar no prepara datos privados ni elimina cachés de otras apps o montajes.
const AMBITO = self.registration.scope;
const NOMBRES = nombresCache(AMBITO);
self.addEventListener('install', (e) => { e.waitUntil(self.skipWaiting()); });
self.addEventListener('activate', (e) => { e.waitUntil(self.clients.claim()); });
self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  if (tipoNucleo(req.url, AMBITO)) e.respondWith(nucleoRedPrimero(req));
  else if (esMapa(req.url)) e.respondWith(mapaRedPrimero(req));
});

async function nucleoRedPrimero(req) {
  try {
    // Se conserva el Request original (credenciales, método y señal), sin timeout de 4 s.
    // no-store solo evita caché HTTP; la copia CacheStorage requiere preparación explícita.
    return await fetch(req, { cache: 'no-store' });
  } catch (error) {
    if (req.signal.aborted || req.cache === 'no-store') throw error;
    const listaCache = await caches.open(NOMBRES.lista);
    const documento = await listaCache.match(AMBITO);
    if (!documento) throw error;
    let lista;
    try { lista = await documento.json(); } catch { throw error; }
    if (!listaPreparada(lista, AMBITO) || !lista.urls.includes(req.url)) throw error;
    // Pertenencia y bytes provienen del mismo descriptor publicado leído una vez.
    const cache = await caches.open(lista.generacion);
    const guardada = await cache.match(req);
    if (guardada && await respuestaNucleo(guardada, req.url, AMBITO)) return guardada;
    throw error;
  }
}

async function mapaRedPrimero(req) {
  try { return await fetch(req); } catch (error) {
    if (req.signal.aborted) throw error;
    const clave = claveTesela(req.url);
    // Migración perezosa de la única caché heredada publicada, sin duplicar descargas.
    for (const nombre of [NOMBRES.mapa, 'mapa-v1']) {
      const cache = await caches.open(nombre);
      const resp = await cache.match(clave);
      if (resp && respuestaMapa(resp, req.url)) return resp;
    }
    throw error;
  }
}

function nombresCache(ambito) {
  const base = new URL(ambito);
  if (base.search || base.hash || !base.pathname.endsWith('/')) throw new Error('Ámbito offline inválido');
  const sufijo = encodeURIComponent(base.href);
  return { app: `itinerario-app-v2:${sufijo}`, lista: `itinerario-lista-v2:${sufijo}`, mapa: `itinerario-mapa-v2:${sufijo}` };
}
function tipoNucleo(direccion, ambito) {
  const url = new URL(direccion, ambito);
  const base = new URL(ambito);
  if (url.origin !== base.origin || url.search || url.hash || url.username || url.password) return null;
  if (/(?:^|\/)(?:api|entrar|auth|auth-error|fotos|photos)(?:\/|$)/i.test(decodeURIComponent(url.pathname))) return null;
  if (!url.pathname.startsWith(base.pathname)) return null;
  const ruta = url.pathname.slice(base.pathname.length);
  if (ruta === '') return 'html';
  if (ruta === 'manifest.webmanifest') return 'manifest';
  if (ruta === 'icono.svg') return 'svg';
  if (/^icono-(180|192|512)\.png$/.test(ruta)) return 'png';
  if (/^assets\/[\w.-]+-[\w-]{8,}\.js$/.test(ruta)) return 'js';
  if (/^assets\/[\w.-]+-[\w-]{8,}\.css$/.test(ruta)) return 'css';
  if (/^assets\/archivo-[\w.-]+-[\w-]{8,}\.woff2$/.test(ruta)) return 'woff2';
  if (/^assets\/kraft-[\w-]{8,}\.png$/.test(ruta)) return 'png';
  return null;
}
function mimeNucleo(tipo, mime) {
  const valor = mime.split(';')[0].trim().toLowerCase();
  const permitidos = {
    html: ['text/html'], js: ['text/javascript', 'application/javascript'], css: ['text/css'],
    manifest: ['application/manifest+json', 'application/json'], svg: ['image/svg+xml'],
    png: ['image/png'], woff2: ['font/woff2', 'application/font-woff2'],
  };
  return permitidos[tipo]?.includes(valor) ?? false;
}
function esHtmlApp(texto, ambito) {
  if (!/<title>\s*Itinerario\s*<\/title>/i.test(texto) || /<base\b/i.test(texto)) return false;
  if (!/\bid=["']mapa["']/i.test(texto) || !/\bid=["']panel["']/i.test(texto)) return false;
  if (/\btype=["']password["']/i.test(texto)) return false;
  return [...texto.matchAll(/<script\b([^>]+)>/gi)].some(([, atributos]) => {
    const src = atributos.match(/\bsrc=["']([^"']+)["']/i)?.[1];
    return /\btype=["']module["']/i.test(atributos) && !!src && tipoNucleo(new URL(src, ambito).href, ambito) === 'js';
  });
}
async function respuestaNucleo(resp, url, ambito) {
  const tipo = tipoNucleo(url, ambito);
  if (!tipo || resp.status !== 200 || resp.redirected || resp.url !== url || resp.type === 'opaque') return false;
  if (!mimeNucleo(tipo, resp.headers.get('Content-Type') ?? '')) return false;
  return tipo !== 'html' || esHtmlApp(await resp.clone().text(), ambito);
}
function listaPreparada(valor, ambito) {
  if (!valor || typeof valor !== 'object') return false;
  const lista = valor;
  const prefijo = nombresCache(ambito).app + ':';
  return lista.version === 2 && lista.ambito === ambito && typeof lista.generacion === 'string' &&
    lista.generacion.startsWith(prefijo) && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(lista.generacion.slice(prefijo.length)) && Array.isArray(lista.urls) &&
    lista.urls.includes(ambito) && lista.urls.every((url) => typeof url === 'string' && !!tipoNucleo(url, ambito));
}
function esMapa(direccion) {
  const url = new URL(direccion);
  return url.origin === 'https://tiles.openfreemap.org' && !url.username && !url.password && !url.search && !url.hash && (
    url.pathname === '/styles/positron' || /^\/planet\/?$/.test(url.pathname) ||
    /^\/planet\/(?:[^/]+\/)?\d+\/\d+\/\d+\.pbf$/.test(url.pathname) ||
    /^\/fonts\/[^/]+\/\d+-\d+\.pbf$/.test(url.pathname) ||
    /^\/sprites\/[\w/.-]+(?:@2x)?(?:\.json|\.png)$/.test(url.pathname) ||
    /^\/styles\/positron\/sprite(?:@2x)?\.(?:json|png)$/.test(url.pathname)
  );
}
function claveTesela(url) {
  return url.replace(/\/planet\/[^/]+\/(\d+\/\d+\/\d+\.pbf)$/, '/planet/$1');
}
function respuestaMapa(resp, direccion) {
  if (!esMapa(direccion) || resp.status !== 200 || resp.redirected || !esMapa(resp.url)) return false;
  if (claveTesela(resp.url) !== claveTesela(direccion)) return false;
  const mime = (resp.headers.get('Content-Type') ?? '').split(';')[0].trim().toLowerCase();
  if (direccion.endsWith('.pbf')) return ['application/x-protobuf', 'application/vnd.mapbox-vector-tile', 'application/octet-stream'].includes(mime);
  if (direccion.endsWith('.png')) return mime === 'image/png';
  return mime === 'application/json';
}
