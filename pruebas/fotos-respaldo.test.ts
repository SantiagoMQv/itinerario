import { describe, expect, it } from 'vitest';
import { itinerario } from '../src/datos/itinerario';
import { crearCapturaFoto } from '../src/fotos';
import { copiarOriginalRespaldo, esReciboRespaldo, copiarReciboRespaldo, esEntradaRespaldo } from '../src/fotos-respaldo';

const fotoId = '12345678-1234-4123-8123-123456789abc';
const operacionId = '22345678-1234-4123-8123-123456789abc';
const captura = crearCapturaFoto(itinerario, { tipo: 'parada', viajeId: itinerario.id,
  paradaId: itinerario.dias[0].paradas[0].id }, new File(['abc'], '\0 e\u0301 ',
  { type: 'image/heic', lastModified: 17 }), -0, { uuid: () => fotoId });
const original = () => copiarOriginalRespaldo(itinerario, captura.metadatos);
const recibo = () => ({ version: 1 as const, tipo: 'acuse-respaldo' as const, viajeId: itinerario.id,
  operacionId, fotoId, original: original(), objetoOriginalDurable: true as const, metadatosDurables: true as const });

describe('contrato puro de respaldo: estructura prometida, no autenticación del proveedor', () => {
  it('materializa identidad sin miniatura ni bytes, conserva nombre y signo', () => {
    const m = original(); expect(Object.hasOwn(m, 'miniatura')).toBe(false);
    expect(Object.is(m.incorporada, -0)).toBe(true); expect(m.nombre).toBe('\0 e\u0301 ');
  });
  it('miniatura derivada válida no altera identidad original', () => {
    expect(copiarOriginalRespaldo(itinerario, { ...captura.metadatos,
      miniatura: { tipo: 'lista', bytes: 12, ancho: 2, alto: 3, mime: 'image/png' } })).toEqual(original());
  });
  it('recibo positivo exige los dos compromisos durables y ámbitos exactos', () => {
    expect(esReciboRespaldo(itinerario, recibo())).toBe(true);
    expect(copiarReciboRespaldo(itinerario, recibo())).toEqual(recibo());
  });
  it.each(['objetoOriginalDurable', 'metadatosDurables'])('no acepta confirmación ausente o falsa: %s', (clave) => {
    const r: Record<string, unknown> = recibo(); delete r[clave];
    expect(esReciboRespaldo(itinerario, r)).toBe(false);
    r[clave] = false; expect(esReciboRespaldo(itinerario, r)).toBe(false);
    r[clave] = 1; expect(esReciboRespaldo(itinerario, r)).toBe(false);
  });
  it.each([
    { version: 2 }, { tipo: 'estado' }, { viajeId: 'otro' }, { operacionId: 'no-uuid' },
    { fotoId: 'otro' }, { etag: 'supuesto' }, { size: 3 }, { original: { fotoId } },
    { objetoOriginalDurable: 'true' },
  ])('rechaza formatos ambiguos o GET/ETag: %j', (cambio) => {
    expect(esReciboRespaldo(itinerario, { ...recibo(), ...cambio })).toBe(false);
  });
  it('no ejecuta getters propios y rechaza prototipos y símbolos', () => {
    let n = 0; const r = recibo();
    Object.defineProperty(r, 'objetoOriginalDurable', { get() { n++; return true; } });
    expect(esReciboRespaldo(itinerario, r)).toBe(false); expect(n).toBe(0);
    expect(esReciboRespaldo(itinerario, Object.assign(Object.create({}), recibo()))).toBe(false);
    expect(esReciboRespaldo(itinerario, { ...recibo(), [Symbol('extra')]: true })).toBe(false);
  });
  it('materializa campos propios no enumerables válidos sin alias del llamador', () => {
    const r = recibo(); Object.defineProperty(r, 'original', { value: r.original, enumerable: false });
    const copia = copiarReciboRespaldo(itinerario, r);
    Object.assign(r.original, { destino: { ...r.original.destino, paradaId: 'otra' } });
    expect(copia.original).toEqual(original());
  });
  it('registro coherente: nunca respaldada sin recibo o sin marcador enviado', () => {
    const base = { formato: 1, fotoId, operacionId, original: original(), fase: 'preparado', enviada: false,
      pausada: false, recibo: null };
    expect(esEntradaRespaldo(itinerario, base)).toBe(true);
    expect(esEntradaRespaldo(itinerario, { ...base, fase: 'respaldada' })).toBe(false);
    expect(esEntradaRespaldo(itinerario, { ...base, fase: 'respaldada', recibo: recibo() })).toBe(false);
    expect(esEntradaRespaldo(itinerario, { ...base, fase: 'enviada', enviada: true })).toBe(true);
    expect(esEntradaRespaldo(itinerario, { ...base, fase: 'respaldada', enviada: true, recibo: recibo() })).toBe(true);
    expect(esEntradaRespaldo(itinerario, { ...base, recibo: recibo() })).toBe(false);
    expect(esEntradaRespaldo(itinerario, { ...base, bytes: new Blob(['abc']) })).toBe(false);
  });
  it('registro y recibo deben coincidir por Object.is, incluso -0', () => {
    const base = { formato: 1, fotoId, operacionId, original: original(), fase: 'respaldada', enviada: true,
      pausada: false, recibo: { ...recibo(), original: { ...original(), incorporada: 0 } } };
    expect(esEntradaRespaldo(itinerario, base)).toBe(false);
  });
});
