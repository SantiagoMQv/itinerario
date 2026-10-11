import { describe, expect, it } from 'vitest';
import { aplicarOperacion, crearProgreso } from '../src/progreso';
import type { Cambios, EstadoProgreso, Operacion } from '../src/progreso';
import { esEstadoProgreso, esInstantaneaProgreso, esOperacion, iguales } from '../src/progreso-validacion';
import type { InstantaneaProgreso } from '../src/progreso-validacion';
import type { Itinerario } from '../src/tipos';

const plan: Itinerario = {
  id: 'viaje', titulo: 'Prueba', dias: [{ fecha: '2026-10-21', titulo: 'Día', paradas: [
    { id: 'p1', nombre: 'Uno', hora: '09:00', categoria: 'otro', lat: 0, lng: 0,
      subparadas: [{ id: 'sub1', nombre: 'Dentro' }] },
    { id: 'p2', nombre: 'Dos', hora: '10:00', categoria: 'otro', lat: 0, lng: 0 },
  ] }], pendientes: [{ id: 'c1', texto: 'Reserva' }],
};
const operacion = (campos: Partial<Extract<Operacion, { tipo: 'parada' }>> = {}): Operacion =>
  ({ id: 'op1', dispositivoId: 'movil', tipo: 'parada', paradaId: 'p1', marca: 'hecha', revision: 0, ...campos });
function aplicado(op = operacion(), estado = crearProgreso(plan), itinerario = plan) {
  const resultado = aplicarOperacion(itinerario, estado, op);
  if (resultado.tipo !== 'aplicada') throw new Error('Falta recibo');
  return resultado;
}
function conRecibo(): EstadoProgreso { return structuredClone(aplicado().estado); }
function congelar(valor: unknown): void {
  if (valor && typeof valor === 'object') {
    Object.values(valor).forEach(congelar);
    Object.freeze(valor);
  }
}

describe('frontera pura de progreso confirmado', () => {
  it('acepta vacío y estados del núcleo: aquí, traslado, casilla, reset, no-op y deshacer', () => {
    let estado = crearProgreso(plan);
    expect(esEstadoProgreso(plan, estado)).toBe(true);
    const primero = aplicado(operacion({ marca: 'aqui', horaReal: 900, revisionAqui: 0 }), estado);
    const operaciones: Operacion[] = [
      operacion({ id: 'traslado', paradaId: 'p2', marca: 'aqui', horaReal: 10, revisionAqui: 1, revisionAnterior: 1 }),
      { id: 'casilla', dispositivoId: 'movil', tipo: 'pendiente', pendienteId: 'c1', hecho: true, revision: 0 },
      operacion({ id: 'reset', marca: null, revision: 2 }),
      operacion({ id: 'noop', marca: null, revision: 3 }),
    ];
    estado = primero.estado;
    expect(esEstadoProgreso(plan, estado)).toBe(true);
    for (const op of operaciones) {
      expect(esOperacion(op)).toBe(true);
      const resultado = aplicarOperacion(plan, estado, op);
      expect(['aplicada', 'sin-cambio']).toContain(resultado.tipo);
      estado = resultado.estado;
      expect(esEstadoProgreso(plan, estado)).toBe(true);
    }
    const casilla = estado.operaciones.casilla.cambios!;
    const undo: Operacion = { id: 'undo', dispositivoId: 'otro', tipo: 'deshacer', cambios: casilla };
    expect(esOperacion(undo)).toBe(true);
    expect(esEstadoProgreso(plan, aplicado(undo, estado).estado)).toBe(true);
  });

  it('acepta IDs opacos que colisionan con prototipos en todos los diccionarios', () => {
    const opaco = structuredClone(plan);
    Object.assign(opaco.dias[0].paradas[0], { id: '__proto__' });
    Object.assign(opaco.pendientes![0], { id: 'constructor' });
    let estado = aplicado(operacion({ id: '__proto__', paradaId: '__proto__' }), crearProgreso(opaco), opaco).estado;
    estado = aplicado({ id: 'constructor', dispositivoId: 'movil', tipo: 'pendiente',
      pendienteId: 'constructor', hecho: false, revision: 0 }, estado, opaco).estado;
    expect(esEstadoProgreso(opaco, estado)).toBe(true);
    const nulo = Object.assign(Object.create(null), estado);
    expect(esEstadoProgreso(opaco, nulo)).toBe(true);
  });

  it.each([
    { caso: 'activo oculto sin puntero', paradaId: null, segundo: false, valido: false },
    { caso: 'activo oculto con puntero coherente', paradaId: 'p1', segundo: false, valido: true },
    { caso: 'segundo activo oculto', paradaId: 'p1', segundo: true, valido: false },
  ])('cuenta todas las claves propias: $caso', ({ paradaId, segundo, valido }) => {
    const estado = crearProgreso(plan);
    Object.defineProperty(estado.paradas, 'p1', {
      value: Object.freeze({ marca: 'aqui', revision: 1 }), enumerable: segundo,
    });
    if (segundo) Object.defineProperty(estado.paradas, 'p2', {
      value: Object.freeze({ marca: 'aqui', revision: 1 }), enumerable: false,
    });
    Object.assign(estado.aqui, { paradaId, revision: 1 });
    congelar(estado);
    expect.soft(esEstadoProgreso(plan, estado)).toBe(valido);
    expect.soft(esInstantaneaProgreso(plan, Object.freeze({ revisionServidor: 0, estado }))).toBe(valido);
  });

  const corrupciones: [string, (e: EstadoProgreso) => void][] = [
    ['viaje distinto', (e) => Object.assign(e, { viajeId: 'otro' })],
    ['parada desconocida', (e) => Object.assign(e.paradas, { otra: { marca: null, revision: 0 } })],
    ['subparada', (e) => Object.assign(e.paradas, { sub1: { marca: null, revision: 0 } })],
    ['pendiente desconocido', (e) => Object.assign(e.pendientes, { otra: { hecho: false, revision: 0 } })],
    ['marca array', (e) => Object.assign(e.paradas.p1, { marca: ['hecha'] })],
    ['hora undefined', (e) => Object.assign(e.paradas.p1, { horaReal: undefined })],
    ['hora no finita', (e) => Object.assign(e.paradas.p1, { horaReal: Infinity })],
    ['hora sin marca', (e) => Object.assign(e.paradas.p1, { marca: null, horaReal: 0 })],
    ['revisión fraccionaria', (e) => Object.assign(e.paradas.p1, { revision: 0.5 })],
    ['revisión insegura', (e) => Object.assign(e.aqui, { revision: Number.MAX_SAFE_INTEGER + 1 })],
    ['revisión negativa', (e) => Object.assign(e.aqui, { revision: -1 })],
    ['revisión NaN', (e) => Object.assign(e.aqui, { revision: NaN })],
    ['puntero sin marca', (e) => Object.assign(e.aqui, { paradaId: 'p1' })],
    ['marca sin puntero', (e) => Object.assign(e.paradas.p1, { marca: 'aqui' })],
    ['dos activos', (e) => {
      Object.assign(e.paradas.p1, { marca: 'aqui' });
      Object.assign(e.paradas, { p2: { marca: 'aqui', revision: 1 } });
      Object.assign(e.aqui, { paradaId: 'p1' });
    }],
    ['puntero desconocido', (e) => Object.assign(e.aqui, { paradaId: 'sub1' })],
    ['diccionario Map', (e) => Object.assign(e, { paradas: new Map() })],
    ['diccionario array', (e) => Object.assign(e, { pendientes: [] })],
    ['diccionario heredado', (e) => Object.assign(e, { operaciones: Object.create({ oculta: {} }) })],
    ['campo adicional', (e) => Object.assign(e, { extra: undefined })],
    ['firma no string', (e) => Object.assign(e.operaciones.op1, { firma: new String('firma') })],
    ['acuse adicional', (e) => Object.assign(e.operaciones.op1, { extra: 1 })],
    ['cambios undefined', (e) => Object.assign(e.operaciones.op1, { cambios: undefined })],
    ['ID de recibo distinto', (e) => Object.assign(e.operaciones.op1.cambios!, { operacionId: 'otra' })],
    ['ID de operación vacío', (e) => Object.assign(e.operaciones, { ' ': { firma: '' } })],
  ];
  it.each(corrupciones)('rechaza %s', (_nombre, corromper) => {
    const estado = conRecibo();
    corromper(estado);
    expect(esEstadoProgreso(plan, estado)).toBe(false);
  });

  const recibos: [string, (c: Cambios) => void][] = [
    ['marca NaN', (c) => Object.assign(c.registros[0].antes, { marca: NaN })],
    ['tag array', (c) => Object.assign(c.registros[0], { tipo: ['parada'] })],
    ['revision Infinity', (c) => Object.assign(c.registros[0].despues, { revision: Infinity })],
    ['registros dispersos', (c) => Object.assign(c, { registros: new Array(1) })],
    ['registros con extra', (c) => Object.assign(c.registros, { extra: true })],
    ['aquí undefined', (c) => Object.assign(c, { aqui: undefined })],
    ['aquí corrupto', (c) => Object.assign(c, { aqui: {
      antes: { paradaId: null, revision: NaN }, despues: { paradaId: null, revision: 1 },
    } })],
  ];
  it.each(recibos)('rechaza recibo %s en acuse y operación', (_nombre, corromper) => {
    const estado = conRecibo();
    const cambios = estado.operaciones.op1.cambios!;
    corromper(cambios);
    expect(esEstadoProgreso(plan, estado)).toBe(false);
    expect(esOperacion({ id: 'undo', dispositivoId: 'movil', tipo: 'deshacer', cambios })).toBe(false);
  });

  it.each(['otra', 'sub1', 'c1'])('rechaza parada de recibo %s fuera del catálogo', (id) => {
    const estado = conRecibo();
    Object.assign(estado.operaciones.op1.cambios!.registros[0], { id });
    expect(esEstadoProgreso(plan, estado)).toBe(false);
  });
  it('valida IDs de casilla y aquí anidados, no reconstruye historia ni interpreta firma', () => {
    const estado = conRecibo();
    Object.assign(estado.operaciones.op1, { firma: 'opaca, no autenticada' });
    Object.assign(estado.paradas.p1, { revision: 99 });
    expect(esEstadoProgreso(plan, estado)).toBe(true);
    Object.assign(estado.operaciones.op1.cambios!, { aqui: {
      antes: { paradaId: 'sub1', revision: 0 }, despues: { paradaId: null, revision: 1 },
    } });
    expect(esEstadoProgreso(plan, estado)).toBe(false);
    const casilla = aplicado({ id: 'check', dispositivoId: 'movil', tipo: 'pendiente',
      pendienteId: 'c1', hecho: true, revision: 0 }).estado;
    Object.assign(casilla.operaciones.check.cambios!.registros[0], { id: 'p1' });
    expect(esEstadoProgreso(plan, casilla)).toBe(false);
  });

  it('admite deshacer un traslado aquí y rechaza campos simbólicos', () => {
    const primero = aplicado(operacion({ marca: 'aqui', revisionAqui: 0 }));
    const traslado = aplicado(operacion({ id: 'traslado', paradaId: 'p2', marca: 'aqui',
      revisionAqui: 1, revisionAnterior: 1 }), primero.estado);
    const undo = aplicado({ id: 'undo', dispositivoId: 'movil', tipo: 'deshacer', cambios: traslado.cambios }, traslado.estado);
    expect(undo.estado.aqui.paradaId).toBe('p1');
    expect(esEstadoProgreso(plan, undo.estado)).toBe(true);
    Object.assign(undo.estado.operaciones, { [Symbol('extra')]: { firma: '' } });
    expect(esEstadoProgreso(plan, undo.estado)).toBe(false);
  });

  it.each([null, [], new Map(), new String('estado'), undefined])('rechaza contenedor de estado %s', (valor) => {
    expect(esEstadoProgreso(plan, valor)).toBe(false);
  });
  it('no muta argumentos congelados y admite revisiones seguras máximas', () => {
    const estado = conRecibo();
    Object.assign(estado.aqui, { revision: Number.MAX_SAFE_INTEGER });
    congelar(estado);
    congelar(plan);
    expect(esEstadoProgreso(plan, estado)).toBe(true);
    expect(esOperacion(Object.freeze(operacion()))).toBe(true);
  });
});

describe('instantánea con secuencia de servidor, no reloj causal', () => {
  it('expone contrato tipado y no vincula secuencia a hora ni revisiones de entidades', () => {
    const estado = aplicado(operacion({ horaReal: -10 })).estado;
    const instantanea: InstantaneaProgreso = { revisionServidor: 0, estado };
    expect(esInstantaneaProgreso(plan, instantanea)).toBe(true);
    expect(esInstantaneaProgreso(plan, { revisionServidor: Number.MAX_SAFE_INTEGER, estado })).toBe(true);
    expect(esInstantaneaProgreso(plan, { revisionServidor: 1, estado: crearProgreso(plan) })).toBe(true);
  });
  it.each([-1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, '1', undefined])('rechaza secuencia %s', (revisionServidor) => {
    expect(esInstantaneaProgreso(plan, { revisionServidor, estado: crearProgreso(plan) })).toBe(false);
  });
  it.each([null, [], new Map(), { estado: crearProgreso(plan) },
    { revisionServidor: 0, estado: [] }, { revisionServidor: 0, estado: crearProgreso(plan), reloj: 1 }])
  ('rechaza envoltorio incorrecto %s', (valor) => { expect(esInstantaneaProgreso(plan, valor)).toBe(false); });
});

describe('guardia de operación y comparación no-lossy', () => {
  it.each([{ horaReal: undefined }, { revisionAqui: undefined }, { revisionAnterior: undefined },
    { marca: new String('hecha') }, { marca: ['hecha'] }, { revision: NaN }, { extra: undefined }])
  ('rechaza opcionales presentes y aliases %s', (campos) => { expect(esOperacion({ ...operacion(), ...campos })).toBe(false); });
  it.each([null, [], new Map(), new String('operacion'), undefined,
    { ...operacion(), dispositivoId: ['movil'] }, { ...operacion(), id: ' ' },
    { id: 'op', dispositivoId: 'movil', tipo: 'pendiente', pendienteId: 'c1', hecho: 1, revision: 0 }])
  ('rechaza operación malformada %s', (valor) => { expect(esOperacion(valor)).toBe(false); });
  it('deja comprobación de entidad de operación al núcleo, sin dependencia de IDB', () => {
    expect(esOperacion(operacion({ paradaId: 'desconocida' }))).toBe(true);
    expect(esOperacion({ id: 'op', dispositivoId: 'movil', tipo: 'pendiente', pendienteId: 'c1', hecho: false, revision: 0 })).toBe(true);
  });
  it('distingue ausencia, undefined, Map, NaN e Infinity sin normalizar', () => {
    expect(iguales({ a: undefined }, {})).toBe(false);
    expect(iguales({}, { a: undefined })).toBe(false);
    expect(iguales(new Map(), {})).toBe(false);
    expect(iguales({ a: NaN }, { a: null })).toBe(false);
    expect(iguales({ a: Infinity }, { a: null })).toBe(false);
    expect(iguales(new Array(1), [undefined])).toBe(false);
    expect(iguales({ a: [1, null] }, { a: [1, null] })).toBe(true);
  });
});
