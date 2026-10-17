import type { Itinerario } from './tipos';
import type { DestinoFoto } from './fotos';
import { copiarPlanFotos } from '../servidor/multipart-fotos';
import { deserializarSolicitudRespaldo } from './fotos-protocolo';
import { deserializarCursorListadoFotos, deserializarPaginaListadoFotos,
  deserializarCursorListadoFotosDestino, deserializarPaginaListadoFotosDestino,
  serializarDestinoListadoFotos, deserializarDestinoListadoFotos,
  MAX_BYTES_CURSOR_LISTADO_FOTOS_DESTINO, MAX_CARACTERES_QUERY_LISTADO_FOTOS_DESTINO,
  type PaginaListadoFotos, type PaginaListadoFotosDestino } from './fotos-listado-protocolo';

/** Admisión lógica explícita; no certifica RAM física, GC, costes ni concurrencia global. */
export interface PresupuestoListadoFotosCliente {
  readonly maxFilas: number;
  readonly maxBytesPagina: number;
  readonly maxBytesChunk: number;
  readonly maxBytesBackingChunk: number;
  readonly maxLecturas: number;
  readonly maxBytesPlan: number;
  readonly maxBytesRetenidos: number;
  readonly plazoMs: number;
}
export interface OpcionesListadoFotosCliente {
  readonly plan: Itinerario;
  /** Origen confiable de composición; en navegador, exactamente location.origin HTTPS. */
  readonly origen: string;
  readonly presupuesto: PresupuestoListadoFotosCliente;
  /** Puerto explícito para pruebas; null impide recurrir al fetch nativo. */
  readonly http?: { readonly fetch: typeof fetch } | null;
}
export type ResultadoListadoFotosCliente =
  | { readonly tipo: 'pagina'; readonly pagina: PaginaListadoFotos }
  | { readonly tipo: 'fallida'; readonly motivo:
      | 'sin-sesion' | 'argumentos-invalidos' | 'consulta-rechazada' | 'infraestructura'
      | 'respuesta-inesperada' | 'formato-invalido' | 'presupuesto-excedido' | 'ocupada' }
  | { readonly tipo: 'detenida'; readonly motivo: 'cancelada' | 'plazo' | 'cerrada' };
export type ResultadoListadoFotosDestinoCliente = Exclude<ResultadoListadoFotosCliente, { tipo: 'pagina' }>
  | { readonly tipo: 'pagina'; readonly pagina: PaginaListadoFotosDestino };
type ResultadoAccionListado = ResultadoListadoFotosCliente | ResultadoListadoFotosDestinoCliente;
export interface ListadoFotos {
  /** Una acción manual, una página de metadata; no descarga originales ni confirma ACK. */
  listar(continuacion: string | null): Promise<ResultadoListadoFotosCliente>;
  /** Comparte single-flight y cancelación con listar; para aislar una ficha, crear otra instancia.
   * Una página, sin autopaginación ni persistencia; cerrar descarta las entregas tardías. */
  listarDestino(destino: DestinoFoto, continuacion: string | null): Promise<ResultadoListadoFotosDestinoCliente>;
  cancelar(): void;
  cerrar(): void;
}
type MotivoFallo = Extract<ResultadoListadoFotosCliente, { tipo: 'fallida' }>['motivo'];
type MotivoDetencion = Extract<ResultadoListadoFotosCliente, { tipo: 'detenida' }>['motivo'];
const MENSAJE = 'No se puede preparar el listado de fotos.';
const HARD_PLAN = 4194304;
const M = 65536;
function invalidar(): never { throw new Error(MENSAJE); }
function sumar(a: number, b: number): number {
  if (!Number.isSafeInteger(a) || !Number.isSafeInteger(b) || a < 0 || b < 0
    || a > Number.MAX_SAFE_INTEGER - b) return invalidar();
  return a + b;
}
function multiplicar(a: number, b: number): number {
  if (!Number.isSafeInteger(a) || !Number.isSafeInteger(b) || a < 0 || b < 0
    || (b !== 0 && a > Math.floor(Number.MAX_SAFE_INTEGER / b))) return invalidar();
  return a * b;
}
/** Descriptores propios exactos: no getters, símbolos, campos extra ni valores heredados.
 * Las primitivas se capturan después; no copia otro catálogo completo. */
function datos(valor: unknown, obligatorias: readonly string[], opcionales: readonly string[] = []): Record<string, unknown> {
  if (typeof valor !== 'object' || valor === null) return invalidar();
  const p = Object.getPrototypeOf(valor);
  if (p !== Object.prototype && p !== null) return invalidar();
  const claves = Reflect.ownKeys(valor);
  if (claves.length < obligatorias.length || claves.length > obligatorias.length + opcionales.length
    || claves.some((k) => typeof k !== 'string' || ![...obligatorias, ...opcionales].includes(k))) return invalidar();
  const salida: Record<string, unknown> = Object.create(null);
  for (const clave of claves as string[]) {
    const d = Object.getOwnPropertyDescriptor(valor, clave);
    if (!d || !Object.hasOwn(d, 'value')) return invalidar();
    salida[clave] = d.value;
  }
  if (obligatorias.some((k) => !Object.hasOwn(salida, k))) return invalidar();
  return salida;
}
/** D cuenta cada aparición, incluidos aliases y length, ANTES del copier del dominio.
 * Cobra contenedor, claves/descriptores temporales y escalares. No evita todas las
 * asignaciones nativas de Reflect sobre una entrada enorme ni aísla traps de Proxy. */
function medirPlan(valor: unknown): number {
  let d = 0; let nodos = 0;
  const activos = new WeakSet<object>();
  function cobrar(n: number): void { d = sumar(d, n); if (d > HARD_PLAN) invalidar(); }
  function visitar(v: unknown, profundidad: number): void {
    if (profundidad > 32 || ++nodos > 16384) invalidar();
    if (v === null || v === undefined || typeof v === 'number' || typeof v === 'boolean') { cobrar(16); return; }
    if (typeof v === 'string') { cobrar(sumar(16, multiplicar(4, v.length))); return; }
    if (typeof v !== 'object') return invalidar();
    const array = Array.isArray(v); const p = Object.getPrototypeOf(v);
    if ((array ? p !== Array.prototype : p !== Object.prototype && p !== null) || activos.has(v)) invalidar();
    if (array) {
      const largo = Object.getOwnPropertyDescriptor(v, 'length');
      if (!largo || !Object.hasOwn(largo, 'value') || !Number.isSafeInteger(largo.value)
        || largo.value < 0 || largo.value > 16384) invalidar();
    }
    cobrar(256); activos.add(v);
    for (const clave of Reflect.ownKeys(v)) {
      if (typeof clave !== 'string') return invalidar();
      cobrar(sumar(256, multiplicar(4, clave.length)));
      const descriptor = Object.getOwnPropertyDescriptor(v, clave);
      if (!descriptor || !Object.hasOwn(descriptor, 'value')) return invalidar();
      visitar(descriptor.value, profundidad + 1);
    }
    activos.delete(v);
  }
  visitar(valor, 0); return d;
}
function presupuesto(entrada: unknown, d: number): { p: PresupuestoListadoFotosCliente; bytes: number; retenidos: number } {
  const claves = ['maxFilas', 'maxBytesPagina', 'maxBytesChunk', 'maxBytesBackingChunk',
    'maxLecturas', 'maxBytesPlan', 'maxBytesRetenidos', 'plazoMs'];
  const valores = datos(entrada, claves);
  for (const k of claves) if (typeof valores[k] !== 'number' || !Number.isSafeInteger(valores[k])
    || (valores[k] as number) < 1) invalidar();
  const p = Object.freeze(valores) as unknown as PresupuestoListadoFotosCliente;
  if (p.maxFilas > 8 || p.maxBytesChunk > HARD_PLAN || p.maxBytesBackingChunk > HARD_PLAN
    || p.maxBytesChunk > p.maxBytesBackingChunk || p.maxLecturas > 65536
    || p.maxBytesPlan > HARD_PLAN || p.maxBytesPlan < d || p.plazoMs > 2147483647) invalidar();
  const q = (x: number) => sumar(multiplicar(6, x), 2);
  const bytes = sumar(sumar(sumar(4096, q(128)), q(1024)), multiplicar(p.maxFilas, sumar(q(M), 1)));
  const r = sumar(sumar(sumar(sumar(multiplicar(16, bytes), multiplicar(multiplicar(32, p.maxFilas), M)),
    p.maxBytesBackingChunk), multiplicar(sumar(multiplicar(8, p.maxFilas), 16), d)), 1048576);
  if (p.maxBytesPagina < bytes || p.maxBytesRetenidos < r) invalidar();
  return { p, bytes, retenidos: r };
}
class Fallida extends Error { constructor(readonly motivo: MotivoFallo) { super('No se puede leer el listado.'); } }
const fallar = (motivo: MotivoFallo): never => { throw new Fallida(motivo); };
interface Accion {
  readonly controlador: AbortController;
  readonly fin: Promise<ResultadoAccionListado>;
  readonly publicar: (r: ResultadoAccionListado) => void;
  readonly inicio: number;
  ultimo: number;
  temporizador: ReturnType<typeof setTimeout> | null;
  detenida: MotivoDetencion | null;
  terminada: boolean;
  trabajoTerminado: boolean;
  externos: number;
  lector: ReadableStreamDefaultReader<Uint8Array> | null;
  leyendo: boolean;
  cancelando: boolean;
  liberado: boolean;
  url: string;
}
/** Una instancia, una acción explícita, cero IO de fábrica. Ningún import de PhotoDB,
 * ledger, colas o progreso local. R = 16P + 32NM + C + (8N+16)D + 1MiB:
 * decoder/encoder/scanner/render/DTO, INITIAL/validaciones, backing y copias de plan
 * por codecs/rango; sin asumir sharing gratuito ni liberación instantánea por GC. */
export function crearClienteListadoFotos(opciones: OpcionesListadoFotosCliente): ListadoFotos {
  const entrada = datos(opciones, ['plan', 'origen', 'presupuesto'], ['http']);
  const d = medirPlan(entrada.plan); // M1: hard cap independiente del presupuesto del operador.
  const plan = copiarPlanFotos(entrada.plan as Itinerario);
  const { p, bytes, retenidos } = presupuesto(entrada.presupuesto, d);
  if (typeof entrada.origen !== 'string') return invalidar();
  let origen: URL;
  try { origen = new URL(entrada.origen); } catch { return invalidar(); }
  if (origen.protocol !== 'https:' || origen.origin !== entrada.origen || origen.username || origen.password
    || origen.search || origen.hash || (typeof location !== 'undefined' && location.origin !== entrada.origen)) invalidar();
  const raiz = origen.origin + '/api/fotos/listado';
  const inyectado = Object.hasOwn(entrada, 'http') && entrada.http !== null;
  let enviar: typeof fetch | null;
  if (!Object.hasOwn(entrada, 'http')) {
    const metodo = globalThis.fetch;
    enviar = typeof metodo === 'function' ? metodo.bind(globalThis) : null;
  } else if (entrada.http === null) enviar = null;
  else {
    const puerto = datos(entrada.http, ['fetch']);
    if (typeof puerto.fetch !== 'function') return invalidar();
    enviar = (puerto.fetch as typeof fetch).bind(entrada.http);
  }
  // Reloj confiable capturado una vez; no hook público de tiempo. Date sólo es fallback.
  const rendimiento = globalThis.performance;
  const ahora = rendimiento && typeof rendimiento.now === 'function'
    ? rendimiento.now.bind(rendimiento) : Date.now.bind(Date);
  const getter = (prototipo: object, clave: string): ((this: unknown) => unknown) => {
    const g = Object.getOwnPropertyDescriptor(prototipo, clave)?.get;
    if (!g) return invalidar(); return g;
  };
  const respuestaUrl = getter(Response.prototype, 'url');
  const respuestaStatus = getter(Response.prototype, 'status');
  const respuestaTipo = getter(Response.prototype, 'type');
  const respuestaRedirect = getter(Response.prototype, 'redirected');
  const respuestaBody = getter(Response.prototype, 'body');
  const respuestaUsada = getter(Response.prototype, 'bodyUsed');
  const respuestaHeaders = getter(Response.prototype, 'headers');
  const streamLocked = getter(ReadableStream.prototype, 'locked');
  const obtenerLector = ReadableStream.prototype.getReader;
  const cancelarBody = ReadableStream.prototype.cancel;
  const leer = ReadableStreamDefaultReader.prototype.read;
  const cancelarLector = ReadableStreamDefaultReader.prototype.cancel;
  const liberarLector = ReadableStreamDefaultReader.prototype.releaseLock;
  const header = Headers.prototype.get;
  const tipoArray = Object.getPrototypeOf(Uint8Array.prototype) as object;
  const arrayBytes = getter(tipoArray, 'byteLength');
  const arrayOffset = getter(tipoArray, 'byteOffset');
  const arrayBacking = getter(tipoArray, 'buffer');
  const arrayTag = Object.getOwnPropertyDescriptor(tipoArray, Symbol.toStringTag)!.get!;
  const backingBytes = getter(ArrayBuffer.prototype, 'byteLength');
  let cerrada = false;
  let activa: Accion | null = null;
  function reloj(): number {
    const n = ahora();
    if (!Number.isFinite(n) || n < 0) return fallar('infraestructura');
    return n;
  }
  function comprobar(a: Accion): void {
    if (a.detenida || a.terminada) throw new Fallida('infraestructura');
    let n: number;
    try { n = reloj(); } catch { detener(a, 'plazo'); throw new Fallida('infraestructura'); }
    if (n < a.ultimo || n - a.inicio >= p.plazoMs) {
      detener(a, 'plazo'); throw new Fallida('infraestructura');
    }
    a.ultimo = n;
  }
  function soltar(a: Accion): void {
    if (a.lector && !a.leyendo && !a.liberado && a.terminada) {
      a.liberado = true;
      try { liberarLector.call(a.lector); } catch { /* Rechazo de cleanup no reemplaza el resultado neutral. */ }
    }
    if (a.trabajoTerminado && a.externos === 0 && activa === a) activa = null;
  }
  /** Reserva ownership ANTES de llamar código externo, incluso si arroja sin Promise. */
  function externo<T>(a: Accion, llamada: () => T | PromiseLike<T>): Promise<T> {
    a.externos++;
    let trabajo: Promise<T>;
    try { trabajo = Promise.resolve(llamada()); } catch (e) { trabajo = Promise.reject(e); }
    return trabajo.finally(() => { a.externos--; soltar(a); });
  }
  function cancelarReader(a: Accion): void {
    if (!a.lector || a.cancelando || a.liberado) return;
    a.cancelando = true;
    void externo(a, () => cancelarLector.call(a.lector!)).catch(() => {});
  }
  function terminar(a: Accion, r: ResultadoAccionListado): void {
    if (a.terminada) return;
    a.terminada = true;
    if (a.temporizador !== null) { clearTimeout(a.temporizador); a.temporizador = null; }
    a.publicar(r); soltar(a);
  }
  function detener(a: Accion, motivo: MotivoDetencion): void {
    if (a.terminada) return;
    a.detenida = motivo;
    try { a.controlador.abort(); } catch { /* No expone causas de puertos ajenos. */ }
    cancelarReader(a);
    terminar(a, { tipo: 'detenida', motivo });
  }
  /** Una entrega de fetch sólo transfiere body libre de la URL esperada.
   * No cancela un body ya usado/bloqueado, una URL ajena ni cierra el puerto HTTP. */
  function bodyPropio(a: Accion, r: Response): ReadableStream<Uint8Array> | null {
    try {
      const url = respuestaUrl.call(r);
      if (url !== a.url && !(inyectado && url === '')) return null;
      if (respuestaUsada.call(r)) return null;
      const body = respuestaBody.call(r) as ReadableStream<Uint8Array> | null;
      return body && !streamLocked.call(body) ? body : null;
    } catch { return null; }
  }
  function descartar(a: Accion, r: Response): void {
    const body = bodyPropio(a, r);
    if (body) void externo(a, () => cancelarBody.call(body)).catch(() => {});
  }
  function cabecera(headers: Headers, clave: string): string | null {
    const valor = header.call(headers, clave);
    if (valor !== null && valor.length > 256) return fallar('respuesta-inesperada');
    return valor;
  }
  function gate(a: Accion, r: Response, maxBytes: number): ReadableStream<Uint8Array> {
    // Intrínsecos de marca: un getter propio url/status/body/headers jamás es autoridad.
    const url = respuestaUrl.call(r); const tipo = respuestaTipo.call(r);
    if ((url !== a.url && !(inyectado && url === '')) || respuestaRedirect.call(r)
      || ['opaque', 'opaqueredirect', 'error'].includes(tipo as string)) return fallar('respuesta-inesperada');
    const status = respuestaStatus.call(r);
    if (status === 401) return fallar('sin-sesion');
    if (status === 400) return fallar('consulta-rechazada');
    if (status === 503) return fallar('infraestructura');
    if (status !== 200) return fallar('respuesta-inesperada');
    const h = respuestaHeaders.call(r) as Headers;
    const contenido = cabecera(h, 'Content-Type');
    const cache = cabecera(h, 'Cache-Control');
    const vary = cabecera(h, 'Vary');
    const pragma = cabecera(h, 'Pragma');
    const sniff = cabecera(h, 'X-Content-Type-Options');
    const longitud = cabecera(h, 'Content-Length');
    if (!contenido || !/^application\/json\s*;\s*charset=utf-8$/i.test(contenido.trim())
      || !cache || !vary || !pragma || sniff?.toLowerCase() !== 'nosniff') return fallar('respuesta-inesperada');
    const cc = cache.toLowerCase().split(',').map((v) => v.trim());
    if (cc.length !== 2 || !cc.includes('private') || !cc.includes('no-store')
      || vary.trim().toLowerCase() !== 'cookie' || pragma.trim().toLowerCase() !== 'no-cache') return fallar('respuesta-inesperada');
    if (longitud !== null && (!/^(?:0|[1-9][0-9]*)$/.test(longitud)
      || !Number.isSafeInteger(Number(longitud)) || Number(longitud) > maxBytes)) return fallar('presupuesto-excedido');
    const body = bodyPropio(a, r);
    if (!body) return fallar('respuesta-inesperada');
    return body;
  }
  function copiarChunk(chunk: unknown, destino: Uint8Array<ArrayBuffer>, offset: number): number {
    if (arrayTag.call(chunk) !== 'Uint8Array') return fallar('formato-invalido');
    const largo = arrayBytes.call(chunk) as number;
    const backing = arrayBacking.call(chunk) as ArrayBuffer;
    const capacidad = backingBytes.call(backing) as number; // SharedArrayBuffer no tiene esta marca.
    const inicio = arrayOffset.call(chunk) as number;
    if (largo > p.maxBytesChunk || capacidad > p.maxBytesBackingChunk || largo > destino.byteLength - offset) return fallar('presupuesto-excedido');
    // La vista nueva comprueba también detached; copia inmediata, sin guardar aliases upstream.
    const vista = new Uint8Array(backing, inicio, largo);
    destino.set(vista, offset); return largo;
  }
  async function ejecutar(a: Accion, continuacion: string | null, solicitado: DestinoFoto | null): Promise<void> {
    let respuesta: Response | null = null;
    try {
      comprobar(a);
      let cursor: ReturnType<typeof deserializarCursorListadoFotos> | null = null;
      let destino: DestinoFoto | null = null;
      let claveDestino: string | null = null;
      const bytesActuales = solicitado === null ? bytes : sumar(bytes, 12290);
      if (solicitado !== null && (p.maxBytesPagina < bytesActuales
        || p.maxBytesRetenidos < sumar(retenidos, 16 * 12290 + 65536))) return fallar('presupuesto-excedido');
      try {
        if (solicitado !== null) {
          claveDestino = serializarDestinoListadoFotos(plan, solicitado);
          destino = deserializarDestinoListadoFotos(plan, claveDestino);
          a.url = raiz + '?destino=' + encodeURIComponent(claveDestino);
        }
        if (continuacion !== null) {
          const maxCursor = destino === null ? 1024 : MAX_BYTES_CURSOR_LISTADO_FOTOS_DESTINO;
          if (typeof continuacion !== 'string' || continuacion.length > maxCursor) return fallar('argumentos-invalidos');
          if (destino === null) cursor = deserializarCursorListadoFotos(plan, continuacion);
          else {
            const c = deserializarCursorListadoFotosDestino(plan, continuacion);
            if (serializarDestinoListadoFotos(plan, c.destino) !== claveDestino) return fallar('argumentos-invalidos');
            cursor = c;
          }
          a.url += (destino === null ? '?' : '&') + 'continuacion=' + encodeURIComponent(continuacion);
        }
        if (a.url.length - raiz.length > (destino === null ? 3086 : MAX_CARACTERES_QUERY_LISTADO_FOTOS_DESTINO))
          return fallar('argumentos-invalidos');
      } catch { return fallar('argumentos-invalidos'); }
      comprobar(a);
      if (!enviar) return fallar('infraestructura');
      const request = new Request(a.url, { method: 'GET', credentials: 'same-origin', mode: 'same-origin',
        cache: 'no-store', redirect: 'error', headers: { Accept: 'application/json' }, signal: a.controlador.signal });
      comprobar(a);
      try { respuesta = await externo(a, () => enviar!(request)); }
      catch { return fallar('infraestructura'); }
      if (a.terminada) { descartar(a, respuesta); return; }
      comprobar(a);
      let body: ReadableStream<Uint8Array>;
      try { body = gate(a, respuesta, bytesActuales); } catch (e) { descartar(a, respuesta); respuesta = null; throw e; }
      comprobar(a);
      a.lector = obtenerLector.call(body) as ReadableStreamDefaultReader<Uint8Array>;
      respuesta = null; // Ownership pasa exclusivamente al lector; no hay segundo cancel del body.
      const buffer = new Uint8Array(bytesActuales); // P efectivo fijo, sólo después del gate HTTP.
      let offset = 0; let lecturas = 0;
      for (;;) {
        comprobar(a);
        if (lecturas >= p.maxLecturas) return fallar('presupuesto-excedido');
        lecturas++; a.leyendo = true;
        let r: ReadableStreamReadResult<Uint8Array>;
        try { r = await externo(a, () => leer.call(a.lector!)); }
        finally { a.leyendo = false; soltar(a); }
        comprobar(a);
        if (r.done) break;
        try { offset += copiarChunk(r.value, buffer, offset); }
        catch (e) { if (e instanceof Fallida) throw e; return fallar('formato-invalido'); }
        comprobar(a);
      }
      comprobar(a);
      let pagina: PaginaListadoFotos | PaginaListadoFotosDestino;
      try {
        // ignoreBOM=true conserva U+FEFF; el scanner lo rechaza en lugar de eliminarlo.
        const texto = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(buffer.subarray(0, offset));
        comprobar(a);
        pagina = destino === null ? deserializarPaginaListadoFotos(plan, texto, p.maxFilas, bytesActuales)
          : deserializarPaginaListadoFotosDestino(plan, texto, p.maxFilas, bytesActuales);
        if (pagina.tipo === 'listado-respaldos-destino'
          && serializarDestinoListadoFotos(plan, pagina.destino) !== claveDestino) return fallar('formato-invalido');
        comprobar(a);
        if (cursor) {
          for (const inicial of pagina.solicitudesIniciales) {
            const id = deserializarSolicitudRespaldo(plan, inicial).fotoId;
            if (!(id > cursor.despuesDe && id <= cursor.hasta)) return fallar('formato-invalido');
            comprobar(a);
          }
          if (pagina.continuacion !== null) {
            const siguiente = destino === null ? deserializarCursorListadoFotos(plan, pagina.continuacion)
              : deserializarCursorListadoFotosDestino(plan, pagina.continuacion);
            if (siguiente.hasta !== cursor.hasta) return fallar('formato-invalido');
          }
        }
      } catch (e) { if (e instanceof Fallida) throw e; return fallar('formato-invalido'); }
      comprobar(a); // Incluye decode, codec, copias de plan, rango y DTO congelado.
      if (pagina.tipo === 'listado-respaldos-destino') terminar(a, { tipo: 'pagina', pagina });
      else terminar(a, { tipo: 'pagina', pagina });
    } catch (e) {
      if (respuesta) descartar(a, respuesta);
      cancelarReader(a);
      if (!a.terminada) terminar(a, { tipo: 'fallida', motivo: e instanceof Fallida ? e.motivo : 'respuesta-inesperada' });
    } finally {
      a.trabajoTerminado = true; soltar(a);
    }
  }
  function iniciar(continuacion: string | null, destino: DestinoFoto | null): Promise<ResultadoAccionListado> {
      if (cerrada) return Promise.resolve({ tipo: 'detenida', motivo: 'cerrada' });
      if (activa) return Promise.resolve({ tipo: 'fallida', motivo: 'ocupada' });
      let inicio: number;
      try { inicio = reloj(); } catch { return Promise.resolve({ tipo: 'fallida', motivo: 'infraestructura' }); }
      let publicar!: (r: ResultadoAccionListado) => void;
      const fin = new Promise<ResultadoAccionListado>((ok) => { publicar = ok; });
      const a: Accion = { controlador: new AbortController(), fin, publicar, inicio, ultimo: inicio,
        temporizador: null, detenida: null, terminada: false, trabajoTerminado: false, externos: 0,
        lector: null, leyendo: false, cancelando: false, liberado: false, url: raiz };
      activa = a;
      a.temporizador = setTimeout(() => detener(a, 'plazo'), p.plazoMs);
      void ejecutar(a, continuacion, destino);
      return a.fin;
  }
  return Object.freeze({
    listar(continuacion: string | null): Promise<ResultadoListadoFotosCliente> {
      return iniciar(continuacion, null) as Promise<ResultadoListadoFotosCliente>;
    },
    listarDestino(destino: DestinoFoto, continuacion: string | null): Promise<ResultadoListadoFotosDestinoCliente> {
      if (destino === null || destino === undefined) return Promise.resolve({ tipo: 'fallida', motivo: 'argumentos-invalidos' });
      return iniciar(continuacion, destino) as Promise<ResultadoListadoFotosDestinoCliente>;
    },
    cancelar(): void { if (activa) detener(activa, 'cancelada'); },
    cerrar(): void { cerrada = true; if (activa) detener(activa, 'cerrada'); },
  });
}
