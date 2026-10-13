import { createHash } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { algoritmoHuellaPortable, calcularHuellaPortable } from '../src/huella-portable';
const bloque = 1048576;
// Referencia independiente: Buffer y node:crypto; ningún codificador privado productivo.
function referencia(bytes: Uint8Array): string {
  const u32 = (n: number) => { const b = Buffer.alloc(4); b.writeUInt32BE(n); return b; };
  const u64 = (n: number) => { const b = Buffer.alloc(8); b.writeBigUInt64BE(BigInt(n)); return b; };
  const sha = (...partes: Uint8Array[]) => createHash('sha256').update(Buffer.concat(partes)).digest();
  const k = Math.ceil(bytes.length / bloque);
  let estado = sha(Buffer.from('ITINPORT-HUELLA-INICIO\0'), u32(1), u32(bloque), u64(bytes.length), u64(k));
  for (let i = 0; i < k; i++) {
    const trozo = bytes.subarray(i * bloque, (i + 1) * bloque);
    estado = sha(Buffer.from('ITINPORT-HUELLA-PASO\0'), estado, u64(i), u32(trozo.length), sha(trozo));
  }
  return sha(Buffer.from('ITINPORT-HUELLA-CIERRE\0'), estado, u64(bytes.length), u64(k)).toString('hex');
}
function datos(n: number): Uint8Array<ArrayBuffer> {
  return Uint8Array.from({ length: n }, (_, i) => (i * 31 + Math.floor(i / bloque)) & 255);
}
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });
describe('huella binaria de bloques secuenciales', () => {
  it.each([0, 55, 56, 63, 64, 65, bloque - 1, bloque, bloque + 1, bloque * 3 + 73])
  ('vector independiente completo de %s bytes', async (n) => {
    const bytes = datos(n);
    expect(await calcularHuellaPortable(new Blob([bytes]), n)).toEqual({ algoritmo: algoritmoHuellaPortable,
      bytes: n, huella: referencia(bytes) });
  });
  it('orden, truncamiento y anexado cambian la identidad; presupuesto no la cambia', async () => {
    const a = new Blob([datos(bloque), new Uint8Array(bloque).fill(99)]);
    const original = await calcularHuellaPortable(a, a.size);
    expect(await calcularHuellaPortable(a, a.size + 100)).toEqual(original);
    for (const b of [new Blob([a.slice(bloque), a.slice(0, bloque)]), a.slice(0, -1), new Blob([a, 'x'])]) {
      expect((await calcularHuellaPortable(b, b.size)).huella).not.toBe(original.huella);
    }
  });
  it('lecturas y digests tienen una única operación activa y entradas acotadas', async () => {
    const archivo = new Blob([datos(bloque * 3 + 7)]);
    const leer = Blob.prototype.arrayBuffer; const sutil = crypto.subtle;
    const digest = sutil.digest.bind(sutil);
    let activas = 0; let maxActivas = 0; const lecturas: number[] = []; const entradas: number[] = [];
    const iniciar = () => { maxActivas = Math.max(maxActivas, ++activas); };
    vi.spyOn(Blob.prototype, 'arrayBuffer').mockImplementation(async function (this: Blob) {
      iniciar(); lecturas.push(this.size);
      try { return await leer.call(this); } finally { activas--; }
    });
    vi.spyOn(sutil, 'digest').mockImplementation(async (algoritmo, bytes) => {
      iniciar(); entradas.push(bytes.byteLength);
      try { return await digest(algoritmo, bytes); } finally { activas--; }
    });
    expect((await calcularHuellaPortable(archivo, archivo.size)).huella).toBe(referencia(datos(archivo.size)));
    expect(lecturas).toEqual([bloque, bloque, bloque, 7]);
    expect(maxActivas).toBe(1); expect(activas).toBe(0);
    expect(entradas).toHaveLength(10);
    expect(entradas.every((n) => n <= bloque)).toBe(true);
    expect(entradas.filter((n) => n !== bloque && n !== 7)).toEqual([47, 97, 97, 97, 97, 71]);
  });
  it('vacío no lee bloques y sólo resume inicio y cierre', async () => {
    const leer = vi.spyOn(Blob.prototype, 'arrayBuffer'); const digest = vi.spyOn(crypto.subtle, 'digest');
    await calcularHuellaPortable(new Blob(), 0);
    expect(leer).not.toHaveBeenCalled(); expect(digest).toHaveBeenCalledTimes(2);
  });
  it.each([-1, NaN, Infinity, 0.5, Number.MAX_SAFE_INTEGER + 1, 0])
  ('presupuesto inválido/excesivo %s no lee ni resume', async (maximo) => {
    const leer = vi.spyOn(Blob.prototype, 'arrayBuffer'); const digest = vi.spyOn(crypto.subtle, 'digest');
    await expect(calcularHuellaPortable(new Blob(['a']), maximo)).rejects.toThrow('presupuesto');
    expect(leer).not.toHaveBeenCalled(); expect(digest).not.toHaveBeenCalled();
  });
  it('ignora getters de tamaño, slice y arrayBuffer del archivo; fija presupuesto nativo', async () => {
    const archivo = new Blob(['abc']); const getter = vi.fn(() => 0);
    Object.defineProperty(archivo, 'size', { get: getter });
    Object.defineProperty(archivo, 'slice', { value: () => { throw new Error('no usar'); } });
    Object.defineProperty(archivo, 'arrayBuffer', { value: () => { throw new Error('no usar'); } });
    expect((await calcularHuellaPortable(archivo, 3)).huella).toBe(referencia(new TextEncoder().encode('abc')));
    expect(getter).not.toHaveBeenCalled();
  });
  it('lectura fallida se rechaza una vez sin fallback ni resultado parcial', async () => {
    const leer = vi.spyOn(Blob.prototype, 'arrayBuffer').mockRejectedValue(new Error('lectura fallida'));
    const digest = vi.spyOn(crypto.subtle, 'digest');
    await expect(calcularHuellaPortable(new Blob(['abc']), 3)).rejects.toThrow('lectura fallida');
    expect(leer).toHaveBeenCalledTimes(1); expect(digest).toHaveBeenCalledTimes(1);
  });
  it.each([1, 2, 3, 4])('digest fallido en operación %s no se reintenta', async (operacion) => {
    const sutil = crypto.subtle; const original = sutil.digest.bind(sutil); let cuenta = 0;
    const digest = vi.spyOn(sutil, 'digest').mockImplementation(async (algoritmo, bytes) => {
      if (++cuenta === operacion) throw new Error('digest fallido');
      return original(algoritmo, bytes);
    });
    await expect(calcularHuellaPortable(new Blob(['abc']), 3)).rejects.toThrow('digest fallido');
    expect(digest).toHaveBeenCalledTimes(operacion);
  });
  it('Web Crypto ausente rechaza sin fallback ni lectura', async () => {
    const leer = vi.spyOn(Blob.prototype, 'arrayBuffer'); vi.stubGlobal('crypto', undefined);
    await expect(calcularHuellaPortable(new Blob(['abc']), 3)).rejects.toThrow('Web Crypto');
    expect(leer).not.toHaveBeenCalled();
  });
});
