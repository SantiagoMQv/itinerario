// Fotos locales desde la interfaz real (dist recompilado por el webServer de Playwright), con Blob/File,
// IndexedDB nativa y decodificación de Chromium. Sin red para fotos: /api/progreso se corta salvo en el caso
// de dos móviles, que usa el controlador y el almacén REALES del progreso con una pasarela en memoria.
// No prueba Safari, HEIC, cámara, galería, cuota ni evicción físicas.
import { type Browser, type BrowserContext, type Locator, type Page, type Route, expect, test } from '@playwright/test';
import { itinerario } from '../src/datos/itinerario';
import { crearProgreso } from '../src/progreso';
import type { InstantaneaProgreso } from '../src/progreso-validacion';
import { crearControladorProgreso, type ControladorProgreso } from '../servidor/api-progreso';
import { crearAlmacenProgreso, type DecisionHistorica } from '../servidor/almacen-progreso';

const HORA = '2026-10-22T13:30:00+08:00';
const PARADA = 'c80e3471f9ab562d'; // Middle Huaihai Road: TX Huaihai
const SUB = 'eb6438fa172dc905'; // Pane, dentro de esa parada
const BASE_FOTOS = `itinerario-fotos:${encodeURIComponent(itinerario.id)}`;
const opcionesMovil = { baseURL: 'http://localhost:4173', locale: 'es-ES', viewport: { width: 390, height: 844 },
  deviceScaleFactor: 2, isMobile: true, hasTouch: true, serviceWorkers: 'block' as const };

/** Instrumentación del navegador: archivos elegidos, decodificaciones y URLs blob vivas. */
async function instrumentar(contexto: BrowserContext) {
  await contexto.addInitScript(() => {
    const w = window as unknown as Record<string, unknown>;
    w.__elegidos = [] as { nombre: string; tipo: string; modificado: number; bytes: number }[];
    document.addEventListener('change', (e) => {
      const input = e.target as HTMLInputElement;
      if (input.type === 'file') for (const f of input.files ?? []) (w.__elegidos as unknown[]).push({ nombre: f.name, tipo: f.type, modificado: f.lastModified, bytes: f.size });
    }, true);
    w.__decodificaciones = 0;
    const decodificar = globalThis.createImageBitmap.bind(globalThis);
    globalThis.createImageBitmap = ((...args: Parameters<typeof createImageBitmap>) => {
      w.__decodificaciones = (w.__decodificaciones as number) + 1;
      const espera = w.__esperaDecode as Promise<void> | undefined;
      return espera ? espera.then(() => decodificar(...args)) : decodificar(...args);
    }) as typeof createImageBitmap;
    const vivas = new Set<string>();
    w.__urlsVivas = () => vivas.size;
    const crear = URL.createObjectURL.bind(URL); const revocar = URL.revokeObjectURL.bind(URL);
    URL.createObjectURL = (o: Blob | MediaSource) => { const u = crear(o); vivas.add(u); return u; };
    URL.revokeObjectURL = (u: string) => { vivas.delete(u); revocar(u); };
  });
}
async function abrirApp(page: Page) {
  await page.clock.setFixedTime(new Date(HORA));
  await page.goto('/');
  await expect(page.locator('#contenido')).not.toBeEmpty();
}
async function movilSinRed(browser: Browser) {
  const contexto = await browser.newContext(opcionesMovil);
  await contexto.route(/^https?:\/\/(?!localhost)/, (r) => r.abort());
  await contexto.route((url) => url.pathname === '/api/progreso', (r) => r.abort());
  await instrumentar(contexto);
  await contexto.addInitScript(() => { if (localStorage.getItem('marcador') === null) localStorage.setItem('marcador', 'true'); });
  const page = await contexto.newPage();
  const errores: string[] = [];
  page.on('pageerror', (e) => errores.push(e.message));
  await abrirApp(page);
  return { contexto, page, errores };
}

/** Abre la ficha de la parada en la lista (la hoja sube) y devuelve su li. */
async function abrirFicha(page: Page, nombre = 'TX Huaihai') {
  const fila = page.locator('#contenido li.parada .fila', { hasText: nombre });
  await fila.click();
  const li = page.locator('#contenido li.parada.abierta', { hasText: nombre });
  await expect(li).toBeVisible();
  await expect(page.locator('#asa')).toHaveAttribute('aria-expanded', 'true');
  return li;
}
const bloque = (page: Page, clave: string) => page.locator(`[data-fotos-destino="${clave}"]`);
async function abrirFotos(page: Page, clave: string) {
  const b = bloque(page, clave);
  const alternar = b.locator('[data-fotos-alternar]');
  await alternar.scrollIntoViewIfNeeded();
  if (await alternar.getAttribute('aria-expanded') !== 'true') await alternar.click();
  await expect(alternar).toHaveAttribute('aria-expanded', 'true');
  await expect(b.locator('[data-fotos-anadir]')).toBeVisible();
  return b;
}
interface Archivo { name: string; mimeType: string; buffer: Buffer }
async function anadir(page: Page, b: Locator, archivo: Archivo | null) {
  const selector = page.waitForEvent('filechooser');
  await b.locator('[data-fotos-anadir]').click();
  const elegido = await selector;
  await elegido.setFiles(archivo ? [archivo] : []);
}
/** Imagen genuina generada por el propio Chromium (canvas), sin librerías. */
async function imagen(page: Page, tipo: 'image/png' | 'image/jpeg' | 'image/webp', ancho = 24, alto = 36): Promise<Buffer> {
  const bytes = await page.evaluate(async ({ tipo, ancho, alto }) => {
    const c = document.createElement('canvas'); c.width = ancho; c.height = alto;
    const g = c.getContext('2d')!; g.fillStyle = '#2453d1'; g.fillRect(0, 0, ancho, alto); g.fillStyle = '#ddf94a'; g.fillRect(2, 2, 6, 9);
    const blob = await new Promise<Blob>((ok) => c.toBlob((b) => ok(b!), tipo, 0.9));
    c.width = 0; c.height = 0;
    return Array.from(new Uint8Array(await blob.arrayBuffer()));
  }, { tipo, ancho, alto });
  return Buffer.from(bytes);
}
/** Solo la cabecera PNG de una imagen de 6000×6000 (36 MP): fuera del presupuesto de previsualización. */
function cabeceraEnorme(): Buffer {
  const b = Buffer.alloc(45);
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13]).copy(b, 0);
  b.write('IHDR', 12, 'latin1'); b.writeUInt32BE(6000, 16); b.writeUInt32BE(6000, 20);
  b[24] = 8; b[25] = 6;
  return b;
}
/** Metadata y original tal como quedaron en IndexedDB (lectura directa, no la interfaz). */
const enBase = (page: Page) => page.evaluate((nombre) => new Promise<{ id: string; destino: Record<string, string>; nombre: string;
  mime: string; modificado: number; bytes: number; miniatura: string; original: number[] | null; borrada: boolean }[]>((ok, ko) => {
  void indexedDB.databases().then((bases) => {
    if (!bases.some((b) => b.name === nombre)) { ok([]); return; }
    const r = indexedDB.open(nombre);
    r.onerror = () => ko(r.error);
    r.onsuccess = () => {
      const db = r.result; const tx = db.transaction(['metadatos', 'originales']);
      const m = tx.objectStore('metadatos').getAll(); const k = tx.objectStore('metadatos').getAllKeys();
      const o = tx.objectStore('originales').getAll(); const ok2 = tx.objectStore('originales').getAllKeys();
      tx.oncomplete = async () => {
        const originales = new Map<IDBValidKey, Blob>(ok2.result.map((clave, i) => [clave, o.result[i] as Blob]));
        const salida = [];
        for (const [i, v] of (m.result as Record<string, unknown>[]).entries()) {
          const original = originales.get(k.result[i]);
          salida.push({ id: String(k.result[i]), destino: (v.destino ?? {}) as Record<string, string>, nombre: v.nombre as string,
            mime: v.mimeDeclarado as string, modificado: v.ultimaModificacion as number, bytes: v.bytesOriginal as number,
            miniatura: (v.miniatura as { tipo: string } | undefined)?.tipo ?? '', borrada: v.tipo === 'borrada',
            original: original ? Array.from(new Uint8Array(await original.arrayBuffer())) : null });
        }
        db.close(); ok(salida);
      };
      tx.onabort = () => { db.close(); ko(tx.error); };
    };
  }, ko);
}), BASE_FOTOS);

test.describe('fotos locales en la interfaz del viaje', () => {
  test('parada y subparada: destino persistente, bytes exactos y vista previa que se conserva al reabrir', async ({ browser }) => {
    const { page, errores } = await movilSinRed(browser);
    await abrirFicha(page);
    const parada = await abrirFotos(page, `p:${PARADA}`);
    await expect(parada).toContainText('Aún no hay fotos');
    const png = await imagen(page, 'image/png');
    await anadir(page, parada, { name: ' Vista 中 é.png ', mimeType: 'image/png', buffer: png });
    await expect(parada.locator('[data-foto-id]')).toHaveCount(1);
    await expect(parada.locator('[data-foto-id] img')).toHaveJSProperty('complete', true);
    expect(await parada.locator('[data-foto-id] img').evaluate((i) => (i as HTMLImageElement).naturalWidth)).toBeGreaterThan(0);
    await expect(parada.locator('.fotos-estado')).toContainText('Guardada en este móvil');
    await expect(parada.locator('[data-fotos-alternar]')).toContainText('1');
    const webp = await imagen(page, 'image/webp', 30, 20);
    await anadir(page, parada, { name: 'tienda.webp', mimeType: 'image/webp', buffer: webp });
    await expect(parada.locator('[data-foto-id] img')).toHaveCount(2);

    // Subparada «Pane», dentro de la misma ficha.
    await page.locator('#contenido li.parada.abierta .sub-fila', { hasText: 'Pane' }).click();
    const sub = await abrirFotos(page, `s:${PARADA}:${SUB}`);
    const jpeg = await imagen(page, 'image/jpeg', 40, 30);
    await anadir(page, sub, { name: 'pane.jpg', mimeType: 'image/jpeg', buffer: jpeg });
    await expect(sub.locator('[data-foto-id] img')).toHaveCount(1);
    await expect(parada.locator('[data-foto-id]')).toHaveCount(2);

    const elegidos = await page.evaluate(() => (window as unknown as { __elegidos: { nombre: string; tipo: string; modificado: number; bytes: number }[] }).__elegidos);
    const guardadas = await enBase(page);
    expect(guardadas).toHaveLength(3);
    const porNombre = new Map(guardadas.map((g) => [g.nombre, g]));
    for (const e of elegidos) {
      const g = porNombre.get(e.nombre)!;
      expect(g).toMatchObject({ mime: e.tipo, modificado: e.modificado, bytes: e.bytes, miniatura: 'lista' });
    }
    expect(porNombre.get(' Vista 中 é.png ')!.original).toEqual(Array.from(png));
    expect(porNombre.get(' Vista 中 é.png ')!.destino).toEqual({ tipo: 'parada', viajeId: itinerario.id, paradaId: PARADA });
    expect(porNombre.get('pane.jpg')!.destino).toEqual({ tipo: 'subparada', viajeId: itinerario.id, paradaId: PARADA, subparadaId: SUB });
    expect(porNombre.get('pane.jpg')!.original).toEqual(Array.from(jpeg));

    // Reabrir la app: siguen ahí, con su vista previa y sin decodificar de nuevo.
    await page.reload();
    await expect(page.locator('#contenido')).not.toBeEmpty();
    await abrirFicha(page);
    const otra = await abrirFotos(page, `p:${PARADA}`);
    await expect(otra.locator('[data-foto-id] img')).toHaveCount(2);
    expect(await page.evaluate(() => (window as unknown as { __decodificaciones: number }).__decodificaciones)).toBe(0);
    expect(errores).toEqual([]);
  });

  test('el destino se fija al abrir el selector; cancelar no guarda; el mismo archivo dos veces son dos fotos', async ({ browser }) => {
    const { page } = await movilSinRed(browser);
    await abrirFicha(page);
    const parada = await abrirFotos(page, `p:${PARADA}`);
    const png = await imagen(page, 'image/png');
    // Con el selector abierto se cambia de día: la foto sigue yendo a la parada desde la que se abrió.
    const selector = page.waitForEvent('filechooser');
    await parada.locator('[data-fotos-anadir]').click();
    const elegido = await selector;
    await page.locator('.pestana').nth(1).click();
    await expect(page.locator('#contenido')).toContainText('Aeropuerto');
    await elegido.setFiles([{ name: 'misma.png', mimeType: 'image/png', buffer: png }]);
    await expect.poll(async () => (await enBase(page)).length).toBe(1);
    expect((await enBase(page))[0].destino).toEqual({ tipo: 'parada', viajeId: itinerario.id, paradaId: PARADA });

    await page.locator('#btn-ahora').click();
    await abrirFicha(page);
    const otra = await abrirFotos(page, `p:${PARADA}`);
    await expect(otra.locator('[data-foto-id]')).toHaveCount(1);
    await anadir(page, otra, null);
    await page.waitForTimeout(300);
    expect(await enBase(page)).toHaveLength(1);
    await anadir(page, otra, { name: 'misma.png', mimeType: 'image/png', buffer: png });
    await expect(otra.locator('[data-foto-id]')).toHaveCount(2);
    const ids = (await enBase(page)).map((g) => g.id);
    expect(new Set(ids).size).toBe(2);
  });

  test('originales opacos o con tipo mentiroso se guardan intactos sin ejecutarse; PNG roto y >32 MP quedan sin vista previa', async ({ browser }) => {
    const { page, errores } = await movilSinRed(browser);
    await abrirFicha(page);
    const b = await abrirFotos(page, `p:${PARADA}`);
    const html = Buffer.from('<script>window.__ejecutado = true</script><h1>no</h1>');
    const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" onload="window.__svg = true"><script>window.__svg = true</script></svg>');
    const png = await imagen(page, 'image/png');
    const roto = Buffer.from(png); roto[29] ^= 0xff; // CRC del IHDR alterado: cabecera identificada, decode rechazado
    await anadir(page, b, { name: 'pagina.html', mimeType: 'text/html', buffer: html });
    await anadir(page, b, { name: 'foto.png', mimeType: 'image/png', buffer: svg });
    await anadir(page, b, { name: 'roto.png', mimeType: 'image/png', buffer: roto });
    await anadir(page, b, { name: 'enorme.png', mimeType: 'image/png', buffer: cabeceraEnorme() });
    await expect(b.locator('[data-foto-id]')).toHaveCount(4);
    await expect(b.locator('[data-foto-id]', { hasText: 'Sin vista previa' })).toHaveCount(4);
    const guardadas = await enBase(page);
    const porNombre = new Map(guardadas.map((g) => [g.nombre, g]));
    expect(porNombre.get('pagina.html')!.original).toEqual(Array.from(html));
    expect(porNombre.get('foto.png')!).toMatchObject({ mime: 'image/png', original: Array.from(svg), miniatura: 'fallida' });
    expect(porNombre.get('roto.png')!).toMatchObject({ original: Array.from(roto), miniatura: 'fallida' });
    expect(porNombre.get('enorme.png')!).toMatchObject({ miniatura: 'fallida' });
    // Solo el PNG roto llegó al decoder: lo opaco y lo enorme se quedan en la cabecera.
    expect(await page.evaluate(() => (window as unknown as { __decodificaciones: number }).__decodificaciones)).toBe(1);
    expect(await page.evaluate(() => [(window as unknown as Record<string, unknown>).__ejecutado, (window as unknown as Record<string, unknown>).__svg]))
      .toEqual([undefined, undefined]);
    expect(await page.locator('iframe, object, embed').count()).toBe(0);

    // El visor no muestra lo opaco, pero permite descargar los bytes exactos.
    await b.locator('[data-foto-id]', { hasText: 'Sin vista previa' }).first().click();
    const visor = page.locator('#visor-foto');
    await expect(visor).toBeVisible();
    await expect(visor).toHaveAttribute('role', 'dialog');
    const titulo = await visor.locator('#visor-foto-nombre').textContent();
    const esperado = porNombre.get(titulo!.trim())!;
    await visor.locator('[data-visor-original]').click();
    await expect(visor.locator('.visor-aviso')).toContainText('No hay vista previa segura');
    await expect(visor.locator('img')).toHaveCount(0);
    const descarga = page.waitForEvent('download');
    await visor.locator('[data-visor-descargar]').click();
    const archivo = await descarga;
    const { readFile } = await import('node:fs/promises');
    expect(Array.from(await readFile(await archivo.path()))).toEqual(esperado.original);
    expect(errores).toEqual([]);
  });

  test('cuota inyectada al confirmar el original: no se da por guardada, el progreso no cambia y Reintentar la guarda una vez', async ({ browser }) => {
    const { page, contexto } = await movilSinRed(browser);
    await contexto.addInitScript(() => {
      const w = window as unknown as { __abortarOriginal?: boolean };
      const anadirOriginal = IDBObjectStore.prototype.add;
      IDBObjectStore.prototype.add = function (this: IDBObjectStore, ...args: Parameters<IDBObjectStore['add']>) {
        const peticion = anadirOriginal.apply(this, args);
        if (this.name === 'originales' && w.__abortarOriginal) {
          const tx = this.transaction;
          peticion.addEventListener('success', () => tx.abort());
        }
        return peticion;
      };
    });
    await page.reload();
    await expect(page.locator('#contenido')).not.toBeEmpty();
    const raizProgreso = () => page.evaluate(() => new Promise<unknown>((ok) => {
      const r = indexedDB.open('itinerario-progreso');
      r.onsuccess = () => { const g = r.result.transaction('viajes').objectStore('viajes').getAll(); g.onsuccess = () => { ok(g.result); r.result.close(); }; };
    }));
    await expect.poll(async () => JSON.stringify(await raizProgreso())).not.toBe('[]');
    const antes = JSON.stringify(await raizProgreso());
    await abrirFicha(page);
    const b = await abrirFotos(page, `p:${PARADA}`);
    await page.evaluate(() => { (window as unknown as { __abortarOriginal: boolean }).__abortarOriginal = true; });
    await anadir(page, b, { name: 'cuota.png', mimeType: 'image/png', buffer: await imagen(page, 'image/png') });
    const fallida = b.locator('.foto-sesion');
    await expect(fallida).toContainText('No se ha guardado');
    expect(await enBase(page)).toHaveLength(0);
    expect(JSON.stringify(await raizProgreso())).toBe(antes);
    await page.evaluate(() => { (window as unknown as { __abortarOriginal: boolean }).__abortarOriginal = false; });
    await fallida.locator('[data-foto-reintentar]').click();
    await expect(b.locator('[data-foto-id] img')).toHaveCount(1);
    await expect(b.locator('.foto-sesion')).toHaveCount(0);
    expect(await enBase(page)).toHaveLength(1);
    expect(JSON.stringify(await raizProgreso())).toBe(antes);
  });

  test('vista previa fallida sin poder anotarla: original guardado, pendiente durable y aviso solo en esta sesión', async ({ browser }) => {
    const { page, contexto } = await movilSinRed(browser);
    await contexto.addInitScript(() => {
      globalThis.createImageBitmap = (() => Promise.reject(new DOMException('Decoder roto', 'InvalidStateError'))) as typeof createImageBitmap;
      const poner = IDBObjectStore.prototype.put;
      IDBObjectStore.prototype.put = function (this: IDBObjectStore, ...args: Parameters<IDBObjectStore['put']>) {
        const valor = args[0] as { miniatura?: { tipo?: string } } | undefined;
        if (this.name === 'metadatos' && valor?.miniatura?.tipo === 'fallida') throw new DOMException('Cuota', 'QuotaExceededError');
        return poner.apply(this, args);
      };
    });
    await page.reload();
    await expect(page.locator('#contenido')).not.toBeEmpty();
    await abrirFicha(page);
    const b = await abrirFotos(page, `p:${PARADA}`);
    await anadir(page, b, { name: 'sin-vista.png', mimeType: 'image/png', buffer: await imagen(page, 'image/png') });
    await expect(b.locator('[data-foto-id]')).toContainText('Vista previa pendiente');
    await expect(b.locator('.fotos-estado')).toContainText('no se pudo anotar');
    expect((await enBase(page))[0]).toMatchObject({ miniatura: 'pendiente', nombre: 'sin-vista.png' });
    // Cerrar y abrir de nuevo en la misma sesión no reintenta sola.
    await b.locator('[data-fotos-alternar]').click();
    await b.locator('[data-fotos-alternar]').click();
    await expect(b.locator('[data-foto-id]')).toContainText('Vista previa pendiente');
    expect((await enBase(page))[0].miniatura).toBe('pendiente');
  });

  test('borrar mientras se prepara la vista previa: no resucita, libera URLs y devuelve el foco', async ({ browser }) => {
    const { page } = await movilSinRed(browser);
    await abrirFicha(page);
    const b = await abrirFotos(page, `p:${PARADA}`);
    await anadir(page, b, { name: 'queda.png', mimeType: 'image/png', buffer: await imagen(page, 'image/png') });
    await expect(b.locator('[data-foto-id] img')).toHaveCount(1);
    await page.evaluate(() => {
      const w = window as unknown as { __esperaDecode?: Promise<void>; __soltarDecode?: () => void };
      w.__esperaDecode = new Promise<void>((ok) => { w.__soltarDecode = ok; });
    });
    await anadir(page, b, { name: 'borrar.png', mimeType: 'image/png', buffer: await imagen(page, 'image/png', 50, 50) });
    const pendiente = b.locator('[data-foto-id]', { hasText: 'Preparando' });
    await expect(pendiente).toHaveCount(1);
    await pendiente.click();
    const visor = page.locator('#visor-foto');
    await expect(visor).toBeVisible();
    await visor.locator('[data-visor-borrar]').click();
    await visor.locator('[data-visor-confirmar]').click();
    await expect(visor).toBeHidden();
    await expect(b.locator('[data-fotos-anadir]')).toBeFocused();
    await page.evaluate(() => (window as unknown as { __soltarDecode: () => void }).__soltarDecode());
    await page.waitForTimeout(300);
    const guardadas = await enBase(page);
    expect(guardadas.filter((g) => !g.borrada).map((g) => g.nombre)).toEqual(['queda.png']);
    expect(guardadas.find((g) => g.borrada)).toBeTruthy();
    await expect(b.locator('[data-foto-id]')).toHaveCount(1);
    // Al cerrar las fotos no queda ninguna URL blob viva.
    await b.locator('[data-fotos-alternar]').click();
    await expect.poll(() => page.evaluate(() => (window as unknown as { __urlsVivas: () => number }).__urlsVivas())).toBe(0);
  });

  test('si no se pueden abrir las fotos, Reintentar en la misma visita sin recargar', async ({ browser }) => {
    const contexto = await browser.newContext(opcionesMovil);
    await contexto.route(/^https?:\/\/(?!localhost)/, (r) => r.abort());
    await contexto.route((url) => url.pathname === '/api/progreso', (r) => r.abort());
    await contexto.addInitScript(() => {
      const abrir = IDBFactory.prototype.open;
      let fallos = 1;
      IDBFactory.prototype.open = function (this: IDBFactory, ...args: Parameters<IDBFactory['open']>) {
        if (String(args[0]).startsWith('itinerario-fotos') && fallos-- > 0) throw new DOMException('Fallo inyectado', 'UnknownError');
        return abrir.apply(this, args);
      };
    });
    const page = await contexto.newPage();
    await abrirApp(page);
    await abrirFicha(page);
    const b = bloque(page, `p:${PARADA}`);
    await b.locator('[data-fotos-alternar]').click();
    await expect(b.locator('.fotos-error')).toContainText('No se pudieron abrir las fotos');
    await b.locator('[data-fotos-reabrir]').click();
    await expect(b.locator('[data-fotos-anadir]')).toBeVisible();
    await anadir(page, b, { name: 'tras-reintentar.png', mimeType: 'image/png', buffer: await imagen(page, 'image/png') });
    await expect(b.locator('[data-foto-id] img')).toHaveCount(1);
  });

  test('teclado: abrir el visor con Enter, Esc lo cierra y devuelve el foco; sin URLs vivas al cerrar', async ({ browser }) => {
    const { page } = await movilSinRed(browser);
    await abrirFicha(page);
    const b = await abrirFotos(page, `p:${PARADA}`);
    await anadir(page, b, { name: 'teclado.png', mimeType: 'image/png', buffer: await imagen(page, 'image/png') });
    const foto = b.locator('[data-foto-id]');
    await expect(foto.locator('img')).toHaveCount(1);
    await foto.focus();
    await page.keyboard.press('Enter');
    const visor = page.locator('#visor-foto');
    await expect(visor).toBeVisible();
    await expect(visor.locator('[data-visor-cerrar]')).toBeFocused();
    await expect(visor).toContainText('TX Huaihai');
    await expect(visor.locator('.visor-pesos')).toContainText('Original');
    // Las acciones son botones de al menos 44 px.
    for (const accion of await visor.locator('button:visible').all()) {
      const caja = (await accion.boundingBox())!;
      expect(Math.min(caja.width, caja.height)).toBeGreaterThanOrEqual(44);
    }
    await page.keyboard.press('Escape');
    await expect(visor).toBeHidden();
    await expect(foto).toBeFocused();
    await b.locator('[data-fotos-alternar]').click();
    await expect.poll(() => page.evaluate(() => (window as unknown as { __urlsVivas: () => number }).__urlsVivas())).toBe(0);
  });

  test('otra captura con el MISMO ID y misma metadata pero bytes distintos no se da por guardada ni sustituye a la primera', async ({ browser }) => {
    const { page, contexto, errores } = await movilSinRed(browser);
    // UUID fijado SOLO para esta prueba (doble del CSPRNG; no es un fallo del generador): fuerza A y luego B con el mismo ID.
    await contexto.addInitScript(() => {
      const w = window as unknown as { __uuidFijo?: string; __uuidLlamadas: number };
      w.__uuidLlamadas = 0;
      const real = crypto.randomUUID.bind(crypto);
      crypto.randomUUID = () => {
        if (!w.__uuidFijo) return real();
        w.__uuidLlamadas++;
        return w.__uuidFijo as ReturnType<Crypto['randomUUID']>;
      };
    });
    await page.reload();
    await expect(page.locator('#contenido')).not.toBeEmpty();
    await abrirFicha(page);
    const b = await abrirFotos(page, `p:${PARADA}`);
    const ID = '1b4e28ba-2fa1-4d3b-a3f5-ef19b5a7633b';
    await page.evaluate((id) => { (window as unknown as { __uuidFijo: string }).__uuidFijo = id; }, ID);
    const bytesA = await imagen(page, 'image/png');
    const bytesB = Buffer.from(bytesA); bytesB[bytesB.length - 1] ^= 0xff; // mismo tamaño, otro byte
    // Archivos reales (en test-results) con el mismo nombre y la misma fecha: Playwright toma la fecha del disco.
    const { mkdir, writeFile, utimes } = await import('node:fs/promises');
    const fecha = new Date('2026-10-20T08:00:00Z');
    const enDisco = async (carpeta: string, bytes: Buffer) => {
      const ruta = test.info().outputPath(carpeta, 'misma.png');
      await mkdir(test.info().outputPath(carpeta), { recursive: true });
      await writeFile(ruta, bytes); await utimes(ruta, fecha, fecha);
      return ruta;
    };
    const elegir = async (ruta: string) => {
      const selector = page.waitForEvent('filechooser');
      await b.locator('[data-fotos-anadir]').click();
      await (await selector).setFiles(ruta);
    };
    await elegir(await enDisco('a', bytesA));
    await expect(b.locator('[data-foto-id] img')).toHaveCount(1);
    await elegir(await enDisco('b', bytesB));
    const elegidos = await page.evaluate(() => (window as unknown as { __elegidos: { nombre: string; tipo: string; modificado: number; bytes: number }[] }).__elegidos);
    expect(elegidos).toHaveLength(2);
    expect(elegidos[1]).toEqual(elegidos[0]); // misma metadata del archivo: nombre, tipo, fecha y tamaño

    const fallida = b.locator('.foto-sesion');
    await expect(fallida).toContainText('No se ha guardado');
    await expect(b.locator('.fotos-estado')).toContainText('No se ha guardado');
    await expect(b.locator('.fotos-cuenta')).toHaveText(' · 1');
    await expect(b.locator('[data-foto-id]')).toHaveCount(1);
    const comprobarBase = async () => {
      const base = await enBase(page);
      expect(base.map((g) => [g.id, g.nombre, g.borrada])).toEqual([[ID, 'misma.png', false]]);
      expect(base[0].original).toEqual(Array.from(bytesA));
    };
    await comprobarBase();
    const llamadas = () => page.evaluate(() => (window as unknown as { __uuidLlamadas: number }).__uuidLlamadas);
    expect(await llamadas()).toBe(2);

    // Reintentar en la sesión: sigue sin guardarse, sin ID nuevo ni tocar la primera.
    await fallida.locator('[data-foto-reintentar]').click();
    await expect(fallida.locator('[data-foto-reintentar]')).not.toHaveAttribute('aria-disabled', 'true');
    await expect(fallida).toContainText('No se ha guardado');
    await expect(b.locator('.fotos-cuenta')).toHaveText(' · 1');
    await comprobarBase();
    expect(await llamadas()).toBe(2);
    await fallida.locator('[data-foto-descartar]').click();
    await expect(b.locator('.foto-sesion')).toHaveCount(0);
    await expect(b.locator('[data-foto-id] img')).toHaveCount(1);

    // Reabrir la base durable: solo la primera, con sus bytes.
    await page.evaluate(() => { (window as unknown as { __uuidFijo?: string }).__uuidFijo = undefined; });
    await page.reload();
    await abrirFicha(page);
    const otra = await abrirFotos(page, `p:${PARADA}`);
    await expect(otra.locator('[data-foto-id] img')).toHaveCount(1);
    await expect(otra.locator('.fotos-cuenta')).toHaveText(' · 1');
    await comprobarBase();
    expect(errores).toEqual([]);
  });

  /** Retiene el AVISO de la transacción del borrado (su oncomplete u onabort), no el commit: así el resultado
   * llega tarde, con otro visor ya abierto. `fallo` además hace fallar la escritura del tombstone. */
  async function retenerBorrado(contexto: BrowserContext) {
    await contexto.addInitScript(() => {
      const w = window as unknown as { __retener?: 'commit' | 'fallo'; __retenido?: string; __soltar?: () => void };
      const poner = IDBObjectStore.prototype.put;
      IDBObjectStore.prototype.put = function (this: IDBObjectStore, ...args: Parameters<IDBObjectStore['put']>) {
        const modo = w.__retener;
        if (this.name === 'metadatos' && (args[0] as { tipo?: string } | undefined)?.tipo === 'borrada' && modo) {
          w.__retener = undefined;
          const tx = this.transaction;
          const original = modo === 'commit' ? tx.oncomplete : tx.onabort;
          const retener = (ev: Event) => { w.__retenido = modo; w.__soltar = () => original?.call(tx, ev); };
          if (modo === 'commit') tx.oncomplete = retener;
          else { tx.onabort = retener; throw new DOMException('Fallo inyectado', 'QuotaExceededError'); }
        }
        return poner.apply(this, args);
      };
    });
  }
  const armar = (page: Page, modo: 'commit' | 'fallo') => page.evaluate((m) => {
    const w = window as unknown as { __retener?: string; __retenido?: string };
    w.__retener = m; w.__retenido = undefined;
  }, modo);
  const retenido = (page: Page) => page.evaluate(() => (window as unknown as { __retenido?: string }).__retenido ?? null);
  const soltar = (page: Page) => page.evaluate(() => (window as unknown as { __soltar: () => void }).__soltar());
  const enHistoria = (page: Page) => page.evaluate(() => (history.state as { visorFoto?: boolean } | null)?.visorFoto ?? null);
  /** Dos fotos en la parada y su visor; `foto(nombre)` es su miniatura. */
  async function dosFotos(browser: Browser) {
    const { page, contexto, errores } = await movilSinRed(browser);
    await retenerBorrado(contexto);
    await page.reload();
    await expect(page.locator('#contenido')).not.toBeEmpty();
    await abrirFicha(page);
    const b = await abrirFotos(page, `p:${PARADA}`);
    const bytesA = await imagen(page, 'image/png'); const bytesB = await imagen(page, 'image/png', 30, 20);
    await anadir(page, b, { name: 'a.png', mimeType: 'image/png', buffer: bytesA });
    await expect(b.locator('[data-foto-id] img')).toHaveCount(1);
    await anadir(page, b, { name: 'b.png', mimeType: 'image/png', buffer: bytesB });
    await expect(b.locator('[data-foto-id] img')).toHaveCount(2);
    const foto = (nombre: string) => b.getByRole('button', { name: new RegExp(`^Foto «${nombre.replace('.', '\\.')}»`) });
    return { page, errores, b, bytesA, bytesB, foto, visor: page.locator('#visor-foto') };
  }
  /** Borra desde el visor abierto con el aviso retenido, y lo cierra con Escape antes de que llegue. */
  async function borrarYSalir(page: Page, visor: Locator, modo: 'commit' | 'fallo') {
    await armar(page, modo);
    await visor.locator('[data-visor-borrar]').click();
    await visor.locator('[data-visor-confirmar]').click();
    await expect.poll(() => retenido(page)).toBe(modo);
    await page.keyboard.press('Escape');
    await expect(visor).toBeHidden();
    await expect.poll(() => enHistoria(page)).toBeNull();
  }
  async function visorIntacto(visor: Locator, nombre: string) {
    await expect(visor).toBeVisible();
    await expect(visor.locator('#visor-foto-nombre')).toHaveText(nombre);
    await expect(visor.locator('.visor-aviso')).toHaveText('');
    await expect(visor.locator('[data-visor-cerrar]')).toBeFocused();
    expect(await enHistoria(visor.page())).toBe(true);
  }

  test('un borrado que termina con OTRO visor abierto no lo cierra ni le quita el foco; en su mismo visor sí lo cierra', async ({ browser }) => {
    const { page, errores, b, bytesB, foto, visor } = await dosFotos(browser);
    await foto('a.png').click();
    await expect(visor.locator('#visor-foto-nombre')).toHaveText('a.png');
    await borrarYSalir(page, visor, 'commit');
    // El commit nativo ya está hecho (tombstone) antes de soltar su aviso.
    expect((await enBase(page)).filter((g) => g.borrada)).toHaveLength(1);
    await foto('b.png').click();
    await expect(visor.locator('img')).toHaveCount(1);
    await visorIntacto(visor, 'b.png');
    await soltar(page);
    await expect(b.locator('.fotos-estado')).toContainText('Foto borrada de este móvil');
    await expect(b.locator('[data-foto-id]')).toHaveCount(1);
    await visorIntacto(visor, 'b.png');
    await expect(visor.locator('img')).toHaveCount(1);
    const base = await enBase(page);
    expect(base.filter((g) => !g.borrada).map((g) => [g.nombre, g.original])).toEqual([['b.png', Array.from(bytesB)]]);

    // Control: en su mismo visor, el borrado cierra el visor y el foco va a «Añadir foto».
    await armar(page, 'commit');
    await visor.locator('[data-visor-borrar]').click();
    await visor.locator('[data-visor-confirmar]').click();
    await expect.poll(() => retenido(page)).toBe('commit');
    await expect(visor).toBeVisible();
    await soltar(page);
    await expect(visor).toBeHidden();
    await expect(b.locator('[data-fotos-anadir]')).toBeFocused();
    await expect(b.locator('[data-foto-id]')).toHaveCount(0);
    expect((await enBase(page)).every((g) => g.borrada)).toBe(true);
    expect(errores).toEqual([]);
  });

  test('un fallo tardío o un borrado que termina con la misma foto reabierta no tocan el visor nuevo', async ({ browser }) => {
    const { page, errores, b, bytesA, bytesB, foto, visor } = await dosFotos(browser);
    // Falla tarde el borrado de A con B abierta: ni aviso ni cambio en B; A sigue guardada y su panel lo dice.
    await foto('a.png').click();
    await borrarYSalir(page, visor, 'fallo');
    await foto('b.png').click();
    await visorIntacto(visor, 'b.png');
    await soltar(page);
    await expect(foto('a.png')).not.toHaveAttribute('aria-label', /borrando/); // el resultado de A ya llegó
    await visorIntacto(visor, 'b.png');
    await expect(visor.locator('img')).toHaveCount(1);
    await expect(b.locator('.fotos-estado')).toContainText('No se pudo borrar');
    const base = await enBase(page);
    expect(base.map((g) => [g.nombre, g.borrada, g.original])).toEqual(expect.arrayContaining([
      ['a.png', false, Array.from(bytesA)], ['b.png', false, Array.from(bytesB)]]));
    await page.keyboard.press('Escape');
    await expect.poll(() => enHistoria(page)).toBeNull();

    // A se borra y su aviso llega con A REABIERTA: ese visor nuevo sigue abierto y no dice que siga guardada.
    await foto('a.png').click();
    await borrarYSalir(page, visor, 'commit');
    await foto('a.png').click();
    await visorIntacto(visor, 'a.png');
    await soltar(page);
    await expect(b.locator('[data-foto-id]')).toHaveCount(1); // el resultado de A ya llegó
    await visorIntacto(visor, 'a.png');
    await expect(b.locator('.fotos-estado')).toContainText('Foto borrada de este móvil');
    await visor.locator('[data-visor-descargar]').click();
    await expect(visor.locator('.visor-aviso')).toHaveText('Esta foto ya no está en este móvil.');
    await expect(visor.locator('[data-visor-cerrar]')).toBeVisible();
    expect(errores).toEqual([]);
  });

  test('vistas previas guardadas: lo que no es un PNG coherente con su metadata no llega a ningún <img>, ni en la lista ni en el visor', async ({ browser }) => {
    const { page, contexto, errores } = await movilSinRed(browser);
    await contexto.addInitScript(() => {
      const w = window as unknown as { __creadas: number[] };
      w.__creadas = [];
      const crear = URL.createObjectURL.bind(URL);
      URL.createObjectURL = (o: Blob | MediaSource) => { if (o instanceof Blob) w.__creadas.push(o.size); return crear(o); };
    });
    await page.reload();
    await expect(page.locator('#contenido')).not.toBeEmpty();
    await abrirFicha(page);
    let b = await abrirFotos(page, `p:${PARADA}`);
    await anadir(page, b, { name: 'foto.png', mimeType: 'image/png', buffer: await imagen(page, 'image/png') });
    await expect(b.locator('[data-foto-id] img')).toHaveCount(1);
    const [antes] = await enBase(page);
    /** Vista previa y metadata «lista» escritas en crudo en la base del móvil (coherentes para la biblioteca). */
    const poner = (bytes: Buffer, ancho: number, alto: number) => page.evaluate(({ nombre, id, bytes, ancho, alto }) => new Promise<void>((ok, ko) => {
      const r = indexedDB.open(nombre);
      r.onsuccess = () => {
        const tx = r.result.transaction(['metadatos', 'miniaturas'], 'readwrite');
        const g = tx.objectStore('metadatos').get(id);
        g.onsuccess = () => {
          tx.objectStore('metadatos').put({ ...g.result, miniatura: { tipo: 'lista', bytes: bytes.length, ancho, alto, mime: 'image/png' } }, id);
          tx.objectStore('miniaturas').put(new Blob([new Uint8Array(bytes)], { type: 'image/png' }), id);
        };
        tx.oncomplete = () => { r.result.close(); ok(); };
        tx.onabort = () => { r.result.close(); ko(tx.error); };
      };
      r.onerror = () => ko(r.error);
    }), { nombre: BASE_FOTOS, id: antes.id, bytes: Array.from(bytes), ancho, alto });
    const visor = page.locator('#visor-foto');
    const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" onload="window.__svg = true"><script>window.__svg = true</script></svg>');
    const casos: [string, Buffer][] = [['PNG 128×64 con metadata 72×72', await imagen(page, 'image/png', 128, 64)], ['SVG declarado PNG', svg],
      ['cabecera PNG de 6000×6000', cabeceraEnorme()]];
    for (const [caso, bytes] of casos) {
      await poner(bytes, 72, 72);
      await page.reload();
      await abrirFicha(page);
      b = await abrirFotos(page, `p:${PARADA}`);
      const miniatura = b.locator('[data-foto-id]');
      // Lista y visor por separado (soft): cada camino se comprueba aunque falle el otro.
      await expect.soft(miniatura, caso).toContainText('Sin vista previa');
      await expect.soft(miniatura.locator('img'), caso).toHaveCount(0);
      await miniatura.click();
      await expect(visor).toBeVisible();
      await page.waitForTimeout(300); // el visor pide su vista previa al abrirse; sin señal positiva de rechazo
      await expect.soft(visor.locator('img'), caso).toHaveCount(0);
      expect(await page.evaluate(() => (window as unknown as { __creadas: number[] }).__creadas), caso).not.toContain(bytes.length);
      await page.keyboard.press('Escape');
      await expect.poll(() => enHistoria(page)).toBeNull();
    }
    // Control: un PNG de verdad con las dimensiones de su metadata sí se enseña, en la lista y en el visor.
    await poner(await imagen(page, 'image/png', 72, 72), 72, 72);
    await page.reload();
    await abrirFicha(page);
    b = await abrirFotos(page, `p:${PARADA}`);
    await expect(b.locator('[data-foto-id] img')).toHaveCount(1);
    expect(await b.locator('[data-foto-id] img').evaluate((i) => (i as HTMLImageElement).naturalWidth)).toBe(72);
    await b.locator('[data-foto-id]').click();
    await expect(visor.locator('img')).toHaveCount(1);
    await page.keyboard.press('Escape');
    await b.locator('[data-fotos-alternar]').click();
    await expect.poll(() => page.evaluate(() => (window as unknown as { __urlsVivas: () => number }).__urlsVivas())).toBe(0);
    const [despues] = await enBase(page);
    expect([despues.nombre, despues.original]).toEqual([antes.nombre, antes.original]);
    expect(await page.evaluate(() => (window as unknown as { __svg?: boolean }).__svg)).toBeUndefined();
    expect(errores).toEqual([]);
  });

  test('dos móviles: el progreso se comparte, las fotos no; ninguna foto viaja por la red', async ({ browser }) => {
    let actual: InstantaneaProgreso = { revisionServidor: 0, estado: crearProgreso(itinerario) };
    const decisiones = new Map<string, DecisionHistorica>();
    const cuerpos: string[] = [];
    const otras: string[] = [];
    const controlador: ControladorProgreso = crearControladorProgreso({ plan: itinerario,
      autenticar: async () => ({ id: '00000000-0000-4000-8000-000000000001', huella: 'a'.repeat(64), viajeId: itinerario.id,
        dispositivoId: 'sesion', creadaEn: 0, venceEn: 4_000_000_000_000, revocada: false }),
      repositorio: crearAlmacenProgreso({ plan: itinerario, pasarela: {
        async consultar(_h: string, _v: string, id?: string) {
          return { tipo: 'lectura', instantanea: structuredClone(actual),
            decision: id === undefined ? null : structuredClone(decisiones.get(id) ?? null) };
        },
        async confirmar(_h: string, _v: string, base: number, k: DecisionHistorica) {
          if (base !== actual.revisionServidor) return { tipo: 'desfase' };
          actual = structuredClone(k.tipo === 'positiva' ? k.acuse.instantanea
            : { revisionServidor: k.rechazo.instantanea.revisionServidor, estado: actual.estado });
          decisiones.set(k.tipo === 'positiva' ? k.acuse.operacionId : k.rechazo.operacionId, structuredClone(k));
          return { tipo: 'comprometida' };
        },
      } }) });
    async function atender(route: Route) {
      const req = route.request();
      const todas = await req.allHeaders(); const headers: Record<string, string> = {};
      for (const k of ['accept', 'content-type', 'origin', 'if-none-match']) if (todas[k]) headers[k] = todas[k];
      const cuerpo = req.postData() ?? undefined;
      if (cuerpo) cuerpos.push(cuerpo);
      const r = await controlador.atender(new Request(req.url(), { method: req.method(), headers, body: cuerpo }));
      await route.fulfill({ status: r.status, headers: Object.fromEntries(r.headers), body: r.status === 304 ? undefined : Buffer.from(await r.arrayBuffer()) });
    }
    async function movil() {
      const contexto = await browser.newContext(opcionesMovil);
      contexto.on('request', (r) => { const u = new URL(r.url()); if (u.hostname === 'localhost' && !/\.(js|css|woff2|png|svg|webmanifest)$/.test(u.pathname) && u.pathname !== '/' && u.pathname !== '/api/progreso') otras.push(u.pathname); });
      await contexto.route(/^https?:\/\/(?!localhost)/, (r) => r.abort());
      await contexto.route((url) => url.pathname === '/api/progreso', atender);
      await contexto.addInitScript(() => { if (localStorage.getItem('marcador') === null) localStorage.setItem('marcador', 'true'); });
      const page = await contexto.newPage();
      await abrirApp(page);
      return page;
    }
    const a = await movil();
    await abrirFicha(a);
    const fotosA = await abrirFotos(a, `p:${PARADA}`);
    await anadir(a, fotosA, { name: 'solo-aqui.png', mimeType: 'image/png', buffer: await imagen(a, 'image/png') });
    await expect(fotosA.locator('[data-foto-id] img')).toHaveCount(1);
    await expect(fotosA).toContainText('solo en este móvil');
    await a.locator('#contenido li.parada.abierta [data-fijar="hecha"]').scrollIntoViewIfNeeded();
    await a.locator('#contenido li.parada.abierta [data-fijar="hecha"]').click();
    await expect.poll(() => actual.estado.paradas[PARADA]?.marca).toBe('hecha');

    const b = await movil();
    await abrirFicha(b);
    await expect(b.locator('#contenido li.parada.abierta [data-fijar="hecha"]')).toHaveAttribute('aria-pressed', 'true');
    const fotosB = await abrirFotos(b, `p:${PARADA}`);
    await expect(fotosB).toContainText('Aún no hay fotos');
    await expect(fotosB.locator('[data-foto-id]')).toHaveCount(0);
    expect(cuerpos.every((c) => !/fotoId|solo-aqui|data:|blob:|image\/png/.test(c))).toBe(true);
    expect(otras).toEqual([]);
  });
});
