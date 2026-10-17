import { test, expect, type Page, type BrowserContext } from '@playwright/test';
import { createServer, type Server } from 'node:http';
import { readFile } from 'node:fs/promises';
import { build, type Rollup } from 'vite';

// HTTP local real: no page.route para el tráfico que intercepta el worker.
test.use({ serviceWorkers: 'allow', launchOptions: {
  // También bloquea las conexiones nacidas dentro del SW, que page.route no intercepta.
  args: ['--host-resolver-rules=MAP tiles.openfreemap.org ~NOTFOUND'],
} });
let servidor: Server;
let origen: string;
let modulo: string;
let estado = 200;
let demora = 0;
let puertaEnRaiz = false;
let assetMalo = false;
let usarCompilada = false;
let sinRed = false;
let generacion = 'A';
let htmlCompilado: string;
const peticiones: string[] = [];
const html = '<!doctype html><title>Itinerario</title><div id="mapa"></div><section id="panel"></section><script type="module" src="./assets/index-Ab123456.js"></script><link rel="stylesheet" href="./assets/index-Cd123456.css">';

test.beforeAll(async () => {
  const resultado = await build({ configFile: false, logLevel: 'silent', build: {
    write: false, lib: { entry: 'src/offline.ts', formats: ['es'], fileName: 'offline' },
  } });
  const salida = (Array.isArray(resultado) ? resultado[0] : resultado) as Rollup.RollupOutput;
  const entrada = salida.output.find((o) => o.type === 'chunk' && o.isEntry);
  if (!entrada || entrada.type !== 'chunk') throw new Error('Sin módulo offline compilado');
  modulo = entrada.code;
  const sw = await readFile('public/sw.js');
  // El servidor global de Playwright compila dist; puede reutilizar un preview previo.
  htmlCompilado = await readFile('dist/index.html', 'utf8');
  servidor = createServer(async (req, res) => {
    const ruta = new URL(req.url!, 'http://local').pathname;
    peticiones.push(req.url!);
    if (sinRed) { req.socket.destroy(); return; }
    res.setHeader('Cache-Control', 'private, no-store');
    if (ruta.endsWith('/sw.js')) {
      res.setHeader('Content-Type', 'text/javascript');
      res.end(sw);
      return;
    }
    if (ruta === '/herramientas/offline.js') {
      res.setHeader('Content-Type', 'text/javascript');
      res.end(modulo);
      return;
    }
    if (ruta === '/' || ruta === '/itinerario/') {
      const codigo = estado;
      await new Promise((ok) => setTimeout(ok, demora));
      res.statusCode = codigo;
      if (codigo === 303 || codigo === 302) { res.setHeader('Location', '/entrar'); res.end(); return; }
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.end(puertaEnRaiz ? '<title>Entrar</title><form>Contraseña del viaje</form>' : usarCompilada ? htmlCompilado : html.replace('Ab123456', generacion === 'A' ? 'Ab123456' : 'Bb123456'));
      return;
    }
    if (usarCompilada && /\/assets\/[\w.-]+$/.test(ruta)) {
      const nombre = ruta.split('/').at(-1)!;
      const mime = nombre.endsWith('.js') ? 'text/javascript' : nombre.endsWith('.css') ? 'text/css' : nombre.endsWith('.woff2') ? 'font/woff2' : 'image/png';
      try { res.setHeader('Content-Type', mime); res.end(await readFile('dist/assets/' + nombre)); }
      catch { res.statusCode = 404; res.end(); }
      return;
    }
    if (/\/assets\/index-[AB]b123456\.js$/.test(ruta)) {
      res.setHeader('Content-Type', assetMalo ? 'text/html' : 'text/javascript');
      res.setHeader('Vary', 'X-Variante');
      res.end(assetMalo ? '<form>Entrar</form>' : `window.nucleoCargado = true; window.nucleoGeneracion = '${ruta.includes('Bb123456') ? 'B' : 'A'}';`);
      return;
    }
    if (ruta.endsWith('/assets/index-Cd123456.css')) {
      res.setHeader('Content-Type', 'text/css'); res.end('body { color: black; }'); return;
    }
    if (ruta.endsWith('/manifest.webmanifest')) {
      res.setHeader('Content-Type', 'application/manifest+json'); res.end('{"name":"Itinerario"}'); return;
    }
    if (ruta.endsWith('/icono.svg')) { res.setHeader('Content-Type', 'image/svg+xml'); res.end('<svg/>'); return; }
    if (/icono-(180|192|512)\.png$/.test(ruta)) { res.setHeader('Content-Type', 'image/png'); res.end('icono'); return; }
    res.setHeader('Content-Type', ruta.includes('api') ? 'application/json' : 'text/html; charset=utf-8');
    res.end(ruta.includes('api') ? '{"privado":true}' : '<title>Entrar</title><form>Contraseña del viaje</form>');
  });
  await new Promise<void>((ok) => servidor.listen(0, '127.0.0.1', ok));
  const direccion = servidor.address();
  if (!direccion || typeof direccion === 'string') throw new Error('Sin puerto local');
  origen = `http://127.0.0.1:${direccion.port}`;
});
test.afterAll(async () => { if (servidor) await new Promise<void>((ok, fallo) => servidor.close((e) => e ? fallo(e) : ok())); });
test.beforeEach(() => { estado = 200; demora = 0; puertaEnRaiz = false; assetMalo = false; usarCompilada = false; sinRed = false; generacion = 'A'; peticiones.length = 0; });

async function desconectar(context: BrowserContext) {
  // CDP offline no basta en todas las versiones para fetch del SW: el servidor corta
  // además los sockets. Es rechazo HTTP real, no una respuesta fabricada ni una ruta mock.
  sinRed = true;
  await context.setOffline(true);
}
async function conectar(context: BrowserContext) { sinRed = false; await context.setOffline(false); }

async function controlar(page: Page, montaje = '/') {
  await page.goto(origen + montaje);
  await page.evaluate(async () => {
    await navigator.serviceWorker.register('./sw.js');
    await navigator.serviceWorker.ready;
    if (!navigator.serviceWorker.controller) await new Promise<void>((ok) => navigator.serviceWorker.addEventListener('controllerchange', () => ok(), { once: true }));
  });
}
async function preparar(page: Page) {
  return page.evaluate(async () => {
    const rutaModulo = '/herramientas/offline.js';
    const moduloReal = await import(rutaModulo);
    return moduloReal.guardarApp();
  });
}

test('OFF-01: generación A ejecuta offline tras cuota solo en publicación final de B', async ({ page, context }) => {
  await controlar(page); await preparar(page);
  await desconectar(context); await page.reload();
  expect(await page.evaluate('window.nucleoGeneracion')).toBe('A');
  await conectar(context);
  const anterior = await page.evaluate(async () => {
    const nombre = (await caches.keys()).find((n) => n.startsWith('itinerario-lista-v2:'))!;
    return (await (await caches.open(nombre)).match(location.origin + '/'))!.text();
  });
  generacion = 'B';
  await page.evaluate(() => {
    const original = Cache.prototype.put;
    Cache.prototype.put = async function (req, resp) {
      if (resp.headers.get('Content-Type') === 'application/json') throw new DOMException('Cuota final', 'QuotaExceededError');
      return original.call(this, req, resp);
    };
  });
  await expect(preparar(page)).rejects.toThrow('Cuota final');
  expect(await page.evaluate(async () => {
    const nombre = (await caches.keys()).find((n) => n.startsWith('itinerario-lista-v2:'))!;
    return (await (await caches.open(nombre)).match(location.origin + '/'))!.text();
  })).toBe(anterior);
  await desconectar(context); await page.reload();
  expect(await page.evaluate('window.nucleoGeneracion')).toBe('A');
  await conectar(context); await preparar(page);
  await desconectar(context); await page.reload();
  expect(await page.evaluate('window.nucleoGeneracion')).toBe('B');
});

test('OFF-01: generación A sobrevive escritura nativa tardía de B después de guardar su raíz', async ({ page, context }) => {
  await controlar(page); await preparar(page); generacion = 'B';
  const resultado = await page.evaluate(async () => {
    const original = Cache.prototype.put;
    let raizEscrita = false;
    Cache.prototype.put = async function (req, resp) {
      const url = req instanceof Request ? req.url : String(req);
      if (url.endsWith('index-Bb123456.js')) throw new DOMException('Cuota tardía', 'QuotaExceededError');
      await original.call(this, req, resp);
      if (url === location.href) raizEscrita = true;
    };
    try {
      const ruta = '/herramientas/offline.js';
      await (await import(ruta)).guardarApp();
      return { raizEscrita, fallo: false };
    } catch { return { raizEscrita, fallo: true }; }
    finally { Cache.prototype.put = original; }
  });
  expect(resultado).toEqual({ raizEscrita: true, fallo: true });
  await desconectar(context); await page.reload();
  expect(await page.evaluate('window.nucleoGeneracion')).toBe('A');
});

test('OFF-01: publicación con puntero ajeno no permite leer su caché nativa', async ({ page, context }) => {
  await controlar(page); await preparar(page);
  await page.evaluate(async () => {
    const lista = await caches.open('itinerario-lista-v2:' + encodeURIComponent(location.href));
    const descriptor = await (await lista.match(location.href))!.json();
    const raiz = (await (await caches.open(descriptor.generacion)).match(location.href))!;
    await (await caches.open('otra-app')).put(location.href, raiz);
    await lista.put(location.href, new Response(JSON.stringify({ ...descriptor, generacion: 'otra-app' })));
  });
  await desconectar(context);
  expect(await page.evaluate(async () => { try { await fetch('./'); return true; } catch { return false; } })).toBe(false);
});

test('SW real no reemplaza un 503 conocido por una copia anterior', async ({ page }) => {
  await controlar(page);
  await preparar(page);
  await page.evaluate(async () => {
    const cache = await caches.open('app-v1');
    await cache.put(location.origin + '/', new Response('<title>Copia privada</title>', { headers: { 'Content-Type': 'text/html' } }));
  });
  estado = 503;
  demora = 4300;
  const respuesta = await page.reload();
  expect(respuesta!.status()).toBe(503);
});

test('activar SW real conserva cachés ajenas y mapas heredados', async ({ page }) => {
  await page.goto(origen);
  await page.evaluate(async () => {
    await (await caches.open('otra-app-v9')).put(location.origin + '/propio', new Response('Datos ajenos'));
    await caches.open('mapa-v1'); await caches.open('mapa-v77');
  });
  await controlar(page);
  expect(await page.evaluate(() => caches.keys())).toEqual(expect.arrayContaining(['otra-app-v9', 'mapa-v1', 'mapa-v77']));
  expect(await page.evaluate(async () => (await (await caches.open('otra-app-v9')).match(location.origin + '/propio'))!.text())).toBe('Datos ajenos');
});

for (const montaje of ['/', '/itinerario/']) {
  test(`núcleo privado no-store preparado reabre sin red en ${montaje}`, async ({ page, context }) => {
    await controlar(page, montaje);
    await preparar(page);
    expect(await page.evaluate(async () => {
      const nombres = await caches.keys();
      const nombre = nombres.find((n) => n.startsWith('itinerario-app-v2:'))!;
      return (await (await caches.open(nombre)).keys()).map((req) => new URL(req.url).pathname);
    })).toEqual(expect.arrayContaining([montaje, montaje + 'assets/index-Ab123456.js']));
    await desconectar(context);
    const respuesta = await page.reload();
    expect(respuesta!.status()).toBe(200);
    await expect(page.locator('#panel')).toBeAttached();
    expect(await page.evaluate('window.nucleoCargado')).toBe(true);
    // No hay fallback de navegación genérico, ni entre montajes, ni ignorando consultas.
    for (const ruta of ['/api/fotos', '/entrar', montaje + 'fotos/original.png', montaje + 'desconocido', montaje + '?privado=1', montaje === '/' ? '/itinerario/' : '/']) {
      expect(await page.evaluate(async (url) => { try { await fetch(url); return true; } catch { return false; } }, ruta)).toBe(false);
    }
  });
}

for (const codigo of [401, 403, 503, 302, 303]) {
  test(`con núcleo preparado devuelve red ${codigo}, nunca autorización offline`, async ({ page }) => {
    await controlar(page); await preparar(page); estado = codigo;
    const respuesta = await page.reload();
    expect(respuesta!.status()).toBe(codigo >= 300 && codigo < 400 ? 200 : codigo);
    if (codigo === 302 || codigo === 303) {
      expect(page.url()).toBe(origen + '/entrar');
      await expect(page.locator('form')).toHaveText('Contraseña del viaje');
    }
    const almacenadas = await page.evaluate(async () => {
      const nombres = (await caches.keys()).filter((n) => n.startsWith('itinerario-app-v2:'));
      return Promise.all(nombres.map(async (n) => (await (await caches.open(n)).match(location.origin + '/'))!.text()));
    });
    expect(almacenadas).toEqual([html]);
  });
}

for (const codigo of [302, 303]) {
  test(`preparación con redirect ${codigo} hacia entrar no guarda la puerta ni corrompe la copia anterior`, async ({ page }) => {
    await controlar(page); await preparar(page); estado = codigo;
    await expect(preparar(page)).rejects.toThrow('núcleo offline');
    expect(await page.evaluate(async () => {
      const lista = (await caches.keys()).find((n) => n.startsWith('itinerario-app-v2:'))!;
      return (await (await caches.open(lista)).match(location.origin + '/'))!.text();
    })).toBe(html);
  });
}

test('puerta 200 y asset HTML no publican un núcleo parcialmente preparado', async ({ page }) => {
  await controlar(page);
  puertaEnRaiz = true;
  await expect(preparar(page)).rejects.toThrow('núcleo offline');
  puertaEnRaiz = false; assetMalo = true;
  await expect(preparar(page)).rejects.toThrow('núcleo offline');
  expect(await page.evaluate(() => caches.keys())).toEqual([]);
});

test('las visitas API/entrada/fotos no generan caché ni fallback aunque se hayan visto online', async ({ page, context }) => {
  await controlar(page);
  for (const ruta of ['/api/estado', '/entrar', '/auth-error', '/fotos/original.png', '/arbitrario.html']) {
    expect(await page.evaluate(async (url) => (await fetch(url)).status, ruta)).toBe(200);
  }
  expect(await page.evaluate(() => caches.keys())).toEqual([]);
  await desconectar(context);
  for (const ruta of ['/api/estado', '/entrar', '/auth-error', '/fotos/original.png', '/arbitrario.html']) {
    expect(await page.evaluate(async (url) => { try { await fetch(url); return true; } catch { return false; } }, ruta)).toBe(false);
  }
});

test('frío sin preparación no promete un inicio offline ni usa el login heredado', async ({ page, context }) => {
  await controlar(page);
  await page.evaluate(async () => {
    await (await caches.open('app-v1')).put(location.origin + '/', new Response('<title>Entrar</title>'));
  });
  await desconectar(context);
  expect(await page.evaluate(async () => { try { await fetch('./'); return true; } catch { return false; } })).toBe(false);
  expect(await page.evaluate(async () => (await (await caches.open('app-v1')).match(location.origin + '/'))!.text())).toBe('<title>Entrar</title>');
});

test('lectura nativa rechaza URL final/MIME/HTML manipulados y respeta Vary', async ({ page, context }) => {
  await controlar(page); await preparar(page);
  // Response.url nativo de una respuesta de la puerta, no un objeto de política simulado.
  await page.evaluate(async () => {
    const lista = await caches.open('itinerario-lista-v2:' + encodeURIComponent(location.href));
    const { generacion: nombre } = await (await lista.match(location.href))!.json();
    await (await caches.open(nombre)).put(location.origin + '/', await fetch('/entrar'));
  });
  await desconectar(context);
  expect(await page.evaluate(async () => { try { await fetch('./'); return true; } catch { return false; } })).toBe(false);
  await conectar(context); await preparar(page);
  // URL final y MIME válidos: el único motivo de rechazo es la variante incompatible.
  await page.evaluate(async () => {
    const lista = await caches.open('itinerario-lista-v2:' + encodeURIComponent(location.href));
    const { generacion: nombre } = await (await lista.match(location.href))!.json();
    const peticion = new Request(location.origin + '/assets/index-Ab123456.js', { headers: { 'X-Variante': 'otra' } });
    await (await caches.open(nombre)).put(peticion, await fetch(peticion));
  });
  await desconectar(context);
  expect(await page.evaluate(async () => { try { await fetch('./assets/index-Ab123456.js'); return true; } catch { return false; } })).toBe(false);
});

test('una respuesta HTML con URL de asset no se lee offline por tener el MIME equivocado', async ({ page, context }) => {
  await controlar(page); await preparar(page);
  assetMalo = true;
  await page.evaluate(async () => {
    const nombre = (await caches.keys()).find((n) => n.startsWith('itinerario-app-v2:'))!;
    const url = location.origin + '/assets/index-Ab123456.js';
    await (await caches.open(nombre)).put(url, await fetch(url));
  });
  await desconectar(context);
  expect(await page.evaluate(async () => { try { await fetch('./assets/index-Ab123456.js'); return true; } catch { return false; } })).toBe(false);
});

test('preparar Pages no borra ni mezcla la copia preparada del montaje raíz', async ({ page, context }) => {
  await controlar(page); await preparar(page);
  await controlar(page, '/itinerario/'); await preparar(page);
  expect((await page.evaluate(() => caches.keys())).filter((n) => n.startsWith('itinerario-app-v2:'))).toHaveLength(2);
  await desconectar(context);
  expect((await page.reload())!.status()).toBe(200);
  expect((await page.goto(origen + '/'))!.status()).toBe(200);
});

test('preparación real no se autoabastece de la copia offline', async ({ page, context }) => {
  await controlar(page); await preparar(page);
  await desconectar(context);
  await expect(preparar(page)).rejects.toThrow();
});

test('mapas heredados públicos se reutilizan con API y progreso reales, sin descargar duplicados', async ({ page, context }) => {
  // Único mock externo: entrega bytes locales antes de registrar el SW. No prueba TLS/proveedor.
  let consultas = 0;
  await context.route('https://tiles.openfreemap.org/**', async (ruta) => {
    consultas++;
    await ruta.fulfill({ status: 200, contentType: 'application/json', body: '{}' });
  });
  await page.goto(origen);
  await page.evaluate(async () => {
    const cache = await caches.open('mapa-v1');
    localStorage.setItem('mapas-descargados', '2026-10-11T00:00:00.000Z');
    for (const url of ['https://tiles.openfreemap.org/styles/positron', 'https://tiles.openfreemap.org/planet']) await cache.put(url, await fetch(url));
  });
  expect(consultas).toBe(2);
  await controlar(page);
  const resultado = await page.evaluate(async () => {
    const ruta = '/herramientas/offline.js';
    const moduloReal = await import(ruta);
    const progresos: number[][] = [];
    const avisoAntes = moduloReal.descargaAnterior();
    const mapa = { getSource: () => ({ tiles: ['https://tiles.openfreemap.org/planet/semana/{z}/{x}/{y}.pbf'], url: 'https://tiles.openfreemap.org/planet', maxzoom: 0 }), getStyle: () => ({ layers: [] }) };
    const descarga = await moduloReal.descargarMapas(mapa, { paradas: [] }, (hechas: number, total: number) => progresos.push([hechas, total]));
    return { descarga, progresos, avisoAntes, avisoDespues: moduloReal.descargaAnterior(), avisoAntiguo: localStorage.getItem('mapas-descargados') };
  });
  expect(resultado).toEqual({ descarga: { fallos: 0, total: 2 }, progresos: [[1, 2], [2, 2]], avisoAntes: null, avisoDespues: expect.any(String), avisoAntiguo: '2026-10-11T00:00:00.000Z' });
  expect(consultas).toBe(2);
  await desconectar(context);
  expect(await page.evaluate(async () => (await fetch('https://tiles.openfreemap.org/styles/positron')).status)).toBe(200);
});

test('núcleo Vite compilado real prepara fuentes/worker y reabre en montaje Pages', async ({ page, context }) => {
  // Evita cualquier tráfico externo de la app real; no es evidencia de descarga del proveedor.
  await context.route('https://tiles.openfreemap.org/**', (ruta) => ruta.abort());
  usarCompilada = true;
  await controlar(page, '/itinerario/');
  await preparar(page);
  const claves = await page.evaluate(async () => {
    const nombre = (await caches.keys()).find((n) => n.startsWith('itinerario-app-v2:'))!;
    return (await (await caches.open(nombre)).keys()).map((req) => req.url);
  });
  expect(claves.some((u) => u.endsWith('.woff2'))).toBe(true);
  expect(claves.some((u) => u.includes('maplibre-gl-worker') && u.endsWith('.js'))).toBe(true);
  await desconectar(context);
  expect((await page.reload())!.status()).toBe(200);
  await expect(page.locator('#dias')).toContainText('Todo');
});

/** Todas las entradas de CacheStorage («caché URL»), ordenadas: para comparar antes y después. */
const inventarioCaches = (page: Page) => page.evaluate(async () => {
  const salida: string[] = [];
  for (const nombre of await caches.keys()) {
    for (const req of await (await caches.open(nombre)).keys()) salida.push(`${nombre} ${req.url}`);
  }
  return salida.sort();
});
/** Abre la ficha de Lingyin y su bloque «Fotos» (la app compilada, en el día del 22). */
async function fotosDeLingyin(page: Page) {
  await expect(page.locator('#contenido')).not.toBeEmpty();
  await page.locator('#contenido li.parada .fila', { hasText: 'Lingyin' }).click();
  await expect(page.locator('#contenido li.parada.abierta', { hasText: 'Lingyin' })).toBeVisible();
  const bloque = page.locator('[data-fotos-destino="p:a42b37ab706683e8"]');
  await bloque.locator('[data-fotos-alternar]').scrollIntoViewIfNeeded();
  await bloque.locator('[data-fotos-alternar]').click();
  await expect(bloque.locator('[data-fotos-anadir]')).toBeVisible();
  return bloque;
}

test('fotos locales: se guardan desde la ficha, se ven sin conexión y nunca entran en CacheStorage', async ({ page, context }) => {
  await context.route('https://tiles.openfreemap.org/**', (ruta) => ruta.abort());
  usarCompilada = true;
  await page.clock.setFixedTime(new Date('2026-10-22T13:30:00+08:00'));
  await controlar(page, '/itinerario/');
  await preparar(page);
  const preparada = await inventarioCaches(page);
  expect(preparada.length).toBeGreaterThan(0);

  await page.reload();
  const bloque = await fotosDeLingyin(page);
  const png = Buffer.from(await page.evaluate(async () => {
    const c = document.createElement('canvas'); c.width = 24; c.height = 36;
    const g = c.getContext('2d')!; g.fillStyle = '#2453d1'; g.fillRect(0, 0, 24, 36);
    const blob = await new Promise<Blob>((ok) => c.toBlob((b) => ok(b!), 'image/png'));
    return Array.from(new Uint8Array(await blob.arrayBuffer()));
  }));
  const selector = page.waitForEvent('filechooser');
  await bloque.locator('[data-fotos-anadir]').click();
  await (await selector).setFiles([{ name: 'sin-red.png', mimeType: 'image/png', buffer: png }]);
  await expect(bloque.locator('[data-foto-id] img')).toHaveCount(1);
  expect(await inventarioCaches(page)).toEqual(preparada);

  // Sin red: la app sale de la copia preparada y la foto, de IndexedDB.
  await desconectar(context);
  expect((await page.reload())!.status()).toBe(200);
  const sinRed = await fotosDeLingyin(page);
  const img = sinRed.locator('[data-foto-id] img');
  await expect(img).toHaveCount(1);
  await expect(img).toHaveJSProperty('complete', true);
  expect(await img.evaluate((i) => (i as HTMLImageElement).naturalWidth)).toBeGreaterThan(0);
  const final = await inventarioCaches(page);
  expect(final).toEqual(preparada);
  expect(final.filter((e) => /blob:|\/api\/|\/entrar|itinerario-fotos/.test(e))).toEqual([]);
});
