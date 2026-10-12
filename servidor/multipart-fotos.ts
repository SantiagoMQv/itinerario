import type { Itinerario } from '../src/tipos';
import { camposFoto } from '../src/fotos';
import { crearProgreso } from '../src/progreso';
import { deserializarSolicitudRespaldo, serializarReciboRespaldo,
  MAX_BYTES_JSON_RESPALDO, type SolicitudRespaldo } from '../src/fotos-protocolo';

/** Admisión local obligatoria; cero nunca significa ilimitado. No limita heap global,
 * CPU, GC, concurrencia, costes ni asignaciones previas del runtime o del adaptador. */
export interface PresupuestoFotos {
  readonly maxBytesOriginal: number;
  readonly maxBytesEntrada: number;
  readonly maxBytesChunk: number;
  readonly maxBytesCabeceras: number;
  readonly maxBytesRetenidos: number;
  readonly maxBloquesOriginal: number;
  readonly bytesBloque: number;
  readonly plazoMs: number;
}
const clavesPresupuesto = ['maxBytesOriginal', 'maxBytesEntrada', 'maxBytesChunk',
  'maxBytesCabeceras', 'maxBytesRetenidos', 'maxBloquesOriginal', 'bytesBloque', 'plazoMs'];

/** Los únicos fallos públicos propios de estas bibliotecas. Nunca transportar un error
 * del proveedor como FalloFotos: la frontera de puertos lo reemplaza por 503. */
export class FalloFotos extends Error {
  constructor(readonly codigo: 400 | 401 | 403 | 404 | 405 | 409 | 413 | 415 | 503) {
    super('No se pudo completar la solicitud de fotos.');
    this.name = 'FalloFotos';
  }
}
export function copiarPresupuestoFotos(valor: unknown): PresupuestoFotos {
  if (!camposFoto(valor, clavesPresupuesto)) throw new FalloFotos(503);
  for (const clave of clavesPresupuesto) {
    const n = valor[clave];
    if (typeof n !== 'number' || !Number.isSafeInteger(n) || n < 0) throw new FalloFotos(503);
  }
  if ((valor.bytesBloque as number) < 1 || (valor.bytesBloque as number) > 1048576
    || (valor.plazoMs as number) < 1 || (valor.plazoMs as number) > 2147483647) throw new FalloFotos(503);
  return Object.freeze(Object.fromEntries(clavesPresupuesto.map((c) => [c, valor[c]]))) as unknown as PresupuestoFotos;
}
/** Snapshot de los datos del Itinerario: registros, arrays y escalares, no objetos
 * ejecutables. No es un sandbox de Proxy ni de un realm alterado por código privilegiado.
 * Sólo se leen descriptores propios; jamás se clona o consulta el original con getters. */
export function copiarPlanFotos(plan: Itinerario): Itinerario {
  const activos = new WeakSet<object>();
  function copiar(valor: unknown): unknown {
    if (valor === null || valor === undefined || typeof valor === 'string'
      || typeof valor === 'number' || typeof valor === 'boolean') return valor;
    if (typeof valor !== 'object') throw new FalloFotos(503);
    const array = Array.isArray(valor);
    const prototipo = Object.getPrototypeOf(valor);
    if (array ? prototipo !== Array.prototype : prototipo !== Object.prototype && prototipo !== null) {
      throw new FalloFotos(503);
    }
    // Ciclos no pertenecen al plan. Un alias válido se copia otra vez por valor.
    if (activos.has(valor)) throw new FalloFotos(503);
    activos.add(valor);
    const descriptores = Object.getOwnPropertyDescriptors(valor);
    for (const clave of Reflect.ownKeys(descriptores)) {
      if (typeof clave !== 'string' || !Object.hasOwn(descriptores[clave], 'value')) throw new FalloFotos(503);
    }
    const copia = array ? [] : Object.create(null);
    for (const clave of Object.keys(descriptores)) {
      if (array && clave === 'length') continue;
      const descriptor = descriptores[clave];
      Object.defineProperty(copia, clave, { value: copiar(descriptor.value),
        enumerable: descriptor.enumerable, writable: true, configurable: true });
    }
    if (array) Object.defineProperty(copia, 'length', { value: descriptores.length.value });
    activos.delete(valor);
    return copia;
  }
  const copia = copiar(plan) as Itinerario;
  // El guard único del catálogo opera sólo sobre datos propios ya capturados, sin IO.
  crearProgreso(copia);
  return copia;
}

/** Una invocación, sin singleton ni IO modular. Cada continuación pasa por comprobar.
 * El timeout rechaza la espera, no deshace trabajo externo ya iniciado ni fuerza liberar
 * un Blob retenido por un puerto pendiente. No espera hooks cancel colgados. */
export interface VigenciaFotos {
  readonly signal: AbortSignal;
  comprobar(): void;
  esperar<T>(trabajo: () => Promise<T>, externo?: boolean): Promise<T>;
  cerrar(): void;
}
export function crearVigenciaFotos(signal: AbortSignal, plazoMs: number): VigenciaFotos {
  const controlador = new AbortController();
  let detenida = signal.aborted;
  let cerrada = false;
  const vence = Date.now() + plazoMs;
  let rechazar: (error: FalloFotos) => void = () => {};
  const fin = new Promise<never>((_, no) => { rechazar = no; });
  void fin.catch(() => {});
  const detener = () => {
    if (detenida || cerrada) return;
    detenida = true;
    controlador.abort();
    rechazar(new FalloFotos(503));
  };
  const temporizador = setTimeout(detener, plazoMs);
  signal.addEventListener('abort', detener, { once: true });
  const comprobar = () => {
    if (!cerrada && !detenida && Date.now() >= vence) detener();
    if (detenida || cerrada || signal.aborted) throw new FalloFotos(503);
  };
  return {
    signal: controlador.signal, comprobar,
    async esperar<T>(trabajo: () => Promise<T>, externo = false): Promise<T> {
      comprobar();
      try {
        const valor = await Promise.race([trabajo(), fin]);
        comprobar();
        return valor;
      } catch (e) {
        comprobar();
        if (!externo && e instanceof FalloFotos) throw e;
        throw new FalloFotos(503);
      }
    },
    cerrar() {
      cerrada = true;
      clearTimeout(temporizador);
      signal.removeEventListener('abort', detener);
    },
  };
}

function sumaSegura(...valores: number[]): number {
  let suma = 0;
  for (const n of valores) {
    if (!Number.isSafeInteger(n) || n < 0 || n > Number.MAX_SAFE_INTEGER - suma) throw new FalloFotos(413);
    suma += n;
  }
  return suma;
}
/** Cuenta dos representaciones completas con capacidad de bloques, chunk upstream,
 * dos buffers de comparación, framing/cabeceras y ocho representaciones máximas JSON.
 * Es una admisión conservadora de referencias propias, NO medición del heap del proceso. */
export function bytesRetenidosFotos(bytes: number, p: PresupuestoFotos): number {
  const bloques = Math.ceil(bytes / p.bytesBloque);
  if (!Number.isSafeInteger(bloques) || bloques > p.maxBloquesOriginal || bytes > p.maxBytesOriginal) throw new FalloFotos(413);
  const capacidad = bloques * p.bytesBloque;
  return sumaSegura(capacidad, capacidad, p.maxBytesChunk, p.bytesBloque, p.bytesBloque,
    p.maxBytesCabeceras * 8, MAX_BYTES_JSON_RESPALDO * 8, 512);
}
export function admitirOriginalFotos(bytes: number, p: PresupuestoFotos): void {
  if (!Number.isSafeInteger(bytes) || bytes < 0 || bytesRetenidosFotos(bytes, p) > p.maxBytesRetenidos) throw new FalloFotos(413);
}
function boundaryFotos(tipo: string | null, p: PresupuestoFotos): string {
  if (tipo === null) throw new FalloFotos(415);
  // Acotar antes de regex, copia o decodificación. No escapes, espacios en boundary ni parámetros extras.
  if (tipo.length > p.maxBytesCabeceras) throw new FalloFotos(413);
  const m = /^multipart\/form-data;[ \t]*boundary=(?:([!#$%&'*+.^_`|~0-9A-Za-z-]{1,70})|"([-0-9A-Za-z'()+_,./:=?]{1,70})")$/i.exec(tipo);
  if (!m) throw new FalloFotos(415);
  return m[1] ?? m[2];
}

/** Copia en bloques propios fijos, nunca un bloque por cada chunk diminuto del cliente.
 * El Blob nativo se crea únicamente después del framing completo y EOF. */
export class CapturadorOriginalFotos {
  private bloques: Uint8Array<ArrayBuffer>[] = [];
  private actual: Uint8Array<ArrayBuffer> | null = null;
  private usados = 0;
  private total = 0;
  constructor(private readonly esperado: number, private readonly p: PresupuestoFotos) {
    admitirOriginalFotos(esperado, p);
  }
  agregar(byte: number): void {
    if (this.total >= this.esperado) throw new FalloFotos(400);
    if (!this.actual || this.usados === this.actual.length) {
      if (this.bloques.length >= this.p.maxBloquesOriginal) throw new FalloFotos(413);
      this.actual = new Uint8Array(Math.min(this.p.bytesBloque, this.esperado - this.total));
      this.bloques.push(this.actual);
      this.usados = 0;
    }
    this.actual[this.usados++] = byte;
    this.total++;
  }
  terminar(): Blob {
    if (this.total !== this.esperado) throw new FalloFotos(400);
    try { return new Blob(this.bloques, { type: 'application/octet-stream' }); }
    finally { this.liberar(); }
  }
  liberar(): void { this.bloques = []; this.actual = null; this.usados = 0; }
}

export interface CapturaMultipartFotos {
  readonly solicitud: SolicitudRespaldo;
  readonly original: Blob;
}

/** Perfil estricto del FormData real de fotos-transporte. No formData(), tee(), text()
 * ni arrayBuffer() integral. Sin preámbulo, epílogo, campos adicionales ni Content-Length.
 * El MIME wrapper no se compara con mimeDeclarado raw guardado exclusivamente en JSON. */
export async function leerMultipartFotos(plan: Itinerario, solicitud: Request,
  presupuesto: PresupuestoFotos, vigencia: VigenciaFotos): Promise<CapturaMultipartFotos> {
  const p = copiarPresupuestoFotos(presupuesto);
  const planFijo = copiarPlanFotos(plan);
  const boundary = boundaryFotos(solicitud.headers.get('Content-Type'), p);
  admitirOriginalFotos(0, p);
  if (!solicitud.body) throw new FalloFotos(400);
  let lector: ReadableStreamDefaultReader<Uint8Array>;
  try { lector = solicitud.body.getReader(); } catch { throw new FalloFotos(400); }
  let chunk: Uint8Array | null = null;
  let posicion = 0;
  let entrada = 0;
  let cabeceras = 0;
  let completa = false;
  let capturador: CapturadorOriginalFotos | null = null;
  const cancelar = () => { try { void lector.cancel().catch(() => {}); } catch { /* Sin espera externa. */ } };
  vigencia.signal.addEventListener('abort', cancelar, { once: true });
  async function byte(): Promise<number | null> {
    vigencia.comprobar();
    while (!chunk || posicion === chunk.byteLength) {
      chunk = null;
      posicion = 0;
      const lectura = await vigencia.esperar(() => lector.read());
      if (lectura.done) return null;
      if (!(lectura.value instanceof Uint8Array)) throw new FalloFotos(400);
      const n = lectura.value.byteLength;
      if (n > p.maxBytesChunk || n > p.maxBytesEntrada - entrada) throw new FalloFotos(413);
      entrada += n;
      chunk = lectura.value;
    }
    return chunk[posicion++];
  }
  async function exacto(texto: string): Promise<void> {
    for (const c of texto) if (await byte() !== c.charCodeAt(0)) throw new FalloFotos(400);
  }
  async function headers(original: boolean): Promise<void> {
    const datos: number[] = [];
    for (;;) {
      const b = await byte();
      if (b === null) throw new FalloFotos(400);
      if (++cabeceras > p.maxBytesCabeceras) throw new FalloFotos(413);
      if (b > 127 || b === 0) throw new FalloFotos(400);
      datos.push(b);
      const n = datos.length;
      if (n >= 4 && datos[n - 4] === 13 && datos[n - 3] === 10 && datos[n - 2] === 13 && b === 10) break;
    }
    // Se acotaron TODOS los bytes antes de producir texto. Perfil de parámetros inequívoco.
    const texto = datos.map((b) => String.fromCharCode(b)).join('');
    const lineas = texto.slice(0, -4).split('\r\n');
    const esperadas = original ? [
      ['content-disposition', 'form-data; name="original"; filename="original"'],
      ['content-type', 'application/octet-stream'],
    ] : [['content-disposition', 'form-data; name="solicitud"']];
    if (lineas.length !== esperadas.length || lineas.some((linea, i) => {
      const separador = linea.indexOf(': ');
      return separador < 0 || linea.slice(0, separador).toLowerCase() !== esperadas[i][0]
        || linea.slice(separador + 2) !== esperadas[i][1];
    })) throw new FalloFotos(400);
  }
  // Ventana de boundary+dos bytes. Un prefijo con sufijo inválido vuelve a payload sin pérdida.
  async function parte(emitir: (b: number) => void): Promise<'siguiente' | 'cierre'> {
    const marca = Array.from(`\r\n--${boundary}`, (c) => c.charCodeAt(0));
    const ventana: number[] = [];
    for (;;) {
      const b = await byte();
      if (b === null) throw new FalloFotos(400);
      ventana.push(b);
      while (ventana.length && !ventana.every((v, i) => i >= marca.length || v === marca[i])) emitir(ventana.shift()!);
      if (ventana.length === marca.length + 2) {
        const a = ventana[marca.length]; const z = ventana[marca.length + 1];
        if (a === 13 && z === 10) return 'siguiente';
        if (a === 45 && z === 45) return 'cierre';
        // Reexaminar desde el segundo byte para detectar también prefijos solapados.
        emitir(ventana.shift()!);
        while (ventana.length && !ventana.every((v, i) => i >= marca.length || v === marca[i])) emitir(ventana.shift()!);
      }
    }
  }
  try {
    await exacto(`--${boundary}\r\n`);
    await headers(false);
    const metadata = new Uint8Array(MAX_BYTES_JSON_RESPALDO);
    let cantidad = 0;
    const separador = await parte((b) => {
      if (cantidad === metadata.length) throw new FalloFotos(413);
      metadata[cantidad++] = b;
    });
    if (separador !== 'siguiente') throw new FalloFotos(400);
    let ref: SolicitudRespaldo;
    try {
      const texto = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(metadata.subarray(0, cantidad));
      ref = deserializarSolicitudRespaldo(planFijo, texto);
    } catch { throw new FalloFotos(400); }
    // Solo validación de sintaxis/tamaño potencial; estos true NO conceden una prueba ni ACK.
    try { serializarReciboRespaldo(planFijo, { ...ref, tipo: 'acuse-respaldo',
      objetoOriginalDurable: true, metadatosDurables: true }); } catch { throw new FalloFotos(413); }
    admitirOriginalFotos(ref.original.bytesOriginal, p);
    Object.freeze(ref.original.destino); Object.freeze(ref.original); Object.freeze(ref);
    await headers(true);
    capturador = new CapturadorOriginalFotos(ref.original.bytesOriginal, p);
    if (await parte((b) => capturador!.agregar(b)) !== 'cierre') throw new FalloFotos(400);
    const final = await byte();
    if (final !== null) {
      if (final !== 13 || await byte() !== 10 || await byte() !== null) throw new FalloFotos(400);
    }
    vigencia.comprobar();
    const original = capturador.terminar();
    completa = true;
    return Object.freeze({ solicitud: ref, original });
  } finally {
    vigencia.signal.removeEventListener('abort', cancelar);
    if (!completa) cancelar();
    chunk = null;
    capturador?.liberar();
    try { lector.releaseLock(); } catch { /* No ocultar fallo original. */ }
  }
}
