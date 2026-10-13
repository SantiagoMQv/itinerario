import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import worker, { type EntornoWorker } from '../../servidor/worker';
import { itinerario } from '../../src/datos/itinerario';
import { crearProgreso } from '../../src/progreso';
import { parsearProgreso, serializarProgreso } from '../../src/progreso-json';
import type { DecisionHistorica } from '../../servidor/almacen-progreso';

const origen = 'https://piloto.example';
const clave = 'clave-sintetica-exclusivamente-local-123456';
const urlBaseDatos = 'postgresql://viajero:clave-sintetica@ep-piloto-test.eu-central-1.aws.neon.tech/viaje?sslmode=require';
const campo = { name: 'resultado', dataTypeID: 25, tableID: 0, columnID: 0,
  dataTypeSize: -1, dataTypeModifier: -1, format: 'text' };
function sobre(resultado: unknown): Response {
  return new Response(JSON.stringify({ command: 'SELECT', rowCount: 1,
    fields: [campo], rows: [[serializarProgreso(resultado)]] }));
}
function preparar() {
  const assets = { fetch: vi.fn(async (_solicitud: Request) => new Response('recurso privado')) };
  const entorno: EntornoWorker = { CLAVE_COMPARTIDA: clave, URL_BASE_DATOS: urlBaseDatos, ASSETS: assets };
  let registro: Record<string, unknown> | null = null;
  let caida = false;
  let perdida = false;
  let perdidaCreacion = false;
  let instantanea = { revisionServidor: 0, estado: crearProgreso(itinerario) };
  let decision: DecisionHistorica | null = null;
  // Doble del transporte HTTP, no de fábricas/controladores/SDK. No hace red ni SQL real.
  const transporte = vi.fn(async (_destino: unknown, opciones: RequestInit) => {
    if (caida) throw new Error(`${urlBaseDatos} ${clave}`);
    const { query, params } = JSON.parse(opciones.body as string) as { query: string; params: string[] };
    if (query.includes('admitir_intento')) return sobre(true);
    if (query.includes('crear_sesion')) {
      registro = { id: params[0], huella: params[1], viajeId: params[2], creadaEn: Number(params[3]),
        venceEn: Number(params[4]), revocada: params[5] === 'true', metadatosTexto: params[6] };
      if (perdidaCreacion) throw new Error('Respuesta perdida después de guardar');
      return sobre({ tipo: 'creada' });
    }
    if (query.includes('leer_sesion')) return sobre(registro);
    if (query.includes('consultar_progreso')) {
      if (perdida) return sobre({ tipo: 'sin-sesion' });
      return sobre({ tipo: 'lectura', instantanea, decision: params[2] === null ? null : decision });
    }
    if (query.includes('confirmar_progreso')) {
      decision = parsearProgreso(params[3]) as DecisionHistorica;
      instantanea = decision.tipo === 'positiva' ? decision.acuse.instantanea : decision.rechazo.instantanea;
      return sobre({ tipo: 'comprometida' });
    }
    throw new Error('Consulta no esperada');
  });
  vi.stubGlobal('fetch', transporte);
  return { entorno, assets, transporte, cambiarRegistro: (cambios: Record<string, unknown>) => {
    registro = { ...registro, ...cambios };
  }, caer: () => { caida = true; }, perder: () => { perdida = true; },
  perderCreacion: () => { perdidaCreacion = true; } };
}
function solicitud(ruta = '/', opciones?: RequestInit) { return new Request(`${origen}${ruta}`, opciones); }
function entrada(ip?: string, cabeceras: Record<string, string> = {}, candidata = clave) {
  return solicitud('/api/sesion', { method: 'POST', headers: { Origin: origen,
    'Content-Type': 'application/json', ...(ip === undefined ? {} : { 'CF-Connecting-IP': ip }), ...cabeceras },
  body: JSON.stringify({ clave: candidata, dispositivoId: 'móvil\u0000ñ' }) });
}
async function iniciar(entorno: EntornoWorker) {
  const respuesta = await worker.fetch(entrada('203.0.113.9'), entorno);
  expect(respuesta.status).toBe(201);
  const cookie = respuesta.headers.get('Set-Cookie');
  expect(cookie).toContain('Secure; HttpOnly; SameSite=Lax');
  const datos = await respuesta.json() as { sesion: { viajeId: string } };
  expect(datos.sesion.viajeId).toBe(itinerario.id);
  return cookie!.split(';', 1)[0];
}
async function privada(respuesta: Response, estado: number) {
  expect(respuesta.status).toBe(estado);
  expect(respuesta.headers.get('Cache-Control')).toBe('private, no-store');
  expect(respuesta.headers.get('Vary')).toBe('Cookie');
  expect(respuesta.headers.get('Set-Cookie')).toBeNull();
  const texto = await respuesta.text();
  expect(texto).not.toContain(urlBaseDatos);
  expect(texto).not.toContain(clave);
  expect(texto).not.toContain('stack');
}
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe('Worker local: composición real y configuración privada', () => {
  it('HTTP precede también a descriptores y métodos de fotos', async () => {
    const f = preparar(); const getter = vi.fn(() => { throw new Error('No inspeccionar fotos'); });
    for (const c of ['ASSETS', 'URL_BASE_DATOS', 'CLAVE_COMPARTIDA', 'FOTOS_ORIGEN', 'FOTOS_PRESUPUESTO',
      'FOTOS_BUCKET', 'FOTOS_LISTADO_PRESUPUESTO']) Object.defineProperty(f.entorno, c, { get: getter });
    await privada(await worker.fetch(new Request('http://piloto.example/api/fotos/respaldo', { method: 'POST', body: 'intacto' }), f.entorno), 400);
    await privada(await worker.fetch(new Request('http://piloto.example/api/fotos/listado'), f.entorno), 400);
    expect(getter).not.toHaveBeenCalled(); expect(f.transporte).not.toHaveBeenCalled();
    expect(f.assets.fetch).not.toHaveBeenCalled();
  });

  it('otras rutas no inspeccionan configuración ni métodos bucket', async () => {
    const f = preparar(); const getter = vi.fn(() => { throw new Error('No inspeccionar bucket'); });
    Object.defineProperty(f.entorno, 'FOTOS_BUCKET', { value: Object.defineProperty({}, 'get', { get: getter }) });
    Object.defineProperty(f.entorno, 'FOTOS_ORIGEN', { get: getter });
    Object.defineProperty(f.entorno, 'FOTOS_PRESUPUESTO', { get: getter });
    expect((await worker.fetch(solicitud('/entrar'), f.entorno)).status).toBe(200);
    const cookie = await iniciar(f.entorno);
    expect((await worker.fetch(solicitud('/', { headers: { Cookie: cookie } }), f.entorno)).status).toBe(200);
    await privada(await worker.fetch(solicitud('/api/fotos/listado'), f.entorno), 503);
    expect(getter).not.toHaveBeenCalled();
  });

  it('importa sin inicializar credenciales, generar aleatoriedad ni consultar SQL', async () => {
    const { transporte } = preparar();
    const azar = vi.spyOn(crypto, 'getRandomValues');
    const resumen = vi.spyOn(crypto.subtle, 'digest');
    vi.resetModules();
    await import('../../servidor/worker');
    expect(transporte).not.toHaveBeenCalled();
    expect(azar).not.toHaveBeenCalled();
    expect(resumen).not.toHaveBeenCalled();
  });

  it.each(['CLAVE_COMPARTIDA', 'URL_BASE_DATOS', 'ASSETS'] as const)('rechaza binding ausente %s sin fallback', async (nombre) => {
    const { entorno, assets, transporte } = preparar();
    const incompleto = { ...entorno, [nombre]: undefined } as unknown as EntornoWorker;
    await privada(await worker.fetch(solicitud('/entrar'), incompleto), 503);
    expect(assets.fetch).not.toHaveBeenCalled();
    expect(transporte).not.toHaveBeenCalled();
  });

  it.each([{ CLAVE_COMPARTIDA: 'corta' }, { URL_BASE_DATOS: 'https://no-es-sql.example' },
    { ASSETS: { fetch: null } }])('rechaza configuración inválida %j', async (cambio) => {
    const { entorno, transporte } = preparar();
    await privada(await worker.fetch(solicitud('/entrar'), { ...entorno, ...cambio } as unknown as EntornoWorker), 503);
    expect(transporte).not.toHaveBeenCalled();
  });

  it('rechaza HTTP antes de acceder a cualquier binding incluso si el entorno lanza', async () => {
    const { transporte } = preparar();
    const lectura = vi.fn(() => { throw new Error(clave); });
    const entorno = new Proxy({}, { get: lectura }) as EntornoWorker;
    await privada(await worker.fetch(new Request('http://piloto.example/entrar'), entorno), 400);
    expect(lectura).not.toHaveBeenCalled();
    expect(transporte).not.toHaveBeenCalled();
  });

  it('oculta URL malformada y fallos del adaptador sin leer assets ni SQL', async () => {
    const { entorno, assets, transporte } = preparar();
    await privada(await worker.fetch({ url: 'no es URL' } as Request, entorno), 503);
    const roto = Object.defineProperty({ ...entorno }, 'ASSETS', { get() { throw new Error(urlBaseDatos); } });
    await privada(await worker.fetch(solicitud(), roto), 503);
    expect(assets.fetch).not.toHaveBeenCalled();
    expect(transporte).not.toHaveBeenCalled();
  });

  it('sirve entrada real con nonce distinto, sin SQL, cookie ni bootstrap', async () => {
    const { entorno, assets, transporte } = preparar();
    const primera = await worker.fetch(solicitud('/entrar'), entorno);
    const segunda = await worker.fetch(solicitud('/entrar'), entorno);
    expect(primera.status).toBe(200);
    expect(primera.headers.get('Content-Type')).toContain('text/html');
    expect(primera.headers.get('Content-Security-Policy')).not.toBe(segunda.headers.get('Content-Security-Policy'));
    const html = await primera.text();
    expect(html).toContain('/api/sesion');
    expect(html).toContain('nonce=');
    expect(html).toContain('type="password"');
    expect(html).not.toContain(clave);
    expect(primera.headers.get('Set-Cookie')).toBeNull();
    const cabeza = await worker.fetch(solicitud('/entrar', { method: 'HEAD' }), entorno);
    expect(cabeza.status).toBe(200);
    expect(await cabeza.text()).toBe('');
    expect(transporte).not.toHaveBeenCalled();
    expect(assets.fetch).not.toHaveBeenCalled();
  });

  it('API desconocida no usa assets y anónimos reciben JSON 401 o navegación 303', async () => {
    const { entorno, assets, transporte } = preparar();
    await privada(await worker.fetch(solicitud('/api/desconocida'), entorno), 404);
    const progreso = await worker.fetch(solicitud('/api/progreso'), entorno);
    expect(progreso.status).toBe(401);
    expect(progreso.headers.get('Cache-Control')).toBe('private, no-store');
    expect(progreso.headers.get('Set-Cookie')).toContain('Max-Age=0');
    await privada(await worker.fetch(solicitud('/app.js'), entorno), 401);
    const navegacion = await worker.fetch(solicitud('/', { headers: { Accept: 'text/html' } }), entorno);
    await privada(navegacion, 303);
    expect(navegacion.headers.get('Location')).toBe('/entrar');
    expect(transporte).not.toHaveBeenCalled();
    expect(assets.fetch).not.toHaveBeenCalled();
  });

  it.each(['/api/sesion', '/api/progreso', '/api/sesiones/00000000-0000-4000-8000-000000000001'])('Origin precede a SQL/assets en %s', async (ruta) => {
    const { entorno, assets, transporte } = preparar();
    const req = solicitud(ruta, { method: ruta.includes('/sesiones/') ? 'DELETE' : 'POST',
      headers: { Origin: 'https://ajeno.example', 'CF-Connecting-IP': '203.0.113.9', 'Content-Type': 'application/json' }, body: '{}' });
    await privada(await worker.fetch(req, entorno), 403);
    expect(transporte).not.toHaveBeenCalled();
    expect(assets.fetch).not.toHaveBeenCalled();
  });

  it.each([undefined, '', '203.0.113.999', '01.2.3.4', '203.0.113.1:80', '1.2.3',
    '1.2.3.4, 5.6.7.8', '[::1]', 'fe80::1%eth0', '1::2::3', '::ffff:999.1.1.1',
    '1:2:3:4:5:6:7', '1:2:3:4:5:6:7:8:9', '12345::', '1:2:3:4:5:6:7::8',
    ':1:2:3:4:5:6:7', '1:2:3:4:5:6:7:', ':::1', '::ffff:192.00.2.1',
    '192.0.2.1::', '1:2:3:4:5::192.0.2.1:8'])('no confía en IP ausente/malformada %j ni cabeceras alternativas', async (ip) => {
    const { entorno, assets, transporte } = preparar();
    await privada(await worker.fetch(entrada(ip, { Forwarded: 'for=203.0.113.9',
      'X-Forwarded-For': '203.0.113.9', 'X-Real-IP': '203.0.113.9' }), entorno), 503);
    expect(transporte).not.toHaveBeenCalled();
    expect(assets.fetch).not.toHaveBeenCalled();
  });

  it.each(['0.0.0.0', '255.255.255.255', '203.0.113.9', '::', '::1', '2001:DB8::1',
    '1:2:3:4:5:6:7:8', '::ffff:192.0.2.1', '1:2:3:4:5:6:192.0.2.1'])('acepta literal completo %s conservando identidad exacta', async (ip) => {
    const { entorno, transporte } = preparar();
    expect((await worker.fetch(entrada(ip), entorno)).status).toBe(201);
    const llamada = JSON.parse(transporte.mock.calls[0][1].body as string);
    const bytes = new TextEncoder().encode(JSON.stringify(['itinerario', 'v1', 'intento-sesion', itinerario.id, ip]));
    const huella = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), (b) => b.toString(16).padStart(2, '0')).join('');
    expect(llamada.params[0]).toBe(huella);
    expect(llamada.query).toContain('admitir_intento');
    expect(transporte).toHaveBeenCalledTimes(2);
  });

  it('autentica contra SQL antes de assets prototípicos conservando receiver y Request original', async () => {
    const { entorno, transporte } = preparar();
    const cookie = await iniciar(entorno);
    const req = solicitud('/app.js', { headers: { Cookie: cookie } });
    class AssetsNativos {
      contenido = 'respuesta del binding';
      async fetch(original: Request) {
        expect(original).toBe(req);
        expect(transporte).toHaveBeenCalledTimes(3);
        return new Response(this.contenido, { headers: { 'X-Recurso': 'intacto' } });
      }
    }
    entorno.ASSETS = new AssetsNativos();
    const respuesta = await worker.fetch(req, entorno);
    expect(respuesta.status).toBe(200);
    expect(respuesta.headers.get('X-Recurso')).toBe('intacto');
    expect(respuesta.headers.get('Cache-Control')).toBe('private, no-store');
    expect(await respuesta.text()).toBe('respuesta del binding');
  });

  it.each(['revocada', 'caducada', 'caida'])('deniega assets ante sesión %s sin fallback', async (modo) => {
    const { entorno, assets, cambiarRegistro, caer } = preparar();
    const cookie = await iniciar(entorno);
    if (modo === 'revocada') cambiarRegistro({ revocada: true });
    if (modo === 'caducada') cambiarRegistro({ creadaEn: 0, venceEn: 1 });
    if (modo === 'caida') caer();
    await privada(await worker.fetch(solicitud('/app.js', { headers: { Cookie: cookie } }), entorno), modo === 'caida' ? 503 : 401);
    expect(assets.fetch).not.toHaveBeenCalled();
  });

  it('no emite cookie ante respuesta perdida de creación aunque el doble guardó el registro', async () => {
    const { entorno, assets, perderCreacion } = preparar();
    perderCreacion();
    await privada(await worker.fetch(entrada('203.0.113.9'), entorno), 503);
    expect(assets.fetch).not.toHaveBeenCalled();
  });

  it('espera confirmación del transporte de creación antes de responder con cookie', async () => {
    const { entorno, transporte } = preparar();
    let resolver!: (respuesta: Response) => void;
    transporte.mockImplementationOnce(async () => sobre(true));
    transporte.mockImplementationOnce(() => new Promise<Response>((r) => { resolver = r; }));
    let terminada = false;
    const pendiente = worker.fetch(entrada('203.0.113.9'), entorno).then((respuesta) => {
      terminada = true;
      return respuesta;
    });
    await vi.waitFor(() => expect(transporte).toHaveBeenCalledTimes(2));
    expect(terminada).toBe(false);
    resolver(sobre({ tipo: 'creada' }));
    const respuesta = await pendiente;
    expect(respuesta.status).toBe(201);
    expect(respuesta.headers.get('Set-Cookie')).toContain('__Host-itinerario=');
  });

  it('conecta límite SQL persistente: denegación no crea cookie ni sesión', async () => {
    const { entorno, assets, transporte } = preparar();
    transporte.mockResolvedValueOnce(sobre(false));
    const respuesta = await worker.fetch(entrada('203.0.113.9'), entorno);
    expect(respuesta.headers.get('Retry-After')).toBe('600');
    await privada(respuesta, 429);
    expect(transporte).toHaveBeenCalledTimes(1);
    expect(assets.fetch).not.toHaveBeenCalled();
  });

  it('reconstruye sin caché: cambio de clave invalida cookie y usa nuevo DSN', async () => {
    const { entorno, transporte } = preparar();
    const cookie = await iniciar(entorno);
    entorno.CLAVE_COMPARTIDA = `${clave}-otra`;
    await privada(await worker.fetch(solicitud('/app.js', { headers: { Cookie: cookie } }), entorno), 401);
    expect(transporte).toHaveBeenCalledTimes(2);
    entorno.URL_BASE_DATOS = urlBaseDatos.replace('/viaje?', '/otro?');
    expect((await worker.fetch(entrada('203.0.113.9', {}, entorno.CLAVE_COMPARTIDA), entorno)).status).toBe(201);
    expect(new Headers(transporte.mock.calls[2][1].headers).get('Neon-Connection-String')).toContain('/otro?');
    entorno.URL_BASE_DATOS = '';
    await privada(await worker.fetch(solicitud('/entrar'), entorno), 503);
  });

  it('conecta progreso real y conserva pérdida de autoridad dentro del repositorio', async () => {
    const { entorno, assets, transporte, perder } = preparar();
    const cookie = await iniciar(entorno);
    const req = () => solicitud('/api/progreso', { headers: { Cookie: cookie } });
    const respuesta = await worker.fetch(req(), entorno);
    expect(respuesta.status).toBe(200);
    expect(await respuesta.json()).toEqual({ revisionServidor: 0, estado: crearProgreso(itinerario) });
    expect(transporte).toHaveBeenCalledTimes(4);
    perder();
    expect((await worker.fetch(req(), entorno)).status).toBe(401);
    expect(assets.fetch).not.toHaveBeenCalled();
  });

  it('error del repositorio de progreso produce 503 privado sin fallback', async () => {
    const { entorno, assets, transporte } = preparar();
    const cookie = await iniciar(entorno);
    const consultaSesion = transporte.getMockImplementation()!;
    transporte.mockImplementationOnce(consultaSesion);
    transporte.mockResolvedValueOnce(sobre({ tipo: 'lectura', instantanea: null, decision: null }));
    await privada(await worker.fetch(solicitud('/api/progreso', { headers: { Cookie: cookie } }), entorno), 503);
    expect(assets.fetch).not.toHaveBeenCalled();
  });

  it.each(['lanza', 'respuesta-500'])('no filtra errores de assets autenticados: %s', async (modo) => {
    const { entorno, assets } = preparar();
    const cookie = await iniciar(entorno);
    if (modo === 'lanza') assets.fetch.mockRejectedValueOnce(new Error(clave));
    else assets.fetch.mockResolvedValueOnce(new Response(urlBaseDatos, { status: 500 }));
    await privada(await worker.fetch(solicitud('/app.js', { headers: { Cookie: cookie } }), entorno), 503);
    expect(assets.fetch).toHaveBeenCalledTimes(1);
  });

  it('identidad de red solo afecta login, sin normalizar ni confiar en dispositivo/body/query', async () => {
    const { entorno, transporte } = preparar();
    const req = solicitud('/api/sesion?ip=203.0.113.9', { method: 'POST',
      headers: { Origin: origen, 'Content-Type': 'application/json' },
      body: JSON.stringify({ clave, dispositivoId: '203.0.113.9' }) });
    await privada(await worker.fetch(req, entorno), 503);
    const respuesta = await worker.fetch(solicitud('/entrar', { headers: { 'CF-Connecting-IP': 'no-es-ip' } }), entorno);
    expect(respuesta.status).toBe(200);
    expect(transporte).not.toHaveBeenCalled();
  });

  it('conserva señal abortada y cuerpo original de login sin emitir cookie ni consultar SQL', async () => {
    const { entorno, assets, transporte } = preparar();
    const controlador = new AbortController();
    const req = new Request(entrada('203.0.113.9'), { signal: controlador.signal });
    controlador.abort();
    await privada(await worker.fetch(req, entorno), 400);
    expect(transporte).not.toHaveBeenCalled();
    expect(assets.fetch).not.toHaveBeenCalled();
  });

  it('transporta operación original, confirma y repite acuse histórico TEXT con -0', async () => {
    const { entorno, transporte } = preparar();
    const cookie = await iniciar(entorno);
    const paradaId = itinerario.dias[0].paradas[0].id;
    const op = { id: 'operación-local', dispositivoId: 'otro-dispositivo', tipo: 'parada',
      paradaId, marca: 'hecha', revision: 0, horaReal: -0 };
    const req = () => solicitud('/api/progreso', { method: 'POST',
      headers: { Cookie: cookie, Origin: origen, 'Content-Type': 'application/json' }, body: serializarProgreso(op) });
    const respuesta = await worker.fetch(req(), entorno);
    expect(respuesta.status).toBe(200);
    const historico = await respuesta.text();
    expect(historico).toContain('"horaReal":-0');
    expect(transporte).toHaveBeenCalledTimes(5);
    const consulta = JSON.parse(transporte.mock.calls[4][1].body as string);
    expect(consulta.query).toContain('confirmar_progreso');
    expect(consulta.params[1]).toBe(itinerario.id);
    expect(consulta.params[3]).toContain('"horaReal":-0');
    const duplicada = await worker.fetch(req(), entorno);
    expect(duplicada.status).toBe(200);
    expect(await duplicada.text()).toBe(historico);
    expect(transporte).toHaveBeenCalledTimes(7);
  });

  it('configuración local fija entrypoint y Worker primero, sin recursos/secretos', () => {
    const configuracion = JSON.parse(readFileSync(new URL('../../wrangler.jsonc', import.meta.url), 'utf8'));
    expect(configuracion).toEqual({ main: 'servidor/worker.ts', compatibility_date: '2026-10-11',
      assets: { directory: './dist', binding: 'ASSETS', run_worker_first: true } });
  });
});
