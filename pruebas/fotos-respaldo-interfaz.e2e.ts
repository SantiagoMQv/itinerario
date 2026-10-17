// Respaldo manual y catálogo DESDE LA INTERFAZ. Dos partes:
// 1. «nativa con Worker real»: TLS local, fetch por defecto, cookie HMAC, Worker/router y SDK→PGlite (SQL001–007),
//    como en fotos-listado.e2e.ts; R2 y la confianza CF-IP son MODELADOS. La página es EXCLUSIVA del fixture: una
//    entrada virtual de Vite (sin módulo semilla, alias, dependencias ni configuración del proyecto) que monta la
//    interfaz real de fotos con composición explícita del respaldo.
// 2. «publicada»: la web compilada (vite preview, 4173) con respaldo: null → 0 red de fotos, 0 ledger, 0 texto nuevo.
// El padre ejecuta este archivo y posee sus temporales (mkdtemp itinerario-respaldo-ui-tls-*, borrado en afterAll).
// No prueba despliegue, COMMIT remoto, cuota física, SameSite entre sitios ni teléfono real.
import { test, expect, type Browser, type Locator, type Page } from '@playwright/test';
import { createServer, type Server } from 'node:https';
import type { IncomingMessage } from 'node:http';
import { TLSSocket } from 'node:tls';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { deflateSync } from 'node:zlib';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build, type Plugin, type Rollup } from 'vite';
import { PGlite } from '@electric-sql/pglite';
import worker, { type EntornoWorker } from '../servidor/worker';
import type { VinculoR2Fotos } from '../servidor/objetos-r2';
import { itinerario } from '../src/datos/itinerario';
import { crearProgreso } from '../src/progreso';
import { serializarProgreso } from '../src/progreso-json';
import { serializarSolicitudRespaldo, type SolicitudRespaldo } from '../src/fotos-protocolo';
import { COPIA_RESPALDADA, COPIA_SIN_CONFIRMAR, pesoLegible } from '../src/fotos-respaldo-interfaz';
import { deserializarDestinoListadoFotos } from '../src/fotos-listado-protocolo';
import type { DestinoFoto } from '../src/fotos';

// Imagen PNG 1×1 del fixture: no contenido de un usuario ni clave real. Su IDAT lleva un CRC que no cuadra, así que
// el decodificador del navegador NO la acepta: vale para el respaldo (solo viajan sus bytes), no para verla.
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jSc0AAAAASUVORK5CYII=', 'base64');
/** PNG sintético VÁLIDO (CRC e IDAT correctos), RGBA de dos colores, para las vistas temporales: no es una foto. */
function pngValido(ancho: number, alto: number): Buffer {
  const crc = (b: Buffer) => {
    let c = 0xffffffff;
    for (const x of b) { c ^= x; for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1)); }
    return (c ^ 0xffffffff) >>> 0;
  };
  const trozo = (tipo: string, datos: Buffer) => {
    const t = Buffer.from(tipo, 'latin1'); const largo = Buffer.alloc(4); const suma = Buffer.alloc(4);
    largo.writeUInt32BE(datos.length); suma.writeUInt32BE(crc(Buffer.concat([t, datos])));
    return Buffer.concat([largo, t, datos, suma]);
  };
  const cabecera = Buffer.alloc(13);
  cabecera.writeUInt32BE(ancho, 0); cabecera.writeUInt32BE(alto, 4); cabecera[8] = 8; cabecera[9] = 6;
  const fila = ancho * 4 + 1;
  const crudo = Buffer.alloc(fila * alto);
  for (let y = 0; y < alto; y++) {
    for (let x = 0; x < ancho; x++) {
      const o = y * fila + 1 + x * 4;
      crudo.set(x < ancho / 2 ? [0x24, 0x53, 0xd1, 0xff] : [0xdd, 0xf9, 0x4a, 0xff], o);
    }
  }
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), trozo('IHDR', cabecera),
    trozo('IDAT', deflateSync(crudo)), trozo('IEND', Buffer.alloc(0))]);
}
const pngVista = pngValido(48, 32);
const BASE_LEDGER = `itinerario-respaldo-fotos:${encodeURIComponent(itinerario.id)}`;
const BASE_FOTOS = `itinerario-fotos:${encodeURIComponent(itinerario.id)}`;
const RESPALDADA = 'Respaldada: el servidor confirmó la copia.';
const FINAL_BORRADO = 'Si la borras, este móvil no podrá volver a guardarla. No se puede deshacer.';
declare global { interface Window { fixtureUi?: { readonly listo: true; readonly cerrarEn: (selector: string) => void;
  readonly repintarTodo: () => void; readonly salirDeTodo: () => void; readonly volverATodo: () => void };
  __escrituras?: string[]; __urlsVivas?: () => number } }

/** Destinos de la página con varios bloques (`?destinos`): una parada con sitios dentro, su primer sitio y otra parada. */
const todasParadas = itinerario.dias.flatMap((d) => d.paradas);
const conSitios = todasParadas.find((p) => (p.subparadas ?? []).length > 0)!;
const D_PARADA: DestinoFoto = { tipo: 'parada', viajeId: itinerario.id, paradaId: conSitios.id };
const D_SUB: DestinoFoto = { tipo: 'subparada', viajeId: itinerario.id, paradaId: conSitios.id, subparadaId: conSitios.subparadas![0].id };
const D_OTRA: DestinoFoto = { tipo: 'parada', viajeId: itinerario.id, paradaId: todasParadas.find((p) => p !== conSitios)!.id };
const claveDe = (d: DestinoFoto) => (d.tipo === 'parada' ? `p:${d.paradaId}` : `s:${d.paradaId}:${d.subparadaId}`);
const nombreDe = (d: DestinoFoto) => {
  const p = todasParadas.find((x) => x.id === d.paradaId)!;
  return d.tipo === 'parada' ? p.nombre : p.subparadas!.find((s) => s.id === d.subparadaId)!.nombre;
};
const bloqueDe = (page: Page, d: DestinoFoto) => page.locator(`[data-fotos-destino="${claveDe(d)}"]`);
/** Destinos pedidos al listado filtrado, en orden, decodificados con el codec real (no una comparación de texto). */
const consultados = (llamadas: readonly string[]) => llamadas.filter((l) => l.startsWith('GET /api/fotos/listado?destino='))
  .map((l) => deserializarDestinoListadoFotos(itinerario, new URL(l.slice(4), 'https://x').searchParams.get('destino')));
const originales = (llamadas: readonly string[]) => llamadas.filter((l) => l.endsWith('/original'));

/** Instrumentación de ESTE navegador antes de cargar la página: escrituras en IndexedDB, Cache Storage y storage
 * (la apertura y el esquema de una base no son escrituras: no pasan por estos métodos) y URLs blob vivas. */
async function instrumentar(page: Page) {
  await page.addInitScript(() => {
    const escrituras: string[] = [];
    window.__escrituras = escrituras;
    const envolver = (prototipo: object, metodos: readonly string[], nombre: (yo: never, metodo: string) => string) => {
      for (const metodo of metodos) {
        const p = prototipo as Record<string, (...a: unknown[]) => unknown>;
        const original = p[metodo];
        if (typeof original !== 'function') continue;
        p[metodo] = function (this: never, ...a: unknown[]) { escrituras.push(nombre(this, metodo)); return original.apply(this, a); };
      }
    };
    envolver(IDBObjectStore.prototype, ['put', 'add', 'delete', 'clear'],
      (s: IDBObjectStore, m) => `idb:${s.transaction.db.name}/${s.name}:${m}`);
    envolver(IDBCursor.prototype, ['update', 'delete'], (_c, m) => `idb:cursor:${m}`);
    if (typeof Cache !== 'undefined') envolver(Cache.prototype, ['put', 'add', 'addAll'], (_c, m) => `cache:${m}`);
    if (typeof CacheStorage !== 'undefined') envolver(CacheStorage.prototype, ['open'], (_c, m) => `caches:${m}`);
    envolver(Storage.prototype, ['setItem', 'removeItem', 'clear'], (_s, m) => `storage:${m}`);
    const vivas = new Set<string>();
    const crear = URL.createObjectURL.bind(URL); const revocar = URL.revokeObjectURL.bind(URL);
    URL.createObjectURL = (o: Blob | MediaSource) => { const u = crear(o); vivas.add(u); return u; };
    URL.revokeObjectURL = (u: string) => { vivas.delete(u); revocar(u); };
    window.__urlsVivas = () => vivas.size;
  });
}
const escrituras = (page: Page) => page.evaluate(() => [...(window.__escrituras ?? [])]);
const urlsVivas = (page: Page) => page.evaluate(() => window.__urlsVivas?.() ?? -1);
/** Dónde aparece cada aguja en lo guardado en ESTE navegador: todas las bases IndexedDB (claves y valores), los dos
 * storage y Cache Storage. Lectura tras medir escrituras: no abre cachés si no las hay. */
const rastro = (page: Page, agujas: readonly string[]) => page.evaluate(async (agujas) => {
  const hallazgos: string[] = [];
  const mirar = (donde: string, texto: string) => { for (const a of agujas) if (texto.includes(a)) hallazgos.push(`${donde}:${a}`); };
  const pedir = <T>(q: IDBRequest<T>) => new Promise<T>((ok, ko) => { q.onsuccess = () => ok(q.result); q.onerror = () => ko(q.error); });
  for (const { name } of await indexedDB.databases()) {
    if (!name) continue;
    const db = await pedir(indexedDB.open(name));
    for (const almacen of [...db.objectStoreNames]) {
      const s = db.transaction(almacen).objectStore(almacen);
      const [valores, claves] = await Promise.all([pedir(s.getAll()), pedir(s.getAllKeys())]);
      mirar(`idb:${name}/${almacen}`, JSON.stringify([valores, claves], (_k, v: unknown) => (v instanceof Blob ? `blob:${v.size}` : v)));
    }
    db.close();
  }
  for (const [nombre, s] of [['local', localStorage], ['sesion', sessionStorage]] as const) {
    for (let i = 0; i < s.length; i++) { const k = s.key(i) ?? ''; mirar(`storage:${nombre}`, `${k}=${s.getItem(k)}`); }
  }
  if (typeof caches !== 'undefined') {
    for (const n of await caches.keys()) for (const r of await (await caches.open(n)).keys()) mirar(`cache:${n}`, r.url);
  }
  return hallazgos;
}, agujas);

/** Entradas del ledger tal como quedaron en IndexedDB del navegador (lectura directa; sin crear la base). */
const ledgerNavegador = (page: Page) => page.evaluate((nombre) => new Promise<{ fotoId: string; operacionId: string;
  fase: string; enviada: boolean; pausada: boolean; recibo: unknown }[]>((ok, ko) => {
  void indexedDB.databases().then((bases) => {
    if (!bases.some((b) => b.name === nombre)) { ok([]); return; }
    const r = indexedDB.open(nombre);
    r.onerror = () => ko(r.error);
    r.onsuccess = () => {
      const db = r.result; const tx = db.transaction('respaldos'); const todo = tx.objectStore('respaldos').getAll();
      tx.oncomplete = () => { db.close(); ok(todo.result); };
      tx.onabort = () => { db.close(); ko(tx.error); };
    };
  }, ko);
}), BASE_LEDGER);
/** Metadata y original de una foto en la PhotoDB ya existente del navegador (lectura directa con la forma de
 * FotosLocal: almacenes «metadatos» y «originales» por fotoId; sin crear la base ni escribir nada). */
const fotoNavegador = (page: Page, fotoId: string) => page.evaluate(({ nombre, fotoId }) =>
  new Promise<{ metadatos: unknown; original: number[] | null } | null>((ok, ko) => {
    void indexedDB.databases().then((bases) => {
      if (!bases.some((b) => b.name === nombre)) { ok(null); return; }
      const r = indexedDB.open(nombre);
      r.onerror = () => ko(r.error);
      r.onsuccess = () => {
        const db = r.result; const tx = db.transaction(['metadatos', 'originales']);
        const metadatos = tx.objectStore('metadatos').get(fotoId); const original = tx.objectStore('originales').get(fotoId);
        tx.oncomplete = () => {
          db.close();
          const blob = original.result as Blob | undefined;
          void (blob ? blob.arrayBuffer().then((b) => Array.from(new Uint8Array(b))) : Promise.resolve(null))
            .then((bytes) => ok({ metadatos: metadatos.result ?? null, original: bytes }), ko);
        };
        tx.onabort = () => { db.close(); ko(tx.error); };
      };
    }, ko);
  }), { nombre: BASE_FOTOS, fotoId });
/** Zona táctil real: .mini se ve de 34 px y se toca con 48 gracias a su ::after (7 px arriba y abajo). */
async function comprobarObjetivos(zona: Locator) {
  const medidas = await zona.locator('button:visible, a:visible').evaluateAll((elementos) => elementos.map((e) => {
    const caja = e.getBoundingClientRect(); const extra = getComputedStyle(e, '::after');
    const crece = extra.content !== 'none' && extra.position === 'absolute' ? -2 * (parseFloat(extra.top) || 0) : 0;
    return { texto: e.textContent?.trim() ?? '', alto: caja.height + Math.max(0, crece) };
  }));
  expect(medidas.length).toBeGreaterThan(0);
  for (const m of medidas) expect(m.alto, m.texto).toBeGreaterThanOrEqual(44);
}

test.describe('nativa con Worker real', () => {
  test.use({ ignoreHTTPSErrors: true });
  let servidor: Server;
  let origen: string;
  let temporal: string;
  let db: PGlite;
  let entorno: EntornoWorker;
  let fetchAnterior: typeof fetch;
  let paginaFixture = '';
  let llamadas: string[] = [];
  let visitasDestino = 0;
  /** Corte de red DESPUÉS de que la consulta se aplicó: se pierde solo la respuesta (una vez). */
  let perdida: 'reserva' | 'final' | null = null;
  let modoListado: 'normal' | 'redirect' | 'invalido' = 'normal';
  const clave = 'clave-sintetica-local-respaldo-ui-12345';
  const dsn = 'postgresql://viajero:fixture@ep-respaldo-ui-test.eu-central-1.aws.neon.tech/viaje?sslmode=require';
  const fotoUno = 'abcdef12-1234-4123-8123-123456789abd';
  const fotoDos = 'bbcdef12-1234-4123-8123-123456789abd';
  /** Fotos respaldadas «desde el otro móvil»; por defecto, con el mismo destino que el bloque del fixture. */
  function remota(fotoId: string, nombre: string, destino: DestinoFoto = { tipo: 'parada', viajeId: itinerario.id,
    paradaId: itinerario.dias[0].paradas[0].id }, mimeDeclarado = 'image/png', bytes: Buffer = png): SolicitudRespaldo {
    return { version: 1, tipo: 'solicitud-respaldo', viajeId: itinerario.id, fotoId, operacionId: fotoId.slice(0, -1) + 'c',
      original: { formato: 1, fotoId, destino, nombre, mimeDeclarado, incorporada: 1_000, ultimaModificacion: 5,
        bytesOriginal: bytes.length } };
  }
  class BucketFixture implements VinculoR2Fotos {
    readonly objetos = new Map<string, Blob>();
    readonly eventos: string[] = [];
    /** Rechaza el siguiente PUT (una vez), como un fallo del proveedor. */
    rechazarPut = false;
    async put(key: string, blob: Blob, opciones: Parameters<VinculoR2Fotos['put']>[2]) {
      this.eventos.push('put'); expect(opciones.onlyIf.get('If-None-Match')).toBe('*');
      expect(opciones.httpMetadata).toEqual({ contentType: 'application/octet-stream' });
      if (this.rechazarPut) { this.rechazarPut = false; throw new Error('PUT rechazado por el fixture'); }
      if (this.objetos.has(key)) return null;
      this.objetos.set(key, blob); return { key, size: blob.size };
    }
    async get(key: string) {
      this.eventos.push('get'); const blob = this.objetos.get(key);
      if (!blob) return null;
      return { key, size: blob.size, bodyUsed: false, body: blob.stream() };
    }
  }
  let bucket: BucketFixture;
  const consultas = new Map([
    ['admitir_intento', 2], ['crear_sesion', 7], ['leer_sesion', 2], ['revocar_sesion', 2],
    ['listar_sesiones', 2], ['revocar_otra_sesion', 3], ['consultar_progreso', 3], ['confirmar_progreso', 4],
    ['reservar_foto', 8], ['finalizar_foto', 10], ['consultar_foto', 3], ['listar_fotos_confirmadas', 7],
    ['listar_fotos_confirmadas_destino', 8],
  ].map(([nombre, cantidad]) => {
    const n = Number(cantidad);
    return [`SELECT itinerario.${nombre}(${Array.from({ length: n }, (_, i) => `$${i + 1}`).join(', ')}) AS resultado`, n];
  }));
  function adaptar(req: IncomingMessage): Request {
    if (!(req.socket instanceof TLSSocket) || !req.socket.encrypted) throw new Error('Fixture requiere TLS');
    const headers = new Headers();
    for (let i = 0; i < req.rawHeaders.length; i += 2) headers.append(req.rawHeaders[i], req.rawHeaders[i + 1]);
    // Autoridad de borde MODELADA, nunca se obtiene de la identidad proporcionada por el browser.
    if (req.method === 'POST' && req.url === '/api/sesion') headers.set('CF-Connecting-IP', '203.0.113.9');
    const controlador = new AbortController(); req.once('aborted', () => controlador.abort());
    let iterador: AsyncIterator<Buffer> | undefined;
    const body = req.method === 'GET' || req.method === 'HEAD' ? undefined : new ReadableStream<Uint8Array>({
      async pull(c) {
        iterador ??= req.iterator({ destroyOnReturn: false });
        const r = await iterador.next(); if (r.done) c.close(); else c.enqueue(new Uint8Array(r.value));
      }, async cancel() { await iterador?.return?.(); },
    }, { highWaterMark: 0 });
    return new Request(new URL(req.url!, origen), { method: req.method, headers, body,
      signal: controlador.signal, duplex: 'half' } as RequestInit);
  }

  // Entrada virtual EXCLUSIVA del fixture: compone la interfaz real con respaldo explícito (la web publicada pasa null)
  // y con la misma tipografía que la app (como src/main.ts: Archivo Variable de @fontsource antes de los estilos);
  // sus woff2 salen de la compilación en memoria y los sirve ASSETS con sesión, como el resto de módulos.
  const ENTRADA = 'virtual:respaldo-ui-fixture';
  const fuente = (relativa: string) => JSON.stringify(fileURLToPath(new URL(relativa, import.meta.url)));
  const CODIGO_ENTRADA = `
import '@fontsource-variable/archivo/wdth.css';
import ${fuente('../src/estilos.css')};
import { itinerario } from ${fuente('../src/datos/itinerario.ts')};
import { crearFotosUi } from ${fuente('../src/fotos-interfaz.ts')};
const contenido = document.getElementById('contenido');
const aviso = document.getElementById('aviso-fixture');
const paradas = itinerario.dias.flatMap((d) => d.paradas);
const nombreDe = (d) => {
  const p = paradas.find((x) => x.id === d.paradaId);
  if (!p) return 'esta parada';
  return d.tipo === 'parada' ? p.nombre : (p.subparadas?.find((s) => s.id === d.subparadaId)?.nombre ?? p.nombre);
};
// Página de 524288 B como el perfil operativo del piloto: cabe la página global (404231) y la filtrada (416521).
const ui = crearFotosUi({ plan: itinerario, contenido, nombreDe,
  anunciar: (texto) => { aviso.textContent = texto; },
  respaldo: { origen: location.origin, listado: { maxFilas: 1, maxBytesPagina: 524288, maxBytesChunk: 1048576,
    maxBytesBackingChunk: 1048576, maxLecturas: 4096, maxBytesPlan: 4194304, maxBytesRetenidos: 134217728, plazoMs: 30000 } } });
const destino = { tipo: 'parada', viajeId: itinerario.id, paradaId: paradas[0].id };
// «?destinos»: una parada con sitios dentro, mucho papel debajo, su primer sitio y otra parada.
const conSitios = paradas.find((p) => (p.subparadas ?? []).length > 0);
const varios = new URLSearchParams(location.search).has('destinos');
const bloques = varios ? [ui.html({ tipo: 'parada', viajeId: itinerario.id, paradaId: conSitios.id }),
  '<div class="espacio-fixture" style="height:200vh"></div>',
  ui.html({ tipo: 'subparada', viajeId: itinerario.id, paradaId: conSitios.id, subparadaId: conSitios.subparadas[0].id }),
  ui.html({ tipo: 'parada', viajeId: itinerario.id, paradaId: paradas.find((p) => p !== conSitios).id })] : [ui.html(destino)];
contenido.innerHTML = bloques.join('') + '<section class="seccion fotos-viaje" id="fotos-viaje" data-fotos-viaje></section>';
ui.montarFotosViaje(contenido.querySelector('[data-fotos-viaje]'));
contenido.addEventListener('click', (e) => { ui.manejarClic(e.target); });
addEventListener('keydown', (e) => { if (e.key === 'Escape') ui.cerrarVisor(); });
addEventListener('popstate', () => { ui.cerrarVisor(true); });
ui.preparar();
// El mismo enganche de ciclo de vida que usa main.ts al plegar una ficha o un sitio de dentro.
// Los ciclos de «Todo» de main.ts: repintarlo (pintarResumen: desmontar y montar en el MISMO turno, como al cargar el
// mapa) e ir a otra vista (pintarLista: solo desmontar) y volver.
const nuevaSeccion = () => {
  const nueva = document.createElement('section');
  nueva.className = 'seccion fotos-viaje'; nueva.id = 'fotos-viaje'; nueva.dataset.fotosViaje = '';
  contenido.querySelector('[data-fotos-viaje]').replaceWith(nueva);
  return nueva;
};
window.fixtureUi = { listo: true, cerrarEn: (selector) => ui.cerrarEn(document.querySelector(selector)),
  repintarTodo() { ui.desmontar(); ui.montarFotosViaje(nuevaSeccion()); },
  salirDeTodo() { ui.desmontar(); },
  volverATodo() { ui.montarFotosViaje(nuevaSeccion()); } };
`;
  const entradaVirtual: Plugin = { name: 'entrada-respaldo-ui-fixture',
    resolveId: (id) => (id === ENTRADA ? `\0${ENTRADA}` : null),
    load: (id) => (id === `\0${ENTRADA}` ? CODIGO_ENTRADA : null) };
  const TIPOS: Record<string, string> = { js: 'text/javascript; charset=utf-8', css: 'text/css; charset=utf-8',
    png: 'image/png', svg: 'image/svg+xml', woff2: 'font/woff2', woff: 'font/woff' };

  test.beforeAll(async () => {
    // Timeout propio de preparación del fixture, con la API de hooks de Playwright.
    test.setTimeout(60000);
    db = await PGlite.create('memory://');
    for (const n of ['001_base.sql', '002_progreso.sql', '003_sesiones.sql', '004_limite.sql', '005_fotos.sql', '006_listado_fotos.sql',
      '007_listado_fotos_destino.sql'])
      await db.exec(await readFile(new URL('../servidor/migraciones/' + n, import.meta.url), 'utf8'));
    await db.query('INSERT INTO itinerario.viajes VALUES ($1,0,$2)', [itinerario.id, serializarProgreso(crearProgreso(itinerario))]);
    // Compilación en memoria (write: false): nada se escribe en el repositorio ni en dist/.
    const resultado = await build({ configFile: false, logLevel: 'silent', plugins: [entradaVirtual],
      // Como vite.config.ts, sin leerlo: misma definición y formato de workers.
      define: { __PLAN__: JSON.stringify('fixture-respaldo-ui') }, worker: { format: 'es' },
      build: { write: false, minify: false, target: 'es2022', rollupOptions: { preserveEntrySignatures: 'strict',
        input: { ui: ENTRADA }, output: { entryFileNames: '[name].js', chunkFileNames: 'fragmento-[hash].js',
          assetFileNames: '[name][extname]' } } } });
    const salida = (Array.isArray(resultado) ? resultado[0] : resultado) as Rollup.RollupOutput;
    const archivos = new Map(salida.output.map((a) => [a.fileName, {
      cuerpo: a.type === 'chunk' ? a.code : typeof a.source === 'string' ? a.source : new Uint8Array(a.source),
      tipo: TIPOS[a.fileName.split('.').pop() ?? ''] ?? 'application/octet-stream' }]));
    const css = salida.output.find((a) => a.type === 'asset' && a.fileName.endsWith('.css'))?.fileName;
    if (!css || !archivos.has('ui.js')) throw new Error('La entrada del fixture no produjo ui.js y su CSS');
    paginaFixture = `<!doctype html><html lang="es" data-tema="claro"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1"><title>Fixture del respaldo de fotos</title>
<link rel="stylesheet" href="/${css}"><style>#contenido{height:100dvh}</style></head>
<body><main id="contenido" class="papel"></main><p id="aviso-fixture" role="status"></p>
<script type="module" src="/ui.js"></script></body></html>`;
    fetchAnterior = globalThis.fetch;
    // Únicamente tráfico SDK -> SQL local admitido. Nunca llama al fetch anterior/Neon remoto.
    globalThis.fetch = async (entrada, opciones) => {
      expect(String(entrada)).toBe('https://api.eu-central-1.aws.neon.tech/sql');
      expect(opciones?.method).toBe('POST');
      const h = new Headers(opciones?.headers);
      // El SDK 1.2.0 añade su identificación al DSN transmitido; no cambia la conexión de composición.
      const conexionSdk = new URL(dsn);
      conexionSdk.searchParams.set('application_name', 'pkg:npm/%40neondatabase/serverless@1.2.0');
      expect(h.get('Neon-Connection-String')).toBe(conexionSdk.href);
      expect(h.get('Neon-Raw-Text-Output')).toBe('true'); expect(h.get('Neon-Array-Mode')).toBe('true');
      const datos = JSON.parse(String(opciones?.body)) as { query: string; params: (string | null)[] };
      expect(Object.keys(datos).sort()).toEqual(['params', 'query']); expect(consultas.has(datos.query)).toBe(true);
      expect(datos.params).toHaveLength(consultas.get(datos.query)!);
      expect(datos.params.every((p) => p === null || typeof p === 'string')).toBe(true);
      const r = await db.query<{ resultado: string }>(datos.query, datos.params);
      if ((perdida === 'reserva' && datos.query.includes('reservar_foto'))
        || (perdida === 'final' && datos.query.includes('finalizar_foto'))) {
        perdida = null;
        // La consulta ya se aplicó en la transacción local del fixture: se pierde solo su respuesta.
        throw new TypeError('Respuesta SQL perdida por el fixture');
      }
      return new Response(JSON.stringify({ command: 'SELECT', rowCount: r.rows.length,
        fields: [{ name: 'resultado', dataTypeID: 25, tableID: 0, columnID: 0,
          dataTypeSize: -1, dataTypeModifier: -1, format: 'text' }], rows: r.rows.map((fila) => [String(fila.resultado)]) }));
    };
    // Sólo el proceso padre ejecuta generación/lectura/limpieza de estos archivos de fixture.
    temporal = await mkdtemp(join(tmpdir(), 'itinerario-respaldo-ui-tls-'));
    // Un archivo real evita reabrir /dev/stdin, que falla desde Node en Linux.
    await writeFile(join(temporal, 'configuracion-tls.cnf'), '[req]\nprompt=no\ndistinguished_name=dn\nx509_extensions=ext\n[dn]\nCN=127.0.0.1\n[ext]\nsubjectAltName=IP:127.0.0.1\nbasicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature,keyEncipherment\nextendedKeyUsage=serverAuth\n');
    execFileSync('/usr/bin/openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-sha256', '-days', '1',
      '-config', join(temporal, 'configuracion-tls.cnf'), '-keyout', join(temporal, 'clave-fixture.pem'), '-out', join(temporal, 'certificado-fixture.pem')],
    { stdio: ['pipe', 'pipe', 'pipe'] });
    servidor = createServer({ key: await readFile(join(temporal, 'clave-fixture.pem')),
      cert: await readFile(join(temporal, 'certificado-fixture.pem')), highWaterMark: 65536 }, async (req, res) => {
      const ruta = new URL(req.url!, origen).pathname;
      // Páginas públicas EXCLUSIVAS del fixture (la de la interfaz carga sus módulos con sesión, vía el Worker).
      if (ruta === '/entrar') {
        res.setHeader('Content-Type', 'text/html'); res.setHeader('Cache-Control', 'no-store');
        res.end('<!doctype html><title>Fixture del respaldo</title>'); return;
      }
      if (ruta === '/fixture-respaldo') {
        res.setHeader('Content-Type', 'text/html; charset=utf-8'); res.setHeader('Cache-Control', 'no-store');
        res.end(paginaFixture); return;
      }
      if (ruta === '/destino-fixture') { visitasDestino++; res.end('No visitar'); return; }
      try {
        if (ruta.startsWith('/api/')) llamadas.push(`${req.method} ${req.url}`);
        const r = await worker.fetch(adaptar(req), entorno);
        if (ruta === '/api/fotos/listado' && modoListado === 'redirect') {
          await r.body?.cancel(); res.writeHead(303, { Location: '/destino-fixture' }); res.end(); return;
        }
        res.writeHead(r.status, Object.fromEntries(r.headers));
        if (ruta === '/api/fotos/listado' && modoListado === 'invalido') { await r.body?.cancel(); res.end('false'); return; }
        res.end(Buffer.from(await r.arrayBuffer()));
      } catch (e) { res.destroy(e instanceof Error ? e : new Error('Fixture fallido')); }
      finally { req.resume(); }
    });
    await new Promise<void>((ok) => servidor.listen(0, '127.0.0.1', ok));
    const direccion = servidor.address(); if (!direccion || typeof direccion === 'string') throw new Error('Sin puerto propio');
    origen = `https://127.0.0.1:${direccion.port}`;
    entorno = { CLAVE_COMPARTIDA: clave, URL_BASE_DATOS: dsn,
      ASSETS: { async fetch(r) {
        const a = archivos.get(new URL(r.url).pathname.slice(1));
        return a === undefined ? new Response('No encontrado', { status: 404 })
          : new Response(a.cuerpo, { headers: { 'Content-Type': a.tipo } });
      } }, FOTOS_ORIGEN: origen,
      FOTOS_PRESUPUESTO: { maxBytesOriginal: 2000000, maxBytesEntrada: 2200000, maxBytesChunk: 65536,
        maxBytesCabeceras: 1024, maxBytesRetenidos: 8000000, maxBloquesOriginal: 100, bytesBloque: 65536, plazoMs: 10000 },
      FOTOS_LISTADO_PRESUPUESTO: { maxFilas: 1, maxOperacionesPorFoto: 64, maxBytesSql: 5 * 1024 ** 2,
        maxBytesRespuesta: 512 * 1024, maxBytesRetenidos: 64 * 1024 ** 2, plazoMs: 10000 },
    };
  });
  test.afterAll(async () => {
    try {
      if (servidor) {
        const cierre = new Promise<void>((ok, no) => servidor.close((e) => e ? no(e) : ok()));
        servidor.closeAllConnections(); await cierre;
      }
    } finally {
      if (fetchAnterior) globalThis.fetch = fetchAnterior;
      try { await db?.close(); } finally { if (temporal) await rm(temporal, { recursive: true, force: true }); }
    }
  });
  test.beforeEach(async ({ page }) => {
    await db.exec('BEGIN'); bucket = new BucketFixture(); entorno.FOTOS_BUCKET = bucket;
    perdida = null; modoListado = 'normal'; llamadas = []; visitasDestino = 0;
    await page.route('**/*', (r) => new URL(r.request().url()).origin === origen ? r.continue() : r.abort());
    await page.goto(origen + '/entrar');
  });
  test.afterEach(async () => {
    // Aislamiento exclusivamente de esta conexión efímera. Snapshots se comparan ANTES.
    await db.exec('ROLLBACK');
  });

  async function login(page: Page, dispositivoId: string) {
    const resultado = await page.evaluate(async ({ clave, dispositivoId }) => {
      const r = await fetch('/api/sesion', { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ clave, dispositivoId }) }); return r.status;
    }, { clave, dispositivoId });
    expect(resultado).toBe(201);
  }
  /** Fotos confirmadas por el otro móvil (POST autenticado real; por defecto, dos PNG del destino del fixture);
   * después, este móvil entra con su sesión. */
  async function sembrarServidor(page: Page, fotos: readonly { readonly s: SolicitudRespaldo; readonly bytes: Buffer }[] = [
    { s: remota(fotoUno, 'remota-uno.png'), bytes: png }, { s: remota(fotoDos, 'remota-dos.png'), bytes: png }]) {
    await login(page, 'editor-uno');
    for (const { s, bytes } of fotos) {
      const status = await page.evaluate(async ({ texto, datos }) => {
        const form = new FormData(); form.append('solicitud', texto);
        form.append('original', new Blob([new Uint8Array(datos)], { type: 'application/octet-stream' }), 'original');
        return (await fetch('/api/fotos/respaldo', { method: 'POST', body: form })).status;
      }, { texto: serializarSolicitudRespaldo(itinerario, s), datos: [...bytes] });
      expect(status).toBe(201);
    }
    await login(page, 'editor-dos');
    llamadas = []; bucket.eventos.length = 0;
  }
  async function abrirFixture(page: Page, busqueda = '') {
    await page.goto(origen + '/fixture-respaldo' + busqueda);
    await page.waitForFunction(() => window.fixtureUi?.listo === true);
    // La tipografía real, no una de reserva: al menos una cara «Archivo Variable» declarada por @fontsource y
    // CARGADA, y el texto español disponible con ella (check() solo no basta: sin caras también devuelve true).
    const tipografia = await page.evaluate(async (texto) => {
      await document.fonts.ready;
      await document.fonts.load('16px "Archivo Variable"', texto);
      const caras: FontFace[] = [];
      document.fonts.forEach((cara) => { if (cara.family.replace(/^["']|["']$/g, '') === 'Archivo Variable') caras.push(cara); });
      return { declaradas: caras.length, cargadas: caras.filter((cara) => cara.status === 'loaded').length,
        disponible: document.fonts.check('16px "Archivo Variable"', texto) };
    }, 'Fotos del viaje · ¿Borrar esta foto de este móvil? «Añadir foto»');
    expect(tipografia.cargadas, `Archivo Variable: ${tipografia.cargadas} de ${tipografia.declaradas} caras cargadas`)
      .toBeGreaterThan(0);
    expect(tipografia.disponible).toBe(true);
  }
  const bloque = (page: Page) => page.locator('[data-fotos-destino]');
  /** La ficha del fixture de un solo bloque. Abrir su «Fotos» consulta SOLO sus compartidas: un GET filtrado por
   * destino (decisión 55482, «Directamente en cada parada»); nada más sale solo. */
  const DESTINO_FIXTURE: DestinoFoto = { tipo: 'parada', viajeId: itinerario.id, paradaId: itinerario.dias[0].paradas[0].id };
  /** Todo lo que no es esa consulta: envíos, originales y catálogo global. */
  const sinCompartidas = (l: readonly string[]) => l.filter((x) => !x.startsWith('GET /api/fotos/listado?destino='));
  async function anadirFoto(page: Page) {
    const b = bloque(page);
    const alternar = b.locator('[data-fotos-alternar]');
    if (await alternar.getAttribute('aria-expanded') !== 'true') await alternar.click();
    await expect(b.locator('[data-fotos-anadir]')).toBeVisible();
    const selector = page.waitForEvent('filechooser');
    await b.locator('[data-fotos-anadir]').click();
    await (await selector).setFiles([{ name: 'calle.png', mimeType: 'image/png', buffer: png }]);
    await expect(b.locator('[data-foto-id]')).toHaveCount(1);
    return b;
  }
  async function abrirVisor(page: Page) {
    const b = bloque(page);
    const alternar = b.locator('[data-fotos-alternar]');
    if (await alternar.getAttribute('aria-expanded') !== 'true') await alternar.click();
    await b.locator('[data-foto-id]').first().click();
    const visor = page.locator('#visor-foto');
    await expect(visor).toBeVisible();
    return visor;
  }
  async function snapshotServidor() {
    const tablas = ['viajes', 'sesiones', 'decisiones', 'intentos_sesion', 'fotos_reservas', 'fotos_operaciones'];
    const sql = [];
    for (const t of tablas) sql.push([t, (await db.query(`SELECT * FROM itinerario.${t} ORDER BY 1,2`)).rows]);
    const objetos = [];
    for (const [k, b] of bucket.objetos) objetos.push([k, Buffer.from(await b.arrayBuffer()).toString('base64')]);
    return { sql, objetos };
  }

  test('N1 · «Respaldar» en el visor: un POST manual con 201 y, al recargar, nada sale solo', async ({ page }) => {
    await login(page, 'editor-uno'); llamadas = [];
    await abrirFixture(page);
    const b = await anadirFoto(page);
    await expect(b.locator('.fotos-nota'))
      .toHaveText('Se guardan en este móvil y funcionan sin conexión. Puedes respaldar cada foto en el servidor del viaje desde su visor.');
    const visor = await abrirVisor(page);
    await expect(visor.locator('.visor-respaldo-nota')).toHaveText('Sin respaldo confirmado en este móvil.');
    const respaldar = visor.locator('[data-visor-respaldar]');
    await expect(respaldar).toHaveText(`Respaldar (${png.length} B)`);
    // Abrir el bloque consulta solo las compartidas de su destino; la página y el visor no envían, descargan ni
    // reintentan nada.
    await expect.poll(() => consultados(llamadas)).toEqual([DESTINO_FIXTURE]);
    expect(sinCompartidas(llamadas)).toEqual([]);
    expect(await ledgerNavegador(page)).toEqual([]);

    await respaldar.click();
    await expect(visor.locator('.visor-aviso')).toHaveText(RESPALDADA);
    await expect(visor.locator('.visor-respaldo-nota')).toHaveText(COPIA_RESPALDADA);
    await expect(visor.locator('.visor-respaldo-acciones')).toBeHidden();
    expect(sinCompartidas(llamadas)).toEqual(['POST /api/fotos/respaldo']);
    expect(consultados(llamadas)).toEqual([DESTINO_FIXTURE]);
    // Un solo PUT; el get es INTERNO del mismo POST: el servidor relee el objeto ganador y compara todos sus bytes
    // (hasta EOF) antes de finalizar. No es otra petición HTTP del navegador ni una descarga automática.
    expect(bucket.eventos).toEqual(['put', 'get']);
    expect(await ledgerNavegador(page)).toEqual([expect.objectContaining({ fase: 'respaldada', enviada: true, pausada: false })]);

    llamadas = [];
    await abrirFixture(page);
    // El estado viene del ledger de este móvil: «Todo» lo cuenta sin preguntar al servidor.
    await expect(page.locator('.estado-fotos-viaje')).toHaveText('1 respaldada');
    const otra = await abrirVisor(page);
    await expect(otra.locator('.visor-respaldo-nota')).toHaveText(COPIA_RESPALDADA);
    // Ya respaldada, el servidor la lista como compartida, pero es la misma foto de este móvil: no se repite ni se
    // pide su original (local primero, identidad completa).
    await page.keyboard.press('Escape');
    await expect(bloque(page).locator('.fotos-remotas-estado'))
      .toHaveText(`Las fotos compartidas de «${nombreDe(DESTINO_FIXTURE)}» ya están en este móvil.`);
    await expect(bloque(page).locator('[data-foto-remota]')).toHaveCount(0);
    expect(consultados(llamadas)).toEqual([DESTINO_FIXTURE]);
    expect(sinCompartidas(llamadas)).toEqual([]);
    expect(bucket.eventos).toEqual(['put', 'get']);
  });

  for (const caso of [
    { nombre: 'N2a · respuesta perdida tras reservar: sin confirmar, también al reintentar', fallo: 'reserva', final: 'sin-confirmar' },
    { nombre: 'N2b · el almacén rechaza el original: sin confirmar, también al reintentar', fallo: 'put', final: 'sin-confirmar' },
    { nombre: 'N2c · respuesta perdida tras finalizar: reintentar recibe el acuse sin otro PUT', fallo: 'final', final: 'respaldada' },
  ] as const) {
    test(caso.nombre, async ({ page }) => {
      await login(page, 'editor-uno'); llamadas = [];
      await abrirFixture(page);
      await anadirFoto(page);
      const visor = await abrirVisor(page);
      if (caso.fallo === 'put') bucket.rechazarPut = true; else perdida = caso.fallo;

      await visor.locator('[data-visor-respaldar]').click();
      await expect(visor.locator('.visor-aviso')).toHaveText(COPIA_SIN_CONFIRMAR);
      await expect(visor.locator('.visor-respaldo-nota')).toHaveText(COPIA_SIN_CONFIRMAR);
      const ledgerTrasFallo = await ledgerNavegador(page);
      expect(ledgerTrasFallo).toEqual([expect.objectContaining({ fase: 'enviada', enviada: true, pausada: false, recibo: null })]);
      const [antes] = ledgerTrasFallo;
      // «Todo» lo cuenta como sin confirmar; nada se reintenta solo.
      await expect(page.locator('.estado-fotos-viaje')).toHaveText('1 sin confirmar');
      expect(sinCompartidas(llamadas)).toEqual(['POST /api/fotos/respaldo']);
      const eventosTrasFallo = [...bucket.eventos];

      // Reabrir la app: la incertidumbre y el registro siguen EXACTAMENTE igual y no sale ningún POST solo.
      await abrirFixture(page);
      await expect(page.locator('.estado-fotos-viaje')).toHaveText('1 sin confirmar');
      const reabierto = await abrirVisor(page);
      await expect(reabierto.locator('.visor-respaldo-nota')).toHaveText(COPIA_SIN_CONFIRMAR);
      expect(await ledgerNavegador(page)).toEqual(ledgerTrasFallo);
      expect(sinCompartidas(llamadas)).toEqual(['POST /api/fotos/respaldo']);
      expect(bucket.eventos).toEqual(eventosTrasFallo);

      // Reintento MANUAL desde el visor reabierto: la misma operación.
      const aviso = reabierto.locator('.visor-aviso');
      await reabierto.locator('[data-visor-reanudar]').click();
      await expect(aviso).toHaveText(caso.final === 'respaldada' ? RESPALDADA : COPIA_SIN_CONFIRMAR);
      expect(sinCompartidas(llamadas)).toEqual(['POST /api/fotos/respaldo', 'POST /api/fotos/respaldo']);
      const despues = await ledgerNavegador(page);
      expect(despues).toHaveLength(1);
      expect(despues[0].operacionId).toBe(antes.operacionId);
      if (caso.final === 'respaldada') {
        expect(despues[0]).toMatchObject({ fase: 'respaldada' });
        expect(bucket.eventos.filter((e) => e === 'put')).toHaveLength(1);
        await expect(page.locator('.estado-fotos-viaje')).toHaveText('1 respaldada');
      } else {
        expect(despues[0]).toMatchObject({ fase: 'enviada', recibo: null });
      }
    });
  }

  test('N3 · catálogo: una página por toque, sin leer R2 ni cambiar nada; sin sesión no navega', async ({ page }) => {
    await sembrarServidor(page);
    await abrirFixture(page);
    const seccion = page.locator('#fotos-viaje');
    const estado = seccion.locator('.estado-catalogo');
    await expect(estado).toHaveText('Fotos respaldadas desde cualquiera de los dos móviles. Se consultan de una en una.');
    // Pintar «Todo» no consulta nada.
    expect(llamadas).toEqual([]);
    const antes = await snapshotServidor();

    await seccion.getByRole('button', { name: 'Ver fotos respaldadas' }).click();
    await expect(estado).toHaveText('Fotos respaldadas confirmadas en el servidor.');
    await expect(seccion.locator('.filas-catalogo li')).toHaveCount(1);
    await expect(seccion.locator('.filas-catalogo')).toContainText('«remota-uno.png»');
    await expect(seccion.getByRole('button', { name: `Guardar en este móvil (${png.length} B)` })).toBeVisible();
    expect(llamadas).toEqual(['GET /api/fotos/listado']);

    await seccion.getByRole('button', { name: 'Siguientes' }).click();
    await expect(estado).toHaveText('Siguientes fotos respaldadas confirmadas.');
    await expect(seccion.locator('.filas-catalogo')).toContainText('«remota-dos.png»');
    await expect(seccion.getByRole('button', { name: 'Siguientes' })).toHaveCount(0);
    expect(llamadas).toHaveLength(2);
    expect(llamadas[1]).toMatch(/^GET \/api\/fotos\/listado\?continuacion=/);
    expect(bucket.eventos).toEqual([]);
    expect(await snapshotServidor()).toEqual(antes);
    expect(await ledgerNavegador(page)).toEqual([]);

    // Respuestas que no valen: el redirect no se sigue y un cuerpo inválido no se importa.
    modoListado = 'redirect';
    await seccion.getByRole('button', { name: 'Desde el principio' }).click();
    await expect(estado).toHaveText('El servidor no respondió como se esperaba. No se ha cambiado nada en este móvil.');
    expect(visitasDestino).toBe(0);
    modoListado = 'invalido';
    await seccion.getByRole('button', { name: 'Reintentar' }).click();
    await expect(estado).toHaveText('La respuesta no es válida; no se ha guardado nada.');
    expect(llamadas).toHaveLength(4);

    // Sin sesión: lo dice y ofrece «Entrar» como enlace; no navega sola.
    modoListado = 'normal';
    await page.context().clearCookies();
    const url = page.url();
    await seccion.getByRole('button', { name: 'Reintentar' }).click();
    await expect(estado).toHaveText('Este móvil no tiene sesión en el servidor.');
    await expect(seccion.getByRole('link', { name: 'Entrar' })).toHaveAttribute('href', '/entrar');
    expect(page.url()).toBe(url);
    expect(llamadas).toHaveLength(5);
    expect(bucket.eventos).toEqual([]);
    expect(await ledgerNavegador(page)).toEqual([]);
  });

  test('N4 · guardar en este móvil y comprobar: un GET por toque, sin ledger ni envío', async ({ page }) => {
    await sembrarServidor(page);
    await abrirFixture(page);
    const seccion = page.locator('#fotos-viaje');
    await seccion.getByRole('button', { name: 'Ver fotos respaldadas' }).click();
    await expect(seccion.locator('.estado-catalogo')).toHaveText('Fotos respaldadas confirmadas en el servidor.');
    llamadas = []; bucket.eventos.length = 0;

    await seccion.getByRole('button', { name: `Guardar en este móvil (${png.length} B)` }).click();
    await expect(seccion.locator('.filas-catalogo')).toContainText('Guardada en este móvil.');
    expect(llamadas).toEqual([`GET /api/fotos/${fotoUno}/original`]);
    expect(bucket.eventos).toEqual(['get']);
    // Incorporada a la interfaz: su bloque «Fotos» la cuenta.
    await expect(bloque(page).locator('.fotos-cuenta')).toHaveText(/·\s*1/);

    await seccion.getByRole('button', { name: 'Volver a consultar' }).click();
    await expect(seccion.locator('.filas-catalogo')).toContainText('Foto registrada en este móvil.');
    await seccion.getByRole('button', { name: `Comprobar y guardar (descarga ${png.length} B para comparar)` }).click();
    await expect(seccion.locator('.filas-catalogo')).toContainText('Comprobada: es la misma foto que ya había en este móvil.');
    expect(llamadas.filter((l) => l.endsWith('/original'))).toHaveLength(2);
    expect(llamadas.some((l) => l.startsWith('POST'))).toBe(false);
    expect(bucket.eventos).toEqual(['get', 'get']);
    // Guardar o comprobar nunca es acuse: el ledger de este móvil sigue vacío.
    expect(await ledgerNavegador(page)).toEqual([]);
  });

  // Matriz de una ronda: móvil en vertical (390×844 y 360×640) y en horizontal (844×390), de día y de noche
  // (:root[data-tema='oscuro'] del CSS real). Misma interfaz, Worker y presupuestos en cada caso. Las capturas son
  // para revisarlas a ojo (salidas propias de Playwright en testInfo.outputPath); no certifican contraste AA.
  for (const [ancho, alto] of [[390, 844], [360, 640], [844, 390]] as const) {
    for (const tema of ['claro', 'oscuro'] as const) {
      test(`N6 · ${ancho}×${alto} ${tema}: objetivos de 44 px, foco y sin desbordes en catálogo, visor y aviso de borrado`,
        async ({ page }, testInfo) => {
          await page.setViewportSize({ width: ancho, height: alto });
          await sembrarServidor(page);
          await abrirFixture(page);
          await page.evaluate((t) => { document.documentElement.dataset.tema = t; }, tema);
          // El papel del tema aplicado por el CSS real: blanco de día, #121820 de noche.
          expect(await page.evaluate(() => getComputedStyle(document.body).backgroundColor))
            .toBe(tema === 'oscuro' ? 'rgb(18, 24, 32)' : 'rgb(255, 255, 255)');

          const seccion = page.locator('#fotos-viaje');
          await seccion.getByRole('button', { name: 'Ver fotos respaldadas' }).focus();
          await page.keyboard.press('Enter');
          await expect(seccion.locator('.estado-catalogo')).toHaveText('Fotos respaldadas confirmadas en el servidor.');
          // El botón pulsado ya no existe: el foco se queda en la sección, no vuelve al documento.
          expect(await page.evaluate(() => document.getElementById('fotos-viaje')?.contains(document.activeElement) ?? false)).toBe(true);
          // F1: la fila del catálogo empieza en la misma columna que su línea de estado (±1 px CSS), medido en
          // los rectángulos de los propios elementos tras la página válida.
          const textoFila = seccion.locator('.filas-catalogo .fila-texto');
          await expect(textoFila).toHaveCount(1);
          const izquierdaFila = await textoFila.evaluate((e) => e.getBoundingClientRect().left);
          const izquierdaEstado = await seccion.locator('.estado-catalogo').evaluate((e) => e.getBoundingClientRect().left);
          expect.soft(Math.abs(izquierdaFila - izquierdaEstado),
            `F1: fila a ${izquierdaFila}px y estado a ${izquierdaEstado}px`).toBeLessThanOrEqual(1);
          await comprobarObjetivos(seccion);
          expect(await seccion.evaluate((s) => s.scrollWidth <= s.clientWidth)).toBe(true);
          await seccion.locator('.estado-catalogo').scrollIntoViewIfNeeded();
          await page.screenshot({ path: testInfo.outputPath('catalogo.png') });

          await anadirFoto(page);
          const visor = await abrirVisor(page);
          await visor.locator('[data-visor-respaldar]').focus();
          await page.keyboard.press('Enter');
          await expect(visor.locator('.visor-respaldo-nota')).toHaveText(COPIA_RESPALDADA);
          // Los botones del respaldo cambian (Respaldar → Pausar → ninguno) y el foco sigue dentro del visor.
          expect(await page.evaluate(() => document.getElementById('visor-foto')?.contains(document.activeElement) ?? false)).toBe(true);
          await comprobarObjetivos(visor.locator('.visor-pie'));
          expect(await visor.evaluate((v) => v.scrollWidth <= v.clientWidth)).toBe(true);

          // Borrar avisa con lo que consta en este móvil (D-U1): se permite, diciendo hasta dónde llega la confirmación.
          await visor.locator('[data-visor-borrar]').click();
          const confirmar = visor.locator('.visor-confirmar');
          await expect(confirmar.locator('.visor-confirmar-texto'))
            .toHaveText(`¿Borrar esta foto de este móvil? ${COPIA_RESPALDADA} ${FINAL_BORRADO}`);
          // F2: el aviso de varias líneas lleva un interlineado numérico de al menos 1,4 veces su cuerpo
          // (estilo calculado del propio párrafo; «normal» no cumple y se informa tal cual).
          const tipografia = await confirmar.locator('.visor-confirmar-texto').evaluate((e) => {
            const estilo = getComputedStyle(e);
            return { lineHeight: estilo.lineHeight, fontSize: estilo.fontSize };
          });
          const interlineado = parseFloat(tipografia.lineHeight);
          expect.soft(Number.isFinite(interlineado), `F2: line-height calculado «${tipografia.lineHeight}»`).toBe(true);
          expect.soft(interlineado, `F2: line-height «${tipografia.lineHeight}» con font-size «${tipografia.fontSize}»`)
            .toBeGreaterThanOrEqual(1.4 * parseFloat(tipografia.fontSize));
          await expect(confirmar.locator('[data-visor-cancelar]')).toBeFocused();
          await comprobarObjetivos(confirmar);
          expect(await visor.evaluate((v) => v.scrollWidth <= v.clientWidth)).toBe(true);
          await confirmar.scrollIntoViewIfNeeded();
          await page.screenshot({ path: testInfo.outputPath('visor.png') });
        });
    }
  }

  test('N7 · D-U1: borrar una foto con respaldo sin confirmar avisa; Cancelar no toca nada y Borrar deja la marca de '
    + 'borrada con el registro intacto', async ({ page }) => {
    await login(page, 'editor-uno'); llamadas = [];
    await abrirFixture(page);
    const b = await anadirFoto(page);
    const visor = await abrirVisor(page);
    // POST manual cuya respuesta se pierde tras reservar: 503, marca de envío durable y nada confirmado.
    perdida = 'reserva';
    await visor.locator('[data-visor-respaldar]').click();
    await expect(visor.locator('.visor-respaldo-nota')).toHaveText(COPIA_SIN_CONFIRMAR);
    const ledger = await ledgerNavegador(page);
    expect(ledger).toEqual([expect.objectContaining({ fase: 'enviada', enviada: true, pausada: false, recibo: null })]);
    const { fotoId } = ledger[0];
    const local = await fotoNavegador(page, fotoId);
    expect(local?.metadatos).toMatchObject({ fotoId, nombre: 'calle.png', bytesOriginal: png.length });
    expect(local?.original).toEqual([...png]);
    expect(sinCompartidas(llamadas)).toEqual(['POST /api/fotos/respaldo']);
    // Instantánea justo antes del aviso: el borrado local no hace ninguna petición al servidor.
    const servidorAntes = await snapshotServidor();
    const eventosAntes = [...bucket.eventos];
    const aviso = visor.locator('.visor-confirmar-texto');
    const textoAviso = '¿Borrar esta foto de este móvil? Su respaldo está sin confirmar: puede que esta sea la única copia. '
      + FINAL_BORRADO;

    // Primera vez: «Cancelar» deja el original y el registro como estaban.
    await visor.locator('[data-visor-borrar]').click();
    await expect(aviso).toHaveText(textoAviso);
    await visor.locator('[data-visor-cancelar]').click();
    await expect(visor.locator('.visor-confirmar')).toBeHidden();
    await expect(visor.locator('[data-visor-borrar]')).toBeFocused();
    expect(await fotoNavegador(page, fotoId)).toEqual(local);
    expect(await ledgerNavegador(page)).toEqual(ledger);

    // Segunda vez: «Borrar» (acción explícita del usuario) deja la marca de borrada en este móvil.
    await visor.locator('[data-visor-borrar]').click();
    await expect(aviso).toHaveText(textoAviso);
    await visor.locator('[data-visor-confirmar]').click();
    await expect(visor).toBeHidden();
    await expect(b.locator('.fotos-estado')).toHaveText('Foto borrada de este móvil.');
    await expect(b.locator('[data-foto-id]')).toHaveCount(0);
    const borrada = { metadatos: { formato: 1, tipo: 'borrada', fotoId }, original: null };
    expect(await fotoNavegador(page, fotoId)).toEqual(borrada);
    // El registro del respaldo se conserva EXACTO (operación, marca de envío, sin acuse) y el servidor no cambia.
    expect(await ledgerNavegador(page)).toEqual(ledger);
    expect(await snapshotServidor()).toEqual(servidorAntes);
    expect(bucket.eventos).toEqual(eventosAntes);
    expect(sinCompartidas(llamadas)).toEqual(['POST /api/fotos/respaldo']);

    // Al recargar, «Todo» sigue contando ese envío sin confirmar; nada se envía, consulta ni descarga solo.
    await abrirFixture(page);
    await expect(page.locator('.estado-fotos-viaje')).toHaveText('1 sin confirmar');
    const fila = page.locator('.filas-resumen li');
    await expect(fila).toHaveCount(1);
    await expect(fila).toContainText('«calle.png»');
    expect(await ledgerNavegador(page)).toEqual(ledger);
    expect(await fotoNavegador(page, fotoId)).toEqual(borrada);
    expect(sinCompartidas(llamadas)).toEqual(['POST /api/fotos/respaldo']);
    expect(bucket.eventos).toEqual(eventosAntes);
  });

  // ---------- FO3 · Compartidas en la ficha de su destino: ver con conexión sin guardar y «Guardar sin conexión» ----------
  // Navegadores independientes (cada uno con su IndexedDB) contra el MISMO Worker, PGlite y R2 modelado del fixture.
  // Es el modelo local: no certifica R2/Neon reales, Safari, HEIC, coste de datos ni un teléfono real.
  const VISTA_TEMPORAL = 'Se ven con conexión y no se guardan en este móvil.';
  const GUARDADA_REMOTA = 'Guardada en este móvil: ya se puede ver sin conexión.';
  const SIN_SESION_REMOTA = 'Este móvil no tiene sesión en el servidor: las fotos compartidas no se pueden ver.';
  async function otroMovil(browser: Browser) {
    const contexto = await browser.newContext({ ignoreHTTPSErrors: true, locale: 'es-ES', viewport: { width: 390, height: 844 },
      deviceScaleFactor: 2, isMobile: true, hasTouch: true, serviceWorkers: 'block' });
    await contexto.route('**/*', (r) => new URL(r.request().url()).origin === origen ? r.continue() : r.abort());
    const page = await contexto.newPage();
    await instrumentar(page);
    await page.goto(origen + '/entrar');
    return { contexto, page };
  }
  /** Página con varios destinos ya asentada: «Fotos del viaje» leyó el ledger (vacío) de este móvil. */
  async function abrirDestinos(page: Page) {
    await abrirFixture(page, '?destinos');
    await expect(page.locator('.estado-fotos-viaje')).toHaveText('Aún no hay respaldos registrados en este móvil.');
  }
  async function abrirFotos(page: Page, d: DestinoFoto) {
    const b = bloqueDe(page, d);
    const alternar = b.locator('[data-fotos-alternar]');
    if (await alternar.getAttribute('aria-expanded') !== 'true') await alternar.click();
    return b;
  }
  const focoVisible = (l: Locator) => l.evaluate((e) => {
    const s = getComputedStyle(e);
    return e.matches(':focus-visible') && s.outlineStyle !== 'none' && parseFloat(s.outlineWidth) >= 2;
  });

  test('N8 · A respalda un PNG sintético y B, otro navegador, lo ve en la ficha de SU destino sin guardar nada', async ({ page, browser }) => {
    // A: foto de la galería y «Respaldar» desde su visor, con la interfaz real.
    await login(page, 'editor-uno');
    await abrirFixture(page, '?destinos');
    const a = await abrirFotos(page, D_PARADA);
    const selector = page.waitForEvent('filechooser');
    await a.locator('[data-fotos-anadir]').click();
    await (await selector).setFiles([{ name: 'calle-a.png', mimeType: 'image/png', buffer: pngVista }]);
    await a.locator('[data-foto-id]').click();
    const visorA = page.locator('#visor-foto');
    await visorA.locator('[data-visor-respaldar]').click();
    await expect(visorA.locator('.visor-aviso')).toHaveText(RESPALDADA);
    const [{ fotoId }] = await ledgerNavegador(page);
    await page.keyboard.press('Escape');

    const b = await otroMovil(browser);
    try {
      await login(b.page, 'editor-dos');
      llamadas = []; bucket.eventos.length = 0;
      await abrirDestinos(b.page);
      // Abrir la app y pintar las fichas no consulta ni descarga nada.
      expect(llamadas).toEqual([]);
      const antes = await escrituras(b.page);
      const bloqueB = await abrirFotos(b.page, D_PARADA);
      const celda = bloqueB.locator(`[data-foto-remota="${fotoId}"]`);
      await expect(celda.locator('img')).toHaveCount(1);
      // Vista temporal saneada: un PNG nuevo en una URL blob propia, nunca el original ni una URL del servidor.
      expect(await celda.locator('img').evaluate((i: HTMLImageElement) => ({ blob: i.src.startsWith('blob:'), ancho: i.naturalWidth })))
        .toEqual({ blob: true, ancho: 48 });
      await expect(bloqueB.locator('.fotos-remotas-estado')).toHaveText(VISTA_TEMPORAL);
      await expect(bloqueB.locator('.fotos-vacio')).toHaveText(`Aún no hay fotos de «${nombreDe(D_PARADA)}» en este móvil.`);
      expect(consultados(llamadas)).toEqual([D_PARADA]);
      expect(originales(llamadas)).toEqual([`GET /api/fotos/${fotoId}/original`]);
      expect(llamadas).toHaveLength(2);
      // Ver no escribe nada en B: ni originales, ni vistas previas, ni metadata, ni ledger, ni Cache Storage ni storage.
      expect((await escrituras(b.page)).slice(antes.length)).toEqual([]);
      expect(await fotoNavegador(b.page, fotoId)).toEqual({ metadatos: null, original: null });

      // Su visor: la vista temporal, de dónde viene y «Guardar sin conexión» como acción aparte.
      await celda.click();
      const visor = b.page.locator('#visor-foto');
      await expect(visor).toBeVisible();
      await expect(visor.locator('#visor-foto-titulo')).toHaveText(`Foto de «${nombreDe(D_PARADA)}»`);
      await expect(visor.locator('.visor-nombre')).toHaveText('calle-a.png');
      await expect(visor.locator('.visor-imagen img')).toHaveCount(1);
      await expect(visor.locator('.visor-remota-nota'))
        .toHaveText('Compartida en el servidor del viaje: se ve con conexión y no se guarda en este móvil.');
      await expect(visor.locator('[data-visor-guardar-remota]')).toHaveText(`Guardar sin conexión (${pngVista.length} B)`);
      await expect(visor.locator('[data-visor-cerrar]')).toBeFocused();
      // Abrir el visor reutiliza la vista temporal: ningún GET más.
      expect(llamadas).toHaveLength(2);
      await b.page.keyboard.press('Escape');
      await expect(visor).toBeHidden();
      await expect(celda).toBeFocused();

      expect((await escrituras(b.page)).slice(antes.length)).toEqual([]);
      expect(await ledgerNavegador(b.page)).toEqual([]);
      expect(await rastro(b.page, [fotoId, 'calle-a.png'])).toEqual([]);
      // Cerrar el bloque suelta las vistas temporales.
      await bloqueB.locator('[data-fotos-alternar]').click();
      await expect.poll(() => urlsVivas(b.page)).toBe(0);
      expect(bucket.eventos).toEqual(['get']);
    } finally {
      await b.contexto.close();
    }
  });

  test('N9 · «Guardar sin conexión» desde el visor de una compartida: un GET, original exacto en este móvil y se abre sin red',
    async ({ page }) => {
      await sembrarServidor(page, [{ s: remota(fotoUno, 'remota-uno.png', D_PARADA, 'image/png', pngVista), bytes: pngVista }]);
      await abrirDestinos(page);
      const b = await abrirFotos(page, D_PARADA);
      const celda = b.locator(`[data-foto-remota="${fotoUno}"]`);
      await expect(celda.locator('img')).toHaveCount(1);
      await celda.click();
      const visor = page.locator('#visor-foto');
      const guardar = visor.locator('[data-visor-guardar-remota]');
      await guardar.click();
      await expect(visor.locator('.visor-aviso')).toHaveText(GUARDADA_REMOTA);
      // Ver y guardar son dos GET del original: guardar no reutiliza la vista temporal.
      expect(originales(llamadas)).toEqual([`GET /api/fotos/${fotoUno}/original`, `GET /api/fotos/${fotoUno}/original`]);
      expect(llamadas.some((l) => l.startsWith('POST'))).toBe(false);
      const local = await fotoNavegador(page, fotoUno);
      expect(local?.original).toEqual([...pngVista]);
      expect(local?.metadatos).toMatchObject({ formato: 1, fotoId: fotoUno, destino: D_PARADA, nombre: 'remota-uno.png',
        mimeDeclarado: 'image/png', bytesOriginal: pngVista.length });
      // Guardar no es un acuse ni un respaldo de este móvil.
      expect(await ledgerNavegador(page)).toEqual([]);
      await expect(guardar).toHaveCount(0);
      await page.keyboard.press('Escape');
      await expect(visor).toBeHidden();
      // Ya es de este móvil: queda la foto local y la compartida no se repite.
      const propia = b.locator(`[data-foto-id="${fotoUno}"]`);
      await expect(propia).toHaveCount(1);
      await expect(propia).toBeFocused();
      await expect(b.locator('[data-foto-remota]')).toHaveCount(0);
      await expect(b.locator('.fotos-cuenta')).toHaveText(/·\s*1/);

      // Se recarga con red y se corta la conexión: la foto se abre desde este móvil, sin ninguna petición.
      await abrirDestinos(page);
      llamadas = [];
      await page.context().setOffline(true);
      try {
        const sinRed = await abrirFotos(page, D_PARADA);
        await expect(sinRed.locator('.fotos-remotas-estado')).toHaveText('Sin conexión: las fotos compartidas solo se ven con conexión.');
        const foto = sinRed.locator(`[data-foto-id="${fotoUno}"]`);
        await expect(foto.locator('img')).toHaveCount(1);
        await foto.click();
        await visor.locator('[data-visor-original]').click();
        await expect(visor.locator('.visor-aviso')).toHaveText('Original a tamaño completo.');
        await expect(visor.locator('.visor-imagen img')).toHaveCount(1);
        expect(llamadas).toEqual([]);
      } finally {
        await page.context().setOffline(false);
      }
    });

  test('N10 · cada ficha consulta SOLO su destino: el sitio de dentro y otra parada no mezclan, y una celda fuera de la vista '
    + 'no pide su original', async ({ page }) => {
    await sembrarServidor(page, [{ s: remota(fotoUno, 'remota-uno.png', D_PARADA, 'image/png', pngVista), bytes: pngVista }]);
    await instrumentar(page);
    await abrirDestinos(page);
    expect(llamadas).toEqual([]);
    for (const d of [D_SUB, D_OTRA]) {
      const b = await abrirFotos(page, d);
      await expect(b.locator('.fotos-remotas-estado')).toHaveText(`No hay fotos compartidas de «${nombreDe(d)}».`);
      await expect(b.locator('[data-foto-remota]')).toHaveCount(0);
    }
    expect(consultados(llamadas)).toEqual([D_SUB, D_OTRA]);
    expect(originales(llamadas)).toEqual([]);

    // La consulta de la parada se retiene hasta llevar su bloque fuera de la vista: su celda llega oculta.
    let soltar!: () => void;
    const compuerta = new Promise<void>((ok) => { soltar = ok; });
    await page.route((u) => u.pathname === '/api/fotos/listado', async (r) => { await compuerta; await r.continue(); });
    const b = await abrirFotos(page, D_PARADA);
    await expect(b.locator('.fotos-remotas-estado')).toHaveText('Buscando fotos compartidas…');
    await page.locator('#contenido').evaluate((c) => { c.scrollTop = c.scrollHeight; });
    soltar();
    const celda = b.locator(`[data-foto-remota="${fotoUno}"]`);
    await expect(celda).toHaveCount(1);
    await expect(celda).not.toBeInViewport();
    await page.waitForTimeout(500);
    expect(originales(llamadas)).toEqual([]);
    await expect(celda.locator('img')).toHaveCount(0);
    // A la vista, entonces sí: un GET de su original y su vista temporal.
    await celda.scrollIntoViewIfNeeded();
    await expect(celda.locator('img')).toHaveCount(1);
    expect(originales(llamadas)).toEqual([`GET /api/fotos/${fotoUno}/original`]);
    expect(consultados(llamadas)).toEqual([D_SUB, D_OTRA, D_PARADA]);
    // Cerrar los bloques suelta todas las vistas temporales; nada quedó guardado.
    for (const d of [D_PARADA, D_SUB, D_OTRA]) await bloqueDe(page, d).locator('[data-fotos-alternar]').click();
    await expect.poll(() => urlsVivas(page)).toBe(0);
    expect(await rastro(page, [fotoUno, 'remota-uno.png'])).toEqual([]);
  });

  test('N11 · al perder la sesión se limpian todas las vistas temporales, sin copia de reserva ni nada guardado', async ({ page }) => {
    await sembrarServidor(page, [{ s: remota(fotoUno, 'remota-uno.png', D_PARADA, 'image/png', pngVista), bytes: pngVista },
      { s: remota(fotoDos, 'remota-dos.png', D_PARADA, 'image/png', pngVista), bytes: pngVista }]);
    await instrumentar(page);
    await abrirDestinos(page);
    const antes = await escrituras(page);
    const b = await abrirFotos(page, D_PARADA);
    await expect(b.locator(`[data-foto-remota="${fotoUno}"] img`)).toHaveCount(1);
    await expect.poll(() => urlsVivas(page)).toBe(1);
    // La sesión deja de valer: «Ver más compartidas» recibe 401 y se limpian las vistas.
    await page.context().clearCookies();
    await b.getByRole('button', { name: 'Ver más compartidas' }).click();
    await expect(b.locator('.fotos-remotas-estado')).toHaveText(SIN_SESION_REMOTA);
    await expect(b.locator('[data-foto-remota]')).toHaveCount(0);
    await expect.poll(() => urlsVivas(page)).toBe(0);
    await expect(b.getByRole('link', { name: 'Entrar' })).toHaveAttribute('href', '/entrar');
    // Reabrir el bloque sin sesión tampoco enseña nada.
    await b.locator('[data-fotos-alternar]').click();
    await b.locator('[data-fotos-alternar]').click();
    await expect(b.locator('.fotos-remotas-estado')).toHaveText(SIN_SESION_REMOTA);
    await expect(b.locator('[data-foto-remota]')).toHaveCount(0);
    expect(originales(llamadas)).toEqual([`GET /api/fotos/${fotoUno}/original`]);
    expect(consultados(llamadas)).toEqual([D_PARADA, D_PARADA, D_PARADA]);
    expect((await escrituras(page)).slice(antes.length)).toEqual([]);
    expect(await rastro(page, [fotoUno, fotoDos])).toEqual([]);
  });

  test('N12 · un archivo sin vista segura (SVG declarado) no se pide ni se pinta: lo dice y deja «Guardar sin conexión»',
    async ({ page }) => {
      const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" onload="window.__svg=1"><script>window.__svg=2</script></svg>');
      await sembrarServidor(page, [{ s: remota(fotoUno, 'dibujo.svg', D_PARADA, 'image/svg+xml', svg), bytes: svg }]);
      await instrumentar(page);
      await abrirDestinos(page);
      const b = await abrirFotos(page, D_PARADA);
      const celda = b.locator(`[data-foto-remota="${fotoUno}"]`);
      await expect(celda).toContainText('Sin vista segura');
      await expect(b.locator('.fotos-remotas img')).toHaveCount(0);
      expect(originales(llamadas)).toEqual([]);
      await celda.click();
      const visor = page.locator('#visor-foto');
      await expect(visor.locator('.visor-texto')).toHaveText('No hay vista segura para este tipo de archivo (image/svg+xml). '
        + 'Puedes guardarlo sin conexión y, después, descargar el original.');
      await expect(visor.locator('.visor-imagen img')).toHaveCount(0);
      await expect(visor.locator('[data-visor-guardar-remota]')).toHaveText(`Guardar sin conexión (${svg.length} B)`);
      expect(await page.evaluate(() => (window as unknown as { __svg?: number }).__svg)).toBeUndefined();
      expect(await urlsVivas(page)).toBe(0);
      await page.keyboard.press('Escape');
      await expect(celda).toBeFocused();
    });

  test('N14 · sin sesión, «Guardar sin conexión» recibe 401: fuera todas las vistas y candidatas compartidas; lo de este móvil sigue',
    async ({ page }) => {
      await sembrarServidor(page, [{ s: remota(fotoUno, 'remota-uno.png', D_PARADA, 'image/png', pngVista), bytes: pngVista },
        { s: remota(fotoDos, 'remota-dos.png', D_PARADA, 'image/png', pngVista), bytes: pngVista }]);
      await instrumentar(page);
      await abrirDestinos(page);
      // Una copia deliberada de este móvil, en otra ficha.
      const propia = await abrirFotos(page, D_OTRA);
      const selector = page.waitForEvent('filechooser');
      await propia.locator('[data-fotos-anadir]').click();
      await (await selector).setFiles([{ name: 'mia.png', mimeType: 'image/png', buffer: pngVista }]);
      await expect(propia.locator('[data-foto-id] img')).toHaveCount(1);
      const b = await abrirFotos(page, D_PARADA);
      const celda = b.locator(`[data-foto-remota="${fotoUno}"]`);
      await expect(celda.locator('img')).toHaveCount(1);
      await celda.click();
      const visor = page.locator('#visor-foto');
      await expect(visor.locator('.visor-imagen img')).toHaveCount(1);
      // La sesión deja de valer justo antes de guardar.
      await page.context().clearCookies();
      await visor.locator('[data-visor-guardar-remota]').click();
      await expect(visor.locator('.visor-aviso')).toHaveText('Este móvil no tiene sesión en el servidor: no se ha guardado nada.');
      await expect(visor.locator('.visor-imagen img')).toHaveCount(0);
      await expect(visor.locator('[data-visor-guardar-remota]')).toHaveCount(0);
      await page.keyboard.press('Escape');
      await expect(b.locator('[data-foto-remota]')).toHaveCount(0);
      await expect(b.locator('.fotos-remotas-estado')).toHaveText(SIN_SESION_REMOTA);
      // Solo queda viva la vista previa de la copia deliberada de este móvil.
      await expect.poll(() => urlsVivas(page)).toBe(1);
      await expect(propia.locator('[data-foto-id] img')).toHaveCount(1);
      expect(await fotoNavegador(page, fotoUno)).toEqual({ metadatos: null, original: null });
      expect(originales(llamadas)).toEqual([`GET /api/fotos/${fotoUno}/original`, `GET /api/fotos/${fotoUno}/original`]);
    });

  test('N15 · sin IntersectionObserver no se pide ningún original hasta tocar una celda; el visor pide solo esa y plegar suelta su vista',
    async ({ page }) => {
      await sembrarServidor(page, [{ s: remota(fotoUno, 'remota-uno.png', D_PARADA, 'image/png', pngVista), bytes: pngVista },
        { s: remota(fotoDos, 'remota-dos.png', D_PARADA, 'image/png', pngVista), bytes: pngVista }]);
      await page.addInitScript(() => { delete (window as unknown as { IntersectionObserver?: unknown }).IntersectionObserver; });
      await instrumentar(page);
      await abrirDestinos(page);
      expect(await page.evaluate(() => typeof (window as unknown as { IntersectionObserver?: unknown }).IntersectionObserver))
        .toBe('undefined');
      const b = await abrirFotos(page, D_PARADA);
      await expect(b.locator(`[data-foto-remota="${fotoUno}"]`)).toHaveCount(1);
      await b.getByRole('button', { name: 'Ver más compartidas' }).click();
      await expect(b.locator('[data-foto-remota]')).toHaveCount(2);
      await page.waitForTimeout(400);
      // La metadata sí (dos consultas por toque); ningún original sin saber qué se ve.
      expect(consultados(llamadas)).toEqual([D_PARADA, D_PARADA]);
      expect(originales(llamadas)).toEqual([]);
      await expect(b.locator('[data-foto-remota] img')).toHaveCount(0);
      // Un toque explícito: el visor pide SOLO esa foto.
      await b.locator(`[data-foto-remota="${fotoDos}"]`).click();
      const visor = page.locator('#visor-foto');
      await expect(visor.locator('.visor-imagen img')).toHaveCount(1);
      expect(originales(llamadas)).toEqual([`GET /api/fotos/${fotoDos}/original`]);
      await page.keyboard.press('Escape');
      await b.locator('[data-fotos-alternar]').click();
      await expect.poll(() => urlsVivas(page)).toBe(0);
      expect(originales(llamadas)).toHaveLength(1);
    });

  test('N16 · plegar (el enganche de main.ts) cierra de verdad las compartidas: con la vista ya lista, con la consulta '
    + 'pendiente y con el original pendiente, nada llega tarde y no queda ninguna URL', async ({ page }) => {
    await sembrarServidor(page, [{ s: remota(fotoUno, 'remota-uno.png', D_PARADA, 'image/png', pngVista), bytes: pngVista },
      { s: remota(fotoDos, 'remota-dos.png', D_SUB, 'image/png', pngVista), bytes: pngVista }]);
    await instrumentar(page);
    await abrirDestinos(page);
    const fallidas: string[] = [];
    page.on('requestfailed', (r) => fallidas.push(new URL(r.url()).pathname));
    const plegarDe = (d: DestinoFoto) => page.evaluate((sel) => window.fixtureUi!.cerrarEn(sel), `[data-fotos-destino="${claveDe(d)}"]`);

    // 1 · Vista ya lista: plegar suelta su URL y deja el bloque plegado; reabrir consulta de nuevo.
    const parada = await abrirFotos(page, D_PARADA);
    await expect(parada.locator(`[data-foto-remota="${fotoUno}"] img`)).toHaveCount(1);
    await expect.poll(() => urlsVivas(page)).toBe(1);
    await plegarDe(D_PARADA);
    await expect(parada.locator('[data-fotos-alternar]')).toHaveAttribute('aria-expanded', 'false');
    await expect.poll(() => urlsVivas(page)).toBe(0);

    // 2 · Consulta pendiente (sitio de dentro): la petición LLEGA al Worker real (queda en su registro) y lo que se
    // retiene es su respuesta; al plegar se corta en el navegador y la página que llega después no se pinta.
    // Retenerla antes de llegar no valdría: el aborto del plegado la cancelaría sin que el servidor la viera nunca.
    let llegada!: () => void;
    const llego = new Promise<void>((ok) => { llegada = ok; });
    let soltarConsulta!: () => void;
    const consulta = new Promise<void>((ok) => { soltarConsulta = ok; });
    const delSitio = (u: URL) => u.pathname === '/api/fotos/listado' && (u.searchParams.get('destino') ?? '').includes('subparada');
    await page.route(delSitio, async (r) => {
      const respuesta = await r.fetch();
      llegada();
      await consulta;
      // La página ya la abortó al plegar: entregarla falla y nada llega a la interfaz.
      await r.fulfill({ response: respuesta }).catch(() => {});
    });
    const sitio = await abrirFotos(page, D_SUB);
    await llego;
    // Barrera de llegada: el servidor del fixture ya la registró (y el Worker contestó) ANTES de plegar.
    expect(consultados(llamadas)).toEqual([D_PARADA, D_SUB]);
    await expect(sitio.locator('.fotos-remotas-estado')).toHaveText('Buscando fotos compartidas…');
    await plegarDe(D_SUB);
    // El plegado aborta la consulta en el navegador.
    await expect.poll(() => fallidas.filter((f) => f === '/api/fotos/listado').length).toBe(1);
    soltarConsulta();
    await page.waitForTimeout(400);
    await expect(sitio.locator('[data-fotos-alternar]')).toHaveAttribute('aria-expanded', 'false');
    await expect(sitio.locator('[data-foto-remota]')).toHaveCount(0);
    await expect(sitio.locator('.fotos-remotas')).toHaveCount(0);
    expect(await urlsVivas(page)).toBe(0);
    expect(originales(llamadas)).toEqual([`GET /api/fotos/${fotoUno}/original`]);
    await page.unroute(delSitio);

    // 3 · Original pendiente (otra ficha): al plegar se aborta; lo que llegue después no crea URL ni vista.
    let soltarOriginal!: () => void;
    const original = new Promise<void>((ok) => { soltarOriginal = ok; });
    await page.route((u) => u.pathname === `/api/fotos/${fotoUno}/original`, async (r) => {
      await original; await r.continue().catch(() => {});
    });
    const otra = await abrirFotos(page, D_PARADA);
    await expect(otra.locator(`[data-foto-remota="${fotoUno}"]`)).toContainText('Cargando…');
    await plegarDe(D_PARADA);
    await expect.poll(() => fallidas.filter((f) => f === `/api/fotos/${fotoUno}/original`).length).toBe(1);
    soltarOriginal();
    await page.waitForTimeout(400);
    await expect(otra.locator('[data-foto-remota]')).toHaveCount(0);
    expect(await urlsVivas(page)).toBe(0);
    // Reabrir es una instancia limpia: consulta nueva y su original otra vez a la vista.
    await page.unroute((u) => u.pathname === `/api/fotos/${fotoUno}/original`);
    const reabierta = await abrirFotos(page, D_PARADA);
    await expect(reabierta.locator(`[data-foto-remota="${fotoUno}"] img`)).toHaveCount(1);
    expect(consultados(llamadas)).toEqual([D_PARADA, D_SUB, D_PARADA, D_PARADA]);
    expect(await rastro(page, [fotoUno, fotoDos])).toEqual([]);
  });

  test('N17 · un 401 en otra operación mientras «Guardar sin conexión» espera su escritura: el fallo posterior por cuota no deja '
    + 'captura, «Descargar archivo», vista ni URL nuevas; lo de este móvil sigue', async ({ page }) => {
    await sembrarServidor(page, [{ s: remota(fotoUno, 'remota-uno.png', D_PARADA, 'image/png', pngVista), bytes: pngVista }]);
    // PhotoDB REAL del navegador con su puerto modelado en la página del fixture: se cuentan las transacciones de
    // escritura de originales y, con la bandera, añadir un original falla por cuota (QuotaExceededError).
    await page.addInitScript((nombre) => {
      const w = window as unknown as { __escriturasOriginales: number; __cuotaLlena: boolean; __urlsCreadas: number };
      w.__escriturasOriginales = 0; w.__cuotaLlena = false; w.__urlsCreadas = 0;
      const transaccion = IDBDatabase.prototype.transaction as (...a: unknown[]) => IDBTransaction;
      IDBDatabase.prototype.transaction = function (this: IDBDatabase, ...a: unknown[]) {
        const almacenes = typeof a[0] === 'string' ? [a[0]] : [...(a[0] as Iterable<string>)];
        if (this.name === nombre && a[1] === 'readwrite' && almacenes.includes('originales')) w.__escriturasOriginales++;
        return transaccion.apply(this, a);
      } as typeof IDBDatabase.prototype.transaction;
      const anadir = IDBObjectStore.prototype.add as (...a: unknown[]) => IDBRequest;
      IDBObjectStore.prototype.add = function (this: IDBObjectStore, ...a: unknown[]) {
        if (w.__cuotaLlena && this.name === 'originales') throw new DOMException('Sin espacio en este móvil', 'QuotaExceededError');
        return anadir.apply(this, a);
      } as typeof IDBObjectStore.prototype.add;
      const crear = URL.createObjectURL.bind(URL);
      URL.createObjectURL = (o: Blob | MediaSource) => { w.__urlsCreadas++; return crear(o); };
    }, BASE_FOTOS);
    await instrumentar(page);
    await abrirDestinos(page);
    const contador = (clave: string) => page.evaluate((k) => (window as unknown as Record<string, number>)[k], clave);

    // Copia deliberada de este móvil, en otra ficha.
    const propia = await abrirFotos(page, D_OTRA);
    const selector = page.waitForEvent('filechooser');
    await propia.locator('[data-fotos-anadir]').click();
    await (await selector).setFiles([{ name: 'mia.png', mimeType: 'image/png', buffer: pngVista }]);
    await expect(propia.locator('[data-foto-id] img')).toHaveCount(1);
    const b = await abrirFotos(page, D_PARADA);
    const celda = b.locator(`[data-foto-remota="${fotoUno}"]`);
    await expect(celda.locator('img')).toHaveCount(1);

    // Otra operación: la consulta del catálogo global sale y se retiene; se suelta cuando el contexto ya no tiene la
    // cookie (Playwright la toma del almacén del contexto al continuar), así que el Worker real contesta 401.
    let soltarCatalogo!: () => void;
    const catalogo = new Promise<void>((ok) => { soltarCatalogo = ok; });
    await page.route((u) => u.pathname === '/api/fotos/listado' && !u.searchParams.has('destino'), async (r) => {
      await catalogo;
      const cabeceras = { ...r.request().headers() };
      delete cabeceras.cookie;
      await r.continue({ headers: cabeceras });
    });
    const seccion = page.locator('#fotos-viaje');
    await seccion.getByRole('button', { name: 'Ver fotos respaldadas' }).click();
    await expect(seccion.locator('.estado-catalogo')).toHaveText('Consultando…');

    // «Guardar sin conexión»: recibe el original válido y su escritura queda retenida en PhotoDB.
    await celda.click();
    const visor = page.locator('#visor-foto');
    await expect(visor.locator('.visor-imagen img')).toHaveCount(1);
    // Línea base: la copia deliberada y su vista previa ya abrieron sus propias escrituras.
    const escriturasAntes = await contador('__escriturasOriginales');
    await page.evaluate((nombre) => new Promise<void>((listo, fallo) => {
      const r = indexedDB.open(nombre);
      r.onerror = () => fallo(r.error);
      r.onsuccess = () => {
        const db = r.result; const tx = db.transaction('originales', 'readwrite'); const almacen = tx.objectStore('originales');
        let soltar = false;
        (window as unknown as { __soltarRetencion: () => void }).__soltarRetencion = () => { soltar = true; };
        const vuelta = () => { if (!soltar) almacen.get('retencion').onsuccess = vuelta; };
        vuelta();
        tx.oncomplete = () => db.close();
        listo();
      };
    }), BASE_FOTOS);
    await visor.locator('[data-visor-guardar-remota]').click();
    // La retención (1) y la escritura de «Guardar sin conexión» (1), que espera detrás.
    await expect.poll(() => contador('__escriturasOriginales')).toBe(escriturasAntes + 2);
    expect(originales(llamadas)).toEqual([`GET /api/fotos/${fotoUno}/original`, `GET /api/fotos/${fotoUno}/original`]);

    // 401 en la otra operación: fuera las vistas y candidatas, también la de este visor.
    await page.context().clearCookies();
    soltarCatalogo();
    await expect(seccion.locator('.estado-catalogo')).toHaveText('Este móvil no tiene sesión en el servidor.');
    await expect(visor.locator('.visor-imagen img')).toHaveCount(0);
    const creadas = await contador('__urlsCreadas');

    // Después, la escritura retenida falla por cuota: ni captura, ni «Descargar archivo», ni Guardar, ni vista.
    await page.evaluate(() => {
      const w = window as unknown as { __cuotaLlena: boolean; __soltarRetencion: () => void };
      w.__cuotaLlena = true; w.__soltarRetencion();
    });
    await expect(visor.locator('.visor-aviso')).toHaveText('No se pudo guardar en este móvil; no se ha guardado nada.');
    await expect(visor.locator('[data-visor-archivo-remota]')).toHaveCount(0);
    await expect(visor.locator('[data-visor-guardar-remota]')).toHaveCount(0);
    await expect(visor.locator('.visor-imagen img')).toHaveCount(0);
    expect(await contador('__urlsCreadas')).toBe(creadas);
    await page.evaluate(() => { (window as unknown as { __cuotaLlena: boolean }).__cuotaLlena = false; });
    await page.keyboard.press('Escape');
    await expect(b.locator('[data-foto-remota]')).toHaveCount(0);
    await expect(b.locator('.fotos-remotas-estado')).toHaveText(SIN_SESION_REMOTA);
    // Solo sigue viva la vista previa de la copia deliberada, que sigue en este móvil.
    await expect.poll(() => urlsVivas(page)).toBe(1);
    await expect(propia.locator('[data-foto-id] img')).toHaveCount(1);
    expect(await fotoNavegador(page, fotoUno)).toEqual({ metadatos: null, original: null });
    expect(await contador('__urlsCreadas')).toBe(creadas);
  });

  // ---------- RP1 · «Respaldar pendientes»: lote manual global de lo añadido aquí con cámara o galería ----------
  /** Añade por la galería (la misma vía que la cámara) fotos con procedencia positiva en el bloque del fixture. */
  async function anadirVarias(page: Page, nombres: readonly string[]) {
    const b = bloque(page);
    const alternar = b.locator('[data-fotos-alternar]');
    if (await alternar.getAttribute('aria-expanded') !== 'true') await alternar.click();
    const antes = await b.locator('[data-foto-id]').count();
    for (const [i, nombre] of nombres.entries()) {
      const selector = page.waitForEvent('filechooser');
      await b.locator('[data-fotos-anadir]').click();
      await (await selector).setFiles([{ name: nombre, mimeType: 'image/png', buffer: pngVista }]);
      await expect(b.locator('[data-foto-id]')).toHaveCount(antes + i + 1);
    }
    return b;
  }
  const FUERA_UNA = 'Quedan fuera: 1 sin origen comprobado aquí (anterior, descargada o importada: se respalda desde su visor).';

  test('N18 · «Respaldar pendientes» cuenta solo lo añadido con cámara o galería, confirma antes de enviar nada, cancelar no '
    + 'prepara nada y confirmar envía de una en una; la descargada queda fuera', async ({ page }) => {
    await sembrarServidor(page);
    await abrirFixture(page);
    const b = await anadirVarias(page, ['galeria-1.png', 'galeria-2.png']);
    const seccion = page.locator('#fotos-viaje');
    // Una descargada del catálogo: este móvil no tiene prueba de que entrara por su cámara o galería.
    await seccion.getByRole('button', { name: 'Ver fotos respaldadas' }).click();
    await seccion.getByRole('button', { name: `Guardar en este móvil (${png.length} B)` }).click();
    await expect(seccion.locator('.filas-catalogo')).toContainText('Guardada en este móvil.');
    await expect(b.locator('[data-foto-id]')).toHaveCount(3);
    llamadas = []; bucket.eventos.length = 0;

    const lote = seccion.locator('.lote-fotos');
    await lote.getByRole('button', { name: 'Respaldar pendientes' }).click();
    await expect(lote.locator('.estado-lote')).toHaveText(
      `¿Respaldar 2 fotos añadidas aquí con la cámara o la galería (≈ ${pesoLegible(2 * pngVista.length)} de originales)?`);
    await expect(lote.locator('.detalle-lote')).toHaveText(
      `Se envían de una en una al servidor del viaje; los datos móviles pueden tener coste. ${FUERA_UNA}`);
    await expect(lote.getByRole('button', { name: 'Respaldar 2 fotos' })).toBeFocused();
    // Contar no consulta, prepara ni envía nada.
    expect(llamadas).toEqual([]);
    expect(await ledgerNavegador(page)).toEqual([]);
    await lote.getByRole('button', { name: 'Cancelar' }).click();
    await expect(lote.getByRole('button', { name: 'Respaldar pendientes' })).toBeFocused();
    expect(llamadas).toEqual([]);
    expect(await ledgerNavegador(page)).toEqual([]);

    // Confirmar: dos POST, uno tras otro; el progreso solo cuenta acuses durables.
    await lote.getByRole('button', { name: 'Respaldar pendientes' }).click();
    await lote.getByRole('button', { name: 'Respaldar 2 fotos' }).click();
    await expect(lote.locator('.estado-lote')).toHaveText('Lote terminado: 2 de 2 confirmadas por el servidor.');
    expect(llamadas).toEqual(['POST /api/fotos/respaldo', 'POST /api/fotos/respaldo']);
    const ledger = await ledgerNavegador(page);
    expect(ledger).toHaveLength(2);
    expect(ledger.every((e) => e.fase === 'respaldada' && e.enviada && !e.pausada)).toBe(true);
    // La descargada no entró: sin registro de respaldo.
    expect(ledger.map((e) => e.fotoId)).not.toContain(fotoUno);
    await expect(page.locator('.estado-fotos-viaje')).toHaveText('2 respaldadas');
    // Otra vez: nada pendiente; las confirmadas y la descargada, fuera; ninguna petición.
    await lote.getByRole('button', { name: 'Respaldar pendientes' }).click();
    await expect(lote.locator('.estado-lote')).toHaveText('No hay fotos añadidas aquí con la cámara o la galería pendientes de respaldo.');
    await expect(lote.locator('.detalle-lote')).toHaveText('Quedan fuera: 2 ya confirmadas · 1 sin origen comprobado aquí '
      + '(anterior, descargada o importada: se respalda desde su visor).');
    expect(llamadas).toHaveLength(2);
  });

  test('N19 · pausar corta el lote: lo que ya salió queda para revisar y «Continuar» solo envía las restantes', async ({ page }) => {
    await login(page, 'editor-uno'); llamadas = [];
    await abrirFixture(page);
    await anadirVarias(page, ['a.png', 'b.png']);
    // Abrir «Fotos» de la parada consulta sus compartidas (una vez); la cuenta del lote empieza después.
    await expect.poll(() => llamadas.filter((l) => l.startsWith('GET /api/fotos/listado?destino=')).length).toBe(1);
    llamadas = [];
    // El primer POST LLEGA al Worker real y se procesa; lo que se retiene es su respuesta.
    let llegada!: () => void;
    const llego = new Promise<void>((ok) => { llegada = ok; });
    let soltar!: () => void;
    const respuesta = new Promise<void>((ok) => { soltar = ok; });
    let primera = true;
    await page.route((u) => u.pathname === '/api/fotos/respaldo', async (r) => {
      if (!primera) { await r.continue(); return; }
      primera = false;
      const res = await r.fetch();
      llegada();
      await respuesta;
      await r.fulfill({ response: res }).catch(() => {});
    });
    const lote = page.locator('#fotos-viaje .lote-fotos');
    await lote.getByRole('button', { name: 'Respaldar pendientes' }).click();
    await lote.getByRole('button', { name: 'Respaldar 2 fotos' }).click();
    await llego;
    await expect(lote.locator('.estado-lote')).toHaveText('Respaldando: 0 de 2 confirmadas por el servidor.');
    await lote.getByRole('button', { name: 'Pausar' }).click();
    await expect(lote.locator('.estado-lote')).toHaveText('En pausa: 0 de 2 confirmadas.');
    await expect(lote.locator('.detalle-lote')).toHaveText(
      'Si una foto ya había salido, el servidor puede recibirla igualmente. 1 para revisar aparte (sin confirmar).');
    await expect(lote.getByRole('button', { name: 'Continuar (1)' })).toBeFocused();
    soltar();
    expect(llamadas).toEqual(['POST /api/fotos/respaldo']);
    const tras = await ledgerNavegador(page);
    expect(tras).toEqual([expect.objectContaining({ fase: 'enviada', enviada: true, recibo: null })]);
    // Continuar: solo la restante; la incierta no se reenvía a ciegas.
    await lote.getByRole('button', { name: 'Continuar (1)' }).click();
    await expect(lote.locator('.estado-lote')).toHaveText('Lote terminado: 1 de 2 confirmadas por el servidor.');
    expect(llamadas).toEqual(['POST /api/fotos/respaldo', 'POST /api/fotos/respaldo']);
    const final = await ledgerNavegador(page);
    expect(final.map((e) => e.fase).sort()).toEqual(['enviada', 'respaldada']);
    expect(final.find((e) => e.fase === 'enviada')?.operacionId).toBe(tras[0].operacionId);
    await expect(page.locator('.estado-fotos-viaje')).toHaveText('1 respaldada · 1 sin confirmar');
  });

  test('N21 · repintar «Todo» (como al cargar el mapa) no corta el lote; salir de «Todo» sí, y volver no lo reanuda',
    async ({ page }) => {
      await login(page, 'editor-uno'); llamadas = [];
      await abrirFixture(page);
      await anadirVarias(page, ['a.png', 'b.png', 'c.png']);
      await expect.poll(() => llamadas.filter((l) => l.startsWith('GET /api/fotos/listado?destino=')).length).toBe(1);
      llamadas = [];
      // Cada POST llega al Worker real; se retiene su respuesta hasta soltarla.
      const retenidas: (() => void)[] = [];
      let llegadas = 0;
      await page.route((u) => u.pathname === '/api/fotos/respaldo', async (r) => {
        const res = await r.fetch();
        llegadas++;
        await new Promise<void>((ok) => { retenidas.push(ok); });
        await r.fulfill({ response: res }).catch(() => {});
      });
      const lote = () => page.locator('#fotos-viaje .lote-fotos');
      await lote().getByRole('button', { name: 'Respaldar pendientes' }).click();
      await lote().getByRole('button', { name: 'Respaldar 3 fotos' }).click();
      await expect.poll(() => llegadas).toBe(1);

      // Repintar en el mismo turno: la sección nueva sigue el MISMO lote.
      await page.evaluate(() => window.fixtureUi!.repintarTodo());
      await expect(lote().locator('.estado-lote')).toHaveText('Respaldando: 0 de 3 confirmadas por el servidor.');
      retenidas.shift()!();
      await expect.poll(() => llegadas).toBe(2);
      await expect(lote().locator('.estado-lote')).toHaveText('Respaldando: 1 de 3 confirmadas por el servidor.');

      // Salir de «Todo» con la segunda en vuelo: se corta; al volver, nada se reanuda solo.
      await page.evaluate(() => window.fixtureUi!.salirDeTodo());
      retenidas.shift()!();
      await page.evaluate(() => window.fixtureUi!.volverATodo());
      // El estado final solo se pinta cuando el lote ya salió de su bucle: no puede salir ningún POST más.
      await expect(lote().locator('.estado-lote')).toHaveText('Se detuvo al salir de esta vista: 1 de 3 confirmadas.');
      await expect(lote().locator('.detalle-lote')).toHaveText(
        'Para seguir, vuelve a respaldar las pendientes. 1 para revisar aparte (sin confirmar).');
      await expect(lote().getByRole('button')).toHaveText(['Respaldar pendientes']);
      expect(llegadas).toBe(2);
      expect(llamadas).toEqual(['POST /api/fotos/respaldo', 'POST /api/fotos/respaldo']);
    });

  for (const [ancho, alto] of [[390, 844], [360, 640]] as const) {
    for (const tema of ['claro', 'oscuro'] as const) {
      test(`N20 · ${ancho}×${alto} ${tema}: «Respaldar pendientes» con su confirmación y su final, 44 px, foco visible y sin desbordes`,
        async ({ page }, testInfo) => {
          await page.setViewportSize({ width: ancho, height: alto });
          await login(page, 'editor-uno');
          await abrirFixture(page);
          await page.evaluate((t) => { document.documentElement.dataset.tema = t; }, tema);
          await anadirVarias(page, ['a.png', 'b.png']);
          const seccion = page.locator('#fotos-viaje');
          const lote = seccion.locator('.lote-fotos');
          await lote.getByRole('button', { name: 'Respaldar pendientes' }).focus();
          await page.keyboard.press('Enter');
          const confirmar = lote.getByRole('button', { name: 'Respaldar 2 fotos' });
          await expect(confirmar).toBeFocused();
          expect(await focoVisible(confirmar)).toBe(true);
          await comprobarObjetivos(lote);
          expect(await seccion.evaluate((s) => s.scrollWidth <= s.clientWidth)).toBe(true);
          await lote.scrollIntoViewIfNeeded();
          await page.screenshot({ path: testInfo.outputPath('lote-confirmacion.png') });
          await page.keyboard.press('Enter');
          await expect(lote.locator('.estado-lote')).toHaveText('Lote terminado: 2 de 2 confirmadas por el servidor.');
          await comprobarObjetivos(lote);
          expect(await seccion.evaluate((s) => s.scrollWidth <= s.clientWidth)).toBe(true);
          await page.screenshot({ path: testInfo.outputPath('lote-terminado.png') });
        });
    }
  }

  // Móvil en vertical (390×844 y 360×640), de día y de noche: capturas para revisarlas a ojo (salidas propias de
  // Playwright en testInfo.outputPath); no certifican contraste AA.
  for (const [ancho, alto] of [[390, 844], [360, 640]] as const) {
    for (const tema of ['claro', 'oscuro'] as const) {
      test(`N13 · ${ancho}×${alto} ${tema}: compartidas junto a las locales y su visor, 44 px, foco visible y sin desbordes`,
        async ({ page }, testInfo) => {
          await page.setViewportSize({ width: ancho, height: alto });
          await sembrarServidor(page, [{ s: remota(fotoUno, 'remota-uno.png', D_PARADA, 'image/png', pngVista), bytes: pngVista },
            { s: remota(fotoDos, 'remota-dos.png', D_PARADA, 'image/png', pngVista), bytes: pngVista }]);
          await abrirDestinos(page);
          await page.evaluate((t) => { document.documentElement.dataset.tema = t; }, tema);
          const b = bloqueDe(page, D_PARADA);
          await b.locator('[data-fotos-alternar]').focus();
          await page.keyboard.press('Enter');
          const celda = b.locator(`[data-foto-remota="${fotoUno}"]`);
          await expect(celda.locator('img')).toHaveCount(1);
          const selector = page.waitForEvent('filechooser');
          await b.locator('[data-fotos-anadir]').click();
          await (await selector).setFiles([{ name: 'calle.png', mimeType: 'image/png', buffer: pngVista }]);
          // Se mide con la vista previa local ya preparada: mientras dice «Preparando…» su celda se repinta.
          await expect(b.locator('[data-foto-id] img')).toHaveCount(1);
          await expect(b.locator('.fotos-remotas-estado')).toHaveText(VISTA_TEMPORAL);
          await comprobarObjetivos(b.locator('.fotos-panel'));
          expect(await b.evaluate((x) => x.scrollWidth <= x.clientWidth)).toBe(true);
          // La compartida se distingue de la local: contorno discontinuo frente a continuo.
          expect(await celda.evaluate((e) => getComputedStyle(e).borderTopStyle)).toBe('dashed');
          expect(await b.locator('[data-foto-id]').evaluate((e) => getComputedStyle(e).borderTopStyle)).toBe('solid');
          // Con teclado hasta la celda: anillo de foco visible.
          await celda.focus();
          await page.keyboard.press('Shift+Tab');
          await page.keyboard.press('Tab');
          await expect(celda).toBeFocused();
          expect(await focoVisible(celda)).toBe(true);
          await b.locator('.fotos-remotas').scrollIntoViewIfNeeded();
          await page.screenshot({ path: testInfo.outputPath('ficha-compartidas.png') });

          await page.keyboard.press('Enter');
          const visor = page.locator('#visor-foto');
          await expect(visor).toBeVisible();
          await expect(visor.locator('[data-visor-cerrar]')).toBeFocused();
          await expect(visor.locator('.visor-imagen img')).toHaveCount(1);
          await comprobarObjetivos(visor.locator('.visor-pie'));
          expect(await visor.evaluate((v) => v.scrollWidth <= v.clientWidth)).toBe(true);
          const guardar = visor.locator('[data-visor-guardar-remota]');
          await guardar.focus();
          expect(await focoVisible(guardar)).toBe(true);
          await page.screenshot({ path: testInfo.outputPath('visor-compartida.png') });
          await page.keyboard.press('Escape');
          await expect(celda).toBeFocused();
        });
    }
  }
});

test.describe('publicada (respaldo: null)', () => {
  const HORA = '2026-10-22T13:30:00+08:00';
  const PARADA = 'a42b37ab706683e8'; // Lingyin y Feilai Feng (día 22, Hangzhou)
  const opcionesMovil = { baseURL: 'http://localhost:4173', locale: 'es-ES', viewport: { width: 390, height: 844 },
    deviceScaleFactor: 2, isMobile: true, hasTouch: true, serviceWorkers: 'block' as const };

  test('N5 · la web publicada no muestra, consulta ni abre nada del respaldo', async ({ browser }) => {
    const contexto = await browser.newContext(opcionesMovil);
    await contexto.route(/^https?:\/\/(?!localhost)/, (r) => r.abort());
    await contexto.route((url) => url.pathname === '/api/progreso', (r) => r.abort());
    // Como en fotos.e2e.ts: este móvil ya marca, así que no hay pregunta inicial delante de la lista.
    await contexto.addInitScript(() => { if (localStorage.getItem('marcador') === null) localStorage.setItem('marcador', 'true'); });
    const page = await contexto.newPage();
    const rutas: string[] = [];
    const errores: string[] = [];
    page.on('request', (r) => rutas.push(new URL(r.url()).pathname));
    page.on('pageerror', (e) => errores.push(e.message));
    try {
      await page.clock.setFixedTime(new Date(HORA));
      await page.goto('/');
      await expect(page.locator('#contenido')).not.toBeEmpty();

      // Ficha, panel «Fotos» y visor: el texto de siempre y ningún bloque de respaldo.
      await page.locator('#contenido li.parada .fila', { hasText: 'Lingyin' }).click();
      await expect(page.locator('#contenido li.parada.abierta', { hasText: 'Lingyin' })).toBeVisible();
      const b = page.locator(`[data-fotos-destino="p:${PARADA}"]`);
      const alternar = b.locator('[data-fotos-alternar]');
      await alternar.scrollIntoViewIfNeeded();
      await alternar.click();
      await expect(b.locator('.fotos-nota')).toHaveText('Se guardan solo en este móvil y funcionan sin conexión. '
        + 'Por ahora no se comparten con el otro móvil ni tienen copia de seguridad.');
      const selector = page.waitForEvent('filechooser');
      await b.locator('[data-fotos-anadir]').click();
      await (await selector).setFiles([{ name: 'calle.png', mimeType: 'image/png', buffer: png }]);
      await expect(b.locator('[data-foto-id]')).toHaveCount(1);
      await b.locator('[data-foto-id]').click();
      const visor = page.locator('#visor-foto');
      await expect(visor).toBeVisible();
      await expect(visor.locator('.visor-respaldo')).toHaveCount(0);
      // Tampoco hay compartidas: ni sección, ni consulta por destino.
      await expect(b.locator('.fotos-remotas')).toHaveCount(0);
      await visor.locator('[data-visor-borrar]').click();
      await expect(visor.locator('.visor-confirmar p'))
        .toHaveText('¿Borrar esta foto de este móvil? Se borran el original y su vista previa; no se puede deshacer.');
      await visor.locator('[data-visor-cancelar]').click();
      await page.keyboard.press('Escape');
      await expect(visor).toBeHidden();

      // «Todo»: no existe «Fotos del viaje» ni, por tanto, «Respaldar pendientes».
      await page.locator('#dias [data-dia="todo"]').click();
      // «Todo» pintado (sus pendientes) y, en la publicada, sin «Compartido»: ni cliente de progreso ni red.
      await expect(page.locator('#pendientes')).toBeVisible();
      await expect(page.locator('#compartido')).toHaveCount(0);
      await expect(page.locator('#fotos-viaje')).toHaveCount(0);
      await expect(page.getByText('Fotos del viaje')).toHaveCount(0);
      await expect(page.getByText('Respaldar pendientes')).toHaveCount(0);

      // Cero red de fotos y ninguna base de respaldo creada en este móvil.
      expect(rutas.filter((r) => r.startsWith('/api/fotos'))).toEqual([]);
      const bases = await page.evaluate(async () => (await indexedDB.databases()).map((x) => x.name ?? ''));
      expect(bases.filter((n) => n.startsWith('itinerario-respaldo-fotos:'))).toEqual([]);
      expect(errores).toEqual([]);
    } finally {
      await contexto.close();
    }
  });
});
