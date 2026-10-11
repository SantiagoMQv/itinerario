import { IDBFactory, IDBObjectStore } from 'fake-indexeddb';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { abrirFotosLocal } from '../src/fotos-local';
import { crearCapturaFoto } from '../src/fotos';
import { itinerario } from '../src/datos/itinerario';

const destino = { tipo: 'parada' as const, viajeId: itinerario.id, paradaId: itinerario.dias[0].paradas[0].id };
const fotoId = '12345678-1234-4123-8123-123456789abc';
const captura = () => crearCapturaFoto(itinerario, destino, new File([new Uint8Array([0, 255, 7])], ' 中 .heic ',
  { type: 'image/heic', lastModified: 17 }), 21, { uuid: () => fotoId });
const cierres: (() => void)[] = [];
afterEach(() => { vi.restoreAllMocks(); cierres.splice(0).forEach((c) => c()); });
function contexto() {
  const fabrica = new IDBFactory();
  const abrir = async () => {
    const lib = await abrirFotosLocal(itinerario, { fabrica, nombre: 'fotos-prueba' });
    cierres.push(lib.cerrar); return lib;
  };
  return { fabrica, abrir };
}
async function cruda(fabrica: IDBFactory, version = 1): Promise<IDBDatabase> {
  return new Promise((ok, no) => {
    const s = fabrica.open('fotos-prueba', version);
    s.onsuccess = () => { cierres.push(() => s.result.close()); ok(s.result); };
    s.onerror = () => no(s.error);
  });
}
async function sembrar(db: IDBDatabase, tabla: string, valor: unknown) {
  return new Promise<void>((ok, no) => {
    const tx = db.transaction(tabla, 'readwrite'); tx.objectStore(tabla).put(valor, fotoId);
    tx.oncomplete = () => ok(); tx.onabort = () => no(tx.error);
  });
}

describe('IDB de fotos: contratos simulados con fake-indexeddb, no cuota física', () => {
  it('guarda metadata y original intacto juntos, y reapertura conserva bytes', async () => {
    const ctx = contexto(); const lib = await ctx.abrir();
    expect((await lib.guardarOriginal(captura())).tipo).toBe('guardada');
    expect(await lib.listar()).toEqual([captura().metadatos]);
    lib.cerrar(); const nueva = await ctx.abrir();
    expect(Array.from(new Uint8Array(await (await nueva.leerOriginal(fotoId))!.arrayBuffer()))).toEqual([0, 255, 7]);
  });
  it('request success seguido de abort NO confirma guardado y no deja huérfanos', async () => {
    const ctx = contexto(); const lib = await ctx.abrir();
    const agregar = IDBObjectStore.prototype.add;
    vi.spyOn(IDBObjectStore.prototype, 'add').mockImplementation(function (this: IDBObjectStore, ...args) {
      const s = agregar.apply(this, args);
      if (this.name === 'metadatos') s.addEventListener('success', () => this.transaction.abort());
      return s;
    });
    await expect(lib.guardarOriginal(captura())).rejects.toThrow();
    vi.restoreAllMocks(); lib.cerrar(); const nueva = await ctx.abrir();
    expect(await nueva.listar()).toEqual([]); expect(await nueva.leerOriginal(fotoId)).toBeNull();
  });
  it('borrado atómico mínimo, miniatura tardía y reutilización nunca resucitan original', async () => {
    const ctx = contexto(); const a = await ctx.abrir(); const b = await ctx.abrir();
    await a.guardarOriginal(captura()); await b.borrarLocal(fotoId);
    await expect(a.guardarMiniatura(fotoId, new Blob(['png'], { type: 'image/png' }), 1, 1)).rejects.toThrow();
    await expect(a.guardarOriginal(captura())).rejects.toThrow();
    expect(await a.leerOriginal(fotoId)).toBeNull();
    expect(await a.leerMiniatura(fotoId)).toBeNull();
    expect(await a.leerMetadatos(fotoId)).toEqual({ formato: 1, fotoId, tipo: 'borrada' });
  });
  it('colisión conservadora tampoco sobrescribe un original vivo', async () => {
    const lib = await contexto().abrir(); await lib.guardarOriginal(captura());
    await expect(lib.guardarOriginal(captura())).rejects.toThrow();
    expect((await lib.leerOriginal(fotoId))!.size).toBe(3);
  });
  it('listar solo abre cursor metadata, sin cargar originales', async () => {
    const lib = await contexto().abrir(); await lib.guardarOriginal(captura());
    const get = vi.spyOn(IDBObjectStore.prototype, 'get');
    expect((await lib.listar()).length).toBe(1); expect(get).not.toHaveBeenCalled();
  });
  it('cuota SIMULADA en original aborta todo, no confirma ni guarda metadata', async () => {
    const lib = await contexto().abrir(); const agregar = IDBObjectStore.prototype.add;
    vi.spyOn(IDBObjectStore.prototype, 'add').mockImplementation(function (this: IDBObjectStore, ...args) {
      if (this.name === 'originales') throw new DOMException('Cuota simulada', 'QuotaExceededError');
      return agregar.apply(this, args);
    });
    await expect(lib.guardarOriginal(captura())).rejects.toThrow('Cuota simulada');
    vi.restoreAllMocks(); expect(await lib.listar()).toEqual([]);
  });
  it('fallo de miniatura conserva original y un reintento explícito puede completarla', async () => {
    const lib = await contexto().abrir(); await lib.guardarOriginal(captura());
    await lib.registrarFalloMiniatura(fotoId, 'No se pudo decodificar');
    expect((await lib.leerMetadatos(fotoId))).toMatchObject({ miniatura: { tipo: 'fallida' } });
    await lib.guardarMiniatura(fotoId, new Blob(['png'], { type: 'image/png' }), 2, 3);
    expect((await lib.leerOriginal(fotoId))!.size).toBe(3);
    expect((await lib.leerMetadatos(fotoId))).toMatchObject({ miniatura: { tipo: 'lista', bytes: 3 } });
  });
  it('corrupción visible se conserva sin cleanup ni reset', async () => {
    const ctx = contexto(); const lib = await ctx.abrir(); await lib.guardarOriginal(captura());
    const db = await cruda(ctx.fabrica); await sembrar(db, 'metadatos', { formato: 999, fotoId });
    await expect(lib.listar()).rejects.toThrow('corrupt');
    await expect(lib.leerOriginal(fotoId)).rejects.toThrow('corrupt');
    const valor = await new Promise<unknown>((ok) => {
      const s = db.transaction('originales').objectStore('originales').get(fotoId); s.onsuccess = () => ok(s.result);
    });
    expect((valor as Blob).size).toBe(3);
  });
  it('miniatura fallida no es durable si también falla registrarFalloMiniatura', async () => {
    const lib = await contexto().abrir(); await lib.guardarOriginal(captura());
    const put = vi.spyOn(IDBObjectStore.prototype, 'put').mockImplementation(() => { throw new Error('Escritura falló'); });
    await expect(lib.registrarFalloMiniatura(fotoId, 'Error sesión')).rejects.toThrow('Escritura falló');
    put.mockRestore();
    expect(await lib.leerMetadatos(fotoId)).toMatchObject({ miniatura: { tipo: 'pendiente' } });
  });
  it('rechaza getters de captura antes de clonar, sin ejecutarlos', async () => {
    const lib = await contexto().abrir(); let n = 0;
    const mala = { get metadatos() { n++; return captura().metadatos; }, original: captura().original };
    await expect(lib.guardarOriginal(mala)).rejects.toThrow(); expect(n).toBe(0);
  });
  it('dos conexiones serializan originales y una sola gana la colisión', async () => {
    const ctx = contexto(); const a = await ctx.abrir(); const b = await ctx.abrir();
    const resultados = await Promise.allSettled([a.guardarOriginal(captura()), b.guardarOriginal(captura())]);
    expect(resultados.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(resultados.filter((r) => r.status === 'rejected')).toHaveLength(1);
    expect(await a.listar()).toHaveLength(1);
  });
  it('metadata fresca: un fallo tardío no pisa una miniatura lista en otra conexión', async () => {
    const ctx = contexto(); const a = await ctx.abrir(); const b = await ctx.abrir();
    await a.guardarOriginal(captura());
    await b.guardarMiniatura(fotoId, new Blob(['PNG'], { type: 'image/png' }), 1, 1);
    await a.registrarFalloMiniatura(fotoId, 'Intento anterior falló');
    expect(await a.leerMetadatos(fotoId)).toMatchObject({ miniatura: { tipo: 'lista' } });
    expect(await (await a.leerMiniatura(fotoId))!.text()).toBe('PNG');
  });
  it('abort de miniatura y de borrado conserva la relación anterior completa', async () => {
    const ctx = contexto(); const lib = await ctx.abrir(); await lib.guardarOriginal(captura());
    const put = IDBObjectStore.prototype.put;
    const falla = vi.spyOn(IDBObjectStore.prototype, 'put').mockImplementation(function (this: IDBObjectStore, ...args) {
      const s = put.apply(this, args); if (this.name === 'metadatos') s.addEventListener('success', () => this.transaction.abort());
      return s;
    });
    await expect(lib.guardarMiniatura(fotoId, new Blob(['png'], { type: 'image/png' }), 1, 1)).rejects.toThrow();
    await expect(lib.borrarLocal(fotoId)).rejects.toThrow(); falla.mockRestore(); lib.cerrar();
    const nueva = await ctx.abrir();
    expect(await nueva.leerMetadatos(fotoId)).toEqual(captura().metadatos);
    expect((await nueva.leerOriginal(fotoId))!.size).toBe(3); expect(await nueva.leerMiniatura(fotoId)).toBeNull();
  });
  it('original ausente/corrupto no se repara ni se borra al modificar', async () => {
    const ctx = contexto(); const lib = await ctx.abrir(); await lib.guardarOriginal(captura());
    const db = await cruda(ctx.fabrica); await sembrar(db, 'originales', new Blob(['longitud diferente']));
    await expect(lib.leerOriginal(fotoId)).rejects.toThrow('corrupt');
    await expect(lib.borrarLocal(fotoId)).rejects.toThrow('corrupt');
    await expect(lib.guardarMiniatura(fotoId, new Blob(['png'], { type: 'image/png' }), 1, 1)).rejects.toThrow('corrupt');
    expect(await lib.leerMetadatos(fotoId)).toEqual(captura().metadatos);
  });
  it('lectura original detecta MIME contradictorio aun con igual longitud y conserva bytes', async () => {
    const ctx = contexto(); const lib = await ctx.abrir(); await lib.guardarOriginal(captura());
    const db = await cruda(ctx.fabrica); await sembrar(db, 'originales', new Blob(['abc'], { type: 'text/html' }));
    await expect(lib.leerOriginal(fotoId)).rejects.toThrow('corrupt');
    expect(await lib.leerMetadatos(fotoId)).toEqual(captura().metadatos);
  });
  it('un blob huérfano desconocido no se limpia ni se convierte en captura nueva', async () => {
    const ctx = contexto(); const lib = await ctx.abrir(); const db = await cruda(ctx.fabrica);
    await sembrar(db, 'miniaturas', new Blob(['ajeno']));
    await expect(lib.guardarOriginal(captura())).rejects.toThrow('huérfanos');
    await expect(lib.leerMiniatura(fotoId)).rejects.toThrow('huérfano');
    await expect(lib.borrarLocal(fotoId)).rejects.toThrow('desconocida');
    expect(await lib.listar()).toEqual([]);
  });
  it('cursor rechaza clave/meta distinta y destino que ya no pertenece al plan', async () => {
    const ctx = contexto(); const lib = await ctx.abrir(); const db = await cruda(ctx.fabrica);
    await sembrar(db, 'metadatos', { ...captura().metadatos, fotoId: '22345678-1234-4123-8123-123456789abc' });
    await expect(lib.listar()).rejects.toThrow('Clave');
    await sembrar(db, 'metadatos', { ...captura().metadatos, destino: { ...destino, paradaId: 'eliminada' } });
    await expect(lib.listar()).rejects.toThrow('corrupt');
  });
  it('rechaza esquema extranjero sin eliminar sus stores ni sus datos', async () => {
    const fabrica = new IDBFactory();
    const db = await new Promise<IDBDatabase>((ok) => {
      const s = fabrica.open('fotos-prueba', 1);
      s.onupgradeneeded = () => s.result.createObjectStore('ajeno');
      s.onsuccess = () => ok(s.result);
    });
    cierres.push(() => db.close());
    await expect(abrirFotosLocal(itinerario, { fabrica, nombre: 'fotos-prueba' })).rejects.toThrow('Esquema');
    expect(Array.from(db.objectStoreNames)).toEqual(['ajeno']);
  });
  it('blocked SIMULADO rechaza y cierra un éxito tardío, error de apertura no crea fallback', async () => {
    const fabrica = new IDBFactory();
    const cerrar = vi.fn();
    const solicitud = { result: { close: cerrar }, onblocked: null, onsuccess: null, onerror: null } as unknown as IDBOpenDBRequest;
    vi.spyOn(fabrica, 'open').mockReturnValue(solicitud);
    const apertura = abrirFotosLocal(itinerario, { fabrica });
    const rechazo = expect(apertura).rejects.toThrow('bloqueada');
    solicitud.onblocked!(new Event('blocked') as IDBVersionChangeEvent); await rechazo;
    solicitud.onsuccess!(new Event('success')); expect(cerrar).toHaveBeenCalledTimes(1);
    vi.restoreAllMocks();
    await expect(abrirFotosLocal(itinerario, { fabrica: null })).rejects.toThrow('no está disponible');
  });
  it('cerrar libera handles sin prometer cancelar una transacción ya iniciada', async () => {
    const ctx = contexto(); const lib = await ctx.abrir();
    const enCurso = lib.guardarOriginal(captura()); lib.cerrar();
    expect((await enCurso).tipo).toBe('guardada');
    await expect(lib.listar()).rejects.toThrow('cerrado');
    expect(await (await ctx.abrir()).listar()).toHaveLength(1);
  });
  it('rechaza miniatura con MIME/tamaño/dimensiones incorrectos antes de abrir TX', async () => {
    const lib = await contexto().abrir(); await lib.guardarOriginal(captura());
    for (const [blob, ancho, alto] of [[new Blob([]), 1, 1], [new Blob(['a'], { type: 'image/png' }), NaN, 1],
      [new Blob(['a'], { type: 'image/png' }), 1025, 1]] as const) {
      await expect(lib.guardarMiniatura(fotoId, blob, ancho, alto)).rejects.toThrow();
    }
    expect(await lib.leerMetadatos(fotoId)).toEqual(captura().metadatos);
  });
  it('versionchange libera conexión y cerrar hace fallar honestamente llamadas siguientes', async () => {
    const ctx = contexto(); const lib = await ctx.abrir(); const db2 = await cruda(ctx.fabrica, 2);
    await expect(lib.listar()).rejects.toThrow('cerrado'); db2.close();
    await expect(ctx.abrir()).rejects.toThrow();
  });
});
