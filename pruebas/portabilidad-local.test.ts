import { IDBFactory, IDBObjectStore } from 'fake-indexeddb';
import { abrirFotosLocal, capturarFotosLocal } from '../src/fotos-local';
import { abrirProgresoLocal, capturarProgresoLocal } from '../src/progreso-local';
import { abrirRespaldoFotosLocal, capturarRespaldoFotosLocal } from '../src/fotos-respaldo-local';
import { inspeccionarArchivoPortable } from '../src/portabilidad';
import { aplicarOperacion, crearProgreso } from '../src/progreso';
import { describe, expect, it, vi } from 'vitest';
import { itinerario } from '../src/datos/itinerario';
import { crearExportadorLocal } from '../src/portabilidad-local';
const fotoId = '12345678-1234-4123-8123-123456789abc';
const borradaId = '22345678-1234-4123-8123-123456789abc';
const operacionId = '32345678-1234-4123-8123-123456789abc';
const nombreFotos = `itinerario-fotos:${encodeURIComponent(itinerario.id)}`;
const nombreLedger = `itinerario-respaldo-fotos:${encodeURIComponent(itinerario.id)}`;
function metadata(bytes = 3) {
  return { formato: 1 as const, fotoId, destino: { tipo: 'parada' as const, viajeId: itinerario.id,
    paradaId: itinerario.dias[0].paradas[0].id }, nombre: '\0 e\u0301 ', mimeDeclarado: 'image/heic',
  ultimaModificacion: -0, incorporada: -0, bytesOriginal: bytes, miniatura: { tipo: 'pendiente' as const } };
}
async function abrir(fabrica: IDBFactory, nombre: string, tablas: string[], version = 1,
  esquema?: (db: IDBDatabase) => void) {
  return new Promise<IDBDatabase>((ok, no) => {
    const s = fabrica.open(nombre, version);
    s.onupgradeneeded = () => esquema ? esquema(s.result) : tablas.forEach((t) => s.result.createObjectStore(t));
    s.onsuccess = () => ok(s.result); s.onerror = () => no(s.error);
  });
}
async function poner(db: IDBDatabase, tabla: string, valor: unknown, clave: IDBValidKey) {
  await new Promise<void>((ok, no) => {
    const tx = db.transaction(tabla, 'readwrite'); tx.objectStore(tabla).put(valor, clave);
    tx.oncomplete = () => ok(); tx.onabort = () => no(tx.error);
  });
}
async function leer(db: IDBDatabase, tabla: string, clave: IDBValidKey): Promise<unknown> {
  return new Promise((ok, no) => {
    const tx = db.transaction(tabla); const req = tx.objectStore(tabla).get(clave); let valor: unknown;
    req.onsuccess = () => { valor = req.result; }; tx.oncomplete = () => ok(valor); tx.onabort = () => no(tx.error);
  });
}
const limites = { maxRegistros: 100, maxBytesMetadatos: 100000, maxBytesArchivo: 4000000, maxProfundidad: 64 };
const casosCatalogoInvalido = ['viaje-vacio', 'viaje-blanco', 'parada-vacia', 'parada-duplicada',
  'subparada-duplicada', 'subparadas-repetidas', 'pendiente-vacio', 'pendiente-duplicado', 'pendiente-cruzado'] as const;
function planConCatalogoInvalido(caso: typeof casosCatalogoInvalido[number]) {
  const plan = structuredClone(itinerario); const paradas = plan.dias.flatMap((d) => d.paradas);
  if (caso === 'viaje-vacio') Object.assign(plan, { id: '' });
  if (caso === 'viaje-blanco') Object.assign(plan, { id: ' \t\n ' });
  if (caso === 'parada-vacia') Object.assign(paradas[0], { id: '' });
  if (caso === 'parada-duplicada') Object.assign(paradas[1], { id: paradas[0].id });
  if (caso === 'subparada-duplicada') paradas[0].subparadas = [{ id: paradas[1].id, nombre: 'Colisión entre destinos' }];
  if (caso === 'subparadas-repetidas') {
    paradas[0].subparadas = [{ id: 'sub-fixture', nombre: 'Uno' }];
    paradas[1].subparadas = [{ id: 'sub-fixture', nombre: 'Dos' }];
  }
  if (caso === 'pendiente-vacio') plan.pendientes = [{ id: '', texto: 'Sin identidad' }];
  if (caso === 'pendiente-duplicado') plan.pendientes = [{ id: 'pendiente-fixture', texto: 'Uno' }, { id: 'pendiente-fixture', texto: 'Dos' }];
  if (caso === 'pendiente-cruzado') plan.pendientes = [{ id: paradas[0].id, texto: 'Colisión con parada' }];
  return plan;
}
describe('M1: ningún catálogo inválido inicia captura ni lee legado', () => {
  it.each(casosCatalogoInvalido)('constructor rechaza %s sin IO de forma síncrona', async (caso) => {
    const plan = planConCatalogoInvalido(caso); const fabrica = new IDBFactory();
    const abrir = vi.spyOn(fabrica, 'open'); const leerLegado = vi.fn(() => null);
    try {
      expect(() => crearProgreso(plan)).toThrow('Identidad');
      expect(() => crearExportadorLocal({ plan, fabrica, limites, leerLegado })).toThrow('Identidad');
      expect(abrir).not.toHaveBeenCalled(); expect(leerLegado).not.toHaveBeenCalled();
      expect(await fabrica.databases()).toEqual([]);
    } finally { abrir.mockRestore(); }
  });
  for (const [nombre, capturar] of [
    ['PhotoDB', capturarFotosLocal], ['ProgressDB', capturarProgresoLocal], ['LedgerDB', capturarRespaldoFotosLocal],
  ] as const) {
    it.each(casosCatalogoInvalido)(`${nombre} rechaza %s como Promise antes de abrir DB ausente`, async (caso) => {
      const plan = planConCatalogoInvalido(caso); const fabrica = new IDBFactory(); const abrir = vi.spyOn(fabrica, 'open');
      try {
        let pendiente: ReturnType<typeof capturar> | undefined;
        expect(() => { pendiente = capturar(plan, limites, { fabrica }); }).not.toThrow();
        expect(pendiente).toBeInstanceOf(Promise);
        await expect(pendiente!).rejects.toThrow('Identidad');
        expect(abrir).not.toHaveBeenCalled(); expect(await fabrica.databases()).toEqual([]);
      } finally { abrir.mockRestore(); }
    });
  }
  it.each([
    ['PhotoDB', capturarFotosLocal], ['ProgressDB', capturarProgresoLocal], ['LedgerDB', capturarRespaldoFotosLocal],
  ] as const)('%s fija catálogo antes de await y revalida cada nueva captura', async (_nombre, capturar) => {
    const plan = structuredClone(itinerario); const fabrica = new IDBFactory(); const abrir = vi.spyOn(fabrica, 'open');
    try {
      const pendiente = capturar(plan, limites, { fabrica });
      Object.assign(plan, { id: '' });
      expect(await pendiente).toEqual({ presente: false, tablas: {} });
      expect(abrir).toHaveBeenCalledTimes(1);
      await expect(capturar(plan, limites, { fabrica })).rejects.toThrow('Identidad');
      expect(abrir).toHaveBeenCalledTimes(1); expect(await fabrica.databases()).toEqual([]);
    } finally { abrir.mockRestore(); }
  });
  it('constructor valida la copia propia: mutar argumentos no cambia catálogo ni destino', async () => {
    const plan = structuredClone(itinerario); const fabrica = new IDBFactory();
    const e = crearExportadorLocal({ plan, fabrica, limites, leerLegado: () => null });
    Object.assign(plan, { id: '' });
    Object.assign(plan.dias[0].paradas[1], { id: plan.dias[0].paradas[0].id });
    const r = await e.exportar(); expect(r.manifiesto.captura.viajeId).toBe(itinerario.id);
    expect(await fabrica.databases()).toEqual([]);
  });
});
describe('exportación explícita local sin crear bases', () => {
  it('constructor sin IO, acción produce archivo y bases ausentes siguen ausentes', async () => {
    const fabrica = new IDBFactory(); const abrir = vi.spyOn(fabrica, 'open');
    const leerLegado = vi.fn(() => null);
    const e = crearExportadorLocal({ plan: itinerario, fabrica, limites, leerLegado });
    expect(abrir).not.toHaveBeenCalled(); expect(leerLegado).not.toHaveBeenCalled();
    const r = await e.exportar(); expect(r.archivo.size).toBeGreaterThan(20);
    expect(await fabrica.databases()).toEqual([]); expect(leerLegado).toHaveBeenCalledTimes(3);
  });
  it('fábrica null rechaza sin leer legado; lectura fallida nunca se convierte en ausencia', async () => {
    const lectura = vi.fn(() => null);
    await expect(crearExportadorLocal({ plan: itinerario, fabrica: null, limites, leerLegado: lectura }).exportar()).rejects.toThrow('disponible');
    expect(lectura).not.toHaveBeenCalled();
    const fabrica = new IDBFactory();
    await expect(crearExportadorLocal({ plan: itinerario, fabrica, limites,
      leerLegado: () => { throw new Error('Storage denegado'); } }).exportar()).rejects.toThrow('denegado');
    expect(await fabrica.databases()).toEqual([]);
  });
  it('tres bases RAW, cola enviada, ledger incierto, tombstone, original y miniatura exactos', async () => {
    const fabrica = new IDBFactory();
    const fotos = await abrirFotosLocal(itinerario, { fabrica });
    await fotos.guardarOriginal({ metadatos: metadata(), original: new Blob([new Uint8Array([0, 7, 255])], { type: 'image/heic' }) });
    await fotos.guardarMiniatura(fotoId, new Blob([new Uint8Array([8, 0, 254])], { type: 'image/png' }), 1, 1);
    await fotos.guardarOriginal({ metadatos: { ...metadata(), fotoId: borradaId }, original: new Blob(['abc'], { type: 'image/heic' }) });
    await fotos.borrarLocal(borradaId);
    const progreso = await abrirProgresoLocal(itinerario, { fabrica, dispositivoId: 'causa-no-credencial' });
    await progreso.registrar({ id: 'op-historica', dispositivoId: 'causa-no-credencial', tipo: 'parada',
      paradaId: itinerario.dias[0].paradas[0].id, marca: 'hecha', revision: 0 });
    await progreso.marcarEnviada('op-historica');
    const root = await progreso.leer();
    const ledger = await abrirRespaldoFotosLocal(itinerario, fotos, { fabrica });
    const e = await ledger.preparar({ metadatos: metadata(), original: new Blob([new Uint8Array([0, 7, 255])], { type: 'image/heic' }) }, operacionId);
    const ref = { fotoId, operacionId, original: e.original };
    await ledger.marcarEnviada(ref); const incierta = await ledger.pausar(ref);
    const guardado = await capturarFotosLocal(itinerario, limites, { fabrica });
    const r = await crearExportadorLocal({ plan: itinerario, fabrica, limites,
      leerLegado: (c) => c === 'marcas' ? '' : c === 'marcas-hora' ? '\0 e\u0301 ' : null }).exportar();
    const verificado = await inspeccionarArchivoPortable(itinerario, r.archivo, limites);
    expect(verificado.manifiesto.captura.progreso.tablas.viajes[0].valor).toEqual(root);
    expect(verificado.manifiesto.captura.respaldos.tablas.respaldos[0].valor).toEqual(incierta);
    expect(verificado.manifiesto.captura.fotos.tablas.metadatos).toEqual(guardado.tablas.metadatos);
    expect(verificado.manifiesto.segmentos).toHaveLength(2);
    for (const [i, s] of verificado.manifiesto.segmentos.entries()) {
      const b = new Uint8Array(await verificado.leerSegmento(i).arrayBuffer());
      expect([...b]).toEqual(s.tabla === 'originales' ? [0, 7, 255] : [8, 0, 254]);
    }
    const m = verificado.manifiesto.captura.fotos.tablas.metadatos.find((r) => r.clave === fotoId)!.valor as ReturnType<typeof metadata>;
    expect(Object.is(m.incorporada, -0)).toBe(true); expect(m.nombre).toBe('\0 e\u0301 ');
    expect(await progreso.leer()).toEqual(root); expect(await ledger.leer(fotoId)).toEqual(incierta);
    fotos.cerrar(); progreso.cerrar(); ledger.cerrar();
  });
  it('ledger permanece exportable con original borrado; sin consultas a PhotoDB', async () => {
    const fabrica = new IDBFactory(); const fotos = await abrirFotosLocal(itinerario, { fabrica });
    const captura = { metadatos: metadata(), original: new Blob(['abc'], { type: 'image/heic' }) };
    await fotos.guardarOriginal(captura); const ledger = await abrirRespaldoFotosLocal(itinerario, fotos, { fabrica });
    const e = await ledger.preparar(captura, operacionId); await fotos.borrarLocal(fotoId);
    const snap = await capturarRespaldoFotosLocal(itinerario, limites, { fabrica });
    expect(snap.tablas.respaldos[0].valor).toEqual(e); fotos.cerrar(); ledger.cerrar();
  });
  it.each(['originales', 'miniaturas'])('huérfano %s rechaza sin eliminar', async (tabla) => {
    const fabrica = new IDBFactory(); const db = await abrir(fabrica, nombreFotos, ['metadatos', 'originales', 'miniaturas']);
    const blob = new Blob(['abc'], { type: 'image/heic' }); await poner(db, tabla, blob, fotoId);
    await expect(capturarFotosLocal(itinerario, limites, { fabrica })).rejects.toThrow(`${tabla}/${fotoId}`);
    expect((await leer(db, tabla, fotoId) as Blob).size).toBe(3); db.close();
  });
  it.each([undefined, null, { formato: 99 }, { formato: 1, tipo: 'borrada', fotoId: borradaId }])('metadata desconocida no se omite: %s', async (valor) => {
    const fabrica = new IDBFactory(); const db = await abrir(fabrica, nombreFotos, ['metadatos', 'originales', 'miniaturas']);
    await poner(db, 'metadatos', valor, fotoId);
    await expect(capturarFotosLocal(itinerario, limites, { fabrica })).rejects.toThrow();
    expect(await leer(db, 'metadatos', fotoId)).toEqual(valor); db.close();
  });
  it.each([12, ['estructura'], new Date(0)])('clave no textual se rechaza íntegra: %s', async (clave) => {
    const fabrica = new IDBFactory(); const db = await abrir(fabrica, nombreFotos, ['metadatos', 'originales', 'miniaturas']);
    await poner(db, 'metadatos', { formato: 1, tipo: 'borrada', fotoId }, clave);
    await expect(capturarFotosLocal(itinerario, limites, { fabrica })).rejects.toThrow('clave'); db.close();
  });
  it.each(['fotos', 'progreso', 'ledger'])('schema futuro %s no se baja de versión', async (tipo) => {
    const fabrica = new IDBFactory();
    const nombre = tipo === 'fotos' ? nombreFotos : tipo === 'progreso' ? 'itinerario-progreso' : nombreLedger;
    const tablas = tipo === 'fotos' ? ['metadatos', 'originales', 'miniaturas'] : [tipo === 'progreso' ? 'viajes' : 'respaldos'];
    const db = await abrir(fabrica, nombre, tablas, 2); db.close();
    const accion = tipo === 'fotos' ? capturarFotosLocal : tipo === 'progreso' ? capturarProgresoLocal : capturarRespaldoFotosLocal;
    await expect(accion(itinerario, limites, { fabrica })).rejects.toThrow();
    expect((await fabrica.databases())[0].version).toBe(2);
  });
  it.each(['extra', 'indice', 'keyPath', 'incremental'])('schema desconocido %s se conserva', async (tipo) => {
    const fabrica = new IDBFactory(); const db = await abrir(fabrica, nombreFotos, [], 1, (db) => {
      const t = db.createObjectStore('metadatos', tipo === 'keyPath' ? { keyPath: 'fotoId' } : tipo === 'incremental' ? { autoIncrement: true } : {});
      if (tipo === 'indice') t.createIndex('extra', 'fotoId');
      db.createObjectStore('originales'); db.createObjectStore('miniaturas'); if (tipo === 'extra') db.createObjectStore('extra');
    });
    await expect(capturarFotosLocal(itinerario, limites, { fabrica })).rejects.toThrow('Esquema');
    expect(db.version).toBe(1); db.close();
  });
  it('registro seleccionado ausente no equivale a undefined almacenado ni otro viaje', async () => {
    const fabrica = new IDBFactory(); const db = await abrir(fabrica, 'itinerario-progreso', ['viajes']);
    expect((await capturarProgresoLocal(itinerario, limites, { fabrica })).tablas.viajes).toEqual([]);
    await poner(db, 'viajes', undefined, itinerario.id);
    await expect(capturarProgresoLocal(itinerario, limites, { fabrica })).rejects.toThrow();
    const otra = new IDBFactory(); const otroDb = await abrir(otra, 'itinerario-progreso', ['viajes']);
    await poner(otroDb, 'viajes', {}, 'otro-viaje');
    await expect(capturarProgresoLocal(itinerario, limites, { fabrica: otra })).rejects.toThrow('Otro viaje');
    db.close(); otroDb.close();
  });
  it.each([1, 2, 99])('root formato %s no se migra ni reinterpreta', async (formato) => {
    const fabrica = new IDBFactory(); const db = await abrir(fabrica, 'itinerario-progreso', ['viajes']);
    const estado = crearProgreso(itinerario); const valor = { formato, revisionServidor: 0,
      confirmado: estado, estado: structuredClone(estado), cola: [] };
    await poner(db, 'viajes', valor, itinerario.id);
    await expect(capturarProgresoLocal(itinerario, limites, { fabrica })).rejects.toThrow();
    expect(await leer(db, 'viajes', itinerario.id)).toEqual(valor); db.close();
  });
  it.each([new Map([['x', NaN]]), Infinity, NaN, undefined, new Blob(['legado'])])('unknown legado %s rechaza completo y conserva source', async (extra) => {
    const fabrica = new IDBFactory(); const db = await abrir(fabrica, 'itinerario-progreso', ['viajes']);
    const estado = crearProgreso(itinerario); const valor = { formato: 3, revisionServidor: 0,
      confirmado: estado, estado: structuredClone(estado), cola: [], legado: { originales: { extra }, recuperacion: [] } };
    await poner(db, 'viajes', valor, itinerario.id);
    await expect(capturarProgresoLocal(itinerario, limites, { fabrica })).rejects.toThrow();
    expect(await leer(db, 'viajes', itinerario.id)).toEqual(valor); db.close();
  });
  it('aborto posterior a éxito de cursor no confirma snapshot y cierra conexión propia', async () => {
    const fabrica = new IDBFactory(); const db = await abrir(fabrica, nombreFotos, ['metadatos', 'originales', 'miniaturas']);
    await poner(db, 'metadatos', { formato: 1, tipo: 'borrada', fotoId }, fotoId);
    const original = IDBObjectStore.prototype.openCursor;
    const spy = vi.spyOn(IDBObjectStore.prototype, 'openCursor').mockImplementation(function (this: IDBObjectStore, ...args) {
      const req = original.apply(this, args);
      if (this.name === 'metadatos') req.addEventListener('success', () => { if (req.result) this.transaction.abort(); });
      return req;
    });
    try { await expect(capturarFotosLocal(itinerario, limites, { fabrica })).rejects.toThrow(); }
    finally { spy.mockRestore(); }
    expect(await leer(db, 'metadatos', fotoId)).toEqual({ formato: 1, tipo: 'borrada', fotoId }); db.close();
  });
  it.each(['originales-alias', 'originales-ciclo', 'recuperacion-alias', 'recuperacion-ciclo', 'cruce'])('legado desconocido %s conserva identidad source y rechaza completo', async (caso) => {
    const fabrica = new IDBFactory(); const db = await abrir(fabrica, 'itinerario-progreso', ['viajes']);
    const confirmado = crearProgreso(itinerario); const estado = structuredClone(confirmado);
    const compartida: Record<string, unknown> = { dato: -0 };
    if (caso.endsWith('ciclo')) compartida.yo = compartida;
    const originales = caso.startsWith('originales') ? { a: compartida, b: compartida }
      : caso === 'cruce' ? { dominio: confirmado } : {};
    const recuperacion = caso.startsWith('recuperacion') ? [{ campo: 'marcas', motivo: 'malformada', valor: { a: compartida, b: compartida } }] : [];
    const raiz = { formato: 3, revisionServidor: 0, confirmado, estado, cola: [], legado: { originales, recuperacion } };
    await poner(db, 'viajes', raiz, itinerario.id);
    await expect(crearExportadorLocal({ plan: itinerario, fabrica, limites, leerLegado: () => null }).exportar()).rejects.toThrow();
    const despues = await leer(db, 'viajes', itinerario.id) as typeof raiz;
    if (caso.startsWith('originales')) expect(despues.legado.originales.a).toBe(despues.legado.originales.b);
    if (caso.endsWith('ciclo')) {
      const p = caso.startsWith('originales') ? despues.legado.originales.a : despues.legado.recuperacion[0].valor.a;
      expect(p!.yo).toBe(p);
    }
    if (caso === 'cruce') expect(despues.legado.originales.dominio).toBe(despues.confirmado);
    db.close();
  });
  it('alias conocido se duplica solo por valor sin mutar aliasing RAW de origen', async () => {
    const fabrica = new IDBFactory(); const db = await abrir(fabrica, 'itinerario-progreso', ['viajes']);
    const estado = crearProgreso(itinerario);
    const raiz = { formato: 3, revisionServidor: 0, confirmado: estado, estado, cola: [],
      legado: { originales: { texto: '\0 e\u0301 ', numero: -0 }, recuperacion: [] } };
    await poner(db, 'viajes', raiz, itinerario.id);
    const r = await crearExportadorLocal({ plan: itinerario, fabrica, limites, leerLegado: () => null }).exportar();
    const inspeccion = await inspeccionarArchivoPortable(itinerario, r.archivo, limites);
    const copia = inspeccion.manifiesto.captura.progreso.tablas.viajes[0].valor as typeof raiz;
    expect(copia).toEqual(raiz); expect(copia.confirmado).not.toBe(copia.estado);
    expect(Object.is(copia.legado.originales.numero, -0)).toBe(true);
    const despues = await leer(db, 'viajes', itinerario.id) as typeof raiz;
    expect(despues.confirmado).toBe(despues.estado); expect(despues).toEqual(raiz); db.close();
  });
  it('known ciclo, propiedades extras y DAG expandido excedente siguen rechazados', async () => {
    for (const caso of ['ciclo', 'extra', 'budget']) {
      const fabrica = new IDBFactory(); const db = await abrir(fabrica, 'itinerario-progreso', ['viajes']);
      const estado = crearProgreso(itinerario); const raiz: Record<string, unknown> = {
        formato: 3, revisionServidor: 0, confirmado: estado, estado, cola: [] };
      if (caso === 'ciclo') raiz.estado = raiz;
      if (caso === 'extra') raiz.extra = 'no conocido';
      if (caso === 'budget') {
        let dag: unknown = { n: 1 }; for (let i = 0; i < 20; i++) dag = { a: dag, b: dag };
        raiz.estado = dag;
      }
      await poner(db, 'viajes', raiz, itinerario.id);
      await expect(capturarProgresoLocal(itinerario, { ...limites, maxBytesMetadatos: 1000 }, { fabrica })).rejects.toThrow(); db.close();
    }
  });
  it('root3 completo conserva NEG/resolución/testigos y dependencia histórica sin acuse nuevo', async () => {
    const fabrica = new IDBFactory(); const progreso = await abrirProgresoLocal(itinerario, { fabrica, dispositivoId: 'local' });
    const operacion = { id: 'rechazada', dispositivoId: 'local', tipo: 'parada' as const,
      paradaId: itinerario.dias[0].paradas[0].id, marca: 'hecha' as const, revision: 0, horaReal: -0 };
    await progreso.registrar(operacion); await progreso.marcarEnviada(operacion.id);
    await progreso.registrar({ ...operacion, id: 'dependiente', marca: 'saltada', revision: 1 });
    const remoto = aplicarOperacion(itinerario, crearProgreso(itinerario), { ...operacion, id: 'remota', marca: 'saltada' });
    expect(remoto.tipo).toBe('aplicada');
    const rechazo = { viajeId: itinerario.id, protocolo: 1, operacionId: operacion.id, operacionOriginal: operacion,
      decisionPersistida: true, motivo: 'conflicto', instantanea: { revisionServidor: 1, estado: remoto.estado } };
    expect((await progreso.recibirRechazo(rechazo)).tipo).toBe('rechazada');
    expect((await progreso.resolverRechazo(operacion.id)).tipo).toBe('resuelta');
    const antes = await progreso.leer();
    const r = await crearExportadorLocal({ plan: itinerario, fabrica, limites, leerLegado: () => null }).exportar();
    const leido = await inspeccionarArchivoPortable(itinerario, r.archivo, limites);
    const raiz = leido.manifiesto.captura.progreso.tablas.viajes[0].valor;
    expect(raiz).toEqual(antes); expect(raiz.cola[0]).toMatchObject({ enviada: true, resolucion: 'conservar-confirmado', rechazo });
    expect(raiz.cola[1].dependeDe).toEqual(['rechazada']);
    expect(Object.is((raiz.cola[0].operacion as typeof operacion).horaReal, -0)).toBe(true);
    expect(await progreso.leer()).toEqual(antes); progreso.cerrar();
  });
  it('ledger RAW alias conocido original/recibo admite valores exactos, no auth', async () => {
    const fabrica = new IDBFactory(); const db = await abrir(fabrica, nombreLedger, ['respaldos']);
    const { miniatura: _miniatura, ...original } = metadata();
    const valor = { formato: 1, fotoId, operacionId, original, fase: 'bloqueada', enviada: true, pausada: true,
      recibo: { version: 1, tipo: 'acuse-respaldo', viajeId: itinerario.id, fotoId, operacionId, original,
        objetoOriginalDurable: true, metadatosDurables: true } };
    await poner(db, 'respaldos', valor, fotoId);
    const r = await crearExportadorLocal({ plan: itinerario, fabrica, limites, leerLegado: () => null }).exportar();
    const leido = await inspeccionarArchivoPortable(itinerario, r.archivo, limites);
    expect(leido.manifiesto.captura.respaldos.tablas.respaldos[0].valor).toEqual(valor);
    const despues = await leer(db, 'respaldos', fotoId) as typeof valor;
    expect(despues.original).toBe(despues.recibo.original); db.close();
  });
  it.each([undefined, {}, { formato: 99 }])('ledger unknown %s no se omite', async (valor) => {
    const fabrica = new IDBFactory(); const db = await abrir(fabrica, nombreLedger, ['respaldos']);
    await poner(db, 'respaldos', valor, fotoId);
    await expect(capturarRespaldoFotosLocal(itinerario, limites, { fabrica })).rejects.toThrow();
    expect(await leer(db, 'respaldos', fotoId)).toEqual(valor); db.close();
  });
  it('blocked y error simulados rechazan; un éxito tardío cierra solo conexión propia', async () => {
    const fabrica = new IDBFactory(); const close = vi.fn();
    const req = { result: { close }, error: null, onblocked: null, onsuccess: null, onerror: null } as unknown as IDBOpenDBRequest;
    const spy = vi.spyOn(fabrica, 'open').mockReturnValue(req);
    try {
      const p = capturarFotosLocal(itinerario, limites, { fabrica }); const rechazo = expect(p).rejects.toThrow('bloqueada');
      req.onblocked!(new Event('blocked') as IDBVersionChangeEvent); await rechazo;
      req.onsuccess!(new Event('success')); expect(close).toHaveBeenCalledTimes(1);
      const q = capturarFotosLocal(itinerario, limites, { fabrica }); const otro = expect(q).rejects.toBeNull();
      req.onerror!(new Event('error')); await otro;
    } finally { spy.mockRestore(); }
  });
  it('capturas únicamente readonly y snapshots RAW mantienen alias conocido hasta exportar', async () => {
    const fabrica = new IDBFactory(); const db = await abrir(fabrica, 'itinerario-progreso', ['viajes']);
    const estado = crearProgreso(itinerario); await poner(db, 'viajes', { formato: 3, revisionServidor: 0, confirmado: estado, estado, cola: [] }, itinerario.id);
    const snap = await capturarProgresoLocal(itinerario, limites, { fabrica });
    const raw = snap.tablas.viajes[0].valor as { confirmado: unknown; estado: unknown };
    expect(raw.confirmado).toBe(raw.estado); db.close();
  });
  it('límites por base/global, factory/config capturados y una acción por instancia', async () => {
    const fabrica = new IDBFactory(); const opciones = { plan: structuredClone(itinerario), fabrica, limites: { ...limites }, leerLegado: vi.fn(() => '') as () => string };
    const e = crearExportadorLocal(opciones);
    Object.assign(opciones.plan, { id: 'cambiado' }); opciones.limites.maxBytesArchivo = 0; opciones.leerLegado = () => { throw new Error('mutado'); };
    const abrirMutado = vi.spyOn(fabrica, 'open').mockImplementation(() => { throw new Error('Factory mutada'); });
    let r: Awaited<ReturnType<typeof e.exportar>>;
    try {
      const pendiente = e.exportar(); await expect(e.exportar()).rejects.toThrow('activa');
      r = await pendiente; expect(abrirMutado).not.toHaveBeenCalled();
    } finally { abrirMutado.mockRestore(); }
    expect(r!.manifiesto.captura.viajeId).toBe(itinerario.id);
    expect(r.manifiesto.captura.legado.marcas).toBe('');
    const db = await abrir(fabrica, nombreFotos, ['metadatos', 'originales', 'miniaturas']);
    await poner(db, 'metadatos', { formato: 1, tipo: 'borrada', fotoId }, fotoId);
    await expect(capturarFotosLocal(itinerario, { ...limites, maxRegistros: 0 }, { fabrica })).rejects.toThrow('maxRegistros'); db.close();
  });
});
