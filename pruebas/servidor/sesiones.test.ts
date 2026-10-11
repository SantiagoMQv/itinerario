import { describe, expect, it, vi } from 'vitest';
import { crearCredenciales, borrarCookieSesion, formatearCookieSesion } from '../../servidor/credenciales';
import { crearControladorSesiones, type RegistroSesion, type RepositorioSesiones } from '../../servidor/sesiones';

// Repositorio exclusivamente de prueba: no demuestra transacciones SQL nativas.
const viajeId = 'viaje-ficticio';
const clave = 'solo-fixture-no-usar-en-produccion-0123456789';
const origen = 'https://viaje.example:8443';
const ahora = 1_800_000_000_000;
const duracion = 30 * 24 * 60 * 60 * 1000;
const contexto = { identidadRed: '192.0.2.123' }; // Red de documentación, nunca IP real.
const falloPrivado = new Error('postgres://usuario:clave@privado/clave-secreta');
const dto = { clave, dispositivoId: 'telefono-uno' };
function solicitud(metodo = 'POST', cuerpo: unknown = dto, cabeceras: Record<string, string> = {}, ruta = '/api/sesion') {
  return new Request(origen + ruta, {
    method: metodo,
    ...(metodo === 'POST' ? { body: JSON.stringify(cuerpo) } : {}),
    headers: { Origin: origen, 'Content-Type': 'application/json', ...cabeceras },
  });
}
function diferida<T>() {
  let resolver!: (valor: T) => void;
  let rechazar!: (error: unknown) => void;
  const promesa = new Promise<T>((si, no) => { resolver = si; rechazar = no; });
  return { promesa, resolver, rechazar };
}
async function preparar(reloj = () => ahora) {
  const registros = new Map<string, RegistroSesion>();
  const repo = {
    crear: vi.fn(async (registro: RegistroSesion) => { registros.set(registro.huella, registro); }),
    leer: vi.fn(async (huella: string): Promise<unknown | null> => registros.get(huella) ?? null),
    revocar: vi.fn(async (huella: string, viaje: string) => {
      const registro = registros.get(huella);
      if (registro?.viajeId === viaje) registros.set(huella, { ...registro, revocada: true });
    }),
    admitirIntento: vi.fn(async (_huella: string, _ahora: number): Promise<boolean> => true),
  } satisfies RepositorioSesiones;
  const credenciales = await crearCredenciales({ viajeId, claveCompartida: clave });
  const controlador = crearControladorSesiones({ viajeId, credenciales, repositorio: repo, reloj });
  const entrar = (cuerpo: unknown = dto, red = contexto) => controlador.atender(solicitud('POST', cuerpo), red);
  const iniciar = async () => {
    const respuesta = await entrar();
    const cookie = respuesta.headers.get('Set-Cookie')!.split(';')[0];
    const registro = [...registros.values()][0];
    return { respuesta, cookie, registro };
  };
  return { controlador, credenciales, repo, registros, entrar, iniciar };
}
async function segura(respuesta: Response, estado: number, sinCookie = false) {
  expect(respuesta.status).toBe(estado);
  expect(respuesta.headers.get('Cache-Control')).toBe('private, no-store');
  expect(respuesta.headers.get('Vary')).toBe('Cookie');
  expect(respuesta.headers.get('X-Content-Type-Options')).toBe('nosniff');
  expect(respuesta.headers.has('Access-Control-Allow-Origin')).toBe(false);
  if (sinCookie) expect(respuesta.headers.has('Set-Cookie')).toBe(false);
  const texto = await respuesta.clone().text();
  for (const secreto of [clave, contexto.identidadRed, 'postgres:', 'clave-secreta', 'huella', 'token']) {
    expect(texto).not.toContain(secreto);
  }
}

describe('sesiones HTTP y autoridad persistida', () => {
  it('crea DTO público exacto, UUID independiente y cookie nativa solo tras persistir', async () => {
    const p = await preparar();
    const espera = diferida<void>();
    const recibido = diferida<RegistroSesion>();
    p.repo.crear.mockImplementation(async (registro) => { recibido.resolver(registro); await espera.promesa; });
    let terminado = false;
    const pendiente = p.entrar({ ...dto, nombreDispositivo: ' Mi móvil 🔐 ' }).then((r) => { terminado = true; return r; });
    const registro = await Promise.race([recibido.promesa, pendiente.then(() => { throw new Error('Se respondió antes de persistir.'); })]);
    expect(terminado).toBe(false);
    expect(registro).toMatchObject({ viajeId, dispositivoId: dto.dispositivoId, creadaEn: ahora, venceEn: ahora + duracion, revocada: false, nombreDispositivo: ' Mi móvil 🔐 ' });
    expect(registro.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(Object.keys(registro).sort()).toEqual(['creadaEn', 'dispositivoId', 'huella', 'id', 'nombreDispositivo', 'revocada', 'venceEn', 'viajeId']);
    espera.resolver();
    const respuesta = await pendiente;
    await segura(respuesta, 201);
    const token = respuesta.headers.get('Set-Cookie')!.split(';')[0].split('=')[1];
    expect(respuesta.headers.get('Set-Cookie')).toBe(formatearCookieSesion(token));
    expect(registro.id).not.toBe(token);
    expect(registro.huella).toBe(await p.credenciales.leerCookie(respuesta.headers.get('Set-Cookie')!.split(';')[0]));
    expect(await respuesta.json()).toEqual({ sesion: { id: registro.id, viajeId, dispositivoId: dto.dispositivoId, venceEn: ahora + duracion, nombreDispositivo: ' Mi móvil 🔐 ' } });
  });

  it('dos dispositivos independientes generan dos registros y cookies distintas; etiqueta ausente no se guarda', async () => {
    const p = await preparar();
    const uno = await p.iniciar();
    const dos = await p.entrar({ ...dto, dispositivoId: 'telefono-dos' });
    expect(p.registros.size).toBe(2);
    const registros = [...p.registros.values()];
    expect(registros[0].id).not.toBe(registros[1].id);
    expect(dos.headers.get('Set-Cookie')!.split(';')[0]).not.toBe(uno.cookie);
    expect(Object.hasOwn(registros[0], 'nombreDispositivo')).toBe(false);
  });

  it.each([undefined, 'null', 'https://viaje.example', 'https://viaje.example:8444', 'https://evil.example'])
  ('rechaza Origin %s sin leer ni consultar ningún puerto', async (valor) => {
    const p = await preparar();
    for (const metodo of ['POST', 'DELETE']) {
      const req = solicitud(metodo);
      if (valor === undefined) req.headers.delete('Origin'); else req.headers.set('Origin', valor);
      await segura(await p.controlador.atender(req, contexto), 403, true);
      expect(req.bodyUsed).toBe(false);
    }
    expect(p.repo.admitirIntento).not.toHaveBeenCalled();
    expect(p.repo.leer).not.toHaveBeenCalled();
    expect(p.repo.crear).not.toHaveBeenCalled();
    expect(p.repo.revocar).not.toHaveBeenCalled();
  });

  it.each([null, [], {}, { clave }, { ...dto, viajeId }, { ...dto, venceEn: 0 }, { ...dto, roles: [] },
    { ...dto, dispositivoId: 1 }, { ...dto, dispositivoId: '' }, { ...dto, dispositivoId: '🔐'.repeat(33) },
    { ...dto, dispositivoId: '\ud800' }, { ...dto, nombreDispositivo: '' }, { ...dto, nombreDispositivo: null },
    { ...dto, nombreDispositivo: 1 }, { ...dto, nombreDispositivo: 'x'.repeat(81) }, { ...dto, nombreDispositivo: '\udc00' },
  ])('rechaza esquema %j antes del limitador', async (cuerpo) => {
    const p = await preparar();
    await segura(await p.entrar(cuerpo), 400, true);
    expect(p.repo.admitirIntento).not.toHaveBeenCalled();
    expect(p.repo.crear).not.toHaveBeenCalled();
  });

  it.each([['text/plain', '{}', 415], ['application/json', '{', 400], ['application/json', ' '.repeat(4097), 413]] as const)
  ('rechaza tipo/cuerpo %s con código %s', async (tipo, texto, estado) => {
    const p = await preparar();
    const req = new Request(origen + '/api/sesion', { method: 'POST', body: texto, headers: { Origin: origen, 'Content-Type': tipo } });
    await segura(await p.controlador.atender(req, contexto), estado, true);
    expect(p.repo.admitirIntento).not.toHaveBeenCalled();
  });

  it.each(['antes', 'durante'] as const)('un aborto %s de la lectura nunca crea sesión', async (momento) => {
    const p = await preparar();
    const aborto = new AbortController();
    const cuerpo = new ReadableStream<Uint8Array>({ pull(c) { c.enqueue(new TextEncoder().encode(JSON.stringify(dto))); aborto.abort(); } }, { highWaterMark: 0 });
    if (momento === 'antes') aborto.abort();
    const opciones: RequestInit & { duplex: 'half' } = { method: 'POST', body: cuerpo, duplex: 'half', signal: aborto.signal, headers: { Origin: origen, 'Content-Type': 'application/json' } };
    await segura(await p.controlador.atender(new Request(origen + '/api/sesion', opciones), contexto), 400, true);
    expect(p.repo.crear).not.toHaveBeenCalled();
    expect(p.repo.admitirIntento).not.toHaveBeenCalled();
  });

  it('cuenta clave correcta/incorrecta/Unicode inválido sin rotar bucket por dispositivo', async () => {
    const p = await preparar();
    await segura(await p.entrar({ ...dto, clave: 'incorrecta', dispositivoId: 'otro' }), 401, true);
    await segura(await p.entrar({ ...dto, clave: `${clave}\ud800` }), 401, true);
    await segura(await p.entrar(), 201);
    expect(p.repo.admitirIntento).toHaveBeenCalledTimes(3);
    const bucket = p.repo.admitirIntento.mock.calls[0][0];
    expect(bucket).toMatch(/^[0-9a-f]{64}$/);
    expect(p.repo.admitirIntento.mock.calls.every(([huella, fecha]) => huella === bucket && fecha === ahora)).toBe(true);
    await p.entrar(dto, { identidadRed: '192.0.2.124' });
    expect(p.repo.admitirIntento.mock.calls[3][0]).not.toBe(bucket);
  });

  it.each(['denegado', 'error', 'indefinido'] as const)('limitador %s falla cerrado antes de verificar o emitir', async (modo) => {
    const p = await preparar();
    p.repo.admitirIntento.mockImplementation(async () => {
      if (modo === 'error') throw falloPrivado;
      return (modo === 'denegado' ? false : undefined) as unknown as boolean;
    });
    const respuesta = await p.entrar();
    await segura(respuesta, modo === 'denegado' ? 429 : 503, true);
    expect(respuesta.headers.get('Retry-After')).toBe(modo === 'denegado' ? '600' : null);
    expect(p.repo.crear).not.toHaveBeenCalled();
  });

  it('no sustituye identidad confiable ausente por la del cuerpo', async () => {
    const p = await preparar();
    await segura(await p.controlador.atender(solicitud()), 503, true);
    expect(p.repo.admitirIntento).not.toHaveBeenCalled();
  });

  it('persistencia rechazada no confirma ni emite cookie', async () => {
    const p = await preparar();
    p.repo.crear.mockRejectedValue(falloPrivado);
    await segura(await p.entrar(), 503, true);
  });

  it('GET consulta DB cada vez y devuelve únicamente DTO público', async () => {
    const p = await preparar();
    const { cookie, registro } = await p.iniciar();
    for (let i = 0; i < 2; i++) {
      const req = solicitud('GET', undefined, { Cookie: cookie, 'X-Dispositivo-Id': 'mentira' });
      const respuesta = await p.controlador.atender(req);
      await segura(respuesta, 200, true);
      expect(await respuesta.json()).toEqual({ sesion: { id: registro.id, viajeId, dispositivoId: dto.dispositivoId, venceEn: ahora + duracion } });
      expect(await p.controlador.autenticar(req)).toEqual(registro);
    }
    expect(p.repo.leer).toHaveBeenCalledTimes(4);
    expect(p.repo.admitirIntento).toHaveBeenCalledTimes(1);
  });

  it.each(['ausente', 'mac', 'publico', 'dispositivo'] as const)('no autentica por %s y no lee DB', async (modo) => {
    const p = await preparar();
    const { cookie, registro } = await p.iniciar();
    const headers: Record<string, string> = modo === 'ausente' ? {} : { Cookie: modo === 'mac' ? cookie.slice(0, -4) + 'aaaa' : '__Host-itinerario=' + (modo === 'publico' ? registro.id : registro.dispositivoId) };
    const req = solicitud('GET', undefined, headers);
    await segura(await p.controlador.atender(req), 401);
    expect(await p.controlador.autenticar(req)).toBeNull();
    expect(p.repo.leer).not.toHaveBeenCalled();
  });

  it.each(['ausente', 'expirada', 'revocada', 'otro-viaje'] as const)('sesión %s no autoriza y logout es idempotente', async (modo) => {
    const p = await preparar();
    const { cookie, registro } = await p.iniciar();
    p.repo.leer.mockResolvedValue(modo === 'ausente' ? null : { ...registro, ...(modo === 'expirada' ? { venceEn: ahora } : modo === 'revocada' ? { revocada: true } : { viajeId: 'otro-viaje' }) });
    const get = await p.controlador.atender(solicitud('GET', undefined, { Cookie: cookie }));
    await segura(get, 401);
    expect(get.headers.get('Set-Cookie')).toBe(borrarCookieSesion());
    const salida = await p.controlador.atender(solicitud('DELETE', undefined, { Cookie: cookie }));
    expect(salida.status).toBe(200);
    expect(await salida.json()).toEqual({ sesion: null });
    expect(salida.headers.get('Set-Cookie')).toBe(borrarCookieSesion());
    expect(p.repo.revocar).not.toHaveBeenCalled();
  });

  const corruptores: ((r: RegistroSesion) => unknown)[] = [
    () => undefined, () => [], (r) => ({ ...r, huella: '0'.repeat(64) }), (r) => ({ ...r, revocada: 0 }),
    (r) => ({ ...r, creadaEn: NaN }), (r) => ({ ...r, venceEn: Infinity }), (r) => ({ ...r, creadaEn: r.venceEn + 1 }),
    (r) => ({ ...r, nombreDispositivo: undefined }), (r) => ({ ...r, id: 5 }), (r) => ({ ...r, dispositivoId: '\ud800' }),
    (r) => ({ ...r, extra: true }), (r) => Object.defineProperty({ ...r }, 'oculto', { value: true }),
    (r) => ({ ...r, [Symbol('extra')]: true }), (r) => Object.assign(Object.create({ heredado: true }), r),
    (r) => Object.defineProperty({ ...r }, 'id', { get() { throw falloPrivado; } }),
    (r) => ({ ...r, creadaEn: 0.5 }), (r) => ({ ...r, venceEn: Number.MAX_SAFE_INTEGER + 1 }),
  ];
  it.each(corruptores)('metadatos corruptos dan 503 sin borrar ni revocar', async (corromper) => {
    const p = await preparar();
    const { cookie, registro } = await p.iniciar();
    p.repo.leer.mockResolvedValue(corromper(registro));
    for (const metodo of ['GET', 'DELETE']) await segura(await p.controlador.atender(solicitud(metodo, undefined, { Cookie: cookie })), 503, true);
    await expect(p.controlador.autenticar(solicitud('GET', undefined, { Cookie: cookie }))).rejects.toThrow('No se pudo comprobar la sesión.');
    expect(p.repo.revocar).not.toHaveBeenCalled();
  });

  it('fallo de lectura no se convierte en ausencia; caducidad se evalúa después de await', async () => {
    let tiempo = ahora;
    const p = await preparar(() => tiempo);
    const { cookie, registro } = await p.iniciar();
    p.repo.leer.mockRejectedValueOnce(falloPrivado);
    await segura(await p.controlador.atender(solicitud('GET', undefined, { Cookie: cookie })), 503, true);
    const espera = diferida<unknown>();
    p.repo.leer.mockReturnValueOnce(espera.promesa);
    const pendiente = p.controlador.atender(solicitud('GET', undefined, { Cookie: cookie }));
    await vi.waitFor(() => expect(p.repo.leer).toHaveBeenCalledTimes(2));
    tiempo = registro.venceEn;
    espera.resolver(registro);
    await segura(await pendiente, 401);
  });

  it('DELETE espera revocación duradera y nunca confirma si esta falla', async () => {
    const p = await preparar();
    const { cookie, registro } = await p.iniciar();
    const espera = diferida<void>();
    p.repo.revocar.mockReturnValueOnce(espera.promesa);
    let terminado = false;
    const pendiente = p.controlador.atender(solicitud('DELETE', undefined, { Cookie: cookie })).then((r) => { terminado = true; return r; });
    await vi.waitFor(() => expect(p.repo.revocar).toHaveBeenCalledWith(registro.huella, viajeId));
    expect(terminado).toBe(false);
    espera.rechazar(falloPrivado);
    await segura(await pendiente, 503, true);
    const salida = await p.controlador.atender(solicitud('DELETE', undefined, { Cookie: cookie }));
    expect(salida.headers.get('Set-Cookie')).toBe(borrarCookieSesion());
    expect(await salida.json()).toEqual({ sesion: null });
    expect(await p.controlador.autenticar(solicitud('GET', undefined, { Cookie: cookie }))).toBeNull();
  });

  it('logout sin cookie o con cookie inválida no consulta DB ni limita', async () => {
    const p = await preparar();
    for (const Cookie of ['', '__Host-itinerario=mentira']) {
      const r = await p.controlador.atender(solicitud('DELETE', undefined, { Cookie }));
      expect(r.status).toBe(200);
      expect(r.headers.get('Set-Cookie')).toBe(borrarCookieSesion());
    }
    expect(p.repo.leer).not.toHaveBeenCalled();
    expect(p.repo.admitirIntento).not.toHaveBeenCalled();
  });

  it('body/header de dispositivo o UUID público no autorizan ni revocan otro registro', async () => {
    const p = await preparar();
    const { registro } = await p.iniciar();
    const req = new Request(origen + '/api/sesion', {
      method: 'DELETE', body: JSON.stringify({ dispositivoId: registro.dispositivoId, id: registro.id }),
      headers: { Origin: origen, 'X-Sesion-Id': registro.id, 'X-Dispositivo-Id': registro.dispositivoId },
    });
    expect((await p.controlador.atender(req)).status).toBe(200);
    expect(req.bodyUsed).toBe(false);
    expect(p.repo.revocar).not.toHaveBeenCalled();
    expect(p.repo.leer).not.toHaveBeenCalled();
    expect(p.registros.get(registro.huella)?.revocada).toBe(false);
    expect(await p.controlador.autenticar(req)).toBeNull();
  });

  it('ruta desconocida y método no permitido nunca caen a assets', async () => {
    const p = await preparar();
    await segura(await p.controlador.atender(solicitud('GET', undefined, {}, '/api/otra')), 404, true);
    const r = await p.controlador.atender(solicitud('PUT'));
    await segura(r, 405, true);
    expect(r.headers.get('Allow')).toBe('POST, GET, DELETE');
    expect(p.repo.leer).not.toHaveBeenCalled();
  });

  it.each([NaN, Infinity, -1, 1.2, Number.MAX_SAFE_INTEGER - duracion + 1])('reloj %s inválido falla cerrado', async (tiempo) => {
    const p = await preparar(() => tiempo);
    await segura(await p.entrar(), 503, true);
    expect(p.repo.crear).not.toHaveBeenCalled();
  });

  it('acepta límites y Unicode exacto sin normalizar clave ni metadatos', async () => {
    const p = await preparar();
    const exacta = ` ${'ñ🔐é'.repeat(8)} `;
    const credenciales = await crearCredenciales({ viajeId, claveCompartida: exacta });
    const c = crearControladorSesiones({ viajeId, credenciales, repositorio: p.repo, reloj: () => ahora });
    const dispositivoId = '🔐'.repeat(32);
    const nombreDispositivo = '🔐'.repeat(80);
    await segura(await c.atender(solicitud('POST', { clave: exacta, dispositivoId, nombreDispositivo }), contexto), 201);
    expect([...p.registros.values()][0]).toMatchObject({ dispositivoId, nombreDispositivo });
    expect((await c.atender(solicitud('POST', { clave: exacta.trim(), dispositivoId }), contexto)).status).toBe(401);
    expect((await c.atender(solicitud('POST', { clave: exacta.normalize('NFD'), dispositivoId }), contexto)).status).toBe(401);
    for (const candidata of [null, {}, [], 1]) expect((await p.entrar({ ...dto, clave: candidata })).status).toBe(401);
  });

  it('la negativa del limitador precede incluso la verificación de clave', async () => {
    const p = await preparar();
    const verificarClave = vi.fn(p.credenciales.verificarClave);
    const emitirSesion = vi.fn(p.credenciales.emitirSesion);
    const c = crearControladorSesiones({ viajeId, repositorio: p.repo, credenciales: { ...p.credenciales, verificarClave, emitirSesion } });
    p.repo.admitirIntento.mockResolvedValue(false);
    await segura(await c.atender(solicitud(), contexto), 429, true);
    expect(verificarClave).not.toHaveBeenCalled();
    expect(emitirSesion).not.toHaveBeenCalled();
  });

  it.each(['digest', 'randomUUID'] as const)('fallo criptográfico nativo %s no escribe ni divulga', async (metodo) => {
    const p = await preparar();
    const espia = metodo === 'digest'
      ? vi.spyOn(crypto.subtle, 'digest').mockRejectedValue(falloPrivado)
      : vi.spyOn(crypto, 'randomUUID').mockImplementation(() => { throw falloPrivado; });
    try {
      await segura(await p.entrar(), 503, true);
      expect(p.repo.crear).not.toHaveBeenCalled();
    } finally { espia.mockRestore(); }
  });

  it('el dominio de viaje y red no admite alias de separadores', async () => {
    const p = await preparar();
    const otroViaje = viajeId + '|red';
    const c = crearControladorSesiones({ viajeId: otroViaje, credenciales: await crearCredenciales({ viajeId: otroViaje, claveCompartida: clave }), repositorio: p.repo });
    await p.entrar(dto, { identidadRed: 'red|192.0.2.123' });
    await c.atender(solicitud(), contexto);
    expect(p.repo.admitirIntento.mock.calls[0][0]).not.toBe(p.repo.admitirIntento.mock.calls[1][0]);
  });

  it('valida configuración y captura viaje fijo; fallos crypto son seguros', async () => {
    const p = await preparar();
    expect(() => crearControladorSesiones({ viajeId: '', credenciales: p.credenciales, repositorio: p.repo })).toThrow();
    const credenciales = { ...p.credenciales, verificarClave: async () => { throw falloPrivado; } };
    const c = crearControladorSesiones({ viajeId, credenciales, repositorio: p.repo });
    await segura(await c.atender(solicitud(), contexto), 503, true);
    const cookie = (await p.iniciar()).cookie;
    const c2 = crearControladorSesiones({ viajeId, repositorio: p.repo, credenciales: { ...p.credenciales, leerCookie: async () => { throw falloPrivado; } } });
    await segura(await c2.atender(solicitud('GET', undefined, { Cookie: cookie })), 503, true);
    await expect(c2.autenticar(solicitud('GET', undefined, { Cookie: cookie }))).rejects.toThrow('No se pudo comprobar la sesión.');
  });
});
