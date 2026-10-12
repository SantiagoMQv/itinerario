import type { Itinerario } from '../src/tipos';
import { camposFoto, esIdFoto } from '../src/fotos';
import { deserializarSolicitudRespaldo, serializarSolicitudRespaldo } from '../src/fotos-protocolo';
import { leerJsonListadoAcotado, type CursorListadoFotos, type PaginaListadoFotos } from '../src/fotos-listado-protocolo';
import { copiarPlanFotos, crearVigenciaFotos } from './multipart-fotos';
import { clavePrivadaFotos } from './almacen-fotos';
import type { EjecutorSql } from './contratos';

export interface PresupuestoListadoFotos {
  readonly maxFilas: number;
  readonly maxOperacionesPorFoto: number;
  readonly maxBytesSql: number;
  readonly maxBytesRespuesta: number;
  readonly maxBytesRetenidos: number;
  readonly plazoMs: number;
}
export interface CotasListadoFotos {
  readonly candidatas: number;
  readonly operacionesPreflight: number;
  readonly pruebas: number;
  readonly bytesSql: number;
  readonly bytesRespuesta: number;
  readonly bytesRetenidos: number;
}
export type ResultadoListadoFotos = { readonly tipo: 'pagina'; readonly pagina: PaginaListadoFotos; readonly textoCanonico: string }
  | { readonly tipo: 'sin-sesion' };
export interface RepositorioListadoFotos {
  listar(huella: string, viajeId: string, continuacion: string | null, signal: AbortSignal): Promise<ResultadoListadoFotos>;
}
const ERROR = 'No se pudo comprobar el listado de fotos.';
const fallar = (): never => { const e = new Error(ERROR); delete e.stack; throw e; };
const SQL = 'SELECT itinerario.listar_fotos_confirmadas($1, $2, $3, $4, $5, $6, $7) AS resultado';
const claves = ['maxFilas', 'maxOperacionesPorFoto', 'maxBytesSql', 'maxBytesRespuesta', 'maxBytesRetenidos', 'plazoMs'];
const M = 65536;
const C = 396490;
const codificador = new TextEncoder();
function entero(n: unknown, max = Number.MAX_SAFE_INTEGER): asserts n is number {
  if (typeof n !== 'number' || !Number.isSafeInteger(n) || n < 1 || n > max) return fallar();
}
function sumar(...valores: number[]): number {
  let total = 0;
  for (const n of valores) {
    if (!Number.isSafeInteger(n) || n < 0 || n > Number.MAX_SAFE_INTEGER - total) return fallar();
    total += n;
  }
  return total;
}
function multiplicar(a: number, b: number): number {
  if (!Number.isSafeInteger(a) || !Number.isSafeInteger(b) || a < 0 || b < 0
    || (b !== 0 && a > Math.floor(Number.MAX_SAFE_INTEGER / b))) return fallar();
  return a * b;
}
const q = (x: number): number => sumar(multiplicar(6, x), 2);
export function copiarPresupuestoListadoFotos(valor: unknown): PresupuestoListadoFotos {
  try {
    if (!camposFoto(valor, claves)) return fallar();
    for (const clave of claves) entero(valor[clave]);
    entero(valor.maxFilas, 8); entero(valor.maxOperacionesPorFoto, 64); entero(valor.plazoMs, 2147483647);
    return Object.freeze({ maxFilas: valor.maxFilas, maxOperacionesPorFoto: valor.maxOperacionesPorFoto,
      maxBytesSql: valor.maxBytesSql as number, maxBytesRespuesta: valor.maxBytesRespuesta as number,
      maxBytesRetenidos: valor.maxBytesRetenidos as number, plazoMs: valor.plazoMs });
  } catch { return fallar(); }
}
/** Modelo de referencias propias, no heap físico ni coste de scans/concurrencia.
 * 8S: texto SQL UTF16/UTF8, scanner y temporales; 4nC: consulta interior individual;
 * 32nM: INITIAL, clones de dominio y renders; 6P: página/texto/UTF8;
 * 1MiB: reserva lógica de estructuras <=4096 slots de 256B y scanner <=256 nodos.
 * No retenemos árboles interiores de todas las candidatas. Catálogo sólo en fábrica. */
export function calcularCotasListadoFotos(n: number, k: number): CotasListadoFotos {
  entero(n, 8); entero(k, 64); // Rangos antes de toda aritmética: no overflow válido oculto.
  const candidatas = sumar(n, 1);
  const c = sumar(256, q(36), q(466), q(M));
  const d = sumar(64, q(36), q(c));
  const bytesSql = sumar(4096, multiplicar(candidatas, sumar(d, 1)));
  const bytesRespuesta = sumar(4096, q(128), q(1024), multiplicar(n, sumar(q(M), 1)));
  const bytesRetenidos = sumar(multiplicar(8, bytesSql), multiplicar(4 * candidatas, c),
    multiplicar(32 * candidatas, M), multiplicar(6, bytesRespuesta), 1048576);
  return Object.freeze({ candidatas, operacionesPreflight: multiplicar(candidatas, sumar(k, 1)),
    pruebas: candidatas, bytesSql, bytesRespuesta, bytesRetenidos });
}
function textoUtf8(texto: unknown, limite: number): string {
  if (typeof texto !== 'string' || texto.length > limite) return fallar();
  const bytes = codificador.encode(texto);
  if (bytes.length > limite || new TextDecoder('utf-8', { fatal: true }).decode(bytes) !== texto) return fallar();
  return texto;
}
function arrayPropio(valor: unknown, max: number): readonly unknown[] {
  if (!Array.isArray(valor) || Object.getPrototypeOf(valor) !== Array.prototype) return fallar();
  const n: unknown = Object.getOwnPropertyDescriptor(valor, 'length')?.value;
  if (typeof n !== 'number' || !Number.isSafeInteger(n) || n < 0 || n > max
    || Reflect.ownKeys(valor).length !== n + 1) return fallar();
  for (let i = 0; i < n; i++) {
    const d = Object.getOwnPropertyDescriptor(valor, String(i));
    if (!d || !Object.hasOwn(d, 'value')) return fallar();
  }
  return valor;
}
function renderCursor(c: CursorListadoFotos): string {
  return '{"version":1,"viajeId":' + JSON.stringify(c.viajeId) + ',"despuesDe":' + JSON.stringify(c.despuesDe)
    + ',"hasta":' + JSON.stringify(c.hasta) + '}';
}
/** Una SELECT, cero IO en fábrica, sin retries, R2, ledger, sesión tocada o caché.
 * El timeout ignora entrega tardía; EjecutorSql NO cancela físicamente el statement. */
export function crearRepositorioListadoFotosSql(configuracion: {
  readonly plan: Itinerario; readonly ejecutor: EjecutorSql; readonly presupuesto: PresupuestoListadoFotos;
}): RepositorioListadoFotos {
  let plan: Itinerario;
  let presupuesto: PresupuestoListadoFotos;
  let cotas: CotasListadoFotos;
  let ejecutar: EjecutorSql['ejecutar'];
  try {
    if (!camposFoto(configuracion, ['plan', 'ejecutor', 'presupuesto'])) return fallar();
    plan = copiarPlanFotos(configuracion.plan); // Antes del presupuesto y del método original.
    textoUtf8(plan.id, 128);
    if (!plan.id || plan.id.includes('\0')) return fallar();
    presupuesto = copiarPresupuestoListadoFotos(configuracion.presupuesto);
    cotas = calcularCotasListadoFotos(presupuesto.maxFilas, presupuesto.maxOperacionesPorFoto);
    if (presupuesto.maxBytesSql < cotas.bytesSql || presupuesto.maxBytesRespuesta < cotas.bytesRespuesta
      || presupuesto.maxBytesRetenidos < cotas.bytesRetenidos) return fallar();
    const puerto = configuracion.ejecutor;
    if (!puerto || typeof puerto !== 'object') return fallar();
    const d = Object.getOwnPropertyDescriptor(puerto, 'ejecutar');
    if (!d || !Object.hasOwn(d, 'value') || typeof d.value !== 'function') return fallar();
    ejecutar = Function.prototype.bind.call(d.value, puerto) as EjecutorSql['ejecutar'];
  } catch { return fallar(); }
  function capturarCursor(texto: unknown): CursorListadoFotos | null {
    if (texto === null) return null;
    const v = leerJsonListadoAcotado(texto, 1024);
    if (!camposFoto(v, ['version', 'viajeId', 'despuesDe', 'hasta']) || v.version !== 1 || v.viajeId !== plan.id
      || !esIdFoto(v.despuesDe) || !esIdFoto(v.hasta) || !(v.despuesDe < v.hasta)) return fallar();
    const c = Object.freeze({ version: 1 as const, viajeId: plan.id, despuesDe: v.despuesDe, hasta: v.hasta });
    if (renderCursor(c) !== texto) return fallar();
    return c;
  }
  return Object.freeze({ async listar(huella: string, viajeId: string, continuacion: string | null,
    signal: AbortSignal): Promise<ResultadoListadoFotos> {
    let vigencia: ReturnType<typeof crearVigenciaFotos> | undefined;
    try {
      if (typeof huella !== 'string' || !/^[a-f0-9]{64}$/.test(huella) || viajeId !== plan.id) return fallar();
      const cursor = capturarCursor(continuacion);
      const parametros = Object.freeze([huella, viajeId, cursor?.despuesDe ?? null, cursor?.hasta ?? null,
        presupuesto.maxFilas, presupuesto.maxOperacionesPorFoto, cotas.bytesSql]);
      vigencia = crearVigenciaFotos(signal, presupuesto.plazoMs);
      vigencia.comprobar();
      const resultado: unknown = await vigencia.esperar(() => ejecutar(SQL, parametros), true);
      vigencia.comprobar();
      if (!camposFoto(resultado, ['filas'])) return fallar();
      const filas = arrayPropio(resultado.filas, 1);
      if (filas.length !== 1 || !camposFoto(filas[0], ['resultado'])) return fallar();
      const interno = leerJsonListadoAcotado(filas[0].resultado, cotas.bytesSql);
      if (camposFoto(interno, ['tipo']) && interno.tipo === 'sin-sesion') return Object.freeze({ tipo: 'sin-sesion' });
      if (!camposFoto(interno, ['tipo', 'hasta', 'candidatas']) || interno.tipo !== 'pagina'
        || (interno.hasta !== null && !esIdFoto(interno.hasta))
        || (cursor !== null && interno.hasta !== cursor.hasta)) return fallar();
      const candidatas = arrayPropio(interno.candidatas, cotas.candidatas);
      if (interno.hasta === null && candidatas.length !== 0) return fallar();
      let anterior: string | null = cursor?.despuesDe ?? null;
      const iniciales: string[] = [];
      let ultimaPublicada: string | null = null;
      for (let i = 0; i < candidatas.length; i++) {
        vigencia.comprobar();
        const candidata = candidatas[i];
        if (!camposFoto(candidata, ['fotoId', 'consultaCanonica']) || !esIdFoto(candidata.fotoId)
          || (anterior !== null && !(anterior < candidata.fotoId)) || interno.hasta === null
          || candidata.fotoId > interno.hasta) return fallar();
        const consulta = leerJsonListadoAcotado(candidata.consultaCanonica, C);
        if (!camposFoto(consulta, ['tipo', 'reserva']) || consulta.tipo !== 'confirmada'
          || !camposFoto(consulta.reserva, ['reservaId', 'claveObjeto', 'solicitudCanonica'])
          || !esIdFoto(consulta.reserva.reservaId) || typeof consulta.reserva.claveObjeto !== 'string') return fallar();
        const texto = textoUtf8(consulta.reserva.solicitudCanonica, M);
        const s = deserializarSolicitudRespaldo(plan, texto);
        if (serializarSolicitudRespaldo(plan, s) !== texto || s.fotoId !== candidata.fotoId
          || consulta.reserva.claveObjeto !== clavePrivadaFotos(plan.id, s.fotoId, consulta.reserva.reservaId)) return fallar();
        anterior = candidata.fotoId;
        if (i < presupuesto.maxFilas) { iniciales.push(texto); ultimaPublicada = candidata.fotoId; }
      }
      const siguiente = candidatas.length > presupuesto.maxFilas;
      if (siguiente && (ultimaPublicada === null || interno.hasta === null || !(ultimaPublicada < interno.hasta))) return fallar();
      const pagina: PaginaListadoFotos = Object.freeze({ version: 1, tipo: 'listado-respaldos', viajeId: plan.id,
        solicitudesIniciales: Object.freeze(iniciales), continuacion: siguiente ? renderCursor({ version: 1,
          viajeId: plan.id, despuesDe: ultimaPublicada!, hasta: interno.hasta as string }) : null });
      // Sólo escalares propios; evita clonar el catálogo por candidata/página.
      const textoCanonico = textoUtf8('{"version":1,"tipo":"listado-respaldos","viajeId":' + JSON.stringify(plan.id)
        + ',"solicitudesIniciales":[' + iniciales.map((s) => JSON.stringify(s)).join(',')
        + '],"continuacion":' + JSON.stringify(pagina.continuacion) + '}', cotas.bytesRespuesta);
      vigencia.comprobar();
      return Object.freeze({ tipo: 'pagina', pagina, textoCanonico });
    } catch { return fallar(); }
    finally { vigencia?.cerrar(); }
  } });
}
