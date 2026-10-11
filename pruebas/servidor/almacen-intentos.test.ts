import { readFile } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { crearAlmacenIntentosSql } from '../../servidor/almacen-intentos';
import type { EjecutorSql } from '../../servidor/contratos';

const fallo = 'No se pudo comprobar la sesión.';
const a = 'a'.repeat(64), b = 'b'.repeat(64);
let db: PGlite;
const ejecutor: EjecutorSql = { async ejecutar(sql, parametros) {
  return { filas: (await db.query(sql, [...parametros])).rows };
} };
const almacen = () => crearAlmacenIntentosSql({ ejecutor });

// PostgreSQL real WASM, memoria y UNA conexión: no prueba locks entre clientes remotos.
describe('Límite persistente SQL de entrada', () => {
  beforeAll(async () => {
    db = await PGlite.create('memory://');
    for (const nombre of ['001_base.sql', '002_progreso.sql', '003_sesiones.sql', '004_limite.sql']) {
      await db.exec(await readFile(new URL('../../servidor/migraciones/' + nombre, import.meta.url), 'utf8'));
    }
  }, 30000);
  afterAll(async () => { await db?.close(); });
  beforeEach(async () => { await db.exec('TRUNCATE itinerario.intentos_sesion'); });
  async function filas() {
    return (await db.query('SELECT huella_origen, inicio_en::text, intentos FROM itinerario.intentos_sesion ORDER BY huella_origen')).rows;
  }
  it('admite diez, deniega el undécimo y conserva ventana entre instancias con reloj regresivo', async () => {
    const primero = almacen(), segundo = almacen();
    expect(await primero.admitirIntento(a, 100)).toBe(true);
    expect(await segundo.admitirIntento(a, 99)).toBe(false);
    for (let i = 1; i < 10; i++) expect(await segundo.admitirIntento(a, 100)).toBe(true);
    expect(await primero.admitirIntento(a, 600099)).toBe(false);
    const lleno = [{ huella_origen: a, inicio_en: '100', intentos: 10 }];
    expect(await filas()).toEqual(lleno);
    for (const ahora of [99, 100, 600099, 99]) expect(await primero.admitirIntento(a, ahora)).toBe(false);
    expect(await filas()).toEqual(lleno);
    expect(await segundo.admitirIntento(a, 600100)).toBe(true);
    expect(await filas()).toEqual([{ huella_origen: a, inicio_en: '600100', intentos: 1 }]);
  });
  it('regresión con contador uno siempre deniega y no altera el bucket', async () => {
    expect(await almacen().admitirIntento(a, 600000)).toBe(true);
    const antes = await filas();
    expect(await almacen().admitirIntento(a, 0)).toBe(false);
    expect(await filas()).toEqual(antes);
  });
  it('hashes y ventanas independientes; no depende de raíz ni de sesión autenticada', async () => {
    for (let i = 0; i < 10; i++) await almacen().admitirIntento(a, 0);
    expect(await almacen().admitirIntento(b, 500)).toBe(true);
    expect(await almacen().admitirIntento(a, 599999)).toBe(false);
    expect(await almacen().admitirIntento(b, 600000)).toBe(true);
    expect(await almacen().admitirIntento(a, 600000)).toBe(true);
    expect(await filas()).toEqual([{ huella_origen: a, inicio_en: '600000', intentos: 1 },
      { huella_origen: b, inicio_en: '500', intentos: 2 }]);
  });
  it.each([0, -0, Number.MAX_SAFE_INTEGER])('reloj inclusivo %s sin desbordamiento ni normalización de operación', async (ahora) => {
    expect(await almacen().admitirIntento(a, ahora)).toBe(true);
    expect(await filas()).toEqual([{ huella_origen: a, inicio_en: String(ahora), intentos: 1 }]);
    for (let i = 1; i < 10; i++) expect(await almacen().admitirIntento(a, ahora)).toBe(true);
    expect(await almacen().admitirIntento(a, ahora)).toBe(false);
  });
  it('resta BIGINT desde cero hasta MAX y frontera de ventana cerca del máximo', async () => {
    const max = Number.MAX_SAFE_INTEGER;
    expect(await almacen().admitirIntento(a, 0)).toBe(true);
    expect(await almacen().admitirIntento(a, max)).toBe(true);
    expect(await almacen().admitirIntento(b, max - 600000)).toBe(true);
    for (let i = 1; i < 10; i++) await almacen().admitirIntento(b, max - 1);
    expect(await almacen().admitirIntento(b, max - 1)).toBe(false);
    expect(await almacen().admitirIntento(b, max)).toBe(true);
    expect(await filas()).toEqual([a, b].map((huella_origen) => ({ huella_origen, inicio_en: String(max), intentos: 1 })));
  });
  it('dos instancias comparten operaciones concurrentes serializadas por UNA conexión WASM', async () => {
    const instancias = [almacen(), almacen()];
    const resultados = await Promise.all(Array.from({ length: 20 }, (_, i) => instancias[i % 2]!.admitirIntento(a, 0)));
    expect(resultados.filter((v) => v === true)).toHaveLength(10);
    expect(resultados.filter((v) => v === false)).toHaveLength(10);
    const reinicio = await Promise.all(instancias.map((r) => r.admitirIntento(a, 600000)));
    expect(reinicio).toEqual([true, true]);
    expect(await filas()).toEqual([{ huella_origen: a, inicio_en: '600000', intentos: 2 }]);
  });
  it.each([[null, 0], ['bad', 0], [a + '\n', 0], [a.toUpperCase(), 0], [a, null], [a, -1], [a, '9007199254740992']])(
    'SQL directo valida %j/%j antes de escribir', async (huella, ahora) => {
      await expect(db.query('SELECT itinerario.admitir_intento($1,$2)', [huella, ahora])).rejects.toThrow();
      expect(await filas()).toEqual([]);
    });
  it.each([['huella_origen', 'bad'], ['inicio_en', -1], ['inicio_en', '9007199254740992'], ['intentos', 0], ['intentos', 11]])(
    'constraint nativa %s rechaza %s sin persistir', async (columna, valor) => {
      await almacen().admitirIntento(a, 0); const antes = await filas();
      await expect(db.query(`UPDATE itinerario.intentos_sesion SET ${columna}=$1`, [valor])).rejects.toThrow();
      expect(await filas()).toEqual(antes);
    });
  it.each(['primero', 'incremento', 'reinicio'])('excepción AFTER %s revierte la escritura nativa', async (caso) => {
    if (caso !== 'primero') await almacen().admitirIntento(a, 100);
    const antes = await filas();
    await db.exec(`CREATE FUNCTION itinerario.fallar_intento_prueba() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'postgres://privado clave token'; END $$;
      CREATE TRIGGER fallo_intento AFTER ${caso === 'primero' ? 'INSERT' : 'UPDATE'} ON itinerario.intentos_sesion
      FOR EACH ROW EXECUTE FUNCTION itinerario.fallar_intento_prueba()`);
    try {
      await expect(almacen().admitirIntento(a, caso === 'reinicio' ? 600100 : 100)).rejects.toThrow(fallo);
      expect(await filas()).toEqual(antes);
    } finally { await db.exec('DROP TRIGGER fallo_intento ON itinerario.intentos_sesion; DROP FUNCTION itinerario.fallar_intento_prueba()'); }
  });
  it('denegados no hacen UPDATE; ni contador lleno ni regresión consumen escritura', async () => {
    for (let i = 0; i < 10; i++) await almacen().admitirIntento(a, 100);
    await db.exec(`CREATE FUNCTION itinerario.prohibir_update_prueba() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'escritura inesperada'; END $$;
      CREATE TRIGGER sin_update BEFORE UPDATE ON itinerario.intentos_sesion
      FOR EACH ROW EXECUTE FUNCTION itinerario.prohibir_update_prueba()`);
    try {
      expect(await almacen().admitirIntento(a, 100)).toBe(false);
      expect(await almacen().admitirIntento(a, 99)).toBe(false);
      expect(await filas()).toEqual([{ huella_origen: a, inicio_en: '100', intentos: 10 }]);
    } finally { await db.exec('DROP TRIGGER sin_update ON itinerario.intentos_sesion; DROP FUNCTION itinerario.prohibir_update_prueba()'); }
  });
  it('commit seguido de pérdida de respuesta es error privado, no falso deny; retry consume otro', async () => {
    const perdida = crearAlmacenIntentosSql({ ejecutor: { async ejecutar(sql, parametros) {
      await ejecutor.ejecutar(sql, parametros); throw new Error('postgres://privado clave token');
    } } });
    await expect(perdida.admitirIntento(a, 0)).rejects.toThrow(fallo);
    expect(await filas()).toEqual([{ huella_origen: a, inicio_en: '0', intentos: 1 }]);
    expect(await almacen().admitirIntento(a, 0)).toBe(true);
    expect(await filas()).toEqual([{ huella_origen: a, inicio_en: '0', intentos: 2 }]);
  });
});

const respuesta = (resultado: unknown) => ({ filas: [{ resultado }] });
function fabrica(valor: unknown) {
  const ejecutar = vi.fn(async (_sql: string, _parametros: readonly unknown[]) => valor as { filas: readonly unknown[] });
  return { ejecutar, repo: crearAlmacenIntentosSql({ ejecutor: { ejecutar } }) };
}
describe('Frontera estricta del límite de entrada', () => {
  it.each([true, false])('solo booleano JSON %s; una consulta ligada por intento', async (decision) => {
    const { ejecutar, repo } = fabrica(respuesta(String(decision)));
    expect(await repo.admitirIntento(a, -0)).toBe(decision);
    expect(ejecutar.mock.calls).toEqual([['SELECT itinerario.admitir_intento($1, $2) AS resultado', [a, -0]]]);
    expect(Object.isFrozen(repo)).toBe(true);
    expect(Reflect.ownKeys(repo)).toEqual(['admitirIntento']);
  });
  it.each(['', 'bad', a + '\n', a.toUpperCase(), a + "'; SELECT true;--", null, 1, {}, new String(a)])(
    'huella inválida %j rechaza sin IO ni coerción', async (huella) => {
      const { ejecutar, repo } = fabrica(respuesta('true'));
      await expect(repo.admitirIntento(huella as string, 0)).rejects.toThrow(fallo);
      expect(ejecutar).not.toHaveBeenCalled();
    });
  it.each([-1, 0.1, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, null, '0', new Number(0), {}])(
    'reloj inválido %j rechaza sin IO ni coerción', async (ahora) => {
      const { ejecutar, repo } = fabrica(respuesta('true'));
      await expect(repo.admitirIntento(a, ahora as number)).rejects.toThrow(fallo);
      expect(ejecutar).not.toHaveBeenCalled();
    });
  it('no ejecuta valueOf/toString de parámetros hostiles', async () => {
    const getter = vi.fn(() => 0);
    const hostil = Object.defineProperty({}, 'valueOf', { get: getter });
    const { ejecutar, repo } = fabrica(respuesta('true'));
    await expect(repo.admitirIntento(hostil as string, 0)).rejects.toThrow(fallo);
    await expect(repo.admitirIntento(a, hostil as number)).rejects.toThrow(fallo);
    expect(getter).not.toHaveBeenCalled(); expect(ejecutar).not.toHaveBeenCalled();
  });
  it.each([null, {}, { filas: [] }, { filas: [{ resultado: 'true' }, { resultado: 'true' }] },
    { ...respuesta('true'), extra: 1 }, { filas: [{ resultado: 'true', extra: 1 }] },
    ...[null, true, 0, '"false"', '"true"', '0', '{}', '[]', 'null', '{mal', '1e999'].map(respuesta)])(
    'sobre o decisión inválida nunca se coacciona: %j', async (valor) => {
      await expect(fabrica(valor).repo.admitirIntento(a, 0)).rejects.toThrow(fallo);
    });
  it('getters de sobre, fila e índice no se ejecutan; rechaza símbolos/prototipos/arrays extra', async () => {
    const getter = vi.fn(() => 'true');
    const filas = [{ resultado: 'true' }]; Object.defineProperty(filas, 'extra', { value: 1 });
    for (const valor of [Object.defineProperty({}, 'filas', { get: getter }),
      { filas: [Object.defineProperty({}, 'resultado', { get: getter })] },
      { filas: Object.defineProperty([{}], '0', { get: getter }) }, { filas },
      { filas: [Object.assign({ resultado: 'true' }, { [Symbol('extra')]: true })] },
      { filas: [Object.assign(Object.create(null), { resultado: 'true' })] }, { filas: new Array(1) }]) {
      await expect(fabrica(valor).repo.admitirIntento(a, 0)).rejects.toThrow(fallo);
    }
    expect(getter).not.toHaveBeenCalled();
  });
  it('acepta datos propios no enumerables como la frontera existente', async () => {
    const fila = Object.defineProperty({}, 'resultado', { value: 'false' });
    const valor = Object.defineProperty({}, 'filas', { value: [fila] });
    expect(await fabrica(valor).repo.admitirIntento(a, 0)).toBe(false);
  });
  it('configuración/reflexión hostil falla de forma privada, sin ejecutar getters', () => {
    const getter = vi.fn(() => { throw new Error('postgres://privado'); });
    for (const config of [null, {}, { ejecutor: {} }, Object.defineProperty({}, 'ejecutor', { get: getter }),
      { ejecutor: Object.defineProperty({}, 'ejecutar', { get: getter }) },
      new Proxy({}, { ownKeys() { throw new Error('postgres://privado'); } })]) {
      expect(() => crearAlmacenIntentosSql(config as { ejecutor: EjecutorSql })).toThrow(fallo);
    }
    expect(getter).not.toHaveBeenCalled();
  });
  it('reflexión de respuesta hostil no filtra detalles', async () => {
    const valor = new Proxy({}, { getPrototypeOf() { throw new Error('postgres://privado'); } });
    await expect(fabrica(valor).repo.admitirIntento(a, 0)).rejects.toThrow(fallo);
  });
  it('resuelve solo al completar ejecutor; nunca confirma un acuse pendiente', async () => {
    let resolver!: (valor: { filas: readonly unknown[] }) => void;
    const pendiente = new Promise<{ filas: readonly unknown[] }>((r) => { resolver = r; });
    const repo = crearAlmacenIntentosSql({ ejecutor: { ejecutar: () => pendiente } });
    let completada = false;
    const accion = repo.admitirIntento(a, 0).then((valor) => { completada = true; return valor; });
    await Promise.resolve(); expect(completada).toBe(false);
    resolver(respuesta('false')); expect(await accion).toBe(false);
  });
  it('errores de transporte no se convierten en false ni tienen causa privada', async () => {
    const repo = crearAlmacenIntentosSql({ ejecutor: { async ejecutar() { throw new Error('postgres://clave token'); } } });
    try { await repo.admitirIntento(a, 0); expect.fail('debe fallar'); } catch (error) {
      expect((error as Error).message).toBe(fallo); expect(Object.hasOwn(error as object, 'cause')).toBe(false);
    }
  });
});
