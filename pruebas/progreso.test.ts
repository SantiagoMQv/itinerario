import { describe, expect, test } from 'vitest';
import type { Itinerario } from '../src/tipos';
import { itinerario } from '../src/datos/itinerario';
import {
  aplicarOperacion, cancelarPendiente, crearProgreso, importarLegado, prepararDeshacer,
  type EstadoProgreso, type Operacion, type ResultadoOperacion,
} from '../src/progreso';

// Dos visitas al hotel protegen la ambigüedad; el museo permite probar el cambio de hora.
const plan: Itinerario = {
  id: 'viaje-prueba', titulo: 'Viaje de prueba', dias: [{ fecha: '2026-10-21', titulo: 'Día', paradas: [
    { id: 'museo', nombre: 'Museo', hora: '10:00', categoria: 'museo', lat: 31, lng: 121 },
    { id: 'hotel-mañana', nombre: 'Hotel', hora: '12:00', categoria: 'hotel', lat: 31, lng: 121 },
    { id: 'hotel-noche', nombre: 'Hotel', hora: '22:00', categoria: 'hotel', lat: 31, lng: 121 },
  ] }], pendientes: [{ id: 'entrada', texto: 'Reservar entrada' }, { id: 'tren', texto: 'Comprar tren' }],
};
const museo = '2026-10-21|10:00|Museo';
const anterior = '2026-10-21|09:00|Museo';
const marcar = (id: string, paradaId = 'museo', marca: 'hecha' | 'saltada' | 'aqui' | null = 'hecha',
  revision = 0, horaReal?: number, revisionAqui?: number): Extract<Operacion, { tipo: 'parada' }> => ({
  id, dispositivoId: 'fold', tipo: 'parada', paradaId, marca, revision, horaReal, revisionAqui,
});
const casilla = (id: string, hecho: boolean, revision = 0, pendienteId = 'entrada'): Extract<Operacion, { tipo: 'pendiente' }> => ({
  id, dispositivoId: 'iphone', tipo: 'pendiente', pendienteId, hecho, revision,
});
function aceptar(resultado: ResultadoOperacion): EstadoProgreso {
  expect(resultado.tipo).toBe('aplicada');
  return resultado.estado;
}
const aplicar = (estado: EstadoProgreso, operacion: Operacion) => aplicarOperacion(plan, estado, operacion);

describe('progreso explícito y revisiones', () => {
  test('vacío no deduce marcas del reloj y valida IDs contra el plan', () => {
    const estado = crearProgreso(plan);
    expect(estado.paradas).toEqual({});
    expect(estado.pendientes).toEqual({});
    expect(estado.aqui).toEqual({ paradaId: null, revision: 0 });
    expect(aplicar(estado, marcar('1', 'inventada')).tipo).toBe('invalida');
    expect(aplicar(estado, casilla('2', true, 0, 'inventada')).tipo).toBe('invalida');
    expect(aplicarOperacion(itinerario, estado, marcar('3')).tipo).toBe('invalida');
    expect(() => crearProgreso({ ...plan, pendientes: [{ id: 'museo', texto: 'Duplicada' }] })).toThrow();
  });

  test('marca, hora, reset explícito y casilla false sin mutar entradas', () => {
    const vacio = crearProgreso(plan);
    const operacion = marcar('1', 'museo', 'hecha', 0, 1500);
    const marcado = aceptar(aplicar(vacio, operacion));
    expect(marcado.paradas.museo).toEqual({ marca: 'hecha', horaReal: 1500, revision: 1 });
    const borrado = aceptar(aplicar(marcado, marcar('2', 'museo', null, 1)));
    expect(borrado.paradas.museo).toEqual({ marca: null, revision: 2 });
    const hecha = aceptar(aplicar(borrado, casilla('3', true)));
    const desmarcada = aceptar(aplicar(hecha, casilla('4', false, 1)));
    expect(desmarcada.pendientes.entrada).toEqual({ hecho: false, revision: 2 });
    expect(vacio.paradas).toEqual({});
    expect(marcado.paradas.museo.horaReal).toBe(1500);
    expect(operacion.horaReal).toBe(1500);
    expect(aplicar(vacio, marcar('nan', 'museo', 'hecha', 0, NaN)).tipo).toBe('invalida');
    expect(aplicar(vacio, marcar('inf', 'museo', 'hecha', 0, Infinity)).tipo).toBe('invalida');
    expect(aplicar(vacio, marcar('reset-hora', 'museo', null, 0, 10)).tipo).toBe('invalida');
  });

  test('entidades independientes, conflictos visibles y no-op semántico con hora exacta', () => {
    let estado = aceptar(aplicar(crearProgreso(plan), marcar('1', 'museo', 'hecha', 0, 900)));
    estado = aceptar(aplicar(estado, casilla('2', true)));
    const conflicto = aplicar(estado, casilla('3', false));
    expect(conflicto.tipo).toBe('conflicto');
    expect(conflicto.estado).toBe(estado);
    expect(aplicar(estado, marcar('4', 'museo', 'hecha', 0, 899)).tipo).toBe('conflicto');
    expect(aplicar(estado, marcar('5', 'museo', 'hecha')).tipo).toBe('conflicto');
    const igual = aplicar(estado, marcar('6', 'museo', 'hecha', 0, 900));
    expect(igual.tipo).toBe('sin-cambio');
    expect(igual.estado.paradas.museo.revision).toBe(1);
    expect(aplicar(estado, casilla('7', true)).tipo).toBe('sin-cambio');
    const atras = aceptar(aplicar(estado, marcar('8', 'museo', 'saltada', 1, 100)));
    expect(atras.paradas.museo.horaReal).toBe(100); // La hora no arbitra la operación.
  });

  test('reintentos no repiten efectos y reutilizar ID con otro contenido es inválido', () => {
    const op = marcar('1');
    const estado = aceptar(aplicar(crearProgreso(plan), op));
    expect(aplicar(estado, op)).toMatchObject({ tipo: 'duplicada', estado });
    expect(aplicar(estado, { ...op, marca: 'saltada' }).tipo).toBe('invalida');
    expect(aplicar(estado, { ...op, dispositivoId: 'otro' }).tipo).toBe('invalida');
    const igual = aplicar(estado, marcar('2'));
    expect(aplicar(igual.estado, marcar('2')).tipo).toBe('duplicada');
  });
});

const MAX_REVISION = Number.MAX_SAFE_INTEGER;
function congelar<T>(valor: T): T {
  if (valor !== null && typeof valor === 'object') {
    for (const parte of Object.values(valor)) congelar(parte);
    Object.freeze(valor);
  }
  return valor;
}
function rechazarSinEfectos(estado: EstadoProgreso, op: Operacion) {
  const copia = structuredClone(estado);
  const resultado = aplicar(congelar(estado), congelar(op));
  expect(resultado.tipo).toBe('invalida');
  expect(resultado.estado).toBe(estado);
  expect(resultado.estado).toEqual(copia); // Incluye todos los registros, aquí y acuses/recibos.
  expect(Object.hasOwn(resultado.estado.operaciones, op.id)).toBe(false);
  if (resultado.tipo === 'invalida') expect(resultado.motivo).toMatch(/revisión.*agotada/i);
}

describe('límite seguro de revisiones', () => {
  test.each(['parada', 'casilla'] as const)('%s saturada rechaza una mutación y su deshacer sin consumir IDs', (tipo) => {
    const inicial: EstadoProgreso = { ...crearProgreso(plan),
      paradas: { museo: { marca: null, revision: MAX_REVISION - 1 } },
      pendientes: { entrada: { hecho: false, revision: MAX_REVISION - 1 } } };
    const op = tipo === 'parada' ? marcar('ultima', 'museo', 'hecha', MAX_REVISION - 1)
      : casilla('ultima', true, MAX_REVISION - 1);
    const resultado = aplicar(inicial, op);
    const estado = aceptar(resultado);
    if (resultado.tipo !== 'aplicada') throw new Error('Falta recibo');
    const revision = tipo === 'parada' ? estado.paradas.museo.revision : estado.pendientes.entrada.revision;
    expect(revision).toBe(MAX_REVISION);
    expect(aplicar(estado, op)).toMatchObject({ tipo: 'duplicada', estado });
    const igual = tipo === 'parada' ? marcar('igual', 'museo', 'hecha', MAX_REVISION)
      : casilla('igual', true, MAX_REVISION);
    const reconciliado = aplicar(estado, igual);
    expect(reconciliado.tipo).toBe('sin-cambio');
    expect(aplicar(reconciliado.estado, igual).tipo).toBe('duplicada');
    rechazarSinEfectos(estado, tipo === 'parada' ? marcar('rechazada', 'museo', null, MAX_REVISION)
      : casilla('rechazada', false, MAX_REVISION));
    rechazarSinEfectos(estado, prepararDeshacer(resultado.cambios, 'inversa', 'fold'));
  });

  test.each(['origen', 'global'] as const)('aquí con %s saturado rechaza toda la transición', (saturado) => {
    const estado: EstadoProgreso = { ...crearProgreso(plan),
      paradas: { museo: { marca: 'aqui', horaReal: 600, revision: saturado === 'origen' ? MAX_REVISION : 1 } },
      aqui: { paradaId: 'museo', revision: saturado === 'global' ? MAX_REVISION : 1 } };
    rechazarSinEfectos(estado, { ...marcar('transicion', 'hotel-mañana', 'aqui', 0, 700, estado.aqui.revision),
      revisionAnterior: estado.paradas.museo.revision });
    if (saturado === 'global') {
      rechazarSinEfectos(estado, marcar('reset', 'museo', null, 1, undefined, MAX_REVISION));
      rechazarSinEfectos(estado, marcar('hora', 'museo', 'aqui', 1, 601, MAX_REVISION));
    }
  });

  test.each(['destino', 'origen', 'global'] as const)('deshacer transición con %s saturado no revierte parcialmente', (saturado) => {
    const inicial: EstadoProgreso = { ...crearProgreso(plan), paradas: {
      museo: { marca: 'aqui', horaReal: 600, revision: saturado === 'origen' ? MAX_REVISION - 1 : 1 },
      'hotel-mañana': { marca: null, revision: saturado === 'destino' ? MAX_REVISION - 1 : 0 },
    }, aqui: { paradaId: 'museo', revision: saturado === 'global' ? MAX_REVISION - 1 : 1 } };
    const op = { ...marcar('transicion', 'hotel-mañana', 'aqui', inicial.paradas['hotel-mañana'].revision,
      700, inicial.aqui.revision), revisionAnterior: inicial.paradas.museo.revision };
    const resultado = aplicar(inicial, op);
    const estado = aceptar(resultado);
    if (resultado.tipo !== 'aplicada') throw new Error('Falta recibo');
    expect(aplicar(estado, op)).toMatchObject({ tipo: 'duplicada', estado });
    rechazarSinEfectos(estado, prepararDeshacer(resultado.cambios, 'inversa', 'fold'));
  });

  test('aquí y casilla false saturados admiten no-op y entidades independientes', () => {
    const estado: EstadoProgreso = { ...crearProgreso(plan),
      paradas: { museo: { marca: 'aqui', horaReal: 600, revision: MAX_REVISION } },
      pendientes: { entrada: { hecho: false, revision: MAX_REVISION } },
      aqui: { paradaId: 'museo', revision: MAX_REVISION } };
    const igual = marcar('igual', 'museo', 'aqui', MAX_REVISION, 600, MAX_REVISION);
    const resultado = aplicar(congelar(estado), igual);
    expect(resultado.tipo).toBe('sin-cambio');
    expect(resultado.estado.paradas).toEqual(estado.paradas);
    expect(resultado.estado.aqui).toEqual(estado.aqui);
    expect(aplicar(resultado.estado, igual).tipo).toBe('duplicada');
    expect(aplicar(estado, casilla('false', false, MAX_REVISION)).tipo).toBe('sin-cambio');
    expect(aceptar(aplicar(estado, casilla('otra', true, 0, 'tren'))).pendientes.tren.revision).toBe(1);
  });
});

describe('robustez de entradas puras', () => {
  test('entradas congeladas e IDs del prototipo funcionan sin mutación ni contaminación', () => {
    const especial = congelar<Itinerario>({ ...plan, dias: [{ ...plan.dias[0], paradas: [
      { ...plan.dias[0].paradas[0], id: '__proto__' },
    ] }], pendientes: [{ id: 'constructor', texto: 'Reservar entrada' }] });
    const vacio = congelar(crearProgreso(especial));
    const op = congelar(marcar('__proto__', '__proto__'));
    const resultado = aplicarOperacion(especial, vacio, op);
    const estado = aceptar(resultado);
    expect(Object.getPrototypeOf(estado.paradas)).toBe(Object.prototype);
    expect(Object.hasOwn(estado.paradas, '__proto__')).toBe(true);
    expect(estado.paradas['__proto__']).toEqual({ marca: 'hecha', revision: 1 });
    expect(aplicarOperacion(especial, congelar(estado), op).tipo).toBe('duplicada');
    const casillado = aceptar(aplicarOperacion(especial, estado, congelar(casilla('constructor', true, 0, 'constructor'))));
    expect(casillado.pendientes.constructor).toEqual({ hecho: true, revision: 1 });
    if (resultado.tipo !== 'aplicada') throw new Error('Falta recibo');
    const inversa = congelar(prepararDeshacer(congelar(resultado.cambios), 'toString', 'fold'));
    expect(aceptar(aplicarOperacion(especial, congelar(casillado), inversa)).paradas['__proto__'].marca).toBeNull();
    expect(vacio.paradas).toEqual({});
    expect(Object.hasOwn(Object.prototype, 'marca')).toBe(false);
  });

  test('fallback de nombre con barras conserva nombre completo, hora y originales congelados', () => {
    const conBarras = congelar<Itinerario>({ ...plan, dias: [{ ...plan.dias[0], paradas: [
      { ...plan.dias[0].paradas[0], nombre: 'Museo | ala norte' },
    ] }] });
    const clave = '2026-10-21|09:00|Museo | ala norte';
    const entradas = congelar({ marcas: { [clave]: 'hecha' }, 'marcas-hora': { [clave]: 580 } });
    const copia = structuredClone(entradas);
    const resultado = importarLegado(conBarras, congelar(crearProgreso(conBarras)), entradas);
    expect(resultado.estado.paradas.museo).toEqual({ marca: 'hecha', horaReal: 580, revision: 1 });
    expect(resultado.originales).toEqual(copia);
    expect(entradas).toEqual(copia);
    expect(resultado.recuperacion).toEqual([]);
  });
});

describe('aquí atómico y deshacer condicionado', () => {
  test('transición cierra la llegada anterior sin inventar su salida', () => {
    const inicial = aceptar(aplicar(crearProgreso(plan), marcar('1', 'museo', 'aqui', 0, 600, 0)));
    const op = { ...marcar('2', 'hotel-mañana', 'aqui', 0, 700, 1), revisionAnterior: 1 };
    const resultado = aplicar(inicial, op);
    const siguiente = aceptar(resultado);
    expect(siguiente.paradas.museo).toEqual({ marca: 'hecha', revision: 2 });
    expect(siguiente.paradas['hotel-mañana']).toEqual({ marca: 'aqui', horaReal: 700, revision: 1 });
    expect(siguiente.aqui).toEqual({ paradaId: 'hotel-mañana', revision: 2 });
    expect(inicial.paradas.museo.horaReal).toBe(600);
    expect(Object.values(siguiente.paradas).filter((p) => p.marca === 'aqui')).toHaveLength(1);
    if (resultado.tipo !== 'aplicada') throw new Error('Falta recibo');
    const inversa = prepararDeshacer(resultado.cambios, '3', 'fold');
    const restaurado = aceptar(aplicar(siguiente, inversa));
    expect(restaurado.paradas.museo).toEqual({ marca: 'aqui', horaReal: 600, revision: 3 });
    expect(restaurado.paradas['hotel-mañana']).toEqual({ marca: null, revision: 2 });
    expect(restaurado.aqui).toEqual({ paradaId: 'museo', revision: 3 });
  });

  test('revisa destino, origen y aquí global antes de tocar cualquier registro', () => {
    const inicial = aceptar(aplicar(crearProgreso(plan), marcar('1', 'museo', 'aqui', 0, 600, 0)));
    const op = { ...marcar('2', 'hotel-mañana', 'aqui', 0, 700, 1), revisionAnterior: 1 };
    for (const fallo of [{ revision: 3 }, { revisionAnterior: 0 }, { revisionAqui: 0 }, { revisionAqui: undefined }]) {
      const resultado = aplicar(inicial, { ...op, ...fallo });
      expect(resultado.tipo).toBe('conflicto');
      expect(resultado.estado).toBe(inicial);
    }
    expect(aplicar(inicial, marcar('reset-sin-global', 'museo', null, 1)).tipo).toBe('conflicto');
    expect(aplicar(inicial, marcar('hecha-sin-global', 'museo', 'hecha', 1)).tipo).toBe('conflicto');
    const reset = aceptar(aplicar(inicial, marcar('reset', 'museo', null, 1, undefined, 1)));
    expect(reset.aqui).toEqual({ paradaId: null, revision: 2 });
    const visita = aceptar(aplicar(reset, marcar('visita', 'hotel-mañana', 'aqui', 0, undefined, 2)));
    expect(aplicar(visita, marcar('antigua', 'museo', 'aqui', 2, undefined, 1)).tipo).toBe('conflicto');
  });

  test('deshacer conserva otras entidades y rechaza modificaciones posteriores incluso ABA', () => {
    const resultado = aplicar(crearProgreso(plan), marcar('1'));
    const inicial = aceptar(resultado);
    if (resultado.tipo !== 'aplicada') throw new Error('Falta recibo');
    const inversa = prepararDeshacer(resultado.cambios, 'deshacer', 'fold');
    const ajeno = aceptar(aplicar(inicial, casilla('2', true)));
    const restaurado = aceptar(aplicar(ajeno, inversa));
    expect(restaurado.paradas.museo.marca).toBeNull();
    expect(restaurado.pendientes).toEqual(ajeno.pendientes);
    expect(aplicar(restaurado, inversa).tipo).toBe('duplicada');
    let posterior = aceptar(aplicar(ajeno, marcar('3', 'museo', 'saltada', 1)));
    posterior = aceptar(aplicar(posterior, marcar('4', 'museo', 'hecha', 2)));
    expect(aplicar(posterior, inversa)).toMatchObject({ tipo: 'conflicto', estado: posterior });
  });

  test('deshacer aquí no revierte parcialmente tras otra transición', () => {
    const primero = aplicar(crearProgreso(plan), marcar('1', 'museo', 'aqui', 0, 600, 0));
    const estado = aceptar(primero);
    if (primero.tipo !== 'aplicada') throw new Error('Falta recibo');
    const posterior = aceptar(aplicar(estado, {
      ...marcar('2', 'hotel-mañana', 'aqui', 0, 700, 1), revisionAnterior: 1,
    }));
    expect(aplicar(posterior, prepararDeshacer(primero.cambios, 'undo', 'fold')))
      .toMatchObject({ tipo: 'conflicto', estado: posterior });
  });

  test('un inverso de casilla false restaura true sin afectar otras casillas', () => {
    const inicial = aceptar(aplicar(crearProgreso(plan), casilla('1', true)));
    const resultado = aplicar(inicial, casilla('2', false, 1));
    const desmarcado = aceptar(resultado);
    if (resultado.tipo !== 'aplicada') throw new Error('Falta recibo');
    const ajeno = aceptar(aplicar(desmarcado, casilla('3', true, 0, 'tren')));
    const restaurado = aceptar(aplicar(ajeno, prepararDeshacer(resultado.cambios, '4', 'iphone')));
    expect(restaurado.pendientes.entrada).toEqual({ hecho: true, revision: 3 });
    expect(restaurado.pendientes.tren).toEqual(ajeno.pendientes.tren);
    const posterior = aceptar(aplicar(ajeno, casilla('5', true, 2)));
    expect(aplicar(posterior, prepararDeshacer(resultado.cambios, '6', 'iphone')).tipo).toBe('conflicto');
  });

  test('precondición global explícita sigue vigente aunque la parada deje de estar aquí', () => {
    const inicial = aceptar(aplicar(crearProgreso(plan), marcar('1', 'museo', 'aqui', 0, 600, 0)));
    const transicion = aplicar(inicial, {
      ...marcar('2', 'hotel-mañana', 'aqui', 0, 700, 1), revisionAnterior: 1,
    });
    const estado = aceptar(transicion);
    // Aunque "hecha" sea ya el valor del origen, no descartamos una precondición global enviada.
    expect(aplicar(estado, marcar('3', 'museo', 'hecha', 1, undefined, 1)).tipo).toBe('conflicto');
    const modificado = aceptar(aplicar(estado, marcar('4', 'museo', 'saltada', 2)));
    if (transicion.tipo !== 'aplicada') throw new Error('Falta recibo');
    expect(aplicar(modificado, prepararDeshacer(transicion.cambios, '5', 'fold')))
      .toMatchObject({ tipo: 'conflicto', estado: modificado });
  });

  test('recibos no autorizan cambios inventados y reintentos reconstruidos son idempotentes', () => {
    const op = marcar('1');
    const resultado = aplicar(crearProgreso(plan), op);
    const estado = aceptar(resultado);
    if (resultado.tipo !== 'aplicada') throw new Error('Falta recibo');
    const falso = { ...resultado.cambios, registros: [] };
    expect(aplicar(estado, prepararDeshacer(falso, '2', 'fold')).tipo).toBe('invalida');
    const reconstruida: Operacion = { revision: 0, marca: 'hecha', paradaId: 'museo',
      tipo: 'parada', dispositivoId: 'fold', id: '1' };
    expect(aplicar(estado, reconstruida).tipo).toBe('duplicada');
  });

  test('cancelar no enviada conserva otras operaciones y no elimina dependientes a escondidas', () => {
    const cola = [{ operacion: marcar('1'), dependeDe: [] }, { operacion: casilla('2', true), dependeDe: [] }];
    expect(cancelarPendiente(cola, '1')).toEqual({ tipo: 'cancelada', pendientes: [cola[1]] });
    expect(cola).toHaveLength(2);
    const dependiente = { operacion: marcar('3', 'museo', null, 1), dependeDe: ['1'] };
    expect(cancelarPendiente([...cola, dependiente], '1').tipo).toBe('conflicto');
    expect(cancelarPendiente(cola, 'ausente').tipo).toBe('ausente');
  });
});

describe('importación pura y recuperable', () => {
  test('coincidencia exacta, hora asociada y textos sin preferencias de dispositivo', () => {
    const originales = { marcas: JSON.stringify({ [museo]: 'hecha' }),
      'marcas-hora': JSON.stringify({ [museo]: 650 }), 'pendientes-hechos': '["Reservar entrada"]' };
    const resultado = importarLegado(plan, crearProgreso(plan), originales);
    expect(resultado.estado.paradas.museo).toEqual({ marca: 'hecha', horaReal: 650, revision: 1 });
    expect(resultado.estado.pendientes.entrada).toEqual({ hecho: true, revision: 1 });
    expect(resultado.recuperacion).toEqual([]);
    expect(resultado.originales).toEqual(originales);
    expect(resultado.estado).not.toHaveProperty('marcador');
    expect(resultado.estado).not.toHaveProperty('tema');
    expect(originales.marcas).toBe(JSON.stringify({ [museo]: 'hecha' }));
  });

  test('fallback único por fecha y nombre; exacta gana y sobra la obsoleta', () => {
    const fuente = { marcas: { [anterior]: 'saltada' }, 'marcas-hora': { [anterior]: 500 } };
    expect(importarLegado(plan, crearProgreso(plan), fuente).estado.paradas.museo)
      .toEqual({ marca: 'saltada', horaReal: 500, revision: 1 });
    const exacta = importarLegado(plan, crearProgreso(plan), {
      marcas: { [anterior]: 'saltada', [museo]: 'hecha' },
    });
    expect(exacta.estado.paradas.museo.marca).toBe('hecha');
    expect(exacta.recuperacion).toContainEqual(expect.objectContaining({ clave: anterior }));
  });

  test('no adivina nombres repetidos ni dos claves obsoletas; excluye claves actuales', () => {
    const ambiguo = importarLegado(plan, crearProgreso(plan), { marcas: {
      [anterior]: 'hecha', '2026-10-21|08:00|Museo': 'saltada',
      '2026-10-21|11:00|Hotel': 'hecha', '2026-10-21|12:00|Hotel': 'saltada',
    } });
    expect(ambiguo.estado.paradas.museo).toBeUndefined();
    expect(ambiguo.estado.paradas['hotel-noche']).toBeUndefined();
    expect(ambiguo.estado.paradas['hotel-mañana'].marca).toBe('saltada');
    expect(ambiguo.recuperacion).toHaveLength(3);
    expect(ambiguo.recuperacion.every((r) => r.motivo === 'ambigua')).toBe(true);
  });

  test('retiene blobs completos, JSON malformado, valores inválidos y huérfanos', () => {
    const originales = { marcas: { [museo]: 'extraña', desconocida: 'hecha' },
      'marcas-hora': { [museo]: Infinity, huérfana: 500 }, 'pendientes-hechos': ['No existe', 17] };
    const resultado = importarLegado(plan, crearProgreso(plan), originales);
    expect(resultado.originales).toEqual(originales);
    expect(resultado.originales).not.toBe(originales);
    expect(resultado.estado.paradas).toEqual({});
    expect(resultado.recuperacion).toHaveLength(6);
    const roto = { marcas: '{roto', 'marcas-hora': '[]', 'pendientes-hechos': '{}' };
    const malformado = importarLegado(plan, crearProgreso(plan), roto);
    expect(malformado.originales).toEqual(roto);
    expect(malformado.recuperacion).toHaveLength(3);
  });

  test('claves actuales y textos duplicados también son ambiguos, no identidades compartidas', () => {
    const duplicado: Itinerario = { ...plan, dias: [{ ...plan.dias[0], paradas: [
      ...plan.dias[0].paradas, { ...plan.dias[0].paradas[0], id: 'otro-museo' },
    ] }], pendientes: [...plan.pendientes!, { id: 'otra-entrada', texto: 'Reservar entrada' }] };
    const resultado = importarLegado(duplicado, crearProgreso(duplicado), {
      marcas: { [museo]: 'hecha' }, 'pendientes-hechos': ['Reservar entrada'],
    });
    expect(resultado.estado.paradas).toEqual({});
    expect(resultado.estado.pendientes).toEqual({});
    expect(resultado.recuperacion).toHaveLength(2);
    expect(resultado.recuperacion.every((r) => r.motivo === 'ambigua')).toBe(true);
  });

  test('hora inválida no destruye la marca válida, pero queda recuperable', () => {
    const resultado = importarLegado(plan, crearProgreso(plan), {
      marcas: { [museo]: 'hecha' }, 'marcas-hora': { [museo]: '09:00' },
    });
    expect(resultado.estado.paradas.museo).toEqual({ marca: 'hecha', revision: 1 });
    expect(resultado.recuperacion).toContainEqual(expect.objectContaining({ campo: 'marcas-hora', valor: '09:00' }));
  });

  test('reimportar no sobrescribe marcas, reset ni casillas false más recientes', () => {
    const fuente = { marcas: { [museo]: 'hecha' }, 'pendientes-hechos': ['Reservar entrada'] };
    const primero = importarLegado(plan, crearProgreso(plan), fuente);
    const segundo = importarLegado(plan, primero.estado, fuente);
    expect(segundo.estado).toBe(primero.estado);
    let nuevo = aceptar(aplicar(primero.estado, marcar('reset', 'museo', null, 1)));
    nuevo = aceptar(aplicar(nuevo, casilla('false', false, 1)));
    const repetido = importarLegado(plan, nuevo, fuente);
    expect(repetido.estado).toBe(nuevo);
    expect(repetido.recuperacion).toHaveLength(2);
  });

  test('múltiples aquí quedan sin resolver; no pierde originales ni genera dos activos', () => {
    const fuente = { marcas: { [museo]: 'aqui', '2026-10-21|12:00|Hotel': 'aqui' } };
    const resultado = importarLegado(plan, crearProgreso(plan), fuente);
    expect(resultado.estado.aqui.paradaId).toBeNull();
    expect(resultado.estado.paradas).toEqual({});
    expect(resultado.recuperacion).toHaveLength(2);
    expect(resultado.originales).toEqual(fuente);
    const activo = aceptar(aplicar(crearProgreso(plan), marcar('1', 'hotel-noche', 'aqui', 0, undefined, 0)));
    const conflicto = importarLegado(plan, activo, { marcas: { [museo]: 'aqui' } });
    expect(conflicto.estado).toBe(activo);
    expect(conflicto.recuperacion).toHaveLength(1);
    const unico = importarLegado(plan, crearProgreso(plan), { marcas: { [museo]: 'aqui' } });
    expect(unico.estado.aqui.paradaId).toBe('museo');
  });
});
