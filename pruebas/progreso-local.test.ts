import { IDBFactory, IDBObjectStore } from 'fake-indexeddb';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { abrirProgresoLocal } from '../src/progreso-local';
import { aplicarOperacion, crearProgreso } from '../src/progreso';
import type { Cambios, EstadoProgreso, Operacion } from '../src/progreso';
import type { Itinerario } from '../src/tipos';

const plan: Itinerario = {
  id: 'viaje', titulo: 'Prueba', dias: [{ fecha: '2026-10-21', titulo: 'Día', paradas: [
    { id: 'p1', nombre: 'Uno', hora: '09:00', categoria: 'otro', lat: 0, lng: 0 },
    { id: 'p2', nombre: 'Dos', hora: '10:00', categoria: 'otro', lat: 0, lng: 0 },
  ] }], pendientes: [{ id: 'c1', texto: 'Reserva' }],
};
const marca = (id = 'op1', paradaId = 'p1'): Extract<Operacion, { tipo: 'parada' }> =>
  ({ id, dispositivoId: 'movil', tipo: 'parada', paradaId, marca: 'hecha', revision: 0 });
const legado = { marcas: '{"2026-10-21|09:00|Uno":"hecha","desconocida":"aqui"}',
  'marcas-hora': '{"2026-10-21|09:00|Uno":555}', 'pendientes-hechos': '["Reserva","Otra"]',
  extra: 'original íntegro' };
const cierres: (() => void)[] = [];
const bases: { fabrica: IDBFactory; nombre: string }[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const cerrar of cierres.splice(0)) cerrar();
  for (const { fabrica, nombre } of bases.splice(0)) await new Promise<void>((resolve, reject) => {
    const peticion = fabrica.deleteDatabase(nombre);
    peticion.onsuccess = () => resolve();
    peticion.onerror = () => reject(peticion.error);
    peticion.onblocked = () => reject(new Error('Limpieza bloqueada'));
  });
});
function contexto() {
  const fabrica = new IDBFactory();
  const nombre = 'prueba';
  bases.push({ fabrica, nombre });
  let numero = 0;
  const opciones = { fabrica, nombre, dispositivoId: 'movil', uuid: () => `legado-${++numero}` };
  const abrir = async (entradasLegadas?: typeof legado) => {
    const almacen = await abrirProgresoLocal(plan, { ...opciones, entradasLegadas });
    cierres.push(() => almacen.cerrar());
    return almacen;
  };
  return { fabrica, nombre, abrir, opciones };
}
async function conexion(fabrica: IDBFactory, nombre: string, version?: number) {
  return new Promise<IDBDatabase>((resolve, reject) => {
    const solicitud = fabrica.open(nombre, version);
    solicitud.onsuccess = () => { cierres.push(() => solicitud.result.close()); resolve(solicitud.result); };
    solicitud.onerror = () => reject(solicitud.error);
  });
}
async function guardarCrudo(db: IDBDatabase, valor: unknown) {
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction('viajes', 'readwrite');
    tx.objectStore('viajes').put(valor, plan.id);
    tx.oncomplete = () => resolve();
    tx.onabort = () => reject(tx.error);
  });
}
async function leerCrudo(db: IDBDatabase): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const solicitud = db.transaction('viajes').objectStore('viajes').get(plan.id);
    solicitud.onsuccess = () => resolve(solicitud.result);
    solicitud.onerror = () => reject(solicitud.error);
  });
}
function abortarDespuesDePut() {
  const original = IDBObjectStore.prototype.put;
  return vi.spyOn(IDBObjectStore.prototype, 'put').mockImplementation(function (this: IDBObjectStore, ...args) {
    const solicitud = original.apply(this, args);
    solicitud.addEventListener('success', () => this.transaction.abort());
    return solicitud;
  });
}

function estadoCon(...operaciones: Operacion[]): EstadoProgreso {
  return operaciones.reduce((estado, op) => {
    const resultado = aplicarOperacion(plan, estado, op);
    if (resultado.tipo === 'invalida' || resultado.tipo === 'conflicto') throw new Error('Fixture inválido');
    return resultado.estado;
  }, crearProgreso(plan));
}
const instantanea = (revisionServidor: number, ...ops: Operacion[]) =>
  ({ revisionServidor, estado: estadoCon(...ops) });
const acuse = (op: Operacion, revisionServidor = 1, ...ops: Operacion[]) =>
  ({ operacionId: op.id, persistida: true as const, instantanea: instantanea(revisionServidor, op, ...ops) });
async function sembrarV1(ctx: ReturnType<typeof contexto>, ops: Operacion[] = []) {
  const vacio = await ctx.abrir();
  vacio.cerrar();
  const db = await conexion(ctx.fabrica, ctx.nombre);
  const raiz = { formato: 1, confirmado: crearProgreso(plan), estado: estadoCon(...ops),
    cola: ops.map((operacion, i) => ({ operacion, dependeDe: ops.slice(0, i).map((op) => op.id) })),
    legado: { originales: { extra: new Map([['dato', { numero: Infinity, nan: NaN, ausente: undefined }]]) },
      recuperacion: [{ campo: 'marcas', motivo: 'malformada', valor: new Map([['nan', NaN]]) }] } };
  await guardarCrudo(db, raiz);
  return { db, raiz };
}

describe('cola durable v2', () => {
  it('crea v2 sobre IDB v1 y migra originales v1 refinando solo dependencias', async () => {
    const ctx = contexto();
    const ops = [marca(), marca('op2', 'p2'), { ...marca('reset'), marca: null, revision: 1 }];
    const { db, raiz } = await sembrarV1(ctx, ops);
    const almacen = await ctx.abrir(legado);
    const nueva = await almacen.leer();
    expect(db.version).toBe(1);
    expect(nueva.formato).toBe(2);
    expect(nueva.revisionServidor).toBe(0);
    expect(nueva.confirmado).toEqual(raiz.confirmado);
    expect(nueva.estado).toEqual(raiz.estado);
    expect(nueva.legado).toEqual(raiz.legado);
    expect(nueva.cola.map((e) => e.operacion)).toEqual(ops);
    expect(nueva.cola.map((e) => e.dependeDe)).toEqual([[], [], ['op1']]);
    expect(nueva.cola.every((e) => e.enviada === false)).toBe(true);
    almacen.cerrar();
    expect(await (await ctx.abrir()).leer()).toEqual(nueva);
  });

  it('aborta upgrade sin cambiar ningún byte lógico y reintenta incluyendo raíz vacía', async () => {
    for (const ops of [[], [marca()]]) {
      const ctx = contexto();
      const { db, raiz } = await sembrarV1(ctx, ops);
      const espia = abortarDespuesDePut();
      await expect(ctx.abrir()).rejects.toMatchObject({ name: 'AbortError' });
      espia.mockRestore();
      expect(await leerCrudo(db)).toEqual(raiz);
      const nueva = await (await ctx.abrir()).leer();
      expect(nueva.formato).toBe(2);
      expect(nueva.legado).toEqual(raiz.legado);
    }
  });

  it('valida v1 antes de migrar y rechaza versiones desconocidas sin put', async () => {
    for (const formato of [1, 3]) {
      const ctx = contexto();
      const { db, raiz } = await sembrarV1(ctx, [marca(), marca('op2', 'p2')]);
      const corrupta = { ...raiz, formato, cola: raiz.cola.map((e) => ({ ...e, dependeDe: [] })) };
      await guardarCrudo(db, corrupta);
      const espia = vi.spyOn(IDBObjectStore.prototype, 'put');
      await expect(ctx.abrir()).rejects.toThrow('corrupt');
      expect(espia).not.toHaveBeenCalled();
      espia.mockRestore();
      expect(await leerCrudo(db)).toEqual(corrupta);
    }
  });

  it('persiste incertidumbre antes de resolver y admite retry idéntico tras conflicto remoto', async () => {
    const ctx = contexto();
    let almacen = await ctx.abrir();
    await almacen.registrar(marca());
    expect((await almacen.marcarEnviada('op1')).tipo).toBe('enviada');
    expect((await leerCrudo(await conexion(ctx.fabrica, ctx.nombre)) as { cola: { enviada: boolean }[] }).cola[0].enviada).toBe(true);
    const remota = { ...marca('remota'), marca: 'saltada' as const };
    await almacen.recibirInstantanea(instantanea(1, remota));
    almacen.cerrar();
    almacen = await ctx.abrir();
    const antes = await almacen.leer();
    expect(antes.estado.paradas.p1.marca).toBe('saltada');
    expect((await almacen.registrar(marca())).tipo).toBe('duplicada');
    expect((await almacen.registrar({ ...marca(), marca: 'saltada' })).tipo).toBe('invalida');
    expect((await almacen.marcarEnviada('op1')).tipo).toBe('enviada');
    expect((await almacen.cancelarIntencion('op1')).tipo).toBe('conflicto');
    expect(await almacen.leer()).toEqual(antes);
  });

  it('dependiente lista NO se envía hasta acuse explícito, ni siquiera con recibo en snapshot', async () => {
    const almacen = await contexto().abrir();
    await almacen.registrar(marca());
    const reset = { ...marca('reset'), marca: null, revision: 1 };
    await almacen.registrar(reset);
    const antes = await almacen.leer();
    const espia = vi.spyOn(IDBObjectStore.prototype, 'put');
    expect((await almacen.marcarEnviada('reset')).tipo).toBe('conflicto');
    expect(espia).not.toHaveBeenCalled();
    espia.mockRestore();
    expect(await almacen.leer()).toEqual(antes);
    await almacen.marcarEnviada('op1');
    await almacen.recibirInstantanea(instantanea(1, marca()));
    expect((await almacen.marcarEnviada('reset')).tipo).toBe('conflicto');
    expect((await almacen.recibirAcuse(acuse(marca()))).tipo).toBe('confirmada');
    expect((await almacen.leer()).cola[0].dependeDe).toEqual([]);
    expect((await almacen.marcarEnviada('reset')).tipo).toBe('enviada');
  });

  it('retiene conflictos y dependientes, rechaza nuevos conflictos y permite independiente', async () => {
    const almacen = await contexto().abrir();
    await almacen.registrar(marca());
    await almacen.registrar({ ...marca('reset'), marca: null, revision: 1 });
    const r = await almacen.recibirInstantanea(instantanea(1, { ...marca('remota'), marca: 'saltada' }));
    expect(r.proyeccion?.entradas.map((e) => e.tipo)).toEqual(['conflicto', 'bloqueada']);
    const antes = await almacen.leer();
    expect((await almacen.marcarEnviada('op1')).tipo).toBe('conflicto');
    expect((await almacen.registrar(marca('nueva'))).tipo).toBe('conflicto');
    expect(await almacen.leer()).toEqual(antes);
    expect((await almacen.registrar(marca('otra', 'p2'))).tipo).toBe('aplicada');
    expect((await almacen.leer()).cola.map((e) => e.operacion.id)).toEqual(['op1', 'reset', 'otra']);
  });

  it('rechaza acuses ausentes, falsos o payload distinto sin limpiar cola ni escribir', async () => {
    const almacen = await contexto().abrir();
    await almacen.registrar(marca());
    const antes = await almacen.leer();
    const espia = vi.spyOn(IDBObjectStore.prototype, 'put');
    for (const mal of [null, { ...acuse(marca()), persistida: false },
      { operacionId: 'op1', persistida: true, instantanea: instantanea(1) },
      acuse({ ...marca(), marca: 'saltada' })]) {
      expect((await almacen.recibirAcuse(mal as never)).tipo).toBe('invalida');
    }
    expect(espia).not.toHaveBeenCalled();
    espia.mockRestore();
    expect(await almacen.leer()).toEqual(antes);
  });

  it('acuse persiste base+cola juntos, aborto tras put revierte ambas y retry no reencola confirmado', async () => {
    const ctx = contexto();
    const almacen = await ctx.abrir();
    await almacen.registrar(marca());
    await almacen.registrar(marca('otra', 'p2'));
    const antes = await almacen.leer();
    const espia = abortarDespuesDePut();
    await expect(almacen.recibirAcuse(acuse(marca()))).rejects.toMatchObject({ name: 'AbortError' });
    espia.mockRestore();
    expect(await almacen.leer()).toEqual(antes);
    expect((await almacen.recibirAcuse(acuse(marca()))).tipo).toBe('confirmada');
    const despues = await almacen.leer();
    expect(despues.revisionServidor).toBe(1);
    expect(despues.confirmado).toEqual(estadoCon(marca()));
    expect(despues.cola.map((e) => e.operacion.id)).toEqual(['otra']);
    expect((await almacen.registrar(marca())).tipo).toBe('duplicada');
    expect(await almacen.leer()).toEqual(despues);
    almacen.cerrar();
    expect(await (await ctx.abrir()).leer()).toEqual(despues);
  });

  it('snapshots/acuse tardíos y repetidos no rebobinan; misma revisión contradictoria no escribe', async () => {
    const almacen = await contexto().abrir();
    await almacen.registrar(marca());
    await almacen.registrar(marca('otra', 'p2'));
    await almacen.recibirInstantanea(instantanea(3, marca(), marca('otra', 'p2')));
    const antes = await almacen.leer();
    expect((await almacen.recibirInstantanea(instantanea(2))).tipo).toBe('ignorada');
    expect((await almacen.recibirInstantanea(instantanea(3))).tipo).toBe('conflicto');
    expect((await almacen.recibirAcuse(acuse(marca(), 3))).tipo).toBe('conflicto');
    expect(await almacen.leer()).toEqual(antes);
    expect((await almacen.recibirAcuse(acuse(marca(), 1))).tipo).toBe('confirmada');
    const despues = await almacen.leer();
    expect(despues.revisionServidor).toBe(3);
    expect(despues.cola.map((e) => e.operacion.id)).toEqual(['otra']);
    expect((await almacen.recibirAcuse(acuse(marca(), 4))).tipo).toBe('ignorada');
    expect(await almacen.leer()).toEqual(despues);
  });

  it('cancelación independiente preserva IDs y deshacer; dependencias impiden cancelar padre', async () => {
    const almacen = await contexto().abrir();
    const r = await almacen.registrar(marca());
    if (r.tipo !== 'aplicada') throw new Error('Falta recibo');
    await almacen.registrar(marca('otra', 'p2'));
    await almacen.registrar({ id: 'undo', dispositivoId: 'movil', tipo: 'deshacer', cambios: r.cambios });
    expect((await almacen.cancelarIntencion('op1')).tipo).toBe('conflicto');
    expect((await almacen.cancelarIntencion('otra')).tipo).toBe('cancelada');
    expect((await almacen.leer()).cola.map((e) => e.operacion.id)).toEqual(['op1', 'undo']);
    expect((await almacen.leer()).estado.paradas.p1.marca).toBeNull();
    expect((await almacen.cancelarIntencion('no-existe')).tipo).toBe('ausente');
  });

  it('dos handles serializan ack/nueva intención/snapshot y marca/acuse sin perder cambios', async () => {
    const ctx = contexto();
    const uno = await ctx.abrir();
    const dos = await ctx.abrir();
    await uno.registrar(marca());
    const resultados = await Promise.all([uno.recibirAcuse(acuse(marca())), dos.registrar(marca('otra', 'p2')),
      dos.recibirInstantanea(instantanea(2, marca()))]);
    expect(resultados.map((r) => r.tipo)).toEqual(['confirmada', 'aplicada', 'actualizada']);
    const raiz = await uno.leer();
    expect(raiz.revisionServidor).toBe(2);
    expect(raiz.cola.map((e) => e.operacion.id)).toEqual(['otra']);
    expect(raiz.estado.paradas.p2.marca).toBe('hecha');
    const carrera = await Promise.all([uno.marcarEnviada('otra'), dos.recibirAcuse(acuse(marca('otra', 'p2'), 3, marca()))]);
    expect(carrera.map((r) => r.tipo)).toEqual(['enviada', 'confirmada']);
    expect((await uno.leer()).cola).toEqual([]);
    expect((await dos.marcarEnviada('otra')).tipo).toBe('ausente');
  });

  it.each(['cache', 'enviada', 'dependencia', 'recibo', 'revision', 'operacion', 'id-repetido', 'sin-marcador', 'fuente-recibo'])('rechaza v2 corrupto %s sin sobrescribir', async (campo) => {
    const ctx = contexto();
    const almacen = await ctx.abrir();
    await almacen.registrar(marca());
    const crudo = await almacen.leer();
    if (campo === 'cache') Object.assign(crudo.estado.paradas.p1, { marca: 'saltada' });
    if (campo === 'enviada') Object.assign(crudo.cola[0], { enviada: 'false' });
    if (campo === 'dependencia') Object.assign(crudo.cola[0], { dependeDe: ['ausente'] });
    if (campo === 'recibo') Object.assign(crudo.confirmado.operaciones, { mal: { firma: 42 } });
    if (campo === 'revision') Object.assign(crudo, { revisionServidor: NaN });
    if (campo === 'operacion') Object.assign(crudo.cola[0].operacion, { revision: -1 });
    if (campo === 'id-repetido') Object.assign(crudo, { cola: [...crudo.cola, crudo.cola[0]] });
    if (campo === 'sin-marcador') Object.assign(crudo, { cola: [{ operacion: marca(), dependeDe: [] }] });
    if (campo === 'fuente-recibo') {
      const confirmado = estadoCon(marca());
      Object.assign(confirmado.operaciones.op1.cambios!, { operacionId: 'ajena' });
      Object.assign(crudo, { confirmado });
    }
    const db = await conexion(ctx.fabrica, ctx.nombre);
    await guardarCrudo(db, crudo);
    const espia = vi.spyOn(IDBObjectStore.prototype, 'put');
    await expect(almacen.leer()).rejects.toThrow('corrupt');
    await expect(almacen.marcarEnviada('op1')).rejects.toThrow('corrupt');
    await expect(ctx.abrir()).rejects.toThrow('corrupt');
    expect(espia).not.toHaveBeenCalled();
    espia.mockRestore();
    expect(await leerCrudo(db)).toEqual(crudo);
  });

  it('captura propios no enumerables de intención y snapshot antes de persistir', async () => {
    const ctx = contexto();
    const almacen = await ctx.abrir();
    const op = marca();
    Object.defineProperty(op, 'id', { value: 'op1', enumerable: false });
    expect((await almacen.registrar(op)).tipo).toBe('aplicada');
    const nueva = instantanea(1, marca());
    Object.defineProperty(nueva.estado.paradas, 'p1', { value: nueva.estado.paradas.p1, enumerable: false });
    Object.defineProperty(nueva.estado.operaciones, 'op1', { value: nueva.estado.operaciones.op1, enumerable: false });
    expect((await almacen.recibirInstantanea(nueva)).tipo).toBe('actualizada');
    almacen.cerrar();
    const raiz = await (await ctx.abrir()).leer();
    expect(raiz.confirmado.paradas.p1.marca).toBe('hecha');
    expect(raiz.confirmado.operaciones.op1).toBeDefined();
    expect(raiz.cola[0].operacion.id).toBe('op1');
  });

  it('hidrata intenciones inválidas y bloqueadas sin descartarlas y permite independientes', async () => {
    const ctx = contexto();
    const almacen = await ctx.abrir();
    const crudo = await almacen.leer();
    const cola = [{ operacion: marca('desconocida', 'fuera'), dependeDe: [], enviada: true },
      { operacion: marca('hija'), dependeDe: ['desconocida'], enviada: false }];
    const db = await conexion(ctx.fabrica, ctx.nombre);
    await guardarCrudo(db, { ...crudo, cola });
    const r = await almacen.recibirInstantanea(instantanea(1));
    expect(r.proyeccion?.entradas.map((e) => e.tipo)).toEqual(['invalida', 'bloqueada']);
    expect((await almacen.marcarEnviada('desconocida')).tipo).toBe('enviada');
    expect((await almacen.marcarEnviada('hija')).tipo).toBe('conflicto');
    expect((await almacen.cancelarIntencion('desconocida')).tipo).toBe('conflicto');
    expect((await almacen.registrar(marca('otra', 'p2'))).tipo).toBe('aplicada');
    almacen.cerrar();
    expect((await (await ctx.abrir()).leer()).cola.slice(0, 2)).toEqual(cola);
  });

  it('captura ack no enumerable y argumentos antes de callbacks; no normaliza extras inválidos', async () => {
    const almacen = await contexto().abrir();
    const op = marca();
    const pendiente = almacen.registrar(op);
    Object.assign(op, { marca: 'saltada' });
    await pendiente;
    const confirmacion = acuse(marca());
    Object.defineProperty(confirmacion, 'persistida', { value: true, enumerable: false });
    Object.defineProperty(confirmacion.instantanea.estado.operaciones, 'op1', {
      value: confirmacion.instantanea.estado.operaciones.op1, enumerable: false,
    });
    const recibido = almacen.recibirAcuse(confirmacion);
    Object.assign(confirmacion.instantanea, { revisionServidor: 99 });
    expect((await recibido).tipo).toBe('confirmada');
    const antes = await almacen.leer();
    expect(antes.revisionServidor).toBe(1);
    const extra = marca('extra', 'p2');
    Object.defineProperty(extra, 'prohibido', { value: undefined, enumerable: false });
    expect((await almacen.registrar(extra)).tipo).toBe('invalida');
    const snapshotExtra = instantanea(2);
    Object.defineProperty(snapshotExtra, 'extra', { value: 1, enumerable: false });
    expect((await almacen.recibirInstantanea(snapshotExtra)).tipo).toBe('invalida');
    await expect(almacen.recibirAcuse(Object.assign(acuse(marca()), { funcion: () => 0 })))
      .rejects.toMatchObject({ name: 'DataCloneError' });
    expect(await almacen.leer()).toEqual(antes);
  });

  it('dos handles no autorizan dependiente saltando padre incierto tras conflicto', async () => {
    const ctx = contexto();
    const uno = await ctx.abrir();
    const dos = await ctx.abrir();
    await uno.registrar(marca());
    await uno.registrar({ ...marca('reset'), marca: null, revision: 1 });
    const r = await Promise.all([uno.marcarEnviada('op1'),
      dos.recibirInstantanea(instantanea(1, { ...marca('remota'), marca: 'saltada' })),
      dos.marcarEnviada('reset')]);
    expect(r.map((v) => v.tipo)).toEqual(['enviada', 'actualizada', 'conflicto']);
    const antes = await uno.leer();
    expect(antes.cola.map((e) => e.enviada)).toEqual([true, false]);
    expect((await dos.marcarEnviada('op1')).tipo).toBe('enviada');
    expect(await dos.leer()).toEqual(antes);
  });

  it('no escribe lecturas iguales/antiguas ni acuses ajenos y métodos cerrados rechazan', async () => {
    const almacen = await contexto().abrir();
    await almacen.recibirInstantanea(instantanea(2));
    const espia = vi.spyOn(IDBObjectStore.prototype, 'put');
    expect((await almacen.recibirInstantanea(instantanea(2))).tipo).toBe('ignorada');
    expect((await almacen.recibirInstantanea(instantanea(1))).tipo).toBe('ignorada');
    expect((await almacen.recibirAcuse(acuse(marca(), 3))).tipo).toBe('ignorada');
    expect(espia).not.toHaveBeenCalled();
    espia.mockRestore();
    almacen.cerrar();
    await expect(almacen.marcarEnviada('op1')).rejects.toThrow('cerrad');
    await expect(almacen.cancelarIntencion('op1')).rejects.toThrow('cerrad');
    await expect(almacen.recibirInstantanea(instantanea(3))).rejects.toThrow('cerrad');
    await expect(almacen.recibirAcuse(acuse(marca()))).rejects.toThrow('cerrad');
  });

  it('aborto/cuota lifecycle propaga error, nunca confirma marcador antes de complete', async () => {
    const almacen = await contexto().abrir();
    await almacen.registrar(marca());
    const antes = await almacen.leer();
    const espia = abortarDespuesDePut();
    await expect(almacen.marcarEnviada('op1')).rejects.toMatchObject({ name: 'AbortError' });
    await expect(almacen.recibirInstantanea(instantanea(1))).rejects.toMatchObject({ name: 'AbortError' });
    await expect(almacen.cancelarIntencion('op1')).rejects.toMatchObject({ name: 'AbortError' });
    espia.mockRestore();
    const cuota = vi.spyOn(IDBObjectStore.prototype, 'put').mockImplementation(() => {
      throw new DOMException('Sin espacio', 'QuotaExceededError');
    });
    await expect(almacen.marcarEnviada('op1')).rejects.toMatchObject({ name: 'QuotaExceededError' });
    cuota.mockRestore();
    expect(await almacen.leer()).toEqual(antes);
  });
});

describe('progreso local transaccional', () => {
  it('inicializa vacío sin importar preferencias ni progreso de subparadas', async () => {
    const almacen = await contexto().abrir();
    const raiz = await almacen.leer();
    expect(raiz.estado).toEqual(raiz.confirmado);
    expect(raiz.estado.paradas).toEqual({});
    expect(raiz.cola).toEqual([]);
    expect(raiz.legado).toBeUndefined();
  });

  it('persiste estado y operación original al cerrar y reabrir; devuelve copias aisladas', async () => {
    const ctx = contexto();
    const almacen = await ctx.abrir();
    const operacion = marca();
    const resultado = await almacen.registrar(operacion);
    expect(resultado.tipo).toBe('aplicada');
    Object.assign(operacion, { marca: 'saltada' });
    Object.assign(resultado.estado.paradas.p1, { marca: 'saltada' });
    const lectura = await almacen.leer();
    Object.assign(lectura.cola[0].operacion, { id: 'alterada' });
    Object.assign(lectura.confirmado.aqui, { paradaId: 'p2' });
    almacen.cerrar();
    await expect(almacen.leer()).rejects.toThrow('cerrad');
    const recargado = await ctx.abrir();
    const raiz = await recargado.leer();
    expect(raiz.estado.paradas.p1.marca).toBe('hecha');
    expect(raiz.confirmado.paradas).toEqual({});
    expect(raiz.confirmado.aqui.paradaId).toBeNull();
    expect(raiz.cola).toEqual([{ operacion: marca(), dependeDe: [], enviada: false }]);
    expect((await recargado.registrar(marca())).tipo).toBe('duplicada');
    expect(await recargado.leer()).toEqual(raiz);
  });

  it('reintenta IDs idénticos sin duplicar y rechaza reutilización, conflictos e inválidas sin escribir', async () => {
    const almacen = await contexto().abrir();
    await almacen.registrar(marca());
    const antes = await almacen.leer();
    expect((await almacen.registrar(marca())).tipo).toBe('duplicada');
    expect((await almacen.registrar({ ...marca(), marca: 'saltada' })).tipo).toBe('invalida');
    expect((await almacen.registrar({ ...marca('otra'), marca: null })).tipo).toBe('conflicto');
    expect((await almacen.registrar(marca('mala', 'ausente'))).tipo).toBe('invalida');
    expect(await almacen.leer()).toEqual(antes);
    await almacen.registrar({ id: 'casilla', dispositivoId: 'movil', tipo: 'pendiente',
      pendienteId: 'c1', hecho: true, revision: 0 });
    const conCasilla = await almacen.leer();
    expect((await almacen.registrar({ id: 'false-viejo', dispositivoId: 'movil', tipo: 'pendiente',
      pendienteId: 'c1', hecho: false, revision: 0 })).tipo).toBe('conflicto');
    expect(await almacen.leer()).toEqual(conCasilla);
    await almacen.registrar({ ...marca('reset'), marca: null, revision: 1 });
    await almacen.registrar({ id: 'false', dispositivoId: 'movil', tipo: 'pendiente',
      pendienteId: 'c1', hecho: false, revision: 1 });
    expect((await almacen.leer()).estado.pendientes.c1.hecho).toBe(false);
    expect((await almacen.leer()).estado.paradas.p1.marca).toBeNull();
  });

  it('serializa read-modify-write entre dos conexiones sin perder entidades independientes', async () => {
    const ctx = contexto();
    const uno = await ctx.abrir();
    const dos = await ctx.abrir();
    const resultados = await Promise.all([uno.registrar(marca()), dos.registrar(marca('op2', 'p2'))]);
    expect(resultados.map((r) => r.tipo)).toEqual(['aplicada', 'aplicada']);
    const raiz = await uno.leer();
    expect(Object.keys(raiz.estado.paradas)).toEqual(['p1', 'p2']);
    expect(raiz.cola.map((p) => p.operacion.id)).toEqual(['op1', 'op2']);
    expect(raiz.cola[1].dependeDe).toEqual([]);
  });

  it('rechaza aborto posterior al éxito del request y revierte estado y cola juntos', async () => {
    const ctx = contexto();
    const almacen = await ctx.abrir();
    const antes = await almacen.leer();
    const espia = abortarDespuesDePut();
    await expect(almacen.registrar(marca())).rejects.toMatchObject({ name: 'AbortError' });
    espia.mockRestore();
    expect(await almacen.leer()).toEqual(antes);
    almacen.cerrar();
    expect(await (await ctx.abrir()).leer()).toEqual(antes);
  });

  it('propaga errores de escritura/cuota y DataCloneError sin modificar el registro', async () => {
    const almacen = await contexto().abrir();
    const antes = await almacen.leer();
    const espia = vi.spyOn(IDBObjectStore.prototype, 'put').mockImplementation(() => {
      throw new DOMException('Sin espacio', 'QuotaExceededError');
    });
    await expect(almacen.registrar(marca())).rejects.toMatchObject({ name: 'QuotaExceededError' });
    espia.mockRestore();
    await expect(almacen.registrar(Object.assign(marca(), { noClonable: () => 1 })))
      .rejects.toMatchObject({ name: 'DataCloneError' });
    expect(await almacen.leer()).toEqual(antes);
  });

  it('propaga errores asíncronos del request y errores de apertura', async () => {
    const ctx = contexto();
    const almacen = await ctx.abrir();
    const antes = await almacen.leer();
    // add sobre la raíz existente emite ConstraintError asincrónicamente, no un throw de put.
    const escritura = vi.spyOn(IDBObjectStore.prototype, 'put').mockImplementation(function (this: IDBObjectStore, valor, clave) {
      return this.add(valor, clave);
    });
    await expect(almacen.registrar(marca())).rejects.toMatchObject({ name: 'ConstraintError' });
    escritura.mockRestore();
    expect(await almacen.leer()).toEqual(antes);
    const apertura = vi.spyOn(ctx.fabrica, 'open').mockImplementation(() => {
      throw new DOMException('Acceso denegado', 'SecurityError');
    });
    await expect(ctx.abrir()).rejects.toMatchObject({ name: 'SecurityError' });
    apertura.mockRestore();
  });

  it('guarda intenciones sin-cambio y deshacer sin eliminar las operaciones previas', async () => {
    const ctx = contexto();
    const almacen = await ctx.abrir();
    const primera = await almacen.registrar(marca());
    if (primera.tipo !== 'aplicada') throw new Error('Falta recibo');
    expect((await almacen.registrar(marca('igual'))).tipo).toBe('sin-cambio');
    expect((await almacen.registrar({ id: 'deshacer', dispositivoId: 'otro-movil', tipo: 'deshacer',
      cambios: primera.cambios })).tipo).toBe('aplicada');
    almacen.cerrar();
    const raiz = await (await ctx.abrir()).leer();
    expect(raiz.estado.paradas.p1).toEqual({ marca: null, revision: 2 });
    expect(raiz.cola.map((p) => p.operacion.id)).toEqual(['op1', 'igual', 'deshacer']);
    expect(raiz.cola[2].dependeDe).toEqual(['op1']);
  });

  it('conserva JSON roto y aquí ambiguo sin inventar intenciones', async () => {
    const ctx = contexto();
    const entradas = { ...legado, marcas: '{"2026-10-21|09:00|Uno":"aqui","desconocida":"aqui"}',
      'marcas-hora': '{roto', 'pendientes-hechos': '[]' };
    const raiz = await (await ctx.abrir(entradas)).leer();
    expect(raiz.legado?.originales).toEqual(entradas);
    expect(raiz.legado?.recuperacion.map((r) => r.motivo)).toEqual(['malformada', 'desconocida', 'conflicto-aqui']);
    expect(raiz.cola).toEqual([]);
    expect(raiz.estado).toEqual(raiz.confirmado);
    const ambiguo = contexto();
    const clavesViejas = { ...legado,
      marcas: '{"2026-10-21|07:00|Uno":"hecha","2026-10-21|08:00|Uno":"saltada"}',
      'marcas-hora': '{}', 'pendientes-hechos': '[]' };
    const sinAdivinar = await (await ambiguo.abrir(clavesViejas)).leer();
    expect(sinAdivinar.cola).toEqual([]);
    expect(sinAdivinar.legado?.originales).toEqual(clavesViejas);
    expect(sinAdivinar.legado?.recuperacion.map((r) => r.motivo)).toEqual(['ambigua', 'ambigua']);
    const unica = contexto();
    const conAqui = await (await unica.abrir({ ...legado,
      marcas: '{"2026-10-21|09:00|Uno":"aqui"}', 'pendientes-hechos': '[]' })).leer();
    expect(conAqui.estado.aqui).toEqual({ paradaId: 'p1', revision: 1 });
    expect(conAqui.cola[0].operacion).toEqual({ ...marca('legado-1'), marca: 'aqui', horaReal: 555, revisionAqui: 0 });
  });

  it('importa una sola vez originales, recuperación e intenciones reales pendientes con IDs estables', async () => {
    const ctx = contexto();
    const almacen = await ctx.abrir(legado);
    const raiz = await almacen.leer();
    expect(raiz.legado?.originales).toEqual(legado);
    expect(raiz.legado?.recuperacion.map((r) => r.motivo)).toEqual(['desconocida', 'desconocida']);
    expect(raiz.confirmado.paradas).toEqual({});
    expect(raiz.confirmado.operaciones).toEqual({});
    expect(raiz.cola.map((p) => p.operacion)).toEqual([
      { ...marca('legado-1'), horaReal: 555 },
      { id: 'legado-2', dispositivoId: 'movil', tipo: 'pendiente', pendienteId: 'c1', hecho: true, revision: 0 },
    ]);
    await almacen.registrar({ ...marca('nueva'), marca: 'saltada', revision: 1 });
    const posterior = await almacen.leer();
    almacen.cerrar();
    expect(await (await ctx.abrir({ ...legado, marcas: '{}' })).leer()).toEqual(posterior);
  });

  it('abortar importación no deja marcador ni cola parcial y permite reintentar', async () => {
    const ctx = contexto();
    const espia = abortarDespuesDePut();
    await expect(ctx.abrir(legado)).rejects.toMatchObject({ name: 'AbortError' });
    espia.mockRestore();
    const raiz = await (await ctx.abrir(legado)).leer();
    expect(raiz.cola).toHaveLength(2);
    expect(raiz.legado?.originales).toEqual(legado);
  });

  it('no importa encima de un viaje ya inicializado sin legado', async () => {
    const ctx = contexto();
    const almacen = await ctx.abrir();
    await almacen.registrar(marca());
    const antes = await almacen.leer();
    almacen.cerrar();
    expect(await (await ctx.abrir(legado)).leer()).toEqual(antes);
  });

  it('expone indisponibilidad y versiones/esquemas no soportados', async () => {
    await expect(abrirProgresoLocal(plan, { fabrica: null, dispositivoId: 'movil' })).rejects.toThrow('IndexedDB');
    const ctx = contexto();
    const db = await conexion(ctx.fabrica, ctx.nombre, 2);
    db.close();
    await expect(ctx.abrir()).rejects.toMatchObject({ name: 'VersionError' });
    const otro = contexto();
    const sinAlmacen = await conexion(otro.fabrica, otro.nombre, 1);
    sinAlmacen.close();
    await expect(otro.abrir()).rejects.toThrow('esquema');
  });

  it('rechaza datos corruptos sin restablecerlos', async () => {
    const ctx = contexto();
    const almacen = await ctx.abrir();
    almacen.cerrar();
    const db = await conexion(ctx.fabrica, ctx.nombre);
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction('viajes', 'readwrite');
      tx.objectStore('viajes').put({ formato: 1, estado: { viajeId: plan.id } }, plan.id);
      tx.oncomplete = () => resolve();
      tx.onabort = () => reject(tx.error);
    });
    db.close();
    await expect(ctx.abrir()).rejects.toThrow('corrupt');
    const comprobacion = await conexion(ctx.fabrica, ctx.nombre);
    const solicitud = comprobacion.transaction('viajes').objectStore('viajes').get(plan.id);
    const valor = await new Promise<unknown>((resolve) => { solicitud.onsuccess = () => resolve(solicitud.result); });
    expect(valor).toEqual({ formato: 1, estado: { viajeId: plan.id } });
  });

  const corrupciones: [string, (estado: EstadoProgreso) => void][] = [
    ['aquí Infinity', (e) => Object.assign(e.aqui, { paradaId: Infinity })],
    ['aquí NaN', (e) => Object.assign(e.aqui, { paradaId: NaN })],
    ['aquí undefined', (e) => Object.assign(e.aqui, { paradaId: undefined })],
    ['contenedores Map', (e) => Object.assign(e, { paradas: new Map(), operaciones: new Map() })],
    ['contenedor array', (e) => Object.assign(e, { pendientes: [] })],
    ['campo extra undefined', (e) => Object.assign(e.aqui, { extra: undefined })],
  ];
  it.each(corrupciones)('rechaza snapshot %s en lectura y reapertura sin reemplazarlo', async (_nombre, corromper) => {
    const ctx = contexto();
    const almacen = await ctx.abrir();
    const e = crearProgreso(plan);
    corromper(e);
    const crudo = { formato: 1, confirmado: e, estado: e, cola: [] };
    const db = await conexion(ctx.fabrica, ctx.nombre);
    await guardarCrudo(db, crudo);
    await expect(almacen.leer()).rejects.toThrow('corrupt');
    almacen.cerrar();
    db.close();
    await expect(ctx.abrir()).rejects.toThrow('corrupt');
    const inspeccion = await conexion(ctx.fabrica, ctx.nombre);
    expect(await leerCrudo(inspeccion)).toEqual(crudo);
  });

  const recibosMalformados: [string, (cambios: Cambios) => void][] = [
    ['marca NaN', (c) => Object.assign(c.registros[0].antes, { marca: NaN })],
    ['marca Infinity', (c) => Object.assign(c.registros[0].antes, { marca: Infinity })],
    ['marca undefined', (c) => Object.assign(c.registros[0].antes, { marca: undefined })],
    ['hora null', (c) => Object.assign(c.registros[0].antes, { horaReal: null })],
    ['hora NaN', (c) => Object.assign(c.registros[0].antes, { horaReal: NaN })],
    ['hora undefined', (c) => Object.assign(c.registros[0].antes, { horaReal: undefined })],
    ['campo extra undefined', (c) => Object.assign(c.registros[0].antes, { extra: undefined })],
    ['tag desconocido', (c) => Object.assign(c.registros[0], { tipo: 'otra' })],
    ['revision inválida', (c) => Object.assign(c.registros[0].antes, { revision: Infinity })],
    ['registros dispersos', (c) => Object.assign(c, { registros: new Array(1) })],
    ['aquí malformado', (c) => Object.assign(c, { aqui: { antes: { paradaId: NaN, revision: 0 },
      despues: { paradaId: null, revision: 1 } } })],
  ];
  it.each(recibosMalformados)('no registra recibo %s ni consume su ID', async (_nombre, corromper) => {
    const ctx = contexto();
    const almacen = await ctx.abrir();
    const primera = await almacen.registrar(marca());
    if (primera.tipo !== 'aplicada') throw new Error('Falta recibo');
    const antes = await almacen.leer();
    const cambios = structuredClone(primera.cambios);
    corromper(cambios);
    const op: Operacion = { id: 'bad-undo', dispositivoId: 'movil', tipo: 'deshacer', cambios };
    expect((await almacen.registrar(op)).tipo).toBe('invalida');
    expect(await almacen.leer()).toEqual(antes);
    expect((await almacen.registrar({ ...op, cambios: primera.cambios })).tipo).toBe('aplicada');
    Object.assign(primera.cambios.registros[0].antes, { marca: 'saltada' });
    const valido = await almacen.leer();
    almacen.cerrar();
    expect(await (await ctx.abrir()).leer()).toEqual(valido);
  });

  it('compara también la proyección optimista sin alias JSON', async () => {
    const ctx = contexto();
    const almacen = await ctx.abrir();
    const crudo = await almacen.leer();
    Object.assign(crudo.estado, { paradas: new Map() });
    // confirmado y estado devueltos pueden compartir referencias: separar explícitamente la base.
    const corrupto = { ...crudo, confirmado: crearProgreso(plan) };
    const db = await conexion(ctx.fabrica, ctx.nombre);
    await guardarCrudo(db, corrupto);
    await expect(almacen.leer()).rejects.toThrow('corrupt');
    expect(await leerCrudo(db)).toEqual(corrupto);
  });

  it('conserva recibos válidos de aquí y casilla, aislados y sin normalizar la cola', async () => {
    const ctx = contexto();
    const almacen = await ctx.abrir();
    const aqui = await almacen.registrar({ ...marca('aqui'), marca: 'aqui', revisionAqui: 0, horaReal: 555 });
    if (aqui.tipo !== 'aplicada') throw new Error('Falta recibo aquí');
    const undoAqui: Operacion = { id: 'undo-aqui', dispositivoId: 'movil', tipo: 'deshacer', cambios: aqui.cambios };
    expect((await almacen.registrar(undoAqui)).tipo).toBe('aplicada');
    const casilla = await almacen.registrar({ id: 'casilla', dispositivoId: 'movil', tipo: 'pendiente',
      pendienteId: 'c1', hecho: true, revision: 0 });
    if (casilla.tipo !== 'aplicada') throw new Error('Falta recibo casilla');
    const undoCasilla: Operacion = { id: 'undo-casilla', dispositivoId: 'movil', tipo: 'deshacer', cambios: casilla.cambios };
    expect((await almacen.registrar(undoCasilla)).tipo).toBe('aplicada');
    const guardado = await almacen.leer();
    expect(guardado.cola[1].operacion).toEqual(undoAqui);
    expect(guardado.cola[3].operacion).toEqual(undoCasilla);
    expect(guardado.estado.aqui.paradaId).toBeNull();
    expect(guardado.estado.pendientes.c1.hecho).toBe(false);
    Object.assign(casilla.cambios.registros[0].antes, { hecho: true });
    Object.assign(aqui.cambios.aqui?.antes ?? {}, { paradaId: 'alterada' });
    almacen.cerrar();
    expect(await (await ctx.abrir()).leer()).toEqual(guardado);
  });

  it('rechaza un recibo persistido con NaN que antes era alias de null, sin sobrescribirlo', async () => {
    const ctx = contexto();
    const almacen = await ctx.abrir();
    const primera = await almacen.registrar(marca());
    if (primera.tipo !== 'aplicada') throw new Error('Falta recibo');
    await almacen.registrar({ id: 'undo', dispositivoId: 'movil', tipo: 'deshacer', cambios: primera.cambios });
    const crudo = await almacen.leer();
    const undo = crudo.cola[1].operacion;
    if (undo.tipo !== 'deshacer') throw new Error('Falta deshacer');
    Object.assign(undo.cambios.registros[0].antes, { marca: NaN });
    const db = await conexion(ctx.fabrica, ctx.nombre);
    await guardarCrudo(db, crudo);
    await expect(almacen.leer()).rejects.toThrow('corrupt');
    await expect(almacen.registrar(marca('op2', 'p2'))).rejects.toThrow('corrupt');
    almacen.cerrar();
    db.close();
    await expect(ctx.abrir()).rejects.toThrow('corrupt');
    expect(await leerCrudo(await conexion(ctx.fabrica, ctx.nombre))).toEqual(crudo);
  });

  it.each<[string, unknown]>([
    ['campo', ['marcas']],
    ['motivo', ['desconocida']],
    ['campo', new String('marcas')],
    ['motivo', new String('desconocida')],
  ])('rechaza %s de recuperación no primitivo sin sobrescribir el respaldo', async (campo, valor) => {
    const ctx = contexto();
    const almacen = await ctx.abrir(legado);
    const crudo = await almacen.leer();
    if (!crudo.legado) throw new Error('Falta respaldo legado');
    Object.assign(crudo.legado.recuperacion[0], { [campo]: valor });
    const db = await conexion(ctx.fabrica, ctx.nombre);
    await guardarCrudo(db, crudo);
    await expect(almacen.leer()).rejects.toThrow('corrupt');
    await expect(almacen.registrar(marca('nueva', 'p2'))).rejects.toThrow('corrupt');
    almacen.cerrar();
    db.close();
    await expect(ctx.abrir()).rejects.toThrow('corrupt');
    expect(await leerCrudo(await conexion(ctx.fabrica, ctx.nombre))).toEqual(crudo);
  });

  it('preserva valores clonables no JSON del respaldo legado, sin tratarlos como estado', async () => {
    const ctx = contexto();
    const entradas = { ...legado, extra: { numero: Infinity, mapa: new Map([['valor', NaN]]), ausente: undefined } };
    const almacen = await abrirProgresoLocal(plan, { ...ctx.opciones, entradasLegadas: entradas });
    cierres.push(() => almacen.cerrar());
    const raiz = await almacen.leer();
    expect(raiz.legado?.originales).toEqual(entradas);
    almacen.cerrar();
    expect((await (await ctx.abrir()).leer()).legado?.originales).toEqual(entradas);
  });

  it('cierra por versionchange y rechaza apertura bloqueada sin mantener conexiones tardías', async () => {
    const ctx = contexto();
    const almacen = await ctx.abrir();
    const nueva = await conexion(ctx.fabrica, ctx.nombre, 2);
    await expect(almacen.leer()).rejects.toThrow('cerrad');
    nueva.close();
    const bloqueado = contexto();
    // Simula el evento blocked y su éxito tardío: la API IDB no ofrece cancelación de open.
    const tardia = await conexion(bloqueado.fabrica, bloqueado.nombre);
    const cierre = vi.spyOn(tardia, 'close');
    const solicitud = new EventTarget() as IDBOpenDBRequest;
    Object.defineProperty(solicitud, 'result', { value: tardia });
    const apertura = vi.spyOn(bloqueado.fabrica, 'open').mockImplementation(() => {
      queueMicrotask(() => solicitud.onblocked?.(new Event('blocked') as IDBVersionChangeEvent));
      return solicitud;
    });
    await expect(bloqueado.abrir()).rejects.toThrow('bloquead');
    solicitud.onsuccess?.(new Event('success'));
    expect(cierre).toHaveBeenCalledOnce();
    apertura.mockRestore();
  });
});
