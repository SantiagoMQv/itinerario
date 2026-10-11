// Progreso compartido entre dos móviles simulados (dos contextos aislados de Chromium, cada uno con
// su IndexedDB y su localStorage reales). /api/progreso pasa por el controlador y el almacén REALES
// del servidor con una pasarela en memoria. No prueba Cloudflare, Neon, SQL, cookies ni móviles.
import { type Browser, type BrowserContext, type Page, type Route, expect, test } from '@playwright/test';
import { itinerario } from '../src/datos/itinerario';
import { crearProgreso } from '../src/progreso';
import type { InstantaneaProgreso } from '../src/progreso-validacion';
import { crearControladorProgreso, type ControladorProgreso } from '../servidor/api-progreso';
import { crearAlmacenProgreso, type DecisionHistorica } from '../servidor/almacen-progreso';
import type { RegistroSesion } from '../servidor/sesiones';

const HORA = '2026-10-22T13:30:00+08:00';
// Paradas del 22 de octubre (IDs persistentes del plan, no índices visuales).
const LANXIN = '9df146a2e730cb58';
const TIENDAS = '452ea1cf8d93706b';
const EQUIPAJE = 'b1f8074a6d3c92e5';
const ACTOR: RegistroSesion = {
  id: '00000000-0000-4000-8000-000000000001', huella: 'a'.repeat(64), viajeId: itinerario.id,
  dispositivoId: 'sesion', creadaEn: 0, venceEn: 4_000_000_000_000, revocada: false,
};

/** Servidor de prueba: estado y decisiones históricas en memoria, con CAS por revisión. */
function crearServidor() {
  let actual: InstantaneaProgreso = { revisionServidor: 0, estado: crearProgreso(itinerario) };
  const decisiones = new Map<string, DecisionHistorica>();
  const s = {
    sesion: true,
    /** Procesa la solicitud y luego corta la respuesta: el servidor decidió, el móvil no lo sabe. */
    perderRespuesta: false,
    posts: [] as { id: string; cuerpo: string }[],
    /** Lecturas GET que llegaron al servidor (con o sin 304). */
    lecturas: 0,
    get actual(): InstantaneaProgreso { return actual; },
    controlador: undefined as unknown as ControladorProgreso,
  };
  s.controlador = crearControladorProgreso({
    plan: itinerario,
    autenticar: async () => (s.sesion ? ACTOR : null),
    repositorio: crearAlmacenProgreso({ plan: itinerario, pasarela: {
      async consultar(_h: string, _v: string, id?: string) {
        return { tipo: 'lectura', instantanea: structuredClone(actual),
          decision: id === undefined ? null : structuredClone(decisiones.get(id) ?? null) };
      },
      async confirmar(_h: string, _v: string, base: number, candidato: DecisionHistorica) {
        if (base !== actual.revisionServidor) return { tipo: 'desfase' };
        actual = structuredClone(candidato.tipo === 'positiva' ? candidato.acuse.instantanea
          : { revisionServidor: candidato.rechazo.instantanea.revisionServidor, estado: actual.estado });
        const id = candidato.tipo === 'positiva' ? candidato.acuse.operacionId : candidato.rechazo.operacionId;
        decisiones.set(id, structuredClone(candidato));
        return { tipo: 'comprometida' };
      },
    } }),
  });
  return s;
}
type Servidor = ReturnType<typeof crearServidor>;

interface Red { cortada: boolean; retener?: Promise<void> }
interface Movil { contexto: BrowserContext; page: Page; red: Red; errores: string[] }

/** Un móvil: contexto aislado, hora fija de China y /api/progreso hacia el servidor compartido. */
async function movil(browser: Browser, servidor: Servidor, legado?: Record<string, string>): Promise<Movil> {
  const contexto = await browser.newContext({
    baseURL: 'http://localhost:4173', locale: 'es-ES', viewport: { width: 390, height: 844 },
    deviceScaleFactor: 2, isMobile: true, hasTouch: true, serviceWorkers: 'block',
  });
  const red: Red = { cortada: false };
  await contexto.route(/^https?:\/\/(?!localhost)/, (r) => r.abort());
  await contexto.route((url) => url.pathname === '/api/progreso', (route) => atender(route, servidor, red));
  await contexto.addInitScript((datos) => {
    if (localStorage.getItem('marcador') === null) localStorage.setItem('marcador', 'true');
    if (datos && localStorage.getItem('marcas') === null) for (const [k, v] of Object.entries(datos)) localStorage.setItem(k, v);
  }, legado ?? null);
  const page = await abrirPagina(contexto);
  const errores: string[] = [];
  page.on('pageerror', (e) => errores.push(e.message));
  return { contexto, page, red, errores };
}
async function abrirPagina(contexto: BrowserContext) {
  const page = await contexto.newPage();
  await page.clock.setFixedTime(new Date(HORA));
  await page.goto('/');
  await expect(page.locator('#contenido')).not.toBeEmpty();
  return page;
}

async function atender(route: Route, servidor: Servidor, red: Red) {
  const req = route.request();
  if (red.cortada) return route.abort('internetdisconnected');
  // Retener un POST deja pasar antes las escrituras del otro móvil (carrera real entre GET y POST).
  if (req.method() === 'POST' && red.retener) await red.retener;
  const todas = await req.allHeaders();
  const headers: Record<string, string> = {};
  for (const k of ['accept', 'content-type', 'origin', 'if-none-match']) if (todas[k]) headers[k] = todas[k];
  const cuerpo = req.postData() ?? undefined;
  if (req.method() === 'POST') servidor.posts.push({ id: (JSON.parse(cuerpo!) as { id: string }).id, cuerpo: cuerpo! });
  else servidor.lecturas++;
  const respuesta = await servidor.controlador.atender(new Request(req.url(), { method: req.method(), headers, body: cuerpo }));
  if (servidor.perderRespuesta && req.method() === 'POST') return route.abort('connectionreset');
  const body = respuesta.status === 304 ? undefined : Buffer.from(await respuesta.arrayBuffer());
  await route.fulfill({ status: respuesta.status, headers: Object.fromEntries(respuesta.headers), body });
}

/** Raíz durable leída directamente de IndexedDB (no de la interfaz). */
const raiz = (page: Page) => page.evaluate((viaje) => new Promise<{
  formato: number; estado: { paradas: Record<string, { marca: string | null; revision: number }>;
    pendientes: Record<string, { hecho: boolean }>; aqui: { paradaId: string | null } };
  cola: { operacion: { id: string }; enviada: boolean; rechazo?: unknown; resolucion?: string }[];
  legado?: { originales: Record<string, unknown>; recuperacion: { campo: string; motivo: string }[] };
} | undefined>((ok, ko) => {
  // Abrir sin versión una base que no existe la crearía vacía: primero se comprueba que exista.
  void indexedDB.databases().then((bases) => {
    if (!bases.some((b) => b.name === 'itinerario-progreso')) { ok(undefined); return; }
    const r = indexedDB.open('itinerario-progreso');
    r.onerror = () => ko(r.error);
    r.onsuccess = () => {
      const db = r.result;
      if (!db.objectStoreNames.contains('viajes')) { db.close(); ok(undefined); return; }
      const g = db.transaction('viajes').objectStore('viajes').get(viaje);
      g.onsuccess = () => { ok(g.result); db.close(); };
      g.onerror = () => { ko(g.error); db.close(); };
    };
  }, ko);
}), itinerario.id);

/** Lo que este móvil puede marcar ya: lo guardado en IndexedDB está abierto. */
async function listo(page: Page, marca: 'hecha' | 'aqui' = 'hecha') {
  await expect(page.locator(`#ahora [data-marcar="${marca}"]`).first()).not.toHaveAttribute('aria-disabled', 'true');
}
/** Pulsa una marca de «ahora» cuando ya no está en el enfriamiento de 0,7 s y espera a que se guarde. */
async function pulsar(page: Page, marca: 'hecha' | 'aqui') {
  await listo(page, marca);
  await expect(page.locator('#ahora')).not.toHaveClass(/enfriando/);
  await page.locator(`#ahora [data-marcar="${marca}"]`).first().click();
  // El aviso de ESTA marca, no uno anterior que siga a la vista.
  await expect(page.locator('#toast-texto')).toContainText(marca === 'aqui' ? /^Estás en .*Guardado en este móvil\.$/ : /: hecha\. Guardado en este móvil\.$/);
  await expect(page.locator('#ahora')).not.toHaveClass(/enfriando/);
}
const marcarHecha = (page: Page) => pulsar(page, 'hecha');
async function sincronizarDesdeTodo(page: Page) {
  await page.locator('.pestana.todo').click();
  const boton = page.locator('#compartido [data-sincronizar]');
  await expect(boton).toBeVisible();
  await boton.click();
}

test.describe('progreso compartido entre dos móviles', () => {
  let servidor: Servidor;
  test.beforeEach(() => { servidor = crearServidor(); });

  test('lo marcado en un móvil, y sus casillas, llegan al otro', async ({ browser }) => {
    const a = await movil(browser, servidor);
    await marcarHecha(a.page);
    await expect.poll(() => servidor.actual.estado.paradas[LANXIN]?.marca).toBe('hecha');
    await expect(a.page.locator('#red')).toBeHidden();

    await a.page.locator('.pestana.todo').click();
    const casilla = a.page.locator(`input[data-pendiente-id="${EQUIPAJE}"]`);
    await casilla.check();
    await expect.poll(() => servidor.actual.estado.pendientes[EQUIPAJE]?.hecho).toBe(true);

    const b = await movil(browser, servidor);
    // B abre después: arranca leyendo el servidor y lo de ahora ya no es Lanxin.
    await expect(b.page.locator('#ahora')).toContainText('Más tiendas');
    await b.page.locator('.pestana.todo').click();
    await expect(b.page.locator(`input[data-pendiente-id="${EQUIPAJE}"]`)).toBeChecked();
    expect((await raiz(b.page))!.estado.paradas[LANXIN].marca).toBe('hecha');
    expect([...a.errores, ...b.errores]).toEqual([]);
  });

  test('un solo aquí: el cambio que choca en el servidor se rechaza y se revisa a mano', async ({ browser }) => {
    const a = await movil(browser, servidor);
    const b = await movil(browser, servidor);
    await marcarHecha(b.page);
    await expect.poll(() => servidor.actual.estado.paradas[LANXIN]?.marca).toBe('hecha');

    // B dice «Llegué» a las tiendas, pero su POST queda retenido: A llega antes al servidor.
    let soltar!: () => void;
    b.red.retener = new Promise((ok) => { soltar = ok; });
    await pulsar(b.page, 'aqui');
    await expect(b.page.locator('#red')).toContainText(/Enviando|sin enviar|Sin confirmar/);
    await marcarHecha(a.page);
    await pulsar(a.page, 'aqui');
    await expect.poll(() => servidor.actual.estado.aqui.paradaId).toBe(TIENDAS);
    const aquiDeA = servidor.actual.estado.aqui.revision;
    soltar();

    await expect(b.page.locator('#red')).toContainText('no se aplicó');
    await b.page.locator('.pestana.todo').click();
    const revisar = b.page.locator('#compartido [data-conservar]');
    await expect(revisar).toBeVisible();
    await expect(b.page.locator('#compartido')).toContainText('no se aplicó');
    // Un solo aquí, el de A; B no reformula ni reintenta por su cuenta.
    expect(servidor.actual.estado.aqui).toEqual({ paradaId: TIENDAS, revision: aquiDeA });
    const r = (await raiz(b.page))!;
    expect(r.estado.aqui.paradaId).toBe(TIENDAS);
    expect(Object.values(r.estado.paradas).filter((p) => p.marca === 'aqui')).toHaveLength(1);
    expect(r.cola.filter((e) => e.rechazo && !e.resolucion)).toHaveLength(1);
    const ids = servidor.posts.map((p) => p.id);
    expect(new Set(ids).size).toBe(ids.length);

    await revisar.click();
    await expect(revisar).toHaveCount(0);
    expect((await raiz(b.page))!.cola.every((e) => !e.rechazo || e.resolucion === 'conservar-confirmado')).toBe(true);
    await expect(b.page.locator('#red')).toBeHidden();
    expect([...a.errores, ...b.errores]).toEqual([]);
  });

  test('respuesta perdida: tras reabrir se reenvía el mismo original y no se duplica', async ({ browser }) => {
    servidor.perderRespuesta = true;
    const a = await movil(browser, servidor);
    await marcarHecha(a.page);
    await expect(a.page.locator('#red')).toContainText('Sin confirmar');
    await expect.poll(() => servidor.posts.length).toBe(1);
    expect(servidor.actual.revisionServidor).toBe(1);
    const pendiente = (await raiz(a.page))!.cola;
    expect(pendiente).toHaveLength(1);
    expect(pendiente[0].enviada).toBe(true);

    // Reabrir: la cola sigue en IndexedDB y el arranque reenvía el MISMO original.
    servidor.perderRespuesta = false;
    await a.page.close();
    const otra = await abrirPagina(a.contexto);
    await expect.poll(async () => (await raiz(otra))!.cola.length).toBe(0);
    expect(servidor.posts.map((p) => p.id)).toEqual([pendiente[0].operacion.id, pendiente[0].operacion.id]);
    expect(servidor.actual.revisionServidor).toBe(1);
    expect((await raiz(otra))!.estado.paradas[LANXIN].marca).toBe('hecha');
    await expect(otra.locator('#red')).toBeHidden();
  });

  test('sin sesión: lo marcado se queda en el móvil y se ofrece Entrar sin redirigir', async ({ browser }) => {
    servidor.sesion = false;
    const a = await movil(browser, servidor);
    await marcarHecha(a.page);
    const pildora = a.page.locator('#red');
    await expect(pildora).toContainText('Sin sesión');
    await expect(pildora).toContainText('1 sin enviar');
    expect(servidor.posts).toHaveLength(0);
    expect(new URL(a.page.url()).pathname).toBe('/');
    await pildora.click();
    await expect(a.page.locator('#toast-accion')).toHaveText('Entrar');
    expect((await raiz(a.page))!.cola).toHaveLength(1);

    servidor.sesion = true;
    await sincronizarDesdeTodo(a.page);
    await expect.poll(() => servidor.actual.estado.paradas[LANXIN]?.marca).toBe('hecha');
    await expect.poll(async () => (await raiz(a.page))!.cola.length).toBe(0);
  });

  test('deshacer: sin enviar se cancela; enviado se compensa sin tocar lo demás', async ({ browser }) => {
    servidor.sesion = false;
    const a = await movil(browser, servidor);
    await marcarHecha(a.page);
    await a.page.locator('#toast-accion').click();
    await expect(a.page.locator('#ahora')).toContainText('Lanxin');
    expect((await raiz(a.page))!.cola).toHaveLength(0);
    expect(servidor.posts).toHaveLength(0);

    servidor.sesion = true;
    await a.page.locator('.pestana.todo').click();
    await a.page.locator(`input[data-pendiente-id="${EQUIPAJE}"]`).check();
    await expect.poll(() => servidor.actual.estado.pendientes[EQUIPAJE]?.hecho).toBe(true);
    await a.page.reload();
    await marcarHecha(a.page);
    await expect.poll(() => servidor.actual.estado.paradas[LANXIN]?.marca).toBe('hecha');
    await a.page.locator('#toast-accion').click();
    await expect.poll(() => servidor.actual.estado.paradas[LANXIN]?.marca ?? null).toBe(null);
    // El deshacer es una operación propia: la casilla de antes sigue hecha.
    expect(servidor.actual.estado.pendientes[EQUIPAJE].hecho).toBe(true);
    expect(servidor.posts.at(-1)!.cuerpo).toContain('"tipo":"deshacer"');
  });

  test('lo marcado antes en este móvil se importa tal cual, sin tocar las claves antiguas', async ({ browser }) => {
    const legado = {
      marcas: '{"2026-10-22|13:00|Lanxin (Lyceum Restaurant)":"hecha","2026-10-22|99:99|Desconocida":"aqui"}',
      'marcas-hora': '{"2026-10-22|13:00|Lanxin (Lyceum Restaurant)":29877930}',
      'pendientes-hechos': '["Equipaje: verificar la franquicia',
    };
    const a = await movil(browser, servidor, legado);
    await expect(a.page.locator('#ahora')).toContainText('Más tiendas');
    const r = (await raiz(a.page))!;
    expect(r.formato).toBe(3);
    expect(r.legado!.originales).toEqual(legado);
    expect(r.legado!.recuperacion.map((x) => `${x.campo}:${x.motivo}`).sort())
      .toEqual(['marcas:desconocida', 'pendientes-hechos:malformada']);
    await a.page.locator('.pestana.todo').click();
    await expect(a.page.locator('#compartido')).toContainText('no se pudieron pasar');
    const claves = await a.page.evaluate(() => ['marcas', 'marcas-hora', 'pendientes-hechos'].map((k) => localStorage.getItem(k)));
    expect(claves).toEqual([legado.marcas, legado['marcas-hora'], legado['pendientes-hechos']]);
    await expect.poll(() => servidor.actual.estado.paradas[LANXIN]?.marca).toBe('hecha');

    // Al reabrir no se vuelve a importar ni se reescriben las claves.
    await a.page.close();
    const otra = await abrirPagina(a.contexto);
    await expect(otra.locator('#ahora')).toContainText('Más tiendas');
    expect((await raiz(otra))!.legado!.originales).toEqual(legado);
    expect(await otra.evaluate(() => ['marcas', 'marcas-hora', 'pendientes-hechos'].map((k) => localStorage.getItem(k))))
      .toEqual(claves);
  });

  test('si no se puede abrir lo guardado, el itinerario sigue y no se marca hasta reintentar', async ({ browser }) => {
    const contexto = await browser.newContext({ baseURL: 'http://localhost:4173', locale: 'es-ES',
      viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, serviceWorkers: 'block' });
    await contexto.route(/^https?:\/\/(?!localhost)/, (r) => r.abort());
    await contexto.route((url) => url.pathname === '/api/progreso', (route) => atender(route, servidor, { cortada: false }));
    await contexto.addInitScript(() => {
      localStorage.setItem('marcador', 'true');
      const abrir = IDBFactory.prototype.open;
      let fallos = 1;
      IDBFactory.prototype.open = function (this: IDBFactory, ...args: Parameters<IDBFactory['open']>) {
        if (fallos-- > 0) throw new DOMException('Fallo inyectado', 'UnknownError');
        return abrir.apply(this, args);
      };
    });
    const page = await abrirPagina(contexto);
    const hecha = page.locator('#ahora [data-marcar="hecha"]').first();
    await expect(page.locator('#red')).toContainText('Marcas sin abrir');
    await expect(hecha).toHaveAttribute('aria-disabled', 'true');
    // aria-disabled no impide el toque (Playwright lo considera deshabilitado: se fuerza).
    await hecha.click({ force: true });
    await expect(page.locator('#toast-texto')).toContainText('No se puede marcar');
    expect(await raiz(page)).toBeUndefined();
    // El resto sigue: la tarjeta del hotel se abre y se cierra.
    await page.locator('#btn-hotel').click();
    await expect(page.locator('#taxi')).toBeVisible();
    await page.locator('#taxi-cerrar').click();

    await page.locator('#red').click();
    await expect(page.locator('#toast-accion')).toHaveText('Reintentar');
    await page.locator('#toast-accion').click();
    await expect(hecha).not.toHaveAttribute('aria-disabled', 'true');
    await marcarHecha(page);
    expect((await raiz(page))!.estado.paradas[LANXIN].marca).toBe('hecha');
  });
  test('Reintentar tras una apertura fallida recupera la sincronización real con el servidor', async ({ browser }) => {
    const contexto = await browser.newContext({ baseURL: 'http://localhost:4173', locale: 'es-ES',
      viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, serviceWorkers: 'block' });
    await contexto.route(/^https?:\/\/(?!localhost)/, (r) => r.abort());
    await contexto.route((url) => url.pathname === '/api/progreso', (route) => atender(route, servidor, { cortada: false }));
    await contexto.addInitScript(() => {
      localStorage.setItem('marcador', 'true');
      const abrir = IDBFactory.prototype.open;
      let fallos = 1;
      IDBFactory.prototype.open = function (this: IDBFactory, ...args: Parameters<IDBFactory['open']>) {
        if (fallos-- > 0) throw new DOMException('Fallo inyectado', 'UnknownError');
        return abrir.apply(this, args);
      };
    });
    const page = await abrirPagina(contexto);
    // El arranque ya pidió sincronizar con la apertura fallida: no hubo red ni marcas que enviar.
    await expect(page.locator('#red')).toContainText('Marcas sin abrir');
    expect(servidor.lecturas + servidor.posts.length).toBe(0);

    await page.locator('#red').click();
    await expect(page.locator('#toast-accion')).toHaveText('Reintentar');
    await page.locator('#toast-accion').click();
    await marcarHecha(page);
    // La marca guardada dispara el envío sin recargar la página: GET, POST del original y acuse.
    await expect.poll(() => servidor.actual.estado.paradas[LANXIN]?.marca).toBe('hecha');
    expect(servidor.lecturas).toBeGreaterThanOrEqual(1);
    expect(servidor.posts).toHaveLength(1);
    await expect.poll(async () => (await raiz(page))!.cola.length).toBe(0);
    await expect(page.locator('#red')).toBeHidden();

    // «Sincronizar ahora» vuelve a leer de verdad (no una promesa ya resuelta): otra lectura y ningún reenvío.
    const lecturas = servidor.lecturas;
    await sincronizarDesdeTodo(page);
    await expect.poll(() => servidor.lecturas).toBeGreaterThan(lecturas);
    expect(servidor.posts).toHaveLength(1);
  });
  test('apertura fallida: marcas, ficha y casillas con aria-disabled exacto, enfocables y explicando por qué', async ({ browser }) => {
    const contexto = await browser.newContext({ baseURL: 'http://localhost:4173', locale: 'es-ES',
      viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, serviceWorkers: 'block' });
    await contexto.route(/^https?:\/\/(?!localhost)/, (r) => r.abort());
    await contexto.route((url) => url.pathname === '/api/progreso', (route) => atender(route, servidor, { cortada: false }));
    await contexto.addInitScript(() => {
      localStorage.setItem('marcador', 'true');
      const abrir = IDBFactory.prototype.open;
      let fallos = 1;
      IDBFactory.prototype.open = function (this: IDBFactory, ...args: Parameters<IDBFactory['open']>) {
        if (fallos-- > 0) throw new DOMException('Fallo inyectado', 'UnknownError');
        return abrir.apply(this, args);
      };
    });
    const page = await abrirPagina(contexto);
    await expect(page.locator('#red')).toContainText('Marcas sin abrir');
    // «Ahora»: el botón dice exactamente aria-disabled="true".
    await expect(page.locator('#ahora [data-marcar="hecha"]').first()).toHaveAttribute('aria-disabled', 'true');

    // Ficha: el selector también, con valor explícito (nunca un atributo vacío).
    await page.locator('#contenido li.parada .fila', { hasText: 'Lanxin' }).click();
    const fijar = page.locator('#contenido li.parada.abierta [data-fijar="hecha"]');
    await expect(fijar).toHaveAttribute('aria-disabled', 'true');
    // La hoja sube al abrir la ficha: se espera a que llegue arriba antes de tocar.
    await expect(page.locator('#asa')).toHaveAttribute('aria-expanded', 'true');
    await fijar.scrollIntoViewIfNeeded();
    await fijar.click({ force: true });
    await expect(page.locator('#toast-texto')).toContainText('No se puede marcar');
    await expect(fijar).toHaveAttribute('aria-pressed', 'false');

    // Casilla: apagada pero enfocable (sin disabled nativo); el espacio no la marca y dice por qué.
    await page.locator('.pestana.todo').click();
    const casilla = page.locator(`input[data-pendiente-id="${EQUIPAJE}"]`);
    await expect(casilla).toHaveAttribute('aria-disabled', 'true');
    expect(await casilla.evaluate((c) => (c as HTMLInputElement).disabled)).toBe(false);
    await casilla.focus();
    await expect(casilla).toBeFocused();
    await page.locator('#toast').evaluate((t) => { (t as HTMLElement).hidden = true; });
    await page.keyboard.press('Space');
    await expect(page.locator('#toast-texto')).toContainText('No se puede marcar');
    await expect(casilla).not.toBeChecked();
    await expect(casilla).toBeFocused();
    await page.locator('label', { has: casilla }).click({ force: true });
    await expect(casilla).not.toBeChecked();
    expect(await raiz(page)).toBeUndefined();
    expect(servidor.posts).toHaveLength(0);

    // Reintentar: ya no está apagada (atributo ausente o "false", nunca vacío) y el espacio la guarda y la envía.
    await page.locator('#red').click();
    await expect(page.locator('#toast-accion')).toHaveText('Reintentar');
    await page.locator('#toast-accion').click();
    await expect(casilla).not.toHaveAttribute('aria-disabled', 'true');
    expect(await casilla.getAttribute('aria-disabled')).not.toBe('');
    await casilla.focus();
    await page.keyboard.press('Space');
    await expect.poll(() => servidor.actual.estado.pendientes[EQUIPAJE]?.hecho).toBe(true);
    await expect.poll(async () => (await raiz(page))!.cola.length).toBe(0);
    await expect(casilla).toBeChecked();
    expect(servidor.posts).toHaveLength(1);
    await expect(casilla).not.toHaveAttribute('aria-disabled', 'true');
    expect(await casilla.getAttribute('aria-disabled')).not.toBe('');
  });
});
