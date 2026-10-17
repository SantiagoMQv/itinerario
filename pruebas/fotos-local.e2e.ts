import { test, expect } from '@playwright/test';
import { createServer, type Server } from 'node:http';
import { build, type Rollup } from 'vite';

// Bibliotecas FUENTE ACTUAL, build en memoria. Sin UI, proveedores, SW ni descargas de fotos.
let servidor: Server;
let origen: string;
test.beforeAll(async () => {
  const resultado = await build({ configFile: false, logLevel: 'silent', build: {
    write: false, minify: false, rollupOptions: { preserveEntrySignatures: 'strict', input: {
      fotos: 'src/fotos.ts', local: 'src/fotos-local.ts', imagen: 'src/fotos-imagen.ts',
      plan: 'src/datos/itinerario.ts', progreso: 'src/progreso-local.ts',
    }, output: { entryFileNames: '[name].js', chunkFileNames: 'fragmento-[hash].js' } },
  } });
  const salida = (Array.isArray(resultado) ? resultado[0] : resultado) as Rollup.RollupOutput;
  const archivos = new Map(salida.output.filter((o) => o.type === 'chunk').map((o) => [o.fileName, o.code]));
  servidor = createServer((req, res) => {
    const nombre = new URL(req.url!, 'http://local').pathname.slice(1);
    res.setHeader('Cache-Control', 'no-store');
    if (archivos.has(nombre)) { res.setHeader('Content-Type', 'text/javascript'); res.end(archivos.get(nombre)); }
    else if (!nombre) { res.setHeader('Content-Type', 'text/html'); res.end('<!doctype html><title>Prueba local de fotos</title>'); }
    else { res.statusCode = 404; res.end(); }
  });
  await new Promise<void>((ok) => servidor.listen(0, '127.0.0.1', ok));
  const direccion = servidor.address();
  if (!direccion || typeof direccion === 'string') throw new Error('Sin puerto');
  origen = `http://127.0.0.1:${direccion.port}`;
});
test.afterAll(async () => { if (servidor) await new Promise<void>((ok, no) => servidor.close((e) => e ? no(e) : ok())); });
test.beforeEach(async ({ page }) => { await page.goto(origen); });

test('Blob/File nativo: bytes intactos tras reopen, tres formatos reales y miniatura lazy PNG', async ({ page }) => {
  const resultado = await page.evaluate(async () => {
    const rutas = ['/local.js', '/fotos.js', '/imagen.js', '/plan.js', '/progreso.js'];
    const [local, fotos, imagen, plan, progreso] = await Promise.all(rutas.map((r) => import(r)));
    const { itinerario } = plan;
    const destino = { tipo: 'parada', viajeId: itinerario.id, paradaId: itinerario.dias[0].paradas[0].id };
    const pref = localStorage.getItem('movil-que-marca');
    const cacheAntes = await caches.keys();
    const avance = await progreso.abrirProgresoLocal(itinerario, { dispositivoId: 'prueba' });
    const anterior = await avance.leer();
    const canvas = document.createElement('canvas'); canvas.width = 32; canvas.height = 48;
    canvas.getContext('2d')!.fillRect(0, 0, 32, 48);
    const formatos: { solicitado: string; real: string; identificado: string }[] = [];
    const lib = await local.abrirFotosLocal(itinerario);
    let decodificaciones = 0; let cierres = 0;
    const motor = imagen.crearMiniatura({ decodificar: async (b: Blob) => {
      decodificaciones++; const bitmap = await createImageBitmap(b, { imageOrientation: 'from-image' });
      return { ancho: bitmap.width, alto: bitmap.height, fuente: bitmap, cerrar: () => { cierres++; bitmap.close(); } };
    } });
    let id = ''; let original: number[] = []; let declarada = ''; let nombre = '';
    for (const formato of ['image/png', 'image/jpeg', 'image/webp']) {
      const b = await new Promise<Blob>((ok) => canvas.toBlob((b) => ok(b!), formato));
      const inspeccion = await imagen.inspeccionarImagen(b);
      formatos.push({ solicitado: formato, real: b.type, identificado: inspeccion.mime });
      const archivo = new File([b], ' 中 e\u0301 .dato ', { type: 'application/octet-stream', lastModified: 17 });
      const captura = fotos.crearCapturaFoto(itinerario, destino, archivo, 29);
      await lib.guardarOriginal(captura);
      if (formato === 'image/png') {
        id = captura.metadatos.fotoId; original = Array.from(new Uint8Array(await archivo.arrayBuffer()));
        declarada = captura.metadatos.mimeDeclarado; nombre = captura.metadatos.nombre;
      }
    }
    const lazy = decodificaciones === 0;
    lib.cerrar(); const nueva = await local.abrirFotosLocal(itinerario);
    const b = await nueva.leerOriginal(id);
    const intacto = JSON.stringify(Array.from(new Uint8Array(await b.arrayBuffer()))) === JSON.stringify(original);
    const thumb = await motor.generar(b, { ladoCss: 16, dpr: 2 });
    await nueva.guardarMiniatura(id, thumb.blob, thumb.ancho, thumb.alto);
    const guardada = await nueva.leerMiniatura(id);
    const bitmap = await createImageBitmap(guardada);
    const dimensiones = [bitmap.width, bitmap.height]; bitmap.close();
    const meta = await nueva.leerMetadatos(id);
    const peso = meta.bytesOriginal + meta.miniatura.bytes;
    // Segunda pasada explícita sobre los tres originales: decoder/canvas predeterminados reales.
    const motorNativo = imagen.crearMiniatura(); const nativas: string[] = [];
    for (const m of await nueva.listar()) {
      const salida = await motorNativo.generar(await nueva.leerOriginal(m.fotoId)); nativas.push(salida.blob.type);
    }
    motorNativo.cerrar();
    const progresoIntacto = JSON.stringify(anterior) === JSON.stringify(await avance.leer());
    avance.cerrar(); nueva.cerrar(); motor.cerrar(); canvas.width = 0; canvas.height = 0;
    const esquema = await new Promise<{ version: number; stores: string[] }>((ok) => {
      const s = indexedDB.open('itinerario-progreso');
      s.onsuccess = () => { ok({ version: s.result.version, stores: Array.from(s.result.objectStoreNames) }); s.result.close(); };
    });
    return { formatos, lazy, intacto, declarada, nombre, decodificaciones, cierres, dimensiones, peso,
      pesoEsperado: original.length + guardada.size, progresoIntacto, esquema,
      nativas, prefIntacta: pref === localStorage.getItem('movil-que-marca'), cacheIntacta: JSON.stringify(cacheAntes) === JSON.stringify(await caches.keys()) };
  });
  expect(resultado.formatos).toEqual(['image/png', 'image/jpeg', 'image/webp'].map((f) => ({ solicitado: f, real: f, identificado: f })));
  expect(resultado).toMatchObject({ lazy: true, intacto: true, declarada: 'application/octet-stream', nombre: ' 中 é .dato ',
    decodificaciones: 1, cierres: 1, dimensiones: [21, 32], progresoIntacto: true,
    esquema: { version: 1, stores: ['viajes'] }, prefIntacta: true, cacheIntacta: true });
  expect(resultado.peso).toBe(resultado.pesoEsperado);
  expect(resultado.nativas).toEqual(['image/png', 'image/png', 'image/png']);
});

test('dos conexiones IDB nativas: borrado gana a miniatura tardía sin resurrección', async ({ page }) => {
  const resultado = await page.evaluate(async () => {
    const rutas = ['/local.js', '/fotos.js', '/imagen.js', '/plan.js'];
    const [local, fotos, imagen, plan] = await Promise.all(rutas.map((r) => import(r)));
    const a = await local.abrirFotosLocal(plan.itinerario); const b = await local.abrirFotosLocal(plan.itinerario);
    const lienzo = new OffscreenCanvas(8, 16); lienzo.getContext('2d')!.fillRect(0, 0, 8, 16);
    const original = await lienzo.convertToBlob({ type: 'image/png' });
    const captura = fotos.crearCapturaFoto(plan.itinerario, { tipo: 'parada', viajeId: plan.itinerario.id,
      paradaId: plan.itinerario.dias[0].paradas[0].id }, new File([original], 'a.png'), 1);
    await a.guardarOriginal(captura); const id = captura.metadatos.fotoId;
    let liberar!: () => void; let inicio!: () => void;
    const iniciada = new Promise<void>((ok) => { inicio = ok; });
    const espera = new Promise<void>((ok) => { liberar = ok; });
    let cerrado = 0;
    const motor = imagen.crearMiniatura({ decodificar: async (blob: Blob) => {
      const bitmap = await createImageBitmap(blob); inicio(); await espera;
      return { ancho: bitmap.width, alto: bitmap.height, fuente: bitmap, cerrar: () => { cerrado++; bitmap.close(); } };
    } });
    const tardia = motor.generar(await a.leerOriginal(id));
    await iniciada; await b.borrarLocal(id); liberar(); const thumb = await tardia;
    let rechazo = false; let colision = false;
    try { await a.guardarMiniatura(id, thumb.blob, thumb.ancho, thumb.alto); } catch { rechazo = true; }
    try { await a.guardarOriginal(captura); } catch { colision = true; }
    a.cerrar(); b.cerrar(); motor.cerrar(); lienzo.width = 0; lienzo.height = 0;
    const nueva = await local.abrirFotosLocal(plan.itinerario);
    const meta = await nueva.leerMetadatos(id); const ausentes = await nueva.leerOriginal(id) === null && await nueva.leerMiniatura(id) === null;
    nueva.cerrar(); return { rechazo, colision, cerrado, meta, ausentes, id };
  });
  expect(resultado).toMatchObject({ rechazo: true, colision: true, cerrado: 1, ausentes: true });
  expect(resultado.meta).toEqual({ formato: 1, tipo: 'borrada', fotoId: resultado.id });
});

test('original activo/HEIC opaco se conserva; header enorme no llama decoder ni crea URL', async ({ page }) => {
  const resultado = await page.evaluate(async () => {
    const rutas = ['/local.js', '/fotos.js', '/imagen.js', '/plan.js'];
    const [local, fotos, imagen, plan] = await Promise.all(rutas.map((r) => import(r)));
    const lib = await local.abrirFotosLocal(plan.itinerario);
    let decodes = 0; let urls = 0;
    const urlOriginal = URL.createObjectURL;
    URL.createObjectURL = (...args) => { urls++; return urlOriginal.apply(URL, args); };
    const motor = imagen.crearMiniatura({ decodificar: async (blob: Blob) => { decodes++;
      const bitmap = await createImageBitmap(blob); return { ancho: bitmap.width, alto: bitmap.height, fuente: bitmap, cerrar: () => bitmap.close() }; } });
    const originales = [new File(['<svg onload="globalThis.activoEjecutado=true"/>'], 'a.png', { type: 'image/png' }),
      new File(['heic-opaco'], 'a.heic', { type: 'image/heic' })];
    let intactos = true;
    for (const archivo of originales) {
      const captura = fotos.crearCapturaFoto(plan.itinerario, { tipo: 'parada', viajeId: plan.itinerario.id,
        paradaId: plan.itinerario.dias[0].paradas[0].id }, archivo, 1);
      await lib.guardarOriginal(captura);
      const leido = await lib.leerOriginal(captura.metadatos.fotoId);
      intactos &&= await leido.text() === await archivo.text();
      const salida = await motor.generar(leido); if (salida.tipo !== 'no-disponible') throw new Error('Opaco se renderizó');
    }
    // Solo 33 bytes de cabecera sintética: no asignamos la imagen de 64 MP.
    const b = new Uint8Array(33); b.set([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82]);
    const v = new DataView(b.buffer); v.setUint32(16, 8000); v.setUint32(20, 8000); b[24] = 8; b[25] = 6;
    const grande = await motor.generar(new Blob([b]));
    URL.createObjectURL = urlOriginal; lib.cerrar(); motor.cerrar();
    return { intactos, decodes, urls, grande: grande.tipo, activo: Object.hasOwn(globalThis, 'activoEjecutado') };
  });
  expect(resultado).toEqual({ intactos: true, decodes: 0, urls: 0, grande: 'no-disponible', activo: false });
});

test('cuota SIMULADA en original y fallo parcial de miniatura sobre IDB/Blob nativos', async ({ page }) => {
  const resultado = await page.evaluate(async () => {
    const rutas = ['/local.js', '/fotos.js', '/plan.js'];
    const [local, fotos, plan] = await Promise.all(rutas.map((r) => import(r)));
    const lib = await local.abrirFotosLocal(plan.itinerario);
    const captura = fotos.crearCapturaFoto(plan.itinerario, { tipo: 'parada', viajeId: plan.itinerario.id,
      paradaId: plan.itinerario.dias[0].paradas[0].id }, new File(['bytes'], 'a'), 1);
    const agregar = IDBObjectStore.prototype.add;
    IDBObjectStore.prototype.add = function (...args) {
      if (this.name === 'originales') throw new DOMException('Cuota SIMULADA', 'QuotaExceededError'); return agregar.apply(this, args);
    };
    let rechazo = false;
    try { await lib.guardarOriginal(captura); } catch { rechazo = true; }
    finally { IDBObjectStore.prototype.add = agregar; }
    const vacio = (await lib.listar()).length === 0;
    await lib.guardarOriginal(captura);
    const put = IDBObjectStore.prototype.put;
    IDBObjectStore.prototype.put = function (...args) {
      if (this.name === 'miniaturas') throw new DOMException('Cuota miniatura SIMULADA', 'QuotaExceededError'); return put.apply(this, args);
    };
    let parcial = false;
    try { await lib.guardarMiniatura(captura.metadatos.fotoId, new Blob(['png'], { type: 'image/png' }), 1, 1); } catch { parcial = true; }
    finally { IDBObjectStore.prototype.put = put; }
    lib.cerrar(); const nueva = await local.abrirFotosLocal(plan.itinerario);
    const metadata = await nueva.leerMetadatos(captura.metadatos.fotoId);
    const intacto = await (await nueva.leerOriginal(captura.metadatos.fotoId)).text() === 'bytes';
    const thumbAusente = await nueva.leerMiniatura(captura.metadatos.fotoId) === null; nueva.cerrar();
    return { rechazo, vacio, parcial, intacto, thumbAusente, estado: metadata.miniatura.tipo };
  });
  expect(resultado).toEqual({ rechazo: true, vacio: true, parcial: true, intacto: true, thumbAusente: true, estado: 'pendiente' });
});

test('corrupción nativa visible conserva original y no borra bytes desconocidos', async ({ page }) => {
  const resultado = await page.evaluate(async () => {
    const rutas = ['/local.js', '/fotos.js', '/plan.js'];
    const [local, fotos, plan] = await Promise.all(rutas.map((r) => import(r)));
    const lib = await local.abrirFotosLocal(plan.itinerario);
    const captura = fotos.crearCapturaFoto(plan.itinerario, { tipo: 'parada', viajeId: plan.itinerario.id,
      paradaId: plan.itinerario.dias[0].paradas[0].id }, new File(['intacto'], 'a'), 1);
    await lib.guardarOriginal(captura); lib.cerrar();
    const db = await new Promise<IDBDatabase>((ok) => { const s = indexedDB.open(`itinerario-fotos:${encodeURIComponent(plan.itinerario.id)}`);
      s.onsuccess = () => ok(s.result); });
    await new Promise<void>((ok) => { const tx = db.transaction('metadatos', 'readwrite');
      tx.objectStore('metadatos').put({ formato: 99, fotoId: captura.metadatos.fotoId }, captura.metadatos.fotoId); tx.oncomplete = () => ok(); });
    const nueva = await local.abrirFotosLocal(plan.itinerario); let error = false;
    try { await nueva.listar(); } catch { error = true; }
    const blob = await new Promise<Blob>((ok) => { const s = db.transaction('originales').objectStore('originales').get(captura.metadatos.fotoId);
      s.onsuccess = () => ok(s.result); });
    const bytes = await blob.text(); nueva.cerrar(); db.close(); return { error, bytes };
  });
  expect(resultado).toEqual({ error: true, bytes: 'intacto' });
});

test('dos conexiones nativas concurrentes: una captura gana sin sobrescribir y versionchange cierra handles', async ({ page }) => {
  const resultado = await page.evaluate(async () => {
    const rutas = ['/local.js', '/fotos.js', '/plan.js'];
    const [local, fotos, plan] = await Promise.all(rutas.map((r) => import(r)));
    const nombre = 'concurrencia-fotos';
    const a = await local.abrirFotosLocal(plan.itinerario, { nombre }); const b = await local.abrirFotosLocal(plan.itinerario, { nombre });
    const captura = fotos.crearCapturaFoto(plan.itinerario, { tipo: 'parada', viajeId: plan.itinerario.id,
      paradaId: plan.itinerario.dias[0].paradas[0].id }, new File(['primera'], 'a'), 1);
    const salidas = await Promise.allSettled([a.guardarOriginal(captura), b.guardarOriginal(captura)]);
    const bytes = await (await a.leerOriginal(captura.metadatos.fotoId)).text();
    // v3: una versión FUTURA respecto a la PhotoDB actual (v2).
    const actualizado = await new Promise<IDBDatabase>((ok, no) => {
      const s = indexedDB.open(nombre, 3); s.onsuccess = () => ok(s.result); s.onerror = () => no(s.error);
      s.onblocked = () => no(new Error('La biblioteca no liberó handles'));
    });
    let cerrada = false;
    try { await a.listar(); } catch { cerrada = true; }
    actualizado.close(); a.cerrar(); b.cerrar();
    return { estados: salidas.map((s) => s.status).sort(), bytes, cerrada };
  });
  expect(resultado).toEqual({ estados: ['fulfilled', 'rejected'], bytes: 'primera', cerrada: true });
});

test('fallback HTML canvas nativo produce PNG y libera su backing canvas', async ({ page }) => {
  const resultado = await page.evaluate(async () => {
    const ruta = '/imagen.js'; const imagen = await import(ruta);
    const fuente = document.createElement('canvas'); fuente.width = 12; fuente.height = 24;
    fuente.getContext('2d')!.fillRect(0, 0, 12, 24);
    const original = await new Promise<Blob>((ok) => fuente.toBlob((b) => ok(b!), 'image/png'));
    const crear = document.createElement.bind(document); const lienzos: HTMLCanvasElement[] = [];
    document.createElement = ((nombre: string, opciones?: ElementCreationOptions) => {
      const elemento = crear(nombre, opciones); if (nombre === 'canvas') lienzos.push(elemento as HTMLCanvasElement); return elemento;
    }) as typeof document.createElement;
    const offscreen = globalThis.OffscreenCanvas;
    Object.defineProperty(globalThis, 'OffscreenCanvas', { value: undefined, configurable: true, writable: true });
    const motor = imagen.crearMiniatura();
    let salida;
    try { salida = await motor.generar(original); }
    finally { motor.cerrar(); document.createElement = crear;
      Object.defineProperty(globalThis, 'OffscreenCanvas', { value: offscreen, configurable: true, writable: true }); }
    fuente.width = 0; fuente.height = 0;
    return { tipo: salida.tipo, mime: salida.blob.type, dimensiones: [salida.ancho, salida.alto],
      liberados: lienzos.length === 1 && lienzos.every((c) => c.width === 0 && c.height === 0) };
  });
  expect(resultado).toEqual({ tipo: 'lista', mime: 'image/png', dimensiones: [12, 24], liberados: true });
});

test('IDB nativa: request success y abort posterior nunca confirman guardado', async ({ page }) => {
  const resultado = await page.evaluate(async () => {
    const ruta = '/local.js'; const { abrirFotosLocal } = await import(ruta);
    const fotosRuta = '/fotos.js'; const { crearCapturaFoto } = await import(fotosRuta);
    const planRuta = '/plan.js'; const { itinerario } = await import(planRuta);
    const lib = await abrirFotosLocal(itinerario);
    const captura = crearCapturaFoto(itinerario, { tipo: 'parada', viajeId: itinerario.id,
      paradaId: itinerario.dias[0].paradas[0].id }, new File(['original'], 'a.png'), 1);
    const agregar = IDBObjectStore.prototype.add;
    IDBObjectStore.prototype.add = function (...args) {
      const s = agregar.apply(this, args);
      if (this.name === 'metadatos') s.addEventListener('success', () => this.transaction.abort());
      return s;
    };
    let guardada = false;
    try { await lib.guardarOriginal(captura); guardada = true; } catch { /* Aborto esperado. */ }
    finally { IDBObjectStore.prototype.add = agregar; lib.cerrar(); }
    const nueva = await abrirFotosLocal(itinerario);
    const lista = await nueva.listar(); const original = await nueva.leerOriginal(captura.metadatos.fotoId);
    nueva.cerrar(); return { guardada, cantidad: lista.length, original: original !== null };
  });
  expect(resultado).toEqual({ guardada: false, cantidad: 0, original: false });
});

test('PhotoDB v1 nativa pasa a v2 al abrir: «procedencias» vacía y bytes intactos; solo la vía cámara/galería deja marca', async ({ page }) => {
  const r = await page.evaluate(async () => {
    const [local, fotos, plan] = await Promise.all(['/local.js', '/fotos.js', '/plan.js'].map((x) => import(x)));
    const nombre = 'migracion-fotos';
    const destino = { tipo: 'parada', viajeId: plan.itinerario.id, paradaId: plan.itinerario.dias[0].paradas[0].id };
    // Fixture v1 EXPLÍCITA, con la forma exacta de la versión anterior.
    const v1 = await new Promise<IDBDatabase>((ok, no) => {
      const s = indexedDB.open(nombre, 1);
      s.onupgradeneeded = () => ['metadatos', 'originales', 'miniaturas'].forEach((t) => s.result.createObjectStore(t));
      s.onsuccess = () => ok(s.result); s.onerror = () => no(s.error);
    });
    const vieja = fotos.crearCapturaFoto(plan.itinerario, destino, new File(['vieja'], 'v.bin'), 1);
    await new Promise<void>((ok, no) => {
      const tx = v1.transaction(['metadatos', 'originales'], 'readwrite');
      tx.objectStore('metadatos').put(vieja.metadatos, vieja.metadatos.fotoId);
      tx.objectStore('originales').put(vieja.original, vieja.metadatos.fotoId);
      tx.oncomplete = () => ok(); tx.onabort = () => no(tx.error);
    });
    v1.close();
    const lib = await local.abrirFotosLocal(plan.itinerario, { nombre });
    const nueva = fotos.crearCapturaFoto(plan.itinerario, destino, new File(['nueva'], 'n.bin'), 2);
    await lib.guardarOriginal(nueva, 'camara-galeria');
    const marcaNueva = (await lib.leerProcedencia?.(nueva.metadatos.fotoId)) ?? null;
    const marcaVieja = (await lib.leerProcedencia?.(vieja.metadatos.fotoId)) ?? null;
    const bytesVieja = await (await lib.leerOriginal(vieja.metadatos.fotoId)).text();
    lib.cerrar();
    const crudo = await new Promise<{ version: number; almacenes: string[] }>((ok) => {
      const s = indexedDB.open(nombre);
      s.onsuccess = () => { ok({ version: s.result.version, almacenes: Array.from(s.result.objectStoreNames) }); s.result.close(); };
    });
    return { crudo, marcaNueva, marcaVieja, bytesVieja };
  });
  expect(r).toEqual({ crudo: { version: 2, almacenes: ['metadatos', 'miniaturas', 'originales', 'procedencias'] },
    marcaNueva: 'camara-galeria', marcaVieja: null, bytesVieja: 'vieja' });
});
