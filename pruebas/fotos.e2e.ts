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
async function movilSinRed(browser: Browser, extra: { viewport?: { width: number; height: number }; colorScheme?: 'light' | 'dark' } = {}) {
  const contexto = await browser.newContext({ ...opcionesMovil, ...extra });
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

    // Control: en su mismo visor, el borrado cierra el visor y el foco va a «Elegir de la galería».
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

// «Tomar foto» y «Elegir de la galería»: el mismo selector de archivos, con la pista de cámara trasera solo en la
// primera. Archivos sintéticos: no prueba una cámara, un carrete ni una galería físicos.
const camara = (b: Locator) => b.locator('[data-fotos-camara]');
const galeria = (b: Locator) => b.locator('[data-fotos-anadir]');
const PIDE_CAMARA = { tipo: 'file', accept: 'image/*', multiple: false, capture: 'environment' as string | null, archivos: 0 };
const PIDE_GALERIA = { ...PIDE_CAMARA, capture: null };
/** Abre el selector desde un botón y anota lo que pedía el input al abrirse. */
async function abrirDesde(page: Page, boton: Locator) {
  const selector = page.waitForEvent('filechooser');
  await boton.click();
  const elegido = await selector;
  const pedido = await elegido.element().evaluate((e) => {
    const i = e as HTMLInputElement;
    return { tipo: i.type, accept: i.accept, multiple: i.multiple, capture: i.getAttribute('capture'), archivos: i.files?.length ?? 0 };
  });
  return { elegido, pedido };
}
const nombreDelDestino = async (b: Locator) =>
  /«(.+)»/.exec((await b.locator('[data-fotos-alternar] .sr').textContent()) ?? '')?.[1] ?? '';
/** Lo que se ve y lo que se toca de las acciones, medido en el navegador (elementFromPoint), no supuesto. */
const medirAcciones = (b: Locator) => b.locator('.fotos-acciones').evaluate((acciones) => {
  acciones.scrollIntoView({ block: 'center' });
  const botones = [...acciones.querySelectorAll('button')];
  const rects = botones.map((e) => e.getBoundingClientRect());
  const toca = (e: Element, x: number, y: number) => document.elementFromPoint(x, y)?.closest('button') === e;
  // Zona al dedo: píxeles que, por el centro del botón, lo devuelven al tocar (con su zona ampliada).
  const zona = (e: Element, r: DOMRect) => {
    let alAlto = 0; let alAncho = 0;
    for (let y = Math.floor(r.top) - 20; y < r.bottom + 20; y++) if (toca(e, r.left + r.width / 2, y + 0.5)) alAlto++;
    for (let x = Math.floor(r.left) - 20; x < r.right + 20; x++) if (toca(e, x + 0.5, r.top + r.height / 2)) alAncho++;
    return { alAlto, alAncho };
  };
  const dentro = (e: Element, r: DOMRect) => {
    const rango = document.createRange(); rango.selectNodeContents(e);
    const t = rango.getBoundingClientRect();
    return t.left >= r.left && t.right <= r.right && t.top >= r.top && t.bottom <= r.bottom;
  };
  const cruzan = (a: DOMRect, c: DOMRect) => a.left < c.right && c.left < a.right && a.top < c.bottom && c.top < a.bottom;
  return {
    pagina: document.documentElement.scrollWidth,
    contenedorDesborda: acciones.scrollWidth > acciones.clientWidth,
    seSolapan: rects.length === 2 && cruzan(rects[0], rects[1]),
    botones: botones.map((e, i) => ({ ...zona(e, rects[i]), textoDentro: dentro(e, rects[i]), izquierda: rects[i].left,
      derecha: rects[i].right, letra: parseFloat(getComputedStyle(e).fontSize) })),
  };
});

test.describe('fotos: tomar foto o elegir de la galería', () => {
  test('cámara y galería: dos acciones con su destino y la pista de cámara solo en «Tomar foto»', async ({ browser }) => {
    const { page, errores } = await movilSinRed(browser);
    await abrirFicha(page);
    const b = await abrirFotos(page, `p:${PARADA}`);
    await expect(b.getByRole('button', { name: /^Tomar foto para «.+»$/ })).toBeVisible();
    const nombre = await nombreDelDestino(b);
    await expect(b.locator('.fotos-acciones button')).toHaveText(['Tomar foto', 'Elegir de la galería']);
    await expect(camara(b)).toHaveAccessibleName(`Tomar foto para «${nombre}»`);
    await expect(galeria(b)).toHaveAccessibleName(`Elegir de la galería una foto para «${nombre}»`);
    // Alternando, la pista no se queda puesta en la galería ni falta al volver a la cámara.
    for (const [boton, pide] of [[camara(b), PIDE_CAMARA], [galeria(b), PIDE_GALERIA], [camara(b), PIDE_CAMARA], [galeria(b), PIDE_GALERIA]] as const) {
      const { elegido, pedido } = await abrirDesde(page, boton);
      expect(pedido).toEqual(pide);
      await elegido.setFiles([]);
    }
    await expect(page.locator('input[type="file"]')).toHaveCount(1);
    await page.waitForTimeout(300);
    expect(await enBase(page)).toEqual([]);
    expect(errores).toEqual([]);
  });

  test('cámara y galería: cancelar la cámara no arrastra destino ni archivo; el mismo archivo otra vez es otra foto', async ({ browser }) => {
    const { page, errores } = await movilSinRed(browser);
    await abrirFicha(page);
    const parada = await abrirFotos(page, `p:${PARADA}`);
    await expect(camara(parada)).toBeVisible();
    await page.locator('#contenido li.parada.abierta .sub-fila', { hasText: 'Pane' }).click();
    const sub = await abrirFotos(page, `s:${PARADA}:${SUB}`);
    const png = await imagen(page, 'image/png');
    const archivo = { name: 'misma.png', mimeType: 'image/png', buffer: png };
    // La cámara se abre desde la parada y se cancela; después, la galería desde Pane.
    const cancelada = await abrirDesde(page, camara(parada));
    expect(cancelada.pedido).toEqual(PIDE_CAMARA);
    await cancelada.elegido.setFiles([]);
    const desdeGaleria = await abrirDesde(page, galeria(sub));
    expect(desdeGaleria.pedido).toEqual(PIDE_GALERIA);
    await desdeGaleria.elegido.setFiles([archivo]);
    await expect(sub.locator('[data-foto-id]')).toHaveCount(1);
    await expect(parada.locator('[data-foto-id]')).toHaveCount(0);
    // El mismo archivo otra vez, por cada camino: otra foto cada vez.
    let n = 1;
    for (const boton of [camara(sub), galeria(sub)]) {
      const { elegido } = await abrirDesde(page, boton);
      await elegido.setFiles([archivo]);
      await expect(sub.locator('[data-foto-id]')).toHaveCount(++n);
    }
    await expect(parada.locator('[data-foto-id]')).toHaveCount(0);
    const guardadas = await enBase(page);
    expect(new Set(guardadas.map((g) => g.id)).size).toBe(3);
    for (const g of guardadas) {
      expect(g.destino).toEqual({ tipo: 'subparada', viajeId: itinerario.id, paradaId: PARADA, subparadaId: SUB });
      expect(g.original).toEqual(Array.from(png));
    }
    expect(errores).toEqual([]);
  });

  test('cámara y galería: la foto de la cámara se guarda entera en su destino aunque cambie el día, sin respaldo solo', async ({ browser }) => {
    const { page, errores } = await movilSinRed(browser);
    const respaldos: string[] = [];
    page.on('request', (r) => { if (new URL(r.url()).pathname.startsWith('/api/fotos')) respaldos.push(r.url()); });
    await abrirFicha(page);
    const b = await abrirFotos(page, `p:${PARADA}`);
    await expect(camara(b)).toBeVisible();
    const jpeg = await imagen(page, 'image/jpeg', 40, 30);
    // Con la cámara abierta se cambia de día: la foto va a la parada desde la que se abrió.
    const { elegido } = await abrirDesde(page, camara(b));
    await page.locator('.pestana').nth(1).click();
    await expect(page.locator('#contenido')).toContainText('Aeropuerto');
    await elegido.setFiles([{ name: 'camara.jpg', mimeType: 'image/jpeg', buffer: jpeg }]);
    await expect.poll(async () => (await enBase(page)).length).toBe(1);
    const [guardada] = await enBase(page);
    expect(guardada.destino).toEqual({ tipo: 'parada', viajeId: itinerario.id, paradaId: PARADA });
    expect(guardada).toMatchObject({ nombre: 'camara.jpg', mime: 'image/jpeg', bytes: jpeg.length, original: Array.from(jpeg) });

    // Se guardó sin estar a la vista: su vista previa se prepara al volver a abrir sus fotos.
    await page.locator('#btn-ahora').click();
    await abrirFicha(page);
    const otra = await abrirFotos(page, `p:${PARADA}`);
    await expect(otra.locator('[data-foto-id] img')).toHaveCount(1);
    await expect.poll(async () => (await enBase(page)).map((g) => g.miniatura)).toEqual(['lista']);
    // Al borrarla, el foco vuelve a una acción que sigue ahí.
    await otra.locator('[data-foto-id]').click();
    const visor = page.locator('#visor-foto');
    await expect(visor).toBeVisible();
    await visor.locator('[data-visor-borrar]').click();
    await visor.locator('[data-visor-confirmar]').click();
    await expect(visor).toBeHidden();
    await expect(galeria(otra)).toBeFocused();
    await expect(camara(otra)).toBeVisible();
    expect(respaldos).toEqual([]);
    expect(errores).toEqual([]);
  });

  for (const [ancho, alto] of [[390, 844], [360, 640]] as const) {
    for (const tema of ['claro', 'oscuro'] as const) {
      test(`cámara y galería: ${ancho}×${alto} ${tema === 'claro' ? 'de día' : 'de noche'}, legibles, sin solaparse, 44 px al dedo y foco visible`, async ({ browser }) => {
        const { page, errores } = await movilSinRed(browser, { viewport: { width: ancho, height: alto }, colorScheme: tema === 'oscuro' ? 'dark' : 'light' });
        await expect(page.locator('html')).toHaveAttribute('data-tema', tema);
        await abrirFicha(page);
        const parada = await abrirFotos(page, `p:${PARADA}`);
        await expect(camara(parada)).toBeVisible();
        await page.locator('#contenido li.parada.abierta .sub-fila', { hasText: 'Pane' }).click();
        const sub = await abrirFotos(page, `s:${PARADA}:${SUB}`);
        for (const b of [sub, parada]) {
          const nombre = await nombreDelDestino(b);
          await expect(camara(b)).toHaveAccessibleName(`Tomar foto para «${nombre}»`);
          await expect(galeria(b)).toHaveAccessibleName(`Elegir de la galería una foto para «${nombre}»`);
          const m = await medirAcciones(b);
          expect(m.botones).toHaveLength(2);
          expect(m.pagina, 'sin desplazamiento horizontal').toBeLessThanOrEqual(ancho);
          expect(m.contenedorDesborda).toBe(false);
          expect(m.seSolapan).toBe(false);
          for (const boton of m.botones) {
            expect(boton.textoDentro).toBe(true);
            expect(boton.letra).toBeGreaterThanOrEqual(14);
            expect(boton.izquierda).toBeGreaterThanOrEqual(0);
            expect(boton.derecha).toBeLessThanOrEqual(ancho);
            expect(boton.alAlto, 'zona al dedo, en alto').toBeGreaterThanOrEqual(44);
            expect(boton.alAncho, 'zona al dedo, en ancho').toBeGreaterThanOrEqual(44);
          }
        }
        // Con teclado, desde «Fotos» de la parada: Tab llega a «Tomar foto» y después a «Elegir de la galería».
        await parada.locator('[data-fotos-alternar]').focus();
        for (const [i, boton] of [camara(parada), galeria(parada)].entries()) {
          await page.keyboard.press('Tab');
          await expect(boton).toBeFocused();
          // Chromium calcula 2 px para los 2,5 px declarados: se exige un contorno sólido de 2 px o más y con color.
          expect(await boton.evaluate((e) => {
            const s = getComputedStyle(e);
            return { visible: e.matches(':focus-visible'), estilo: s.outlineStyle, grueso: parseFloat(s.outlineWidth) >= 2,
              transparente: s.outlineColor === 'rgba(0, 0, 0, 0)' };
          })).toEqual({ visible: true, estilo: 'solid', grueso: true, transparente: false });
          if (i === 0) {
            await boton.evaluate((e) => e.scrollIntoView({ block: 'center' }));
            await page.screenshot({ path: test.info().outputPath(`camara-${ancho}x${alto}-${tema}.png`) });
          }
        }
        expect(errores).toEqual([]);
      });
    }
  }
});

// Con la hoja alta, las píldoras del pie («Mapa», «Hotel») flotan sobre la lista. Se mide la pose a la que se llega
// con los pasos normales (abrir, Tab y Shift+Tab, desplazar solo si no se ve), sin recentrar nada para medir.
/** Fuentes cargadas, hoja alta asentada en el propio body y tres fotogramas seguidos con la misma geometría. */
async function hojaAsentada(page: Page) {
  await page.evaluate(() => document.fonts.ready.then(() => undefined));
  await expect(page.locator('body')).toHaveAttribute('data-hoja', 'alta');
  // waitForFunction no espera promesas: el predicado es síncrono y se evalúa en cada fotograma.
  await page.evaluate(() => { Object.assign(window, { __geometria: '', __iguales: 0 }); });
  await page.waitForFunction(() => {
    const w = window as unknown as { __geometria: string; __iguales: number };
    const p = document.getElementById('panel')!.getBoundingClientRect();
    const c = document.getElementById('contenido')!;
    const q = document.getElementById('pildoras')!.getBoundingClientRect();
    const foto = [p.top, p.height, c.scrollTop, c.clientHeight, q.top, q.height].join('|');
    w.__iguales = foto === w.__geometria ? w.__iguales + 1 : 0;
    w.__geometria = foto;
    return w.__iguales >= 2;
  });
}
/** Hit-testing nativo: quién recibe el toque en los 44×44 centrales de cada acción y sobre su texto. */
const medirOclusion = (b: Locator) => b.evaluate((bloque) => {
  const quien = (h: Element | null) => (h ? h.closest('[id]')?.id || h.tagName.toLowerCase() : 'fuera de la pantalla');
  const medir = (e: Element) => {
    const r = e.getBoundingClientRect();
    const x = r.x + r.width / 2; const y = r.y + r.height / 2;
    const tapan = new Set<string>();
    let grilla = 0;
    for (let i = 0; i < 44; i++) for (let j = 0; j < 44; j++) {
      const h = document.elementFromPoint(x - 21.5 + i, y - 21.5 + j);
      if (h && (h === e || e.contains(h))) grilla++; else tapan.add(quien(h));
    }
    let puntos = 0; let aciertos = 0;
    const textos = document.createTreeWalker(e, NodeFilter.SHOW_TEXT);
    for (let t = textos.nextNode(); t; t = textos.nextNode()) {
      if (!t.textContent?.trim()) continue;
      const rango = document.createRange(); rango.selectNodeContents(t);
      for (const c of rango.getClientRects()) for (let px = c.left + 2; px <= c.right - 2; px += 4) {
        puntos++;
        const h = document.elementFromPoint(px, c.top + c.height / 2);
        if (h && (h === e || e.contains(h))) aciertos++; else tapan.add(quien(h));
      }
    }
    return { y: r.y, alto: r.height, grilla, texto: { puntos, aciertos }, tapan: [...tapan].sort(),
      dentro: r.left >= 0 && r.top >= 0 && r.right <= innerWidth && r.bottom <= innerHeight };
  };
  return { desplazamiento: document.getElementById('contenido')!.scrollTop,
    camara: medir(bloque.querySelector('[data-fotos-camara]')!), galeria: medir(bloque.querySelector('[data-fotos-anadir]')!) };
});
/**
 * El contorno de foco se pinta a 2 px del botón, pero no es zona de toque: a 3 px puede quedar fuera de la zona
 * ampliada del botón. Ahí vale el propio botón, algo suyo o un antepasado de verdad (en cuyo papel se pinta el
 * contorno); un hermano, una píldora o lo que esté encima lo tapa.
 */
const medirFoco = (boton: Locator) => boton.evaluate((e) => {
  const quien = (h: Element | null) => (h ? h.closest('[id]')?.id || h.tagName.toLowerCase() : 'fuera de la pantalla');
  const r = e.getBoundingClientRect(); const s = getComputedStyle(e);
  const puntos: [number, number][] = [];
  for (let x = r.left + 4; x <= r.right - 4; x += 6) puntos.push([x, r.top - 3], [x, r.bottom + 3]);
  for (let y = r.top + 4; y <= r.bottom - 4; y += 6) puntos.push([r.left - 3, y], [r.right + 3, y]);
  const tapan = new Set<string>();
  let tapados = 0;
  for (const [x, y] of puntos) {
    const h = document.elementFromPoint(x, y);
    if (!(h && (h === e || e.contains(h) || h.contains(e)))) { tapados++; tapan.add(quien(h)); }
  }
  return { enfocado: document.activeElement === e, visible: e.matches(':focus-visible'), estilo: s.outlineStyle,
    grueso: parseFloat(s.outlineWidth) >= 2, transparente: s.outlineColor === 'transparent' || /^rgba\(.*,\s*0\)$/.test(s.outlineColor),
    anillo: puntos.length, tapados, tapan: [...tapan].sort() };
});

test.describe('fotos: acciones con la hoja alta y las píldoras del pie', () => {
  for (const [ancho, alto] of [[360, 640], [390, 844]] as const) {
    for (const tema of ['claro', 'oscuro'] as const) {
      test(`oclusión de acciones bajo píldoras: Pane a ${ancho}×${alto} ${tema === 'claro' ? 'de día' : 'de noche'}, cámara y galería a la vista, 44 px al dedo y foco sin tapar`, async ({ browser }) => {
        const { page, errores } = await movilSinRed(browser, { viewport: { width: ancho, height: alto }, colorScheme: tema === 'oscuro' ? 'dark' : 'light' });
        await abrirFicha(page);
        await hojaAsentada(page);
        await page.locator('#contenido li.parada.abierta .sub-fila', { hasText: 'Pane' }).click();
        const sub = bloque(page, `s:${PARADA}:${SUB}`);
        const alternar = sub.locator('[data-fotos-alternar]');
        await alternar.scrollIntoViewIfNeeded();
        await alternar.click();
        await expect(alternar).toHaveAttribute('aria-expanded', 'true');
        await expect(camara(sub)).toBeVisible();
        await expect(galeria(sub)).toBeVisible();
        await camara(sub).focus();
        await page.keyboard.press('Tab');
        await page.keyboard.press('Shift+Tab');
        await galeria(sub).scrollIntoViewIfNeeded();
        await hojaAsentada(page);
        // La captura va antes de cualquier comprobación: es la evidencia de la pose medida.
        await page.screenshot({ path: test.info().outputPath(`pildoras-subparada-${ancho}x${alto}-${tema}.png`) });

        const pose = await medirOclusion(sub);
        const focoCamara = await medirFoco(camara(sub));
        await page.keyboard.press('Tab');
        await hojaAsentada(page);
        const focoGaleria = await medirFoco(galeria(sub));
        const alEnfocarGaleria = (await medirOclusion(sub)).desplazamiento - pose.desplazamiento;
        // Aparte, y sin contarlo como acierto: si desplazar más a mano dejaría la galería libre.
        const recuperacion: Record<string, { grilla: number; tapan: string[] }> = {};
        for (const [paso, cuanto] of [['120 px más', 120], ['hasta el final', -1]] as const) {
          await page.locator('#contenido').evaluate((c, d) => { if (d < 0) c.scrollTop = c.scrollHeight; else c.scrollBy(0, d); }, cuanto);
          const { galeria: g } = await medirOclusion(sub);
          recuperacion[paso] = { grilla: g.grilla, tapan: g.tapan };
        }
        const medidas = { caso: `${ancho}x${alto}-${tema}`, pose, focoCamara, focoGaleria, alEnfocarGaleria, recuperacion };
        const { mkdir, writeFile } = await import('node:fs/promises');
        await mkdir(test.info().outputDir, { recursive: true });
        await writeFile(test.info().outputPath(`medidas-${ancho}x${alto}-${tema}.json`), JSON.stringify(medidas, null, 2));
        test.info().annotations.push({ type: 'recuperación con más desplazamiento (no cuenta como acierto)', description: JSON.stringify(recuperacion) });

        for (const nombre of ['camara', 'galeria'] as const) {
          const m = pose[nombre];
          expect(m.grilla, `${nombre}: los 44×44 centrales al dedo (lo tapan: ${m.tapan.join(', ') || 'nada'})`).toBe(1936);
          expect(m.texto.puntos).toBeGreaterThan(0);
          expect(m.texto.aciertos, `${nombre}: su texto se ve entero`).toBe(m.texto.puntos);
          expect(m.dentro, `${nombre}: dentro de la pantalla`).toBe(true);
        }
        for (const [nombre, foco] of [['camara', focoCamara], ['galeria', focoGaleria]] as const) {
          expect(foco.transparente, `${nombre}: el contorno de foco tiene color`).toBe(false);
          expect(foco, `${nombre}: foco visible y sin tapar (lo tapan: ${foco.tapan.join(', ') || 'nada'})`)
            .toMatchObject({ enfocado: true, visible: true, estilo: 'solid', grueso: true, tapados: 0 });
        }
        expect(errores).toEqual([]);
      });
    }
  }
});

/** Las píldoras del pie que se ven, en cuántas filas, si --alto-pildoras es su alto real y si la lista acaba encima. */
const pildorasDelPie = (page: Page) => page.evaluate(() => {
  const q = document.getElementById('pildoras')!;
  const botones = [...q.querySelectorAll<HTMLElement>(':scope > button')].filter((b) => b.getClientRects().length > 0);
  const caja = q.getBoundingClientRect();
  const lista = document.getElementById('contenido')!.getBoundingClientRect();
  return { visibles: botones.map((b) => b.id), filas: new Set(botones.map((b) => Math.round(b.getBoundingClientRect().top))).size,
    cuadra: getComputedStyle(document.documentElement).getPropertyValue('--alto-pildoras').trim() === `${Math.ceil(caja.height)}px`,
    aire: caja.top - lista.bottom >= 7.5 };
});

test.describe('fotos: la lista y las píldoras del pie con la hoja alta', () => {
  test('píldoras y foco: con teclado, lo enfocado en la lista queda entero por encima de las píldoras (360×640 de noche)', async ({ browser }) => {
    const { page, errores } = await movilSinRed(browser, { viewport: { width: 360, height: 640 }, colorScheme: 'dark' });
    await abrirFicha(page);
    await hojaAsentada(page);
    await page.locator('#contenido li.parada.abierta .fila').focus();
    const pasos: { quien: string; dentro: boolean; cruza: boolean; tapado: boolean }[] = [];
    for (let i = 0; i < 16; i++) {
      await page.keyboard.press('Tab');
      await hojaAsentada(page);
      const paso = await page.evaluate(() => {
        const e = document.activeElement as HTMLElement | null;
        const c = document.getElementById('contenido')!;
        if (!e || !c.contains(e)) return null;
        const r = e.getBoundingClientRect(); const cr = c.getBoundingClientRect();
        const pildoras = [...document.querySelectorAll<HTMLElement>('#pildoras > button')].filter((b) => b.getClientRects().length > 0)
          .map((b) => b.getBoundingClientRect());
        const h = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
        return { quien: (e.getAttribute('aria-label') ?? e.textContent ?? e.tagName).trim().slice(0, 40),
          dentro: r.top >= cr.top - 0.5 && r.bottom <= cr.bottom + 0.5,
          cruza: pildoras.some((p) => r.left < p.right && p.left < r.right && r.top < p.bottom && p.top < r.bottom),
          tapado: !!h?.closest('#pildoras') };
      });
      if (paso) pasos.push(paso);
    }
    expect(pasos.length).toBeGreaterThanOrEqual(10);
    for (const p of pasos) expect(p, p.quien).toMatchObject({ dentro: true, cruza: false, tapado: false });
    expect(errores).toEqual([]);
  });

  test('píldoras y foco: sin conexión pasan a dos filas, la lista sigue acabando encima y con conexión vuelven a una (360×640)', async ({ browser }) => {
    const { contexto, page, errores } = await movilSinRed(browser, { viewport: { width: 360, height: 640 } });
    await abrirFicha(page);
    await hojaAsentada(page);
    await expect.poll(() => pildorasDelPie(page)).toMatchObject({ filas: 1, cuadra: true, aire: true });

    // Sin conexión de verdad (no un estado fabricado): aparece la píldora de la conexión y no cabe en la fila.
    await contexto.setOffline(true);
    await expect(page.locator('#red')).toContainText('Sin conexión');
    await expect.poll(() => pildorasDelPie(page)).toMatchObject({ visibles: ['btn-mapa', 'btn-hotel', 'red'], filas: 2, cuadra: true, aire: true });
    await hojaAsentada(page);
    await page.locator('#contenido li.parada.abierta .sub-fila', { hasText: 'Pane' }).click();
    const sub = bloque(page, `s:${PARADA}:${SUB}`);
    const alternar = sub.locator('[data-fotos-alternar]');
    await alternar.scrollIntoViewIfNeeded();
    await alternar.click();
    await expect(alternar).toHaveAttribute('aria-expanded', 'true');
    await camara(sub).focus();
    await page.keyboard.press('Tab');
    await page.keyboard.press('Shift+Tab');
    await galeria(sub).scrollIntoViewIfNeeded();
    await hojaAsentada(page);
    await page.screenshot({ path: test.info().outputPath('pildoras-dos-filas-360x640-claro.png') });
    const pose = await medirOclusion(sub);
    const foco = await medirFoco(camara(sub));
    for (const nombre of ['camara', 'galeria'] as const) {
      expect(pose[nombre].grilla, `${nombre}: los 44×44 centrales al dedo (lo tapan: ${pose[nombre].tapan.join(', ') || 'nada'})`).toBe(1936);
      expect(pose[nombre].texto.aciertos, `${nombre}: su texto se ve entero`).toBe(pose[nombre].texto.puntos);
    }
    expect(foco, `cámara: foco visible y sin tapar (lo tapan: ${foco.tapan.join(', ') || 'nada'})`)
      .toMatchObject({ enfocado: true, visible: true, estilo: 'solid', grueso: true, transparente: false, tapados: 0 });

    await contexto.setOffline(false);
    await expect(page.locator('#red')).toBeHidden();
    await expect.poll(() => pildorasDelPie(page)).toMatchObject({ visibles: ['btn-mapa', 'btn-hotel'], filas: 1, cuadra: true, aire: true });
    expect(errores).toEqual([]);
  });
});

// Ciclo de vida en la app de verdad (main.ts): plegar la ficha, plegar un sitio de dentro o abrir otra ficha del mismo
// día cierra su «Fotos» de verdad (y, con la composición del respaldo, sus compartidas). Aquí, la web publicada: lo
// observable son el bloque plegado y las URLs de sus vistas previas soltadas; las fotos siguen en este móvil.
test.describe('fotos: plegar la ficha cierra su «Fotos»', () => {
  const urlsVivas = (page: Page) => page.evaluate(() => (window as unknown as { __urlsVivas: () => number }).__urlsVivas());
  for (const caso of ['parada', 'sitio', 'otra ficha'] as const) {
    test(`plegar · ${caso}: el bloque se pliega, suelta sus vistas previas y la foto sigue en este móvil`, async ({ browser }) => {
      const { contexto, page, errores } = await movilSinRed(browser);
      try {
        const ficha = await abrirFicha(page);
        if (caso === 'sitio') await ficha.locator('.sub-fila', { hasText: 'Pane' }).click();
        const clave = caso === 'sitio' ? `s:${PARADA}:${SUB}` : `p:${PARADA}`;
        const b = await abrirFotos(page, clave);
        await anadir(page, b, { name: 'plegar.png', mimeType: 'image/png', buffer: await imagen(page, 'image/png') });
        await expect(b.locator('[data-foto-id] img')).toHaveCount(1);
        expect(await urlsVivas(page)).toBe(1);
        if (caso === 'parada') await ficha.locator('.fila').click();
        else if (caso === 'sitio') await ficha.locator('.sub-fila', { hasText: 'Pane' }).click();
        else await page.locator('#contenido li.parada:not(.origen) .fila').filter({ hasNotText: 'TX Huaihai' }).first().click();
        await expect(b.locator('[data-fotos-alternar]')).toHaveAttribute('aria-expanded', 'false');
        await expect(b.locator('.fotos-panel')).toBeHidden();
        await expect.poll(() => urlsVivas(page)).toBe(0);
        // Nada se borró: sigue en este móvil y se ve al volver a abrir.
        expect(await enBase(page)).toHaveLength(1);
        await expect(b.locator('.fotos-cuenta')).toHaveText(/·\s*1/);
        expect(errores).toEqual([]);
      } finally {
        await contexto.close();
      }
    });
  }
});
