import type { Itinerario } from './tipos';
import { capturarFotosLocal } from './fotos-local';
import { capturarProgresoLocal } from './progreso-local';
import { capturarRespaldoFotosLocal } from './fotos-respaldo-local';
import { copiarLimitesPortables, copiarPlanPortable, exportarArchivoPortable, type ArchivoPortable,
  type CampoLegadoPortable, type LimitesPortables } from './portabilidad';

export interface OpcionesPortabilidadLocal {
  readonly plan: Itinerario;
  readonly limites: LimitesPortables;
  /** null rechaza; nunca fallback en memoria. */
  readonly fabrica?: IDBFactory | null;
  /** Puerto explícito solo para marcas, marcas-hora y pendientes-hechos.
   * El llamador liga sus claves actuales: esta biblioteca nunca enumera localStorage.
   * null es ausencia, '' es presente vacío; error de lectura rechaza toda exportación. */
  readonly leerLegado: (campo: CampoLegadoPortable) => string | null;
}
export interface ExportadorLocal {
  /** Manual, sin red ni colas/recibos nuevos. Las capturas tienen coherencia por base,
   * no atomicidad global con otras pestañas, las tres bases o localStorage.
   * No incluye scheduler/red/transitorios, caches, credenciales, tema ni navegación. */
  exportar(): Promise<ArchivoPortable>;
}
/** Constructor sin IO. Captura configuración, funciones y catálogo antes de cualquier await.
 * Una sola acción por instancia; no bloqueo global de pestañas ni pausa de transportes ajenos.
 * Importación/restauración futura deberá usar staging histórico separado, nunca publicar ACK
 * ni activar estas colas automáticamente en almacenes activos. */
export function crearExportadorLocal(opciones: OpcionesPortabilidadLocal): ExportadorLocal {
  const plan = copiarPlanPortable(opciones.plan);
  const limites = copiarLimitesPortables(opciones.limites);
  const fabricaEntrada = opciones.fabrica === undefined ? globalThis.indexedDB : opciones.fabrica;
  // Liga el método nativo a su receptor ahora: no cambia entre las tres capturas por await.
  const fabrica = fabricaEntrada ? Object.freeze({ open: fabricaEntrada.open.bind(fabricaEntrada) }) : fabricaEntrada;
  const lectura = opciones.leerLegado;
  if (typeof lectura !== 'function') throw new Error('Falta puerto explícito de legado');
  let activa = false;
  return { exportar: async () => {
    if (activa) throw new Error('Ya hay una exportación activa en esta instancia');
    activa = true;
    try {
      if (!fabrica) throw new Error('IndexedDB no está disponible');
      const legado = { marcas: lectura('marcas'), 'marcas-hora': lectura('marcas-hora'),
        'pendientes-hechos': lectura('pendientes-hechos') };
      for (const v of Object.values(legado)) {
        if (v !== null && typeof v !== 'string') throw new Error('Lectura legada inválida');
      }
      const fotos = await capturarFotosLocal(plan, limites, { fabrica });
      const progreso = await capturarProgresoLocal(plan, limites, { fabrica });
      const respaldos = await capturarRespaldoFotosLocal(plan, limites, { fabrica });
      return await exportarArchivoPortable(plan, { viajeId: plan.id, fotos, progreso, respaldos, legado }, limites);
    } finally { activa = false; }
  } };
}
