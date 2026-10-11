import { describe, expect, it, vi } from 'vitest';
import { crearControladorProgreso } from '../../servidor/api-progreso';
import { FalloHttp } from '../../servidor/http';
import { serializarProgreso } from '../../src/progreso-json';
import { agregarIntencion, iniciarCola, marcarEnviada, recibirAcuse, recibirRechazo,
  capturarAcusePersistido, capturarInstantaneaProgreso, capturarRechazoPersistido } from '../../src/progreso-cola';
import { aplicarOperacion, crearProgreso, type Operacion } from '../../src/progreso';
import type { InstantaneaProgreso } from '../../src/progreso-validacion';
import type { Itinerario } from '../../src/tipos';
import { crearCredenciales, formatearCookieSesion } from '../../servidor/credenciales';
import { crearControladorSesiones, FalloSesion, type RegistroSesion } from '../../servidor/sesiones';

const plan: Itinerario = { id: 'viaje', titulo: 'Prueba', dias: [{ fecha: '2026-10-21', titulo: 'Día',
  paradas: [{ id: 'a', nombre: 'Museo', hora: '10:00', categoria: 'museo', lat: 31, lng: 121,
    subparadas: [{ id: 'sub', nombre: 'Sala' }] }] }], pendientes: [{ id: 'entrada', texto: 'Entrada' }] };
const origen = 'https://viaje.example';
const actor: RegistroSesion = { id: 'publico', huella: 'autoridad-cookie', viajeId: plan.id,
  dispositivoId: 'nuevo', creadaEn: 0, venceEn: 9999, revocada: false };
const operacion = (extra = {}): Operacion => ({ id: 'op', dispositivoId: 'antiguo', tipo: 'parada',
  paradaId: 'a', marca: 'hecha', revision: 0, ...extra });
const vacia = (): InstantaneaProgreso => ({ revisionServidor: 0, estado: crearProgreso(plan) });
function positiva(op = operacion(), base = vacia(), revisionServidor = 1) {
  const resultado = aplicarOperacion(plan, base.estado, op);
  expect(['aplicada', 'sin-cambio', 'duplicada']).toContain(resultado.tipo);
  return { operacionId: op.id, persistida: true, instantanea: { revisionServidor, estado: resultado.estado } };
}
function negativa() {
  return { viajeId: plan.id, protocolo: 1, operacionId: 'op', operacionOriginal: operacion(),
    decisionPersistida: true, motivo: 'conflicto', instantanea: vacia() };
}
function solicitud(metodo = 'GET', cuerpo: unknown = operacion(), cabeceras = {}, ruta = '/api/progreso') {
  return new Request(origen + ruta, { method: metodo,
    ...(metodo === 'POST' ? { body: JSON.stringify(cuerpo) } : {}),
    headers: { Origin: origen, 'Content-Type': 'application/json', ...cabeceras } });
}
function preparar() {
  // Doble exclusivamente de pruebas: no autentica ni persiste en producción.
  const autenticar = vi.fn(async (): Promise<RegistroSesion | null> => actor);
  const repositorio = {
    leer: vi.fn(async (_huella: string, _viaje: string): Promise<unknown> => ({ tipo: 'instantanea', instantanea: vacia() })),
    procesar: vi.fn(async (_huella: string, _viaje: string, _op: Operacion): Promise<unknown> => ({ tipo: 'confirmada', acuse: positiva() })),
  };
  const controlador = crearControladorProgreso({ plan, autenticar, repositorio });
  return { autenticar, repositorio, atender: controlador.atender };
}
async function segura(respuesta: Response, estado: number) {
  expect(respuesta.status).toBe(estado);
  expect(respuesta.headers.get('Cache-Control')).toBe('private, no-store');
  expect(respuesta.headers.get('Vary')).toBe('Cookie');
  expect(respuesta.headers.get('X-Content-Type-Options')).toBe('nosniff');
  expect(await respuesta.clone().text()).not.toMatch(/postgres:|contraseña|autoridad-cookie/);
}
function oculta<T>(valor: T): T {
  if (Array.isArray(valor)) return valor.map(oculta) as T;
  if (valor && typeof valor === 'object') {
    const copia = {};
    for (const clave of Object.getOwnPropertyNames(valor)) Object.defineProperty(copia, clave,
      { value: oculta((valor as Record<string, unknown>)[clave]) });
    return copia as T;
  }
  return valor;
}
const conGetter = () => Object.defineProperty({}, 'tipo', { get() { throw new Error('No ejecutar getter'); } });

describe('API HTTP pura de progreso', () => {
  const solicitudExacta = (op: Operacion) => new Request(origen + '/api/progreso', { method: 'POST',
    headers: { Origin: origen, 'Content-Type': 'application/json' }, body: serializarProgreso(op) });
  it('GET y acuse histórico conservan hora -0, recibo real, replay y 304 privado', async () => {
    const p = preparar(); const op = operacion({ horaReal: -0, revision: -0 });
    const acuse = positiva(op);
    p.repositorio.procesar.mockImplementation(async (_huella, _viaje, recibido) => {
      expect(recibido.tipo).toBe('parada');
      if (recibido.tipo === 'parada') {
        expect(Object.is(recibido.revision, -0)).toBe(true);
        expect(Object.is(recibido.horaReal, -0)).toBe(true);
      }
      return { tipo: 'confirmada', acuse };
    });
    const iniciada = iniciarCola(plan, vacia());
    const agregada = agregarIntencion(plan, iniciada.cola, op);
    const enviada = marcarEnviada(plan, agregada.cola, op.id);
    for (let i = 0; i < 2; i++) {
      const respuesta = await p.atender(solicitudExacta(op)); await segura(respuesta, 200);
      const datos = capturarAcusePersistido(plan, await respuesta.json());
      expect(datos).not.toBeNull();
      expect(Object.is(datos!.instantanea.estado.paradas.a.horaReal, -0)).toBe(true);
      const cambio = datos!.instantanea.estado.operaciones.op.cambios!.registros[0];
      expect(cambio.tipo).toBe('parada');
      if (cambio.tipo === 'parada') expect(Object.is(cambio.despues.horaReal, -0)).toBe(true);
      expect(recibirAcuse(plan, enviada.cola, datos).tipo).toBe('confirmada');
    }
    p.repositorio.leer.mockResolvedValue({ tipo: 'instantanea', instantanea: acuse.instantanea });
    const lectura = await p.atender(solicitud()); await segura(lectura, 200);
    const instantanea = capturarInstantaneaProgreso(plan, await lectura.json());
    expect(instantanea).not.toBeNull();
    expect(Object.is(instantanea!.estado.paradas.a.horaReal, -0)).toBe(true);
    const condicional = await p.atender(solicitud('GET', undefined, { 'If-None-Match': lectura.headers.get('ETag')! }));
    await segura(condicional, 304); expect(await condicional.text()).toBe('');
    expect(p.repositorio.leer).toHaveBeenCalledTimes(2);
  });
  it('rechazo histórico -0 llega como prueba exacta al cliente puro sin rebobinar ni reemplazar', async () => {
    const p = preparar(); const op = operacion({ horaReal: -0, revision: -0 });
    const historica = positiva(operacion({ id: 'anterior', horaReal: -0 })).instantanea;
    const rechazo = { ...negativa(), operacionOriginal: op, instantanea: historica };
    p.repositorio.procesar.mockResolvedValue(oculta({ tipo: 'rechazada', rechazo }));
    const iniciada = iniciarCola(plan, vacia());
    const agregada = agregarIntencion(plan, iniciada.cola, op);
    const enviada = marcarEnviada(plan, agregada.cola, op.id);
    for (let i = 0; i < 2; i++) {
      // Literal explícito: ni el helper legado de pruebas ni JSON.stringify pueden borrar el signo.
      const req = new Request(origen + '/api/progreso', { method: 'POST', headers: { Origin: origen,
        'Content-Type': 'application/json' }, body: '{"id":"op","dispositivoId":"antiguo","tipo":"parada","paradaId":"a","marca":"hecha","revision":-0,"horaReal":-0}' });
      const respuesta = await p.atender(req); await segura(respuesta, 409);
      const datos = capturarRechazoPersistido(plan, await respuesta.json());
      expect(datos).not.toBeNull();
      expect(datos!.operacionOriginal.tipo).toBe('parada');
      if (datos!.operacionOriginal.tipo === 'parada') {
        expect(Object.is(datos!.operacionOriginal.horaReal, -0)).toBe(true);
        expect(Object.is(datos!.operacionOriginal.revision, -0)).toBe(true);
      }
      expect(Object.is(datos!.instantanea.estado.paradas.a.horaReal, -0)).toBe(true);
      expect(recibirRechazo(plan, enviada.cola, datos).tipo).toBe('rechazada');
    }
    expect(p.repositorio.leer).not.toHaveBeenCalled();
  });
  it('GET entrega DTO directo y ETag fuerte solo tras consultar autoridad actual', async () => {
    const p = preparar();
    const primera = await p.atender(solicitud());
    await segura(primera, 200);
    expect(await primera.json()).toEqual(vacia());
    const etag = primera.headers.get('ETag')!;
    expect(etag).toMatch(/^"[\x21\x23-\x7e]+"$/);
    const segunda = await p.atender(solicitud('GET', undefined, { 'If-None-Match': etag }));
    await segura(segunda, 304);
    expect(await segunda.text()).toBe('');
    expect(segunda.headers.get('ETag')).toBe(etag);
    expect(p.repositorio.leer).toHaveBeenCalledTimes(2);
    expect(p.repositorio.leer).toHaveBeenCalledWith(actor.huella, plan.id);
  });
  it.each(['W/', 'extranjero', '*', 'lista'])('no declara frescura con condicional no exacto: %s', async (tipo) => {
    const p = preparar();
    const etag = (await p.atender(solicitud())).headers.get('ETag')!;
    const valor = tipo === 'W/' ? 'W/' + etag : tipo === 'lista' ? etag + ', "otro"' : tipo;
    await segura(await p.atender(solicitud('GET', undefined, { 'If-None-Match': valor })), 200);
  });
  it('el condicional coincidente no evita sesión ni validación de metadatos actual', async () => {
    const p = preparar(); const etiqueta = (await p.atender(solicitud())).headers.get('ETag')!;
    const req = () => solicitud('GET', undefined, { 'If-None-Match': etiqueta });
    p.repositorio.leer.mockResolvedValue({ tipo: 'instantanea', instantanea: { ...vacia(), revisionServidor: true } });
    await segura(await p.atender(req()), 503);
    p.repositorio.leer.mockResolvedValue({ tipo: 'sin-sesion' });
    await segura(await p.atender(req()), 401);
    p.autenticar.mockResolvedValue(null);
    await segura(await p.atender(req()), 401);
    expect(p.repositorio.leer).toHaveBeenCalledTimes(3);
  });
  it('el viaje participa del ETag y la revisión cambia su identidad', async () => {
    const p = preparar();
    const primero = (await p.atender(solicitud())).headers.get('ETag');
    p.repositorio.leer.mockResolvedValue({ tipo: 'instantanea', instantanea: { ...vacia(), revisionServidor: 2 } });
    expect((await p.atender(solicitud())).headers.get('ETag')).not.toBe(primero);
    const otro = { ...plan, id: 'otro' };
    const c = crearControladorProgreso({ plan: otro, autenticar: async () => ({ ...actor, viajeId: otro.id }),
      repositorio: { ...p.repositorio, leer: async () => ({ tipo: 'instantanea', instantanea: { revisionServidor: 0, estado: crearProgreso(otro) } }) } });
    expect((await c.atender(solicitud())).headers.get('ETag')).not.toBe(primero);
  });
  it.each([null, { ...actor, viajeId: 'otro' }])('sesión ausente o ajena no lee ni consume cuerpo', async (sesion) => {
    const p = preparar(); p.autenticar.mockResolvedValue(sesion);
    const req = solicitud('POST');
    await segura(await p.atender(req), 401);
    expect(req.bodyUsed).toBe(false);
    expect(p.repositorio.procesar).not.toHaveBeenCalled();
    await segura(await p.atender(solicitud('GET', undefined, { 'If-None-Match': '*' })), 401);
    expect(p.repositorio.leer).not.toHaveBeenCalled();
  });
  it.each(['', 'https://otro.example', origen + '/'])('origen exacto antes de autenticar o consumir: %s', async (Origin) => {
    const p = preparar(); const req = solicitud('POST', operacion(), { Origin });
    await segura(await p.atender(req), 403);
    expect(req.bodyUsed).toBe(false); expect(p.autenticar).not.toHaveBeenCalled();
    expect(p.repositorio.procesar).not.toHaveBeenCalled();
  });
  it.each([['/desconocida', 'POST', 404], ['/api/progreso', 'DELETE', 405], ['/api/progreso', 'PUT', 405]])(
    'rutas y métodos no consultan puertos: %s %s', async (ruta, metodo, codigo) => {
      const p = preparar(); const respuesta = await p.atender(solicitud(metodo as string, undefined, {}, ruta as string));
      await segura(respuesta, codigo as number);
      if (codigo === 405) expect(respuesta.headers.get('Allow')).toBe('GET, POST');
      expect(p.autenticar).not.toHaveBeenCalled(); expect(p.repositorio.procesar).not.toHaveBeenCalled();
    });
  it.each([{}, { tipo: 'instantanea', instantanea: { ...vacia(), revisionServidor: -1 } },
    { tipo: 'instantanea', instantanea: { ...vacia(), estado: { ...vacia().estado, paradas: { ajena: { marca: 'hecha', revision: 1 } } } } },
    { tipo: 'instantanea', instantanea: { ...vacia(), [Symbol('extra')]: true } },
    { tipo: 'instantanea', instantanea: vacia(), extra: true }, new (class { tipo = 'sin-sesion'; })(), conGetter(),
    { tipo: new String('sin-sesion') }])('GET rechaza puerto inválido sin divulgar datos %#', async (valor) => {
      const p = preparar(); p.repositorio.leer.mockResolvedValue(valor);
      await segura(await p.atender(solicitud('GET', undefined, { 'If-None-Match': '*' })), 503);
    });
  it.each(['leer', 'procesar', 'autenticar'] as const)('fallo privado en %s produce 503 constante', async (puerto) => {
    const p = preparar(); const error = new Error('postgres://contraseña@privado');
    if (puerto === 'autenticar') p.autenticar.mockRejectedValue(new FalloSesion());
    else p.repositorio[puerto].mockRejectedValue(error);
    const respuesta = await p.atender(solicitud(puerto === 'procesar' ? 'POST' : 'GET'));
    await segura(respuesta, 503); expect(await respuesta.json()).toEqual({ error: 'No se pudo comprobar el progreso.' });
  });
  it.each([
    {}, { operacion: operacion() }, { ...operacion(), extra: true }, { ...operacion(), revision: true },
    { ...operacion(), paradaId: 'ajena' }, { ...operacion(), paradaId: 'sub' },
    { ...operacion(), dispositivoId: '' }, { ...operacion(), id: 'a\0b' }, { ...operacion(), dispositivoId: '\ud800' },
    { ...operacion(), id: 'é'.repeat(65) }, { ...operacion(), id: 'a'.repeat(129) },
    { id: 'op', dispositivoId: 'antiguo', tipo: 'pendiente', pendienteId: 'otro', hecho: true, revision: 0 },
    { id: 'op', dispositivoId: 'antiguo', tipo: 'pendiente', pendienteId: 'entrada', hecho: 1, revision: 0 },
    { id: 'op', dispositivoId: 'antiguo', tipo: 'deshacer', cambios: { operacionId: 'a\0b', registros: [] } },
    { id: 'op', dispositivoId: 'antiguo', tipo: 'deshacer', cambios: { operacionId: 'original', registros: [null] } },
    { id: 'op', dispositivoId: 'antiguo', tipo: 'deshacer', cambios: { operacionId: 'original', registros: [
      { tipo: 'parada', id: 'sub', antes: { marca: null, revision: 0 }, despues: { marca: 'hecha', revision: 1 } }] } },
  ])('schema/catálogo/metadatos inválidos no generan decisión %#', async (cuerpo) => {
    const p = preparar(); await segura(await p.atender(solicitud('POST', cuerpo)), 400);
    expect(p.repositorio.procesar).not.toHaveBeenCalled();
  });
  it.each(['media', 'limite', 'malformado', 'utf8', 'preaborto', 'aborto'])('frontera de lectura %s no procesa', async (caso) => {
    const p = preparar(); const abortar = new AbortController();
    let cuerpo: string | Uint8Array<ArrayBuffer> | ReadableStream<Uint8Array> = JSON.stringify(operacion());
    if (caso === 'limite') cuerpo = ' '.repeat(65537);
    if (caso === 'malformado') cuerpo = '{';
    if (caso === 'utf8') cuerpo = new Uint8Array([0xff]);
    if (caso === 'aborto') cuerpo = new ReadableStream<Uint8Array>({ start(c) { c.enqueue(new TextEncoder().encode('{')); },
      pull() { abortar.abort('postgres://contraseña'); } });
    if (caso === 'preaborto') abortar.abort();
    const req = new Request(origen + '/api/progreso', { method: 'POST', headers: { Origin: origen,
      'Content-Type': caso === 'media' ? 'text/plain' : 'application/json' }, body: cuerpo, signal: abortar.signal,
      ...{ duplex: 'half' } });
    await segura(await p.atender(req), caso === 'media' ? 415 : caso === 'limite' ? 413 : 400);
    expect(p.repositorio.procesar).not.toHaveBeenCalled();
  });
  it('espera el puerto durable, preserva metadatos ajenos a la sesión y no emite cookie', async () => {
    const p = preparar(); let resolver!: (v: unknown) => void; let recibido!: () => void;
    const llamada = new Promise<void>((r) => { recibido = r; });
    p.repositorio.procesar.mockImplementation(async () => { recibido(); return new Promise((r) => { resolver = r; }); });
    let terminada = false;
    const pendiente = p.atender(solicitud('POST')).then((r) => { terminada = true; return r; });
    await llamada; expect(terminada).toBe(false);
    expect(p.repositorio.procesar).toHaveBeenCalledWith(actor.huella, plan.id, operacion());
    resolver({ tipo: 'confirmada', acuse: positiva() });
    const respuesta = await pendiente; await segura(respuesta, 200);
    expect(respuesta.headers.has('Set-Cookie')).toBe(false); expect(await respuesta.json()).toEqual(positiva());
  });
  it.each(['aplicada', 'sin-cambio', 'duplicada'])('prueba positiva real del núcleo: %s', async (tipo) => {
    const p = preparar(); const inicial = positiva();
    const op = tipo === 'sin-cambio' ? operacion({ id: 'segunda', revision: 1 }) : operacion();
    const acuse = tipo === 'aplicada' ? inicial : positiva(op, inicial.instantanea, tipo === 'duplicada' ? 1 : 2);
    p.repositorio.procesar.mockResolvedValue({ tipo: 'confirmada', acuse });
    const respuesta = await p.atender(solicitud('POST', op)); await segura(respuesta, 200);
    expect(await respuesta.json()).toEqual(acuse);
  });
  it('valida acuses reales de casilla y deshacer sin ejecutar mutaciones HTTP', async () => {
    const p = preparar(); const base = positiva();
    const cambios = base.instantanea.estado.operaciones.op.cambios!;
    const deshacer: Operacion = { id: 'undo', dispositivoId: 'antiguo', tipo: 'deshacer', cambios };
    const casilla: Operacion = { id: 'casilla', dispositivoId: 'antiguo', tipo: 'pendiente',
      pendienteId: 'entrada', hecho: true, revision: 0 };
    for (const op of [deshacer, casilla]) {
      const acuse = positiva(op, base.instantanea, 2);
      p.repositorio.procesar.mockResolvedValue(oculta({ tipo: 'confirmada', acuse }));
      const r = await p.atender(solicitud('POST', op)); await segura(r, 200);
      expect(await r.json()).toEqual(acuse);
    }
    expect(base.instantanea.estado.paradas.a.marca).toBe('hecha');
  });
  it('preserva identidad opaca sin trim ni coerción', async () => {
    const p = preparar(); const op = operacion({ id: ' op ', dispositivoId: ' anterior ' });
    p.repositorio.procesar.mockResolvedValue({ tipo: 'confirmada', acuse: positiva(op) });
    await segura(await p.atender(solicitud('POST', op)), 200);
    expect(p.repositorio.procesar).toHaveBeenCalledWith(actor.huella, plan.id, op);
  });
  it('acepta ID opaco UTF-8 en el límite y deshacer sin consultar recibo desde HTTP', async () => {
    const p = preparar(); const op = operacion({ id: 'é'.repeat(64) });
    p.repositorio.procesar.mockResolvedValue({ tipo: 'confirmada', acuse: positiva(op) });
    await segura(await p.atender(solicitud('POST', op)), 200);
    p.repositorio.procesar.mockResolvedValue({ tipo: 'identidad-reutilizada' });
    await segura(await p.atender(solicitud('POST', { id: 'undo', dispositivoId: 'antiguo', tipo: 'deshacer',
      cambios: { operacionId: 'original-desconocido', registros: [] } })), 409);
    expect(p.repositorio.procesar).toHaveBeenCalledTimes(2);
  });
  it.each([
    { ...positiva(), operacionId: 'otra' }, { ...positiva(), persistida: false }, { ...positiva(), extra: true },
    { ...positiva(), instantanea: vacia() }, { ...positiva(), instantanea: { ...positiva().instantanea, revisionServidor: true } },
    positiva(operacion({ marca: 'saltada' })), positiva(operacion({ id: 'ajena' })),
  ])('acuse sin prueba exacta no confirma persistencia %#', async (acuse) => {
    const p = preparar(); p.repositorio.procesar.mockResolvedValue({ tipo: 'confirmada', acuse });
    const r = await p.atender(solicitud('POST')); await segura(r, 503);
    expect(await r.text()).not.toContain('persistida');
  });
  it('rechazo histórico directo se repite sin leer/reemplazar la instantánea', async () => {
    const p = preparar(); p.repositorio.procesar.mockResolvedValue({ tipo: 'rechazada', rechazo: negativa() });
    for (let i = 0; i < 2; i++) {
      const r = await p.atender(solicitud('POST')); await segura(r, 409); expect(await r.json()).toEqual(negativa());
    }
    expect(p.repositorio.leer).not.toHaveBeenCalled();
  });
  it.each([
    { ...negativa(), decisionPersistida: false }, { ...negativa(), protocolo: 2 }, { ...negativa(), viajeId: 'otro' },
    { ...negativa(), operacionId: 'otra' }, { ...negativa(), operacionOriginal: operacion({ dispositivoId: 'otro' }) },
    { ...negativa(), instantanea: positiva().instantanea }, { ...negativa(), instantanea: { ...vacia(), revisionServidor: NaN } },
    { ...negativa(), motivo: new String('conflicto') }, { ...negativa(), extra: true },
  ])('rechazo inválido no constituye decisión durable %#', async (rechazo) => {
    const p = preparar(); p.repositorio.procesar.mockResolvedValue({ tipo: 'rechazada', rechazo });
    const r = await p.atender(solicitud('POST')); await segura(r, 503); expect(await r.text()).not.toContain('decisionPersistida');
  });
  it.each([{}, { tipo: 'confirmada' }, { tipo: 'rechazada' }, { tipo: 'identidad-reutilizada', extra: 1 },
    { tipo: 'sin-sesion', extra: 1 }, conGetter(), new (class { tipo = 'sin-sesion'; })(),
    { tipo: 'sin-sesion', [Symbol('extra')]: 1 }])('unión desconocida del puerto no se publica %#', async (valor) => {
    const p = preparar(); p.repositorio.procesar.mockResolvedValue(valor);
    await segura(await p.atender(solicitud('POST')), 503);
  });
  it('identidad reutilizada no inventa acuse ni prueba negativa', async () => {
    const p = preparar(); p.repositorio.procesar.mockResolvedValue({ tipo: 'identidad-reutilizada' });
    const r = await p.atender(solicitud('POST')); await segura(r, 409);
    expect(await r.json()).toEqual({ codigo: 'identidad-reutilizada', error: 'La identidad de operación ya tiene otro contenido.' });
  });
  it.each(['GET', 'POST'])('la revalidación atómica sin sesión devuelve 401: %s', async (metodo) => {
    const p = preparar(); p.repositorio.leer.mockResolvedValue({ tipo: 'sin-sesion' });
    p.repositorio.procesar.mockResolvedValue({ tipo: 'sin-sesion' });
    const r = await p.atender(solicitud(metodo)); await segura(r, 401);
    expect(await r.text()).not.toMatch(/persistida|decisionPersistida|<html/);
  });
  it.each(['GET', 'positiva', 'negativa'])('materializa todos los campos propios ocultos: %s', async (tipo) => {
    const p = preparar();
    p.repositorio.leer.mockResolvedValue(oculta({ tipo: 'instantanea', instantanea: vacia() }));
    p.repositorio.procesar.mockResolvedValue(oculta(tipo === 'positiva' ? { tipo: 'confirmada', acuse: positiva() }
      : { tipo: 'rechazada', rechazo: negativa() }));
    const r = await p.atender(solicitud(tipo === 'GET' ? 'GET' : 'POST'));
    await segura(r, tipo === 'negativa' ? 409 : 200);
    expect(await r.json()).toEqual(tipo === 'GET' ? vacia() : tipo === 'positiva' ? positiva() : negativa());
  });
  it.each(['GET', 'POST'])('no ejecuta accesores anidados del adaptador: %s', async (metodo) => {
    const p = preparar(); const espia = vi.fn(() => { throw new Error('postgres://contraseña'); });
    const instantanea = Object.defineProperty({ estado: vacia().estado }, 'revisionServidor', { get: espia });
    p.repositorio.leer.mockResolvedValue({ tipo: 'instantanea', instantanea });
    p.repositorio.procesar.mockResolvedValue({ tipo: 'confirmada', acuse: { ...positiva(), instantanea } });
    await segura(await p.atender(solicitud(metodo)), 503); expect(espia).not.toHaveBeenCalled();
  });
  it.each(['leer', 'procesar', 'autenticar'] as const)('FalloHttp del puerto %s sigue siendo 503', async (puerto) => {
    const p = preparar();
    if (puerto === 'autenticar') p.autenticar.mockRejectedValue(new FalloHttp(400));
    else p.repositorio[puerto].mockRejectedValue(new FalloHttp(400));
    await segura(await p.atender(solicitud(puerto === 'procesar' ? 'POST' : 'GET')), 503);
  });
  it('64 KiB exactos con JSON y espacios se aceptan, sin recortar el original', async () => {
    const p = preparar(); const texto = JSON.stringify(operacion());
    const req = new Request(origen + '/api/progreso', { method: 'POST', headers: { Origin: origen,
      'Content-Type': 'application/json' }, body: texto + ' '.repeat(65536 - new TextEncoder().encode(texto).length) });
    await segura(await p.atender(req), 200);
    expect(p.repositorio.procesar).toHaveBeenCalledWith(actor.huella, plan.id, operacion());
  });
  it('un adaptador no puede mutar el original para fabricar su prueba', async () => {
    const p = preparar();
    p.repositorio.procesar.mockImplementation(async (_huella, _viaje, op) => {
      Object.assign(op, { marca: 'saltada' });
      return { tipo: 'confirmada', acuse: positiva(op) };
    });
    await segura(await p.atender(solicitud('POST')), 503);
  });
  it('sin-cambio sin recibo propio nunca es confirmación', async () => {
    const p = preparar(); const anterior = positiva();
    p.repositorio.procesar.mockResolvedValue({ tipo: 'confirmada', acuse: { ...anterior, operacionId: 'segunda' } });
    await segura(await p.atender(solicitud('POST', operacion({ id: 'segunda', revision: 1 }))), 503);
  });
  it.each(['vigente', 'revocada', 'caducada', 'carrera'])('integra cookie real con sesiones: %s', async (caso) => {
    const credenciales = await crearCredenciales({ viajeId: plan.id, claveCompartida: 'fixture-publico-no-produccion-0123456789' });
    const emitida = await credenciales.emitirSesion();
    const registro = { ...actor, id: '12345678-1234-4234-8234-123456789abc', huella: emitida.huella,
      revocada: caso === 'revocada', venceEn: caso === 'caducada' ? 10 : 9999 };
    const sesiones = crearControladorSesiones({ viajeId: plan.id, credenciales, reloj: () => 10, repositorio: {
      crear: async () => {}, leer: async () => registro, revocar: async () => {}, admitirIntento: async () => true,
      listar: async () => ({ tipo: 'lista', sesiones: [] }), revocarOtra: async () => 'ausente',
    } });
    let mutada = false;
    const procesar = vi.fn(async () => { // Revalidación simulada: revocada después de autenticar.
      if (caso === 'carrera') return { tipo: 'sin-sesion' };
      mutada = true; return { tipo: 'confirmada', acuse: positiva() };
    });
    const c = crearControladorProgreso({ plan, autenticar: sesiones.autenticar,
      repositorio: { leer: async () => ({ tipo: 'sin-sesion' }), procesar } });
    await segura(await c.atender(solicitud('POST', operacion(), { Cookie: formatearCookieSesion(emitida.token).split(';')[0] })),
      caso === 'vigente' ? 200 : 401);
    expect(mutada).toBe(caso === 'vigente'); expect(procesar).toHaveBeenCalledTimes(['vigente', 'carrera'].includes(caso) ? 1 : 0);
  });
});
