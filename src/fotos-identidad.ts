import type { Itinerario } from './tipos';
import { copiarMetadatos, esFotoBorrada, tamanoBlob, tipoBlob, type MetadatosFoto } from './fotos';

/** Bloques fijos de 1 MiB: se compara el original entero, sin hash ni límite de peso. */
export const BLOQUE_IDENTIDAD_FOTO = 1 << 20;

/** Puerto estructural solo de lectura, compatible con FotosLocal sin depender de su implementación.
 * Cada llamada debe ser fresca, con null para ausencia, y fallar ante corrupción de relaciones.
 * Requiere original vivo inmutable y tombstone definitivo: no reutilización de ID, reemplazo ni ABA.
 * Sin ese contrato, tres lecturas no prueban coherencia ni aíslan escritores arbitrarios. */
export interface LecturasIdentidadFoto {
  readonly leerMetadatos: (fotoId: string) => Promise<unknown>;
  readonly leerOriginal: (fotoId: string) => Promise<unknown>;
}

/** «Distintos» es diferencia comprobada; un error/brand inválido no afirma diferencia ni igualdad. */
export type ComparacionOriginalesFoto = { readonly tipo: 'iguales' | 'distintos' }
  | { readonly tipo: 'incierta'; readonly motivo: string };

/** «Misma» atesta exclusivamente el original LOCAL observado, nunca ACK remoto ni respaldo durable.
 * «Otra» exige diferencia válida comprobada; «borrada» es tombstone propio, no ausencia reutilizable.
 * «Incierta» conserva ambigüedad ante corrupción, cambios concurrentes o lecturas fallidas. */
export type IdentidadFoto = { readonly tipo: 'misma'; readonly metadatos: MetadatosFoto }
  | { readonly tipo: 'ausente' | 'otra' }
  | { readonly tipo: 'borrada'; readonly fotoId: string }
  | { readonly tipo: 'incierta'; readonly motivo: string };

function mismaMetadata(a: MetadatosFoto, b: MetadatosFoto): boolean {
  const x = a.destino; const y = b.destino;
  return Object.is(a.formato, b.formato) && Object.is(a.fotoId, b.fotoId)
    && Object.is(a.nombre, b.nombre) && Object.is(a.mimeDeclarado, b.mimeDeclarado)
    && Object.is(a.ultimaModificacion, b.ultimaModificacion) && Object.is(a.incorporada, b.incorporada)
    && Object.is(a.bytesOriginal, b.bytesOriginal) && Object.is(x.tipo, y.tipo)
    && Object.is(x.viajeId, y.viajeId) && Object.is(x.paradaId, y.paradaId)
    && Object.is(x.tipo === 'subparada' ? x.subparadaId : null, y.tipo === 'subparada' ? y.subparadaId : null);
}

/** Valida y materializa ambos inputs con el guard de fotos.ts, sin ejecutar getters propios.
 * Object.is en TODOS los campos originales, incluida incorporada: conserva NUL, NFD y -0.
 * Solo miniatura derivada válida queda fuera de identidad. Inválidos/extranjeros nunca son iguales.
 * Como en fotos.ts, no constituye aislamiento frente a traps de un Proxy hostil. */
export function mismosMetadatosOriginal(plan: Itinerario, a: unknown, b: unknown): boolean {
  try { return mismaMetadata(copiarMetadatos(plan, a), copiarMetadatos(plan, b)); }
  catch { return false; }
}

/** Brand, size y type intrínsecos: ignora cualquier override propio en Blob/File. */
function datosBlob(valor: unknown): { bytes: number; mime: string } {
  return { bytes: tamanoBlob(valor), mime: tipoBlob(valor as Blob) };
}
function compatible(blob: unknown, m: MetadatosFoto): boolean {
  const datos = datosBlob(blob);
  return datos.bytes === m.bytesOriginal && datos.mime === m.mimeDeclarado;
}

/** Compara tipo nativo, tamaño y TODOS los bytes; corta en el primer bloque distinto.
 * Solo hay hasta dos buffers de bloque actuales referenciados por esta operación (no es una promesa
 * sobre GC, heap total del proceso ni varias invocaciones concurrentes). Cada vuelta espera ambas
 * lecturas antes de avanzar; incluye última fracción y Blob vacío. No usa métodos propios falsificables.
 * Si falla una lectura, no declara iguales ni distintos y no intenta reparar/reintentar. */
export async function compararOriginalesFoto(a: unknown, b: unknown): Promise<ComparacionOriginalesFoto> {
  try {
    const x = datosBlob(a); const y = datosBlob(b);
    if (x.bytes !== y.bytes || x.mime !== y.mime) return { tipo: 'distintos' };
    for (let inicio = 0; inicio < x.bytes; inicio += BLOQUE_IDENTIDAD_FOTO) {
      const fin = Math.min(inicio + BLOQUE_IDENTIDAD_FOTO, x.bytes);
      // Secuencial: si falla la primera lectura no queda una segunda promesa leyendo en segundo plano.
      const primero = new Uint8Array(await Blob.prototype.arrayBuffer.call(Blob.prototype.slice.call(a, inicio, fin)));
      const segundo = new Uint8Array(await Blob.prototype.arrayBuffer.call(Blob.prototype.slice.call(b, inicio, fin)));
      if (primero.length !== fin - inicio || segundo.length !== fin - inicio) {
        return { tipo: 'incierta', motivo: 'Lectura de bloque incompleta.' };
      }
      for (let i = 0; i < primero.length; i++) if (primero[i] !== segundo[i]) return { tipo: 'distintos' };
    }
    return { tipo: 'iguales' };
  } catch { return { tipo: 'incierta', motivo: 'No se pudieron leer los originales completos.' }; }
}

/** ¿Consta ESTA captura original en el puerto local?
 * Valida/snapshot de metadata y brand/size/type del original del llamador ANTES de toda E/S y await.
 * Orden: metadata → original (bytes completos) → metadata fresca. Snapshots impiden retargeting si
 * el llamador o el puerto mutan sus objetos durante await; el Blob nativo es inmutable.
 * La última lectura admite miniatura válida nueva, pero no original cambiado, borrado o corrupción.
 * La prueba depende del contrato no-ABA del puerto, no es prueba distribuida ni de proveedor R2.
 * No escribe, repara, regenera IDs ni confirma una operación remota. guardarOriginal sigue rechazando
 * TODA colisión, incluso tras esta atestación positiva de una respuesta local perdida. */
export async function comprobarIdentidadFoto(plan: Itinerario, lecturas: LecturasIdentidadFoto,
  metadatos: unknown, original: unknown): Promise<IdentidadFoto> {
  const incierta = (motivo: string): IdentidadFoto => ({ tipo: 'incierta', motivo });
  let esperada: MetadatosFoto;
  try {
    esperada = copiarMetadatos(plan, metadatos);
    if (!compatible(original, esperada)) return incierta('Original del llamador incompatible con su metadata.');
  } catch { return incierta('Captura original inválida.'); }
  const id = esperada.fotoId;
  // Copia del plan antes del primer await: no se altera el dominio válido durante la comprobación.
  let planFijo: Itinerario;
  try { planFijo = structuredClone(plan); } catch { return incierta('Plan no disponible para comprobar.'); }
  function leerEstado(valor: unknown): MetadatosFoto | { tipo: 'borrada'; fotoId: string } | null {
    if (valor === null) return null;
    if (esFotoBorrada(valor)) {
      if (!Object.is(valor.fotoId, id)) throw new Error('Tombstone de otra identidad');
      return { tipo: 'borrada', fotoId: id };
    }
    return copiarMetadatos(planFijo, valor);
  }
  try {
    const antes = leerEstado(await lecturas.leerMetadatos(id));
    if (antes === null) return { tipo: 'ausente' };
    if ('tipo' in antes) return antes;
    if (!mismaMetadata(antes, esperada)) return { tipo: 'otra' };
    const guardado = await lecturas.leerOriginal(id);
    // Aun si falta el Blob, se vuelve a leer metadata para distinguir un borrado concurrente.
    let bytes: ComparacionOriginalesFoto = { tipo: 'incierta', motivo: 'Original guardado ausente o corrupto.' };
    if (guardado !== null && compatible(guardado, esperada)) bytes = await compararOriginalesFoto(guardado, original);
    const despues = leerEstado(await lecturas.leerMetadatos(id));
    if (despues !== null && 'tipo' in despues) return despues;
    if (despues === null || !mismaMetadata(despues, esperada)) return incierta('Cambió mientras se comprobaba.');
    if (bytes.tipo === 'incierta') return bytes;
    if (bytes.tipo === 'distintos') return { tipo: 'otra' };
    return { tipo: 'misma', metadatos: despues };
  } catch { return incierta('No se pudo comprobar el original local.'); }
}
