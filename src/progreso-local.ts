import { aplicarOperacion, crearProgreso, importarLegado } from './progreso';
import type { EntradasLegadas, EstadoProgreso, Operacion, OperacionPendiente, RecuperacionLegada, ResultadoOperacion } from './progreso';
import type { Itinerario } from './tipos';

/** Un registro por viaje: toda modificación sustituye esta raíz en una única transacción. */
export interface RegistroLocal {
  readonly formato: 1;
  readonly confirmado: EstadoProgreso;
  readonly estado: EstadoProgreso;
  readonly cola: readonly OperacionPendiente[];
  readonly legado?: { readonly originales: EntradasLegadas; readonly recuperacion: readonly RecuperacionLegada[] };
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
  /** No cancela transacciones ya iniciadas. Volver a abrir requiere abrirProgresoLocal. */
  cerrar(): void;
}
const almacen = 'viajes';
const objeto = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === 'object' && !Array.isArray(v);

const plano = (v: unknown): v is Record<string, unknown> => objeto(v)
  && (Object.getPrototypeOf(v) === Object.prototype || Object.getPrototypeOf(v) === null);
const densa = (v: unknown): v is unknown[] => Array.isArray(v)
  && Reflect.ownKeys(v).length === v.length + 1
  && Array.from({ length: v.length }, (_, i) => Object.hasOwn(v, i)).every(Boolean);
function campos(v: unknown, obligatorios: readonly string[], opcionales: readonly string[] = []): v is Record<string, unknown> {
  return plano(v) && obligatorios.every((k) => Object.hasOwn(v, k))
    && Reflect.ownKeys(v).every((k) => typeof k === 'string' && [...obligatorios, ...opcionales].includes(k));
}

// Compara únicamente dominio reconstruido: no convierte NaN/Infinity/Map/undefined a JSON.
// El esperado es acíclico y tipado; el respaldo legado nunca pasa por esta comparación.
function iguales(valor: unknown, esperado: unknown): boolean {
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
/** Frontera runtime, también para recibos de deshacer que el núcleo asume ya tipados. */
function operacionValida(v: unknown): v is Operacion {
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

/**
 * Frontera T2B1: confirmado sigue vacío y la cola completa reconstruye la proyección.
 * Acuses remotos, eliminación de cola, snapshots existentes y rebase pertenecen a T2B2/T4.
 * Rechazamos otros formatos en lugar de resetear o perder intenciones pendientes.
 */
function validar(plan: Itinerario, valor: unknown): RegistroLocal {
  try {
    if (!campos(valor, ['formato', 'confirmado', 'estado', 'cola'], ['legado']) || valor.formato !== 1 || !densa(valor.cola)
      || !iguales(valor.confirmado, crearProgreso(plan))) throw new Error();
    let estado = crearProgreso(plan);
    const ids: string[] = [];
    for (const entrada of valor.cola) {
      if (!campos(entrada, ['operacion', 'dependeDe']) || !operacionValida(entrada.operacion)
        || !iguales(entrada.dependeDe, ids)) throw new Error();
      const operacion = entrada.operacion;
      const resultado = aplicarOperacion(plan, estado, operacion);
      if (resultado.tipo !== 'aplicada' && resultado.tipo !== 'sin-cambio') throw new Error();
      estado = resultado.estado;
      ids.push(operacion.id);
    }
    if (!iguales(valor.estado, estado)) throw new Error();
    if (Object.hasOwn(valor, 'legado')) {
      const legado = valor.legado;
      if (!campos(legado, ['originales', 'recuperacion']) || !objeto(legado.originales) || !densa(legado.recuperacion)) throw new Error();
      for (const r of legado.recuperacion) {
        if (!campos(r, ['campo', 'valor', 'motivo'], ['clave']) || typeof r.campo !== 'string' || !['marcas', 'marcas-hora', 'pendientes-hechos'].includes(r.campo)
          || typeof r.motivo !== 'string' || !['malformada', 'desconocida', 'ambigua', 'estado-existente', 'conflicto-aqui'].includes(r.motivo)
          || !Object.hasOwn(r, 'valor') || (r.clave !== undefined && typeof r.clave !== 'string')) throw new Error();
      }
    }
    return valor as unknown as RegistroLocal;
  } catch {
    throw new Error('Registro de progreso corrupto o formato no soportado');
  }
}

function encolar(plan: Itinerario, raiz: RegistroLocal, operacion: Operacion): {
  raiz: RegistroLocal; resultado: ResultadoOperacion;
} {
  if (!operacionValida(operacion)) return { raiz,
    resultado: { tipo: 'invalida', estado: raiz.estado, motivo: 'Esquema de operación o recibo inválido' } };
  const resultado = aplicarOperacion(plan, raiz.estado, operacion);
  if (resultado.tipo !== 'aplicada' && resultado.tipo !== 'sin-cambio') return { raiz, resultado };
  return { resultado, raiz: { ...raiz, estado: resultado.estado,
    // Dependencia conservadora: no presupone que futuras operaciones se puedan reordenar.
    cola: [...raiz.cola, { operacion, dependeDe: raiz.cola.map((p) => p.operacion.id) }] } };
}

function inicializar(plan: Itinerario, opciones: OpcionesProgresoLocal): RegistroLocal {
  const confirmado = crearProgreso(plan);
  let raiz: RegistroLocal = { formato: 1, confirmado, estado: confirmado, cola: [] };
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
        if (db.objectStoreNames.length !== 1 || !db.objectStoreNames.contains(almacen)) {
          throw new Error('El esquema IndexedDB no está soportado');
        }
        const tabla = db.transaction(almacen).objectStore(almacen);
        if (tabla.keyPath !== null || tabla.autoIncrement || tabla.indexNames.length) {
          throw new Error('El esquema IndexedDB no está soportado');
        }
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
  function transaccion<T>(modo: IDBTransactionMode, trabajo: (raiz: RegistroLocal | undefined) => {
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
          const raiz = solicitud.result === undefined ? undefined : validar(copiaPlan, solicitud.result);
          const salida = trabajo(raiz);
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
    await transaccion('readwrite', (raiz) => {
      if (raiz) return { valor: undefined };
      return { valor: undefined, guardar: inicializar(copiaPlan, copiaOpciones) };
    });
  } catch (error) {
    cerrar();
    throw error;
  }
  return {
    cerrar,
    leer: () => transaccion('readonly', (raiz) => {
      if (!raiz) throw new Error('Falta el registro de progreso; no se restablece automáticamente');
      return { valor: raiz };
    }),
    registrar: async (operacion) => {
      const copia = structuredClone(operacion);
      return transaccion('readwrite', (raiz) => {
        if (!raiz) throw new Error('Falta el registro de progreso; no se restablece automáticamente');
        const siguiente = encolar(copiaPlan, raiz, copia);
        return { valor: siguiente.resultado, ...(siguiente.raiz === raiz ? {} : { guardar: siguiente.raiz }) };
      });
    },
  };
}
