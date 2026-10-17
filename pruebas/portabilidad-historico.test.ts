import { describe, expect, it, vi } from 'vitest';
import { IDBFactory, IDBObjectStore } from 'fake-indexeddb';
import * as fotos from '../src/fotos-local';
import { itinerario } from '../src/datos/itinerario';
import { exportarArchivoPortable, type BasePortable } from '../src/portabilidad';
import { crearPortabilidadHistorica } from '../src/portabilidad-historico';
import { copiarOriginalRespaldo } from '../src/fotos-respaldo';

const limites = { maxRegistros: 100, maxBytesMetadatos: 100000, maxBytesArchivo: 4000000, maxProfundidad: 64 };
const limitesHistoria = { maxImportaciones: 100, maxObservaciones: 1000, maxProcedencias: 1000, maxBytesHistoria: 40000000 };
const fotoId = '12345678-1234-4123-8123-123456789abc';
const otraId = '22345678-1234-4123-8123-123456789abc';
const nombre = `itinerario-fotos:${encodeURIComponent(itinerario.id)}`;
function metadata(id = fotoId, bytes = 3) {
  return { formato: 1 as const, fotoId: id, destino: { tipo: 'parada' as const, viajeId: itinerario.id,
    paradaId: itinerario.dias[0].paradas[0].id }, nombre: '\0 e\u0301 ', mimeDeclarado: 'image/heic',
    incorporada: -0, ultimaModificacion: -0, bytesOriginal: bytes, miniatura: { tipo: 'pendiente' as const } };
}
function base(bytes: Uint8Array = new Uint8Array([1, 2, 3])): BasePortable {
  return { presente: true, tablas: { metadatos: [{ clave: fotoId, valor: metadata(fotoId, bytes.length) }],
    originales: [{ clave: fotoId, valor: new Blob([bytes as Uint8Array<ArrayBuffer>], { type: 'image/heic' }) }], miniaturas: [] } };
}
async function original(fabrica: IDBFactory, id = fotoId) {
  const f = await fotos.abrirFotosLocal(itinerario, { fabrica });
  try { return await f.leerOriginal(id); } finally { f.cerrar(); }
}
async function archivoFoto(bytes = new Uint8Array([1, 2, 3])) {
  return (await exportarArchivoPortable(itinerario, { viajeId: itinerario.id, fotos: base(bytes),
    progreso: { presente: false, tablas: {} }, respaldos: { presente: false, tablas: {} },
    legado: { marcas: '\0 e\u0301 ', 'marcas-hora': '', 'pendientes-hechos': null } }, limites)).archivo;
}
describe('historia durable separada y manual', () => {
  it.each([-1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])('presupuesto histórico inseguro %s se rechaza sin IO', (n) => {
    const fabrica = new IDBFactory(); const abrir = vi.spyOn(fabrica, 'open');
    expect(() => crearPortabilidadHistorica({ plan: itinerario, limites, fabrica,
      limitesHistoria: { ...limitesHistoria, maxImportaciones: n } })).toThrow();
    expect(abrir).not.toHaveBeenCalled();
  });
  it('importación sin capacidad para su observación rechaza antes de crear historia o fotos', async () => {
    const fabrica = new IDBFactory(); const h = crearPortabilidadHistorica({ plan: itinerario, limites,
      limitesHistoria: { ...limitesHistoria, maxObservaciones: 0 }, fabrica });
    const r = await h.importar(await archivoFoto());
    expect(r).toMatchObject({ tipo: 'rechazado-antes-escribir', historia: 'no-intentada' });
    expect(await fabrica.databases()).toEqual([]);
  });
  it('respuesta perdida del puerto exige atestación readonly fresca, sin atribuir nuestra TX', async () => {
    const fabrica = new IDBFactory(); const driver = fotos.crearRestauradorFotosPortable(itinerario, limites, { fabrica });
    const h = crearPortabilidadHistorica({ plan: itinerario, limites, limitesHistoria, fabrica,
      restaurador: { restaurar: async (b) => { await driver.restaurar(b); throw new Error('Respuesta perdida'); } } });
    const r = await h.importar(await archivoFoto());
    expect(r).toMatchObject({ historia: 'confirmada', fotos: { tipo: 'observadas', transaccion: 'incierta' } });
    expect((await h.consultar(r.trabajoId!))!.observaciones).toMatchObject([{ tipo: 'observadas', transaccion: 'incierta' }]);
  });
  it('reabre original exacto y copia pública aislada; mismo job exige todos los bytes, no MIME exterior', async () => {
    const fabrica = new IDBFactory(); const bytes = new Uint8Array((1 << 20) + 5); bytes.fill(23); bytes[bytes.length - 1] = 255;
    const archivo = await archivoFoto(bytes); const opciones = { plan: itinerario, limites, limitesHistoria, fabrica };
    const h = crearPortabilidadHistorica(opciones); const r = await h.importar(archivo);
    const consulta = (await h.consultar(r.trabajoId!))!;
    Object.assign(consulta.contenido.captura, { viajeId: 'mutado' });
    Object.assign(consulta, { archivo: new Blob(['otro']), trabajoId: otraId });
    const reabierta = crearPortabilidadHistorica(opciones);
    expect(await (await reabierta.exportarOriginal(r.trabajoId!)).arrayBuffer()).toEqual(await archivo.arrayBuffer());
    expect((await reabierta.consultar(r.trabajoId!))!.contenido.captura.viajeId).toBe(itinerario.id);
    const igual = new Blob([archivo], { type: 'text/plain' });
    expect((await reabierta.reintentar(r.trabajoId!, igual)).fotos?.tipo).toBe('observadas');
    const diferente = new Blob([archivo.slice(0, -1), new Uint8Array([254])]);
    expect(await reabierta.reintentar(r.trabajoId!, diferente)).toMatchObject({ tipo: 'rechazado-antes-escribir', historia: 'no-intentada' });
    expect((await reabierta.consultar(r.trabajoId!))!.observaciones).toHaveLength(2);
  });
  it('archivo no confirmado tras crear HistoryDB reporta creación real y nunca inicia PhotoDB', async () => {
    const fabrica = new IDBFactory(); const add = IDBObjectStore.prototype.add;
    const spy = vi.spyOn(IDBObjectStore.prototype, 'add').mockImplementation(function (this: IDBObjectStore, ...args: Parameters<typeof add>) {
      if (this.name === 'importaciones') throw new DOMException('Cuota inyectada', 'QuotaExceededError');
      return add.apply(this, args);
    });
    let r;
    try { r = await crearPortabilidadHistorica({ plan: itinerario, limites, limitesHistoria, fabrica }).importar(await archivoFoto()); }
    finally { spy.mockRestore(); }
    expect(r).toMatchObject({ tipo: 'historia-no-confirmada', historia: 'no-confirmada', baseHistorica: 'creada', fotos: null });
    expect((await fabrica.databases()).map((d) => d.name)).toEqual([`itinerario-portabilidad:${encodeURIComponent(itinerario.id)}`]);
  });
  it('cuota foto inyectada deja archivo confirmado recuperable; retry manual funciona después', async () => {
    const fabrica = new IDBFactory(); const h = crearPortabilidadHistorica({ plan: itinerario, limites, limitesHistoria, fabrica });
    const archivo = await archivoFoto(); const add = IDBObjectStore.prototype.add;
    const spy = vi.spyOn(IDBObjectStore.prototype, 'add').mockImplementation(function (this: IDBObjectStore, ...args: Parameters<typeof add>) {
      if (this.name === 'originales') throw new DOMException('Cuota inyectada', 'QuotaExceededError');
      return add.apply(this, args);
    });
    let r;
    try { r = await h.importar(archivo); } finally { spy.mockRestore(); }
    expect(r).toMatchObject({ historia: 'confirmada', fotos: { tipo: 'tx-abortada', transaccion: 'abortada' } });
    expect(await (await h.exportarOriginal(r.trabajoId!)).arrayBuffer()).toEqual(await archivo.arrayBuffer());
    expect((await h.reintentar(r.trabajoId!)).fotos?.tipo).toBe('observadas');
    expect((await h.consultar(r.trabajoId!))!.observaciones).toHaveLength(2);
  });
  it('fotos atestadas pero observación no durable se distingue; reintentos concurrentes no pierden arrays', async () => {
    const fabrica = new IDBFactory(); const h = crearPortabilidadHistorica({ plan: itinerario, limites, limitesHistoria, fabrica });
    const put = IDBObjectStore.prototype.put;
    const spy = vi.spyOn(IDBObjectStore.prototype, 'put').mockImplementation(function (this: IDBObjectStore, ...args: Parameters<typeof put>) {
      if (this.name === 'importaciones') throw new DOMException('Cuota resultado inyectada', 'QuotaExceededError');
      return put.apply(this, args);
    });
    let r;
    try { r = await h.importar(await archivoFoto()); } finally { spy.mockRestore(); }
    expect(r).toMatchObject({ tipo: 'resultado-durable-incierto', historia: 'confirmada', fotos: { tipo: 'observadas' } });
    expect((await h.consultar(r.trabajoId!))!.observaciones).toHaveLength(0);
    const resultados = await Promise.all([h.reintentar(r.trabajoId!), h.reintentar(r.trabajoId!)]);
    expect(resultados.every((r) => r.tipo === 'historia-confirmada')).toBe(true);
    expect((await h.consultar(r.trabajoId!))!.observaciones).toHaveLength(2);
  });
  it.each(['futuro', 'store-extra', 'corrupto'] as const)('historia %s nunca se interpreta vacía ni se resetea', async (caso) => {
    const fabrica = new IDBFactory(); const nombre = `itinerario-portabilidad:${encodeURIComponent(itinerario.id)}`;
    const db = await new Promise<IDBDatabase>((ok, no) => {
      const s = fabrica.open(nombre, caso === 'futuro' ? 2 : 1);
      s.onupgradeneeded = () => { s.result.createObjectStore('importaciones'); if (caso === 'store-extra') s.result.createObjectStore('extra'); };
      s.onsuccess = () => ok(s.result); s.onerror = () => no(s.error);
    });
    await new Promise<void>((ok, no) => { const tx = db.transaction('importaciones', 'readwrite');
      tx.objectStore('importaciones').put({ conservar: 'dato desconocido' }, fotoId); tx.oncomplete = () => ok(); tx.onabort = () => no(tx.error); });
    const h = crearPortabilidadHistorica({ plan: itinerario, limites, limitesHistoria, fabrica });
    await expect(h.listar()).rejects.toThrow();
    expect((await h.importar(await archivoFoto())).tipo).toBe('rechazado-antes-escribir');
    const conservado = await new Promise((ok) => { const tx = db.transaction('importaciones'); const s = tx.objectStore('importaciones').get(fotoId); s.onsuccess = () => ok(s.result); });
    expect(conservado).toEqual({ conservar: 'dato desconocido' }); expect(db.version).toBe(caso === 'futuro' ? 2 : 1); db.close();
  });
  it('archiva Blob completo antes de fotos; vacío no crea bases activas y reabre sin marcador LS', async () => {
    const fabrica = new IDBFactory(); const archivo = await exportarArchivoPortable(itinerario, {
      viajeId: itinerario.id, fotos: { presente: false, tablas: {} }, progreso: { presente: false, tablas: {} },
      respaldos: { presente: false, tablas: {} }, legado: { marcas: '\0 e\u0301 ', 'marcas-hora': '', 'pendientes-hechos': null },
    }, limites);
    const h = crearPortabilidadHistorica({ plan: itinerario, limites, limitesHistoria, fabrica });
    const r = await h.importar(archivo.archivo);
    expect(r).toMatchObject({ tipo: 'historia-confirmada', historia: 'confirmada', fotos: { tipo: 'sin-fotos' } });
    const reabierta = crearPortabilidadHistorica({ plan: itinerario, limites, limitesHistoria, fabrica });
    expect(await reabierta.listar()).toHaveLength(1);
    expect((await fabrica.databases()).map((d) => d.name)).toEqual([`itinerario-portabilidad:${encodeURIComponent(itinerario.id)}`]);
  });
  it('archivo truncado se rechaza antes de cualquier creación o escritura', async () => {
    const fabrica = new IDBFactory(); const abrir = vi.spyOn(fabrica, 'open');
    const h = crearPortabilidadHistorica({ plan: itinerario, limites, limitesHistoria, fabrica });
    expect(await h.importar(new Blob(['ITINPORT']))).toMatchObject({ tipo: 'rechazado-antes-escribir', historia: 'no-intentada' });
    expect(abrir).not.toHaveBeenCalled(); expect(await fabrica.databases()).toEqual([]);
  });
});
describe('restauración portable dedicada: lote PhotoDB, nunca progreso ni ledger', () => {
  it('bootstrap: el puerto es independiente de FotosLocal', () => {
    expect(fotos).toHaveProperty('crearRestauradorFotosPortable');
  });
  it('confirma lote nuevo y verifica todos los bytes al reabrir, conservando -0 y nombres RAW', async () => {
    const fabrica = new IDBFactory(); const bytes = new Uint8Array((1 << 20) + 5);
    bytes.fill(23); bytes[0] = 0; bytes[bytes.length - 1] = 255;
    const restaurador = fotos.crearRestauradorFotosPortable(itinerario, limites, { fabrica });
    const r = await restaurador.restaurar(base(bytes));
    expect(r).toMatchObject({ tipo: 'observadas', transaccion: 'confirmada', fotos: [{ fotoId, tipo: 'nueva', derivacion: 'igual' }] });
    expect(new Uint8Array(await (await original(fabrica))!.arrayBuffer())).toEqual(bytes);
    const f = await fotos.abrirFotosLocal(itinerario, { fabrica });
    const m = await f.leerMetadatos(fotoId); f.cerrar();
    expect(m).toMatchObject({ nombre: '\0 e\u0301 ', mimeDeclarado: 'image/heic' });
    expect(Object.is((m as ReturnType<typeof metadata>).incorporada, -0)).toBe(true);
    expect((await fabrica.databases()).map((d) => d.name)).toEqual([nombre]);
  });
  it('fotoempty/absent no crea PhotoDB y constructor no abre nada', async () => {
    const fabrica = new IDBFactory(); const abrir = vi.spyOn(fabrica, 'open');
    const r = fotos.crearRestauradorFotosPortable(itinerario, limites, { fabrica });
    expect(abrir).not.toHaveBeenCalled();
    const vacias: BasePortable[] = [{ presente: false, tablas: {} }, { presente: true, tablas: { metadatos: [], originales: [], miniaturas: [] } }];
    for (const b of vacias) {
      expect(await r.restaurar(b)).toMatchObject({ tipo: 'sin-fotos', transaccion: 'no-intentada' });
    }
    expect(abrir).not.toHaveBeenCalled(); expect(await fabrica.databases()).toEqual([]);
  });
  it('colisión en el último byte aborta el lote entero sin añadir la otra foto', async () => {
    const fabrica = new IDBFactory(); const bytes = new Uint8Array((1 << 20) + 5); bytes.fill(23);
    const restaurador = fotos.crearRestauradorFotosPortable(itinerario, limites, { fabrica });
    expect((await restaurador.restaurar(base(bytes))).tipo).toBe('observadas');
    const distinta = bytes.slice(); distinta[distinta.length - 1] = 254;
    const b = base(distinta); (b.tablas.metadatos as { clave: string; valor: unknown }[]).push({ clave: otraId, valor: metadata(otraId) });
    (b.tablas.originales as { clave: string; valor: unknown }[]).push({ clave: otraId, valor: new Blob(['abc'], { type: 'image/heic' }) });
    expect(await restaurador.restaurar(b)).toMatchObject({ tipo: 'conflicto-preflight', transaccion: 'no-intentada' });
    expect(await original(fabrica, otraId)).toBeNull();
    expect(new Uint8Array(await (await original(fabrica))!.arrayBuffer())).toEqual(bytes);
  });
  it('original igual conserva miniatura local distinta y devuelve diferencias, tombstone nunca resucita', async () => {
    const fabrica = new IDBFactory(); const restaurador = fotos.crearRestauradorFotosPortable(itinerario, limites, { fabrica });
    await restaurador.restaurar(base());
    const f = await fotos.abrirFotosLocal(itinerario, { fabrica });
    await f.guardarMiniatura(fotoId, new Blob([new Uint8Array([7, 8])], { type: 'image/png' }), 1, 1);
    const b = base(); const m = metadata();
    Object.assign(m, { miniatura: { tipo: 'lista', bytes: 2, ancho: 1, alto: 1, mime: 'image/png' } });
    (b.tablas.metadatos as { clave: string; valor: unknown }[])[0].valor = m;
    (b.tablas.miniaturas as { clave: string; valor: unknown }[]).push({ clave: fotoId,
      valor: new Blob([new Uint8Array([7, 9])], { type: 'image/png' }) });
    expect(await restaurador.restaurar(b)).toMatchObject({ tipo: 'observadas', fotos: [{ fotoId, tipo: 'existente', derivacion: 'diferente' }] });
    expect(new Uint8Array(await (await f.leerMiniatura(fotoId))!.arrayBuffer())).toEqual(new Uint8Array([7, 8]));
    const borrada: BasePortable = { presente: true, tablas: { metadatos: [{ clave: fotoId,
      valor: { formato: 1, tipo: 'borrada', fotoId } }], originales: [], miniaturas: [] } };
    expect((await restaurador.restaurar(borrada)).tipo).toBe('conflicto-preflight');
    expect(await f.leerOriginal(fotoId)).not.toBeNull();
    await f.borrarLocal(fotoId); f.cerrar();
    expect((await restaurador.restaurar(base())).tipo).toBe('conflicto-preflight');
    expect(await original(fabrica)).toBeNull();
    expect(await restaurador.restaurar(borrada)).toMatchObject({ tipo: 'observadas', fotos: [{ tipo: 'tombstone' }] });
    const nueva = new IDBFactory();
    expect((await fotos.crearRestauradorFotosPortable(itinerario, limites, { fabrica: nueva }).restaurar(borrada)).tipo).toBe('observadas');
    expect(await original(nueva)).toBeNull();
  });
  it('request success seguido de abort no confirma ni deja metadata, original ni miniatura', async () => {
    const fabrica = new IDBFactory(); const add = IDBObjectStore.prototype.add;
    let requestExitosa = false;
    const spy = vi.spyOn(IDBObjectStore.prototype, 'add').mockImplementation(function (this: IDBObjectStore, ...args: Parameters<typeof add>) {
      const req = add.apply(this, args);
      if (this.name === 'originales') req.addEventListener('success', () => { requestExitosa = true; this.transaction.abort(); });
      return req;
    });
    try {
      const r = await fotos.crearRestauradorFotosPortable(itinerario, limites, { fabrica }).restaurar(base());
      expect(r).toMatchObject({ tipo: 'tx-abortada', transaccion: 'abortada' });
      expect(requestExitosa).toBe(true);
    } finally { spy.mockRestore(); }
    const raw = await fotos.capturarFotosLocal(itinerario, limites, { fabrica });
    expect(raw).toEqual({ presente: true, tablas: { metadatos: [], originales: [], miniaturas: [] } });
  });
  it.each(['insercion', 'tombstone', 'derivacion'] as const)('carrera fresca %s: sin await dentro de TX ni sobrescritura', async (caso) => {
    const fabrica = new IDBFactory(); const f = await fotos.abrirFotosLocal(itinerario, { fabrica });
    if (caso !== 'insercion') await f.guardarOriginal({ metadatos: metadata(), original: new Blob([new Uint8Array([1, 2, 3])], { type: 'image/heic' }) });
    f.cerrar();
    const open = fabrica.open.bind(fabrica); let inyectada = false;
    const spy = vi.spyOn(fabrica, 'open').mockImplementation((nombre, version) => {
      const req = open(nombre, version);
      // La apertura física del restaurador es la de PhotoDB v2 (con «procedencias»).
      if (version === 2 && !inyectada) req.addEventListener('success', () => {
        inyectada = true; const tx = req.result.transaction(['metadatos', 'originales', 'miniaturas'], 'readwrite');
        if (caso === 'insercion') {
          tx.objectStore('metadatos').add(metadata(), fotoId);
          tx.objectStore('originales').add(new Blob([new Uint8Array([1, 2, 3])], { type: 'image/heic' }), fotoId);
        } else if (caso === 'tombstone') {
          // Fixture de escritor local autorizado: borrado definitivo, no reparación del importador.
          tx.objectStore('metadatos').put({ formato: 1, tipo: 'borrada', fotoId }, fotoId);
          tx.objectStore('originales').delete(fotoId);
        } else {
          tx.objectStore('metadatos').put({ ...metadata(), miniatura: { tipo: 'lista', bytes: 1, ancho: 1, alto: 1, mime: 'image/png' } }, fotoId);
          tx.objectStore('miniaturas').put(new Blob([new Uint8Array([7])], { type: 'image/png' }), fotoId);
        }
      });
      return req;
    });
    try {
      const r = await fotos.crearRestauradorFotosPortable(itinerario, limites, { fabrica }).restaurar(base());
      expect(inyectada).toBe(true);
      if (caso === 'derivacion') expect(r).toMatchObject({ tipo: 'observadas', transaccion: 'confirmada', fotos: [{ derivacion: 'diferente' }] });
      else expect(r.transaccion).toBe('abortada');
      if (caso === 'tombstone') { expect(r.tipo).toBe('conflicto-fresco'); expect(await original(fabrica)).toBeNull(); }
      if (caso === 'insercion') expect(r.tipo).toBe('observadas'); // Identidad observada, NO autoría de nuestra TX abortada.
    } finally { spy.mockRestore(); }
  });
  it('oncomplete con bytes posteriores ilegibles no afirma diferencia ni restauración definitiva', async () => {
    const fabrica = new IDBFactory(); const add = IDBObjectStore.prototype.add;
    const arrayBuffer = Blob.prototype.arrayBuffer; let confirmado = false;
    const escritura = vi.spyOn(IDBObjectStore.prototype, 'add').mockImplementation(function (this: IDBObjectStore, ...args: Parameters<typeof add>) {
      this.transaction.addEventListener('complete', () => { confirmado = true; }); return add.apply(this, args);
    });
    const lectura = vi.spyOn(Blob.prototype, 'arrayBuffer').mockImplementation(function (this: Blob) {
      if (confirmado) return Promise.reject(new Error('Bytes posteriores ilegibles'));
      return arrayBuffer.call(this);
    });
    try {
      expect(await fotos.crearRestauradorFotosPortable(itinerario, limites, { fabrica }).restaurar(base()))
        .toMatchObject({ tipo: 'lectura-posterior-fallida', transaccion: 'confirmada' });
    } finally { escritura.mockRestore(); lectura.mockRestore(); }
    expect(await original(fabrica)).not.toBeNull();
  });
  it('oncomplete con lectura posterior fallida conserva el lote y reporta incertidumbre de lectura', async () => {
    const fabrica = new IDBFactory(); const add = IDBObjectStore.prototype.add; const open = fabrica.open.bind(fabrica);
    let confirmado = false;
    const escritura = vi.spyOn(IDBObjectStore.prototype, 'add').mockImplementation(function (this: IDBObjectStore, ...args: Parameters<typeof add>) {
      this.transaction.addEventListener('complete', () => { confirmado = true; }); return add.apply(this, args);
    });
    const lectura = vi.spyOn(fabrica, 'open').mockImplementation((nombre, version) => {
      if (confirmado && version === undefined) throw new Error('Fallo inyectado de lectura');
      return open(nombre, version);
    });
    try {
      expect(await fotos.crearRestauradorFotosPortable(itinerario, limites, { fabrica }).restaurar(base()))
        .toMatchObject({ tipo: 'lectura-posterior-fallida', transaccion: 'confirmada' });
    } finally { escritura.mockRestore(); lectura.mockRestore(); }
    expect(await original(fabrica)).not.toBeNull();
  });
});

// ---------- Restauración sobre PhotoDB v2 (RP1) ----------

describe('restauración portable sobre PhotoDB v2', () => {
  it('RH1 · restaurar añade la importada SIN marca y conserva intacta la local con su marca de cámara/galería', async () => {
    const fabrica = new IDBFactory();
    const db = await new Promise<IDBDatabase>((ok, no) => {
      const s = fabrica.open(nombre, 2);
      s.onupgradeneeded = () => ['metadatos', 'originales', 'miniaturas', 'procedencias'].forEach((t) => s.result.createObjectStore(t));
      s.onsuccess = () => ok(s.result); s.onerror = () => no(s.error);
    });
    const marca = { version: 1, via: 'camara-galeria', original: copiarOriginalRespaldo(itinerario, metadata(otraId)) };
    await new Promise<void>((ok, no) => {
      const tx = db.transaction(['metadatos', 'originales', 'procedencias'], 'readwrite');
      tx.objectStore('metadatos').put(metadata(otraId), otraId);
      tx.objectStore('originales').put(new Blob([new Uint8Array([7, 8, 9])], { type: 'image/heic' }), otraId);
      tx.objectStore('procedencias').put(marca, otraId);
      tx.oncomplete = () => ok(); tx.onabort = () => no(tx.error);
    });
    db.close();
    const r = await fotos.crearRestauradorFotosPortable(itinerario, limites, { fabrica }).restaurar(base());
    expect(r).toMatchObject({ tipo: 'observadas', transaccion: 'confirmada' });
    const crudo = await new Promise<{ version: number; marcas: [IDBValidKey, unknown][]; ids: IDBValidKey[] }>((ok, no) => {
      const s = fabrica.open(nombre);
      s.onerror = () => no(s.error);
      s.onsuccess = () => {
        const d = s.result; const tx = d.transaction(['metadatos', 'procedencias']);
        const ids = tx.objectStore('metadatos').getAllKeys();
        const claves = tx.objectStore('procedencias').getAllKeys(); const valores = tx.objectStore('procedencias').getAll();
        tx.oncomplete = () => { d.close(); ok({ version: d.version, ids: ids.result,
          marcas: claves.result.map((k, i) => [k, valores.result[i]]) }); };
        tx.onabort = () => { d.close(); no(tx.error); };
      };
    });
    expect(crudo.version).toBe(2);
    expect([...crudo.ids].sort()).toEqual([fotoId, otraId].sort());
    expect(crudo.marcas).toEqual([[otraId, marca]]);
  });
  it('RH2 · una importada que coincide con la local no la toca: misma fila, mismos bytes y su marca sigue siendo suya', async () => {
    const fabrica = new IDBFactory();
    const db = await new Promise<IDBDatabase>((ok, no) => {
      const s = fabrica.open(nombre, 2);
      s.onupgradeneeded = () => ['metadatos', 'originales', 'miniaturas', 'procedencias'].forEach((t) => s.result.createObjectStore(t));
      s.onsuccess = () => ok(s.result); s.onerror = () => no(s.error);
    });
    const marca = { version: 1, via: 'camara-galeria', original: copiarOriginalRespaldo(itinerario, metadata()) };
    await new Promise<void>((ok, no) => {
      const tx = db.transaction(['metadatos', 'originales', 'procedencias'], 'readwrite');
      tx.objectStore('metadatos').put(metadata(), fotoId);
      tx.objectStore('originales').put(new Blob([new Uint8Array([1, 2, 3])], { type: 'image/heic' }), fotoId);
      tx.objectStore('procedencias').put(marca, fotoId);
      tx.oncomplete = () => ok(); tx.onabort = () => no(tx.error);
    });
    db.close();
    const r = await fotos.crearRestauradorFotosPortable(itinerario, limites, { fabrica }).restaurar(base());
    expect(r).toMatchObject({ tipo: 'observadas', fotos: [{ fotoId, tipo: 'existente' }] });
    const f = await fotos.abrirFotosLocal(itinerario, { fabrica });
    try {
      expect(await f.leerMetadatos(fotoId)).toEqual(metadata());
      expect(new Uint8Array(await (await f.leerOriginal(fotoId))!.arrayBuffer())).toEqual(new Uint8Array([1, 2, 3]));
      expect(await f.leerProcedencia?.(fotoId)).toBe('camara-galeria');
    } finally { f.cerrar(); }
  });
});
