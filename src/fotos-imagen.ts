import { tamanoBlob, tipoBlob } from './fotos';

/** Presupuestos técnicos, no límites de producto sobre originales/cantidad de fotos.
 * 32 MP admite teléfonos de 12–24 MP. No garantiza el consumo interno del decoder.
 * 128 KiB/una lectura evita cargar EXIF grande; no buscamos GPS ni leemos sus campos.
 * 1024 px limita el canvas/output incluso con DPR elevado; PNG no usa calidad arbitraria. */
export const LIMITES_IMAGEN = Object.freeze({ bytesCabecera: 128 * 1024, lecturasCabecera: 1,
  pixelesEntrada: 32_000_000, ladoSalida: 1024, dpr: 3 });
export type InspeccionImagen = { readonly tipo: 'identificada'; readonly mime: 'image/png' | 'image/jpeg' | 'image/webp';
  readonly ancho: number; readonly alto: number } | { readonly tipo: 'no-disponible'; readonly motivo: string };
export type MiniaturaImagen = { readonly tipo: 'lista'; readonly blob: Blob; readonly ancho: number; readonly alto: number }
  | Extract<InspeccionImagen, { tipo: 'no-disponible' }>;
export interface ImagenDecodificada {
  readonly ancho: number; readonly alto: number; readonly fuente: CanvasImageSource; cerrar(): void;
}
export interface LienzoMiniatura { dibujar(fuente: CanvasImageSource): void; png(): Promise<Blob>; liberar(): void }
export interface OpcionesMiniatura {
  readonly decodificar?: (blob: Blob) => Promise<ImagenDecodificada>;
  readonly crearLienzo?: (ancho: number, alto: number) => LienzoMiniatura;
}
export interface MotorMiniatura {
  generar(original: Blob, opciones?: { readonly senal?: AbortSignal; readonly ladoCss?: number; readonly dpr?: number }): Promise<MiniaturaImagen>;
  cerrar(): void;
}
const noDisponible = (motivo: string): Extract<InspeccionImagen, { tipo: 'no-disponible' }> => ({ tipo: 'no-disponible', motivo });
function dimensiones(mime: Extract<InspeccionImagen, { tipo: 'identificada' }>['mime'], ancho: number, alto: number): InspeccionImagen {
  if (!Number.isSafeInteger(ancho) || !Number.isSafeInteger(alto) || ancho <= 0 || alto <= 0
    || ancho * alto > LIMITES_IMAGEN.pixelesEntrada) return noDisponible('Dimensiones fuera del presupuesto técnico de previsualización');
  return { tipo: 'identificada', mime, ancho, alto };
}
/** Una sola lectura acotada. Un header incompleto no habilita decodificación a ciegas.
 * HEIC/HEIF/AVIF y activos quedan opacos; esto NO modifica ni elimina el original. */
export async function inspeccionarImagen(original: Blob): Promise<InspeccionImagen> {
  const size = tamanoBlob(original);
  const fragmento = Blob.prototype.slice.call(original, 0, LIMITES_IMAGEN.bytesCabecera);
  const b = new Uint8Array(await Blob.prototype.arrayBuffer.call(fragmento));
  const v = new DataView(b.buffer);
  const coincide = (offset: number, numeros: readonly number[]) => numeros.every((n, i) => b[offset + i] === n);
  const ascii = (offset: number, texto: string) => coincide(offset, Array.from(texto, (c) => c.charCodeAt(0)));
  const u24 = (offset: number) => b[offset] + b[offset + 1] * 256 + b[offset + 2] * 65536;
  if (coincide(0, [137, 80, 78, 71, 13, 10, 26, 10])) {
    if (b.length < 33 || v.getUint32(8) !== 13 || !ascii(12, 'IHDR') || b[26] !== 0 || b[27] !== 0
      || b[28] > 1) return noDisponible('Cabecera PNG inválida');
    const profundidades: Record<number, readonly number[]> = { 0: [1, 2, 4, 8, 16], 2: [8, 16], 3: [1, 2, 4, 8], 4: [8, 16], 6: [8, 16] };
    if (!profundidades[b[25]]?.includes(b[24])) return noDisponible('IHDR PNG inválido');
    return dimensiones('image/png', v.getUint32(16), v.getUint32(20));
  }
  if (coincide(0, [255, 216])) {
    let offset = 2;
    while (offset + 4 <= b.length) {
      if (b[offset++] !== 255) return noDisponible('Marcador JPEG inválido');
      while (offset < b.length && b[offset] === 255) offset++;
      const marcador = b[offset++];
      if (marcador === 217 || marcador === 218 || marcador === 0 || marcador === 216
        || (marcador >= 208 && marcador <= 215)) return noDisponible('JPEG sin dimensiones verificables');
      if (offset + 2 > b.length) break;
      const largo = v.getUint16(offset);
      if (largo < 2 || offset + largo > b.length) break;
      if ([192, 193, 194].includes(marcador)) {
        const componentes = b[offset + 7];
        if (largo !== 8 + 3 * componentes || ![1, 3, 4].includes(componentes) || b[offset + 2] !== 8) {
          return noDisponible('SOF JPEG inválido');
        }
        return dimensiones('image/jpeg', v.getUint16(offset + 5), v.getUint16(offset + 3));
      }
      // Otras familias SOF no se interpretan ni se envían al decoder.
      if (marcador >= 195 && marcador <= 207 && ![196, 200, 204].includes(marcador)) return noDisponible('SOF JPEG no soportado');
      offset += largo;
    }
    return noDisponible('Dimensiones JPEG fuera de la cabecera acotada');
  }
  if (b.length >= 20 && ascii(0, 'RIFF') && ascii(8, 'WEBP')) {
    if (v.getUint32(4, true) + 8 !== size) return noDisponible('Longitud RIFF inválida');
    let offset = 12;
    let extendida: { ancho: number; alto: number } | undefined;
    while (offset + 8 <= b.length) {
      const largo = v.getUint32(offset + 4, true);
      const datos = offset + 8;
      if (datos + largo > size) return noDisponible('Chunk WebP truncado');
      if (ascii(offset, 'VP8X')) {
        if (offset !== 12 || largo !== 10 || datos + 10 > b.length || (b[datos] & 0xc3) !== 0
          || b[datos + 1] || b[datos + 2] || b[datos + 3]) return noDisponible('VP8X inválido o animado');
        extendida = { ancho: u24(datos + 4) + 1, alto: u24(datos + 7) + 1 };
        const control = dimensiones('image/webp', extendida.ancho, extendida.alto);
        if (control.tipo === 'no-disponible') return control;
      } else if (ascii(offset, 'VP8 ') || ascii(offset, 'VP8L')) {
        let ancho: number; let alto: number;
        if (ascii(offset, 'VP8 ')) {
          if (largo < 10 || datos + 10 > b.length || (b[datos] & 1) !== 0
            || !coincide(datos + 3, [157, 1, 42])) return noDisponible('VP8 inválido');
          ancho = v.getUint16(datos + 6, true) & 16383; alto = v.getUint16(datos + 8, true) & 16383;
        } else {
          if (largo < 5 || datos + 5 > b.length || b[datos] !== 47 || (b[datos + 4] & 224)) return noDisponible('VP8L inválido');
          const bits = v.getUint32(datos + 1, true); ancho = (bits & 16383) + 1; alto = ((bits >>> 14) & 16383) + 1;
        }
        if (extendida && (ancho !== extendida.ancho || alto !== extendida.alto)) return noDisponible('Dimensiones WebP contradictorias');
        return dimensiones('image/webp', ancho, alto);
      } else if (ascii(offset, 'ANIM') || ascii(offset, 'ANMF')) return noDisponible('WebP animado no soportado');
      offset = datos + largo + (largo % 2);
    }
    return noDisponible('Dimensiones WebP fuera de la cabecera acotada');
  }
  return noDisponible('Formato sin previsualización segura');
}
async function decodificarNativa(blob: Blob): Promise<ImagenDecodificada> {
  if (typeof globalThis.createImageBitmap !== 'function') throw new Error('El navegador no ofrece un decoder de imágenes seguro');
  // El decoder aplica EXIF disponible. No se lee GPS ni se vuelve a rotar el resultado.
  const bitmap = await createImageBitmap(blob, { imageOrientation: 'from-image' });
  return { ancho: bitmap.width, alto: bitmap.height, fuente: bitmap, cerrar: () => bitmap.close() };
}
function lienzoNativo(ancho: number, alto: number): LienzoMiniatura {
  if (typeof OffscreenCanvas === 'function') {
    const lienzo = new OffscreenCanvas(ancho, alto);
    const contexto = lienzo.getContext('2d');
    if (!contexto) { lienzo.width = 0; lienzo.height = 0; throw new Error('Canvas no disponible'); }
    return { dibujar: (fuente) => contexto.drawImage(fuente, 0, 0, ancho, alto),
      png: () => lienzo.convertToBlob({ type: 'image/png' }), liberar: () => { lienzo.width = 0; lienzo.height = 0; } };
  }
  if (typeof document === 'undefined') throw new Error('Canvas no disponible');
  const lienzo = document.createElement('canvas'); lienzo.width = ancho; lienzo.height = alto;
  const contexto = lienzo.getContext('2d');
  if (!contexto) { lienzo.width = 0; lienzo.height = 0; throw new Error('Canvas no disponible'); }
  return { dibujar: (fuente) => contexto.drawImage(fuente, 0, 0, ancho, alto),
    png: () => new Promise((ok, no) => lienzo.toBlob((b) => b ? ok(b) : no(new Error('toBlob no produjo PNG')), 'image/png')),
    liberar: () => { lienzo.width = 0; lienzo.height = 0; } };
}
/** Instancia lazy: generar solo al abrir la sección, DESPUÉS de guardar el original.
 * Serializa decode y canvas, incluso tras error/noop/abort. No hay latch de promesa resuelta.
 * No crea ObjectURLs, elementos img, red ni IO durante importación. */
export function crearMiniatura(opciones: OpcionesMiniatura = {}): MotorMiniatura {
  let cerrado = false;
  let cola: Promise<void> = Promise.resolve();
  const decodificar = opciones.decodificar ?? decodificarNativa;
  const crearLienzo = opciones.crearLienzo ?? lienzoNativo;
  const activo = new AbortController();
  return {
    cerrar: () => { cerrado = true; activo.abort(); },
    generar: (original, presentacion = {}) => {
      const comprobar = () => {
        if (cerrado || activo.signal.aborted || presentacion.senal?.aborted) throw new DOMException('Miniatura cancelada', 'AbortError');
      };
      const trabajo = async (): Promise<MiniaturaImagen> => {
        comprobar();
        const ladoCss = presentacion.ladoCss ?? 256; const dpr = presentacion.dpr ?? 1;
        if (!Number.isFinite(ladoCss) || ladoCss <= 0 || !Number.isFinite(dpr) || dpr <= 0) throw new Error('Presentación de miniatura inválida');
        const lado = Math.max(1, Math.min(LIMITES_IMAGEN.ladoSalida, Math.round(Math.min(ladoCss, LIMITES_IMAGEN.ladoSalida)
          * Math.min(dpr, LIMITES_IMAGEN.dpr))));
        const inspeccion = await inspeccionarImagen(original); comprobar();
        if (inspeccion.tipo === 'no-disponible') return inspeccion;
        let imagen: ImagenDecodificada | undefined; let lienzo: LienzoMiniatura | undefined;
        try {
          // MIME identificado para el decoder, no el tipo declarado del File. Los bytes originales no cambian.
          const entrada = Blob.prototype.slice.call(original, 0, tamanoBlob(original), inspeccion.mime);
          imagen = await decodificar(entrada); comprobar();
          const validacion = dimensiones(inspeccion.mime, imagen.ancho, imagen.alto);
          if (validacion.tipo === 'no-disponible' || !((imagen.ancho === inspeccion.ancho && imagen.alto === inspeccion.alto)
            || (imagen.ancho === inspeccion.alto && imagen.alto === inspeccion.ancho))) throw new Error('Dimensiones decodificadas incompatibles');
          const escala = Math.min(1, lado / Math.max(imagen.ancho, imagen.alto));
          const ancho = Math.max(1, Math.round(imagen.ancho * escala)); const alto = Math.max(1, Math.round(imagen.alto * escala));
          lienzo = crearLienzo(ancho, alto); lienzo.dibujar(imagen.fuente); comprobar();
          const blob = await lienzo.png(); comprobar();
          if (tamanoBlob(blob) <= 0 || tipoBlob(blob) !== 'image/png') throw new Error('Canvas no produjo PNG');
          return { tipo: 'lista', blob, ancho, alto };
        } finally {
          try { lienzo?.liberar(); } finally { imagen?.cerrar(); }
        }
      };
      const siguiente = cola.then(trabajo);
      cola = siguiente.then(() => {}, () => {});
      return siguiente;
    },
  };
}
