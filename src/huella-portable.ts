/** Cadena SHA-256 de bloques, NO SHA-256 del archivo completo ni firma/autoría.
 * Un bloque explícito y cabeceras fijas; Web Crypto puede copiar sus entradas.
 * Este límite lógico no certifica heap, GC, CPU ni dispositivos móviles. */
export const algoritmoHuellaPortable = 'sha256-cadena-bloques-v1' as const;
export interface VinculoPortable {
  readonly algoritmo: typeof algoritmoHuellaPortable;
  readonly bytes: number;
  readonly huella: string;
}
const bloqueBytes = 1048576;
const codificador = new TextEncoder();
const obtenerTamano = Object.getOwnPropertyDescriptor(Blob.prototype, 'size')!.get!;
function cabecera(dominio: string, longitud: number): { bytes: Uint8Array<ArrayBuffer>; vista: DataView; inicio: number } {
  const etiqueta = codificador.encode(dominio);
  const bytes = new Uint8Array(etiqueta.length + longitud);
  bytes.set(etiqueta);
  return { bytes, vista: new DataView(bytes.buffer), inicio: etiqueta.length };
}
/** Fija tamaño nativo y presupuesto antes del primer await. No reintenta ni ofrece fallback.
 * Dominios ASCII terminados en NUL; u32/u64 sin signo big-endian, índices desde cero. */
export async function calcularHuellaPortable(archivo: Blob, maxBytes: number): Promise<VinculoPortable> {
  const n: number = obtenerTamano.call(archivo);
  if (!Number.isSafeInteger(n) || n < 0 || !Number.isSafeInteger(maxBytes) || maxBytes < 0 || n > maxBytes) {
    throw new Error('Huella portable: longitud o presupuesto inválido');
  }
  const k = Math.ceil(n / bloqueBytes);
  if (!Number.isSafeInteger(k)) throw new Error('Huella portable: número de bloques inseguro');
  const sutil = globalThis.crypto?.subtle;
  if (!sutil) throw new Error('Huella portable: Web Crypto no disponible');
  const resumir = async (bytes: Uint8Array<ArrayBuffer>): Promise<Uint8Array<ArrayBuffer>> => {
    const resultado = new Uint8Array(await sutil.digest('SHA-256', bytes));
    if (resultado.length !== 32) throw new Error('Huella portable: digest inválido');
    return resultado;
  };
  const inicial = cabecera('ITINPORT-HUELLA-INICIO\0', 24);
  inicial.vista.setUint32(inicial.inicio, 1);
  inicial.vista.setUint32(inicial.inicio + 4, bloqueBytes);
  inicial.vista.setBigUint64(inicial.inicio + 8, BigInt(n));
  inicial.vista.setBigUint64(inicial.inicio + 16, BigInt(k));
  let estado = await resumir(inicial.bytes);
  for (let i = 0; i < k; i++) {
    const inicio = i * bloqueBytes; const longitud = Math.min(bloqueBytes, n - inicio);
    const trozo = Blob.prototype.slice.call(archivo, inicio, inicio + longitud) as Blob;
    const bloque = new Uint8Array(await Blob.prototype.arrayBuffer.call(trozo));
    if (bloque.length !== longitud) throw new Error('Huella portable: bloque truncado');
    const digest = await resumir(bloque);
    const paso = cabecera('ITINPORT-HUELLA-PASO\0', 76);
    paso.bytes.set(estado, paso.inicio);
    paso.vista.setBigUint64(paso.inicio + 32, BigInt(i));
    paso.vista.setUint32(paso.inicio + 40, longitud);
    paso.bytes.set(digest, paso.inicio + 44);
    estado = await resumir(paso.bytes);
  }
  const cierre = cabecera('ITINPORT-HUELLA-CIERRE\0', 48);
  cierre.bytes.set(estado, cierre.inicio);
  cierre.vista.setBigUint64(cierre.inicio + 32, BigInt(n));
  cierre.vista.setBigUint64(cierre.inicio + 40, BigInt(k));
  const digest = await resumir(cierre.bytes);
  return { algoritmo: algoritmoHuellaPortable, bytes: n,
    huella: Array.from(digest, (byte) => byte.toString(16).padStart(2, '0')).join('') };
}
