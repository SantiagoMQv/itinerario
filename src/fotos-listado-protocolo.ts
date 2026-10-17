import type { Itinerario } from './tipos';
import { camposFoto, esIdFoto, esDestinoFoto, type DestinoFoto } from './fotos';
import { deserializarSolicitudRespaldo, serializarSolicitudRespaldo } from './fotos-protocolo';
import { copiarPlanFotos } from '../servidor/multipart-fotos';

export const MAX_FILAS_LISTADO_FOTOS = 8;
export const MAX_BYTES_CURSOR_LISTADO_FOTOS = 1024;
export const MAX_PROFUNDIDAD_JSON_LISTADO_FOTOS = 16;
export const MAX_NODOS_JSON_LISTADO_FOTOS = 256;
/** Cotas adicionales independientes del cursor global anterior. */
export const MAX_BYTES_DESTINO_LISTADO_FOTOS = 1024;
export const MAX_BYTES_CURSOR_LISTADO_FOTOS_DESTINO = 2048;
export const MAX_CARACTERES_QUERY_LISTADO_FOTOS_DESTINO = 9240;
export interface CursorListadoFotosDestino extends CursorListadoFotos {
  readonly tipo: 'cursor-respaldos-destino';
  readonly destino: DestinoFoto;
}
export interface PaginaListadoFotosDestino extends Omit<PaginaListadoFotos, 'tipo'> {
  readonly tipo: 'listado-respaldos-destino';
  readonly destino: DestinoFoto;
}
/** Posición unsigned, no autorización ni snapshot: cada página requiere sesión viva. */
export interface CursorListadoFotos {
  readonly version: 1;
  readonly viajeId: string;
  readonly despuesDe: string;
  readonly hasta: string;
}
/** Sólo INITIAL canónicos. Leer/importar una página nunca confirma el ledger local. */
export interface PaginaListadoFotos {
  readonly version: 1;
  readonly tipo: 'listado-respaldos';
  readonly viajeId: string;
  readonly solicitudesIniciales: readonly string[];
  readonly continuacion: string | null;
}
const fallar = (): never => { throw new Error('Listado de fotos inválido'); };
const codificador = new TextEncoder();
function positivo(n: number): void {
  if (!Number.isSafeInteger(n) || n < 1) fallar();
}
function acotar(texto: unknown, maxBytes: number): string {
  positivo(maxBytes);
  if (typeof texto !== 'string' || texto.length > maxBytes) return fallar();
  const bytes = codificador.encode(texto);
  if (bytes.length > maxBytes || new TextDecoder('utf-8', { fatal: true }).decode(bytes) !== texto) return fallar();
  return texto;
}
function viaje(plan: Itinerario, valor: unknown): string {
  if (typeof valor !== 'string' || valor !== plan.id || !valor || valor.includes('\0')) return fallar();
  return acotar(valor, 128);
}
/** Scanner compartido, previo al parse nativo. No valida dominio ni recibos SQL.
 * Nodos = valores JSON (incluido raíz); profundidad de raíz = 0. Claves escapadas
 * equivalentes se comparan decodificadas. No se modifica el scanner del codec previo. */
export function leerJsonListadoAcotado(texto: unknown, maxBytes: number): unknown {
  const fuente = acotar(texto, maxBytes);
  let posicion = 0;
  let nodos = 0;
  const numero = /-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/y;
  function blancos(): void {
    while (' \t\r\n'.includes(fuente[posicion] ?? '\0')) posicion++;
  }
  function cadena(clave = false): string {
    const inicio = posicion;
    if (fuente[posicion++] !== '"') return fallar();
    while (posicion < fuente.length) {
      const c = fuente[posicion++];
      if (c === '"') return clave ? JSON.parse(fuente.slice(inicio, posicion)) as string : '';
      if (c === '\\') {
        const escape = fuente[posicion++];
        if (escape === 'u') {
          for (let i = 0; i < 4; i++) if (!/^[0-9a-fA-F]$/.test(fuente[posicion++] ?? '')) return fallar();
        } else if (!'"\\/bfnrt'.includes(escape ?? '\0')) return fallar();
      } else if (c.charCodeAt(0) < 32) return fallar();
    }
    return fallar();
  }
  function valor(profundidad: number): void {
    if (profundidad > MAX_PROFUNDIDAD_JSON_LISTADO_FOTOS || ++nodos > MAX_NODOS_JSON_LISTADO_FOTOS) fallar();
    blancos();
    const c = fuente[posicion];
    if (c === '"') { cadena(); return; }
    if (c === '{' || c === '[') {
      posicion++; blancos();
      const fin = c === '{' ? '}' : ']';
      const claves = new Set<string>();
      if (fuente[posicion] === fin) { posicion++; return; }
      for (;;) {
        if (c === '{') {
          blancos(); const nombre = cadena(true);
          if (claves.has(nombre)) return fallar();
          claves.add(nombre); blancos();
          if (fuente[posicion++] !== ':') return fallar();
        }
        valor(profundidad + 1); blancos();
        const separador = fuente[posicion++];
        if (separador === fin) return;
        if (separador !== ',') return fallar();
      }
    }
    for (const literal of ['true', 'false', 'null']) {
      if (fuente.startsWith(literal, posicion)) { posicion += literal.length; return; }
    }
    numero.lastIndex = posicion;
    if (!numero.exec(fuente)) return fallar();
    posicion = numero.lastIndex;
  }
  valor(0); blancos();
  if (posicion !== fuente.length) return fallar();
  return JSON.parse(fuente) as unknown;
}
function cursor(plan: Itinerario, valor: unknown): CursorListadoFotos {
  if (!camposFoto(valor, ['version', 'viajeId', 'despuesDe', 'hasta']) || valor.version !== 1
    || !esIdFoto(valor.despuesDe) || !esIdFoto(valor.hasta) || !(valor.despuesDe < valor.hasta)) return fallar();
  return Object.freeze({ version: 1, viajeId: viaje(plan, valor.viajeId), despuesDe: valor.despuesDe, hasta: valor.hasta });
}
function renderCursor(c: CursorListadoFotos): string {
  return '{"version":1,"viajeId":' + JSON.stringify(c.viajeId) + ',"despuesDe":' + JSON.stringify(c.despuesDe)
    + ',"hasta":' + JSON.stringify(c.hasta) + '}';
}
export function copiarCursorListadoFotos(plan: Itinerario, valor: unknown): CursorListadoFotos {
  return cursor(copiarPlanFotos(plan), valor);
}
export function serializarCursorListadoFotos(plan: Itinerario, valor: unknown): string {
  return acotar(renderCursor(cursor(copiarPlanFotos(plan), valor)), MAX_BYTES_CURSOR_LISTADO_FOTOS);
}
function leerCursor(plan: Itinerario, texto: unknown): CursorListadoFotos {
  const c = cursor(plan, leerJsonListadoAcotado(texto, MAX_BYTES_CURSOR_LISTADO_FOTOS));
  if (renderCursor(c) !== texto) return fallar();
  return c;
}
export function deserializarCursorListadoFotos(plan: Itinerario, texto: unknown): CursorListadoFotos {
  return leerCursor(copiarPlanFotos(plan), texto);
}
function pagina(plan: Itinerario, valor: unknown, maxFilas: number): PaginaListadoFotos {
  positivo(maxFilas);
  if (maxFilas > MAX_FILAS_LISTADO_FOTOS || !camposFoto(valor,
    ['version', 'tipo', 'viajeId', 'solicitudesIniciales', 'continuacion'])
    || valor.version !== 1 || valor.tipo !== 'listado-respaldos') return fallar();
  const viajeId = viaje(plan, valor.viajeId);
  const array = valor.solicitudesIniciales;
  if (!Array.isArray(array) || Object.getPrototypeOf(array) !== Array.prototype) return fallar();
  const n: unknown = Object.getOwnPropertyDescriptor(array, 'length')?.value;
  if (typeof n !== 'number' || !Number.isSafeInteger(n) || n < 0 || n > maxFilas
    || Reflect.ownKeys(array).length !== n + 1) return fallar();
  const c = valor.continuacion === null ? null : leerCursor(plan, valor.continuacion);
  const solicitudes: string[] = [];
  let anterior: string | null = null;
  for (let i = 0; i < n; i++) {
    const d = Object.getOwnPropertyDescriptor(array, String(i));
    if (!d || !Object.hasOwn(d, 'value') || typeof d.value !== 'string') return fallar();
    const texto = d.value;
    const s = deserializarSolicitudRespaldo(plan, texto);
    if (serializarSolicitudRespaldo(plan, s) !== texto || (anterior !== null && !(anterior < s.fotoId))
      || (c !== null && s.fotoId > c.hasta)) return fallar();
    anterior = s.fotoId; solicitudes.push(texto);
  }
  if (c !== null && (n === 0 || c.viajeId !== viajeId || c.despuesDe !== anterior)) return fallar();
  return Object.freeze({ version: 1, tipo: 'listado-respaldos', viajeId,
    solicitudesIniciales: Object.freeze(solicitudes), continuacion: valor.continuacion as string | null });
}
function renderPagina(p: PaginaListadoFotos): string {
  return '{"version":1,"tipo":"listado-respaldos","viajeId":' + JSON.stringify(p.viajeId)
    + ',"solicitudesIniciales":[' + p.solicitudesIniciales.map((s) => JSON.stringify(s)).join(',')
    + '],"continuacion":' + (p.continuacion === null ? 'null' : JSON.stringify(p.continuacion)) + '}';
}
export function copiarPaginaListadoFotos(plan: Itinerario, valor: unknown, maxFilas: number): PaginaListadoFotos {
  return pagina(copiarPlanFotos(plan), valor, maxFilas);
}
export function serializarPaginaListadoFotos(plan: Itinerario, valor: unknown, maxFilas: number, maxBytes: number): string {
  return acotar(renderPagina(pagina(copiarPlanFotos(plan), valor, maxFilas)), maxBytes);
}
export function deserializarPaginaListadoFotos(plan: Itinerario, texto: unknown, maxFilas: number, maxBytes: number): PaginaListadoFotos {
  const fijo = copiarPlanFotos(plan);
  const p = pagina(fijo, leerJsonListadoAcotado(texto, maxBytes), maxFilas);
  if (renderPagina(p) !== texto) return fallar();
  return p;
}

function destinoListado(plan: Itinerario, valor: unknown): DestinoFoto {
  if (!esDestinoFoto(plan, valor)) return fallar();
  const d: DestinoFoto = valor.tipo === 'parada'
    ? { tipo: 'parada', viajeId: valor.viajeId, paradaId: valor.paradaId }
    : { tipo: 'subparada', viajeId: valor.viajeId, paradaId: valor.paradaId, subparadaId: valor.subparadaId };
  acotar(JSON.stringify(d), MAX_BYTES_DESTINO_LISTADO_FOTOS);
  return Object.freeze(d);
}
export function serializarDestinoListadoFotos(plan: Itinerario, valor: unknown): string {
  return JSON.stringify(destinoListado(plan, valor));
}
export function deserializarDestinoListadoFotos(plan: Itinerario, texto: unknown): DestinoFoto {
  const d = destinoListado(plan, leerJsonListadoAcotado(texto, MAX_BYTES_DESTINO_LISTADO_FOTOS));
  if (JSON.stringify(d) !== texto) return fallar();
  return d;
}
function cursorDestino(plan: Itinerario, valor: unknown): CursorListadoFotosDestino {
  if (!camposFoto(valor, ['version', 'tipo', 'viajeId', 'destino', 'despuesDe', 'hasta'])
    || valor.tipo !== 'cursor-respaldos-destino') return fallar();
  const posicion = cursor(plan, { version: valor.version, viajeId: valor.viajeId,
    despuesDe: valor.despuesDe, hasta: valor.hasta });
  const destino = destinoListado(plan, valor.destino);
  return Object.freeze({ version: 1, tipo: 'cursor-respaldos-destino', viajeId: posicion.viajeId,
    destino, despuesDe: posicion.despuesDe, hasta: posicion.hasta });
}
export function serializarCursorListadoFotosDestino(plan: Itinerario, valor: unknown): string {
  return acotar(JSON.stringify(cursorDestino(plan, valor)), MAX_BYTES_CURSOR_LISTADO_FOTOS_DESTINO);
}
export function deserializarCursorListadoFotosDestino(plan: Itinerario, texto: unknown): CursorListadoFotosDestino {
  const c = cursorDestino(plan, leerJsonListadoAcotado(texto, MAX_BYTES_CURSOR_LISTADO_FOTOS_DESTINO));
  if (JSON.stringify(c) !== texto) return fallar();
  return c;
}
function paginaDestino(plan: Itinerario, valor: unknown, maxFilas: number): PaginaListadoFotosDestino {
  if (!camposFoto(valor, ['version', 'tipo', 'viajeId', 'destino', 'solicitudesIniciales', 'continuacion'])
    || valor.tipo !== 'listado-respaldos-destino') return fallar();
  const destino = destinoListado(plan, valor.destino);
  const clave = JSON.stringify(destino);
  const c = valor.continuacion === null ? null : deserializarCursorListadoFotosDestino(plan, valor.continuacion);
  if (c !== null && JSON.stringify(c.destino) !== clave) return fallar();
  // El codec anterior conserva sus campos, orden, INITIAL y reglas de keyset intactos.
  const base = pagina(plan, { version: valor.version, tipo: 'listado-respaldos', viajeId: valor.viajeId,
    solicitudesIniciales: valor.solicitudesIniciales, continuacion: c === null ? null : renderCursor(c) }, maxFilas);
  for (const inicial of base.solicitudesIniciales) {
    const s = deserializarSolicitudRespaldo(plan, inicial);
    if (serializarDestinoListadoFotos(plan, s.original.destino) !== clave) return fallar();
  }
  return Object.freeze({ version: 1, tipo: 'listado-respaldos-destino', viajeId: base.viajeId,
    destino, solicitudesIniciales: base.solicitudesIniciales, continuacion: valor.continuacion as string | null });
}
export function copiarPaginaListadoFotosDestino(plan: Itinerario, valor: unknown, maxFilas: number): PaginaListadoFotosDestino {
  return paginaDestino(copiarPlanFotos(plan), valor, maxFilas);
}
export function serializarPaginaListadoFotosDestino(plan: Itinerario, valor: unknown, maxFilas: number, maxBytes: number): string {
  return acotar(JSON.stringify(paginaDestino(copiarPlanFotos(plan), valor, maxFilas)), maxBytes);
}
export function deserializarPaginaListadoFotosDestino(plan: Itinerario, texto: unknown, maxFilas: number,
  maxBytes: number): PaginaListadoFotosDestino {
  const p = paginaDestino(copiarPlanFotos(plan), leerJsonListadoAcotado(texto, maxBytes), maxFilas);
  if (JSON.stringify(p) !== texto) return fallar();
  return p;
}
