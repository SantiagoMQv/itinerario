import type { Itinerario } from './tipos';
import { crearProgreso } from './progreso';
import { tamanoBlob, tipoBlob, type MetadatosFoto, type FotoBorrada } from './fotos';
import type { RegistroLocal } from './progreso-local';
import type { EntradaRespaldo } from './fotos-respaldo';
import { validarFotosPortables } from './fotos-local';
import { validarProgresoPortable } from './progreso-local';
import { validarRespaldosPortables } from './fotos-respaldo-local';

/** Límites técnicos explícitos, enteros seguros no negativos; profundidad entre 1 y 256.
 * No garantizan heap móvil ni protección frente a evicción física. */
export interface LimitesPortables {
  readonly maxRegistros: number;
  readonly maxBytesMetadatos: number;
  readonly maxBytesArchivo: number;
  readonly maxProfundidad: number;
}
/** Puerto mínimo para aperturas readonly; no concede create/delete/upgrade explícitos. */
export type PuertoAperturaPortable = Pick<IDBFactory, 'open'>;
export interface RegistroPortable<T = unknown> { readonly clave: string; readonly valor: T }
export interface BasePortable<T = unknown> {
  readonly presente: boolean;
  readonly tablas: Readonly<Record<string, readonly RegistroPortable<T>[]>>;
}
export type CampoLegadoPortable = 'marcas' | 'marcas-hora' | 'pendientes-hechos';
export interface CapturaPortable {
  readonly viajeId: string;
  readonly fotos: BasePortable;
  readonly progreso: BasePortable;
  readonly respaldos: BasePortable;
  readonly legado: Readonly<Record<CampoLegadoPortable, string | null>>;
}
export type JsonFiel = null | boolean | number | string | readonly JsonFiel[]
  | { readonly [clave: string]: JsonFiel };
/** Desplazamiento relativo al primer byte posterior al manifiesto. CRC detecta corrupción,
 * no autentica proveedor, recibos, autoría, permisos ni identidad de quien importa. */
export interface SegmentoPortable {
  readonly tabla: 'originales' | 'miniaturas'; readonly clave: string;
  readonly offset: number; readonly bytes: number; readonly mime: string; readonly crc32: number;
}
export interface ReferenciaSegmentoPortable { readonly segmento: number }
/** Tipos admitidos DESPUÉS de guards de los drivers y frontera JSON fiel del legado. */
export interface CapturaManifiestoPortable extends Omit<CapturaPortable, 'fotos' | 'progreso' | 'respaldos'> {
  readonly fotos: BasePortable<MetadatosFoto | FotoBorrada | ReferenciaSegmentoPortable>;
  readonly progreso: BasePortable<RegistroLocal>;
  readonly respaldos: BasePortable<EntradaRespaldo>;
}
export interface ManifiestoPortable {
  readonly formato: 1;
  readonly alcance: 'historia-durable-por-base';
  /** Raíces RAW validadas. Solo valores Blob se sustituyen por {segmento: índice}.
   * El subconjunto JSON fiel rechaza identidad compartida, opacos y campos undefined. */
  readonly captura: CapturaManifiestoPortable;
  readonly segmentos: readonly SegmentoPortable[];
}
export interface ArchivoPortable {
  readonly archivo: Blob;
  readonly manifiesto: ManifiestoPortable;
  /** Vista binaria sin reconstruir File ni normalizar nombre/MIME de metadata. */
  leerSegmento(indice: number): Blob;
}
const codificador = new TextEncoder();
const magic = new Uint8Array([73, 84, 73, 78, 80, 79, 82, 84]); // ITINPORT
const cabeceraBytes = 24;
const bloqueBytes = 1 << 20;
function fallo(detalle: string): never { throw new Error(`Exportación portable rechazada: ${detalle}`); }
/** Catálogo obligatorio, incluso con todas las bases ausentes. Guard puro existente:
 * crearProgreso valida IDs globales en memoria; su estado vacío se descarta.
 * No abre bases, inicializa raíces, genera UUID ni concede autoridad.
 * La copia validada fija el catálogo antes de cualquier await, sin normalizar sus IDs. */
export function copiarPlanPortable(entrada: Itinerario): Itinerario {
  const plan = structuredClone(entrada);
  crearProgreso(plan);
  return plan;
}
export function copiarLimitesPortables(valor: LimitesPortables): LimitesPortables {
  exigirCampos(valor, ['maxRegistros', 'maxBytesMetadatos', 'maxBytesArchivo', 'maxProfundidad']);
  const copia = { ...valor };
  for (const n of Object.values(copia)) if (typeof n !== 'number' || !Number.isSafeInteger(n) || n < 0) fallo('límite inválido');
  if (copia.maxProfundidad < 1 || copia.maxProfundidad > 256) fallo('profundidad fuera de 1–256');
  return copia;
}
function suma(a: number, b: number): number {
  const n = a + b;
  if (!Number.isSafeInteger(n) || n < 0) fallo('longitud o desplazamiento inseguro');
  return n;
}
export function exigirCampos(valor: unknown, claves: readonly string[]): asserts valor is Record<string, unknown> {
  if (typeof valor !== 'object' || valor === null || Array.isArray(valor)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(valor))) fallo('objeto no plano');
  const propias = Reflect.ownKeys(valor);
  if (propias.length !== claves.length || propias.some((k) => typeof k !== 'string' || !claves.includes(k))) {
    fallo('campos desconocidos o ausentes');
  }
  for (const clave of propias) {
    const d = Object.getOwnPropertyDescriptor(valor, clave)!;
    if (!Object.hasOwn(d, 'value') || !d.enumerable) fallo('accessor o campo oculto');
  }
}
/** Subconjunto estricto, no serializador universal de EntradasLegadas.
 * Antes de clonar se inspeccionan propios; jamás se ejecutan getters/toJSON.
 * Los Proxy hostiles pueden ejecutar traps: no es aislamiento de código JS. */
export function codificarJsonFiel(valor: unknown, opciones: LimitesPortables): string {
  const limites = copiarLimitesPortables(opciones);
  const vistos = new Set<object>();
  let bytes = 0;
  const contar = (texto: string): string => {
    bytes = suma(bytes, codificador.encode(texto).byteLength);
    if (bytes > limites.maxBytesMetadatos) fallo('maxBytesMetadatos excedido');
    return texto;
  };
  function recorrer(v: unknown, profundidad: number): string {
    if (profundidad > limites.maxProfundidad) fallo('maxProfundidad excedida');
    if (v === null) return contar('null');
    if (typeof v === 'string' || typeof v === 'boolean') return contar(JSON.stringify(v));
    if (typeof v === 'number') {
      if (!Number.isFinite(v)) fallo('número no finito');
      return contar(Object.is(v, -0) ? '-0' : String(v));
    }
    if (typeof v !== 'object') fallo('valor no representable en JSON fiel');
    if (vistos.has(v)) fallo('ciclo o referencia compartida');
    vistos.add(v);
    const arreglo = Array.isArray(v);
    const proto = Object.getPrototypeOf(v);
    if (proto !== null && proto !== (arreglo ? Array.prototype : Object.prototype)) fallo('objeto opaco');
    const descriptores = Object.getOwnPropertyDescriptors(v);
    const claves = Reflect.ownKeys(v);
    if (claves.some((k) => typeof k !== 'string')) fallo('clave símbolo');
    for (const k of claves as string[]) {
      const d = descriptores[k];
      if (!Object.hasOwn(d, 'value') || (!d.enumerable && !(arreglo && k === 'length'))) fallo('accessor o campo oculto');
    }
    if (arreglo) {
      const longitud = descriptores.length.value as number;
      if (claves.length !== longitud + 1) fallo('array disperso o propios adicionales');
      const partes: string[] = [contar('[')];
      for (let i = 0; i < longitud; i++) {
        if (!Object.hasOwn(descriptores, String(i))) fallo('array disperso');
        if (i) partes.push(contar(','));
        partes.push(recorrer(descriptores[String(i)].value, profundidad + 1));
      }
      partes.push(contar(']')); return partes.join('');
    }
    const partes: string[] = [contar('{')];
    for (const [i, k] of (claves as string[]).sort().entries()) {
      if (i) partes.push(contar(','));
      partes.push(contar(JSON.stringify(k)), contar(':'), recorrer(descriptores[k].value, profundidad + 1));
    }
    partes.push(contar('}')); return partes.join('');
  }
  return recorrer(valor, 0);
}

/** Primitiva interna compartida. Apertura sin versión: aborta creación inicial, nunca
 * inicializa/migra/borra. Una única TX readonly enumera todas las tablas y confirma al complete.
 * Esquema y guards pertenecen al driver, no a una copia paralela de sus invariantes. */
export function capturarBasePortable(fabrica: PuertoAperturaPortable | null | undefined, nombre: string,
  tablas: readonly string[], limitesEntrada: LimitesPortables,
  comprobarEsquema: (db: IDBDatabase, tx: IDBTransaction) => void,
  validar: (base: BasePortable) => void,
  copiarParaPresupuesto: (valor: unknown, clave: string) => unknown = (valor) => valor): Promise<BasePortable> {
  const limites = copiarLimitesPortables(limitesEntrada);
  if (!fabrica) return Promise.reject(new Error('IndexedDB no está disponible'));
  return new Promise((ok, no) => {
    let terminada = false; let ausente = false;
    const s = fabrica.open(nombre);
    const rechazar = (e: unknown) => { if (!terminada) { terminada = true; no(e); } };
    s.onblocked = () => rechazar(new Error(`${nombre}: apertura bloqueada`));
    s.onupgradeneeded = (e) => {
      ausente = e.oldVersion === 0;
      s.transaction!.abort();
    };
    s.onerror = () => {
      if (terminada) return;
      if (ausente) { terminada = true; ok({ presente: false, tablas: {} }); }
      else rechazar(s.error);
    };
    s.onsuccess = () => {
      const db = s.result;
      if (terminada) { db.close(); return; }
      let tx: IDBTransaction;
      db.onversionchange = () => { db.close(); rechazar(new Error(`${nombre}: cambio de versión`)); };
      db.onclose = () => rechazar(new Error(`${nombre}: conexión cerrada`));
      try {
        tx = db.transaction([...tablas], 'readonly');
        comprobarEsquema(db, tx);
      } catch (e) { db.close(); rechazar(e); return; }
      const contenido: Record<string, RegistroPortable[]> = Object.fromEntries(tablas.map((t) => [t, []]));
      let cuenta = 0; let bytes = 0; let error: unknown;
      const abortar = (e: unknown) => { error = e; try { tx.abort(); } catch { db.close(); rechazar(e); } };
      tx.onabort = () => { db.close(); rechazar(error ?? tx.error ?? new Error(`${nombre}: TX abortada`)); };
      tx.onerror = (e) => { error ??= (e.target as IDBRequest).error; };
      tx.oncomplete = () => {
        db.close();
        if (terminada) return;
        try { const base = { presente: true, tablas: contenido }; validar(base); terminada = true; ok(base); }
        catch (e) { rechazar(e); }
      };
      for (const tabla of tablas) {
        const req = tx.objectStore(tabla).openCursor();
        req.onsuccess = () => {
          const cursor = req.result;
          if (!cursor) return;
          const clave = cursor.primaryKey;
          try {
            if (typeof clave !== 'string') fallo(`${nombre}/${tabla}/[clave no textual]`);
            if (++cuenta > limites.maxRegistros) fallo(`${nombre}/${tabla}/${clave}: maxRegistros`);
            const valor: unknown = cursor.value;
            let binario = false;
            try { tamanoBlob(valor); binario = true; } catch { /* JSON o rechazo explícito posterior. */ }
            bytes = suma(bytes, codificador.encode(codificarJsonFiel({ clave, valor: binario ? null : copiarParaPresupuesto(valor, clave) }, limites)).length);
            if (bytes > limites.maxBytesMetadatos) fallo(`${nombre}/${tabla}/${clave}: maxBytesMetadatos`);
            contenido[tabla].push({ clave, valor }); cursor.continue();
          } catch (e) { abortar(new Error(`${nombre}/${tabla}/${String(clave)}: ${e instanceof Error ? e.message : 'registro inválido'}`)); }
        };
      }
    };
  });
}

/** Copia por valor SOLO dentro de una raíz progreso que después valida su driver.
 * Semántica del dominio: valores tipados exactos, no identidad/aliasing del grafo JS.
 * Todo legado (originales y recuperación incluidos) sigue siendo desconocido estricto.
 * Rechaza cruces legado/dominio, ciclos y expansión DAG antes de agotar el presupuesto.
 * No es materialización desdeResultado ni normaliza escalares/propios RAW. */
function copiarValoresPortables(entrada: unknown, limites: LimitesPortables, raiz: 'progreso' | 'respaldo' | null): unknown {
  const conocidos = new Set<object>(); const desconocidos = new Set<object>();
  const ancestros = new Set<object>(); let bytes = 0;
  const contar = (texto: string) => {
    bytes = suma(bytes, codificador.encode(texto).length);
    if (bytes > limites.maxBytesMetadatos) fallo('maxBytesMetadatos en expansión por valor');
  };
  function copiar(v: unknown, ruta: readonly string[], profundidad: number): unknown {
    if (profundidad > limites.maxProfundidad) fallo('maxProfundidad excedida');
    if (v === null) { contar('null'); return v; }
    if (typeof v === 'string' || typeof v === 'boolean') { contar(JSON.stringify(v)); return v; }
    if (typeof v === 'number' && Number.isFinite(v)) { contar(Object.is(v, -0) ? '-0' : String(v)); return v; }
    if (typeof v !== 'object') fallo('valor no representable en JSON fiel');
    const binario = !raiz && ruta.length === 5 && ruta[0] === 'fotos' && ruta[1] === 'tablas'
      && ['originales', 'miniaturas'].includes(ruta[2]) && ruta[4] === 'valor';
    if (binario) { tamanoBlob(v); contar('null'); return v; }
    const rutaDominio = raiz ? ruta : ruta.slice(5);
    const dentroProgreso = raiz === 'progreso' || (!raiz && ruta.length >= 5 && ruta[0] === 'progreso'
      && ruta[1] === 'tablas' && ruta[2] === 'viajes' && ruta[4] === 'valor');
    const dentroRespaldo = raiz === 'respaldo' || (!raiz && ruta.length >= 5 && ruta[0] === 'respaldos'
      && ruta[1] === 'tablas' && ruta[2] === 'respaldos' && ruta[4] === 'valor');
    const conocido = dentroRespaldo || (dentroProgreso && rutaDominio[0] !== 'legado');
    if (ancestros.has(v)) fallo('ciclo');
    if (conocido) {
      if (desconocidos.has(v)) fallo('referencia compartida entre legado y dominio');
      conocidos.add(v);
    } else {
      if (desconocidos.has(v) || conocidos.has(v)) fallo('referencia compartida desconocida o cruce dominio');
      desconocidos.add(v);
    }
    const arreglo = Array.isArray(v); const proto = Object.getPrototypeOf(v);
    if (proto !== null && proto !== (arreglo ? Array.prototype : Object.prototype)) fallo('objeto opaco');
    const claves = Reflect.ownKeys(v); const ds = Object.getOwnPropertyDescriptors(v);
    if (claves.some((k) => typeof k !== 'string')) fallo('clave símbolo');
    for (const k of claves as string[]) {
      if (!Object.hasOwn(ds[k], 'value') || (!ds[k].enumerable && !(arreglo && k === 'length'))) fallo('accessor o campo oculto');
    }
    ancestros.add(v); contar(arreglo ? '[]' : '{}');
    try {
      if (arreglo) {
        const longitud = ds.length.value as number;
        if (claves.length !== longitud + 1) fallo('array disperso o propios adicionales');
        const lista: unknown[] = [];
        for (let i = 0; i < longitud; i++) {
          if (!Object.hasOwn(ds, String(i))) fallo('array disperso');
          if (i) contar(',');
          lista.push(copiar(ds[String(i)].value, [...ruta, String(i)], profundidad + 1));
        }
        return lista;
      }
      const resultado: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
      for (const [i, k] of (claves as string[]).entries()) {
        contar((i ? ',' : '') + JSON.stringify(k) + ':');
        resultado[k] = copiar(ds[k].value, [...ruta, k], profundidad + 1);
      }
      return resultado;
    } finally { ancestros.delete(v); }
  }
  return copiar(entrada, [], 0);
}
/** Interno del driver: su guard debe validar esta copia antes de admitir su presupuesto.
 * El RAW capturado nunca se sustituye por esta copia, que solo expande alias conocidos. */
export function copiarValoresProgresoPortable(valor: unknown, limites: LimitesPortables): unknown {
  return copiarValoresPortables(valor, copiarLimitesPortables(limites), 'progreso');
}
export function copiarValoresRespaldoPortable(valor: unknown, limites: LimitesPortables): unknown {
  return copiarValoresPortables(valor, copiarLimitesPortables(limites), 'respaldo');
}
function copiarCapturaPortable(entrada: CapturaPortable, limites: LimitesPortables): CapturaPortable {
  return copiarValoresPortables(entrada, limites, null) as CapturaPortable;
}
function validarCaptura(plan: Itinerario, captura: CapturaPortable): void {
  exigirCampos(captura, ['viajeId', 'fotos', 'progreso', 'respaldos', 'legado']);
  if (captura.viajeId !== plan.id) fallo('viaje incompatible');
  exigirCampos(captura.legado, ['marcas', 'marcas-hora', 'pendientes-hechos']);
  for (const v of Object.values(captura.legado)) if (v !== null && typeof v !== 'string') fallo('legado no textual');
  validarFotosPortables(plan, captura.fotos);
  validarProgresoPortable(plan, captura.progreso);
  validarRespaldosPortables(plan, captura.respaldos);
}
/** Valida envolventes estrictas y no omite registros desconocidos. */
export function validarBasePortable(base: BasePortable, tablas: readonly string[]): void {
  exigirCampos(base, ['presente', 'tablas']);
  if (typeof base.presente !== 'boolean') fallo('presencia inválida');
  exigirCampos(base.tablas, base.presente ? tablas : []);
  for (const tabla of Object.keys(base.tablas)) {
    const registros = base.tablas[tabla];
    if (!Array.isArray(registros)) fallo(`tabla ${tabla} no enumerable`);
    const claves = new Set<string>();
    for (const r of registros) {
      exigirCampos(r, ['clave', 'valor']);
      if (typeof r.clave !== 'string' || claves.has(r.clave)) fallo(`${tabla}: clave inválida o duplicada`);
      claves.add(r.clave);
    }
  }
}
// CRC-32 IEEE incremental: un bloque a la vez, nunca todo el archivo ni todos los originales.
function actualizarCrc(crc: number, bytes: Uint8Array): number {
  for (const b of bytes) {
    crc ^= b;
    for (let i = 0; i < 8; i++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
  }
  return crc >>> 0;
}
async function crcBlob(blob: Blob): Promise<number> {
  let crc = 0xffffffff;
  for (let inicio = 0; inicio < blob.size; inicio += bloqueBytes) {
    const bytes = new Uint8Array(await Blob.prototype.slice.call(blob, inicio, Math.min(blob.size, inicio + bloqueBytes)).arrayBuffer());
    crc = actualizarCrc(crc, bytes);
  }
  return (crc ^ 0xffffffff) >>> 0;
}
function vista(archivo: Blob, manifiesto: ManifiestoPortable, inicio: number): ArchivoPortable {
  // La vista captura descriptores propios, no depende de mutaciones del manifiesto público.
  const segmentos = manifiesto.segmentos.map((s) => ({ ...s }));
  return { archivo, manifiesto, leerSegmento: (indice) => {
    if (!Number.isSafeInteger(indice) || indice < 0 || indice >= segmentos.length) fallo('referencia de segmento inválida');
    const s = segmentos[indice];
    return Blob.prototype.slice.call(archivo, inicio + s.offset, inicio + s.offset + s.bytes, s.mime) as Blob;
  } };
}
/** Acción explícita. Archivo completo o rechazo: no existen exportaciones parciales.
 * Captura aislada antes del primer await. No snapshot de red, scheduler ni estado transitorio.
 * Las bases ya capturadas tienen coherencia individual; no atomicidad global entre ellas. */
export async function exportarArchivoPortable(planEntrada: Itinerario, capturaEntrada: CapturaPortable,
  limitesEntrada: LimitesPortables): Promise<ArchivoPortable> {
  const limites = copiarLimitesPortables(limitesEntrada);
  const plan = copiarPlanPortable(planEntrada);
  const entrada = copiarCapturaPortable(capturaEntrada, limites);
  // Inspección previa al clon evita perder propios ocultos/getters. Blob es excepción explícita.
  const binarios: Blob[] = [];
  const segmentos: SegmentoPortable[] = [];
  const tablas: Record<string, RegistroPortable[]> = {};
  validarCaptura(plan, entrada);
  let registros = 0; let offset = 0;
  for (const base of [entrada.fotos, entrada.progreso, entrada.respaldos]) {
    for (const lista of Object.values(base.tablas)) registros = suma(registros, lista.length);
  }
  if (registros > limites.maxRegistros) fallo('maxRegistros excedido');
  for (const tabla of Object.keys(entrada.fotos.tablas).sort()) {
    tablas[tabla] = [...entrada.fotos.tablas[tabla]].sort((a, b) => a.clave < b.clave ? -1 : a.clave > b.clave ? 1 : 0).map((r) => {
      if (tabla === 'metadatos') return r;
      const blob = r.valor as Blob;
      const bytes = tamanoBlob(blob); const mime = tipoBlob(blob);
      const indice = segmentos.length;
      segmentos.push({ tabla: tabla as SegmentoPortable['tabla'], clave: r.clave, offset, bytes, mime, crc32: 0 });
      offset = suma(offset, bytes); binarios.push(blob);
      return { clave: r.clave, valor: { segmento: indice } };
    });
  }
  const ordenar = (base: BasePortable): BasePortable => ({ presente: base.presente,
    tablas: Object.fromEntries(Object.entries(base.tablas).map(([t, rs]) => [t, [...rs].sort((a, b) => a.clave < b.clave ? -1 : a.clave > b.clave ? 1 : 0)])) });
  const manifiestoEntrada = { formato: 1, alcance: 'historia-durable-por-base',
    captura: { ...entrada, fotos: { presente: entrada.fotos.presente, tablas },
      progreso: ordenar(entrada.progreso), respaldos: ordenar(entrada.respaldos) }, segmentos };
  // JSON prevalidado crea una copia propia fiel, incluido -0. No structuredClone universal.
  const manifiesto = JSON.parse(codificarJsonFiel(manifiestoEntrada, limites)) as ManifiestoPortable;
  if (suma(cabeceraBytes, offset) > limites.maxBytesArchivo) fallo('maxBytesArchivo excedido');
  for (const [i, blob] of binarios.entries()) {
    (manifiesto.segmentos[i] as { crc32: number }).crc32 = await crcBlob(blob);
  }
  const metadata = codificador.encode(codificarJsonFiel(manifiesto, limites));
  const total = suma(suma(cabeceraBytes, metadata.length), offset);
  if (total > limites.maxBytesArchivo) fallo('maxBytesArchivo excedido');
  const cabecera = new Uint8Array(cabeceraBytes); cabecera.set(magic);
  const dv = new DataView(cabecera.buffer);
  dv.setUint32(8, 1); dv.setBigUint64(12, BigInt(metadata.length));
  dv.setUint32(20, (actualizarCrc(0xffffffff, metadata) ^ 0xffffffff) >>> 0);
  const archivo = new Blob([cabecera, metadata, ...binarios], { type: 'application/octet-stream' });
  if (archivo.size !== total) fallo('longitud final incompatible');
  return vista(archivo, manifiesto, cabeceraBytes + metadata.length);
}

/** Inspección verificable sin escribir bases, reactivar colas ni conceder ACK.
 * Exige representación canónica propia (rechaza duplicados JSON, extras y alias de segmentos).
 * Todas las integridades se comprueban antes de entregar referencias binarias. */
export async function inspeccionarArchivoPortable(planEntrada: Itinerario, archivo: Blob,
  limitesEntrada: LimitesPortables): Promise<ArchivoPortable> {
  const limites = copiarLimitesPortables(limitesEntrada); const plan = copiarPlanPortable(planEntrada);
  const tamano = tamanoBlob(archivo);
  if (tamano < cabeceraBytes || tamano > limites.maxBytesArchivo) fallo('longitud del archivo inválida');
  const cabecera = new Uint8Array(await Blob.prototype.slice.call(archivo, 0, cabeceraBytes).arrayBuffer());
  if (!magic.every((b, i) => b === cabecera[i])) fallo('magic desconocido');
  const dv = new DataView(cabecera.buffer);
  if (dv.getUint32(8) !== 1) fallo('versión desconocida');
  const longitudGrande = dv.getBigUint64(12);
  if (longitudGrande > BigInt(Number.MAX_SAFE_INTEGER)) fallo('longitud insegura');
  const longitud = Number(longitudGrande); const inicio = suma(cabeceraBytes, longitud);
  if (longitud > limites.maxBytesMetadatos || inicio > tamano) fallo('manifiesto truncado o excesivo');
  const bytes = new Uint8Array(await Blob.prototype.slice.call(archivo, cabeceraBytes, inicio).arrayBuffer());
  if (((actualizarCrc(0xffffffff, bytes) ^ 0xffffffff) >>> 0) !== dv.getUint32(20)) fallo('CRC del manifiesto');
  const texto = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
  const desconocido: unknown = JSON.parse(texto);
  if (codificarJsonFiel(desconocido, limites) !== texto) fallo('JSON no canónico o claves duplicadas');
  exigirCampos(desconocido, ['formato', 'alcance', 'captura', 'segmentos']);
  if (desconocido.formato !== 1 || desconocido.alcance !== 'historia-durable-por-base' || !Array.isArray(desconocido.segmentos)) fallo('formato del manifiesto');
  const manifiesto = desconocido as unknown as ManifiestoPortable;
  let offset = 0; const ids = new Set<string>();
  // Toda forma/longitud se valida sin await, antes de comprobar binarios.
  for (const s of manifiesto.segmentos) {
    exigirCampos(s, ['tabla', 'clave', 'offset', 'bytes', 'mime', 'crc32']);
    if (!['originales', 'miniaturas'].includes(s.tabla) || typeof s.clave !== 'string' || typeof s.mime !== 'string'
      || !Number.isSafeInteger(s.bytes) || s.bytes < 0 || s.offset !== offset
      || !Number.isSafeInteger(s.crc32) || s.crc32 < 0 || s.crc32 > 0xffffffff) fallo('segmento inválido');
    const id = `${s.tabla}|${s.clave}`;
    if (ids.has(id)) fallo('segmento duplicado'); ids.add(id); offset = suma(offset, s.bytes);
  }
  if (suma(inicio, offset) !== tamano) fallo('segmentos truncados o bytes adicionales');
  const r = vista(archivo, manifiesto, inicio);
  const usados = new Set<number>();
  const captura = manifiesto.captura;
  exigirCampos(captura, ['viajeId', 'fotos', 'progreso', 'respaldos', 'legado']);
  validarBasePortable(captura.fotos, ['metadatos', 'originales', 'miniaturas']);
  const tablas: Record<string, RegistroPortable[]> = {};
  let registros = 0;
  for (const base of [captura.fotos, captura.progreso, captura.respaldos]) {
    // La forma restante se comprueba en sus drivers antes de leer binarios.
    exigirCampos(base, ['presente', 'tablas']);
    for (const lista of Object.values(base.tablas)) {
      if (!Array.isArray(lista)) fallo('registros inválidos'); registros = suma(registros, lista.length);
    }
  }
  if (registros > limites.maxRegistros) fallo('maxRegistros excedido');
  for (const [tabla, lista] of Object.entries(captura.fotos.tablas)) {
    tablas[tabla] = lista.map((registro) => {
      if (tabla === 'metadatos') return registro;
      exigirCampos(registro.valor, ['segmento']); const indice = registro.valor.segmento;
      if (typeof indice !== 'number' || !Number.isSafeInteger(indice) || usados.has(indice)) fallo('referencia duplicada o inválida');
      const s = manifiesto.segmentos[indice];
      if (!s || s.tabla !== tabla || s.clave !== registro.clave) fallo('referencia incompatible');
      usados.add(indice); return { clave: registro.clave, valor: r.leerSegmento(indice) };
    });
  }
  if (usados.size !== manifiesto.segmentos.length) fallo('segmento huérfano');
  validarCaptura(plan, { ...captura, fotos: { presente: captura.fotos.presente, tablas } });
  for (let i = 0; i < manifiesto.segmentos.length; i++) {
    if (await crcBlob(r.leerSegmento(i)) !== manifiesto.segmentos[i].crc32) fallo(`CRC del segmento ${i}`);
  }
  return r;
}
