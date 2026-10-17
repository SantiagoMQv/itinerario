// Puerta /entrar en un móvil simulado. La página sale de la función real del servidor; /api/sesion
// y «/» se simulan con page.route: aquí no hay Worker, base de datos ni cookies de verdad.
import { createServer } from 'node:http';
import { type Page, expect, test } from '@playwright/test';
import { comprobarOrigen, FalloHttp, respuestaJson } from '../servidor/http';
import { CLAVE_IDENTIFICADOR_DISPOSITIVO, proveerRespuestaEntrada } from '../servidor/entrada';

// Con espacios y no ASCII: la UI no la recorta ni la transforma.
const CLAVE = '  clave del viaje ñ ✓  ';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const ID_SESION = '3f2b8c1e-9d4a-4b6f-8a1c-2e5d7f9a0b3c';

type Cuerpo = { clave: string; dispositivoId: string; nombreDispositivo?: string };
type Respuesta = { status: number; body?: string; contentType?: string; headers?: Record<string, string> } | 'abortar' | 'colgar';

const json = (status: number, datos: unknown, headers?: Record<string, string>): Respuesta => ({
  status, body: JSON.stringify(datos), headers,
});
const sesionDe = (c: Cuerpo) => ({
  id: ID_SESION, viajeId: 'viaje', dispositivoId: c.dispositivoId, venceEn: 1_800_000_000_000,
  ...(c.nombreDispositivo === undefined ? {} : { nombreDispositivo: c.nombreDispositivo }),
});
const exito = (c: Cuerpo) => json(201, { sesion: sesionDe(c) });

/** Sirve /entrar con la función real y simula /api/sesion con `responder`. */
async function abrirPuerta(page: Page, responder: (cuerpo: Cuerpo, n: number) => Respuesta | Promise<Respuesta> = exito) {
  const peticiones: { metodo: string; cuerpo: Cuerpo; tipo: string | undefined; texto: string }[] = [];
  const errores: string[] = [];
  page.on('pageerror', (e) => errores.push(e.message));
  page.on('console', (m) => m.type() === 'error' && errores.push(m.text()));
  await page.route(/^https?:\/\/(?!localhost)/, (r) => r.abort());
  await page.route((url) => url.pathname === '/entrar', async (route) => {
    const r = await proveerRespuestaEntrada(new Request(route.request().url(), { method: route.request().method() }));
    await route.fulfill({ status: r.status, headers: Object.fromEntries(r.headers), body: await r.text() });
  });
  await page.route((url) => url.pathname === '/', (route) =>
    route.fulfill({ contentType: 'text/html; charset=utf-8', body: '<!doctype html><title>Viaje</title><p id="viaje">Itinerario</p>' }));
  await page.route((url) => url.pathname === '/api/sesion', async (route) => {
    const req = route.request();
    const cuerpo = req.postDataJSON() as Cuerpo;
    peticiones.push({ metodo: req.method(), cuerpo, tipo: req.headers()['content-type'], texto: req.postData() ?? '' });
    const r = await responder(cuerpo, peticiones.length);
    if (r === 'colgar') return;
    if (r === 'abortar') return route.abort('failed');
    await route.fulfill({ status: r.status, contentType: r.contentType ?? 'application/json; charset=utf-8', body: r.body ?? '', headers: r.headers });
  });
  await page.goto('/entrar');
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
  return { peticiones, errores };
}

const almacenado = (page: Page) => page.evaluate(() => {
  const todo: Record<string, string | null> = {};
  for (const s of [localStorage, sessionStorage]) for (let i = 0; i < s.length; i++) todo[s.key(i)!] = s.getItem(s.key(i)!);
  return todo;
});

test('Origin nativo: la entrada supera el validador real y abre el itinerario', async ({ browser }) => {
  // HTTP loopback prueba solo Origin: no sustituye el gate HTTPS del Worker ni autentica.
  let origen = '';
  const observadas: { origen: string | null; estado: number }[] = [];
  const errores: string[] = [];
  const servidor = createServer(async (peticion, salida) => {
    try {
      const url = new URL(peticion.url!, origen);
      const cabeceras = new Headers();
      for (let i = 0; i < peticion.rawHeaders.length; i += 2) {
        cabeceras.append(peticion.rawHeaders[i], peticion.rawHeaders[i + 1]);
      }
      const solicitud = new Request(url, { method: peticion.method, headers: cabeceras });
      let respuesta: Response;
      if (url.pathname === '/entrar' && peticion.method === 'GET') {
        respuesta = await proveerRespuestaEntrada(solicitud);
      } else if (url.pathname === '/api/sesion' && peticion.method === 'POST') {
        const recibido = cabeceras.get('Origin');
        try {
          // Conservar las cabeceras nativas y validar ANTES de consumir el cuerpo HTTP.
          comprobarOrigen(solicitud);
          const trozos: Buffer[] = [];
          for await (const trozo of peticion) trozos.push(Buffer.from(trozo));
          const cuerpo = JSON.parse(Buffer.concat(trozos).toString('utf8')) as Cuerpo;
          expect(cuerpo.clave).toBe('clave-test');
          expect(cuerpo.dispositivoId).toMatch(UUID);
          // DTO exclusivamente sintético: no hay DB, autenticación ni cookie persistida.
          respuesta = respuestaJson({ sesion: sesionDe(cuerpo) }, 201);
        } catch (error) {
          if (!(error instanceof FalloHttp)) throw error;
          respuesta = respuestaJson({ error: error.message }, error.codigo);
        }
        observadas.push({ origen: recibido, estado: respuesta.status });
      } else if (url.pathname === '/' && peticion.method === 'GET') {
        respuesta = new Response('<!doctype html><title>Destino sintético</title><p id="viaje">Itinerario sintético</p>', {
          headers: { 'Content-Type': 'text/html; charset=utf-8' },
        });
      } else {
        respuesta = new Response(null, { status: 404 });
      }
      salida.writeHead(respuesta.status, Object.fromEntries(respuesta.headers));
      salida.end(Buffer.from(await respuesta.arrayBuffer()));
    } catch (error) {
      errores.push(String(error));
      salida.writeHead(500);
      salida.end();
    }
  });
  let contexto: Awaited<ReturnType<typeof browser.newContext>> | undefined;
  try {
    await new Promise<void>((resolver, rechazar) => {
      servidor.once('error', rechazar);
      servidor.listen(0, '127.0.0.1', resolver);
    });
    const direccion = servidor.address();
    if (!direccion || typeof direccion === 'string') throw new Error('No hay puerto local asignado.');
    origen = `http://127.0.0.1:${direccion.port}`;
    contexto = await browser.newContext({ serviceWorkers: 'block' });
    // No interceptar la API: permitir HTTP real únicamente hacia este servidor propio.
    await contexto.route('**/*', (ruta) =>
      new URL(ruta.request().url()).origin === origen ? ruta.continue() : ruta.abort());
    const pagina = await contexto.newPage();
    await pagina.goto(`${origen}/entrar`);
    await pagina.getByLabel('Contraseña del viaje').fill('clave-test');
    const respuesta = pagina.waitForResponse((r) => r.url() === `${origen}/api/sesion`);
    await pagina.getByRole('button', { name: 'Entrar' }).click();
    const recibida = await respuesta;
    expect(errores).toEqual([]);
    expect(observadas).toEqual([{ origen, estado: 201 }]);
    expect(recibida.status()).toBe(201);
    await expect(pagina).toHaveURL(`${origen}/`);
    await expect(pagina.locator('#viaje')).toHaveText('Itinerario sintético');
  } finally {
    try {
      await contexto?.close();
    } finally {
      await new Promise<void>((resolver, rechazar) => {
        servidor.close((error) => error ? rechazar(error) : resolver());
        servidor.closeAllConnections();
      });
    }
  }
});

test('entra con la contraseña exacta, guarda solo el identificador y va a «/»', async ({ page }) => {
  const { peticiones, errores } = await abrirPuerta(page);
  await page.getByLabel('Contraseña del viaje').fill(CLAVE);
  await page.getByLabel(/Nombre de este móvil/).fill('Fold de Ñandú 🇪🇸');
  const navegacion = page.waitForRequest((r) => new URL(r.url()).pathname === '/');
  await page.getByLabel('Contraseña del viaje').press('Enter');
  await navegacion;
  await expect(page.locator('#viaje')).toBeVisible();
  expect(new URL(page.url()).pathname).toBe('/');
  expect(page.url()).not.toContain('clave');

  expect(peticiones).toHaveLength(1);
  const [p] = peticiones;
  expect(p.metodo).toBe('POST');
  expect(p.tipo).toBe('application/json');
  expect(Object.keys(p.cuerpo)).toEqual(['clave', 'dispositivoId', 'nombreDispositivo']);
  expect(p.cuerpo.clave).toBe(CLAVE);
  expect(p.cuerpo.nombreDispositivo).toBe('Fold de Ñandú 🇪🇸');
  expect(p.cuerpo.dispositivoId).toMatch(UUID);

  const guardado = await almacenado(page);
  expect(guardado).toEqual({ [CLAVE_IDENTIFICADOR_DISPOSITIVO]: p.cuerpo.dispositivoId });
  expect(errores).toEqual([]);
});

test('al entrar vacía el campo de la contraseña antes de irse', async ({ page }) => {
  await abrirPuerta(page);
  // Un 204 cancela la navegación a «/» y deja a la vista el documento que se iba (la ruta más reciente manda).
  await page.route((url) => url.pathname === '/', (route) => route.fulfill({ status: 204 }));
  await page.getByLabel('Contraseña del viaje').fill(CLAVE);
  await page.getByRole('button', { name: 'Mostrar contraseña' }).click();
  const navegacion = page.waitForRequest((r) => new URL(r.url()).pathname === '/');
  await page.getByRole('button', { name: 'Entrar' }).click();
  await navegacion;
  await expect(page.locator('#estado')).toHaveText('Contraseña aceptada. Abriendo el itinerario…');
  await expect(page.locator('#clave')).toHaveValue('');
  await expect(page.locator('#clave')).toHaveAttribute('type', 'password');
  expect(new URL(page.url()).pathname).toBe('/entrar');
});

test('el identificador del móvil se mantiene entre visitas y no toca las claves antiguas', async ({ page }) => {
  await page.addInitScript(() => {
    if (localStorage.getItem('marcas') === null) {
      localStorage.setItem('marcas', '{"2026-10-21|10:00|Bund":"hecha"}');
      localStorage.setItem('pendientes-hechos', '["Equipaje"]');
      localStorage.setItem('tema', '"claro"');
    }
  });
  const { peticiones } = await abrirPuerta(page, () => json(401, { error: 'La clave no es válida.' }));
  const primero = await page.evaluate((k) => localStorage.getItem(k), CLAVE_IDENTIFICADOR_DISPOSITIVO);
  expect(primero).toMatch(UUID);
  await page.reload();
  expect(await page.evaluate((k) => localStorage.getItem(k), CLAVE_IDENTIFICADOR_DISPOSITIVO)).toBe(primero);

  await page.getByLabel('Contraseña del viaje').fill(CLAVE);
  await page.getByRole('button', { name: 'Entrar' }).click();
  await expect(page.locator('#error-clave')).toBeVisible();
  // Sin nombre, el campo opcional no se envía.
  expect(peticiones[0].cuerpo).toEqual({ clave: CLAVE, dispositivoId: primero });
  expect(await almacenado(page)).toEqual({
    marcas: '{"2026-10-21|10:00|Bund":"hecha"}',
    'pendientes-hechos': '["Equipaje"]',
    tema: '"claro"',
    [CLAVE_IDENTIFICADOR_DISPOSITIVO]: primero,
  });
});

test('si el navegador no deja guardar, lo dice y entra con un identificador de esta visita', async ({ page }) => {
  await page.addInitScript(() => {
    const falla = () => { throw new DOMException('Bloqueado', 'SecurityError'); };
    Storage.prototype.getItem = falla;
    Storage.prototype.setItem = falla;
  });
  const { peticiones, errores } = await abrirPuerta(page);
  await expect(page.locator('#aviso-almacen')).toBeVisible();
  await expect(page.locator('#aviso-almacen')).toContainText('solo durará mientras esta página siga abierta');
  await page.getByLabel('Contraseña del viaje').fill(CLAVE);
  await page.getByRole('button', { name: 'Entrar' }).click();
  await expect(page.locator('#viaje')).toBeVisible();
  expect(peticiones[0].cuerpo.dispositivoId).toMatch(UUID);
  expect(errores).toEqual([]);
});

test.describe('nombre del móvil', () => {
  test('acepta Unicode completo hasta 80 caracteres', async ({ page }) => {
    const { peticiones } = await abrirPuerta(page);
    const nombre = '😀'.repeat(80);
    await page.getByLabel('Contraseña del viaje').fill(CLAVE);
    await page.getByLabel(/Nombre de este móvil/).fill(nombre);
    await page.getByRole('button', { name: 'Entrar' }).click();
    await expect(page.locator('#viaje')).toBeVisible();
    expect(peticiones[0].cuerpo.nombreDispositivo).toBe(nombre);
  });

  for (const [caso, valor, texto] of [
    ['NUL', 'Fold\u0000', 'no se pueden guardar'],
    ['sustituto suelto', 'Fold \ud83d', 'no se pueden guardar'],
    ['más de 80 caracteres', 'ñ'.repeat(81), 'como máximo 80'],
  ] as const) {
    test(`rechaza en la UI sin enviar: ${caso}`, async ({ page }) => {
      const { peticiones } = await abrirPuerta(page);
      await page.getByLabel('Contraseña del viaje').fill(CLAVE);
      await page.locator('#nombre').evaluate((e, v) => { (e as HTMLInputElement).value = v; }, valor);
      await page.getByRole('button', { name: 'Entrar' }).click();
      await expect(page.locator('#error-nombre')).toContainText(texto);
      await expect(page.locator('#nombre')).toHaveAttribute('aria-invalid', 'true');
      await expect(page.locator('#nombre')).toBeFocused();
      expect(peticiones).toHaveLength(0);
    });
  }
});

test('contraseña vacía: lo dice en el campo y no envía nada', async ({ page }) => {
  const { peticiones } = await abrirPuerta(page);
  await page.getByRole('button', { name: 'Entrar' }).click();
  await expect(page.locator('#error-clave')).toContainText('Escribe la contraseña del viaje');
  await expect(page.locator('#clave')).toHaveAttribute('aria-invalid', 'true');
  await expect(page.locator('#clave')).toBeFocused();
  expect(peticiones).toHaveLength(0);
});

test('401: contraseña incorrecta, sin mostrar el texto del servidor, y se puede reintentar', async ({ page }, info) => {
  const { peticiones } = await abrirPuerta(page, (c, n) => (n === 1 ? json(401, { error: 'La clave no es válida.' }) : exito(c)));
  await page.getByLabel('Contraseña del viaje').fill(CLAVE);
  await page.getByRole('button', { name: 'Entrar' }).click();
  await expect(page.locator('#error-clave')).toContainText('La contraseña no es correcta');
  await expect(page.locator('#clave')).toHaveAttribute('aria-invalid', 'true');
  await expect(page.locator('#clave')).toBeFocused();
  await expect(page.locator('#clave')).toHaveValue(CLAVE);
  await expect(page.locator('body')).not.toContainText('La clave no es válida');
  expect(new URL(page.url()).pathname).toBe('/entrar');
  await page.screenshot({ path: info.outputPath('entrada-401.png'), fullPage: true });

  await page.getByRole('button', { name: 'Entrar' }).click();
  await expect(page.locator('#viaje')).toBeVisible();
  expect(peticiones).toHaveLength(2);
});

test('429: pide esperar, sin contador ni reintento automático', async ({ page }) => {
  const { peticiones } = await abrirPuerta(page, () =>
    json(429, { error: 'Demasiados intentos. Esperá antes de volver a entrar.' }, { 'Retry-After': '600' }));
  await page.getByLabel('Contraseña del viaje').fill(CLAVE);
  await page.getByRole('button', { name: 'Entrar' }).click();
  const resultado = page.locator('#resultado');
  await expect(resultado).toContainText('Demasiados intentos');
  expect(await resultado.innerText()).not.toMatch(/\d/);
  await expect(page.locator('#error-clave')).toBeHidden();
  await page.waitForTimeout(1500);
  expect(peticiones).toHaveLength(1);
  await expect(page.getByRole('button', { name: 'Entrar' })).not.toHaveAttribute('aria-disabled', 'true');
});

// Ninguna de estas respuestas confirma la entrada ni dice que la contraseña esté mal.
const noConfirmadas: [string, Respuesta | ((c: Cuerpo) => Respuesta), string][] = [
  ['503', json(503, { error: 'No se pudo comprobar la sesión.' }), 'No se pudo confirmar la entrada'],
  ['red caída', 'abortar', 'No llegó respuesta del servidor'],
  ['201 con cuerpo incompleto', json(201, { sesion: { id: 'x' } }), 'No se pudo confirmar la entrada'],
  ['201 con HTML', { status: 201, contentType: 'text/html', body: '<p>postgres://usuario@base</p>' }, 'No se pudo confirmar la entrada'],
  ['201 de otro móvil', (c) => json(201, { sesion: { ...sesionDe(c), dispositivoId: 'otro' } }), 'No se pudo confirmar la entrada'],
  ['201 con campos de más', (c) => json(201, { sesion: { ...sesionDe(c), huella: 'f'.repeat(64) } }), 'No se pudo confirmar la entrada'],
  ['200 en vez de 201', (c) => json(200, { sesion: sesionDe(c) }), 'No se pudo confirmar la entrada'],
  ['401 con HTML', { status: 401, contentType: 'text/html', body: '<p>postgres://usuario@base</p>' }, 'No se pudo confirmar la entrada'],
  ['418 raro', json(418, { error: 'Soy una tetera.' }), 'No se pudo confirmar la entrada'],
  ['400 rechazada', json(400, { error: 'El cuerpo JSON no es válido.' }), 'el servidor no aceptó la solicitud'],
];
// viajeId sigue el contrato del servidor (sesiones.ts): texto no vacío, UTF-8 exacto y como mucho 128 BYTES.
const conViaje = (viajeId: string) => (c: Cuerpo) => json(201, { sesion: { ...sesionDe(c), viajeId } });
const viajesInvalidos: [string, string][] = [
  ['viajeId vacío', ''],
  ['viajeId de 129 bytes ASCII', 'v'.repeat(129)],
  ['viajeId de 130 bytes en 65 caracteres', 'ñ'.repeat(65)],
  ['viajeId de 129 bytes en 43 caracteres', '中'.repeat(43)],
  ['viajeId astral de 132 bytes', '😀'.repeat(33)],
  ['viajeId con sustituto alto aislado', 'viaje\ud83d'],
  ['viajeId con sustituto bajo aislado', 'viaje\ude00'],
];
for (const [caso, viajeId] of viajesInvalidos) noConfirmadas.push([`201 con ${caso}`, conViaje(viajeId), 'No se pudo confirmar la entrada']);
for (const [caso, respuesta, texto] of noConfirmadas) {
  test(`no da por buena la entrada: ${caso}`, async ({ page }) => {
    const { peticiones } = await abrirPuerta(page, (c, n) => {
      if (n > 1) return exito(c);
      return typeof respuesta === 'function' ? respuesta(c) : respuesta;
    });
    await page.getByLabel('Contraseña del viaje').fill(CLAVE);
    await page.getByRole('button', { name: 'Entrar' }).click();
    await expect(page.locator('#resultado')).toContainText(texto);
    // Sin confirmación, acceso explícito a «/»; un rechazo del servidor no lo ofrece.
    await expect(page.getByRole('link', { name: 'Abrir el itinerario' })).toBeVisible({ visible: texto !== 'el servidor no aceptó la solicitud' });
    await expect(page.locator('body')).not.toContainText(/incorrecta|no es correcta|postgres|tetera|JSON/);
    await expect(page.locator('#clave')).not.toHaveAttribute('aria-invalid', 'true');
    expect(new URL(page.url()).pathname).toBe('/entrar');
    await expect(page.locator('#clave')).toHaveValue(CLAVE);
    // Siempre se puede volver a intentar.
    await page.getByRole('button', { name: 'Entrar' }).click();
    await expect(page.locator('#viaje')).toBeVisible();
    expect(peticiones).toHaveLength(2);
  });
}

// Límites válidos: se aceptan tal cual, sin recortar, normalizar ni prohibir NUL.
for (const [caso, viajeId] of [
  ['viajeId de 128 bytes ASCII', 'v'.repeat(128)],
  ['viajeId de 128 bytes en 64 caracteres', 'ñ'.repeat(64)],
  ['viajeId de 128 bytes con caracteres de 3 bytes', `${'中'.repeat(42)}ab`],
  ['viajeId astral de 128 bytes', '😀'.repeat(32)],
  ['viajeId con NUL, espacios y forma NFD', ' viaje\u0000 n\u0303 '],
] as const) {
  test(`entra con un ${caso}`, async ({ page }) => {
    const { peticiones } = await abrirPuerta(page, conViaje(viajeId));
    await page.getByLabel('Contraseña del viaje').fill(CLAVE);
    await page.getByRole('button', { name: 'Entrar' }).click();
    await expect(page.locator('#viaje')).toBeVisible();
    expect(peticiones).toHaveLength(1);
  });
}

test('sin respuesta confirmada ofrece abrir el itinerario en «/»', async ({ page }, info) => {
  await page.emulateMedia({ colorScheme: 'dark' });
  await abrirPuerta(page, () => json(503, { error: 'No se pudo comprobar la sesión.' }));
  await page.getByLabel('Contraseña del viaje').fill(CLAVE);
  await page.getByRole('button', { name: 'Entrar' }).click();
  const abrir = page.getByRole('link', { name: 'Abrir el itinerario' });
  await expect(abrir).toBeVisible();
  await expect(abrir).toHaveAttribute('href', '/');
  await page.screenshot({ path: info.outputPath('entrada-503-noche.png'), fullPage: true });
});

test('doble envío: un solo POST mientras espera, con estado ocupado', async ({ page }) => {
  let soltar!: () => void;
  const espera = new Promise<void>((r) => { soltar = r; });
  const { peticiones } = await abrirPuerta(page, async () => {
    await espera;
    return json(401, { error: 'La clave no es válida.' });
  });
  await page.getByLabel('Contraseña del viaje').fill(CLAVE);
  const boton = page.getByRole('button', { name: /Entrar|Entrando/ });
  await boton.click();
  await expect(page.locator('form')).toHaveAttribute('aria-busy', 'true');
  await expect(boton).toHaveAttribute('aria-disabled', 'true');
  await expect(boton).toHaveText('Entrando…');
  // aria-disabled no impide el toque: se fuerza para comprobar que no sale un segundo POST.
  await boton.click({ force: true });
  await page.getByLabel('Contraseña del viaje').press('Enter');
  await page.waitForTimeout(400);
  expect(peticiones).toHaveLength(1);
  soltar();
  await expect(page.locator('#error-clave')).toBeVisible();
  await expect(page.locator('form')).not.toHaveAttribute('aria-busy', 'true');
  await expect(boton).toHaveText('Entrar');
});

test('tiempo agotado: no la da por fallida ni por hecha', async ({ page }) => {
  await page.clock.install();
  const { peticiones } = await abrirPuerta(page, () => 'colgar');
  await page.getByLabel('Contraseña del viaje').fill(CLAVE);
  await page.getByRole('button', { name: 'Entrar' }).click();
  await expect.poll(() => peticiones.length).toBe(1);
  await page.clock.runFor(31_000);
  await expect(page.locator('#resultado')).toContainText('No llegó respuesta del servidor');
  await expect(page.locator('#resultado')).toContainText('Puede que la entrada se haya completado');
  expect(new URL(page.url()).pathname).toBe('/entrar');
  await expect(page.getByRole('button', { name: 'Entrar' })).not.toHaveAttribute('aria-disabled', 'true');
});

test('sin conexión: lo dice y no envía nada', async ({ page, context }) => {
  const { peticiones } = await abrirPuerta(page);
  await context.setOffline(true);
  await expect(page.locator('#conexion')).toBeVisible();
  await page.getByLabel('Contraseña del viaje').fill(CLAVE);
  await page.getByRole('button', { name: 'Entrar' }).click();
  await expect(page.locator('#resultado')).toContainText('hace falta internet');
  await expect(page.locator('#resultado')).toContainText('lo que este móvil ya tenga guardado');
  expect(peticiones).toHaveLength(0);
  await context.setOffline(false);
  await expect(page.locator('#conexion')).toBeHidden();
});

test('teclado y lector de pantalla', async ({ page }) => {
  await abrirPuerta(page, () => json(401, { error: 'La clave no es válida.' }));
  const orden: string[] = [];
  for (let i = 0; i < 4; i++) {
    await page.keyboard.press('Tab');
    orden.push(await page.evaluate(() => document.activeElement?.id ?? ''));
  }
  expect(orden).toEqual(['clave', 'ver-clave', 'nombre', 'entrar']);

  const ver = page.getByRole('button', { name: 'Mostrar contraseña' });
  await page.locator('#clave').fill(CLAVE);
  await expect(ver).toHaveAttribute('aria-pressed', 'false');
  await ver.focus();
  await page.keyboard.press('Space');
  await expect(ver).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('#clave')).toHaveAttribute('type', 'text');
  // El nombre accesible no cambia ni lleva la contraseña.
  await expect(page.getByRole('button', { name: 'Mostrar contraseña' })).toHaveCount(1);
  await page.keyboard.press('Enter');
  await expect(page.locator('#clave')).toHaveAttribute('type', 'password');

  await expect(page.locator('#clave')).toHaveAttribute('aria-describedby', /error-clave/);
  await page.locator('#nombre').press('Enter');
  await expect(page.locator('#error-clave')).toBeVisible();
  await expect(page.locator('#clave')).toBeFocused();
  expect(await page.content()).not.toContain(CLAVE.trim());
});

// Medidas y capturas para la inspección visual (quedan en test-results/, que no se sube).
for (const [nombre, ancho, alto, movil] of [
  ['390x844', 390, 844, true],
  ['360x640', 360, 640, true],
  ['844x390', 844, 390, true],
  ['1280x800', 1280, 800, false],
] as const) {
  test.describe(`pantalla ${nombre}`, () => {
    test.use({ viewport: { width: ancho, height: alto }, isMobile: movil, hasTouch: movil });

    for (const tema of ['light', 'dark'] as const) {
      test(`cabe sin desbordar, con objetivos de 44 px (${tema})`, async ({ page }, info) => {
        await page.emulateMedia({ colorScheme: tema });
        const { errores } = await abrirPuerta(page);
        await expect(page.locator('html')).toHaveAttribute('data-tema', tema === 'dark' ? 'oscuro' : 'claro');
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
        await expect(page.locator('#clave')).toBeInViewport();
        for (const sel of ['#clave', '#ver-clave', '#nombre', '#entrar']) {
          const caja = (await page.locator(sel).boundingBox())!;
          expect(caja.height, sel).toBeGreaterThanOrEqual(44);
          expect(caja.width, sel).toBeGreaterThanOrEqual(44);
        }
        await page.screenshot({ path: info.outputPath(`entrada-${nombre}-${tema}.png`), fullPage: true });
        expect(errores).toEqual([]);
      });
    }
  });
}

test('el tema elegido en este móvil manda sobre el del sistema', async ({ page }) => {
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.addInitScript(() => localStorage.setItem('tema', '"claro"'));
  await abrirPuerta(page);
  await expect(page.locator('html')).toHaveAttribute('data-tema', 'claro');
  expect(await page.evaluate(() => localStorage.getItem('tema'))).toBe('"claro"');
});
