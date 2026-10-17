import { aplicarOperacion, aplicarOperacionGuardada, cancelarPendiente } from './progreso';
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
  /** Decisión negativa irreversible; no equivale a progreso aplicado. */
  readonly rechazo?: RechazoPersistido;
  /** Revisión manual: conserva el confirmado, sin cumplir dependencias ni borrar historia. */
  readonly resolucion?: 'conservar-confirmado';
}
export interface Cola {
  readonly confirmado: InstantaneaProgreso;
  readonly entradas: readonly EntradaCola[];
}
export interface Proyeccion {
  readonly estado: EstadoProgreso;
  readonly entradas: readonly {
    readonly operacionId: string;
    readonly tipo: 'lista' | 'conflicto' | 'invalida' | 'bloqueada' | 'rechazada' | 'resuelta';
    readonly resultado?: 'aplicada' | 'sin-cambio' | 'duplicada';
    readonly motivo?: string;
  }[];
}
export interface ResultadoCola {
  readonly tipo: 'iniciada' | 'agregada' | 'proyectada' | 'actualizada' | 'ignorada'
    | 'enviada' | 'cancelada' | 'confirmada' | 'ausente' | 'conflicto' | 'invalida' | 'rechazada' | 'resuelta';
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

/** Solo un transporte autenticado (TLS/sesión) entrega este DTO; ni GET ni status HTTP lo prueban.
 * El servidor futuro persiste atómicamente viaje/ID/payload completo y decisión antes de emitirlo.
 * Positivo y negativo son mutuamente excluyentes y retenidos: mismo ID/payload repite el DTO
 * histórico completo, incluida su instantánea original (no una lectura posterior).
 * Otro payload para el mismo ID requiere cuarentena, fuera de este contrato.
 * decisionPersistida confirma el resultado negativo, NO progreso aplicado. Timeout, 401,
 * aborto o error de parseo no son rechazos. El guard solo verifica forma y correspondencia,
 * no autenticidad, historia, firma ni reloj; jamás reejecutar un ID negativamente decidido.
 * Próxima unidad IDB: raíz serializada v3 con rechazo/resolucion opcionales y migración
 * atómica/validada de raíces v1/v2; mantener versión física de base 1. No guardar en raíz v2.
 */
export interface RechazoPersistido {
  readonly viajeId: string;
  readonly protocolo: 1;
  readonly operacionId: string;
  readonly operacionOriginal: Operacion;
  readonly decisionPersistida: true;
  readonly motivo: 'conflicto' | 'invalida';
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

/** Inspecciona descriptores antes de leer: no ejecuta getters, admite datos ocultos/congelados. */
function datosPropios(valor: unknown, ancestros = new Set<object>()): boolean {
  if (valor === null || typeof valor !== 'object') return true;
  if (ancestros.has(valor)) return false;
  ancestros.add(valor);
  for (const clave of Reflect.ownKeys(valor)) {
    const descriptor = Object.getOwnPropertyDescriptor(valor, clave)!;
    if (typeof clave !== 'string' || !Object.hasOwn(descriptor, 'value')
      || !datosPropios(descriptor.value, ancestros)) return false;
  }
  ancestros.delete(valor);
  return true;
}
function esRechazo(plan: Itinerario, valor: unknown): valor is RechazoPersistido {
  return datosPropios(valor) && campos(valor, ['viajeId', 'protocolo', 'operacionId',
    'operacionOriginal', 'decisionPersistida', 'motivo', 'instantanea'])
    && valor.viajeId === plan.id && valor.protocolo === 1 && valor.decisionPersistida === true
    && (valor.motivo === 'conflicto' || valor.motivo === 'invalida')
    && esOperacion(valor.operacionOriginal) && valor.operacionId === valor.operacionOriginal.id
    && esInstantaneaProgreso(plan, valor.instantanea)
    && !Object.hasOwn(valor.instantanea.estado.operaciones, valor.operacionId);
}
/** Fronteras DTO estrechas: validar antes de materializar campos propios ocultos para JSON.
 * No son normalizadores de respaldos ni prueba de autenticidad/persistencia del servidor.
 */
export function capturarOperacionProgreso(valor: unknown): Operacion | null {
  return datosPropios(valor) && esOperacion(valor) ? capturar(valor) : null;
}
export function capturarInstantaneaProgreso(plan: Itinerario, valor: unknown): InstantaneaProgreso | null {
  return datosPropios(valor) && esInstantaneaProgreso(plan, valor) ? capturar(valor) : null;
}
export function capturarAcusePersistido(plan: Itinerario, valor: unknown): AcusePersistido | null {
  if (!datosPropios(valor) || !campos(valor, ['operacionId', 'persistida', 'instantanea'])
    || typeof valor.operacionId !== 'string' || !valor.operacionId.trim() || valor.persistida !== true
    || !esInstantaneaProgreso(plan, valor.instantanea)) return null;
  return capturar(valor) as unknown as AcusePersistido;
}
export function capturarRechazoPersistido(plan: Itinerario, valor: unknown): RechazoPersistido | null {
  return esRechazo(plan, valor) ? capturar(valor) : null;
}

function contradiceNegativos(cola: Cola, instantanea: InstantaneaProgreso): boolean {
  return cola.entradas.some((e) => e.rechazo && Object.hasOwn(instantanea.estado.operaciones, e.operacion.id));
}
function validarCola(plan: Itinerario, valor: unknown): valor is Cola {
  if (!datosPropios(valor) || !campos(valor, ['confirmado', 'entradas']) || !esInstantaneaProgreso(plan, valor.confirmado)
    || !densa(valor.entradas)) return false;
  const ids = new Set<string>();
  for (const e of valor.entradas) {
    if (!campos(e, ['operacion', 'dependeDe', 'enviada'], ['rechazo', 'resolucion']) || !esOperacion(e.operacion)
      || typeof e.enviada !== 'boolean' || !densa(e.dependeDe)
      || e.dependeDe.some((id) => typeof id !== 'string' || !ids.has(id))
      || new Set(e.dependeDe).size !== e.dependeDe.length || ids.has(e.operacion.id)) return false;
    if (Object.hasOwn(e, 'rechazo') && (!e.enviada || !esRechazo(plan, e.rechazo)
      || !iguales(capturar(e.rechazo.operacionOriginal), capturar(e.operacion))
      || Object.hasOwn(valor.confirmado.estado.operaciones, e.operacion.id))) return false;
    if (Object.hasOwn(e, 'resolucion') && (!Object.hasOwn(e, 'rechazo')
      || e.resolucion !== 'conservar-confirmado')) return false;
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

function proyectar(plan: Itinerario, cola: Cola, aplicar = aplicarOperacion): { proyeccion: Proyeccion; autores: Map<string, string> } {
  let estado = capturar(cola.confirmado.estado);
  const autores = new Map<string, string>();
  const listas = new Set<string>();
  const entradas: Proyeccion['entradas'][number][] = [];
  for (const e of cola.entradas) {
    const operacionId = e.operacion.id;
    // Nunca aplicar un negativo, ni siquiera si ahora sería sin-cambio. No es autor causal.
    if (e.rechazo) {
      entradas.push({ operacionId, tipo: e.resolucion ? 'resuelta' : 'rechazada' });
      continue;
    }
    if (e.dependeDe.some((id) => !listas.has(id))) {
      entradas.push({ operacionId, tipo: 'bloqueada', motivo: 'Una intención causal no se pudo proyectar' });
      continue;
    }
    const r = aplicar(plan, estado, e.operacion);
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
/**
 * SOLO integridad de una raíz ya guardada (progreso-local): reproduce la MISMA cola como se proyectó al guardarla,
 * cuando sus retiradas conocidas aún eran del plan. No sirve para operar, elegir envíos ni acusar: la proyección
 * efectiva es siempre la de proyectarCola.
 */
export function proyectarColaGuardada(plan: Itinerario, valor: unknown): ResultadoCola {
  if (!validarCola(plan, valor)) return invalida('Cola inválida');
  const cola = capturar(valor);
  return { tipo: 'proyectada', cola, proyeccion: proyectar(plan, cola, aplicarOperacionGuardada).proyeccion };
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
  if (contradiceNegativos(cola, nueva)) return salida(plan, cola, 'conflicto', 'Recibo positivo para un ID rechazado');
  const orden = comparar(cola.confirmado, nueva);
  if (orden === 'contradictoria') return salida(plan, cola, 'conflicto', 'Misma revisión del servidor con distinto contenido');
  if (orden !== 'nueva') return salida(plan, cola, 'ignorada');
  return salida(plan, { ...cola, confirmado: nueva }, 'actualizada');
}
/** Registra exclusivamente la decisión negativa autenticada; nunca resuelve la revisión manual. */
export function recibirRechazo(plan: Itinerario, valor: unknown, rechazo: unknown): ResultadoCola {
  if (!validarCola(plan, valor)) return invalida('Cola inválida');
  const cola = capturar(valor);
  if (!esRechazo(plan, rechazo)) return salida(plan, cola, 'invalida', 'Rechazo persistido inválido');
  const decision = capturar(rechazo);
  const entrada = cola.entradas.find((e) => e.operacion.id === decision.operacionId);
  if (Object.hasOwn(cola.confirmado.estado.operaciones, decision.operacionId)
    || contradiceNegativos(cola, decision.instantanea)) {
    return salida(plan, cola, 'conflicto', 'Decisiones positiva y negativa incompatibles');
  }
  if (!entrada) return salida(plan, cola, 'ignorada');
  if (!entrada.enviada || !iguales(decision.operacionOriginal, entrada.operacion)) {
    return salida(plan, cola, 'conflicto', 'El rechazo no corresponde al original enviado');
  }
  if (entrada.rechazo) {
    return iguales(decision, entrada.rechazo) ? salida(plan, cola, 'ignorada')
      : salida(plan, cola, 'conflicto', 'Otra decisión para un ID ya rechazado');
  }
  const orden = comparar(cola.confirmado, decision.instantanea);
  if (orden === 'contradictoria') return salida(plan, cola, 'conflicto', 'Rechazo con revisión contradictoria');
  return salida(plan, {
    confirmado: orden === 'nueva' ? decision.instantanea : cola.confirmado,
    entradas: cola.entradas.map((e) => e.operacion.id === decision.operacionId ? { ...e, rechazo: decision } : e),
  }, 'rechazada');
}

/** Acción explícita del usuario, nunca automática desde transporte. Conserva historia y causalidad:
 * resuelta deja de requerir revisión, pero los hijos siguen bloqueados con sus payloads originales.
 * No cancela, no crea IDs, no rebasa ni muta servidor: una nueva intención exige decisión manual.
 */
export function resolverRechazo(plan: Itinerario, valor: unknown, id: string): ResultadoCola {
  if (!validarCola(plan, valor)) return invalida('Cola inválida');
  const cola = capturar(valor);
  const entrada = cola.entradas.find((e) => e.operacion.id === id);
  if (!entrada) return salida(plan, cola, 'ausente');
  if (!entrada.rechazo) return salida(plan, cola, 'conflicto', 'No existe una decisión negativa persistida');
  if (entrada.resolucion) return salida(plan, cola, 'resuelta');
  return salida(plan, { ...cola, entradas: cola.entradas.map((e) => e.operacion.id === id
    ? { ...e, resolucion: 'conservar-confirmado' as const } : e) }, 'resuelta');
}
export function marcarEnviada(plan: Itinerario, valor: unknown, id: string): ResultadoCola {
  if (!validarCola(plan, valor)) return invalida('Cola inválida');
  const cola = capturar(valor);
  const entrada = cola.entradas.find((e) => e.operacion.id === id);
  if (!entrada) return salida(plan, cola, 'ausente');
  if (entrada.rechazo) return salida(plan, cola, 'conflicto', 'Una decisión negativa no admite reintento');
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
  if (!datosPropios(acuse) || !campos(acuse, ['operacionId', 'persistida', 'instantanea']) || typeof acuse.operacionId !== 'string'
    || !acuse.operacionId.trim() || acuse.persistida !== true || !esInstantaneaProgreso(plan, acuse.instantanea)) {
    return salida(plan, cola, 'invalida', 'Acuse persistido inválido');
  }
  const entrada = cola.entradas.find((e) => e.operacion.id === acuse.operacionId);
  if (entrada?.rechazo || contradiceNegativos(cola, acuse.instantanea)) {
    return salida(plan, cola, 'conflicto', 'Acuse positivo incompatible con decisión negativa');
  }
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
