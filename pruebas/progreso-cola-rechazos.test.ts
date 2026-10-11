import { describe, expect, test } from 'vitest';
import { aplicarOperacion, crearProgreso, prepararDeshacer, type Operacion } from '../src/progreso';
import type { InstantaneaProgreso } from '../src/progreso-validacion';
import type { Itinerario } from '../src/tipos';
import {
  iniciarCola, agregarIntencion, proyectarCola, marcarEnviada, cancelarIntencion,
  recibirInstantanea, recibirAcuse, recibirRechazo, resolverRechazo,
  type Cola, type ResultadoCola, type RechazoPersistido,
} from '../src/progreso-cola';

const plan: Itinerario = {
  id: 'viaje', titulo: 'Prueba', dias: [{ fecha: '2026-10-21', titulo: 'Día', paradas:
    ['a', 'b'].map((id) => ({ id, nombre: id, hora: '10:00', categoria: 'museo', lat: 31, lng: 121 })) }],
};
const vacia = (): InstantaneaProgreso => ({ revisionServidor: 0, estado: crearProgreso(plan) });
const parada = (id = 'original', marca: 'hecha' | 'saltada' | null = 'hecha', revision = 0):
  Extract<Operacion, { tipo: 'parada' }> =>
  ({ id, dispositivoId: 'fold', tipo: 'parada', paradaId: 'a', marca, revision });
function cola(r: ResultadoCola): Cola {
  expect(r.cola).toBeDefined();
  return r.cola!;
}
function servidor(base: InstantaneaProgreso, revisionServidor: number, op: Operacion): InstantaneaProgreso {
  const r = aplicarOperacion(plan, base.estado, op);
  expect(['aplicada', 'sin-cambio', 'duplicada']).toContain(r.tipo);
  return { revisionServidor, estado: r.estado };
}
const remoto = () => servidor(vacia(), 1, parada('compañero', 'saltada'));
const inicio = (...ops: Operacion[]) => cola(iniciarCola(plan, vacia(), ops));
const enviada = (...ops: Operacion[]) => cola(marcarEnviada(plan, inicio(...ops), ops[0].id));
// Simulación del contrato del backend: no demuestra TLS, sesión ni persistencia SQL.
const rechazo = (op: Operacion = parada(), instantanea = remoto()): RechazoPersistido => ({
  viajeId: plan.id, protocolo: 1, operacionId: op.id, operacionOriginal: op,
  decisionPersistida: true, motivo: 'conflicto', instantanea,
});
const negativa = () => cola(recibirRechazo(plan, enviada(parada()), rechazo()));
const acuse = (operacionId: string, instantanea: InstantaneaProgreso) =>
  ({ operacionId, persistida: true, instantanea });

function ocultarYCongelar(v: unknown): void {
  if (v === null || typeof v !== 'object') return;
  for (const k of Object.getOwnPropertyNames(v)) {
    const d = Object.getOwnPropertyDescriptor(v, k)!;
    ocultarYCongelar(d.value);
    if (!Array.isArray(v)) Object.defineProperty(v, k, { ...d, enumerable: false });
  }
  Object.freeze(v);
}

describe('rechazo terminal persistido y revisión explícita', () => {
  test('conserva original enviado, deja de proyectarlo y exige revisión antes de resolver', () => {
    const c = enviada(parada());
    const dto = rechazo();
    const r = recibirRechazo(plan, c, dto);
    expect(r.tipo).toBe('rechazada');
    expect(r.cola!.entradas[0]).toEqual({ ...c.entradas[0], rechazo: dto });
    expect(r.proyeccion!.entradas).toEqual([{ operacionId: 'original', tipo: 'rechazada' }]);
    expect(r.proyeccion!.estado).toEqual(dto.instantanea.estado);
    expect(Object.hasOwn(r.proyeccion!.estado.operaciones, 'original')).toBe(false);
    expect(marcarEnviada(plan, r.cola, 'original').tipo).toBe('conflicto');
    expect(cancelarIntencion(plan, r.cola, 'original').tipo).toBe('conflicto');
    const resuelta = resolverRechazo(plan, r.cola, 'original');
    expect(resuelta.tipo).toBe('resuelta');
    expect(resuelta.cola!.entradas[0]).toEqual({ ...r.cola!.entradas[0], resolucion: 'conservar-confirmado' });
    expect(resuelta.proyeccion!.entradas).toEqual([{ operacionId: 'original', tipo: 'resuelta' }]);
    expect(resuelta.proyeccion!.estado).toEqual(dto.instantanea.estado);
    expect(resolverRechazo(plan, resuelta.cola, 'original').cola).toEqual(resuelta.cola);
    expect(cancelarIntencion(plan, resuelta.cola, 'original').tipo).toBe('conflicto');
    expect(marcarEnviada(plan, resuelta.cola, 'original').cola).toEqual(resuelta.cola);
    expect(c.entradas[0]).not.toHaveProperty('rechazo');
  });

  test('resolver no cumple dependencias: cancelar hoja y reformular requiere intención fresca', () => {
    const hijo = parada('hijo', null, 1);
    const c = enviada(parada(), hijo);
    const r = resolverRechazo(plan, cola(recibirRechazo(plan, c, rechazo())), 'original');
    expect(r.proyeccion!.entradas.map((e) => e.tipo)).toEqual(['resuelta', 'bloqueada']);
    expect(r.cola!.entradas[1]).toEqual(c.entradas[1]);
    const limpia = cola(cancelarIntencion(plan, r.cola, 'hijo'));
    const nueva = agregarIntencion(plan, limpia, parada('nueva', null, 1));
    expect(nueva.cola!.entradas[1].dependeDe).toEqual([]);
    expect(nueva.proyeccion!.entradas.map((e) => e.tipo)).toEqual(['resuelta', 'lista']);
    expect(nueva.proyeccion!.estado.paradas.a).toEqual({ marca: null, revision: 2 });
    expect(agregarIntencion(plan, limpia, parada()).tipo).toBe('conflicto');
  });

  test('decisión tardía conserva la base nueva y revisión igual contradictoria bloquea', () => {
    const actual = servidor(remoto(), 5, { ...parada('otra'), paradaId: 'b' });
    const c = cola(recibirInstantanea(plan, enviada(parada()), actual));
    const r = recibirRechazo(plan, c, rechazo());
    expect(r.tipo).toBe('rechazada');
    expect(r.cola!.confirmado).toEqual(actual);
    const mismaRevision = { ...remoto(), revisionServidor: 5 };
    const contradictoria = recibirRechazo(plan, c, rechazo(parada(), mismaRevision));
    expect(contradictoria.tipo).toBe('conflicto');
    expect(contradictoria.cola).toEqual(c);
  });

  test('replay estable es idempotente incluso resuelto; no sustituye motivo ni testigo histórico', () => {
    const c = cola(resolverRechazo(plan, negativa(), 'original'));
    expect(recibirRechazo(plan, c, rechazo()).tipo).toBe('ignorada');
    expect(recibirRechazo(plan, c, rechazo()).cola).toEqual(c);
    for (const dto of [
      { ...rechazo(), motivo: 'invalida' },
      rechazo(parada(), { ...remoto(), revisionServidor: 2 }),
      rechazo(parada(), servidor(remoto(), 2, { ...parada('otra'), paradaId: 'b' })),
      rechazo(parada('original', 'saltada')),
    ]) {
      const r = recibirRechazo(plan, c, dto);
      expect(r.tipo).toBe('conflicto');
      expect(r.cola).toEqual(c);
    }
  });

  test('valor futuro coincidente jamás revive el original ni fabrica un recibo sin-cambio', () => {
    const c = negativa();
    const coincide = servidor(remoto(), 2, parada('otra', 'hecha', 1));
    expect(aplicarOperacion(plan, coincide.estado, parada()).tipo).toBe('sin-cambio');
    const r = recibirInstantanea(plan, c, coincide);
    expect(r.tipo).toBe('actualizada');
    expect(r.proyeccion!.entradas[0].tipo).toBe('rechazada');
    expect(Object.hasOwn(r.proyeccion!.estado.operaciones, 'original')).toBe(false);
    expect(resolverRechazo(plan, r.cola, 'original').proyeccion!.estado).toEqual(coincide.estado);
  });

  test.each([false, true])('negativo conocido bloquea lectura y acuse positivos incluso resuelto=%s', (resuelto) => {
    const c = resuelto ? cola(resolverRechazo(plan, negativa(), 'original')) : negativa();
    const positiva = servidor(vacia(), 10, parada());
    for (const r of [recibirInstantanea(plan, c, positiva), recibirAcuse(plan, c, acuse('original', positiva)),
      recibirAcuse(plan, c, acuse('ajena', positiva))]) {
      expect(r.tipo).toBe('conflicto');
      expect(r.cola).toEqual(c);
    }
    const antigua = { ...positiva, revisionServidor: 0 };
    expect(recibirInstantanea(plan, c, antigua).tipo).toBe('conflicto');
  });

  test('positivos ajenos conservan metadatos negativos y acuse tardío no rebobina', () => {
    const op = { ...parada('independiente'), paradaId: 'b' };
    const c = cola(agregarIntencion(plan, negativa(), op));
    const aplicada = servidor(remoto(), 2, op);
    const nueva = servidor(aplicada, 9, parada('posterior', 'hecha', 1));
    const leida = cola(recibirInstantanea(plan, c, nueva));
    const r = recibirAcuse(plan, leida, acuse(op.id, aplicada));
    expect(r.tipo).toBe('confirmada');
    expect(r.cola!.confirmado).toEqual(nueva);
    expect(r.cola!.entradas).toEqual([c.entradas[0]]);
  });

  test('rechaza contradicción con recibo positivo conocido, incluido ID opaco sin cambios', () => {
    const positiva = servidor(vacia(), 8, parada());
    const c = cola(recibirInstantanea(plan, enviada(parada()), positiva));
    expect(recibirRechazo(plan, c, rechazo()).tipo).toBe('conflicto');
    expect(recibirRechazo(plan, c, rechazo()).cola).toEqual(c);
    const historica = { ...positiva, estado: { ...positiva.estado, operaciones: { original: { firma: 'opaca' } } } };
    const conHistoria = cola(recibirInstantanea(plan, enviada(parada()), historica));
    expect(recibirRechazo(plan, conHistoria, rechazo()).tipo).toBe('conflicto');
    expect(recibirRechazo(plan, enviada(parada()), rechazo(parada(), positiva)).tipo).toBe('invalida');
  });

  test('requiere original enviado y correspondencia exacta; ausencia no actúa como lectura', () => {
    expect(recibirRechazo(plan, inicio(parada()), rechazo()).tipo).toBe('conflicto');
    expect(recibirRechazo(plan, enviada(parada()), rechazo(parada('original', 'saltada'))).tipo).toBe('conflicto');
    const c = inicio();
    expect(recibirRechazo(plan, c, rechazo()).tipo).toBe('ignorada');
    expect(recibirRechazo(plan, c, rechazo()).cola).toEqual(c);
    expect(resolverRechazo(plan, c, 'ausente').tipo).toBe('ausente');
    expect(resolverRechazo(plan, enviada(parada()), 'original').tipo).toBe('conflicto');
    expect(proyectarCola(plan, inicio(parada())).cola!.entradas[0]).toEqual({
      operacion: parada(), dependeDe: [], enviada: false,
    });
  });

  test.each([
    null, 409, 'conflicto', true, new String('conflicto'), [], new Map(),
    { ...rechazo(), viajeId: 'otro' }, { ...rechazo(), protocolo: 2 },
    { ...rechazo(), protocolo: new Number(1) }, { ...rechazo(), operacionId: 'otro' },
    { ...rechazo(), decisionPersistida: false }, { ...rechazo(), decisionPersistida: new Boolean(true) },
    { ...rechazo(), motivo: 'timeout' }, { ...rechazo(), motivo: new String('conflicto') },
    { ...rechazo(), extra: undefined }, { ...rechazo(), [Symbol('extra')]: true },
    { ...rechazo(), operacionOriginal: { ...parada(), horaReal: undefined } },
    { ...rechazo(), operacionOriginal: { ...parada(), revision: '0' } },
    { ...rechazo(), instantanea: { ...remoto(), extra: undefined } },
    { operacionId: 'original', persistida: true, instantanea: remoto() },
    { status: 409, instantanea: remoto() }, { ...rechazo(), instantanea: vacia().estado },
  ])('no acepta evidencia malformada o inferida %s', (dto) => {
    const c = enviada(parada());
    const r = recibirRechazo(plan, c, dto);
    expect(r.tipo).toBe('invalida');
    expect(r.cola).toEqual(c);
  });

  test('no evalúa accessors ni acepta arrays dispersos del dominio', () => {
    const getter = () => { throw new Error('No debe ejecutarse'); };
    const dto = Object.defineProperty({ ...rechazo() }, 'motivo', { get: getter });
    expect(recibirRechazo(plan, enviada(parada()), dto).tipo).toBe('invalida');
    const op = Object.defineProperty({ ...parada() }, 'revision', { get: getter });
    expect(recibirRechazo(plan, enviada(parada()), { ...rechazo(), operacionOriginal: op }).tipo).toBe('invalida');
    const c = Object.defineProperty({ ...negativa() }, 'entradas', { get: getter });
    expect(proyectarCola(plan, c).tipo).toBe('invalida');
    const undo = { id: 'undo', dispositivoId: 'fold', tipo: 'deshacer',
      cambios: { operacionId: 'desconocida', registros: new Array(1) } };
    expect(recibirRechazo(plan, enviada(parada()), { ...rechazo(), operacionOriginal: undo }).tipo).toBe('invalida');
  });

  test('guards de cola rechazan metadatos sueltos, incompatibles o indefinidos', () => {
    const c = negativa();
    const e = c.entradas[0];
    for (const entrada of [
      { ...e, enviada: false }, { ...e, rechazo: undefined }, { ...e, resolucion: undefined },
      { ...e, resolucion: 'automatica' }, { ...e, rechazo: rechazo(parada('otra')) },
      { ...e, rechazo: { ...rechazo(), protocolo: 2 } },
      { ...inicio(parada()).entradas[0], resolucion: 'conservar-confirmado' },
      { ...e, [Symbol('extra')]: true }, { ...e, dependeDe: new Array(1) },
    ]) expect(proyectarCola(plan, { ...c, entradas: [entrada] }).tipo).toBe('invalida');
    const positiva = servidor(vacia(), 2, parada());
    expect(proyectarCola(plan, { ...c, confirmado: positiva }).tipo).toBe('invalida');
  });

  test('captura campos propios ocultos y congelados sin compartir ni mutar inputs', () => {
    const c = enviada(parada());
    const dto = rechazo();
    const copia = structuredClone(dto);
    ocultarYCongelar(c);
    ocultarYCongelar(dto);
    const r = recibirRechazo(plan, c, dto);
    expect(r.tipo).toBe('rechazada');
    expect(r.cola!.entradas[0].rechazo).toEqual(copia);
    expect(r.cola!.entradas[0].rechazo).not.toBe(dto);
    expect(r.cola!.entradas[0].operacion).not.toBe(c.entradas[0].operacion);
    ocultarYCongelar(r.cola);
    expect(recibirRechazo(plan, r.cola, dto).tipo).toBe('ignorada');
    const resuelta = resolverRechazo(plan, r.cola, 'original');
    expect(resuelta.tipo).toBe('resuelta');
    expect(resuelta.cola!.entradas[0].rechazo).not.toBe(r.cola!.entradas[0].rechazo);
    expect(r.cola!.entradas[0]).not.toHaveProperty('resolucion');
  });

  test('el guard no reejecuta ni demuestra el motivo; la decisión explícita congela efectos futuros', () => {
    const c = enviada(parada());
    const dto = { ...rechazo(parada(), vacia()), motivo: 'invalida' as const };
    expect(aplicarOperacion(plan, vacia().estado, parada()).tipo).toBe('aplicada');
    const r = recibirRechazo(plan, c, dto);
    expect(r.tipo).toBe('rechazada');
    expect(r.proyeccion!.estado).toEqual(vacia().estado);
    expect(r.cola!.confirmado).toEqual(vacia());
    expect(r.cola!.entradas[0].rechazo!.motivo).toBe('invalida');
  });

  test('otro rechazo no incorpora recibos positivos de negativos previos', () => {
    const otra = { ...parada('segunda'), paradaId: 'b' };
    const c = cola(marcarEnviada(plan, cola(agregarIntencion(plan, negativa(), otra)), otra.id));
    const imposible = servidor(vacia(), 10, parada());
    const r = recibirRechazo(plan, c, rechazo(otra, imposible));
    expect(r.tipo).toBe('conflicto');
    expect(r.cola).toEqual(c);
  });

  test('replay no cambia su testigo aunque solo difiera un recibo ajeno', () => {
    const c = negativa();
    const s = remoto();
    const conRecibo = { ...s, estado: { ...s.estado,
      operaciones: { ...s.estado.operaciones, testigo: { firma: 'opaca' } } } };
    expect(recibirRechazo(plan, c, rechazo(parada(), conRecibo)).tipo).toBe('conflicto');
    expect(recibirRechazo(plan, c, rechazo(parada(), conRecibo)).cola).toEqual(c);
    const dto = rechazo();
    expect(recibirRechazo(plan, c, { ...dto, instantanea: {
      ...dto.instantanea, estado: { ...dto.instantanea.estado, [Symbol('oculto')]: true },
    } }).tipo).toBe('invalida');
  });

  test('rechazo explícito invalida de deshacer no requiere inferirlo mediante GET', () => {
    const aplicada = aplicarOperacion(plan, crearProgreso(plan), parada());
    if (aplicada.tipo !== 'aplicada') throw new Error('Falta recibo de prueba');
    const undo = prepararDeshacer(aplicada.cambios, 'undo', 'fold');
    const c = enviada(undo);
    expect(recibirInstantanea(plan, c, remoto()).proyeccion!.entradas[0].tipo).toBe('invalida');
    expect(recibirRechazo(plan, c, remoto()).tipo).toBe('invalida');
    const r = recibirRechazo(plan, c, { ...rechazo(undo), motivo: 'invalida' });
    expect(r.tipo).toBe('rechazada');
    expect(r.proyeccion!.entradas[0].tipo).toBe('rechazada');
  });
});
