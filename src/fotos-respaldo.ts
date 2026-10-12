import type { Itinerario } from './tipos';
import { camposFoto, copiarMetadatos, esIdFoto, type DestinoFoto, type MetadatosFoto } from './fotos';
import { mismosMetadatosOriginal } from './fotos-identidad';

/** Identidad del original: ningún Blob, credencial ni estado de miniatura derivada.
 * Todos los campos heredados conservan su representación exacta, incluido -0/NUL/NFD.
 * Esta metadata no atesta bytes: preparar necesita comprobarIdentidadFoto contra PhotoDB viva. */
export interface OriginalRespaldo {
  /** Formato original de metadata del dominio de fotos. */
  readonly formato: 1;
  /** UUID de captura original, no sustituible ni regenerable al reintentar. */
  readonly fotoId: string;
  /** Viaje, parada padre y subparada hija exactos del plan. */
  readonly destino: DestinoFoto;
  /** Nombre raw del File, sin recorte ni normalización Unicode. */
  readonly nombre: string;
  /** MIME declarado raw; por sí solo no autentica el contenido. */
  readonly mimeDeclarado: string;
  /** Valor informativo del File conservado por Object.is, no reloj causal. */
  readonly ultimaModificacion: number;
  /** Valor original de incorporación: forma parte de la identidad exacta, no LWW. */
  readonly incorporada: number;
  /** Tamaño del original, nunca miniatura ni estimación de tráfico/facturación. */
  readonly bytesOriginal: number;
}

/** Contrato FUTURO del recibo emitido por servidor de ESTE origen tras autenticar la sesión.
 * El guard local comprueba estructura/coherencia, NO autentica al emisor ni prueba R2/SQL.
 * Solo un transporte confiable de sesión podrá entregarlo a confirmarRecibo, nunca un GET de
 * estado, un boolean del escritor local, un ETag ni contenido de un archivo importado.
 * Autenticación HTTP, atomicidad/recuperación R2+SQL y prueba remota pertenecen al servidor/T7.
 * Un importador portable futuro deberá revalidar con el servidor, no reutilizarlo como ACK fresco. */
export interface ReciboRespaldo {
  /** Versión explícita del protocolo, no versión de IndexedDB. */
  readonly version: 1;
  /** Discriminante exclusivo de acuse; no respuesta GET de disponibilidad. */
  readonly tipo: 'acuse-respaldo';
  /** Viaje autenticado por el servidor, no seleccionado de una respuesta ajena. */
  readonly viajeId: string;
  /** Operación manual inmutable a la que responde el acuse. */
  readonly operacionId: string;
  /** Identidad de foto, sin reutilización ni reemplazo de original. */
  readonly fotoId: string;
  /** Payload original completo confirmado, comparado sin normalización. */
  readonly original: OriginalRespaldo;
  /** Compromiso del servidor de persistencia del objeto original, no solo size/MIME. */
  readonly objetoOriginalDurable: true;
  /** Compromiso independiente de persistencia de la metadata vinculada al objeto. */
  readonly metadatosDurables: true;
}

export interface ReferenciaRespaldo {
  /** Clave estable del ledger, no posición en una lista visual. */
  readonly fotoId: string;
  /** UUIDv4 creado una vez por preparación explícita. */
  readonly operacionId: string;
  /** Identidad completa que evita acciones tardías sobre otra captura. */
  readonly original: OriginalRespaldo;
}
export interface EntradaRespaldo extends ReferenciaRespaldo {
  /** Formato propio del registro durable, nunca formato de progreso. */
  readonly formato: 1;
  /** Autoridad local: preparado no enviado; enviada incierta; respaldada solo con recibo;
   * bloqueada conserva pruebas previas pero impide nuevos envíos por contradicción. */
  readonly fase: 'preparado' | 'enviada' | 'respaldada' | 'bloqueada';
  /** Testigo histórico irreversible anterior a cualquier IO externo, NO prueba de envío real. */
  readonly enviada: boolean;
  /** Intención local de pausa; no revoca solicitudes, objetos remotos ni costes del proveedor. */
  readonly pausada: boolean;
  /** Prueba exacta conservada; null significa ausencia de acuse, nunca ausencia remota. */
  readonly recibo: ReciboRespaldo | null;
}
const camposOriginal = ['formato', 'fotoId', 'destino', 'nombre', 'mimeDeclarado', 'ultimaModificacion',
  'incorporada', 'bytesOriginal'];
const camposRecibo = ['version', 'tipo', 'viajeId', 'operacionId', 'fotoId', 'original',
  'objetoOriginalDurable', 'metadatosDurables'];
const camposReferencia = ['fotoId', 'operacionId', 'original'];
const camposEntrada = [...camposReferencia, 'formato', 'fase', 'enviada', 'pausada', 'recibo'];

/** Materializa metadata válida, incluidos propios no enumerables, sin miniatura derivada. */
export function copiarOriginalRespaldo(plan: Itinerario, metadata: unknown): OriginalRespaldo {
  const m = copiarMetadatos(plan, metadata);
  return { formato: m.formato, fotoId: m.fotoId, destino: m.destino, nombre: m.nombre,
    mimeDeclarado: m.mimeDeclarado, ultimaModificacion: m.ultimaModificacion,
    incorporada: m.incorporada, bytesOriginal: m.bytesOriginal };
}
/** Reconstruye únicamente para reutilizar el guard de dominio; no confunde miniatura con identidad. */
function conMiniatura(plan: Itinerario, original: unknown): MetadatosFoto {
  if (!camposFoto(original, camposOriginal)) throw new Error('Identidad original de respaldo inválida');
  return copiarMetadatos(plan, { formato: original.formato, fotoId: original.fotoId, destino: original.destino,
    nombre: original.nombre, mimeDeclarado: original.mimeDeclarado, ultimaModificacion: original.ultimaModificacion,
    incorporada: original.incorporada, bytesOriginal: original.bytesOriginal, miniatura: { tipo: 'pendiente' } });
}
export function copiarIdentidadRespaldo(plan: Itinerario, original: unknown): OriginalRespaldo {
  return copiarOriginalRespaldo(plan, conMiniatura(plan, original));
}
export function mismosOriginalesRespaldo(plan: Itinerario, a: unknown, b: unknown): boolean {
  try { return mismosMetadatosOriginal(plan, conMiniatura(plan, a), conMiniatura(plan, b)); }
  catch { return false; }
}
export function copiarReferenciaRespaldo(plan: Itinerario, valor: unknown): ReferenciaRespaldo {
  if (!camposFoto(valor, camposReferencia) || !esIdFoto(valor.fotoId) || !esIdFoto(valor.operacionId)) {
    throw new Error('Referencia de respaldo inválida');
  }
  const original = copiarIdentidadRespaldo(plan, valor.original);
  if (!Object.is(original.fotoId, valor.fotoId)) throw new Error('Identidad de respaldo contradictoria');
  return { fotoId: valor.fotoId, operacionId: valor.operacionId, original };
}
export function esReciboRespaldo(plan: Itinerario, valor: unknown): valor is ReciboRespaldo {
  try {
    if (!camposFoto(valor, camposRecibo) || valor.version !== 1 || valor.tipo !== 'acuse-respaldo'
      || valor.viajeId !== plan.id || !esIdFoto(valor.operacionId) || !esIdFoto(valor.fotoId)
      || valor.objetoOriginalDurable !== true || valor.metadatosDurables !== true) return false;
    const original = copiarIdentidadRespaldo(plan, valor.original);
    return Object.is(original.fotoId, valor.fotoId) && Object.is(original.destino.viajeId, valor.viajeId);
  } catch { return false; }
}
export function copiarReciboRespaldo(plan: Itinerario, valor: unknown): ReciboRespaldo {
  if (!esReciboRespaldo(plan, valor)) throw new Error('Recibo de respaldo inválido o incompleto');
  return { version: 1, tipo: 'acuse-respaldo', viajeId: valor.viajeId, operacionId: valor.operacionId,
    fotoId: valor.fotoId, original: copiarIdentidadRespaldo(plan, valor.original),
    objetoOriginalDurable: true, metadatosDurables: true };
}
export function esEntradaRespaldo(plan: Itinerario, valor: unknown): valor is EntradaRespaldo {
  try {
    if (!camposFoto(valor, camposEntrada) || valor.formato !== 1 || typeof valor.enviada !== 'boolean'
      || typeof valor.pausada !== 'boolean') return false;
    const ref = copiarReferenciaRespaldo(plan, { fotoId: valor.fotoId, operacionId: valor.operacionId, original: valor.original });
    if (valor.fase === 'preparado') { if (valor.enviada || valor.recibo !== null) return false; }
    else if (!['enviada', 'respaldada', 'bloqueada'].includes(valor.fase as string) || !valor.enviada) return false;
    if (valor.fase === 'respaldada' && valor.recibo === null) return false;
    if (valor.fase === 'enviada' && valor.recibo !== null) return false;
    if (valor.recibo !== null) {
      const r = copiarReciboRespaldo(plan, valor.recibo);
      if (!Object.is(r.operacionId, ref.operacionId) || !Object.is(r.fotoId, ref.fotoId)
        || !mismosOriginalesRespaldo(plan, r.original, ref.original)) return false;
    }
    return true;
  } catch { return false; }
}
export function copiarEntradaRespaldo(plan: Itinerario, valor: unknown): EntradaRespaldo {
  if (!esEntradaRespaldo(plan, valor)) throw new Error('Registro de respaldo corrupto o formato no soportado');
  return { formato: 1, fotoId: valor.fotoId, operacionId: valor.operacionId,
    original: copiarIdentidadRespaldo(plan, valor.original), fase: valor.fase, enviada: valor.enviada,
    pausada: valor.pausada, recibo: valor.recibo === null ? null : copiarReciboRespaldo(plan, valor.recibo) };
}
