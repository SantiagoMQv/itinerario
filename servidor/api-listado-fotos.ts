import type { Itinerario } from '../src/tipos';
import { camposFoto, esIdFoto } from '../src/fotos';
import { leerJsonListadoAcotado } from '../src/fotos-listado-protocolo';
import type { EjecutorSql } from './contratos';
import { calcularCotasListadoFotos, copiarPresupuestoListadoFotos, crearRepositorioListadoFotosSql,
  type PresupuestoListadoFotos } from './repositorio-listado-fotos';
import { copiarPlanFotos, crearVigenciaFotos, type VigenciaFotos } from './multipart-fotos';
import type { ControladorSesiones, RegistroSesion } from './sesiones';

export interface AtencionListadoFotos {
  atender(solicitud: Request): Promise<Response>;
}
const MENSAJE = 'No se puede atender la solicitud ahora.';
const fallar = (): never => { throw new Error(MENSAJE); };
const codificador = new TextEncoder();
function sumar(a: number, b: number): number {
  if (!Number.isSafeInteger(a) || !Number.isSafeInteger(b) || a < 0 || b < 0
    || a > Number.MAX_SAFE_INTEGER - b) return fallar();
  return a + b;
}
function multiplicar(a: number, b: number): number {
  if (!Number.isSafeInteger(a) || !Number.isSafeInteger(b) || a < 0 || b < 0
    || (b !== 0 && a > Math.floor(Number.MAX_SAFE_INTEGER / b))) return fallar();
  return a * b;
}
function texto(valor: unknown, max: number): string {
  if (typeof valor !== 'string' || valor.length > max) return fallar();
  const bytes = codificador.encode(valor);
  if (bytes.length > max || new TextDecoder('utf-8', { fatal: true }).decode(bytes) !== valor) return fallar();
  return valor;
}
function reloj(): number {
  const ahora = Date.now();
  if (!Number.isSafeInteger(ahora) || ahora < 0) return fallar();
  return ahora;
}
function tiempo(valor: unknown): valor is number {
  return typeof valor === 'number' && Number.isSafeInteger(valor) && valor >= 0;
}
/** Captura por valor antes del próximo await; la fuente mutable nunca es autoridad. */
function actor(valor: unknown): RegistroSesion | null {
  if (valor === null) return null;
  const claves = ['id', 'huella', 'viajeId', 'dispositivoId', 'creadaEn', 'venceEn', 'revocada'];
  if (typeof valor === 'object' && valor && Object.hasOwn(valor, 'nombreDispositivo')) claves.push('nombreDispositivo');
  if (!camposFoto(valor, claves) || typeof valor.id !== 'string'
    || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(valor.id)
    || typeof valor.huella !== 'string' || !/^[a-f0-9]{64}$/.test(valor.huella)
    || !texto(valor.viajeId, 128) || !texto(valor.dispositivoId, 128)
    || !tiempo(valor.creadaEn) || !tiempo(valor.venceEn) || valor.creadaEn > valor.venceEn
    || typeof valor.revocada !== 'boolean') return fallar();
  if (Object.hasOwn(valor, 'nombreDispositivo')) {
    if (!texto(valor.nombreDispositivo, 320) || Array.from(valor.nombreDispositivo as string).length > 80) return fallar();
  }
  return Object.freeze({ id: valor.id, huella: valor.huella, viajeId: valor.viajeId as string,
    dispositivoId: valor.dispositivoId as string, creadaEn: valor.creadaEn, venceEn: valor.venceEn,
    revocada: valor.revocada });
}
function vigente(a: RegistroSesion | null, viajeId: string, ahora: number): a is RegistroSesion {
  return a !== null && !a.revocada && a.viajeId === viajeId && a.venceEn > ahora;
}
/** URL serializada por Request nativo, no bytes originales del transporte HTTP. */
function cursor(url: URL, viajeId: string): string | null {
  const href = url.href;
  const interrogacion = href.indexOf('?');
  const fragmento = href.indexOf('#');
  if (interrogacion < 0 || (fragmento >= 0 && fragmento < interrogacion)) return null;
  // Sólo índices primitivos antes del límite: no split/slice ni materializar search.
  // La URL nativa y su escaneo no acreditan heap físico ni CPU constante.
  const longitud = (fragmento < 0 ? href.length : fragmento) - interrogacion;
  if (longitud <= 1 || longitud > 3086) return fallar();
  const consulta = url.search;
  if (consulta.length !== longitud || !consulta.startsWith('?continuacion=')) return fallar();
  const crudo = consulta.slice(14);
  if (!crudo || crudo.includes('&')) return fallar();
  // Un único decode estricto; '=' dentro del valor no es otro separador.
  const decodificado = decodeURIComponent(crudo.replace(/\+/g, ' '));
  const c = leerJsonListadoAcotado(decodificado, 1024);
  if (!camposFoto(c, ['version', 'viajeId', 'despuesDe', 'hasta']) || c.version !== 1 || c.viajeId !== viajeId
    || !esIdFoto(c.despuesDe) || !esIdFoto(c.hasta) || !(c.despuesDe < c.hasta)) return fallar();
  const canonico = '{"version":1,"viajeId":' + JSON.stringify(viajeId) + ',"despuesDe":'
    + JSON.stringify(c.despuesDe) + ',"hasta":' + JSON.stringify(c.hasta) + '}';
  if (canonico !== decodificado) return fallar();
  return decodificado;
}
function responder(solicitud: Request, estado: number, cuerpo = '{"error":"' + MENSAJE + '"}'): Response {
  return new Response(solicitud.method === 'HEAD' ? null : cuerpo, { status: estado, headers: {
    'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'private, no-store',
    Vary: 'Cookie', Pragma: 'no-cache', 'X-Content-Type-Options': 'nosniff',
    ...(estado === 405 ? { Allow: 'GET' } : {}),
  } });
}
/** Preparación cero IO antes de credenciales. E1 cerrado, sin puerto público para
 * inyectar páginas. Catálogo sólo en fábrica, no clones/parse/renders por petición.
 * Retención HTTP adicional: encoder hasta 3P antes del rechazo, decode 2P,
 * Response P y 64KiB para referencias acotadas de query/auth/vigencia. No sharing
 * gratuito ni liberación GC instantánea; no certifica SDK, RAM, CPU o concurrencia. */
export function prepararListadoFotos(configuracion: {
  readonly plan: Itinerario; readonly ejecutor: EjecutorSql;
  readonly origen: string; readonly presupuesto: PresupuestoListadoFotos;
}): { conAutenticacion(autenticar: ControladorSesiones['autenticar']): AtencionListadoFotos } {
  if (!camposFoto(configuracion, ['plan', 'ejecutor', 'origen', 'presupuesto'])) return fallar();
  const plan = copiarPlanFotos(configuracion.plan); // M1 antes de presupuesto/ejecutor.
  const presupuesto = copiarPresupuestoListadoFotos(configuracion.presupuesto);
  const cotas = calcularCotasListadoFotos(presupuesto.maxFilas, presupuesto.maxOperacionesPorFoto);
  const minimo = sumar(sumar(cotas.bytesRetenidos, multiplicar(6, cotas.bytesRespuesta)), 65536);
  if (presupuesto.maxBytesRetenidos < minimo) return fallar();
  const origen = configuracion.origen;
  if (typeof origen !== 'string') return fallar();
  const url = new URL(origen);
  if (url.protocol !== 'https:' || url.origin !== origen || url.username || url.password || url.search || url.hash) return fallar();
  const repositorio = crearRepositorioListadoFotosSql({ plan, ejecutor: configuracion.ejecutor, presupuesto });
  const viajeId = plan.id;
  const plazoMs = presupuesto.plazoMs;
  const maxBytes = cotas.bytesRespuesta; // Efectivo, no MAX arbitrario del binding.
  return Object.freeze({ conAutenticacion(autenticar: ControladorSesiones['autenticar']): AtencionListadoFotos {
    if (typeof autenticar !== 'function') return fallar();
    const autenticarCapturado = autenticar;
    return Object.freeze({ async atender(solicitud: Request): Promise<Response> {
      let vigencia: VigenciaFotos | undefined;
      try {
        const destino = new URL(solicitud.url);
        if (destino.protocol !== 'https:') return responder(solicitud, 400);
        if (destino.pathname !== '/api/fotos/listado') return responder(solicitud, 404);
        if (solicitud.method !== 'GET') return responder(solicitud, 405);
        if (destino.origin !== origen) return responder(solicitud, 400);
        vigencia = crearVigenciaFotos(solicitud.signal, plazoMs);
        vigencia.comprobar();
        const inicial = actor(await vigencia.esperar(() => autenticarCapturado(solicitud), true));
        if (!vigente(inicial, viajeId, reloj())) return responder(solicitud, 401);
        let continuacion: string | null;
        try { continuacion = cursor(destino, viajeId); } catch { return responder(solicitud, 400); }
        const resultado = await vigencia.esperar(() => repositorio.listar(inicial.huella, inicial.viajeId,
          continuacion, vigencia!.signal), true);
        if (camposFoto(resultado, ['tipo']) && resultado.tipo === 'sin-sesion') return responder(solicitud, 401);
        if (!camposFoto(resultado, ['tipo', 'pagina', 'textoCanonico']) || resultado.tipo !== 'pagina') return fallar();
        const cuerpo = texto(resultado.textoCanonico, maxBytes);
        // DB real de sesiones después del RETURN SQL Y entrega SDK, mismo Request.
        const fresca = actor(await vigencia.esperar(() => autenticarCapturado(solicitud), true));
        if (!vigente(fresca, viajeId, reloj()) || fresca.huella !== inicial.huella || fresca.id !== inicial.id
          || fresca.viajeId !== inicial.viajeId || fresca.creadaEn !== inicial.creadaEn) return responder(solicitud, 401);
        const respuesta = responder(solicitud, 200, cuerpo);
        const ahora = reloj();
        vigencia.comprobar();
        if (inicial.venceEn <= ahora || fresca.venceEn <= ahora) return responder(solicitud, 401);
        // Ningún await entre esta comprobación final y la publicación.
        return respuesta;
      } catch { return responder(solicitud, 503); }
      finally { vigencia?.cerrar(); }
    } });
  } });
}
