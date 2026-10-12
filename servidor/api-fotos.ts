import type { Itinerario } from '../src/tipos';
import { camposFoto, esIdFoto } from '../src/fotos';
import type { ControladorSesiones } from './sesiones';
import { crearAlmacenFotos, type RepositorioFotos, type ObjetosFotos } from './almacen-fotos';
import { copiarPlanFotos, copiarPresupuestoFotos, crearVigenciaFotos, leerMultipartFotos,
  FalloFotos, type PresupuestoFotos } from './multipart-fotos';

export interface ConfiguracionApiFotos {
  readonly plan: Itinerario;
  /** Origen HTTPS confiable capturado por composición, sin ruta ni userinfo. */
  readonly origen: string;
  readonly autenticar: ControladorSesiones['autenticar'];
  readonly repositorio: RepositorioFotos;
  readonly objetos: ObjetosFotos;
}
export interface ControladorFotos {
  /** Presupuesto requerido en CADA invocación; no default ni original ilimitado. */
  atender(solicitud: Request, presupuesto: PresupuestoFotos): Promise<Response>;
}
const cabecerasPrivadas = {
  'Cache-Control': 'private, no-store', 'Vary': 'Cookie', 'X-Content-Type-Options': 'nosniff',
};
function errorPublico(codigo: number): Response {
  return new Response('{"error":"No se pudo completar la solicitud de fotos."}', {
    status: codigo, headers: { ...cabecerasPrivadas, 'Content-Type': 'application/json; charset=utf-8' },
  });
}

/** Biblioteca autónoma: no router/Worker, TLS real, cookie nueva, assets, UI ni endpoint
 * de listado. El autenticar inyectado ES el gate de sesión/cookie existente, nunca un
 * header del cliente ni credencial en JSON. A modela puertos; B/C/D y T7 siguen pendientes. */
export function crearControladorFotos(configuracion: ConfiguracionApiFotos): ControladorFotos {
  if (!camposFoto(configuracion, ['plan', 'origen', 'autenticar', 'repositorio', 'objetos'])) throw new FalloFotos(503);
  const plan = copiarPlanFotos(configuracion.plan);
  const origen = configuracion.origen;
  const url = new URL(origen);
  if (url.protocol !== 'https:' || url.origin !== origen || url.username || url.password
    || url.search || url.hash || typeof configuracion.autenticar !== 'function') throw new FalloFotos(503);
  const autenticar = configuracion.autenticar;
  const almacen = crearAlmacenFotos({ plan, repositorio: configuracion.repositorio, objetos: configuracion.objetos });
  return Object.freeze({
    async atender(solicitud: Request, presupuesto: PresupuestoFotos): Promise<Response> {
      let vigencia: ReturnType<typeof crearVigenciaFotos> | null = null;
      try {
        const p = copiarPresupuestoFotos(presupuesto);
        const destino = new URL(solicitud.url);
        const post = destino.pathname === '/api/fotos/respaldo';
        const m = /^\/api\/fotos\/([^/]+)\/original$/.exec(destino.pathname);
        if (!post && !m) return errorPublico(404);
        if (solicitud.method !== (post ? 'POST' : 'GET')) {
          const respuesta = errorPublico(405);
          respuesta.headers.set('Allow', post ? 'POST' : 'GET');
          return respuesta;
        }
        if (destino.protocol !== 'https:' || destino.origin !== origen) throw new FalloFotos(400);
        if (post && solicitud.headers.get('Origin') !== origen) throw new FalloFotos(403);
        let fotoId = '';
        if (m) {
          try { fotoId = decodeURIComponent(m[1]); } catch { throw new FalloFotos(400); }
          if (!esIdFoto(fotoId)) throw new FalloFotos(400);
        }
        vigencia = crearVigenciaFotos(solicitud.signal, p.plazoMs);
        const v = vigencia;
        const actor = await v.esperar(() => autenticar(solicitud), true);
        if (!actor || actor.viajeId !== plan.id || actor.revocada) throw new FalloFotos(401);
        const huellaActor = actor.huella;
        const contexto = { huellaActor, presupuesto: p, vigencia: v,
          reautenticar: async () => {
            const fresca = await v.esperar(() => autenticar(solicitud), true);
            return !!fresca && fresca.viajeId === plan.id && fresca.huella === huellaActor && !fresca.revocada;
          },
        };
        if (post) {
          const captura = await leerMultipartFotos(plan, solicitud, p, v);
          const resultado = await almacen.respaldar(captura, contexto);
          v.comprobar();
          return new Response(resultado.texto, { status: resultado.primera ? 201 : 200,
            headers: { ...cabecerasPrivadas, 'Content-Type': 'application/json; charset=utf-8' } });
        }
        const original = await almacen.descargar(fotoId, contexto);
        v.comprobar();
        return new Response(original, { status: 200,
          headers: { ...cabecerasPrivadas, 'Content-Type': 'application/octet-stream' } });
      } catch (e) {
        return errorPublico(e instanceof FalloFotos ? e.codigo : 503);
      } finally { vigencia?.cerrar(); }
    },
  });
}
