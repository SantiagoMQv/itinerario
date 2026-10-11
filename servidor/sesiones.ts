import {
  borrarCookieSesion, formatearCookieSesion, type crearCredenciales,
} from './credenciales';
import { comprobarOrigen, FalloHttp, leerJsonAcotado, respuestaJson } from './http';

const DURACION_SESION_MS = 30 * 24 * 60 * 60 * 1000;
const ERROR_CONFIGURACION = 'La configuración de sesiones no es válida.';
const ERROR_SISTEMA = 'No se pudo comprobar la sesión.';
const codificador = new TextEncoder();
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

// UTC del servidor en milisegundos, independiente del reloj operativo de China.
export interface RegistroSesion {
  readonly id: string;
  readonly huella: string;
  readonly viajeId: string;
  readonly dispositivoId: string;
  readonly creadaEn: number;
  readonly venceEn: number;
  readonly revocada: boolean;
  readonly nombreDispositivo?: string;
}

// Solo estos campos pueden salir en JSON. Los identificadores públicos NO autentican.
export interface SesionPublica {
  readonly id: string;
  readonly viajeId: string;
  readonly dispositivoId: string;
  readonly venceEn: number;
  readonly nombreDispositivo?: string;
}
export interface RespuestaSesion { readonly sesion: SesionPublica | null }
export interface SesionDispositivo extends SesionPublica { readonly actual: boolean }
export interface RespuestaDispositivos { readonly sesiones: readonly SesionDispositivo[] }
export type ResultadoListado = { readonly tipo: 'lista'; readonly sesiones: readonly unknown[] }
  | { readonly tipo: 'sin-sesion' };
export type ResultadoRevocacion = 'revocada' | 'ausente' | 'sin-sesion';
export interface EntradaSesion {
  readonly clave: unknown;
  readonly dispositivoId: string;
  readonly nombreDispositivo?: string;
}

// Puerto obligatorio: nunca sustituirlo por memoria en producción.
export interface RepositorioSesiones {
  // Resuelve EXCLUSIVAMENTE tras confirmar persistencia duradera; no al recibir el registro.
  crear(registro: RegistroSesion): Promise<void>;
  // El adaptador SQL decodifica columnas, pero la frontera valida el objeto desconocido.
  leer(huella: string): Promise<unknown | null>;
  // Duradera, idempotente y limitada al viaje; no afecta copias offline.
  revocar(huella: string, viajeId: string): Promise<void>;
  // Atómica y persistida: máximo 10 intentos por huella en ventana de 600_000 ms.
  // Ventana inicia en el primer intento admitido; reinicia si ahora >= inicio + 600_000.
  // Dentro de la ventana cuenta éxitos y claves erróneas; denegados no incrementan.
  // Reloj regresivo no reinicia la ventana. No almacenar/loguear identidad de red cruda.
  admitirIntento(huellaOrigen: string, ahora: number): Promise<boolean>;
  // El futuro SQL debe revalidar actor vivo, viaje y caducidad DENTRO de cada operación
  // atómica; la lectura previa del controlador no basta. listar devuelve ResultadoListado,
  // pero la frontera recibe unknown y valida todas las filas antes de filtrar/publicar.
  // Sin límite arbitrario que oculte sesiones: presupuestar bytes/paginación en SQL futuro.
  listar(huellaActor: string, viajeId: string): Promise<unknown>;
  // Confirmar commit antes de resolver. Objetivo ajeno al viaje = ausente; objetivo ya
  // revocado del mismo viaje = revocada mientras el actor siga válido. Permite autorrevocar.
  // SQL futuro: bloquear AMBAS filas en orden determinista ANTES de validar/escribir;
  // ShareLock del actor seguido de Update del otro puede causar deadlock al cruzar A/B.
  // Callbacks de prueba solo prueban este contrato, no locks ni aislamiento PostgreSQL.
  revocarOtra(huellaActor: string, viajeId: string, objetivoId: string): Promise<ResultadoRevocacion>;
}
export interface ConfiguracionSesiones {
  readonly viajeId: string;
  // El router debe esperar crearCredenciales antes de construir/servir el controlador.
  readonly credenciales: Awaited<ReturnType<typeof crearCredenciales>>;
  readonly repositorio: RepositorioSesiones;
  readonly reloj?: () => number;
}
export interface ContextoSolicitudSesion {
  // Solo el router de confianza (futuro CF edge), nunca cuerpo ni cabecera elegida por cliente.
  readonly identidadRed: string;
}
export interface ControladorSesiones {
  atender(solicitud: Request, contexto?: ContextoSolicitudSesion): Promise<Response>;
  // Gate futuro de assets/progreso: null = no autenticada; FalloSesion = sistema caído.
  // Nunca convertir ese error en null ni permitir fallback a assets.
  autenticar(solicitud: Request): Promise<RegistroSesion | null>;
}
export class FalloSesion extends Error {
  constructor() { super(ERROR_SISTEMA); this.name = 'FalloSesion'; }
}

function textoValido(valor: unknown): valor is string {
  if (typeof valor !== 'string' || valor.length === 0) return false;
  // La ida/vuelta exacta rechaza sustitutos aislados, sin normalizar metadatos.
  return new TextDecoder('utf-8', { fatal: true }).decode(codificador.encode(valor)) === valor;
}
function identificador(valor: unknown, maximo = 128): valor is string {
  return textoValido(valor) && codificador.encode(valor).length <= maximo;
}
function nombre(valor: unknown): valor is string {
  return textoValido(valor) && Array.from(valor).length <= 80;
}
function tiempoValido(valor: unknown): valor is number {
  return typeof valor === 'number' && Number.isSafeInteger(valor) && valor >= 0;
}

// Comprobar el original antes de copiar: incluye campos ocultos/símbolos y no ejecuta getters.
function camposExactos(valor: unknown, requeridos: readonly string[], opcionales: readonly string[]): valor is Record<string, unknown> {
  if (valor === null || typeof valor !== 'object' || Object.getPrototypeOf(valor) !== Object.prototype) return false;
  const campos = Reflect.ownKeys(valor);
  if (!requeridos.every((campo) => Object.hasOwn(valor, campo))) return false;
  return campos.every((campo) => {
    if (typeof campo !== 'string' || ![...requeridos, ...opcionales].includes(campo)) return false;
    const descriptor = Object.getOwnPropertyDescriptor(valor, campo)!;
    return Object.hasOwn(descriptor, 'value');
  });
}
function entradaValida(valor: unknown): valor is EntradaSesion {
  return camposExactos(valor, ['clave', 'dispositivoId'], ['nombreDispositivo']) &&
    identificador(valor.dispositivoId) &&
    (!Object.hasOwn(valor, 'nombreDispositivo') || nombre(valor.nombreDispositivo));
}
function registroValidado(valor: unknown, huella: string): RegistroSesion {
  if (!camposExactos(valor, ['id', 'huella', 'viajeId', 'dispositivoId', 'creadaEn', 'venceEn', 'revocada'], ['nombreDispositivo']) ||
    typeof valor.id !== 'string' || !uuid.test(valor.id) ||
    typeof valor.huella !== 'string' || !/^[0-9a-f]{64}$/.test(valor.huella) || valor.huella !== huella ||
    !identificador(valor.viajeId) || !identificador(valor.dispositivoId) ||
    !tiempoValido(valor.creadaEn) || !tiempoValido(valor.venceEn) || valor.creadaEn > valor.venceEn ||
    typeof valor.revocada !== 'boolean' ||
    (Object.hasOwn(valor, 'nombreDispositivo') && !nombre(valor.nombreDispositivo))) throw new FalloSesion();
  // Copia explícita después de validar, sin retener un objeto mutable del adaptador.
  return Object.freeze({
    id: valor.id, huella: valor.huella, viajeId: valor.viajeId, dispositivoId: valor.dispositivoId,
    creadaEn: valor.creadaEn, venceEn: valor.venceEn, revocada: valor.revocada,
    ...(Object.hasOwn(valor, 'nombreDispositivo') ? { nombreDispositivo: valor.nombreDispositivo as string } : {}),
  });
}
function listadoValidado(valor: unknown, actor: RegistroSesion): readonly RegistroSesion[] | null {
  if (camposExactos(valor, ['tipo'], []) && valor.tipo === 'sin-sesion') return null;
  if (!camposExactos(valor, ['tipo', 'sesiones'], []) || valor.tipo !== 'lista' ||
    !Array.isArray(valor.sesiones) || Object.getPrototypeOf(valor.sesiones) !== Array.prototype) throw new FalloSesion();
  const filas = valor.sesiones;
  // Densa, sin propiedades extra/símbolos ni accesores. No ejecutar getters del adaptador.
  if (Reflect.ownKeys(filas).length !== filas.length + 1) throw new FalloSesion();
  const ids = new Set<string>();
  const huellas = new Set<string>();
  const registros: RegistroSesion[] = [];
  for (let i = 0; i < filas.length; i++) {
    const descriptor = Object.getOwnPropertyDescriptor(filas, String(i));
    if (!descriptor || !Object.hasOwn(descriptor, 'value')) throw new FalloSesion();
    const fila: unknown = descriptor.value;
    const huella = fila !== null && typeof fila === 'object'
      ? Object.getOwnPropertyDescriptor(fila, 'huella')?.value : undefined;
    const registro = registroValidado(fila, huella);
    if (registro.viajeId !== actor.viajeId || ids.has(registro.id) || huellas.has(registro.huella) ||
      (registro.id === actor.id) !== (registro.huella === actor.huella)) throw new FalloSesion();
    ids.add(registro.id);
    huellas.add(registro.huella);
    registros.push(registro);
  }
  return registros;
}
function publica(registro: RegistroSesion): SesionPublica {
  return {
    id: registro.id, viajeId: registro.viajeId, dispositivoId: registro.dispositivoId, venceEn: registro.venceEn,
    ...(Object.hasOwn(registro, 'nombreDispositivo') ? { nombreDispositivo: registro.nombreDispositivo } : {}),
  };
}
function responder(sesion: SesionPublica | null, estado: number, cookie?: string): Response {
  const respuesta = respuestaJson({ sesion } satisfies RespuestaSesion, estado);
  if (cookie !== undefined) respuesta.headers.set('Set-Cookie', cookie);
  return respuesta;
}

export function crearControladorSesiones(configuracion: ConfiguracionSesiones): ControladorSesiones {
  const { viajeId, credenciales, repositorio, reloj = Date.now } = configuracion;
  if (!identificador(viajeId) || typeof reloj !== 'function' ||
    !credenciales || !['verificarClave', 'emitirSesion', 'leerCookie'].every((campo) => typeof Reflect.get(credenciales, campo) === 'function') ||
    !repositorio || !['crear', 'leer', 'revocar', 'admitirIntento', 'listar', 'revocarOtra'].every((campo) => typeof Reflect.get(repositorio, campo) === 'function')) {
    throw new Error(ERROR_CONFIGURACION);
  }
  const leerReloj = () => {
    const ahora = reloj();
    if (!tiempoValido(ahora)) throw new FalloSesion();
    return ahora;
  };
  const autenticar = async (solicitud: Request): Promise<RegistroSesion | null> => {
    try {
      const huella = await credenciales.leerCookie(solicitud.headers.get('Cookie'));
      if (huella === null) return null;
      const desconocido = await repositorio.leer(huella);
      if (desconocido === null) return null;
      const registro = registroValidado(desconocido, huella);
      // La DB siempre es autoridad y el tiempo se toma DESPUÉS de la lectura pendiente.
      const ahora = leerReloj();
      return registro.viajeId === viajeId && !registro.revocada && registro.venceEn > ahora ? registro : null;
    } catch { throw new FalloSesion(); }
  };
  const entrar = async (solicitud: Request, contexto?: ContextoSolicitudSesion): Promise<Response> => {
    comprobarOrigen(solicitud);
    const entrada = await leerJsonAcotado(solicitud, 4096);
    if (!entradaValida(entrada)) throw new FalloHttp(400);
    if (!identificador(contexto?.identidadRed, 256)) throw new FalloSesion();
    // JSON delimita viaje/red sin alias de concatenación; SHA-256 nativo, sin IP en logs.
    const bytes = codificador.encode(JSON.stringify(['itinerario', 'v1', 'intento-sesion', viajeId, contexto.identidadRed]));
    const resumen = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
    const huellaOrigen = Array.from(resumen, (byte) => byte.toString(16).padStart(2, '0')).join('');
    const admitido = await repositorio.admitirIntento(huellaOrigen, leerReloj());
    if (admitido === false) {
      const respuesta = respuestaJson({ error: 'Demasiados intentos. Esperá antes de volver a entrar.' }, 429);
      respuesta.headers.set('Retry-After', '600');
      return respuesta;
    }
    if (admitido !== true) throw new FalloSesion();
    if (!await credenciales.verificarClave(entrada.clave)) return respuestaJson({ error: 'La clave no es válida.' }, 401);
    if (solicitud.signal.aborted) throw new FalloHttp(400);
    const { token, huella } = await credenciales.emitirSesion();
    const creadaEn = leerReloj();
    if (creadaEn > Number.MAX_SAFE_INTEGER - DURACION_SESION_MS) throw new FalloSesion();
    const registro = registroValidado({
      id: crypto.randomUUID(), huella, viajeId, dispositivoId: entrada.dispositivoId,
      creadaEn, venceEn: creadaEn + DURACION_SESION_MS, revocada: false,
      ...(Object.hasOwn(entrada, 'nombreDispositivo') ? { nombreDispositivo: entrada.nombreDispositivo } : {}),
    }, huella);
    // Formatear antes de persistir evita una escritura si los datos criptográficos son inválidos.
    const cookie = formatearCookieSesion(token);
    if (solicitud.signal.aborted) throw new FalloHttp(400);
    await repositorio.crear(registro);
    return responder(publica(registro), 201, cookie);
  };
  const dispositivos = async (solicitud: Request, ruta: string): Promise<Response> => {
    const esListado = ruta === '/api/sesiones';
    const metodo = esListado ? 'GET' : 'DELETE';
    if (solicitud.method !== metodo) {
      const respuesta = respuestaJson({ error: 'Método no permitido.' }, 405);
      respuesta.headers.set('Allow', metodo);
      return respuesta;
    }
    let objetivoId = '';
    if (!esListado) {
      comprobarOrigen(solicitud); // Antes de autenticar o consultar cualquier puerto.
      try { objetivoId = decodeURIComponent(ruta.slice('/api/sesiones/'.length)).toLowerCase(); }
      catch { throw new FalloHttp(400); }
      if (!uuid.test(objetivoId)) throw new FalloHttp(400);
    }
    const sinSesion = () => responder(null, 401, borrarCookieSesion());
    const actor = await autenticar(solicitud);
    if (!actor) return sinSesion();
    if (esListado) {
      const registros = listadoValidado(await repositorio.listar(actor.huella, viajeId), actor);
      if (registros === null) return sinSesion();
      const ahora = leerReloj(); // Siempre DESPUÉS de esperar y validar el listado.
      const sesiones = registros.filter((r) => !r.revocada && r.venceEn > ahora)
        .sort((a, b) => Number(b.id === actor.id) - Number(a.id === actor.id) ||
          b.creadaEn - a.creadaEn || a.id.localeCompare(b.id))
        .map((r) => ({ ...publica(r), actual: r.id === actor.id && r.huella === actor.huella }));
      return respuestaJson({ sesiones } satisfies RespuestaDispositivos);
    }
    // La autoridad final está en esta operación atómica, no en el ID público ni el cuerpo.
    const resultado = await repositorio.revocarOtra(actor.huella, viajeId, objetivoId);
    if (resultado === 'sin-sesion') return sinSesion();
    if (resultado === 'ausente') return respuestaJson({ error: 'Sesión no encontrada.' }, 404);
    if (resultado !== 'revocada') throw new FalloSesion();
    const respuesta = respuestaJson({ revocada: objetivoId });
    if (objetivoId === actor.id) respuesta.headers.set('Set-Cookie', borrarCookieSesion());
    return respuesta;
  };
  return Object.freeze({
    autenticar,
    async atender(solicitud: Request, contexto?: ContextoSolicitudSesion): Promise<Response> {
      // Producción requiere HTTPS: el futuro Worker T3F fuerza TLS, sin CORS permisivo.
      try {
        const ruta = new URL(solicitud.url).pathname;
        if (ruta === '/api/sesiones' || /^\/api\/sesiones\/[^/]+$/.test(ruta)) return await dispositivos(solicitud, ruta);
        if (ruta !== '/api/sesion') return respuestaJson({ error: 'Ruta no encontrada.' }, 404);
        if (!['POST', 'GET', 'DELETE'].includes(solicitud.method)) {
          const respuesta = respuestaJson({ error: 'Método no permitido.' }, 405);
          respuesta.headers.set('Allow', 'POST, GET, DELETE');
          return respuesta;
        }
        if (solicitud.method === 'POST') return await entrar(solicitud, contexto);
        if (solicitud.method === 'DELETE') comprobarOrigen(solicitud);
        const registro = await autenticar(solicitud);
        if (solicitud.method === 'GET') {
          return registro ? responder(publica(registro), 200) : responder(null, 401, borrarCookieSesion());
        }
        if (registro) await repositorio.revocar(registro.huella, viajeId);
        return responder(null, 200, borrarCookieSesion());
      } catch (error) {
        // No logs, URI de DB, claves ni confirmaciones falsas/expiración ante fallo de sistema.
        if (error instanceof FalloHttp) return respuestaJson({ error: error.message }, error.codigo);
        return respuestaJson({ error: ERROR_SISTEMA }, 503);
      }
    },
  });
}
