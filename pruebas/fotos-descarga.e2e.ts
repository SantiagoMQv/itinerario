import { test, expect, type Page } from '@playwright/test';
import { createServer, type Server } from 'node:http';
import { build, type Rollup } from 'vite';

// Chromium, HTTP loopback e IndexedDB reales en contextos de prueba propios. No proveedor ni UI.
// Bundle actual en memoria; Playwright compila además dist con su webServer normal.
let servidor: Server;
let origen: string;
let modo: 'normal' | 'exceso' | 'truncado' | 'redirect' | 'pendiente' = 'normal';
let solicitudes: { ruta: string; metodo: string; accept?: string; cookie?: string }[] = [];
let visitasPublicas = 0;
let entrar: () => void;
let cabeceras: Promise<void>;
let cerrarStream: () => void;
let streamCerrado: Promise<void>;
const payload = Buffer.alloc((1 << 20) + 5, 23);
payload[0] = 0; payload[payload.length - 1] = 255;

test.beforeAll(async () => {
  const resultado = await build({ configFile: false, logLevel: 'silent', build: {
    write: false, minify: false, rollupOptions: { preserveEntrySignatures: 'strict', input: {
      descarga: 'src/fotos-descarga.ts', local: 'src/fotos-local.ts', plan: 'src/datos/itinerario.ts',
      respaldo: 'src/fotos-respaldo-local.ts', progreso: 'src/progreso-local.ts',
    }, output: { entryFileNames: '[name].js', chunkFileNames: 'fragmento-[hash].js' } },
  } });
  const salida = (Array.isArray(resultado) ? resultado[0] : resultado) as Rollup.RollupOutput;
  const archivos = new Map(salida.output.filter((o) => o.type === 'chunk').map((o) => [o.fileName, o.code]));
  servidor = createServer((req, res) => {
    const ruta = new URL(req.url!, 'http://local').pathname;
    res.setHeader('Cache-Control', 'no-store');
    if (archivos.has(ruta.slice(1))) {
      res.setHeader('Content-Type', 'text/javascript'); res.end(archivos.get(ruta.slice(1))); return;
    }
    if (ruta === '/') { res.setHeader('Content-Type', 'text/html'); res.end('<!doctype html><title>Descarga local</title>'); return; }
    if (ruta === '/publico') { visitasPublicas++; res.end(payload); return; }
    if (!/^\/api\/fotos\/[0-9a-f-]+\/original$/.test(ruta) || req.method !== 'GET') {
      res.statusCode = 404; res.end(); return;
    }
    solicitudes.push({ ruta, metodo: req.method, accept: req.headers.accept, cookie: req.headers.cookie });
    if (modo === 'redirect') { res.statusCode = 303; res.setHeader('Location', '/publico'); res.end(); return; }
    res.setHeader('Content-Type', 'application/octet-stream'); res.setHeader('X-Content-Type-Options', 'nosniff');
    if (modo === 'pendiente') {
      res.on('close', () => cerrarStream()); res.write(payload.subarray(0, 1)); entrar(); return;
    }
    if (modo === 'truncado') { res.write(payload.subarray(0, payload.length - 1)); res.end(); return; }
    // write+end para transferencia nativa por stream sin depender de Content-Length.
    res.write(payload.subarray(0, 700000));
    res.write(payload.subarray(700000));
    res.end(modo === 'exceso' ? Buffer.from([99]) : undefined);
  });
  await new Promise<void>((ok) => servidor.listen(0, '127.0.0.1', ok));
  const direccion = servidor.address();
  if (!direccion || typeof direccion === 'string') throw new Error('Sin puerto loopback');
  origen = `http://127.0.0.1:${direccion.port}`;
});
test.afterAll(async () => {
  if (servidor) await new Promise<void>((ok, no) => servidor.close((e) => e ? no(e) : ok()));
});
test.beforeEach(async ({ page }) => {
  modo = 'normal'; solicitudes = []; visitasPublicas = 0;
  cabeceras = new Promise<void>((ok) => { entrar = ok; });
  streamCerrado = new Promise<void>((ok) => { cerrarStream = ok; });
  // Ninguna request sale del servidor propio; no navegación a recursos externos.
  await page.route('**/*', (r) => new URL(r.request().url()).origin === origen ? r.continue() : r.abort());
  await page.goto(origen);
});

async function cargar(page: Page) {
  await page.evaluate(async () => {
    const [descarga, local, plan, respaldo, progreso] = await Promise.all(
      ['/descarga.js', '/local.js', '/plan.js', '/respaldo.js', '/progreso.js'].map((ruta) => import(ruta)));
    const p = plan.itinerario;
    const fotos = await local.abrirFotosLocal(p);
    const ref = { formato: 1, fotoId: '12345678-1234-4123-8123-123456789abc', destino: {
      tipo: 'parada', viajeId: p.id, paradaId: p.dias[0].paradas[0].id,
    }, nombre: '\0 e\u0301 ', mimeDeclarado: 'image/heic', ultimaModificacion: -0,
    incorporada: -0, bytesOriginal: (1 << 20) + 5 };
    const d = descarga.crearDescargaFotos({ plan: p, origen: location.origin, fotos });
    Object.assign(window, { fixtureDescarga: { descarga, local, respaldo, progreso, p, fotos, ref, d } });
  });
}

// El fixture reside solo en este contexto efímero; nunca toca datos de usuarios existentes.
interface FixtureNativo {
  descarga: typeof import('../src/fotos-descarga');
  local: typeof import('../src/fotos-local');
  respaldo: typeof import('../src/fotos-respaldo-local');
  progreso: typeof import('../src/progreso-local');
  p: typeof import('../src/datos/itinerario').itinerario;
  fotos: import('../src/fotos-local').FotosLocal;
  ref: import('../src/fotos-respaldo').OriginalRespaldo;
  d: import('../src/fotos-descarga').DescargaFotos;
  pendiente?: Promise<import('../src/fotos-descarga').ResultadoDescargaFotos>;
}
declare global { interface Window { fixtureDescarga: FixtureNativo } }

test('GET nativo conserva binario completo y reopen; schemas/progreso/respaldo/cache/legado intactos', async ({ page }) => {
  await cargar(page);
  const r = await page.evaluate(async () => {
    const c = window.fixtureDescarga;
    const progreso = await c.progreso.abrirProgresoLocal(c.p, { dispositivoId: 'dispositivo-descarga' });
    const antes = JSON.stringify(await progreso.leer());
    const ledger = await c.respaldo.abrirRespaldoFotosLocal(c.p, c.fotos);
    const respaldoAntes = JSON.stringify(await ledger.listar());
    const cache = await caches.open('fixture-descarga');
    await cache.put('/sentinela', new Response('no tocar'));
    localStorage.setItem('itinerario-marcas', 'fixture-legado');
    const basesAntes = (await indexedDB.databases()).map((b) => b.name).sort();
    let terminada = false; let requestAntesDeResultado = false; let txCompleta = false;
    const agregar = IDBObjectStore.prototype.add;
    IDBObjectStore.prototype.add = function (valor: unknown, clave?: IDBValidKey) {
      const req = agregar.call(this, valor, clave);
      if (this.name === 'originales') {
        req.addEventListener('success', () => { requestAntesDeResultado = !terminada; });
        this.transaction.addEventListener('complete', () => { txCompleta = true; });
      }
      return req;
    };
    let resultado: import('../src/fotos-descarga').ResultadoDescargaFotos;
    try { resultado = await c.d.descargar(c.ref); terminada = true; }
    finally { IDBObjectStore.prototype.add = agregar; }
    const estado = await c.fotos.leerMetadatos(c.ref.fotoId);
    const progresoIgual = antes === JSON.stringify(await progreso.leer());
    const respaldoIgual = respaldoAntes === JSON.stringify(await ledger.listar());
    const cacheIgual = await (await cache.match('/sentinela'))!.text();
    const clavesCache = (await cache.keys()).map((r) => new URL(r.url).pathname);
    const legado = localStorage.getItem('itinerario-marcas');
    c.d.cerrar(); c.fotos.cerrar(); progreso.cerrar(); ledger.cerrar();
    const fotos = await c.local.abrirFotosLocal(c.p);
    const original = await fotos.leerOriginal(c.ref.fotoId);
    const bytes = new Uint8Array(await original!.arrayBuffer());
    const final = await fotos.leerMetadatos(c.ref.fotoId); fotos.cerrar();
    const schemas = [];
    for (const info of await indexedDB.databases()) {
      const db = await new Promise<IDBDatabase>((ok, no) => {
        const req = indexedDB.open(info.name!); req.onsuccess = () => ok(req.result); req.onerror = () => no(req.error);
      });
      const tablas = [...db.objectStoreNames];
      const tx = db.transaction(tablas);
      const detalle = await Promise.all(tablas.map((nombre) => new Promise<{ nombre: string; keyPath: string | string[] | null;
        autoIncrement: boolean; indices: string[]; filas: number }>((ok, no) => {
        const t = tx.objectStore(nombre); const n = t.count();
        n.onsuccess = () => ok({ nombre, keyPath: t.keyPath, autoIncrement: t.autoIncrement, indices: [...t.indexNames],
          filas: n.result });
        n.onerror = () => no(n.error);
      })));
      schemas.push({ nombre: db.name, version: db.version, tablas, detalle }); db.close();
    }
    return { tipo: resultado.tipo, recibidos: resultado.bytesRecibidos, longitud: bytes.length,
      primero: bytes[0], ultimo: bytes[bytes.length - 1], penultimo: bytes[bytes.length - 2],
      blobNativo: original instanceof Blob && !(original instanceof File), mime: original!.type,
      estado, final, signo: final && !('tipo' in final) && Object.is(final.incorporada, -0)
        && Object.is(final.ultimaModificacion, -0), progresoIgual, respaldoIgual, cacheIgual, clavesCache, legado,
      requestAntesDeResultado, txCompleta, schemas, basesAntes, basesDespues: (await indexedDB.databases()).map((b) => b.name).sort() };
  });
  expect(r).toMatchObject({ tipo: 'guardada', recibidos: payload.length, longitud: payload.length,
    primero: 0, ultimo: 255, penultimo: 23, blobNativo: true, mime: 'image/heic', signo: true,
    requestAntesDeResultado: true, txCompleta: true,
    progresoIgual: true, respaldoIgual: true, cacheIgual: 'no tocar', clavesCache: ['/sentinela'], legado: 'fixture-legado' });
  expect(r.final).toEqual(r.estado);
  expect(r.final).toMatchObject({ nombre: '\0 e\u0301 ', mimeDeclarado: 'image/heic', miniatura: { tipo: 'pendiente' } });
  expect(r.basesDespues).toEqual(r.basesAntes); expect(r.schemas).toHaveLength(3);
  const foto = r.schemas.find((s) => s.nombre.startsWith('itinerario-fotos:'))!;
  expect(foto).toMatchObject({ version: 2, tablas: ['metadatos', 'miniaturas', 'originales', 'procedencias'] });
  expect(foto.detalle.every((t) => t.keyPath === null && !t.autoIncrement && t.indices.length === 0)).toBe(true);
  // Descargada: nunca gana procedencia de cámara o galería.
  expect(foto.detalle.find((t) => t.nombre === 'procedencias')?.filas).toBe(0);
  expect(r.schemas.find((s) => s.nombre === 'itinerario-progreso')).toMatchObject({ version: 1, tablas: ['viajes'] });
  expect(r.schemas.find((s) => s.nombre.startsWith('itinerario-respaldo-fotos:'))).toMatchObject({ version: 1, tablas: ['respaldos'] });
  expect(solicitudes).toEqual([{ ruta: '/api/fotos/12345678-1234-4123-8123-123456789abc/original',
    metodo: 'GET', accept: 'application/octet-stream', cookie: undefined }]);
});

test('stream nativo truncado/excesivo y redirect no escriben ni visitan endpoint público', async ({ page }) => {
  await cargar(page);
  for (const caso of ['truncado', 'exceso', 'redirect'] as const) {
    modo = caso;
    const r = await page.evaluate(async () => {
      const c = window.fixtureDescarga;
      const r = await c.d.descargar(c.ref);
      return { tipo: r.tipo, recibidos: r.bytesRecibidos, captura: 'captura' in r,
        metadata: await c.fotos.leerMetadatos(c.ref.fotoId) };
    });
    expect(r.tipo, caso).toBe('fallida'); expect(r.captura, caso).toBe(false); expect(r.metadata, caso).toBeNull();
    if (caso === 'truncado') expect(r.recibidos).toBe(payload.length - 1);
    if (caso === 'exceso') expect(r.recibidos).toBeGreaterThan(payload.length);
  }
  expect(visitasPublicas).toBe(0); expect(solicitudes).toHaveLength(3);
});

test('dos conexiones nativas preservan A ante B, miniatura y tombstone; comparación incluye último bloque', async ({ page }) => {
  await cargar(page);
  const r = await page.evaluate(async () => {
    const c = window.fixtureDescarga;
    const otra = await c.local.abrirFotosLocal(c.p);
    const bytes = new Uint8Array(c.ref.bytesOriginal); bytes.fill(23); bytes[0] = 0; bytes[bytes.length - 1] = 254;
    const a = { metadatos: { ...c.ref, miniatura: { tipo: 'pendiente' as const } }, original: new Blob([bytes], { type: c.ref.mimeDeclarado }) };
    await otra.guardarOriginal(a);
    await otra.guardarMiniatura(c.ref.fotoId, new Blob([new Uint8Array([9])], { type: 'image/png' }), 1, 1);
    const resultado = await c.d.descargar(c.ref); // GET contiene B, mismo tamaño/metadata, último byte distinto
    const original = new Uint8Array(await (await otra.leerOriginal(c.ref.fotoId))!.arrayBuffer());
    const miniatura = await otra.leerMiniatura(c.ref.fotoId);
    await otra.borrarLocal(c.ref.fotoId);
    const despuesBorrado = await c.d.descargar(c.ref);
    const m = await c.fotos.leerMetadatos(c.ref.fotoId);
    const respaldo = await c.respaldo.abrirRespaldoFotosLocal(c.p, c.fotos);
    const ledger = await respaldo.listar(); respaldo.cerrar(); otra.cerrar(); c.d.cerrar(); c.fotos.cerrar();
    return { tipo: resultado.tipo, recuperable: resultado.tipo === 'fallida' && !!resultado.captura,
      ultimo: original[original.length - 1], miniatura: miniatura?.size, borrada: despuesBorrado.tipo, m, ledger };
  });
  expect(r).toMatchObject({ tipo: 'fallida', recuperable: true, ultimo: 254, miniatura: 1,
    borrada: 'fallida', m: { tipo: 'borrada' }, ledger: [] });
  expect(solicitudes).toHaveLength(1); // Tombstone preflight: cero GET nuevo.
});

test('aborto nativo cierra HTTP; fallo de cuota simulado recupera solo sesión y ACK local perdido exige bytes', async ({ page }) => {
  await cargar(page); modo = 'pendiente';
  await page.evaluate(() => { const c = window.fixtureDescarga; c.pendiente = c.d.descargar(c.ref); });
  await cabeceras;
  const detenido = await page.evaluate(async () => {
    const c = window.fixtureDescarga; c.d.cancelar(); const r = await c.pendiente!;
    return { tipo: r.tipo, captura: 'captura' in r, m: await c.fotos.leerMetadatos(c.ref.fotoId) };
  });
  await streamCerrado;
  expect(detenido).toEqual({ tipo: 'detenida', captura: false, m: null });
  modo = 'normal';
  const r = await page.evaluate(async () => {
    const c = window.fixtureDescarga;
    const d = c.descarga.crearDescargaFotos({ plan: c.p, origen: location.origin, fotos: { ...c.fotos,
      guardarOriginal: async () => { throw new DOMException('Fixture de cuota, no cuota física', 'QuotaExceededError'); },
    } });
    const fallo = await d.descargar(c.ref);
    const persistida = await c.fotos.leerOriginal(c.ref.fotoId);
    const recuperacion = fallo.tipo === 'fallida' && fallo.captura ? new Uint8Array(await fallo.captura.original.arrayBuffer()) : null;
    d.cerrar();
    const otra = await c.local.abrirFotosLocal(c.p);
    const ackPerdido = c.descarga.crearDescargaFotos({ plan: c.p, origen: location.origin, fotos: { ...c.fotos,
      guardarOriginal: async (captura) => { await otra.guardarOriginal(captura); throw new Error('Respuesta local perdida'); },
    } });
    const confirmada = await ackPerdido.descargar(c.ref);
    ackPerdido.cerrar(); otra.cerrar(); c.d.cerrar(); c.fotos.cerrar();
    const reabierta = await c.local.abrirFotosLocal(c.p);
    const blob = await reabierta.leerOriginal(c.ref.fotoId); reabierta.cerrar();
    return { fallo: fallo.tipo, persistida: persistida !== null, recuperacion: recuperacion?.length,
      ultimo: recuperacion?.[recuperacion.length - 1], confirmada: confirmada.tipo, reabierta: blob?.size };
  });
  expect(r).toEqual({ fallo: 'fallida', persistida: false, recuperacion: payload.length,
    ultimo: 255, confirmada: 'guardada', reabierta: payload.length });
  expect(solicitudes).toHaveLength(3);
});
