// Fotos de este móvil cuyo destino ya no está en el plan (identidades retiradas), en la web compilada SIN composición
// (la publicada): siguen a la vista en «Todo» → «Sitios que ya no están en el plan», con su nombre de entonces, su
// visor y su original, sin captura nueva y sin ninguna petición /api/ (ni al abrir, ni al marcar, ni al reconectar).
// Datos SINTÉTICOS sembrados en la IndexedDB que crea la propia app; no prueba Safari ni móviles reales.
import { type Browser, type Page, type TestInfo, expect, test } from '@playwright/test';
import { itinerario } from '../src/datos/itinerario';

const HORA = '2026-10-22T13:30:00+08:00';
const BASE_FOTOS = `itinerario-fotos:${encodeURIComponent(itinerario.id)}`;
// Top Banana fue parada el miércoles 21 y hoy es un sitio de dentro de la cena en Siji Minfu: dos tuplas distintas.
const TOP_BANANA = '731c8fe4a629bd50';
const SIJI = 'ebd3a84f0109b344';
const JOY_CITY = '6b1ad38f925e704c';
const SIHANG = '4c72f1a5eb306d98';
const NOTA_RETIRADA = 'Este sitio ya no está en el plan: sus fotos siguen guardadas en este móvil, pero no se pueden añadir nuevas.';

type Destino = { tipo: 'parada'; viajeId: string; paradaId: string }
  | { tipo: 'subparada'; viajeId: string; paradaId: string; subparadaId: string };
const enParada = (paradaId: string): Destino => ({ tipo: 'parada', viajeId: itinerario.id, paradaId });
const enSitio = (paradaId: string, subparadaId: string): Destino =>
  ({ tipo: 'subparada', viajeId: itinerario.id, paradaId, subparadaId });
const SEMBRADAS: { fotoId: string; nombre: string; destino: Destino }[] = [
  { fotoId: '00000000-0000-4000-8000-0000000000a1', nombre: 'top-banana-antigua.png', destino: enParada(TOP_BANANA) },
  { fotoId: '00000000-0000-4000-8000-0000000000a2', nombre: 'sihang.png', destino: enSitio(JOY_CITY, SIHANG) },
  { fotoId: '00000000-0000-4000-8000-0000000000a3', nombre: 'top-banana-hoy.png', destino: enSitio(SIJI, TOP_BANANA) },
];

/** Siembra en CRUDO, en la base que ya creó la app (sus cuatro tablas, sin tocar el esquema), un PNG real por foto. */
async function sembrar(page: Page): Promise<number[][]> {
  await expect.poll(() => page.evaluate(async (nombre) => (await indexedDB.databases()).some((b) => b.name === nombre),
    BASE_FOTOS)).toBe(true);
  return page.evaluate(async ({ nombre, fotos }) => {
    const bytes: number[][] = [];
    const registros: { id: string; metadatos: unknown; original: Blob }[] = [];
    for (const [i, f] of fotos.entries()) {
      const lienzo = new OffscreenCanvas(48 + i * 8, 36);
      const ctx = lienzo.getContext('2d')!;
      ctx.fillStyle = ['#2453d1', '#1e7f3e', '#c8327e'][i]; ctx.fillRect(0, 0, lienzo.width, lienzo.height);
      const original = await lienzo.convertToBlob({ type: 'image/png' });
      bytes.push([...new Uint8Array(await original.arrayBuffer())]);
      registros.push({ id: f.fotoId, original, metadatos: { formato: 1, fotoId: f.fotoId, destino: f.destino, nombre: f.nombre,
        mimeDeclarado: 'image/png', ultimaModificacion: 1760000000000 + i, incorporada: 1760000000000 + i,
        bytesOriginal: original.size, miniatura: { tipo: 'pendiente' } } });
    }
    await new Promise<void>((ok, ko) => {
      const s = indexedDB.open(nombre);
      s.onerror = () => ko(s.error);
      s.onsuccess = () => {
        const db = s.result;
        const tx = db.transaction(['metadatos', 'originales'], 'readwrite');
        for (const r of registros) {
          tx.objectStore('metadatos').put(r.metadatos, r.id);
          tx.objectStore('originales').put(r.original, r.id);
        }
        tx.oncomplete = () => { db.close(); ok(); };
        tx.onabort = () => { db.close(); ko(tx.error); };
      };
    });
    return bytes;
  }, { nombre: BASE_FOTOS, fotos: SEMBRADAS });
}

async function verTodo(page: Page) {
  await page.locator('#dias [data-dia="todo"]').click();
  await expect(page.locator('#pendientes')).toBeVisible();
}
/** Hoja arriba del todo con el asa (como el viajero): solo entonces la lista se desplaza y se toca entera. */
async function hojaAlta(page: Page) {
  const asa = page.locator('#asa');
  for (let i = 0; i < 2 && (await asa.getAttribute('aria-expanded')) !== 'true'; i++) await asa.click();
  await expect(asa).toHaveAttribute('aria-expanded', 'true');
}
/** Zona al dedo de un botón (píxeles que, por su centro, lo devuelven al tocar), con la hoja ya asentada. */
const zonaAlDedo = (b: import('@playwright/test').Locator) => b.evaluate((e) => {
  e.scrollIntoView({ block: 'center' });
  const r = e.getBoundingClientRect();
  const toca = (x: number, y: number) => document.elementFromPoint(x, y)?.closest('button') === e;
  let alAlto = 0; let alAncho = 0;
  for (let y = Math.floor(r.top) - 20; y < r.bottom + 20; y++) if (toca(r.left + r.width / 2, y + 0.5)) alAlto++;
  for (let x = Math.floor(r.left) - 20; x < r.right + 20; x++) if (toca(x + 0.5, r.top + r.height / 2)) alAncho++;
  return { alAlto, alAncho };
});

async function movil(browser: Browser, ancho: number, alto: number, tema: 'light' | 'dark') {
  const contexto = await browser.newContext({ baseURL: 'http://localhost:4173', locale: 'es-ES',
    viewport: { width: ancho, height: alto }, deviceScaleFactor: 2, isMobile: true, hasTouch: true,
    serviceWorkers: 'block', colorScheme: tema, acceptDownloads: true });
  const peticiones: string[] = [];
  contexto.on('request', (r) => { peticiones.push(new URL(r.url()).pathname); });
  await contexto.route(/^https?:\/\/(?!localhost)/, (r) => r.abort());
  await contexto.addInitScript(() => { if (localStorage.getItem('marcador') === null) localStorage.setItem('marcador', 'true'); });
  const page = await contexto.newPage();
  const errores: string[] = [];
  page.on('pageerror', (e) => errores.push(e.message));
  await page.clock.setFixedTime(new Date(HORA));
  await page.goto('/');
  await expect(page.locator('#contenido')).not.toBeEmpty();
  return { contexto, page, peticiones, errores };
}

async function captura(page: Page, info: TestInfo, nombre: string) {
  await page.screenshot({ path: info.outputPath(`${nombre}.png`), fullPage: false });
}

test.describe('fotos de sitios que ya no están en el plan (web publicada)', () => {
  for (const [ancho, alto, tema] of [[390, 844, 'light'], [360, 640, 'dark']] as const) {
    test(`se ven, se abren y se descargan sin captura ni red: ${ancho}×${alto} ${tema === 'light' ? 'de día' : 'de noche'}`,
      async ({ browser }, info) => {
        const { contexto, page, peticiones, errores } = await movil(browser, ancho, alto, tema);
        try {
          // Antes: sin fotos de sitios retirados la sección no existe a la vista (ni ocupa sitio).
          await verTodo(page);
          await expect(page.locator('#fotos-retiradas')).toBeHidden();
          await expect(page.locator('#compartido')).toHaveCount(0);
          await captura(page, info, `antes-${ancho}x${alto}-${tema}`);

          const bytes = await sembrar(page);
          await page.reload();
          await expect(page.locator('#contenido')).not.toBeEmpty();
          await verTodo(page);
          const seccion = page.locator('#fotos-retiradas');
          await expect(seccion).toBeVisible();
          await expect(seccion.locator('h3')).toHaveText('Sitios que ya no están en el plan');
          // Una fila por tupla retirada, con su nombre de entonces; la foto del sitio ACTUAL de Top Banana no está aquí.
          await expect(seccion.locator('.retirada-nombre')).toHaveText(['Cena en Top Banana Market', 'Sihang Warehouse']);
          await expect(seccion.locator('[data-fotos-destino]')).toHaveCount(2);
          await expect(seccion.locator(`[data-fotos-destino="p:${TOP_BANANA}"]`)).toHaveCount(1);
          await expect(seccion.locator(`[data-fotos-destino="s:${JOY_CITY}:${SIHANG}"]`)).toHaveCount(1);
          await expect(seccion.locator(`[data-fotos-destino="s:${SIJI}:${TOP_BANANA}"]`)).toHaveCount(0);

          const bloque = seccion.locator(`[data-fotos-destino="p:${TOP_BANANA}"]`);
          const alternar = bloque.locator('[data-fotos-alternar]');
          await expect(alternar).toHaveText(/Fotos · 1/);
          // 34 px a la vista y 44 px al dedo (DESIGN): la zona que de verdad recibe el toque, con la hoja arriba y
          // asentada (el muelle tarda unos 300 ms), sin quedar bajo las píldoras del pie.
          await hojaAlta(page);
          await expect.poll(async () => Math.min(...Object.values(await zonaAlDedo(alternar))), { timeout: 5000 })
            .toBeGreaterThanOrEqual(44);
          await alternar.scrollIntoViewIfNeeded();
          await alternar.click();
          await expect(alternar).toHaveAttribute('aria-expanded', 'true');
          await expect(bloque.locator('[data-foto-id]')).toHaveCount(1);
          // Sin captura en un sitio retirado: ni «Tomar foto» ni «Elegir de la galería» a la vista.
          await expect(bloque.locator('[data-fotos-camara]')).toBeHidden();
          await expect(bloque.locator('[data-fotos-anadir]')).toBeHidden();
          await expect(bloque.locator('.fotos-nota')).toHaveText(NOTA_RETIRADA);
          await expect(bloque.locator('[data-foto-id] img')).toHaveCount(1);
          await captura(page, info, `despues-${ancho}x${alto}-${tema}`);

          // Foco visible con teclado en el botón «Fotos» del sitio retirado.
          await alternar.focus();
          await page.keyboard.press('Shift+Tab');
          await page.keyboard.press('Tab');
          await expect(alternar).toBeFocused();
          const contorno = await alternar.evaluate((b) => parseFloat(getComputedStyle(b).outlineWidth));
          expect(contorno).toBeGreaterThanOrEqual(2);

          // Visor y original de siempre: los bytes exactos que se guardaron.
          await bloque.locator('[data-foto-id]').click();
          const visor = page.locator('#visor-foto');
          await expect(visor).toBeVisible();
          await expect(visor).toContainText('Foto de «Cena en Top Banana Market»');
          const descarga = page.waitForEvent('download');
          await visor.getByRole('button', { name: /Descargar original/ }).click();
          const archivo = await descarga;
          const leido = await new Promise<Buffer>((ok, ko) => {
            void archivo.createReadStream().then((s) => {
              const partes: Buffer[] = [];
              s.on('data', (p: Buffer) => partes.push(p)); s.on('end', () => ok(Buffer.concat(partes))); s.on('error', ko);
            }, ko);
          });
          expect([...leido]).toEqual(bytes[0]);
          await page.keyboard.press('Escape');
          await expect(visor).toBeHidden();

          // Marcar (una casilla) y reconectar siguen sin red: solo este móvil.
          await page.locator('input[data-pendiente-id="b059fb349a2744a7"]').check();
          await expect(page.locator('input[data-pendiente-id="b059fb349a2744a7"]')).toBeChecked();
          await contexto.setOffline(true);
          await contexto.setOffline(false);
          await page.waitForTimeout(300);
          expect(peticiones.filter((r) => r.startsWith('/api/'))).toEqual([]);
          expect(errores).toEqual([]);
        } finally {
          await contexto.close();
        }
      });
  }
});
