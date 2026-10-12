import { describe, expect, it, vi } from 'vitest';
import { IDBFactory } from 'fake-indexeddb';
import { itinerario } from '../src/datos/itinerario';
import { crearCapturaFoto } from '../src/fotos';
import { abrirFotosLocal } from '../src/fotos-local';
import { abrirRespaldoFotosLocal } from '../src/fotos-respaldo-local';
import { crearTransporteFotos, ErrorTransporteFotos } from '../src/fotos-transporte';
import { deserializarSolicitudRespaldo, serializarReciboRespaldo, MAX_BYTES_JSON_RESPALDO } from '../src/fotos-protocolo';
import type { EntradaRespaldo } from '../src/fotos-respaldo';

const fotoId = '12345678-1234-4123-8123-123456789abc';
const operacionId = '22345678-1234-4123-8123-123456789abc';
const origen = 'https://fotos.example';
const referencia = (e: EntradaRespaldo) => ({ fotoId: e.fotoId, operacionId: e.operacionId, original: e.original });
function barrera<T>() {
  let resolver!: (v: T) => void;
  const promesa = new Promise<T>((ok) => { resolver = ok; });
  return { promesa, resolver };
}
async function contexto() {
  const fabrica = new IDBFactory();
  const fuente = await abrirFotosLocal(itinerario, { fabrica });
  const captura = crearCapturaFoto(itinerario, { tipo: 'parada', viajeId: itinerario.id,
    paradaId: itinerario.dias[0].paradas[0].id }, new File([new Uint8Array([0, 255, 17])], '\0 e\u0301 ',
    { type: 'image/heic', lastModified: 17 }), -0, { uuid: () => fotoId });
  await fuente.guardarOriginal(captura);
  const ledger = await abrirRespaldoFotosLocal(itinerario, fuente, { fabrica });
  const entrada = await ledger.preparar(captura, operacionId);
  const ref = referencia(entrada);
  const recibo = { version: 1 as const, tipo: 'acuse-respaldo' as const, viajeId: itinerario.id,
    ...ref, objetoOriginalDurable: true as const, metadatosDurables: true as const };
  const texto = serializarReciboRespaldo(itinerario, recibo);
  const respuesta = () => new Response(texto, { status: 201,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' } });
  const enviar = vi.fn<typeof fetch>(async () => respuesta());
  const transporte = crearTransporteFotos({ plan: itinerario, origen, fuente, ledger, fetch: enviar });
  const cerrar = () => { transporte.cerrar(); fuente.cerrar(); ledger.cerrar(); };
  return { fabrica, fuente, ledger, captura, entrada, ref, recibo, texto, respuesta, enviar, transporte, cerrar };
}

describe('POST manual local: estructura HTTP, no prueba de autenticación ni proveedor', () => {
  it('estima metadata explícitamente sin leer original ni iniciar red', async () => {
    const c = await contexto();
    try {
      const leer = vi.spyOn(c.fuente, 'leerOriginal');
      const estimacion = c.transporte.estimar(c.ref);
      expect(estimacion.bytesOriginal).toBe(3);
      expect(estimacion.bytesPayloadConocido).toBe(3 + estimacion.bytesSolicitud);
      expect(estimacion.traficoFacturable).toBe('desconocido');
      expect(leer).not.toHaveBeenCalled(); expect(c.enviar).not.toHaveBeenCalled();
    } finally { c.cerrar(); }
  });
  it('espera marcador durable, envía exactamente dos campos y confirma tras TX', async () => {
    const c = await contexto();
    try {
      c.enviar.mockImplementation(async (url, opciones) => {
        expect(url).toBe(`${origen}/api/fotos/respaldo`);
        expect(await c.ledger.leer(fotoId)).toMatchObject({ fase: 'enviada', enviada: true });
        expect(opciones).toMatchObject({ method: 'POST', credentials: 'same-origin', cache: 'no-store', redirect: 'error' });
        const headers = new Headers(opciones!.headers);
        expect([...headers]).toEqual([['accept', 'application/json']]);
        const cuerpo = opciones!.body as FormData;
        expect([...cuerpo.keys()]).toEqual(['solicitud', 'original']);
        const texto = cuerpo.get('solicitud'); expect(typeof texto).toBe('string');
        const solicitud = deserializarSolicitudRespaldo(itinerario, texto);
        expect(Object.is(solicitud.original.incorporada, -0)).toBe(true);
        expect(solicitud.original.nombre).toBe('\0 e\u0301 ');
        const original = cuerpo.get('original') as File;
        expect(original.name).toBe('original'); expect(original.type).toBe('application/octet-stream');
        expect([...new Uint8Array(await original.arrayBuffer())]).toEqual([0, 255, 17]);
        return c.respuesta();
      });
      expect(await c.transporte.subir(c.ref)).toMatchObject({ fase: 'respaldada' });
      expect(await c.ledger.leer(fotoId)).toMatchObject({ fase: 'respaldada' });
      expect(c.enviar).toHaveBeenCalledTimes(1);
    } finally { c.cerrar(); }
  });
  it('pausa mientras espera marcador impide iniciar fetch y conserva incertidumbre', async () => {
    const c = await contexto();
    const dentro = barrera<void>(); const liberar = barrera<void>();
    const marcar = c.ledger.marcarEnviada;
    c.ledger.marcarEnviada = async (ref) => { const e = await marcar(ref); dentro.resolver(); await liberar.promesa; return e; };
    try {
      const carga = c.transporte.subir(c.ref);
      const resultado = carga.then(() => null, (e: unknown) => e);
      await Promise.race([dentro.promesa, resultado.then((e) => { throw e ?? new Error('Terminó antes del marcador'); })]);
      await c.transporte.pausar(c.ref); liberar.resolver(); expect(await resultado).toBeInstanceOf(Error);
      expect(c.enviar).not.toHaveBeenCalled();
      expect(await c.ledger.leer(fotoId)).toMatchObject({ fase: 'enviada', pausada: true, recibo: null });
    } finally { liberar.resolver(); c.cerrar(); }
  });
});


function respuestaTexto(texto: string | Uint8Array, opciones: ResponseInit = {}) {
  return new Response(typeof texto === 'string' ? texto : new Uint8Array(texto), { status: 200,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }, ...opciones });
}
async function sinAcuse(c: Awaited<ReturnType<typeof contexto>>) {
  const confirmar = vi.spyOn(c.ledger, 'confirmarRecibo');
  await expect(c.transporte.subir(c.ref)).rejects.toBeInstanceOf(Error);
  expect(confirmar).not.toHaveBeenCalled();
  expect(await c.ledger.leer(fotoId)).toMatchObject({ fase: 'enviada', enviada: true, recibo: null });
  expect(c.enviar).toHaveBeenCalledTimes(1);
}

describe('selección, identidad fresca y exclusión local', () => {
  it('constructor es cero IO; null no obtiene fallback ni abre bases', async () => {
    const c = await contexto();
    try {
      const leer = vi.spyOn(c.ledger, 'leer'); const original = vi.spyOn(c.fuente, 'leerOriginal');
      const t = crearTransporteFotos({ plan: itinerario, origen, fuente: null, ledger: null, fetch: null });
      expect(leer).not.toHaveBeenCalled(); expect(original).not.toHaveBeenCalled();
      await expect(t.subir(c.ref)).rejects.toMatchObject({ estado: 'sin-envio' });
      expect(c.enviar).not.toHaveBeenCalled(); t.cerrar();
    } finally { c.cerrar(); }
  });
  it.each(['https://otro.example/ruta', 'https://usuario@fotos.example', origen + '?q=1',
    origen + '#x', origen + '/', 'file:///fotos', 'https://fotos.example:443'])('rechaza origen no canónico %s', async (destino) => {
    const c = await contexto();
    try {
      expect(() => crearTransporteFotos({ plan: itinerario, origen: destino, fuente: c.fuente,
        ledger: c.ledger, fetch: c.enviar })).toThrow(); expect(c.enviar).not.toHaveBeenCalled();
    } finally { c.cerrar(); }
  });
  it('opciones no aceptan campos extra, getters, endpoint por operación ni recibo importado', async () => {
    const c = await contexto();
    try {
      const leer = vi.fn();
      const opciones = { plan: itinerario, origen, fuente: c.fuente, ledger: c.ledger, get fetch() { leer(); return c.enviar; } };
      expect(() => crearTransporteFotos(opciones)).toThrow(); expect(leer).not.toHaveBeenCalled();
      expect(() => crearTransporteFotos({ ...opciones, fetch: c.enviar, endpoint: origen } as never)).toThrow();
      await expect(c.transporte.subir({ ...c.ref, recibo: c.recibo } as never)).rejects.toThrow();
      expect('confirmarRecibo' in c.transporte).toBe(false); expect(c.enviar).not.toHaveBeenCalled();
    } finally { c.cerrar(); }
  });
  it.each([NaN, Infinity, -1])('política explícita no admite %s', async (limite) => {
    const c = await contexto();
    try { expect(() => crearTransporteFotos({ plan: itinerario, origen, fuente: c.fuente,
      ledger: c.ledger, fetch: c.enviar, maxBytesOriginal: limite })).toThrow(); }
    finally { c.cerrar(); }
  });
  it('política opcional impide envío antes de lectura del original', async () => {
    const c = await contexto();
    try {
      const original = vi.spyOn(c.fuente, 'leerOriginal');
      const t = crearTransporteFotos({ plan: itinerario, origen, fuente: c.fuente, ledger: c.ledger,
        fetch: c.enviar, maxBytesOriginal: 2 });
      expect(() => t.estimar(c.ref)).toThrow(); await expect(t.subir(c.ref)).rejects.toThrow();
      expect(original).not.toHaveBeenCalled(); expect(c.enviar).not.toHaveBeenCalled(); t.cerrar();
    } finally { c.cerrar(); }
  });
  it.each(['ausente', 'borrada', 'metadata', 'referencia', 'original-ausente', 'fase', 'pausa'])('%s nunca prepara ni inicia IO', async (caso) => {
    const c = await contexto();
    try {
      const preparar = vi.spyOn(c.ledger, 'preparar');
      if (caso === 'ausente') c.fuente.leerMetadatos = async () => null;
      if (caso === 'borrada') await c.fuente.borrarLocal(fotoId);
      if (caso === 'metadata') c.fuente.leerMetadatos = async () => ({ ...c.captura.metadatos, incorporada: 0 });
      if (caso === 'referencia') c.ledger.leer = async () => ({ ...c.entrada, operacionId: '32345678-1234-4123-8123-123456789abc' });
      if (caso === 'original-ausente') c.fuente.leerOriginal = async () => null;
      if (caso === 'fase') { await c.ledger.marcarEnviada(c.ref); await c.ledger.confirmarRecibo(c.recibo); } // Control local.
      if (caso === 'pausa') await c.ledger.pausar(c.ref);
      await expect(c.transporte.subir(c.ref)).rejects.toThrow();
      expect(c.enviar).not.toHaveBeenCalled(); expect(preparar).not.toHaveBeenCalled();
    } finally { c.cerrar(); }
  });
  it('bytes distintos al último byte contra candidato A no atestan B con mismo UUID', async () => {
    const c = await contexto();
    try {
      let lecturas = 0;
      const a = c.captura.original; const b = new Blob([new Uint8Array([0, 255, 18])], { type: a.type });
      // Control de candidato inconsistente: incumplimiento detectable del contrato inmutable.
      // Sustitución histórica ANTES de ambas lecturas no es detectable sin digest: no se afirma.
      c.fuente.leerOriginal = async () => ++lecturas === 1 ? a : b;
      await expect(c.transporte.subir(c.ref)).rejects.toThrow('atestado');
      expect(c.enviar).not.toHaveBeenCalled(); expect(lecturas).toBe(2);
    } finally { c.cerrar(); }
  });
  it('miniatura derivada distinta no altera referencia ni impide upload', async () => {
    const c = await contexto();
    try {
      const leer = c.fuente.leerMetadatos;
      c.fuente.leerMetadatos = async (id) => {
        const m = await leer(id);
        if (!m || 'tipo' in m) return m;
        return { ...m, miniatura: { tipo: 'fallida', motivo: 'derivada' } };
      };
      expect(await c.transporte.subir(c.ref)).toMatchObject({ fase: 'respaldada' });
    } finally { c.cerrar(); }
  });
  it('snapshot antes de await y duplicado reentrante no crean dos cargas', async () => {
    const c = await contexto(); const dentro = barrera<void>(); const liberar = barrera<void>();
    const leer = c.ledger.leer;
    c.ledger.leer = async (id) => { dentro.resolver(); await liberar.promesa; return leer(id); };
    try {
      const ref = structuredClone(c.ref); const carga = c.transporte.subir(ref);
      await dentro.promesa;
      await expect(c.transporte.subir(c.ref)).rejects.toThrow('activa');
      ref.original = { ...ref.original, nombre: 'retarget B' };
      liberar.resolver(); expect(await carga).toMatchObject({ fase: 'respaldada' });
      expect(c.enviar).toHaveBeenCalledTimes(1);
    } finally { liberar.resolver(); c.cerrar(); }
  });
});

describe('barreras y ownership: ninguna respuesta tardía cambia otra selección', () => {
  it.each(['ledger', 'metadata', 'original', 'atestacion', 'antes-fetch', 'confirmacion'])('cancelar después de await %s nunca devuelve éxito', async (etapa) => {
    const c = await contexto(); const dentro = barrera<void>(); const liberar = barrera<void>();
    const retener = async <T>(valor: T) => { dentro.resolver(); await liberar.promesa; return valor; };
    if (etapa === 'ledger' || etapa === 'antes-fetch') {
      let n = 0; const leer = c.ledger.leer;
      c.ledger.leer = async (id) => { const e = await leer(id); return ++n === (etapa === 'ledger' ? 1 : 3) ? retener(e) : e; };
    } else if (etapa === 'metadata' || etapa === 'atestacion') {
      let n = 0; const leer = c.fuente.leerMetadatos;
      c.fuente.leerMetadatos = async (id) => { const e = await leer(id); return ++n === (etapa === 'metadata' ? 1 : 3) ? retener(e) : e; };
    } else if (etapa === 'original') {
      const leer = c.fuente.leerOriginal; c.fuente.leerOriginal = async (id) => retener(await leer(id));
    } else {
      const confirmar = c.ledger.confirmarRecibo; c.ledger.confirmarRecibo = async (r) => retener(await confirmar(r));
    }
    try {
      const carga = c.transporte.subir(c.ref); const resultado = carga.catch((e: unknown) => e);
      await dentro.promesa; c.transporte.cancelar(); liberar.resolver();
      expect(await resultado).toBeInstanceOf(ErrorTransporteFotos);
      if (etapa !== 'confirmacion') expect(c.enviar).not.toHaveBeenCalled();
      else {
        // TX ya iniciada ganó la carrera: éxito durable puede existir, pero no devuelve éxito cancelado.
        expect(await c.ledger.leer(fotoId)).toMatchObject({ fase: 'respaldada' });
      }
    } finally { liberar.resolver(); c.cerrar(); }
  });
  it.each(['cancelar', 'cerrar', 'pausar'])('%s después de fetch ignora ACK tardío y preserva enviada', async (accion) => {
    const c = await contexto(); const dentro = barrera<void>(); const liberar = barrera<Response>();
    const confirmar = vi.spyOn(c.ledger, 'confirmarRecibo');
    c.enviar.mockImplementation(async (_url, opciones) => {
      dentro.resolver(); const r = await liberar.promesa;
      expect(opciones!.signal!.aborted).toBe(true); return r; // Puerto ignora aborto deliberadamente.
    });
    try {
      const carga = c.transporte.subir(c.ref); const resultado = carga.catch((e: unknown) => e);
      await dentro.promesa;
      if (accion === 'pausar') await c.transporte.pausar(c.ref);
      else c.transporte[accion as 'cancelar' | 'cerrar']();
      liberar.resolver(c.respuesta()); expect(await resultado).toBeInstanceOf(Error);
      expect(confirmar).not.toHaveBeenCalled();
      expect(await c.ledger.leer(fotoId)).toMatchObject({ fase: 'enviada', recibo: null });
      const nueva = await abrirRespaldoFotosLocal(itinerario, c.fuente, { fabrica: c.fabrica });
      expect(await nueva.leer(fotoId)).toMatchObject({ fase: 'enviada', recibo: null }); nueva.cerrar();
    } finally { liberar.resolver(c.respuesta()); c.cerrar(); }
  });
  it('cancelación libera stream tardío incluso cuando fetch ignora AbortSignal', async () => {
    const c = await contexto(); const dentro = barrera<void>(); const liberar = barrera<Response>();
    const cancelar = vi.fn();
    c.enviar.mockImplementation(async () => { dentro.resolver(); return liberar.promesa; });
    try {
      const carga = c.transporte.subir(c.ref).catch((e: unknown) => e);
      await dentro.promesa; c.transporte.cancelar();
      liberar.resolver(new Response(new ReadableStream({ cancel: cancelar })));
      expect(await carga).toBeInstanceOf(Error); expect(cancelar).toHaveBeenCalledTimes(1);
    } finally { c.cerrar(); }
  });
  it('cierre no cierra puertos del usuario ni admite nuevas solicitudes', async () => {
    const c = await contexto();
    try {
      c.transporte.cerrar(); await expect(c.transporte.subir(c.ref)).rejects.toThrow('cerrado');
      expect(await c.fuente.leerOriginal(fotoId)).not.toBeNull(); expect(await c.ledger.leer(fotoId)).not.toBeNull();
      expect(() => c.transporte.estimar(c.ref)).toThrow(); expect(c.enviar).not.toHaveBeenCalled();
    } finally { c.cerrar(); }
  });
  it('error de red no reintenta; acción explícita conserva JSON y bytes, sin regeneración', async () => {
    const c = await contexto(); const cuerpos: FormData[] = [];
    const retry = vi.spyOn(c.ledger, 'reintentar'); const preparar = vi.spyOn(c.ledger, 'preparar');
    c.enviar.mockImplementation(async (_url, opciones) => {
      cuerpos.push(opciones!.body as FormData);
      if (cuerpos.length === 1) throw new TypeError('Offline / cookie expirada / respuesta perdida');
      return c.respuesta();
    });
    try {
      await expect(c.transporte.subir(c.ref)).rejects.toMatchObject({ estado: 'incierta' });
      expect(retry).not.toHaveBeenCalled(); expect(c.enviar).toHaveBeenCalledTimes(1);
      await c.transporte.pausar(c.ref);
      expect(await c.transporte.reintentar(c.ref)).toMatchObject({ fase: 'respaldada', operacionId });
      expect(retry).toHaveBeenCalledTimes(1); expect(preparar).not.toHaveBeenCalled();
      expect(cuerpos[0].get('solicitud')).toBe(cuerpos[1].get('solicitud'));
      expect(await (cuerpos[0].get('original') as Blob).arrayBuffer()).toEqual(await (cuerpos[1].get('original') as Blob).arrayBuffer());
    } finally { c.cerrar(); }
  });
});

describe('acuse HTTP acotado y vinculado: sin privilegio para JSON arbitrario', () => {
  it.each([401, 303, 403, 503, 204])('HTTP %s deja incertidumbre sin ACK', async (status) => {
    const c = await contexto();
    try { c.enviar.mockResolvedValue(new Response(status === 204 ? null : c.texto, { status })); await sinAcuse(c); }
    finally { c.cerrar(); }
  });
  it.each(['html', 'sin-no-store', 'redirect', 'url-ajena', 'objeto-boolean'])('%s no se convierte en recibo', async (caso) => {
    const c = await contexto();
    try {
      let r: Response = c.respuesta();
      if (caso === 'html') r = respuestaTexto('<html>login</html>', { headers: { 'Content-Type': 'text/html', 'Cache-Control': 'no-store' } });
      if (caso === 'sin-no-store') r = respuestaTexto(c.texto, { headers: { 'Content-Type': 'application/json' } });
      if (caso === 'redirect') Object.defineProperty(r, 'redirected', { value: true });
      if (caso === 'url-ajena') Object.defineProperty(r, 'url', { value: origen + '/login' });
      if (caso === 'objeto-boolean') r = { status: 200, ok: true, text: async () => c.texto } as Response;
      c.enviar.mockResolvedValue(r); await sinAcuse(c);
    } finally { c.cerrar(); }
  });
  it.each(['otra-op', 'otra-foto', 'otro-viaje', 'original', 'menos-cero', 'falta-objeto', 'falta-metadata', 'boolean-clase'])('%s no confirma referencia seleccionada', async (caso) => {
    const c = await contexto();
    try {
      let texto = c.texto;
      if (caso === 'otra-op') texto = texto.replace(operacionId, '32345678-1234-4123-8123-123456789abc');
      if (caso === 'otra-foto') texto = texto.replaceAll(fotoId, '42345678-1234-4123-8123-123456789abc');
      if (caso === 'otro-viaje') texto = texto.replaceAll(itinerario.id, 'viaje-ajeno');
      if (caso === 'original') texto = texto.replace('"bytesOriginal":3', '"bytesOriginal":4');
      if (caso === 'menos-cero') texto = texto.replace('"incorporada":-0', '"incorporada":0');
      if (caso === 'falta-objeto') texto = texto.replace(',"objetoOriginalDurable":true', '');
      if (caso === 'falta-metadata') texto = texto.replace(',"metadatosDurables":true', '');
      if (caso === 'boolean-clase') texto = texto.replace('"metadatosDurables":true', '"metadatosDurables":{}');
      c.enviar.mockResolvedValue(respuestaTexto(texto)); await sinAcuse(c);
    } finally { c.cerrar(); }
  });
  it.each(['BOM', 'UTF8', 'duplicada', 'truncada', 'grande', 'multibyte-grande'])('%s se rechaza antes de ACK', async (caso) => {
    const c = await contexto(); const cancelada = vi.fn();
    try {
      let bytes = new TextEncoder().encode(c.texto);
      if (caso === 'BOM') bytes = new TextEncoder().encode('\uFEFF' + c.texto);
      if (caso === 'UTF8') bytes = new Uint8Array([0xc3, 0x28]);
      if (caso === 'duplicada') bytes = new TextEncoder().encode(c.texto.replace('"version":1', '"version":1,"version":1'));
      if (caso === 'truncada') bytes = bytes.slice(0, -1);
      if (caso === 'grande') bytes = new TextEncoder().encode(' '.repeat(MAX_BYTES_JSON_RESPALDO + 1));
      if (caso === 'multibyte-grande') bytes = new TextEncoder().encode('é'.repeat(MAX_BYTES_JSON_RESPALDO / 2 + 1));
      let posicion = 0;
      const stream = new ReadableStream<Uint8Array>({
        pull(controlador) {
          if (posicion === bytes.length) { if (!caso.endsWith('grande')) controlador.close(); return; }
          const siguiente = Math.min(posicion + 333, bytes.length);
          controlador.enqueue(bytes.slice(posicion, siguiente)); posicion = siguiente;
        }, cancel: cancelada,
      });
      const r = new Response(stream, { status: 200, headers: { 'Content-Type': 'application/json',
        'Cache-Control': 'no-store', 'Content-Length': '1' } });
      const text = vi.spyOn(r, 'text'); c.enviar.mockResolvedValue(r); await sinAcuse(c);
      expect(text).not.toHaveBeenCalled(); expect(stream.locked).toBe(false);
      if (caso.endsWith('grande')) expect(cancelada).toHaveBeenCalledTimes(1);
    } finally { c.cerrar(); }
  });
  it('UTF8 válido dividido por byte preserva metadata y respeta 200 con URL exacta', async () => {
    const c = await contexto();
    try {
      const bytes = new TextEncoder().encode(c.texto); let posicion = 0;
      const r = new Response(new ReadableStream<Uint8Array>({ pull(controlador) {
        if (posicion === bytes.length) controlador.close(); else controlador.enqueue(bytes.slice(posicion, ++posicion));
      } }), { status: 200, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'private, no-store' } });
      Object.defineProperty(r, 'url', { value: origen + '/api/fotos/respaldo' });
      c.enviar.mockResolvedValue(r); expect(await c.transporte.subir(c.ref)).toMatchObject({ fase: 'respaldada' });
    } finally { c.cerrar(); }
  });
  it('cancelar durante lectura cancela stream y nunca confirma', async () => {
    const c = await contexto(); const leyendo = barrera<void>(); const cancelar = vi.fn();
    const r = new Response(new ReadableStream<Uint8Array>({ pull() { leyendo.resolver(); }, cancel: cancelar }, { highWaterMark: 0 }), {
      status: 200, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
    });
    c.enviar.mockResolvedValue(r); const confirmar = vi.spyOn(c.ledger, 'confirmarRecibo');
    try {
      const carga = c.transporte.subir(c.ref).catch((e: unknown) => e);
      await leyendo.promesa; c.transporte.cancelar(); expect(await carga).toBeInstanceOf(Error);
      expect(confirmar).not.toHaveBeenCalled(); expect(cancelar).toHaveBeenCalledTimes(1); expect(r.body!.locked).toBe(false);
    } finally { c.cerrar(); }
  });
});


describe('fronteras restantes del puerto HTTP y autoridad local', () => {
  it('fetch global capturado no admite Response sin URL; sintético solo pertenece a inyección explícita', async () => {
    const c = await contexto(); const anterior = globalThis.fetch;
    try {
      const nativoControlado = vi.fn<typeof fetch>(async () => c.respuesta());
      globalThis.fetch = nativoControlado;
      const t = crearTransporteFotos({ plan: itinerario, origen, fuente: c.fuente, ledger: c.ledger });
      globalThis.fetch = vi.fn<typeof fetch>(async () => { throw new Error('No debe usar global cambiado'); });
      await expect(t.subir(c.ref)).rejects.toMatchObject({ estado: 'incierta' });
      expect(nativoControlado).toHaveBeenCalledTimes(1);
      expect(await c.ledger.leer(fotoId)).toMatchObject({ fase: 'enviada', recibo: null }); t.cerrar();
    } finally { globalThis.fetch = anterior; c.cerrar(); }
  });
  it('recibo válido de otro job nunca confirma ni modifica ese job', async () => {
    const c = await contexto();
    try {
      const otra = crearCapturaFoto(itinerario, c.captura.metadatos.destino,
        new File(['otro'], 'otra', { type: 'image/png', lastModified: 18 }), 1,
        { uuid: () => '42345678-1234-4123-8123-123456789abc' });
      await c.fuente.guardarOriginal(otra);
      const e = await c.ledger.preparar(otra, '32345678-1234-4123-8123-123456789abc');
      c.enviar.mockResolvedValue(respuestaTexto(serializarReciboRespaldo(itinerario, {
        version: 1, tipo: 'acuse-respaldo', viajeId: itinerario.id, ...referencia(e),
        objetoOriginalDurable: true, metadatosDurables: true,
      })));
      await sinAcuse(c); expect(await c.ledger.leer(e.fotoId)).toEqual(e);
    } finally { c.cerrar(); }
  });
  it('ledger bloqueado preserva recibo anterior y no admite retry ni nuevo upload', async () => {
    const c = await contexto();
    try {
      await c.ledger.marcarEnviada(c.ref); await c.ledger.confirmarRecibo(c.recibo);
      // Control local independiente: contradicción crea bloqueo con evidencia anterior conservada.
      await c.ledger.confirmarRecibo({ ...c.recibo, original: { ...c.ref.original, incorporada: 0 } });
      const antes = await c.ledger.leer(fotoId); const retry = vi.spyOn(c.ledger, 'reintentar');
      await expect(c.transporte.subir(c.ref)).rejects.toThrow();
      await expect(c.transporte.reintentar(c.ref)).rejects.toThrow();
      expect(c.enviar).not.toHaveBeenCalled(); expect(retry).not.toHaveBeenCalled();
      expect(await c.ledger.leer(fotoId)).toEqual(antes); expect(antes!.recibo).toEqual(c.recibo);
    } finally { c.cerrar(); }
  });
  it('pausa durable desde otra conexión ya completada antes de IO es observada', async () => {
    const c = await contexto(); const dentro = barrera<void>(); const liberar = barrera<void>();
    const otra = await abrirRespaldoFotosLocal(itinerario, c.fuente, { fabrica: c.fabrica });
    const marcar = c.ledger.marcarEnviada;
    c.ledger.marcarEnviada = async (ref) => { const e = await marcar(ref); dentro.resolver(); await liberar.promesa; return e; };
    try {
      const carga = c.transporte.subir(c.ref).catch((e: unknown) => e);
      await dentro.promesa; await otra.pausar(c.ref); liberar.resolver();
      expect(await carga).toBeInstanceOf(Error); expect(c.enviar).not.toHaveBeenCalled();
      expect(await otra.leer(fotoId)).toMatchObject({ fase: 'enviada', pausada: true });
    } finally { liberar.resolver(); otra.cerrar(); c.cerrar(); }
  });
});


it('intención de pausa pendiente anterior a la carga bloquea subir y retry antes de IO', async () => {
  const c = await contexto(); const dentro = barrera<void>(); const liberar = barrera<void>();
  const pausar = c.ledger.pausar;
  c.ledger.pausar = async (ref) => { dentro.resolver(); await liberar.promesa; return pausar(ref); };
  const pausa = c.transporte.pausar(c.ref);
  try {
    await dentro.promesa;
    await expect(c.transporte.subir(c.ref)).rejects.toThrow();
    await expect(c.transporte.reintentar(c.ref)).rejects.toThrow();
    expect(c.enviar).not.toHaveBeenCalled(); liberar.resolver(); await pausa;
  } finally { liberar.resolver(); await pausa.catch(() => {}); c.cerrar(); }
});


it('atestación fallida al reabrir una enviada no borra ni oculta su incertidumbre anterior', async () => {
  const c = await contexto();
  try {
    await c.ledger.marcarEnviada(c.ref); await c.fuente.borrarLocal(fotoId);
    await expect(c.transporte.subir(c.ref)).rejects.toMatchObject({ estado: 'incierta' });
    expect(c.enviar).not.toHaveBeenCalled();
    expect(await c.ledger.leer(fotoId)).toMatchObject({ fase: 'enviada', enviada: true, recibo: null });
  } finally { c.cerrar(); }
});
