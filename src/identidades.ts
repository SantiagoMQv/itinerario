import type { Itinerario } from './tipos';

/**
 * Catálogo único de identidades de UN viaje: las activas del plan y las retiradas conocidas (`plan.retiradas`).
 * Lo usan el núcleo de progreso, sus validadores (app y servidor) y las fotos, para que lo guardado con un plan
 * anterior del mismo viaje se siga leyendo sin reescribirlo. Retirada no es activa: nunca se puede marcar ni
 * capturar en ella, ni vuelve al plan. Desconocido sigue siendo desconocido. Sin caché ni estado: se calcula del
 * plan que se recibe y lanza ante cualquier plan incoherente, siempre en el mismo orden.
 */
export interface Identidades {
  readonly paradas: { readonly activas: ReadonlySet<string>; readonly conocidas: ReadonlySet<string> };
  readonly pendientes: { readonly activas: ReadonlySet<string>; readonly conocidas: ReadonlySet<string> };
  /** Tupla exacta de un destino: parada (sin sitio) o parada + sitio de dentro. */
  destino(paradaId: string, subparadaId?: string): 'activo' | 'retirado' | null;
  /** Nombre de entonces de una parada o un sitio retirados, por su tupla exacta. */
  nombreRetirado(paradaId: string, subparadaId?: string): string | null;
}

const texto = (v: unknown): v is string => typeof v === 'string' && v.trim().length > 0;
/** Objeto plano cuyas claves propias son datos de esa lista (todas, salvo `opcionales`), sin accesores ni símbolos. */
function registro(v: unknown, claves: readonly string[], opcionales = false): v is Record<string, unknown> {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return false;
  const proto = Object.getPrototypeOf(v);
  if (proto !== Object.prototype && proto !== null) return false;
  const propias = Reflect.ownKeys(v);
  if (propias.some((k) => typeof k !== 'string' || !claves.includes(k))) return false;
  if (!opcionales && propias.length !== claves.length) return false;
  return propias.every((k) => Object.hasOwn(Object.getOwnPropertyDescriptor(v, k)!, 'value'));
}
const lista = (v: unknown): v is readonly unknown[] => Array.isArray(v) && Reflect.ownKeys(v).length === v.length + 1
  && Array.from({ length: v.length }, (_, i) => Object.hasOwn(v, i)).every(Boolean);
function fallo(): never { throw new Error('Identidades retiradas inválidas'); }

export function identidades(plan: Itinerario): Identidades {
  const usadas = new Set<string>();
  const registrar = (id: unknown) => {
    if (!texto(id) || usadas.has(id)) throw new Error('Identidad del itinerario vacía o duplicada');
    usadas.add(id);
  };
  registrar(plan.id);
  const paradas = new Set<string>();
  const subparadas = new Map<string, Set<string>>();
  for (const dia of plan.dias) {
    for (const parada of dia.paradas) {
      registrar(parada.id);
      paradas.add(parada.id);
      const subs = new Set<string>();
      for (const sub of parada.subparadas ?? []) { registrar(sub.id); subs.add(sub.id); }
      subparadas.set(parada.id, subs);
    }
  }
  const pendientes = new Set<string>();
  for (const pendiente of plan.pendientes ?? []) { registrar(pendiente.id); pendientes.add(pendiente.id); }

  const paradasRetiradas = new Map<string, string>();
  const subsRetiradas = new Map<string, Map<string, string>>();
  const pendientesRetirados = new Set<string>();
  if (Object.hasOwn(plan, 'retiradas')) {
    const r: unknown = plan.retiradas;
    if (!registro(r, ['paradas', 'subparadas', 'pendientes'], true)) fallo();
    const de = (campo: string): readonly unknown[] => {
      if (!Object.hasOwn(r, campo)) return [];
      const v = r[campo];
      return lista(v) ? v : fallo();
    };
    // Cada retirada aparece una sola vez y nunca coincide con el viaje ni con un pendiente activo. Solo puede seguir
    // viva con OTRO tipo de visita (una parada que pasó a sitio de dentro): son tuplas distintas, nunca dos activas.
    const vistas = new Set<string>();
    const nueva = (id: unknown): string => {
      if (!texto(id) || vistas.has(id) || id === plan.id || pendientes.has(id)) fallo();
      vistas.add(id);
      return id;
    };
    for (const p of de('paradas')) {
      if (!registro(p, ['id', 'nombre']) || !texto(p.nombre)) fallo();
      const id = nueva(p.id);
      if (paradas.has(id)) fallo();
      paradasRetiradas.set(id, p.nombre);
    }
    for (const s of de('subparadas')) {
      if (!registro(s, ['paradaId', 'id', 'nombre']) || !texto(s.paradaId) || !texto(s.nombre)) fallo();
      const id = nueva(s.id);
      const padre = s.paradaId;
      if ((!paradas.has(padre) && !paradasRetiradas.has(padre)) || subparadas.get(padre)?.has(id)) fallo();
      if (!subsRetiradas.has(padre)) subsRetiradas.set(padre, new Map());
      subsRetiradas.get(padre)!.set(id, s.nombre);
    }
    for (const p of de('pendientes')) {
      if (!registro(p, ['id'])) fallo();
      const id = nueva(p.id);
      if (usadas.has(id)) fallo();
      pendientesRetirados.add(id);
    }
  }

  return {
    paradas: { activas: paradas, conocidas: new Set([...paradas, ...paradasRetiradas.keys()]) },
    pendientes: { activas: pendientes, conocidas: new Set([...pendientes, ...pendientesRetirados]) },
    destino(paradaId, subparadaId) {
      if (subparadaId === undefined) return paradas.has(paradaId) ? 'activo' : paradasRetiradas.has(paradaId) ? 'retirado' : null;
      if (subparadas.get(paradaId)?.has(subparadaId)) return 'activo';
      return subsRetiradas.get(paradaId)?.has(subparadaId) ? 'retirado' : null;
    },
    nombreRetirado(paradaId, subparadaId) {
      if (subparadaId === undefined) return paradasRetiradas.get(paradaId) ?? null;
      return subsRetiradas.get(paradaId)?.get(subparadaId) ?? null;
    },
  };
}
