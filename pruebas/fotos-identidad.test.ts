import { IDBFactory } from 'fake-indexeddb';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { itinerario } from '../src/datos/itinerario';
import { crearCapturaFoto } from '../src/fotos';
import { abrirFotosLocal } from '../src/fotos-local';
import { BLOQUE_IDENTIDAD_FOTO, mismosMetadatosOriginal, compararOriginalesFoto, comprobarIdentidadFoto,
  type LecturasIdentidadFoto } from '../src/fotos-identidad';

const fotoId = '12345678-1234-4123-8123-123456789abc';
const destino = { tipo: 'parada' as const, viajeId: itinerario.id, paradaId: itinerario.dias[0].paradas[0].id };
function captura(bytes = new Uint8Array([0, 255, 7])) {
  return crearCapturaFoto(itinerario, destino, new File([bytes], '\0 e\u0301 ',
    { type: 'image/heic', lastModified: 17 }), 29, { uuid: () => fotoId });
}
const meta = () => captura().metadatos;
const cierres: (() => void)[] = [];
afterEach(() => { vi.restoreAllMocks(); cierres.splice(0).forEach((cerrar) => cerrar()); });
function puerto(m: unknown = meta(), b: unknown = captura().original): LecturasIdentidadFoto {
  return { leerMetadatos: vi.fn(async () => m), leerOriginal: vi.fn(async () => b) };
}
const comprobar = (p: LecturasIdentidadFoto, m: unknown = meta(), b: unknown = captura().original) =>
  comprobarIdentidadFoto(itinerario, p, m, b);

describe('metadata original: identidad exacta, no equivalencia normalizada', () => {
  it('positivo completo y miniatura derivada válida no cambia identidad', () => {
    const a = meta();
    for (const miniatura of [{ tipo: 'pendiente' }, { tipo: 'fallida', motivo: 'Error' },
      { tipo: 'lista', bytes: 3, ancho: 2, alto: 1, mime: 'image/png' }]) {
      expect(mismosMetadatosOriginal(itinerario, a, { ...a, miniatura })).toBe(true);
    }
  });
  it.each([
    ['formato', 2], ['fotoId', fotoId.toUpperCase()], ['nombre', '\0 é '], ['nombre', ' e\u0301 '],
    ['mimeDeclarado', 'image/png'], ['ultimaModificacion', 18], ['incorporada', 30], ['bytesOriginal', 4],
  ])('rechaza diferencia original en %s (%s)', (campo, valor) => {
    const a = meta();
    expect(mismosMetadatosOriginal(itinerario, a, { ...a, [campo]: valor })).toBe(false);
  });
  it.each(['ultimaModificacion', 'incorporada', 'bytesOriginal'])('Object.is distingue -0 y 0 en %s', (campo) => {
    expect(mismosMetadatosOriginal(itinerario, { ...meta(), [campo]: -0 }, { ...meta(), [campo]: 0 })).toBe(false);
  });
  it('distingue tipo, viaje, padre e hijo; no admite hijo bajo padre ajeno', () => {
    const padre = itinerario.dias.flatMap((d) => d.paradas).find((p) => (p.subparadas?.length ?? 0) > 1)!;
    const a = { ...meta(), destino: { tipo: 'subparada', viajeId: itinerario.id,
      paradaId: padre.id, subparadaId: padre.subparadas![0].id } };
    expect(mismosMetadatosOriginal(itinerario, a, a)).toBe(true);
    for (const d of [{ ...a.destino, tipo: 'parada' }, { ...a.destino, viajeId: 'extranjero' },
      { ...a.destino, paradaId: destino.paradaId }, { ...a.destino, subparadaId: padre.subparadas![1].id },
      { ...destino }, { ...destino, paradaId: itinerario.dias[0].paradas[1].id }]) {
      expect(mismosMetadatosOriginal(itinerario, a, { ...a, destino: d })).toBe(false);
    }
  });
  it('getter inválido nunca se ejecuta y propios no enumerables válidos se materializan', async () => {
    const a = meta(); let invocaciones = 0;
    for (const malo of [{ ...a, get nombre() { invocaciones++; return a.nombre; } },
      { ...a, destino: { ...destino, get viajeId() { invocaciones++; return itinerario.id; } } },
      { ...a, miniatura: { get tipo() { invocaciones++; return 'pendiente'; } } }]) {
      expect(mismosMetadatosOriginal(itinerario, a, malo)).toBe(false);
      const p = puerto(); expect((await comprobar(p, malo)).tipo).toBe('incierta');
      expect(p.leerMetadatos).not.toHaveBeenCalled();
    }
    const oculto = { ...a, destino: { ...destino } };
    Object.defineProperty(oculto, 'nombre', { value: a.nombre, enumerable: false });
    Object.defineProperty(oculto.destino, 'paradaId', { value: destino.paradaId, enumerable: false });
    expect(mismosMetadatosOriginal(itinerario, a, oculto)).toBe(true);
    expect(await comprobar(puerto(oculto), oculto)).toEqual({ tipo: 'misma', metadatos: a });
    expect(invocaciones).toBe(0);
  });
  it.each([null, { ...meta(), miniatura: { tipo: 'lista', bytes: 0, ancho: 1, alto: 1, mime: 'image/png' } },
    { ...meta(), extra: 1 }, { formato: 1, tipo: 'borrada', fotoId }])('malformado o tombstone nunca es igual: %s', (m) => {
    expect(mismosMetadatosOriginal(itinerario, meta(), m)).toBe(false);
  });
});

describe('Blob nativo: todos los bytes, bloques acotados e intrínsecos', () => {
  it('vacío positivo, última fracción y último byte distinto con mismo size y MIME', async () => {
    expect(await compararOriginalesFoto(new Blob([]), new Blob([]))).toEqual({ tipo: 'iguales' });
    const a = new Uint8Array(2 * BLOQUE_IDENTIDAD_FOTO + 13); a.fill(7);
    const b = a.slice(); b[b.length - 1] = 8;
    const blob = new Blob([a], { type: 'image/heic' });
    expect(await compararOriginalesFoto(blob, new Blob([a], { type: blob.type }))).toEqual({ tipo: 'iguales' });
    expect(await compararOriginalesFoto(blob, new Blob([b], { type: blob.type }))).toEqual({ tipo: 'distintos' });
  });
  it('ignora size/type/slice/arrayBuffer propios falsificados sin invocarlos', async () => {
    const a = captura().original; let n = 0;
    for (const clave of ['size', 'type', 'slice', 'arrayBuffer']) {
      Object.defineProperty(a, clave, { get() { n++; throw new Error('No leer propios'); } });
    }
    expect(await compararOriginalesFoto(a, captura().original)).toEqual({ tipo: 'iguales' });
    expect((await comprobar(puerto(meta(), a), meta(), a)).tipo).toBe('misma');
    expect(n).toBe(0);
  });
  it('brand falso no se confunde con Blob ni ejecuta métodos propios', async () => {
    const falso = { size: 3, type: 'image/heic', arrayBuffer: vi.fn(), slice: vi.fn() };
    expect((await compararOriginalesFoto(falso, captura().original)).tipo).toBe('incierta');
    expect(falso.arrayBuffer).not.toHaveBeenCalled(); expect(falso.slice).not.toHaveBeenCalled();
  });
  it('tamaño/MIME diferente no lee bloques', async () => {
    const leer = vi.spyOn(Blob.prototype, 'arrayBuffer');
    expect(await compararOriginalesFoto(new Blob(['a']), new Blob(['aa']))).toEqual({ tipo: 'distintos' });
    expect(await compararOriginalesFoto(new Blob(['a']), new Blob(['a'], { type: 'image/png' }))).toEqual({ tipo: 'distintos' });
    expect(leer).not.toHaveBeenCalled();
  });
  it('bloques de 1 MiB, dos lecturas activas como máximo; corta tras primera diferencia', async () => {
    expect(BLOQUE_IDENTIDAD_FOTO).toBe(1 << 20);
    const intrinseco = Blob.prototype.arrayBuffer;
    const tamanos: number[] = []; let activas = 0; let maximo = 0;
    const leer = vi.spyOn(Blob.prototype, 'arrayBuffer').mockImplementation(async function (this: Blob) {
      tamanos.push(this.size); activas++; maximo = Math.max(maximo, activas);
      try { return await intrinseco.call(this); } finally { activas--; }
    });
    const a = new Uint8Array(2 * BLOQUE_IDENTIDAD_FOTO + 1);
    expect(await compararOriginalesFoto(new Blob([a]), new Blob([a]))).toEqual({ tipo: 'iguales' });
    expect(tamanos).toEqual([BLOQUE_IDENTIDAD_FOTO, BLOQUE_IDENTIDAD_FOTO,
      BLOQUE_IDENTIDAD_FOTO, BLOQUE_IDENTIDAD_FOTO, 1, 1]);
    expect(maximo).toBeLessThanOrEqual(2); leer.mockClear();
    const b = a.slice(); b[0] = 1;
    expect(await compararOriginalesFoto(new Blob([a]), new Blob([b]))).toEqual({ tipo: 'distintos' });
    expect(leer).toHaveBeenCalledTimes(2);
  });
  it('frontera exacta de 1 MiB y lectura intrínseca incompleta no producen falso igual', async () => {
    const datos = new Uint8Array(BLOQUE_IDENTIDAD_FOTO);
    const a = new Blob([datos]);
    expect(await compararOriginalesFoto(a, new Blob([datos]))).toEqual({ tipo: 'iguales' });
    datos[datos.length - 1] = 1;
    expect(await compararOriginalesFoto(a, new Blob([datos]))).toEqual({ tipo: 'distintos' });
    vi.spyOn(Blob.prototype, 'arrayBuffer').mockResolvedValue(new ArrayBuffer(0));
    expect((await compararOriginalesFoto(a, a)).tipo).toBe('incierta');
  });
  it('fallo de lectura conserva incertidumbre, nunca falso igual o diferente', async () => {
    vi.spyOn(Blob.prototype, 'arrayBuffer').mockRejectedValue(new Error('Disco ilegible'));
    expect((await compararOriginalesFoto(captura().original, captura().original)).tipo).toBe('incierta');
    expect((await comprobar(puerto())).tipo).toBe('incierta');
  });
});

describe('puerto de lecturas: metadata → original → metadata fresca', () => {
  it('mismo original completo positivo; última diferencia no confirma otra captura bajo el UUID', async () => {
    const p = puerto(); expect((await comprobar(p)).tipo).toBe('misma');
    expect(p.leerMetadatos).toHaveBeenCalledTimes(2); expect(p.leerOriginal).toHaveBeenCalledWith(fotoId);
    const b = new Blob([new Uint8Array([0, 255, 8])], { type: 'image/heic' });
    expect((await comprobar(puerto(), meta(), b)).tipo).toBe('otra');
  });
  it('valida metadata y tamaño/tipo/brand del original del llamador ANTES de IO', async () => {
    for (const b of [null, {}, new Blob(['xx'], { type: 'image/heic' }), new Blob(['abc'], { type: 'image/png' })]) {
      const p = puerto(); expect((await comprobar(p, meta(), b)).tipo).toBe('incierta');
      expect(p.leerMetadatos).not.toHaveBeenCalled(); expect(p.leerOriginal).not.toHaveBeenCalled();
    }
  });
  it('ausente y otra metadata válida son distintos de corrupción y error', async () => {
    expect(await comprobar(puerto(null))).toEqual({ tipo: 'ausente' });
    expect(await comprobar(puerto({ ...meta(), nombre: 'otra' }))).toEqual({ tipo: 'otra' });
    for (const m of [{ ...meta(), formato: 2 }, { ...meta(), destino: { ...destino, viajeId: 'otro' } },
      { formato: 1, fotoId: fotoId.toUpperCase(), tipo: 'borrada' }]) {
      expect((await comprobar(puerto(m))).tipo).toBe('incierta');
    }
    const p = puerto(); vi.mocked(p.leerMetadatos).mockRejectedValue(new Error('Lectura falló'));
    expect((await comprobar(p)).tipo).toBe('incierta');
  });
  it.each([null, {}, new Blob(['abc'], { type: 'image/png' }), new Blob(['xx'], { type: 'image/heic' })])(
    'original guardado ausente/corrupto no prueba igualdad (%s)', async (b) => {
      expect((await comprobar(puerto(meta(), b))).tipo).toBe('incierta');
    });
  it('fallo de lectura de original o final no es otra ni misma', async () => {
    const p = puerto(); vi.mocked(p.leerOriginal).mockRejectedValue(new Error('IDB cerrada'));
    expect((await comprobar(p)).tipo).toBe('incierta');
    const q = puerto(); vi.mocked(q.leerMetadatos).mockResolvedValueOnce(meta()).mockRejectedValueOnce(new Error('Final falló'));
    expect((await comprobar(q)).tipo).toBe('incierta');
  });
  it.each(['inicial', 'intermedia', 'final'])('tombstone %s es explícito, nunca SAME', async (fase) => {
    const borrada = { formato: 1, fotoId, tipo: 'borrada' }; const p = puerto();
    vi.mocked(p.leerMetadatos).mockResolvedValueOnce(fase === 'inicial' ? borrada : meta()).mockResolvedValue(borrada);
    if (fase === 'intermedia') vi.mocked(p.leerOriginal).mockResolvedValue(null);
    expect(await comprobar(p)).toEqual({ tipo: 'borrada', fotoId });
  });
  it.each([null, { ...meta(), nombre: 'cambió' }, { ...meta(), formato: 99 }])(
    'metadata final cambiada no confirma igualdad (%s)', async (final) => {
      const p = puerto(); vi.mocked(p.leerMetadatos).mockResolvedValueOnce(meta()).mockResolvedValueOnce(final);
      expect((await comprobar(p)).tipo).toBe('incierta');
    });
  it('permite miniatura final válida y devuelve snapshot independiente', async () => {
    const final = { ...meta(), miniatura: { tipo: 'fallida' as const, motivo: 'Sin decoder' } };
    const p = puerto(); vi.mocked(p.leerMetadatos).mockResolvedValueOnce(meta()).mockResolvedValueOnce(final);
    const r = await comprobar(p); expect(r).toEqual({ tipo: 'misma', metadatos: final });
    final.miniatura.motivo = 'Mutación posterior';
    if (r.tipo !== 'misma') throw new Error('Sin prueba positiva');
    expect(r.metadatos.miniatura).toEqual({ tipo: 'fallida', motivo: 'Sin decoder' });
  });
  it('snapshot del llamador y del almacén antes de await evita retargeting mutable', async () => {
    const esperada = structuredClone(meta()); const leida = structuredClone(meta());
    const p = puerto(leida);
    vi.mocked(p.leerOriginal).mockImplementation(async (id) => {
      expect(id).toBe(fotoId);
      Object.assign(esperada, { fotoId: fotoId.toUpperCase(), nombre: 'otra' });
      Object.assign(esperada.destino, { paradaId: 'ajena' }); Object.assign(leida, { nombre: 'otra' });
      return captura().original;
    });
    vi.mocked(p.leerMetadatos).mockResolvedValueOnce(leida).mockResolvedValueOnce(meta());
    expect((await comprobar(p, esperada)).tipo).toBe('misma');
    expect(p.leerMetadatos).toHaveBeenNthCalledWith(2, fotoId);
  });
});

describe('biblioteca real fotos-local y Node Blob con fake IDB (sin ACK remoto)', () => {
  it('corrupción persistida da incertidumbre y conserva bytes sin reparar', async () => {
    const fabrica = new IDBFactory();
    const lib = await abrirFotosLocal(itinerario, { fabrica, nombre: 'corrupta' }); cierres.push(lib.cerrar);
    const a = captura(); await lib.guardarOriginal(a);
    const db = await new Promise<IDBDatabase>((ok, no) => {
      const s = fabrica.open('corrupta'); s.onsuccess = () => ok(s.result); s.onerror = () => no(s.error);
    });
    cierres.push(() => db.close());
    await new Promise<void>((ok, no) => {
      const tx = db.transaction('metadatos', 'readwrite');
      tx.objectStore('metadatos').put({ ...a.metadatos, formato: 99 }, fotoId);
      tx.oncomplete = () => ok(); tx.onabort = () => no(tx.error);
    });
    expect((await comprobar(lib, a.metadatos, a.original)).tipo).toBe('incierta');
    const guardado = await new Promise<Blob>((ok, no) => {
      const s = db.transaction('originales').objectStore('originales').get(fotoId);
      s.onsuccess = () => ok(s.result); s.onerror = () => no(s.error);
    });
    expect(await compararOriginalesFoto(guardado, a.original)).toEqual({ tipo: 'iguales' });
    await expect(lib.leerMetadatos(fotoId)).rejects.toThrow('corruptos');
  });
  it('commit con respuesta perdida: atestación local positiva, colisión siempre rechazada', async () => {
    const fabrica = new IDBFactory(); const lib = await abrirFotosLocal(itinerario, { fabrica, nombre: 'identidad' });
    cierres.push(lib.cerrar); const a = captura();
    await lib.guardarOriginal(a); // Se descarta deliberadamente la respuesta, no se simula el commit.
    lib.cerrar(); const nueva = await abrirFotosLocal(itinerario, { fabrica, nombre: 'identidad' }); cierres.push(nueva.cerrar);
    expect((await comprobar(nueva, a.metadatos, a.original)).tipo).toBe('misma');
    await expect(nueva.guardarOriginal(a)).rejects.toThrow('Colisión');
    const b = captura(new Uint8Array([0, 255, 8]));
    expect((await comprobar(nueva, b.metadatos, b.original)).tipo).toBe('otra');
    await expect(nueva.guardarOriginal(b)).rejects.toThrow('Colisión');
    expect(await compararOriginalesFoto((await nueva.leerOriginal(fotoId))!, a.original)).toEqual({ tipo: 'iguales' });
    await nueva.registrarFalloMiniatura(fotoId, 'No disponible');
    expect((await comprobar(nueva, a.metadatos, a.original)).tipo).toBe('misma');
    await nueva.borrarLocal(fotoId);
    expect(await comprobar(nueva, a.metadatos, a.original)).toEqual({ tipo: 'borrada', fotoId });
  });
});
