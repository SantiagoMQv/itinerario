import type { EjecutorSql } from './contratos';
import type { RepositorioSesiones } from './sesiones';
import { parsearProgreso } from '../src/progreso-json';

const ERROR = 'No se pudo comprobar la sesión.';
const fallar = (): never => { throw new Error(ERROR); };

// Datos propios exactos (también ocultos), sin invocar getters ni admitir prototipos extra.
function capturar(valor: unknown, claves: readonly string[]): Record<string, unknown> {
  if (valor === null || typeof valor !== 'object' || Object.getPrototypeOf(valor) !== Object.prototype) return fallar();
  const copia: Record<string, unknown> = {};
  const propias = Reflect.ownKeys(valor);
  if (propias.length !== claves.length) return fallar();
  for (const clave of propias) {
    if (typeof clave !== 'string' || !claves.includes(clave)) return fallar();
    const descriptor = Object.getOwnPropertyDescriptor(valor, clave);
    if (!descriptor || !Object.hasOwn(descriptor, 'value')) return fallar();
    Object.defineProperty(copia, clave, { value: descriptor.value, enumerable: true });
  }
  return copia;
}

/** Un SELECT ligado, atómico y persistente. El ejecutor confirma commit antes de resolver.
 * La huella ya incluye viaje y red confiable; no almacenar IP, clave, token ni DeviceID.
 * Respuesta perdida es incertidumbre: rechazar, no fingir denegación ni reintentar aquí.
 * Repetir puede consumir otro intento: este protocolo no promete idempotencia de login.
 */
export function crearAlmacenIntentosSql(configuracion: { readonly ejecutor: EjecutorSql }): Pick<RepositorioSesiones, 'admitirIntento'> {
  let ejecutor: EjecutorSql;
  let ejecutar: EjecutorSql['ejecutar'];
  try {
    ejecutor = capturar(configuracion, ['ejecutor']).ejecutor as EjecutorSql;
    ejecutar = capturar(ejecutor, ['ejecutar']).ejecutar as EjecutorSql['ejecutar'];
    if (typeof ejecutar !== 'function') return fallar();
  } catch { return fallar(); }
  return Object.freeze({
    async admitirIntento(huellaOrigen: string, ahora: number): Promise<boolean> {
      try {
        if (typeof huellaOrigen !== 'string' || huellaOrigen.length !== 64 || !/^[0-9a-f]{64}$/.test(huellaOrigen)
          || typeof ahora !== 'number' || !Number.isSafeInteger(ahora) || ahora < 0) return fallar();
        const resultado = capturar(await ejecutar.call(ejecutor,
          'SELECT itinerario.admitir_intento($1, $2) AS resultado', [huellaOrigen, ahora]), ['filas']);
        const filas = resultado.filas;
        if (!Array.isArray(filas) || Object.getPrototypeOf(filas) !== Array.prototype
          || Object.getOwnPropertyDescriptor(filas, 'length')?.value !== 1
          || Reflect.ownKeys(filas).length !== 2) return fallar();
        const descriptor = Object.getOwnPropertyDescriptor(filas, '0');
        if (!descriptor || !Object.hasOwn(descriptor, 'value')) return fallar();
        const fila = capturar(descriptor.value, ['resultado']);
        const decision = parsearProgreso(fila.resultado);
        if (typeof decision !== 'boolean') return fallar();
        return decision;
      } catch { return fallar(); }
    },
  });
}
