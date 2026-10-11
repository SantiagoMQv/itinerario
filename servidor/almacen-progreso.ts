import type { Itinerario } from '../src/tipos';
import { aplicarOperacion, crearProgreso, type Operacion } from '../src/progreso';
import { campos, densa, iguales, type InstantaneaProgreso } from '../src/progreso-validacion';
import {
  capturarOperacionProgreso, capturarInstantaneaProgreso, capturarAcusePersistido,
  capturarRechazoPersistido, type AcusePersistido, type RechazoPersistido,
} from '../src/progreso-cola';
import type { ResultadoLecturaProgreso, ResultadoProcesoProgreso, RepositorioProgreso } from './api-progreso';

/** Ambos DTO son históricos e inmutables, incluso el acuse positivo: nunca reconstruirlo
 * con el estado actual. Las decisiones de un ID son exclusivas y retienen el original entero. */
export type DecisionHistorica =
  | { readonly tipo: 'positiva'; readonly operacionOriginal: Operacion; readonly acuse: AcusePersistido }
  | { readonly tipo: 'negativa'; readonly rechazo: RechazoPersistido };

/** Única frontera durable; ningún acceso lateral ni creación implícita de viaje.
 * consultar devuelve exactamente {tipo:'lectura', instantanea, decision} o {tipo:'sin-sesion'}.
 * Sin operacionId, decision debe ser null. Revalidar actor/viaje/caducidad/revocación en SQL.
 * confirmar devuelve {tipo:'comprometida'|'desfase'|'sin-sesion'} después de la transacción.
 * Bajo locks: sesión vigente, versión == revisionBase, candidato con versión base+1,
 * ID exclusivo y original completo; estado + contador + decisión se comprometen juntos.
 * Positivo usa acuse.instantanea; negativo conserva entidades y solo incrementa contador.
 * El adaptador futuro debe conservar -0 con códec reversible: JSONB directo NO alcanza. */
export interface PasarelaProgreso {
  consultar(huellaActor: string, viajeId: string, operacionId?: string): Promise<unknown>;
  confirmar(huellaActor: string, viajeId: string, revisionBase: number, candidato: DecisionHistorica): Promise<unknown>;
}
export interface ConfiguracionAlmacenProgreso {
  readonly plan: Itinerario;
  readonly pasarela: PasarelaProgreso;
  /** Intentos CAS completos, por defecto 3, entero seguro entre 1 y 10. */
  readonly maxIntentos?: number;
}
export interface AlmacenProgreso extends RepositorioProgreso {
  leer(huellaActor: string, viajeId: string): Promise<ResultadoLecturaProgreso>;
  procesar(huellaActor: string, viajeId: string, operacion: Operacion): Promise<ResultadoProcesoProgreso>;
}
const ERROR_SISTEMA = 'No se pudo comprobar el progreso.';
const ERROR_CAPACIDAD = 'El progreso alcanzó su capacidad.';
const ERROR_OCUPADO = 'El progreso está ocupado. Intentá de nuevo.';
const codificador = new TextEncoder();
class FalloAlmacen extends Error {}
const fallar = (): never => { throw new FalloAlmacen(ERROR_SISTEMA); };

// Inspeccionar descriptores ANTES de leer discriminantes o metadatos de envoltorios.
function sobre(valor: unknown, requeridos: readonly string[], opcionales: readonly string[] = []): valor is Record<string, unknown> {
  return campos(valor, requeridos, opcionales) && Reflect.ownKeys(valor).every((k) =>
    Object.hasOwn(Object.getOwnPropertyDescriptor(valor, k)!, 'value'));
}
// Configuración del plan: no ejecutar getters ni permitir arrays dispersos/ciclos/prototipos.
function datosPlan(valor: unknown, ancestros = new Set<object>()): boolean {
  if (valor === null || typeof valor !== 'object') return typeof valor !== 'function';
  if (ancestros.has(valor)) return false;
  if (Array.isArray(valor) ? !densa(valor) : !campos(valor, Object.getOwnPropertyNames(valor))) return false;
  ancestros.add(valor);
  const valido = Reflect.ownKeys(valor).every((k) => {
    const d = Object.getOwnPropertyDescriptor(valor, k)!;
    return typeof k === 'string' && Object.hasOwn(d, 'value') && datosPlan(d.value, ancestros);
  });
  ancestros.delete(valor);
  return valido;
}
function identidad(valor: string): boolean {
  const bytes = codificador.encode(valor);
  return valor.length > 0 && !valor.includes('\0') && bytes.length <= 128
    && new TextDecoder('utf-8', { fatal: true }).decode(bytes) === valor;
}
function congelar<T>(valor: T): T {
  if (valor !== null && typeof valor === 'object') {
    for (const k of Object.getOwnPropertyNames(valor)) congelar((valor as Record<string, unknown>)[k]);
    Object.freeze(valor);
  }
  return valor;
}
async function seguro<T>(ejecutar: () => T | Promise<T>): Promise<T> {
  try { return await ejecutar(); } catch (error) {
    if (error instanceof FalloAlmacen) throw error;
    return fallar();
  }
}
// Una excepción del adaptador nunca es decisión ni habilita un retry CAS incierto.
async function puerto(ejecutar: () => Promise<unknown>): Promise<unknown> {
  try { return await ejecutar(); } catch { return fallar(); }
}
function resultado(decision: DecisionHistorica): ResultadoProcesoProgreso {
  return decision.tipo === 'positiva' ? { tipo: 'confirmada', acuse: decision.acuse }
    : { tipo: 'rechazada', rechazo: decision.rechazo };
}

export function crearAlmacenProgreso(configuracion: ConfiguracionAlmacenProgreso): AlmacenProgreso {
  try {
    if (!sobre(configuracion, ['plan', 'pasarela'], ['maxIntentos'])) return fallar();
    const { plan, pasarela } = configuracion;
    const maxIntentos = Object.hasOwn(configuracion, 'maxIntentos') ? configuracion.maxIntentos : 3;
    if (typeof maxIntentos !== 'number' || !Number.isSafeInteger(maxIntentos) || maxIntentos < 1 || maxIntentos > 10
      || !sobre(pasarela, ['consultar', 'confirmar']) || typeof pasarela.consultar !== 'function'
      || typeof pasarela.confirmar !== 'function' || !datosPlan(plan)) return fallar();
    crearProgreso(plan); // Valida catálogo compartido, sin guardar ni fabricar raíz durable.
    if (!identidad(plan.id)) return fallar();
    const paradas = new Set(plan.dias.flatMap((dia) => dia.paradas.map((p) => p.id)));
    const pendientes = new Set((plan.pendientes ?? []).map((p) => p.id));
    function original(valor: unknown): Operacion {
      const op = capturarOperacionProgreso(valor);
      if (!op || !identidad(op.id) || !identidad(op.dispositivoId)) return fallar();
      if (op.tipo === 'parada' ? !paradas.has(op.paradaId) : op.tipo === 'pendiente' ? !pendientes.has(op.pendienteId)
        : !identidad(op.cambios.operacionId) || !op.cambios.registros.every((c) =>
          (c.tipo === 'parada' ? paradas : pendientes).has(c.id))
          || (op.cambios.aqui !== undefined && ![op.cambios.aqui.antes, op.cambios.aqui.despues].every((a) =>
            a.paradaId === null || paradas.has(a.paradaId)))) return fallar();
      return congelar(op);
    }
    function alcance(huella: string, viaje: string): void {
      if (typeof huella !== 'string' || !/^[a-f0-9]{64}$/.test(huella) || viaje !== plan.id) fallar();
    }
    function capturaInstantanea(valor: unknown): InstantaneaProgreso {
      const captura = capturarInstantaneaProgreso(plan, valor);
      if (!captura || !Object.keys(captura.estado.operaciones).every(identidad)) return fallar();
      return captura;
    }
    function decision(valor: unknown, id: string, actual: InstantaneaProgreso): DecisionHistorica {
      let historica: DecisionHistorica;
      let anterior: InstantaneaProgreso;
      if (sobre(valor, ['tipo', 'operacionOriginal', 'acuse']) && valor.tipo === 'positiva') {
        const op = original(valor.operacionOriginal);
        const acuse = capturarAcusePersistido(plan, valor.acuse);
        if (!acuse || op.id !== id || acuse.operacionId !== id
          || aplicarOperacion(plan, acuse.instantanea.estado, op).tipo !== 'duplicada'
          || !Object.hasOwn(actual.estado.operaciones, id)) return fallar();
        historica = { tipo: 'positiva', operacionOriginal: op, acuse };
        anterior = capturaInstantanea(acuse.instantanea);
      } else if (sobre(valor, ['tipo', 'rechazo']) && valor.tipo === 'negativa') {
        const rechazo = capturarRechazoPersistido(plan, valor.rechazo);
        if (!rechazo || rechazo.operacionId !== id || original(rechazo.operacionOriginal).id !== id
          || Object.hasOwn(actual.estado.operaciones, id)) return fallar();
        historica = { tipo: 'negativa', rechazo };
        anterior = capturaInstantanea(rechazo.instantanea);
      } else return fallar();
      if (anterior.revisionServidor < 1 || anterior.revisionServidor > actual.revisionServidor
        || (anterior.revisionServidor === actual.revisionServidor && !iguales(anterior.estado, actual.estado))) return fallar();
      // Todo recibo conocido en esa historia debe seguir presente e idéntico, no solo el ID consultado.
      if (!Object.keys(anterior.estado.operaciones).every((k) => Object.hasOwn(actual.estado.operaciones, k)
        && iguales(anterior.estado.operaciones[k], actual.estado.operaciones[k]))) return fallar();
      return congelar(historica);
    }
    async function consultar(huella: string, viaje: string, id?: string) {
      const lectura = await puerto(() => id === undefined ? pasarela.consultar(huella, viaje) : pasarela.consultar(huella, viaje, id));
      if (sobre(lectura, ['tipo']) && lectura.tipo === 'sin-sesion') return null;
      if (!sobre(lectura, ['tipo', 'instantanea', 'decision']) || lectura.tipo !== 'lectura') return fallar();
      const instantanea = capturaInstantanea(lectura.instantanea);
      if (id === undefined && lectura.decision !== null) return fallar();
      const historica = lectura.decision === null ? null : decision(lectura.decision, id!, instantanea);
      return { instantanea, historica };
    }
    return Object.freeze({
      leer(huella: string, viaje: string): Promise<ResultadoLecturaProgreso> {
        return seguro(async () => {
          alcance(huella, viaje);
          const lectura = await consultar(huella, viaje);
          return lectura ? { tipo: 'instantanea', instantanea: lectura.instantanea } : { tipo: 'sin-sesion' };
        });
      },
      procesar(huella: string, viaje: string, operacion: Operacion): Promise<ResultadoProcesoProgreso> {
        return seguro(async () => {
          alcance(huella, viaje);
          const op = original(operacion); // Una sola captura anterior a cualquier await.
          for (let intento = 0; intento < maxIntentos; intento++) {
            const lectura = await consultar(huella, viaje, op.id);
            if (!lectura) return { tipo: 'sin-sesion' };
            const { instantanea: actual, historica } = lectura;
            if (historica) {
              const guardado = historica.tipo === 'positiva' ? historica.operacionOriginal : historica.rechazo.operacionOriginal;
              return iguales(op, guardado) ? resultado(historica) : { tipo: 'identidad-reutilizada' };
            }
            if (Object.hasOwn(actual.estado.operaciones, op.id)) return fallar(); // Historia perdida, no reconstruir acuse.
            if (actual.revisionServidor === Number.MAX_SAFE_INTEGER) throw new FalloAlmacen(ERROR_CAPACIDAD);
            const r = aplicarOperacion(plan, actual.estado, op);
            const siguiente = { revisionServidor: actual.revisionServidor + 1, estado: r.estado };
            let candidato: DecisionHistorica;
            if (r.tipo === 'aplicada' || r.tipo === 'sin-cambio') {
              const acuse = capturarAcusePersistido(plan, { operacionId: op.id, persistida: true, instantanea: siguiente });
              if (!acuse || !Object.hasOwn(acuse.instantanea.estado.operaciones, op.id)
                || aplicarOperacion(plan, acuse.instantanea.estado, op).tipo !== 'duplicada') return fallar();
              candidato = { tipo: 'positiva', operacionOriginal: original(op), acuse };
            } else if (r.tipo === 'conflicto' || r.tipo === 'invalida') {
              const rechazo = capturarRechazoPersistido(plan, { viajeId: plan.id, protocolo: 1, operacionId: op.id,
                operacionOriginal: op, decisionPersistida: true, motivo: r.tipo,
                instantanea: { ...siguiente, estado: actual.estado } });
              if (!rechazo) return fallar();
              candidato = { tipo: 'negativa', rechazo };
            } else return fallar(); // duplicada sin decisión histórica es corrupción.
            congelar(candidato); // Capturas separadas: la pasarela no puede alterar estado/input/respuesta.
            const compromiso = await puerto(() => pasarela.confirmar(huella, viaje, actual.revisionServidor, candidato));
            if (!sobre(compromiso, ['tipo'])) return fallar();
            if (compromiso.tipo === 'comprometida') return resultado(candidato);
            if (compromiso.tipo === 'sin-sesion') return { tipo: 'sin-sesion' };
            if (compromiso.tipo !== 'desfase') return fallar();
            // Releer/reaplicar el MISMO original y precondiciones, nunca autorebase ni reloj.
          }
          throw new FalloAlmacen(ERROR_OCUPADO);
        });
      },
    });
  } catch { return fallar(); }
}
