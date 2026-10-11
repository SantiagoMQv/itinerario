import type { EstadoProgreso, Operacion } from './progreso';
import type { Itinerario } from './tipos';

/**
 * Secuencia de lectura del servidor, no reloj causal ni precondición de entidad.
 * El servidor deberá incrementarla transaccionalmente; este módulo solo valida su forma.
 */
export interface InstantaneaProgreso {
  readonly revisionServidor: number;
  readonly estado: EstadoProgreso;
}
const plano = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === 'object' && !Array.isArray(v)
  && (Object.getPrototypeOf(v) === Object.prototype || Object.getPrototypeOf(v) === null);
export const densa = (v: unknown): v is unknown[] => Array.isArray(v)
  && Reflect.ownKeys(v).length === v.length + 1
  && Array.from({ length: v.length }, (_, i) => Object.hasOwn(v, i)).every(Boolean);
export function campos(v: unknown, obligatorios: readonly string[], opcionales: readonly string[] = []): v is Record<string, unknown> {
  return plano(v) && obligatorios.every((k) => Object.hasOwn(v, k))
    && Reflect.ownKeys(v).every((k) => typeof k === 'string' && [...obligatorios, ...opcionales].includes(k));
}

// Compara únicamente dominio reconstruido: no convierte NaN/Infinity/Map/undefined a JSON.
// El esperado es acíclico y tipado; el respaldo legado nunca pasa por esta comparación.
export function iguales(valor: unknown, esperado: unknown): boolean {
  if (Array.isArray(esperado)) return densa(valor) && valor.length === esperado.length
    && esperado.every((v, i) => iguales(valor[i], v));
  if (plano(esperado)) return campos(valor, Object.keys(esperado))
    && Object.keys(esperado).every((k) => iguales(valor[k], esperado[k]));
  return (typeof valor !== 'number' || Number.isFinite(valor)) && Object.is(valor, esperado);
}
const texto = (v: unknown): v is string => typeof v === 'string' && v.trim().length > 0;
const revision = (v: unknown) => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0;
const marca = (v: unknown) => v === null || v === 'hecha' || v === 'saltada' || v === 'aqui';
const finito = (v: unknown) => typeof v === 'number' && Number.isFinite(v);
// Opcional presente con undefined es inválido: los constructores deben omitir el campo.
const opcional = (v: Record<string, unknown>, k: string, prueba: (valor: unknown) => boolean) =>
  !Object.hasOwn(v, k) || prueba(v[k]);
function registroParada(v: unknown): boolean {
  return campos(v, ['marca', 'revision'], ['horaReal']) && marca(v.marca) && revision(v.revision)
    && opcional(v, 'horaReal', (hora) => v.marca !== null && finito(hora));
}
function registroPendiente(v: unknown): boolean {
  return campos(v, ['hecho', 'revision']) && typeof v.hecho === 'boolean' && revision(v.revision);
}
function registroAqui(v: unknown): boolean {
  return campos(v, ['paradaId', 'revision']) && (v.paradaId === null || texto(v.paradaId)) && revision(v.revision);
}
function reciboValido(v: unknown): boolean {
  if (!campos(v, ['operacionId', 'registros'], ['aqui']) || !texto(v.operacionId) || !densa(v.registros)) return false;
  for (const cambio of v.registros) {
    if (!campos(cambio, ['tipo', 'id', 'antes', 'despues']) || !texto(cambio.id)) return false;
    const prueba = cambio.tipo === 'parada' ? registroParada : cambio.tipo === 'pendiente' ? registroPendiente : undefined;
    if (!prueba || !prueba(cambio.antes) || !prueba(cambio.despues)) return false;
  }
  return opcional(v, 'aqui', (aqui) => campos(aqui, ['antes', 'despues'])
    && registroAqui(aqui.antes) && registroAqui(aqui.despues));
}
/** Frontera runtime; el núcleo comprueba entidades y precondiciones al ejecutar. */
export function esOperacion(v: unknown): v is Operacion {
  if (!plano(v) || !texto(v.id) || !texto(v.dispositivoId)) return false;
  const identidad = ['id', 'dispositivoId', 'tipo'];
  if (v.tipo === 'parada') return campos(v, [...identidad, 'paradaId', 'marca', 'revision'],
    ['horaReal', 'revisionAqui', 'revisionAnterior']) && texto(v.paradaId) && marca(v.marca) && revision(v.revision)
    && opcional(v, 'horaReal', (hora) => v.marca !== null && finito(hora))
    && opcional(v, 'revisionAqui', revision) && opcional(v, 'revisionAnterior', revision);
  if (v.tipo === 'pendiente') return campos(v, [...identidad, 'pendienteId', 'hecho', 'revision'])
    && texto(v.pendienteId) && typeof v.hecho === 'boolean' && revision(v.revision);
  return v.tipo === 'deshacer' && campos(v, [...identidad, 'cambios']) && reciboValido(v.cambios);
}

function diccionario(v: unknown, prueba: (id: string, valor: unknown) => boolean): boolean {
  return plano(v) && Reflect.ownKeys(v).every((id) => typeof id === 'string' && texto(id) && prueba(id, v[id]));
}

/**
 * Valida estructura y catálogo, no autenticidad de firmas ni historia completa.
 * Los IDs del plan son persistentes: las subparadas no tienen progreso propio.
 * No compara horaReal con ninguna revisión; tampoco interpreta la firma opaca.
 */
export function esEstadoProgreso(plan: Itinerario, v: unknown): v is EstadoProgreso {
  if (!campos(v, ['viajeId', 'paradas', 'pendientes', 'aqui', 'operaciones']) || v.viajeId !== plan.id) return false;
  const paradas = new Set(plan.dias.flatMap((dia) => dia.paradas.map((p) => p.id)));
  const pendientes = new Set((plan.pendientes ?? []).map((p) => p.id));
  const aquiConocido = (aqui: unknown): boolean => registroAqui(aqui)
    && plano(aqui) && (aqui.paradaId === null || paradas.has(aqui.paradaId as string));
  if (!diccionario(v.paradas, (id, valor) => paradas.has(id) && registroParada(valor))
    || !diccionario(v.pendientes, (id, valor) => pendientes.has(id) && registroPendiente(valor))
    || !aquiConocido(v.aqui)) return false;
  // Aceptamos registros propios no enumerables: también cuentan para la invariante aquí.
  // El diccionario ya rechazó símbolos; estos nombres cubren todas las claves validadas.
  const registros = v.paradas as EstadoProgreso['paradas'];
  const activos = Object.getOwnPropertyNames(registros).filter((id) => registros[id].marca === 'aqui');
  if (activos.length > 1 || (activos[0] ?? null) !== (v.aqui as EstadoProgreso['aqui']).paradaId) return false;
  return diccionario(v.operaciones, (id, acuse) => {
    if (!campos(acuse, ['firma'], ['cambios']) || typeof acuse.firma !== 'string') return false;
    return opcional(acuse, 'cambios', (cambios) => {
      if (!reciboValido(cambios)) return false;
      const recibo = cambios as NonNullable<EstadoProgreso['operaciones'][string]['cambios']>;
      return recibo.operacionId === id && recibo.registros.every((c) =>
        (c.tipo === 'parada' ? paradas : pendientes).has(c.id))
        && (recibo.aqui === undefined || (aquiConocido(recibo.aqui.antes) && aquiConocido(recibo.aqui.despues)));
    });
  });
}

/** Forma estricta; ordenar lecturas y persistir acuses pertenece al futuro reconciliador. */
export function esInstantaneaProgreso(plan: Itinerario, v: unknown): v is InstantaneaProgreso {
  return campos(v, ['revisionServidor', 'estado']) && revision(v.revisionServidor) && esEstadoProgreso(plan, v.estado);
}
