// «Copia de este móvil» DESDE LA INTERFAZ. Dos partes:
// 1. «nativa local»: entrada virtual de Vite EXCLUSIVA del fixture (sin módulo semilla, alias, dependencias ni configuración
//    del proyecto) que compone la interfaz real de fotos y la de portabilidad con composición explícita, servida por un
//    HTTP loopback propio en memoria (la portabilidad no usa red ni proveedor). IndexedDB, File, Blob, selector de archivo
//    y descargas reales de Chromium; dos contextos aislados (A y B) para la transferencia.
// 2. «publicada»: la web compilada (vite preview, 4173) con portabilidad: null → ni sección, ni texto, ni base de historia.
// Sin temporales propios: la compilación es en memoria y las descargas las guarda Playwright en sus salidas. La «cuota» de P3
// es MODELADA; no prueba Safari, iOS, la cuota ni la entrega física del archivo en un móvil real.
import { test, expect, type BrowserContext, type Locator, type Page } from '@playwright/test';
import { createServer, type Server } from 'node:http';
import { fileURLToPath } from 'node:url';
import { build, type Plugin, type Rollup } from 'vite';
import { itinerario } from '../src/datos/itinerario';
import { exportarArchivoPortable, inspeccionarArchivoPortable } from '../src/portabilidad';
import type { RegistroLocal } from '../src/progreso-local';

// Presupuestos de operador del fixture (los de pruebas/portabilidad.e2e.ts): no son la capacidad de un móvil.
const LIMITES = { maxRegistros: 1000, maxBytesMetadatos: 1000000, maxBytesArchivo: 8000000, maxProfundidad: 64 };
const LIMITES_HISTORIA = { maxImportaciones: 100, maxObservaciones: 1000, maxProcedencias: 1000, maxBytesHistoria: 80000000 };
// Datos sintéticos: bytes de 5 B, no la foto de nadie. El nombre lleva NUL y una tilde descompuesta (NFD).
const FOTO = '12345678-1234-4123-8123-123456789abc';
const BORRADA = '22345678-1234-4123-8123-123456789abc';
const OPERACION = '32345678-1234-4123-8123-123456789abc';
const NOMBRE = '\0 é «calle».heic';
const BYTES = [0, 7, 255, 128, 1];
const LEGADO = '{"versión":"anterior"}';
const SEMILLA = { nombre: NOMBRE, bytes: BYTES, foto: FOTO, borrada: BORRADA, operacion: OPERACION, legado: LEGADO };
const NOMBRE_LARGO = 'copia-de-un-movil-con-un-nombre-de-archivo-muy-largo-y-sin-espacios-del-21-de-octubre.itinport';
const BASE_FOTOS = `itinerario-fotos:${encodeURIComponent(itinerario.id)}`;
const BASE_LEDGER = `itinerario-respaldo-fotos:${encodeURIComponent(itinerario.id)}`;
const BASE_HISTORIA = `itinerario-portabilidad:${encodeURIComponent(itinerario.id)}`;
const INTRO = 'Guarda en un archivo las fotos, las marcas y el registro de respaldos de este móvil, o importa el archivo de otro móvil.';
const DESCARGA_PEDIDA = 'Descarga pedida al navegador. La app no puede comprobar que el archivo se haya guardado.';
const SOLO_CONSULTA = 'Solo consulta: sus marcas, sus cambios enviados o rechazados y sus recibos de respaldo no se aplican a este '
  + 'móvil ni se envían, y no son un respaldo remoto ni un acuse.';
const RESUMEN_A = '1 foto · 1 borrada · 1 marca · 1 cambio en cola (1 enviado) · 1 registro de respaldo (1 con recibo) · '
  + 'marcas de la versión anterior';
const IMPORTADA = 'Copia archivada en este móvil. Fotos: 1 añadida · 1 borrada, no se recupera.';
const RECHAZADA = 'No se ha guardado nada: el archivo no es una copia válida de este viaje o no cabe en los límites de esta copia.';

interface FixtureCopia {
  readonly listo: true;
  pintar(): void;
  /** Otra vista (Mapa, Taxi, Ahora…): la sección se desmonta; lo que esté en curso sigue. */
  salir(): void;
  ocupar(valor: boolean): void;
  abrirFotos(): void;
  fase(): string;
  sembrar(datos: typeof SEMILLA): Promise<RegistroLocal>;
}
declare global { interface Window { fixtureCopia?: FixtureCopia } }
/** Testigo del fallo MODELADO de P7 (instalado antes de cargar la app; solo en su página). */
interface FalloHistoria { armado: boolean; fallos: number; completos: number; archivos: number }
declare global { interface Window { fixtureFalloHistoria?: FalloHistoria } }
interface RegistroNavegador {
  readonly formato: unknown; readonly viajeId: unknown; readonly trabajoId: string;
  readonly observaciones: unknown[]; readonly procedencias: unknown[]; readonly bytes: number[];
}

/** Archivo válido hecho en Node con la biblioteca (foto + tombstone + legado), para importarlo en un contexto limpio. */
async function archivoSintetico(): Promise<Buffer> {
  const destino = { tipo: 'parada' as const, viajeId: itinerario.id, paradaId: itinerario.dias[0].paradas[0].id };
  const a = await exportarArchivoPortable(itinerario, { viajeId: itinerario.id,
    fotos: { presente: true, tablas: {
      metadatos: [{ clave: FOTO, valor: { formato: 1, fotoId: FOTO, destino, nombre: NOMBRE, mimeDeclarado: 'image/heic',
        ultimaModificacion: -0, incorporada: -0, bytesOriginal: BYTES.length, miniatura: { tipo: 'pendiente' } } },
      { clave: BORRADA, valor: { formato: 1, tipo: 'borrada', fotoId: BORRADA } }],
      originales: [{ clave: FOTO, valor: new Blob([new Uint8Array(BYTES)], { type: 'image/heic' }) }], miniaturas: [] } },
    progreso: { presente: false, tablas: {} }, respaldos: { presente: false, tablas: {} },
    legado: { marcas: 'antiguas', 'marcas-hora': null, 'pendientes-hechos': null } }, LIMITES);
  return Buffer.from(await a.archivo.arrayBuffer());
}
const bases = (page: Page) => page.evaluate(async () => (await indexedDB.databases()).map((d) => d.name ?? '').sort());
/** Metadata y original de una foto en la PhotoDB ya existente del navegador (lectura directa; sin crear ni escribir nada). */
const fotoNavegador = (page: Page, fotoId: string) => page.evaluate(({ nombre, fotoId }) =>
  new Promise<{ metadatos: unknown; original: number[] | null } | null>((ok, ko) => {
    void indexedDB.databases().then((todas) => {
      if (!todas.some((b) => b.name === nombre)) { ok(null); return; }
      const r = indexedDB.open(nombre);
      r.onerror = () => ko(r.error);
      r.onsuccess = () => {
        const db = r.result; const tx = db.transaction(['metadatos', 'originales']);
        const metadatos = tx.objectStore('metadatos').get(fotoId); const original = tx.objectStore('originales').get(fotoId);
        tx.oncomplete = () => {
          db.close();
          const blob = original.result as Blob | undefined;
          void (blob ? blob.arrayBuffer().then((b) => Array.from(new Uint8Array(b))) : Promise.resolve(null))
            .then((bytes) => ok({ metadatos: metadatos.result ?? null, original: bytes }), ko);
        };
        tx.onabort = () => { db.close(); ko(tx.error); };
      };
    }, ko);
  }), { nombre: BASE_FOTOS, fotoId });
/** Zona táctil real: .mini se ve de 34 px y se toca con 48 gracias a su ::after (7 px arriba y abajo). */
async function comprobarObjetivos(zona: Locator) {
  const medidas = await zona.locator('button:visible, a:visible').evaluateAll((elementos) => elementos.map((e) => {
    const caja = e.getBoundingClientRect(); const extra = getComputedStyle(e, '::after');
    const crece = extra.content !== 'none' && extra.position === 'absolute' ? -2 * (parseFloat(extra.top) || 0) : 0;
    return { texto: e.textContent?.trim() ?? '', alto: caja.height + Math.max(0, crece) };
  }));
  expect(medidas.length).toBeGreaterThan(0);
  for (const m of medidas) expect(m.alto, m.texto).toBeGreaterThanOrEqual(44);
}
/** Descarga REAL del navegador tras un toque: bytes completos leídos del flujo de Playwright. */
async function descargar(page: Page, boton: Locator) {
  const espera = page.waitForEvent('download');
  await boton.click();
  const d = await espera;
  const trozos: Buffer[] = [];
  for await (const t of await d.createReadStream()) trozos.push(Buffer.from(t as Uint8Array));
  return { nombre: d.suggestedFilename(), bytes: Buffer.concat(trozos) };
}
/** Selector de archivo REAL abierto por el toque en «Importar una copia». */
async function elegirArchivo(page: Page, bytes: Buffer, nombre: string) {
  const selector = page.waitForEvent('filechooser');
  await page.locator('#copia-movil').getByRole('button', { name: 'Importar una copia' }).click();
  await (await selector).setFiles({ name: nombre, mimeType: 'application/octet-stream', buffer: bytes });
}

test.describe('nativa local', () => {
  let servidor: Server;
  let origen = '';
  let paginaFixture = '';
  const solicitudes: string[] = [];

  // Entrada virtual EXCLUSIVA del fixture: compone la interfaz real de fotos (respaldo: null) y la de portabilidad con
  // composición explícita (la web publicada pasa null), con la tipografía y los estilos reales de la app.
  const ENTRADA = 'virtual:copia-movil-fixture';
  const fuente = (relativa: string) => JSON.stringify(fileURLToPath(new URL(relativa, import.meta.url)));
  const CODIGO_ENTRADA = `
import '@fontsource-variable/archivo/wdth.css';
import ${fuente('../src/estilos.css')};
import { itinerario } from ${fuente('../src/datos/itinerario.ts')};
import { crearFotosUi } from ${fuente('../src/fotos-interfaz.ts')};
import { componerPortabilidad } from ${fuente('../src/portabilidad-interfaz.ts')};
import { abrirFotosLocal } from ${fuente('../src/fotos-local.ts')};
import { abrirProgresoLocal } from ${fuente('../src/progreso-local.ts')};
import { abrirRespaldoFotosLocal } from ${fuente('../src/fotos-respaldo-local.ts')};
const contenido = document.getElementById('contenido');
const aviso = document.getElementById('aviso-fixture');
const paradas = itinerario.dias.flatMap((d) => d.paradas);
const nombreDe = (d) => paradas.find((p) => p.id === d.paradaId)?.nombre ?? 'esta parada';
const anunciar = (texto) => { aviso.textContent = texto; };
const fotos = crearFotosUi({ plan: itinerario, contenido, nombreDe, anunciar, respaldo: null });
let ocupado = false;
const copia = componerPortabilidad({ limites: ${JSON.stringify(LIMITES)}, limitesHistoria: ${JSON.stringify(LIMITES_HISTORIA)} }, {
  plan: itinerario, nombreDe, anunciar, leerLegado: (campo) => localStorage.getItem(campo),
  puerto: () => fotos.controlador.puerto?.() ?? null, incorporar: (m) => fotos.controlador.incorporar?.(m),
  progresoOcupado: () => ocupado });
const destino = { tipo: 'parada', viajeId: itinerario.id, paradaId: paradas[0].id };
function pintar() {
  copia.desmontar(); fotos.desmontar();
  contenido.innerHTML = fotos.html(destino) + '<section class="seccion copia-movil" id="copia-movil" data-copia-movil></section>';
  copia.montar(contenido.querySelector('[data-copia-movil]'));
  fotos.pintarCuentas();
}
contenido.addEventListener('click', (e) => { if (!fotos.manejarClic(e.target)) copia.manejarClic(e.target); });
pintar();
window.fixtureCopia = {
  listo: true,
  pintar,
  salir() { copia.desmontar(); fotos.desmontar(); contenido.innerHTML = '<p id="mapa-fixture">Mapa</p>'; },
  ocupar(valor) { ocupado = valor; },
  abrirFotos() { fotos.preparar(); },
  fase: () => fotos.controlador.fase,
  // Móvil A con las bibliotecas reales: foto viva y tombstone, raíz v3 con un cambio enviado, respaldo con recibo y legado.
  async sembrar(d) {
    const meta = (fotoId, n) => ({ formato: 1, fotoId, destino, nombre: d.nombre, mimeDeclarado: 'image/heic',
      ultimaModificacion: -0, incorporada: -0, bytesOriginal: n, miniatura: { tipo: 'pendiente' } });
    const f = await abrirFotosLocal(itinerario);
    const captura = { metadatos: meta(d.foto, d.bytes.length), original: new Blob([new Uint8Array(d.bytes)], { type: 'image/heic' }) };
    await f.guardarOriginal(captura);
    await f.guardarOriginal({ metadatos: meta(d.borrada, 3), original: new Blob(['abc'], { type: 'image/heic' }) });
    await f.borrarLocal(d.borrada);
    const p = await abrirProgresoLocal(itinerario, { dispositivoId: 'movil-a' });
    await p.registrar({ id: 'op-a', dispositivoId: 'movil-a', tipo: 'parada', paradaId: paradas[0].id, marca: 'hecha', revision: 0 });
    await p.marcarEnviada('op-a');
    const l = await abrirRespaldoFotosLocal(itinerario, f);
    const e = await l.preparar(captura, d.operacion);
    await l.marcarEnviada({ fotoId: e.fotoId, operacionId: e.operacionId, original: e.original });
    await l.confirmarRecibo({ version: 1, tipo: 'acuse-respaldo', viajeId: itinerario.id, fotoId: e.fotoId,
      operacionId: e.operacionId, original: e.original, objetoOriginalDurable: true, metadatosDurables: true });
    localStorage.setItem('marcas', d.legado);
    const raiz = await p.leer();
    f.cerrar(); p.cerrar(); l.cerrar();
    return raiz;
  },
};
`;
  const entradaVirtual: Plugin = { name: 'entrada-copia-movil-fixture',
    resolveId: (id) => (id === ENTRADA ? `\0${ENTRADA}` : null),
    load: (id) => (id === `\0${ENTRADA}` ? CODIGO_ENTRADA : null) };
  const TIPOS: Record<string, string> = { js: 'text/javascript; charset=utf-8', css: 'text/css; charset=utf-8',
    png: 'image/png', svg: 'image/svg+xml', woff2: 'font/woff2', woff: 'font/woff' };

  /** Cada petición del navegador se anota; fuera del origen del fixture se corta. Se comprueba en afterEach. */
  async function vigilar(contexto: BrowserContext) {
    contexto.on('request', (r) => { solicitudes.push(r.url()); });
    await contexto.route('**/*', (r) => (new URL(r.request().url()).origin === origen ? r.continue() : r.abort()));
  }
  async function abrirFixture(page: Page) {
    await page.goto(origen + '/fixture-copia');
    await page.waitForFunction(() => window.fixtureCopia?.listo === true);
    // La tipografía real, no una de reserva: al menos una cara «Archivo Variable» declarada por @fontsource y CARGADA, y
    // el texto español disponible con ella (check() solo no basta: sin caras también devuelve true).
    const tipografia = await page.evaluate(async (texto) => {
      await document.fonts.ready;
      await document.fonts.load('16px "Archivo Variable"', texto);
      const caras: FontFace[] = [];
      document.fonts.forEach((cara) => { if (cara.family.replace(/^["']|["']$/g, '') === 'Archivo Variable') caras.push(cara); });
      return { declaradas: caras.length, cargadas: caras.filter((cara) => cara.status === 'loaded').length,
        disponible: document.fonts.check('16px "Archivo Variable"', texto) };
    }, 'Copia de este móvil · ¿Importar «copia.itinport»? Descargar copia (2,4 MB)');
    expect(tipografia.cargadas, `Archivo Variable: ${tipografia.cargadas} de ${tipografia.declaradas} caras cargadas`)
      .toBeGreaterThan(0);
    expect(tipografia.disponible).toBe(true);
  }

  test.beforeAll(async () => {
    // Timeout propio de preparación del fixture, con la API de hooks de Playwright.
    test.setTimeout(60000);
    // Compilación en memoria (write: false): nada se escribe en el repositorio ni en dist/.
    const resultado = await build({ configFile: false, logLevel: 'silent', plugins: [entradaVirtual],
      define: { __PLAN__: JSON.stringify('fixture-copia-movil') }, worker: { format: 'es' },
      build: { write: false, minify: false, target: 'es2022', rollupOptions: { preserveEntrySignatures: 'strict',
        input: { ui: ENTRADA }, output: { entryFileNames: '[name].js', chunkFileNames: 'fragmento-[hash].js',
          assetFileNames: '[name][extname]' } } } });
    const salida = (Array.isArray(resultado) ? resultado[0] : resultado) as Rollup.RollupOutput;
    const archivos = new Map(salida.output.map((a) => [a.fileName, {
      cuerpo: a.type === 'chunk' ? a.code : typeof a.source === 'string' ? a.source : new Uint8Array(a.source),
      tipo: TIPOS[a.fileName.split('.').pop() ?? ''] ?? 'application/octet-stream' }]));
    const css = salida.output.find((a) => a.type === 'asset' && a.fileName.endsWith('.css'))?.fileName;
    if (!css || !archivos.has('ui.js')) throw new Error('La entrada del fixture no produjo ui.js y su CSS');
    paginaFixture = `<!doctype html><html lang="es" data-tema="claro"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1"><title>Fixture de la copia de este móvil</title>
<link rel="stylesheet" href="/${css}"><style>#contenido{height:100dvh}</style></head>
<body><main id="contenido" class="papel"></main><p id="aviso-fixture" role="status"></p>
<script type="module" src="/ui.js"></script></body></html>`;
    servidor = createServer((req, res) => {
      const ruta = new URL(req.url!, 'http://local').pathname;
      res.setHeader('Cache-Control', 'no-store');
      if (ruta === '/fixture-copia') {
        res.setHeader('Content-Type', 'text/html; charset=utf-8'); res.end(paginaFixture); return;
      }
      const a = archivos.get(ruta.slice(1));
      if (!a) { res.statusCode = 404; res.end(); return; }
      res.setHeader('Content-Type', a.tipo); res.end(a.cuerpo);
    });
    await new Promise<void>((ok) => servidor.listen(0, '127.0.0.1', ok));
    const direccion = servidor.address();
    if (!direccion || typeof direccion === 'string') throw new Error('Sin puerto loopback propio');
    origen = `http://127.0.0.1:${direccion.port}`;
  });
  test.afterAll(async () => {
    if (!servidor) return;
    const cierre = new Promise<void>((ok, no) => servidor.close((e) => (e ? no(e) : ok())));
    servidor.closeAllConnections(); await cierre;
  });
  test.beforeEach(async ({ context }) => {
    solicitudes.length = 0;
    await vigilar(context);
  });
  test.afterEach(() => {
    // Observador real de peticiones (no un stub que dé 0): solo el origen del fixture y ninguna /api.
    const red = solicitudes.filter((u) => /^https?:/.test(u));
    expect(red.filter((u) => new URL(u).origin !== origen)).toEqual([]);
    expect(red.filter((u) => new URL(u).pathname.startsWith('/api/'))).toEqual([]);
  });

  test('P1 · A prepara y descarga su copia; B la importa tras confirmar, la archiva, añade su foto y la indexa; consulta, '
    + 'originales y recarga', async ({ page, browser }) => {
    await abrirFixture(page);
    const raiz = await page.evaluate((d) => window.fixtureCopia!.sembrar(d), SEMILLA);
    await page.evaluate(() => window.fixtureCopia!.abrirFotos());
    await expect(page.locator('.fotos-cuenta')).toHaveText(/·\s*1/);
    const seccion = page.locator('#copia-movil');
    await expect(seccion.locator('.estado-copia')).toHaveText(INTRO);
    // Pintar no abre ni lee nada de la copia: ninguna base de historia.
    expect(await bases(page)).toEqual([BASE_FOTOS, 'itinerario-progreso', BASE_LEDGER].sort());

    await seccion.getByRole('button', { name: 'Preparar copia' }).click();
    await expect(seccion.locator('.estado-copia')).toContainText(`· ${RESUMEN_A}. No incluye las copias importadas.`);
    // Preparar y descargar son dos toques: el foco pasa al botón que descarga.
    const boton = seccion.getByRole('button', { name: /^Descargar copia \(/ });
    await expect(boton).toBeFocused();
    const copiaA = await descargar(page, boton);
    expect(copiaA.nombre).toMatch(/^copia-itinerario-\d{4}-\d{2}-\d{2}\.itinport$/);
    await expect(seccion.locator('.estado-copia')).toHaveText(DESCARGA_PEDIDA);
    // Archivo completo: inspección con TODOS los CRC y bytes exactos del original (sin hash ni muestra).
    const leido = await inspeccionarArchivoPortable(itinerario, new Blob([new Uint8Array(copiaA.bytes)]), LIMITES);
    const c = leido.manifiesto.captura;
    expect(c.fotos.tablas.metadatos.map((r) => r.clave)).toEqual([FOTO, BORRADA]);
    expect((c.fotos.tablas.metadatos[0].valor as { nombre: string }).nombre).toBe(NOMBRE);
    const s = leido.manifiesto.segmentos.findIndex((x) => x.tabla === 'originales' && x.clave === FOTO);
    expect([...new Uint8Array(await leido.leerSegmento(s).arrayBuffer())]).toEqual(BYTES);
    expect(c.progreso.tablas.viajes).toEqual([{ clave: itinerario.id, valor: raiz }]);
    expect(c.respaldos.tablas.respaldos[0].valor).toMatchObject({ fase: 'respaldada', enviada: true, recibo: { tipo: 'acuse-respaldo' } });
    expect(c.legado).toEqual({ marcas: LEGADO, 'marcas-hora': null, 'pendientes-hechos': null });
    // Preparar y descargar solo leen: A sigue sin base de historia.
    expect(await bases(page)).toEqual([BASE_FOTOS, 'itinerario-progreso', BASE_LEDGER].sort());

    const contextoB = await browser.newContext();
    await vigilar(contextoB);
    try {
      const b = await contextoB.newPage();
      await abrirFixture(b);
      await b.evaluate(() => window.fixtureCopia!.abrirFotos());
      await expect.poll(() => b.evaluate(() => window.fixtureCopia!.fase())).toBe('lista');
      const sb = b.locator('#copia-movil');
      await elegirArchivo(b, copiaA.bytes, 'copia.itinport');
      const confirmar = sb.locator('.confirmar-copia');
      await expect(confirmar).toBeVisible();
      await expect(confirmar.locator('.confirmar-copia-texto')).toContainText('¿Importar «copia.itinport»');
      await expect(confirmar.locator('.confirmar-copia-texto')).toContainText('ocupa otros');
      await expect(confirmar.getByRole('button', { name: 'Cancelar' })).toBeFocused();
      // Elegir no lee ni guarda: todavía no hay base de historia.
      expect(await bases(b)).toEqual([BASE_FOTOS]);
      await confirmar.getByRole('button', { name: /^Importar \(/ }).click();
      await expect(sb.locator('.estado-copia')).toHaveText(IMPORTADA);
      await expect(b.locator('.fotos-cuenta')).toHaveText(/·\s*1/);
      const local = await fotoNavegador(b, FOTO);
      expect(local?.original).toEqual(BYTES);
      expect(local?.metadatos).toMatchObject({ fotoId: FOTO, nombre: NOMBRE, bytesOriginal: BYTES.length });
      expect((await fotoNavegador(b, BORRADA))?.metadatos).toEqual({ formato: 1, tipo: 'borrada', fotoId: BORRADA });
      // Progreso, registro de respaldos y legado importados quedan en cuarentena: ni bases ni claves nuevas en B.
      expect(await bases(b)).toEqual([BASE_FOTOS, BASE_HISTORIA].sort());
      expect(await b.evaluate(() => localStorage.getItem('marcas'))).toBeNull();

      await sb.getByRole('button', { name: 'Ver copias importadas' }).click();
      await expect(sb.locator('.estado-historia')).toHaveText('Una copia importada. No tienen fecha: el orden no es el de importación.');
      const fila = sb.locator('.filas-historia > li');
      await expect(fila).toHaveCount(1);
      await expect(fila).toContainText('Copia importada 1');
      await expect(fila).toContainText(RESUMEN_A);
      await fila.getByRole('button', { name: 'Ver contenido' }).click();
      const detalle = fila.locator('.copia-detalle');
      await expect(detalle).toContainText(SOLO_CONSULTA);
      const original = await descargar(b, detalle.getByRole('button', { name: /^Descargar el original de/ }));
      expect([...original.bytes]).toEqual(BYTES);
      expect(original.nombre).not.toContain('\0');
      expect(original.nombre).toMatch(/\.heic$/);
      await detalle.getByRole('button', { name: 'Preparar el archivo completo' }).click();
      const completo = await descargar(b, detalle.getByRole('button', { name: /^Descargar el archivo completo/ }));
      expect(completo.nombre).toBe('copia-importada-1.itinport');
      expect(completo.bytes.equals(copiaA.bytes)).toBe(true);

      // Al recargar, la historia y la foto siguen; nada se lee solo hasta el toque.
      await abrirFixture(b);
      await expect(b.locator('#copia-movil .filas-historia > li')).toHaveCount(0);
      await b.locator('#copia-movil').getByRole('button', { name: 'Ver copias importadas' }).click();
      await expect(b.locator('#copia-movil .filas-historia > li')).toHaveCount(1);
      expect((await fotoNavegador(b, FOTO))?.original).toEqual(BYTES);
    } finally {
      await contextoB.close();
    }
  });

  test('P2 · archivo truncado, con un byte cambiado o con BOM: nada se archiva ni se añade', async ({ page }) => {
    const valido = await archivoSintetico();
    await abrirFixture(page);
    const seccion = page.locator('#copia-movil');
    const casos: [string, Buffer][] = [
      ['truncado.itinport', valido.subarray(0, -1)],
      ['cambiado.itinport', Buffer.concat([valido.subarray(0, -1), Buffer.from([valido[valido.length - 1] ^ 1])])],
      ['bom.itinport', Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), valido])],
    ];
    for (const [nombre, bytes] of casos) {
      await elegirArchivo(page, bytes, nombre);
      await seccion.locator('.confirmar-copia').getByRole('button', { name: /^Importar \(/ }).click();
      // Hasta que termina, «Importar una copia» está apagado: así se espera a ESTE resultado.
      await expect(seccion.getByRole('button', { name: 'Importar una copia' })).not.toHaveAttribute('aria-disabled', 'true');
      await expect(seccion.locator('.estado-copia')).toHaveText(RECHAZADA);
    }
    expect(await bases(page)).toEqual([]);
  });

  test('P3 · cuota MODELADA al añadir el original: la copia queda archivada y «Reintentar las fotos» la completa sin otra copia',
    async ({ page }) => {
      const archivo = await archivoSintetico();
      await abrirFixture(page);
      await page.evaluate(() => window.fixtureCopia!.abrirFotos());
      await expect.poll(() => page.evaluate(() => window.fixtureCopia!.fase())).toBe('lista');
      // Modelo de «sin espacio» al escribir el original (una vez); no certifica la cuota de un móvil real.
      await page.evaluate(() => {
        const add = IDBObjectStore.prototype.add; let fallar = true;
        IDBObjectStore.prototype.add = function (this: IDBObjectStore, ...args: Parameters<typeof add>) {
          if (fallar && this.name === 'originales') { fallar = false; throw new DOMException('Cuota modelada', 'QuotaExceededError'); }
          return add.apply(this, args);
        };
      });
      const seccion = page.locator('#copia-movil');
      await elegirArchivo(page, archivo, 'copia.itinport');
      await seccion.locator('.confirmar-copia').getByRole('button', { name: /^Importar \(/ }).click();
      await expect(seccion.locator('.estado-copia')).toHaveText('Copia archivada en este móvil. '
        + 'Sus fotos no se añadieron (puede faltar espacio en este móvil). Puedes reintentarlo.');
      expect(await fotoNavegador(page, FOTO)).toEqual({ metadatos: null, original: null });
      await seccion.getByRole('button', { name: 'Reintentar las fotos' }).click();
      await expect(seccion.locator('.estado-copia')).toHaveText('Fotos: 1 añadida · 1 borrada, no se recupera.');
      await expect(seccion.getByRole('button', { name: 'Reintentar las fotos' })).toHaveCount(0);
      await expect(page.locator('.fotos-cuenta')).toHaveText(/·\s*1/);
      expect((await fotoNavegador(page, FOTO))?.original).toEqual(BYTES);
      await seccion.getByRole('button', { name: 'Ver copias importadas' }).click();
      const fila = seccion.locator('.filas-historia > li');
      await expect(fila).toHaveCount(1);
      await expect(fila).toContainText('Fotos: 1 añadida · 1 borrada, no se recupera.');
    });

  test('P4 · con una marca guardándose no empieza nada; salir de «Todo» no corta la importación y el resultado llega al aviso '
    + 'general', async ({ page }) => {
    const archivo = await archivoSintetico();
    await abrirFixture(page);
    const seccion = page.locator('#copia-movil');
    await page.evaluate(() => window.fixtureCopia!.ocupar(true));
    await seccion.getByRole('button', { name: 'Preparar copia' }).click();
    await expect(seccion.locator('.estado-copia')).toHaveText('Se está guardando una marca en este móvil; prueba en un momento.');
    expect(await bases(page)).toEqual([]);
    await page.evaluate(() => window.fixtureCopia!.ocupar(false));
    await elegirArchivo(page, archivo, 'copia.itinport');
    await expect(seccion.locator('.confirmar-copia')).toBeVisible();
    // Confirmar y, en el mismo instante, ir a otra vista: la acción sigue y no toca la vista nueva.
    await page.evaluate(() => {
      document.querySelector<HTMLElement>('#copia-movil [data-copia="confirmar"]')!.click();
      window.fixtureCopia!.salir();
    });
    // Las fotos de este móvil no estaban abiertas: no se afirma que ya se vean.
    const resultado = `${IMPORTADA} Puede que las fotos añadidas no se vean en sus fichas hasta volver a abrir la app.`;
    await expect(page.locator('#aviso-fixture')).toHaveText(resultado);
    await expect(page.locator('#mapa-fixture')).toHaveText('Mapa');
    expect(await bases(page)).toEqual([BASE_FOTOS, BASE_HISTORIA].sort());
    // De vuelta en «Todo», la sección dice lo mismo, sin repetir nada.
    await page.evaluate(() => window.fixtureCopia!.pintar());
    await expect(seccion.locator('.estado-copia')).toHaveText(resultado);
  });

  // Matriz propia de una ronda: móvil en vertical (390×844 y 360×640) y en horizontal (844×390), de día y de noche
  // (:root[data-tema='oscuro'] del CSS real). Las capturas son para revisarlas a ojo (salidas propias de Playwright en
  // testInfo.outputPath, con prefijo «portabilidad-»); no certifican contraste AA.
  for (const [ancho, alto] of [[390, 844], [360, 640], [844, 390]] as const) {
    for (const tema of ['claro', 'oscuro'] as const) {
      test(`P5 · ${ancho}×${alto} ${tema}: 44 px, foco con teclado, sin desbordes ni saltos, aviso privado en la copia y en `
        + 'la consulta', async ({ page }, testInfo) => {
        await page.setViewportSize({ width: ancho, height: alto });
        await abrirFixture(page);
        await page.evaluate((t) => { document.documentElement.dataset.tema = t; }, tema);
        // El papel del tema aplicado por el CSS real: blanco de día, #121820 de noche.
        expect(await page.evaluate(() => getComputedStyle(document.body).backgroundColor))
          .toBe(tema === 'oscuro' ? 'rgb(18, 24, 32)' : 'rgb(255, 255, 255)');
        await page.evaluate((d) => window.fixtureCopia!.sembrar(d), SEMILLA);
        await page.evaluate(() => window.fixtureCopia!.abrirFotos());
        await expect(page.locator('.fotos-cuenta')).toHaveText(/·\s*1/);
        const seccion = page.locator('#copia-movil');
        await seccion.getByRole('button', { name: 'Preparar copia' }).focus();
        await page.keyboard.press('Enter');
        await expect(seccion.locator('.estado-copia')).toContainText(RESUMEN_A);
        await expect(seccion.getByRole('button', { name: /^Descargar copia \(/ })).toBeFocused();
        await elegirArchivo(page, await archivoSintetico(), NOMBRE_LARGO);
        await expect(seccion.locator('.confirmar-copia').getByRole('button', { name: 'Cancelar' })).toBeFocused();
        await expect(seccion.locator('.cifras')).toContainText('trátalo como privado');
        await comprobarObjetivos(seccion);
        expect(await seccion.evaluate((s) => s.scrollWidth <= s.clientWidth)).toBe(true);
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
        await seccion.locator('.confirmar-copia').scrollIntoViewIfNeeded();
        await page.screenshot({ path: testInfo.outputPath('portabilidad-copia.png') });

        await seccion.locator('.confirmar-copia').getByRole('button', { name: /^Importar \(/ }).click();
        await expect(seccion.locator('.estado-copia'))
          .toHaveText('Copia archivada en este móvil. Fotos: 1 ya estaba · 1 borrada, no se recupera.');
        await seccion.getByRole('button', { name: 'Ver copias importadas' }).click();
        const fila = seccion.locator('.filas-historia > li');
        await expect(fila).toHaveCount(1);
        const ver = fila.getByRole('button', { name: 'Ver contenido' });
        await ver.scrollIntoViewIfNeeded();
        await ver.focus();
        const lista = page.locator('#contenido');
        const antes = await lista.evaluate((e) => e.scrollTop);
        await page.keyboard.press('Enter');
        await expect(fila.locator('.copia-detalle')).toContainText(SOLO_CONSULTA);
        await expect(fila.getByRole('button', { name: 'Ocultar contenido' })).toBeFocused();
        expect.soft(Math.abs(await lista.evaluate((e) => e.scrollTop) - antes), 'la lista no salta al abrir el contenido')
          .toBeLessThanOrEqual(1);
        await comprobarObjetivos(seccion);
        expect(await seccion.evaluate((s) => s.scrollWidth <= s.clientWidth)).toBe(true);
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
        await fila.locator('.copia-detalle').scrollIntoViewIfNeeded();
        await page.screenshot({ path: testInfo.outputPath('portabilidad-historia.png') });
      });
    }
  }

  /** Registros de la historia del navegador, leídos en una TX readonly sin crear la base ni escribir nada. */
  const historiaNavegador = (page: Page) => page.evaluate((nombre) => new Promise<RegistroNavegador[]>((ok, ko) => {
    void indexedDB.databases().then((todas) => {
      if (!todas.some((b) => b.name === nombre)) { ok([]); return; }
      const r = indexedDB.open(nombre);
      r.onerror = () => ko(r.error);
      r.onsuccess = () => {
        const db = r.result; const tx = db.transaction('importaciones'); const todo = tx.objectStore('importaciones').getAll();
        tx.oncomplete = () => {
          db.close();
          const valores = todo.result as { formato: unknown; viajeId: unknown; trabajoId: string; archivo: Blob;
            observaciones: unknown[]; procedencias: unknown[] }[];
          void Promise.all(valores.map(async (v) => ({ formato: v.formato, viajeId: v.viajeId, trabajoId: v.trabajoId,
            observaciones: v.observaciones, procedencias: v.procedencias,
            bytes: Array.from(new Uint8Array(await v.archivo.arrayBuffer())) }))).then(ok, ko);
        };
        tx.onabort = () => { db.close(); ko(tx.error); };
      };
    }, ko);
  }), BASE_HISTORIA);

  test('P7 · si falla la lectura de la historia JUSTO después de archivar, el mensaje no niega la copia guardada; la lista '
    + 'vieja se cierra y «Reintentar las fotos» la completa sin otra copia', async ({ page }) => {
    const archivo = await archivoSintetico();
    // Fallo MODELADO (no cuota ni móvil), instalado antes de cargar la app porque las bibliotecas fijan open al crearse:
    // se arma solo con el oncomplete de la transacción que añade el archivo a la historia, y la PRIMERA apertura
    // posterior de esa base falla una vez. El testigo de complete se registra al CREAR la transacción, antes del
    // oncomplete de la biblioteca: el navegador vacía las microtareas entre listeners y, si fuera después, la
    // continuación ya habría abierto la historia sin fallo.
    await page.addInitScript((nombre) => {
      const estado = { armado: false, fallos: 0, completos: 0, archivos: 0 };
      window.fixtureFalloHistoria = estado;
      const conArchivo = new WeakSet<IDBTransaction>();
      const open = IDBFactory.prototype.open;
      IDBFactory.prototype.open = function (this: IDBFactory, ...args: Parameters<typeof open>) {
        if (estado.armado && args[0] === nombre) {
          estado.armado = false; estado.fallos++;
          throw new DOMException('Fallo modelado de apertura', 'AbortError');
        }
        return open.apply(this, args);
      };
      const transaction = IDBDatabase.prototype.transaction;
      IDBDatabase.prototype.transaction = function (this: IDBDatabase, ...args: Parameters<typeof transaction>) {
        const tx = transaction.apply(this, args);
        if (this.name === nombre && args[1] === 'readwrite') {
          tx.addEventListener('complete', () => { if (conArchivo.has(tx)) { estado.completos++; estado.armado = true; } });
        }
        return tx;
      };
      const add = IDBObjectStore.prototype.add;
      IDBObjectStore.prototype.add = function (this: IDBObjectStore, ...args: Parameters<typeof add>) {
        if (this.name === 'importaciones' && this.transaction.db.name === nombre) {
          estado.archivos++; conArchivo.add(this.transaction);
        }
        return add.apply(this, args);
      };
    }, BASE_HISTORIA);
    await abrirFixture(page);
    await page.evaluate(() => window.fixtureCopia!.abrirFotos());
    await expect.poll(() => page.evaluate(() => window.fixtureCopia!.fase())).toBe('lista');
    const seccion = page.locator('#copia-movil');
    const testigo = () => page.evaluate(() => ({ ...window.fixtureFalloHistoria! }));
    // Al empezar, la historia leída a mano está vacía: ninguna copia archivada.
    await seccion.getByRole('button', { name: 'Ver copias importadas' }).click();
    await expect(seccion.locator('.estado-historia')).toHaveText('No hay copias importadas en este móvil.');
    expect(await historiaNavegador(page)).toEqual([]);
    expect(await testigo()).toEqual({ armado: false, fallos: 0, completos: 0, archivos: 0 });

    await elegirArchivo(page, archivo, 'copia.itinport');
    await seccion.locator('.confirmar-copia').getByRole('button', { name: /^Importar \(/ }).click();
    await expect(seccion.getByRole('button', { name: 'Importar una copia' })).not.toHaveAttribute('aria-disabled', 'true');
    // Testigo causal ANTES del mensaje: un archivo añadido, su oncomplete, un único fallo después y ninguna restauración.
    expect(await testigo()).toEqual({ armado: false, fallos: 1, completos: 1, archivos: 1 });
    const registros = await historiaNavegador(page);
    expect(registros).toHaveLength(1);
    expect(registros[0]).toMatchObject({ formato: 1, viajeId: itinerario.id, observaciones: [], procedencias: [] });
    expect(Buffer.from(registros[0].bytes).equals(archivo)).toBe(true);
    const leido = await inspeccionarArchivoPortable(itinerario, new Blob([new Uint8Array(registros[0].bytes)]), LIMITES);
    expect(leido.manifiesto.captura.fotos.tablas.metadatos.map((r) => r.clave)).toEqual([FOTO, BORRADA]);
    expect([...new Uint8Array(await leido.leerSegmento(0).arrayBuffer())]).toEqual(BYTES);
    expect(await fotoNavegador(page, FOTO)).toEqual({ metadatos: null, original: null });
    expect(await fotoNavegador(page, BORRADA)).toEqual({ metadatos: null, original: null });
    expect(await page.evaluate(() => localStorage.getItem('marcas'))).toBeNull();

    // RED esperado: la copia está archivada y hoy la línea de estado dice «No se ha guardado nada…».
    await expect(seccion.locator('.estado-copia')).toHaveText('Copia archivada en este móvil. Sus fotos aún no se han añadido.');
    // La lista leída antes (vacía) ya no vale y no se sigue mostrando; volver a leerla es un toque.
    await expect(seccion.locator('.estado-historia')).not.toHaveText('No hay copias importadas en este móvil.');
    await seccion.getByRole('button', { name: 'Ver copias importadas' }).click();
    await expect(seccion.locator('.filas-historia > li')).toHaveCount(1);
    // Un solo gesto añade sus fotos sobre la MISMA copia, sin archivar otra.
    await seccion.locator('.acciones-copia').getByRole('button', { name: 'Reintentar las fotos' }).click();
    await expect(seccion.locator('.estado-copia')).toHaveText('Fotos: 1 añadida · 1 borrada, no se recupera.');
    await expect(page.locator('.fotos-cuenta')).toHaveText(/·\s*1/);
    expect((await fotoNavegador(page, FOTO))?.original).toEqual(BYTES);
    expect((await fotoNavegador(page, BORRADA))?.metadatos).toEqual({ formato: 1, tipo: 'borrada', fotoId: BORRADA });
    const despues = await historiaNavegador(page);
    expect(despues.map((r) => r.trabajoId)).toEqual([registros[0].trabajoId]);
    expect(despues[0].observaciones).toHaveLength(1);
    expect((await testigo()).archivos).toBe(1);
  });
});

test.describe('publicada (portabilidad: null)', () => {
  const opcionesMovil = { baseURL: 'http://localhost:4173', locale: 'es-ES', viewport: { width: 390, height: 844 },
    deviceScaleFactor: 2, isMobile: true, hasTouch: true, serviceWorkers: 'block' as const };

  test('P6 · la web publicada no muestra, lee ni crea nada de la copia', async ({ browser }) => {
    const contexto = await browser.newContext(opcionesMovil);
    await contexto.route(/^https?:\/\/(?!localhost)/, (r) => r.abort());
    await contexto.route((url) => url.pathname === '/api/progreso', (r) => r.abort());
    // Como en fotos.e2e.ts: este móvil ya marca, así que no hay pregunta inicial delante de la lista.
    await contexto.addInitScript(() => { if (localStorage.getItem('marcador') === null) localStorage.setItem('marcador', 'true'); });
    const page = await contexto.newPage();
    const errores: string[] = [];
    page.on('pageerror', (e) => errores.push(e.message));
    try {
      await page.goto('/');
      await expect(page.locator('#contenido')).not.toBeEmpty();
      await page.locator('#dias [data-dia="todo"]').click();
      // «Todo» pintado (sus pendientes) y, en la publicada, sin «Compartido»: ni cliente de progreso ni red.
      await expect(page.locator('#pendientes')).toBeVisible();
      await expect(page.locator('#compartido')).toHaveCount(0);
      await expect(page.locator('#copia-movil')).toHaveCount(0);
      await expect(page.getByText('Copia de este móvil')).toHaveCount(0);
      const nombres = await page.evaluate(async () => (await indexedDB.databases()).map((x) => x.name ?? ''));
      expect(nombres.filter((n) => n.startsWith('itinerario-portabilidad:'))).toEqual([]);
      expect(errores).toEqual([]);
    } finally {
      await contexto.close();
    }
  });
});
