import { describe, expect, test } from 'vitest';
import { aplicarOperacion, crearProgreso, prepararDeshacer, type Operacion } from '../src/progreso';
import type { InstantaneaProgreso } from '../src/progreso-validacion';
import type { Itinerario } from '../src/tipos';
import {
  iniciarCola, agregarIntencion, proyectarCola, recibirInstantanea, marcarEnviada, cancelarIntencion,
  recibirAcuse, type Cola, type ResultadoCola,
} from '../src/progreso-cola';

const plan: Itinerario = {
  id: 'viaje', titulo: 'Prueba', dias: [{ fecha: '2026-10-21', titulo: 'Día', paradas:
    ['a', 'b', '__proto__'].map((id) => ({ id, nombre: id, hora: '10:00', categoria: 'museo', lat: 31, lng: 121 })) }],
  pendientes: [{ id: 'entrada', texto: 'Entrada' }, { id: 'tren', texto: 'Tren' }],
};
const vacia = (): InstantaneaProgreso => ({ revisionServidor: 0, estado: crearProgreso(plan) });
const parada = (id: string, paradaId = 'a', marca: 'hecha' | 'saltada' | 'aqui' | null = 'hecha', revision = 0,
  extra = {}): Operacion => ({ id, dispositivoId: 'fold', tipo: 'parada', paradaId, marca, revision, ...extra });
const casilla = (id: string, hecho = true, revision = 0, pendienteId = 'entrada'): Operacion =>
  ({ id, dispositivoId: 'iphone', tipo: 'pendiente', pendienteId, hecho, revision });
function cola(r: ResultadoCola): Cola {
  expect(r.cola).toBeDefined();
  return r.cola!;
}
const inicio = (...ops: Operacion[]) => cola(iniciarCola(plan, vacia(), ops));
const agregar = (c: Cola, op: Operacion) => cola(agregarIntencion(plan, c, op));
function servidor(base: InstantaneaProgreso, revisionServidor: number, ...ops: Operacion[]): InstantaneaProgreso {
  let estado = base.estado;
  for (const op of ops) {
    const r = aplicarOperacion(plan, estado, op);
    expect(['aplicada', 'sin-cambio', 'duplicada']).toContain(r.tipo);
    estado = r.estado;
  }
  return { revisionServidor, estado };
}
const acuse = (operacionId: string, instantanea: unknown) => ({ operacionId, persistida: true, instantanea });

describe('cola pura de intenciones', () => {
  test('reproyecta intenciones independientes y captura dependencias mínimas', () => {
    const c = inicio(parada('a1'), casilla('p1'), parada('a2', 'a', null, 1));
    expect(c.entradas.map((e) => e.dependeDe)).toEqual([[], [], ['a1']]);
    const p = proyectarCola(plan, c);
    expect(p.tipo).toBe('proyectada');
    expect(p.proyeccion!.estado.paradas.a).toEqual({ marca: null, revision: 2 });
    expect(p.proyeccion!.estado.pendientes.entrada.hecho).toBe(true);
    expect(p.proyeccion!.entradas.map((e) => e.tipo)).toEqual(['lista', 'lista', 'lista']);
  });

  test('el acuse persistido elimina únicamente su ID, no una simple lectura', () => {
    const op = parada('a1');
    const c = inicio(op, casilla('p1'));
    const remoto = servidor(vacia(), 1, op);
    const leida = cola(recibirInstantanea(plan, c, remoto));
    expect(leida.entradas.map((e) => e.operacion.id)).toEqual(['a1', 'p1']);
    expect(proyectarCola(plan, leida).proyeccion!.entradas[0].resultado).toBe('duplicada');
    const confirmada = cola(recibirAcuse(plan, leida, acuse('a1', remoto)));
    expect(confirmada.entradas.map((e) => e.operacion.id)).toEqual(['p1']);
  });

  test('aquí lee ubicación global y parada predecesora; casillas siguen independientes', () => {
    const c = inicio(parada('a1', 'a', 'aqui', 0, { revisionAqui: 0 }), casilla('p1'),
      parada('a2', 'a', 'aqui', 1, { revisionAqui: 1, horaReal: 10 }),
      parada('b1', 'b', 'aqui', 0, { revisionAqui: 2, revisionAnterior: 2 }));
    expect(c.entradas.map((e) => e.dependeDe)).toEqual([[], [], ['a1'], ['a2']]);
    expect(proyectarCola(plan, c).proyeccion!.estado.aqui.paradaId).toBe('b');
    expect(cancelarIntencion(plan, c, 'a2').tipo).toBe('conflicto');
    expect(cancelarIntencion(plan, c, 'p1').tipo).toBe('cancelada');
  });

  test('una lectura condicional global aquí depende aunque no cambie esa ubicación', () => {
    const c = inicio(parada('a1', 'a', 'aqui', 0, { revisionAqui: 0 }),
      parada('b1', 'b', 'hecha', 0, { revisionAqui: 1 }));
    expect(c.entradas[1].dependeDe).toEqual(['a1']);
  });

  test('el inverso lee recibo y revisiones estrictas; no restaura la instantánea completa', () => {
    const c = inicio(parada('a1'), casilla('p1'));
    const estado = proyectarCola(plan, c).proyeccion!.estado;
    const op = prepararDeshacer(estado.operaciones.a1.cambios!, 'undo', 'fold');
    const inversa = agregar(c, op);
    expect(inversa.entradas[2].dependeDe).toEqual(['a1']);
    expect(proyectarCola(plan, inversa).proyeccion!.estado.pendientes.entrada.hecho).toBe(true);
    const remoto = servidor(vacia(), 2, parada('a1'), parada('remota', 'a', 'saltada', 1));
    const leida = recibirInstantanea(plan, inversa, remoto);
    expect(leida.proyeccion!.entradas.map((e) => e.tipo)).toEqual(['lista', 'lista', 'conflicto']);
    expect(leida.proyeccion!.estado.paradas.a.marca).toBe('saltada');
  });

  test('inverso de operación confirmada también respeta conflictos posteriores', () => {
    const base = servidor(vacia(), 1, parada('a1'));
    const op = prepararDeshacer(base.estado.operaciones.a1.cambios!, 'undo', 'fold');
    const c = cola(iniciarCola(plan, base, [op]));
    expect(c.entradas[0].dependeDe).toEqual([]);
    const remoto = servidor(base, 2, parada('remota', 'a', 'saltada', 1));
    expect(recibirInstantanea(plan, c, remoto).proyeccion!.entradas[0].tipo).toBe('conflicto');
  });

  test('conflicto remoto bloquea dependientes, no intenciones independientes ni payloads', () => {
    const c = inicio(parada('a1'), parada('a2', 'a', null, 1), casilla('p1'));
    const remoto = servidor(vacia(), 7, parada('externa', 'a', 'saltada', 0, { horaReal: 1 }));
    const r = recibirInstantanea(plan, c, remoto);
    expect(r.proyeccion!.entradas.map((e) => e.tipo)).toEqual(['conflicto', 'bloqueada', 'lista']);
    expect(r.proyeccion!.estado.pendientes.entrada.hecho).toBe(true);
    expect(r.cola!.entradas).toEqual(c.entradas);
    expect(r.cola!.entradas).not.toBe(c.entradas);
    expect(r.proyeccion!.estado.paradas.a.horaReal).toBe(1);
  });

  test('false y reset son intenciones conservadas, no ausencia ni comparación de horas', () => {
    const c = inicio(casilla('p1'), casilla('p2', false, 1), parada('a1', 'a', 'hecha', 0, { horaReal: 1500 }),
      parada('a2', 'a', null, 1));
    const r = recibirInstantanea(plan, c, servidor(vacia(), 5, casilla('externa', true, 0, 'tren')));
    expect(r.cola!.entradas).toEqual(c.entradas);
    expect(r.proyeccion!.estado.pendientes.entrada).toEqual({ hecho: false, revision: 2 });
    expect(r.proyeccion!.estado.paradas.a).toEqual({ marca: null, revision: 2 });
  });

  test('snapshot anterior no rebobina y revisión igual contradictoria es explícita', () => {
    const base = servidor(vacia(), 8, parada('remota'));
    const c = cola(iniciarCola(plan, base, [casilla('p1')]));
    expect(recibirInstantanea(plan, c, vacia()).tipo).toBe('ignorada');
    expect(recibirInstantanea(plan, c, vacia()).cola!.confirmado).toEqual(base);
    expect(recibirInstantanea(plan, c, { ...vacia(), revisionServidor: 8 }).tipo).toBe('conflicto');
    expect(recibirInstantanea(plan, c, base).tipo).toBe('ignorada');
  });

  test.each([
    ['sin bandera', { operacionId: 'a1', instantanea: servidor(vacia(), 1, parada('a1')) }],
    ['false', { ...acuse('a1', servidor(vacia(), 1, parada('a1'))), persistida: false }],
    ['sin recibo', acuse('a1', vacia())],
    ['otro ID de recibo', acuse('a1', servidor(vacia(), 1, parada('otro')))],
    ['otro payload', acuse('a1', servidor(vacia(), 1, parada('a1', 'a', 'saltada')))],
    ['otro dispositivo', acuse('a1', servidor(vacia(), 1, { ...parada('a1'), dispositivoId: 'ajeno' }))],
    ['otro viaje', acuse('a1', { ...vacia(), estado: { ...crearProgreso(plan), viajeId: 'otro' } })],
    ['recibo malformado', acuse('a1', { revisionServidor: 1, estado: { ...crearProgreso(plan),
      operaciones: { a1: { firma: 'opaca', cambios: { operacionId: 'a1', registros: [{ tipo: 'parada' }] } } } } })],
    ['campos extra', { ...acuse('a1', vacia()), status: 200 }],
  ])('rechaza acuse %s sin limpiar ninguna intención', (_nombre, a) => {
    const c = inicio(parada('a1'), casilla('p1'));
    const r = recibirAcuse(plan, c, a);
    expect(r.tipo).toBe('invalida');
    expect(r.cola).toEqual(c);
  });

  test('acuse tardío prueba persistencia sin rebobinar; segundo acuse no actualiza ni borra otros', () => {
    const op = parada('a1');
    const antigua = servidor(vacia(), 1, op);
    const nueva = servidor(antigua, 9, casilla('remota', true, 0, 'tren'));
    const c = cola(recibirInstantanea(plan, inicio(op, casilla('p1')), nueva));
    const r = recibirAcuse(plan, c, acuse('a1', antigua));
    expect(r.tipo).toBe('confirmada');
    expect(r.cola!.confirmado).toEqual(nueva);
    expect(r.cola!.entradas.map((e) => e.operacion.id)).toEqual(['p1']);
    const repetida = recibirAcuse(plan, r.cola!, acuse('a1', { ...nueva, revisionServidor: 99 }));
    expect(repetida.tipo).toBe('ignorada');
    expect(repetida.cola).toEqual(r.cola);
    expect(recibirAcuse(plan, c, acuse('desconocida', nueva)).cola).toEqual(c);
  });

  test('acuse igual contradictorio no elimina; ID ajeno no sirve como lectura', () => {
    const op = parada('a1');
    const base = servidor(vacia(), 4, op);
    const c = cola(recibirInstantanea(plan, inicio(op), base));
    const contradictoria = servidor(base, 4, casilla('remota'));
    expect(recibirAcuse(plan, c, acuse('a1', contradictoria)).tipo).toBe('conflicto');
    expect(recibirAcuse(plan, c, acuse('otro', contradictoria)).tipo).toBe('ignorada');
  });

  test('acuse normaliza solo dependencias cumplidas y conserva inversos pendientes', () => {
    const op = parada('a1');
    const c = inicio(op, parada('a2', 'a', null, 1), casilla('p1'));
    const r = recibirAcuse(plan, c, acuse('a1', servidor(vacia(), 1, op)));
    expect(r.cola!.entradas.map((e) => [e.operacion.id, e.dependeDe])).toEqual([['a2', []], ['p1', []]]);
    expect(r.proyeccion!.entradas.map((e) => e.tipo)).toEqual(['lista', 'lista']);
  });

  test('respuesta perdida/recarga/401 no desmarcan enviada; retry preserva mismo ID y contenido', () => {
    const c = inicio(parada('a1'), casilla('p1'));
    const enviada = cola(marcarEnviada(plan, c, 'a1'));
    const recargada = cola(proyectarCola(plan, enviada));
    const retry = cola(marcarEnviada(plan, recargada, 'a1'));
    expect(retry).toEqual(enviada);
    expect(retry.entradas[0].operacion).toEqual(c.entradas[0].operacion);
    expect(cancelarIntencion(plan, retry, 'a1').tipo).toBe('conflicto');
    expect(c.entradas[0].enviada).toBe(false);
    expect(agregarIntencion(plan, retry, parada('a1')).tipo).toBe('conflicto');
    expect(marcarEnviada(plan, retry, 'ausente').tipo).toBe('ausente');
  });

  test('cancelar independiente conserva IDs ajenos y cancelar con dependientes no los descarta', () => {
    const c = inicio(parada('a1'), casilla('p1'), parada('a2', 'a', null, 1));
    expect(cancelarIntencion(plan, c, 'a1').cola).toEqual(c);
    const r = cancelarIntencion(plan, c, 'p1');
    expect(r.tipo).toBe('cancelada');
    expect(r.cola!.entradas.map((e) => e.operacion.id)).toEqual(['a1', 'a2']);
    expect(r.proyeccion!.estado.paradas.a.marca).toBe(null);
    expect(cancelarIntencion(plan, c, 'ausente').tipo).toBe('ausente');
  });

  test('ledger confirmado prohíbe cancelar incluso si enviada sigue false', () => {
    const op = parada('a1');
    const c = cola(recibirInstantanea(plan, inicio(op), servidor(vacia(), 1, op)));
    expect(c.entradas[0].enviada).toBe(false);
    expect(cancelarIntencion(plan, c, 'a1').tipo).toBe('conflicto');
  });

  test('retiene operación inválida de dominio y la muestra sin afectar independientes', () => {
    const c = inicio(parada('desconocida', 'no-existe'), casilla('p1'));
    expect(proyectarCola(plan, c).proyeccion!.entradas.map((e) => e.tipo)).toEqual(['invalida', 'lista']);
    expect(c.entradas).toHaveLength(2);
    expect(agregarIntencion(plan, c, { ...casilla('bad'), revision: NaN }).tipo).toBe('invalida');
  });

  test.each([null, [], new Map(), { revisionServidor: Number.MAX_SAFE_INTEGER + 1, estado: crearProgreso(plan) },
    { revisionServidor: -1, estado: crearProgreso(plan) }, { ...vacia(), extra: true }])('rechaza snapshot inválido %s', (s) => {
    expect(iniciarCola(plan, s).tipo).toBe('invalida');
    expect(recibirInstantanea(plan, inicio(), s).tipo).toBe('invalida');
  });

  test('rechaza cola desconocida, dependencias futuras, ciclos, IDs duplicados y marker mal tipado', () => {
    const c = inicio(parada('a1'));
    for (const mala of [new Map(), { ...c, formato: 2 }, { ...c, entradas: [c.entradas[0], c.entradas[0]] },
      { ...c, entradas: [{ ...c.entradas[0], dependeDe: ['a1'] }] },
      { ...c, entradas: [{ ...c.entradas[0], enviada: undefined }] },
      { ...c, entradas: [{ ...c.entradas[0], dependeDe: ['desconocida'] }] }]) {
      expect(proyectarCola(plan, mala).tipo).toBe('invalida');
      expect(marcarEnviada(plan, mala, 'a1').tipo).toBe('invalida');
      expect(cancelarIntencion(plan, mala, 'a1').tipo).toBe('invalida');
      expect(recibirAcuse(plan, mala, acuse('a1', vacia())).tipo).toBe('invalida');
    }
  });

  test('captura TODOS los campos propios no enumerables y admite entradas congeladas', () => {
    const base = servidor(vacia(), 1, parada('__proto__', '__proto__', 'aqui', 0, { revisionAqui: 0, horaReal: 10 }));
    function ocultarYCongelar(v: unknown): void {
      if (v === null || typeof v !== 'object') return;
      for (const k of Object.getOwnPropertyNames(v)) {
        const d = Object.getOwnPropertyDescriptor(v, k)!;
        ocultarYCongelar(d.value);
        if (!Array.isArray(v)) Object.defineProperty(v, k, { ...d, enumerable: false });
      }
      Object.freeze(v);
    }
    ocultarYCongelar(base);
    const op = casilla('constructor');
    ocultarYCongelar(op);
    const c = cola(iniciarCola(plan, base, Object.freeze([op])));
    expect(c.confirmado.estado.paradas.__proto__.horaReal).toBe(10);
    expect(Object.hasOwn(c.confirmado.estado.operaciones, '__proto__')).toBe(true);
    expect(c.entradas[0].operacion).toEqual(casilla('constructor'));
    expect(proyectarCola(plan, c).proyeccion!.estado.aqui.paradaId).toBe('__proto__');
    expect(recibirInstantanea(plan, c, base).tipo).toBe('ignorada');
    expect(c.confirmado.estado).not.toBe(base.estado);
    const enviada = cola(marcarEnviada(plan, Object.freeze(c), 'constructor'));
    expect(enviada.entradas[0].operacion).not.toBe(c.entradas[0].operacion);
  });

  test('captura recibos no enumerables antes de invocar el núcleo para probar un acuse', () => {
    const op = parada('a1');
    const s = servidor(vacia(), 1, op);
    const recibo = s.estado.operaciones.a1;
    Object.defineProperty(s.estado.operaciones, 'a1', { value: recibo, enumerable: false });
    Object.freeze(s.estado.operaciones);
    expect(recibirAcuse(plan, inicio(op), acuse('a1', s)).tipo).toBe('confirmada');
  });

  test('hidrata IDs ya presentes en el ledger sin eliminarlos ni inventar acuses', () => {
    const op = parada('a1');
    const base = servidor(vacia(), 1, op);
    const r = iniciarCola(plan, base, [op, casilla('p1')]);
    expect(r.tipo).toBe('iniciada');
    expect(r.cola!.entradas.map((e) => e.operacion.id)).toEqual(['a1', 'p1']);
    expect(r.proyeccion!.entradas[0].resultado).toBe('duplicada');
    expect(cancelarIntencion(plan, r.cola!, 'a1').tipo).toBe('conflicto');
  });

  test('sin cambio también requiere persistir su recibo para eliminar la intención', () => {
    const base = servidor(vacia(), 1, casilla('primera'));
    const op = casilla('noop', true, 1);
    const c = cola(iniciarCola(plan, base, [op]));
    expect(proyectarCola(plan, c).proyeccion!.entradas[0].resultado).toBe('sin-cambio');
    expect(recibirAcuse(plan, c, acuse('noop', base)).tipo).toBe('invalida');
    const persistida = servidor(base, 2, op);
    expect(recibirAcuse(plan, c, acuse('noop', persistida)).cola!.entradas).toEqual([]);
  });

  test('IDs de prototipo son intenciones propias, nunca recibos heredados', () => {
    const op = parada('__proto__', '__proto__');
    const c = inicio(op, casilla('toString'));
    expect(c.entradas.map((e) => e.operacion.id)).toEqual(['__proto__', 'toString']);
    const r = recibirAcuse(plan, c, acuse('__proto__', servidor(vacia(), 1, op)));
    expect(r.tipo).toBe('confirmada');
    expect(r.cola!.entradas.map((e) => e.operacion.id)).toEqual(['toString']);
    expect(Object.hasOwn(r.proyeccion!.estado.pendientes, 'entrada')).toBe(true);
  });

  test('el inverso dependiente conserva su recibo después del acuse de la operación original', () => {
    const op = parada('a1');
    const c = inicio(op);
    const recibo = proyectarCola(plan, c).proyeccion!.estado.operaciones.a1.cambios!;
    const inversa = agregar(c, prepararDeshacer(recibo, 'undo', 'fold'));
    const r = recibirAcuse(plan, inversa, acuse('a1', servidor(vacia(), 1, op)));
    expect(r.cola!.entradas[0].dependeDe).toEqual([]);
    expect(r.cola!.entradas[0].operacion.id).toBe('undo');
    expect(r.proyeccion!.estado.paradas.a).toEqual({ marca: null, revision: 2 });
  });

  test('outputs de lectura y proyección no comparten objetos de dominio con el input', () => {
    const c = inicio(parada('a1'));
    const r = proyectarCola(plan, c);
    expect(r.cola!.confirmado.estado.aqui).not.toBe(c.confirmado.estado.aqui);
    expect(r.cola!.entradas[0].dependeDe).not.toBe(c.entradas[0].dependeDe);
    expect(r.proyeccion!.estado.aqui).not.toBe(c.confirmado.estado.aqui);
    expect(iniciarCola(plan, vacia(), [parada('a1'), parada('a1')]).tipo).toBe('conflicto');
  });

  test('fábrica conserva IDs originales y refina cola conservadora sobre base vacía', () => {
    const ops = [parada('original-a'), casilla('original-p'), casilla('original-false', false, 1)];
    const c = inicio(...ops);
    expect(c.entradas.map((e) => e.operacion)).toEqual(ops);
    expect(c.entradas.map((e) => e.dependeDe)).toEqual([[], [], ['original-p']]);
    expect(proyectarCola(plan, c).proyeccion!.estado.pendientes.entrada.hecho).toBe(false);
  });
});
