import type { Itinerario } from './tipos';
import { esIdFoto, tamanoBlob, tipoBlob } from './fotos';
import { compararOriginalesFoto } from './fotos-identidad';
import { crearRestauradorFotosPortable, type RestauradorFotosPortable, type ResultadoRestauracionFotos } from './fotos-local';
import { capturarBasePortable, codificarJsonFiel, copiarLimitesPortables, copiarPlanPortable, exigirCampos,
  inspeccionarArchivoPortable, validarBasePortable, type ArchivoPortable, type BasePortable,
  type LimitesPortables, type ManifiestoPortable, type PuertoAperturaPortable } from './portabilidad';

/** Presupuestos de TODA la historia, no sólo del último trabajo. No garantizan heap/evicción. */
export interface LimitesHistoria {
  readonly maxImportaciones: number;
  readonly maxObservaciones: number;
  readonly maxProcedencias: number;
  readonly maxBytesHistoria: number;
}
export interface ProcedenciaHistorica { readonly viajeId: string; readonly trabajoId: string }
export type ObservacionHistorica = ResultadoRestauracionFotos | {
  readonly tipo: 'puerto-incierto'; readonly transaccion: 'incierta'; readonly fotos: readonly [];
};
export interface RegistroHistorico {
  readonly formato: 1; readonly viajeId: string; readonly trabajoId: string;
  /** Única copia durable del contenido. No guarda otra raíz/manifiesto/ledger materializado. */
  readonly archivo: Blob;
  readonly observaciones: readonly ObservacionHistorica[];
  readonly procedencias: readonly ProcedenciaHistorica[];
}
export interface HistoriaArchivada extends RegistroHistorico {
  readonly tipo: 'historia-archivada';
  /** Copia pública aislada: SENT/recibos/fases son historia, jamás autoridad activa. */
  readonly contenido: ManifiestoPortable;
  leerSegmento(indice: number): Blob;
}
export interface ResultadoImportacionHistorica {
  readonly tipo: 'rechazado-antes-escribir' | 'historia-no-confirmada' | 'historia-confirmada' | 'resultado-durable-incierto';
  readonly historia: 'no-intentada' | 'no-confirmada' | 'confirmada';
  readonly baseHistorica: 'no-intentada' | 'existente' | 'creada' | 'incierta';
  readonly trabajoId: string | null;
  readonly fotos: ObservacionHistorica | null;
}
export interface OpcionesHistoria {
  readonly plan: Itinerario; readonly limites: LimitesPortables; readonly limitesHistoria: LimitesHistoria;
  readonly fabrica?: PuertoAperturaPortable | null;
  /** Puerto exclusivo de restauración manual, nunca ProgresoLocal ni RespaldoFotosLocal.
   * Un throw no prueba aborto. Se conserva el archivo y se registra incertidumbre tipada. */
  readonly restaurador?: RestauradorFotosPortable;
}
export interface PortabilidadHistorica {
  listar(): Promise<readonly HistoriaArchivada[]>;
  consultar(trabajoId: string): Promise<HistoriaArchivada | null>;
  exportarOriginal(trabajoId: string): Promise<Blob>;
  archivar(archivo: Blob, procedencias?: readonly ProcedenciaHistorica[],
    observaciones?: readonly ObservacionHistorica[]): Promise<ResultadoImportacionHistorica>;
  importar(archivo: Blob): Promise<ResultadoImportacionHistorica>;
  reintentar(trabajoId: string, archivo?: Blob): Promise<ResultadoImportacionHistorica>;
}
const tipos = ['sin-fotos', 'conflicto-preflight', 'conflicto-fresco', 'tx-abortada', 'tx-incierta',
  'observadas', 'cambiadas', 'lectura-posterior-fallida', 'puerto-incierto'];
const transacciones = ['no-intentada', 'confirmada', 'abortada', 'incierta'];
const tabla = 'importaciones';
function rechazar(): never { throw new Error('Historia portable inválida, desconocida o excesiva'); }
function sumar(a: number, b: number): number {
  const n = a + b; if (!Number.isSafeInteger(n) || n < 0) rechazar(); return n;
}
export function copiarLimitesHistoria(entrada: LimitesHistoria): LimitesHistoria {
  exigirCampos(entrada, ['maxImportaciones', 'maxObservaciones', 'maxProcedencias', 'maxBytesHistoria']);
  const copia = { ...entrada };
  for (const n of Object.values(copia)) if (typeof n !== 'number' || !Number.isSafeInteger(n) || n < 0) rechazar();
  return copia;
}
export function validarDatosHistoricos(observaciones: readonly ObservacionHistorica[],
  procedencias: readonly ProcedenciaHistorica[], limites: LimitesPortables, presupuesto: LimitesHistoria): void {
  if (!Array.isArray(observaciones) || !Array.isArray(procedencias)
    || observaciones.length > presupuesto.maxObservaciones || procedencias.length > presupuesto.maxProcedencias) rechazar();
  // Cuenta acotada antes de expandir JSON; nunca omite propios, getters, alias u opacos.
  codificarJsonFiel({ observaciones, procedencias }, limites);
  const ids = new Set<string>();
  for (const p of procedencias) {
    exigirCampos(p, ['viajeId', 'trabajoId']);
    if (typeof p.viajeId !== 'string' || !p.viajeId.length || p.viajeId.length > 512
      || typeof p.trabajoId !== 'string' || !p.trabajoId.length || p.trabajoId.length > 512) rechazar();
    const clave = JSON.stringify([p.viajeId, p.trabajoId]);
    if (ids.has(clave)) rechazar(); ids.add(clave);
  }
  for (const o of observaciones) {
    exigirCampos(o, ['tipo', 'transaccion', 'fotos']);
    if (typeof o.tipo !== 'string' || typeof o.transaccion !== 'string'
      || !tipos.includes(o.tipo) || !transacciones.includes(o.transaccion) || !Array.isArray(o.fotos)
      || o.fotos.length > limites.maxRegistros) rechazar();
    if (o.tipo === 'puerto-incierto' && (o.transaccion !== 'incierta' || o.fotos.length)) rechazar();
    const fotos = new Set<string>();
    for (const f of o.fotos) {
      exigirCampos(f, ['fotoId', 'tipo', 'derivacion']);
      if (typeof f.fotoId !== 'string' || typeof f.tipo !== 'string' || typeof f.derivacion !== 'string'
        || !esIdFoto(f.fotoId) || !['nueva', 'existente', 'tombstone'].includes(f.tipo)
        || !['igual', 'diferente'].includes(f.derivacion) || fotos.has(f.fotoId)) rechazar();
      fotos.add(f.fotoId);
    }
  }
}
function esquema(db: IDBDatabase, tx: IDBTransaction): void {
  if (db.version !== 1 || db.objectStoreNames.length !== 1 || !db.objectStoreNames.contains(tabla)) rechazar();
  const t = tx.objectStore(tabla);
  if (t.keyPath !== null || t.autoIncrement || t.indexNames.length) rechazar();
}
function validarRegistro(plan: Itinerario, clave: string, entrada: unknown,
  limites: LimitesPortables, presupuesto: LimitesHistoria): asserts entrada is RegistroHistorico {
  exigirCampos(entrada, ['formato', 'viajeId', 'trabajoId', 'archivo', 'observaciones', 'procedencias']);
  if (entrada.formato !== 1 || entrada.viajeId !== plan.id || entrada.trabajoId !== clave || !esIdFoto(clave)) rechazar();
  const bytes = tamanoBlob(entrada.archivo);
  if (bytes > limites.maxBytesArchivo) rechazar();
  validarDatosHistoricos(entrada.observaciones as ObservacionHistorica[], entrada.procedencias as ProcedenciaHistorica[], limites, presupuesto);
}
export function presupuestoHistoria(registros: readonly RegistroHistorico[], limites: LimitesHistoria): void {
  let bytes = 0; let obs = 0; let procedencias = 0;
  if (registros.length > limites.maxImportaciones) rechazar();
  for (const r of registros) {
    bytes = sumar(bytes, tamanoBlob(r.archivo)); obs = sumar(obs, r.observaciones.length);
    procedencias = sumar(procedencias, r.procedencias.length);
  }
  if (bytes > limites.maxBytesHistoria || obs > limites.maxObservaciones || procedencias > limites.maxProcedencias) rechazar();
}
/** Detecta ausencia sin inicializar; todas las raíces y CRC de TODOS los archivos se validan.
 * Error/futuro/corrupción/exceso jamás se convierten en una historia vacía conocida. */
export async function capturarHistoriaPortable(planEntrada: Itinerario, limitesEntrada: LimitesPortables,
  presupuestoEntrada: LimitesHistoria, fabricaEntrada?: PuertoAperturaPortable | null): Promise<{
    readonly presente: boolean; readonly registros: readonly RegistroHistorico[];
  }> {
  const plan = copiarPlanPortable(planEntrada); const limites = copiarLimitesPortables(limitesEntrada);
  const presupuesto = copiarLimitesHistoria(presupuestoEntrada);
  const entrada = fabricaEntrada === undefined ? globalThis.indexedDB : fabricaEntrada;
  const fabrica = entrada ? { open: entrada.open.bind(entrada) } : entrada;
  const base = await capturarBasePortable(fabrica, `itinerario-portabilidad:${encodeURIComponent(plan.id)}`, [tabla],
    { ...limites, maxRegistros: presupuesto.maxImportaciones }, esquema, (b) => {
      validarBasePortable(b, [tabla]);
      for (const r of b.tablas[tabla] ?? []) validarRegistro(plan, r.clave, r.valor, limites, presupuesto);
    }, (valor) => {
      exigirCampos(valor, ['formato', 'viajeId', 'trabajoId', 'archivo', 'observaciones', 'procedencias']);
      tamanoBlob(valor.archivo); return { ...valor, archivo: null };
    });
  const registros = (base.tablas[tabla] ?? []).map((r) => structuredClone(r.valor) as RegistroHistorico);
  presupuestoHistoria(registros, presupuesto);
  for (const r of registros) await inspeccionarArchivoPortable(plan, r.archivo, limites);
  return { presente: base.presente, registros };
}
/** Materializa sólo fotos de un inspector privado: referencias públicas no controlan escrituras. */
function fotosInspeccionadas(inspeccion: ArchivoPortable): BasePortable {
  const base = inspeccion.manifiesto.captura.fotos;
  return { presente: base.presente, tablas: Object.fromEntries(Object.entries(base.tablas).map(([t, rs]) =>
    [t, rs.map((r) => ({ clave: r.clave, valor: t === 'metadatos' ? structuredClone(r.valor)
      : inspeccion.leerSegmento((r.valor as { segmento: number }).segmento) }))])) };
}
function archivoConstante(archivo: Blob): Blob {
  return Blob.prototype.slice.call(archivo, 0, tamanoBlob(archivo), 'application/octet-stream') as Blob;
}
/** Acciones manuales. Sin IO/generación de IDs en el constructor, sin autostart/replay/ACK.
 * Las dos bases NO forman una transacción global. Historia confirmada nunca se borra por fallo foto.
 * La continuidad del archivo depende de que este driver nunca lo reemplaza: no sandbox RAW hostil. */
export function crearPortabilidadHistorica(opciones: OpcionesHistoria): PortabilidadHistorica {
  const plan = copiarPlanPortable(opciones.plan); const limites = copiarLimitesPortables(opciones.limites);
  const presupuesto = copiarLimitesHistoria(opciones.limitesHistoria);
  const entrada = opciones.fabrica === undefined ? globalThis.indexedDB : opciones.fabrica;
  const fabrica = entrada ? { open: entrada.open.bind(entrada) } : entrada;
  const nombre = `itinerario-portabilidad:${encodeURIComponent(plan.id)}`;
  const driver = crearRestauradorFotosPortable(plan, limites, { fabrica });
  const restaurador = opciones.restaurador ?? driver;
  if (typeof restaurador.restaurar !== 'function') rechazar();
  const restaurar = restaurador.restaurar.bind(restaurador);
  if (!globalThis.crypto || typeof globalThis.crypto.randomUUID !== 'function') throw new Error('Falta CSPRNG local');
  const generarId = globalThis.crypto.randomUUID.bind(globalThis.crypto);
  const captura = () => capturarHistoriaPortable(plan, limites, presupuesto, fabrica);
  const respuesta = (tipo: ResultadoImportacionHistorica['tipo'], historia: ResultadoImportacionHistorica['historia'],
    trabajoId: string | null = null, fotos: ObservacionHistorica | null = null,
    baseHistorica: ResultadoImportacionHistorica['baseHistorica'] = 'no-intentada'): ResultadoImportacionHistorica =>
    ({ tipo, historia, baseHistorica, trabajoId, fotos });
  async function abrir(): Promise<{ db: IDBDatabase; creada: boolean }> {
    if (!fabrica) throw new Error('IndexedDB no disponible');
    return new Promise((ok, no) => {
      let creada = false; let terminada = false; const s = fabrica.open(nombre, 1);
      s.onupgradeneeded = (e) => {
        if (e.oldVersion !== 0) { s.transaction!.abort(); return; }
        creada = true; s.result.createObjectStore(tabla);
      };
      s.onblocked = () => { terminada = true; no(new Error('Historia bloqueada')); };
      s.onerror = () => no(s.error);
      s.onsuccess = () => {
        const db = s.result; if (terminada) { db.close(); return; }
        try { const tx = db.transaction(tabla); esquema(db, tx); ok({ db, creada }); }
        catch (e) { db.close(); no(e); }
      };
    });
  }
  async function escribir(registro: RegistroHistorico, nueva: boolean, observacion?: ObservacionHistorica): Promise<{
    confirmado: boolean; base: ResultadoImportacionHistorica['baseHistorica'];
  }> {
    let abierta: Awaited<ReturnType<typeof abrir>>;
    try { abierta = await abrir(); } catch { return { confirmado: false, base: 'incierta' }; }
    const { db, creada } = abierta; const base = creada ? 'creada' : 'existente';
    return new Promise((ok) => {
      let terminada = false; let tx: IDBTransaction;
      const terminar = (confirmado: boolean) => {
        if (terminada) return; terminada = true; db.close(); ok({ confirmado, base });
      };
      try { tx = db.transaction(tabla, 'readwrite'); esquema(db, tx); }
      catch { terminar(false); return; }
      db.onversionchange = () => db.close(); db.onclose = () => terminar(false);
      tx.oncomplete = () => terminar(true); tx.onabort = () => terminar(false);
      const registros: RegistroHistorico[] = [];
      const s = tx.objectStore(tabla).openCursor();
      s.onsuccess = () => {
        try {
          const cursor = s.result;
          if (cursor) {
            if (typeof cursor.primaryKey !== 'string' || registros.length >= presupuesto.maxImportaciones) rechazar();
            validarRegistro(plan, cursor.primaryKey, cursor.value, limites, presupuesto);
            registros.push(cursor.value as RegistroHistorico); cursor.continue(); return;
          }
          if (nueva) {
            presupuestoHistoria([...registros, registro], presupuesto);
            tx.objectStore(tabla).add(registro, registro.trabajoId);
          } else {
            const actual = registros.find((r) => r.trabajoId === registro.trabajoId);
            if (!actual || actual.formato !== registro.formato || actual.viajeId !== registro.viajeId
              || tamanoBlob(actual.archivo) !== tamanoBlob(registro.archivo)
              || tipoBlob(actual.archivo) !== tipoBlob(registro.archivo)) rechazar();
            // Relee arrays frescos; append sin perder observaciones concurrentes ni procedencias.
            // Nunca sustituye el Blob por el input del reintento ni por una copia pública.
            const siguiente = { ...actual, observaciones: [...actual.observaciones, observacion!] };
            validarRegistro(plan, siguiente.trabajoId, siguiente, limites, presupuesto);
            presupuestoHistoria(registros.map((r) => r.trabajoId === siguiente.trabajoId ? siguiente : r), presupuesto);
            tx.objectStore(tabla).put(siguiente, siguiente.trabajoId);
          }
        } catch { try { tx.abort(); } catch { terminar(false); } }
      };
    });
  }
  async function consultar(id: string): Promise<HistoriaArchivada | null> {
    if (!esIdFoto(id)) rechazar();
    const r = (await captura()).registros.find((r) => r.trabajoId === id);
    if (!r) return null;
    const inspeccion = await inspeccionarArchivoPortable(plan, r.archivo, limites);
    return { ...structuredClone(r), tipo: 'historia-archivada', contenido: structuredClone(inspeccion.manifiesto),
      leerSegmento: (indice) => inspeccion.leerSegmento(indice) };
  }
  async function archivar(archivo: Blob, procedencias: readonly ProcedenciaHistorica[] = [],
    observaciones: readonly ObservacionHistorica[] = [], reservarObservacion = false): Promise<ResultadoImportacionHistorica> {
    let propias: ProcedenciaHistorica[]; let previas: ObservacionHistorica[];
    try {
      tamanoBlob(archivo); validarDatosHistoricos(observaciones, procedencias, limites, presupuesto);
      propias = structuredClone(procedencias) as ProcedenciaHistorica[];
      previas = structuredClone(observaciones) as ObservacionHistorica[];
      if (reservarObservacion && sumar(previas.length, 1) > presupuesto.maxObservaciones) rechazar();
      await inspeccionarArchivoPortable(plan, archivo, limites);
      const historia = await captura();
      let obs = previas.length;
      for (const r of historia.registros) obs = sumar(obs, r.observaciones.length);
      if (reservarObservacion && sumar(obs, 1) > presupuesto.maxObservaciones) rechazar();
      presupuestoHistoria([...historia.registros, { formato: 1, viajeId: plan.id, trabajoId: '', archivo,
        observaciones: previas, procedencias: propias }], presupuesto);
    } catch { return respuesta('rechazado-antes-escribir', 'no-intentada'); }
    const id = generarId();
    const registro: RegistroHistorico = { formato: 1, viajeId: plan.id, trabajoId: id, archivo,
      observaciones: previas, procedencias: propias };
    const escritura = await escribir(registro, true);
    return respuesta(escritura.confirmado ? 'historia-confirmada' : 'historia-no-confirmada',
      escritura.confirmado ? 'confirmada' : 'no-confirmada', id, null, escritura.base);
  }
  async function reintentar(id: string, otroArchivo?: Blob): Promise<ResultadoImportacionHistorica> {
    // Fija marca y Blob del llamador antes de awaits. MIME exterior NO es identidad del archivo.
    let externo: Blob | undefined;
    try { if (!esIdFoto(id)) rechazar(); if (otroArchivo !== undefined) externo = archivoConstante(otroArchivo); }
    catch { return respuesta('rechazado-antes-escribir', 'no-intentada', id); }
    let registro: RegistroHistorico; let inspeccion: ArchivoPortable;
    try {
      const historia = await captura();
      const r = historia.registros.find((r) => r.trabajoId === id); if (!r) rechazar(); registro = r;
      let obs = 0;
      for (const r of historia.registros) obs = sumar(obs, r.observaciones.length);
      if (sumar(obs, 1) > presupuesto.maxObservaciones) rechazar();
      if (externo && (await compararOriginalesFoto(archivoConstante(registro.archivo), externo)).tipo !== 'iguales') rechazar();
      inspeccion = await inspeccionarArchivoPortable(plan, registro.archivo, limites);
    } catch { return respuesta('rechazado-antes-escribir', 'no-intentada', id); }
    let fotos: ObservacionHistorica;
    try { fotos = await restaurar(fotosInspeccionadas(inspeccion)); validarDatosHistoricos([fotos], [], limites, presupuesto); fotos = structuredClone(fotos); }
    catch {
      // Throw ≠ aborto. Sólo lectura fresca del driver real; no replay ni segundo lote RW.
      try { fotos = await driver.comprobar!(fotosInspeccionadas(inspeccion)); }
      catch { fotos = { tipo: 'puerto-incierto', transaccion: 'incierta', fotos: [] }; }
    }
    const escritura = await escribir(registro, false, fotos);
    return respuesta(escritura.confirmado ? 'historia-confirmada' : 'resultado-durable-incierto', 'confirmada',
      id, fotos, escritura.base);
  }
  return { consultar, archivar, reintentar,
    listar: async () => {
      const registros = (await captura()).registros; const salida: HistoriaArchivada[] = [];
      for (const r of registros) {
        const i = await inspeccionarArchivoPortable(plan, r.archivo, limites);
        salida.push({ ...structuredClone(r), tipo: 'historia-archivada', contenido: structuredClone(i.manifiesto), leerSegmento: (n) => i.leerSegmento(n) });
      }
      return salida;
    },
    exportarOriginal: async (id) => { const r = await consultar(id); if (!r) rechazar(); return r.archivo; },
    importar: async (archivo) => {
      const archivado = await archivar(archivo, [], [], true);
      if (archivado.historia !== 'confirmada') return archivado;
      return reintentar(archivado.trabajoId!);
    },
  };
}
