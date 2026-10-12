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
}
export type ResultadoDescargaFotos =
  | { readonly tipo: 'guardada'; readonly captura: CapturaFoto; readonly bytesRecibidos: number }
  | { readonly tipo: 'fallida'; readonly motivo: string; readonly captura?: CapturaFoto; readonly bytesRecibidos: number }
  | { readonly tipo: 'detenida'; readonly bytesRecibidos: number };
export interface DescargaFotos {
  /** Única acción que inicia IO. No es recibo de respaldo ni autentica un catálogo importado. */
  descargar(original: OriginalRespaldo): Promise<ResultadoDescargaFotos>;
  /** No puede deshacer una TX ya iniciada; consultar PhotoDB manualmente después. */
  cancelar(): void;
  /** Aborta recursos propios sin cerrar el puerto del llamador ni borrar datos. */
  cerrar(): void;
}
interface Operacion {
  readonly controlador: AbortController;
  bytes: number;
  lector: ReadableStreamDefaultReader<Uint8Array> | null;
}
class Detenida extends Error {}

/** GET manual de original, sin apertura de DB, singleton, miniaturas ni IO al construir.
 * El futuro servidor protegido debe comprobar sesión viva e identidad del objeto; estos headers,
 * tamaño y URL NO autentican los bytes. No interpreta imágenes ni crea File/URL de recurso.
 * Acota bytes aceptados por la app, no chunks internos, RAM del dispositivo, cuota ni facturación.
 * Captura de fallo pertenece solo al llamador durante esta sesión, sin persistencia/promesa de reopen.
 * Confirmación local requiere atestación completa: metadata fresca + TODOS los bytes + metadata final.
 * La exclusión es por instancia, no global/distribuida; requiere contrato inmutable/no-ABA de PhotoDB. */
export function crearDescargaFotos(opciones: OpcionesDescargaFotos): DescargaFotos {
  const obligatorias = ['plan', 'origen', 'fotos'];
  const permitidas = [...obligatorias, 'fetch', 'maxBytesOriginal'];
  const claves = typeof opciones === 'object' && opciones !== null ? Reflect.ownKeys(opciones) : [];
  if (claves.some((k) => typeof k !== 'string' || !permitidas.includes(k))
    || !obligatorias.every((k) => claves.includes(k)) || !camposFoto(opciones, claves as string[])) {
    throw new Error('Opciones de descarga inválidas');
  }
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
  const puerto = opciones.fotos;
  // Captura funciones y ownership: cambios posteriores del objeto no sustituyen el puerto.
  if (!puerto || typeof puerto.leerMetadatos !== 'function' || typeof puerto.leerOriginal !== 'function'
    || typeof puerto.guardarOriginal !== 'function') throw new Error('Puerto de fotos no disponible');
  const leerMetadatos = puerto.leerMetadatos.bind(puerto);
  const leerOriginal = puerto.leerOriginal.bind(puerto);
  const guardarOriginal = puerto.guardarOriginal.bind(puerto);
  const inyectado = typeof opciones.fetch === 'function';
  const enviar = opciones.fetch === undefined ? globalThis.fetch?.bind(globalThis) : opciones.fetch;
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
  async function recibir(o: Operacion, ref: OriginalRespaldo): Promise<Blob> {
    if (typeof enviar !== 'function') throw new Error('Fetch no disponible');
    const endpoint = `${origen}/api/fotos/${encodeURIComponent(ref.fotoId)}/original`;
    // Necesita cleanup aun si la respuesta llega después del aborto del puerto inyectado.
    let respuesta: Response;
    vigente(o);
    try { respuesta = await enviar(endpoint, { method: 'GET', credentials: 'same-origin',
      cache: 'no-store', redirect: 'error', signal: o.controlador.signal,
      headers: { Accept: 'application/octet-stream' } }); }
    catch (e) { vigente(o); throw e; }
    let completa = false;
    try {
      vigente(o);
      if (respuesta.status !== 200 || respuesta.redirected
        || (!respuesta.url && !inyectado) || (respuesta.url && respuesta.url !== endpoint)) {
        throw new Error('Respuesta fuera del endpoint protegido o estado distinto de 200');
      }
      if (respuesta.headers.get('Content-Type')?.trim().toLowerCase() !== 'application/octet-stream'
        || !respuesta.headers.get('Cache-Control')?.split(',').some((v) => v.trim().toLowerCase() === 'no-store')
        || respuesta.headers.get('X-Content-Type-Options')?.trim().toLowerCase() !== 'nosniff') {
        throw new Error('Respuesta sin contrato binario protegido');
      }
      // Content-Length es solo hint: la autoridad del límite es el stream medido y el EOF.
      if (!respuesta.body) throw new Error('Respuesta sin stream binario');
      const lector = respuesta.body.getReader();
      o.lector = lector;
      const partes: Uint8Array<ArrayBuffer>[] = [];
      for (;;) {
        const bloque = await esperar(o, () => lector.read());
        if (bloque.done) break;
        if (!(bloque.value instanceof Uint8Array)) throw new Error('Chunk binario inválido');
        const bytes = bloque.value.byteLength;
        // Suma solo después de descartar overflow; exceso observado no es éxito ni captura completa.
        if (!Number.isSafeInteger(o.bytes + bytes)) throw new Error('Conteo de bytes fuera de rango');
        o.bytes += bytes;
        if (o.bytes > ref.bytesOriginal || (limite !== undefined && o.bytes > limite)) {
          throw new Error('Original excede los bytes seleccionados');
        }
        partes.push(new Uint8Array(bloque.value)); // snapshot ante reutilización de buffers del puerto
      }
      if (o.bytes !== ref.bytesOriginal) throw new Error('Original truncado');
      vigente(o);
      const blob = new Blob(partes, { type: ref.mimeDeclarado });
      // El Blob no se renderiza/decodifica. Su type no reemplaza nunca metadata raw;
      // si el constructor lo normaliza, PhotoDB rechazará la captura incompatible.
      if (tamanoBlob(blob) !== ref.bytesOriginal) throw new Error('Blob incompatible');
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
      if (e instanceof Detenida || o.controlador.signal.aborted || cerrada) {
        captura = undefined;
        return { tipo: 'detenida', bytesRecibidos: o.bytes };
      }
      return { tipo: 'fallida', motivo: e instanceof Error ? e.message : 'Descarga no confirmada',
        ...(captura ? { captura } : {}), bytesRecibidos: o.bytes };
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
