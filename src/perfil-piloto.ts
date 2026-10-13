import type { PresupuestoFotos } from '../servidor/multipart-fotos';
import type { PresupuestoListadoFotos } from '../servidor/repositorio-listado-fotos';
import type { PresupuestoListadoFotosCliente } from './fotos-listado';
import type { ComposicionRespaldoFotos } from './fotos-respaldo-interfaz';
import type { ComposicionPortabilidad } from './portabilidad-interfaz';

/** Sólo políticas explícitas no secretas. No acepta puertos, bindings ni credenciales. */
export interface DatosPerfilPiloto {
  readonly origen: string;
  /** Declaración del llamador, no consulta ni garantía del proveedor o de su cuenta. */
  readonly maxBytesCuerpoProveedor: number;
  readonly respaldoServidor: PresupuestoFotos;
  readonly listadoServidor: PresupuestoListadoFotos;
  readonly listadoCliente: PresupuestoListadoFotosCliente;
  readonly portabilidad: ComposicionPortabilidad;
}
export interface PerfilPiloto extends Omit<DatosPerfilPiloto, 'listadoCliente'> {
  readonly respaldo: ComposicionRespaldoFotos & { readonly maxBytesOriginal: number };
}
const fallar = (): never => { throw new Error('Perfil del piloto inválido.'); };

/** Esquemas fijos por descriptores propios; no invoca getters. No aísla Proxy ni otro realm. */
function datos(valor: unknown, claves: readonly string[]): Record<string, unknown> {
  if (!valor || typeof valor !== 'object') return fallar();
  const proto = Object.getPrototypeOf(valor);
  if (proto !== Object.prototype && proto !== null) return fallar();
  const propias = Reflect.ownKeys(valor);
  if (propias.length !== claves.length || propias.some((k) => typeof k !== 'string' || !claves.includes(k))) return fallar();
  const copia: Record<string, unknown> = Object.create(null);
  for (const clave of claves) {
    const descriptor = Object.getOwnPropertyDescriptor(valor, clave);
    if (!descriptor || !Object.hasOwn(descriptor, 'value') || !descriptor.enumerable) return fallar();
    copia[clave] = descriptor.value;
  }
  return copia;
}
function numero(valor: unknown, minimo = 0, maximo = Number.MAX_SAFE_INTEGER): number {
  if (typeof valor !== 'number' || !Number.isSafeInteger(valor) || valor < minimo || valor > maximo) return fallar();
  return valor;
}
function presupuesto(valor: unknown, claves: readonly string[], minimo: number): Readonly<Record<string, number>> {
  const copia = datos(valor, claves);
  const salida: Record<string, number> = {};
  for (const clave of claves) salida[clave] = numero(copia[clave], minimo);
  return Object.freeze(salida);
}
function sumar(...valores: number[]): number {
  let total = 0;
  for (const n of valores) {
    if (n > Number.MAX_SAFE_INTEGER - total) return fallar();
    total += n;
  }
  return total;
}
function multiplicar(a: number, b: number): number {
  if (b !== 0 && a > Math.floor(Number.MAX_SAFE_INTEGER / b)) return fallar();
  return a * b;
}
const q = (n: number) => sumar(multiplicar(6, n), 2);

/** Constructor/validador síncrono: únicamente captura datos y devuelve snapshots congelados.
 * No activa composiciones ni hace IO. El plan real se valida después en sus fábricas:
 * este perfil no certifica RAM, CPU, almacenamiento total, costes, autenticación ni móviles. */
export function crearPerfilPiloto(entrada: unknown): PerfilPiloto {
  const d = datos(entrada, ['origen', 'maxBytesCuerpoProveedor', 'respaldoServidor',
    'listadoServidor', 'listadoCliente', 'portabilidad']);
  const origen = d.origen;
  if (typeof origen !== 'string') return fallar();
  let url: URL;
  try { url = new URL(origen); } catch { return fallar(); }
  if (url.protocol !== 'https:' || url.origin !== origen || url.username || url.password || url.search || url.hash) return fallar();
  const maxBytesCuerpoProveedor = numero(d.maxBytesCuerpoProveedor, 1);
  const fotos = presupuesto(d.respaldoServidor, ['maxBytesOriginal', 'maxBytesEntrada', 'maxBytesChunk',
    'maxBytesCabeceras', 'maxBytesRetenidos', 'maxBloquesOriginal', 'bytesBloque', 'plazoMs'], 0);
  numero(fotos.bytesBloque, 1, 1048576);
  numero(fotos.plazoMs, 1, 2147483647);
  // HTTP multipart: B + JSON (64 KiB) + cabeceras TOTALES + tres boundaries <=70 y CRLF.
  // El objeto R2 usa OTRO encuadre: 12 + N + B, N<=65536; no mide el cuerpo HTTP.
  const cuerpoHttp = sumar(fotos.maxBytesOriginal, 65536, fotos.maxBytesCabeceras, 228);
  const objetoR2 = sumar(12, 65536, fotos.maxBytesOriginal);
  if (cuerpoHttp > fotos.maxBytesEntrada || fotos.maxBytesEntrada >= maxBytesCuerpoProveedor
    || objetoR2 > 5 * 1024 ** 3 || objetoR2 > fotos.maxBytesEntrada) return fallar();

  const servidor = presupuesto(d.listadoServidor, ['maxFilas', 'maxOperacionesPorFoto', 'maxBytesSql',
    'maxBytesRespuesta', 'maxBytesRetenidos', 'plazoMs'], 1);
  numero(servidor.maxFilas, 1, 8);
  numero(servidor.maxOperacionesPorFoto, 1, 64);
  numero(servidor.plazoMs, 1, 2147483647);
  // Cotas normativas de E1 y su frontera HTTP; K limita operaciones, no estos bytes.
  const n = servidor.maxFilas;
  const candidatas = n + 1;
  const c = sumar(256, q(36), q(466), q(65536));
  const sql = sumar(4096, multiplicar(candidatas, sumar(64, q(36), q(c), 1)));
  const pagina = sumar(4096, q(128), q(1024), multiplicar(n, sumar(q(65536), 1)));
  const retenidos = sumar(multiplicar(8, sql), multiplicar(4 * candidatas, c),
    multiplicar(32 * candidatas, 65536), multiplicar(12, pagina), 1048576, 65536);
  if (servidor.maxBytesSql < sql || servidor.maxBytesRespuesta < pagina || servidor.maxBytesRetenidos < retenidos) return fallar();

  const cliente = presupuesto(d.listadoCliente, ['maxFilas', 'maxBytesPagina', 'maxBytesChunk',
    'maxBytesBackingChunk', 'maxLecturas', 'maxBytesPlan', 'maxBytesRetenidos', 'plazoMs'], 1);
  numero(cliente.maxFilas, 1, 8);
  numero(cliente.maxBytesChunk, 1, 4194304);
  numero(cliente.maxBytesBackingChunk, 1, 4194304);
  numero(cliente.maxLecturas, 1, 65536);
  numero(cliente.maxBytesPlan, 1, 4194304);
  numero(cliente.plazoMs, 1, 2147483647);
  if (cliente.maxFilas !== n || cliente.maxBytesChunk > cliente.maxBytesBackingChunk
    || cliente.maxBytesPagina < pagina) return fallar();
  // Sólo el mínimo independiente de D: la fábrica cliente cobra después el plan REAL.
  const minimoCliente = sumar(multiplicar(16, pagina), multiplicar(32 * n, 65536),
    cliente.maxBytesBackingChunk, 1048576);
  if (cliente.maxBytesRetenidos < minimoCliente) return fallar();

  const portable = datos(d.portabilidad, ['limites', 'limitesHistoria']);
  const limites = presupuesto(portable.limites, ['maxRegistros', 'maxBytesMetadatos',
    'maxBytesArchivo', 'maxProfundidad'], 0);
  numero(limites.maxProfundidad, 1, 256);
  const limitesHistoria = presupuesto(portable.limitesHistoria, ['maxImportaciones', 'maxObservaciones',
    'maxProcedencias', 'maxBytesHistoria'], 0);
  // Sólo conversiones de snapshots de campos fijos ya comprobados, nunca del original.
  const respaldoServidor = fotos as unknown as PresupuestoFotos;
  const listadoServidor = servidor as unknown as PresupuestoListadoFotos;
  const listado = cliente as unknown as PresupuestoListadoFotosCliente;
  const portabilidad = Object.freeze({ limites, limitesHistoria }) as unknown as ComposicionPortabilidad;
  return Object.freeze({ origen, maxBytesCuerpoProveedor, respaldoServidor, listadoServidor, portabilidad,
    respaldo: Object.freeze({ origen, listado, maxBytesOriginal: respaldoServidor.maxBytesOriginal }) });
}
