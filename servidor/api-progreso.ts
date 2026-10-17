import type { Itinerario } from '../src/tipos';
import { identidades } from '../src/identidades';
import { aplicarOperacion, type Operacion } from '../src/progreso';
import { campos, iguales } from '../src/progreso-validacion';
import { serializarProgreso } from '../src/progreso-json';
import {
  capturarOperacionProgreso, capturarInstantaneaProgreso, capturarAcusePersistido,
  capturarRechazoPersistido, type AcusePersistido, type RechazoPersistido,
} from '../src/progreso-cola';
import type { InstantaneaProgreso } from '../src/progreso-validacion';
import type { ControladorSesiones } from './sesiones';
import { borrarCookieSesion } from './credenciales';
import { comprobarOrigen, FalloHttp, leerJsonAcotado, respuestaJson } from './http';

const LIMITE_CUERPO_BYTES = 64 * 1024;
const LIMITE_IDENTIDAD_BYTES = 128;
const ERROR_SISTEMA = 'No se pudo comprobar el progreso.';
const codificador = new TextEncoder();

// Uniones documentadas del adaptador; el controlador SIEMPRE recibe unknown y las valida.
export type ResultadoLecturaProgreso = { readonly tipo: 'instantanea'; readonly instantanea: InstantaneaProgreso }
  | { readonly tipo: 'sin-sesion' };
export type ResultadoProcesoProgreso = { readonly tipo: 'confirmada'; readonly acuse: AcusePersistido }
  | { readonly tipo: 'rechazada'; readonly rechazo: RechazoPersistido }
  | { readonly tipo: 'identidad-reutilizada' | 'sin-sesion' };

/** Puerto obligatorio, sin implementación SQL ni persistencia simulada de producción.
 * Revalidar actor no revocado, no caducado y del viaje DENTRO de la lectura/operación atómica.
 * procesar resuelve solo tras commit durable de estado + recibo + contador, o ledger negativo
 * separado + contador. CAS perdido relee/reaplica dentro del almacén, nunca en este controlador.
 * Mismo ID/payload conserva tipo y DTO histórico originales; otro payload = cuarentena,
 * NO prueba negativa. Retener resultados positivos y negativos mutuamente excluyentes.
 * POST admite una Operacion directa de hasta 64 KiB; IDs opacos/dispositivo/original de
 * deshacer: 1–128 bytes UTF-8 exactos, sin NUL ni sustitutos aislados (compatibles con PG).
 * El dispositivo es metadato, no autoridad: puede proceder de una sesión anterior.
 */
export interface RepositorioProgreso {
  leer(huellaActor: string, viajeId: string): Promise<unknown>;
  procesar(huellaActor: string, viajeId: string, operacion: Operacion): Promise<unknown>;
}
export interface ConfiguracionProgreso {
  readonly plan: Itinerario;
  readonly autenticar: ControladorSesiones['autenticar'];
  readonly repositorio: RepositorioProgreso;
}
export interface ControladorProgreso { atender(solicitud: Request): Promise<Response> }

function identidad(valor: string): boolean {
  const bytes = codificador.encode(valor);
  return valor.length > 0 && !valor.includes('\0') && bytes.length <= LIMITE_IDENTIDAD_BYTES
    && new TextDecoder('utf-8', { fatal: true }).decode(bytes) === valor;
}
// Inspeccionar descriptores del sobre antes de leer discriminantes o valores del adaptador.
function sobre(valor: unknown, requeridos: readonly string[]): valor is Record<string, unknown> {
  return campos(valor, requeridos) && requeridos.every((campo) =>
    Object.hasOwn(Object.getOwnPropertyDescriptor(valor, campo)!, 'value'));
}
function etag(viajeId: string, revision: number): string {
  // JSON delimita sin alias; hex de cada unidad UTF-16 conserva identidad exacta incluso
  // para IDs de plan no ASCII. No representa secretos, firma ni autorización.
  const viaje = Array.from({ length: viajeId.length }, (_, i) => viajeId.charCodeAt(i).toString(16).padStart(4, '0')).join('');
  return `"progreso-1-${viaje}-${revision}"`;
}
async function puerto<T>(ejecutar: () => Promise<T>): Promise<T> {
  try { return await ejecutar(); } catch { throw new Error(ERROR_SISTEMA); }
}
// Solo DTO capturado de dominio: el helper HTTP genérico sigue fuera de esta frontera.
function respuestaProgreso(datos: unknown, estado = 200): Response {
  return new Response(serializarProgreso(datos), { status: estado, headers: {
    'Cache-Control': 'private, no-store', 'Vary': 'Cookie',
    'Content-Type': 'application/json; charset=utf-8', 'X-Content-Type-Options': 'nosniff',
  } });
}
const sinSesion = () => {
  const respuesta = respuestaJson({ error: 'Se necesita una sesión vigente.' }, 401);
  respuesta.headers.set('Set-Cookie', borrarCookieSesion());
  return respuesta;
};

/** API pura: GET entrega instantánea directa; POST 200 entrega AcusePersistido directo
 * solo después del puerto durable; 409 entrega rechazo histórico o cuarentena sin decisión.
 * If-None-Match usa únicamente igualdad exacta con ETag fuerte: listas, * y débiles se
 * contestan 200 (optimización conservadora, no un parser general de condicionales HTTP).
 * Todo 304 autentica y revalida en repositorio antes de omitir el cuerpo; reduce bytes de
 * polling sin demostrar métricas reales de red. TLS/gate/router pertenecen al futuro Worker.
 */
export function crearControladorProgreso(configuracion: ConfiguracionProgreso): ControladorProgreso {
  const { plan, autenticar, repositorio } = configuracion;
  // Conocidas (activas y retiradas del mismo viaje): el replay de lo ya aceptado conserva su acuse y una nueva
  // sobre una retirada llega al almacén, que la rechaza y lo deja persistido. Lo desconocido sigue en 400.
  const { paradas: { conocidas: paradas }, pendientes: { conocidas: pendientes } } = identidades(plan);
  const operacionValida = (op: Operacion): boolean => {
    if (!identidad(op.id) || !identidad(op.dispositivoId)) return false;
    if (op.tipo === 'parada') return paradas.has(op.paradaId);
    if (op.tipo === 'pendiente') return pendientes.has(op.pendienteId);
    return identidad(op.cambios.operacionId) && op.cambios.registros.every((c) =>
      (c.tipo === 'parada' ? paradas : pendientes).has(c.id))
      && (!op.cambios.aqui || [op.cambios.aqui.antes, op.cambios.aqui.despues].every((aqui) =>
        aqui.paradaId === null || paradas.has(aqui.paradaId)));
  };
  return Object.freeze({
    async atender(solicitud: Request): Promise<Response> {
      try {
        if (new URL(solicitud.url).pathname !== '/api/progreso') return respuestaJson({ error: 'Ruta no encontrada.' }, 404);
        if (solicitud.method !== 'GET' && solicitud.method !== 'POST') {
          const respuesta = respuestaJson({ error: 'Método no permitido.' }, 405);
          respuesta.headers.set('Allow', 'GET, POST');
          return respuesta;
        }
        if (solicitud.method === 'POST') comprobarOrigen(solicitud);
        const actor = await puerto(() => autenticar(solicitud));
        if (!actor || actor.viajeId !== plan.id) return sinSesion();
        if (solicitud.signal.aborted) throw new FalloHttp(400);
        if (solicitud.method === 'GET') {
          const resultado = await puerto(() => repositorio.leer(actor.huella, plan.id));
          if (sobre(resultado, ['tipo']) && resultado.tipo === 'sin-sesion') return sinSesion();
          if (!sobre(resultado, ['tipo', 'instantanea']) || resultado.tipo !== 'instantanea') throw new Error(ERROR_SISTEMA);
          const instantanea = capturarInstantaneaProgreso(plan, resultado.instantanea);
          if (!instantanea) throw new Error(ERROR_SISTEMA);
          const etiqueta = etag(plan.id, instantanea.revisionServidor);
          const respuesta = respuestaProgreso(instantanea);
          respuesta.headers.set('ETag', etiqueta);
          return solicitud.headers.get('If-None-Match') === etiqueta
            ? new Response(null, { status: 304, headers: respuesta.headers }) : respuesta;
        }
        const original = capturarOperacionProgreso(await leerJsonAcotado(solicitud, LIMITE_CUERPO_BYTES));
        if (!original || !operacionValida(original)) throw new FalloHttp(400);
        if (solicitud.signal.aborted) throw new FalloHttp(400);
        // Una copia independiente impide que un adaptador altere la prueba del original.
        const resultado = await puerto(() => repositorio.procesar(actor.huella, plan.id, capturarOperacionProgreso(original)!));
        if (sobre(resultado, ['tipo'])) {
          if (resultado.tipo === 'sin-sesion') return sinSesion();
          if (resultado.tipo === 'identidad-reutilizada') return respuestaJson({ codigo: 'identidad-reutilizada',
            error: 'La identidad de operación ya tiene otro contenido.' }, 409);
        }
        if (sobre(resultado, ['tipo', 'acuse']) && resultado.tipo === 'confirmada') {
          const acuse = capturarAcusePersistido(plan, resultado.acuse);
          if (!acuse || acuse.operacionId !== original.id
            || aplicarOperacion(plan, acuse.instantanea.estado, original).tipo !== 'duplicada') throw new Error(ERROR_SISTEMA);
          return respuestaProgreso(acuse);
        }
        if (sobre(resultado, ['tipo', 'rechazo']) && resultado.tipo === 'rechazada') {
          const rechazo = capturarRechazoPersistido(plan, resultado.rechazo);
          if (!rechazo || !iguales(rechazo.operacionOriginal, original)) throw new Error(ERROR_SISTEMA);
          return respuestaProgreso(rechazo, 409);
        }
        throw new Error(ERROR_SISTEMA);
      } catch (error) {
        // Solo errores de lectura/origen generados aquí son públicos. Fallos de puertos,
        // incluidos FalloHttp de adaptadores, nunca divulgan ni inventan decisiones.
        if (error instanceof FalloHttp) return respuestaJson({ error: error.message }, error.codigo);
        return respuestaJson({ error: ERROR_SISTEMA }, 503);
      }
    },
  });
}
