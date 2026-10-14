// Arranque REAL del piloto privado y arranque único, en el móvil simulado de playwright.config.ts (Chromium).
// La página es EXCLUSIVA del fixture: el index.html real con su script público sustituido por una entrada virtual de
// Vite compilada en memoria (sin módulo semilla, alias, dependencias ni configuración del proyecto). Esa entrada
// importa SIN llamarlas la entrada real (src/entrada-piloto.ts) y la fábrica real (src/main.ts), y expone un puente
// de prueba que solo llama, siembra en crudo y lee en crudo cuando la prueba lo pide. La sirve un HTTPS loopback
// propio con certificado temporal (mkdtemp itinerario-arranque-piloto-tls-*, borrado en afterAll). Los presupuestos
// del perfil son SINTÉTICOS. Todo lo de otro origen y TODO /api/progreso se cortan antes de responder: no hay
// servidor de la app, proveedor, SQL, R2 ni cuenta, y nada de esto llega a la web publicada.
// No prueba Safari, iOS, un móvil real, la cuota ni ausencia universal de IO: al importar se evalúan los estilos y la
// biblioteca del mapa (que crea un lienzo suelto).
import { test, expect, type Page } from '@playwright/test';
import { createServer, type Server } from 'node:https';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build, type Plugin, type Rollup } from 'vite';
import { itinerario } from '../src/datos/itinerario';
import { crearClienteListadoFotos } from '../src/fotos-listado';
import { crearPerfilPiloto, type DatosPerfilPiloto } from '../src/perfil-piloto';

const GUARDA = 'La app ya se arrancó en esta página.';
const INVALIDO = 'Perfil del piloto inválido.';
const OTRO_ORIGEN = 'El perfil del piloto es de otro origen.';
const LISTADO = 'No se puede preparar el listado de fotos.';
// Antes del viaje (solo la fecha, no los temporizadores): la app abre siempre en «Todo».
const HORA = '2026-10-14T12:00:00+08:00';
const BASE_FOTOS = `itinerario-fotos:${encodeURIComponent(itinerario.id)}`;
const BASE_PROGRESO = 'itinerario-progreso';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const INCIERTO = 'No se pudo comprobar con el servidor. Lo marcado en este móvil está guardado aquí.';
const SIN_RESPALDOS = 'Aún no hay respaldos registrados en este móvil.';
const CATALOGO = 'Fotos respaldadas desde cualquiera de los dos móviles. Se consultan de una en una.';
const INTRO_COPIA = 'Guarda en un archivo las fotos, las marcas y el registro de respaldos de este móvil, o importa el '
  + 'archivo de otro móvil.';
// Datos sintéticos sembrados en crudo: no son la foto ni el progreso de nadie. El nombre lleva NUL y una tilde
// descompuesta (NFD), que los validadores de fotos admiten tal cual; las fechas de la foto se siembran como -0.
const SEMILLA = {
  foto: '12345678-1234-4123-8123-123456789abc', borrada: '22345678-1234-4123-8123-123456789abc',
  nombre: '\0 é «calle».heic', mime: 'image/heic', bytes: [0, 7, 255, 128, 1],
  legado: '{"versión":"anterior"}', identidad: '4d6f6f9e-1c2b-4a3d-8e5f-6a7b8c9d0e1f',
};

interface ResultadoArranque { readonly ok: boolean; readonly nombre?: string; readonly mensaje?: string }
interface FixtureArranque {
  readonly listo: true;
  /** arrancarPiloto(datos, location.origin); el fallo controlado se devuelve, no escapa como pageerror. */
  piloto(datos: unknown): ResultadoArranque;
  /** La fábrica con una composición (null y null) cuyo getter vuelve a llamar a la fábrica. */
  reentrada(): { readonly exterior: ResultadoArranque; readonly anidada: ResultadoArranque | null };
  sembrar(semilla: typeof SEMILLA): Promise<void>;
  comprobarSemilla(): Promise<{ readonly registros: readonly number[]; readonly nombre: string; readonly menosCero: boolean }>;
  fijarBase(): Promise<void>;
  /** Rutas que difieren de la base fijada: 'todo' (localStorage entero) o 'semilla' (identidad y legado). */
  diferencias(alcance: 'todo' | 'semilla'): Promise<string[]>;
}
declare global { interface Window { fixtureArranque?: FixtureArranque } }

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

const piloto = (page: Page, datos: unknown) => page.evaluate((d) => window.fixtureArranque!.piloto(d), datos);
const bases = (page: Page) => page.evaluate(async () => (await indexedDB.databases()).map((b) => b.name ?? '').sort());
/** Lo que deja un arranque en la página: lienzo ENLAZADO, secciones de «Todo», identidad y nombres de bases. */
const efectos = (page: Page) => page.evaluate(async () => ({
  canvas: document.querySelectorAll('#mapa canvas').length,
  compartido: document.querySelectorAll('#compartido').length,
  fotosViaje: document.querySelectorAll('#fotos-viaje').length,
  copia: document.querySelectorAll('#copia-movil').length,
  contenido: document.getElementById('contenido')!.childElementCount,
  dias: document.getElementById('dias')!.childElementCount,
  identidad: localStorage.getItem('identificador-dispositivo'),
  bases: (await indexedDB.databases()).map((b) => b.name ?? '').sort(),
}));
/** Un toque en «Modo noche»: con UN escuchador, claro pasa a oscuro; con dos vuelve a claro; sin ninguno, nada. */
async function voltearTema(page: Page) {
  const html = page.locator('html');
  const antes = await html.getAttribute('data-tema');
  await page.locator('#btn-tema').dispatchEvent('click');
  return { antes, despues: await html.getAttribute('data-tema') };
}
/** Arranque privado asentado: progreso abierto con su GET cortado, fotos y registro de respaldos leídos, copia pintada. */
async function esperarPrivada(page: Page) {
  await expect(page.locator('#compartido .estado-compartido')).toHaveText(INCIERTO);
  await expect(page.locator('#fotos-viaje .estado-fotos-viaje')).toHaveText(SIN_RESPALDOS);
  await expect(page.locator('#fotos-viaje .estado-catalogo')).toHaveText(CATALOGO);
  await expect(page.locator('#copia-movil .estado-copia')).toHaveText(INTRO_COPIA);
}

test.describe('nativa: arranque del piloto', () => {
  test.use({ ignoreHTTPSErrors: true });
  let servidor: Server;
  let temporal = '';
  let origen = '';
  let pagina = '';
  let perfil: ReturnType<typeof perfilDe>;
  let solicitudes: { metodo: string; origen: string; ruta: string }[] = [];
  let errores: string[] = [];
  const api = () => solicitudes.filter((s) => s.ruta.startsWith('/api/'));

  const ENTRADA = 'virtual:arranque-piloto-fixture';
  const fuente = (relativa: string) => JSON.stringify(fileURLToPath(new URL(relativa, import.meta.url)));
  const CODIGO_ENTRADA = `
import { arrancarPiloto } from ${fuente('../src/entrada-piloto.ts')};
import { arrancarItinerario } from ${fuente('../src/main.ts')};
import { itinerario } from ${fuente('../src/datos/itinerario.ts')};
import { crearProgreso } from ${fuente('../src/progreso.ts')};
import { capturarFotosLocal } from ${fuente('../src/fotos-local.ts')};
import { capturarProgresoLocal } from ${fuente('../src/progreso-local.ts')};
const BASE_FOTOS = ${JSON.stringify(BASE_FOTOS)};
const BASE_PROGRESO = ${JSON.stringify(BASE_PROGRESO)};
const TABLAS_FOTOS = ['metadatos', 'originales', 'miniaturas'];
const CLAVES_SEMILLA = ['identificador-dispositivo', 'marcas'];
const LIMITES = { maxRegistros: 1000, maxBytesMetadatos: 1000000, maxBytesArchivo: 8000000, maxProfundidad: 64 };
const intentar = (hacer) => {
  try { hacer(); return { ok: true }; } catch (e) { return { ok: false, nombre: e?.name, mensaje: e?.message }; }
};
const esperar = (peticion) => new Promise((ok, ko) => {
  peticion.onsuccess = () => ok(peticion.result); peticion.onerror = () => ko(peticion.error);
});
const terminada = (tx) => new Promise((ok, ko) => { tx.oncomplete = () => ok(); tx.onabort = () => ko(tx.error); });
// Siembra en CRUDO con el esquema de las bibliotecas (v1, tablas sin keyPath ni índices); espera al complete.
async function crearBase(nombre, tablas, escribir) {
  const apertura = indexedDB.open(nombre, 1);
  apertura.onupgradeneeded = () => { for (const t of tablas) apertura.result.createObjectStore(t); };
  const db = await esperar(apertura);
  const tx = db.transaction(tablas, 'readwrite');
  escribir(tx);
  await terminada(tx);
  db.close();
}
// Lectura en CRUDO y readonly de todas las tablas; una base ausente no se crea.
async function leerBase(nombre) {
  if (!(await indexedDB.databases()).some((b) => b.name === nombre)) return null;
  const db = await esperar(indexedDB.open(nombre));
  const nombres = [...db.objectStoreNames];
  const tx = db.transaction(nombres, 'readonly');
  const tablas = {};
  for (const t of nombres) {
    tablas[t] = [];
    const cursor = tx.objectStore(t).openCursor();
    cursor.onsuccess = () => { const c = cursor.result; if (c) { tablas[t].push([c.primaryKey, c.value]); c.continue(); } };
  }
  await terminada(tx);
  db.close();
  return { version: db.version, tablas };
}
async function instantanea() {
  const local = {};
  for (let i = 0; i < localStorage.length; i++) { const k = localStorage.key(i); local[k] = localStorage.getItem(k); }
  return { local, fotos: await leerBase(BASE_FOTOS), raiz: await leerBase(BASE_PROGRESO) };
}
const recortar = (s, alcance) => alcance === 'todo' ? s
  : { ...s, local: Object.fromEntries(Object.entries(s.local).filter(([k]) => CLAVES_SEMILLA.includes(k))) };
// Comparación exacta DENTRO del navegador: Object.is (-0 no es 0), mismas claves, y Blobs por tipo, tamaño y bytes.
async function comparar(a, b, ruta, difs) {
  if (a instanceof Blob || b instanceof Blob) {
    if (!(a instanceof Blob) || !(b instanceof Blob) || a.type !== b.type || a.size !== b.size) { difs.push(ruta); return; }
    const [x, y] = (await Promise.all([a.arrayBuffer(), b.arrayBuffer()])).map((v) => new Uint8Array(v));
    if (x.some((n, i) => n !== y[i])) difs.push(ruta);
    return;
  }
  if (typeof a !== 'object' || a === null || typeof b !== 'object' || b === null) {
    if (!Object.is(a, b)) difs.push(ruta);
    return;
  }
  const claves = (v) => JSON.stringify(Object.keys(v).sort());
  if (Array.isArray(a) !== Array.isArray(b) || Object.getPrototypeOf(a) !== Object.getPrototypeOf(b) || claves(a) !== claves(b)) {
    difs.push(ruta + ' (forma)');
    return;
  }
  for (const k of Object.keys(a)) await comparar(a[k], b[k], ruta + '/' + k, difs);
}
let base = null;
window.fixtureArranque = {
  listo: true,
  piloto: (datos) => intentar(() => arrancarPiloto(datos, location.origin)),
  reentrada() {
    let anidada = null;
    const composicion = {
      get respaldo() { anidada = intentar(() => arrancarItinerario({ respaldo: null, portabilidad: null })); return null; },
      portabilidad: null,
    };
    return { exterior: intentar(() => arrancarItinerario(composicion)), anidada };
  },
  async sembrar(d) {
    const destino = { tipo: 'parada', viajeId: itinerario.id, paradaId: itinerario.dias[0].paradas[0].id };
    await crearBase(BASE_FOTOS, TABLAS_FOTOS, (tx) => {
      tx.objectStore('metadatos').add({ formato: 1, fotoId: d.foto, destino, nombre: d.nombre, mimeDeclarado: d.mime,
        ultimaModificacion: -0, incorporada: -0, bytesOriginal: d.bytes.length, miniatura: { tipo: 'pendiente' } }, d.foto);
      tx.objectStore('originales').add(new Blob([new Uint8Array(d.bytes)], { type: d.mime }), d.foto);
      tx.objectStore('metadatos').add({ formato: 1, tipo: 'borrada', fotoId: d.borrada }, d.borrada);
    });
    // Raíz v3 coherente y SIN trabajo pendiente (cola vacía), elegida antes de escribir la prueba.
    await crearBase(BASE_PROGRESO, ['viajes'], (tx) => {
      tx.objectStore('viajes').add({ formato: 3, revisionServidor: 0, confirmado: crearProgreso(itinerario),
        estado: crearProgreso(itinerario), cola: [] }, itinerario.id);
    });
    localStorage.setItem('marcas', d.legado);
    localStorage.setItem('identificador-dispositivo', d.identidad);
  },
  // Antes de fijar la base, lo sembrado pasa los guards reales (capturas readonly de las bibliotecas).
  async comprobarSemilla() {
    const fotos = await capturarFotosLocal(itinerario, LIMITES);
    const progreso = await capturarProgresoLocal(itinerario, LIMITES);
    const viva = fotos.tablas.metadatos.find((r) => r.valor.tipo !== 'borrada').valor;
    return { registros: [...TABLAS_FOTOS.map((t) => fotos.tablas[t].length), progreso.tablas.viajes.length],
      nombre: viva.nombre, menosCero: Object.is(viva.ultimaModificacion, -0) && Object.is(viva.incorporada, -0) };
  },
  async fijarBase() { base = await instantanea(); },
  async diferencias(alcance) {
    const difs = [];
    await comparar(recortar(base, alcance), recortar(await instantanea(), alcance), '', difs);
    return difs;
  },
};
`;
  const entradaVirtual: Plugin = { name: 'entrada-arranque-piloto-fixture',
    resolveId: (id) => (id === ENTRADA ? `\0${ENTRADA}` : null),
    load: (id) => (id === `\0${ENTRADA}` ? CODIGO_ENTRADA : null) };
  const TIPOS: Record<string, string> = { js: 'text/javascript; charset=utf-8', css: 'text/css; charset=utf-8',
    png: 'image/png', svg: 'image/svg+xml', woff2: 'font/woff2', woff: 'font/woff' };

  test.beforeAll(async () => {
    // Compilación en memoria (write: false): nada se escribe en el repositorio ni en dist/.
    const resultado = await build({ configFile: false, logLevel: 'silent', plugins: [entradaVirtual],
      // Como vite.config.ts, sin leerlo: formato de workers; __PLAN__ es una fecha ISO fija SOLO de prueba.
      define: { __PLAN__: JSON.stringify('2026-10-14T00:00:00.000Z') }, worker: { format: 'es' },
      build: { write: false, minify: false, target: 'es2022', rollupOptions: { preserveEntrySignatures: 'strict',
        input: { piloto: ENTRADA }, output: { entryFileNames: '[name].js', chunkFileNames: 'fragmento-[hash].js',
          assetFileNames: '[name][extname]' } } } });
    const salida = (Array.isArray(resultado) ? resultado[0] : resultado) as Rollup.RollupOutput;
    const archivos = new Map(salida.output.map((a) => [a.fileName, {
      cuerpo: a.type === 'chunk' ? a.code : typeof a.source === 'string' ? a.source : new Uint8Array(a.source),
      tipo: TIPOS[a.fileName.split('.').pop() ?? ''] ?? 'application/octet-stream' }]));
    const estilos = salida.output.filter((a) => a.type === 'asset' && a.fileName.endsWith('.css')).map((a) => a.fileName);
    if (!archivos.has('piloto.js') || !estilos.length) throw new Error('La entrada del fixture no produjo piloto.js y su CSS');
    // El index.html REAL con una sola sustitución (su script público por la entrada del fixture) y el CSS emitido.
    const html = await readFile(new URL('../index.html', import.meta.url), 'utf8');
    const publico = '<script type="module" src="./src/publica.ts"></script>';
    if (html.split(publico).length !== 2 || html.split('</head>').length !== 2) {
      throw new Error('index.html no tiene un único script público y un único </head>');
    }
    pagina = html.replace(publico, '<script type="module" src="/piloto.js"></script>')
      .replace('</head>', `${estilos.map((c) => `<link rel="stylesheet" href="/${c}">`).join('')}</head>`);
    // Sólo este proceso genera, lee y borra estos archivos del fixture.
    temporal = await mkdtemp(join(tmpdir(), 'itinerario-arranque-piloto-tls-'));
    execFileSync('/usr/bin/openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-sha256', '-days', '1',
      '-config', '/dev/stdin', '-keyout', join(temporal, 'clave-fixture.pem'), '-out', join(temporal, 'certificado-fixture.pem')],
    { input: '[req]\nprompt=no\ndistinguished_name=dn\nx509_extensions=ext\n[dn]\nCN=127.0.0.1\n[ext]\nsubjectAltName=IP:127.0.0.1\nbasicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature,keyEncipherment\nextendedKeyUsage=serverAuth\n', stdio: ['pipe', 'pipe', 'pipe'] });
    servidor = createServer({ key: await readFile(join(temporal, 'clave-fixture.pem')),
      cert: await readFile(join(temporal, 'certificado-fixture.pem')) }, (req, res) => {
      const ruta = new URL(req.url!, 'https://local').pathname;
      res.setHeader('Cache-Control', 'no-store');
      if (ruta === '/') { res.setHeader('Content-Type', 'text/html; charset=utf-8'); res.end(pagina); return; }
      const a = archivos.get(ruta.slice(1));
      if (!a) { res.statusCode = 404; res.end(); return; }
      res.setHeader('Content-Type', a.tipo); res.end(a.cuerpo);
    });
    await new Promise<void>((ok) => servidor.listen(0, '127.0.0.1', ok));
    const direccion = servidor.address();
    if (!direccion || typeof direccion === 'string') throw new Error('Sin puerto loopback propio');
    origen = `https://127.0.0.1:${direccion.port}`;
    // Precondiciones con las fábricas reales (en Node no hay location): el perfil vale y el plan real cabe.
    perfil = perfilDe(origen);
    crearClienteListadoFotos({ plan: itinerario, origen, presupuesto: crearPerfilPiloto(perfil).respaldo.listado, http: null }).cerrar();
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
  test.beforeEach(async ({ page, context }) => {
    solicitudes = []; errores = [];
    context.on('request', (r) => {
      const url = new URL(r.url());
      solicitudes.push({ metodo: r.method(), origen: url.origin, ruta: url.pathname });
    });
    page.on('pageerror', (e) => { errores.push(e.message); });
    // Lo de otro origen (estilo y teselas del mapa) y TODO /api/progreso (GET incluido) se cortan antes de responder.
    await context.route('**/*', (r) => {
      const url = new URL(r.request().url());
      return url.origin !== origen || url.pathname === '/api/progreso' ? r.abort() : r.continue();
    });
    await page.clock.setFixedTime(new Date(HORA));
  });
  test.afterEach(() => {
    // Nada de fotos en la red y ningún envío de progreso; los fallos controlados los recoge el puente.
    expect(api().filter((s) => s.ruta.startsWith('/api/fotos'))).toEqual([]);
    expect(api().filter((s) => s.ruta === '/api/progreso' && s.metodo !== 'GET')).toEqual([]);
    expect(errores).toEqual([]);
  });

  async function abrir(page: Page) {
    await page.goto(origen + '/');
    await page.waitForFunction(() => window.fixtureArranque?.listo === true);
  }

  test('A1 · importar la entrada y la fábrica reales en frío no arranca nada', async ({ page }) => {
    await abrir(page);
    // Ningún lienzo ENLAZADO (la biblioteca del mapa crea uno suelto al evaluarse) y nada pintado por la app.
    expect(await page.evaluate(() => document.querySelectorAll('canvas').length)).toBe(0);
    for (const id of ['#mapa', '#contenido', '#dias', '#ahora']) await expect(page.locator(id)).toBeEmpty();
    // Ni identidad ni bases personales.
    expect(await page.evaluate(() => localStorage.length)).toBe(0);
    expect(await bases(page)).toEqual([]);
    // El tema del HTML tal cual y ningún escuchador en «Modo noche».
    expect(await voltearTema(page)).toEqual({ antes: 'claro', despues: 'claro' });
    await expect(page.locator('#btn-tema')).toHaveAttribute('aria-pressed', 'false');
    expect(solicitudes.filter((s) => s.origen !== origen)).toEqual([]);
    expect(api()).toEqual([]);
  });

  test('A2 · un segundo arranque válido se rechaza con la guarda y sin efectos nuevos', async ({ page }) => {
    await abrir(page);
    expect(await piloto(page, perfil)).toEqual({ ok: true });
    await esperarPrivada(page);
    const antes = await efectos(page);
    expect(antes).toMatchObject({ canvas: 1, compartido: 1, fotosViaje: 1, copia: 1 });
    expect(antes.identidad).toMatch(UUID);
    expect(antes.bases).toEqual(expect.arrayContaining([BASE_FOTOS, BASE_PROGRESO]));

    expect(await piloto(page, perfil)).toEqual({ ok: false, nombre: 'Error', mensaje: GUARDA });
    // Ni otro lienzo, ni otra «Todo», ni otra identidad o base; y un único escuchador del tema.
    expect(await efectos(page)).toEqual(antes);
    expect(await voltearTema(page)).toEqual({ antes: 'claro', despues: 'oscuro' });
  });

  test('A3 · perfil, origen o D inválidos no tocan nada; el perfil corregido arranca y conserva lo sembrado',
    async ({ page }) => {
      const invalidos: [string, unknown, string][] = [
        ['perfil vacío', {}, INVALIDO],
        ['otro origen', { ...perfil, origen: 'https://otro.example' }, OTRO_ORIGEN],
        ['D del plan real mayor que maxBytesPlan', { ...perfil, listadoCliente: { ...perfil.listadoCliente, maxBytesPlan: 4096 } },
          LISTADO],
      ];
      // Cada caso falla por SU motivo con las fábricas reales (en Node).
      expect(() => crearPerfilPiloto(invalidos[0][1])).toThrow(INVALIDO);
      expect(crearPerfilPiloto(invalidos[1][1]).origen).toBe('https://otro.example');
      expect(() => crearClienteListadoFotos({ plan: itinerario, origen, http: null,
        presupuesto: crearPerfilPiloto(invalidos[2][1]).respaldo.listado })).toThrow(LISTADO);

      await abrir(page);
      await page.evaluate((s) => window.fixtureArranque!.sembrar(s), SEMILLA);
      // Otra carga sobre lo sembrado, como al volver a abrir la app; lo sembrado pasa los guards reales.
      await abrir(page);
      expect(await page.evaluate(() => window.fixtureArranque!.comprobarSemilla()))
        .toEqual({ registros: [2, 1, 0, 1], nombre: SEMILLA.nombre, menosCero: true });
      await page.evaluate(() => window.fixtureArranque!.fijarBase());
      const sembradas = await bases(page);
      expect(sembradas).toEqual([BASE_FOTOS, BASE_PROGRESO].sort());

      for (const [caso, datos, mensaje] of invalidos) {
        expect(await piloto(page, datos), caso).toMatchObject({ ok: false, mensaje });
        // Nada personal tocado: estado crudo exacto, ninguna base nueva, sin lienzo ni lista.
        expect(await page.evaluate(() => window.fixtureArranque!.diferencias('todo')), caso).toEqual([]);
        expect(await bases(page), caso).toEqual(sembradas);
        expect(await efectos(page), caso).toMatchObject({ canvas: 0, contenido: 0, dias: 0 });
      }
      expect(api()).toEqual([]);

      // Corregido en la MISMA página: arranca con los controles privados (manuales) en «Todo».
      expect(await piloto(page, perfil)).toEqual({ ok: true });
      await esperarPrivada(page);
      // Misma identidad y legado; raíz y PhotoDB crudos exactos, tombstone y bytes del original incluidos. Abrir lee
      // en local (invariancia durable, no ausencia de IO).
      expect(await page.evaluate(() => window.fixtureArranque!.diferencias('semilla'))).toEqual([]);
      expect(await bases(page)).toEqual(expect.arrayContaining(sembradas));
      expect([...new Set(api().map((s) => `${s.metodo} ${s.ruta}`))]).toEqual(['GET /api/progreso']);
    });

  test('A4 · si el primer arranque falla a medias, el reintento se rechaza y no reabre la app', async ({ page }) => {
    await abrir(page);
    // Punto de corte del fixture, sin hooks de producción: main usa #saltar después del mapa, la identidad, los
    // escuchadores y el tema, y antes de pintar, del service worker y de abrir el progreso.
    const saltar = await page.evaluateHandle(() => {
      const a = document.getElementById('saltar')!;
      a.remove();
      return a;
    });
    const primera = await piloto(page, perfil);
    expect(primera).toMatchObject({ ok: false, nombre: 'TypeError' });
    expect(primera.mensaje).not.toBe(GUARDA);
    const antes = await efectos(page);
    expect(antes).toMatchObject({ canvas: 1, compartido: 0, contenido: 0, dias: 0 });
    expect(antes.identidad).toMatch(UUID);
    expect(antes.bases).not.toContain(BASE_PROGRESO);

    // Solo se repone el ancla del fixture; lo que ya hizo el primer intento se queda como está.
    await saltar.evaluate((a) => { document.body.prepend(a); });
    expect(await piloto(page, perfil)).toEqual({ ok: false, nombre: 'Error', mensaje: GUARDA });
    expect(await efectos(page)).toEqual(antes);
    expect(await voltearTema(page)).toEqual({ antes: 'claro', despues: 'oscuro' });
    expect(api()).toEqual([]);
  });

  test('A5 · un getter de la composición que vuelve a arrancar recibe la guarda; el arranque exterior sigue',
    async ({ page }) => {
      await abrir(page);
      expect(await page.evaluate(() => window.fixtureArranque!.reentrada()))
        .toEqual({ exterior: { ok: true }, anidada: { ok: false, nombre: 'Error', mensaje: GUARDA } });
      await expect(page.locator('#compartido .estado-compartido')).toHaveText(INCIERTO);
      // Una sola app, la publicada (null y null): sin controles privados.
      expect(await efectos(page)).toMatchObject({ canvas: 1, compartido: 1, fotosViaje: 0, copia: 0 });
      expect(await voltearTema(page)).toEqual({ antes: 'claro', despues: 'oscuro' });
    });
});
