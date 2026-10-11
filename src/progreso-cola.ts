import { aplicarOperacion, cancelarPendiente } from './progreso';
import type { EstadoProgreso, Operacion } from './progreso';
import { campos, densa, esOperacion, esInstantaneaProgreso, iguales } from './progreso-validacion';
import type { InstantaneaProgreso } from './progreso-validacion';
import type { Itinerario } from './tipos';

export interface EntradaCola {
  readonly operacion: Operacion;
  /** IDs causales capturados al crear la intención; nunca se recalculan al recibir lecturas. */
  readonly dependeDe: readonly string[];
  /** Un envío incierto sigue enviado incluso tras reiniciar, perder respuesta o recibir un 401. */
  readonly enviada: boolean;
}
export interface Cola {
  readonly confirmado: InstantaneaProgreso;
  readonly entradas: readonly EntradaCola[];
}
export interface Proyeccion {
  readonly estado: EstadoProgreso;
  readonly entradas: readonly {
    readonly operacionId: string;
    readonly tipo: 'lista' | 'conflicto' | 'invalida' | 'bloqueada';
    readonly resultado?: 'aplicada' | 'sin-cambio' | 'duplicada';
    readonly motivo?: string;
  }[];
}
export interface ResultadoCola {
  readonly tipo: 'iniciada' | 'agregada' | 'proyectada' | 'actualizada' | 'ignorada'
    | 'enviada' | 'cancelada' | 'confirmada' | 'ausente' | 'conflicto' | 'invalida';
  readonly cola?: Cola;
  readonly proyeccion?: Proyeccion;
  readonly motivo?: string;
}
/** Contrato T3: persistencia transaccional de estado + recibo, no recepción HTTP ni autenticidad.
 * revisionServidor aumenta en cada escritura; lecturas posteriores conservan los recibos (sin compactación).
 * La identidad del dispositivo es metadato: sesión/autorización se resuelven fuera de este módulo.
 */
export interface AcusePersistido {
  readonly operacionId: string;
  readonly persistida: true;
  readonly instantanea: InstantaneaProgreso;
}

/** Solo dominio previamente validado, acíclico: materializa también sus campos propios no enumerables.
 * No sirve para respaldos legados, prototipos arbitrarios ni valores externos sin validar.
 */
function capturar<T>(valor: T): T {
  if (Array.isArray(valor)) return valor.map((v) => capturar(v)) as T;
  if (valor !== null && typeof valor === 'object') {
    const copia = {};
    for (const clave of Object.getOwnPropertyNames(valor)) {
      Object.defineProperty(copia, clave, { value: capturar((valor as Record<string, unknown>)[clave]),
        enumerable: true, writable: true, configurable: true });
    }
    return copia as T;
  }
  return valor;
}
const invalida = (motivo: string): ResultadoCola => ({ tipo: 'invalida', motivo });

function validarCola(plan: Itinerario, valor: unknown): valor is Cola {
  if (!campos(valor, ['confirmado', 'entradas']) || !esInstantaneaProgreso(plan, valor.confirmado)
    || !densa(valor.entradas)) return false;
  const ids = new Set<string>();
  for (const e of valor.entradas) {
    if (!campos(e, ['operacion', 'dependeDe', 'enviada']) || !esOperacion(e.operacion)
      || typeof e.enviada !== 'boolean' || !densa(e.dependeDe)
      || e.dependeDe.some((id) => typeof id !== 'string' || !ids.has(id))
      || new Set(e.dependeDe).size !== e.dependeDe.length || ids.has(e.operacion.id)) return false;
    ids.add(e.operacion.id);
  }
  return true;
}

// Las claves incluyen el tipo: un ID opaco jamás es una propiedad heredada ni separador interpretable.
const clave = (tipo: string, id = '') => JSON.stringify([tipo, id]);
function lecturas(op: Operacion, estado: EstadoProgreso): string[] {
  if (op.tipo === 'pendiente') return [clave('pendiente', op.pendienteId)];
  if (op.tipo === 'deshacer') return [clave('recibo', op.cambios.operacionId),
    ...op.cambios.registros.map((c) => clave(c.tipo, c.id)), ...(op.cambios.aqui ? [clave('aqui')] : [])];
  const claves = [clave('parada', op.paradaId)];
  if (op.marca === 'aqui' || op.revisionAqui !== undefined || estado.aqui.paradaId === op.paradaId) {
    claves.push(clave('aqui'));
  }
  if (op.marca === 'aqui' && estado.aqui.paradaId !== null && estado.aqui.paradaId !== op.paradaId) {
    claves.push(clave('parada', estado.aqui.paradaId));
  }
  return claves;
}

function proyectar(plan: Itinerario, cola: Cola): { proyeccion: Proyeccion; autores: Map<string, string> } {
  let estado = capturar(cola.confirmado.estado);
  const autores = new Map<string, string>();
  const listas = new Set<string>();
  const entradas: Proyeccion['entradas'][number][] = [];
  for (const e of cola.entradas) {
    const operacionId = e.operacion.id;
    if (e.dependeDe.some((id) => !listas.has(id))) {
      entradas.push({ operacionId, tipo: 'bloqueada', motivo: 'Una intención causal no se pudo proyectar' });
      continue;
    }
    const r = aplicarOperacion(plan, estado, e.operacion);
    if (r.tipo === 'conflicto' || r.tipo === 'invalida') {
      entradas.push({ operacionId, tipo: r.tipo, motivo: r.motivo });
      continue;
    }
    estado = r.estado;
    listas.add(operacionId);
    entradas.push({ operacionId, tipo: 'lista', resultado: r.tipo });
    autores.set(clave('recibo', operacionId), operacionId);
    if (r.tipo === 'aplicada') {
      for (const c of r.cambios.registros) autores.set(clave(c.tipo, c.id), operacionId);
      if (r.cambios.aqui) autores.set(clave('aqui'), operacionId);
    }
  }
  return { proyeccion: { estado, entradas }, autores };
}
function salida(plan: Itinerario, cola: Cola, tipo: ResultadoCola['tipo'], motivo?: string): ResultadoCola {
  return { tipo, cola, proyeccion: proyectar(plan, cola).proyeccion, ...(motivo ? { motivo } : {}) };
}

/** Reproduce originales sobre la base dada, antes de cualquier lectura remota.
 * T2B2C puede usar la base vacía v1 para refinar sus dependencias conservadoras sin cambiar IDs.
 * No acepta raíces IDB ni respaldos legados; enviada requiere hidratar una Cola validada.
 */
export function iniciarCola(plan: Itinerario, confirmado: unknown, intenciones: unknown = []): ResultadoCola {
  if (!esInstantaneaProgreso(plan, confirmado) || !densa(intenciones) || !intenciones.every(esOperacion)) {
    return invalida('Instantánea o intenciones inválidas');
  }
  let cola: Cola = { confirmado: capturar(confirmado), entradas: [] };
  for (const op of intenciones) {
    if (cola.entradas.some((e) => e.operacion.id === op.id)) {
      return salida(plan, cola, 'conflicto', 'ID repetido entre intenciones originales');
    }
    cola = agregarCapturada(plan, cola, op);
  }
  return salida(plan, cola, 'iniciada');
}
export function proyectarCola(plan: Itinerario, valor: unknown): ResultadoCola {
  if (!validarCola(plan, valor)) return invalida('Cola inválida');
  return salida(plan, capturar(valor), 'proyectada');
}
export function agregarIntencion(plan: Itinerario, valor: unknown, operacion: unknown): ResultadoCola {
  if (!validarCola(plan, valor) || !esOperacion(operacion)) return invalida('Cola u operación inválida');
  const cola = capturar(valor);
  if (cola.entradas.some((e) => e.operacion.id === operacion.id)
    || Object.hasOwn(cola.confirmado.estado.operaciones, operacion.id)) {
    return salida(plan, cola, 'conflicto', 'ID ya registrado; reintentar la entrada existente');
  }
  return salida(plan, agregarCapturada(plan, cola, operacion), 'agregada');
}
function agregarCapturada(plan: Itinerario, cola: Cola, operacion: Operacion): Cola {
  const { proyeccion, autores } = proyectar(plan, cola);
  const dependeDe = [...new Set(lecturas(operacion, proyeccion.estado)
    .flatMap((k) => autores.has(k) ? [autores.get(k)!] : []))];
  const entradas = [...cola.entradas, { operacion: capturar(operacion), dependeDe, enviada: false }];
  return { ...cola, entradas };
}

function comparar(base: InstantaneaProgreso, nueva: InstantaneaProgreso): 'anterior' | 'igual' | 'nueva' | 'contradictoria' {
  if (nueva.revisionServidor < base.revisionServidor) return 'anterior';
  if (nueva.revisionServidor > base.revisionServidor) return 'nueva';
  return iguales(nueva.estado, base.estado) ? 'igual' : 'contradictoria';
}
export function recibirInstantanea(plan: Itinerario, valor: unknown, instantanea: unknown): ResultadoCola {
  if (!validarCola(plan, valor) || !esInstantaneaProgreso(plan, instantanea)) return invalida('Cola o instantánea inválida');
  const cola = capturar(valor);
  const nueva = capturar(instantanea);
  const orden = comparar(cola.confirmado, nueva);
  if (orden === 'contradictoria') return salida(plan, cola, 'conflicto', 'Misma revisión del servidor con distinto contenido');
  if (orden !== 'nueva') return salida(plan, cola, 'ignorada');
  return salida(plan, { ...cola, confirmado: nueva }, 'actualizada');
}
export function marcarEnviada(plan: Itinerario, valor: unknown, id: string): ResultadoCola {
  if (!validarCola(plan, valor)) return invalida('Cola inválida');
  const cola = capturar(valor);
  if (!cola.entradas.some((e) => e.operacion.id === id)) return salida(plan, cola, 'ausente');
  return salida(plan, { ...cola, entradas: cola.entradas.map((e) => e.operacion.id === id ? { ...e, enviada: true } : e) }, 'enviada');
}
export function cancelarIntencion(plan: Itinerario, valor: unknown, id: string): ResultadoCola {
  if (!validarCola(plan, valor)) return invalida('Cola inválida');
  const cola = capturar(valor);
  const e = cola.entradas.find((e) => e.operacion.id === id);
  if (!e) return salida(plan, cola, 'ausente');
  if (e.enviada || Object.hasOwn(cola.confirmado.estado.operaciones, id)) {
    return salida(plan, cola, 'conflicto', 'Envío incierto o recibo existente: requiere un inverso explícito');
  }
  const r = cancelarPendiente(cola.entradas, id);
  if (r.tipo !== 'cancelada') return salida(plan, cola, r.tipo, 'Existen intenciones dependientes');
  return salida(plan, { ...cola, entradas: cola.entradas.filter((e) => e.operacion.id !== id) }, 'cancelada');
}
export function recibirAcuse(plan: Itinerario, valor: unknown, acuse: unknown): ResultadoCola {
  if (!validarCola(plan, valor)) return invalida('Cola inválida');
  const cola = capturar(valor);
  if (!campos(acuse, ['operacionId', 'persistida', 'instantanea']) || typeof acuse.operacionId !== 'string'
    || !acuse.operacionId.trim() || acuse.persistida !== true || !esInstantaneaProgreso(plan, acuse.instantanea)) {
    return salida(plan, cola, 'invalida', 'Acuse persistido inválido');
  }
  const entrada = cola.entradas.find((e) => e.operacion.id === acuse.operacionId);
  // Un acuse repetido/ajeno no es una lectura: no modifica la base ni otras intenciones.
  if (!entrada) return salida(plan, cola, 'ignorada');
  const instantanea = capturar(acuse.instantanea);
  if (aplicarOperacion(plan, instantanea.estado, entrada.operacion).tipo !== 'duplicada') {
    return salida(plan, cola, 'invalida', 'El recibo no corresponde a la intención original');
  }
  const orden = comparar(cola.confirmado, instantanea);
  if (orden === 'contradictoria') return salida(plan, cola, 'conflicto', 'Acuse con revisión contradictoria');
  const entradas = cola.entradas.filter((e) => e.operacion.id !== acuse.operacionId)
    .map((e) => ({ ...e, dependeDe: e.dependeDe.filter((id) => id !== acuse.operacionId) }));
  return salida(plan, { confirmado: orden === 'nueva' ? instantanea : cola.confirmado, entradas }, 'confirmada');
}
