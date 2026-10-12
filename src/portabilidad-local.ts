import type { Itinerario } from './tipos';
import { capturarFotosLocal } from './fotos-local';
import { capturarProgresoLocal } from './progreso-local';
import { capturarRespaldoFotosLocal } from './fotos-respaldo-local';
import { capturarHistoriaPortable, copiarLimitesHistoria, crearPortabilidadHistorica,
  presupuestoHistoria, validarDatosHistoricos, type RegistroHistorico, type ProcedenciaHistorica,
  type LimitesHistoria, type OpcionesHistoria, type ResultadoImportacionHistorica } from './portabilidad-historico';
import { copiarLimitesPortables, copiarPlanPortable, exportarArchivoPortable, type ArchivoPortable,
  type CampoLegadoPortable, type LimitesPortables, type ConjuntoRecuperacion, type LimitesConjunto,
  crearConjuntoRecuperacion, copiarLimitesConjunto, inspeccionarConjuntoRecuperacion } from './portabilidad';

export interface OpcionesPortabilidadLocal {
  readonly plan: Itinerario; readonly limites: LimitesPortables;
  /** null rechaza; nunca fallback en memoria. */
  readonly fabrica?: IDBFactory | null;
  /** Defaults conservadores derivados de limites, no historia ilimitada implícita. */
  readonly limitesHistoria?: LimitesHistoria;
  /** Sólo marcas, marcas-hora y pendientes-hechos; no enumera localStorage. */
  readonly leerLegado: (campo: CampoLegadoPortable) => string | null;
}
export class ErrorExportacionHistoria extends Error {
  constructor(readonly codigo: 'historia-presente' | 'historia-no-valida') {
    super('Exportación incompleta rechazada: usar exportarRecuperacion con presupuestos explícitos');
  }
}
export interface ExportacionActual {
  readonly tipo: 'actual-sin-historia'; readonly archivo: ArchivoPortable;
  readonly excluidas: readonly ['historia-archivada', 'caches', 'credenciales', 'transitorios'];
}
export interface ExportadorLocal {
  /** Contrato baseline únicamente con historia ausente/vacía CONOCIDA. */
  exportar(): Promise<ArchivoPortable>;
  exportarActual(): Promise<ExportacionActual>;
  /** Todas las fuentes declaradas, coherencia por base, no un instante global simultáneo. */
  exportarRecuperacion(limites: LimitesConjunto): Promise<ConjuntoRecuperacion>;
}
/** Constructor sin IO; funciones/configuración ligadas antes de awaits. No transporte ni replay. */
export function crearExportadorLocal(opciones: OpcionesPortabilidadLocal): ExportadorLocal {
  const plan = copiarPlanPortable(opciones.plan); const limites = copiarLimitesPortables(opciones.limites);
  const presupuesto = copiarLimitesHistoria(opciones.limitesHistoria ?? { maxImportaciones: limites.maxRegistros,
    maxObservaciones: limites.maxRegistros, maxProcedencias: limites.maxRegistros, maxBytesHistoria: limites.maxBytesArchivo });
  const entrada = opciones.fabrica === undefined ? globalThis.indexedDB : opciones.fabrica;
  const fabrica = entrada ? Object.freeze({ open: entrada.open.bind(entrada) }) : entrada;
  const lectura = opciones.leerLegado;
  if (typeof lectura !== 'function') throw new Error('Falta puerto explícito de legado');
  let activa = false;
  async function exclusiva<T>(trabajo: () => Promise<T>): Promise<T> {
    if (activa) throw new Error('Ya hay una exportación activa en esta instancia');
    activa = true; try { return await trabajo(); } finally { activa = false; }
  }
  async function actual(): Promise<ArchivoPortable> {
    if (!fabrica) throw new Error('IndexedDB no está disponible');
    const legado = { marcas: lectura('marcas'), 'marcas-hora': lectura('marcas-hora'), 'pendientes-hechos': lectura('pendientes-hechos') };
    for (const v of Object.values(legado)) if (v !== null && typeof v !== 'string') throw new Error('Lectura legada inválida');
    const fotos = await capturarFotosLocal(plan, limites, { fabrica });
    const progreso = await capturarProgresoLocal(plan, limites, { fabrica });
    const respaldos = await capturarRespaldoFotosLocal(plan, limites, { fabrica });
    return exportarArchivoPortable(plan, { viajeId: plan.id, fotos, progreso, respaldos, legado }, limites);
  }
  return {
    exportar: () => exclusiva(async () => {
      if (!fabrica) throw new Error('IndexedDB no está disponible');
      let historia;
      try { historia = await capturarHistoriaPortable(plan, limites, presupuesto, fabrica); }
      catch { throw new ErrorExportacionHistoria('historia-no-valida'); }
      if (historia.registros.length) throw new ErrorExportacionHistoria('historia-presente');
      return actual();
    }),
    exportarActual: () => exclusiva(async () => ({ tipo: 'actual-sin-historia', archivo: await actual(),
      excluidas: ['historia-archivada', 'caches', 'credenciales', 'transitorios'] })),
    exportarRecuperacion: (presupuestoConjunto) => exclusiva(async () => {
      // crearConjuntoRecuperacion captura/valida su configuración antes de IO; aquí también
      // se fija el presupuesto antes de capturar cualquiera de las cinco fuentes declaradas.
      const copia = copiarLimitesConjunto(presupuestoConjunto);
      if (copia.maxArchivos < 1) throw new Error('maxArchivos no permite snapshot actual');
      const historia = await capturarHistoriaPortable(plan, limites, presupuesto, fabrica);
      if (historia.registros.length + 1 > copia.maxArchivos) throw new Error('maxArchivos excedido');
      const ahora = await actual();
      return crearConjuntoRecuperacion(plan, ahora.archivo, historia.registros.map((r) => ({ trabajoId: r.trabajoId,
        archivo: r.archivo, observaciones: r.observaciones, procedencias: r.procedencias })), limites, copia);
    }),
  };
}
export interface ResultadoImportacionConjunto {
  readonly tipo: 'rechazado-antes-escribir' | 'historias-parciales' | 'historia-confirmada' | 'resultado-durable-incierto';
  readonly trabajos: readonly ResultadoImportacionHistorica[];
  readonly actual: ResultadoImportacionHistorica | null;
}
/** Importación manual plana. Prevalida inventario y TODOS los originales antes de abrir
 * una base destino. Archiva todos primero; sólo el snapshot designado actual restaura fotos.
 * No reproduce progreso/ledger/LS y no concede permiso para borrar el origen. */
export function crearImportadorRecuperacionLocal(opciones: OpcionesHistoria) {
  const plan = copiarPlanPortable(opciones.plan); const limites = copiarLimitesPortables(opciones.limites);
  const presupuesto = copiarLimitesHistoria(opciones.limitesHistoria);
  const entrada = opciones.fabrica === undefined ? globalThis.indexedDB : opciones.fabrica;
  const fabrica = entrada ? { open: entrada.open.bind(entrada) } : entrada;
  const historia = crearPortabilidadHistorica({ plan, limites, limitesHistoria: presupuesto, fabrica, restaurador: opciones.restaurador });
  const archivar = historia.archivar.bind(historia); const reintentar = historia.reintentar.bind(historia);
  return { importarConjunto: async (conjunto: ConjuntoRecuperacion, presupuestoEntrada: LimitesConjunto): Promise<ResultadoImportacionConjunto> => {
    let preparados: { referencia: string; registro: RegistroHistorico }[];
    try {
      const inspeccion = await inspeccionarConjuntoRecuperacion(plan, conjunto, limites, copiarLimitesConjunto(presupuestoEntrada));
      preparados = inspeccion.inventario.archivos.map((a) => {
        const origenes: ProcedenciaHistorica[] = structuredClone(a.procedencias) as ProcedenciaHistorica[];
        if (a.trabajoOrigen !== null && !origenes.some((p) => p.viajeId === plan.id && p.trabajoId === a.trabajoOrigen)) {
          origenes.push({ viajeId: plan.id, trabajoId: a.trabajoOrigen });
        }
        return { referencia: a.referencia, registro: { formato: 1, viajeId: plan.id, trabajoId: '',
          archivo: inspeccion.archivos.find((f) => f.referencia === a.referencia)!.inspeccion.archivo,
          observaciones: structuredClone(a.observaciones), procedencias: origenes } };
      });
      const existentes = await capturarHistoriaPortable(plan, limites, presupuesto, fabrica);
      // Reserva la observación del snapshot actual: límite conocido NO se descubre tras escribir.
      presupuestoHistoria([...existentes.registros, ...preparados.map((p) => p.registro)], presupuesto);
      const obs = existentes.registros.reduce((n, r) => n + r.observaciones.length, 0)
        + preparados.reduce((n, p) => n + p.registro.observaciones.length, 0) + 1;
      if (!Number.isSafeInteger(obs) || obs > presupuesto.maxObservaciones) throw new Error('Presupuesto de observaciones excedido');
      // Validación de procedencias agregadas después de añadir IDs de origen; nunca se adoptan.
      for (const p of preparados) validarDatosHistoricos(p.registro.observaciones, p.registro.procedencias, limites, presupuesto);
    } catch { return { tipo: 'rechazado-antes-escribir', trabajos: [], actual: null }; }
    const trabajos: ResultadoImportacionHistorica[] = []; let actualId: string | null = null;
    for (const p of preparados) {
      const r = await archivar(p.registro.archivo, p.registro.procedencias, p.registro.observaciones);
      trabajos.push(r);
      if (r.historia !== 'confirmada') return { tipo: 'historias-parciales', trabajos, actual: null };
      if (p.referencia === 'actual') actualId = r.trabajoId;
    }
    const actual = await reintentar(actualId!);
    return { tipo: actual.tipo === 'resultado-durable-incierto' ? 'resultado-durable-incierto' : 'historia-confirmada', trabajos, actual };
  } };
}
