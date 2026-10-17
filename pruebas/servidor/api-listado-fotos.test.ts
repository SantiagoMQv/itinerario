import { afterEach, describe, expect, it, vi } from 'vitest';
import { itinerario as plan } from '../../src/datos/itinerario';
import { prepararListadoFotos } from '../../servidor/api-listado-fotos';
import { calcularCotasListadoFotos, type PresupuestoListadoFotos } from '../../servidor/repositorio-listado-fotos';
import type { EjecutorSql } from '../../servidor/contratos';
import type { RegistroSesion } from '../../servidor/sesiones';

const origen = 'https://piloto.example';
const presupuesto: PresupuestoListadoFotos = { maxFilas: 1, maxOperacionesPorFoto: 64,
  maxBytesSql: 5 * 1024 ** 2, maxBytesRespuesta: 512 * 1024, maxBytesRetenidos: 64 * 1024 ** 2, plazoMs: 1000 };
const sesion: RegistroSesion = { id: 'abcdef12-1234-4123-8123-123456789abc', huella: 'a'.repeat(64),
  viajeId: plan.id, dispositivoId: 'local', creadaEn: 1, venceEn: Number.MAX_SAFE_INTEGER, revocada: false };
const despuesDe = 'ABCDEF12-1234-4123-8123-123456789ABC';
const hasta = 'BBCDEF12-1234-4123-8123-123456789ABC';
const continuacion = JSON.stringify({ version: 1, viajeId: plan.id, despuesDe, hasta });
const solicitar = (query = '', opciones?: RequestInit) => new Request(origen + '/api/fotos/listado' + query, opciones);
/** Frontera negativa aislada: repositorio E1 REAL, sólo envelopes de EjecutorSql
 * sintéticos. El positivo SQL/SDK/Worker íntegro vive en worker-fotos.test.ts. */
function preparar(cambio: Partial<PresupuestoListadoFotos> = {}) {
  const ejecutar = vi.fn<EjecutorSql['ejecutar']>(async () => ({ filas: [{ resultado:
    '{"tipo":"pagina","hasta":null,"candidatas":[]}' }] }));
  const autenticar = vi.fn(async (_r: Request): Promise<RegistroSesion | null> => ({ ...sesion }));
  const configuracion = { plan, ejecutor: { ejecutar }, origen, presupuesto: { ...presupuesto, ...cambio } };
  const preparacion = prepararListadoFotos(configuracion);
  return { ejecutar, autenticar, configuracion, preparacion, api: preparacion.conAutenticacion(autenticar) };
}
async function privada(r: Response, estado: number) {
  expect(r.status).toBe(estado);
  expect(r.headers.get('Cache-Control')).toBe('private, no-store');
  expect(r.headers.get('Pragma')).toBe('no-cache'); expect(r.headers.get('Vary')).toBe('Cookie');
  expect(r.headers.get('Content-Type')).toBe('application/json; charset=utf-8');
  expect(r.headers.get('X-Content-Type-Options')).toBe('nosniff');
  for (const h of ['Set-Cookie', 'Location', 'ETag', 'Access-Control-Allow-Origin']) expect(r.headers.get(h)).toBeNull();
  if (estado !== 200 && r.body !== null) expect(await r.text()).toBe('{"error":"No se puede atender la solicitud ahora."}');
}
function barrera() {
  let liberar!: () => void;
  const espera = new Promise<void>((r) => { liberar = r; });
  return { espera, liberar };
}
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe('Consulta de destino autenticada y aditiva', () => {
  const destino = { tipo: 'parada', viajeId: plan.id, paradaId: plan.dias[0].paradas[0].id };
  const consulta = '?destino=' + encodeURIComponent(JSON.stringify(destino));
  it('destino válido devuelve envelope exacto y autentica de nuevo', async () => {
    const f = preparar(); const r = await f.api.atender(solicitar(consulta));
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ version: 1, tipo: 'listado-respaldos-destino', viajeId: plan.id,
      destino, solicitudesIniciales: [], continuacion: null });
    expect(f.autenticar).toHaveBeenCalledTimes(2);
    expect(f.ejecutar.mock.calls[0][0]).toBe('SELECT itinerario.listar_fotos_confirmadas_destino($1, $2, $3, $4, $5, $6, $7, $8) AS resultado');
    expect(f.ejecutar.mock.calls[0][1][7]).toBe(JSON.stringify(destino));
  });
  it.each([consulta + '&otro=1', consulta + '&destino=x', '?destino={}',
    '?destino=' + encodeURIComponent(JSON.stringify({ ...destino, viajeId: 'otro' })),
    '?destino=' + encodeURIComponent(JSON.stringify({ ...destino, tipo: 'subparada', subparadaId: 'inexistente' })),
    consulta + '&continuacion=' + encodeURIComponent(continuacion),
    '?destino=' + encodeURIComponent(JSON.stringify(destino) + ' '),
    '?destino=' + encodeURIComponent(JSON.stringify(destino).replace('"tipo"', '"tipo":"parada","tipo"')),
  ])('rechaza mezcla, extras, destino ajeno o no canónico: %s', async (q) => {
    const f = preparar(); await privada(await f.api.atender(solicitar(q)), 400);
    expect(f.ejecutar).not.toHaveBeenCalled();
  });
  it('sesión inválida antecede incluso destino mal formado', async () => {
    const f = preparar(); f.autenticar.mockResolvedValue(null);
    await privada(await f.api.atender(solicitar('?destino=%FF')), 401);
    expect(f.ejecutar).not.toHaveBeenCalled();
  });
  it('destino válido no publica después de revocación fresca', async () => {
    const f = preparar(); f.autenticar.mockResolvedValueOnce({ ...sesion }).mockResolvedValueOnce(null);
    await privada(await f.api.atender(solicitar(consulta)), 401);
    expect(f.ejecutar).toHaveBeenCalledTimes(1);
  });
});

describe('Listado HTTP privado, frontera con E1 cerrado', () => {
  it('fábrica y enlace congelados sin auth, SQL, hashing ni azar', () => {
    const azar = vi.spyOn(crypto, 'getRandomValues'); const digest = vi.spyOn(crypto.subtle, 'digest');
    const f = preparar();
    expect(Object.isFrozen(f.preparacion)).toBe(true); expect(Object.isFrozen(f.api)).toBe(true);
    expect(f.ejecutar).not.toHaveBeenCalled(); expect(f.autenticar).not.toHaveBeenCalled();
    expect(azar).not.toHaveBeenCalled(); expect(digest).not.toHaveBeenCalled();
  });
  it.each(['POST', 'PUT', 'DELETE', 'HEAD', 'OPTIONS'])('%s pertenece al API, no autentica ni lista', async (method) => {
    const f = preparar(); const r = await f.api.atender(solicitar('', { method }));
    expect(r.headers.get('Allow')).toBe('GET'); if (method === 'HEAD') expect(r.body).toBeNull();
    await privada(r, 405); expect(f.autenticar).not.toHaveBeenCalled(); expect(f.ejecutar).not.toHaveBeenCalled();
  });
  it('POST stream HWM0 no lee ni sustituye Request', async () => {
    const f = preparar(); const leer = vi.fn();
    const body = new ReadableStream({ pull: leer }, { highWaterMark: 0 });
    const r = solicitar('', { method: 'POST', body, duplex: 'half' } as RequestInit);
    await privada(await f.api.atender(r), 405); expect(leer).not.toHaveBeenCalled(); expect(r.bodyUsed).toBe(false);
  });
  it.each(['http://piloto.example/api/fotos/listado', 'https://otro.example/api/fotos/listado'])('destino %s antes de auth', async (url) => {
    const f = preparar(); await privada(await f.api.atender(new Request(url)), 400);
    expect(f.autenticar).not.toHaveBeenCalled(); expect(f.ejecutar).not.toHaveBeenCalled();
  });
  it.each(['/api/fotos/listado/', '/api/fotos/%6cistado', '/api/fotos', '/api/fotos/listado/extra'])('path exacto: %s no alias', async (ruta) => {
    const f = preparar(); await privada(await f.api.atender(new Request(origen + ruta)), 404);
    expect(f.autenticar).not.toHaveBeenCalled(); expect(f.ejecutar).not.toHaveBeenCalled();
  });
  it('GET no es mutación CSRF: Origin ajeno no reemplaza autoridad de cookie', async () => {
    const f = preparar(); const r = solicitar('', { headers: { Origin: 'https://otro.example' } });
    await privada(await f.api.atender(r), 200);
    expect(f.autenticar.mock.calls.map(([original]) => original)).toEqual([r, r]);
  });
  it.each([null, { ...sesion, revocada: true }, { ...sesion, venceEn: 1 }, { ...sesion, viajeId: 'otro' }])('auth inválida antecede query %j', async (actor) => {
    const f = preparar(); f.autenticar.mockResolvedValue(actor);
    await privada(await f.api.atender(solicitar('?desconocido=privado')), 401);
    expect(f.ejecutar).not.toHaveBeenCalled();
  });
  it('infra auth no se convierte en 401 ni refleja el error', async () => {
    const f = preparar(); f.autenticar.mockRejectedValue(new Error('cookie SQL privado stack'));
    await privada(await f.api.atender(solicitar('?continuacion=%FF')), 503); expect(f.ejecutar).not.toHaveBeenCalled();
  });
  it.each(['?', '?continuacion', '?continuacion=', '?otro=1', '?%63ontinuacion=x', '?continuacion=%FF',
    '?continuacion=%', '?continuacion=%C0%AF', '?continuacion=null', '?continuacion={}'])('query nativa estricta %s', async (query) => {
    const f = preparar(); await privada(await f.api.atender(solicitar(query)), 400);
    expect(f.autenticar).toHaveBeenCalledTimes(1); expect(f.ejecutar).not.toHaveBeenCalled();
  });
  it.each(['&', '&continuacion=x', '&otro=1', '&&'])('separador/doble %s no listado SQL', async (cola) => {
    const f = preparar(); await privada(await f.api.atender(solicitar('?continuacion=' + encodeURIComponent(continuacion) + cola)), 400);
    expect(f.ejecutar).not.toHaveBeenCalled();
  });
  it.each([
    continuacion + ' ', continuacion.replace('"version":1', '"version":1.0'),
    continuacion.replace('"version":1', '"version":1,"version":1'),
    continuacion.replace('"version"', '"ver\\u0073ion"'),
    JSON.stringify({ version: 1, viajeId: 'otro', despuesDe, hasta }),
    JSON.stringify({ version: 1, viajeId: plan.id, despuesDe: hasta, hasta: despuesDe }),
    '['.repeat(17) + '0' + ']'.repeat(17), '[' + Array(256).fill('0').join(',') + ']',
    '"' + 'a'.repeat(1022) + '"', '"' + 'a'.repeat(1023) + '"',
  ])('cursor inválido/canonicalidad/scanner: %s', async (c) => {
    const f = preparar(); await privada(await f.api.atender(solicitar('?continuacion=' + encodeURIComponent(c))), 400);
    expect(f.ejecutar).not.toHaveBeenCalled();
  });
  it.each(['', '#fragmento?ignorado'])('query excesiva%s: cero split propio de URL antes del límite', async (fragmento) => {
    const f = preparar(); const solicitud = solicitar('?continuacion=' + 'a'.repeat(4096) + fragmento);
    const href = new URL(solicitud.url).href; const nativo = String.prototype.split;
    let llamadas = 0; let longitudPrimera = 0; let respuesta!: Response;
    // Testigo de operación, no medida de heap. Mismo receiver/args/resultado nativos;
    // sólo dos números observados para ESTA URL, sin alterar status ni lanzar fallos.
    const espia = vi.spyOn(String.prototype, 'split').mockImplementation(function (this: string, ...args) {
      const resultado = Reflect.apply(nativo, this, args) as string[];
      if (String(this) === href) { llamadas++; longitudPrimera = resultado[0]?.length ?? 0; }
      return resultado;
    });
    try { respuesta = await f.api.atender(solicitud); }
    finally { espia.mockClear(); espia.mockRestore(); }
    await privada(respuesta, 400); expect(f.autenticar).toHaveBeenCalledTimes(1);
    expect(f.ejecutar).not.toHaveBeenCalled();
    expect({ llamadas, longitudPrimera }).toEqual({ llamadas: 0, longitudPrimera: 0 });
  });
  it.each([3086, 3087])('query serializada %i acotada antes de decode', async (n) => {
    const f = preparar(); const q = '?continuacion=' + '%'.repeat(n - 14);
    expect(new URL(solicitar(q).url).search.length).toBe(n);
    await privada(await f.api.atender(solicitar(q)), 400); expect(f.ejecutar).not.toHaveBeenCalled();
  });
  it('cursor canónico envía posición case-sensitive en parámetros, no autoridad', async () => {
    const f = preparar(); f.ejecutar.mockResolvedValue({ filas: [{ resultado: JSON.stringify({ tipo: 'pagina', hasta, candidatas: [] }) }] });
    await privada(await f.api.atender(solicitar('?continuacion=' + encodeURIComponent(continuacion))), 200);
    expect(f.ejecutar.mock.calls[0][1]).toEqual([sesion.huella, plan.id, despuesDe, hasta, 1, 64, 4762546]);
  });
  it.each(['viaje=uno', 'viaje&uno', 'viaje#uno'])('trip literal %s conserva = y & codificado sin alias', async (viajeId) => {
    const f = preparar(); const p = { ...structuredClone(plan), id: viajeId };
    const autenticar = vi.fn(async () => ({ ...sesion, viajeId }));
    const api = prepararListadoFotos({ ...f.configuracion, plan: p }).conAutenticacion(autenticar);
    const c = JSON.stringify({ version: 1, viajeId, despuesDe, hasta });
    // '=' crudo dentro del valor válido; '&' sí necesita percent-encoding.
    const q = encodeURIComponent(c).replace(/%3D/g, '=');
    f.ejecutar.mockResolvedValue({ filas: [{ resultado: JSON.stringify({ tipo: 'pagina', hasta, candidatas: [] }) }] });
    await privada(await api.atender(solicitar('?continuacion=' + q)), 200);
    expect(f.ejecutar.mock.calls[0][1][1]).toBe(viajeId);
  });
  it.each(['#?continuacion=no', '#fragmento?otro=1'])('fragmento nativo %s no es query', async (fragmento) => {
    const f = preparar(); const solicitud = solicitar(fragmento);
    expect(new URL(solicitud.url).search).toBe('');
    await privada(await f.api.atender(solicitud), 200);
    expect(f.ejecutar.mock.calls[0][1][2]).toBeNull();
  });
  it.each(['?', '?#fragmento?ignorado'])('interrogación vacía %s conservada por Request = 400', async (sufijo) => {
    const f = preparar(); const solicitud = solicitar(sufijo);
    expect(solicitud.url).toContain('/listado?'); expect(new URL(solicitud.url).search).toBe('');
    await privada(await f.api.atender(solicitud), 400); expect(f.ejecutar).not.toHaveBeenCalled();
  });
  it('query excesiva sin sesión mantiene 401 antes del cursor', async () => {
    const f = preparar(); f.autenticar.mockResolvedValue(null);
    await privada(await f.api.atender(solicitar('?continuacion=' + 'a'.repeat(4096))), 401);
    expect(f.ejecutar).not.toHaveBeenCalled();
  });
  it('cursor válido con fragmento queda acotado sólo por query serializada', async () => {
    const f = preparar(); f.ejecutar.mockResolvedValue({ filas: [{ resultado: JSON.stringify({ tipo: 'pagina', hasta, candidatas: [] }) }] });
    await privada(await f.api.atender(solicitar('?continuacion=' + encodeURIComponent(continuacion) + '#?' + 'x'.repeat(4096))), 200);
    expect(f.ejecutar.mock.calls[0][1][2]).toBe(despuesDe);
  });
  it('sin-sesion SQL es 401 sin autenticar por segunda vez', async () => {
    const f = preparar(); f.ejecutar.mockResolvedValue({ filas: [{ resultado: '{"tipo":"sin-sesion"}' }] });
    await privada(await f.api.atender(solicitar()), 401); expect(f.autenticar).toHaveBeenCalledTimes(1);
  });
  it.each([{ filas: [] }, { filas: [{ resultado: '{}' }] }, { filas: [{ resultado: 'null' }] },
    { filas: [{ resultado: '{"tipo":"pagina","hasta":null,"candidatas":[{}]}' }] }])('corrupción SQL cierra página %j', async ({ filas }) => {
    const f = preparar(); f.ejecutar.mockResolvedValue({ filas });
    await privada(await f.api.atender(solicitar()), 503); expect(f.autenticar).toHaveBeenCalledTimes(1);
  });
  it.each([null, { ...sesion, revocada: true }, { ...sesion, viajeId: 'otro' }, { ...sesion, venceEn: 1 },
    { ...sesion, huella: 'b'.repeat(64) }, { ...sesion, id: 'bbcdef12-1234-4123-8123-123456789abc' },
    { ...sesion, creadaEn: 2 }])('auth fresca no cambia identidad %j', async (actual) => {
    const f = preparar(); f.autenticar.mockResolvedValueOnce({ ...sesion }).mockResolvedValueOnce(actual);
    await privada(await f.api.atender(solicitar()), 401); expect(f.ejecutar).toHaveBeenCalledTimes(1);
  });
  it('rename/dispositivo no son permisos ni dueño de fotos', async () => {
    const f = preparar(); f.autenticar.mockResolvedValueOnce({ ...sesion }).mockResolvedValueOnce({ ...sesion,
      dispositivoId: 'renombrado', nombreDispositivo: 'Otro nombre' });
    await privada(await f.api.atender(solicitar()), 200);
  });
  it('auth fresca infra = 503, no publicación parcial', async () => {
    const f = preparar(); f.autenticar.mockResolvedValueOnce({ ...sesion }).mockRejectedValueOnce(new Error('SQL secreto'));
    await privada(await f.api.atender(solicitar()), 503);
  });
  it.each(['id', 'huella', 'viajeId', 'dispositivoId', 'creadaEn', 'venceEn', 'revocada', 'nombreDispositivo'])('registro getter %s no se ejecuta', async (campo) => {
    const f = preparar(); const getter = vi.fn(); const a = { ...sesion };
    Object.defineProperty(a, campo, { get: getter }); f.autenticar.mockResolvedValue(a);
    await privada(await f.api.atender(solicitar()), 503); expect(getter).not.toHaveBeenCalled(); expect(f.ejecutar).not.toHaveBeenCalled();
  });
  it('actor inicial mutable capturado por valor antes de SQL await', async () => {
    const f = preparar(); const a = { ...sesion }; f.autenticar.mockResolvedValueOnce(a);
    f.ejecutar.mockImplementationOnce(async () => {
      a.huella = 'b'.repeat(64); a.id = 'bbcdef12-1234-4123-8123-123456789abc';
      return { filas: [{ resultado: '{"tipo":"pagina","hasta":null,"candidatas":[]}' }] };
    });
    await privada(await f.api.atender(solicitar()), 200);
    expect(f.ejecutar.mock.calls[0][1][0]).toBe(sesion.huella);
  });
  it('caducidad inicial durante auth fresca impide publicación', async () => {
    const f = preparar(); const ahora = Date.now(); const a = { ...sesion, venceEn: ahora + 10 };
    f.autenticar.mockResolvedValueOnce(a).mockImplementationOnce(async () => {
      vi.spyOn(Date, 'now').mockReturnValue(ahora + 11); return { ...sesion };
    });
    await privada(await f.api.atender(solicitar()), 401);
  });
  it('vence justo en el tercer reloj post-auth fresca, después de construir Response', async () => {
    const f = preparar(); const base = Date.now(); let frescaResuelta = false;
    const lecturas: number[] = [];
    const a = { ...sesion, venceEn: base + 50 };
    f.autenticar.mockResolvedValueOnce(a).mockImplementationOnce(async () => {
      frescaResuelta = true; return { ...a };
    });
    // Modelo ordinal del código actual: comprobar esperar=1, reloj actor=2,
    // reloj posterior a Response=3, comprobar final=4. No intercepta Response.
    const reloj = vi.spyOn(Date, 'now').mockImplementation(() => {
      if (!frescaResuelta) return base;
      const valor = lecturas.length < 2 ? base : base + 50;
      lecturas.push(valor); return valor;
    });
    let r!: Response;
    try { r = await f.api.atender(solicitar()); }
    finally { reloj.mockRestore(); }
    await privada(r, 401);
    expect(lecturas).toEqual([base, base, base + 50, base + 50]);
    expect(f.autenticar).toHaveBeenCalledTimes(2); expect(f.ejecutar).toHaveBeenCalledTimes(1);
  });
  it.each(['inicial', 'sql', 'fresca'])('aborto con %s pendiente ignora continuación tardía', async (paso) => {
    const f = preparar(); const llegada = barrera(); const gate = barrera(); const salio = barrera();
    const esperar = async () => { llegada.liberar(); await gate.espera; salio.liberar(); };
    if (paso === 'sql') f.ejecutar.mockImplementationOnce(async () => { await esperar(); return { filas: [{ resultado: '{"tipo":"pagina","hasta":null,"candidatas":[]}' }] }; });
    else if (paso === 'inicial') f.autenticar.mockImplementationOnce(async () => { await esperar(); return { ...sesion }; });
    else f.autenticar.mockResolvedValueOnce({ ...sesion }).mockImplementationOnce(async () => { await esperar(); return { ...sesion }; });
    const ac = new AbortController(); const pendiente = f.api.atender(solicitar('', { signal: ac.signal }));
    await llegada.espera; ac.abort(); await privada(await pendiente, 503); gate.liberar(); await salio.espera;
    await Promise.allSettled([...f.autenticar.mock.results, ...f.ejecutar.mock.results].map((r) => r.value));
    expect(f.autenticar).toHaveBeenCalledTimes(paso === 'fresca' ? 2 : 1);
    expect(f.ejecutar).toHaveBeenCalledTimes(paso === 'inicial' ? 0 : 1);
  });
  it.each(['inicial', 'sql', 'fresca'])('plazo con %s pendiente no reintenta', async (paso) => {
    const f = preparar({ plazoMs: 20 }); const llegada = barrera(); const gate = barrera();
    const esperar = async () => { llegada.liberar(); await gate.espera; };
    if (paso === 'sql') f.ejecutar.mockImplementationOnce(async () => { await esperar(); return { filas: [{ resultado: '{"tipo":"pagina","hasta":null,"candidatas":[]}' }] }; });
    else if (paso === 'inicial') f.autenticar.mockImplementationOnce(async () => { await esperar(); return { ...sesion }; });
    else f.autenticar.mockResolvedValueOnce({ ...sesion }).mockImplementationOnce(async () => { await esperar(); return { ...sesion }; });
    vi.useFakeTimers(); const pendiente = f.api.atender(solicitar());
    await llegada.espera; await vi.advanceTimersByTimeAsync(20); await privada(await pendiente, 503);
    gate.liberar(); await Promise.allSettled([...f.autenticar.mock.results, ...f.ejecutar.mock.results].map((r) => r.value));
    expect(f.ejecutar).toHaveBeenCalledTimes(paso === 'inicial' ? 0 : 1);
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe('Admisión HTTP y snapshots cero IO', () => {
  it.each([1, 8])('N%i exige R_E1 + 6P + 65536 exactos', (n) => {
    const c = calcularCotasListadoFotos(n, 64); const minimo = c.bytesRetenidos + 6 * c.bytesRespuesta + 65536;
    expect(minimo).toBe(n === 1 ? 51431476 : 243480256);
    const f = preparar(); const configuracion = { ...f.configuracion, presupuesto: { ...presupuesto,
      maxFilas: n, maxBytesSql: c.bytesSql, maxBytesRespuesta: c.bytesRespuesta, maxBytesRetenidos: minimo } };
    expect(() => prepararListadoFotos(configuracion)).not.toThrow();
    configuracion.presupuesto.maxBytesRetenidos--;
    expect(() => prepararListadoFotos(configuracion)).toThrow(); expect(f.ejecutar).not.toHaveBeenCalled();
  });
  it.each(['plan', 'ejecutor', 'origen', 'presupuesto'])('getter propio configuración %s no invocado', (campo) => {
    const f = preparar(); const getter = vi.fn(); Object.defineProperty(f.configuracion, campo, { get: getter });
    expect(() => prepararListadoFotos(f.configuracion)).toThrow(); expect(getter).not.toHaveBeenCalled();
  });
  it('plan anidado M1 falla antes de inspeccionar presupuesto/método', () => {
    const f = preparar(); const p = structuredClone(plan); const getter = vi.fn();
    Object.defineProperty(p.dias[0].paradas[0], 'nombre', { get: getter });
    const metodo = vi.fn(); Object.defineProperty(f.configuracion.ejecutor, 'ejecutar', { get: metodo });
    expect(() => prepararListadoFotos({ ...f.configuracion, plan: p })).toThrow();
    expect(getter).not.toHaveBeenCalled(); expect(metodo).not.toHaveBeenCalled();
  });
  it.each(['maxFilas', 'maxOperacionesPorFoto', 'maxBytesSql', 'maxBytesRespuesta', 'maxBytesRetenidos', 'plazoMs'])('budget accessor %s no ejecutado', (campo) => {
    const f = preparar(); const getter = vi.fn(); Object.defineProperty(f.configuracion.presupuesto, campo, { get: getter });
    expect(() => prepararListadoFotos(f.configuracion)).toThrow(); expect(getter).not.toHaveBeenCalled();
  });
  it.each([{ maxFilas: 9 }, { maxFilas: 0 }, { maxFilas: Number.MAX_SAFE_INTEGER }, { maxOperacionesPorFoto: 65 },
    { plazoMs: 0 }, { plazoMs: 2147483648 }, { maxBytesRespuesta: Infinity }, { extra: 1 }])('budget inválido %j antes de SQL', (cambio) => {
    const f = preparar(); Object.assign(f.configuracion.presupuesto, cambio);
    expect(() => prepararListadoFotos(f.configuracion)).toThrow(); expect(f.ejecutar).not.toHaveBeenCalled();
  });
  it.each(['http://piloto.example', origen + '/', origen + '?', origen + '#', 'https://user@piloto.example', '/relativa'])('origen no exacto %s', (o) => {
    const f = preparar(); expect(() => prepararListadoFotos({ ...f.configuracion, origen: o })).toThrow();
  });
  it('símbolos, campos extra y prototipos no admitidos', () => {
    const f = preparar();
    expect(() => prepararListadoFotos({ ...f.configuracion, [Symbol('extra')]: 1 })).toThrow();
    expect(() => prepararListadoFotos(Object.assign(Object.create({}), f.configuracion))).toThrow();
    expect(() => prepararListadoFotos({ ...f.configuracion, extra: 1 } as typeof f.configuracion)).toThrow();
  });
  it('ejecutor own function ligado y snapshots no leen mutaciones posteriores', async () => {
    const f = preparar(); const fallido = vi.fn(async () => { throw new Error('método mutado'); });
    f.configuracion.ejecutor.ejecutar = fallido; f.configuracion.origen = 'https://otro.example';
    f.configuracion.presupuesto.maxFilas = 0;
    await privada(await f.api.atender(solicitar()), 200); expect(f.ejecutar).toHaveBeenCalledTimes(1); expect(fallido).not.toHaveBeenCalled();
  });
  it('máximos configurados no sustituyen P/S efectivos ni causan multiplicación MAX', async () => {
    const f = preparar({ maxBytesSql: Number.MAX_SAFE_INTEGER, maxBytesRespuesta: Number.MAX_SAFE_INTEGER,
      maxBytesRetenidos: Number.MAX_SAFE_INTEGER });
    await privada(await f.api.atender(solicitar()), 200); expect(f.ejecutar.mock.calls[0][1][6]).toBe(4762546);
  });
});
