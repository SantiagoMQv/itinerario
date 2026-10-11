import type { Itinerario } from './tipos';

/** IDs del plan, nunca índices visuales del modelo. */
export type DestinoFoto = { readonly tipo: 'parada'; readonly viajeId: string; readonly paradaId: string }
  | { readonly tipo: 'subparada'; readonly viajeId: string; readonly paradaId: string; readonly subparadaId: string };
export type EstadoMiniatura = { readonly tipo: 'pendiente' } | { readonly tipo: 'fallida'; readonly motivo: string }
  | { readonly tipo: 'lista'; readonly bytes: number; readonly ancho: number; readonly alto: number; readonly mime: 'image/png' };
export interface MetadatosFoto {
  readonly formato: 1;
  readonly fotoId: string;
  readonly destino: DestinoFoto;
  /** Valores del File tal como los proporciona el navegador, sin normalizar. */
  readonly nombre: string;
  readonly mimeDeclarado: string;
  readonly ultimaModificacion: number;
  /** Fecha informativa, no orden causal ni identidad. */
  readonly incorporada: number;
  readonly bytesOriginal: number;
  readonly miniatura: EstadoMiniatura;
}
/** No conserva nombres ni MIME del original eliminado. Impide reutilizar su identidad. */
export interface FotoBorrada { readonly formato: 1; readonly fotoId: string; readonly tipo: 'borrada' }
export type ResultadoFoto = { readonly tipo: 'guardada'; readonly metadatos: MetadatosFoto }
  | { readonly tipo: 'borrada'; readonly fotoId: string };
export interface CapturaFoto { readonly metadatos: MetadatosFoto; readonly original: Blob }

/** Inspecciona descriptores antes de acceder a valores. No ejecuta accessors ni clona inválidos.
 * Los Proxy hostiles no son una frontera de aislamiento JS: sus traps pueden ejecutarse. */
export function camposFoto(valor: unknown, claves: readonly string[]): valor is Record<string, unknown> {
  if (typeof valor !== 'object' || valor === null) return false;
  const proto = Object.getPrototypeOf(valor);
  if (proto !== Object.prototype && proto !== null) return false;
  const propias = Reflect.ownKeys(valor);
  if (propias.length !== claves.length || propias.some((k) => typeof k !== 'string' || !claves.includes(k))) return false;
  return claves.every((k) => Object.hasOwn(Object.getOwnPropertyDescriptor(valor, k)!, 'value'));
}
export const esIdFoto = (valor: unknown): valor is string => typeof valor === 'string'
  && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(valor);
const entero = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v);
const bytes = (v: unknown): v is number => entero(v) && v >= 0;
// Techo técnico de representación de campos, no una restricción de cantidad/peso de fotos.
const texto = (v: unknown): v is string => typeof v === 'string' && v.length <= 65536;
export function esDestinoFoto(plan: Itinerario, valor: unknown): valor is DestinoFoto {
  try {
    if (!camposFoto(valor, ['tipo', 'viajeId', 'paradaId'])
      && !camposFoto(valor, ['tipo', 'viajeId', 'paradaId', 'subparadaId'])) return false;
    if (valor.viajeId !== plan.id || typeof valor.paradaId !== 'string') return false;
    const padre = plan.dias.flatMap((d) => d.paradas).find((p) => p.id === valor.paradaId);
    if (!padre) return false;
    return valor.tipo === 'parada' ? camposFoto(valor, ['tipo', 'viajeId', 'paradaId'])
      : valor.tipo === 'subparada' && camposFoto(valor, ['tipo', 'viajeId', 'paradaId', 'subparadaId'])
        && !!padre.subparadas?.some((s) => s.id === valor.subparadaId);
  } catch { return false; }
}
export function esEstadoMiniatura(valor: unknown): valor is EstadoMiniatura {
  try {
    if (camposFoto(valor, ['tipo'])) return valor.tipo === 'pendiente';
    if (camposFoto(valor, ['tipo', 'motivo'])) return valor.tipo === 'fallida' && texto(valor.motivo) && valor.motivo.length > 0;
    return camposFoto(valor, ['tipo', 'bytes', 'ancho', 'alto', 'mime']) && valor.tipo === 'lista'
      && bytes(valor.bytes) && valor.bytes > 0 && entero(valor.ancho) && valor.ancho > 0 && valor.ancho <= 1024
      && entero(valor.alto) && valor.alto > 0 && valor.alto <= 1024 && valor.mime === 'image/png';
  } catch { return false; }
}
export function esMetadatosFoto(plan: Itinerario, valor: unknown): valor is MetadatosFoto {
  try {
    return camposFoto(valor, ['formato', 'fotoId', 'destino', 'nombre', 'mimeDeclarado', 'ultimaModificacion',
      'incorporada', 'bytesOriginal', 'miniatura']) && valor.formato === 1 && esIdFoto(valor.fotoId)
      && esDestinoFoto(plan, valor.destino) && texto(valor.nombre) && texto(valor.mimeDeclarado)
      && entero(valor.ultimaModificacion) && entero(valor.incorporada) && bytes(valor.bytesOriginal)
      && esEstadoMiniatura(valor.miniatura);
  } catch { return false; }
}
export function esFotoBorrada(valor: unknown): valor is FotoBorrada {
  try { return camposFoto(valor, ['formato', 'fotoId', 'tipo']) && valor.formato === 1
    && esIdFoto(valor.fotoId) && valor.tipo === 'borrada'; } catch { return false; }
}
export function esResultadoFoto(plan: Itinerario, valor: unknown): valor is ResultadoFoto {
  try {
    return camposFoto(valor, ['tipo', 'metadatos']) ? valor.tipo === 'guardada' && esMetadatosFoto(plan, valor.metadatos)
      : camposFoto(valor, ['tipo', 'fotoId']) && valor.tipo === 'borrada' && esIdFoto(valor.fotoId);
  } catch { return false; }
}
/** Brand nativo; Blob no es JSON ni se inspeccionan sus propiedades propias. */
export function tamanoBlob(valor: unknown): number {
  return Object.getOwnPropertyDescriptor(Blob.prototype, 'size')!.get!.call(valor) as number;
}
export function tipoBlob(valor: Blob): string {
  return Object.getOwnPropertyDescriptor(Blob.prototype, 'type')!.get!.call(valor) as string;
}
export function copiarMetadatos(plan: Itinerario, valor: unknown): MetadatosFoto {
  if (!esMetadatosFoto(plan, valor)) throw new Error('Metadatos de foto corruptos o formato no soportado');
  // Materializa también propios no enumerables válidos, que structuredClone omitiría.
  const destino: DestinoFoto = valor.destino.tipo === 'parada'
    ? { tipo: 'parada', viajeId: valor.destino.viajeId, paradaId: valor.destino.paradaId }
    : { tipo: 'subparada', viajeId: valor.destino.viajeId, paradaId: valor.destino.paradaId, subparadaId: valor.destino.subparadaId };
  const m = valor.miniatura;
  const miniatura: EstadoMiniatura = m.tipo === 'lista'
    ? { tipo: m.tipo, bytes: m.bytes, ancho: m.ancho, alto: m.alto, mime: m.mime }
    : m.tipo === 'fallida' ? { tipo: m.tipo, motivo: m.motivo } : { tipo: m.tipo };
  return { formato: 1, fotoId: valor.fotoId, destino, nombre: valor.nombre, mimeDeclarado: valor.mimeDeclarado,
    ultimaModificacion: valor.ultimaModificacion, incorporada: valor.incorporada, bytesOriginal: valor.bytesOriginal, miniatura };
}
function uuidSeguro(): string {
  const cripto = globalThis.crypto;
  if (cripto?.randomUUID) return cripto.randomUUID();
  if (!cripto?.getRandomValues) throw new Error('No hay generador criptográfico disponible');
  const b = cripto.getRandomValues(new Uint8Array(16));
  b[6] = (b[6] & 15) | 64; b[8] = (b[8] & 63) | 128;
  const h = Array.from(b, (n) => n.toString(16).padStart(2, '0')).join('');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}
/** Crear UNA vez por intento. Ante escritura incierta conservar captura/ID; nunca regenerar automáticamente. */
export function crearCapturaFoto(plan: Itinerario, destino: DestinoFoto, archivo: File, incorporada: number,
  opciones: { uuid?: () => string } = {}): CapturaFoto {
  if (!esDestinoFoto(plan, destino) || !entero(incorporada)) throw new Error('Destino o fecha inválidos');
  const nombre = Object.getOwnPropertyDescriptor(File.prototype, 'name')!.get!.call(archivo) as string;
  const ultimaModificacion = Object.getOwnPropertyDescriptor(File.prototype, 'lastModified')!.get!.call(archivo) as number;
  const metadatos = copiarMetadatos(plan, { formato: 1, fotoId: (opciones.uuid ?? uuidSeguro)(), destino,
    nombre, ultimaModificacion, incorporada, mimeDeclarado: tipoBlob(archivo), bytesOriginal: tamanoBlob(archivo),
    miniatura: { tipo: 'pendiente' } });
  return { metadatos, original: archivo };
}
