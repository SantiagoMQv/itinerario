import { afterEach, describe, expect, expectTypeOf, it, vi } from 'vitest';
import { crearPerfilPiloto, type DatosPerfilPiloto } from '../src/perfil-piloto';
import type { ComposicionRespaldoFotos } from '../src/fotos-respaldo-interfaz';
import type { ComposicionPortabilidad } from '../src/portabilidad-interfaz';

/** Ejemplos EXCLUSIVOS de pruebas, no política operativa ni defaults. */
function ejemplo() {
  return {
    origen: 'https://piloto.example', maxBytesCuerpoProveedor: 67045,
    respaldoServidor: { maxBytesOriginal: 1024, maxBytesEntrada: 67044, maxBytesChunk: 4096,
      maxBytesCabeceras: 256, maxBytesRetenidos: 2000000, maxBloquesOriginal: 4, bytesBloque: 256, plazoMs: 1000 },
    listadoServidor: { maxFilas: 1, maxOperacionesPorFoto: 1, maxBytesSql: 5000000,
      maxBytesRespuesta: 500000, maxBytesRetenidos: 60000000, plazoMs: 1000 },
    listadoCliente: { maxFilas: 1, maxBytesPagina: 500000, maxBytesChunk: 4096,
      maxBytesBackingChunk: 4096, maxLecturas: 100, maxBytesPlan: 4096, maxBytesRetenidos: 20000000, plazoMs: 1000 },
    portabilidad: { limites: { maxRegistros: 10, maxBytesMetadatos: 10000, maxBytesArchivo: 100000, maxProfundidad: 8 },
      limitesHistoria: { maxImportaciones: 2, maxObservaciones: 10, maxProcedencias: 10, maxBytesHistoria: 200000 } },
  } satisfies DatosPerfilPiloto;
}
function presupuestos(d: ReturnType<typeof ejemplo>): Record<string, number>[] {
  return [d.respaldoServidor, d.listadoServidor, d.listadoCliente, d.portabilidad.limites, d.portabilidad.limitesHistoria];
}
afterEach(() => vi.unstubAllGlobals());

describe('perfil del piloto: contrato explícito sin activar consumidores', () => {
  it('entrega tipos de composición reales y deriva un único límite de original', () => {
    const d = ejemplo();
    const p = crearPerfilPiloto(d);
    expectTypeOf(p.respaldo).toExtend<ComposicionRespaldoFotos>();
    expectTypeOf(p.portabilidad).toEqualTypeOf<ComposicionPortabilidad>();
    expect(p).toEqual({ origen: d.origen, maxBytesCuerpoProveedor: 67045,
      respaldoServidor: d.respaldoServidor, listadoServidor: d.listadoServidor, portabilidad: d.portabilidad,
      respaldo: { origen: d.origen, maxBytesOriginal: 1024, listado: d.listadoCliente } });
    expect(p.respaldo.listado.maxFilas).toBe(1);
    expect(p.respaldo.maxBytesOriginal).toBe(1024);
  });

  it('acepta el límite exacto multipart: 1024+65536+256+228=67044, no 12+N+B', () => {
    const d = ejemplo();
    expect(crearPerfilPiloto(d).respaldoServidor.maxBytesEntrada).toBe(67044);
    d.respaldoServidor.maxBytesEntrada = 67043;
    expect(() => crearPerfilPiloto(d)).toThrow();
    d.respaldoServidor.maxBytesEntrada = 66572; // 12+65536+1024: sólo objeto R2.
    expect(() => crearPerfilPiloto(d)).toThrow();
  });

  it('cobra cabeceras acumuladas una vez y exige entrada estrictamente menor al proveedor', () => {
    const d = ejemplo();
    d.maxBytesCuerpoProveedor = 67044;
    expect(() => crearPerfilPiloto(d)).toThrow();
    d.maxBytesCuerpoProveedor = 67043;
    expect(() => crearPerfilPiloto(d)).toThrow();
    d.maxBytesCuerpoProveedor = 67045;
    expect(crearPerfilPiloto(d).maxBytesCuerpoProveedor).toBe(67045);
    d.respaldoServidor.maxBytesCabeceras = 257;
    expect(() => crearPerfilPiloto(d)).toThrow();
  });

  it('preserva cada cero permitido, sin fallback ilimitado', () => {
    const d = ejemplo();
    for (const clave of ['maxBytesOriginal', 'maxBytesChunk', 'maxBytesCabeceras', 'maxBytesRetenidos', 'maxBloquesOriginal']) {
      (d.respaldoServidor as Record<string, number>)[clave] = 0;
    }
    d.respaldoServidor.maxBytesEntrada = 65764; // 65536+228, también con B=0.
    for (const b of [d.portabilidad.limites, d.portabilidad.limitesHistoria]) {
      for (const clave of Object.keys(b)) if (clave !== 'maxProfundidad') (b as Record<string, number>)[clave] = 0;
    }
    const p = crearPerfilPiloto(d);
    expect(p.respaldo.maxBytesOriginal).toBe(0);
    expect(p.respaldoServidor).toEqual(d.respaldoServidor);
    expect(p.portabilidad).toEqual(d.portabilidad);
  });

  it('rechaza tipos, omisiones y números inválidos en TODOS los presupuestos', () => {
    for (let i = 0; i < 5; i++) {
      for (const clave of Object.keys(presupuestos(ejemplo())[i])) {
        for (const invalido of ['1', NaN, Infinity, -Infinity, -1, 0.5, Number.MAX_SAFE_INTEGER + 1, undefined]) {
          const d = ejemplo();
          Object.defineProperty(presupuestos(d)[i], clave, { value: invalido, enumerable: true, configurable: true });
          expect(() => crearPerfilPiloto(d), `${i}/${clave}/${String(invalido)}`).toThrow();
        }
        const d = ejemplo();
        delete presupuestos(d)[i][clave];
        expect(() => crearPerfilPiloto(d)).toThrow();
      }
    }
    for (const clave of Object.keys(ejemplo())) {
      const d: Record<string, unknown> = ejemplo();
      delete d[clave];
      expect(() => crearPerfilPiloto(d)).toThrow();
    }
    for (const valor of [0, -1, '67045', NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
      expect(() => crearPerfilPiloto({ ...ejemplo(), maxBytesCuerpoProveedor: valor })).toThrow();
    }
  });

  it('aplica cotas existentes de bloque, plazo, filas, operaciones y cliente', () => {
    const casos: [number, string, number][] = [[0, 'bytesBloque', 0], [0, 'bytesBloque', 1048577],
      [0, 'plazoMs', 2147483648], [1, 'maxFilas', 9], [1, 'maxOperacionesPorFoto', 65],
      [1, 'plazoMs', 0], [2, 'maxFilas', 0], [2, 'maxBytesChunk', 4194305],
      [2, 'maxBytesBackingChunk', 4194305], [2, 'maxLecturas', 65537], [2, 'maxBytesPlan', 4194305],
      [2, 'plazoMs', 2147483648], [3, 'maxProfundidad', 0], [3, 'maxProfundidad', 257]];
    for (const [i, clave, n] of casos) {
      const d = ejemplo(); presupuestos(d)[i][clave] = n;
      expect(() => crearPerfilPiloto(d)).toThrow();
    }
    const d = ejemplo(); d.listadoCliente.maxBytesChunk = 4097;
    expect(() => crearPerfilPiloto(d)).toThrow();
    d.listadoCliente.maxBytesChunk = 4096; d.listadoCliente.maxFilas = 2;
    expect(() => crearPerfilPiloto(d)).toThrow();
  });

  it('acepta extremos legales y objetos planos sin prototipo', () => {
    const d = ejemplo();
    d.listadoServidor.maxFilas = 8; d.listadoServidor.maxOperacionesPorFoto = 64;
    d.listadoCliente.maxFilas = 8; d.listadoCliente.maxBytesChunk = 4194304;
    d.listadoCliente.maxBytesBackingChunk = 4194304; d.listadoCliente.maxLecturas = 65536;
    d.listadoCliente.maxBytesPlan = 4194304; d.portabilidad.limites.maxProfundidad = 256;
    for (const clave of ['maxBytesSql', 'maxBytesRespuesta', 'maxBytesRetenidos']) {
      (d.listadoServidor as Record<string, number>)[clave] = Number.MAX_SAFE_INTEGER;
    }
    d.listadoCliente.maxBytesPagina = 3156764;
    d.listadoCliente.maxBytesRetenidos = Number.MAX_SAFE_INTEGER;
    const p = crearPerfilPiloto(Object.assign(Object.create(null), d));
    expect(p.respaldo.listado.maxFilas).toBe(8);
    expect(p.portabilidad.limites.maxProfundidad).toBe(256);
  });

  it('comprueba mínimos normativos de catálogo independientes del constructor', () => {
    const d = ejemplo();
    d.listadoServidor.maxBytesSql = 4762546;
    d.listadoServidor.maxBytesRespuesta = 404231;
    d.listadoServidor.maxBytesRetenidos = 51431476;
    d.listadoCliente.maxBytesPagina = 404231;
    d.listadoCliente.maxBytesRetenidos = 9617520; // Mínimo sin D; la fábrica posterior cobra D real.
    expect(crearPerfilPiloto(d).listadoServidor.maxBytesRetenidos).toBe(51431476);
    for (const [i, clave] of [[1, 'maxBytesSql'], [1, 'maxBytesRespuesta'], [1, 'maxBytesRetenidos'],
      [2, 'maxBytesPagina'], [2, 'maxBytesRetenidos']] as const) {
      const copia = structuredClone(d); presupuestos(copia)[i][clave]--;
      expect(() => crearPerfilPiloto(copia)).toThrow();
    }
  });

  it('rechaza overflow seguro y el techo del objeto sin confundirlo con capacidad del proveedor', () => {
    const d = ejemplo();
    d.maxBytesCuerpoProveedor = Number.MAX_SAFE_INTEGER;
    d.respaldoServidor.maxBytesEntrada = Number.MAX_SAFE_INTEGER - 1;
    d.respaldoServidor.maxBytesOriginal = Number.MAX_SAFE_INTEGER;
    expect(() => crearPerfilPiloto(d)).toThrow();
    d.respaldoServidor.maxBytesOriginal = 0; d.respaldoServidor.maxBytesCabeceras = Number.MAX_SAFE_INTEGER;
    expect(() => crearPerfilPiloto(d)).toThrow();
    d.respaldoServidor.maxBytesCabeceras = 256;
    d.respaldoServidor.maxBytesOriginal = 5 * 1024 ** 3 - 65548;
    expect(crearPerfilPiloto(d).respaldo.maxBytesOriginal).toBe(5368643572);
    d.respaldoServidor.maxBytesOriginal++;
    expect(() => crearPerfilPiloto(d)).toThrow();
  });

  it.each(['http://piloto.example', 'https://piloto.example/', 'https://piloto.example/ruta',
    'https://usuario:clave@piloto.example', 'https://piloto.example?x=1', 'https://piloto.example#x',
    'https://PILOTO.example', 'https://piloto.example:443', ' https://piloto.example', '', null])(
    'rechaza origen no canónico: %s', (origen) => expect(() => crearPerfilPiloto({ ...ejemplo(), origen })).toThrow());

  it('captura cada nivel por valor y congela todas las composiciones y hojas', () => {
    const d = ejemplo(); const p = crearPerfilPiloto(d);
    d.origen = 'https://otro.example';
    for (const b of presupuestos(d)) for (const clave of Object.keys(b)) b[clave] = 999;
    expect(p.respaldo.maxBytesOriginal).toBe(1024);
    expect(p.respaldo.listado.maxFilas).toBe(1);
    expect(p.portabilidad.limitesHistoria.maxImportaciones).toBe(2);
    for (const b of [p, p.respaldo, p.respaldoServidor, p.listadoServidor, p.respaldo.listado,
      p.portabilidad, p.portabilidad.limites, p.portabilidad.limitesHistoria]) expect(Object.isFrozen(b)).toBe(true);
    expect(Reflect.set(p.respaldo.listado, 'maxFilas', 2)).toBe(false);
  });

  it('rechaza getters propios en todos los niveles sin ejecutarlos', () => {
    const getter = vi.fn(() => { throw new Error('No debe ejecutarse'); });
    for (let i = 0; i < 7; i++) {
      const d = ejemplo(); const objetos = [d, d.portabilidad, ...presupuestos(d)];
      Object.defineProperty(objetos[i], Object.keys(objetos[i])[0], { get: getter, enumerable: true });
      expect(() => crearPerfilPiloto(d)).toThrow();
    }
    expect(getter).not.toHaveBeenCalled();
  });

  it('rechaza objetos no planos, secretos, callbacks, símbolos y campos ocultos', () => {
    for (const valor of [null, [], new Date(), Object.create(ejemplo()), { ...ejemplo(), clave: 'no-admitida' },
      { ...ejemplo(), fetch: () => {} }, { ...ejemplo(), [Symbol('extra')]: 1 }]) expect(() => crearPerfilPiloto(valor)).toThrow();
    const d = ejemplo(); Object.defineProperty(d, 'origen', { enumerable: false });
    expect(() => crearPerfilPiloto(d)).toThrow();
    expect(() => crearPerfilPiloto({ ...ejemplo(), respaldoServidor: [] })).toThrow();
  });

  it('no llama red, almacenamiento, DOM ni timers al importar y validar', async () => {
    const io = vi.fn(() => { throw new Error('IO prohibido'); });
    for (const clave of ['fetch', 'indexedDB', 'localStorage', 'document', 'navigator']) vi.stubGlobal(clave, io);
    const modulo = await import('../src/perfil-piloto');
    vi.stubGlobal('setTimeout', io);
    expect(modulo.crearPerfilPiloto(ejemplo())).not.toBeInstanceOf(Promise);
    expect(io).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });
});
