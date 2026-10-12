import type { Itinerario } from './tipos';
import { camposFoto } from './fotos';
import { copiarReferenciaRespaldo, copiarReciboRespaldo, mismosOriginalesRespaldo,
  type OriginalRespaldo, type ReciboRespaldo } from './fotos-respaldo';

/** Solicitud de metadata; los bytes originales pertenecen al transporte futuro separado. */
export interface SolicitudRespaldo {
  /** Versión del contrato JSON, no de PhotoDB. */
  readonly version: 1;
  /** Discriminante exclusivo de solicitud manual. */
  readonly tipo: 'solicitud-respaldo';
  /** Viaje del plan y del destino original. */
  readonly viajeId: string;
  /** Operación ya preparada, nunca generada por el codec. */
  readonly operacionId: string;
  /** UUID de la captura original. */
  readonly fotoId: string;
  /** Identidad completa sin miniatura, Blob ni credenciales. */
  readonly original: OriginalRespaldo;
}
/** Techo del texto UTF-8 del protocolo, NO del original ni de un upload. */
export const MAX_BYTES_JSON_RESPALDO = 64 * 1024;
const camposSolicitud = ['version', 'tipo', 'viajeId', 'operacionId', 'fotoId', 'original'];

/** Snapshot de datos propios válidos. Reutiliza la política de descriptores del dominio.
 * No invoca getters ni toJSON. Como camposFoto, no aísla traps de un Proxy hostil. */
export function copiarSolicitudRespaldo(plan: Itinerario, valor: unknown): SolicitudRespaldo {
  if (!camposFoto(valor, camposSolicitud) || valor.version !== 1 || valor.tipo !== 'solicitud-respaldo'
    || valor.viajeId !== plan.id) throw new Error('Solicitud de respaldo inválida');
  const ref = copiarReferenciaRespaldo(plan, {
    fotoId: valor.fotoId, operacionId: valor.operacionId, original: valor.original,
  });
  if (ref.original.destino.viajeId !== valor.viajeId) throw new Error('Viaje de respaldo contradictorio');
  return { version: 1, tipo: 'solicitud-respaldo', viajeId: valor.viajeId, ...ref };
}

/** JSON.stringify sólo recibe strings primitivos copiados, jamás objetos del llamador. */
function textoJson(valor: string): string { return JSON.stringify(valor); }
function numeroJson(valor: number): string { return Object.is(valor, -0) ? '-0' : JSON.stringify(valor); }

/** Render explícito del esquema guardado. No reemplaza substrings ni usa sentinelas. */
function originalJson(original: OriginalRespaldo): string {
  const d = original.destino;
  const destino = '{"tipo":' + textoJson(d.tipo) + ',"viajeId":' + textoJson(d.viajeId)
    + ',"paradaId":' + textoJson(d.paradaId)
    + (d.tipo === 'subparada' ? ',"subparadaId":' + textoJson(d.subparadaId) : '') + '}';
  return '{"formato":1,"fotoId":' + textoJson(original.fotoId) + ',"destino":' + destino
    + ',"nombre":' + textoJson(original.nombre) + ',"mimeDeclarado":' + textoJson(original.mimeDeclarado)
    + ',"ultimaModificacion":' + numeroJson(original.ultimaModificacion)
    + ',"incorporada":' + numeroJson(original.incorporada)
    + ',"bytesOriginal":' + numeroJson(original.bytesOriginal) + '}';
}
function cabeceraJson(valor: SolicitudRespaldo | ReciboRespaldo): string {
  return '{"version":1,"tipo":' + textoJson(valor.tipo) + ',"viajeId":' + textoJson(valor.viajeId)
    + ',"operacionId":' + textoJson(valor.operacionId) + ',"fotoId":' + textoJson(valor.fotoId)
    + ',"original":' + originalJson(valor.original);
}
function acotarTexto(texto: unknown): string {
  if (typeof texto !== 'string') throw new Error('Se requiere texto JSON de respaldo');
  // Toda unidad UTF-16 ocupa al menos un byte UTF-8; evita asignar un buffer enorme.
  if (texto.length > MAX_BYTES_JSON_RESPALDO
    || new TextEncoder().encode(texto).byteLength > MAX_BYTES_JSON_RESPALDO) {
    throw new Error('Texto JSON de respaldo supera 64 KiB UTF-8');
  }
  return texto;
}
export function serializarSolicitudRespaldo(plan: Itinerario, valor: unknown): string {
  return acotarTexto(cabeceraJson(copiarSolicitudRespaldo(plan, valor)) + '}');
}
export function serializarReciboRespaldo(plan: Itinerario, valor: unknown): string {
  return acotarTexto(cabeceraJson(copiarReciboRespaldo(plan, valor))
    + ',"objetoOriginalDurable":true,"metadatosDurables":true}');
}

/** Escáner acotado para rechazar claves duplicadas antes del parse nativo.
 * No es un importador genérico: sólo precede a los guards del esquema tipado.
 * Texto <=64 KiB, profundidad <=16, recorrido lineal sin regex de retroceso exponencial.
 * Las claves se decodifican individualmente para reconocer equivalencia de escapes. */
function comprobarClavesJson(texto: string): void {
  let posicion = 0;
  const numero = /-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/y;
  function fallo(): never { throw new Error('Sintaxis JSON de respaldo inválida'); }
  function blancos(): void {
    while (posicion < texto.length && (texto[posicion] === ' ' || texto[posicion] === '\t'
      || texto[posicion] === '\r' || texto[posicion] === '\n')) posicion++;
  }
  function cadena(): string {
    const inicio = posicion;
    if (texto[posicion++] !== '"') return fallo();
    while (posicion < texto.length) {
      const c = texto[posicion++];
      if (c === '"') return JSON.parse(texto.slice(inicio, posicion)) as string;
      if (c === '\\') {
        const escape = texto[posicion++];
        if (escape === 'u') {
          for (let i = 0; i < 4; i++) {
            const h = texto[posicion++];
            if (h === undefined || !/[0-9a-fA-F]/.test(h)) return fallo();
          }
        } else if (escape === undefined || !'"\\/bfnrt'.includes(escape)) return fallo();
      } else if (c.charCodeAt(0) < 32) return fallo();
    }
    return fallo();
  }
  function valor(profundidad: number): void {
    if (profundidad > 16) throw new Error('Profundidad JSON de respaldo excesiva');
    blancos();
    const c = texto[posicion];
    if (c === '"') { cadena(); return; }
    if (c === '{') {
      posicion++; blancos(); const claves = new Set<string>();
      if (texto[posicion] === '}') { posicion++; return; }
      for (;;) {
        blancos(); const clave = cadena();
        if (claves.has(clave)) throw new Error('Clave JSON duplicada');
        claves.add(clave); blancos();
        if (texto[posicion++] !== ':') return fallo();
        valor(profundidad + 1); blancos();
        const separador = texto[posicion++];
        if (separador === '}') return;
        if (separador !== ',') return fallo();
      }
    }
    if (c === '[') {
      posicion++; blancos();
      if (texto[posicion] === ']') { posicion++; return; }
      for (;;) {
        valor(profundidad + 1); blancos();
        const separador = texto[posicion++];
        if (separador === ']') return;
        if (separador !== ',') return fallo();
      }
    }
    for (const literal of ['true', 'false', 'null']) {
      if (texto.startsWith(literal, posicion)) { posicion += literal.length; return; }
    }
    numero.lastIndex = posicion;
    if (!numero.exec(texto)) return fallo();
    posicion = numero.lastIndex;
  }
  valor(0); blancos();
  if (posicion !== texto.length) fallo();
}
function leerJson(texto: unknown): unknown {
  const limitado = acotarTexto(texto);
  comprobarClavesJson(limitado);
  return JSON.parse(limitado) as unknown;
}
export function deserializarSolicitudRespaldo(plan: Itinerario, texto: unknown): SolicitudRespaldo {
  return copiarSolicitudRespaldo(plan, leerJson(texto));
}
/** Decodificar NO autentica un acuse ni autoriza confirmarRecibo.
 * Un archivo/importación nunca es ACK fresco. El futuro HTTP confiable debe comprobar
 * origen esperado y sesión viva, vincular la referencia seleccionada y atestar los bytes
 * originales antes del IO. Este codec no toca DB, cookies, red ni estado del ledger. */
export function deserializarReciboRespaldo(plan: Itinerario, texto: unknown): ReciboRespaldo {
  return copiarReciboRespaldo(plan, leerJson(texto));
}
/** Coherencia estructural exclusivamente; NO prueba emisor, bytes ni durabilidad remota. */
export function reciboCorrespondeASolicitud(plan: Itinerario, solicitud: unknown, recibo: unknown): boolean {
  try {
    const s = copiarSolicitudRespaldo(plan, solicitud); const r = copiarReciboRespaldo(plan, recibo);
    return Object.is(s.viajeId, r.viajeId) && Object.is(s.operacionId, r.operacionId)
      && Object.is(s.fotoId, r.fotoId) && mismosOriginalesRespaldo(plan, s.original, r.original);
  } catch { return false; }
}
