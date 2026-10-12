import { test, expect } from '@playwright/test';
import { createServer, type Server } from 'node:http';
import { build, type Rollup } from 'vite';

// FUENTE actual en memoria; contextos Chromium propios. No usa UI, SW, proveedor ni DB del usuario.
let servidor: Server;
let origen: string;
test.beforeAll(async () => {
  const resultado = await build({ configFile: false, logLevel: 'silent', build: {
    write: false, minify: false, rollupOptions: { preserveEntrySignatures: 'strict', input: {
      respaldo: 'src/fotos-respaldo-local.ts', dominio: 'src/fotos-respaldo.ts', fotos: 'src/fotos.ts',
      local: 'src/fotos-local.ts', plan: 'src/datos/itinerario.ts', progreso: 'src/progreso-local.ts',
    }, output: { entryFileNames: '[name].js', chunkFileNames: 'fragmento-[hash].js' } },
  } });
  const salida = (Array.isArray(resultado) ? resultado[0] : resultado) as Rollup.RollupOutput;
  const archivos = new Map(salida.output.filter((o) => o.type === 'chunk').map((o) => [o.fileName, o.code]));
  servidor = createServer((req, res) => {
    const nombre = new URL(req.url!, 'http://local').pathname.slice(1);
    res.setHeader('Cache-Control', 'no-store');
    if (archivos.has(nombre)) { res.setHeader('Content-Type', 'text/javascript'); res.end(archivos.get(nombre)); }
    else if (!nombre) { res.setHeader('Content-Type', 'text/html'); res.end('<!doctype html><title>Ledger manual local</title>'); }
    else { res.statusCode = 404; res.end(); }
  });
  await new Promise<void>((ok) => servidor.listen(0, '127.0.0.1', ok));
  const direccion = servidor.address();
  if (!direccion || typeof direccion === 'string') throw new Error('Sin puerto local');
  origen = `http://127.0.0.1:${direccion.port}`;
});
test.afterAll(async () => { if (servidor) await new Promise<void>((ok, no) => servidor.close((e) => e ? no(e) : ok())); });
test.beforeEach(async ({ page }) => {
  await page.route('**/*', (ruta) => new URL(ruta.request().url()).origin === origen ? ruta.continue() : ruta.abort());
  await page.goto(origen);
});

test('original nativo A/B, atestación, two connections/reopen y prueba local del contrato de recibo', async ({ page }) => {
  const r = await page.evaluate(async () => {
    const [respaldo, fotos, local, plan, progreso] = await Promise.all(
      ['/respaldo.js', '/fotos.js', '/local.js', '/plan.js', '/progreso.js'].map((ruta) => import(ruta)));
    const { itinerario } = plan;
    const avance = await progreso.abrirProgresoLocal(itinerario, { dispositivoId: 'respaldo-prueba' });
    const antes = await avance.leer(); const cacheAntes = await caches.keys();
    const fuente = await local.abrirFotosLocal(itinerario);
    const destino = { tipo: 'parada', viajeId: itinerario.id, paradaId: itinerario.dias[0].paradas[0].id };
    const datos = new Uint8Array(2 * (1 << 20) + 17); datos.fill(43); const otros = datos.slice(); otros[otros.length - 1] = 44;
    const captura = fotos.crearCapturaFoto(itinerario, destino,
      new File([datos], '\0 e\u0301 ', { type: 'image/heic', lastModified: 17 }), -0);
    await fuente.guardarOriginal(captura);
    const a = await respaldo.abrirRespaldoFotosLocal(itinerario, fuente);
    const b = await respaldo.abrirRespaldoFotosLocal(itinerario, fuente);
    const operacionId = crypto.randomUUID(); let colisionBytes = false;
    try { await a.preparar({ metadatos: captura.metadatos, original: new Blob([otros], { type: 'image/heic' }) }, operacionId); }
    catch { colisionBytes = true; }
    const sinFalsoPreparado = await a.leer(captura.metadatos.fotoId) === null;
    const e = await a.preparar(captura, operacionId);
    const ref = { fotoId: e.fotoId, operacionId: e.operacionId, original: e.original };
    const lienzo = new OffscreenCanvas(2, 3); lienzo.getContext('2d')!.fillRect(0, 0, 2, 3);
    await fuente.guardarMiniatura(e.fotoId, await lienzo.convertToBlob({ type: 'image/png' }), 2, 3);
    const derivadaNoRetarget = JSON.stringify(await b.preparar(captura, operacionId)) === JSON.stringify(e);
    await a.marcarEnviada(ref);
    const antesIO = await b.leer(e.fotoId); // No hay IO externo en esta unidad.
    await b.pausar(ref); a.cerrar(); b.cerrar();
    const nueva = await respaldo.abrirRespaldoFotosLocal(itinerario, fuente);
    const incierta = await nueva.leer(e.fotoId); await nueva.reintentar(ref);
    let cargaOriginal = 0; const leerOriginal = fuente.leerOriginal;
    fuente.leerOriginal = async (id: string) => { cargaOriginal++; return leerOriginal(id); };
    await nueva.listar(); await nueva.leer(e.fotoId);
    const recibo = { version: 1, tipo: 'acuse-respaldo', viajeId: itinerario.id, fotoId: e.fotoId,
      operacionId, original: e.original, objetoOriginalDurable: true, metadatosDurables: true };
    // CONTROL LOCAL: recibo sintético del contrato. No servidor autenticado ni prueba R2 real.
    const confirmada = await nueva.confirmarRecibo(recibo);
    await fuente.borrarLocal(e.fotoId);
    const repetida = await nueva.confirmarRecibo(recibo); nueva.cerrar();
    const final = await respaldo.abrirRespaldoFotosLocal(itinerario, fuente);
    const durable = await final.leer(e.fotoId);
    const esquemas = [];
    for (const nombre of [`itinerario-respaldo-fotos:${encodeURIComponent(itinerario.id)}`,
      `itinerario-fotos:${encodeURIComponent(itinerario.id)}`, 'itinerario-progreso']) {
      const db = await new Promise<IDBDatabase>((ok, no) => {
        const s = indexedDB.open(nombre); s.onsuccess = () => ok(s.result); s.onerror = () => no(s.error);
      });
      esquemas.push({ version: db.version, tablas: Array.from(db.objectStoreNames), estructuras:
        Array.from(db.objectStoreNames).map((tabla) => {
          const t = db.transaction(tabla).objectStore(tabla);
          return { clave: t.keyPath, incremento: t.autoIncrement, indices: t.indexNames.length };
        }) }); db.close();
    }
    const despues = await avance.leer(); avance.cerrar(); fuente.cerrar(); final.cerrar();
    return { colisionBytes, sinFalsoPreparado, derivadaNoRetarget, antesIO, incierta,
      confirmada, repetida, durable, cargaOriginal, signo: Object.is(durable.original.incorporada, -0),
      nombre: durable.original.nombre, sinBlob: !Object.hasOwn(durable, 'blob'), esquemas,
      antes, despues, cacheAntes, cacheDespues: await caches.keys() };
  });
  expect(r).toMatchObject({ colisionBytes: true, sinFalsoPreparado: true, derivadaNoRetarget: true,
    antesIO: { fase: 'enviada', enviada: true, recibo: null }, incierta: { fase: 'enviada', enviada: true, pausada: true },
    confirmada: { fase: 'respaldada', enviada: true }, cargaOriginal: 0, signo: true, nombre: '\0 é ', sinBlob: true });
  expect(r.repetida).toEqual(r.confirmada); expect(r.durable).toEqual(r.confirmada);
  expect(r.esquemas).toEqual([
    { version: 1, tablas: ['respaldos'], estructuras: [{ clave: null, incremento: false, indices: 0 }] },
    { version: 1, tablas: ['metadatos', 'miniaturas', 'originales'], estructuras: Array(3).fill({ clave: null, incremento: false, indices: 0 }) },
    { version: 1, tablas: ['viajes'], estructuras: [{ clave: null, incremento: false, indices: 0 }] },
  ]);
  expect(r.despues).toEqual(r.antes); expect(r.despues.formato).toBe(3); expect(r.cacheDespues).toEqual(r.cacheAntes);
});

test('Chromium: snapshots del llamador, no falsa A bajo B y stale ACK no pisa fase ni prueba', async ({ page }) => {
  const r = await page.evaluate(async () => {
    const [respaldo, fotos, local, plan] = await Promise.all(
      ['/respaldo.js', '/fotos.js', '/local.js', '/plan.js'].map((ruta) => import(ruta)));
    const { itinerario } = plan; const fuente = await local.abrirFotosLocal(itinerario);
    const captura = fotos.crearCapturaFoto(itinerario, { tipo: 'parada', viajeId: itinerario.id,
      paradaId: itinerario.dias[0].paradas[0].id }, new File(['abc'], '\0 e\u0301 '), -0);
    await fuente.guardarOriginal(captura);
    let inicio!: () => void; let liberar!: () => void;
    const iniciada = new Promise<void>((ok) => { inicio = ok; }); const espera = new Promise<void>((ok) => { liberar = ok; });
    const puerto = { leerOriginal: fuente.leerOriginal, leerMetadatos: async (id: string) => {
      inicio(); await espera; return fuente.leerMetadatos(id);
    } };
    const a = await respaldo.abrirRespaldoFotosLocal(itinerario, puerto);
    const b = await respaldo.abrirRespaldoFotosLocal(itinerario, fuente);
    const preparando = a.preparar(captura, crypto.randomUUID()); await iniciada;
    captura.metadatos.nombre = 'mutada'; captura.metadatos.incorporada = 0; liberar(); const e = await preparando;
    const ref = { fotoId: e.fotoId, operacionId: e.operacionId, original: e.original };
    await a.marcarEnviada(ref);
    const recibo = { version: 1, tipo: 'acuse-respaldo', viajeId: itinerario.id, fotoId: e.fotoId,
      operacionId: e.operacionId, original: e.original, objetoOriginalDurable: true, metadatosDurables: true };
    const rechazos: boolean[] = [];
    for (const malo of [{ ...recibo, operacionId: crypto.randomUUID() }, { ...recibo, viajeId: 'otro' },
      { ...recibo, objetoOriginalDurable: false }, { ...recibo, metadatosDurables: false },
      { fotoId: e.fotoId, size: 3, mime: '', etag: 'xxx' }]) {
      try { await b.confirmarRecibo(malo); rechazos.push(false); } catch { rechazos.push(true); }
    }
    const incierta = await b.leer(e.fotoId);
    await Promise.all([a.confirmarRecibo(recibo), b.pausar(ref)]);
    const confirmada = await a.leer(e.fotoId); let staleRetryRechazado = false;
    try { await b.reintentar(ref); } catch { staleRetryRechazado = true; }
    const bloqueada = await b.confirmarRecibo({ ...recibo, original: { ...e.original, incorporada: 0 } });
    const replay = await a.confirmarRecibo(recibo); a.cerrar(); b.cerrar(); fuente.cerrar();
    return { nombre: e.original.nombre, signo: Object.is(e.original.incorporada, -0), rechazos,
      incierta, confirmada, staleRetryRechazado, bloqueada, replay };
  });
  expect(r).toMatchObject({ nombre: '\0 é ', signo: true, rechazos: Array(5).fill(true),
    incierta: { fase: 'enviada', recibo: null }, confirmada: { fase: 'respaldada', pausada: true },
    staleRetryRechazado: true, bloqueada: { fase: 'bloqueada', enviada: true } });
  expect(r.bloqueada.recibo).toEqual(r.confirmada.recibo); expect(r.replay).toEqual(r.bloqueada);
});

test('IDB nativo request-success→abort y cuota INYECTADA no dan éxito ni borran estado previo', async ({ page }) => {
  const r = await page.evaluate(async () => {
    const [respaldo, fotos, local, plan] = await Promise.all(
      ['/respaldo.js', '/fotos.js', '/local.js', '/plan.js'].map((ruta) => import(ruta)));
    const { itinerario } = plan; const fuente = await local.abrirFotosLocal(itinerario);
    const captura = fotos.crearCapturaFoto(itinerario, { tipo: 'parada', viajeId: itinerario.id,
      paradaId: itinerario.dias[0].paradas[0].id }, new File(['abc'], 'a'), 1);
    await fuente.guardarOriginal(captura); const a = await respaldo.abrirRespaldoFotosLocal(itinerario, fuente);
    const add = IDBObjectStore.prototype.add; const put = IDBObjectStore.prototype.put;
    const rechazos: boolean[] = [];
    IDBObjectStore.prototype.add = function (...args) {
      const s = add.apply(this, args); if (this.name === 'respaldos') s.addEventListener('success', () => this.transaction.abort()); return s;
    };
    try { await a.preparar(captura); rechazos.push(false); } catch { rechazos.push(true); }
    finally { IDBObjectStore.prototype.add = add; }
    const sinRegistro = await a.leer(captura.metadatos.fotoId) === null;
    const e = await a.preparar(captura); const ref = { fotoId: e.fotoId, operacionId: e.operacionId, original: e.original };
    IDBObjectStore.prototype.put = function (...args) {
      const s = put.apply(this, args); if (this.name === 'respaldos') s.addEventListener('success', () => this.transaction.abort()); return s;
    };
    try { await a.marcarEnviada(ref); rechazos.push(false); } catch { rechazos.push(true); }
    finally { IDBObjectStore.prototype.put = put; }
    const sinMarcador = await a.leer(e.fotoId);
    await a.marcarEnviada(ref);
    const recibo = { version: 1, tipo: 'acuse-respaldo', viajeId: itinerario.id, fotoId: e.fotoId,
      operacionId: e.operacionId, original: e.original, objetoOriginalDurable: true, metadatosDurables: true };
    IDBObjectStore.prototype.put = function (...args) {
      const s = put.apply(this, args); if (this.name === 'respaldos') s.addEventListener('success', () => this.transaction.abort()); return s;
    };
    try { await a.confirmarRecibo(recibo); rechazos.push(false); } catch { rechazos.push(true); }
    finally { IDBObjectStore.prototype.put = put; }
    const sinAcuse = await a.leer(e.fotoId);
    IDBObjectStore.prototype.put = function (...args) {
      if (this.name === 'respaldos') throw new DOMException('Cuota INYECTADA', 'QuotaExceededError'); return put.apply(this, args);
    };
    try { await a.pausar(ref); rechazos.push(false); } catch { rechazos.push(true); }
    finally { IDBObjectStore.prototype.put = put; }
    a.cerrar(); const nueva = await respaldo.abrirRespaldoFotosLocal(itinerario, fuente);
    const final = await nueva.leer(e.fotoId); const bytes = await (await fuente.leerOriginal(e.fotoId)).text();
    nueva.cerrar(); fuente.cerrar(); return { rechazos, sinRegistro, sinMarcador, sinAcuse, final, bytes };
  });
  expect(r).toMatchObject({ rechazos: Array(4).fill(true), sinRegistro: true,
    sinMarcador: { fase: 'preparado', enviada: false }, sinAcuse: { fase: 'enviada', recibo: null }, bytes: 'abc' });
  expect(r.final).toEqual(r.sinAcuse);
});

test('esquema desconocido y registro corrupto nativos conservan datos crudos sin reset', async ({ page }) => {
  const r = await page.evaluate(async () => {
    const [respaldo, plan] = await Promise.all(['/respaldo.js', '/plan.js'].map((ruta) => import(ruta)));
    const { itinerario } = plan;
    const abrir = (nombre: string, version: number, crear?: (d: IDBDatabase) => void) => new Promise<IDBDatabase>((ok, no) => {
      const s = indexedDB.open(nombre, version); s.onupgradeneeded = () => crear?.(s.result);
      s.onsuccess = () => ok(s.result); s.onerror = () => no(s.error);
    });
    const fuente = { leerMetadatos: async () => null, leerOriginal: async () => null };
    const resultados = [];
    for (const caso of ['futura', 'falta', 'extra', 'indice', 'corrupta']) {
      const p = { ...itinerario, id: `${itinerario.id}-${caso}` };
      const nombre = `itinerario-respaldo-fotos:${encodeURIComponent(p.id)}`;
      const db = await abrir(nombre, caso === 'futura' ? 2 : 1, (d) => {
        const t = d.createObjectStore(caso === 'falta' ? 'ajena' : 'respaldos');
        if (caso === 'extra') d.createObjectStore('ajena'); if (caso === 'indice') t.createIndex('extra', 'fotoId');
        t.put({ fotoId: '12345678-1234-4123-8123-123456789abc', formato: 999, nombre: '\0 e\u0301 ' }, '12345678-1234-4123-8123-123456789abc');
      }); db.close(); let rechazado = false;
      try {
        const lib = await respaldo.abrirRespaldoFotosLocal(p, fuente);
        try { await lib.listar(); } finally { lib.cerrar(); }
      } catch { rechazado = true; }
      const actual = await abrir(nombre, caso === 'futura' ? 2 : 1);
      const crudo = await new Promise<unknown>((ok) => {
        const s = actual.transaction(caso === 'falta' ? 'ajena' : 'respaldos').objectStore(caso === 'falta' ? 'ajena' : 'respaldos')
          .get('12345678-1234-4123-8123-123456789abc'); s.onsuccess = () => ok(s.result);
      });
      resultados.push({ rechazado, version: actual.version, tablas: Array.from(actual.objectStoreNames), crudo }); actual.close();
    }
    return resultados;
  });
  expect(r).toHaveLength(5);
  for (const caso of r) expect(caso).toMatchObject({ rechazado: true, crudo: { formato: 999, nombre: '\0 é ' } });
  expect(r.map((c) => c.version)).toEqual([2, 1, 1, 1, 1]);
  expect(r.map((c) => c.tablas)).toEqual([['respaldos'], ['ajena'], ['ajena', 'respaldos'], ['respaldos'], ['respaldos']]);
});
