import type { Itinerario } from '../src/tipos';
import { camposFoto, esIdFoto } from '../src/fotos';
import { deserializarSolicitudRespaldo, serializarSolicitudRespaldo } from '../src/fotos-protocolo';
import { admitirMarcoObjetoFotos, clavePrivadaFotos, MAGIC_OBJETO_FOTOS,
  BYTES_CABECERA_OBJETO_FOTOS, type ContextoObjetosFotos, type ObjetosFotos } from './almacen-fotos';
import { copiarPlanFotos, copiarPresupuestoFotos, FalloFotos } from './multipart-fotos';

/** Vinculación estructural mínima; no certifica semántica de un proveedor real. */
export interface VinculoR2Fotos {
  get(clave: string): Promise<unknown>;
  put(clave: string, valor: Blob, opciones: { onlyIf: Headers; httpMetadata: { contentType: string } }): Promise<unknown>;
}
/** Captura métodos de clase conservando receiver, sin evaluar accessors heredados. */
function metodo(valor: object, nombre: string): (...args: never[]) => unknown {
  for (let actual: object | null = valor; actual; actual = Object.getPrototypeOf(actual)) {
    const d = Object.getOwnPropertyDescriptor(actual, nombre);
    if (!d) continue;
    if (!Object.hasOwn(d, 'value') || typeof d.value !== 'function') throw new FalloFotos(503);
    return Function.prototype.bind.call(d.value, valor);
  }
  throw new FalloFotos(503);
}
function capturarContexto(contexto: ContextoObjetosFotos) {
  if (!camposFoto(contexto, ['presupuesto', 'vigencia'])) throw new FalloFotos(503);
  const p = copiarPresupuestoFotos(contexto.presupuesto); const v = contexto.vigencia;
  if (!v || typeof v !== 'object') throw new FalloFotos(503);
  const d = Object.getOwnPropertyDescriptor(v, 'signal');
  if (!d || !Object.hasOwn(d, 'value') || !(d.value instanceof AbortSignal)) throw new FalloFotos(503);
  const comprobar = metodo(v, 'comprobar') as () => void;
  const esperar = metodo(v, 'esperar') as typeof v.esperar;
  const signal = d.value as AbortSignal;
  comprobar();
  return Object.freeze({ p, comprobar, esperar, signal });
}
type ContextoFijo = ReturnType<typeof capturarContexto>;

/** Fábrica privada sin IO. No autentica, reserva, confirma SQL ni crea IDs. No retry,
 * delete ni prueba de igualdad por tamaño/ETag/hash. El único objeto contiene todo el
 * cuerpo inicial, no customMetadata limitada por el proveedor a 8 KiB. */
export function crearObjetosFotosR2(configuracion: { readonly plan: Itinerario; readonly bucket: VinculoR2Fotos }): ObjetosFotos {
  if (!camposFoto(configuracion, ['plan', 'bucket'])) throw new FalloFotos(503);
  let plan: Itinerario;
  try { plan = copiarPlanFotos(configuracion.plan); } catch { throw new FalloFotos(503); }
  const bucket = configuracion.bucket;
  if (!bucket || typeof bucket !== 'object') throw new FalloFotos(503);
  const get = metodo(bucket, 'get') as VinculoR2Fotos['get'];
  const put = metodo(bucket, 'put') as VinculoR2Fotos['put'];
  const sizeBlob = Object.getOwnPropertyDescriptor(Blob.prototype, 'size')!.get!;
  function entrada(clave: string, canonico: string, c: ContextoFijo) {
    if (typeof clave !== 'string' || clave.length > 1024 || new TextEncoder().encode(clave).length > 1024) throw new FalloFotos(503);
    let s: ReturnType<typeof deserializarSolicitudRespaldo>;
    try {
      s = deserializarSolicitudRespaldo(plan, canonico);
      if (serializarSolicitudRespaldo(plan, s) !== canonico) throw new Error();
      // Reconstrucción exacta, incluida caja UUID: jamás cambiar namespace ni adoptar.
      const prefijo = clavePrivadaFotos(plan.id, s.fotoId, '');
      if (!clave.startsWith(prefijo)) throw new Error();
      const reserva = decodeURIComponent(clave.slice(prefijo.length));
      if (!esIdFoto(reserva) || clavePrivadaFotos(plan.id, s.fotoId, reserva) !== clave) throw new Error();
    } catch { throw new FalloFotos(503); }
    const marco = admitirMarcoObjetoFotos(s.original.bytesOriginal, canonico, c.p);
    c.comprobar();
    return { ...marco, bytesOriginal: s.original.bytesOriginal };
  }
  function cancelarTardio(valor: unknown): void {
    // Sólo adquirir un reader propio si el proveedor entregó cuerpo no usado/libre.
    try {
      if (!valor || typeof valor !== 'object') return;
      const r = valor as { body?: unknown; bodyUsed?: unknown };
      const usado = r.bodyUsed; const body = r.body;
      if (usado !== false || !(body instanceof ReadableStream) || body.locked) return;
      const lector = body.getReader();
      void lector.cancel().catch(() => {});
      try { lector.releaseLock(); } catch { /* Limpieza sin invadir otro dueño. */ }
    } catch { /* No sustituir el fallo principal ni exponer detalles. */ }
  }
  return Object.freeze({
    async ponerSiAusente(clave: string, original: Blob, canonico: string, contexto: ContextoObjetosFotos) {
      const c = capturarContexto(contexto); const m = entrada(clave, canonico, c);
      let bytes: number;
      try { bytes = sizeBlob.call(original); } catch { throw new FalloFotos(503); }
      if (bytes !== m.bytesOriginal) throw new FalloFotos(503);
      // Blob compuesto puede consultar size en Node. Rechazar sobrescrituras sin
      // invocarlas: no fabricar otro slice completo para ocultar un accessor ajeno.
      for (let actual: object | null = original; actual; actual = Object.getPrototypeOf(actual)) {
        const d = Object.getOwnPropertyDescriptor(actual, 'size');
        if (!d) continue;
        if (d.get !== sizeBlob || Object.hasOwn(d, 'value')) throw new FalloFotos(503);
        break;
      }
      const cabecera = new Uint8Array(BYTES_CABECERA_OBJETO_FOTOS);
      cabecera.set(MAGIC_OBJETO_FOTOS); new DataView(cabecera.buffer).setUint32(8, m.bytesMetadata, false);
      // No slice extra ni arrayBuffer integral del original. Se cobra Blob compuesto.
      const objeto = new Blob([cabecera, new TextEncoder().encode(canonico), original], { type: 'application/octet-stream' });
      if (sizeBlob.call(objeto) !== m.bytesFisicos) throw new FalloFotos(503);
      const valor = await c.esperar(() => put(clave, objeto, { onlyIf: new Headers({ 'If-None-Match': '*' }),
        httpMetadata: { contentType: 'application/octet-stream' } }), true);
      c.comprobar();
      if (valor === null) return false;
      try {
        if (!valor || typeof valor !== 'object' || (valor as { key?: unknown }).key !== clave
          || (valor as { size?: unknown }).size !== m.bytesFisicos) throw new Error();
      } catch { throw new FalloFotos(503); }
      return true;
    },
    async leer(clave: string, canonico: string, contexto: ContextoObjetosFotos) {
      const c = capturarContexto(contexto); const m = entrada(clave, canonico, c);
      const valor = await c.esperar(() => get(clave).then((r) => {
        try { c.comprobar(); } catch (e) { cancelarTardio(r); throw e; }
        return r;
      }), true);
      if (valor === null) return null;
      let cuerpo: ReadableStream<Uint8Array>;
      try {
        if (!valor || typeof valor !== 'object') throw new Error();
        const r = valor as { key?: unknown; size?: unknown; body?: unknown; bodyUsed?: unknown };
        const key = r.key; const size = r.size; const usado = r.bodyUsed; const body = r.body;
        if (key !== clave || !Number.isSafeInteger(size) || size !== m.bytesFisicos
          || usado !== false || !(body instanceof ReadableStream) || body.locked) throw new Error();
        cuerpo = body;
      } catch { cancelarTardio(valor); throw new FalloFotos(503); }
      let lector: ReadableStreamDefaultReader<Uint8Array>;
      try { lector = cuerpo.getReader(); } catch { throw new FalloFotos(503); }
      let detenida = false; let entradaFisica = 0; let emitidos = 0;
      let chunk: Uint8Array<ArrayBuffer> | null = null; let posicion = 0;
      let metadata: Uint8Array<ArrayBuffer> | null = null;
      let controlador: ReadableStreamDefaultController<Uint8Array> | null = null;
      function liberar(): void {
        chunk = null; metadata = null; posicion = 0;
        c.signal.removeEventListener('abort', abortar);
        try { lector.releaseLock(); } catch { /* read pendiente libera al resolver. */ }
      }
      function detener(cancelar: boolean): void {
        if (detenida) return;
        detenida = true;
        if (cancelar) {
          try { void lector.cancel().catch(() => {}); } catch { /* No esperar hooks ajenos. */ }
        }
        liberar();
      }
      function abortar(): void {
        detener(true);
        try { controlador?.error(new FalloFotos(503)); } catch { /* Ya terminado. */ }
      }
      c.signal.addEventListener('abort', abortar, { once: true });
      async function siguiente(): Promise<boolean> {
        c.comprobar(); if (detenida) throw new FalloFotos(503);
        let r: Awaited<ReturnType<typeof lector.read>>;
        try { r = await c.esperar(() => lector.read(), true); }
        finally { if (detenida) liberar(); }
        c.comprobar(); if (detenida) throw new FalloFotos(503);
        if (r.done) {
          if (entradaFisica !== m.bytesFisicos) throw new FalloFotos(503);
          chunk = null; posicion = 0; return false;
        }
        const b = r.value;
        // Upstream ya asignó el chunk: esto limita retención propia, no heap global.
        if (!(b instanceof Uint8Array) || !(b.buffer instanceof ArrayBuffer)
          || b.byteLength > c.p.maxBytesChunk || b.byteLength > m.bytesFisicos - entradaFisica) throw new FalloFotos(503);
        entradaFisica += b.byteLength;
        chunk = new Uint8Array(b); posicion = 0;
        return true;
      }
      async function llenar(destino: Uint8Array): Promise<void> {
        let usados = 0;
        while (usados < destino.length) {
          c.comprobar(); if (detenida) throw new FalloFotos(503);
          if (!chunk || posicion === chunk.length) {
            if (!await siguiente()) throw new FalloFotos(503);
            continue;
          }
          const n = Math.min(destino.length - usados, chunk.length - posicion);
          destino.set(chunk.subarray(posicion, posicion + n), usados); usados += n; posicion += n;
        }
      }
      try {
        c.comprobar();
        const cabecera = new Uint8Array(BYTES_CABECERA_OBJETO_FOTOS);
        await llenar(cabecera);
        if (!MAGIC_OBJETO_FOTOS.every((b, i) => cabecera[i] === b)
          || new DataView(cabecera.buffer).getUint32(8, false) !== m.bytesMetadata) throw new FalloFotos(503);
        metadata = new Uint8Array(m.bytesMetadata); await llenar(metadata);
        // ignoreBOM conserva BOM en el texto para rechazarlo, no lo normaliza.
        const verificado = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(metadata);
        if (verificado !== canonico) throw new FalloFotos(503);
        metadata = null;
        const original = new ReadableStream<Uint8Array>({
          start(canal) { controlador = canal; },
          async pull(canal) {
            try {
              for (;;) {
                c.comprobar(); if (detenida) throw new FalloFotos(503);
                if (chunk && posicion < chunk.length) {
                  const resto = chunk.subarray(posicion);
                  if (resto.length > m.bytesOriginal - emitidos) throw new FalloFotos(503);
                  emitidos += resto.length; posicion = chunk.length;
                  c.comprobar(); if (detenida) throw new FalloFotos(503);
                  canal.enqueue(resto); return;
                }
                chunk = null;
                if (!await siguiente()) {
                  if (emitidos !== m.bytesOriginal) throw new FalloFotos(503);
                  c.comprobar(); detener(false); canal.close(); return;
                }
              }
            } catch {
              detener(true); canal.error(new FalloFotos(503));
            }
          },
          cancel() { detener(true); },
        }, { highWaterMark: 0 });
        c.comprobar();
        return Object.freeze({ claveObjeto: clave, solicitudCanonica: verificado, original });
      } catch {
        detener(true); throw new FalloFotos(503);
      }
    },
  });
}
