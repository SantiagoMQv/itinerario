import { aplicarOperacion, crearProgreso, importarLegado } from './progreso';
import { campos, densa, esOperacion, esEstadoProgreso, iguales } from './progreso-validacion';
import { iniciarCola, agregarIntencion, proyectarCola, recibirInstantanea, marcarEnviada, cancelarIntencion, recibirAcuse, recibirRechazo, resolverRechazo } from './progreso-cola';
import type { Cola, EntradaCola, ResultadoCola, AcusePersistido, RechazoPersistido } from './progreso-cola';
import type { InstantaneaProgreso } from './progreso-validacion';
import type { EntradasLegadas, EstadoProgreso, Operacion, OperacionPendiente, RecuperacionLegada, ResultadoOperacion } from './progreso';
import type { Itinerario } from './tipos';
import { capturarBasePortable, copiarLimitesPortables, copiarPlanPortable, copiarValoresProgresoPortable, validarBasePortable, type BasePortable, type LimitesPortables, type PuertoAperturaPortable } from './portabilidad';

/** Formato anterior, solo para validar antes de migrar; IDB mantiene su versión 1. */
interface RegistroV1 {
  readonly formato: 1;
  readonly confirmado: EstadoProgreso;
  readonly estado: EstadoProgreso;
  readonly cola: readonly OperacionPendiente[];
  readonly legado?: { readonly originales: EntradasLegadas; readonly recuperacion: readonly RecuperacionLegada[] };
}
/** Una raíz por viaje. estado es exclusivamente la proyección cacheada de confirmado + cola.
 * revisionServidor ordena snapshots; no es una revisión de entidad ni prueba de autenticidad.
 */
export interface RegistroLocal {
  readonly formato: 3;
  readonly revisionServidor: number;
  readonly confirmado: EstadoProgreso;
  readonly estado: EstadoProgreso;
  readonly cola: readonly EntradaCola[];
  readonly legado?: RegistroV1['legado'];
}
export interface OpcionesProgresoLocal {
  readonly fabrica?: IDBFactory | null;
  readonly nombre?: string;
  /** Identidad causal, no credencial ni autorización. */
  readonly dispositivoId: string;
  readonly uuid?: () => string;
  /** Captura explícita; nunca se consulta ni se elimina localStorage. */
  readonly entradasLegadas?: EntradasLegadas;
}
export interface ProgresoLocal {
  leer(): Promise<RegistroLocal>;
  registrar(operacion: Operacion): Promise<ResultadoOperacion>;
  recibirInstantanea(instantanea: InstantaneaProgreso): Promise<ResultadoCola>;
  /** Disponibilidad durable, no autorización: resolver precede cualquier IO del futuro emisor. */
  marcarEnviada(operacionId: string): Promise<ResultadoCola>;
  cancelarIntencion(operacionId: string): Promise<ResultadoCola>;
  recibirAcuse(acuse: AcusePersistido): Promise<ResultadoCola>;
  /** Decisión durable separada de la revisión manual; nunca implica progreso aplicado. */
  recibirRechazo(rechazo: unknown): Promise<ResultadoCola>;
  resolverRechazo(operacionId: string): Promise<ResultadoCola>;
  /** No cancela transacciones ya iniciadas. Volver a abrir requiere abrirProgresoLocal. */
  cerrar(): void;
}
const almacen = 'viajes';
const objeto = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === 'object' && !Array.isArray(v);

/**
 * Invariantes históricas T2B1: base vacía y dependencias de toda la cola anterior.
 * Validamos el formato original completo antes de refinarlo con iniciarCola.
 * Nunca reinterpretamos un registro corrupto como un viaje nuevo.
 */
function validarV1(plan: Itinerario, valor: unknown): RegistroV1 {
  try {
    if (!campos(valor, ['formato', 'confirmado', 'estado', 'cola'], ['legado']) || valor.formato !== 1 || !densa(valor.cola)
      || !iguales(valor.confirmado, crearProgreso(plan))) throw new Error();
    let estado = crearProgreso(plan);
    const ids: string[] = [];
    for (const entrada of valor.cola) {
      if (!campos(entrada, ['operacion', 'dependeDe']) || !esOperacion(entrada.operacion)
        || !iguales(entrada.dependeDe, ids)) throw new Error();
      const operacion = entrada.operacion;
      const resultado = aplicarOperacion(plan, estado, operacion);
      if (resultado.tipo !== 'aplicada' && resultado.tipo !== 'sin-cambio') throw new Error();
      estado = resultado.estado;
      ids.push(operacion.id);
    }
    if (!iguales(valor.estado, estado)) throw new Error();
    validarLegado(valor);
    return valor as unknown as RegistroV1;
  } catch {
    throw new Error('Registro de progreso corrupto o formato no soportado');
  }
}

function validarLegado(valor: Record<string, unknown>): void {
  if (!Object.hasOwn(valor, 'legado')) return;
  const legado = valor.legado;
  if (!campos(legado, ['originales', 'recuperacion']) || !objeto(legado.originales) || !densa(legado.recuperacion)) throw new Error();
  for (const r of legado.recuperacion) {
    if (!campos(r, ['campo', 'valor', 'motivo'], ['clave']) || typeof r.campo !== 'string'
      || !['marcas', 'marcas-hora', 'pendientes-hechos'].includes(r.campo) || typeof r.motivo !== 'string'
      || !['malformada', 'desconocida', 'ambigua', 'estado-existente', 'conflicto-aqui'].includes(r.motivo)
      || (Object.hasOwn(r, 'clave') && typeof r.clave !== 'string')) throw new Error();
  }
}
function comoCola(raiz: RegistroLocal): Cola {
  return { confirmado: { revisionServidor: raiz.revisionServidor, estado: raiz.confirmado }, entradas: raiz.cola };
}
function desdeResultado(raiz: Pick<RegistroLocal, 'legado'>, resultado: ResultadoCola): RegistroLocal {
  if (!resultado.cola || !resultado.proyeccion) throw new Error('No se pudo reconstruir la cola');
  return { formato: 3, revisionServidor: resultado.cola.confirmado.revisionServidor,
    confirmado: resultado.cola.confirmado.estado, estado: resultado.proyeccion.estado,
    cola: resultado.cola.entradas, ...(raiz.legado === undefined ? {} : { legado: raiz.legado }) };
}
/** Invariante adicional de almacenamiento: el guard puro valida cada prueba y propietario,
 * pero la raíz conserva todos los testigos históricos, incluso después de lecturas nuevas. */
function historiaCoherente(cola: Cola): boolean {
  const pruebas = cola.entradas.flatMap((e) => e.rechazo ? [e.rechazo] : []);
  const testigos = [cola.confirmado, ...pruebas.map((r) => r.instantanea)];
  return testigos.every((s) => s.revisionServidor <= cola.confirmado.revisionServidor
    && pruebas.every((r) => !Object.hasOwn(s.estado.operaciones, r.operacionId))
    && testigos.every((otro) => otro.revisionServidor !== s.revisionServidor || iguales(otro.estado, s.estado)));
}
function validar(plan: Itinerario, valor: unknown, formato: 2 | 3 = 3): RegistroLocal {
  try {
    if (!campos(valor, ['formato', 'revisionServidor', 'confirmado', 'estado', 'cola'], ['legado'])
      || valor.formato !== formato || !esEstadoProgreso(plan, valor.estado)) throw new Error();
    // V2 tiene su esquema original: jamás admite metadatos incorporados en V3.
    if (formato === 2 && (!densa(valor.cola)
      || !valor.cola.every((e) => campos(e, ['operacion', 'dependeDe', 'enviada'])))) throw new Error();
    const raiz = valor as unknown as RegistroLocal;
    const resultado = proyectarCola(plan, comoCola(raiz));
    if (!resultado.cola || !resultado.proyeccion || !iguales(valor.estado, resultado.proyeccion.estado)) throw new Error();
    if (!historiaCoherente(resultado.cola)) throw new Error();
    validarLegado(valor);
    // El helper materializa el dominio; el legado conserva su clon estructurado, no se normaliza.
    return desdeResultado(raiz, resultado);
  } catch {
    throw new Error('Registro de progreso corrupto o formato no soportado');
  }
}
function migrar(plan: Itinerario, valor: unknown): RegistroLocal {
  const anterior = validarV1(plan, valor);
  return desdeResultado(anterior, iniciarCola(plan, { revisionServidor: 0, estado: anterior.confirmado },
    anterior.cola.map((e) => e.operacion)));
}
function encolar(plan: Itinerario, raiz: RegistroLocal, operacion: Operacion): {
  raiz: RegistroLocal; resultado: ResultadoOperacion;
} {
  if (!esOperacion(operacion)) return { raiz,
    resultado: { tipo: 'invalida', estado: raiz.estado, motivo: 'Esquema de operación o recibo inválido' } };
  const existente = raiz.cola.find((e) => e.operacion.id === operacion.id);
  if (existente) return { raiz, resultado: iguales(operacion, existente.operacion)
    ? { tipo: 'duplicada', estado: raiz.estado }
    : { tipo: 'invalida', estado: raiz.estado, motivo: 'ID reutilizado con otra intención' } };
  const resultado = aplicarOperacion(plan, raiz.estado, operacion);
  if (resultado.tipo !== 'aplicada' && resultado.tipo !== 'sin-cambio') return { raiz, resultado };
  return { resultado, raiz: desdeResultado(raiz, agregarIntencion(plan, comoCola(raiz), operacion)) };
}

function inicializar(plan: Itinerario, opciones: OpcionesProgresoLocal): RegistroLocal {
  const confirmado = crearProgreso(plan);
  let raiz = desdeResultado({}, iniciarCola(plan, { revisionServidor: 0, estado: confirmado }));
  if (opciones.entradasLegadas === undefined) return raiz;
  const importado = importarLegado(plan, confirmado, opciones.entradasLegadas);
  raiz = { ...raiz, legado: { originales: importado.originales, recuperacion: importado.recuperacion } };
  const uuid = opciones.uuid ?? (() => globalThis.crypto.randomUUID());
  function agregar(campos: Omit<Extract<Operacion, { tipo: 'parada' }>, 'id' | 'dispositivoId'>
    | Omit<Extract<Operacion, { tipo: 'pendiente' }>, 'id' | 'dispositivoId'>) {
    const siguiente = encolar(plan, raiz, { ...campos, id: uuid(), dispositivoId: opciones.dispositivoId });
    if (siguiente.resultado.tipo !== 'aplicada') throw new Error('No se pudo crear la intención legada');
    raiz = siguiente.raiz;
  }
  // Se leen registros interpretados, no firmas ni recibos sintéticos del importador.
  for (const [paradaId, registro] of Object.entries(importado.estado.paradas)) {
    agregar({ tipo: 'parada', paradaId, marca: registro.marca, revision: 0,
      ...(registro.horaReal === undefined ? {} : { horaReal: registro.horaReal }),
      ...(registro.marca === 'aqui' ? { revisionAqui: raiz.estado.aqui.revision } : {}) });
  }
  for (const [pendienteId, registro] of Object.entries(importado.estado.pendientes)) {
    agregar({ tipo: 'pendiente', pendienteId, hecho: registro.hecho, revision: 0 });
  }
  return raiz;
}

function comprobarEsquemaProgreso(db: IDBDatabase, tx?: IDBTransaction): void {
  if (db.objectStoreNames.length !== 1 || !db.objectStoreNames.contains(almacen)) {
    throw new Error('El esquema IndexedDB no está soportado');
  }
  const tabla = (tx ?? db.transaction(almacen)).objectStore(almacen);
  if (tabla.keyPath !== null || tabla.autoIncrement || tabla.indexNames.length) {
    throw new Error('El esquema IndexedDB no está soportado');
  }
}
/** Viaje único, raíz v3 entera. No migra v1/v2 ni materializa desdeResultado como salida. */
export function validarProgresoPortable(plan: Itinerario, base: BasePortable): void {
  validarBasePortable(base, [almacen]);
  if (!base.presente) return;
  for (const r of base.tablas[almacen]) {
    try {
      if (r.clave !== plan.id) throw new Error('Otro viaje o clave desconocida fuera del alcance');
      validar(plan, r.valor);
    } catch (e) { throw new Error(`ProgressDB/${almacen}/${r.clave}: ${e instanceof Error ? e.message : 'inválido'}`); }
  }
}
/** Base ausente y registro ausente son distintos; cursor incluye undefined almacenado. */
export async function capturarProgresoLocal(planEntrada: Itinerario, limites: LimitesPortables,
  opciones: { readonly fabrica?: PuertoAperturaPortable | null; readonly nombre?: string } = {}): Promise<BasePortable> {
  const plan = copiarPlanPortable(planEntrada);
  const fabrica = opciones.fabrica === undefined ? globalThis.indexedDB : opciones.fabrica;
  const nombre = opciones.nombre ?? 'itinerario-progreso';
  const limitesFijos = copiarLimitesPortables(limites);
  return capturarBasePortable(fabrica, nombre, [almacen], limitesFijos, (db, tx) => {
    if (db.version !== 1) throw new Error('ProgressDB: versión no soportada');
    comprobarEsquemaProgreso(db, tx);
  }, (base) => validarProgresoPortable(plan, base), (raw, clave) => {
    if (clave !== plan.id) throw new Error('Otro viaje o clave desconocida fuera del alcance');
    const copia = copiarValoresProgresoPortable(raw, limitesFijos);
    validar(plan, copia); // Guard propio, sin usar su materialización como salida RAW.
    return copia;
  });
}
function abrirBase(fabrica: IDBFactory, nombre: string): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const solicitud = fabrica.open(nombre, 1);
    let terminada = false;
    solicitud.onupgradeneeded = (evento) => {
      if (evento.oldVersion === 0) solicitud.result.createObjectStore(almacen);
    };
    solicitud.onerror = () => { terminada = true; reject(solicitud.error); };
    // IndexedDB no permite cancelar una apertura bloqueada: cerramos cualquier éxito tardío.
    solicitud.onblocked = () => { terminada = true; reject(new Error('Apertura IndexedDB bloqueada; cerrar otras conexiones y reintentar')); };
    solicitud.onsuccess = () => {
      const db = solicitud.result;
      if (terminada) { db.close(); return; }
      terminada = true;
      try {
        comprobarEsquemaProgreso(db);
        resolve(db);
      } catch (error) {
        db.close(); reject(error);
      }
    };
  });
}

export async function abrirProgresoLocal(plan: Itinerario, opciones: OpcionesProgresoLocal): Promise<ProgresoLocal> {
  const fabrica = opciones.fabrica === undefined ? globalThis.indexedDB : opciones.fabrica;
  if (!fabrica) throw new Error('IndexedDB no está disponible');
  if (typeof opciones.dispositivoId !== 'string' || !opciones.dispositivoId.trim()) {
    throw new Error('Identidad de dispositivo inválida');
  }
  // Aísla argumentos antes de iniciar cualquier transacción (también expone DataCloneError).
  const copiaPlan = structuredClone(plan);
  crearProgreso(copiaPlan);
  const copiaOpciones = { ...opciones, entradasLegadas: structuredClone(opciones.entradasLegadas) };
  const db = await abrirBase(fabrica, opciones.nombre ?? 'itinerario-progreso');
  let cerrado = false;
  const cerrar = () => { cerrado = true; db.close(); };
  db.onversionchange = cerrar;
  db.onclose = () => { cerrado = true; };

  /** Ningún await dentro de la transacción: solo callbacks síncronos de requests. */
  function transaccion<T>(modo: IDBTransactionMode, trabajo: (valor: unknown) => {
    valor: T; guardar?: RegistroLocal;
  }): Promise<T> {
    return new Promise((resolve, reject) => {
      if (cerrado) { reject(new Error('El almacén está cerrado')); return; }
      const tx = db.transaction(almacen, modo);
      let valor: T;
      let error: unknown;
      tx.oncomplete = () => resolve(valor);
      tx.onerror = (evento) => { error ??= (evento.target as IDBRequest).error ?? tx.error; };
      tx.onabort = () => reject(error ?? tx.error ?? new DOMException('Transacción abortada', 'AbortError'));
      const tabla = tx.objectStore(almacen);
      const solicitud = tabla.get(copiaPlan.id);
      solicitud.onsuccess = () => {
        try {
          const salida = trabajo(solicitud.result);
          valor = structuredClone(salida.valor);
          if (salida.guardar) tabla.put(salida.guardar, copiaPlan.id);
        } catch (causa) {
          error = causa;
          tx.abort();
        }
      };
    });
  }
  try {
    await transaccion('readwrite', (valor) => {
      if (valor === undefined) return { valor: undefined, guardar: inicializar(copiaPlan, copiaOpciones) };
      if (campos(valor, ['formato', 'confirmado', 'estado', 'cola'], ['legado']) && valor.formato === 1) {
        return { valor: undefined, guardar: migrar(copiaPlan, valor) };
      }
      if (campos(valor, ['formato', 'revisionServidor', 'confirmado', 'estado', 'cola'], ['legado']) && valor.formato === 2) {
        return { valor: undefined, guardar: validar(copiaPlan, valor, 2) };
      }
      validar(copiaPlan, valor);
      return { valor: undefined };
    });
  } catch (error) {
    cerrar();
    throw error;
  }
  function raizExistente(valor: unknown): RegistroLocal {
    if (valor === undefined) throw new Error('Falta el registro de progreso; no se restablece automáticamente');
    return validar(copiaPlan, valor);
  }
  function modificar(trabajo: (cola: Cola) => ResultadoCola): Promise<ResultadoCola> {
    return transaccion('readwrite', (valor) => {
      const raiz = raizExistente(valor);
      const resultado = trabajo(comoCola(raiz));
      if (resultado.cola && !historiaCoherente(resultado.cola)) {
        return { valor: { ...proyectarCola(copiaPlan, comoCola(raiz)), tipo: 'conflicto' as const,
          motivo: 'Decisión incompatible con los testigos históricos almacenados' } };
      }
      const guardar = resultado.cola && resultado.proyeccion && !iguales(resultado.cola, comoCola(raiz));
      return { valor: resultado, ...(guardar ? { guardar: desdeResultado(raiz, resultado) } : {}) };
    });
  }
  // Capturamos mediante la frontera pura ANTES del clon IDB: structuredClone omite propios
  // no enumerables. Nunca aplicamos esta materialización a respaldos arbitrarios legados.
  function capturarInstantanea(valor: unknown): InstantaneaProgreso | null {
    const resultado = iniciarCola(copiaPlan, valor);
    if (resultado.cola) return resultado.cola.confirmado;
    structuredClone(valor); // Propaga DataCloneError aun si el esquema es inválido.
    return null;
  }
  return {
    cerrar,
    leer: () => transaccion('readonly', (valor) => ({ valor: raizExistente(valor) })),
    registrar: async (operacion) => {
      const valida = esOperacion(operacion);
      const copia = valida
        ? iniciarCola(copiaPlan, { revisionServidor: 0, estado: crearProgreso(copiaPlan) }, [operacion]).cola!.entradas[0].operacion
        : structuredClone(operacion);
      return transaccion('readwrite', (valor) => {
        const raiz = raizExistente(valor);
        if (!valida) return { valor: { tipo: 'invalida' as const, estado: raiz.estado, motivo: 'Esquema de operación inválido' } };
        const siguiente = encolar(copiaPlan, raiz, copia);
        return { valor: siguiente.resultado, ...(siguiente.raiz === raiz ? {} : { guardar: siguiente.raiz }) };
      });
    },
    recibirInstantanea: async (instantanea) => {
      const copia = capturarInstantanea(instantanea);
      return modificar((cola) => recibirInstantanea(copiaPlan, cola, copia));
    },
    marcarEnviada: (id) => modificar((cola) => {
      const entrada = cola.entradas.find((e) => e.operacion.id === id);
      if (entrada && !entrada.enviada) {
        const proyeccion = proyectarCola(copiaPlan, cola).proyeccion!;
        if (entrada.dependeDe.length || proyeccion.entradas.find((e) => e.operacionId === id)?.tipo !== 'lista') {
          return { tipo: 'conflicto', cola, proyeccion, motivo: 'Requiere acuse causal explícito y proyección lista' };
        }
      }
      return marcarEnviada(copiaPlan, cola, id);
    }),
    cancelarIntencion: (id) => modificar((cola) => cancelarIntencion(copiaPlan, cola, id)),
    recibirRechazo: async (rechazo) => {
      // Validar ANTES de leer/capturar campos: el guard puro rechaza accessors sin ejecutarlos.
      const vacia = iniciarCola(copiaPlan, { revisionServidor: 0, estado: crearProgreso(copiaPlan) }).cola!;
      const validacion = recibirRechazo(copiaPlan, vacia, rechazo);
      let copia: RechazoPersistido | null = null;
      if (validacion.tipo !== 'invalida') {
        const decision = rechazo as RechazoPersistido;
        // Hidratar con el testigo propio permite la materialización canónica del helper,
        // incluso para una prueba histórica que difiere de nuestra base actual.
        const capturada = proyectarCola(copiaPlan, { confirmado: decision.instantanea,
          entradas: [{ operacion: decision.operacionOriginal, dependeDe: [], enviada: true, rechazo: decision }] });
        copia = capturada.cola!.entradas[0].rechazo!;
      }
      return modificar((cola) => recibirRechazo(copiaPlan, cola, copia));
    },
    resolverRechazo: (id) => modificar((cola) => resolverRechazo(copiaPlan, cola, id)),
    recibirAcuse: async (acuse) => {
      // El reconciliador valida el acuse, incluso sin entrada: no duplicamos su esquema.
      const vacia = iniciarCola(copiaPlan, { revisionServidor: 0, estado: crearProgreso(copiaPlan) }).cola!;
      if (recibirAcuse(copiaPlan, vacia, acuse).tipo === 'invalida') {
        structuredClone(acuse);
        return modificar((cola) => recibirAcuse(copiaPlan, cola, null));
      }
      const copia = { operacionId: acuse.operacionId, persistida: true,
        instantanea: capturarInstantanea(acuse.instantanea) };
      return modificar((cola) => recibirAcuse(copiaPlan, cola, copia));
    },
  };
}
