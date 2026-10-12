import { test, expect } from '@playwright/test';
import { createServer, type Server } from 'node:http';
import { build, type Rollup } from 'vite';

// Módulos FUENTE actuales en memoria y Chromium propio: sin UI, SW, DB ni proveedor.
let servidor: Server;
let origen: string;
test.beforeAll(async () => {
  const resultado = await build({ configFile: false, logLevel: 'silent', build: {
    write: false, minify: false, rollupOptions: { preserveEntrySignatures: 'strict', input: {
      protocolo: 'src/fotos-protocolo.ts', plan: 'src/datos/itinerario.ts', dominio: 'src/fotos-respaldo.ts',
    }, output: { entryFileNames: '[name].js', chunkFileNames: 'fragmento-[hash].js' } },
  } });
  const salida = (Array.isArray(resultado) ? resultado[0] : resultado) as Rollup.RollupOutput;
  const archivos = new Map(salida.output.filter((o) => o.type === 'chunk').map((o) => [o.fileName, o.code]));
  servidor = createServer((req, res) => {
    const nombre = new URL(req.url!, 'http://local').pathname.slice(1);
    res.setHeader('Cache-Control', 'no-store');
    if (archivos.has(nombre)) { res.setHeader('Content-Type', 'text/javascript'); res.end(archivos.get(nombre)); }
    else if (!nombre) { res.setHeader('Content-Type', 'text/html'); res.end('<!doctype html><title>Codec puro</title>'); }
    else { res.statusCode = 404; res.end(); }
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
  await page.route('**/*', (ruta) => new URL(ruta.request().url()).origin === origen ? ruta.continue() : ruta.abort());
  await page.goto(origen);
});

for (const tipo of ['solicitud', 'recibo'] as const) {
  test(`Chromium: ${tipo} por Request/Response y UTF-8 nativos, sin envío HTTP`, async ({ page }) => {
    const r = await page.evaluate(async (tipo) => {
      const [p, { itinerario: plan }, dominio] = await Promise.all(
        ['/protocolo.js', '/plan.js', '/dominio.js'].map((ruta) => import(ruta)));
      const fotoId = '12345678-1234-4123-8123-123456789abc';
      const original = { formato: 1, fotoId, destino: { tipo: 'parada', viajeId: plan.id,
        paradaId: plan.dias[0].paradas[0].id }, nombre: '\0 e\u0301 " \\ [-0] \ud800',
        mimeDeclarado: '\0 raw e\u0301', incorporada: -0, ultimaModificacion: -0, bytesOriginal: -0 };
      const s = { version: 1, tipo: 'solicitud-respaldo', viajeId: plan.id, fotoId,
        operacionId: '87654321-4321-4321-9321-cba987654321', original };
      const recibo = { ...s, tipo: 'acuse-respaldo', objetoOriginalDurable: true, metadatosDurables: true };
      const codificar = tipo === 'solicitud' ? p.serializarSolicitudRespaldo : p.serializarReciboRespaldo;
      const decodificar = tipo === 'solicitud' ? p.deserializarSolicitudRespaldo : p.deserializarReciboRespaldo;
      const valor = tipo === 'solicitud' ? s : recibo;
      const texto = codificar(plan, valor);
      // Request/Response locales, nunca fetch: no prueban servidor, sesión ni ACK remoto.
      const request = new Request(location.origin + '/no-se-envia', { method: 'POST', body: texto });
      const textoRequest = await request.text();
      const response = new Response(new TextEncoder().encode(textoRequest));
      const textoResponse = await response.text();
      const copia = decodificar(plan, textoResponse);
      const signos = ['incorporada', 'ultimaModificacion', 'bytesOriginal'].map((k) => Object.is(copia.original[k], -0));
      const positivos = [];
      for (const clave of ['incorporada', 'ultimaModificacion', 'bytesOriginal']) {
        const positivo = { ...valor, original: { ...original, [clave]: 0 } };
        const vuelta = decodificar(plan, codificar(plan, positivo));
        positivos.push(Object.is(vuelta.original[clave], 0)
          && !dominio.mismosOriginalesRespaldo(plan, vuelta.original, copia.original));
      }
      const sinAlias = copia.original !== original && copia.original.destino !== original.destino;
      const mismoOriginal = dominio.mismosOriginalesRespaldo(plan, copia.original, original);
      const nombre = copia.original.nombre === original.nombre;
      const mime = copia.original.mimeDeclarado === original.mimeDeclarado;
      const binding = p.reciboCorrespondeASolicitud(plan, s, recibo);
      Object.assign(original, { nombre: 'mutado', incorporada: 0 });
      return { signos, positivos, sinAlias, mismoOriginal, nombre, mime, binding,
        copiaEstable: Object.is(copia.original.incorporada, -0),
        bytesIguales: texto === textoRequest && texto === textoResponse
          && new TextDecoder().decode(new TextEncoder().encode(texto)) === texto };
    }, tipo);
    expect(r).toEqual({ signos: [true, true, true], positivos: [true, true, true], sinAlias: true,
      mismoOriginal: true, nombre: true, mime: true, binding: true, copiaEstable: true, bytesIguales: true });
  });
}

test('Chromium: duplicados escapados y corrupción no producen payload válido ni autoridad', async ({ page }) => {
  const r = await page.evaluate(async () => {
    const [p, { itinerario: plan }] = await Promise.all(['/protocolo.js', '/plan.js'].map((ruta) => import(ruta)));
    const fotoId = '12345678-1234-4123-8123-123456789abc';
    const s = { version: 1, tipo: 'solicitud-respaldo', viajeId: plan.id, fotoId,
      operacionId: '87654321-4321-4321-9321-cba987654321', original: { formato: 1, fotoId,
        destino: { tipo: 'parada', viajeId: plan.id, paradaId: plan.dias[0].paradas[0].id },
        nombre: 'n', mimeDeclarado: '', incorporada: -0, ultimaModificacion: -0, bytesOriginal: -0 } };
    const recibo = { ...s, tipo: 'acuse-respaldo', objetoOriginalDurable: true, metadatosDurables: true };
    const rechazos = [];
    for (const [valor, codificar, decodificar] of [
      [s, p.serializarSolicitudRespaldo, p.deserializarSolicitudRespaldo],
      [recibo, p.serializarReciboRespaldo, p.deserializarReciboRespaldo],
    ]) {
      const texto = codificar(plan, valor);
      for (const malo of [texto.replace('"version":1', '"version":1,"\\u0076ersion":1'),
        texto.replace('"formato":1', '"formato":1,"formato":1'),
        texto.replace('"paradaId":', '"paradaId":"otro","\\u0070aradaId":'),
        texto.slice(0, -1), texto + texto, '['.repeat(1000) + '0' + ']'.repeat(1000)]) {
        try { decodificar(plan, await new Response(malo).text()); rechazos.push(false); }
        catch { rechazos.push(true); }
      }
      // Response.text elimina el BOM UTF-8 por norma. El codec sólo puede rechazar
      // el BOM cuando aún forma parte del string recibido, no recuperar bytes perdidos.
      try { decodificar(plan, '\ufeff' + texto); rechazos.push(false); }
      catch { rechazos.push(true); }
      if (await new Response('\ufeff' + texto).text() !== texto) throw new Error('BOM nativo inesperado');
    }
    return { rechazos, positivo: p.deserializarReciboRespaldo(plan, p.serializarReciboRespaldo(plan, recibo)).metadatosDurables,
      stale: p.reciboCorrespondeASolicitud(plan, s, { ...recibo,
        operacionId: '11111111-1111-4111-8111-111111111111' }) };
  });
  expect(r).toEqual({ rechazos: Array(14).fill(true), positivo: true, stale: false });
});

test('Chromium: techo real de 64 KiB UTF-8 en ambos mensajes y control positivo al límite', async ({ page }) => {
  const r = await page.evaluate(async () => {
    const [p, { itinerario: plan }] = await Promise.all(['/protocolo.js', '/plan.js'].map((ruta) => import(ruta)));
    const fotoId = '12345678-1234-4123-8123-123456789abc';
    const s = { version: 1, tipo: 'solicitud-respaldo', viajeId: plan.id, fotoId,
      operacionId: '87654321-4321-4321-9321-cba987654321', original: { formato: 1, fotoId,
        destino: { tipo: 'parada', viajeId: plan.id, paradaId: plan.dias[0].paradas[0].id },
        nombre: '', mimeDeclarado: '', incorporada: -0, ultimaModificacion: -0, bytesOriginal: -0 } };
    const resultados = [];
    for (const [valor, codificar, decodificar] of [
      [s, p.serializarSolicitudRespaldo, p.deserializarSolicitudRespaldo],
      [{ ...s, tipo: 'acuse-respaldo', objetoOriginalDurable: true, metadatosDurables: true },
        p.serializarReciboRespaldo, p.deserializarReciboRespaldo],
    ]) {
      const espacio = p.MAX_BYTES_JSON_RESPALDO - new TextEncoder().encode(codificar(plan, valor)).byteLength;
      const nombre = '界'.repeat(Math.floor(espacio / 3)) + 'a'.repeat(espacio % 3);
      const limite = { ...valor, original: { ...valor.original, nombre } };
      const texto = codificar(plan, limite);
      const copia = decodificar(plan, await new Response(texto).text());
      let excesoEntrada = false; let excesoSalida = false;
      try { decodificar(plan, texto + ' '); } catch { excesoEntrada = true; }
      try { codificar(plan, { ...limite, original: { ...limite.original, nombre: nombre + '界' } }); }
      catch { excesoSalida = true; }
      resultados.push({ bytes: new TextEncoder().encode(texto).byteLength,
        nombreIgual: copia.original.nombre === nombre, excesoEntrada, excesoSalida });
    }
    return resultados;
  });
  expect(r).toEqual(Array(2).fill({ bytes: 65536, nombreIgual: true, excesoEntrada: true, excesoSalida: true }));
});
