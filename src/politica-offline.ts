/** Protocolo v2 con public/sw.js. Las pruebas contrastan ambos validadores reales. */
export function nombresCache(ambito: string) {
  const base = new URL(ambito);
  if (base.search || base.hash || !base.pathname.endsWith('/')) throw new Error('Ámbito offline inválido');
  const sufijo = encodeURIComponent(base.href);
  return { app: `itinerario-app-v2:${sufijo}`, lista: `itinerario-lista-v2:${sufijo}`, mapa: `itinerario-mapa-v2:${sufijo}` };
}

/** No se normalizan consultas, fragmentos ni rutas desconocidas hacia el inicio. */
export function tipoNucleo(direccion: string, ambito: string): string | null {
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

export function mimeNucleo(tipo: string, mime: string): boolean {
  const valor = mime.split(';')[0].trim().toLowerCase();
  const permitidos: Record<string, string[]> = {
    html: ['text/html'], js: ['text/javascript', 'application/javascript'], css: ['text/css'],
    manifest: ['application/manifest+json', 'application/json'], svg: ['image/svg+xml'],
    png: ['image/png'], woff2: ['font/woff2', 'application/font-woff2'],
  };
  return permitidos[tipo]?.includes(valor) ?? false;
}

export function esHtmlApp(texto: string, ambito: string): boolean {
  if (!/<title>\s*Itinerario\s*<\/title>/i.test(texto) || /<base\b/i.test(texto)) return false;
  if (!/\bid=["']mapa["']/i.test(texto) || !/\bid=["']panel["']/i.test(texto)) return false;
  if (/\btype=["']password["']/i.test(texto)) return false;
  return [...texto.matchAll(/<script\b([^>]+)>/gi)].some(([, atributos]) => {
    const src = atributos.match(/\bsrc=["']([^"']+)["']/i)?.[1];
    return /\btype=["']module["']/i.test(atributos) && !!src && tipoNucleo(new URL(src, ambito).href, ambito) === 'js';
  });
}

/** Cache-Control no-store no equivale a prohibir una copia privada preparada a mano. */
export async function respuestaNucleo(resp: Response, url: string, ambito: string): Promise<boolean> {
  const tipo = tipoNucleo(url, ambito);
  if (!tipo || resp.status !== 200 || resp.redirected || resp.url !== url || resp.type === 'opaque') return false;
  if (!mimeNucleo(tipo, resp.headers.get('Content-Type') ?? '')) return false;
  return tipo !== 'html' || esHtmlApp(await resp.clone().text(), ambito);
}

/** Solo recursos públicos del proveedor conocido; nunca fotos ni URLs del origen de la app. */
export function esMapa(direccion: string): boolean {
  const url = new URL(direccion);
  return url.origin === 'https://tiles.openfreemap.org' && !url.username && !url.password && !url.search && !url.hash && (
    url.pathname === '/styles/positron' || /^\/planet\/?$/.test(url.pathname) ||
    /^\/planet\/(?:[^/]+\/)?\d+\/\d+\/\d+\.pbf$/.test(url.pathname) ||
    /^\/fonts\/[^/]+\/\d+-\d+\.pbf$/.test(url.pathname) ||
    /^\/sprites\/[\w/.-]+(?:@2x)?(?:\.json|\.png)$/.test(url.pathname) ||
    /^\/styles\/positron\/sprite(?:@2x)?\.(?:json|png)$/.test(url.pathname)
  );
}
export function claveTesela(url: string): string {
  return url.replace(/\/planet\/[^/]+\/(\d+\/\d+\/\d+\.pbf)$/, '/planet/$1');
}
export function respuestaMapa(resp: Response, direccion: string): boolean {
  if (!esMapa(direccion) || resp.status !== 200 || resp.redirected || !esMapa(resp.url)) return false;
  if (claveTesela(resp.url) !== claveTesela(direccion)) return false;
  const mime = (resp.headers.get('Content-Type') ?? '').split(';')[0].trim().toLowerCase();
  if (direccion.endsWith('.pbf')) return ['application/x-protobuf', 'application/vnd.mapbox-vector-tile', 'application/octet-stream'].includes(mime);
  if (direccion.endsWith('.png')) return mime === 'image/png';
  return mime === 'application/json';
}

/** Lista acotada al documento y sus dependencias compiladas, no al historial de rendimiento. */
export function referenciasNucleo(texto: string, url: string, ambito: string, tipo: string): string[] {
  const referencias: string[] = [];
  if (tipo === 'html') {
    for (const [, etiqueta, atributos] of texto.matchAll(/<(script|link)\b([^>]+)>/gi)) {
      if (etiqueta.toLowerCase() === 'link' && !/\brel=["'](?:stylesheet|modulepreload|manifest|icon|apple-touch-icon)["']/i.test(atributos)) continue;
      const valor = atributos.match(/\b(?:src|href)=["']([^"']+)["']/i)?.[1];
      if (valor) referencias.push(valor);
    }
  } else if (tipo === 'css') {
    for (const [, valor] of texto.matchAll(/url\(\s*["']?([^"')\s]+)["']?\s*\)/gi)) if (!valor.startsWith('data:')) referencias.push(valor);
  } else if (tipo === 'js') {
    // Vite publica el worker de MapLibre como dependencia relativa del paquete principal.
    for (const [, valor] of texto.matchAll(/["'`]((?:\.\/)?(?:assets\/)?[\w.-]+-[\w-]{8,}\.js)["'`]/g)) referencias.push(valor);
  }
  return referencias.map((valor) => {
    const destino = new URL(valor, url).href;
    if (!tipoNucleo(destino, ambito)) throw new Error('Dependencia ajena al núcleo offline');
    return destino;
  });
}

export function listaPreparada(valor: unknown, ambito: string): valor is { version: 2; ambito: string; generacion: string; urls: string[] } {
  if (!valor || typeof valor !== 'object') return false;
  const lista = valor as { version?: unknown; ambito?: unknown; generacion?: unknown; urls?: unknown };
  const prefijo = nombresCache(ambito).app + ':';
  return lista.version === 2 && lista.ambito === ambito && typeof lista.generacion === 'string' &&
    lista.generacion.startsWith(prefijo) && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(lista.generacion.slice(prefijo.length)) && Array.isArray(lista.urls) &&
    lista.urls.includes(ambito) && lista.urls.every((url) => typeof url === 'string' && !!tipoNucleo(url, ambito));
}
