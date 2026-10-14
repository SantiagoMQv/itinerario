// Montaje privado LOCAL con la receta real: npm run build:privado -- <perfil.json> <salida-nueva>.
// El perfil es SINTÉTICO (los presupuestos de las pruebas de la entrada) con el origen de un HTTPS loopback propio, de
// certificado temporal hecho con openssl, que se conoce ANTES de construir. Perfiles, salidas y casos de colisión viven
// en un mkdtemp propio (itinerario-build-privado-*) que afterAll borra entero. Nada de esto es un perfil, origen,
// presupuesto ni carpeta operativa, y construir aquí no autoriza servir ni desplegar nada. M1 usa el comando npm
// exacto; los casos que rechazan llaman al lanzador de Node (la misma implementación, sin volver a pasar tsc) y las
// rutas dentro del repositorio se prueban con la función pura, que rechaza sin crear nada en él. Los casos C construyen
// EN MEMORIA, con el plugin y la configuración reales, perfiles sintéticos que la receta en disco rechazaría: no
// autorizan ningún montaje real con un perfil que no vale.
// No prueba Safari, móviles reales ni proveedores.
import { test, expect, type BrowserContext, type Page } from '@playwright/test';
import { createServer, type Server } from 'node:https';
import { execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readlinkSync, realpathSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { extname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build, mergeConfig, type Rollup } from 'vite';
import type { DatosPerfilPiloto } from '../src/perfil-piloto';
import { configPrivada, reservarSalida } from '../vite.config.privado';

const REPO = realpathSync(fileURLToPath(new URL('..', import.meta.url)));
const USO = 'Uso: npm run build:privado -- <perfil.json> <salida-nueva>';
// Texto que solo está en el código privado (src/preparar-piloto.ts): sirve de marca en los bundles.
const MARCA = 'El perfil del piloto es de otro origen.';
// Antes del viaje (solo la fecha, no los temporizadores): la app abre siempre en «Todo».
const HORA = '2026-10-14T12:00:00+08:00';
const INCIERTO = 'No se pudo comprobar con el servidor. Lo marcado en este móvil está guardado aquí.';
const SIN_RESPALDOS = 'Aún no hay respaldos registrados en este móvil.';
const CATALOGO = 'Fotos respaldadas desde cualquiera de los dos móviles. Se consultan de una en una.';
const INTRO_COPIA = 'Guarda en un archivo las fotos, las marcas y el registro de respaldos de este móvil, o importa el '
  + 'archivo de otro móvil.';
const TIPOS: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2',
  '.woff': 'font/woff', '.webmanifest': 'application/manifest+json' };
// Página de configuración no válida: su título y el motivo que da para cada error conocido de la preparación.
const TITULO = 'No se puede abrir el itinerario privado';
const MOTIVOS = { perfil: 'el perfil no tiene la forma o los límites que espera la app.',
  origen: 'el perfil es para otra dirección web, no para la de esta página.',
  plan: 'los límites del perfil no admiten el plan de este itinerario.' };
const ANCLA = '<a id="saltar" href="#ahora">Ir a «ahora»</a>';

/** Presupuestos SINTÉTICOS (los del test de la entrada) con el origen del fixture: no son política desplegada. */
function perfilDe(origen: string) {
  return {
    origen, maxBytesCuerpoProveedor: 67045,
    respaldoServidor: { maxBytesOriginal: 1024, maxBytesEntrada: 67044, maxBytesChunk: 4096,
      maxBytesCabeceras: 256, maxBytesRetenidos: 2000000, maxBloquesOriginal: 4, bytesBloque: 256, plazoMs: 1000 },
    listadoServidor: { maxFilas: 1, maxOperacionesPorFoto: 1, maxBytesSql: 5000000,
      maxBytesRespuesta: 500000, maxBytesRetenidos: 60000000, plazoMs: 1000 },
    listadoCliente: { maxFilas: 1, maxBytesPagina: 500000, maxBytesChunk: 4096, maxBytesBackingChunk: 4096,
      maxLecturas: 100, maxBytesPlan: 4194304, maxBytesRetenidos: 512 * 1024 ** 2, plazoMs: 1000 },
    portabilidad: { limites: { maxRegistros: 10, maxBytesMetadatos: 10000, maxBytesArchivo: 100000, maxProfundidad: 8 },
      limitesHistoria: { maxImportaciones: 2, maxObservaciones: 10, maxProcedencias: 10, maxBytesHistoria: 200000 } },
  } satisfies DatosPerfilPiloto;
}

interface Ejecucion { readonly codigo: number | null; readonly errores: string }
/** Proceso hijo limitado a la receta privada (npm o su lanzador de Node): su código y su salida de error. */
function ejecutar(orden: string, args: readonly string[]): Promise<Ejecucion> {
  return new Promise((ok, no) => {
    const hijo = spawn(orden, args, { cwd: REPO, stdio: ['ignore', 'ignore', 'pipe'] });
    let errores = '';
    hijo.stderr.setEncoding('utf8').on('data', (texto: string) => { errores += texto; });
    hijo.on('error', no);
    hijo.on('close', (codigo) => ok({ codigo, errores }));
  });
}
const lanzar = (...args: string[]) => ejecutar(process.execPath, ['scripts/build-privado.mjs', ...args]);

/** Huella de cada archivo del dist PÚBLICO, que compila el webServer existente antes de las pruebas. */
async function huellasDist(): Promise<Record<string, string>> {
  const dist = join(REPO, 'dist');
  const huellas: Record<string, string> = {};
  for (const e of await readdir(dist, { recursive: true, withFileTypes: true })) {
    if (!e.isFile()) continue;
    const ruta = join(e.parentPath, e.name);
    huellas[ruta.slice(dist.length + 1)] = createHash('sha256').update(await readFile(ruta)).digest('hex');
  }
  return huellas;
}
/** ¿Algún .js de la carpeta lleva la marca del código privado? */
async function llevaMarca(carpeta: string): Promise<boolean> {
  for (const e of await readdir(carpeta, { recursive: true, withFileTypes: true })) {
    if (e.isFile() && e.name.endsWith('.js') && (await readFile(join(e.parentPath, e.name), 'utf8')).includes(MARCA)) return true;
  }
  return false;
}
/** Lo que se ve de la página de error: tema, fondo y contraste WCAG del texto y del contorno de foco, y desbordes. */
const medir = (page: Page) => page.evaluate(() => {
  const canales = (c: string) => {
    const n = (c.match(/[\d.]+/g) ?? []).slice(0, 3).map(Number);
    return c.startsWith('color(') ? n.map((v) => v * 255) : n;
  };
  const luz = (c: string) => canales(c).map((v) => (v / 255 <= 0.03928 ? v / 255 / 12.92 : ((v / 255 + 0.055) / 1.055) ** 2.4))
    .reduce((s, v, i) => s + v * [0.2126, 0.7152, 0.0722][i], 0);
  const contraste = (a: string, b: string) => {
    const [x, y] = [luz(a), luz(b)].sort((p, q) => q - p);
    return (x + 0.05) / (y + 0.05);
  };
  const fondo = getComputedStyle(document.querySelector('main')!).backgroundColor;
  const titulo = document.querySelector('h1')!;
  // Holgura entre la caja del título (la que rodea el contorno de foco) y sus letras, a cada lado.
  const letras = document.createRange();
  letras.selectNodeContents(titulo);
  const lineas = [...letras.getClientRects()];
  const caja = titulo.getBoundingClientRect();
  return { tema: document.documentElement.dataset.tema, fondo,
    textos: [...document.querySelectorAll('main h1, main p')].map((e) => contraste(getComputedStyle(e).color, fondo)),
    contorno: getComputedStyle(titulo).outlineStyle, foco: contraste(getComputedStyle(titulo).outlineColor, fondo),
    separacion: getComputedStyle(titulo).outlineOffset,
    holgura: Math.max(caja.right - Math.max(...lineas.map((r) => r.right)), Math.min(...lineas.map((r) => r.left)) - caja.left),
    desborde: document.documentElement.scrollWidth > innerWidth || [...document.querySelectorAll('main, main *')]
      .some((e) => e.scrollWidth > e.clientWidth || e.getBoundingClientRect().right > innerWidth) };
});

test.describe('montaje privado local', () => {
  test.use({ ignoreHTTPSErrors: true });
  let servidor: Server;
  let temporal = '';
  let origen = '';
  let perfil = '';
  let salida = '';
  let distAntes: Record<string, string> = {};
  let construccion: Ejecucion;
  /** Montaje en memoria de un caso C; null: se sirve la salida de la receta en disco (M1–M5). */
  let montajeMemoria: Map<string, string | Uint8Array> | null = null;

  test.beforeAll(async () => {
    // Sólo este proceso crea, usa y borra esta raíz temporal y todo lo que hay dentro.
    temporal = await realpath(await mkdtemp(join(tmpdir(), 'itinerario-build-privado-')));
    execFileSync('/usr/bin/openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-sha256', '-days', '1',
      '-config', '/dev/stdin', '-keyout', join(temporal, 'clave-fixture.pem'), '-out', join(temporal, 'certificado-fixture.pem')],
    { input: '[req]\nprompt=no\ndistinguished_name=dn\nx509_extensions=ext\n[dn]\nCN=127.0.0.1\n[ext]\nsubjectAltName=IP:127.0.0.1\nbasicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature,keyEncipherment\nextendedKeyUsage=serverAuth\n', stdio: ['pipe', 'pipe', 'pipe'] });
    servidor = createServer({ key: await readFile(join(temporal, 'clave-fixture.pem')),
      cert: await readFile(join(temporal, 'certificado-fixture.pem')) }, (req, res) => {
      // Sirve SOLO la salida construida (la página en /, sus archivos debajo); lo demás, /api incluido, da 404.
      const ruta = new URL(req.url!, 'https://local').pathname;
      const archivo = resolve(salida, '.' + (ruta === '/' ? '/index.html' : ruta));
      res.setHeader('Cache-Control', 'no-store');
      if (!archivo.startsWith(salida + sep)) { res.statusCode = 404; res.end(); return; }
      if (montajeMemoria) {
        const cuerpo = montajeMemoria.get(archivo.slice(salida.length + 1));
        if (cuerpo === undefined) { res.statusCode = 404; res.end(); return; }
        res.setHeader('Content-Type', TIPOS[extname(archivo)] ?? 'application/octet-stream'); res.end(cuerpo); return;
      }
      readFile(archivo).then((cuerpo) => {
        res.setHeader('Content-Type', TIPOS[extname(archivo)] ?? 'application/octet-stream'); res.end(cuerpo);
      }, () => { res.statusCode = 404; res.end(); });
    });
    await new Promise<void>((ok) => servidor.listen(0, '127.0.0.1', ok));
    const direccion = servidor.address();
    if (!direccion || typeof direccion === 'string') throw new Error('Sin puerto loopback propio');
    origen = `https://127.0.0.1:${direccion.port}`;
    perfil = join(temporal, 'perfil.json');
    await writeFile(perfil, JSON.stringify(perfilDe(origen)));
    salida = join(temporal, 'montaje');
    distAntes = await huellasDist();
    // La receta EXACTA de quien opera, con el perfil sintético y una salida nueva.
    construccion = await ejecutar('npm', ['run', 'build:privado', '--', perfil, salida]);
  });
  test.afterAll(async () => {
    try {
      if (servidor) {
        const cierre = new Promise<void>((ok, no) => servidor.close((e) => (e ? no(e) : ok())));
        servidor.closeAllConnections(); await cierre;
      }
    } finally {
      if (temporal) await rm(temporal, { recursive: true, force: true });
    }
  });
  test.beforeEach(() => { montajeMemoria = null; });

  /** Montaje EN MEMORIA con el plugin y la configuración reales (configPrivada) y un perfil sintético cualquiera, para
   * llevar a la página perfiles que la receta en disco rechazaría antes de construir. No escribe nada. */
  async function montarEnMemoria(datos: unknown) {
    const resultado = await build(mergeConfig(configPrivada(datos, join(temporal, 'no-se-escribe')),
      { configFile: false, root: REPO, logLevel: 'silent', build: { write: false } }));
    const salidaVite = (Array.isArray(resultado) ? resultado[0] : resultado) as Rollup.RollupOutput;
    montajeMemoria = new Map(salidaVite.output.map((a) => [a.fileName, a.type === 'chunk' ? a.code : a.source]));
  }
  /** Como en M1: registro de /api y de errores de página, cortes de red y la fecha antes del viaje. No navega. */
  async function vigilar(page: Page, context: BrowserContext) {
    const api: string[] = [];
    const errores: string[] = [];
    context.on('request', (r) => {
      const url = new URL(r.url());
      if (url.pathname.startsWith('/api/')) api.push(`${r.method()} ${url.pathname}`);
    });
    page.on('pageerror', (e) => { errores.push(e.message); });
    await context.route('**/*', (r) => {
      const url = new URL(r.request().url());
      return url.origin !== origen || url.pathname === '/api/progreso' ? r.abort() : r.continue();
    });
    await page.clock.setFixedTime(new Date(HORA));
    return { api, errores };
  }

  test('M1 · la receta npm construye el perfil sintético en una salida nueva y el montaje arranca la app privada',
    async ({ page, context }) => {
      expect(construccion.codigo, construccion.errores).toBe(0);
      expect(existsSync(join(salida, 'index.html'))).toBe(true);
      const api: string[] = [];
      const errores: string[] = [];
      context.on('request', (r) => {
        const url = new URL(r.url());
        if (url.pathname.startsWith('/api/')) api.push(`${r.method()} ${url.pathname}`);
      });
      page.on('pageerror', (e) => { errores.push(e.message); });
      // Lo de otro origen (estilo y teselas del mapa) y TODO /api/progreso se cortan antes de responder.
      await context.route('**/*', (r) => {
        const url = new URL(r.request().url());
        return url.origin !== origen || url.pathname === '/api/progreso' ? r.abort() : r.continue();
      });
      await page.clock.setFixedTime(new Date(HORA));
      await page.goto(origen + '/');
      // «Todo» pintado y el progreso asentado (cualquier composición) y, después, los controles PRIVADOS del perfil.
      await expect(page.locator('#compartido .estado-compartido')).toHaveText(INCIERTO);
      await expect(page.locator('#fotos-viaje')).toHaveCount(1);
      await expect(page.locator('#copia-movil')).toHaveCount(1);
      await expect(page.locator('#fotos-viaje .estado-fotos-viaje')).toHaveText(SIN_RESPALDOS);
      await expect(page.locator('#fotos-viaje .estado-catalogo')).toHaveText(CATALOGO);
      await expect(page.locator('#copia-movil .estado-copia')).toHaveText(INTRO_COPIA);
      expect([...new Set(api)]).toEqual(['GET /api/progreso']);
      expect(errores).toEqual([]);
      expect(await llevaMarca(salida)).toBe(true);
    });

  test('M2 · sin exactamente dos argumentos no construye ni crea nada', async () => {
    const sobrante = join(temporal, 'm2-salida');
    for (const args of [[], [perfil], [perfil, sobrante, 'extra']]) {
      const r = await lanzar(...args);
      expect(r.codigo, args.join(' ')).toBe(1);
      expect(r.errores, args.join(' ')).toContain(USO);
    }
    expect(existsSync(sobrante)).toBe(false);
  });

  test('M3 · una salida que ya existe, sin carpeta padre o dentro del repositorio se rechaza sin tocar nada',
    async () => {
      const carpeta = join(temporal, 'm3-carpeta');
      await mkdir(carpeta);
      await writeFile(join(carpeta, 'marca.txt'), 'no tocar');
      const archivo = join(temporal, 'm3-archivo');
      await writeFile(archivo, 'no tocar');
      const roto = join(temporal, 'm3-enlace-roto');
      await symlink(join(temporal, 'm3-no-existe'), roto);
      const casos: [string, string][] = [[carpeta, 'La salida ya existe'], [archivo, 'La salida ya existe'],
        [roto, 'La salida ya existe'], [join(temporal, 'm3-sin-padre', 'salida'), 'No existe la carpeta donde crear la salida']];
      for (const [destino, mensaje] of casos) {
        const r = await lanzar(perfil, destino);
        expect(r.codigo, destino).toBe(1);
        expect(r.errores, destino).toContain(mensaje);
      }
      // Lo que ya existía sigue exactamente igual.
      expect(await readdir(carpeta)).toEqual(['marca.txt']);
      expect(await readFile(join(carpeta, 'marca.txt'), 'utf8')).toBe('no tocar');
      expect(await readFile(archivo, 'utf8')).toBe('no tocar');
      expect(readlinkSync(roto)).toBe(join(temporal, 'm3-no-existe'));
      expect(existsSync(join(temporal, 'm3-sin-padre'))).toBe(false);
      // Dentro del repositorio, también a través de un padre que es un enlace: la función pura rechaza ANTES de crear.
      const enlace = join(temporal, 'm3-enlace-repo');
      await symlink(REPO, enlace);
      for (const destino of [join(REPO, 'salida-privada-prueba'), join(enlace, 'salida-privada-prueba')]) {
        expect(() => reservarSalida(destino), destino).toThrow('La salida tiene que estar fuera del repositorio.');
      }
      expect(existsSync(join(REPO, 'salida-privada-prueba'))).toBe(false);
    });

  test('M4 · un perfil ausente, que no es JSON, inválido, que no cabe en el plan real o dentro del repositorio se '
    + 'rechaza antes de crear la salida', async () => {
    const noJson = join(temporal, 'm4-no-json.json');
    await writeFile(noJson, '{ no es json');
    const vacio = join(temporal, 'm4-vacio.json');
    await writeFile(vacio, '{}');
    const grande = join(temporal, 'm4-plan.json');
    const d = perfilDe(origen);
    await writeFile(grande, JSON.stringify({ ...d, listadoCliente: { ...d.listadoCliente, maxBytesPlan: 4096 } }));
    const casos: [string, string][] = [
      [join(temporal, 'm4-no-existe.json'), 'No existe el perfil privado'],
      [noJson, 'El perfil privado no es JSON válido'],
      [vacio, 'Perfil del piloto inválido.'],
      [grande, 'No se puede preparar el listado de fotos.'],
      [join(REPO, 'package.json'), 'El perfil privado tiene que estar fuera del repositorio.'],
    ];
    for (const [i, [ruta, mensaje]] of casos.entries()) {
      const destino = join(temporal, `m4-salida-${i}`);
      const r = await lanzar(ruta, destino);
      expect(r.codigo, ruta).toBe(1);
      expect(r.errores, ruta).toContain(mensaje);
      expect(existsSync(destino), ruta).toBe(false);
    }
  });

  test('M5 · la web publicada no cambia: dist idéntico durante el build privado y sin código privado', async () => {
    expect(await huellasDist()).toEqual(distAntes);
    expect(await llevaMarca(join(REPO, 'dist'))).toBe(false);
  });

  for (const caso of [
    { nombre: 'C1 · un perfil vacío', datos: () => ({}), motivo: MOTIVOS.perfil },
    { nombre: 'C2 · un perfil de otro origen', datos: () => ({ ...perfilDe(origen), origen: 'https://otro.example' }),
      motivo: MOTIVOS.origen },
    { nombre: 'C3 · un perfil cuyo plan real no cabe en maxBytesPlan', motivo: MOTIVOS.plan, datos: () => {
      const d = perfilDe(origen);
      return { ...d, listadoCliente: { ...d.listadoCliente, maxBytesPlan: 4096 } };
    } },
  ]) {
    test(`${caso.nombre}: la página lo explica con el foco en el título, sin arrancar ni abrir nada personal`,
      async ({ page, context }) => {
        await montarEnMemoria(caso.datos());
        const { api, errores } = await vigilar(page, context);
        await page.goto(origen + '/');
        await expect(page.getByRole('heading', { level: 1, name: TITULO })).toBeFocused();
        await expect(page.getByRole('main')).toContainText(`Motivo: ${caso.motivo}`);
        // Solo informa: sin botones, enlaces ni lienzo, nada guardado ni pedido, y el fallo de la preparación no es
        // un error de página.
        expect(await page.locator('button, a, canvas').count()).toBe(0);
        expect(await page.evaluate(async () => [localStorage.length, (await indexedDB.databases()).length])).toEqual([0, 0]);
        expect(api).toEqual([]);
        expect(errores).toEqual([]);
      });
  }

  test('C4 · si la app falla con un perfil válido, es un error de la app y no se presenta como configuración',
    async ({ page, context }) => {
      // El montaje de M1 (perfil válido) sin el ancla #saltar SOLO en el HTML que recibe esta prueba: main falla después
      // de empezar (mapa, identidad), como en A4, que ya prueba que ese arranque queda consumido.
      const html = await readFile(join(salida, 'index.html'), 'utf8');
      expect(html).toContain(ANCLA);
      const { api, errores } = await vigilar(page, context);
      await context.route(origen + '/', (r) => r.fulfill({ contentType: 'text/html; charset=utf-8', body: html.replace(ANCLA, '') }));
      await page.goto(origen + '/');
      await expect.poll(() => errores.length).toBe(1);
      expect(errores[0]).toContain('addEventListener');
      await expect(page.getByRole('heading', { level: 1 })).toHaveCount(0);
      await expect(page.locator('#mapa canvas')).toHaveCount(1);
      expect(api).toEqual([]);
    });

  test('C5 · la página de configuración no válida en móvil, horizontal y escritorio, de día y de noche',
    async ({ page, context }, testInfo) => {
      await montarEnMemoria({});
      const { api, errores } = await vigilar(page, context);
      for (const [ancho, alto] of [[390, 844], [360, 640], [844, 390], [1440, 900]] as const) {
        for (const tema of ['claro', 'oscuro'] as const) {
          const caso = `${ancho}x${alto} ${tema}`;
          await page.setViewportSize({ width: ancho, height: alto });
          await page.emulateMedia({ colorScheme: tema === 'oscuro' ? 'dark' : 'light' });
          await page.goto(origen + '/');
          await expect(page.getByRole('heading', { level: 1, name: TITULO }), caso).toBeFocused();
          await page.evaluate(async () => { await document.fonts.ready; });
          // Tema del sistema (sin preferencia guardada), texto y foco con contraste suficiente y nada desbordado.
          const m = await medir(page);
          expect(m.tema, caso).toBe(tema);
          expect(m.fondo, caso).toBe(tema === 'oscuro' ? 'rgb(18, 24, 32)' : 'rgb(255, 255, 255)');
          for (const c of m.textos) expect(c, caso).toBeGreaterThanOrEqual(4.5);
          expect(m.contorno, caso).toBe('solid');
          // La separación del contorno de foco de la app (2 px), no otra propia.
          expect(m.separacion, caso).toBe('2px');
          // El contorno se ciñe a las letras del título (también partido en dos líneas), no a la columna.
          expect(m.holgura, caso).toBeLessThanOrEqual(1);
          expect(m.foco, caso).toBeGreaterThanOrEqual(3);
          expect(m.desborde, caso).toBe(false);
          const ruta = testInfo.outputPath(`configuracion-invalida-${ancho}x${alto}-${tema}.png`);
          await page.screenshot({ path: ruta, fullPage: true });
          console.log(`CAPTURA ${ruta}`);
        }
      }
      expect(api).toEqual([]);
      expect(errores).toEqual([]);
    });
});
