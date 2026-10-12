import { test, expect } from '@playwright/test';
import { createServer, type Server } from 'node:http';
import { build, type Rollup } from 'vite';

// FUENTE actual en memoria; navegador aislado, sin UI/SW/proveedores ni base del usuario.
let servidor: Server;
let origen: string;
test.beforeAll(async () => {
  const resultado = await build({ configFile: false, logLevel: 'silent', build: {
    write: false, minify: false, rollupOptions: { preserveEntrySignatures: 'strict', input: {
      identidad: 'src/fotos-identidad.ts', fotos: 'src/fotos.ts', local: 'src/fotos-local.ts',
      plan: 'src/datos/itinerario.ts', progreso: 'src/progreso-local.ts',
    }, output: { entryFileNames: '[name].js', chunkFileNames: 'fragmento-[hash].js' } },
  } });
  const salida = (Array.isArray(resultado) ? resultado[0] : resultado) as Rollup.RollupOutput;
  const archivos = new Map(salida.output.filter((o) => o.type === 'chunk').map((o) => [o.fileName, o.code]));
  servidor = createServer((req, res) => {
    const nombre = new URL(req.url!, 'http://local').pathname.slice(1);
    res.setHeader('Cache-Control', 'no-store');
    if (archivos.has(nombre)) { res.setHeader('Content-Type', 'text/javascript'); res.end(archivos.get(nombre)); }
    else if (!nombre) { res.setHeader('Content-Type', 'text/html'); res.end('<!doctype html><title>Identidad local</title>'); }
    else { res.statusCode = 404; res.end(); }
  });
  await new Promise<void>((ok) => servidor.listen(0, '127.0.0.1', ok));
  const direccion = servidor.address();
  if (!direccion || typeof direccion === 'string') throw new Error('Sin puerto');
  origen = `http://127.0.0.1:${direccion.port}`;
});
test.afterAll(async () => { if (servidor) await new Promise<void>((ok, no) => servidor.close((e) => e ? no(e) : ok())); });
test.beforeEach(async ({ page }) => {
  await page.route('**/*', (ruta) => new URL(ruta.request().url()).origin === origen ? ruta.continue() : ruta.abort());
  await page.goto(origen);
});

test('Chromium: commit/reopen, colisión B bajo UUID A, miniatura mutable y esquema T5 intacto', async ({ page }) => {
  const r = await page.evaluate(async () => {
    const rutas = ['/identidad.js', '/local.js', '/fotos.js', '/plan.js', '/progreso.js'];
    const [identidad, local, fotos, plan, progreso] = await Promise.all(rutas.map((ruta) => import(ruta)));
    const { itinerario } = plan;
    const avance = await progreso.abrirProgresoLocal(itinerario, { dispositivoId: 'identidad-prueba' });
    const progresoAntes = await avance.leer(); const cacheAntes = await caches.keys();
    const prefAntes = localStorage.getItem('movil-que-marca');
    const destino = { tipo: 'parada', viajeId: itinerario.id, paradaId: itinerario.dias[0].paradas[0].id };
    const datos = new Uint8Array(2 * identidad.BLOQUE_IDENTIDAD_FOTO + 17); datos.fill(43);
    const otros = datos.slice(); otros[otros.length - 1] = 44;
    const archivo = new File([datos], '\0 e\u0301 ', { type: 'image/heic', lastModified: 17 });
    const captura = fotos.crearCapturaFoto(itinerario, destino, archivo, 29);
    const b = { metadatos: captura.metadatos, original: new Blob([otros], { type: 'image/heic' }) };
    const a = await local.abrirFotosLocal(itinerario);
    await a.guardarOriginal(captura); // Respuesta descartada: commit verdadero, no ACK remoto.
    a.cerrar(); const nueva = await local.abrirFotosLocal(itinerario);
    const segunda = await local.abrirFotosLocal(itinerario);
    const comprobar = (c = captura) => identidad.comprobarIdentidadFoto(itinerario, nueva, c.metadatos, c.original);
    const misma = (await comprobar()).tipo;
    const otra = (await comprobar(b)).tipo;
    let rechazoB = false; let rechazoA = false;
    try { await segunda.guardarOriginal(b); } catch { rechazoB = true; }
    try { await segunda.guardarOriginal(captura); } catch { rechazoA = true; }
    const intacto = (await identidad.compararOriginalesFoto(await nueva.leerOriginal(captura.metadatos.fotoId), archivo)).tipo;
    const canvas = new OffscreenCanvas(2, 3); canvas.getContext('2d')!.fillRect(0, 0, 2, 3);
    const thumb = await canvas.convertToBlob({ type: 'image/png' });
    await segunda.guardarMiniatura(captura.metadatos.fotoId, thumb, 2, 3);
    const derivada = await comprobar();
    const db = await new Promise<IDBDatabase>((ok, no) => {
      const s = indexedDB.open(`itinerario-fotos:${encodeURIComponent(itinerario.id)}`);
      s.onsuccess = () => ok(s.result); s.onerror = () => no(s.error);
    });
    const esquemaFotos = { version: db.version, tablas: Array.from(db.objectStoreNames), estructuras: [] as unknown[] };
    for (const nombre of Array.from(db.objectStoreNames)) {
      const t = db.transaction(nombre).objectStore(nombre);
      esquemaFotos.estructuras.push({ keyPath: t.keyPath, autoIncrement: t.autoIncrement, indices: Array.from(t.indexNames) });
    }
    db.close();
    const progresoDespues = await avance.leer(); avance.cerrar();
    const esquemaProgreso = await new Promise<{ version: number; tablas: string[] }>((ok, no) => {
      const s = indexedDB.open('itinerario-progreso'); s.onerror = () => no(s.error);
      s.onsuccess = () => { ok({ version: s.result.version, tablas: Array.from(s.result.objectStoreNames) }); s.result.close(); };
    });
    await segunda.borrarLocal(captura.metadatos.fotoId);
    nueva.cerrar(); segunda.cerrar(); const reabierta = await local.abrirFotosLocal(itinerario);
    const borrada = await identidad.comprobarIdentidadFoto(itinerario, reabierta, captura.metadatos, archivo);
    const originalBorrado = await reabierta.leerOriginal(captura.metadatos.fotoId) === null;
    let resurreccionRechazada = false;
    try { await reabierta.guardarOriginal(captura); } catch { resurreccionRechazada = true; }
    reabierta.cerrar();
    return { misma, otra, rechazoB, rechazoA, intacto, derivada: derivada.tipo,
      miniatura: derivada.metadatos.miniatura.tipo, esquemaFotos, esquemaProgreso,
      progresoAntes, progresoDespues, cacheAntes, cacheDespues: await caches.keys(),
      prefAntes, prefDespues: localStorage.getItem('movil-que-marca'), borrada: borrada.tipo,
      originalBorrado, resurreccionRechazada };
  });
  expect(r).toMatchObject({ misma: 'misma', otra: 'otra', rechazoB: true, rechazoA: true, intacto: 'iguales',
    derivada: 'misma', miniatura: 'lista', borrada: 'borrada', originalBorrado: true, resurreccionRechazada: true,
    esquemaFotos: { version: 1, tablas: ['metadatos', 'miniaturas', 'originales'],
      estructuras: Array(3).fill({ keyPath: null, autoIncrement: false, indices: [] }) },
    esquemaProgreso: { version: 1, tablas: ['viajes'] } });
  expect(r.progresoDespues).toEqual(r.progresoAntes);
  expect(r.progresoDespues.formato).toBe(3);
  expect(Object.keys(r.progresoDespues).sort()).toEqual(['cola', 'confirmado', 'estado', 'formato', 'revisionServidor']);
  expect(r.cacheDespues).toEqual(r.cacheAntes); expect(r.prefDespues).toBe(r.prefAntes);
});

test('Chromium: tombstone entre lecturas en dos conexiones impide SAME, sin resurrección', async ({ page }) => {
  const r = await page.evaluate(async () => {
    const rutas = ['/identidad.js', '/local.js', '/fotos.js', '/plan.js'];
    const [identidad, local, fotos, plan] = await Promise.all(rutas.map((ruta) => import(ruta)));
    const { itinerario } = plan;
    const captura = fotos.crearCapturaFoto(itinerario, { tipo: 'parada', viajeId: itinerario.id,
      paradaId: itinerario.dias[0].paradas[0].id }, new File(['original'], 'a'), 1);
    const a = await local.abrirFotosLocal(itinerario); const b = await local.abrirFotosLocal(itinerario);
    await a.guardarOriginal(captura);
    const orden: string[] = [];
    const puerto = {
      leerMetadatos: async (id: string) => { orden.push('metadata'); return a.leerMetadatos(id); },
      leerOriginal: async (id: string) => {
        orden.push('original'); const original = await a.leerOriginal(id);
        await b.borrarLocal(id); return original;
      },
    };
    const final = await identidad.comprobarIdentidadFoto(itinerario, puerto, captura.metadatos, captura.original);
    a.cerrar(); b.cerrar(); const nueva = await local.abrirFotosLocal(itinerario);
    const durable = await nueva.leerMetadatos(captura.metadatos.fotoId);
    nueva.cerrar(); return { final: final.tipo, durable: durable.tipo, orden };
  });
  expect(r).toEqual({ final: 'borrada', durable: 'borrada', orden: ['metadata', 'original', 'metadata'] });
});

test('Chromium: Blob nativo ignora overrides propios y metadata final mutada no es SAME', async ({ page }) => {
  const r = await page.evaluate(async () => {
    const rutas = ['/identidad.js', '/local.js', '/fotos.js', '/plan.js'];
    const [identidad, local, fotos, plan] = await Promise.all(rutas.map((ruta) => import(ruta)));
    const { itinerario } = plan;
    const archivo = new File(['abc'], 'a', { type: 'image/heic' }); let getters = 0;
    const captura = fotos.crearCapturaFoto(itinerario, { tipo: 'parada', viajeId: itinerario.id,
      paradaId: itinerario.dias[0].paradas[0].id }, archivo, 1);
    const lib = await local.abrirFotosLocal(itinerario); await lib.guardarOriginal(captura);
    for (const clave of ['size', 'type', 'slice', 'arrayBuffer']) {
      Object.defineProperty(archivo, clave, { get() { getters++; throw new Error('Propio falsificado'); } });
    }
    const positiva = await identidad.comprobarIdentidadFoto(itinerario, lib, captura.metadatos, archivo);
    // Escritura cruda de prueba fuera del contrato no-ABA: se detecta metadata final cambiada.
    const db = await new Promise<IDBDatabase>((ok) => {
      const s = indexedDB.open(`itinerario-fotos:${encodeURIComponent(itinerario.id)}`); s.onsuccess = () => ok(s.result);
    });
    const puerto = { leerMetadatos: (id: string) => lib.leerMetadatos(id), leerOriginal: async (id: string) => {
      const original = await lib.leerOriginal(id);
      await new Promise<void>((ok, no) => {
        const tx = db.transaction('metadatos', 'readwrite');
        tx.objectStore('metadatos').put({ ...captura.metadatos, nombre: 'otra' }, id);
        tx.oncomplete = () => ok(); tx.onabort = () => no(tx.error);
      });
      return original;
    } };
    const cambiada = await identidad.comprobarIdentidadFoto(itinerario, puerto, captura.metadatos, archivo);
    db.close(); lib.cerrar(); return { positiva: positiva.tipo, cambiada: cambiada.tipo, getters };
  });
  expect(r).toEqual({ positiva: 'misma', cambiada: 'incierta', getters: 0 });
});
