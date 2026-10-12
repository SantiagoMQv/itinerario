import { itinerario } from '../src/datos/itinerario';
import { crearEjecutorNeon } from './ejecutor-neon';
import { crearRepositorioSesionesSql } from './repositorio-sesiones';
import { crearCredenciales } from './credenciales';
import { crearControladorSesiones } from './sesiones';
import { crearPasarelaSql } from './pasarela-sql';
import { crearAlmacenProgreso } from './almacen-progreso';
import { crearControladorProgreso } from './api-progreso';
import { crearRouterViaje, esRutaFotos } from './router';
import { crearComposicionFotos, type AtencionFotosWorker } from './composicion-fotos';
import type { PresupuestoFotos } from './multipart-fotos';
import type { VinculoR2Fotos } from './objetos-r2';
import { proveerRespuestaEntrada } from './entrada';
import { FalloHttp, respuestaJson } from './http';

// Tipos estructurales del borde; sin SDK Workers ni secretos en el navegador.
export interface EntornoWorker {
  CLAVE_COMPARTIDA: string;
  URL_BASE_DATOS: string;
  ASSETS: { fetch(solicitud: Request): Promise<Response> };
  FOTOS_ORIGEN?: string;
  FOTOS_PRESUPUESTO?: PresupuestoFotos;
  FOTOS_BUCKET?: VinculoR2Fotos;
}
/** Datos propios de configuración confiable, no getters ni JSON de entrada cliente. */
function prepararFotos(entorno: EntornoWorker, ejecutor: Parameters<typeof crearComposicionFotos>[0]['ejecutor']) {
  const campos = ['FOTOS_ORIGEN', 'FOTOS_PRESUPUESTO', 'FOTOS_BUCKET'] as const;
  const valores = campos.map((nombre) => {
    const descriptor = Object.getOwnPropertyDescriptor(entorno, nombre);
    if (!descriptor || !Object.hasOwn(descriptor, 'value')) throw new Error('Fotos no disponibles.');
    return descriptor.value;
  });
  return crearComposicionFotos({ plan: itinerario, ejecutor,
    origen: valores[0], presupuesto: valores[1], bucket: valores[2] });
}
function ipv4(valor: string): boolean {
  const partes = valor.split('.');
  return partes.length === 4 && partes.every((p) => /^(?:0|[1-9][0-9]{0,2})$/.test(p) && Number(p) <= 255);
}
function literalIp(valor: string | null): valor is string {
  if (!valor || valor.length > 45) return false;
  if (!valor.includes(':')) return ipv4(valor);
  let grupos = valor;
  // La cola IPv4 ocupa dos grupos de 16 bits, únicamente en la posición final.
  if (grupos.includes('.')) {
    const ultimo = grupos.lastIndexOf(':');
    if (!ipv4(grupos.slice(ultimo + 1))) return false;
    grupos = `${grupos.slice(0, ultimo + 1)}0:0`;
  }
  const mitades = grupos.split('::');
  if (mitades.length > 2) return false;
  const partes = mitades.flatMap((m) => m === '' ? [] : m.split(':'));
  if (!partes.every((p) => /^[0-9a-fA-F]{1,4}$/.test(p))) return false;
  // Sin compresión son ocho; :: debe sustituir al menos un grupo completo.
  return mitades.length === 2 ? partes.length < 8 : partes.length === 8;
}
function errorPrivado(solicitud: Request, estado: number, mensaje: string): Response {
  const respuesta = respuestaJson({ error: mensaje }, estado);
  respuesta.headers.set('Pragma', 'no-cache');
  return new Response(solicitud.method === 'HEAD' ? null : respuesta.body, {
    status: respuesta.status, headers: respuesta.headers,
  });
}

/** Entrada de borde bajo la hipótesis de acceso directo Cloudflare (ver README).
 * Sin caché de composición: ninguna autoridad/configuración sobrevive a la solicitud.
 * Importar este módulo no inicializa credenciales, genera azar ni ejecuta SQL.
 */
export default {
  async fetch(solicitud: Request, entorno: EntornoWorker): Promise<Response> {
    try {
      // TLS precede incluso a la lectura de bindings y a cualquier fábrica.
      if (new URL(solicitud.url).protocol !== 'https:') {
        return errorPrivado(solicitud, 400, new FalloHttp(400).message);
      }
      const binding = entorno.ASSETS;
      if (!binding || typeof binding.fetch !== 'function') throw new Error('Binding no válido.');
      const ejecutor = crearEjecutorNeon({ urlBaseDatos: entorno.URL_BASE_DATOS });
      // Sólo rutas reconocidas inspeccionan fotos. Un fallo de esta configuración
      // no deshabilita sesiones, progreso, entrada ni assets; no lee cuerpo ni hace IO.
      let preparacion: ReturnType<typeof crearComposicionFotos> | undefined;
      let fotos: AtencionFotosWorker | undefined;
      if (esRutaFotos(new URL(solicitud.url).pathname)) {
        try { preparacion = prepararFotos(entorno, ejecutor); } catch {
          fotos = { atender: async (original) => errorPrivado(original, 503, 'No se puede atender la solicitud ahora.') };
        }
      }
      const viajeId = itinerario.id;
      const repositorio = crearRepositorioSesionesSql({ ejecutor, viajeId });
      const credenciales = await crearCredenciales({ viajeId, claveCompartida: entorno.CLAVE_COMPARTIDA });
      const sesiones = crearControladorSesiones({ viajeId, credenciales, repositorio });
      if (preparacion) fotos = preparacion.conAutenticacion(sesiones.autenticar.bind(sesiones));
      const pasarela = crearPasarelaSql({ ejecutor });
      const almacen = crearAlmacenProgreso({ plan: itinerario, pasarela });
      const progreso = crearControladorProgreso({ plan: itinerario, autenticar: sesiones.autenticar, repositorio: almacen });
      // El binding nativo puede tener fetch en el prototipo y requerir su receiver.
      const assets = { fetch: (original: Request) => binding.fetch(original) };
      const router = crearRouterViaje({ sesiones, progreso, assets, proveerRespuestaEntrada,
        ...(fotos ? { fotos } : {}) });
      // Solo login necesita identidad de red; no inferirla de otros campos del cliente.
      let contexto;
      if (solicitud.method === 'POST' && new URL(solicitud.url).pathname === '/api/sesion') {
        const ip = solicitud.headers.get('CF-Connecting-IP');
        if (literalIp(ip)) contexto = { identidadRed: ip };
      }
      return await router.atender(solicitud, contexto);
    } catch {
      // Configuración/infraestructura fallida nunca sirve entrada ni assets como fallback.
      return errorPrivado(solicitud, 503, 'No se puede atender la solicitud ahora.');
    }
  },
};
