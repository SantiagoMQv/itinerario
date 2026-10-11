import { describe, expect, it, vi } from 'vitest';
import { itinerario } from '../src/datos/itinerario';
import { crearCapturaFoto, esDestinoFoto, esMetadatosFoto, esResultadoFoto, esFotoBorrada } from '../src/fotos';

const parada = itinerario.dias[0].paradas[0];
const destino = { tipo: 'parada' as const, viajeId: itinerario.id, paradaId: parada.id };
const uuid = () => '12345678-1234-4123-8123-123456789abc';

describe('dominio de fotos independiente', () => {
  it('conserva identidad, Unicode y metadatos exactos del File sin recodificar', () => {
    const archivo = new File([new Uint8Array([0, 255, 13, 10])], ' 中 e\u0301 .PNG ', { type: 'image/png', lastModified: 17 });
    const captura = crearCapturaFoto(itinerario, destino, archivo, 29, { uuid });
    expect(captura.original).toBe(archivo);
    expect(captura.metadatos).toMatchObject({ fotoId: uuid(), nombre: archivo.name, mimeDeclarado: archivo.type,
      ultimaModificacion: 17, incorporada: 29, bytesOriginal: 4, miniatura: { tipo: 'pendiente' } });
    expect(esMetadatosFoto(itinerario, captura.metadatos)).toBe(true);
  });
  it('rechaza subparada de otro padre aunque exista en el viaje', () => {
    const padre = itinerario.dias.flatMap((d) => d.paradas).find((p) => p.subparadas?.length)!;
    expect(esDestinoFoto(itinerario, { ...destino, tipo: 'subparada', subparadaId: padre.subparadas![0].id })).toBe(false);
    expect(esDestinoFoto(itinerario, { tipo: 'subparada', viajeId: itinerario.id, paradaId: padre.id,
      subparadaId: padre.subparadas![0].id })).toBe(true);
  });
  it('rechaza getters antes de ejecutarlos, símbolos, herencia y campos adicionales', () => {
    let lecturas = 0;
    const getter = { ...destino, get paradaId() { lecturas++; return parada.id; } };
    expect(esDestinoFoto(itinerario, getter)).toBe(false);
    expect(lecturas).toBe(0);
    for (const malo of [{ ...destino, extra: 1 }, { ...destino, [Symbol()]: 1 }, Object.create(destino), []]) {
      expect(esDestinoFoto(itinerario, malo)).toBe(false);
    }
  });
  it('resultado y tombstone tienen variantes exactas sin metadata residual', () => {
    const metadatos = crearCapturaFoto(itinerario, destino, new File(['a'], 'a'), 1, { uuid }).metadatos;
    expect(esResultadoFoto(itinerario, { tipo: 'guardada', metadatos })).toBe(true);
    expect(esResultadoFoto(itinerario, { tipo: 'borrada', fotoId: uuid() })).toBe(true);
    expect(esResultadoFoto(itinerario, { tipo: 'guardada', metadatos, extra: true })).toBe(false);
    expect(esFotoBorrada({ formato: 1, tipo: 'borrada', fotoId: uuid(), nombre: 'a' })).toBe(false);
    expect(esFotoBorrada({ formato: 1, tipo: 'borrada', fotoId: uuid() })).toBe(true);
  });
  it('fallback getRandomValues produce UUID v4 y sin CSPRNG falla sin sustituto', () => {
    const getRandomValues = vi.fn((b: Uint8Array) => { b.fill(0); return b; });
    vi.stubGlobal('crypto', { getRandomValues });
    try {
      expect(crearCapturaFoto(itinerario, destino, new File([], 'a'), 1).metadatos.fotoId).toBe('00000000-0000-4000-8000-000000000000');
      expect(getRandomValues).toHaveBeenCalledTimes(1);
      vi.stubGlobal('crypto', undefined);
      expect(() => crearCapturaFoto(itinerario, destino, new File([], 'a'), 1)).toThrow('criptográfico');
    } finally { vi.unstubAllGlobals(); }
  });
  it('valida cada variante exacta y números seguros sin normalizar valores', () => {
    const meta = crearCapturaFoto(itinerario, destino, new File(['a'], '\u0000 e\u0301 ', { lastModified: -17 }), -0, { uuid }).metadatos;
    expect(Object.is(meta.incorporada, -0)).toBe(true);
    for (const mala of [
      { ...meta, formato: 2 }, { ...meta, bytesOriginal: Infinity }, { ...meta, incorporada: NaN },
      { ...meta, ultimaModificacion: Number.MAX_SAFE_INTEGER + 1 }, { ...meta, bytesOriginal: -1 },
      { ...meta, nombre: new String('a') }, { ...meta, nombre: 'a'.repeat(65537) },
      { ...meta, miniatura: { tipo: 'pendiente', bytes: 0 } },
      { ...meta, miniatura: { tipo: 'fallida', motivo: '' } },
      { ...meta, miniatura: { tipo: 'lista', bytes: 2, ancho: 1025, alto: 1, mime: 'image/png' } },
      { ...meta, miniatura: { tipo: 'lista', bytes: 0, ancho: 1, alto: 1, mime: 'image/png' } },
      { ...meta, miniatura: { tipo: 'lista', bytes: 2, ancho: 1, alto: 1, mime: 'image/jpeg' } },
      { ...meta, destino: { ...destino, viajeId: 'otro' } },
    ]) expect(esMetadatosFoto(itinerario, mala)).toBe(false);
    expect(esMetadatosFoto(itinerario, { ...meta, miniatura: { tipo: 'lista', bytes: 2, ancho: 1024, alto: 1, mime: 'image/png' } })).toBe(true);
  });
  it('rechaza getters anidados sin ejecutarlos y materializa propios no enumerables', () => {
    let lecturas = 0;
    const archivo = new File(['a'], 'a');
    const meta = crearCapturaFoto(itinerario, destino, archivo, 1, { uuid }).metadatos;
    expect(esMetadatosFoto(itinerario, { ...meta, miniatura: { get tipo() { lecturas++; return 'pendiente'; } } })).toBe(false);
    expect(esMetadatosFoto(itinerario, { ...meta, destino: { ...destino, get viajeId() { lecturas++; return itinerario.id; } } })).toBe(false);
    expect(lecturas).toBe(0);
    const noEnumerable = { ...destino };
    Object.defineProperty(noEnumerable, 'paradaId', { value: parada.id, enumerable: false });
    expect(crearCapturaFoto(itinerario, noEnumerable, archivo, 1, { uuid }).metadatos.destino).toEqual(destino);
  });
  it('File con getters propios no sustituye su metadata nativa', () => {
    const archivo = new File(['a'], 'original', { type: 'image/heic', lastModified: 7 });
    let n = 0;
    Object.defineProperty(archivo, 'name', { get: () => { n++; return 'otro'; } });
    expect(crearCapturaFoto(itinerario, destino, archivo, 1, { uuid }).metadatos.nombre).toBe('original');
    expect(n).toBe(0);
  });
  it('usa UUIDv4 criptográfico sin consultar reloj ni Math.random', () => {
    const captura = crearCapturaFoto(itinerario, destino, new File(['a'], 'a'), 1);
    expect(captura.metadatos.fotoId).toMatch(/^[0-9a-f-]{14}4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
  });
  it('rechaza UUID no v4 y números inseguros sin generar identidad sustituta', () => {
    expect(() => crearCapturaFoto(itinerario, destino, new File([], 'a'), NaN, { uuid })).toThrow();
    expect(() => crearCapturaFoto(itinerario, destino, new File([], 'a'), 1, { uuid: () => 'reloj' })).toThrow();
  });
});
