import { describe, expect, it, vi } from 'vitest';
import { crearRouterViaje, type ConfiguracionRouterViaje } from '../../servidor/router';
import { crearControladorSesiones, type RegistroSesion, type RepositorioSesiones } from '../../servidor/sesiones';

const solicitar = (ruta = '/', opciones: RequestInit = {}) =>
  new Request(`https://viaje.test${ruta}`, opciones);
const actor: RegistroSesion = {
  id: '00000000-0000-4000-8000-000000000001', huella: 'a'.repeat(64), viajeId: 'viaje',
  dispositivoId: 'movil', creadaEn: 0, venceEn: 999999, revocada: false,
};
function preparar() {
  const sesiones = {
    atender: vi.fn(async (_solicitud: Request, _contexto?: { identidadRed: string }) => new Response('sesiones')),
    autenticar: vi.fn(async (_solicitud: Request): Promise<RegistroSesion | null> => actor),
  };
  const progreso = { atender: vi.fn(async (_solicitud: Request) => new Response('progreso')) };
  const assets = { fetch: vi.fn(async (_solicitud: Request) => new Response('privado')) };
  // Solo fixture sintética: la UI real obligatoria se compondrá en otra unidad.
  const proveerRespuestaEntrada = vi.fn(async (_solicitud: Request) => new Response('<p>Fixture</p>', {
    headers: { 'Content-Type': 'text/html; charset=utf-8' },
  }));
  const configuracion = { sesiones, progreso, assets, proveerRespuestaEntrada };
  return { ...configuracion, configuracion, router: () => crearRouterViaje(configuracion) };
}
function privada(respuesta: Response) {
  expect(respuesta.headers.get('Cache-Control')).toBe('private, no-store');
  expect(respuesta.headers.get('Pragma')).toBe('no-cache');
  expect(respuesta.headers.get('Vary')?.split(',').map((v) => v.trim().toLowerCase())).toContain('cookie');
  expect(respuesta.headers.get('X-Content-Type-Options')).toBe('nosniff');
}

describe('router puro del viaje', () => {
  it.each(['GET', 'POST', 'HEAD'])('listado %s conserva Request/Response y método del puerto', async (method) => {
    const p = preparar(); const solicitud = solicitar('/api/fotos/listado', { method,
      ...(method === 'POST' ? { body: 'cuerpo intacto' } : {}) });
    const respuesta = new Response(method === 'HEAD' ? null : 'exacto', { status: 405, headers: { Allow: 'GET' } });
    const listadoFotos = { atender: vi.fn(async function (this: unknown, original: Request) {
      expect(this).toBe(listadoFotos); expect(original).toBe(solicitud); return respuesta;
    }) };
    const router = crearRouterViaje({ ...p.configuracion, listadoFotos }); const capturado = listadoFotos.atender;
    listadoFotos.atender = vi.fn(async () => new Response('mutado'));
    expect(await router.atender(solicitud)).toBe(respuesta);
    expect(capturado).toHaveBeenCalledOnce(); expect(listadoFotos.atender).not.toHaveBeenCalled();
    expect(solicitud.bodyUsed).toBe(false); expect(p.sesiones.autenticar).not.toHaveBeenCalled();
    expect(p.assets.fetch).not.toHaveBeenCalled();
  });
  it.each(['ausente', 'lanza'])('listado %s da 503 privado sin assets/auth/fallback', async (modo) => {
    const p = preparar(); const listadoFotos = { atender: vi.fn(async () => { throw new Error('privado'); }) };
    const router = crearRouterViaje({ ...p.configuracion, ...(modo === 'lanza' ? { listadoFotos } : {}) });
    const r = await router.atender(solicitar('/api/fotos/listado')); expect(r.status).toBe(503); privada(r);
    expect(p.sesiones.autenticar).not.toHaveBeenCalled(); expect(p.assets.fetch).not.toHaveBeenCalled();
  });
  it('listado accessor se rechaza sin invocarlo', () => {
    const p = preparar(); const getter = vi.fn(); const listadoFotos = Object.defineProperty({}, 'atender', { get: getter });
    expect(() => crearRouterViaje({ ...p.configuracion, listadoFotos } as unknown as ConfiguracionRouterViaje)).toThrow();
    expect(getter).not.toHaveBeenCalled();
  });
  it.each(['/api/fotos/respaldo', '/api/fotos/ABC%2FDEF/original'])('delega fotos %s sin filtrar método, consumir ni envolver', async (ruta) => {
    const p = preparar(); const solicitud = solicitar(ruta, { method: 'POST', body: 'cuerpo intacto',
      headers: { Origin: 'https://ajeno.test', Cookie: 'cookie-original' } });
    const respuesta = new Response('bytes exactos\0', { status: 405, headers: { Allow: 'GET',
      'Cache-Control': 'private, no-store', Vary: 'Cookie', 'X-Content-Type-Options': 'nosniff', 'X-Puerto': 'sin cambios' } });
    const fotos = { atender: vi.fn(async (original: Request) => {
      expect(original).toBe(solicitud); expect(original.bodyUsed).toBe(false); return respuesta;
    }) };
    const router = crearRouterViaje({ ...p.configuracion, fotos });
    fotos.atender = vi.fn(async () => { throw new Error('Método posterior no capturado'); });
    expect(await router.atender(solicitud)).toBe(respuesta);
    expect(await respuesta.text()).toBe('bytes exactos\0');
    expect(respuesta.headers.get('X-Puerto')).toBe('sin cambios');
    expect(solicitud.bodyUsed).toBe(false); expect(fotos.atender).not.toHaveBeenCalled();
    expect(p.sesiones.autenticar).not.toHaveBeenCalled(); expect(p.assets.fetch).not.toHaveBeenCalled();
    expect(p.progreso.atender).not.toHaveBeenCalled(); expect(p.proveerRespuestaEntrada).not.toHaveBeenCalled();
  });

  it.each(['/api/fotos', '/api/fotos/listado/', '/api/fotos/%6cistado', '/api/fotos/respaldo/', '/api/fotos/a/b/original'])('foto no reconocida %s no cae en puerto/assets', async (ruta) => {
    const p = preparar(); const fotos = { atender: vi.fn(async () => new Response('no usar')) };
    const r = await crearRouterViaje({ ...p.configuracion, fotos }).atender(solicitar(ruta));
    expect(r.status).toBe(404); privada(r); expect(fotos.atender).not.toHaveBeenCalled();
    expect(p.assets.fetch).not.toHaveBeenCalled(); expect(p.sesiones.autenticar).not.toHaveBeenCalled();
  });

  it.each(['ausente', 'lanza'])('puerto foto %s falla privado sin fallback', async (modo) => {
    const p = preparar(); const fotos = { atender: vi.fn(async () => { throw new Error('detalle privado'); }) };
    const router = crearRouterViaje({ ...p.configuracion, ...(modo === 'lanza' ? { fotos } : {}) });
    const r = await router.atender(solicitar('/api/fotos/respaldo', { method: 'POST', body: 'sin leer' }));
    expect(r.status).toBe(503); privada(r); expect(await r.text()).not.toContain('detalle privado');
    expect(p.assets.fetch).not.toHaveBeenCalled(); expect(p.sesiones.autenticar).not.toHaveBeenCalled();
    expect((await router.atender(solicitar('/entrar'))).status).toBe(200);
  });

  it('espera autoridad de sesión antes de servir ASSETS', async () => {
    const p = preparar();
    let resolver!: (valor: RegistroSesion | null) => void;
    p.sesiones.autenticar.mockImplementation(() => new Promise((r) => { resolver = r; }));
    const solicitud = solicitar('/app.js');
    const pendiente = p.router().atender(solicitud);
    expect(p.assets.fetch).not.toHaveBeenCalled();
    resolver(actor);
    const respuesta = await pendiente;
    expect(p.sesiones.autenticar).toHaveBeenCalledWith(solicitud);
    expect(p.assets.fetch).toHaveBeenCalledWith(solicitud);
    privada(respuesta);
    expect(await respuesta.text()).toBe('privado');
  });

  it.each(['/api/sesion', '/api/sesiones', '/api/sesiones/UUID', '/api/sesiones/a/b', '/api/sesiones/%E4%B8%AD'])
  ('delega sesión original sin autenticar desde router: %s', async (ruta) => {
    const p = preparar();
    const solicitud = solicitar(ruta, { method: 'POST', body: '{"clave":"fixture"}', headers: {
      Origin: 'https://ajeno.test', Cookie: '__Host-viaje=fixture', 'CF-Connecting-IP': 'falsa',
      Forwarded: 'for=falsa', 'X-Real-IP': 'falsa',
    }, signal: AbortSignal.abort() });
    const respuesta = new Response(null, { status: 429, headers: {
      'Retry-After': '600', 'Set-Cookie': '__Host-viaje=opaca; Secure', 'Cache-Control': 'private, no-store',
    } });
    p.sesiones.atender.mockResolvedValue(respuesta);
    expect(await p.router().atender(solicitud)).toBe(respuesta);
    expect(p.sesiones.atender).toHaveBeenCalledWith(solicitud, undefined);
    expect(solicitud.bodyUsed).toBe(false);
    expect(p.sesiones.autenticar).not.toHaveBeenCalled();
    expect(p.progreso.atender).not.toHaveBeenCalled();
    expect(p.assets.fetch).not.toHaveBeenCalled();
    expect(p.proveerRespuestaEntrada).not.toHaveBeenCalled();
  });

  it.each([200, 304, 401, 404, 405, 409, 503])('conserva progreso y su respuesta %s sin otro gate', async (estado) => {
    const p = preparar();
    const solicitud = solicitar('/api/progreso', { method: 'POST', body: 'original', headers: { Origin: 'https://ajeno.test' } });
    const respuesta = new Response(estado === 304 ? null : 'del controlador', { status: estado, headers: {
      ETag: '"revision"', 'Set-Cookie': '__Host-viaje=; Secure', Allow: 'GET, POST',
    } });
    p.progreso.atender.mockResolvedValue(respuesta);
    expect(await p.router().atender(solicitud)).toBe(respuesta);
    expect(p.progreso.atender).toHaveBeenCalledWith(solicitud);
    expect(solicitud.bodyUsed).toBe(false);
    expect(p.sesiones.autenticar).not.toHaveBeenCalled();
    expect(p.assets.fetch).not.toHaveBeenCalled();
  });

  it('solo reenvía identidad explícita de infraestructura, capturada sin campos adicionales', async () => {
    const p = preparar();
    const contexto = { identidadRed: 'red-confiable' };
    const solicitud = solicitar('/api/sesion?identidadRed=falsa', { method: 'POST', body: '{"identidadRed":"falsa"}',
      headers: { 'CF-Connecting-IP': 'falsa', 'X-Real-IP': 'falsa', Forwarded: 'for=falsa' } });
    await p.router().atender(solicitud, contexto);
    const recibido = p.sesiones.atender.mock.calls[0][1];
    expect(recibido).toEqual(contexto);
    expect(recibido).not.toBe(contexto);
    expect(Object.isFrozen(recibido)).toBe(true);
    expect(solicitud.bodyUsed).toBe(false);
  });

  it.each(['/api', '/api/desconocida', '/api/sesion/', '/api/progreso/', '/api/%70rogreso', '/api/SESION'])
  ('API desconocida %s nunca cae en ASSETS/entrada', async (ruta) => {
    const p = preparar();
    const respuesta = await p.router().atender(solicitar(ruta, { headers: { Accept: 'text/html' } }));
    expect(respuesta.status).toBe(404);
    expect(respuesta.headers.get('Content-Type')).toContain('application/json');
    privada(respuesta);
    expect(p.sesiones.atender).not.toHaveBeenCalled();
    expect(p.sesiones.autenticar).not.toHaveBeenCalled();
    expect(p.assets.fetch).not.toHaveBeenCalled();
    expect(p.proveerRespuestaEntrada).not.toHaveBeenCalled();
  });

  it.each(['/', '/app.css', '/entrar', '/api/sesion', '/api/progreso'])('HTTP falla cerrado, sin redirección: %s', async (ruta) => {
    const p = preparar();
    const respuesta = await p.router().atender(new Request(`http://viaje.test${ruta}`, {
      headers: { 'X-Forwarded-Proto': 'https' },
    }));
    expect(respuesta.status).toBe(400);
    expect(respuesta.headers.get('Location')).toBeNull();
    privada(respuesta);
    expect(p.sesiones.atender).not.toHaveBeenCalled();
    expect(p.progreso.atender).not.toHaveBeenCalled();
    expect(p.assets.fetch).not.toHaveBeenCalled();
    expect(p.proveerRespuestaEntrada).not.toHaveBeenCalled();
  });

  it.each(['GET', 'HEAD'])('entrada pública %s usa solo el puerto UI y elimina cookies', async (metodo) => {
    const p = preparar();
    const solicitud = solicitar('/entrar?returnTo=https://ajeno.test', { method: metodo, headers: { Cookie: 'vigente' } });
    const original = new Response('<p>Fixture</p>', { headers: {
      'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'public, max-age=999',
      'Set-Cookie': '__Host-viaje=falsa; Secure', 'Content-Security-Policy': "default-src 'none'", Vary: 'Accept-Encoding',
    } });
    p.proveerRespuestaEntrada.mockResolvedValue(original);
    const respuesta = await p.router().atender(solicitud);
    expect(p.proveerRespuestaEntrada).toHaveBeenCalledWith(solicitud);
    expect(p.sesiones.autenticar).not.toHaveBeenCalled();
    expect(p.assets.fetch).not.toHaveBeenCalled();
    expect(respuesta.status).toBe(200);
    expect(respuesta.headers.get('Set-Cookie')).toBeNull();
    expect(respuesta.headers.get('Content-Security-Policy')).toBe("default-src 'none'");
    expect(respuesta.headers.get('Vary')).toBe('Accept-Encoding, Cookie');
    expect(original.headers.get('Cache-Control')).toBe('public, max-age=999');
    privada(respuesta);
    if (metodo === 'HEAD') expect(respuesta.body).toBeNull();
    else expect(await respuesta.text()).toBe('<p>Fixture</p>');
  });

  it.each([
    new Response('json', { headers: { 'Content-Type': 'application/json' } }),
    new Response('html sin tipo'),
    new Response('no', { status: 503, headers: { 'Content-Type': 'text/html' } }),
    new Response(null, { status: 302, headers: { Location: 'https://ajeno.test', 'Content-Type': 'text/html' } }),
    { status: 200, headers: new Headers({ 'Content-Type': 'text/html' }) },
  ])('entrada inválida falla sin diagnóstico ni fallback %#', async (valor) => {
    const p = preparar();
    p.proveerRespuestaEntrada.mockResolvedValue(valor as Response);
    const respuesta = await p.router().atender(solicitar('/entrar'));
    expect(respuesta.status).toBe(503);
    privada(respuesta);
    expect(respuesta.headers.get('Location')).toBeNull();
    expect(p.assets.fetch).not.toHaveBeenCalled();
  });

  it.each(['sesiones', 'progreso', 'entrada', 'autenticar', 'assets'] as const)('error de %s se oculta', async (puerto) => {
    const p = preparar();
    const error = new Error('token-clave-diagnostico-secreto');
    let ruta = '/';
    if (puerto === 'sesiones') { p.sesiones.atender.mockRejectedValue(error); ruta = '/api/sesion'; }
    if (puerto === 'progreso') { p.progreso.atender.mockRejectedValue(error); ruta = '/api/progreso'; }
    if (puerto === 'entrada') { p.proveerRespuestaEntrada.mockRejectedValue(error); ruta = '/entrar'; }
    if (puerto === 'autenticar') p.sesiones.autenticar.mockRejectedValue(error);
    if (puerto === 'assets') p.assets.fetch.mockRejectedValue(error);
    const respuesta = await p.router().atender(solicitar(ruta));
    expect(respuesta.status).toBe(503);
    privada(respuesta);
    expect(await respuesta.text()).not.toContain(error.message);
    expect(respuesta.headers.get('Set-Cookie')).toBeNull();
    if (puerto !== 'assets') expect(p.assets.fetch).not.toHaveBeenCalled();
  });

  it.each(['text/html', 'text/html;q=0.8,application/xhtml+xml', 'TEXT/HTML; q=1'])
  ('sin sesión navegación %s redirige solo a /entrar', async (accept) => {
    const p = preparar();
    p.sesiones.autenticar.mockResolvedValue(null);
    const respuesta = await p.router().atender(solicitar('/privado?clave=secreta&returnTo=https://ajeno.test', { headers: { Accept: accept } }));
    expect(respuesta.status).toBe(303);
    expect(respuesta.headers.get('Location')).toBe('/entrar');
    privada(respuesta);
    expect(p.assets.fetch).not.toHaveBeenCalled();
    expect(p.proveerRespuestaEntrada).not.toHaveBeenCalled();
  });

  it.each(['*/*', 'text/css', 'image/png', 'text/html;q=0', 'text/html;q=no', 'text/html;q=2'])
  ('sin sesión recurso %s recibe JSON401, no HTML', async (accept) => {
    const p = preparar();
    p.sesiones.autenticar.mockResolvedValue(null);
    const respuesta = await p.router().atender(solicitar('/app.css', { headers: { Accept: accept } }));
    expect(respuesta.status).toBe(401);
    expect(respuesta.headers.get('Location')).toBeNull();
    expect(respuesta.headers.get('Content-Type')).toContain('application/json');
    privada(respuesta);
    expect(p.assets.fetch).not.toHaveBeenCalled();
  });

  it('revalida cada petición; una cookie/lectura previa no autoriza revocada/caducada', async () => {
    const p = preparar();
    const router = p.router();
    const solicitud = solicitar('/app.js', { headers: { Cookie: 'misma-cookie' } });
    expect((await router.atender(solicitud)).status).toBe(200);
    p.sesiones.autenticar.mockResolvedValue(null);
    expect((await router.atender(solicitud)).status).toBe(401);
    expect((await router.atender(solicitud)).status).toBe(401);
    expect(p.sesiones.autenticar).toHaveBeenCalledTimes(3);
    expect(p.assets.fetch).toHaveBeenCalledTimes(1);
  });

  it.each([200, 206, 301, 304, 404])('ASSETS autorizado conserva estado %s y cabeceras', async (estado) => {
    const p = preparar();
    const original = new Response([301, 304].includes(estado) ? null : 'bytes', { status: estado, headers: {
      'Content-Type': 'image/png', ETag: '"archivo"', 'Content-Range': 'bytes 0-4/5',
      'Cache-Control': 'public, max-age=999', Vary: 'Accept-Encoding', Location: '/canonica',
    } });
    p.assets.fetch.mockResolvedValue(original);
    const solicitud = solicitar('/imagen.png');
    const respuesta = await p.router().atender(solicitud);
    expect(respuesta.status).toBe(estado);
    for (const nombre of ['Content-Type', 'ETag', 'Content-Range', 'Location']) {
      expect(respuesta.headers.get(nombre)).toBe(original.headers.get(nombre));
    }
    expect(p.assets.fetch).toHaveBeenCalledWith(solicitud);
    privada(respuesta);
  });

  it.each([500, 502, 503])('ASSETS %s no publica diagnóstico', async (estado) => {
    const p = preparar();
    p.assets.fetch.mockResolvedValue(new Response('secreto-proveedor', { status: estado }));
    const respuesta = await p.router().atender(solicitar('/'));
    expect(respuesta.status).toBe(503);
    expect(await respuesta.text()).not.toContain('secreto-proveedor');
  });

  it.each(['/entrar', '/', '/app.js'])('rechaza mutaciones no API: %s', async (ruta) => {
    const p = preparar();
    const respuesta = await p.router().atender(solicitar(ruta, { method: 'POST', body: 'sin leer' }));
    expect(respuesta.status).toBe(405);
    expect(respuesta.headers.get('Allow')).toBe('GET, HEAD');
    privada(respuesta);
    expect(p.assets.fetch).not.toHaveBeenCalled();
    expect(p.sesiones.autenticar).not.toHaveBeenCalled();
    expect(p.proveerRespuestaEntrada).not.toHaveBeenCalled();
  });

  it.each(['/api/ausente', '/entrar', '/app.js'])('HEAD en respuesta propia nunca tiene cuerpo: %s', async (ruta) => {
    const p = preparar();
    p.sesiones.autenticar.mockResolvedValue(null);
    const respuesta = await p.router().atender(solicitar(ruta, { method: 'HEAD' }));
    expect(respuesta.body).toBeNull();
    privada(respuesta);
  });

  it('HEAD autenticado conserva metadatos sin leer el stream de ASSETS', async () => {
    const p = preparar();
    const tirar = vi.fn();
    const stream = new ReadableStream({ pull: tirar }, { highWaterMark: 0 });
    p.assets.fetch.mockResolvedValue(new Response(stream, { headers: { ETag: '"x"' } }));
    const respuesta = await p.router().atender(solicitar('/app.js', { method: 'HEAD' }));
    expect(respuesta.body).toBeNull();
    expect(respuesta.headers.get('ETag')).toBe('"x"');
    expect(tirar).not.toHaveBeenCalled();
  });

  it.each(['entrada', 'assets'] as const)('rechaza cuerpo ya consumido de %s', async (puerto) => {
    const p = preparar();
    const respuesta = new Response('fixture', { headers: { 'Content-Type': 'text/html' } });
    await respuesta.text();
    if (puerto === 'entrada') p.proveerRespuestaEntrada.mockResolvedValue(respuesta);
    else p.assets.fetch.mockResolvedValue(respuesta);
    expect((await p.router().atender(solicitar(puerto === 'entrada' ? '/entrar' : '/'))).status).toBe(503);
  });

  it('captura referencias/métodos de configuración sin depender de cambios posteriores', async () => {
    const p = preparar();
    const router = p.router();
    const anterior = p.assets.fetch;
    p.assets.fetch = vi.fn(async () => new Response('reemplazo'));
    p.configuracion.proveerRespuestaEntrada = vi.fn(async () => new Response('no HTML'));
    expect(await (await router.atender(solicitar('/'))).text()).toBe('privado');
    expect(anterior).toHaveBeenCalledOnce();
    expect((await router.atender(solicitar('/entrar'))).status).toBe(200);
  });

  it.each(['ausente', 'símbolo', 'extra', 'getter', 'método', 'puertoGetter'] as const)
  ('configuración inválida %s falla sin ejecutar getters/filtrar datos', (caso) => {
    const p = preparar();
    const c: Record<PropertyKey, unknown> = { ...p.configuracion };
    const getter = vi.fn(() => { throw new Error('secreto'); });
    if (caso === 'ausente') delete c.proveerRespuestaEntrada;
    if (caso === 'símbolo') c[Symbol('extra')] = 'secreto';
    if (caso === 'extra') c.otra = 'secreto';
    if (caso === 'getter') Object.defineProperty(c, 'assets', { get: getter });
    if (caso === 'método') c.sesiones = { atender: 4, autenticar: p.sesiones.autenticar };
    if (caso === 'puertoGetter') c.assets = Object.defineProperty({}, 'fetch', { get: getter });
    expect(() => crearRouterViaje(c as unknown as ConfiguracionRouterViaje)).toThrow('La configuración del router no es válida.');
    expect(getter).not.toHaveBeenCalled();
  });

  it.each(['', '\0', 'x'.repeat(257), '\ud800'])('contexto inválido no llama al controlador %#', async (identidadRed) => {
    const p = preparar();
    expect((await p.router().atender(solicitar('/api/sesion'), { identidadRed })).status).toBe(503);
    expect(p.sesiones.atender).not.toHaveBeenCalled();
  });

  it('el controlador consume el cuerpo original y observa Origin, cookie y aborto sin sustituciones', async () => {
    const p = preparar();
    const cancelar = new AbortController();
    const solicitud = solicitar('/api/sesion', { method: 'POST', body: '{"clave":"fixture"}',
      headers: { Origin: 'https://ajeno.test', Cookie: 'original' }, signal: cancelar.signal });
    p.sesiones.atender.mockImplementation(async (recibida) => {
      expect(recibida).toBe(solicitud);
      expect(recibida.bodyUsed).toBe(false);
      expect(recibida.headers.get('Origin')).toBe('https://ajeno.test');
      expect(recibida.headers.get('Cookie')).toBe('original');
      expect(await recibida.text()).toBe('{"clave":"fixture"}');
      cancelar.abort();
      expect(recibida.signal.aborted).toBe(true);
      return new Response('propiedad del controlador', { status: 403 });
    });
    expect((await p.router().atender(solicitud)).status).toBe(403);
  });

  it('URL normaliza segmentos antes de elegir API, sin fallback a archivos', async () => {
    const p = preparar();
    await p.router().atender(solicitar('/archivos/../api/progreso'));
    expect(p.progreso.atender).toHaveBeenCalledOnce();
    expect(p.assets.fetch).not.toHaveBeenCalled();
  });

  it('HEAD de API conserva respuesta del controlador; no inventa soporte HEAD', async () => {
    const p = preparar();
    const respuesta = new Response('controlador', { status: 405, headers: { Allow: 'GET, POST' } });
    p.progreso.atender.mockResolvedValue(respuesta);
    expect(await p.router().atender(solicitar('/api/progreso', { method: 'HEAD' }))).toBe(respuesta);
  });

  it.each(['entrada', 'assets'] as const)('cuerpo bloqueado de %s falla cerrado sin lectura', async (puerto) => {
    const p = preparar();
    const respuesta = new Response('fixture', { headers: { 'Content-Type': 'text/html' } });
    const lector = respuesta.body!.getReader();
    try {
      if (puerto === 'entrada') p.proveerRespuestaEntrada.mockResolvedValue(respuesta);
      else p.assets.fetch.mockResolvedValue(respuesta);
      expect((await p.router().atender(solicitar(puerto === 'entrada' ? '/entrar' : '/'))).status).toBe(503);
      expect(respuesta.bodyUsed).toBe(false);
    } finally { lector.releaseLock(); }
  });

  it('ASSETS desconocido no se acepta como Response', async () => {
    const p = preparar();
    p.assets.fetch.mockResolvedValue({ status: 200 } as Response);
    expect((await p.router().atender(solicitar('/'))).status).toBe(503);
  });

  it.each(['autenticar', 'assets', 'entrada'] as const)('HEAD con error de %s es privado y sin cuerpo', async (puerto) => {
    const p = preparar();
    if (puerto === 'autenticar') p.sesiones.autenticar.mockRejectedValue(new Error('secreto'));
    if (puerto === 'assets') p.assets.fetch.mockRejectedValue(new Error('secreto'));
    if (puerto === 'entrada') p.proveerRespuestaEntrada.mockRejectedValue(new Error('secreto'));
    const respuesta = await p.router().atender(solicitar(puerto === 'entrada' ? '/entrar' : '/', { method: 'HEAD' }));
    expect(respuesta.status).toBe(503);
    expect(respuesta.body).toBeNull();
    privada(respuesta);
  });

  it.each(['sinContexto', 'origenAjeno', 'limitada'] as const)
  ('sesión real conserva autoridad HTTP: %s', async (caso) => {
    const p = preparar();
    const admitirIntento = vi.fn(async () => false);
    const verificarClave = vi.fn(async () => false);
    const repositorio: RepositorioSesiones = {
      crear: vi.fn(async () => undefined), leer: vi.fn(async () => null),
      revocar: vi.fn(async () => undefined), admitirIntento,
      listar: vi.fn(async () => null), revocarOtra: vi.fn(async () => 'sin-sesion' as const),
    };
    const sesiones = crearControladorSesiones({ viajeId: 'viaje', repositorio, credenciales: {
      verificarClave, leerCookie: vi.fn(async () => null),
      emitirSesion: vi.fn(async () => ({ token: 'no-se-emite', huella: 'no-se-emite' })),
    } });
    const router = crearRouterViaje({ ...p.configuracion, sesiones });
    const solicitud = solicitar('/api/sesion?identidadRed=falsa', {
      method: 'POST', body: '{"clave":"fixture","dispositivoId":"movil"}', headers: {
        'Content-Type': 'application/json', Origin: caso === 'origenAjeno' ? 'https://ajeno.test' : 'https://viaje.test',
        'CF-Connecting-IP': 'falsa', Forwarded: 'for=falsa', 'X-Real-IP': 'falsa',
      },
    });
    const respuesta = await router.atender(solicitud, caso === 'sinContexto' ? undefined : { identidadRed: 'confiable' });
    expect(respuesta.status).toBe(caso === 'sinContexto' ? 503 : caso === 'origenAjeno' ? 403 : 429);
    expect(admitirIntento).toHaveBeenCalledTimes(caso === 'limitada' ? 1 : 0);
    expect(verificarClave).not.toHaveBeenCalled();
    if (caso === 'limitada') expect(respuesta.headers.get('Retry-After')).toBe('600');
    if (caso === 'origenAjeno') expect(solicitud.bodyUsed).toBe(false);
    expect(p.assets.fetch).not.toHaveBeenCalled();
  });

  it('contexto con getter falla sin ejecutarlo ni derivar IP de cabeceras', async () => {
    const p = preparar();
    const getter = vi.fn(() => 'falsa');
    const contexto = Object.defineProperty({}, 'identidadRed', { get: getter }) as { identidadRed: string };
    expect((await p.router().atender(solicitar('/api/sesion'), contexto)).status).toBe(503);
    expect(getter).not.toHaveBeenCalled();
    expect(p.sesiones.atender).not.toHaveBeenCalled();
  });
});
