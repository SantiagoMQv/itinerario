import { afterEach, describe, expect, it, vi } from 'vitest';
import { crearEjecutorNeon } from '../../servidor/ejecutor-neon';

const urlBaseDatos = 'postgresql://viajero:clave-sintetica@ep-piloto-test.eu-central-1.aws.neon.tech/viaje?sslmode=require';
const consulta = 'SELECT itinerario.consultar_progreso($1, $2, $3) AS resultado';
const error = 'No se pudo ejecutar la consulta.';
const campo = (name = 'resultado', dataTypeID = 25) => ({ name, dataTypeID,
  tableID: 0, columnID: 0, dataTypeSize: -1, dataTypeModifier: -1, format: 'text' });
// Protocolo HTTP oficial: columnas tipadas y celdas de texto en arreglos.
const sobre = (rows: unknown[] = [['{}']], fields = [campo()]) => ({
  command: 'SELECT', rowCount: rows.length, fields, rows,
});
const respuesta = (dato: unknown) => new Response(JSON.stringify(dato));
function preparar(dato: unknown = sobre()) {
  const fetch = vi.fn().mockResolvedValue(respuesta(dato));
  vi.stubGlobal('fetch', fetch);
  return { fetch, ejecutor: crearEjecutorNeon({ urlBaseDatos }) };
}
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); vi.restoreAllMocks(); });
async function privado(promesa: Promise<unknown>) {
  const fallo: unknown = await promesa.catch((e: unknown) => e);
  expect(fallo).toBeInstanceOf(Error);
  expect((fallo as Error).message).toBe(error);
  expect(Object.hasOwn(fallo as object, 'cause')).toBe(false);
  expect(String((fallo as Error).stack)).not.toContain('clave-sintetica');
}

describe('ejecutor HTTP Neon real, con fetch local', () => {
  it('envía un único POST con SQL y parámetros separados, conserva TEXT opaco', async () => {
    const texto = '{"horaReal":-0,"dispositivoId":"raíz\\u0000"}';
    const parametros = Object.freeze(['huella', texto, null, true, Number.MAX_SAFE_INTEGER]);
    const { fetch, ejecutor } = preparar(sobre([[texto]]));
    expect(fetch).not.toHaveBeenCalled();
    expect(await ejecutor.ejecutar(consulta, parametros)).toEqual({ filas: [{ resultado: texto }] });
    expect(fetch).toHaveBeenCalledTimes(1);
    const [destino, opciones] = fetch.mock.calls[0] as [string, RequestInit];
    expect(destino).toBe('https://api.eu-central-1.aws.neon.tech/sql');
    expect(opciones.method).toBe('POST');
    expect(JSON.parse(opciones.body as string)).toEqual({ query: consulta,
      params: ['huella', texto, null, 'true', String(Number.MAX_SAFE_INTEGER)] });
    const cabeceras = new Headers(opciones.headers);
    expect(cabeceras.get('Neon-Connection-String')).toContain(urlBaseDatos);
    expect(cabeceras.get('Neon-Raw-Text-Output')).toBe('true');
    expect(cabeceras.get('Neon-Array-Mode')).toBe('true');
    expect(opciones.signal).toBeInstanceOf(AbortSignal);
    expect(parametros[1]).toBe(texto);
  });

  it.each([[], [['uno']], [['uno'], ['dos']]].map((rows) => ({ rows })))('admite cero, una y varias filas: $rows', async ({ rows }) => {
    const { ejecutor } = preparar(sobre(rows));
    expect(await ejecutor.ejecutar('SELECT resultado', [])).toEqual({ filas: rows.map(([resultado]) => ({ resultado })) });
  });

  it('deja al SDK decodificar booleanos/números sin interpretar TEXT', async () => {
    const { ejecutor } = preparar(sobre([['t', '42', null]], [campo('permitido', 16), campo('contador', 23), campo('texto')]));
    expect(await ejecutor.ejecutar('SELECT valores', [])).toEqual({ filas: [{ permitido: true, contador: 42, texto: null }] });
  });

  it('no confirma antes de que termine la respuesta HTTP', async () => {
    let resolver!: (respuesta: Response) => void;
    vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>((r) => { resolver = r; })));
    const ejecutor = crearEjecutorNeon({ urlBaseDatos });
    let terminada = false;
    const pendiente = ejecutor.ejecutar(consulta, []).then((r) => { terminada = true; return r; });
    await vi.waitFor(() => expect(resolver).toBeTypeOf('function'));
    expect(terminada).toBe(false);
    resolver(respuesta(sobre()));
    expect(await pendiente).toEqual({ filas: [{ resultado: '{}' }] });
  });

  it.each([
    {}, { rows: [], fields: [] }, sobre([[]]), sobre([['a', 'b']]),
    { ...sobre(), rowCount: 0 }, { ...sobre(), command: null },
    sobre([['a', 'b']], [campo('duplicada'), campo('duplicada')]),
    { ...sobre(), fields: null }, { ...sobre(), rows: {} }, sobre([[{}]]),
    { ...sobre(), fields: [{ ...campo(), format: 'binary' }] },
  ])('rechaza respuestas incompletas sin éxito ficticio %j', async (dato) => {
    const { ejecutor, fetch } = preparar(dato);
    await privado(ejecutor.ejecutar(consulta, []));
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it.each([400, 401, 403, 500])('oculta errores HTTP %i, sin reintentos', async (status) => {
    const { ejecutor, fetch } = preparar();
    fetch.mockResolvedValue(new Response(JSON.stringify({ message: `${urlBaseDatos} datos-privados`, code: '28P01' }), { status }));
    await privado(ejecutor.ejecutar(consulta, []));
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it.each(['json', 'red', 'aborto'])('oculta fallos de %s', async (modo) => {
    const { ejecutor, fetch } = preparar();
    if (modo === 'json') fetch.mockResolvedValue(new Response('respuesta privada inválida'));
    else fetch.mockRejectedValue(modo === 'aborto' ? new DOMException(urlBaseDatos, 'AbortError') : new Error(urlBaseDatos));
    await privado(ejecutor.ejecutar(consulta, []));
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('vence a los diez segundos, aborta y no confunde incertidumbre con rechazo persistido', async () => {
    vi.useFakeTimers();
    const fetch = vi.fn((_destino: unknown, _opciones?: RequestInit) => new Promise<Response>(() => {}));
    vi.stubGlobal('fetch', fetch);
    const comprobacion = privado(crearEjecutorNeon({ urlBaseDatos }).ejecutar(consulta, []));
    await vi.advanceTimersByTimeAsync(0);
    const opciones = fetch.mock.calls[0]?.[1] as RequestInit | undefined;
    expect(opciones?.signal?.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(10_000);
    await comprobacion;
    expect(opciones?.signal?.aborted).toBe(true);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([true, false])('libera el temporizador al resolver/rechazar: %s', async (exito) => {
    vi.useFakeTimers();
    const { ejecutor, fetch } = preparar();
    if (!exito) fetch.mockRejectedValue(new Error('privado'));
    if (exito) await ejecutor.ejecutar(consulta, []);
    else await privado(ejecutor.ejecutar(consulta, []));
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(['', 'https://usuario:clave@neon.tech/db', 'postgresql://host/db',
    'postgresql://usuario@host/db', 'postgresql://usuario:clave@/db',
    'postgresql://usuario:clave@host/', `${urlBaseDatos}\0`, `${urlBaseDatos}\ud800`,
    'postgresql://usuario:%00@host/db', 'postgresql://usuario:%zz@host/db'])('rechaza DSN inválido sin red %j', (urlBaseDatos) => {
    const fetch = vi.fn(); vi.stubGlobal('fetch', fetch);
    expect(() => crearEjecutorNeon({ urlBaseDatos })).toThrow(error);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('rechaza configuración con getter sin leerlo', () => {
    const getter = vi.fn(() => urlBaseDatos);
    const configuracion = Object.defineProperty({}, 'urlBaseDatos', { get: getter });
    expect(() => crearEjecutorNeon(configuracion as { urlBaseDatos: string })).toThrow(error);
    expect(getter).not.toHaveBeenCalled();
  });

  it.each([NaN, Infinity, 1.5, Number.MAX_SAFE_INTEGER + 1, 1n, undefined, {}, [], new Date()])('rechaza parámetro no admitido %s antes de fetch', async (valor) => {
    const { ejecutor, fetch } = preparar();
    await privado(ejecutor.ejecutar(consulta, [valor]));
    expect(fetch).not.toHaveBeenCalled();
  });

  it('conserva SQL sin recortar y permite cero negativo solo como parámetro numérico', async () => {
    const { ejecutor, fetch } = preparar();
    await ejecutor.ejecutar(' SELECT $1 ', [-0]);
    const opciones = fetch.mock.calls[0]?.[1] as RequestInit;
    expect(JSON.parse(opciones.body as string)).toEqual({ query: ' SELECT $1 ', params: ['0'] });
  });

  it('no lee ni convierte objetos de parámetros', async () => {
    const { ejecutor, fetch } = preparar();
    const getter = vi.fn(() => 'privado');
    const valor = Object.defineProperty({}, 'toPostgres', { get: getter });
    await privado(ejecutor.ejecutar(consulta, [valor]));
    expect(getter).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });

  it('rechaza parámetros dispersos/accesores sin ejecutarlos', async () => {
    const { ejecutor, fetch } = preparar();
    const getter = vi.fn(() => 'privado');
    const parametros = Object.defineProperty([], '0', { get: getter });
    await privado(ejecutor.ejecutar(consulta, parametros));
    await privado(ejecutor.ejecutar(consulta, new Array(1)));
    expect(getter).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each(['', '\0', 'SELECT \ud800'])('rechaza SQL inválido sin alterarlo %j', async (consulta) => {
    const { ejecutor, fetch } = preparar();
    await privado(ejecutor.ejecutar(consulta, []));
    expect(fetch).not.toHaveBeenCalled();
  });
});
