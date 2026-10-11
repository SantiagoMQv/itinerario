import { describe, expect, it, vi } from 'vitest';
import { borrarCookieSesion, crearCredenciales } from '../../servidor/credenciales';
import { crearControladorSesiones, type RegistroSesion, type RepositorioSesiones, type RespuestaDispositivos } from '../../servidor/sesiones';

const origen = 'https://viaje.example';
const viajeId = 'viaje-prueba';
const clave = 'fixture-publico-exclusivo-de-pruebas-0123456789';
const privado = new Error('postgres://usuario:secreto@privado');
function diferida<T>() {
  let resolver!: (valor: T) => void;
  const promesa = new Promise<T>((si) => { resolver = si; });
  return { promesa, resolver };
}
function solicitud(metodo: string, ruta: string, cookie = '', cuerpo?: unknown) {
  return new Request(origen + ruta, { method: metodo, headers: { Origin: origen, Cookie: cookie,
    'Content-Type': 'application/json' }, ...(cuerpo === undefined ? {} : { body: JSON.stringify(cuerpo) }) });
}
// Simula el contrato atómico con callbacks; NO prueba PostgreSQL, locks ni aislamiento real.
async function preparar() {
  let tiempo = 1_800_000_000_000;
  const registros = new Map<string, RegistroSesion>();
  const vivo = (huella: string, viaje: string) => {
    const r = registros.get(huella);
    return r && r.viajeId === viaje && !r.revocada && r.venceEn > tiempo;
  };
  const repo = {
    crear: vi.fn(async (r: RegistroSesion) => { registros.set(r.huella, r); }),
    leer: vi.fn(async (huella: string): Promise<unknown> => registros.get(huella) ?? null),
    revocar: vi.fn(async () => {}),
    admitirIntento: vi.fn(async () => true),
    listar: vi.fn(async (actor: string, viaje: string): Promise<unknown> => vivo(actor, viaje)
      ? { tipo: 'lista', sesiones: [...registros.values()].filter((r) => r.viajeId === viaje) }
      : { tipo: 'sin-sesion' }),
    revocarOtra: vi.fn(async (actor: string, viaje: string, id: string): Promise<'revocada' | 'ausente' | 'sin-sesion'> => {
      if (!vivo(actor, viaje)) return 'sin-sesion';
      const r = [...registros.values()].find((r) => r.id === id && r.viajeId === viaje);
      if (!r) return 'ausente';
      registros.set(r.huella, { ...r, revocada: true });
      return 'revocada';
    }),
  } satisfies RepositorioSesiones;
  const controlador = crearControladorSesiones({ viajeId, repositorio: repo,
    credenciales: await crearCredenciales({ viajeId, claveCompartida: clave }), reloj: () => tiempo });
  const entrar = async (dispositivoId: string) => {
    const respuesta = await controlador.atender(solicitud('POST', '/api/sesion', '',
      { clave, dispositivoId, nombreDispositivo: dispositivoId }), { identidadRed: '192.0.2.1' });
    expect(respuesta.status).toBe(201);
    const cookie = respuesta.headers.get('Set-Cookie')!.split(';')[0];
    const r = [...registros.values()].find((r) => r.dispositivoId === dispositivoId)!;
    return { cookie, r };
  };
  const uno = await entrar('uno');
  const dos = await entrar('dos');
  const listar = () => controlador.atender(solicitud('GET', '/api/sesiones', uno.cookie));
  const revocar = (id = dos.r.id, cookie = uno.cookie) => controlador.atender(solicitud('DELETE', '/api/sesiones/' + id, cookie));
  return { repo, controlador, registros, uno, dos, listar, revocar, avanzar: (t: number) => { tiempo = t; } };
}
async function segura(respuesta: Response, estado: number, borra = false) {
  expect(respuesta.status).toBe(estado);
  expect(respuesta.headers.get('Cache-Control')).toBe('private, no-store');
  expect(respuesta.headers.get('Vary')).toBe('Cookie');
  expect(respuesta.headers.get('X-Content-Type-Options')).toBe('nosniff');
  expect(respuesta.headers.get('Content-Type')).toBe('application/json; charset=utf-8');
  expect(respuesta.headers.get('Set-Cookie')).toBe(borra ? borrarCookieSesion() : null);
  const texto = await respuesta.clone().text();
  for (const secreto of [clave, 'postgres:', 'secreto', 'huella', 'token', 'creadaEn', 'revocada":true']) expect(texto).not.toContain(secreto);
}

describe('listado privado y revocación de dispositivos', () => {
  it('lista dos sesiones con DTO exacto, actual primero, sin mutaciones ni limitador adicional', async () => {
    const p = await preparar();
    const respuesta = await p.listar();
    await segura(respuesta, 200);
    const dto = ({ r }: typeof p.uno, actual: boolean) => ({ id: r.id, viajeId, dispositivoId: r.dispositivoId,
      venceEn: r.venceEn, nombreDispositivo: r.nombreDispositivo, actual });
    expect(await respuesta.json()).toEqual({ sesiones: [dto(p.uno, true), dto(p.dos, false)] });
    expect(p.repo.listar).toHaveBeenCalledWith(p.uno.r.huella, viajeId);
    expect(p.repo.revocarOtra).not.toHaveBeenCalled();
    expect(p.repo.revocar).not.toHaveBeenCalled();
    expect(p.repo.crear).toHaveBeenCalledTimes(2);
    expect(p.repo.admitirIntento).toHaveBeenCalledTimes(2);
  });

  it('valida todos los registros y filtra revocados y vencidos con reloj posterior al await', async () => {
    const p = await preparar();
    const espera = diferida<unknown>();
    p.repo.listar.mockReturnValueOnce(espera.promesa);
    const pendiente = p.listar();
    await vi.waitFor(() => expect(p.repo.listar).toHaveBeenCalledOnce());
    p.avanzar(p.dos.r.venceEn);
    espera.resolver({ tipo: 'lista', sesiones: [p.dos.r, { ...p.uno.r, revocada: true }] });
    await segura(await pendiente, 200);
    expect(await (await pendiente).json()).toEqual({ sesiones: [] });
    p.avanzar(p.uno.r.creadaEn);
    p.repo.listar.mockResolvedValueOnce({ tipo: 'lista', sesiones: [] });
    expect(await (await p.listar()).json()).toEqual({ sesiones: [] });
  });

  const corruptores: ((a: RegistroSesion, b: RegistroSesion) => unknown)[] = [
    () => null, () => undefined, () => ({ tipo: 'otra', sesiones: [] }),
    () => ({ tipo: 'sin-sesion', extra: true }), () => ({ tipo: 'lista' }),
    () => ({ tipo: 'lista', sesiones: [], extra: true }),
    () => ({ tipo: 'lista', sesiones: new Array(1) }),
    () => ({ tipo: 'lista', sesiones: Object.assign([], { [Symbol('extra')]: 1 }) }),
    (a) => ({ tipo: 'lista', sesiones: [a, a] }),
    (a, b) => ({ tipo: 'lista', sesiones: [a, { ...b, huella: a.huella }] }),
    (a, b) => ({ tipo: 'lista', sesiones: [{ ...b, id: a.id }] }),
    (a) => ({ tipo: 'lista', sesiones: [{ ...a, viajeId: 'ajeno' }] }),
    (a) => ({ tipo: 'lista', sesiones: [{ ...a, venceEn: NaN }] }),
    (a) => ({ tipo: 'lista', sesiones: [{ ...a, nombreDispositivo: undefined, revocada: true }] }),
    (a) => ({ tipo: 'lista', sesiones: [{ ...a, secreto: clave }] }),
    (a) => ({ tipo: 'lista', sesiones: [Object.defineProperty({ ...a }, 'id', { get() { throw privado; } })] }),
    () => Object.assign(Object.create({ tipo: 'lista' }), { sesiones: [] }),
    () => ({ tipo: 'lista', sesiones: Object.defineProperty([], '0', { get() { throw privado; } }) }),
    () => ({ tipo: 'lista', sesiones: [], [Symbol('extra')]: true }),
    () => ({ tipo: 'lista', sesiones: Object.assign([], { extra: true }) }),
    () => Object.defineProperty({ tipo: 'lista', sesiones: [] }, 'sesiones', { get() { throw privado; } }),
    (a) => ({ tipo: 'lista', sesiones: [Object.assign(Object.create(a), {})] }),
    (a) => ({ tipo: 'lista', sesiones: [{ ...a, [Symbol('extra')]: true }] }),
    (a, b) => ({ tipo: 'lista', sesiones: [{ ...b, huella: a.huella }] }),
  ];
  it.each(corruptores)('no oculta corrupción ni filtra filas inválidas como si fueran ausentes', async (corromper) => {
    const p = await preparar();
    p.repo.listar.mockResolvedValueOnce(corromper(p.uno.r, p.dos.r));
    await segura(await p.listar(), 503);
  });

  it.each(['ausente', 'mac', 'nula', 'corrupta', 'error'] as const)('actor %s nunca alcanza los nuevos puertos', async (modo) => {
    const p = await preparar();
    const cookie = modo === 'ausente' ? '' : modo === 'mac' ? p.uno.cookie.slice(0, -4) + 'aaaa' : p.uno.cookie;
    if (modo === 'nula') p.repo.leer.mockResolvedValue(null);
    if (modo === 'corrupta') p.repo.leer.mockResolvedValue({ ...p.uno.r, revocada: 0 });
    if (modo === 'error') p.repo.leer.mockRejectedValue(privado);
    for (const [metodo, ruta] of [['GET', '/api/sesiones'], ['DELETE', '/api/sesiones/' + p.dos.r.id]]) {
      await segura(await p.controlador.atender(solicitud(metodo, ruta, cookie)),
        modo === 'corrupta' || modo === 'error' ? 503 : 401, modo !== 'corrupta' && modo !== 'error');
    }
    expect(p.repo.listar).not.toHaveBeenCalled();
    expect(p.repo.revocarOtra).not.toHaveBeenCalled();
    if (modo === 'ausente' || modo === 'mac') expect(p.repo.leer).not.toHaveBeenCalled();
  });

  it('ordena otras sesiones por creación y omite nombre ausente, revocadas y vencidas', async () => {
    const p = await preparar();
    const antigua = { ...p.dos.r, creadaEn: p.dos.r.creadaEn - 1 };
    const nueva = { ...p.dos.r, id: crypto.randomUUID(), huella: '1'.repeat(64), creadaEn: p.dos.r.creadaEn + 1 };
    const { nombreDispositivo: _nombre, ...sinNombre } = antigua;
    p.repo.listar.mockResolvedValueOnce({ tipo: 'lista', sesiones: [sinNombre, nueva, p.uno.r,
      { ...nueva, id: crypto.randomUUID(), huella: '2'.repeat(64), revocada: true },
      { ...antigua, id: crypto.randomUUID(), huella: '3'.repeat(64), venceEn: p.uno.r.creadaEn }] });
    const respuesta = await p.listar();
    await segura(respuesta, 200);
    const datos = await respuesta.json() as RespuestaDispositivos;
    expect(datos.sesiones.map((r: { id: string }) => r.id)).toEqual([p.uno.r.id, nueva.id, antigua.id]);
    expect(Object.keys(datos.sesiones[2]).sort()).toEqual(['actual', 'dispositivoId', 'id', 'venceEn', 'viajeId']);
    expect(datos.sesiones.map((r: { actual: boolean }) => r.actual)).toEqual([true, false, false]);
  });

  it('listado pierde autoridad concurrentemente dentro del puerto, sin revelar sesiones', async () => {
    const p = await preparar();
    const operacion = p.repo.listar.getMockImplementation()!;
    const espera = diferida<void>();
    p.repo.listar.mockImplementation(async (...args) => { await espera.promesa; return operacion(...args); });
    const pendiente = p.listar();
    await vi.waitFor(() => expect(p.repo.listar).toHaveBeenCalledOnce());
    p.registros.set(p.uno.r.huella, { ...p.uno.r, revocada: true });
    espera.resolver();
    const respuesta = await pendiente;
    await segura(respuesta, 401, true);
    expect(await respuesta.json()).toEqual({ sesion: null });
  });

  it('exige ambos puertos nuevos sin implementar sustitutos silenciosos', async () => {
    const p = await preparar();
    const credenciales = await crearCredenciales({ viajeId, claveCompartida: clave });
    for (const campo of ['listar', 'revocarOtra']) {
      expect(() => crearControladorSesiones({ viajeId, credenciales,
        repositorio: { ...p.repo, [campo]: undefined } as unknown as RepositorioSesiones })).toThrow('La configuración');
    }
  });

  it('listado revalida actor y no convierte fallos privados en ausencia', async () => {
    const p = await preparar();
    p.repo.listar.mockResolvedValueOnce({ tipo: 'sin-sesion' });
    await segura(await p.listar(), 401, true);
    p.repo.listar.mockRejectedValueOnce(privado);
    await segura(await p.listar(), 503);
  });

  it.each([undefined, 'https://ajeno.example'])('Origin %s se comprueba antes de autenticar o revocar', async (valor) => {
    const p = await preparar();
    const req = solicitud('DELETE', '/api/sesiones/' + p.dos.r.id, p.uno.cookie, { dispositivoId: 'spoof' });
    if (valor === undefined) req.headers.delete('Origin'); else req.headers.set('Origin', valor);
    await segura(await p.controlador.atender(req), 403);
    expect(req.bodyUsed).toBe(false);
    expect(p.repo.leer).not.toHaveBeenCalled();
    expect(p.repo.revocarOtra).not.toHaveBeenCalled();
  });

  it.each(['mal', '%ZZ', '%2e%2e', '%2F', '00000000-0000-1000-8000-000000000000',
    '00000000-0000-4000-8000-000000000000/extra', '00000000-0000-4000-8000-000000000000.json'])
  ('rechaza objetivo %s sin invocar el puerto', async (id) => {
    const p = await preparar();
    const respuesta = await p.revocar(id);
    expect([400, 404]).toContain(respuesta.status);
    await segura(respuesta, respuesta.status);
    expect(p.repo.revocarOtra).not.toHaveBeenCalled();
  });

  it.each([['POST', '/api/sesiones'], ['DELETE', '/api/sesiones'], ['GET', '/api/sesiones/'],
    ['GET', '/api/sesiones/00000000-0000-4000-8000-000000000000'],
    ['POST', '/api/sesiones/00000000-0000-4000-8000-000000000000']])
  ('ruta y método estrictos %s %s', async (metodo, ruta) => {
    const p = await preparar();
    const respuesta = await p.controlador.atender(solicitud(metodo, ruta, p.uno.cookie));
    expect([404, 405]).toContain(respuesta.status);
    await segura(respuesta, respuesta.status);
    expect(p.repo.leer).not.toHaveBeenCalled();
    expect(p.repo.revocarOtra).not.toHaveBeenCalled();
  });

  it('cuerpo y query no eligen actor ni viaje; revocar otro mantiene cookie y su próximo GET falla', async () => {
    const p = await preparar();
    const req = solicitud('DELETE', '/api/sesiones/' + p.dos.r.id + '?actor=' + p.dos.r.id + '&viajeId=ajeno',
      p.uno.cookie, { dispositivoId: p.dos.r.dispositivoId, viajeId: 'ajeno', actor: p.dos.r.huella });
    const respuesta = await p.controlador.atender(req);
    await segura(respuesta, 200);
    expect(await respuesta.json()).toEqual({ revocada: p.dos.r.id });
    expect(req.bodyUsed).toBe(false);
    expect(p.repo.revocarOtra).toHaveBeenCalledWith(p.uno.r.huella, viajeId, p.dos.r.id);
    await segura(await p.controlador.atender(solicitud('GET', '/api/sesion', p.dos.cookie)), 401, true);
    await segura(await p.controlador.atender(solicitud('GET', '/api/sesion', p.uno.cookie)), 200);
    await segura(await p.revocar(), 200); // Objetivo ya revocado, actor todavía válido.
  });

  it.each([false, true])('espera commit y solo borra cookie del objetivo propio (%s), normalizando UUID', async (propia) => {
    const p = await preparar();
    const espera = diferida<'revocada'>();
    p.repo.revocarOtra.mockReturnValueOnce(espera.promesa);
    const objetivo = propia ? p.uno.r : p.dos.r;
    const codificado = objetivo.id.toUpperCase().replace(/-/g, '%2D');
    let terminado = false;
    const pendiente = p.revocar(codificado).then((r) => { terminado = true; return r; });
    await vi.waitFor(() => expect(p.repo.revocarOtra).toHaveBeenCalledWith(p.uno.r.huella, viajeId, objetivo.id));
    expect(terminado).toBe(false);
    espera.resolver('revocada');
    const respuesta = await pendiente;
    await segura(respuesta, 200, propia);
    expect(await respuesta.json()).toEqual({ revocada: objetivo.id });
  });

  it('objetivo de otro viaje y ausente son indistinguibles, sin borrar cookie propia', async () => {
    const p = await preparar();
    p.registros.set(p.dos.r.huella, { ...p.dos.r, viajeId: 'ajeno' });
    const ajena = await p.revocar();
    await segura(ajena, 404);
    const ausente = await p.revocar(crypto.randomUUID());
    await segura(ausente, 404);
    expect(await ajena.json()).toEqual(await ausente.json());
    expect(p.registros.get(p.dos.r.huella)?.revocada).toBe(false);
  });

  it.each(['revocada', 'expirada'] as const)('pérdida concurrente de actor %s no toca al objetivo', async (modo) => {
    const p = await preparar();
    const operacion = p.repo.revocarOtra.getMockImplementation()!;
    const espera = diferida<void>();
    p.repo.revocarOtra.mockImplementation(async (...args) => { await espera.promesa; return operacion(...args); });
    const pendiente = p.revocar();
    await vi.waitFor(() => expect(p.repo.revocarOtra).toHaveBeenCalledOnce());
    if (modo === 'revocada') p.registros.set(p.uno.r.huella, { ...p.uno.r, revocada: true });
    else p.avanzar(p.uno.r.venceEn);
    espera.resolver();
    await segura(await pendiente, 401, true);
    expect(p.registros.get(p.dos.r.huella)?.revocada).toBe(false);
  });

  it.each([undefined, null, true, new String('revocada'), 'otra', { tipo: 'revocada' }])
  ('resultado no literal %j nunca confirma ni borra cookie propia', async (valor) => {
    const p = await preparar();
    p.repo.revocarOtra.mockResolvedValueOnce(valor as 'revocada');
    await segura(await p.revocar(p.uno.r.id), 503);
  });

  it('rechazo del puerto no confirma revocación ni borra cookie propia', async () => {
    const p = await preparar();
    p.repo.revocarOtra.mockRejectedValueOnce(privado);
    await segura(await p.revocar(p.uno.r.id), 503);
    expect(p.registros.get(p.uno.r.huella)?.revocada).toBe(false);
  });
});
