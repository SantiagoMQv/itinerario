import { test, expect, type Page } from '@playwright/test';
import { createServer, type Server } from 'node:http';
import { build, type Rollup } from 'vite';

// Bundle productivo real en memoria y contexto HTTP/Chromium propio. No UI ni proveedor.
let servidor: Server;
let origen: string;
let solicitudesApi = 0;
let solicitudesExternas = 0;
test.beforeAll(async () => {
  const resultado = await build({ configFile: false, logLevel: 'silent', build: {
    write: false, minify: false, rollupOptions: { preserveEntrySignatures: 'strict', input: {
      portable: 'src/portabilidad.ts', composicion: 'src/portabilidad-local.ts',
      fotos: 'src/fotos-local.ts', progreso: 'src/progreso-local.ts', ledger: 'src/fotos-respaldo-local.ts',
      plan: 'src/datos/itinerario.ts',
    }, output: { entryFileNames: '[name].js', chunkFileNames: 'fragmento-[hash].js' } },
  } });
  const salida = (Array.isArray(resultado) ? resultado[0] : resultado) as Rollup.RollupOutput;
  const archivos = new Map(salida.output.filter((o) => o.type === 'chunk').map((o) => [o.fileName, o.code]));
  servidor = createServer((req, res) => {
    const ruta = new URL(req.url!, 'http://local').pathname;
    res.setHeader('Cache-Control', 'no-store');
    if (ruta.startsWith('/api/')) solicitudesApi++;
    if (archivos.has(ruta.slice(1))) {
      res.setHeader('Content-Type', 'text/javascript'); res.end(archivos.get(ruta.slice(1))); return;
    }
    if (ruta === '/') {
      res.setHeader('Content-Type', 'text/html'); res.end('<!doctype html><title>Historia portable</title>'); return;
    }
    res.statusCode = 404; res.end();
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
  solicitudesApi = 0; solicitudesExternas = 0;
  await page.route('**/*', (r) => {
    if (new URL(r.request().url()).origin === origen) return r.continue();
    solicitudesExternas++; return r.abort();
  });
  await page.goto(origen); await cargar(page);
});
test.afterEach(() => { expect(solicitudesApi).toBe(0); expect(solicitudesExternas).toBe(0); });
interface FixturePortableNativo {
  portable: typeof import('../src/portabilidad');
  composicion: typeof import('../src/portabilidad-local');
  fotos: typeof import('../src/fotos-local');
  progreso: typeof import('../src/progreso-local');
  ledger: typeof import('../src/fotos-respaldo-local');
  plan: typeof import('../src/datos/itinerario').itinerario;
  limites: import('../src/portabilidad').LimitesPortables;
  metadata: import('../src/fotos').MetadatosFoto;
  abrir(nombre: string, tablas: readonly string[]): Promise<IDBDatabase>;
  poner(db: IDBDatabase, tabla: string, clave: IDBValidKey, valor: unknown): Promise<void>;
  leer(db: IDBDatabase, tabla: string, clave: IDBValidKey): Promise<unknown>;
}
declare global { interface Window { fixturePortable: FixturePortableNativo } }
async function cargar(page: Page) {
  await page.evaluate(async () => {
    const [portable, composicion, fotos, progreso, ledger, datos] = await Promise.all(
      ['/portable.js', '/composicion.js', '/fotos.js', '/progreso.js', '/ledger.js', '/plan.js'].map((ruta) => import(ruta)));
    const plan = datos.itinerario;
    const abrir = (nombre: string, tablas: readonly string[]) => new Promise<IDBDatabase>((ok, no) => {
      const s = indexedDB.open(nombre, 1);
      s.onupgradeneeded = () => tablas.forEach((t) => s.result.createObjectStore(t));
      s.onsuccess = () => ok(s.result); s.onerror = () => no(s.error);
    });
    const poner = (db: IDBDatabase, tabla: string, clave: IDBValidKey, valor: unknown) => new Promise<void>((ok, no) => {
      const tx = db.transaction(tabla, 'readwrite'); tx.objectStore(tabla).put(valor, clave);
      tx.oncomplete = () => ok(); tx.onabort = () => no(tx.error);
    });
    const leer = (db: IDBDatabase, tabla: string, clave: IDBValidKey) => new Promise<unknown>((ok, no) => {
      const tx = db.transaction(tabla); const req = tx.objectStore(tabla).get(clave); let valor: unknown;
      req.onsuccess = () => { valor = req.result; }; tx.oncomplete = () => ok(valor); tx.onabort = () => no(tx.error);
    });
    Object.assign(window, { fixturePortable: { portable, composicion, fotos, progreso, ledger, plan,
      limites: { maxRegistros: 1000, maxBytesMetadatos: 1000000, maxBytesArchivo: 8000000, maxProfundidad: 64 },
      metadata: { formato: 1, fotoId: '12345678-1234-4123-8123-123456789abc', destino: {
        tipo: 'parada', viajeId: plan.id, paradaId: plan.dias[0].paradas[0].id }, nombre: '\0 e\u0301 ',
      mimeDeclarado: 'image/heic', incorporada: -0, ultimaModificacion: -0,
      bytesOriginal: (1 << 20) + 5, miniatura: { tipo: 'pendiente' } }, abrir, poner, leer } });
  });
}

test('M1: catálogo inválido se rechaza en seis fronteras sin aperturas, legacy ni lecturas binarias; control válido ausente', async ({ page }) => {
  const r = await page.evaluate(async () => {
    const c = window.fixturePortable; const antes = await indexedDB.databases();
    const control = await c.composicion.crearExportadorLocal({ plan: c.plan, limites: c.limites, leerLegado: () => null }).exportar();
    await c.portable.inspeccionarArchivoPortable(c.plan, control.archivo, c.limites);
    const trasControl = await indexedDB.databases();
    const abrir = IDBFactory.prototype.open; const leerBytes = Blob.prototype.arrayBuffer;
    let aperturas = 0; let lecturas = 0; let lecturasLegado = 0;
    IDBFactory.prototype.open = function (...args: Parameters<typeof abrir>) {
      aperturas++; return abrir.apply(this, args);
    };
    Blob.prototype.arrayBuffer = function () { lecturas++; return leerBytes.call(this); };
    const resultados: { caso: string; frontera: string; rechazado: boolean; diagnostico: boolean; aperturas: number; lecturas: number; legado: number }[] = [];
    try {
      for (const caso of ['viaje-vacio', 'parada-duplicada', 'subparada-cruzada', 'pendiente-vacio']) {
        const plan = structuredClone(c.plan); const paradas = plan.dias.flatMap((d) => d.paradas);
        if (caso === 'viaje-vacio') Object.assign(plan, { id: '' });
        if (caso === 'parada-duplicada') Object.assign(paradas[1], { id: paradas[0].id });
        if (caso === 'subparada-cruzada') paradas[0].subparadas = [{ id: paradas[1].id, nombre: 'Colisión nativa' }];
        if (caso === 'pendiente-vacio') plan.pendientes = [{ id: '', texto: 'Sin ID' }];
        const captura = { ...control.manifiesto.captura, viajeId: plan.id };
        const acciones: [string, () => unknown][] = [
          ['constructor', () => c.composicion.crearExportadorLocal({ plan, limites: c.limites,
            leerLegado: () => { lecturasLegado++; return null; } })],
          ['PhotoDB', () => c.fotos.capturarFotosLocal(plan, c.limites)],
          ['ProgressDB', () => c.progreso.capturarProgresoLocal(plan, c.limites)],
          ['LedgerDB', () => c.ledger.capturarRespaldoFotosLocal(plan, c.limites)],
          ['exportador', () => c.portable.exportarArchivoPortable(plan, captura, c.limites)],
          ['inspector', () => c.portable.inspeccionarArchivoPortable(plan, control.archivo, c.limites)],
        ];
        for (const [frontera, accion] of acciones) {
          const a = aperturas; const b = lecturas; const l = lecturasLegado;
          let rechazado = false; let diagnostico = false;
          try { await accion(); } catch (e) { rechazado = true; diagnostico = e instanceof Error && e.message.includes('Identidad'); }
          resultados.push({ caso, frontera, rechazado, diagnostico, aperturas: aperturas - a, lecturas: lecturas - b, legado: lecturasLegado - l });
        }
      }
    } finally { IDBFactory.prototype.open = abrir; Blob.prototype.arrayBuffer = leerBytes; }
    return { antes, trasControl, despues: await indexedDB.databases(), resultados, validasAusentes:
      !control.manifiesto.captura.fotos.presente && !control.manifiesto.captura.progreso.presente && !control.manifiesto.captura.respaldos.presente };
  });
  expect(r.antes).toEqual([]); expect(r.trasControl).toEqual([]); expect(r.despues).toEqual([]);
  expect(r.validasAusentes).toBe(true); expect(r.resultados).toHaveLength(24);
  for (const resultado of r.resultados) {
    expect(resultado, `${resultado.caso}/${resultado.frontera}`).toMatchObject({ rechazado: true,
      diagnostico: true, aperturas: 0, lecturas: 0, legado: 0 });
  }
});

test('tres bases nativas y dos conexiones: root3/SENT, ledger bloqueado histórico, tombstone y archivo binario exacto', async ({ page }) => {
  const r = await page.evaluate(async () => {
    const c = window.fixturePortable; const p = c.plan;
    const fotos = await c.fotos.abrirFotosLocal(p); const otra = await c.fotos.abrirFotosLocal(p);
    const bytes = new Uint8Array(c.metadata.bytesOriginal); bytes.fill(23); bytes[0] = 0; bytes[bytes.length - 1] = 255;
    const captura = { metadatos: c.metadata, original: new Blob([bytes], { type: 'image/heic' }) };
    await fotos.guardarOriginal(captura);
    await otra.guardarMiniatura(c.metadata.fotoId, new Blob([new Uint8Array([0, 9, 254])], { type: 'image/png' }), 1, 1);
    const borradaId = '22345678-1234-4123-8123-123456789abc';
    await otra.guardarOriginal({ ...captura, metadatos: { ...c.metadata, fotoId: borradaId } }); await otra.borrarLocal(borradaId);
    const progreso = await c.progreso.abrirProgresoLocal(p, { dispositivoId: 'historico-no-credencial' });
    await progreso.registrar({ id: 'op1', dispositivoId: 'historico-no-credencial', tipo: 'parada',
      paradaId: p.dias[0].paradas[0].id, marca: 'hecha', revision: 0, horaReal: -0 });
    await progreso.marcarEnviada('op1');
    await progreso.registrar({ id: 'op2', dispositivoId: 'historico-no-credencial', tipo: 'parada',
      paradaId: p.dias[0].paradas[0].id, marca: 'saltada', revision: 1 });
    const antes = await progreso.leer();
    const ledger = await c.ledger.abrirRespaldoFotosLocal(p, fotos);
    const e = await ledger.preparar(captura, '32345678-1234-4123-8123-123456789abc');
    const ref = { fotoId: e.fotoId, operacionId: e.operacionId, original: e.original };
    await ledger.marcarEnviada(ref);
    const acuse = { version: 1 as const, tipo: 'acuse-respaldo' as const, viajeId: p.id,
      ...ref, objetoOriginalDurable: true as const, metadatosDurables: true as const };
    await ledger.confirmarRecibo(acuse);
    await ledger.confirmarRecibo({ ...acuse, original: { ...e.original, nombre: 'prueba contradictoria' } });
    const ledgerAntes = await ledger.pausar(ref);
    const db = await c.abrir('itinerario-progreso', ['viajes']);
    const rawAntes = await c.leer(db, 'viajes', p.id) as import('../src/progreso-local').RegistroLocal;
    const aliasAntes = rawAntes.estado.paradas[p.dias[0].paradas[0].id] === rawAntes.estado.operaciones.op1.cambios?.registros[0].despues;
    const modos: string[] = []; const transaction = IDBDatabase.prototype.transaction;
    IDBDatabase.prototype.transaction = function (...args: Parameters<typeof transaction>) {
      modos.push(args[1] ?? 'readonly'); return transaction.apply(this, args);
    };
    let r: import('../src/portabilidad').ArchivoPortable;
    try { r = await c.composicion.crearExportadorLocal({ plan: p, limites: c.limites,
      leerLegado: (campo) => campo === 'marcas' ? '' : campo === 'marcas-hora' ? '\0 e\u0301 ' : null }).exportar(); }
    finally { IDBDatabase.prototype.transaction = transaction; }
    const verificado = await c.portable.inspeccionarArchivoPortable(p, r.archivo, c.limites);
    const raiz = verificado.manifiesto.captura.progreso.tablas.viajes[0].valor as import('../src/progreso-local').RegistroLocal;
    const guardada = verificado.manifiesto.captura.respaldos.tablas.respaldos[0].valor;
    const s = verificado.manifiesto.segmentos.findIndex((s) => s.tabla === 'originales');
    const binario = new Uint8Array(await verificado.leerSegmento(s).arrayBuffer());
    const mini = new Uint8Array(await verificado.leerSegmento(1 - s).arrayBuffer());
    const rawDespues = await c.leer(db, 'viajes', p.id) as typeof rawAntes;
    const rawIgual = c.portable.codificarJsonFiel(c.portable.copiarValoresProgresoPortable(rawAntes, c.limites), c.limites)
      === c.portable.codificarJsonFiel(c.portable.copiarValoresProgresoPortable(rawDespues, c.limites), c.limites);
    const iguales = c.portable.codificarJsonFiel(c.portable.copiarValoresProgresoPortable(antes, c.limites), c.limites)
      === c.portable.codificarJsonFiel(raiz, c.limites);
    const ledgerIgual = c.portable.codificarJsonFiel(ledgerAntes, c.limites) === c.portable.codificarJsonFiel(guardada, c.limites);
    fotos.cerrar(); otra.cerrar(); progreso.cerrar(); ledger.cerrar(); db.close();
    const reabierta = await c.fotos.abrirFotosLocal(p); const original = await reabierta.leerOriginal(c.metadata.fotoId);
    const metadata = await reabierta.leerMetadatos(c.metadata.fotoId); reabierta.cerrar();
    return { iguales, ledgerIgual, rawIgual, aliasAntes, aliasDespues: rawDespues.estado.paradas[p.dias[0].paradas[0].id] === rawDespues.estado.operaciones.op1.cambios?.registros[0].despues,
      modos, raiz, ledgerAntes, binarioIgual: binario.every((v, i) => v === bytes[i]), bytes: binario.length,
      primero: binario[0], ultimo: binario[binario.length - 1], mini: [...mini], archivoMayor: r.archivo.size > bytes.length,
      metadatos: verificado.manifiesto.captura.fotos.tablas.metadatos, signo: Object.is(raiz.cola[0].operacion.tipo === 'parada' && raiz.cola[0].operacion.horaReal, -0),
      metadata, reopen: original?.size, legado: verificado.manifiesto.captura.legado };
  });
  expect(r).toMatchObject({ iguales: true, ledgerIgual: true, rawIgual: true, binarioIgual: true,
    bytes: (1 << 20) + 5, primero: 0, ultimo: 255, mini: [0, 9, 254], archivoMayor: true, signo: true,
    reopen: (1 << 20) + 5, legado: { marcas: '', 'marcas-hora': '\0 e\u0301 ', 'pendientes-hechos': null },
    ledgerAntes: { fase: 'bloqueada', enviada: true, pausada: true, recibo: { tipo: 'acuse-respaldo' } } });
  expect(r.aliasDespues).toBe(r.aliasAntes); expect(r.modos.length).toBe(3); expect(r.modos.every((m) => m === 'readonly')).toBe(true);
  expect(r.raiz.cola).toHaveLength(2); expect(r.raiz.cola[0].enviada).toBe(true); expect(r.raiz.cola[1].dependeDe).toEqual(['op1']);
  expect(r.metadatos.some((m) => (m.valor as { tipo?: string }).tipo === 'borrada')).toBe(true);
  expect(r.metadata).toMatchObject({ nombre: '\0 e\u0301 ', mimeDeclarado: 'image/heic' });
});

test('bases ausentes siguen ausentes; registro ausente distinto y root1/2 nunca migran', async ({ page }) => {
  const r = await page.evaluate(async () => {
    const c = window.fixturePortable;
    const e = c.composicion.crearExportadorLocal({ plan: c.plan, limites: c.limites, leerLegado: () => null });
    const antes = await indexedDB.databases(); const archivo = await e.exportar(); const despues = await indexedDB.databases();
    const db = await c.abrir('itinerario-progreso', ['viajes']);
    const sinRegistro = await c.progreso.capturarProgresoLocal(c.plan, c.limites);
    await c.poner(db, 'viajes', c.plan.id, undefined);
    let undefinedRechazado = false;
    try { await e.exportar(); } catch { undefinedRechazado = true; }
    const casos = [];
    for (const formato of [1, 2]) {
      const valor = { formato, legado: { originales: { texto: 'no migrar' }, recuperacion: [] } };
      await c.poner(db, 'viajes', c.plan.id, valor);
      let rechazado = false; try { await e.exportar(); } catch { rechazado = true; }
      casos.push({ rechazado, conservado: JSON.stringify(await c.leer(db, 'viajes', c.plan.id)) === JSON.stringify(valor) });
    }
    db.close();
    return { antes, despues, ausentes: archivo.manifiesto.captura, sinRegistro, undefinedRechazado, casos };
  });
  expect(r.antes).toEqual([]); expect(r.despues).toEqual([]);
  expect(r.ausentes.fotos.presente).toBe(false); expect(r.ausentes.progreso.presente).toBe(false); expect(r.ausentes.respaldos.presente).toBe(false);
  expect(r.sinRegistro).toEqual({ presente: true, tablas: { viajes: [] } }); expect(r.undefinedRechazado).toBe(true);
  expect(r.casos).toEqual([{ rechazado: true, conservado: true }, { rechazado: true, conservado: true }]);
});

test('huérfanos/unknown y aborto tras éxito de cursor rechazan sin borrar ni confirmar snapshots', async ({ page }) => {
  const r = await page.evaluate(async () => {
    const c = window.fixturePortable; const nombre = `itinerario-fotos:${encodeURIComponent(c.plan.id)}`;
    const db = await c.abrir(nombre, ['metadatos', 'originales', 'miniaturas']);
    await c.poner(db, 'originales', c.metadata.fotoId, new Blob(['abc'], { type: 'image/heic' }));
    let huerfano = false; try { await c.fotos.capturarFotosLocal(c.plan, c.limites); } catch { huerfano = true; }
    const originalConservado = (await c.leer(db, 'originales', c.metadata.fotoId) as Blob).size;
    await c.poner(db, 'metadatos', c.metadata.fotoId, { ...c.metadata, bytesOriginal: 3 });
    const cursor = IDBObjectStore.prototype.openCursor; let requestExitosa = false; let txAbortada = false;
    IDBObjectStore.prototype.openCursor = function (...args: Parameters<typeof cursor>) {
      const req = cursor.apply(this, args);
      if (this.name === 'metadatos') {
        this.transaction.addEventListener('abort', () => { txAbortada = true; });
        req.addEventListener('success', () => { if (req.result) { requestExitosa = true; this.transaction.abort(); } });
      }
      return req;
    };
    let snapshotRechazado = false;
    try { await c.fotos.capturarFotosLocal(c.plan, c.limites); } catch { snapshotRechazado = true; }
    finally { IDBObjectStore.prototype.openCursor = cursor; }
    await c.poner(db, 'metadatos', 'unknown', { formato: 999 });
    let unknown = false; try { await c.fotos.capturarFotosLocal(c.plan, c.limites); } catch { unknown = true; }
    const unknownConservado = await c.leer(db, 'metadatos', 'unknown'); db.close();
    const progreso = await c.progreso.abrirProgresoLocal(c.plan, { dispositivoId: 'fixture' });
    const root = await progreso.leer(); progreso.cerrar();
    const p = await c.abrir('itinerario-progreso', ['viajes']);
    const rama = { dato: -0 }; const opaco = { ...root, legado: { originales: { a: rama, b: rama }, recuperacion: [] } };
    await c.poner(p, 'viajes', c.plan.id, opaco);
    let aliasUnknown = false; try { await c.progreso.capturarProgresoLocal(c.plan, c.limites); } catch { aliasUnknown = true; }
    const final = await c.leer(p, 'viajes', c.plan.id) as typeof opaco; p.close();
    return { huerfano, originalConservado, requestExitosa, txAbortada, snapshotRechazado, unknown, unknownConservado,
      aliasUnknown, aliasConservado: final.legado.originales.a === final.legado.originales.b };
  });
  expect(r).toEqual({ huerfano: true, originalConservado: 3, requestExitosa: true, txAbortada: true,
    snapshotRechazado: true, unknown: true, unknownConservado: { formato: 999 }, aliasUnknown: true, aliasConservado: true });
});

test('legacy solo tres strings exactos: ausencia/vacío/fallo; original cero y archivo íntegro sin IO remoto', async ({ page }) => {
  const r = await page.evaluate(async () => {
    const c = window.fixturePortable; const fotos = await c.fotos.abrirFotosLocal(c.plan);
    await fotos.guardarOriginal({ metadatos: { ...c.metadata, bytesOriginal: 0 }, original: new Blob([], { type: 'image/heic' }) });
    localStorage.setItem('fixture-marcas', ''); localStorage.setItem('fixture-marcas-hora', '\0 e\u0301 {JSON inválido');
    localStorage.setItem('fuera-de-scope', 'NO EXPORTAR');
    const campos: string[] = [];
    const e = c.composicion.crearExportadorLocal({ plan: c.plan, limites: c.limites,
      leerLegado: (campo) => { campos.push(campo); return localStorage.getItem(`fixture-${campo}`); } });
    const a = await e.exportar(); const v = await c.portable.inspeccionarArchivoPortable(c.plan, a.archivo, c.limites);
    const fallos = [];
    for (const archivo of [a.archivo.slice(0, -1), new Blob([a.archivo, new Uint8Array([1])]),
      new Blob([a.archivo.slice(0, 24), new Uint8Array([255]), a.archivo.slice(25)])]) {
      try { await c.portable.inspeccionarArchivoPortable(c.plan, archivo, c.limites); fallos.push(false); }
      catch { fallos.push(true); }
    }
    let storageFallo = false;
    try { await c.composicion.crearExportadorLocal({ plan: c.plan, limites: c.limites,
      leerLegado: () => { throw new DOMException('Fixture acceso denegado', 'SecurityError'); } }).exportar(); }
    catch { storageFallo = true; }
    const intacto = localStorage.getItem('fuera-de-scope'); fotos.cerrar();
    return { campos, legado: v.manifiesto.captura.legado, cero: v.leerSegmento(0).size,
      archivoSize: a.archivo.size, segmentoSize: a.manifiesto.segmentos[0].bytes, fallos, storageFallo, intacto };
  });
  expect(r.campos).toEqual(['marcas', 'marcas-hora', 'pendientes-hechos']);
  expect(r.legado).toEqual({ marcas: '', 'marcas-hora': '\0 e\u0301 {JSON inválido', 'pendientes-hechos': null });
  expect(r.cero).toBe(0); expect(r.segmentoSize).toBe(0); expect(r.archivoSize).toBeGreaterThan(24);
  expect(r.fallos).toEqual([true, true, true]); expect(r.storageFallo).toBe(true); expect(r.intacto).toBe('NO EXPORTAR');
});
