import { IDBFactory, IDBObjectStore } from 'fake-indexeddb';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { itinerario } from '../src/datos/itinerario';
import { crearCapturaFoto } from '../src/fotos';
import { abrirFotosLocal } from '../src/fotos-local';
import { abrirRespaldoFotosLocal } from '../src/fotos-respaldo-local';
import type { EntradaRespaldo } from '../src/fotos-respaldo';

const fotoId = '12345678-1234-4123-8123-123456789abc';
const operacionId = '22345678-1234-4123-8123-123456789abc';
const otraOperacion = '32345678-1234-4123-8123-123456789abc';
const nombre = `itinerario-respaldo-fotos:${encodeURIComponent(itinerario.id)}`;
const captura = () => crearCapturaFoto(itinerario, { tipo: 'parada', viajeId: itinerario.id,
  paradaId: itinerario.dias[0].paradas[0].id }, new File(['abc'], '\0 e\u0301 ',
  { type: 'image/heic', lastModified: 17 }), -0, { uuid: () => fotoId });
const referencia = (e: EntradaRespaldo) => ({ fotoId: e.fotoId, operacionId: e.operacionId, original: e.original });
const recibo = (e: EntradaRespaldo) => ({ version: 1 as const, tipo: 'acuse-respaldo' as const,
  viajeId: itinerario.id, fotoId: e.fotoId, operacionId: e.operacionId, original: e.original,
  objetoOriginalDurable: true as const, metadatosDurables: true as const });
const cierres: (() => void)[] = [];
afterEach(() => { vi.restoreAllMocks(); cierres.splice(0).forEach((c) => c()); });
async function contexto() {
  const fabrica = new IDBFactory(); const fotos = await abrirFotosLocal(itinerario, { fabrica });
  cierres.push(fotos.cerrar); await fotos.guardarOriginal(captura());
  const abrir = async (fuente = fotos) => {
    const lib = await abrirRespaldoFotosLocal(itinerario, fuente, { fabrica });
    cierres.push(lib.cerrar); return lib;
  };
  const a = await abrir(); return { fabrica, fotos, abrir, a,
    preparar: () => a.preparar(captura(), operacionId) };
}
async function cruda(fabrica: IDBFactory, version?: number, crear?: (db: IDBDatabase) => void) {
  return new Promise<IDBDatabase>((ok, no) => {
    const s = fabrica.open(nombre, version);
    s.onupgradeneeded = () => crear?.(s.result);
    s.onerror = () => no(s.error); s.onsuccess = () => { cierres.push(() => s.result.close()); ok(s.result); };
  });
}
async function sembrar(db: IDBDatabase, valor: unknown) {
  return new Promise<void>((ok, no) => {
    const tx = db.transaction('respaldos', 'readwrite'); tx.objectStore('respaldos').put(valor, fotoId);
    tx.oncomplete = () => ok(); tx.onabort = () => no(tx.error);
  });
}
async function leerCrudo(db: IDBDatabase) {
  return new Promise<unknown>((ok, no) => {
    const tx = db.transaction('respaldos'); const s = tx.objectStore('respaldos').get(fotoId);
    let r: unknown; s.onsuccess = () => { r = s.result; };
    tx.oncomplete = () => ok(r); tx.onabort = () => no(tx.error);
  });
}

describe('ledger manual durable, fakeIDB: no prueba de cuota ni servidor real', () => {
  it('prepara con atestación local, reopen conserva identidad sin almacenar otro original', async () => {
    const c = await contexto(); const e = await c.preparar(); c.a.cerrar();
    const b = await c.abrir(); expect(await b.leer(fotoId)).toEqual(e);
    expect(e).toMatchObject({ fase: 'preparado', enviada: false, pausada: false, recibo: null });
    expect(Object.is(e.original.incorporada, -0)).toBe(true);
    const db = await cruda(c.fabrica);
    expect(Array.from(db.objectStoreNames)).toEqual(['respaldos']); expect(db.version).toBe(1);
    const t = db.transaction('respaldos').objectStore('respaldos');
    expect([t.keyPath, t.autoIncrement, t.indexNames.length]).toEqual([null, false, 0]);
    expect(await leerCrudo(db)).toEqual(e); expect(Object.keys(e.original)).not.toContain('miniatura');
  });
  it('B no persistida con mismo UUID/tamaño/MIME y último byte distinto no prepara A', async () => {
    const c = await contexto();
    await expect(c.a.preparar({ ...captura(), original: new Blob(['abd'], { type: 'image/heic' }) }, operacionId)).rejects.toThrow('atest');
    expect(await c.a.listar()).toEqual([]); expect(await (await c.fotos.leerOriginal(fotoId))!.text()).toBe('abc');
  });
  it('ausencia, tombstone y fallo de lectura no inventan respaldo', async () => {
    const c = await contexto(); await c.fotos.borrarLocal(fotoId);
    await expect(c.preparar()).rejects.toThrow('atest'); expect(await c.a.leer(fotoId)).toBeNull();
    const b = await c.abrir({ ...c.fotos, leerMetadatos: async () => null });
    await expect(b.preparar(captura(), operacionId)).rejects.toThrow('atest');
    const d = await c.abrir({ ...c.fotos, leerOriginal: async () => { throw new Error('Lectura falló'); },
      leerMetadatos: async () => captura().metadatos });
    await expect(d.preparar(captura(), operacionId)).rejects.toThrow('atest');
  });
  it('repreparar preserva estado e ID; colisión de operación nunca sobrescribe', async () => {
    const c = await contexto(); const e = await c.preparar();
    const enviada = await c.a.marcarEnviada(referencia(e)); await c.a.pausar(referencia(e));
    const repetida = await c.preparar(); expect(repetida).toEqual({ ...enviada, pausada: true });
    expect(await c.a.preparar(captura())).toEqual(repetida);
    await expect(c.a.preparar(captura(), otraOperacion)).rejects.toThrow('Colisión');
    expect(await c.a.leer(fotoId)).toEqual(repetida);
  });
  it('genera UUID solo al preparar un registro nuevo; retry no lo regenera', async () => {
    const c = await contexto(); const uuid = vi.fn(() => operacionId);
    const b = await abrirRespaldoFotosLocal(itinerario, c.fotos, { fabrica: c.fabrica, uuid }); cierres.push(b.cerrar);
    const e = await b.preparar(captura()); await b.preparar(captura());
    await b.pausar(referencia(e)); await b.reintentar(referencia(e));
    expect(uuid).toHaveBeenCalledTimes(1);
  });
  it('marcador debe terminar TX antes del IO futuro; reply perdido y pausa quedan inciertos', async () => {
    const c = await contexto(); const e = await c.preparar(); const b = await c.abrir();
    const orden: string[] = [];
    await c.a.marcarEnviada(referencia(e)); orden.push((await b.leer(fotoId))!.fase);
    orden.push('IO futuro simulado sin envío'); await b.pausar(referencia(e));
    c.a.cerrar(); b.cerrar(); const nueva = await c.abrir();
    expect(await nueva.leer(fotoId)).toMatchObject({ operacionId, fase: 'enviada', enviada: true, pausada: true, recibo: null });
    await expect(nueva.marcarEnviada(referencia(e))).rejects.toThrow('paus');
    expect(await nueva.reintentar(referencia(e))).toMatchObject({ enviada: true, pausada: false, fase: 'enviada', operacionId });
    expect(orden).toEqual(['enviada', 'IO futuro simulado sin envío']);
  });
  it('pausa previa impide enviar, retry manual la quita sin inventar marcador', async () => {
    const c = await contexto(); const e = await c.preparar(); await c.a.pausar(referencia(e));
    await expect(c.a.marcarEnviada(referencia(e))).rejects.toThrow('paus');
    expect(await c.a.reintentar(referencia(e))).toMatchObject({ enviada: false, fase: 'preparado', pausada: false });
  });
  it('acuse exacto solo tras enviada; replay conserva prueba y borrado local no la borra', async () => {
    const c = await contexto(); const e = await c.preparar();
    await expect(c.a.confirmarRecibo(recibo(e))).rejects.toThrow('envi');
    await c.a.marcarEnviada(referencia(e)); await c.a.pausar(referencia(e));
    const confirmada = await c.a.confirmarRecibo(recibo(e));
    expect(confirmada).toMatchObject({ fase: 'respaldada', enviada: true, pausada: true, recibo: recibo(e) });
    await c.fotos.borrarLocal(fotoId); const b = await c.abrir();
    expect(await b.confirmarRecibo(recibo(e))).toEqual(confirmada);
    expect(await b.pausar(referencia(e))).toEqual(confirmada);
    await expect(b.reintentar(referencia(e))).rejects.toThrow();
    await expect(b.marcarEnviada(referencia(e))).rejects.toThrow();
    expect(await b.leer(fotoId)).toEqual(confirmada);
  });
  it.each(['objetoOriginalDurable', 'metadatosDurables'])('sin %s durable no hay ACK', async (clave) => {
    const c = await contexto(); const e = await c.preparar(); await c.a.marcarEnviada(referencia(e));
    const r: Record<string, unknown> = recibo(e); delete r[clave];
    await expect(c.a.confirmarRecibo(r)).rejects.toThrow(); r[clave] = false;
    await expect(c.a.confirmarRecibo(r)).rejects.toThrow();
    expect(await c.a.leer(fotoId)).toMatchObject({ fase: 'enviada', recibo: null });
  });
  it('GET tamaño/MIME/ETag y boolean local no son recibos', async () => {
    const c = await contexto(); const e = await c.preparar(); await c.a.marcarEnviada(referencia(e));
    for (const r of [true, { persistida: true }, { ...recibo(e), etag: 'xyz' }, { fotoId, bytes: 3, mime: 'image/heic' }]) {
      await expect(c.a.confirmarRecibo(r)).rejects.toThrow();
    }
    expect(await c.a.leer(fotoId)).toMatchObject({ fase: 'enviada', recibo: null });
  });
  it('stale ACK de otra operación no retira incertidumbre ni cambia identidad', async () => {
    const c = await contexto(); const e = await c.preparar(); await c.a.marcarEnviada(referencia(e));
    await expect(c.a.confirmarRecibo({ ...recibo(e), operacionId: otraOperacion })).rejects.toThrow('Colisión');
    expect(await c.a.leer(fotoId)).toMatchObject({ fase: 'enviada', operacionId, recibo: null });
  });
  it('recibo contradictorio bloquea sin borrar prueba previa ni historia enviada', async () => {
    const c = await contexto(); const e = await c.preparar(); await c.a.marcarEnviada(referencia(e));
    const confirmada = await c.a.confirmarRecibo(recibo(e));
    const bloqueada = await c.a.confirmarRecibo({ ...recibo(e), original: { ...e.original, incorporada: 0 } });
    expect(bloqueada).toEqual({ ...confirmada, fase: 'bloqueada' });
    expect(await c.a.confirmarRecibo(recibo(e))).toEqual(bloqueada);
    await expect(c.a.reintentar(referencia(e))).rejects.toThrow('bloque');
    expect(await c.preparar()).toEqual(bloqueada);
  });
  it('contradicción sin prueba previa también bloquea conservando incertidumbre', async () => {
    const c = await contexto(); const e = await c.preparar(); await c.a.marcarEnviada(referencia(e));
    expect(await c.a.confirmarRecibo({ ...recibo(e), original: { ...e.original, nombre: 'otra' } }))
      .toMatchObject({ fase: 'bloqueada', enviada: true, recibo: null });
  });
  it('dos conexiones no aplican snapshots viejos encima de ACK/pausa', async () => {
    const c = await contexto(); const e = await c.preparar(); const b = await c.abrir();
    await c.a.marcarEnviada(referencia(e));
    await Promise.all([c.a.confirmarRecibo(recibo(e)), b.pausar(referencia(e))]);
    expect(await c.a.leer(fotoId)).toMatchObject({ fase: 'respaldada', enviada: true, pausada: true, recibo: recibo(e) });
    await expect(b.reintentar(referencia(e))).rejects.toThrow();
    expect(await c.preparar()).toEqual(await c.a.leer(fotoId));
  });
  it('preparaciones concurrentes distintas no sobrescriben: solo una operación gana', async () => {
    const c = await contexto(); const b = await c.abrir();
    const r = await Promise.allSettled([c.preparar(), b.preparar(captura(), otraOperacion)]);
    expect(r.filter((v) => v.status === 'fulfilled')).toHaveLength(1);
    expect(r.filter((v) => v.status === 'rejected')).toHaveLength(1);
    expect(await c.a.listar()).toHaveLength(1);
  });
  it('copia captura antes del primer await, sin ejecutar getters propios', async () => {
    const c = await contexto(); let liberar!: () => void; let inicio!: () => void;
    const iniciada = new Promise<void>((ok) => { inicio = ok; }); const espera = new Promise<void>((ok) => { liberar = ok; });
    const fuente = { ...c.fotos, leerMetadatos: async (id: string) => { inicio(); await espera; return c.fotos.leerMetadatos(id); } };
    const b = await c.abrir(fuente); const input = captura(); const trabajo = b.preparar(input, operacionId);
    await iniciada; Object.assign(input.metadatos, { nombre: 'mutado', incorporada: 0 }); liberar();
    const e = await trabajo; expect(e.original.nombre).toBe('\0 e\u0301 '); expect(Object.is(e.original.incorporada, -0)).toBe(true);
    let n = 0; await expect(b.preparar({ get metadatos() { n++; return captura().metadatos; }, original: input.original }, operacionId)).rejects.toThrow();
    expect(n).toBe(0);
  });
  it('referencia y recibo copiados antes de awaits; respuestas no son alias persistidos', async () => {
    const c = await contexto(); const e = await c.preparar(); const ref = referencia(e);
    const marca = c.a.marcarEnviada(ref); Object.assign(ref.original, { nombre: 'mutado' }); await marca;
    const actual = (await c.a.leer(fotoId))!; const r = recibo(actual); const confirmacion = c.a.confirmarRecibo(r);
    Object.assign(r.original, { nombre: 'mutado' }); const final = await confirmacion;
    Object.assign(final.original, { nombre: 'retorno mutado' });
    expect(await c.a.leer(fotoId)).toMatchObject({ original: { nombre: '\0 e\u0301 ' }, recibo: { original: { nombre: '\0 e\u0301 ' } } });
  });
  it('miniatura válida cambia sin retargeting; referencias con -0 diferente son colisiones', async () => {
    const c = await contexto(); const e = await c.preparar();
    await c.fotos.guardarMiniatura(fotoId, new Blob(['png'], { type: 'image/png' }), 1, 1);
    expect(await c.preparar()).toEqual(e);
    await expect(c.a.marcarEnviada({ ...referencia(e), original: { ...e.original, incorporada: 0 } })).rejects.toThrow('Colisión');
  });
  it('request success seguido de abort NO confirma preparación ni marcador ni ACK', async () => {
    const c = await contexto(); const put = IDBObjectStore.prototype.put; const add = IDBObjectStore.prototype.add;
    const abortar = () => {
      vi.spyOn(IDBObjectStore.prototype, 'put').mockImplementation(function (this: IDBObjectStore, ...args) {
        const s = put.apply(this, args); if (this.name === 'respaldos') s.addEventListener('success', () => this.transaction.abort()); return s;
      });
      vi.spyOn(IDBObjectStore.prototype, 'add').mockImplementation(function (this: IDBObjectStore, ...args) {
        const s = add.apply(this, args); if (this.name === 'respaldos') s.addEventListener('success', () => this.transaction.abort()); return s;
      });
    };
    abortar(); await expect(c.preparar()).rejects.toThrow(); vi.restoreAllMocks();
    expect(await c.a.leer(fotoId)).toBeNull(); const e = await c.preparar();
    abortar(); await expect(c.a.marcarEnviada(referencia(e))).rejects.toThrow(); vi.restoreAllMocks();
    expect(await c.a.leer(fotoId)).toEqual(e); await c.a.marcarEnviada(referencia(e));
    abortar(); await expect(c.a.confirmarRecibo(recibo(e))).rejects.toThrow(); vi.restoreAllMocks();
    expect(await c.a.leer(fotoId)).toMatchObject({ fase: 'enviada', recibo: null });
  });
  it('cuota INYECTADA conserva estado previo y original', async () => {
    const c = await contexto(); const e = await c.preparar(); const put = IDBObjectStore.prototype.put;
    vi.spyOn(IDBObjectStore.prototype, 'put').mockImplementation(function (this: IDBObjectStore, ...args) {
      if (this.name === 'respaldos') throw new DOMException('Cuota INYECTADA', 'QuotaExceededError'); return put.apply(this, args);
    });
    await expect(c.a.marcarEnviada(referencia(e))).rejects.toThrow('Cuota'); vi.restoreAllMocks();
    expect(await c.a.leer(fotoId)).toEqual(e); expect(await (await c.fotos.leerOriginal(fotoId))!.text()).toBe('abc');
  });
  it('listar/leer no cargan PhotoDB original; corrupción cruda permanece intacta', async () => {
    const c = await contexto(); await c.preparar(); const original = vi.spyOn(c.fotos, 'leerOriginal');
    await c.a.listar(); await c.a.leer(fotoId); expect(original).not.toHaveBeenCalled();
    const db = await cruda(c.fabrica); const mal = { formato: 999, fotoId, raro: '\0' }; await sembrar(db, mal);
    await expect(c.a.listar()).rejects.toThrow('corrupt'); await expect(c.a.leer(fotoId)).rejects.toThrow('corrupt');
    await expect(c.preparar()).rejects.toThrow('corrupt'); expect(await leerCrudo(db)).toEqual(mal);
  });
  it('cerrar no reabre lógicamente; apertura fallida admite nuevo intento explícito', async () => {
    const c = await contexto(); c.a.cerrar(); await expect(c.a.listar()).rejects.toThrow('cerrado');
    await expect(abrirRespaldoFotosLocal(itinerario, c.fotos, { fabrica: null })).rejects.toThrow('disponible');
    const open = vi.spyOn(c.fabrica, 'open').mockImplementationOnce(() => { throw new Error('Apertura falló'); });
    await expect(c.abrir()).rejects.toThrow('Apertura falló'); open.mockRestore(); expect(await (await c.abrir()).listar()).toEqual([]);
  });
  it('blocked SIMULADO y error open rechazan; éxito tardío cierra su conexión sin fuga', async () => {
    const fabrica = new IDBFactory(); const cerrar = vi.fn();
    const solicitud = { result: { close: cerrar }, onblocked: null, onsuccess: null, onerror: null } as unknown as IDBOpenDBRequest;
    vi.spyOn(fabrica, 'open').mockReturnValue(solicitud);
    const fuente = { leerMetadatos: async () => null, leerOriginal: async () => null };
    const apertura = abrirRespaldoFotosLocal(itinerario, fuente, { fabrica });
    const rechazo = expect(apertura).rejects.toThrow('bloqueada');
    solicitud.onblocked!(new Event('blocked') as IDBVersionChangeEvent); await rechazo;
    solicitud.onsuccess!(new Event('success')); expect(cerrar).toHaveBeenCalledTimes(1);
    const error = abrirRespaldoFotosLocal(itinerario, fuente, { fabrica });
    const rechazoError = expect(error).rejects.toThrow('abrir');
    solicitud.onerror!(new Event('error')); await rechazoError;
    expect(fabrica.open).toHaveBeenCalledTimes(2);
  });
  it('versionchange libera conexión sin downgrade; la instancia vieja no reabre', async () => {
    const c = await contexto(); const e = await c.preparar();
    const futura = await cruda(c.fabrica, 2); await expect(c.a.listar()).rejects.toThrow('cerrado');
    expect(await leerCrudo(futura)).toEqual(e); futura.close(); await expect(c.abrir()).rejects.toThrow();
  });
  it('captura no enumerable válida se materializa, getters anidados no se ejecutan', async () => {
    const c = await contexto(); const input = captura();
    Object.defineProperty(input, 'metadatos', { value: input.metadatos, enumerable: false });
    const e = await c.a.preparar(input, operacionId); expect(e.original.nombre).toBe('\u0000 e\u0301 ');
    let n = 0; const mala = captura();
    Object.defineProperty(mala.metadatos.destino, 'paradaId', { get() { n++; return itinerario.dias[0].paradas[0].id; } });
    await expect(c.a.preparar(mala, operacionId)).rejects.toThrow(); expect(n).toBe(0);
    const r = recibo(e); Object.defineProperty(r.original, 'nombre', { get() { n++; return 'falso'; } });
    await expect(c.a.confirmarRecibo(r)).rejects.toThrow(); expect(n).toBe(0);
  });
  it('UUID inválido y captura de otro destino no crean ni reescriben registro', async () => {
    const c = await contexto(); await expect(c.a.preparar(captura(), 'invalido')).rejects.toThrow('Operación');
    expect(await c.a.listar()).toEqual([]); const e = await c.preparar();
    const otra = captura(); Object.assign(otra.metadatos.destino, { paradaId: itinerario.dias[1].paradas[0].id });
    await expect(c.a.preparar(otra, operacionId)).rejects.toThrow('atest'); expect(await c.a.leer(fotoId)).toEqual(e);
  });
  it.each(['futura', 'falta', 'extra', 'indice', 'clave'])('esquema %s desconocido no se migra ni resetea', async (caso) => {
    const fabrica = new IDBFactory(); const db = await cruda(fabrica, caso === 'futura' ? 2 : 1, (d) => {
      if (caso === 'falta') { d.createObjectStore('ajena'); return; }
      const t = d.createObjectStore('respaldos', caso === 'clave' ? { keyPath: 'fotoId' } : undefined);
      if (caso === 'extra') d.createObjectStore('ajena'); if (caso === 'indice') t.createIndex('ajeno', 'fotoId');
      t.put({ fotoId, ajeno: true }, ...(caso === 'clave' ? [] : [fotoId]));
    });
    db.close(); const fuente = { leerMetadatos: async () => null, leerOriginal: async () => null };
    await expect(abrirRespaldoFotosLocal(itinerario, fuente, { fabrica })).rejects.toThrow();
    const actual = await cruda(fabrica); expect(actual.version).toBe(caso === 'futura' ? 2 : 1);
    expect(Array.from(actual.objectStoreNames)).toEqual(caso === 'falta' ? ['ajena'] : caso === 'extra' ? ['ajena', 'respaldos'] : ['respaldos']);
    if (caso !== 'falta') expect(await leerCrudo(actual)).toEqual({ fotoId, ajeno: true });
  });
});

describe('admisión del lote en el reclamo durable (H1)', () => {
  it('H1-L1 · con «soloPreparada» el marcador solo se escribe sobre una preparada sin envío ni pausa; lo demás no cambia', async () => {
    const c = await contexto(); const e = await c.preparar(); const b = await c.abrir();
    // Otra conexión (otro contexto) ya la marcó enviada: el lote no puede reclamarla y nada cambia.
    const ajena = await b.marcarEnviada(referencia(e));
    await expect(c.a.marcarEnviada(referencia(e), { soloPreparada: true })).rejects.toMatchObject({ name: 'ErrorAdmisionRespaldo' });
    expect(await c.a.leer(fotoId)).toEqual(ajena);
    // Sin condición, el reintento individual de la MISMA operación sigue permitido.
    expect(await c.a.marcarEnviada(referencia(e))).toEqual(ajena);
    // En pausa o ya confirmada tampoco se reclama con la condición.
    const pausada = await c.a.pausar(referencia(e));
    await expect(c.a.marcarEnviada(referencia(e), { soloPreparada: true })).rejects.toMatchObject({ name: 'ErrorAdmisionRespaldo' });
    expect(await c.a.leer(fotoId)).toEqual(pausada);
    await c.a.reintentar(referencia(e)); const confirmada = await c.a.confirmarRecibo(recibo(e));
    await expect(c.a.marcarEnviada(referencia(e), { soloPreparada: true })).rejects.toMatchObject({ name: 'ErrorAdmisionRespaldo' });
    expect(await c.a.leer(fotoId)).toEqual(confirmada);
    // Condiciones con otra forma no se interpretan: se rechazan antes de abrir la transacción.
    await expect(c.a.marcarEnviada(referencia(e), { soloPreparada: 'si' } as never)).rejects.toThrow('Condiciones');
    await expect(c.a.marcarEnviada(referencia(e), { otra: true } as never)).rejects.toThrow('Condiciones');
  });

  it('H1-L2 · dos reclamos con condición desde dos conexiones a la vez: exactamente uno gana y el otro no escribe', async () => {
    const c = await contexto(); const e = await c.preparar(); const b = await c.abrir();
    const r = await Promise.allSettled([c.a.marcarEnviada(referencia(e), { soloPreparada: true }),
      b.marcarEnviada(referencia(e), { soloPreparada: true })]);
    expect(r.map((x) => x.status).sort()).toEqual(['fulfilled', 'rejected']);
    const perdida = r.find((x): x is PromiseRejectedResult => x.status === 'rejected');
    expect(perdida?.reason).toMatchObject({ name: 'ErrorAdmisionRespaldo' });
    const ganada = r.find((x): x is PromiseFulfilledResult<EntradaRespaldo> => x.status === 'fulfilled');
    expect(ganada?.value).toMatchObject({ fase: 'enviada', enviada: true, pausada: false, operacionId });
    expect(await c.a.leer(fotoId)).toEqual(ganada?.value);
  });

  it('H1-L3 · la condición no rechaza el marcador propio ya escrito: tras reclamar, acuse y lecturas siguen', async () => {
    const c = await contexto(); const e = await c.preparar();
    const propia = await c.a.marcarEnviada(referencia(e), { soloPreparada: true });
    expect(propia).toMatchObject({ fase: 'enviada', enviada: true, operacionId });
    expect(await c.a.confirmarRecibo(recibo(e))).toMatchObject({ fase: 'respaldada', operacionId });
  });
});
