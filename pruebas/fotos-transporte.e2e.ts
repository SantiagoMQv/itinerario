import { test, expect, type Page } from '@playwright/test';
import { createServer, type Server } from 'node:http';
import { build, type Rollup } from 'vite';
import { itinerario } from '../src/datos/itinerario';
import { deserializarSolicitudRespaldo, serializarReciboRespaldo, MAX_BYTES_JSON_RESPALDO } from '../src/fotos-protocolo';

// HTTP loopback propio + Chromium + IndexedDB nativos. No UI, SW, sesión real ni proveedor.
// Build write:false usa fuente actual en memoria; preview del runner compila además dist actual.
let servidor: Server;
let origen: string;
let modo: 'normal' | 'aborto' | 'redirect' | 'BOM' | 'grande' | 'UTF8' = 'normal';
interface Observacion {
  metodo?: string;
  campos: string[];
  contentType: string;
  nombreBinario: string;
  mimeBinario: string;
  bytes: number[];
  nombreRaw: string;
  menosCero: boolean;
  cookie?: string;
}
let observaciones: Observacion[] = [];
let destinosRedirect = 0;
let resolverAborto: (() => void) | null = null;
let abortoObservado: Promise<void>;
let errores: string[] = [];

test.beforeAll(async () => {
  const resultado = await build({ configFile: false, logLevel: 'silent', build: {
    write: false, minify: false, rollupOptions: { preserveEntrySignatures: 'strict', input: {
      transporte: 'src/fotos-transporte.ts', respaldo: 'src/fotos-respaldo-local.ts',
      local: 'src/fotos-local.ts', fotos: 'src/fotos.ts', plan: 'src/datos/itinerario.ts',
    }, output: { entryFileNames: '[name].js', chunkFileNames: 'fragmento-[hash].js' } },
  } });
  const salida = (Array.isArray(resultado) ? resultado[0] : resultado) as Rollup.RollupOutput;
  const archivos = new Map(salida.output.filter((o) => o.type === 'chunk').map((o) => [o.fileName, o.code]));
  servidor = createServer((req, res) => {
    void (async () => {
      const ruta = new URL(req.url!, 'http://local').pathname;
      res.setHeader('Cache-Control', 'no-store');
      if (archivos.has(ruta.slice(1))) {
        res.setHeader('Content-Type', 'text/javascript'); res.end(archivos.get(ruta.slice(1))); return;
      }
      if (ruta === '/') { res.setHeader('Content-Type', 'text/html'); res.end('<!doctype html><title>Transporte manual local</title>'); return; }
      if (ruta === '/login') { destinosRedirect++; res.end('No es ACK'); return; }
      if (ruta !== '/api/fotos/respaldo' || req.method !== 'POST') { res.statusCode = 404; res.end(); return; }
      const trozos: Buffer[] = [];
      for await (const trozo of req) trozos.push(Buffer.from(trozo));
      // Fixture local controlada: parser multipart nativo Node. No formato binario ad hoc.
      const cuerpo = await new Response(new Uint8Array(Buffer.concat(trozos)), {
        headers: { 'Content-Type': req.headers['content-type']! },
      }).formData();
      const texto = cuerpo.get('solicitud');
      if (typeof texto !== 'string') throw new Error('Solicitud debe ser STRING, no File');
      const solicitud = deserializarSolicitudRespaldo(itinerario, texto);
      const original = cuerpo.get('original') as File;
      observaciones.push({ metodo: req.method, campos: [...cuerpo.keys()], contentType: req.headers['content-type']!,
        nombreBinario: original.name, mimeBinario: original.type,
        bytes: [...new Uint8Array(await original.arrayBuffer())], nombreRaw: solicitud.original.nombre,
        menosCero: Object.is(solicitud.original.incorporada, -0), cookie: req.headers.cookie });
      if (modo === 'redirect') { res.statusCode = 303; res.setHeader('Location', '/login'); res.end(); return; }
      res.statusCode = 201; res.setHeader('Content-Type', 'application/json; charset=utf-8');
      const recibo = serializarReciboRespaldo(itinerario, { ...solicitud, tipo: 'acuse-respaldo',
        objetoOriginalDurable: true, metadatosDurables: true });
      if (modo === 'aborto') {
        // Cabeceras reales y stream pendiente: cancelación nativa, no delay/poll/sleep.
        res.on('close', () => resolverAborto?.()); res.write('{'); return;
      }
      if (modo === 'BOM') { res.end(Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(recibo)])); return; }
      if (modo === 'UTF8') { res.end(Buffer.from([0xc3, 0x28])); return; }
      if (modo === 'grande') {
        // Cuenta BYTES UTF-8, no caracteres; no Content-Length como autoridad.
        res.write('é'.repeat(MAX_BYTES_JSON_RESPALDO / 2)); res.end('é'); return;
      }
      res.end(recibo);
    })().catch((e: unknown) => {
      errores.push(e instanceof Error ? e.message : String(e));
      if (!res.headersSent) res.statusCode = 500;
      res.end();
    });
  });
  await new Promise<void>((ok) => servidor.listen(0, '127.0.0.1', ok));
  const direccion = servidor.address();
  if (!direccion || typeof direccion === 'string') throw new Error('Sin puerto local');
  origen = `http://127.0.0.1:${direccion.port}`;
});
test.afterAll(async () => {
  if (servidor) await new Promise<void>((ok, no) => servidor.close((e) => e ? no(e) : ok()));
});
test.beforeEach(async ({ page }) => {
  modo = 'normal'; observaciones = []; destinosRedirect = 0; errores = [];
  abortoObservado = new Promise<void>((ok) => { resolverAborto = ok; });
  await page.route('**/*', (ruta) => new URL(ruta.request().url()).origin === origen ? ruta.continue() : ruta.abort());
  await page.goto(origen);
});

async function cargar(page: Page, abortar = false) {
  return page.evaluate(async (abortar) => {
    const [modulo, respaldo, local, fotos, plan] = await Promise.all(
      ['/transporte.js', '/respaldo.js', '/local.js', '/fotos.js', '/plan.js'].map((ruta) => import(ruta)));
    const { itinerario } = plan;
    const fuente = await local.abrirFotosLocal(itinerario);
    const captura = fotos.crearCapturaFoto(itinerario, { tipo: 'parada', viajeId: itinerario.id,
      paradaId: itinerario.dias[0].paradas[0].id }, new File([new Uint8Array([0, 255, 17, 0, 128])], '\0 e\u0301 ',
      { type: 'image/heic', lastModified: 17 }), -0);
    await fuente.guardarOriginal(captura);
    const ledger = await respaldo.abrirRespaldoFotosLocal(itinerario, fuente);
    const e = await ledger.preparar(captura);
    const ref = { fotoId: e.fotoId, operacionId: e.operacionId, original: e.original };
    let llamadas = 0; let signalAbortado = false; let estadoAntesIO = '';
    let transporte: ReturnType<typeof modulo.crearTransporteFotos>;
    const enviar: typeof fetch = async (url, opciones) => {
      llamadas++; estadoAntesIO = (await ledger.leer(e.fotoId)).fase;
      opciones!.signal!.addEventListener('abort', () => { signalAbortado = true; }, { once: true });
      const r = await fetch(url, opciones); // HTTP nativo real, sin mock Response ni request interception.
      if (abortar) transporte.cancelar();
      return r;
    };
    transporte = modulo.crearTransporteFotos({ plan: itinerario, origen: location.origin, fuente, ledger, fetch: enviar });
    const estimacion = transporte.estimar(ref);
    const llamadasAntes = llamadas;
    let resultado = ''; let estadoError = '';
    try { resultado = (await transporte.subir(ref)).fase; }
    catch (e) { resultado = 'rechazada'; estadoError = (e as { estado: string }).estado; }
    const final = await ledger.leer(ref.fotoId);
    transporte.cerrar(); ledger.cerrar();
    const reabierta = await respaldo.abrirRespaldoFotosLocal(itinerario, fuente);
    const durable = await reabierta.leer(ref.fotoId);
    const conservado = await fuente.leerOriginal(ref.fotoId);
    const bytesOriginal = [...new Uint8Array(await conservado.arrayBuffer())];
    reabierta.cerrar(); fuente.cerrar();
    return { resultado, estadoError, final, durable, llamadas, llamadasAntes, estadoAntesIO,
      signalAbortado, estimacion, bytesOriginal, signo: Object.is(durable.original.incorporada, -0) };
  }, abortar);
}

test('Chromium envía multipart nativo exacto y espera marcador y confirmación IndexedDB', async ({ page }) => {
  const r = await cargar(page);
  expect(r.resultado).toBe('respaldada'); expect(r.durable.fase).toBe('respaldada');
  expect(r.llamadasAntes).toBe(0); expect(r.llamadas).toBe(1); expect(r.estadoAntesIO).toBe('enviada');
  expect(r.signo).toBe(true); expect(r.estimacion.traficoFacturable).toBe('desconocido');
  expect(r.bytesOriginal).toEqual([0, 255, 17, 0, 128]); expect(errores).toEqual([]);
  expect(observaciones).toHaveLength(1);
  const o = observaciones[0];
  expect(o).toMatchObject({ metodo: 'POST', campos: ['solicitud', 'original'], nombreBinario: 'original',
    mimeBinario: 'application/octet-stream', bytes: [0, 255, 17, 0, 128], nombreRaw: '\0 e\u0301 ', menosCero: true });
  expect(o.contentType).toMatch(/^multipart\/form-data; boundary=/);
  expect(o.cookie).toBeUndefined(); // Fixture sin credenciales: NO prueba sesión/auth backend.
});

test('aborto real tras cabeceras cierra stream HTTP sin ACK y reopen conserva incertidumbre', async ({ page }) => {
  modo = 'aborto';
  const r = await cargar(page, true); await abortoObservado;
  expect(r.resultado).toBe('rechazada'); expect(r.signalAbortado).toBe(true);
  expect(r.durable).toMatchObject({ fase: 'enviada', enviada: true, recibo: null });
  expect(r.llamadas).toBe(1); expect(observaciones).toHaveLength(1); expect(errores).toEqual([]);
  // Bytes llegaron al fixture antes del abort: cancelar NO promete cero transferencia/facturación.
  expect(observaciones[0].bytes).toEqual([0, 255, 17, 0, 128]);
});

test('redirect error nativo no visita login ni convierte 303 en acuse', async ({ page }) => {
  modo = 'redirect'; const r = await cargar(page);
  expect(r.resultado).toBe('rechazada'); expect(r.estadoError).toBe('incierta');
  expect(r.durable).toMatchObject({ fase: 'enviada', recibo: null });
  expect(destinosRedirect).toBe(0); expect(observaciones).toHaveLength(1); expect(errores).toEqual([]);
});

test('BOM raw, UTF8 inválido y exceso UTF8 reales no producen confirmación durable', async ({ page }) => {
  for (const caso of ['BOM', 'UTF8', 'grande'] as const) {
    modo = caso; const r = await cargar(page);
    expect(r.resultado, caso).toBe('rechazada'); expect(r.estadoError, caso).toBe('incierta');
    expect(r.durable, caso).toMatchObject({ fase: 'enviada', recibo: null });
    expect(r.llamadas, caso).toBe(1); expect(r.signo, caso).toBe(true);
  }
  expect(observaciones).toHaveLength(3); expect(errores).toEqual([]);
});
