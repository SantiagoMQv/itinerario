import type { Itinerario } from '../src/tipos';
import { camposFoto } from '../src/fotos';
import type { EjecutorSql } from './contratos';
import { copiarPlanFotos, copiarPresupuestoFotos, FalloFotos, type PresupuestoFotos } from './multipart-fotos';
import { crearObjetosFotosR2, type VinculoR2Fotos } from './objetos-r2';
import { crearRepositorioFotosSql } from './repositorio-fotos';
import { crearControladorFotos } from './api-fotos';
import type { ControladorSesiones } from './sesiones';

export interface AtencionFotosWorker {
  atender(solicitud: Request): Promise<Response>;
}
export interface ConfiguracionComposicionFotos {
  readonly plan: Itinerario;
  readonly ejecutor: EjecutorSql;
  readonly origen: string;
  readonly presupuesto: PresupuestoFotos;
  readonly bucket: VinculoR2Fotos;
}
/** Preparación síncrona sin IO antes de construir credenciales. Los snapshots y los
 * métodos nativos ligados no conservan autoridad de otra solicitud ni configuración mutable.
 * La autenticación real se enlaza después; no hay forwarder sin inicializar. */
export function crearComposicionFotos(configuracion: ConfiguracionComposicionFotos): {
  conAutenticacion(autenticar: ControladorSesiones['autenticar']): AtencionFotosWorker;
} {
  if (!camposFoto(configuracion, ['plan', 'ejecutor', 'origen', 'presupuesto', 'bucket'])) throw new FalloFotos(503);
  const plan = copiarPlanFotos(configuracion.plan);
  const presupuesto = copiarPresupuestoFotos(configuracion.presupuesto);
  const origen = configuracion.origen;
  if (typeof origen !== 'string') throw new FalloFotos(503);
  const url = new URL(origen);
  if (url.protocol !== 'https:' || url.origin !== origen || url.username || url.password || url.search || url.hash) {
    throw new FalloFotos(503);
  }
  const repositorio = crearRepositorioFotosSql({ plan, ejecutor: configuracion.ejecutor });
  const objetos = crearObjetosFotosR2({ plan, bucket: configuracion.bucket });
  return Object.freeze({
    conAutenticacion(autenticar: ControladorSesiones['autenticar']): AtencionFotosWorker {
      const controlador = crearControladorFotos({ plan, origen, autenticar, repositorio, objetos });
      return Object.freeze({ atender: (solicitud: Request) => controlador.atender(solicitud, presupuesto) });
    },
  });
}
