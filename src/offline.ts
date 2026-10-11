import type { Map as Mapa, VectorTileSource } from 'maplibre-gl';
import { type Caja, ampliarCaja, cajaDe, teselasDeCaja } from './geo';
import { ESTILO } from './mapa';
import type { Modelo } from './modelo';

import { nombresCache, tipoNucleo, respuestaNucleo, referenciasNucleo, esMapa, respuestaMapa, claveTesela } from './politica-offline';
// El aviso antiguo no acredita que exista un núcleo v2 preparado. No se borra su clave.
const CLAVE_DESCARGA = 'mapas-descargados-v2:';
const claveDescarga = (ambito = new URL('./', location.href).href) => CLAVE_DESCARGA + ambito;

export async function registrarServiceWorker() {
  if (import.meta.env.DEV || !('serviceWorker' in navigator)) return;
  try {
    await navigator.serviceWorker.register('./sw.js');
  } catch (e) {
    console.warn('No se pudo registrar el service worker', e);
  }
}

/** Preparación manual: valida todo antes de publicar la lista que permite lecturas offline. */
export async function guardarApp(ambito?: string): Promise<void> {
  const registro = await navigator.serviceWorker.getRegistration();
  const base = ambito ?? registro?.scope;
  if (!base || new URL(base).origin !== location.origin) throw new Error('Sin ámbito offline propio');
  const nombres = nombresCache(base);
  const pendientes = new Set([base, ...['manifest.webmanifest', 'icono.svg', 'icono-180.png', 'icono-192.png', 'icono-512.png'].map((ruta) => new URL(ruta, base).href)]);
  const preparadas = new Map<string, { peticion: Request; resp: Response }>();
  for (const url of pendientes) {
    // Bypass del caché HTTP y de cualquier copia offline: la preparación necesita red real.
    const peticion = new Request(url, { method: 'GET', credentials: 'same-origin', cache: 'no-store' });
    const resp = await fetch(peticion);
    if (!(await respuestaNucleo(resp, url, base))) throw new Error('No se pudo preparar el núcleo offline');
    preparadas.set(url, { peticion, resp });
    const tipo = tipoNucleo(url, base)!;
    if (['html', 'css', 'js'].includes(tipo)) {
      for (const dependencia of referenciasNucleo(await resp.clone().text(), url, base, tipo)) pendientes.add(dependencia);
    }
  }
  // Cada operación posee sus bytes: nunca sobrescribe una generación publicada.
  const generacion = nombres.app + ':' + crypto.randomUUID();
  const cache = await caches.open(generacion);
  for (const { peticion, resp } of preparadas.values()) await cache.put(peticion, resp.clone());
  const lista = await caches.open(nombres.lista);
  await lista.put(base, new Response(JSON.stringify({ version: 2, ambito: base, generacion, urls: [...preparadas.keys()] }), { headers: { 'Content-Type': 'application/json' } }));
  // Una sola escritura publica puntero y URLs juntos. No se limpia ni ante rechazo:
  // podría haberse publicado antes de perder el acuse; conservar huérfanos es seguro.
  // app-v1 queda aislada: nunca se lee ni se borra, porque puede contener otro montaje.
}

export function descargaAnterior(): string | null {
  try {
    return localStorage.getItem(claveDescarga());
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
  // No anunciar una descarga completa si el núcleo quedó sin preparar.
  let falloApp = 0;
  try { await guardarApp(); } catch { falloApp = 1; }
  const urls = urlsNecesarias(mapa, modelo);
  const registro = await navigator.serviceWorker.getRegistration();
  if (!registro) throw new Error('Sin ámbito offline propio');
  const cache = await caches.open(nombresCache(registro.scope).mapa);
  const heredada = await caches.open('mapa-v1');
  let hechas = 0;
  let fallos = falloApp;
  const cola = [...urls];
  const trabajador = async () => {
    for (let url = cola.shift(); url; url = cola.shift()) {
      try {
        if (!esMapa(url)) throw new Error('Recurso de mapa no permitido');
        const clave = claveTesela(url);
        const previa = await cache.match(clave) ?? await heredada.match(clave);
        if (!previa || !respuestaMapa(previa, url)) {
          const resp = await fetch(url, { mode: 'cors', credentials: 'omit', cache: 'no-store' });
          if (respuestaMapa(resp, url)) await cache.put(clave, resp);
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
      localStorage.setItem(claveDescarga(registro.scope), new Date().toISOString());
    } catch {
      // Sin almacenamiento local: solo se pierde el aviso de "ya descargado".
    }
  }
  return { fallos, total: urls.length };
}
