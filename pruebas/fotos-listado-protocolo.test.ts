import { describe, expect, it, vi } from 'vitest';
import type { Itinerario } from '../src/tipos';
import { serializarSolicitudRespaldo, deserializarSolicitudRespaldo } from '../src/fotos-protocolo';
import { copiarCursorListadoFotos, serializarCursorListadoFotos, deserializarCursorListadoFotos,
  copiarPaginaListadoFotos, serializarPaginaListadoFotos, deserializarPaginaListadoFotos, leerJsonListadoAcotado,
  MAX_FILAS_LISTADO_FOTOS, MAX_BYTES_CURSOR_LISTADO_FOTOS,
  MAX_PROFUNDIDAD_JSON_LISTADO_FOTOS, MAX_NODOS_JSON_LISTADO_FOTOS } from '../src/fotos-listado-protocolo';
const plan: Itinerario = { id: 'viaje', titulo: 'Prueba', dias: [{ fecha: '2026-10-21', titulo: 'Día',
  paradas: [{ id: 'a', nombre: 'A', hora: '10:00', categoria: 'museo', lat: 31, lng: 121 }] }] };
const despuesDe = '12345678-1234-4234-8234-123456789012';
const hasta = '22345678-1234-4234-8234-123456789012';
const cursor = { version: 1, viajeId: plan.id, despuesDe, hasta };
const textoCursor = JSON.stringify(cursor);
function inicial(fotoId = despuesDe, nombre = 'e\u0301\0"original":}\\.jpg') {
  return serializarSolicitudRespaldo(plan, { version: 1, tipo: 'solicitud-respaldo', viajeId: plan.id,
    fotoId, operacionId: '32345678-1234-4234-8234-123456789012', original: { formato: 1, fotoId,
      destino: { tipo: 'parada', viajeId: plan.id, paradaId: 'a' }, nombre, mimeDeclarado: 'IMAGE/HEIC\0;☃',
      ultimaModificacion: -0, incorporada: -0, bytesOriginal: -0 } });
}
const pagina = { version: 1, tipo: 'listado-respaldos', viajeId: plan.id,
  solicitudesIniciales: [inicial()], continuacion: textoCursor };
const serial = (valor: unknown, bytes = 500000) => serializarPaginaListadoFotos(plan, valor, 8, bytes);

describe('Listado: protocolo sin autoridad de ACK', () => {
  it('serializa posición con framing canónico y conserva identidad', () => {
    expect(serializarCursorListadoFotos(plan, cursor)).toBe(textoCursor);
    expect(deserializarCursorListadoFotos(plan, textoCursor)).toEqual(cursor);
    expect(Object.isFrozen(copiarCursorListadoFotos(plan, cursor))).toBe(true);
  });
  it('lee JSON acotado sin alterar escalares', () => {
    expect(leerJsonListadoAcotado('{"a":-0}', 8)).toEqual({ a: -0 });
  });
  it('publica las cuatro cotas del scanner y el listado', () => {
    expect([MAX_FILAS_LISTADO_FOTOS, MAX_BYTES_CURSOR_LISTADO_FOTOS,
      MAX_PROFUNDIDAD_JSON_LISTADO_FOTOS, MAX_NODOS_JSON_LISTADO_FOTOS]).toEqual([8, 1024, 16, 256]);
  });
  it.each([null, [], {}, { ...cursor, version: 2 }, { ...cursor, viajeId: 'otro' },
    { ...cursor, despuesDe: hasta }, { ...cursor, despuesDe: 'z' }, { ...cursor, hasta: despuesDe },
    { ...cursor, extra: 1 }, Object.create(cursor)])('rechaza cursor inválido %# sin coerción', (valor) => {
    expect(() => copiarCursorListadoFotos(plan, valor)).toThrow();
  });
  it.each([' ' + textoCursor, textoCursor + '\n', textoCursor.replace('"version":1', '"version":1,"version":1'),
    textoCursor.replace('version', '\\u0076ersion'), textoCursor.replace('"version":1', '"version":1.0'),
    textoCursor.replace('"viajeId":"viaje",', '')])('rechaza cursor no canónico %#', (texto) => {
    expect(() => deserializarCursorListadoFotos(plan, texto)).toThrow();
  });
  it('framing cursor extremo de viaje escapado cabe en 1024 sin UUID mágico', () => {
    const p = { ...plan, id: '\u0001'.repeat(128) };
    const texto = serializarCursorListadoFotos(p, { ...cursor, viajeId: p.id });
    expect(new TextEncoder().encode(texto).length).toBeLessThanOrEqual(892);
    expect(deserializarCursorListadoFotos(p, texto).viajeId).toBe(p.id);
  });
  it.each(['', 'x'.repeat(129), '\0', '\uD800', '\uFEFFviaje'])('trip raw inválido %#', (id) => {
    const p = { ...plan, id };
    expect(() => serializarCursorListadoFotos(p, { ...cursor, viajeId: id })).toThrow();
  });
  it('conserva INITIAL completo, MIME raro, NUL y tres -0; snapshot congelado', () => {
    const copia = copiarPaginaListadoFotos(plan, pagina, 1);
    expect(copia).toEqual(pagina);
    expect(Object.isFrozen(copia)).toBe(true); expect(Object.isFrozen(copia.solicitudesIniciales)).toBe(true);
    const s = deserializarSolicitudRespaldo(plan, copia.solicitudesIniciales[0]);
    expect(s.original.nombre).toBe('e\u0301\0"original":}\\.jpg');
    expect(s.original.mimeDeclarado).toBe('IMAGE/HEIC\0;☃');
    for (const n of [s.original.ultimaModificacion, s.original.incorporada, s.original.bytesOriginal]) expect(Object.is(n, -0)).toBe(true);
    expect(deserializarPaginaListadoFotos(plan, serial(pagina), 8, 500000)).toEqual(pagina);
  });
  it('NFD/NFC y MIME/casing no se normalizan', () => {
    expect(serial({ ...pagina, solicitudesIniciales: [inicial(despuesDe, 'é')] })).not.toBe(serial(pagina));
    const mayuscula = 'ABCDEF12-1234-4234-8234-123456789012';
    expect(copiarPaginaListadoFotos(plan, { ...pagina, solicitudesIniciales: [inicial(mayuscula), inicial(mayuscula.toLowerCase())],
      continuacion: null }, 2).solicitudesIniciales).toHaveLength(2);
    expect(() => copiarPaginaListadoFotos(plan, { ...pagina, solicitudesIniciales: [inicial(mayuscula.toLowerCase()), inicial(mayuscula)],
      continuacion: null }, 2)).toThrow();
  });
  it('metadata con surrogate escapado sigue perteneciendo al dominio previo', () => {
    const texto = inicial(despuesDe, '\uD800');
    expect(texto).toContain('\\ud800');
    expect(copiarPaginaListadoFotos(plan, { ...pagina, solicitudesIniciales: [texto] }, 1).solicitudesIniciales[0]).toBe(texto);
  });
  it('INITIAL exacto 65536 sigue válido para codec; 65537 no', () => {
    const base = inicial(despuesDe, '');
    const texto = inicial(despuesDe, 'x'.repeat(65536 - new TextEncoder().encode(base).length));
    expect(new TextEncoder().encode(texto).length).toBe(65536);
    expect(copiarPaginaListadoFotos(plan, { ...pagina, solicitudesIniciales: [texto] }, 1).solicitudesIniciales[0]).toBe(texto);
    expect(() => inicial(despuesDe, 'x'.repeat(65537 - new TextEncoder().encode(base).length))).toThrow();
  });
  it.each([{ ...pagina, tipo: 'acuse-respaldo' }, { ...pagina, extra: 'recibo' }, { ...pagina, viajeId: 'otro' },
    { ...pagina, solicitudesIniciales: [inicial(), inicial()] }, { ...pagina, solicitudesIniciales: [inicial(hasta)] },
    { ...pagina, solicitudesIniciales: [], continuacion: textoCursor },
    { ...pagina, solicitudesIniciales: [inicial().replace('solicitud-respaldo', 'acuse-respaldo')] },
    { ...pagina, solicitudesIniciales: [' ' + inicial()] }, { ...pagina, continuacion: '{}' }])('página contradictoria %#', (valor) => {
    expect(() => copiarPaginaListadoFotos(plan, valor, 8)).toThrow();
  });
  it('rechaza cursor invertido, sin atribuir el fallo al guard de IDs publicados', () => {
    // En una página válida, orden estricto + últimoID=despuesDe<hasta implican
    // TODOS los IDs<=hasta. Ese guard público es redundante; no puede aislarse
    // conservando las otras invariantes. La frontera SQL sí prueba el exceso aparte.
    const c = JSON.stringify({ ...cursor, despuesDe: hasta, hasta: despuesDe });
    expect(() => deserializarCursorListadoFotos(plan, c)).toThrow();
    expect(() => copiarPaginaListadoFotos(plan, { ...pagina, solicitudesIniciales: [inicial(hasta)], continuacion: c }, 1)).toThrow();
  });
  it('vacía exige null; ocho filas caben, nueve no', () => {
    expect(copiarPaginaListadoFotos(plan, { ...pagina, solicitudesIniciales: [], continuacion: null }, 1).continuacion).toBeNull();
    const solicitudesIniciales = Array.from({ length: 8 }, (_, i) => inicial(`${i + 1}2345678-1234-4234-8234-123456789012`));
    expect(copiarPaginaListadoFotos(plan, { ...pagina, solicitudesIniciales, continuacion: null }, 8).solicitudesIniciales).toHaveLength(8);
    expect(() => copiarPaginaListadoFotos(plan, { ...pagina, solicitudesIniciales: [...solicitudesIniciales, inicial(hasta)], continuacion: null }, 8)).toThrow();
  });
  it.each([0, 9, NaN, Infinity, 1.5, Number.MAX_SAFE_INTEGER])('maxFilas inválido %s', (n) => {
    expect(() => copiarPaginaListadoFotos(plan, pagina, n)).toThrow();
  });
  it('presupuesto UTF8 efectivo exacto y uno menos, incluida expansión Unicode', () => {
    const valor = { ...pagina, solicitudesIniciales: [inicial(despuesDe, '中☃é')], continuacion: null };
    const texto = serial(valor); const bytes = new TextEncoder().encode(texto).length;
    expect(serial(valor, bytes)).toBe(texto);
    expect(deserializarPaginaListadoFotos(plan, texto, 8, bytes)).toEqual(valor);
    expect(() => serial(valor, bytes - 1)).toThrow();
    expect(() => deserializarPaginaListadoFotos(plan, texto, 8, bytes - 1)).toThrow();
  });
  it.each([' ' + serial(pagina), serial(pagina).replace('version', '\\u0076ersion'), serial(pagina) + 'false'])('página no canónica %#', (texto) => {
    expect(() => deserializarPaginaListadoFotos(plan, texto, 8, 500000)).toThrow();
  });
  it('arrays densos propios, sin extras, subclases, accessors ni toJSON', () => {
    const getter = vi.fn(() => inicial());
    const accessor = [inicial()]; Object.defineProperty(accessor, '0', { get: getter });
    const extra = Object.assign([inicial()], { toJSON: getter });
    class Subclase extends Array<string> {}
    for (const solicitudesIniciales of [new Array(1), accessor, extra, new Subclase(inicial())]) {
      expect(() => copiarPaginaListadoFotos(plan, { ...pagina, solicitudesIniciales }, 8)).toThrow();
    }
    expect(getter).not.toHaveBeenCalled();
  });
  it('accessors de DTO y de plan se rechazan antes de leerlos (M1)', () => {
    const getter = vi.fn(() => plan.id);
    const p = { ...plan }; Object.defineProperty(p, 'id', { get: getter });
    const dto = { ...cursor }; Object.defineProperty(dto, 'viajeId', { get: getter });
    expect(() => copiarCursorListadoFotos(plan, dto)).toThrow();
    expect(() => serializarCursorListadoFotos(p, cursor)).toThrow();
    expect(() => serializarPaginaListadoFotos(p, pagina, 1, 1000)).toThrow();
    expect(getter).not.toHaveBeenCalled();
  });
});

describe('Scanner compartido antes de parsear dominio', () => {
  it.each(['{"a":1,"a":2}', '{"a":1,"\\u0061":2}', '{"x":{"a":0,"a":1}}',
    '{"a":}', '[1,]', '{"a":1,}', '01', 'false true', '"\\x"', '"\\u12z4"', '"\n"', '', '\uFEFF{}', '"\uD800"'])('rechaza fuente %#', (texto) => {
    expect(() => leerJsonListadoAcotado(texto, 1000)).toThrow();
  });
  it.each([undefined, null, {}, 12])('no convierte texto unknown %#', (valor) => {
    expect(() => leerJsonListadoAcotado(valor, 10)).toThrow();
  });
  it.each([0, -1, NaN, Infinity, 1.5, Number.MAX_SAFE_INTEGER + 1])('maxBytes inválido %s', (n) => {
    expect(() => leerJsonListadoAcotado('{}', n)).toThrow();
  });
  it('bytes exactos antes de parse, no sólo length; MAX_SAFE no se multiplica', () => {
    expect(leerJsonListadoAcotado('"中"', 5)).toBe('中');
    expect(() => leerJsonListadoAcotado('"中"', 4)).toThrow();
    expect(leerJsonListadoAcotado('{}', Number.MAX_SAFE_INTEGER)).toEqual({});
  });
  it('256 nodos exactos y 257 fallan (raíz contada)', () => {
    expect(leerJsonListadoAcotado('[' + Array(255).fill('0').join(',') + ']', 1000)).toHaveLength(255);
    expect(() => leerJsonListadoAcotado('[' + Array(256).fill('0').join(',') + ']', 1000)).toThrow();
  });
  it('profundidad raíz0: 16 exacta, 17 falla; escapes no cuentan como estructura', () => {
    expect(leerJsonListadoAcotado('['.repeat(16) + '0' + ']'.repeat(16), 100)).toBeDefined();
    expect(() => leerJsonListadoAcotado('['.repeat(17) + '0' + ']'.repeat(17), 100)).toThrow();
    expect(leerJsonListadoAcotado('"[]{}\\\""', 100)).toBe('[]{}"');
  });
  it('se permiten surrogates JSON escapados pero no unidades raw inválidas', () => {
    expect(leerJsonListadoAcotado('"\\uD800"', 8)).toBe('\uD800');
    expect(leerJsonListadoAcotado('"😀"', 6)).toBe('😀');
    expect(() => leerJsonListadoAcotado('"\uDC00"', 100)).toThrow();
  });
});
