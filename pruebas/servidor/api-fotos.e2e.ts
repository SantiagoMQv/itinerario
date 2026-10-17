import { test, expect, type Page } from '@playwright/test';
import { createServer, request as solicitarHttps, type Server } from 'node:https';
import type { IncomingMessage } from 'node:http';
import { TLSSocket } from 'node:tls';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { crearControladorFotos } from '../../servidor/api-fotos';
import { clavePrivadaFotos } from '../../servidor/almacen-fotos';
import * as protocoloNodo from '../../src/fotos-protocolo';
import { itinerario } from '../../src/datos/itinerario';
import { build, type Rollup } from 'vite';
import type { SolicitudRespaldo } from '../../src/fotos-protocolo';
import type { PresupuestoFotos } from '../../servidor/multipart-fotos';
import type { ReservaFotos, RepositorioFotos, ObjetosFotos } from '../../servidor/almacen-fotos';

// TLS y FormData por cable reales; autenticación, SQL y R2 son puertos MODELADOS.
// No certifica cookies, proveedores, durabilidad SQL/R2 ni teléfonos físicos.
test.use({ ignoreHTTPSErrors: true });
let servidor: Server;
let origen: string;
let temporal: string;
let certificado: Buffer;
let llamadasApi = 0;
let llamadasExternas = 0;
let modelo: ReturnType<typeof crearModelo>;
const presupuestoBase: PresupuestoFotos = { maxBytesOriginal: 2000000, maxBytesEntrada: 2200000,
  maxBytesChunk: 65536, maxBytesCabeceras: 1024, maxBytesRetenidos: 8000000,
  maxBloquesOriginal: 100, bytesBloque: 65536, plazoMs: 10000 };
interface EstadoModelo {
  viva: boolean; perdidaReserva: boolean; perdidaPut: boolean; perdidaFinal: boolean;
  revocarEnScan: boolean; colgarReserva: boolean; colgarScan: boolean;
}
interface CapturaCable {
  originCable: string | null; originAdaptado: string | null; tls: boolean;
  lecturas: number; auth: number; reserva: number; put: number; final: number;
}
const capturas: CapturaCable[] = [];
let presupuestoActual = presupuestoBase;
let fragmentoActual = 17;
function crearModelo() {
  const eventos: string[] = [];
  const estado: EstadoModelo = { viva: true, perdidaReserva: false, perdidaPut: false,
    perdidaFinal: false, revocarEnScan: false, colgarReserva: false, colgarScan: false };
  let reserva: ReservaFotos | null = null;
  let confirmada = false;
  let original: Blob | null = null;
  const repositorio: RepositorioFotos = {
    async reservar(_a, _v, texto) {
      eventos.push('reserva'); if (estado.colgarReserva) return new Promise(() => {});
      if (reserva) return { tipo: 'existente', reserva };
      const s = protocoloNodo.deserializarSolicitudRespaldo(itinerario, texto);
      const reservaId = 'ABCDEF12-1234-4123-8123-123456789ABE';
      reserva = { reservaId, claveObjeto: clavePrivadaFotos(itinerario.id, s.fotoId, reservaId), solicitudCanonica: texto };
      if (estado.perdidaReserva) throw new Error('SQL perdido');
      return { tipo: 'ganadora', reserva };
    },
    async finalizar(_a, _v, _r, texto) {
      eventos.push('final'); if (!estado.viva) return { tipo: 'sin-sesion' };
      confirmada = true; if (estado.perdidaFinal) throw new Error('final perdido');
      const s = protocoloNodo.deserializarSolicitudRespaldo(itinerario, texto);
      return { tipo: 'confirmada', reciboCanonico: protocoloNodo.serializarReciboRespaldo(itinerario,
        { ...s, tipo: 'acuse-respaldo', objetoOriginalDurable: true, metadatosDurables: true }) };
    },
    async leerConfirmada() {
      eventos.push('consulta'); return confirmada ? { tipo: 'confirmada', reserva: reserva! } : { tipo: 'ausente' };
    },
  };
  const objetos: ObjetosFotos = {
    async ponerSiAusente(_k, b) {
      eventos.push('put'); if (original) return false;
      original = b; if (estado.perdidaPut) throw new Error('put perdido'); return true;
    },
    async leer(claveObjeto) {
      eventos.push('get'); if (!original) return null;
      if (estado.revocarEnScan) estado.viva = false;
      return { claveObjeto, solicitudCanonica: reserva!.solicitudCanonica,
        original: estado.colgarScan ? new ReadableStream<Uint8Array>() : original.stream() };
    },
  };
  const controlador = crearControladorFotos({ plan: itinerario, origen,
    autenticar: async () => {
      eventos.push('auth'); return estado.viva ? { id: 'abcdef12-1234-4123-8123-123456789abd',
        huella: 'a'.repeat(64), viajeId: itinerario.id, dispositivoId: 'editor-igual', creadaEn: 0,
        venceEn: Number.MAX_SAFE_INTEGER, revocada: false } : null;
    }, repositorio, objetos });
  return { eventos, estado, controlador, tieneOriginal: () => original !== null };
}

function adaptar(req: IncomingMessage, captura: CapturaCable): Request {
  if (!(req.socket instanceof TLSSocket) || !req.socket.encrypted) throw new Error('Se exige socket TLS propio');
  const headers = new Headers();
  for (let i = 0; i < req.rawHeaders.length; i += 2) headers.append(req.rawHeaders[i], req.rawHeaders[i + 1]);
  captura.originAdaptado = headers.get('Origin');
  const method = req.method!;
  const abortador = new AbortController();
  req.once('aborted', () => abortador.abort());
  // El iterador se crea en el primer pull, HWM cero evita prelectura de aplicación.
  // Se conserva como máximo un chunk Node y se refragmenta; NO representa paquetes TLS/TCP.
  const fragmento = fragmentoActual;
  let iterador: AsyncIterator<Buffer> | undefined;
  let bloque: Buffer | undefined;
  let posicion = 0;
  const body = method === 'GET' || method === 'HEAD' ? undefined : new ReadableStream<Uint8Array>({
    async pull(c) {
      captura.lecturas++;
      iterador ??= req.iterator({ destroyOnReturn: false });
      if (!bloque || posicion === bloque.length) {
        const siguiente = await iterador.next();
        if (siguiente.done) { c.close(); return; }
        bloque = siguiente.value; posicion = 0;
      }
      const fin = Math.min(bloque.length, posicion + fragmento);
      c.enqueue(new Uint8Array(bloque.subarray(posicion, fin))); posicion = fin;
    },
    async cancel() { await iterador?.return?.(); },
  }, { highWaterMark: 0 });
  return new Request(new URL(req.url!, origen), { method, headers, body,
    signal: abortador.signal, duplex: 'half' } as RequestInit);
}
test.beforeAll(async () => {
  const resultado = await build({ configFile: false, logLevel: 'silent', build: {
    write: false, minify: false, rollupOptions: { preserveEntrySignatures: 'strict', input: {
      api: 'servidor/api-fotos.ts', almacen: 'servidor/almacen-fotos.ts', multipart: 'servidor/multipart-fotos.ts', protocolo: 'src/fotos-protocolo.ts',
      plan: 'src/datos/itinerario.ts',
    }, output: { entryFileNames: '[name].js', chunkFileNames: 'fragmento-[hash].js' } },
  } });
  const salida = (Array.isArray(resultado) ? resultado[0] : resultado) as Rollup.RollupOutput;
  const archivos = new Map(salida.output.filter((a) => a.type === 'chunk').map((a) => [a.fileName, a.code]));
  temporal = await mkdtemp(join(tmpdir(), 'itinerario-tls-prueba-'));
  // Un archivo real evita reabrir /dev/stdin, que falla desde Node en Linux.
  await writeFile(join(temporal, 'configuracion-tls.cnf'), `[req]
prompt = no
distinguished_name = dn
x509_extensions = extensiones
[dn]
CN = 127.0.0.1
[extensiones]
subjectAltName = IP:127.0.0.1
basicConstraints = critical,CA:FALSE
keyUsage = critical,digitalSignature,keyEncipherment
extendedKeyUsage = serverAuth
`);
  execFileSync('/usr/bin/openssl', ['req','-x509','-newkey','rsa:2048','-nodes','-sha256','-days','1','-config',join(temporal, 'configuracion-tls.cnf'),'-keyout',join(temporal,'clave-prueba.pem'),'-out',join(temporal,'certificado-prueba.pem')], {stdio:['pipe','pipe','pipe']});
  certificado = await readFile(join(temporal, 'certificado-prueba.pem'));
  servidor = createServer({ key: await readFile(join(temporal, 'clave-prueba.pem')), cert: certificado,
    highWaterMark: 65536 }, async (req, res) => {
    const ruta = new URL(req.url!, origen).pathname;
    if (ruta.startsWith('/api/')) {
      llamadasApi++;
      const captura: CapturaCable = { originCable: req.headers.origin ?? null, originAdaptado: null,
        tls: req.socket instanceof TLSSocket && req.socket.encrypted,
        lecturas: 0, auth: 0, reserva: 0, put: 0, final: 0 };
      const inicio = modelo.eventos.length;
      try {
        const respuesta = await modelo.controlador.atender(adaptar(req, captura), presupuestoActual);
        res.writeHead(respuesta.status, Object.fromEntries(respuesta.headers));
        res.end(Buffer.from(await respuesta.arrayBuffer()));
      } catch (e) { res.destroy(e instanceof Error ? e : new Error(String(e))); }
      finally {
        for (const evento of modelo.eventos.slice(inicio)) {
          if (evento === 'auth' || evento === 'reserva' || evento === 'put' || evento === 'final') captura[evento]++;
        }
        capturas.push(captura);
        // Drenaje de transporte posterior al gate, no lectura del adaptador/parser.
        req.resume();
      }
      return;
    }
    res.setHeader('Cache-Control', 'no-store');
    if (archivos.has(ruta.slice(1))) {
      res.setHeader('Content-Type', 'text/javascript'); res.end(archivos.get(ruta.slice(1))); return;
    }
    if (ruta === '/') {
      res.setHeader('Content-Type', 'text/html'); res.end('<!doctype html><title>Servidor de originales</title>'); return;
    }
    res.statusCode = 404; res.end();
  });
  await new Promise<void>((ok) => servidor.listen(0, '127.0.0.1', ok));
  const d = servidor.address();
  if (!d || typeof d === 'string') throw new Error('Sin puerto propio');
  origen = `https://127.0.0.1:${d.port}`;
});
test.afterAll(async () => {
  try {
    if (servidor) {
      const cierre = new Promise<void>((ok, no) => servidor.close((e) => e ? no(e) : ok()));
      servidor.closeAllConnections();
      await cierre;
    }
  } finally { if (temporal) await rm(temporal, { recursive: true, force: true }); }
});
test.beforeEach(async ({ page }) => {
  llamadasApi = 0; llamadasExternas = 0; capturas.length = 0;
  presupuestoActual = presupuestoBase; fragmentoActual = 17; modelo = crearModelo();
  await page.exposeBinding('configurarModeloFotos', (_fuente, estado: EstadoModelo, eventos: string[], presupuesto: PresupuestoFotos, fragmento: number) => {
    Object.assign(modelo.estado, estado); modelo.eventos.splice(0, modelo.eventos.length, ...eventos);
    presupuestoActual = presupuesto; fragmentoActual = fragmento;
  });
  await page.exposeBinding('consultarModeloFotos', () => ({ estado: modelo.estado,
    eventos: [...modelo.eventos], tieneOriginal: modelo.tieneOriginal() }));
  await page.route('**/*', (r) => {
    if (new URL(r.request().url()).origin === origen) return r.continue();
    llamadasExternas++; return r.abort();
  });
  await page.goto(origen); await cargar(page);
});
const apiEsperada = [3, 4, 3, 2, 3, 2, 7, 0, 0];
test.afterEach(({}, info) => {
  const indice = escenarios.indexOf(info.title);
  expect(indice).toBeGreaterThanOrEqual(0);
  expect(llamadasApi).toBe(apiEsperada[indice]);
  expect(llamadasExternas).toBe(0);
  expect(capturas).toHaveLength(llamadasApi);
  for (const c of capturas) {
    expect(c.tls).toBe(true); expect(c.originAdaptado).toBe(c.originCable);
    if (c.auth > 0 && c.originCable !== null) expect(c.originCable).toBe(origen);
  }
});
const escenarios: string[] = [];

interface FixtureServidorFotos {
  plan: typeof import('../../src/datos/itinerario').itinerario;
  protocolo: typeof import('../../src/fotos-protocolo');
  multipart: typeof import('../../servidor/multipart-fotos');
  presupuesto: PresupuestoFotos;
  solicitud(bytes?: number): SolicitudRespaldo;
  request(s: SolicitudRespaldo, datos: Uint8Array, fragmento?: number, texto?: string, extra?: boolean): Promise<Request>;
  atender: import('../../servidor/api-fotos').ControladorFotos['atender'];
  eventos: string[];
  estado: { viva: boolean; perdidaReserva: boolean; perdidaPut: boolean; perdidaFinal: boolean;
    revocarEnScan: boolean; colgarReserva: boolean; colgarScan: boolean; original: Blob | null };
}
declare global { interface Window {
  fixtureServidorFotos: FixtureServidorFotos;
  configurarModeloFotos(estado: EstadoModelo, eventos: string[], presupuesto: PresupuestoFotos, fragmento: number): Promise<void>;
  consultarModeloFotos(): Promise<{ estado: EstadoModelo; eventos: string[]; tieneOriginal: boolean }>;
} }
async function cargar(page: Page): Promise<void> {
  await page.evaluate(async () => {
    const [protocolo, datos, multipart] = await Promise.all(['/protocolo.js', '/plan.js', '/multipart.js'].map((r) => import(r)));
    const formularios = new WeakMap<Request, { form: FormData; fragmento: number }>();
    const plan = datos.itinerario as FixtureServidorFotos['plan'];
    const eventos: string[] = [];
    const estado = { viva: true, perdidaReserva: false, perdidaPut: false, perdidaFinal: false,
      revocarEnScan: false, colgarReserva: false, colgarScan: false, original: null as Blob | null };
    const solicitud = (bytes = 3): SolicitudRespaldo => {
      const fotoId = 'ABCDEF12-1234-4123-8123-123456789ABD';
      return { version: 1, tipo: 'solicitud-respaldo', viajeId: plan.id,
        operacionId: 'ABCDEF12-1234-4123-8123-123456789ABC', fotoId, original: { formato: 1, fotoId,
          destino: { tipo: 'parada', viajeId: plan.id, paradaId: plan.dias[0].paradas[0].id },
          nombre: '\0 e\u0301 😀 ', mimeDeclarado: 'IMAGE/HEIC\0', incorporada: -0,
          ultimaModificacion: -0, bytesOriginal: bytes } };
    };
    // El Request/stream sólo se usa para el caso de parser directo. La API envía
    // el FormData por fetch nativo (no stream custom ni header Origin de script).
    async function atender(request: Request, presupuesto: PresupuestoFotos): Promise<Response> {
      const entrada = formularios.get(request);
      const { original: _original, ...controles } = estado;
      await window.configurarModeloFotos(controles, eventos, presupuesto, entrada?.fragmento ?? 17);
      // Esta copia del stream era sólo para el parser directo; no se envía por HTTP.
      await request.body?.cancel();
      const respuesta = await fetch(new URL(new URL(request.url).pathname, location.origin), {
        method: request.method, body: entrada?.form, credentials: 'same-origin',
      });
      const copia = await window.consultarModeloFotos();
      Object.assign(estado, copia.estado);
      estado.original = copia.tieneOriginal ? new Blob([]) : null; // Sólo indicador del puerto modelado.
      eventos.splice(0, eventos.length, ...copia.eventos);
      return respuesta;
    }
    async function request(s: SolicitudRespaldo, original: Uint8Array, fragmento = 17, texto?: string, extra = false): Promise<Request> {
      const form = new FormData(); form.append('solicitud', texto ?? protocolo.serializarSolicitudRespaldo(plan, s));
      form.append('original', new Blob([original as Uint8Array<ArrayBuffer>], { type: 'application/octet-stream' }), 'original');
      if (extra) form.append('otra', 'no');
      const nativa = new Request(new URL('/api/fotos/respaldo', location.origin), { method: 'POST', body: form });
      const lector = nativa.body!.getReader(); let bloque: Uint8Array | null = null; let pos = 0;
      const body = new ReadableStream<Uint8Array>({ async pull(c) {
        while (!bloque || pos === bloque.length) {
          const r = await lector.read();
          if (r.done) { lector.releaseLock(); c.close(); return; }
          bloque = r.value; pos = 0;
        }
        const fin = Math.min(bloque.length, pos + fragmento); c.enqueue(bloque.slice(pos, fin)); pos = fin;
      }, cancel() { void lector.cancel().catch(() => {}); try { lector.releaseLock(); } catch { /* Limpieza fixture. */ } } });
      const request = new Request(nativa.url, { method: 'POST', headers: {
        'Content-Type': nativa.headers.get('Content-Type')! }, body, duplex: 'half' } as RequestInit);
      formularios.set(request, { form, fragmento });
      return request;
    }
    Object.assign(window, { fixtureServidorFotos: { plan, protocolo, multipart, solicitud, request, eventos, estado,
      atender, presupuesto: { maxBytesOriginal: 2000000, maxBytesEntrada: 2200000,
        maxBytesChunk: 65536, maxBytesCabeceras: 1024, maxBytesRetenidos: 8000000,
        maxBloquesOriginal: 100, bytesBloque: 65536, plazoMs: 10000 } } });
  });
}

escenarios.push('FormData real fragmentado a un byte: recibo exacto y GET privado, repetir nunca put');
test(escenarios[0], async ({ page }) => {
  const r = await page.evaluate(async () => {
    const f = window.fixtureServidorFotos; const bytes = new Uint8Array([1, 2, 3]);
    const solicitud = await f.request(f.solicitud(), bytes, 1);
    const primera = await f.atender(solicitud, f.presupuesto);
    if (primera.status !== 201) throw new Error(`Fixture TLS nativa: estado=${primera.status}`);
    const recibo = f.protocolo.deserializarReciboRespaldo(f.plan, await primera.text());
    const segunda = await f.atender(await f.request(f.solicitud(), bytes, 1), f.presupuesto);
    f.eventos.push('GET');
    const get = await f.atender(new Request(new URL(`/api/fotos/${encodeURIComponent(recibo.fotoId)}/original`, location.origin)), f.presupuesto);
    return { estados: [primera.status, segunda.status, get.status], igual: Object.is(recibo.original.incorporada, -0),
      nombre: recibo.original.nombre, mime: recibo.original.mimeDeclarado, id: recibo.fotoId,
      bytes: Array.from(new Uint8Array(await get.arrayBuffer())), eventos: f.eventos,
      headers: ['Content-Type', 'Cache-Control', 'Vary', 'X-Content-Type-Options'].map((h) => get.headers.get(h)) };
  });
  expect(r.estados).toEqual([201, 200, 200]); expect(r.igual).toBe(true);
  expect(r.nombre).toBe('\0 e\u0301 😀 '); expect(r.mime).toBe('IMAGE/HEIC\0');
  expect(r.id).toBe('ABCDEF12-1234-4123-8123-123456789ABD'); expect(r.bytes).toEqual([1, 2, 3]);
  expect(r.eventos.filter((e) => e === 'put')).toHaveLength(1);
  expect(r.headers).toEqual(['application/octet-stream', 'private, no-store', 'Cookie', 'nosniff']);
  expect(r.eventos.slice(r.eventos.indexOf('GET'))).toEqual(['GET', 'auth', 'consulta', 'get', 'auth']);
  expect(capturas.map((c) => c.originCable)).toEqual([origen, origen, null]);
  expect(capturas.map((c) => [c.auth, c.reserva, c.put, c.final])).toEqual([[2, 1, 1, 1], [2, 1, 0, 1], [2, 0, 0, 0]]);
  expect(capturas.slice(0, 2).every((c) => c.lecturas > 0)).toBe(true);
  expect(capturas[2].lecturas).toBe(0);
});

escenarios.push('BOM, claves escaped duplicadas, parte extra y recibo potencial excesivo: cero reserva/objeto');
test(escenarios[1], async ({ page }) => {
  const r = await page.evaluate(async () => {
    const f = window.fixtureServidorFotos; const s = f.solicitud(); const texto = f.protocolo.serializarSolicitudRespaldo(f.plan, s);
    const estados: number[] = [];
    for (const t of ['\ufeff' + texto, texto.replace('"version":1', '"version":1,"vers\\u0069on":1')]) {
      estados.push((await f.atender(await f.request(s, new Uint8Array([1, 2, 3]), 1, t), f.presupuesto)).status);
    }
    estados.push((await f.atender(await f.request(s, new Uint8Array([1, 2, 3]), 17, undefined, true), f.presupuesto)).status);
    const vacia = { ...s, original: { ...s.original, nombre: '' } };
    const n = 65536 - new TextEncoder().encode(f.protocolo.serializarSolicitudRespaldo(f.plan, vacia)).length;
    const enorme = { ...vacia, original: { ...vacia.original, nombre: 'x'.repeat(n) } };
    estados.push((await f.atender(await f.request(enorme, new Uint8Array([1, 2, 3]), 137), f.presupuesto)).status);
    return { estados, eventos: f.eventos };
  });
  expect(r.estados).toEqual([400, 400, 400, 413]); expect(r.eventos).toEqual(['auth', 'auth', 'auth', 'auth']);
});

escenarios.push('más de 1MiB: scan completo detecta colisión de último byte aun con recibo anterior');
test(escenarios[2], async ({ page }) => {
  const r = await page.evaluate(async () => {
    const f = window.fixtureServidorFotos; const datos = new Uint8Array(1048576 + 5); datos.fill(42);
    const s = f.solicitud(datos.length);
    const primera = await f.atender(await f.request(s, datos, 32768), f.presupuesto);
    const otros = datos.slice(); otros[otros.length - 1] = 43;
    const colision = await f.atender(await f.request(s, otros, 32768), f.presupuesto);
    const repetida = await f.atender(await f.request(s, datos, 32768), f.presupuesto);
    return { estados: [primera.status, colision.status, repetida.status], eventos: f.eventos };
  });
  expect(r.estados).toEqual([201, 409, 200]); expect(r.eventos.filter((e) => e === 'put')).toHaveLength(1);
  expect(r.eventos.filter((e) => e === 'final')).toHaveLength(2);
});

escenarios.push('respuesta reserva perdida deja hueco de disponibilidad: retry vacío jamás put/ACK');
test(escenarios[3], async ({ page }) => {
  const r = await page.evaluate(async () => {
    const f = window.fixtureServidorFotos; f.estado.perdidaReserva = true;
    const a = await f.atender(await f.request(f.solicitud(), new Uint8Array([1, 2, 3])), f.presupuesto);
    f.estado.perdidaReserva = false;
    const b = await f.atender(await f.request(f.solicitud(), new Uint8Array([1, 2, 3])), f.presupuesto);
    return { estados: [a.status, b.status], eventos: f.eventos };
  });
  expect(r.estados).toEqual([503, 503]); expect(r.eventos).toEqual(['auth', 'reserva', 'auth', 'reserva', 'get']);
});

escenarios.push('put/final respuestas perdidas: incierto y retry fullcompare sin otro put');
test(escenarios[4], async ({ page }) => {
  const r = await page.evaluate(async () => {
    const f = window.fixtureServidorFotos; const bytes = new Uint8Array([1, 2, 3]);
    f.estado.perdidaPut = true;
    const a = await f.atender(await f.request(f.solicitud(), bytes), f.presupuesto);
    f.estado.perdidaPut = false; f.estado.perdidaFinal = true;
    const b = await f.atender(await f.request(f.solicitud(), bytes), f.presupuesto);
    f.estado.perdidaFinal = false;
    const c = await f.atender(await f.request(f.solicitud(), bytes), f.presupuesto);
    return { estados: [a.status, b.status, c.status], eventos: f.eventos };
  });
  expect(r.estados).toEqual([503, 503, 200]); expect(r.eventos.filter((e) => e === 'put')).toHaveLength(1);
  expect(r.eventos.filter((e) => e === 'get')).toHaveLength(2);
});

escenarios.push('revocación en scan conserva huérfano y niega ACK; timeout scan no finaliza');
test(escenarios[5], async ({ page }) => {
  const r = await page.evaluate(async () => {
    const f = window.fixtureServidorFotos; const bytes = new Uint8Array([1, 2, 3]);
    f.estado.revocarEnScan = true;
    const revocada = await f.atender(await f.request(f.solicitud(), bytes), f.presupuesto);
    f.estado.viva = true; f.estado.revocarEnScan = false; f.estado.colgarScan = true;
    const timeout = await f.atender(await f.request(f.solicitud(), bytes), { ...f.presupuesto, plazoMs: 40 });
    const eventos = [...f.eventos];
    await new Promise((ok) => setTimeout(ok, 60));
    const posterior = await window.consultarModeloFotos();
    return { estados: [revocada.status, timeout.status], preservado: posterior.tieneOriginal,
      eventos, posteriores: posterior.eventos };
  });
  expect(r.estados).toEqual([401, 503]); expect(r.preservado).toBe(true);
  expect(r.eventos).not.toContain('final'); expect(r.posteriores).toEqual(r.eventos);
});

escenarios.push('HTTPS/Origin siguen activos y presupuestos cero/exceso rechazan sin reservar');
test(escenarios[6], async ({ page }) => {
  // Request HTTP MODELADO directo: no es tráfico TLS ni un puente de protocolo.
  expect((await modelo.controlador.atender(new Request('http://viaje.test/api/fotos/respaldo', { method: 'POST' }), presupuestoBase)).status).toBe(400);
  for (const origin of [undefined, origen + '/', 'null']) {
    const antes = capturas.length;
    const status = await new Promise<number>((ok, no) => {
      const req = solicitarHttps(new URL('/api/fotos/respaldo', origen), { method: 'POST', ca: certificado,
        headers: origin === undefined ? {} : { Origin: origin } }, (res) => {
        res.resume(); res.once('end', () => ok(res.statusCode!));
      });
      req.once('error', no); req.end('cuerpo adversarial no debe llegar al parser');
    });
    expect(status).toBe(403);
    expect(capturas[antes]).toEqual({ originCable: origin ?? null, originAdaptado: origin ?? null,
      tls: true, lecturas: 0, auth: 0, reserva: 0, put: 0, final: 0 });
  }
  const r = await page.evaluate(async () => {
    const f = window.fixtureServidorFotos; const estados: number[] = [];
    for (const limites of [{ maxBytesOriginal: 0 }, { maxBytesEntrada: 1 }, { maxBytesChunk: 0 }, { maxBytesRetenidos: 0 }]) {
      estados.push((await f.atender(await f.request(f.solicitud(), new Uint8Array([1, 2, 3])), { ...f.presupuesto, ...limites })).status);
    }
    return { estados, eventos: f.eventos };
  });
  expect(r.estados).toEqual([413, 413, 413, 413]); expect(r.eventos).toEqual(['auth', 'auth', 'auth', 'auth']);
  expect(capturas.slice(3).every((c) => c.originCable === origen && c.auth === 1 && c.reserva === 0 && c.put === 0 && c.final === 0)).toBe(true);
});

escenarios.push('parser productivo directo con WebAPI nativa, sin fingir evidencia del gate HTTP');
test(escenarios[7], async ({ page }) => {
  const r = await page.evaluate(async () => {
    const f = window.fixtureServidorFotos;
    async function parsear(s: SolicitudRespaldo, bytes: Uint8Array, tamano: number, texto?: string) {
      const request = await f.request(s, bytes, tamano, texto);
      const v = f.multipart.crearVigenciaFotos(request.signal, f.presupuesto.plazoMs);
      try { return await f.multipart.leerMultipartFotos(f.plan, request, f.presupuesto, v); }
      finally { v.cerrar(); }
    }
    const datos = new TextEncoder().encode('😀\r\n--parecidoXX\0');
    const s = f.solicitud(datos.length);
    const pequena = await parsear(s, datos, 1);
    const grande = new Uint8Array(1048576 + 5); grande.fill(42); grande[grande.length - 1] = 99;
    const captura = await parsear(f.solicitud(grande.length), grande, 32768);
    let bom = false;
    try { await parsear(s, datos, 1, '\ufeff' + f.protocolo.serializarSolicitudRespaldo(f.plan, s)); }
    catch (e) { bom = e instanceof f.multipart.FalloFotos && e.codigo === 400; }
    return { pequena: Array.from(new Uint8Array(await pequena.original.arrayBuffer())), esperado: Array.from(datos),
      bytes: captura.original.size, ultimo: new Uint8Array(await captura.original.slice(-1).arrayBuffer())[0],
      raw: pequena.solicitud.original.mimeDeclarado, negativo: Object.is(pequena.solicitud.original.incorporada, -0),
      bom, eventos: f.eventos };
  });
  expect(r.pequena).toEqual(r.esperado); expect(r.bytes).toBe(1048576 + 5); expect(r.ultimo).toBe(99);
  expect(r.raw).toBe('IMAGE/HEIC\0'); expect(r.negativo).toBe(true); expect(r.bom).toBe(true);
  expect(r.eventos).toEqual([]);
});

escenarios.push('plan de operador con getter: helper y fábricas rechazan sin IO en Chromium');
test(escenarios[8], async ({ page }) => {
  const resultado = await page.evaluate(async () => {
    const f = window.fixtureServidorFotos;
    const rutaApi = '/api.js'; const rutaAlmacen = '/almacen.js';
    const api: typeof import('../../servidor/api-fotos') = await import(rutaApi);
    const almacen: typeof import('../../servidor/almacen-fotos') = await import(rutaAlmacen);
    let llamadas = 0; let io = 0; let rechazos = 0;
    const puerto = async () => { io++; return null; };
    const repositorio = { reservar: puerto, finalizar: puerto, leerConfirmada: puerto };
    const objetos = { ponerSiAusente: puerto, leer: puerto };
    for (const anidado of [false, true]) {
      const plan = structuredClone(f.plan);
      Object.defineProperty(anidado ? plan.dias[0].paradas[0] : plan, 'id', {
        enumerable: true, get() { llamadas++; return 'sonda-operador'; },
      });
      for (const fabricar of [() => f.multipart.copiarPlanFotos(plan),
        () => almacen.crearAlmacenFotos({ plan, repositorio, objetos }),
        () => api.crearControladorFotos({ plan, origen: location.origin, autenticar: puerto, repositorio, objetos })]) {
        try { fabricar(); } catch { rechazos++; }
      }
    }
    const normal = structuredClone(f.plan);
    const copia = f.multipart.copiarPlanFotos(normal);
    normal.dias[0].paradas[0].nombre = 'mutación tardía';
    return { llamadas, io, rechazos, id: copia.id,
      aislado: copia.dias[0].paradas[0].nombre === f.plan.dias[0].paradas[0].nombre,
      eventos: f.eventos };
  });
  expect(resultado).toEqual({ llamadas: 0, io: 0, rechazos: 6, id: itinerario.id, aislado: true, eventos: [] });
  expect(modelo.eventos).toEqual([]);
  expect(modelo.tieneOriginal()).toBe(false);
});
