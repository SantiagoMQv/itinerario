import { describe, expect, it, vi } from 'vitest';
import { parsearProgreso, serializarProgreso } from '../src/progreso-json';

const errorSeguro = 'Datos JSON de progreso inválidos.';
function comprobarNumeros(original: unknown, copia: unknown): void {
  if (typeof original === 'number') expect(Object.is(original, copia)).toBe(true);
  else if (original && typeof original === 'object') {
    for (const clave of Object.getOwnPropertyNames(original)) {
      comprobarNumeros((original as Record<string, unknown>)[clave], (copia as Record<string, unknown>)[clave]);
    }
  } else expect(copia).toBe(original);
}
function rechazar(valor: unknown) {
  expect(() => serializarProgreso(valor)).toThrow(new Error(errorSeguro));
}

describe('JSON exacto de progreso', () => {
  it('conserva todos los números como números, incluido el literal -0', () => {
    const valor = { numeros: [-0, 0, Number.MIN_VALUE, Number.MAX_VALUE, 1e308, -1e308,
      0.1, -0.25, Number.MAX_SAFE_INTEGER, Math.PI], texto: '"/\\\n\r\t\b\f\0上海😀\ud800|\udfff',
    nulo: null, cierto: true, falso: false };
    const texto = serializarProgreso(valor);
    expect(texto).toContain('[-0,0,');
    comprobarNumeros(valor, JSON.parse(texto));
    comprobarNumeros(valor, parsearProgreso(texto));
    expect(serializarProgreso(-0)).toBe('-0');
  });
  it('escapa claves y materializa datos ocultos sin herencia ni mutación', () => {
    const diccionario = Object.create(null);
    for (const clave of ['__proto__', 'constructor', '"\\\0😀', 'toJSON']) {
      Object.defineProperty(diccionario, clave, { value: -0 });
    }
    Object.freeze(diccionario);
    const copia = JSON.parse(serializarProgreso(diccionario));
    expect(Object.keys(copia)).toEqual(Object.getOwnPropertyNames(diccionario));
    comprobarNumeros(diccionario, copia);
    expect(Object.getPrototypeOf(diccionario)).toBeNull();
    expect(Object.isFrozen(diccionario)).toBe(true);
    expect(Object.hasOwn(copia, '__proto__')).toBe(true);
    expect(serializarProgreso({})).toBe('{}');
  });
  it('admite índices propios ocultos y referencias compartidas acíclicas', () => {
    const arreglo = [-0]; Object.defineProperty(arreglo, '0', { enumerable: false }); Object.freeze(arreglo);
    const compartido = Object.freeze({ numero: -0 });
    const valor = { arreglo, a: compartido, b: compartido };
    comprobarNumeros(valor, JSON.parse(serializarProgreso(valor)));
    expect(valor.a).toBe(valor.b);
  });
  it.each([undefined, () => 1, Symbol('dato'), 1n, NaN, Infinity, -Infinity,
    new Date(0), new Map(), new Set(), new (class Dato { numero = 1; })(),
    new Number(1), new (class Lista extends Array {})(), Object.create({ heredado: 1 }), { dato: undefined }, [undefined],
    { dato: { numero: Infinity } }, { [Symbol('dato')]: 1 }, new Array(1)])(
    'rechaza valores ajenos a JSON sin publicar su contenido %#', rechazar);
  it.each(['extra', '01', '4294967295'])('rechaza propiedades adicionales en arreglos: %s', (clave) => {
    const arreglo = [1]; Object.defineProperty(arreglo, clave, { value: 2 }); rechazar(arreglo);
  });
  it('rechaza huecos, símbolos y accesores de arreglos sin leerlos', () => {
    const hueco = [1, 2]; delete hueco[0]; rechazar(hueco);
    const simbolo = [1]; Object.defineProperty(simbolo, Symbol('dato'), { value: 2 }); rechazar(simbolo);
    const getter = vi.fn(() => -0);
    const arreglo = [1]; Object.defineProperty(arreglo, '0', { get: getter }); rechazar(arreglo);
    expect(getter).not.toHaveBeenCalled();
  });
  it('no ejecuta getters anidados ni toJSON ni conversiones', () => {
    const getter = vi.fn(() => 1); const convertir = vi.fn(() => 'dato');
    rechazar({ anidado: Object.defineProperty({}, 'dato', { get: getter }) });
    rechazar({ toJSON: convertir }); rechazar({ toString: convertir });
    rechazar(Object.defineProperty({}, 'dato', { set: convertir }));
    expect(getter).not.toHaveBeenCalled(); expect(convertir).not.toHaveBeenCalled();
  });
  it('rechaza ciclos, profundidad excesiva y errores de reflexión con error constante', () => {
    const ciclo: Record<string, unknown> = {}; ciclo.hijo = { padre: ciclo }; rechazar(ciclo);
    const arreglo: unknown[] = []; arreglo.push(arreglo); rechazar(arreglo);
    let profundo: unknown = null;
    for (let i = 0; i < 20000; i++) profundo = { hijo: profundo };
    rechazar(profundo);
    rechazar(new Proxy({}, { ownKeys() { throw new Error('Dato externo no publicable'); } }));
    rechazar(new Proxy({ dato: 1 }, { getOwnPropertyDescriptor() { throw new Error('Dato externo'); } }));
    expect(() => parsearProgreso('['.repeat(20000) + '0' + ']'.repeat(20000))).toThrow(new Error(errorSeguro));
  });
  it.each([null, 0, {}, ['null'], '{', 'null resto', '1e999', '-1e999', '{"dato":1e999}',
    '[0,1e999]', 'texto externo no publicable'])('parsea solo texto JSON finito con error constante %#', (texto) => {
    expect(() => parsearProgreso(texto)).toThrow(new Error(errorSeguro));
  });
  it('no convierte metadatos arbitrarios en texto para parsearlos', () => {
    const convertir = vi.fn(() => 'null');
    expect(() => parsearProgreso({ toString: convertir })).toThrow(new Error(errorSeguro));
    expect(convertir).not.toHaveBeenCalled();
  });
  it('parsea sin validar DTO y conserva NUL, -0 y la última clave duplicada nativa', () => {
    const valor = parsearProgreso('{"dato":0,"dato":-0,"texto":"\\u0000","__proto__":null}') as Record<string, unknown>;
    expect(Object.is(valor.dato, -0)).toBe(true);
    expect(valor.texto).toBe('\0'); expect(Object.hasOwn(valor, '__proto__')).toBe(true);
    expect(parsearProgreso('null')).toBeNull();
    expect(parsearProgreso('true')).toBe(true);
  });
});
