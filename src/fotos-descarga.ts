import type { Itinerario } from './tipos';
import { camposFoto, copiarMetadatos, esFotoBorrada, tamanoBlob, tipoBlob, type CapturaFoto } from './fotos';
import type { FotosLocal } from './fotos-local';
import { comprobarIdentidadFoto } from './fotos-identidad';
import { copiarIdentidadRespaldo, mismosOriginalesRespaldo, type OriginalRespaldo } from './fotos-respaldo';

export interface OpcionesDescargaFotos {
  readonly plan: Itinerario;
  /** Origen confiable de composición, exactamente location.origin en navegador. */
  readonly origen: string;
  /** PhotoDB existente, vivo inmutable/no-ABA; TX resuelta en oncomplete. Nunca se cierra aquí. */
  readonly fotos: Pick<FotosLocal, 'leerMetadatos' | 'leerOriginal' | 'guardarOriginal'>;
  /** Puerto confiable capturado al construir. Una Response sintética de URL vacía solo se
   * acepta si se inyecta este puerto. No usar fixtures/importaciones en producción. */
  readonly fetch?: typeof fetch | null;
  /** Entero seguro no negativo. Cero impide originales positivos; omitirlo usa tamaño seleccionado. */
  readonly maxBytesOriginal?: number;
  /** Plazo de la recepción (GET y stream), entero positivo en ms; omitido: sin plazo propio. No cubre la TX local. */
  readonly plazoMs?: number;
}
/** Por qué falló, cuando importa a quien llama: «sin-sesion» (401 del endpoint exacto) o «plazo» (venció). */
export type CausaRecepcion = 'sin-sesion' | 'plazo';
export type ResultadoDescargaFotos =
  | { readonly tipo: 'guardada'; readonly captura: CapturaFoto; readonly bytesRecibidos: number }
  | { readonly tipo: 'fallida'; readonly motivo: string; readonly causa?: CausaRecepcion; readonly captura?: CapturaFoto;
      readonly bytesRecibidos: number }
  | { readonly tipo: 'detenida'; readonly bytesRecibidos: number };
export interface DescargaFotos {
  /** Única acción que inicia IO. No es recibo de respaldo ni autentica un catálogo importado. */
  descargar(original: OriginalRespaldo): Promise<ResultadoDescargaFotos>;
  /** No puede deshacer una TX ya iniciada; consultar PhotoDB manualmente después. */
  cancelar(): void;
  /** Aborta recursos propios sin cerrar el puerto del llamador ni borrar datos. */
  cerrar(): void;
}
/** Recepción protegida de UN original a memoria, sin PhotoDB: para verlo en una vista temporal saneada. */
export interface OpcionesRecepcionOriginal {
  readonly plan: Itinerario;
  /** Origen confiable de composición, exactamente location.origin en navegador. */
  readonly origen: string;
  /** Mismo contrato que en la descarga: una Response sintética de URL vacía solo con puerto inyectado. */
  readonly fetch?: typeof fetch | null;
  /** Entero seguro no negativo; misma política de original que la descarga y el transporte. */
  readonly maxBytesOriginal?: number;
  /** Plazo de la recepción (GET y stream), entero positivo en ms; omitido: sin plazo propio. */
  readonly plazoMs?: number;
}
export type ResultadoRecepcionOriginal =
  | { readonly tipo: 'recibido'; readonly original: Blob; readonly bytesRecibidos: number }
  | { readonly tipo: 'fallida'; readonly motivo: 'sin-sesion' | 'plazo' | 'limite' | 'identidad' | 'respuesta' | 'red';
      readonly bytesRecibidos: number }
  | { readonly tipo: 'detenida'; readonly bytesRecibidos: number };
export interface RecepcionOriginal {
  /** UN GET manual por llamada. Los bytes solo existen en el Blob devuelto: nada se escribe en IndexedDB,
   * CacheStorage ni storage, y no es recibo, captura guardada ni prueba de identidad local. Integridad: identidad,
   * longitud exacta hasta EOF y contrato binario; no hay hash criptográfico del contenido en el protocolo. Con
   * plazo, al vencer se aborta el GET y se cancela el lector; la promesa se resuelve cuando el puerto suelta su
   * trabajo (un puerto que ignore el abort retrasa la entrega, no la deja escapar). */
  recibir(original: OriginalRespaldo, senal?: AbortSignal): Promise<ResultadoRecepcionOriginal>;
  /** Aborta las recepciones en curso; no cierra puertos del llamador. */
  cerrar(): void;
}
/** Estado de UNA recepción: su señal, los bytes medidos y el lector que hay que cancelar. */
interface Operacion {
  readonly controlador: AbortController;
  bytes: number;
  lector: ReadableStreamDefaultReader<Uint8Array> | null;
  /** Venció el plazo de la recepción (y por eso se abortó). */
  vencida?: boolean;
}
interface Transporte {
  readonly origen: string;
  readonly enviar: typeof fetch | null | undefined;
  readonly inyectado: boolean;
  readonly limite: number | undefined;
  readonly plazoMs: number | undefined;
}
class Detenida extends Error {}
/** Fallo del contrato HTTP protegido (mismos textos que antes); `sinSesion` solo para un 401 del endpoint exacto. */
class ErrorRecepcion extends Error {
  constructor(mensaje: string, readonly sinSesion = false) { super(mensaje); }
}

/** Opciones comunes a descarga y recepción: plan, origen exacto del contexto, puerto HTTP y límite de original. */
function transporteDe(opciones: OpcionesRecepcionOriginal): { plan: Itinerario; transporte: Transporte } {
  const plan = structuredClone(opciones.plan);
  const origen = opciones.origen;
  const url = typeof origen === 'string' ? new URL(origen) : null;
  if (!url || !['https:', 'http:'].includes(url.protocol) || url.origin !== origen
    || url.username || url.password || url.search || url.hash
    || (typeof location !== 'undefined' && location.origin !== origen)) {
    throw new Error('Origen confiable inválido o distinto del contexto');
  }
  const limite = opciones.maxBytesOriginal;
  if (limite !== undefined && (!Number.isSafeInteger(limite) || limite < 0)) {
    throw new Error('Límite de original inválido');
  }
  const plazoMs = opciones.plazoMs;
  if (plazoMs !== undefined && (!Number.isSafeInteger(plazoMs) || plazoMs < 1 || plazoMs > 2147483647)) {
    throw new Error('Plazo de recepción inválido');
  }
  const inyectado = typeof opciones.fetch === 'function';
  const enviar = opciones.fetch === undefined ? globalThis.fetch?.bind(globalThis) : opciones.fetch;
  return { plan, transporte: { origen, enviar, inyectado, limite, plazoMs } };
}

/** GET protegido del original: cookie de sesión del mismo origen, sin caché HTTP, sin seguir redirecciones,
 * contrato binario no-store/nosniff, stream medido hasta EOF con el tamaño exacto seleccionado y cancelación del
 * lector en cualquier salida que no sea completa. `vigente` lanza si la operación dejó de valer, también entre
 * awaits. No interpreta imágenes, no crea File/URL ni toca PhotoDB: devuelve un Blob en memoria. */
async function recibirProtegido(t: Transporte, ref: OriginalRespaldo, o: Operacion, vigente: () => void): Promise<Blob> {
  const esperar = async <T>(trabajo: () => Promise<T>): Promise<T> => {
    vigente();
    try { const valor = await trabajo(); vigente(); return valor; }
    catch (e) { vigente(); throw e; }
  };
  if (typeof t.enviar !== 'function') throw new Error('Fetch no disponible');
  const enviar = t.enviar;
  const endpoint = `${t.origen}/api/fotos/${encodeURIComponent(ref.fotoId)}/original`;
  vigente();
  // Plazo finito del GET y del stream: al vencer, abort y cancelación del lector; el limpiado sigue en finally.
  const plazo = t.plazoMs === undefined ? null : setTimeout(() => {
    o.vencida = true;
    o.controlador.abort();
    if (o.lector) void o.lector.cancel().catch(() => {});
  }, t.plazoMs);
  try { return await leerProtegido(t, enviar, endpoint, ref, o, vigente, esperar); }
  finally { if (plazo !== null) clearTimeout(plazo); }
}
async function leerProtegido(t: Transporte, enviar: typeof fetch, endpoint: string, ref: OriginalRespaldo, o: Operacion,
  vigente: () => void, esperar: <T>(trabajo: () => Promise<T>) => Promise<T>): Promise<Blob> {
  // Necesita cleanup aun si la respuesta llega después del aborto del puerto inyectado.
  let respuesta: Response;
  try { respuesta = await enviar(endpoint, { method: 'GET', credentials: 'same-origin',
    cache: 'no-store', redirect: 'error', signal: o.controlador.signal,
    headers: { Accept: 'application/octet-stream' } }); }
  catch (e) { vigente(); throw e; }
  let completa = false;
  try {
    vigente();
    const propia = !respuesta.redirected && !(!respuesta.url && !t.inyectado) && !(respuesta.url && respuesta.url !== endpoint);
    if (respuesta.status !== 200 || !propia) {
      throw new ErrorRecepcion('Respuesta fuera del endpoint protegido o estado distinto de 200', propia && respuesta.status === 401);
    }
    if (respuesta.headers.get('Content-Type')?.trim().toLowerCase() !== 'application/octet-stream'
      || !respuesta.headers.get('Cache-Control')?.split(',').some((v) => v.trim().toLowerCase() === 'no-store')
      || respuesta.headers.get('X-Content-Type-Options')?.trim().toLowerCase() !== 'nosniff') {
      throw new ErrorRecepcion('Respuesta sin contrato binario protegido');
    }
    // Content-Length es solo hint: la autoridad del límite es el stream medido y el EOF.
    if (!respuesta.body) throw new ErrorRecepcion('Respuesta sin stream binario');
    const lector = respuesta.body.getReader();
    o.lector = lector;
    const partes: Uint8Array<ArrayBuffer>[] = [];
    for (;;) {
      const bloque = await esperar(() => lector.read());
      if (bloque.done) break;
      if (!(bloque.value instanceof Uint8Array)) throw new ErrorRecepcion('Chunk binario inválido');
      const bytes = bloque.value.byteLength;
      // Suma solo después de descartar overflow; exceso observado no es éxito ni captura completa.
      if (!Number.isSafeInteger(o.bytes + bytes)) throw new ErrorRecepcion('Conteo de bytes fuera de rango');
      o.bytes += bytes;
      if (o.bytes > ref.bytesOriginal || (t.limite !== undefined && o.bytes > t.limite)) {
        throw new ErrorRecepcion('Original excede los bytes seleccionados');
      }
      partes.push(new Uint8Array(bloque.value)); // snapshot ante reutilización de buffers del puerto
    }
    if (o.bytes !== ref.bytesOriginal) throw new ErrorRecepcion('Original truncado');
    vigente();
    const blob = new Blob(partes, { type: ref.mimeDeclarado });
    // El Blob no se renderiza/decodifica. Su type no reemplaza nunca metadata raw;
    // si el constructor lo normaliza, PhotoDB rechazará la captura incompatible.
    if (tamanoBlob(blob) !== ref.bytesOriginal) throw new ErrorRecepcion('Blob incompatible');
    completa = true;
    return blob;
  } finally {
    const lector = o.lector;
    if (lector) {
      if (!completa) { try { await lector.cancel(); } catch { /* stream ya abortado */ } }
      lector.releaseLock(); o.lector = null;
    } else if (!completa && respuesta.body && !respuesta.body.locked) {
      try { await respuesta.body.cancel(); } catch { /* cuerpo ya cerrado */ }
    }
  }
}

/** Recepción a memoria para la vista temporal de una foto compartida. Sin apertura de DB, singleton ni IO al
 * construir. Varias recepciones pueden convivir (cada una con su AbortController); quien compone acota cuántas.
 * El original privado puede llegar ENTERO (hasta su tamaño y el límite de la composición): no hay miniaturas
 * compartidas. Cancelar descarta la entrega tardía; no promete que el navegador no haya recibido bytes. */
export function crearRecepcionOriginal(opciones: OpcionesRecepcionOriginal): RecepcionOriginal {
  const obligatorias = ['plan', 'origen'];
  const permitidas = [...obligatorias, 'fetch', 'maxBytesOriginal', 'plazoMs'];
  const claves = typeof opciones === 'object' && opciones !== null ? Reflect.ownKeys(opciones) : [];
  if (claves.some((k) => typeof k !== 'string' || !permitidas.includes(k))
    || !obligatorias.every((k) => claves.includes(k)) || !camposFoto(opciones, claves as string[])) {
    throw new Error('Opciones de recepción inválidas');
  }
  const { plan, transporte } = transporteDe(opciones);
  let cerrada = false;
  const activas = new Set<Operacion>();
  function detener(o: Operacion) {
    o.controlador.abort();
    if (o.lector) void o.lector.cancel().catch(() => {});
  }
  return {
    async recibir(original, senal) {
      if (cerrada || senal?.aborted) return { tipo: 'detenida', bytesRecibidos: 0 };
      // Materializa todos los campos ANTES del primer await, como la descarga.
      let ref: OriginalRespaldo;
      try { ref = copiarIdentidadRespaldo(plan, original); }
      catch { return { tipo: 'fallida', motivo: 'identidad', bytesRecibidos: 0 }; }
      if (transporte.limite !== undefined && ref.bytesOriginal > transporte.limite) {
        return { tipo: 'fallida', motivo: 'limite', bytesRecibidos: 0 };
      }
      const o: Operacion = { controlador: new AbortController(), bytes: 0, lector: null };
      const alAbortar = () => detener(o);
      senal?.addEventListener('abort', alAbortar, { once: true });
      activas.add(o);
      try {
        const blob = await recibirProtegido(transporte, ref, o, () => {
          if (cerrada || o.controlador.signal.aborted) throw new Detenida('Recepción detenida');
        });
        return { tipo: 'recibido', original: blob, bytesRecibidos: o.bytes };
      } catch (e) {
        if (o.vencida && !cerrada) return { tipo: 'fallida', motivo: 'plazo', bytesRecibidos: o.bytes };
        if (e instanceof Detenida || o.controlador.signal.aborted || cerrada) return { tipo: 'detenida', bytesRecibidos: o.bytes };
        if (e instanceof ErrorRecepcion) {
          return { tipo: 'fallida', motivo: e.sinSesion ? 'sin-sesion' : 'respuesta', bytesRecibidos: o.bytes };
        }
        return { tipo: 'fallida', motivo: 'red', bytesRecibidos: o.bytes };
      } finally {
        senal?.removeEventListener('abort', alAbortar);
        activas.delete(o);
      }
    },
    cerrar() {
      cerrada = true;
      for (const o of activas) detener(o);
    },
  };
}

/** GET manual de original, sin apertura de DB, singleton, miniaturas ni IO al construir.
 * El futuro servidor protegido debe comprobar sesión viva e identidad del objeto; estos headers,
 * tamaño y URL NO autentican los bytes. No interpreta imágenes ni crea File/URL de recurso.
 * Acota bytes aceptados por la app, no chunks internos, RAM del dispositivo, cuota ni facturación.
 * Captura de fallo pertenece solo al llamador durante esta sesión, sin persistencia/promesa de reopen.
 * Confirmación local requiere atestación completa: metadata fresca + TODOS los bytes + metadata final.
 * La exclusión es por instancia, no global/distribuida; requiere contrato inmutable/no-ABA de PhotoDB. */
export function crearDescargaFotos(opciones: OpcionesDescargaFotos): DescargaFotos {
  const obligatorias = ['plan', 'origen', 'fotos'];
  const permitidas = [...obligatorias, 'fetch', 'maxBytesOriginal', 'plazoMs'];
  const claves = typeof opciones === 'object' && opciones !== null ? Reflect.ownKeys(opciones) : [];
  if (claves.some((k) => typeof k !== 'string' || !permitidas.includes(k))
    || !obligatorias.every((k) => claves.includes(k)) || !camposFoto(opciones, claves as string[])) {
    throw new Error('Opciones de descarga inválidas');
  }
  const { plan, transporte } = transporteDe(opciones);
  const limite = transporte.limite;
  const puerto = opciones.fotos;
  // Captura funciones y ownership: cambios posteriores del objeto no sustituyen el puerto.
  if (!puerto || typeof puerto.leerMetadatos !== 'function' || typeof puerto.leerOriginal !== 'function'
    || typeof puerto.guardarOriginal !== 'function') throw new Error('Puerto de fotos no disponible');
  const leerMetadatos = puerto.leerMetadatos.bind(puerto);
  const leerOriginal = puerto.leerOriginal.bind(puerto);
  const guardarOriginal = puerto.guardarOriginal.bind(puerto);
  let cerrada = false;
  let activa: Operacion | null = null;

  function vigente(o: Operacion) {
    if (cerrada || activa !== o || o.controlador.signal.aborted) throw new Detenida('Descarga detenida');
  }
  async function esperar<T>(o: Operacion, trabajo: () => Promise<T>): Promise<T> {
    vigente(o);
    try { const valor = await trabajo(); vigente(o); return valor; }
    catch (e) { vigente(o); throw e; }
  }
  function detener() {
    const o = activa;
    if (!o) return;
    o.controlador.abort();
    if (o.lector) void o.lector.cancel().catch(() => {});
    // No libera ownership antes de finally: un fetch inyectado puede ignorar abort.
  }
  async function estado(o: Operacion, ref: OriginalRespaldo) {
    const valor = await esperar(o, () => leerMetadatos(ref.fotoId));
    if (valor === null) return null;
    if (esFotoBorrada(valor)) throw new Error('Foto borrada: no se puede resucitar');
    const m = copiarMetadatos(plan, valor);
    if (!mismosOriginalesRespaldo(plan, ref, copiarIdentidadRespaldo(plan, {
      formato: m.formato, fotoId: m.fotoId, destino: m.destino, nombre: m.nombre,
      mimeDeclarado: m.mimeDeclarado, ultimaModificacion: m.ultimaModificacion,
      incorporada: m.incorporada, bytesOriginal: m.bytesOriginal,
    }))) throw new Error('Colisión de identidad original local');
    return m;
  }
  async function identidad(o: Operacion, c: CapturaFoto) {
    // Guards también entre awaits internos del helper: cancelar impide la siguiente lectura.
    return esperar(o, () => comprobarIdentidadFoto(plan, {
      leerMetadatos: (id) => esperar(o, () => leerMetadatos(id)),
      leerOriginal: (id) => esperar(o, () => leerOriginal(id)),
    }, c.metadatos, c.original));
  }
  /** El mismo GET protegido que la recepción a memoria; aquí sus bytes siguen hacia la atestación y PhotoDB. */
  function recibir(o: Operacion, ref: OriginalRespaldo): Promise<Blob> {
    return recibirProtegido(transporte, ref, o, () => vigente(o));
  }
  async function ejecutar(o: Operacion, ref: OriginalRespaldo): Promise<ResultadoDescargaFotos> {
    let captura: CapturaFoto | undefined;
    try {
      vigente(o);
      if (limite !== undefined && ref.bytesOriginal > limite) throw new Error('Original supera política de descarga');
      const previa = await estado(o, ref); vigente(o);
      if (previa !== null) {
        const local = await esperar(o, () => leerOriginal(ref.fotoId));
        if (local === null || tamanoBlob(local) !== ref.bytesOriginal || tipoBlob(local) !== ref.mimeDeclarado) {
          throw new Error('Original local ausente o corrupto');
        }
        // Lectura fresca antes del GET: no se continúa si apareció un tombstone/cambio.
        if (await estado(o, ref) === null) throw new Error('Original local desapareció');
        vigente(o);
      }
      const original = await recibir(o, ref); vigente(o);
      captura = { original, metadatos: copiarMetadatos(plan, { ...ref, miniatura: { tipo: 'pendiente' } }) };
      const anterior = await estado(o, ref); vigente(o);
      if (anterior !== null) {
        const atestada = await identidad(o, captura); vigente(o);
        if (atestada.tipo !== 'misma') throw new Error('Original local distinto o no comprobable');
        // Conserva miniatura derivada del registro existente, sin escribir ni descargarla.
        return { tipo: 'guardada', captura: { original, metadatos: atestada.metadatos }, bytesRecibidos: o.bytes };
      }
      // Última lectura inmediatamente anterior a la escritura. El puerto mantiene el guard de colisión.
      try { await esperar(o, () => guardarOriginal(captura!)); }
      catch (e) {
        vigente(o);
        // Constraint/ACK local perdido: nunca metadata-only ni idempotencia genérica.
        const actual = await identidad(o, captura); vigente(o);
        if (actual.tipo !== 'misma') throw e;
        return { tipo: 'guardada', captura: { original, metadatos: actual.metadatos }, bytesRecibidos: o.bytes };
      }
      const actual = await identidad(o, captura); vigente(o);
      if (actual.tipo !== 'misma') throw new Error('Escritura sin identidad durable comprobada');
      return { tipo: 'guardada', captura: { original, metadatos: actual.metadatos }, bytesRecibidos: o.bytes };
    } catch (e) {
      if (o.vencida && !cerrada) {
        // Venció el plazo de la recepción (antes de cualquier escritura): fallo tipado, sin bytes.
        return { tipo: 'fallida', motivo: 'Plazo de recepción agotado', causa: 'plazo', bytesRecibidos: o.bytes };
      }
      if (e instanceof Detenida || o.controlador.signal.aborted || cerrada) {
        captura = undefined;
        return { tipo: 'detenida', bytesRecibidos: o.bytes };
      }
      // La sesión perdida llega tipada: quien guarda decide qué invalidar, no un texto.
      const causa: CausaRecepcion | undefined = e instanceof ErrorRecepcion && e.sinSesion ? 'sin-sesion' : undefined;
      return { tipo: 'fallida', motivo: e instanceof Error ? e.message : 'Descarga no confirmada',
        ...(causa ? { causa } : {}), ...(captura ? { captura } : {}), bytesRecibidos: o.bytes };
    } finally { if (activa === o) activa = null; }
  }
  return {
    descargar(original) {
      if (cerrada) return Promise.resolve({ tipo: 'detenida', bytesRecibidos: 0 });
      if (activa) return Promise.resolve({ tipo: 'fallida', motivo: 'Ya hay una descarga activa', bytesRecibidos: 0 });
      // Materializa todos los campos ANTES del primer await; no regenera identidad ni normaliza strings/-0.
      let ref: OriginalRespaldo;
      try { ref = copiarIdentidadRespaldo(plan, original); }
      catch { return Promise.resolve({ tipo: 'fallida', motivo: 'Identidad original inválida', bytesRecibidos: 0 }); }
      const o: Operacion = { controlador: new AbortController(), bytes: 0, lector: null };
      activa = o;
      return ejecutar(o, ref);
    },
    cancelar: detener,
    cerrar() { cerrada = true; detener(); },
  };
}
