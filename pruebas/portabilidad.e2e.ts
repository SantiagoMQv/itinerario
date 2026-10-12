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
      portable: 'src/portabilidad.ts', composicion: 'src/portabilidad-local.ts', historia: 'src/portabilidad-historico.ts',
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
  historia: typeof import('../src/portabilidad-historico');
  limitesHistoria: import('../src/portabilidad-historico').LimitesHistoria;
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
    const [portable, composicion, fotos, progreso, ledger, datos, historia] = await Promise.all(
      ['/portable.js', '/composicion.js', '/fotos.js', '/progreso.js', '/ledger.js', '/plan.js', '/historia.js'].map((ruta) => import(ruta)));
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
    Object.assign(window, { fixturePortable: { portable, composicion, fotos, progreso, ledger, historia, plan,
      limitesHistoria: { maxImportaciones: 100, maxObservaciones: 1000, maxProcedencias: 1000, maxBytesHistoria: 80000000 },
      limites: { maxRegistros: 1000, maxBytesMetadatos: 1000000, maxBytesArchivo: 8000000, maxProfundidad: 64 },
      metadata: { formato: 1, fotoId: '12345678-1234-4123-8123-123456789abc', destino: {
        tipo: 'parada', viajeId: plan.id, paradaId: plan.dias[0].paradas[0].id }, nombre: '\0 e\u0301 ',
      mimeDeclarado: 'image/heic', incorporada: -0, ultimaModificacion: -0,
      bytesOriginal: (1 << 20) + 5, miniatura: { tipo: 'pendiente' } }, abrir, poner, leer } });
  });
}

test('M1: catálogo inválido se rechaza en siete fronteras sin aperturas, legacy ni lecturas binarias; control válido ausente', async ({ page }) => {
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
          ['historia-constructor', () => c.historia.crearPortabilidadHistorica({ plan, limites: c.limites, limitesHistoria: c.limitesHistoria })],
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
  expect(r.validasAusentes).toBe(true); expect(r.resultados).toHaveLength(28);
  for (const resultado of r.resultados) {
    expect(resultado, `${resultado.caso}/${resultado.frontera}`).toMatchObject({ rechazado: true,
      diagnostico: true, aperturas: 0, lecturas: 0, legado: 0 });
  }
});

test('MIME crudo incompatible con Blob nativo rechaza archivo canónico con CRC válido sin aperturas ni escrituras', async ({ page }) => {
  const r = await page.evaluate(async () => {
    const c = window.fixturePortable; const antes = await indexedDB.databases();
    const fotoId = c.metadata.fotoId; const original = new Blob(['123456789'], { type: 'image/heic' });
    const a = await c.portable.exportarArchivoPortable(c.plan, { viajeId: c.plan.id,
      fotos: { presente: true, tablas: { metadatos: [{ clave: fotoId, valor: { ...c.metadata, bytesOriginal: 9 } }],
        originales: [{ clave: fotoId, valor: original }], miniaturas: [] } },
      progreso: { presente: false, tablas: {} }, respaldos: { presente: false, tablas: {} },
      legado: { marcas: null, 'marcas-hora': null, 'pendientes-hechos': null } }, c.limites);
    const control = await c.portable.inspeccionarArchivoPortable(c.plan, a.archivo, c.limites);
    const manifiesto = JSON.parse(c.portable.codificarJsonFiel(a.manifiesto, c.limites));
    manifiesto.segmentos[0].mime = 'IMAGE/HEIC';
    const bytes = new TextEncoder().encode(c.portable.codificarJsonFiel(manifiesto, c.limites));
    let crc = 0xffffffff;
    for (const byte of bytes) {
      crc ^= byte; for (let i = 0; i < 8; i++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
    }
    const cabecera = new Uint8Array(24); cabecera.set(new TextEncoder().encode('ITINPORT'));
    const dv = new DataView(cabecera.buffer); dv.setUint32(8, 1); dv.setBigUint64(12, BigInt(bytes.length));
    dv.setUint32(20, (crc ^ 0xffffffff) >>> 0);
    const archivo = new Blob([cabecera, bytes, original]);
    const abrir = IDBFactory.prototype.open; const transaction = IDBDatabase.prototype.transaction;
    let aperturas = 0; let escrituras = 0; let rechazado = false; let diagnostico = false;
    IDBFactory.prototype.open = function (...args: Parameters<typeof abrir>) {
      aperturas++; return abrir.apply(this, args);
    };
    IDBDatabase.prototype.transaction = function (...args: Parameters<typeof transaction>) {
      if (args[1] === 'readwrite') escrituras++;
      return transaction.apply(this, args);
    };
    let rechazoHistoria = '';
    try {
      try { await c.portable.inspeccionarArchivoPortable(c.plan, archivo, c.limites); }
      catch (e) { rechazado = true; diagnostico = e instanceof Error && e.message.includes('MIME'); }
      rechazoHistoria = (await c.historia.crearPortabilidadHistorica({ plan: c.plan, limites: c.limites,
        limitesHistoria: c.limitesHistoria }).importar(archivo)).tipo;
    } finally { IDBFactory.prototype.open = abrir; IDBDatabase.prototype.transaction = transaction; }
    return { antes, despues: await indexedDB.databases(), aperturas, escrituras, rechazado, diagnostico, rechazoHistoria,
      controlMime: control.leerSegmento(0).type, descriptor: manifiesto.segmentos[0].mime,
      crcOriginal: manifiesto.segmentos[0].crc32, bytes: [...new Uint8Array(await original.arrayBuffer())] };
  });
  expect(r).toEqual({ antes: [], despues: [], aperturas: 0, escrituras: 0, rechazado: true, diagnostico: true,
    rechazoHistoria: 'rechazado-antes-escribir', controlMime: 'image/heic', descriptor: 'IMAGE/HEIC', crcOriginal: 0xcbf43926,
    bytes: [49, 50, 51, 52, 53, 54, 55, 56, 57] });
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

test('restaurador dedicado nativo: lote de tres stores, bytes completos, miniatura y tombstone; colisión no escribe ninguna foto', async ({ page }) => {
  const r = await page.evaluate(async () => {
    const c = window.fixturePortable; const bytes = new Uint8Array((1 << 20) + 5); bytes.fill(23); bytes[bytes.length - 1] = 255;
    const fotoId = c.metadata.fotoId; const tombstone = '22345678-1234-4123-8123-123456789abc';
    const otra = '32345678-1234-4123-8123-123456789abc';
    const miniatura = new Blob([new Uint8Array([0, 7, 254])], { type: 'image/png' });
    const base: import('../src/portabilidad').BasePortable = { presente: true, tablas: {
      metadatos: [{ clave: fotoId, valor: { ...c.metadata, miniatura: { tipo: 'lista', bytes: 3, ancho: 1, alto: 1, mime: 'image/png' } } },
        { clave: tombstone, valor: { formato: 1, tipo: 'borrada', fotoId: tombstone } }],
      originales: [{ clave: fotoId, valor: new Blob([bytes], { type: 'image/heic' }) }], miniaturas: [{ clave: fotoId, valor: miniatura }] } };
    const restaurador = c.fotos.crearRestauradorFotosPortable(c.plan, c.limites);
    const modos: { tablas: string[]; modo: string }[] = []; const transaction = IDBDatabase.prototype.transaction;
    IDBDatabase.prototype.transaction = function (...args: Parameters<typeof transaction>) {
      if (args[1] === 'readwrite') modos.push({ tablas: typeof args[0] === 'string' ? [args[0]] : Array.from(args[0]), modo: args[1] });
      return transaction.apply(this, args);
    };
    let resultado;
    try { resultado = await restaurador.restaurar(base); } finally { IDBDatabase.prototype.transaction = transaction; }
    const f = await c.fotos.abrirFotosLocal(c.plan);
    const original = new Uint8Array(await (await f.leerOriginal(fotoId))!.arrayBuffer());
    const mini = [...new Uint8Array(await (await f.leerMiniatura(fotoId))!.arrayBuffer())];
    const metadata = await f.leerMetadatos(fotoId) as import('../src/fotos').MetadatosFoto;
    const borrada = await f.leerMetadatos(tombstone);
    await f.guardarMiniatura(fotoId, new Blob([new Uint8Array([0, 7, 253])], { type: 'image/png' }), 1, 1);
    const noop = await restaurador.restaurar(base);
    const local = [...new Uint8Array(await (await f.leerMiniatura(fotoId))!.arrayBuffer())];
    const distinta = bytes.slice(); distinta[distinta.length - 1] = 254;
    const conflicto: import('../src/portabilidad').BasePortable = { presente: true, tablas: {
      metadatos: [...base.tablas.metadatos, { clave: otra, valor: { ...structuredClone(c.metadata), fotoId: otra, bytesOriginal: 3 } }],
      originales: [{ clave: fotoId, valor: new Blob([distinta], { type: 'image/heic' }) },
        { clave: otra, valor: new Blob(['abc'], { type: 'image/heic' }) }], miniaturas: base.tablas.miniaturas } };
    const rechazo = await restaurador.restaurar(conflicto); const ausente = await f.leerOriginal(otra); f.cerrar();
    const archivo = await c.portable.exportarArchivoPortable(c.plan, { viajeId: c.plan.id,
      fotos: await c.fotos.capturarFotosLocal(c.plan, c.limites), progreso: { presente: false, tablas: {} },
      respaldos: { presente: false, tablas: {} }, legado: { marcas: '\0 e\u0301 ', 'marcas-hora': '', 'pendientes-hechos': null } }, c.limites);
    const h = c.historia.crearPortabilidadHistorica({ plan: c.plan, limites: c.limites, limitesHistoria: c.limitesHistoria });
    const job = await h.importar(archivo.archivo); const reabierta = (await h.consultar(job.trabajoId!))!;
    const indice = reabierta.contenido.segmentos.findIndex((s) => s.tabla === 'originales');
    const historico = new Uint8Array(await reabierta.leerSegmento(indice).arrayBuffer());
    return { resultado, modos, historicoExacto: historico.length === bytes.length && historico.every((b, i) => b === bytes[i]), todos: original.every((b, i) => b === bytes[i]), cantidad: original.length, mini,
      nombre: metadata.nombre, signo: Object.is(metadata.incorporada, -0), borrada, noop, local, rechazo, ausente,
      bases: (await indexedDB.databases()).map((d) => d.name) };
  });
  expect(r.resultado).toMatchObject({ tipo: 'observadas', transaccion: 'confirmada' });
  expect(r.modos).toEqual([{ tablas: ['metadatos', 'originales', 'miniaturas'], modo: 'readwrite' }]);
  expect(r).toMatchObject({ todos: true, cantidad: (1 << 20) + 5, mini: [0, 7, 254], nombre: '\0 e\u0301 ', signo: true,
    borrada: { tipo: 'borrada' }, local: [0, 7, 253], ausente: null,
    rechazo: { tipo: 'conflicto-preflight', transaccion: 'no-intentada' } });
  expect(r.noop).toMatchObject({ tipo: 'observadas', fotos: [{ derivacion: 'diferente' }, { tipo: 'tombstone' }] });
  expect(r.historicoExacto).toBe(true); expect(r.bases).toHaveLength(2);
  expect(r.bases.some((n) => n!.startsWith('itinerario-portabilidad:'))).toBe(true);
});

test('restaurador nativo: request success→abort y alta concurrente no confirman autoría, reintento manual atesta', async ({ page }) => {
  const r = await page.evaluate(async () => {
    const c = window.fixturePortable; const fotoId = c.metadata.fotoId;
    const base: import('../src/portabilidad').BasePortable = { presente: true, tablas: {
      metadatos: [{ clave: fotoId, valor: { ...c.metadata, bytesOriginal: 3 } }],
      originales: [{ clave: fotoId, valor: new Blob(['abc'], { type: 'image/heic' }) }], miniaturas: [] } };
    const restaurador = c.fotos.crearRestauradorFotosPortable(c.plan, c.limites);
    const add = IDBObjectStore.prototype.add; let requestExitosa = false;
    IDBObjectStore.prototype.add = function (...args: Parameters<typeof add>) {
      const req = add.apply(this, args);
      if (this.name === 'originales') req.addEventListener('success', () => { requestExitosa = true; this.transaction.abort(); });
      return req;
    };
    let abortada;
    try { abortada = await restaurador.restaurar(base); } finally { IDBObjectStore.prototype.add = add; }
    const vacia = await c.fotos.capturarFotosLocal(c.plan, c.limites);
    const abrir = IDBFactory.prototype.open; let insertada = false;
    IDBFactory.prototype.open = function (...args: Parameters<typeof abrir>) {
      const req = abrir.apply(this, args);
      if (args[1] === 1 && !insertada) req.addEventListener('success', () => {
        insertada = true; const tx = req.result.transaction(['metadatos', 'originales', 'miniaturas'], 'readwrite');
        tx.objectStore('metadatos').add(base.tablas.metadatos[0].valor, fotoId);
        tx.objectStore('originales').add(base.tablas.originales[0].valor, fotoId);
      });
      return req;
    };
    let carrera;
    try { carrera = await c.fotos.crearRestauradorFotosPortable(c.plan, c.limites).restaurar(base); }
    finally { IDBFactory.prototype.open = abrir; }
    const manual = await restaurador.restaurar(base);
    return { abortada, requestExitosa, vacia, insertada, carrera, manual };
  });
  expect(r).toMatchObject({ requestExitosa: true, insertada: true,
    abortada: { tipo: 'tx-abortada', transaccion: 'abortada' },
    vacia: { presente: true, tablas: { metadatos: [], originales: [], miniaturas: [] } },
    carrera: { tipo: 'observadas', transaccion: 'abortada' },
    manual: { tipo: 'observadas', transaccion: 'confirmada', fotos: [{ tipo: 'existente' }] } });
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

test('historia nativa root3 SENT/NEG y recibo: reabre datos separados, conserva activos y migra conjunto plano sólo con fotos actuales', async ({ page, browser }) => {
  const transferencia = await page.evaluate(async () => {
    const c = window.fixturePortable; const p = c.plan; const fotoId = c.metadata.fotoId;
    const f = await c.fotos.abrirFotosLocal(p); const metadata = { ...c.metadata, bytesOriginal: 3 };
    const captura = { metadatos: metadata, original: new Blob(['abc'], { type: 'image/heic' }) }; await f.guardarOriginal(captura);
    const progreso = await c.progreso.abrirProgresoLocal(p, { dispositivoId: 'causal-no-credencial' });
    const enviada = { id: 'sent', dispositivoId: 'causal-no-credencial', tipo: 'parada' as const,
      paradaId: p.dias[0].paradas[0].id, marca: 'hecha' as const, revision: 0, horaReal: -0 };
    await progreso.registrar(enviada); await progreso.marcarEnviada('sent');
    const negada = { ...enviada, id: 'neg', paradaId: p.dias[0].paradas[1].id, revision: 0, marca: 'saltada' as const };
    await progreso.registrar(negada); await progreso.marcarEnviada('neg'); const antesNeg = await progreso.leer();
    const decision = await progreso.recibirRechazo({ protocolo: 1, viajeId: p.id, operacionId: 'neg', operacionOriginal: negada,
      decisionPersistida: true, motivo: 'conflicto', instantanea: { revisionServidor: 1, estado: antesNeg.confirmado } });
    if (decision.tipo !== 'rechazada') throw new Error('Fixture NEG no válida');
    const ledger = await c.ledger.abrirRespaldoFotosLocal(p, f);
    const entrada = await ledger.preparar(captura, '32345678-1234-4123-8123-123456789abc');
    const ref = { fotoId, operacionId: entrada.operacionId, original: entrada.original }; await ledger.marcarEnviada(ref);
    await ledger.confirmarRecibo({ version: 1, tipo: 'acuse-respaldo', viajeId: p.id, ...ref,
      objetoOriginalDurable: true, metadatosDurables: true });
    localStorage.setItem('fixture-marcas', '\0 e\u0301 '); localStorage.setItem('fixture-marcas-hora', '');
    localStorage.setItem('fixture-marcador', 'no-autoridad');
    const e = c.composicion.crearExportadorLocal({ plan: p, limites: c.limites, limitesHistoria: c.limitesHistoria,
      leerLegado: (campo) => localStorage.getItem(`fixture-${campo}`) });
    const actual = await e.exportarActual(); const rootAntes = await progreso.leer(); const ledgerAntes = await ledger.leer(fotoId);
    const h = c.historia.crearPortabilidadHistorica({ plan: p, limites: c.limites, limitesHistoria: c.limitesHistoria });
    const importado = await h.importar(actual.archivo.archivo); localStorage.removeItem('fixture-marcador');
    const historica = (await h.consultar(importado.trabajoId!))!;
    const root = historica.contenido.captura.progreso.tablas.viajes[0].valor as import('../src/progreso-local').RegistroLocal;
    const textoRoot = (v: unknown) => c.portable.codificarJsonFiel(c.portable.copiarValoresProgresoPortable(v, c.limites), c.limites);
    const activosIguales = textoRoot(rootAntes) === textoRoot(await progreso.leer())
      && c.portable.codificarJsonFiel(ledgerAntes, c.limites) === c.portable.codificarJsonFiel(await ledger.leer(fotoId), c.limites);
    const originalExacto = new Uint8Array(await (await h.exportarOriginal(importado.trabajoId!)).arrayBuffer());
    const inicial = new Uint8Array(await actual.archivo.archivo.arrayBuffer());
    const antiguo = await c.portable.exportarArchivoPortable(p, { viajeId: p.id,
      fotos: { presente: true, tablas: { metadatos: [{ clave: fotoId, valor: { formato: 1, tipo: 'borrada', fotoId } }], originales: [], miniaturas: [] } },
      progreso: { presente: false, tablas: {} }, respaldos: { presente: false, tablas: {} },
      legado: { marcas: 'antiguo', 'marcas-hora': null, 'pendientes-hechos': null } }, c.limites);
    await h.archivar(antiguo.archivo);
    let legacyRechazado = false; try { await e.exportar(); } catch (error) { legacyRechazado = (error as { codigo: string }).codigo === 'historia-presente'; }
    const presupuesto = { maxArchivos: 20, maxBytesConjunto: 80000000, maxBytesInventario: 1000000,
      maxRegistrosConjunto: 10000, maxObservaciones: 1000, maxProcedencias: 1000 };
    const conjunto = await e.exportarRecuperacion(presupuesto);
    f.cerrar(); progreso.cerrar(); ledger.cerrar();
    return { inventario: [...new Uint8Array(await conjunto.inventario.arrayBuffer())],
      archivos: await Promise.all(conjunto.archivos.map(async (a) => ({ referencia: a.referencia, bytes: [...new Uint8Array(await a.archivo.arrayBuffer())] }))),
      presupuesto, jobsOrigen: (await h.listar()).map((r) => r.trabajoId), activosIguales, legacyRechazado,
      bytesIguales: originalExacto.every((b, i) => b === inicial[i]) && originalExacto.length === inicial.length,
      enviada: root.cola.some((e) => e.operacion.id === 'sent' && e.enviada), negada: root.cola.some((e) => e.operacion.id === 'neg' && !!e.rechazo),
      legado: historica.contenido.captura.legado, marker: localStorage.getItem('fixture-marcador'), excluidas: actual.excluidas };
  });
  expect(transferencia).toMatchObject({ activosIguales: true, legacyRechazado: true, bytesIguales: true, enviada: true, negada: true,
    marker: null, legado: { marcas: '\0 e\u0301 ', 'marcas-hora': '', 'pendientes-hechos': null } });
  expect(transferencia.archivos).toHaveLength(3); expect(transferencia.excluidas).toContain('historia-archivada');
  const contexto = await browser.newContext(); const destino = await contexto.newPage(); let externas = 0;
  await destino.route('**/*', (r) => { if (new URL(r.request().url()).origin === origen) return r.continue(); externas++; return r.abort(); });
  try {
    await destino.goto(origen); await cargar(destino);
    const resultado = await destino.evaluate(async (transferencia) => {
      const c = window.fixturePortable; const conjunto = { inventario: new Blob([new Uint8Array(transferencia.inventario)]),
        archivos: transferencia.archivos.map((a) => ({ referencia: a.referencia, archivo: new Blob([new Uint8Array(a.bytes)]) })) };
      const opciones = { plan: c.plan, limites: c.limites, limitesHistoria: c.limitesHistoria };
      const r = await c.composicion.crearImportadorRecuperacionLocal(opciones).importarConjunto(conjunto, transferencia.presupuesto);
      const h = c.historia.crearPortabilidadHistorica(opciones); const historicas = await h.listar();
      const usados = new Set<number>(); const todosExactos: boolean[] = [];
      for (const r of historicas) {
        const bytes = new Uint8Array(await r.archivo.arrayBuffer());
        const i = transferencia.archivos.findIndex((a, n) => !usados.has(n)
          && bytes.length === a.bytes.length && bytes.every((b, j) => b === a.bytes[j]));
        todosExactos.push(i >= 0); if (i >= 0) usados.add(i);
      }
      const f = await c.fotos.abrirFotosLocal(c.plan); const original = await (await f.leerOriginal(c.metadata.fotoId))!.text(); f.cerrar();
      const siguiente = await c.composicion.crearExportadorLocal({ ...opciones, leerLegado: () => null }).exportarRecuperacion(transferencia.presupuesto);
      const inventario = (await c.portable.inspeccionarConjuntoRecuperacion(c.plan, siguiente, c.limites, transferencia.presupuesto)).inventario;
      return { tipo: r.tipo, foto: r.actual?.fotos?.tipo, original, cantidad: historicas.length, todosExactos: todosExactos.every(Boolean),
        jobsLocales: historicas.every((r) => !transferencia.jobsOrigen.includes(r.trabajoId)),
        procedencia: historicas.some((r) => r.procedencias.some((p) => transferencia.jobsOrigen.includes(p.trabajoId))),
        bases: (await indexedDB.databases()).map((d) => d.name), ls: localStorage.length, siguientes: siguiente.archivos.length,
        plano: inventario.archivos.every((a) => a.procedencias.every((p) => Object.keys(p).sort().join(',') === 'trabajoId,viajeId')),
        transferenciaSiguiente: { inventario: [...new Uint8Array(await siguiente.inventario.arrayBuffer())],
          archivos: await Promise.all(siguiente.archivos.map(async (a) => ({ referencia: a.referencia,
            bytes: [...new Uint8Array(await a.archivo.arrayBuffer())] }))) } };
    }, transferencia);
    expect(resultado).toMatchObject({ tipo: 'historia-confirmada', foto: 'observadas', original: 'abc', cantidad: 3,
      todosExactos: true, jobsLocales: true, procedencia: true, ls: 0, siguientes: 4, plano: true });
    expect(resultado.bases.sort()).toEqual([`itinerario-fotos:${encodeURIComponent('d64bf870a2c193e5')}`,
      `itinerario-portabilidad:${encodeURIComponent('d64bf870a2c193e5')}`].sort()); expect(externas).toBe(0);
    const tercero = await browser.newContext(); const tercera = await tercero.newPage();
    await tercera.route('**/*', (r) => { if (new URL(r.request().url()).origin === origen) return r.continue(); externas++; return r.abort(); });
    try {
      await tercera.goto(origen); await cargar(tercera);
      const segundaMigracion = await tercera.evaluate(async ({ transferencia, presupuesto }) => {
        const c = window.fixturePortable; const conjunto = { inventario: new Blob([new Uint8Array(transferencia.inventario)]),
          archivos: transferencia.archivos.map((a) => ({ referencia: a.referencia, archivo: new Blob([new Uint8Array(a.bytes)]) })) };
        const opciones = { plan: c.plan, limites: c.limites, limitesHistoria: c.limitesHistoria };
        const r = await c.composicion.crearImportadorRecuperacionLocal(opciones).importarConjunto(conjunto, presupuesto);
        const exportador = c.composicion.crearExportadorLocal({ ...opciones, leerLegado: () => null });
        const siguiente = await exportador.exportarRecuperacion(presupuesto);
        const inv = (await c.portable.inspeccionarConjuntoRecuperacion(c.plan, siguiente, c.limites, presupuesto)).inventario;
        return { tipo: r.tipo, cantidad: (await c.historia.crearPortabilidadHistorica(opciones).listar()).length,
          siguientes: siguiente.archivos.length, plano: inv.archivos.every((a) => a.procedencias.every((p) => Object.keys(p).length === 2)) };
      }, { transferencia: resultado.transferenciaSiguiente, presupuesto: transferencia.presupuesto });
      expect(segundaMigracion).toEqual({ tipo: 'historia-confirmada', cantidad: 4, siguientes: 5, plano: true }); expect(externas).toBe(0);
    } finally { await tercero.close(); }
  } finally { await contexto.close(); }
});

test('historia nativa: cuota foto parcial, retry manual, respuesta perdida y fallo durable de observación conservan archivo', async ({ page }) => {
  const r = await page.evaluate(async () => {
    const c = window.fixturePortable; const fotoId = c.metadata.fotoId;
    const archivo = (await c.portable.exportarArchivoPortable(c.plan, { viajeId: c.plan.id,
      fotos: { presente: true, tablas: { metadatos: [{ clave: fotoId, valor: { ...c.metadata, bytesOriginal: 3 } }],
        originales: [{ clave: fotoId, valor: new Blob(['abc'], { type: 'image/heic' }) }], miniaturas: [] } },
      progreso: { presente: false, tablas: {} }, respaldos: { presente: false, tablas: {} },
      legado: { marcas: null, 'marcas-hora': null, 'pendientes-hechos': null } }, c.limites)).archivo;
    const opciones = { plan: c.plan, limites: c.limites, limitesHistoria: c.limitesHistoria };
    const h = c.historia.crearPortabilidadHistorica(opciones); const add = IDBObjectStore.prototype.add;
    IDBObjectStore.prototype.add = function (...args: Parameters<typeof add>) {
      if (this.name === 'originales') throw new DOMException('Cuota foto inyectada', 'QuotaExceededError');
      return add.apply(this, args);
    };
    let parcial; try { parcial = await h.importar(archivo); } finally { IDBObjectStore.prototype.add = add; }
    const recuperada = await h.exportarOriginal(parcial.trabajoId!); const antes = new Uint8Array(await archivo.arrayBuffer());
    const bytes = new Uint8Array(await recuperada.arrayBuffer()); const reabierta = c.historia.crearPortabilidadHistorica(opciones);
    const manual = await reabierta.reintentar(parcial.trabajoId!);
    const otro = new Blob([archivo.slice(0, -1), new Uint8Array([255])]); const diferente = await reabierta.reintentar(parcial.trabajoId!, otro);
    const driver = c.fotos.crearRestauradorFotosPortable(c.plan, c.limites);
    const perdida = await c.historia.crearPortabilidadHistorica({ ...opciones,
      restaurador: { restaurar: async (b) => { await driver.restaurar(b); throw new Error('Respuesta perdida'); } } }).importar(archivo);
    const put = IDBObjectStore.prototype.put;
    IDBObjectStore.prototype.put = function (...args: Parameters<typeof put>) {
      if (this.name === 'importaciones') throw new DOMException('Cuota resultado inyectada', 'QuotaExceededError');
      return put.apply(this, args);
    };
    let resultadoFallido; try { resultadoFallido = await h.importar(archivo); } finally { IDBObjectStore.prototype.put = put; }
    const consulta = (await h.consultar(resultadoFallido.trabajoId!))!;
    return { parcial, manual, diferente, perdida, resultadoFallido, archivoConservado: bytes.length === antes.length && bytes.every((b, i) => b === antes[i]),
      obsFallida: consulta.observaciones.length, cantidad: (await h.listar()).length };
  });
  expect(r).toMatchObject({ parcial: { historia: 'confirmada', fotos: { tipo: 'tx-abortada', transaccion: 'abortada' } },
    manual: { historia: 'confirmada', fotos: { tipo: 'observadas' } }, diferente: { tipo: 'rechazado-antes-escribir' },
    perdida: { fotos: { tipo: 'observadas', transaccion: 'incierta' } }, resultadoFallido: { tipo: 'resultado-durable-incierto', fotos: { tipo: 'observadas' } },
    archivoConservado: true, obsFallida: 0, cantidad: 3 });
});

test('conjunto nativo corrupto último histórico/extras/límites y archivo truncado rechazan antes de abrir cualquier DB', async ({ page }) => {
  const r = await page.evaluate(async () => {
    const c = window.fixturePortable; const presupuesto = { maxArchivos: 10, maxBytesConjunto: 80000000, maxBytesInventario: 1000000,
      maxRegistrosConjunto: 10000, maxObservaciones: 1000, maxProcedencias: 1000 };
    const actual = await c.composicion.crearExportadorLocal({ plan: c.plan, limites: c.limites, leerLegado: () => null }).exportar();
    const historico = (await c.portable.exportarArchivoPortable(c.plan, { viajeId: c.plan.id,
      fotos: { presente: true, tablas: { metadatos: [{ clave: c.metadata.fotoId, valor: { ...c.metadata, bytesOriginal: 3 } }],
        originales: [{ clave: c.metadata.fotoId, valor: new Blob(['abc'], { type: 'image/heic' }) }], miniaturas: [] } },
      progreso: { presente: false, tablas: {} }, respaldos: { presente: false, tablas: {} },
      legado: { marcas: null, 'marcas-hora': null, 'pendientes-hechos': null } }, c.limites)).archivo;
    const conjunto = await c.portable.crearConjuntoRecuperacion(c.plan, actual.archivo, [{ trabajoId: 'origen-no-autorizacion',
      archivo: historico, observaciones: [{ tipo: 'sin-fotos', transaccion: 'no-intentada', fotos: [] }],
      procedencias: [{ viajeId: c.plan.id, trabajoId: 'procedencia-no-autoridad' }] }], c.limites, presupuesto);
    const abrir = IDBFactory.prototype.open; let aperturas = 0;
    IDBFactory.prototype.open = function (...args: Parameters<typeof abrir>) { aperturas++; return abrir.apply(this, args); };
    const resultados = [];
    try {
      const importer = c.composicion.crearImportadorRecuperacionLocal({ plan: c.plan, limites: c.limites, limitesHistoria: c.limitesHistoria });
      for (const caso of ['ultimo-crc', 'extra', 'falta', 'duplicado', 'bytes', 'inventario', 'inventario-extra', 'version', 'no-canonico', 'registros', 'observaciones', 'procedencias', 'archivos']) {
        let archivos = [...conjunto.archivos]; const limites = { ...presupuesto }; let inventario = conjunto.inventario;
        if (caso === 'ultimo-crc') { const a = archivos[1]; archivos[1] = { ...a, archivo: new Blob([a.archivo.slice(0, -1), new Uint8Array([255])]) }; }
        if (caso === 'inventario-extra' || caso === 'version') {
          const m = JSON.parse(await conjunto.inventario.text()); if (caso === 'version') m.formato = 2; else m.extra = true;
          inventario = new Blob([c.portable.codificarJsonFiel(m, c.limites)]);
        }
        if (caso === 'no-canonico') inventario = new Blob([' ', conjunto.inventario]);
        if (caso === 'registros') limites.maxRegistrosConjunto = 0;
        if (caso === 'observaciones') limites.maxObservaciones = 0;
        if (caso === 'procedencias') limites.maxProcedencias = 0;
        if (caso === 'archivos') limites.maxArchivos = 1;
        if (caso === 'extra') archivos.push({ referencia: 'historico-99999999', archivo: actual.archivo });
        if (caso === 'falta') archivos = archivos.slice(0, -1);
        if (caso === 'duplicado') archivos.push(archivos[0]);
        if (caso === 'bytes') limites.maxBytesConjunto = 0;
        if (caso === 'inventario') limites.maxBytesInventario = conjunto.inventario.size - 1;
        resultados.push((await importer.importarConjunto({ inventario, archivos }, limites)).tipo);
      }
      resultados.push((await c.historia.crearPortabilidadHistorica({ plan: c.plan, limites: c.limites,
        limitesHistoria: c.limitesHistoria }).importar(actual.archivo.slice(0, -1))).tipo);
    } finally { IDBFactory.prototype.open = abrir; }
    return { resultados, aperturas, bases: await indexedDB.databases() };
  });
  expect(r).toEqual({ resultados: Array(14).fill('rechazado-antes-escribir'), aperturas: 0, bases: [] });
});

test('control nativo válido all-absent: sólo HistoryDB v1, un store sin índices; original recuperable sin progreso/ledger/fotos', async ({ page }) => {
  const r = await page.evaluate(async () => {
    const c = window.fixturePortable; const archivo = await c.composicion.crearExportadorLocal({ plan: c.plan,
      limites: c.limites, leerLegado: (campo) => campo === 'marcas' ? '' : null }).exportar();
    const h = c.historia.crearPortabilidadHistorica({ plan: c.plan, limites: c.limites, limitesHistoria: c.limitesHistoria });
    const resultado = await h.importar(archivo.archivo); const reabierta = (await h.consultar(resultado.trabajoId!))!;
    const nombre = `itinerario-portabilidad:${encodeURIComponent(c.plan.id)}`;
    const db = await new Promise<IDBDatabase>((ok, no) => { const s = indexedDB.open(nombre); s.onsuccess = () => ok(s.result); s.onerror = () => no(s.error); });
    const t = db.transaction('importaciones').objectStore('importaciones');
    const esquema = { version: db.version, tablas: Array.from(db.objectStoreNames), keyPath: t.keyPath,
      autoIncrement: t.autoIncrement, indices: t.indexNames.length }; db.close();
    const bytes = new Uint8Array(await reabierta.archivo.arrayBuffer()); const original = new Uint8Array(await archivo.archivo.arrayBuffer());
    return { resultado, esquema, bases: (await indexedDB.databases()).map((d) => d.name), nombre,
      exacto: bytes.length === original.length && bytes.every((b, i) => b === original[i]), legado: reabierta.contenido.captura.legado, ls: localStorage.length };
  });
  expect(r).toMatchObject({ resultado: { historia: 'confirmada', fotos: { tipo: 'sin-fotos', transaccion: 'no-intentada' } },
    esquema: { version: 1, tablas: ['importaciones'], keyPath: null, autoIncrement: false, indices: 0 },
    exacto: true, legado: { marcas: '', 'marcas-hora': null, 'pendientes-hechos': null }, ls: 0 });
  expect(r.bases).toEqual([r.nombre]);
});

test('historia nativa future/schema extra/corrupt data preservados; nunca falso vacío ni reset', async ({ page }) => {
  const r = await page.evaluate(async () => {
    const c = window.fixturePortable; const resultados = [];
    for (const caso of ['futuro', 'extra', 'corrupto']) {
      const plan = structuredClone(c.plan); Object.assign(plan, { id: `${c.plan.id}-${caso}` });
      const nombre = `itinerario-portabilidad:${encodeURIComponent(plan.id)}`;
      const db = await new Promise<IDBDatabase>((ok, no) => {
        const s = indexedDB.open(nombre, caso === 'futuro' ? 2 : 1);
        s.onupgradeneeded = () => { s.result.createObjectStore('importaciones'); if (caso === 'extra') s.result.createObjectStore('extra'); };
        s.onsuccess = () => ok(s.result); s.onerror = () => no(s.error);
      });
      await c.poner(db, 'importaciones', c.metadata.fotoId, { conservar: 'desconocido' });
      const h = c.historia.crearPortabilidadHistorica({ plan, limites: c.limites, limitesHistoria: c.limitesHistoria });
      let rechazado = false; try { await h.listar(); } catch { rechazado = true; }
      let exportacion = ''; try { await c.composicion.crearExportadorLocal({ plan, limites: c.limites, leerLegado: () => null }).exportar(); }
      catch (e) { exportacion = (e as { codigo: string }).codigo; }
      resultados.push({ caso, rechazado, exportacion, version: db.version, datos: await c.leer(db, 'importaciones', c.metadata.fotoId) }); db.close();
    }
    return resultados;
  });
  expect(r).toEqual(['futuro', 'extra', 'corrupto'].map((caso) => ({ caso, rechazado: true,
    exportacion: 'historia-no-valida', version: caso === 'futuro' ? 2 : 1, datos: { conservar: 'desconocido' } })));
});

test('historia nativa: éxito de request no confirma archivo; oncomplete foto con postread fallido conserva incertidumbre', async ({ page }) => {
  const r = await page.evaluate(async () => {
    const c = window.fixturePortable; const archivo = (await c.portable.exportarArchivoPortable(c.plan, {
      viajeId: c.plan.id, fotos: { presente: true, tablas: {
        metadatos: [{ clave: c.metadata.fotoId, valor: { ...c.metadata, bytesOriginal: 3 } }],
        originales: [{ clave: c.metadata.fotoId, valor: new Blob(['abc'], { type: 'image/heic' }) }], miniaturas: [] } },
      progreso: { presente: false, tablas: {} }, respaldos: { presente: false, tablas: {} },
      legado: { marcas: null, 'marcas-hora': null, 'pendientes-hechos': null } }, c.limites)).archivo;
    const h = c.historia.crearPortabilidadHistorica({ plan: c.plan, limites: c.limites, limitesHistoria: c.limitesHistoria });
    const add = IDBObjectStore.prototype.add; let requestExitosa = false;
    IDBObjectStore.prototype.add = function (...args: Parameters<typeof add>) {
      const req = add.apply(this, args);
      if (this.name === 'importaciones') req.addEventListener('success', () => { requestExitosa = true; this.transaction.abort(); });
      return req;
    };
    let abortada; try { abortada = await h.importar(archivo); } finally { IDBObjectStore.prototype.add = add; }
    const vacia = (await h.listar()).length;
    let fotoConfirmada = false; let fotoProgramada = false; const open = IDBFactory.prototype.open;
    IDBObjectStore.prototype.add = function (...args: Parameters<typeof add>) {
      if (this.name === 'originales') {
        fotoProgramada = true;
        this.transaction.addEventListener('complete', () => { fotoConfirmada = true; });
      }
      return add.apply(this, args);
    };
    IDBFactory.prototype.open = function (...args: Parameters<typeof open>) {
      // El driver no abre otra lectura entre add y el desenlace TX. No depender del orden
      // de microtasks entre listeners de complete para activar el fallo del postread.
      if (fotoProgramada && args[0].startsWith('itinerario-fotos:') && args[1] === undefined) throw new Error('Postread inyectado');
      return open.apply(this, args);
    };
    let incierta;
    try { incierta = await c.historia.crearPortabilidadHistorica({ plan: c.plan, limites: c.limites, limitesHistoria: c.limitesHistoria }).importar(archivo); }
    finally { IDBObjectStore.prototype.add = add; IDBFactory.prototype.open = open; }
    const f = await c.fotos.abrirFotosLocal(c.plan); const original = await (await f.leerOriginal(c.metadata.fotoId))!.text(); f.cerrar();
    const durable = (await h.consultar(incierta.trabajoId!))!.observaciones;
    return { abortada, vacia, requestExitosa, fotoConfirmada, incierta, original, durable };
  });
  expect(r).toMatchObject({ requestExitosa: true, vacia: 0, fotoConfirmada: true, original: 'abc',
    abortada: { tipo: 'historia-no-confirmada', baseHistorica: 'creada', fotos: null },
    incierta: { historia: 'confirmada', fotos: { tipo: 'lectura-posterior-fallida', transaccion: 'confirmada' } },
    durable: [{ tipo: 'lectura-posterior-fallida', transaccion: 'confirmada' }] });
});

test('restaurador nativo: tombstone intercalado no resucita y derivación fresca concurrente se conserva', async ({ page }) => {
  const r = await page.evaluate(async () => {
    const c = window.fixturePortable; const resultados = [];
    for (const caso of ['tombstone', 'derivacion']) {
      const plan = structuredClone(c.plan); Object.assign(plan, { id: `${c.plan.id}-${caso}` });
      const metadata = { ...c.metadata, destino: { ...c.metadata.destino, viajeId: plan.id }, bytesOriginal: 3 };
      const original = new Blob(['abc'], { type: 'image/heic' }); const fotoId = metadata.fotoId;
      const f = await c.fotos.abrirFotosLocal(plan); await f.guardarOriginal({ metadatos: metadata, original }); f.cerrar();
      const open = IDBFactory.prototype.open; let intercalada = false;
      IDBFactory.prototype.open = function (...args: Parameters<typeof open>) {
        const req = open.apply(this, args);
        if (args[1] === 1 && !intercalada) req.addEventListener('success', () => {
          intercalada = true; const tx = req.result.transaction(['metadatos', 'originales', 'miniaturas'], 'readwrite');
          if (caso === 'tombstone') { tx.objectStore('metadatos').put({ formato: 1, tipo: 'borrada', fotoId }, fotoId); tx.objectStore('originales').delete(fotoId); }
          else { tx.objectStore('metadatos').put({ ...metadata, miniatura: { tipo: 'lista', bytes: 1, ancho: 1, alto: 1, mime: 'image/png' } }, fotoId);
            tx.objectStore('miniaturas').put(new Blob([new Uint8Array([7])], { type: 'image/png' }), fotoId); }
        });
        return req;
      };
      let resultado;
      try { resultado = await c.fotos.crearRestauradorFotosPortable(plan, c.limites).restaurar({ presente: true, tablas: {
        metadatos: [{ clave: fotoId, valor: metadata }], originales: [{ clave: fotoId, valor: original }], miniaturas: [] } }); }
      finally { IDBFactory.prototype.open = open; }
      const despues = await c.fotos.abrirFotosLocal(plan); const m = await despues.leerMetadatos(fotoId);
      const blob = await despues.leerOriginal(fotoId); const mini = await despues.leerMiniatura(fotoId); despues.cerrar();
      resultados.push({ caso, intercalada, resultado, m, original: blob ? await blob.text() : null,
        mini: mini ? [...new Uint8Array(await mini.arrayBuffer())] : null });
    }
    return resultados;
  });
  expect(r[0]).toMatchObject({ caso: 'tombstone', intercalada: true, resultado: { tipo: 'conflicto-fresco', transaccion: 'abortada' },
    m: { tipo: 'borrada' }, original: null, mini: null });
  expect(r[1]).toMatchObject({ caso: 'derivacion', intercalada: true, resultado: { tipo: 'observadas', fotos: [{ derivacion: 'diferente' }] },
    original: 'abc', mini: [7] });
});
