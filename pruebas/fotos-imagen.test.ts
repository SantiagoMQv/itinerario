import { describe, expect, it, vi } from 'vitest';
import { inspeccionarImagen, crearMiniatura, LIMITES_IMAGEN } from '../src/fotos-imagen';

function png(ancho = 12, alto = 24) {
  const b = new Uint8Array(33); b.set([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82]);
  const v = new DataView(b.buffer); v.setUint32(16, ancho); v.setUint32(20, alto); b[24] = 8; b[25] = 6;
  return new Blob([b], { type: 'text/html' });
}
describe('previsualización acotada, nunca valida por extensión o MIME declarado', () => {
  it('identifica PNG por estructura y dimensions, independientemente del MIME', async () => {
    expect(await inspeccionarImagen(png())).toEqual({ tipo: 'identificada', mime: 'image/png', ancho: 12, alto: 24 });
  });
  it('no decodifica activos, desconocidos, dimensiones cero ni exceso de píxeles', async () => {
    const decodificar = vi.fn(); const motor = crearMiniatura({ decodificar });
    for (const blob of [new Blob(['<svg onload="alert(1)"/>'], { type: 'image/png' }), png(0, 2), png(8000, 8000)]) {
      expect((await motor.generar(blob)).tipo).toBe('no-disponible');
    }
    expect(decodificar).not.toHaveBeenCalled(); motor.cerrar();
  });
  it('lectura de cabecera nunca supera presupuesto aunque el Blob sea grande', async () => {
    const slice = vi.spyOn(Blob.prototype, 'slice');
    await inspeccionarImagen(new Blob([new Uint8Array(1024 * 1024)]));
    expect(slice).toHaveBeenCalledTimes(1);
    expect(slice.mock.calls[0].slice(0, 2)).toEqual([0, LIMITES_IMAGEN.bytesCabecera]); slice.mockRestore();
  });
  it('JPEG SOF y WebP VP8/VP8L/VP8X verifican dimensiones estructurales', async () => {
    const jpeg = new Uint8Array([255, 216, 255, 224, 0, 4, 0, 0, 255, 192, 0, 11, 8, 0, 24, 0, 12, 1, 1, 17, 0]);
    expect(await inspeccionarImagen(new Blob([jpeg]))).toEqual({ tipo: 'identificada', mime: 'image/jpeg', ancho: 12, alto: 24 });
    function webp(tipo: string, datos: number[], extendida = false) {
      const inicio = extendida ? 30 : 12;
      const b = new Uint8Array(inicio + 8 + datos.length + (datos.length % 2));
      const v = new DataView(b.buffer); const texto = (offset: number, s: string) => b.set(Array.from(s, (c) => c.charCodeAt(0)), offset);
      texto(0, 'RIFF'); texto(8, 'WEBP'); v.setUint32(4, b.length - 8, true);
      if (extendida) { texto(12, 'VP8X'); v.setUint32(16, 10, true); b[24] = 11; b[27] = 23; }
      texto(inicio, tipo); v.setUint32(inicio + 4, datos.length, true); b.set(datos, inicio + 8); return new Blob([b]);
    }
    const vp8 = [0, 0, 0, 157, 1, 42, 12, 0, 24, 0];
    const bits = 11 | (23 << 14);
    const vp8l = [47, bits & 255, (bits >>> 8) & 255, (bits >>> 16) & 255, (bits >>> 24) & 255];
    for (const blob of [webp('VP8 ', vp8), webp('VP8L', vp8l), webp('VP8 ', vp8, true)]) {
      expect(await inspeccionarImagen(blob)).toEqual({ tipo: 'identificada', mime: 'image/webp', ancho: 12, alto: 24 });
    }
  });
  it('EXIF grande/cabecera truncada/SOS antes de SOF no habilitan decoder', async () => {
    const grande = new Uint8Array(LIMITES_IMAGEN.bytesCabecera + 50);
    grande.set([255, 216, 255, 225, 255, 255]);
    grande.set([255, 225, 255, 255], 65539);
    const decodificar = vi.fn(); const motor = crearMiniatura({ decodificar });
    for (const b of [grande, new Uint8Array([255, 216, 255, 218, 0, 2]), new Uint8Array([255, 216, 255, 192, 0, 1])]) {
      expect((await motor.generar(new Blob([b]))).tipo).toBe('no-disponible');
    }
    expect(decodificar).not.toHaveBeenCalled();
  });
  it('32 MP entra y 32 MP + 1 píxel no; ningún canvas se crea antes de validar', async () => {
    expect((await inspeccionarImagen(png(8000, 4000))).tipo).toBe('identificada');
    expect((await inspeccionarImagen(png(8001, 4000))).tipo).toBe('no-disponible');
    const decodificar = vi.fn(); const crearLienzo = vi.fn();
    await crearMiniatura({ decodificar, crearLienzo }).generar(png(8001, 4000));
    expect(decodificar).not.toHaveBeenCalled(); expect(crearLienzo).not.toHaveBeenCalled();
  });
  it('DPR/edge acotados, MIME derivado y orientación del decoder sin doble rotación', async () => {
    const cerrar = vi.fn(); const liberar = vi.fn(); let tipo = '';
    const crearLienzo = vi.fn(() => ({ dibujar: () => {}, liberar, png: async () => new Blob(['png'], { type: 'image/png' }) }));
    const motor = crearMiniatura({ decodificar: async (b) => { tipo = b.type;
      return { ancho: 2000, alto: 4000, fuente: {} as CanvasImageSource, cerrar }; }, crearLienzo });
    const salida = await motor.generar(png(4000, 2000), { ladoCss: 800, dpr: 10 });
    expect(salida).toMatchObject({ tipo: 'lista', ancho: 512, alto: 1024 });
    expect(tipo).toBe('image/png'); expect(crearLienzo).toHaveBeenCalledWith(512, 1024);
    expect(cerrar).toHaveBeenCalledTimes(1); expect(liberar).toHaveBeenCalledTimes(1);
  });
  it('una decodificación a la vez; failure/noop no deja latch y se puede seguir', async () => {
    let activas = 0; let maximo = 0;
    const motor = crearMiniatura({ decodificar: async () => {
      activas++; maximo = Math.max(maximo, activas); await Promise.resolve();
      return { ancho: 12, alto: 24, fuente: {} as CanvasImageSource, cerrar: () => { activas--; } };
    }, crearLienzo: () => ({ dibujar: () => {}, liberar: () => {}, png: async () => new Blob(['p'], { type: 'image/png' }) }) });
    const salidas = await Promise.all([motor.generar(png()), motor.generar(new Blob(['opaco'])), motor.generar(png())]);
    expect(salidas.map((s) => s.tipo)).toEqual(['lista', 'no-disponible', 'lista']); expect(maximo).toBe(1); expect(activas).toBe(0);
  });
  it('cancelación durante decode libera bitmap y no crea canvas; retry funciona', async () => {
    const abortar = new AbortController(); const cerrar = vi.fn(); const crearLienzo = vi.fn();
    const motor = crearMiniatura({ decodificar: async () => { abortar.abort();
      return { ancho: 12, alto: 24, fuente: {} as CanvasImageSource, cerrar }; }, crearLienzo });
    await expect(motor.generar(png(), { senal: abortar.signal })).rejects.toThrow('cancelada');
    expect(cerrar).toHaveBeenCalledTimes(1); expect(crearLienzo).not.toHaveBeenCalled();
    const opaco = await motor.generar(new Blob(['opaco'])); expect(opaco.tipo).toBe('no-disponible');
    motor.cerrar(); await expect(motor.generar(png())).rejects.toThrow('cancelada');
  });
  it.each(['dibujar', 'png', 'cerrar'] as const)('libera recursos al fallar %s y no usa ObjectURL', async (paso) => {
    const cerrar = vi.fn(); const liberar = vi.fn();
    const motor = crearMiniatura({ decodificar: async () => ({ ancho: 12, alto: 24, fuente: {} as CanvasImageSource, cerrar }),
      crearLienzo: () => ({ liberar, dibujar: () => { if (paso === 'dibujar') throw new Error('dibujar'); },
        png: async () => { if (paso === 'cerrar') motor.cerrar();
          if (paso === 'png') return new Blob([]); return new Blob(['p'], { type: 'image/png' }); } }) });
    const url = vi.spyOn(URL, 'createObjectURL');
    await expect(motor.generar(png())).rejects.toThrow();
    expect(cerrar).toHaveBeenCalledTimes(1); expect(liberar).toHaveBeenCalledTimes(1); expect(url).not.toHaveBeenCalled(); url.mockRestore();
  });
  it('libera bitmap y canvas si codificar PNG falla, y la cola permite reintentar', async () => {
    const cerrar = vi.fn(); const liberar = vi.fn(); let llamadas = 0;
    const motor = crearMiniatura({ decodificar: async () => ({ ancho: 12, alto: 24, fuente: {} as CanvasImageSource, cerrar }),
      crearLienzo: () => ({ dibujar: () => {}, liberar, png: async () => {
        if (++llamadas === 1) throw new Error('toBlob falló'); return new Blob(['png'], { type: 'image/png' });
      } }) });
    await expect(motor.generar(png())).rejects.toThrow('toBlob falló');
    expect((await motor.generar(png())).tipo).toBe('lista');
    expect(cerrar).toHaveBeenCalledTimes(2); expect(liberar).toHaveBeenCalledTimes(2); motor.cerrar();
  });
});
