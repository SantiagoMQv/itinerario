import type { VinculoAssets } from './contratos';
import type { ControladorProgreso } from './api-progreso';
import type { ControladorSesiones, ContextoSolicitudSesion } from './sesiones';
import { FalloHttp, respuestaJson } from './http';
import type { AtencionFotosWorker } from './composicion-fotos';

export interface ConfiguracionRouterViaje {
  readonly sesiones: ControladorSesiones;
  readonly progreso: ControladorProgreso;
  readonly assets: VinculoAssets;
  readonly fotos?: AtencionFotosWorker;
  // Puerto obligatorio de la UI real; sin página ficticia ni fallback a ASSETS.
  readonly proveerRespuestaEntrada: (solicitud: Request) => Promise<Response>;
}
export interface RouterViaje {
  atender(solicitud: Request, contexto?: ContextoSolicitudSesion): Promise<Response>;
}
const ERROR_CONFIGURACION = 'La configuración del router no es válida.';
const ERROR_SISTEMA = 'No se puede atender la solicitud ahora.';

// Solo campos propios de datos: no ejecutar getters ni aceptar símbolos/campos extra.
function capturar(valor: unknown, nombres: readonly string[]): Record<string, unknown> {
  if (!valor || typeof valor !== 'object' || Array.isArray(valor)) throw new Error(ERROR_CONFIGURACION);
  const claves = Reflect.ownKeys(valor);
  if (claves.length !== nombres.length || claves.some((c) => typeof c !== 'string' || !nombres.includes(c))) {
    throw new Error(ERROR_CONFIGURACION);
  }
  const copia: Record<string, unknown> = {};
  for (const nombre of nombres) {
    const descriptor = Object.getOwnPropertyDescriptor(valor, nombre);
    if (!descriptor || !Object.hasOwn(descriptor, 'value')) throw new Error(ERROR_CONFIGURACION);
    copia[nombre] = descriptor.value;
  }
  return copia;
}
function metodos(valor: unknown, nombres: readonly string[]): Record<string, (...args: never[]) => unknown> {
  const copia = capturar(valor, nombres);
  const resultado: Record<string, (...args: never[]) => unknown> = {};
  for (const nombre of nombres) {
    const metodo = copia[nombre];
    if (typeof metodo !== 'function') throw new Error(ERROR_CONFIGURACION);
    resultado[nombre] = metodo.bind(valor);
  }
  return resultado;
}
function contextoSeguro(valor: unknown): ContextoSolicitudSesion | undefined {
  if (valor === undefined) return undefined;
  const { identidadRed } = capturar(valor, ['identidadRed']);
  if (typeof identidadRed !== 'string' || !identidadRed.length || identidadRed.includes('\0') ||
    new TextEncoder().encode(identidadRed).length > 256 ||
    new TextDecoder('utf-8', { fatal: true }).decode(new TextEncoder().encode(identidadRed)) !== identidadRed) {
    throw new Error(ERROR_CONFIGURACION);
  }
  return Object.freeze({ identidadRed });
}
function privada(respuesta: Response, solicitud: Request, entrada = false): Response {
  if (!(respuesta instanceof Response) || respuesta.bodyUsed || respuesta.body?.locked) throw new Error(ERROR_SISTEMA);
  const headers = new Headers(respuesta.headers);
  headers.set('Cache-Control', 'private, no-store');
  headers.set('Pragma', 'no-cache');
  headers.set('X-Content-Type-Options', 'nosniff');
  const vary = headers.get('Vary');
  if (!vary?.split(',').some((v) => v.trim().toLowerCase() === 'cookie')) {
    headers.set('Vary', vary ? `${vary}, Cookie` : 'Cookie');
  }
  // La entrada no emite credenciales. Solo la API de sesiones puede iniciar sesión.
  if (entrada) headers.delete('Set-Cookie');
  return new Response(solicitud.method === 'HEAD' ? null : respuesta.body, {
    status: respuesta.status, statusText: respuesta.statusText, headers,
  });
}
function errorPrivado(solicitud: Request, estado: number, mensaje: string, permitir?: string): Response {
  const respuesta = respuestaJson({ error: mensaje }, estado);
  if (permitir) respuesta.headers.set('Allow', permitir);
  return privada(respuesta, solicitud);
}
/** Sólo las dos formas existentes; método e identidad pertenecen al controlador A. */
export function esRutaFotos(ruta: string): boolean {
  return ruta === '/api/fotos/respaldo' || /^\/api\/fotos\/([^/]+)\/original$/.test(ruta);
}
function navegacion(solicitud: Request): boolean {
  if (solicitud.mode === 'navigate' || solicitud.destination === 'document') return true;
  return (solicitud.headers.get('Accept') ?? '').split(',').some((rango) => {
    const [tipo, ...parametros] = rango.trim().toLowerCase().split(';');
    if (tipo.trim() !== 'text/html') return false;
    const pesos = parametros.map((p) => p.trim()).filter((p) => p.startsWith('q='));
    return pesos.length === 0 || (pesos.length === 1 &&
      /^q=(?:0(?:\.\d{1,3})?|1(?:\.0{1,3})?)$/.test(pesos[0]) && Number(pesos[0].slice(2)) > 0);
  });
}

/** Router Web API puro, exclusivamente HTTPS (HTTP devuelve 400, nunca redirige).
 * API primero y sin segunda autenticación; /entrar pública siempre, incluso con cookie.
 * El futuro Worker debe configurar assets.run_worker_first=true: aquí no hay despliegue.
 * no-store no impide copias offline/CacheStorage ni promete borrarlas al revocar.
 */
export function crearRouterViaje(configuracion: ConfiguracionRouterViaje): RouterViaje {
  let sesiones: ControladorSesiones, progreso: ControladorProgreso, assets: VinculoAssets;
  let proveerRespuestaEntrada: ConfiguracionRouterViaje['proveerRespuestaEntrada'];
  let fotos: AtencionFotosWorker | undefined;
  try {
    const nombres = ['sesiones', 'progreso', 'assets', 'proveerRespuestaEntrada'];
    if (Object.hasOwn(configuracion, 'fotos')) nombres.push('fotos');
    const c = capturar(configuracion, nombres);
    if (c.fotos !== undefined) fotos = metodos(c.fotos, ['atender']) as unknown as AtencionFotosWorker;
    sesiones = metodos(c.sesiones, ['atender', 'autenticar']) as unknown as ControladorSesiones;
    progreso = metodos(c.progreso, ['atender']) as unknown as ControladorProgreso;
    assets = metodos(c.assets, ['fetch']) as unknown as VinculoAssets;
    if (typeof c.proveerRespuestaEntrada !== 'function') throw new Error(ERROR_CONFIGURACION);
    proveerRespuestaEntrada = c.proveerRespuestaEntrada as ConfiguracionRouterViaje['proveerRespuestaEntrada'];
  } catch { throw new Error(ERROR_CONFIGURACION); }
  return Object.freeze({
    async atender(solicitud: Request, contexto?: ContextoSolicitudSesion): Promise<Response> {
      try {
        const url = new URL(solicitud.url);
        if (url.protocol !== 'https:') return errorPrivado(solicitud, 400, new FalloHttp(400).message);
        const ruta = url.pathname;
        // Se conserva el Request original: Origin, cuerpo, cookie y señal son del controlador.
        if (ruta === '/api/sesion' || ruta === '/api/sesiones' || ruta.startsWith('/api/sesiones/')) {
          return await sesiones.atender(solicitud, contextoSeguro(contexto));
        }
        if (ruta === '/api/progreso') return await progreso.atender(solicitud);
        if (esRutaFotos(ruta)) {
          return fotos ? await fotos.atender(solicitud) : errorPrivado(solicitud, 503, ERROR_SISTEMA);
        }
        if (ruta === '/api' || ruta.startsWith('/api/')) return errorPrivado(solicitud, 404, 'Ruta no encontrada.');
        if (solicitud.method !== 'GET' && solicitud.method !== 'HEAD') {
          return errorPrivado(solicitud, 405, 'Método no permitido.', 'GET, HEAD');
        }
        if (ruta === '/entrar') {
          const respuesta = await proveerRespuestaEntrada(solicitud);
          if (!(respuesta instanceof Response) || respuesta.status !== 200 ||
            respuesta.headers.get('Content-Type')?.split(';', 1)[0].trim().toLowerCase() !== 'text/html') {
            throw new Error(ERROR_SISTEMA);
          }
          return privada(respuesta, solicitud, true);
        }
        // No leer identidad de red de cabeceras/cuerpo/query, ni reutilizar autoridad entre requests.
        const actor = await sesiones.autenticar(solicitud);
        if (!actor) {
          return navegacion(solicitud)
            ? privada(new Response(null, { status: 303, headers: { Location: '/entrar' } }), solicitud)
            : errorPrivado(solicitud, 401, 'Se necesita una sesión vigente.');
        }
        const respuesta = await assets.fetch(solicitud);
        if (!(respuesta instanceof Response) || respuesta.status >= 500) throw new Error(ERROR_SISTEMA);
        return privada(respuesta, solicitud);
      } catch {
        // Sin mensajes/cause/stack del proveedor, sin borrar cookie ni fallback ante DB caída.
        return errorPrivado(solicitud, 503, ERROR_SISTEMA);
      }
    },
  });
}
