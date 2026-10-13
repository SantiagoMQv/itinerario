// Respaldo manual y catálogo DESDE LA INTERFAZ. Dos partes:
// 1. «nativa con Worker real»: TLS local, fetch por defecto, cookie HMAC, Worker/router y SDK→PGlite (SQL001–006),
//    como en fotos-listado.e2e.ts; R2 y la confianza CF-IP son MODELADOS. La página es EXCLUSIVA del fixture: una
//    entrada virtual de Vite (sin módulo semilla, alias, dependencias ni configuración del proyecto) que monta la
//    interfaz real de fotos con composición explícita del respaldo.
// 2. «publicada»: la web compilada (vite preview, 4173) con respaldo: null → 0 red de fotos, 0 ledger, 0 texto nuevo.
// El padre ejecuta este archivo y posee sus temporales (mkdtemp itinerario-respaldo-ui-tls-*, borrado en afterAll).
// No prueba despliegue, COMMIT remoto, cuota física, SameSite entre sitios ni teléfono real.
import { test, expect, type Locator, type Page } from '@playwright/test';
import { createServer, type Server } from 'node:https';
import type { IncomingMessage } from 'node:http';
import { TLSSocket } from 'node:tls';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
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
import { COPIA_RESPALDADA, COPIA_SIN_CONFIRMAR } from '../src/fotos-respaldo-interfaz';

// Imagen PNG 1×1 del fixture: no contenido de un usuario ni clave real.
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jSc0AAAAASUVORK5CYII=', 'base64');
const BASE_LEDGER = `itinerario-respaldo-fotos:${encodeURIComponent(itinerario.id)}`;
const BASE_FOTOS = `itinerario-fotos:${encodeURIComponent(itinerario.id)}`;
const RESPALDADA = 'Respaldada: el servidor confirmó la copia.';
const FINAL_BORRADO = 'Si la borras, este móvil no podrá volver a guardarla. No se puede deshacer.';
declare global { interface Window { fixtureUi?: { readonly listo: true } } }

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
  /** Fotos respaldadas «desde el otro móvil», con el mismo destino que el bloque del fixture. */
  function remota(fotoId: string, nombre: string): SolicitudRespaldo {
    return { version: 1, tipo: 'solicitud-respaldo', viajeId: itinerario.id, fotoId, operacionId: fotoId.slice(0, -1) + 'c',
      original: { formato: 1, fotoId, destino: { tipo: 'parada', viajeId: itinerario.id, paradaId: itinerario.dias[0].paradas[0].id },
        nombre, mimeDeclarado: 'image/png', incorporada: 1_000, ultimaModificacion: 5, bytesOriginal: png.length } };
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
const ui = crearFotosUi({ plan: itinerario, contenido,
  nombreDe: (d) => paradas.find((p) => p.id === d.paradaId)?.nombre ?? 'esta parada',
  anunciar: (texto) => { aviso.textContent = texto; },
  respaldo: { origen: location.origin, listado: { maxFilas: 1, maxBytesPagina: 404231, maxBytesChunk: 1048576,
    maxBytesBackingChunk: 1048576, maxLecturas: 4096, maxBytesPlan: 4194304, maxBytesRetenidos: 134217728, plazoMs: 30000 } } });
const destino = { tipo: 'parada', viajeId: itinerario.id, paradaId: paradas[0].id };
contenido.innerHTML = ui.html(destino) + '<section class="seccion fotos-viaje" id="fotos-viaje" data-fotos-viaje></section>';
ui.montarFotosViaje(contenido.querySelector('[data-fotos-viaje]'));
contenido.addEventListener('click', (e) => { ui.manejarClic(e.target); });
addEventListener('keydown', (e) => { if (e.key === 'Escape') ui.cerrarVisor(); });
addEventListener('popstate', () => { ui.cerrarVisor(true); });
ui.preparar();
window.fixtureUi = { listo: true };
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
    for (const n of ['001_base.sql', '002_progreso.sql', '003_sesiones.sql', '004_limite.sql', '005_fotos.sql', '006_listado_fotos.sql'])
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
    execFileSync('/usr/bin/openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-sha256', '-days', '1',
      '-config', '/dev/stdin', '-keyout', join(temporal, 'clave-fixture.pem'), '-out', join(temporal, 'certificado-fixture.pem')],
    { input: '[req]\nprompt=no\ndistinguished_name=dn\nx509_extensions=ext\n[dn]\nCN=127.0.0.1\n[ext]\nsubjectAltName=IP:127.0.0.1\nbasicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature,keyEncipherment\nextendedKeyUsage=serverAuth\n', stdio: ['pipe', 'pipe', 'pipe'] });
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
  /** Dos fotos confirmadas por el otro móvil (POST autenticado real); después, este móvil entra con su sesión. */
  async function sembrarServidor(page: Page) {
    await login(page, 'editor-uno');
    for (const s of [remota(fotoUno, 'remota-uno.png'), remota(fotoDos, 'remota-dos.png')]) {
      const status = await page.evaluate(async ({ texto, datos }) => {
        const form = new FormData(); form.append('solicitud', texto);
        form.append('original', new Blob([new Uint8Array(datos)], { type: 'application/octet-stream' }), 'original');
        return (await fetch('/api/fotos/respaldo', { method: 'POST', body: form })).status;
      }, { texto: serializarSolicitudRespaldo(itinerario, s), datos: [...png] });
      expect(status).toBe(201);
    }
    await login(page, 'editor-dos');
    llamadas = []; bucket.eventos.length = 0;
  }
  async function abrirFixture(page: Page) {
    await page.goto(origen + '/fixture-respaldo');
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
    // Abrir la página, el bloque y el visor no consulta, envía ni reintenta nada.
    expect(llamadas).toEqual([]);
    expect(await ledgerNavegador(page)).toEqual([]);

    await respaldar.click();
    await expect(visor.locator('.visor-aviso')).toHaveText(RESPALDADA);
    await expect(visor.locator('.visor-respaldo-nota')).toHaveText(COPIA_RESPALDADA);
    await expect(visor.locator('.visor-respaldo-acciones')).toBeHidden();
    expect(llamadas).toEqual(['POST /api/fotos/respaldo']);
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
    expect(llamadas).toEqual([]);
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
      expect(llamadas).toEqual(['POST /api/fotos/respaldo']);
      const eventosTrasFallo = [...bucket.eventos];

      // Reabrir la app: la incertidumbre y el registro siguen EXACTAMENTE igual y no sale ningún POST solo.
      await abrirFixture(page);
      await expect(page.locator('.estado-fotos-viaje')).toHaveText('1 sin confirmar');
      const reabierto = await abrirVisor(page);
      await expect(reabierto.locator('.visor-respaldo-nota')).toHaveText(COPIA_SIN_CONFIRMAR);
      expect(await ledgerNavegador(page)).toEqual(ledgerTrasFallo);
      expect(llamadas).toEqual(['POST /api/fotos/respaldo']);
      expect(bucket.eventos).toEqual(eventosTrasFallo);

      // Reintento MANUAL desde el visor reabierto: la misma operación.
      const aviso = reabierto.locator('.visor-aviso');
      await reabierto.locator('[data-visor-reanudar]').click();
      await expect(aviso).toHaveText(caso.final === 'respaldada' ? RESPALDADA : COPIA_SIN_CONFIRMAR);
      expect(llamadas).toEqual(['POST /api/fotos/respaldo', 'POST /api/fotos/respaldo']);
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
    expect(llamadas).toEqual(['POST /api/fotos/respaldo']);
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
    expect(llamadas).toEqual(['POST /api/fotos/respaldo']);

    // Al recargar, «Todo» sigue contando ese envío sin confirmar; nada se envía, consulta ni descarga solo.
    await abrirFixture(page);
    await expect(page.locator('.estado-fotos-viaje')).toHaveText('1 sin confirmar');
    const fila = page.locator('.filas-resumen li');
    await expect(fila).toHaveCount(1);
    await expect(fila).toContainText('«calle.png»');
    expect(await ledgerNavegador(page)).toEqual(ledger);
    expect(await fotoNavegador(page, fotoId)).toEqual(borrada);
    expect(llamadas).toEqual(['POST /api/fotos/respaldo']);
    expect(bucket.eventos).toEqual(eventosAntes);
  });
});

test.describe('publicada (respaldo: null)', () => {
  const HORA = '2026-10-22T13:30:00+08:00';
  const PARADA = 'c80e3471f9ab562d'; // Middle Huaihai Road: TX Huaihai
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
      await page.locator('#contenido li.parada .fila', { hasText: 'TX Huaihai' }).click();
      await expect(page.locator('#contenido li.parada.abierta', { hasText: 'TX Huaihai' })).toBeVisible();
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
      await visor.locator('[data-visor-borrar]').click();
      await expect(visor.locator('.visor-confirmar p'))
        .toHaveText('¿Borrar esta foto de este móvil? Se borran el original y su vista previa; no se puede deshacer.');
      await visor.locator('[data-visor-cancelar]').click();
      await page.keyboard.press('Escape');
      await expect(visor).toBeHidden();

      // «Todo»: no existe «Fotos del viaje».
      await page.locator('#dias [data-dia="todo"]').click();
      await expect(page.locator('#compartido')).toHaveCount(1);
      await expect(page.locator('#fotos-viaje')).toHaveCount(0);
      await expect(page.getByText('Fotos del viaje')).toHaveCount(0);

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
