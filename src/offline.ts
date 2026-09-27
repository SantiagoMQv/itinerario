import type { Map as Mapa, VectorTileSource } from 'maplibre-gl';
import { type Caja, ampliarCaja, cajaDe, teselasDeCaja } from './geo';
import { ESTILO } from './mapa';
import type { Modelo } from './modelo';

// Deben coincidir con public/sw.js.
const CACHE_APP = 'app-v1';
const CACHE_MAPA = 'mapa-v1';
const CLAVE_DESCARGA = 'mapas-descargados';

/** Clave de caché de una tesela sin la versión del mapa. Igual que en public/sw.js. */
const claveTesela = (url: string) => url.replace(/\/planet\/[^/]+\/(\d+\/\d+\/\d+\.pbf)$/, '/planet/$1');

export async function registrarServiceWorker() {
  if (import.meta.env.DEV || !('serviceWorker' in navigator)) return;
  try {
    await navigator.serviceWorker.register('./sw.js');
    await guardarApp();
  } catch (e) {
    console.warn('No se pudo registrar el service worker', e);
  }
}

/** Guarda en caché lo que ya se ha cargado de la app (en la primera visita el service worker aún no lo ve). */
async function guardarApp() {
  const cache = await caches.open(CACHE_APP);
  const urls = new Set([new URL('./', location.href).href]);
  for (const r of performance.getEntriesByType('resource')) {
    if (r.name.startsWith(location.origin)) urls.add(r.name.split('#')[0]);
  }
  await Promise.all(
    [...urls].map(async (u) => {
      if (!(await cache.match(u))) await cache.add(u).catch(() => {});
    }),
  );
}

export function descargaAnterior(): string | null {
  try {
    return localStorage.getItem(CLAVE_DESCARGA);
  } catch {
    return null;
  }
}

/** Lista de URLs necesarias para ver sin conexión todas las zonas del viaje. */
function urlsNecesarias(mapa: Mapa, modelo: Modelo): string[] {
  const fuente = mapa.getSource('openmaptiles') as VectorTileSource | undefined;
  const plantilla = fuente?.tiles?.[0];
  if (!plantilla) throw new Error('El mapa aún no ha cargado.');
  const estilo = mapa.getStyle();
  const urls = new Set<string>([ESTILO, fuente.url]);

  const tesela = (z: number, x: number, y: number) =>
    plantilla.replace('{z}', String(z)).replace('{x}', String(x)).replace('{y}', String(y));
  const cubrir = (caja: Caja, zMin: number, zMax: number) => {
    for (let z = zMin; z <= zMax; z++) for (const [x, y] of teselasDeCaja(caja, z)) urls.add(tesela(z, x, y));
  };

  // Vista general de toda la región y detalle de cada zona (Shanghái, Nankín…).
  cubrir(ampliarCaja(cajaDe(modelo.paradas.map((p) => p.pos)), 20), 3, 10);
  const porZona = new Map<number, [number, number][]>();
  for (const p of modelo.paradas) porZona.set(p.zona, [...(porZona.get(p.zona) ?? []), p.pos]);
  for (const puntos of porZona.values()) cubrir(ampliarCaja(cajaDe(puntos), 2), 11, fuente.maxzoom);

  // Tipografías (solo alfabeto latino: los caracteres chinos los dibuja el propio móvil) e iconos.
  const fuentes = new Set<string>();
  for (const capa of estilo.layers) {
    const f = capa.type === 'symbol' ? capa.layout?.['text-font'] : undefined;
    if (Array.isArray(f)) fuentes.add(f.join(','));
  }
  if (estilo.glyphs) {
    for (const f of fuentes) {
      for (const rango of ['0-255', '256-511', '8192-8447']) {
        urls.add(estilo.glyphs.replace('{fontstack}', encodeURIComponent(f)).replace('{range}', rango));
      }
    }
  }
  if (typeof estilo.sprite === 'string') {
    for (const sufijo of ['', '@2x']) for (const ext of ['.json', '.png']) urls.add(`${estilo.sprite}${sufijo}${ext}`);
  }
  return [...urls];
}

/** Descarga y guarda los mapas de todas las zonas del viaje. */
export async function descargarMapas(
  mapa: Mapa,
  modelo: Modelo,
  progreso: (hechas: number, total: number) => void,
): Promise<{ fallos: number; total: number }> {
  await navigator.storage?.persist?.().catch(() => false);
  await guardarApp().catch(() => {});
  const urls = urlsNecesarias(mapa, modelo);
  const cache = await caches.open(CACHE_MAPA);
  let hechas = 0;
  let fallos = 0;
  const cola = [...urls];
  const trabajador = async () => {
    for (let url = cola.shift(); url; url = cola.shift()) {
      try {
        const clave = claveTesela(url);
        if (!(await cache.match(clave, { ignoreVary: true }))) {
          const resp = await fetch(url, { mode: 'cors' });
          if (resp.ok) await cache.put(clave, resp);
          else if (resp.status !== 204 && resp.status !== 404) fallos++;
        }
      } catch {
        fallos++;
      }
      progreso(++hechas, urls.length);
    }
  };
  await Promise.all(Array.from({ length: 6 }, trabajador));
  if (fallos === 0) {
    try {
      localStorage.setItem(CLAVE_DESCARGA, new Date().toISOString());
    } catch {
      // Sin almacenamiento local: solo se pierde el aviso de "ya descargado".
    }
  }
  return { fallos, total: urls.length };
}
