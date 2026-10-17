import { test, expect, type Page } from '@playwright/test';
import { createServer, type Server } from 'node:https';
import type { IncomingMessage } from 'node:http';
import { TLSSocket } from 'node:tls';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { build, type Rollup } from 'vite';
import { PGlite } from '@electric-sql/pglite';
import worker, { type EntornoWorker } from '../servidor/worker';
import type { VinculoR2Fotos } from '../servidor/objetos-r2';
import { itinerario } from '../src/datos/itinerario';
import { crearProgreso } from '../src/progreso';
import { serializarProgreso } from '../src/progreso-json';
import { serializarSolicitudRespaldo, type SolicitudRespaldo } from '../src/fotos-protocolo';

// El padre ejecuta este fixture y posee sus artefactos temporales. Fuente sin UI productiva.
// TLS, fetch por defecto, cookie HMAC, Worker/router y SDK son reales localmente.
// SQL001–006: PGlite de una conexión/tx exterior; R2 y confianza CF-IP son MODELADOS.
// No COMMIT remoto, despliegue, cuota física, SameSite entre sitios ni teléfono certificado.
test.use({ ignoreHTTPSErrors: true });
let servidor: Server;
let origen: string;
let temporal: string;
let db: PGlite;
let entorno: EntornoWorker;
let fetchAnterior: typeof fetch;
let llamadas: string[] = [];
let consultasSql: string[] = [];
let respuestasListado: { status: number; cookie: string | null }[] = [];
let visitasDestino = 0;
let modo: 'normal' | 'redirect' | 'invalido' | 'truncado' | 'exceso' | 'pendiente' = 'normal';
let llegoStream: () => void;
let streamLlegado: Promise<void>;
let cerroStream: () => void;
let streamCerrado: Promise<void>;
const clave = 'clave-sintetica-local-listado-123456789';
const dsn = 'postgresql://viajero:fixture@ep-listado-test.eu-central-1.aws.neon.tech/viaje?sslmode=require';
// Imagen PNG 1×1 del fixture: no contenido de un usuario ni clave real.
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jSc0AAAAASUVORK5CYII=', 'base64');
const fotoUno = 'ABCDEF12-1234-4123-8123-123456789ABD';
const fotoDos = 'BBCDEF12-1234-4123-8123-123456789ABD';
function solicitud(fotoId = fotoUno): SolicitudRespaldo {
  return { version: 1, tipo: 'solicitud-respaldo', viajeId: itinerario.id,
    fotoId, operacionId: fotoId.slice(0, -1) + 'C', original: { formato: 1, fotoId,
      destino: { tipo: 'parada', viajeId: itinerario.id, paradaId: itinerario.dias[0].paradas[0].id },
      nombre: '\0 e\u0301 .png', mimeDeclarado: 'image/png', incorporada: -0,
      ultimaModificacion: -0, bytesOriginal: png.length } };
}
class BucketFixture implements VinculoR2Fotos {
  readonly objetos = new Map<string, Blob>();
  readonly eventos: string[] = [];
  async put(key: string, blob: Blob, opciones: Parameters<VinculoR2Fotos['put']>[2]) {
    this.eventos.push('put'); expect(opciones.onlyIf.get('If-None-Match')).toBe('*');
    expect(opciones.httpMetadata).toEqual({ contentType: 'application/octet-stream' });
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

test.beforeAll(async () => {
  // Timeout propio de preparación del fixture, con la API de hooks de Playwright.
  test.setTimeout(60000);
  db = await PGlite.create('memory://');
  for (const n of ['001_base.sql', '002_progreso.sql', '003_sesiones.sql', '004_limite.sql', '005_fotos.sql', '006_listado_fotos.sql'])
    await db.exec(await readFile(new URL('../servidor/migraciones/' + n, import.meta.url), 'utf8'));
  await db.query('INSERT INTO itinerario.viajes VALUES ($1,0,$2)', [itinerario.id, serializarProgreso(crearProgreso(itinerario))]);
  const resultado = await build({ configFile: false, logLevel: 'silent', build: { write: false, minify: false,
    rollupOptions: { preserveEntrySignatures: 'strict', input: {
      listado: 'src/fotos-listado.ts', descarga: 'src/fotos-descarga.ts', local: 'src/fotos-local.ts',
      ledger: 'src/fotos-respaldo-local.ts', progreso: 'src/progreso-local.ts', protocolo: 'src/fotos-protocolo.ts',
      plan: 'src/datos/itinerario.ts', portable: 'src/portabilidad-local.ts', historia: 'src/portabilidad-historico.ts',
    }, output: { entryFileNames: '[name].js', chunkFileNames: 'fragmento-[hash].js' } },
  } });
  const salida = (Array.isArray(resultado) ? resultado[0] : resultado) as Rollup.RollupOutput;
  const archivos = new Map(salida.output.filter((a) => a.type === 'chunk').map((a) => [a.fileName, a.code]));
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
    consultasSql.push(datos.query);
    const r = await db.query<{ resultado: string }>(datos.query, datos.params);
    return new Response(JSON.stringify({ command: 'SELECT', rowCount: r.rows.length,
      fields: [{ name: 'resultado', dataTypeID: 25, tableID: 0, columnID: 0,
        dataTypeSize: -1, dataTypeModifier: -1, format: 'text' }], rows: r.rows.map((fila) => [String(fila.resultado)]) }));
  };
  // Sólo el proceso padre ejecuta generación/lectura/limpieza de estos archivos de fixture.
  temporal = await mkdtemp(join(tmpdir(), 'itinerario-listado-tls-'));
  // Un archivo real evita reabrir /dev/stdin, que falla desde Node en Linux.
  await writeFile(join(temporal, 'configuracion-tls.cnf'), '[req]\nprompt=no\ndistinguished_name=dn\nx509_extensions=ext\n[dn]\nCN=127.0.0.1\n[ext]\nsubjectAltName=IP:127.0.0.1\nbasicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature,keyEncipherment\nextendedKeyUsage=serverAuth\n');
  execFileSync('/usr/bin/openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-sha256', '-days', '1',
    '-config', join(temporal, 'configuracion-tls.cnf'), '-keyout', join(temporal, 'clave-fixture.pem'), '-out', join(temporal, 'certificado-fixture.pem')],
  { stdio: ['pipe', 'pipe', 'pipe'] });
  servidor = createServer({ key: await readFile(join(temporal, 'clave-fixture.pem')),
    cert: await readFile(join(temporal, 'certificado-fixture.pem')), highWaterMark: 65536 }, async (req, res) => {
    const ruta = new URL(req.url!, origen).pathname;
    // Dos páginas vacías públicas EXCLUSIVAS del fixture, sin código ni interfaz de producto.
    if (ruta === '/entrar' || ruta === '/publico-fixture') {
      res.setHeader('Content-Type', 'text/html'); res.setHeader('Cache-Control', 'no-store');
      res.end('<!doctype html><title>Fixture de catálogo privado</title>'); return;
    }
    if (ruta === '/destino-fixture') { visitasDestino++; res.end('No visitar'); return; }
    try {
      if (ruta.startsWith('/api/')) llamadas.push(req.url!);
      const r = await worker.fetch(adaptar(req), entorno);
      if (ruta === '/api/fotos/listado') {
        respuestasListado.push({ status: r.status, cookie: r.headers.get('Set-Cookie') });
        if (modo === 'redirect') { res.writeHead(303, { Location: '/destino-fixture' }); res.end(); return; }
        res.writeHead(r.status, Object.fromEntries(r.headers));
        if (modo === 'pendiente') {
          res.on('close', () => cerroStream()); res.write('{'); llegoStream(); return;
        }
        const texto = await r.text();
        const cuerpo = modo === 'invalido' ? 'false' : modo === 'truncado' ? texto.slice(0, -1)
          : modo === 'exceso' ? ' '.repeat(404232) : texto;
        for (let i = 0; i < cuerpo.length; i += 65536) res.write(cuerpo.slice(i, i + 65536));
        res.end(); return;
      }
      res.writeHead(r.status, Object.fromEntries(r.headers)); res.end(Buffer.from(await r.arrayBuffer()));
    } catch (e) { res.destroy(e instanceof Error ? e : new Error('Fixture fallido')); }
    finally { req.resume(); }
  });
  await new Promise<void>((ok) => servidor.listen(0, '127.0.0.1', ok));
  const direccion = servidor.address(); if (!direccion || typeof direccion === 'string') throw new Error('Sin puerto propio');
  origen = `https://127.0.0.1:${direccion.port}`;
  entorno = { CLAVE_COMPARTIDA: clave, URL_BASE_DATOS: dsn,
    ASSETS: { async fetch(r) {
      const codigo = archivos.get(new URL(r.url).pathname.slice(1));
      return codigo === undefined ? new Response('No encontrado', { status: 404 })
        : new Response(codigo, { headers: { 'Content-Type': 'text/javascript' } });
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
  modo = 'normal'; llamadas = []; consultasSql = []; respuestasListado = []; visitasDestino = 0;
  streamLlegado = new Promise<void>((ok) => { llegoStream = ok; });
  streamCerrado = new Promise<void>((ok) => { cerroStream = ok; });
  await page.route('**/*', (r) => new URL(r.request().url()).origin === origen ? r.continue() : r.abort());
  await page.goto(origen + '/entrar');
});
test.afterEach(async ({ page }) => {
  await page.evaluate(() => { window.fixtureListado?.c.cerrar(); window.fixtureListado?.fotos.cerrar();
    window.fixtureListado?.ledger.cerrar(); window.fixtureListado?.progreso.cerrar(); });
  // Aislamiento exclusivamente de esta conexión efímera. Snapshots se comparan ANTES.
  await db.exec('ROLLBACK');
});

interface FixtureListado {
  c: import('../src/fotos-listado').ListadoFotos;
  crear: typeof import('../src/fotos-listado').crearClienteListadoFotos;
  descarga: typeof import('../src/fotos-descarga');
  protocolo: typeof import('../src/fotos-protocolo');
  plan: typeof itinerario;
  fotos: import('../src/fotos-local').FotosLocal;
  ledger: import('../src/fotos-respaldo-local').RespaldoFotosLocal;
  progreso: import('../src/progreso-local').ProgresoLocal;
  exportador: import('../src/portabilidad-local').ExportadorLocal;
  historia: import('../src/portabilidad-historico').PortabilidadHistorica;
  limites: import('../src/fotos-listado').PresupuestoListadoFotosCliente;
  ultima?: import('../src/fotos-listado-protocolo').PaginaListadoFotos;
  pendiente?: Promise<import('../src/fotos-listado').ResultadoListadoFotosCliente>;
}
declare global { interface Window { fixtureListado: FixtureListado } }
async function login(page: Page, dispositivoId: string) {
  const resultado = await page.evaluate(async ({ clave, dispositivoId }) => {
    const r = await fetch('/api/sesion', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ clave, dispositivoId }) }); return r.status;
  }, { clave, dispositivoId });
  expect(resultado).toBe(201);
}
async function preparar(page: Page) {
  await login(page, 'editor-uno');
  const recibos: unknown[] = [];
  for (const fotoId of [fotoUno, fotoDos]) {
    const resultado = await page.evaluate(async ({ texto, datos }) => {
      const form = new FormData(); form.append('solicitud', texto);
      form.append('original', new Blob([new Uint8Array(datos)], { type: 'application/octet-stream' }), 'original');
      const r = await fetch('/api/fotos/respaldo', { method: 'POST', body: form });
      return { status: r.status, texto: await r.text() };
    }, { texto: serializarSolicitudRespaldo(itinerario, solicitud(fotoId)), datos: [...png] });
    expect(resultado.status).toBe(201); recibos.push(JSON.parse(resultado.texto));
  }
  await login(page, 'editor-dos');
  await page.evaluate(async ({ fotoDos, reciboDos, datos }) => {
    const [listado, descarga, local, ledger, progreso, protocolo, plan, portable, historico] = await Promise.all(
      ['/listado.js', '/descarga.js', '/local.js', '/ledger.js', '/progreso.js', '/protocolo.js', '/plan.js', '/portable.js', '/historia.js'].map((r) => import(r)));
    const p = plan.itinerario; const fotos = await local.abrirFotosLocal(p);
    const respaldo = await ledger.abrirRespaldoFotosLocal(p, fotos);
    const progresoLocal = await progreso.abrirProgresoLocal(p, { dispositivoId: 'local-listado' });
    const ref = reciboDos.original;
    const captura = { metadatos: { ...ref, miniatura: { tipo: 'pendiente' } }, original: new Blob([new Uint8Array(datos)], { type: 'image/png' }) };
    await fotos.guardarOriginal(captura);
    const referenciaDos = await respaldo.preparar(captura, reciboDos.operacionId);
    if (referenciaDos.fase !== 'preparado') throw new Error('Se esperaba preparación de fixture');
    await respaldo.marcarEnviada({ fotoId: referenciaDos.fotoId, operacionId: referenciaDos.operacionId,
      original: referenciaDos.original });
    // Seed local exclusivo del fixture, después de su POST: no certifica el orden de un emisor.
    // El acuse procede del POST autenticado real, no del catálogo ni de un archivo.
    await respaldo.confirmarRecibo(reciboDos);
    const otroId = 'CBCDEF12-1234-4123-8123-123456789ABD';
    const enviada = { metadatos: { ...captura.metadatos, fotoId: otroId }, original: captura.original };
    await fotos.guardarOriginal(enviada);
    const entrada = await respaldo.preparar(enviada, 'CBCDEF12-1234-4123-8123-123456789ABC');
    if (entrada.fase !== 'preparado') throw new Error('Se esperaba preparación de fixture');
    await respaldo.marcarEnviada({ fotoId: entrada.fotoId, operacionId: entrada.operacionId,
      original: entrada.original });
    const id = 'progreso-enviado-fixture';
    await progresoLocal.registrar({ id, dispositivoId: 'local-listado', tipo: 'parada', paradaId: p.dias[0].paradas[0].id,
      marca: 'hecha', revision: 0, horaReal: -0 });
    await progresoLocal.marcarEnviada(id);
    await fotos.guardarMiniatura(fotoDos, new Blob([new Uint8Array(datos)], { type: 'image/png' }), 1, 1);
    localStorage.setItem('marcas', '{"anterior":"e\\u0301\\u0000"}');
    localStorage.setItem('marcas-hora', '{"anterior":-0}'); localStorage.setItem('pendientes-hechos', '["anterior"]');
    const cache = await caches.open('fixture-listado'); await cache.put('/sentinela', new Response('cache-anterior'));
    const limitesPortable = { maxRegistros: 1000, maxBytesMetadatos: 4194304, maxBytesArchivo: 8388608, maxProfundidad: 64 };
    const limitesHistoria = { maxImportaciones: 10, maxObservaciones: 100, maxProcedencias: 100, maxBytesHistoria: 16777216 };
    const exportador = portable.crearExportadorLocal({ plan: p, limites: limitesPortable, limitesHistoria,
      leerLegado: (campo: string) => localStorage.getItem(campo) });
    const historia = historico.crearPortabilidadHistorica({ plan: p, limites: limitesPortable, limitesHistoria });
    const archivo = (await exportador.exportarActual()).archivo;
    const archivada = await historia.archivar(archivo.archivo);
    if (archivada.historia !== 'confirmada') throw new Error('Historia de fixture no confirmada');
    const limites = { maxFilas: 1, maxBytesPagina: 404231, maxBytesChunk: 4194304, maxBytesBackingChunk: 4194304,
      maxLecturas: 65536, maxBytesPlan: 4194304, maxBytesRetenidos: 512 * 1024 ** 2, plazoMs: 10000 };
    // Sin http inyectado: fetch nativo del navegador y Response.url genuina.
    const c = listado.crearClienteListadoFotos({ plan: p, origen: location.origin, presupuesto: limites });
    window.fixtureListado = { c, crear: listado.crearClienteListadoFotos, descarga, protocolo, plan: p,
      fotos, ledger: respaldo, progreso: progresoLocal, exportador, historia, limites };
  }, { fotoDos, reciboDos: recibos[1] as import('../src/fotos-protocolo').SolicitudRespaldo, datos: [...png] });
  // Verifica atributos del cookie en el almacén del navegador; JS no recibe HttpOnly.
  const cookies = await page.context().cookies(origen);
  expect(cookies.some((c) => c.name.startsWith('__Host-') && c.secure && c.httpOnly && c.sameSite === 'Lax' && c.path === '/')).toBe(true);
  expect(await page.evaluate(() => document.cookie)).not.toContain('__Host-');
  llamadas = []; consultasSql = []; respuestasListado = []; bucket.eventos.length = 0;
}
async function listar(page: Page, continuacion: string | null = null) {
  return page.evaluate(async (cursor) => {
    const f = window.fixtureListado; const r = await f.c.listar(cursor);
    if (r.tipo === 'pagina') f.ultima = r.pagina;
    return r;
  }, continuacion);
}
async function snapshotServidor() {
  const tablas = ['viajes', 'sesiones', 'decisiones', 'intentos_sesion', 'fotos_reservas', 'fotos_operaciones'];
  const sql = [];
  for (const t of tablas) sql.push([t, (await db.query(`SELECT * FROM itinerario.${t} ORDER BY 1,2`)).rows]);
  const objetos = [];
  for (const [k, b] of bucket.objetos) objetos.push([k, Buffer.from(await b.arrayBuffer()).toString('base64')]);
  return { sql, objetos };
}
async function snapshotLocal(page: Page) {
  return page.evaluate(async () => {
    const f = window.fixtureListado;
    const actual = (await f.exportador.exportarActual()).archivo;
    const historia = await f.historia.listar();
    const cache = await caches.open('fixture-listado');
    return { archivo: [...new Uint8Array(await actual.archivo.arrayBuffer())],
      historia: await Promise.all(historia.map(async (h) => ({ trabajoId: h.trabajoId,
        archivo: [...new Uint8Array(await h.archivo.arrayBuffer())], observaciones: h.observaciones, procedencias: h.procedencias }))),
      ledger: await f.ledger.listar(), progreso: await f.progreso.leer(),
      legado: ['marcas', 'marcas-hora', 'pendientes-hechos'].map((k) => [k, localStorage.getItem(k)]),
      caches: await caches.keys(), cache: await (await cache.match('/sentinela'))!.text(),
      clavesCache: (await cache.keys()).map((r) => r.url), bases: (await indexedDB.databases()).map((b) => [b.name, b.version]).sort() };
  });
}

test('default fetch y cookie HMAC: una página manual, sin continuar ni leer R2', async ({ page }) => {
  await preparar(page); const antes = await snapshotServidor();
  const primera = await listar(page); expect(primera.tipo).toBe('pagina');
  if (primera.tipo !== 'pagina') throw new Error('Sin página');
  expect(primera.pagina.solicitudesIniciales).toEqual([serializarSolicitudRespaldo(itinerario, solicitud())]);
  expect(typeof primera.pagina.continuacion).toBe('string');
  expect(llamadas).toEqual(['/api/fotos/listado']);
  expect(consultasSql.filter((q) => q.includes('listar_fotos_confirmadas'))).toHaveLength(1);
  expect(consultasSql.filter((q) => q.includes('leer_sesion'))).toHaveLength(2); expect(consultasSql).toHaveLength(3);
  expect(bucket.eventos).toEqual([]); expect(respuestasListado).toEqual([{ status: 200, cookie: null }]);
  const segunda = await listar(page, primera.pagina.continuacion);
  expect(segunda).toEqual({ tipo: 'pagina', pagina: { version: 1, tipo: 'listado-respaldos', viajeId: itinerario.id,
    solicitudesIniciales: [serializarSolicitudRespaldo(itinerario, solicitud(fotoDos))], continuacion: null } });
  expect(llamadas).toHaveLength(2); expect(bucket.eventos).toEqual([]); expect(await snapshotServidor()).toEqual(antes);
});
test('sin sesión no navega al login ni sigue otra ruta', async ({ page }) => {
  await preparar(page); await page.context().clearCookies(); const url = page.url();
  expect(await listar(page)).toEqual({ tipo: 'fallida', motivo: 'sin-sesion' });
  expect(page.url()).toBe(url); expect(llamadas).toEqual(['/api/fotos/listado']); expect(bucket.eventos).toEqual([]);
});
test('redirect error nunca visita el destino', async ({ page }) => {
  await preparar(page); modo = 'redirect'; expect((await listar(page)).tipo).toBe('fallida');
  expect(visitasDestino).toBe(0); expect(llamadas).toEqual(['/api/fotos/listado']); expect(bucket.eventos).toEqual([]);
});
test('cuerpos nativos inválidos, truncados y excesivos no se importan', async ({ page }) => {
  await preparar(page); const antes = await snapshotLocal(page);
  for (const caso of ['invalido', 'truncado', 'exceso'] as const) {
    modo = caso; expect(await listar(page)).toEqual({ tipo: 'fallida', motivo: caso === 'exceso' ? 'presupuesto-excedido' : 'formato-invalido' });
  }
  expect(llamadas).toHaveLength(3); expect(bucket.eventos).toEqual([]); expect(await snapshotLocal(page)).toEqual(antes);
});
test('aborto y plazo cierran el stream nativo sin retry', async ({ page }) => {
  await preparar(page); modo = 'pendiente';
  await page.evaluate(() => { const f = window.fixtureListado; f.pendiente = f.c.listar(null); });
  await streamLlegado;
  const abortada = await page.evaluate(async () => { const f = window.fixtureListado; f.c.cancelar(); return f.pendiente; });
  expect(abortada).toEqual({ tipo: 'detenida', motivo: 'cancelada' }); await streamCerrado;
  streamLlegado = new Promise<void>((ok) => { llegoStream = ok; }); streamCerrado = new Promise<void>((ok) => { cerroStream = ok; });
  await page.evaluate(() => { const f = window.fixtureListado; f.c.cerrar();
    f.c = f.crear({ plan: f.plan, origen: location.origin, presupuesto: { ...f.limites, plazoMs: 1000 } });
    f.pendiente = f.c.listar(null); });
  await streamLlegado;
  expect(await page.evaluate(() => window.fixtureListado.pendiente)).toEqual({ tipo: 'detenida', motivo: 'plazo' });
  await streamCerrado; expect(llamadas).toHaveLength(2); expect(bucket.eventos).toEqual([]);
});
test('metadata conserva PhotoDB, ledger, SENT, progreso, historia, legado y caches no vacíos', async ({ page }) => {
  await preparar(page); const local = await snapshotLocal(page); const servidor = await snapshotServidor();
  expect(local.historia).toHaveLength(1); expect(local.ledger).toHaveLength(2);
  expect(local.ledger.some((r) => r.fase === 'respaldada')).toBe(true);
  expect(local.ledger.some((r) => r.fase === 'enviada')).toBe(true);
  expect(local.progreso.cola.length).toBeGreaterThan(0); expect(local.archivo.length).toBeGreaterThan(0);
  expect((await listar(page)).tipo).toBe('pagina');
  expect(await snapshotLocal(page)).toEqual(local); expect(await snapshotServidor()).toEqual(servidor);
  expect(bucket.eventos).toEqual([]);
});
test('original sin metadata local requiere segunda acción explícita; guardar no confirma ledger', async ({ page }) => {
  await preparar(page); const antes = await snapshotServidor(); const local = await snapshotLocal(page);
  expect(await page.evaluate((id) => window.fixtureListado.fotos.leerMetadatos(id), fotoUno)).toBeNull();
  expect((await listar(page)).tipo).toBe('pagina'); expect(bucket.eventos).toEqual([]);
  expect(await page.evaluate((id) => window.fixtureListado.fotos.leerMetadatos(id), fotoUno)).toBeNull();
  const r = await page.evaluate(async () => {
    const f = window.fixtureListado;
    const original = f.protocolo.deserializarSolicitudRespaldo(f.plan, f.ultima!.solicitudesIniciales[0]).original;
    const d = f.descarga.crearDescargaFotos({ plan: f.plan, origen: location.origin, fotos: f.fotos });
    try {
      const resultado = await d.descargar(original);
      const bytes = await f.fotos.leerOriginal(original.fotoId);
      return { tipo: resultado.tipo, metadatos: await f.fotos.leerMetadatos(original.fotoId),
        bytes: bytes && [...new Uint8Array(await bytes.arrayBuffer())], ledger: await f.ledger.listar(),
        progreso: await f.progreso.leer() };
    } finally { d.cerrar(); }
  });
  expect(r.tipo).toBe('guardada'); expect(r.bytes).toEqual([...png]); expect(r.metadatos).not.toBeNull();
  expect(r.ledger).toEqual(local.ledger); expect(r.progreso).toEqual(local.progreso);
  expect(llamadas).toEqual(['/api/fotos/listado', `/api/fotos/${fotoUno}/original`]);
  expect(bucket.eventos).toEqual(['get']); expect(await snapshotServidor()).toEqual(antes);
});
