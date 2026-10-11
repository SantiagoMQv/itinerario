import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import * as politica from '../src/politica-offline';

vi.mock('../src/mapa', () => ({ ESTILO: 'https://tiles.openfreemap.org/styles/positron' }));
import { guardarApp, descargarMapas, descargaAnterior, registrarServiceWorker } from '../src/offline';

const ambito = 'https://viaje.test/';
const html = '<title>Itinerario</title><div id="mapa"></div><div id="panel"></div><script type="module" src="./assets/index-Ab123456.js"></script><link rel="stylesheet" href="./assets/index-Cd123456.css">';
const js = ambito + 'assets/index-Ab123456.js';
const css = ambito + 'assets/index-Cd123456.css';
const fuente = ambito + 'assets/archivo-latin-wght-normal-Ef123456.woff2';

/** Dobles WebAPI de almacenamiento; Chromium cubre Response.url y CacheStorage nativos. */
function respuesta(url: string, texto: string, mime = 'text/html', estado = 200, redirigida = false): Response {
  const crear = (): Response => {
    const resp = new Response(texto, { status: estado, headers: { 'Content-Type': mime, 'Cache-Control': 'private, no-store' } });
    Object.defineProperties(resp, { url: { value: url }, redirected: { value: redirigida }, clone: { value: crear } });
    return resp;
  };
  return crear();
}
class Almacen {
  entradas = new Map<string, Response>();
  async match(clave: RequestInfo | URL) { return this.entradas.get(clave instanceof Request ? clave.url : String(clave))?.clone(); }
  async put(clave: RequestInfo | URL, resp: Response) { this.entradas.set(clave instanceof Request ? clave.url : String(clave), resp.clone()); }
}
function entorno(base = ambito) {
  const almacenes = new Map<string, Almacen>();
  const caches = { open: vi.fn(async (nombre: string) => {
    if (!almacenes.has(nombre)) almacenes.set(nombre, new Almacen());
    return almacenes.get(nombre)!;
  }) };
  const red = vi.fn(async (entrada: RequestInfo | URL) => {
    const url = entrada instanceof Request ? entrada.url : String(entrada);
    const tipo = politica.tipoNucleo(url, base);
    if (tipo === 'html') return respuesta(url, html);
    if (tipo === 'js') return respuesta(url, '', 'text/javascript');
    if (tipo === 'css') return respuesta(url, `@font-face{src:url(./${fuente.split('/').at(-1)})}`, 'text/css');
    if (tipo === 'woff2') return respuesta(url, 'fuente', 'font/woff2');
    if (tipo === 'manifest') return respuesta(url, '{}', 'application/manifest+json');
    if (tipo === 'svg') return respuesta(url, '<svg/>', 'image/svg+xml');
    if (tipo === 'png') return respuesta(url, 'icono', 'image/png');
    throw new Error('Sin recurso');
  });
  vi.stubGlobal('navigator', { serviceWorker: { register: vi.fn(async () => ({})), getRegistration: vi.fn(async () => ({ scope: base })) }, storage: {} });
  vi.stubGlobal('location', new URL(base));
  vi.stubGlobal('caches', caches);
  vi.stubGlobal('fetch', red);
  vi.stubGlobal('performance', { getEntriesByType: () => [{ name: base + 'api/fotos/original.jpg' }] });
  vi.stubGlobal('localStorage', { setItem: vi.fn() });
  return { almacenes, caches, red };
}

async function publicada(almacenes: Map<string, Almacen>, base = ambito) {
  const lista = await (await almacenes.get(politica.nombresCache(base).lista)!.match(base))!.json();
  return almacenes.get(lista.generacion)!;
}

function worker(puertos: Record<string, unknown> = {}) {
  const fuenteSW = readFileSync('public/sw.js', 'utf8');
  return runInNewContext(fuenteSW + '\n({ nombresCache, tipoNucleo, mimeNucleo, esHtmlApp, respuestaNucleo, listaPreparada, esMapa, claveTesela, respuestaMapa, nucleoRedPrimero, mapaRedPrimero })', {
    self: { registration: { scope: ambito }, addEventListener() {} }, URL, Response, ...puertos,
  }) as typeof politica & { nucleoRedPrimero(req: Request): Promise<Response>; mapaRedPrimero(req: Request): Promise<Response> };
}

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

describe.each([['app', politica], ['SW clásico real', worker()]])('Validadores del %s', (_, reglas) => {
  it.each(['/', '/itinerario/'])('acepta raíz y recursos propios del montaje %s', (ruta) => {
    const base = 'https://viaje.test' + ruta;
    expect(reglas.tipoNucleo(base, base)).toBe('html');
    expect(reglas.tipoNucleo(new URL('assets/index-Ab123456.js', base).href, base)).toBe('js');
    expect(reglas.nombresCache(base)).toEqual(politica.nombresCache(base));
    expect(reglas.nombresCache(base).app).not.toBe('app-v1');
  });
  it.each(['/api/', '/api/fotos/original.jpg?mime=text/html', '/entrar', '/auth-error', '/fotos/original.png', '/assets/foto-Ab123456.jpg', '/desconocido', '/?entrada=1', '/icono.svg?token=x', '/itinerario', '/itinerario/api/assets/index-Ab123456.js'])('excluye %s independientemente de su contenido', (ruta) => {
    expect(reglas.tipoNucleo('https://viaje.test' + ruta, ambito)).toBeNull();
  });
  it('no mezcla orígenes ni ámbitos', () => {
    expect(reglas.tipoNucleo('https://otro.test/assets/index-Ab123456.js', ambito)).toBeNull();
    expect(reglas.tipoNucleo(js, ambito + 'itinerario/')).toBeNull();
    expect(reglas.nombresCache(ambito).app).not.toBe(reglas.nombresCache(ambito + 'itinerario/').app);
  });
  it('admite núcleo privado preparado aunque use no-store', async () => {
    expect(await reglas.respuestaNucleo(respuesta(ambito, html), ambito, ambito)).toBe(true);
    expect(await reglas.respuestaNucleo(respuesta(js, 'script', 'application/javascript'), js, ambito)).toBe(true);
  });
  it.each([401, 403, 503, 206])('rechaza estado %s', async (estado) => {
    expect(await reglas.respuestaNucleo(respuesta(ambito, html, 'text/html', estado), ambito, ambito)).toBe(false);
  });
  it.each([
    ['redirección', ambito, html, 'text/html', true],
    ['URL final distinta', ambito + 'entrar', html, 'text/html', false],
    ['puerta 200', ambito, '<title>Entrar</title><form>Contraseña</form>', 'text/html', false],
    ['puerta vacía', ambito, '', 'text/html', false],
    ['MIME incorrecto', ambito, html, 'application/json', false],
    ['contraseña en shell', ambito, html + '<input type="password">', 'text/html', false],
  ])('rechaza %s', async (_, final, texto, mime, redirigida) => {
    expect(await reglas.respuestaNucleo(respuesta(final, texto, mime, 200, redirigida), ambito, ambito)).toBe(false);
  });
  it('no interpreta HTML de entrada como JavaScript ni confía en una lista de otro montaje', async () => {
    expect(await reglas.respuestaNucleo(respuesta(js, '<form/>'), js, ambito)).toBe(false);
    const generacion = politica.nombresCache(ambito).app + ':00000000-0000-4000-8000-000000000000';
    expect(reglas.listaPreparada({ version: 2, ambito, generacion, urls: [ambito, ambito + 'entrar'] }, ambito)).toBe(false);
    expect(reglas.listaPreparada({ version: 2, ambito, generacion, urls: [ambito] }, ambito + 'itinerario/')).toBe(false);
  });
  it('OFF-01: descriptor exige generación propia y rechaza punteros ajenos o sin generación', () => {
    const generacion = politica.nombresCache(ambito).app + ':00000000-0000-4000-8000-000000000000';
    const lista = { version: 2, ambito, generacion, urls: [ambito, js] };
    expect(reglas.listaPreparada(lista, ambito)).toBe(true);
    for (const nombre of [undefined, 'app-v1', 'otra-app', politica.nombresCache(ambito + 'itinerario/').app + ':00000000-0000-4000-8000-000000000000', generacion + '/extra']) {
      expect(reglas.listaPreparada({ ...lista, generacion: nombre }, ambito)).toBe(false);
    }
    expect(reglas.listaPreparada({ ...lista, urls: [ambito, ambito + 'api/fotos'] }, ambito)).toBe(false);
  });
  it('solo acepta mapas públicos conocidos y valida respuestas heredadas', () => {
    const url = 'https://tiles.openfreemap.org/planet/nueva/3/2/1.pbf';
    const vieja = 'https://tiles.openfreemap.org/planet/vieja/3/2/1.pbf';
    expect(reglas.esMapa(url)).toBe(true);
    expect(reglas.respuestaMapa(respuesta(vieja, 'tesela', 'application/x-protobuf'), url)).toBe(true);
    expect(reglas.respuestaMapa(respuesta(vieja, '<form/>'), url)).toBe(false);
    expect(reglas.esMapa(ambito + 'planet/3/2/1.pbf')).toBe(false);
    expect(reglas.esMapa('https://tiles.openfreemap.org/fotos/original.jpg')).toBe(false);
    expect(reglas.esMapa(url + '?token=x')).toBe(false);
    expect(reglas.esMapa('https://tiles.openfreemap.org/desconocido')).toBe(false);
  });
});

describe('Preparación explícita', () => {
  it('un aviso heredado no anuncia un núcleo v2 preparado ni se elimina', () => {
    entorno();
    const getItem = vi.fn((clave: string) => clave === 'mapas-descargados' ? '2026-10-11T00:00:00.000Z' : null);
    vi.stubGlobal('localStorage', { getItem });
    expect(descargaAnterior()).toBeNull();
    expect(getItem).toHaveBeenCalledWith('mapas-descargados-v2:' + ambito);
  });
  it('registrar el worker no descarga ni guarda recursos de la visita', async () => {
    const { caches, red } = entorno();
    vi.stubEnv('DEV', false);
    await registrarServiceWorker();
    expect(caches.open).not.toHaveBeenCalled(); expect(red).not.toHaveBeenCalled();
  });
  it.each([ambito, ambito + 'itinerario/'])('publica únicamente el núcleo validado de %s', async (base) => {
    const { almacenes, red } = entorno(base);
    await guardarApp();
    const nombres = politica.nombresCache(base);
    const lista = await (await almacenes.get(nombres.lista)!.match(base))!.json();
    expect(lista.urls).toHaveLength(9);
    expect(lista.urls).toContain(new URL('assets/archivo-latin-wght-normal-Ef123456.woff2', base).href);
    expect(lista.urls.some((u: string) => u.includes('/api/'))).toBe(false);
    for (const [req] of red.mock.calls) {
      expect(req).toBeInstanceOf(Request);
      expect((req as Request).credentials).toBe('same-origin');
      expect((req as Request).cache).toBe('no-store');
    }
  });
  it('una redirección hacia la entrada no contamina el inicio ni modifica una preparación anterior', async () => {
    const { red, almacenes } = entorno();
    await guardarApp();
    const anterior = await (await publicada(almacenes)).match(ambito);
    red.mockImplementationOnce(async () => respuesta(ambito + 'entrar', '<form>Contraseña</form>', 'text/html', 200, true));
    await expect(guardarApp()).rejects.toThrow('núcleo offline');
    expect(await (await (await publicada(almacenes)).match(ambito))!.text()).toBe(await anterior!.text());
  });
  it('un fallo parcial no publica disponibilidad ni escribe respuestas anteriores a la validación completa', async () => {
    const { red, almacenes } = entorno();
    red.mockImplementationOnce(async () => respuesta(ambito, html));
    red.mockImplementationOnce(async () => { throw new Error('Sin red'); });
    await expect(guardarApp()).rejects.toThrow('Sin red');
    expect(almacenes.size).toBe(0);
  });
  it('un fallo de cuota no publica una lista nueva ni elimina una copia anterior', async () => {
    const { almacenes } = entorno();
    await guardarApp();
    const nombres = politica.nombresCache(ambito);
    const cache = await publicada(almacenes);
    const lista = almacenes.get(nombres.lista)!;
    const anterior = await (await lista.match(ambito))!.text();
    const publicar = vi.fn(lista.put.bind(lista));
    lista.put = publicar;
    vi.spyOn(Almacen.prototype, 'put').mockRejectedValueOnce(new DOMException('Sin cuota', 'QuotaExceededError'));
    await expect(guardarApp()).rejects.toThrow('Sin cuota');
    expect(publicar).not.toHaveBeenCalled();
    expect(await (await lista.match(ambito))!.text()).toBe(anterior);
    expect(await (await cache.match(ambito))!.text()).toBe(html);
  });
  it('OFF-01: cuota solo en publicación final conserva raíz y script de la generación A', async () => {
    const { almacenes, caches, red } = entorno();
    await guardarApp();
    const lista = almacenes.get(politica.nombresCache(ambito).lista)!;
    const anterior = await (await lista.match(ambito))!.text();
    const redAnterior = red.getMockImplementation()!;
    red.mockImplementation(async (req) => {
      const url = req instanceof Request ? req.url : String(req);
      if (url === ambito) return respuesta(url, html.replace('Ab123456', 'Bb123456'));
      return redAnterior(req);
    });
    vi.spyOn(lista, 'put').mockRejectedValueOnce(new DOMException('Sin cuota final', 'QuotaExceededError'));
    await expect(guardarApp()).rejects.toThrow('Sin cuota final');
    expect(await (await lista.match(ambito))!.text()).toBe(anterior);
    const sw = worker({ caches, fetch: async () => { throw new Error('Sin red'); } });
    expect(await (await sw.nucleoRedPrimero(new Request(ambito))).text()).toBe(html);
    expect(await (await sw.nucleoRedPrimero(new Request(js))).text()).toBe('');
  });
  it('OFF-01: escritura tardía fallida conserva la generación publicada aunque la nueva raíz ya exista', async () => {
    const { almacenes } = entorno();
    await guardarApp();
    const anterior = await publicada(almacenes);
    const original = Almacen.prototype.put;
    let raizEscrita = false;
    vi.spyOn(Almacen.prototype, 'put').mockImplementation(async function (this: Almacen, req, resp) {
      const url = req instanceof Request ? req.url : String(req);
      if (url === js) throw new Error('Fallo tardío');
      await original.call(this, req, resp);
      if (url === ambito) raizEscrita = true;
    });
    await expect(guardarApp()).rejects.toThrow('Fallo tardío');
    expect(raizEscrita).toBe(true);
    expect(await publicada(almacenes)).toBe(anterior);
    expect(await (await anterior.match(js))!.text()).toBe('');
  });
  it('OFF-01: preparaciones concurrentes publican completas incluso en orden inverso', async () => {
    const { almacenes, red, caches } = entorno();
    let liberar!: () => void;
    let detenida!: () => void;
    const parada = new Promise<void>((ok) => { detenida = ok; });
    const espera = new Promise<void>((ok) => { liberar = ok; });
    const original = Almacen.prototype.put;
    let bloquear = true;
    vi.spyOn(Almacen.prototype, 'put').mockImplementation(async function (this: Almacen, req, resp) {
      if (bloquear) { bloquear = false; detenida(); await espera; }
      await original.call(this, req, resp);
    });
    const primera = guardarApp();
    await parada;
    const redAnterior = red.getMockImplementation()!;
    red.mockImplementation(async (req) => {
      const url = req instanceof Request ? req.url : String(req);
      return url === ambito ? respuesta(url, html.replace('Ab123456', 'Bb123456')) : redAnterior(req);
    });
    await guardarApp();
    const segunda = await publicada(almacenes);
    expect(await (await segunda.match(ambito))!.text()).toContain('Bb123456');
    const sw = worker({ caches, fetch: async () => { throw new Error('Sin red'); } });
    expect(await (await sw.nucleoRedPrimero(new Request(ambito + 'assets/index-Bb123456.js'))).text()).toBe('');
    liberar(); await primera;
    expect(await publicada(almacenes)).not.toBe(segunda);
    expect(await (await sw.nucleoRedPrimero(new Request(ambito))).text()).toBe(html);
    expect(await (await sw.nucleoRedPrimero(new Request(js))).text()).toBe('');
    expect(await (await segunda.match(ambito))!.text()).toContain('Bb123456');
  });
  it('OFF-01: publicación aplicada que pierde el acuse no deja un puntero colgante', async () => {
    const { almacenes } = entorno();
    await guardarApp();
    const lista = almacenes.get(politica.nombresCache(ambito).lista)!;
    const original = lista.put.bind(lista);
    vi.spyOn(lista, 'put').mockImplementation(async (req, resp) => {
      await original(req, resp); throw new Error('Acuse perdido');
    });
    await expect(guardarApp()).rejects.toThrow('Acuse perdido');
    const actual = await publicada(almacenes);
    expect(await (await actual.match(ambito))!.text()).toBe(html);
    expect(await (await actual.match(js))!.text()).toBe('');
  });
  it('rechaza dependencias ajenas sin pedir sus URLs ni sus credenciales', () => {
    expect(() => politica.referenciasNucleo('<script src="/api/fotos/original"></script>', ambito, ambito, 'html')).toThrow('ajena');
    expect(() => politica.referenciasNucleo('body{background:url(https://otro.test/foto.png)}', css, ambito, 'css')).toThrow('ajena');
  });
  it('un mapa configurado con fotos privadas no envía credenciales ni descarga esa URL', async () => {
    const { red } = entorno();
    const progreso = vi.fn();
    const mapa = { getSource: () => ({ tiles: [ambito + 'fotos/{z}/{x}/{y}.pbf'], url: ambito + 'api/fotos', maxzoom: 0 }), getStyle: () => ({ layers: [] }) };
    const resultado = await descargarMapas(mapa as never, { paradas: [] } as never, progreso);
    expect(resultado.fallos).toBe(2);
    expect(red.mock.calls.some(([req]) => (req instanceof Request ? req.url : String(req)).includes('api/fotos'))).toBe(false);
    expect(progreso).toHaveBeenCalledTimes(2);
    expect(localStorage.setItem).not.toHaveBeenCalled();
  });
  it('no anuncia mapas guardados si falla el núcleo; reutiliza mapas heredados seguros sin descargarlos', async () => {
    const { red, caches } = entorno();
    const urls = ['https://tiles.openfreemap.org/styles/positron', 'https://tiles.openfreemap.org/planet'];
    const legado = await caches.open('mapa-v1');
    for (const url of urls) await legado.put(url, respuesta(url, '{}', 'application/json'));
    red.mockRejectedValue(new Error('Sin red'));
    const progreso = vi.fn();
    const mapa = { getSource: () => ({ tiles: ['https://tiles.openfreemap.org/planet/semana/{z}/{x}/{y}.pbf'], url: urls[1], maxzoom: 0 }), getStyle: () => ({ layers: [] }) };
    const resultado = await descargarMapas(mapa as never, { paradas: [] } as never, progreso);
    expect(resultado).toEqual({ fallos: 1, total: 2 });
    expect(red).toHaveBeenCalledTimes(1);
    expect(progreso).toHaveBeenCalledTimes(2);
    expect(localStorage.setItem).not.toHaveBeenCalled();
    expect(legado.entradas.size).toBe(2);
  });
});

describe('Flujo real del SW con puertos WebAPI controlados', () => {
  it('devuelve 401/503/redirect sin lectura ni escritura de CacheStorage y conserva Request', async () => {
    for (const estado of [401, 503, 303]) {
      const red = vi.fn(async (_req: Request) => new Response('', { status: estado }));
      const caches = { open: vi.fn() };
      const req = new Request(ambito, { credentials: 'include', signal: new AbortController().signal });
      const resp = await worker({ fetch: red, caches }).nucleoRedPrimero(req);
      expect(resp.status).toBe(estado); expect(caches.open).not.toHaveBeenCalled();
      expect(red.mock.calls[0][0]).toBe(req);
    }
  });
  it('solo ante rechazo de red lee una respuesta validada y nunca usa app-v1 contaminada', async () => {
    const { caches } = entorno();
    const nombres = politica.nombresCache(ambito);
    await (await caches.open(nombres.lista)).put(ambito, new Response(JSON.stringify({ version: 2, ambito, generacion: nombres.app + ':00000000-0000-4000-8000-000000000000', urls: [ambito] })));
    const cache = await caches.open(nombres.app + ':00000000-0000-4000-8000-000000000000');
    await cache.put(ambito, respuesta(ambito, html));
    const sw = worker({ fetch: async () => { throw new Error('Sin red'); }, caches });
    expect(await (await sw.nucleoRedPrimero(new Request(ambito))).text()).toBe(html);
    await cache.put(ambito, respuesta(ambito + 'entrar', html));
    await expect(sw.nucleoRedPrimero(new Request(ambito))).rejects.toThrow('Sin red');
    expect(caches.open.mock.calls.flat()).not.toContain('app-v1');
  });
  it('una preparación manual nunca se satisface con la copia offline ni tras un aborto', async () => {
    const caches = { open: vi.fn() };
    const sw = worker({ fetch: async () => { throw new Error('Sin red'); }, caches });
    await expect(sw.nucleoRedPrimero(new Request(ambito, { cache: 'no-store' }))).rejects.toThrow('Sin red');
    const control = new AbortController(); control.abort();
    await expect(sw.nucleoRedPrimero(new Request(ambito, { signal: control.signal }))).rejects.toThrow('Sin red');
    expect(caches.open).not.toHaveBeenCalled();
  });
});
