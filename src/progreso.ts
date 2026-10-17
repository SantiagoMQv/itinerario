import type { Itinerario } from './tipos';
import { identidades } from './identidades';

/** Núcleo puro de un viaje. No consulta reloj, almacenamiento, preferencias ni red. */
export type Marca = 'hecha' | 'saltada' | 'aqui';
export interface RegistroParada {
  readonly marca: Marca | null;
  /** Minutos de China: metadato de llegada/salida, nunca orden causal. */
  readonly horaReal?: number;
  readonly revision: number;
}
export interface RegistroPendiente { readonly hecho: boolean; readonly revision: number }
export interface Aqui { readonly paradaId: string | null; readonly revision: number }
type Cambio =
  | { readonly tipo: 'parada'; readonly id: string; readonly antes: RegistroParada; readonly despues: RegistroParada }
  | { readonly tipo: 'pendiente'; readonly id: string; readonly antes: RegistroPendiente; readonly despues: RegistroPendiente };
/** Recibo mínimo reversible. Las revisiones del después son precondiciones estrictas del deshacer. */
export interface Cambios {
  readonly operacionId: string;
  readonly registros: readonly Cambio[];
  readonly aqui?: { readonly antes: Aqui; readonly despues: Aqui };
}
interface Acuse { readonly firma: string; readonly cambios?: Cambios }
export interface EstadoProgreso {
  readonly viajeId: string;
  readonly paradas: Readonly<Record<string, RegistroParada>>;
  readonly pendientes: Readonly<Record<string, RegistroPendiente>>;
  readonly aqui: Aqui;
  /** IDs globalmente únicos en este viaje. T2B debe persistir estos acuses junto al estado. */
  readonly operaciones: Readonly<Record<string, Acuse>>;
}
interface IdentidadOperacion { readonly id: string; readonly dispositivoId: string }
export type Operacion = IdentidadOperacion & (
  | { readonly tipo: 'parada'; readonly paradaId: string; readonly marca: Marca | null;
      readonly horaReal?: number; readonly revision: number; readonly revisionAqui?: number;
      readonly revisionAnterior?: number }
  | { readonly tipo: 'pendiente'; readonly pendienteId: string; readonly hecho: boolean; readonly revision: number }
  | { readonly tipo: 'deshacer'; readonly cambios: Cambios }
);
export type ResultadoOperacion =
  | { readonly tipo: 'aplicada'; readonly estado: EstadoProgreso; readonly cambios: Cambios }
  | { readonly tipo: 'sin-cambio' | 'duplicada'; readonly estado: EstadoProgreso }
  | { readonly tipo: 'conflicto' | 'invalida'; readonly estado: EstadoProgreso; readonly motivo: string };

const revisionValida = (n: number) => Number.isSafeInteger(n) && n >= 0;
const revisionIncrementable = (n: number) => revisionValida(n) && n < Number.MAX_SAFE_INTEGER;
const textoValido = (s: string) => typeof s === 'string' && s.trim().length > 0;
const marcaValida = (m: unknown): m is Marca => m === 'hecha' || m === 'saltada' || m === 'aqui';
const horaValida = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n);
const vacia = (): RegistroParada => ({ marca: null, revision: 0 });
const pendienteVacio = (): RegistroPendiente => ({ hecho: false, revision: 0 });
const propia = <T>(registros: Readonly<Record<string, T>>, id: string): T | undefined =>
  Object.hasOwn(registros, id) ? registros[id] : undefined;
const paradaDe = (e: EstadoProgreso, id: string) => propia(e.paradas, id) ?? vacia();
const pendienteDe = (e: EstadoProgreso, id: string) => propia(e.pendientes, id) ?? pendienteVacio();
const igualParada = (a: RegistroParada, b: RegistroParada) => a.marca === b.marca && a.horaReal === b.horaReal;

/** Valida el catálogo entero (activas y retiradas) y deja a mano lo activo que necesita el legado. */
function catalogo(plan: Itinerario) {
  const ids = identidades(plan);
  const paradas = plan.dias.flatMap((dia) => dia.paradas.map((parada) => ({ id: parada.id, nombre: parada.nombre,
    fecha: dia.fecha, clave: `${dia.fecha}|${parada.hora}|${parada.nombre}` })));
  return { paradas, pendientes: plan.pendientes ?? [], ids };
}

export function crearProgreso(plan: Itinerario): EstadoProgreso {
  catalogo(plan);
  return { viajeId: plan.id, paradas: {}, pendientes: {}, aqui: { paradaId: null, revision: 0 }, operaciones: {} };
}

function firmaCambios(cambios: Cambios): string {
  const valor = (registro: RegistroParada | RegistroPendiente) => 'marca' in registro
    ? [registro.marca, registro.horaReal ?? null, registro.revision]
    : [registro.hecho, registro.revision];
  return JSON.stringify([cambios.operacionId, cambios.registros.map((c) =>
    [c.tipo, c.id, valor(c.antes), valor(c.despues)]), cambios.aqui
    ? [cambios.aqui.antes.paradaId, cambios.aqui.antes.revision,
      cambios.aqui.despues.paradaId, cambios.aqui.despues.revision] : null]);
}

// Firma con orden de campos fijo: reintentar objetos reconstruidos no depende del orden de sus propiedades.
function firma(op: Operacion): string {
  const identidad = [op.id, op.dispositivoId, op.tipo];
  if (op.tipo === 'parada') return JSON.stringify([...identidad, op.paradaId, op.marca, op.horaReal ?? null,
    op.revision, op.revisionAqui ?? null, op.revisionAnterior ?? null]);
  if (op.tipo === 'pendiente') return JSON.stringify([...identidad, op.pendienteId, op.hecho, op.revision]);
  return JSON.stringify([...identidad, firmaCambios(op.cambios)]);
}

/**
 * Entradas tipadas; el adaptador de red debe validar esquema y snapshots antes de llamar al núcleo.
 * Los acuses no caducan aquí: su retención/compactación requiere una política idempotente del servidor.
 * Una parada o un pendiente retirados (`plan.retiradas`) solo se reconocen: el replay exacto de lo ya
 * aceptado sigue dando «duplicada», pero una operación nueva sobre ellos es inválida y no se aplica.
 */
export function aplicarOperacion(plan: Itinerario, estado: EstadoProgreso, op: Operacion): ResultadoOperacion {
  return aplicar(plan, estado, op, false);
}
/**
 * SOLO para comprobar la integridad de lo ya guardado (`proyectarColaGuardada`): reproduce una operación con las
 * reglas con las que se guardó, cuando sus retiradas aún eran del plan. Nunca para operar, enviar ni acusar.
 */
export function aplicarOperacionGuardada(plan: Itinerario, estado: EstadoProgreso, op: Operacion): ResultadoOperacion {
  return aplicar(plan, estado, op, true);
}
function aplicar(plan: Itinerario, estado: EstadoProgreso, op: Operacion, comoGuardada: boolean): ResultadoOperacion {
  const invalida = (motivo: string): ResultadoOperacion => ({ tipo: 'invalida', estado, motivo });
  const conflicto = (motivo: string): ResultadoOperacion => ({ tipo: 'conflicto', estado, motivo });
  const { ids } = catalogo(plan);
  if (estado.viajeId !== plan.id || !textoValido(op.id) || !textoValido(op.dispositivoId)) {
    return invalida('Viaje o identidad de operación inválidos');
  }
  let retirada = false;
  if (op.tipo === 'parada') {
    if (!ids.paradas.conocidas.has(op.paradaId) || !revisionValida(op.revision)
      || (op.marca !== null && !marcaValida(op.marca))
      || (op.horaReal !== undefined && (!horaValida(op.horaReal) || op.marca === null))) {
      return invalida('Parada, revisión, marca u hora inválida');
    }
    for (const revision of [op.revisionAqui, op.revisionAnterior]) {
      if (revision !== undefined && !revisionValida(revision)) return invalida('Revisión inválida');
    }
    retirada = !ids.paradas.activas.has(op.paradaId);
  } else if (op.tipo === 'pendiente') {
    if (!ids.pendientes.conocidas.has(op.pendienteId)
      || typeof op.hecho !== 'boolean' || !revisionValida(op.revision)) return invalida('Pendiente inválido');
    retirada = !ids.pendientes.activas.has(op.pendienteId);
  } else if (op.tipo !== 'deshacer') return invalida('Tipo desconocido');

  const huella = firma(op);
  const acuse = propia(estado.operaciones, op.id);
  if (acuse) return acuse.firma === huella ? { tipo: 'duplicada', estado } : invalida('ID reutilizado con otro contenido');
  if (retirada && !comoGuardada) return invalida('Ya no está en el plan: no se aplica');
  const registros: Cambio[] = [];
  let cambioAqui: Cambios['aqui'];
  if (op.tipo === 'parada') {
    const antes = paradaDe(estado, op.paradaId);
    const despues: RegistroParada = { marca: op.marca, revision: antes.revision,
      ...(op.horaReal === undefined ? {} : { horaReal: op.horaReal }) };
    const tocaAqui = op.marca === 'aqui' || estado.aqui.paradaId === op.paradaId;
    if ((tocaAqui || op.revisionAqui !== undefined) && op.revisionAqui !== estado.aqui.revision) {
      return conflicto('Cambió la ubicación aquí');
    }
    // Un no-op puede reconciliar una revisión vieja, pero nunca una hora distinta ni una casilla false distinta.
    const igual = propia(estado.paradas, op.paradaId) !== undefined && igualParada(antes, despues);
    if (!igual && antes.revision !== op.revision) return conflicto('Cambió la parada');
    if (!igual) {
      if (!revisionIncrementable(antes.revision)) return invalida('Revisión de parada agotada');
      registros.push({ tipo: 'parada', id: op.paradaId, antes,
        despues: { ...despues, revision: antes.revision + 1 } });
    }
    if (op.marca === 'aqui' && estado.aqui.paradaId && estado.aqui.paradaId !== op.paradaId) {
      const id = estado.aqui.paradaId;
      const anterior = paradaDe(estado, id);
      if (op.revisionAnterior !== anterior.revision) return conflicto('Cambió la parada anterior');
      if (!revisionIncrementable(anterior.revision)) return invalida('Revisión de parada anterior agotada');
      // Su hora era llegada, no salida. No la reutilizamos como una salida inventada.
      registros.push({ tipo: 'parada', id, antes: anterior,
        despues: { marca: 'hecha', revision: anterior.revision + 1 } });
    }
    if (tocaAqui && registros.length) {
      if (!revisionIncrementable(estado.aqui.revision)) return invalida('Revisión global aquí agotada');
      cambioAqui = { antes: estado.aqui,
        despues: { paradaId: op.marca === 'aqui' ? op.paradaId : null, revision: estado.aqui.revision + 1 } };
    }
  } else if (op.tipo === 'pendiente') {
    const antes = pendienteDe(estado, op.pendienteId);
    const igual = propia(estado.pendientes, op.pendienteId) !== undefined && antes.hecho === op.hecho;
    if (!igual && antes.revision !== op.revision) return conflicto('Cambió la casilla');
    if (!igual) {
      if (!revisionIncrementable(antes.revision)) return invalida('Revisión de casilla agotada');
      registros.push({ tipo: 'pendiente', id: op.pendienteId, antes,
        despues: { hecho: op.hecho, revision: antes.revision + 1 } });
    }
  } else {
    const recibo = propia(estado.operaciones, op.cambios.operacionId)?.cambios;
    // El inverso solo puede proceder de un recibo aplicado en este viaje, no de una instantánea arbitraria.
    if (!recibo || firmaCambios(recibo) !== firmaCambios(op.cambios)) return invalida('Recibo de deshacer desconocido');
    for (const cambio of recibo.registros) {
      const actual = cambio.tipo === 'parada' ? paradaDe(estado, cambio.id) : pendienteDe(estado, cambio.id);
      if (actual.revision !== cambio.despues.revision) return conflicto('Un registro de la operación cambió');
    }
    if (recibo.aqui && estado.aqui.revision !== recibo.aqui.despues.revision) return conflicto('Aquí cambió después');
    // Comprobar todos los contadores antes de construir el inverso mantiene el rechazo atómico.
    if (recibo.registros.some((c) => !revisionIncrementable(c.despues.revision))) {
      return invalida('Revisión de registro agotada al deshacer');
    }
    if (recibo.aqui && !revisionIncrementable(estado.aqui.revision)) {
      return invalida('Revisión global aquí agotada al deshacer');
    }
    for (const cambio of recibo.registros) {
      if (cambio.tipo === 'parada') registros.push({ ...cambio, antes: paradaDe(estado, cambio.id),
        despues: { ...cambio.antes, revision: cambio.despues.revision + 1 } });
      else registros.push({ ...cambio, antes: pendienteDe(estado, cambio.id),
        despues: { ...cambio.antes, revision: cambio.despues.revision + 1 } });
    }
    if (recibo.aqui) cambioAqui = { antes: estado.aqui,
      despues: { paradaId: recibo.aqui.antes.paradaId, revision: estado.aqui.revision + 1 } };
  }

  const cambios: Cambios = { operacionId: op.id, registros, ...(cambioAqui ? { aqui: cambioAqui } : {}) };
  const paradas = { ...estado.paradas };
  const pendientes = { ...estado.pendientes };
  for (const cambio of registros) {
    // defineProperty también admite IDs opacos como "__proto__" sin activar setters del prototipo.
    Object.defineProperty(cambio.tipo === 'parada' ? paradas : pendientes, cambio.id,
      { value: cambio.despues, enumerable: true, writable: true, configurable: true });
  }
  const aqui = cambioAqui?.despues ?? estado.aqui;
  const activos = Object.entries(paradas).filter(([, p]) => p.marca === 'aqui').map(([id]) => id);
  if (activos.length > 1 || (activos[0] ?? null) !== aqui.paradaId) return invalida('Invariante aquí inválida');
  const nuevo: EstadoProgreso = { ...estado, paradas, pendientes, aqui,
    operaciones: { ...estado.operaciones, [op.id]: { firma: huella, ...(registros.length ? { cambios } : {}) } } };
  return registros.length ? { tipo: 'aplicada', estado: nuevo, cambios } : { tipo: 'sin-cambio', estado: nuevo };
}

export function prepararDeshacer(cambios: Cambios, id: string, dispositivoId: string): Operacion {
  return { id, dispositivoId, tipo: 'deshacer', cambios: structuredClone(cambios) };
}

export interface OperacionPendiente { readonly operacion: Operacion; readonly dependeDe: readonly string[] }
/**
 * Solo cancela una intención no enviada. No altera un estado optimista ni reconstruye la cola.
 * T2B/T4 deben guardar dependencias, distinguir envío/acuse y reproyectar desde el estado confirmado.
 * Si existen dependientes, la decisión de rebase/cancelación queda explícitamente sin resolver.
 */
export function cancelarPendiente(pendientes: readonly OperacionPendiente[], id: string): {
  tipo: 'cancelada' | 'conflicto' | 'ausente'; pendientes: readonly OperacionPendiente[];
} {
  if (!pendientes.some((p) => p.operacion.id === id)) return { tipo: 'ausente', pendientes };
  if (pendientes.some((p) => p.dependeDe.includes(id))) return { tipo: 'conflicto', pendientes };
  return { tipo: 'cancelada', pendientes: pendientes.filter((p) => p.operacion.id !== id) };
}

/** Valores parseados clonables o los blobs JSON originales. No lee ni elimina claves reales. */
export interface EntradasLegadas {
  readonly marcas?: unknown;
  readonly 'marcas-hora'?: unknown;
  readonly 'pendientes-hechos'?: unknown;
  readonly [campo: string]: unknown;
}
type CampoLegado = 'marcas' | 'marcas-hora' | 'pendientes-hechos';
export interface RecuperacionLegada {
  readonly campo: CampoLegado;
  readonly clave?: string;
  readonly valor: unknown;
  readonly motivo: 'malformada' | 'desconocida' | 'ambigua' | 'estado-existente' | 'conflicto-aqui';
}
export interface ResultadoImportacion {
  readonly estado: EstadoProgreso;
  readonly originales: EntradasLegadas;
  readonly recuperacion: readonly RecuperacionLegada[];
}
const objeto = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);

export function importarLegado(plan: Itinerario, inicial: EstadoProgreso, entradas: EntradasLegadas): ResultadoImportacion {
  const fuente = catalogo(plan);
  if (inicial.viajeId !== plan.id) throw new Error('La importación pertenece a otro viaje');
  // Conserva incluso campos desconocidos y JSON roto. El adaptador debe guardar este resultado, no borrarlo.
  const originales = structuredClone(entradas);
  const recuperacion: RecuperacionLegada[] = [];
  const recuperar = (campo: CampoLegado, valor: unknown, motivo: RecuperacionLegada['motivo'], clave?: string) => {
    recuperacion.push({ campo, valor: structuredClone(valor), motivo, ...(clave === undefined ? {} : { clave }) });
  };
  function leer(campo: CampoLegado, lista = false): unknown {
    const original = entradas[campo];
    if (original === undefined) return lista ? [] : {};
    let valor: unknown = original;
    try { if (typeof valor === 'string') valor = JSON.parse(valor) as unknown; }
    catch { recuperar(campo, original, 'malformada'); return lista ? [] : {}; }
    if (!(lista ? Array.isArray(valor) : objeto(valor))) {
      recuperar(campo, original, 'malformada'); return lista ? [] : {};
    }
    return valor;
  }
  const marcas = leer('marcas') as Record<string, unknown>;
  const horas = leer('marcas-hora') as Record<string, unknown>;
  const hechos = leer('pendientes-hechos', true) as unknown[];
  const clavesActuales = new Set(fuente.paradas.map((p) => p.clave));
  const validas = new Map<string, Marca>();
  for (const [clave, valor] of Object.entries(marcas)) {
    if (marcaValida(valor)) validas.set(clave, valor);
    else recuperar('marcas', valor, 'malformada', clave);
  }
  const usadas = new Set<string>();
  const ambiguas = new Set<string>();
  const candidatas: { id: string; clave: string; marca: Marca }[] = [];
  for (const parada of fuente.paradas) {
    // Una exacta presente, incluso inválida, impide adivinar otra marca obsoleta.
    if (Object.hasOwn(marcas, parada.clave)) {
      if (fuente.paradas.filter((p) => p.clave === parada.clave).length > 1) {
        ambiguas.add(parada.clave); continue;
      }
      const marca = validas.get(parada.clave);
      if (marca) { candidatas.push({ id: parada.id, clave: parada.clave, marca }); usadas.add(parada.clave); }
      continue;
    }
    const viejas = Object.keys(marcas).filter((clave) => {
      const partes = /^(\d{4}-\d{2}-\d{2})\|([0-2]\d:[0-5]\d)\|(.+)$/.exec(clave);
      return partes && partes[1] === parada.fecha && partes[3] === parada.nombre && !clavesActuales.has(clave);
    });
    const unica = fuente.paradas.filter((p) => p.fecha === parada.fecha && p.nombre === parada.nombre).length === 1;
    if (!unica || viejas.length > 1) { for (const clave of viejas) ambiguas.add(clave); continue; }
    if (viejas.length === 1) {
      const clave = viejas[0];
      const marca = validas.get(clave);
      if (marca) { candidatas.push({ id: parada.id, clave, marca }); usadas.add(clave); }
    }
  }
  for (const [clave, marca] of validas) {
    if (!usadas.has(clave)) recuperar('marcas', marca, ambiguas.has(clave) ? 'ambigua' : 'desconocida', clave);
  }
  const horasValidas = new Map<string, number>();
  for (const [clave, valor] of Object.entries(horas)) {
    if (!horaValida(valor)) recuperar('marcas-hora', valor, 'malformada', clave);
    else if (!usadas.has(clave)) recuperar('marcas-hora', valor, 'desconocida', clave);
    else horasValidas.set(clave, valor);
  }
  // Incluso un aquí desconocido mantiene la ambigüedad: no elegimos silenciosamente un ganador.
  const variosAqui = [...validas.values()].filter((m) => m === 'aqui').length > 1;
  let estado = inicial;
  for (const candidata of candidatas) {
    const { id, clave, marca } = candidata;
    if (paradaDe(estado, id).revision > 0) {
      recuperar('marcas', marcas[clave], 'estado-existente', clave); continue;
    }
    if (marca === 'aqui' && (variosAqui || estado.aqui.paradaId !== null)) {
      recuperar('marcas', marcas[clave], 'conflicto-aqui', clave); continue;
    }
    const horaReal = horasValidas.get(clave);
    const resultado = aplicarOperacion(plan, estado, { tipo: 'parada', paradaId: id, marca, horaReal,
      revision: 0, revisionAqui: estado.aqui.revision, dispositivoId: 'importacion-legada',
      id: JSON.stringify(['legado', plan.id, 'marcas', clave, marca, horaReal ?? null]) });
    if (resultado.tipo === 'aplicada' || resultado.tipo === 'sin-cambio') estado = resultado.estado;
    else recuperar('marcas', marcas[clave], 'estado-existente', clave);
  }
  for (const [indice, texto] of hechos.entries()) {
    if (typeof texto !== 'string') { recuperar('pendientes-hechos', texto, 'malformada', String(indice)); continue; }
    const candidatos = fuente.pendientes.filter((p) => p.texto === texto);
    if (candidatos.length !== 1) {
      recuperar('pendientes-hechos', texto, candidatos.length ? 'ambigua' : 'desconocida', String(indice)); continue;
    }
    const id = candidatos[0].id;
    if (pendienteDe(estado, id).revision > 0) {
      recuperar('pendientes-hechos', texto, 'estado-existente', String(indice)); continue;
    }
    const resultado = aplicarOperacion(plan, estado, { tipo: 'pendiente', pendienteId: id, hecho: true,
      revision: 0, dispositivoId: 'importacion-legada', id: JSON.stringify(['legado', plan.id, 'pendientes', id]) });
    if (resultado.tipo === 'aplicada' || resultado.tipo === 'sin-cambio') estado = resultado.estado;
    else recuperar('pendientes-hechos', texto, 'estado-existente', String(indice));
  }
  return { estado, originales, recuperacion };
}
