import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Itinerario } from '../src/tipos';
import { itinerario } from '../src/datos/itinerario';
import { crearClienteListadoFotos, type PresupuestoListadoFotosCliente } from '../src/fotos-listado';
import { serializarSolicitudRespaldo, deserializarSolicitudRespaldo } from '../src/fotos-protocolo';
import { deserializarPaginaListadoFotos, serializarCursorListadoFotos,
  serializarPaginaListadoFotos } from '../src/fotos-listado-protocolo';

it('Una llamada manual devuelve una página exacta y no sigue su continuación', async () => {
  const fotoId = '12345678-1234-4234-8234-123456789012';
  const inicial = serializarSolicitudRespaldo(itinerario, {
    version: 1, tipo: 'solicitud-respaldo', viajeId: itinerario.id,
    fotoId, operacionId: '32345678-1234-4234-8234-123456789012',
    original: { formato: 1, fotoId,
      destino: { tipo: 'parada', viajeId: itinerario.id, paradaId: itinerario.dias[0].paradas[0].id },
      nombre: 'e\u0301\0 original.jpg', mimeDeclarado: 'image/heic',
      ultimaModificacion: -0, incorporada: -0, bytesOriginal: 12 },
  });
  const continuacion = serializarCursorListadoFotos(itinerario, {
    version: 1, viajeId: itinerario.id, despuesDe: fotoId,
    hasta: '22345678-1234-4234-8234-123456789012',
  });
  // 512 MiB de admisión lógica, no asignación, cuota real ni valor por defecto.
  const presupuesto: PresupuestoListadoFotosCliente = {
    maxFilas: 8, maxBytesPagina: 3156764, maxBytesChunk: 4194304,
    maxBytesBackingChunk: 4194304, maxLecturas: 65536, maxBytesPlan: 4194304,
    maxBytesRetenidos: 512 * 1024 * 1024, plazoMs: 10000,
  };
  const texto = serializarPaginaListadoFotos(itinerario, {
    version: 1, tipo: 'listado-respaldos', viajeId: itinerario.id,
    solicitudesIniciales: [inicial], continuacion,
  }, presupuesto.maxFilas, presupuesto.maxBytesPagina);
  // El codec existente verifica el fixture antes de ejercitar el cliente.
  const pagina = deserializarPaginaListadoFotos(itinerario, texto,
    presupuesto.maxFilas, presupuesto.maxBytesPagina);
  const solicitudes: Request[] = [];
  const http: { fetch: typeof fetch } = {
    async fetch(entrada, opciones) {
      solicitudes.push(new Request(entrada, opciones));
      // Response nativa sintética, URL vacía: sólo el puerto explícito de prueba la permite.
      return new Response(texto, { status: 200, headers: {
        'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'private, no-store',
        Vary: 'Cookie', Pragma: 'no-cache', 'X-Content-Type-Options': 'nosniff',
      } });
    },
  };
  const cliente = crearClienteListadoFotos({ plan: itinerario, origen: 'https://viaje.test',
    presupuesto, http });
  expect(solicitudes).toHaveLength(0);

  const resultado = await cliente.listar(null);
  // Primera aserción de comportamiento; el padre observó su RED antes de implementar.
  expect(resultado.tipo).toBe('pagina');
  if (resultado.tipo !== 'pagina') throw new Error('Se esperaba una página de listado');
  expect(resultado.pagina).toEqual(pagina);
  expect(resultado.pagina.solicitudesIniciales).toEqual([inicial]);
  expect(resultado.pagina.continuacion).toBe(continuacion);
  expect(Object.isFrozen(resultado.pagina)).toBe(true);
  expect(Object.isFrozen(resultado.pagina.solicitudesIniciales)).toBe(true);
  expect(solicitudes).toHaveLength(1);
  expect(solicitudes[0].url).toBe('https://viaje.test/api/fotos/listado');
  expect(solicitudes[0].method).toBe('GET');
  expect(solicitudes[0].credentials).toBe('same-origin');
  expect(solicitudes[0].mode).toBe('same-origin');
  expect(solicitudes[0].cache).toBe('no-store');
  expect(solicitudes[0].redirect).toBe('error');
  expect(solicitudes[0].headers.get('Accept')).toBe('application/json');
  cliente.cerrar();
  expect(solicitudes).toHaveLength(1);
});

const plan: Itinerario = { id: 'viaje', titulo: 'Prueba', dias: [{ fecha: '2026-10-21', titulo: 'Día',
  paradas: [{ id: 'a', nombre: 'A', hora: '10:00', categoria: 'museo', lat: 31, lng: 121 }] }] };
const uno = '12345678-1234-4234-8234-123456789012';
const dos = '22345678-1234-4234-8234-123456789012';
const tres = '32345678-1234-4234-8234-123456789012';
const origen = 'https://viaje.test';
const limites: PresupuestoListadoFotosCliente = { maxFilas: 1, maxBytesPagina: 404231,
  maxBytesChunk: 4194304, maxBytesBackingChunk: 4194304, maxLecturas: 65536,
  maxBytesPlan: 4194304, maxBytesRetenidos: 512 * 1024 ** 2, plazoMs: 1000 };
const headers = { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'private, no-store',
  Vary: 'Cookie', Pragma: 'no-cache', 'X-Content-Type-Options': 'nosniff' };
function inicial(id = uno) {
  return serializarSolicitudRespaldo(plan, { version: 1, tipo: 'solicitud-respaldo', viajeId: plan.id,
    fotoId: id, operacionId: tres, original: { formato: 1, fotoId: id,
      destino: { tipo: 'parada', viajeId: plan.id, paradaId: 'a' }, nombre: 'e\u0301\0\uD800',
      mimeDeclarado: 'IMAGE/HEIC\0;☃', incorporada: -0, ultimaModificacion: -0, bytesOriginal: -0 } });
}
function cursor(despuesDe = uno, hasta = tres) {
  return serializarCursorListadoFotos(plan, { version: 1, viajeId: plan.id, despuesDe, hasta });
}
function pagina(id: string | null = uno, continuacion: string | null = null) {
  return serializarPaginaListadoFotos(plan, { version: 1, tipo: 'listado-respaldos', viajeId: plan.id,
    solicitudesIniciales: id === null ? [] : [inicial(id)], continuacion }, 1, limites.maxBytesPagina);
}
function respuesta(cuerpo: BodyInit | null = pagina(), cambios: ResponseInit = {}) {
  return new Response(cuerpo, { status: 200, headers, ...cambios });
}
function cliente(enviar: typeof fetch, cambios: Partial<PresupuestoListadoFotosCliente> = {}) {
  return crearClienteListadoFotos({ plan, origen, presupuesto: { ...limites, ...cambios }, http: { fetch: enviar } });
}
function barrera<T>() {
  let resolver!: (v: T) => void;
  const promesa = new Promise<T>((ok) => { resolver = ok; });
  return { promesa, resolver };
}
function flujo(chunks: unknown[], alCancelar: () => void | Promise<void> = () => {}) {
  let i = 0; let lecturas = 0;
  const body = new ReadableStream<Uint8Array>({ pull(c) {
    lecturas++;
    if (i === chunks.length) c.close(); else c.enqueue(chunks[i++] as Uint8Array);
  }, cancel: alCancelar }, { highWaterMark: 0 });
  return { body, lecturas: () => lecturas };
}
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe('Admisión, captura y cero IO de fábrica', () => {
  it('fábrica congelada no llama fetch ni crea temporizadores; http null no usa ambiente', async () => {
    const enviar = vi.fn(async () => respuesta()); vi.stubGlobal('fetch', enviar);
    const timer = vi.spyOn(globalThis, 'setTimeout');
    const c = crearClienteListadoFotos({ plan, origen, presupuesto: limites, http: null });
    expect(Object.isFrozen(c)).toBe(true); expect(timer).not.toHaveBeenCalled(); expect(enviar).not.toHaveBeenCalled();
    expect(await c.listar(null)).toEqual({ tipo: 'fallida', motivo: 'infraestructura' });
    expect(enviar).not.toHaveBeenCalled(); c.cerrar();
  });
  it('captura receiver, método, plan y presupuesto; mutaciones posteriores no los sustituyen', async () => {
    const p = structuredClone(plan); const presupuesto = { ...limites };
    const http = { fetch: async function (this: unknown) { expect(this).toBe(http); return respuesta(); } };
    const c = crearClienteListadoFotos({ plan: p, origen, presupuesto, http });
    Object.defineProperty(p, 'id', { value: 'otro' }); presupuesto.maxBytesPagina = 1;
    http.fetch = async () => { throw new Error('No capturado'); };
    expect((await c.listar(null)).tipo).toBe('pagina'); c.cerrar();
  });
  it.each(['plan', 'presupuesto', 'origen', 'http'])('accessor de opciones %s se rechaza sin invocarlo', (campo) => {
    const getter = vi.fn(); const opciones = { plan, origen, presupuesto: limites, http: null };
    Object.defineProperty(opciones, campo, { get: getter });
    expect(() => crearClienteListadoFotos(opciones)).toThrow('No se puede preparar el listado de fotos.');
    expect(getter).not.toHaveBeenCalled();
  });
  it('M1 rechaza plan propio hostil antes de tocar presupuesto y método HTTP', () => {
    const getter = vi.fn(); const p = { ...plan }; Object.defineProperty(p, 'id', { get: getter });
    const b = { ...limites }; Object.defineProperty(b, 'maxFilas', { get: getter });
    const http = { fetch: vi.fn(async () => respuesta()) }; Object.defineProperty(http, 'fetch', { get: getter });
    expect(() => crearClienteListadoFotos({ plan: p, origen, presupuesto: b, http })).toThrow();
    expect(getter).not.toHaveBeenCalled();
  });
  it.each([0, 9, 1.5, Infinity, NaN, Number.MAX_SAFE_INTEGER])('N inválido %s no consulta', (maxFilas) => {
    const enviar = vi.fn(async () => respuesta());
    expect(() => cliente(enviar, { maxFilas })).toThrow(); expect(enviar).not.toHaveBeenCalled();
  });
  it.each([{ maxBytesPagina: 404230 }, { maxBytesChunk: 4194305 }, { maxBytesBackingChunk: 4194305 },
    { maxBytesChunk: 100, maxBytesBackingChunk: 99 }, { maxLecturas: 65537 }, { maxBytesPlan: 4194305 },
    { maxBytesPlan: 1 }, { maxBytesRetenidos: 1 }, { plazoMs: 2147483648 }])('presupuesto fuera de dominio %j', (cambio) => {
    expect(() => cliente(async () => respuesta(), cambio)).toThrow();
  });
  it('MAX_SAFE de página no amplía P; R extremo N8/D4MiB/C4MiB es 408072640 lógico', async () => {
    expect(16 * 3156764 + 32 * 8 * 65536 + 4194304 + (8 * 8 + 16) * 4194304 + 1048576).toBe(408072640);
    const f = flujo([new Uint8Array(404232)]);
    const c = cliente(async () => respuesta(f.body), { maxBytesPagina: Number.MAX_SAFE_INTEGER });
    expect(await c.listar(null)).toEqual({ tipo: 'fallida', motivo: 'presupuesto-excedido' }); c.cerrar();
  });
  it('rechaza ciclos, símbolos, funciones, profundidad, nodos, array y D duros antes del copier', () => {
    const ciclo = { ...plan } as Itinerario & { ciclo?: unknown }; ciclo.ciclo = ciclo;
    let profundo: unknown = 0; for (let i = 0; i < 34; i++) profundo = { profundo };
    for (const p of [ciclo, { ...plan, extra: Symbol('x') }, { ...plan, extra: () => 1 },
      { ...plan, extra: profundo }, { ...plan, extra: new Array(16385) },
      { ...plan, extra: Array(16384).fill(null) }, { ...plan, titulo: 'x'.repeat(1048576) }]) {
      expect(() => crearClienteListadoFotos({ plan: p, origen, presupuesto: limites, http: null })).toThrow();
    }
  });
  it.each([origen + '/', 'http://viaje.test', 'https://u@viaje.test', origen + '?x=1', origen + '#x'])('origen inválido %s', (o) => {
    expect(() => crearClienteListadoFotos({ plan, origen: o, presupuesto: limites, http: null })).toThrow();
  });
});

describe('HTTP, bytes completos y dominio RAW', () => {
  it.each([401, 400, 503, 403, 206, 304])('estado %s cancela body sin leer ni reflejar detalles', async (status) => {
    const cancelar = vi.fn(); const f = flujo([new TextEncoder().encode('SQL secreto')], cancelar);
    // 304 prohíbe body por contrato Response nativo.
    const r = respuesta(status === 304 ? null : f.body, { status });
    const c = cliente(async () => r); const resultado = await c.listar(null);
    expect(resultado).toEqual({ tipo: 'fallida', motivo: status === 401 ? 'sin-sesion' : status === 400
      ? 'consulta-rechazada' : status === 503 ? 'infraestructura' : 'respuesta-inesperada' });
    expect(f.lecturas()).toBe(0); expect(JSON.stringify(resultado)).not.toContain('SQL'); c.cerrar();
  });
  it.each([{ 'Content-Type': 'text/html' }, { 'Cache-Control': 'public, no-store' }, { Vary: '*' },
    { Pragma: 'cache' }, { 'X-Content-Type-Options': 'sniff' }, { 'Content-Type': 'x'.repeat(257) }])('headers %j antes de body', async (cambio) => {
    const f = flujo([new Uint8Array([1])]); const c = cliente(async () => respuesta(f.body, { headers: { ...headers, ...cambio } }));
    expect(await c.listar(null)).toEqual({ tipo: 'fallida', motivo: 'respuesta-inesperada' });
    expect(f.lecturas()).toBe(0); c.cerrar();
  });
  it('Content-Length excesivo se rechaza antes de leer; valor pequeño no acredita EOF', async () => {
    const f = flujo([new Uint8Array([1])]);
    const c = cliente(async () => respuesta(f.body, { headers: { ...headers, 'Content-Length': '9007199254740991' } }));
    expect(await c.listar(null)).toEqual({ tipo: 'fallida', motivo: 'presupuesto-excedido' }); expect(f.lecturas()).toBe(0); c.cerrar();
    const d = cliente(async () => respuesta(pagina() + 'false', { headers: { ...headers, 'Content-Length': '1' } }));
    expect(await d.listar(null)).toEqual({ tipo: 'fallida', motivo: 'formato-invalido' }); d.cerrar();
  });
  it.each(['', pagina().slice(0, -1), '\uFEFF' + pagina(), pagina() + 'false', pagina().replace('version', '\\u0076ersion')])('JSON canónico completo requerido %#', async (texto) => {
    const c = cliente(async () => respuesta(texto));
    expect(await c.listar(null)).toEqual({ tipo: 'fallida', motivo: 'formato-invalido' }); c.cerrar();
  });
  it('UTF8 fatal rechaza bytes inválidos, no surrogate JSON escapado; RAW conserva -0', async () => {
    const c = cliente(async () => respuesta(new Uint8Array([0xc3, 0x28])));
    expect(await c.listar(null)).toEqual({ tipo: 'fallida', motivo: 'formato-invalido' }); c.cerrar();
    const d = cliente(async () => respuesta()); const r = await d.listar(null); expect(r.tipo).toBe('pagina');
    if (r.tipo !== 'pagina') throw new Error('Se esperaba página');
    const s = deserializarSolicitudRespaldo(plan, r.pagina.solicitudesIniciales[0]);
    expect(s.original.nombre).toBe('e\u0301\0\uD800'); expect(s.original.mimeDeclarado).toBe('IMAGE/HEIC\0;☃');
    expect(Object.is(s.original.incorporada, -0)).toBe(true); expect(Object.is(s.original.ultimaModificacion, -0)).toBe(true);
    expect(Object.is(s.original.bytesOriginal, -0)).toBe(true); d.cerrar();
  });
  it('vacía válida; cuenta vacíos y EOF; no declara éxito sin lectura final', async () => {
    const f = flujo([new Uint8Array(), new TextEncoder().encode(pagina(null))]);
    const c = cliente(async () => respuesta(f.body), { maxLecturas: 2 });
    expect(await c.listar(null)).toEqual({ tipo: 'fallida', motivo: 'presupuesto-excedido' }); expect(f.lecturas()).toBe(2); c.cerrar();
    const d = cliente(async () => respuesta(pagina(null))); expect((await d.listar(null)).tipo).toBe('pagina'); d.cerrar();
  });
  it('frontera buffer P/P+1 con JSON inválido: no se presenta como página válida extrema', async () => {
    for (const n of [404231, 404232]) {
      const c = cliente(async () => respuesta(flujo([new Uint8Array(n)]).body));
      expect(await c.listar(null)).toEqual({ tipo: 'fallida', motivo: n === 404231 ? 'formato-invalido' : 'presupuesto-excedido' }); c.cerrar();
    }
  });
  it('vista mínima con backing enorme, Shared y detached no se aceptan; Buffer nativo sí', async () => {
    const backing = new ArrayBuffer(128); const detached = new Uint8Array(4); structuredClone(detached.buffer, { transfer: [detached.buffer] });
    for (const chunk of [new Uint8Array(backing, 0, 1), new Uint8Array(new SharedArrayBuffer(4)), detached]) {
      const c = cliente(async () => respuesta(flujo([chunk]).body), { maxBytesChunk: 64, maxBytesBackingChunk: 64 });
      expect((await c.listar(null)).tipo).toBe('fallida'); c.cerrar();
    }
    const d = cliente(async () => respuesta(flujo([Buffer.from(pagina())]).body));
    expect((await d.listar(null)).tipo).toBe('pagina'); d.cerrar();
  });
  it('upstream reutiliza backing: cada chunk se copia antes del siguiente read', async () => {
    const bytes = new TextEncoder().encode(pagina()); const memoria = new Uint8Array(17); let offset = 0;
    const body = new ReadableStream<Uint8Array>({ pull(c) {
      if (offset === bytes.length) { c.close(); return; }
      const n = Math.min(memoria.length, bytes.length - offset); memoria.set(bytes.subarray(offset, offset + n));
      offset += n; c.enqueue(memoria.subarray(0, n));
    } }, { highWaterMark: 0 });
    const c = cliente(async () => respuesta(body)); expect((await c.listar(null)).tipo).toBe('pagina'); c.cerrar();
  });
  it('getters propios de Response, Headers y Uint8Array no sustituyen intrínsecos', async () => {
    const getter = vi.fn(() => { throw new Error('No ejecutar'); }); const chunk = new TextEncoder().encode(pagina());
    for (const campo of ['byteLength', 'buffer', 'byteOffset']) Object.defineProperty(chunk, campo, { get: getter });
    const r = respuesta(flujo([chunk]).body);
    const h = r.headers; Object.defineProperty(h, 'get', { get: getter });
    for (const campo of ['url', 'status', 'body', 'headers', 'redirected', 'type', 'bodyUsed']) Object.defineProperty(r, campo, { get: getter });
    const c = cliente(async () => r); expect((await c.listar(null)).tipo).toBe('pagina'); expect(getter).not.toHaveBeenCalled(); c.cerrar();
  });
  it('Response estructural falsa no tiene marca; no se ejecutan sus getters', async () => {
    const getter = vi.fn(); const falso = Object.defineProperty({}, 'url', { get: getter });
    const c = cliente(async () => falso as Response); expect((await c.listar(null)).tipo).toBe('fallida');
    expect(getter).not.toHaveBeenCalled(); c.cerrar();
  });
  it('fetch por defecto no admite Response sintética de URL vacía', async () => {
    const enviar = vi.fn(async () => respuesta()); vi.stubGlobal('fetch', enviar);
    const c = crearClienteListadoFotos({ plan, origen, presupuesto: limites });
    expect(await c.listar(null)).toEqual({ tipo: 'fallida', motivo: 'respuesta-inesperada' }); expect(enviar).toHaveBeenCalledTimes(1); c.cerrar();
  });
  it.each([uno, '02345678-1234-4234-8234-123456789012', '42345678-1234-4234-8234-123456789012'])('rango final null rechaza ID %s fuera de (after,hasta]', async (id) => {
    const c = cliente(async () => respuesta(pagina(id)));
    expect(await c.listar(cursor())).toEqual({ tipo: 'fallida', motivo: 'formato-invalido' }); c.cerrar();
  });
  it('continuación mantiene hasta y cada llamada explícita crea una sola GET codificada', async () => {
    const enviar = vi.fn(async (_entrada: RequestInfo | URL, _opciones?: RequestInit) => respuesta(pagina(dos, cursor(dos, tres))));
    const c = cliente(enviar);
    expect((await c.listar(cursor())).tipo).toBe('pagina');
    expect((enviar.mock.calls[0][0] as Request).url).toBe(origen + '/api/fotos/listado?continuacion=' + encodeURIComponent(cursor()));
    expect(enviar).toHaveBeenCalledTimes(1); c.cerrar();
    const d = cliente(async () => respuesta(pagina(dos, cursor(dos, '42345678-1234-4234-8234-123456789012'))));
    expect(await d.listar(cursor())).toEqual({ tipo: 'fallida', motivo: 'formato-invalido' }); d.cerrar();
  });
  it.each(['', 'x'.repeat(1025), ' ' + cursor(), cursor() + '\n', '\uD800'])('cursor inválido %# sin GET', async (texto) => {
    const enviar = vi.fn(async () => respuesta()); const c = cliente(enviar);
    expect(await c.listar(texto)).toEqual({ tipo: 'fallida', motivo: 'argumentos-invalidos' }); expect(enviar).not.toHaveBeenCalled(); c.cerrar();
  });
});

describe('Ownership, plazo y cierre sin reentrada ilimitada', () => {
  it('cancelar entrega inmediata, pero fetch tardío y cancel pendiente mantienen ocupada', async () => {
    const llegada = barrera<Response>(); const cancel = barrera<void>(); const cancelado = vi.fn(() => cancel.promesa);
    const enviar = vi.fn(() => llegada.promesa); const c = cliente(enviar); const pendiente = c.listar(null);
    expect(await c.listar(null)).toEqual({ tipo: 'fallida', motivo: 'ocupada' }); c.cancelar();
    expect(await pendiente).toEqual({ tipo: 'detenida', motivo: 'cancelada' });
    expect(await c.listar(null)).toEqual({ tipo: 'fallida', motivo: 'ocupada' });
    llegada.resolver(respuesta(flujo([], cancelado).body));
    for (let i = 0; i < 8; i++) await Promise.resolve();
    expect(cancelado).toHaveBeenCalledTimes(1); expect(await c.listar(null)).toEqual({ tipo: 'fallida', motivo: 'ocupada' });
    cancel.resolver(); for (let i = 0; i < 8; i++) await Promise.resolve(); c.cerrar();
    expect(await c.listar(null)).toEqual({ tipo: 'detenida', motivo: 'cerrada' }); expect(enviar).toHaveBeenCalledTimes(1);
  });
  it('plazo durante fetch no inicia retry ni acepta página tardía', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const llegada = barrera<Response>(); const enviar = vi.fn(() => llegada.promesa);
    const c = cliente(enviar, { plazoMs: 20 }); const pendiente = c.listar(null);
    await vi.advanceTimersByTimeAsync(20); expect(await pendiente).toEqual({ tipo: 'detenida', motivo: 'plazo' });
    expect(await c.listar(null)).toEqual({ tipo: 'fallida', motivo: 'ocupada' });
    llegada.resolver(respuesta()); for (let i = 0; i < 8; i++) await Promise.resolve();
    expect(enviar).toHaveBeenCalledTimes(1); c.cerrar();
  });
  it('lector pendiente cancelado libera lock al asentarse; body ajeno locked queda intacto', async () => {
    const entrada = barrera<void>(); const cancel = barrera<void>(); let controlador!: ReadableStreamDefaultController<Uint8Array>;
    const body = new ReadableStream<Uint8Array>({ start(c) { controlador = c; }, pull() { entrada.resolver(); }, cancel() { return cancel.promesa; } }, { highWaterMark: 0 });
    const c = cliente(async () => respuesta(body)); const pendiente = c.listar(null); await entrada.promesa; c.cancelar();
    expect(await pendiente).toEqual({ tipo: 'detenida', motivo: 'cancelada' });
    expect(await c.listar(null)).toEqual({ tipo: 'fallida', motivo: 'ocupada' });
    cancel.resolver(); for (let i = 0; i < 8; i++) await Promise.resolve(); expect(body.locked).toBe(false); c.cerrar();
    void controlador;
    const ajeno = flujo([]); const r = respuesta(ajeno.body); const reader = ajeno.body.getReader();
    const d = cliente(async () => r); expect((await d.listar(null)).tipo).toBe('fallida');
    expect(ajeno.body.locked).toBe(true); reader.releaseLock(); d.cerrar();
  });
  it('reloj nativo comprueba plazo tras trabajo síncrono aunque el timer no pueda ejecutarse', async () => {
    const c = cliente(async () => {
      const inicio = performance.now();
      while (performance.now() - inicio < 10) { /* Bloqueo acotado exclusivamente del puerto de prueba. */ }
      return respuesta();
    }, { plazoMs: 2 });
    expect(await c.listar(null)).toEqual({ tipo: 'detenida', motivo: 'plazo' }); c.cerrar();
  });
});
