/// <reference lib="dom" />
/// <reference lib="dom.iterable" />
// Integración mixta navegador/Node: tipos DOM sólo en el proyecto de pruebas, no en el servidor productivo.
import { readFile } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';
import { IDBFactory } from 'fake-indexeddb';
import { crearClienteListadoFotos } from '../../src/fotos-listado';
import { abrirFotosLocal } from '../../src/fotos-local';
import { abrirRespaldoFotosLocal } from '../../src/fotos-respaldo-local';
import { crearTransporteFotos } from '../../src/fotos-transporte';
import { abrirProgresoLocal } from '../../src/progreso-local';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import worker, { type EntornoWorker } from '../../servidor/worker';
import { itinerario as plan } from '../../src/datos/itinerario';
import { crearProgreso } from '../../src/progreso';
import { serializarProgreso } from '../../src/progreso-json';
import { serializarSolicitudRespaldo, serializarReciboRespaldo, type SolicitudRespaldo } from '../../src/fotos-protocolo';
import type { PresupuestoFotos } from '../../servidor/multipart-fotos';
import type { PaginaListadoFotos } from '../../src/fotos-listado-protocolo';
import type { VinculoR2Fotos } from '../../servidor/objetos-r2';
import { crearComposicionFotos } from '../../servidor/composicion-fotos';
import { crearEjecutorNeon } from '../../servidor/ejecutor-neon';
import { clavePrivadaFotos } from '../../servidor/almacen-fotos';
import { calcularCotasListadoFotos } from '../../servidor/repositorio-listado-fotos';

const origen = 'https://piloto.example';
const clave = 'clave-sintetica-exclusivamente-local-123456';
const dsn = 'postgresql://viajero:clave-sintetica@ep-piloto-test.eu-central-1.aws.neon.tech/viaje?sslmode=require';
// Sólo presupuesto de fixture; no recomendación para producción ni límite de heap global.
const presupuesto: PresupuestoFotos = { maxBytesOriginal: 2000000, maxBytesEntrada: 2200000,
  maxBytesChunk: 65536, maxBytesCabeceras: 1024, maxBytesRetenidos: 8000000,
  maxBloquesOriginal: 100, bytesBloque: 65536, plazoMs: 10000 };
const presupuestoListado = { maxFilas: 1, maxOperacionesPorFoto: 64,
  maxBytesSql: 5 * 1024 ** 2, maxBytesRespuesta: 512 * 1024, maxBytesRetenidos: 64 * 1024 ** 2, plazoMs: 1000 };
const base: SolicitudRespaldo = { version: 1, tipo: 'solicitud-respaldo', viajeId: plan.id,
  fotoId: 'ABCDEF12-1234-4123-8123-123456789ABD', operacionId: 'ABCDEF12-1234-4123-8123-123456789ABC',
  original: { formato: 1, fotoId: 'ABCDEF12-1234-4123-8123-123456789ABD',
    destino: { tipo: 'parada', viajeId: plan.id, paradaId: plan.dias[0].paradas[0].id },
    nombre: '\0 e\u0301 ', mimeDeclarado: 'IMAGE/HEIC\0', incorporada: -0, ultimaModificacion: -0, bytesOriginal: 3 } };
const consultas = new Map([
  ['admitir_intento', 2], ['crear_sesion', 7], ['leer_sesion', 2], ['revocar_sesion', 2],
  ['listar_sesiones', 2], ['revocar_otra_sesion', 3], ['consultar_progreso', 3], ['confirmar_progreso', 4],
  ['reservar_foto', 8], ['finalizar_foto', 10], ['consultar_foto', 3], ['listar_fotos_confirmadas', 7],
].map(([nombre, cantidad]) => {
  const n = Number(cantidad);
  return [`SELECT itinerario.${nombre}(${Array.from({ length: n }, (_, i) => `$${i + 1}`).join(', ')}) AS resultado`, n];
}));
let db: PGlite;

/** Modelo condicional local de R2, sin SDK/proveedor. Blob y streams nativos; nunca GC. */
class BucketLocal implements VinculoR2Fotos {
  readonly objetos = new Map<string, Blob>();
  readonly eventos: string[] = [];
  antesPut?: () => Promise<void>;
  antesGet?: () => Promise<void>;
  alEof?: () => Promise<void>;
  alterar?: (b: Uint8Array<ArrayBuffer>) => Uint8Array<ArrayBuffer>;
  ausente = false;
  perdidaPut = false;
  rechazoPut: 'null' | '429' | undefined;
  errorStream = false;
  async put(k: string, b: Blob, opciones: Parameters<VinculoR2Fotos['put']>[2]) {
    this.eventos.push('put');
    await this.antesPut?.();
    expect(opciones.onlyIf.get('If-None-Match')).toBe('*');
    expect(opciones.httpMetadata).toEqual({ contentType: 'application/octet-stream' });
    if (this.rechazoPut === '429') throw new Error('429 detalle privado');
    if (this.rechazoPut === 'null' || this.objetos.has(k)) return null;
    this.objetos.set(k, b);
    if (this.perdidaPut) throw new Error('PUT persistió, respuesta perdida');
    return { key: k, size: b.size };
  }
  async get(k: string) {
    this.eventos.push('get'); await this.antesGet?.();
    const b = this.objetos.get(k); if (!b || this.ausente) return null;
    const salida = this.alterar ? new Blob([this.alterar(new Uint8Array(await b.arrayBuffer()))]) : b;
    const lector = salida.stream().getReader(); const bucket = this;
    let pendiente: Uint8Array | null = null; let posicion = 0;
    const body = new ReadableStream<Uint8Array>({ async pull(c) {
      if (bucket.errorStream) { c.error(new Error('stream privado roto')); return; }
      if (!pendiente || posicion === pendiente.length) {
        const r = await lector.read();
        if (r.done) { await bucket.alEof?.(); lector.releaseLock(); c.close(); return; }
        pendiente = r.value; posicion = 0;
      }
      const chunk = pendiente;
      if (!chunk) throw new Error('Modelo R2 sin chunk.');
      const fin = Math.min(posicion + 65536, chunk.length);
      c.enqueue(chunk.subarray(posicion, fin)); posicion = fin;
    }, async cancel() { await lector.cancel(); lector.releaseLock(); } }, { highWaterMark: 0 });
    return { key: k, size: b.size, bodyUsed: false, body };
  }
}
function preparar() {
  const bucket = new BucketLocal();
  const assets = { fetch: vi.fn(async () => new Response('recurso privado')) };
  const entorno = { CLAVE_COMPARTIDA: clave, URL_BASE_DATOS: dsn, ASSETS: assets,
    FOTOS_ORIGEN: origen, FOTOS_PRESUPUESTO: { ...presupuesto }, FOTOS_BUCKET: bucket };
  const llamadas: { query: string; params: (string | null)[] }[] = [];
  const hooks: { antes?: (q: string) => Promise<void>; despues?: (q: string) => Promise<void> } = {};
  // El SDK real serializa parámetros. TODOS sus fetch terminan en SQL local real.
  const transporte = vi.fn(async (destino: unknown, opciones?: RequestInit) => {
    expect(String(destino)).toBe('https://api.eu-central-1.aws.neon.tech/sql');
    expect(opciones?.method).toBe('POST');
    const entrada = JSON.parse(String(opciones?.body)) as { query: string; params: (string | null)[] };
    expect(Object.keys(entrada).sort()).toEqual(['params', 'query']);
    expect(consultas.has(entrada.query)).toBe(true);
    expect(entrada.params).toHaveLength(consultas.get(entrada.query)!);
    expect(entrada.params.every((p) => p === null || typeof p === 'string')).toBe(true);
    llamadas.push(entrada);
    await hooks.antes?.(entrada.query);
    const r = await db.query<{ resultado: string }>(entrada.query, entrada.params);
    await hooks.despues?.(entrada.query);
    return new Response(JSON.stringify({ command: 'SELECT', rowCount: r.rows.length,
      fields: [{ name: 'resultado', dataTypeID: 25, tableID: 0, columnID: 0,
        dataTypeSize: -1, dataTypeModifier: -1, format: 'text' }], rows: r.rows.map((fila) => [String(fila.resultado)]) }));
  });
  vi.stubGlobal('fetch', transporte);
  return { bucket, assets, entorno, llamadas, transporte, hooks };
}
function req(ruta: string, opciones?: RequestInit) { return new Request(origen + ruta, opciones); }
async function iniciar(entorno: EntornoWorker, dispositivoId = 'editor-local') {
  const r = await worker.fetch(req('/api/sesion', { method: 'POST', headers: { Origin: origen,
    'Content-Type': 'application/json', 'CF-Connecting-IP': '203.0.113.9' },
  body: JSON.stringify({ clave, dispositivoId }) }), entorno);
  expect(r.status).toBe(201);
  expect(r.headers.get('Set-Cookie')).toContain('Secure; HttpOnly; SameSite=Lax');
  return r.headers.get('Set-Cookie')!.split(';', 1)[0];
}
/** Refragmentación lazy de multipart Node; no reescribe Origin ni simula segmentación TCP. */
function post(cookie: string, s = base, datos: Uint8Array<ArrayBuffer> = new Uint8Array([1, 2, 3])) {
  const form = new FormData(); form.append('solicitud', serializarSolicitudRespaldo(plan, s));
  form.append('original', new Blob([datos], { type: 'application/octet-stream' }), 'original');
  const nativa = req('/api/fotos/respaldo', { method: 'POST', headers: { Origin: origen, Cookie: cookie }, body: form });
  const lector = nativa.body!.getReader(); let pendiente: Uint8Array | null = null; let posicion = 0; let lecturas = 0;
  const body = new ReadableStream<Uint8Array>({ async pull(c) {
    lecturas++;
    if (!pendiente || posicion === pendiente.length) {
      const r = await lector.read();
      if (r.done) { lector.releaseLock(); c.close(); return; }
      pendiente = r.value; posicion = 0;
    }
    const chunk = pendiente;
    if (!chunk) throw new Error('Transporte multipart local sin chunk.');
    const fin = Math.min(posicion + 65536, chunk.length);
    c.enqueue(chunk.subarray(posicion, fin)); posicion = fin;
  }, async cancel() { await lector.cancel(); lector.releaseLock(); } }, { highWaterMark: 0 });
  return { solicitud: new Request(nativa.url, { method: 'POST', headers: nativa.headers, body,
    duplex: 'half' } as RequestInit), lecturas: () => lecturas };
}
function barrera() {
  let liberar!: () => void;
  const espera = new Promise<void>((r) => { liberar = r; });
  return { espera, liberar };
}
async function filas(tabla: string) {
  const permitidas = ['viajes', 'sesiones', 'decisiones', 'intentos_sesion', 'fotos_reservas', 'fotos_operaciones'];
  expect(permitidas).toContain(tabla);
  return (await db.query(`SELECT * FROM itinerario.${tabla} ORDER BY 1,2`)).rows;
}
async function snapshot(bucket: BucketLocal) {
  const sql = Object.fromEntries(await Promise.all(['viajes', 'sesiones', 'decisiones', 'intentos_sesion',
    'fotos_reservas', 'fotos_operaciones'].map(async (t) => [t, await filas(t)])));
  const objetos = await Promise.all([...bucket.objetos].map(async ([k, b]) => [k, Buffer.from(await b.arrayBuffer()).toString('base64')]));
  return { sql, objetos };
}
function fotosSql(f: ReturnType<typeof preparar>, nombre?: string) {
  return f.llamadas.filter((q) => nombre ? q.query.includes(nombre) : /(?:reservar|finalizar|consultar)_foto/.test(q.query));
}
async function errorPrivado(r: Response, estado: number, pragma = false) {
  expect(r.status).toBe(estado);
  expect(r.headers.get('Cache-Control')).toBe('private, no-store');
  expect(r.headers.get('Vary')).toBe('Cookie');
  expect(r.headers.get('X-Content-Type-Options')).toBe('nosniff');
  if (pragma) expect(r.headers.get('Pragma')).toBe('no-cache');
  expect(r.headers.get('Set-Cookie')).toBeNull();
  const texto = await r.text();
  expect(texto).toMatch(/^\{"error":"(?:No se pudo completar la solicitud de fotos\.|No se puede atender la solicitud ahora\.|Ruta no encontrada\.)"\}$/);
  for (const privado of [dsn, clave, 'stack', 'clave_objeto', base.original.nombre, 'IMAGE/HEIC']) expect(texto).not.toContain(privado);
}
function acuse(s = base) {
  return serializarReciboRespaldo(plan, { ...s, tipo: 'acuse-respaldo', objetoOriginalDurable: true, metadatosDurables: true });
}

beforeAll(async () => {
  db = await PGlite.create('memory://');
  for (const n of ['001_base.sql', '002_progreso.sql', '003_sesiones.sql', '004_limite.sql', '005_fotos.sql', '006_listado_fotos.sql']) {
    await db.exec(await readFile(new URL('../../servidor/migraciones/' + n, import.meta.url), 'utf8'));
  }
  await db.query('INSERT INTO itinerario.viajes VALUES ($1,0,$2)', [plan.id, serializarProgreso(crearProgreso(plan))]);
}, 30000);
beforeEach(async () => { await db.exec('BEGIN'); });
afterEach(async () => { await db.exec('ROLLBACK'); vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });
afterAll(async () => { await db?.close(); });

describe('Fotos Worker real + SDK real + SQL001–006 local; cookie reenviada en Node', () => {
  it('Cliente manual descubre INITIAL confirmado del otro editor sin MUTAR SQL,R2 ni estado local', async () => {
    const f = preparar(); const uno = await iniciar(f.entorno, 'uno'); const dos = await iniciar(f.entorno, 'dos');
    expect((await worker.fetch(post(uno).solicitud, f.entorno)).status).toBe(201);
    const fabrica = new IDBFactory();
    const fotos = await abrirFotosLocal(plan, { fabrica });
    const ledger = await abrirRespaldoFotosLocal(plan, fotos, { fabrica });
    const progreso = await abrirProgresoLocal(plan, { fabrica, dispositivoId: 'local' });
    const fotoId = 'CBCDEF12-1234-4123-8123-123456789ABD';
    const captura = { metadatos: { ...base.original, fotoId, mimeDeclarado: 'image/png',
      miniatura: { tipo: 'pendiente' as const } }, original: new Blob([new Uint8Array([1, 2, 3])], { type: 'image/png' }) };
    await fotos.guardarOriginal(captura);
    const referencia = await ledger.preparar(captura, 'CBCDEF12-1234-4123-8123-123456789ABC');
    expect(referencia.fase).toBe('preparado');
    await ledger.marcarEnviada({ fotoId: referencia.fotoId, operacionId: referencia.operacionId,
      original: referencia.original });
    await progreso.registrar({ id: 'intencion-listado', dispositivoId: 'local', tipo: 'parada',
      paradaId: plan.dias[0].paradas[0].id, marca: 'hecha', revision: 0, horaReal: -0 });
    const localAntes = { fotos: await fotos.listar(), ledger: await ledger.listar(), progreso: await progreso.leer(),
      bytes: [...new Uint8Array(await (await fotos.leerOriginal(fotoId))!.arrayBuffer())] };
    const antes = await snapshot(f.bucket);
    const entorno = { ...f.entorno, FOTOS_LISTADO_PRESUPUESTO: { ...presupuestoListado } };
    let llamadas = 0;
    const c = crearClienteListadoFotos({ plan, origen, presupuesto: { maxFilas: 1, maxBytesPagina: 404231,
      maxBytesChunk: 4194304, maxBytesBackingChunk: 4194304, maxLecturas: 65536, maxBytesPlan: 4194304,
      maxBytesRetenidos: 512 * 1024 ** 2, plazoMs: 10000 }, http: { async fetch(entrada, opciones) {
      llamadas++; const r = new Request(entrada, opciones); r.headers.set('Cookie', dos);
      const salida = await worker.fetch(r, entorno);
      expect(salida.headers.get('Set-Cookie')).toBeNull(); return salida;
    } } });
    f.llamadas.length = 0; f.bucket.eventos.length = 0;
    try {
      expect(llamadas).toBe(0);
      const resultado = await c.listar(null);
      expect(resultado).toEqual({ tipo: 'pagina', pagina: { version: 1, tipo: 'listado-respaldos', viajeId: plan.id,
        solicitudesIniciales: [serializarSolicitudRespaldo(plan, base)], continuacion: null } });
      expect(llamadas).toBe(1);
      expect(f.llamadas.filter((q) => q.query.includes('listar_fotos_confirmadas'))).toHaveLength(1);
      expect(f.llamadas.filter((q) => q.query.includes('leer_sesion'))).toHaveLength(2);
      expect(f.llamadas).toHaveLength(3); expect(f.bucket.eventos).toEqual([]);
      expect(await snapshot(f.bucket)).toEqual(antes);
      expect({ fotos: await fotos.listar(), ledger: await ledger.listar(), progreso: await progreso.leer(),
        bytes: [...new Uint8Array(await (await fotos.leerOriginal(fotoId))!.arrayBuffer())] }).toEqual(localAntes);
      expect(await fotos.leerMetadatos(base.fotoId)).toBeNull();
    } finally { c.cerrar(); progreso.cerrar(); ledger.cerrar(); fotos.cerrar(); }
  });
  it.each(['reserva-respuesta-perdida', 'put-persistido-respuesta-perdida',
    'final-persistido-respuesta-perdida', 'put-rechazado-modelado'] as const)
    ('acción manual real conserva original/SENT e incertidumbre: %s en modelo local', async (modo) => {
      const f = preparar();
      const uno = await iniciar(f.entorno, 'uno'); const dos = await iniciar(f.entorno, 'dos');
      const fabrica = new IDBFactory();
      let fotos = await abrirFotosLocal(plan, { fabrica });
      let ledger = await abrirRespaldoFotosLocal(plan, fotos, { fabrica });
      const captura = { metadatos: { ...base.original, mimeDeclarado: 'image/png',
        miniatura: { tipo: 'pendiente' as const } },
      original: new Blob([new Uint8Array([1, 2, 3])], { type: 'image/png' }) };
      let cookie = uno; let solicitudes = 0;
      const estadosHttp: number[] = []; const orden: string[] = [];
      let perderSql = true; let perderPut = true;
      f.hooks.despues = async (q) => {
        if (q.includes('leer_sesion')) orden.push('sesion');
        if (q.includes('finalizar_foto')) orden.push('final');
        if (perderSql && q.includes(modo === 'reserva-respuesta-perdida' ? 'reservar_foto'
          : modo === 'final-persistido-respuesta-perdida' ? 'finalizar_foto' : 'ninguna-consulta')) {
          perderSql = false;
          throw new Error('Entrega SDK perdida después del SQL local, no COMMIT físico');
        }
      };
      if (modo === 'put-persistido-respuesta-perdida') {
        const putOriginal = f.bucket.put;
        f.bucket.put = async (...args) => {
          const resultado = await Reflect.apply(putOriginal, f.bucket, args);
          if (perderPut) { perderPut = false; throw new Error('Respuesta PUT perdida en modelo R2'); }
          return resultado;
        };
      }
      if (modo === 'put-rechazado-modelado') f.bucket.rechazoPut = '429';
      f.bucket.alEof = async () => { orden.push('eof'); };
      const abrirTransporte = () => crearTransporteFotos({ plan, origen, fuente: fotos, ledger,
        maxBytesOriginal: 2000000, fetch: async (entrada, opciones) => {
          // Lectura durable ANTES del primer HTTP, también en el reintento explícito.
          const enviada = await ledger.leer(base.fotoId);
          expect(enviada).toMatchObject({ fotoId: base.fotoId, operacionId: base.operacionId,
            fase: 'enviada', enviada: true, pausada: false, recibo: null });
          expect(enviada?.original).toEqual(referencia.original);
          const r = new Request(entrada, opciones);
          expect(r.method).toBe('POST'); expect(r.url).toBe(origen + '/api/fotos/respaldo');
          expect(r.headers.get('Content-Type')).toMatch(/^multipart\/form-data; boundary=/);
          r.headers.set('Origin', origen); r.headers.set('Cookie', cookie);
          solicitudes++;
          const salida = await worker.fetch(r, f.entorno);
          estadosHttp.push(salida.status); return salida;
        } });
      const local = async () => ({ fotos: await fotos.listar(), ledger: await ledger.listar(),
        miniatura: await fotos.leerMiniatura(base.fotoId),
        bytes: [...new Uint8Array(await (await fotos.leerOriginal(base.fotoId))!.arrayBuffer())] });
      await fotos.guardarOriginal(captura);
      const preparada = await ledger.preparar(captura, base.operacionId);
      // EntradaRespaldo tiene campos adicionales: el transporte exige sólo estos tres.
      const referencia = { fotoId: preparada.fotoId, operacionId: preparada.operacionId,
        original: preparada.original };
      const solicitud: SolicitudRespaldo = { version: 1, tipo: 'solicitud-respaldo', viajeId: plan.id,
        ...referencia };
      let transporte = abrirTransporte();
      const antes = await snapshot(f.bucket); const originalAntes = await local();
      try {
        expect(solicitudes).toBe(0); expect(preparada.fase).toBe('preparado');
        await expect(transporte.subir(referencia)).rejects.toMatchObject({
          name: 'ErrorTransporteFotos', estado: 'incierta' });
        expect(estadosHttp).toEqual([503]); expect(solicitudes).toBe(1);
        const incierta = await snapshot(f.bucket); const localIncierto = await local();
        expect(incierta.sql.fotos_reservas).toHaveLength(1);
        expect(incierta.sql.fotos_operaciones).toHaveLength(1);
        const objetoPersistido = modo === 'put-persistido-respuesta-perdida'
          || modo === 'final-persistido-respuesta-perdida';
        expect(incierta.objetos).toHaveLength(objetoPersistido ? 1 : 0);
        if (objetoPersistido) {
          const marco = Buffer.from(incierta.objetos[0][1], 'base64');
          const longitud = new DataView(marco.buffer, marco.byteOffset).getUint32(8, false);
          expect(new TextDecoder().decode(marco.subarray(12, 12 + longitud)))
            .toBe(serializarSolicitudRespaldo(plan, solicitud));
          expect([...marco.subarray(12 + longitud)]).toEqual(originalAntes.bytes);
        }
        expect(incierta.sql.fotos_reservas).toEqual([expect.objectContaining({
          solicitud_canonica: serializarSolicitudRespaldo(plan, solicitud) })]);
        expect(incierta.sql.fotos_operaciones).toEqual([expect.objectContaining({
          recibo_canonico: modo === 'final-persistido-respuesta-perdida' ? acuse(solicitud) : null })]);
        for (const t of ['viajes', 'sesiones', 'decisiones', 'intentos_sesion'])
          expect(incierta.sql[t]).toEqual(antes.sql[t]);
        expect(localIncierto.fotos).toEqual(originalAntes.fotos);
        expect(localIncierto.bytes).toEqual([1, 2, 3]); expect(localIncierto.miniatura).toBeNull();
        expect(localIncierto.ledger).toEqual([{ ...preparada, fase: 'enviada', enviada: true }]);
        expect(Object.is(localIncierto.ledger[0].original.incorporada, -0)).toBe(true);
        expect(Object.is(localIncierto.ledger[0].original.ultimaModificacion, -0)).toBe(true);
        // Reabrir las mismas bases no regenera UUID, borra historia ni inicia red.
        transporte.cerrar(); ledger.cerrar(); fotos.cerrar();
        fotos = await abrirFotosLocal(plan, { fabrica });
        ledger = await abrirRespaldoFotosLocal(plan, fotos, { fabrica });
        expect(await local()).toEqual(localIncierto); expect(solicitudes).toBe(1);
        cookie = dos; transporte = abrirTransporte();
        const llamadasAntes = f.llamadas.length; const eventosAntes = f.bucket.eventos.length;
        orden.length = 0;
        const recuperable = modo === 'put-persistido-respuesta-perdida'
          || modo === 'final-persistido-respuesta-perdida';
        if (recuperable) {
          const confirmada = await transporte.reintentar(referencia);
          expect(confirmada).toMatchObject({ ...referencia, fase: 'respaldada', enviada: true,
            recibo: { ...solicitud, tipo: 'acuse-respaldo', objetoOriginalDurable: true, metadatosDurables: true } });
          // EOF íntegro precede a autenticación DB fresca y finalización; no ACK por GET solo.
          expect(orden).toEqual(['sesion', 'eof', 'sesion', 'final']);
        } else {
          await expect(transporte.reintentar(referencia)).rejects.toMatchObject({
            name: 'ErrorTransporteFotos', estado: 'incierta' });
          expect(await local()).toEqual(localIncierto);
          expect(orden).toEqual(['sesion']);
        }
        expect(estadosHttp).toEqual([503, recuperable ? 200 : 503]); expect(solicitudes).toBe(2);
        expect(f.bucket.eventos.slice(eventosAntes)).toEqual(['get']);
        expect(f.bucket.eventos.filter((e) => e === 'put')).toHaveLength(
          modo === 'reserva-respuesta-perdida' ? 0 : 1);
        const consultasRetry = f.llamadas.slice(llamadasAntes);
        expect(consultasRetry.filter((q) => q.query.includes('reservar_foto'))).toHaveLength(1);
        expect(consultasRetry.filter((q) => q.query.includes('finalizar_foto'))).toHaveLength(recuperable ? 1 : 0);
        const final = await snapshot(f.bucket);
        expect(final.objetos).toEqual(incierta.objetos);
        expect(final.sql.fotos_reservas).toEqual(incierta.sql.fotos_reservas);
        expect(final.sql.fotos_operaciones).toHaveLength(1);
        if (!recuperable || modo === 'final-persistido-respuesta-perdida') expect(final).toEqual(incierta);
        else expect(final.sql.fotos_operaciones).toEqual([expect.objectContaining({ recibo_canonico: acuse(solicitud) })]);
        for (const t of ['viajes', 'sesiones', 'decisiones', 'intentos_sesion']) expect(final.sql[t]).toEqual(antes.sql[t]);
        const localFinal = await local();
        expect(localFinal.fotos).toEqual(originalAntes.fotos); expect(localFinal.bytes).toEqual(originalAntes.bytes);
        transporte.cerrar(); ledger.cerrar(); fotos.cerrar();
        fotos = await abrirFotosLocal(plan, { fabrica }); ledger = await abrirRespaldoFotosLocal(plan, fotos, { fabrica });
        expect(await local()).toEqual(localFinal); expect(solicitudes).toBe(2);
        // Snapshots del modelo ANTES del ROLLBACK exterior; no prueba de persistencia física.
      } finally { transporte.cerrar(); ledger.cerrar(); fotos.cerrar(); }
    });

  it('lista INITIAL exacto tras login HMAC y respaldo 201 sin cambiar SQL ni R2', async () => {
    const f = preparar(); const cookie = await iniciar(f.entorno);
    expect((await worker.fetch(post(cookie).solicitud, f.entorno)).status).toBe(201);
    const entorno = { ...f.entorno, FOTOS_LISTADO_PRESUPUESTO: { ...presupuestoListado } };
    const antes = await snapshot(f.bucket); f.llamadas.length = 0; f.bucket.eventos.length = 0;
    const r = await worker.fetch(req('/api/fotos/listado', { headers: { Cookie: cookie } }), entorno);
    expect(r.status).toBe(200);
    expect(await r.text()).toBe('{"version":1,"tipo":"listado-respaldos","viajeId":' + JSON.stringify(plan.id)
      + ',"solicitudesIniciales":[' + JSON.stringify(serializarSolicitudRespaldo(plan, base)) + '],"continuacion":null}');
    expect(f.llamadas.filter((q) => q.query.includes('listar_fotos_confirmadas'))).toHaveLength(1);
    expect(f.llamadas.filter((q) => q.query.includes('leer_sesion'))).toHaveLength(2);
    expect(fotosSql(f)).toEqual([]); expect(f.bucket.eventos).toEqual([]);
    expect(await snapshot(f.bucket)).toEqual(antes);
  });
  it('listado por dos editores, página manual N1, vacío y todos los datos intactos', async () => {
    const f = preparar(); const cookie = await iniciar(f.entorno, 'uno'); const otro = await iniciar(f.entorno, 'dos');
    const entorno = { ...f.entorno, FOTOS_LISTADO_PRESUPUESTO: { ...presupuestoListado } };
    const vacio = await worker.fetch(req('/api/fotos/listado', { headers: { Cookie: cookie } }), entorno);
    expect(vacio.status).toBe(200); expect((await vacio.json() as PaginaListadoFotos).solicitudesIniciales).toEqual([]);
    const segundaId = 'BBCDEF12-1234-4123-8123-123456789ABD';
    const segunda = { ...base, fotoId: segundaId, operacionId: 'BBCDEF12-1234-4123-8123-123456789ABC',
      original: { ...base.original, fotoId: segundaId } };
    for (const s of [base, segunda]) expect((await worker.fetch(post(cookie, s).solicitud, f.entorno)).status).toBe(201);
    const antes = await snapshot(f.bucket); f.llamadas.length = 0; f.bucket.eventos.length = 0;
    const primera = await worker.fetch(req('/api/fotos/listado', { headers: { Cookie: otro } }), entorno);
    expect(primera.status).toBe(200); const pagina = await primera.json() as PaginaListadoFotos;
    expect(pagina.solicitudesIniciales).toEqual([serializarSolicitudRespaldo(plan, base)]);
    expect(typeof pagina.continuacion).toBe('string');
    const siguiente = await worker.fetch(req('/api/fotos/listado?continuacion=' + encodeURIComponent(pagina.continuacion!),
      { headers: { Cookie: cookie } }), entorno);
    expect(siguiente.status).toBe(200); expect(await siguiente.json()).toEqual({ version: 1, tipo: 'listado-respaldos',
      viajeId: plan.id, solicitudesIniciales: [serializarSolicitudRespaldo(plan, segunda)], continuacion: null });
    expect(f.llamadas.filter((q) => q.query.includes('listar_fotos_confirmadas'))).toHaveLength(2);
    expect(f.llamadas.filter((q) => q.query.includes('leer_sesion'))).toHaveLength(4);
    expect(f.bucket.eventos).toEqual([]); expect(fotosSql(f)).toEqual([]);
    expect(await snapshot(f.bucket)).toEqual(antes);
  });

  it.each(['revocada', 'caducada', 'cookie-otro'])('listado RETURN entregado tarde: %s niega página con auth DB fresca', async (modo) => {
    const f = preparar(); const cookie = await iniciar(f.entorno, 'uno'); const otro = await iniciar(f.entorno, 'dos');
    expect((await worker.fetch(post(cookie).solicitud, f.entorno)).status).toBe(201);
    const entorno = { ...f.entorno, FOTOS_LISTADO_PRESUPUESTO: { ...presupuestoListado } };
    const r = req('/api/fotos/listado', { headers: { Cookie: cookie } });
    const llegada = barrera(); const gate = barrera();
    f.llamadas.length = 0; f.bucket.eventos.length = 0;
    f.hooks.despues = async (q) => { if (q.includes('listar_fotos_confirmadas')) { llegada.liberar(); await gate.espera; } };
    const pendiente = worker.fetch(r, entorno); await llegada.espera;
    if (modo === 'revocada') await db.exec('UPDATE itinerario.sesiones SET revocada=true');
    if (modo === 'caducada') await db.exec('UPDATE itinerario.sesiones SET creada_en=0,vence_en=1');
    if (modo === 'cookie-otro') r.headers.set('Cookie', otro);
    const antes = await snapshot(f.bucket); gate.liberar(); await errorPrivado(await pendiente, 401, true);
    expect(f.llamadas.filter((q) => q.query.includes('leer_sesion'))).toHaveLength(2);
    expect(f.llamadas.filter((q) => q.query.includes('listar_fotos_confirmadas'))).toHaveLength(1);
    expect(f.bucket.eventos).toEqual([]); expect(fotosSql(f)).toEqual([]);
    expect(await snapshot(f.bucket)).toEqual(antes);
  });

  it.each(['ausente', 'malformada', 'revocada', 'caducada', 'otro-viaje'])('listado auth inicial %s antes de cursor inválido', async (modo) => {
    const f = preparar(); let cookie = await iniciar(f.entorno);
    const entorno = { ...f.entorno, FOTOS_LISTADO_PRESUPUESTO: { ...presupuestoListado } };
    if (modo === 'ausente') cookie = ''; if (modo === 'malformada') cookie = '__Host-itinerario=no-token';
    if (modo === 'revocada') await db.exec('UPDATE itinerario.sesiones SET revocada=true');
    if (modo === 'caducada') await db.exec('UPDATE itinerario.sesiones SET creada_en=0,vence_en=1');
    if (modo === 'otro-viaje') {
      await db.query('INSERT INTO itinerario.viajes VALUES ($1,0,$2)', ['otro', serializarProgreso(crearProgreso(plan))]);
      await db.exec("UPDATE itinerario.sesiones SET viaje_id='otro'");
    }
    f.llamadas.length = 0;
    await errorPrivado(await worker.fetch(req('/api/fotos/listado?continuacion=%FF', { headers: { Cookie: cookie } }), entorno), 401, true);
    expect(f.llamadas.filter((q) => q.query.includes('listar_fotos_confirmadas'))).toEqual([]);
    expect(f.bucket.eventos).toEqual([]);
  });

  it.each(['inicial', 'sql', 'fresca'])('listado aborto SDK pendiente en %s no continúa ni muta', async (paso) => {
    const f = preparar(); const cookie = await iniciar(f.entorno);
    const entorno = { ...f.entorno, FOTOS_LISTADO_PRESUPUESTO: { ...presupuestoListado } };
    const llegada = barrera(); const gate = barrera(); let auth = 0;
    f.llamadas.length = 0;
    f.hooks.despues = async (q) => {
      if (q.includes('leer_sesion')) auth++;
      if ((paso === 'sql' && q.includes('listar_fotos_confirmadas'))
        || (q.includes('leer_sesion') && auth === (paso === 'fresca' ? 2 : paso === 'inicial' ? 1 : -1))) {
        llegada.liberar(); await gate.espera;
      }
    };
    const ac = new AbortController(); const pendiente = worker.fetch(req('/api/fotos/listado',
      { headers: { Cookie: cookie }, signal: ac.signal }), entorno);
    await llegada.espera; ac.abort(); await errorPrivado(await pendiente, 503, true);
    const antes = await snapshot(f.bucket); gate.liberar();
    await Promise.allSettled(f.transporte.mock.results.map((r) => r.value));
    expect(f.llamadas.filter((q) => q.query.includes('listar_fotos_confirmadas'))).toHaveLength(paso === 'inicial' ? 0 : 1);
    expect(auth).toBe(paso === 'fresca' ? 2 : 1); expect(await snapshot(f.bucket)).toEqual(antes);
  });

  it.each(['inicial', 'sql', 'fresca'])('listado plazo SDK pendiente en %s ignora entrega tardía', async (paso) => {
    const f = preparar(); const cookie = await iniciar(f.entorno);
    const entorno = { ...f.entorno, FOTOS_LISTADO_PRESUPUESTO: { ...presupuestoListado, plazoMs: 20 } };
    const llegada = barrera(); const gate = barrera(); let auth = 0;
    f.llamadas.length = 0;
    f.hooks.despues = async (q) => {
      if (q.includes('leer_sesion')) auth++;
      if ((paso === 'sql' && q.includes('listar_fotos_confirmadas'))
        || (q.includes('leer_sesion') && auth === (paso === 'fresca' ? 2 : paso === 'inicial' ? 1 : -1))) {
        llegada.liberar(); await gate.espera;
      }
    };
    vi.useFakeTimers(); const pendiente = worker.fetch(req('/api/fotos/listado', { headers: { Cookie: cookie } }), entorno);
    await llegada.espera; await vi.advanceTimersByTimeAsync(20); await errorPrivado(await pendiente, 503, true);
    const antes = await snapshot(f.bucket); gate.liberar();
    await Promise.allSettled(f.transporte.mock.results.map((r) => r.value));
    expect(f.llamadas.filter((q) => q.query.includes('listar_fotos_confirmadas'))).toHaveLength(paso === 'inicial' ? 0 : 1);
    expect(auth).toBe(paso === 'fresca' ? 2 : 1); expect(await snapshot(f.bucket)).toEqual(antes);
  });

  it.each(['inicial', 'sql', 'fresca'])('listado infraestructura fallida %s no publica ni filtra causa', async (paso) => {
    const f = preparar(); const cookie = await iniciar(f.entorno); let auth = 0;
    const entorno = { ...f.entorno, FOTOS_LISTADO_PRESUPUESTO: { ...presupuestoListado } };
    f.llamadas.length = 0;
    f.hooks.antes = async (q) => {
      if (q.includes('leer_sesion')) auth++;
      if ((paso === 'sql' && q.includes('listar_fotos_confirmadas'))
        || (q.includes('leer_sesion') && auth === (paso === 'fresca' ? 2 : paso === 'inicial' ? 1 : -1)))
        throw new Error('Detalle privado infraestructura SQL');
    };
    await errorPrivado(await worker.fetch(req('/api/fotos/listado', { headers: { Cookie: cookie } }), entorno), 503, true);
    expect(f.bucket.eventos).toEqual([]); expect(fotosSql(f)).toEqual([]);
  });

  it('listado aislado no inspecciona bucket/presupuesto binario incluso accessors hostiles', async () => {
    const f = preparar(); const cookie = await iniciar(f.entorno);
    const entorno = { ...f.entorno, FOTOS_LISTADO_PRESUPUESTO: { ...presupuestoListado } };
    const getter = vi.fn(() => { throw new Error('R2 no debe inspeccionarse'); });
    for (const nombre of ['FOTOS_BUCKET', 'FOTOS_PRESUPUESTO']) Object.defineProperty(entorno, nombre, { get: getter });
    const r = await worker.fetch(req('/api/fotos/listado', { headers: { Cookie: cookie } }), entorno);
    expect(r.status).toBe(200); expect(getter).not.toHaveBeenCalled(); expect(f.bucket.eventos).toEqual([]);
  });

  it.each(['ausente', 'getter', 'parcial', 'retencion'])('config listado %s 503 sólo listado, no auth/lista/cuerpo', async (modo) => {
    const f = preparar(); const cookie = await iniciar(f.entorno); const getter = vi.fn();
    const entorno: EntornoWorker = { ...f.entorno, FOTOS_LISTADO_PRESUPUESTO: { ...presupuestoListado } };
    if (modo === 'ausente') delete entorno.FOTOS_LISTADO_PRESUPUESTO;
    if (modo === 'getter') Object.defineProperty(entorno, 'FOTOS_LISTADO_PRESUPUESTO', { get: getter });
    if (modo === 'parcial') delete (entorno.FOTOS_LISTADO_PRESUPUESTO as Partial<typeof presupuestoListado>).maxFilas;
    if (modo === 'retencion') entorno.FOTOS_LISTADO_PRESUPUESTO = { ...presupuestoListado, maxBytesRetenidos: 51431475 };
    f.llamadas.length = 0;
    await errorPrivado(await worker.fetch(req('/api/fotos/listado'), entorno), 503, true);
    expect(f.llamadas).toEqual([]); expect(getter).not.toHaveBeenCalled();
    expect((await worker.fetch(post(cookie).solicitud, entorno)).status).toBe(201);
    expect((await worker.fetch(req('/api/progreso', { headers: { Cookie: cookie } }), entorno)).status).toBe(200);
  });

  it('listingbudget accessor nunca leído en binarios/login/progreso/entrada/assets/unknown', async () => {
    const f = preparar(); const getter = vi.fn(() => { throw new Error('Campo de otra ruta'); });
    Object.defineProperty(f.entorno, 'FOTOS_LISTADO_PRESUPUESTO', { get: getter });
    const cookie = await iniciar(f.entorno);
    expect((await worker.fetch(post(cookie).solicitud, f.entorno)).status).toBe(201);
    for (const ruta of [`/api/fotos/${base.fotoId}/original`, '/api/progreso', '/', '/entrar'])
      expect((await worker.fetch(req(ruta, { headers: { Cookie: cookie } }), f.entorno)).status).toBe(200);
    expect((await worker.fetch(req('/api/fotos/listado/'), f.entorno)).status).toBe(404);
    expect(getter).not.toHaveBeenCalled();
  });

  it('listado captura origin/budget antes de digest credenciales y siguiente request recaptura', async () => {
    const f = preparar(); const cookie = await iniciar(f.entorno);
    const entorno = { ...f.entorno, FOTOS_LISTADO_PRESUPUESTO: { ...presupuestoListado } };
    const llegada = barrera(); const gate = barrera(); const digest = crypto.subtle.digest.bind(crypto.subtle);
    vi.spyOn(crypto.subtle, 'digest').mockImplementationOnce(async (...args) => {
      llegada.liberar(); await gate.espera; return digest(...args);
    });
    const pendiente = worker.fetch(req('/api/fotos/listado', { headers: { Cookie: cookie } }), entorno);
    await llegada.espera; entorno.FOTOS_ORIGEN = 'https://otra.example'; entorno.FOTOS_LISTADO_PRESUPUESTO.maxFilas = 0;
    gate.liberar(); expect((await pendiente).status).toBe(200);
    await errorPrivado(await worker.fetch(req('/api/fotos/listado', { headers: { Cookie: cookie } }), entorno), 503, true);
  });

  it('listado conserva seis tablas completas, viaje ajeno, historia cruda SQL y reserva incierta sin adoptarla', async () => {
    const f = preparar(); const cookie = await iniciar(f.entorno, 'uno'); const editor = await iniciar(f.entorno, 'dos');
    const op = { id: 'historia-propia', dispositivoId: 'uno', tipo: 'parada',
      paradaId: plan.dias[0].paradas[0].id, marca: 'hecha', revision: 0, horaReal: -0 };
    expect((await worker.fetch(req('/api/progreso', { method: 'POST', headers: { Cookie: cookie,
      Origin: origen, 'Content-Type': 'application/json' }, body: serializarProgreso(op) }), f.entorno)).status).toBe(200);
    expect((await worker.fetch(post(cookie).solicitud, f.entorno)).status).toBe(201);
    const pendienteId = 'DBCDEF12-1234-4123-8123-123456789ABD';
    const pendiente = { ...base, fotoId: pendienteId, operacionId: 'DBCDEF12-1234-4123-8123-123456789ABC',
      original: { ...base.original, fotoId: pendienteId } };
    f.hooks.despues = async (q) => { if (q.includes('reservar_foto')) throw new Error('Entrega perdida en fixture'); };
    await errorPrivado(await worker.fetch(post(cookie, pendiente).solicitud, f.entorno), 503);
    f.hooks.despues = undefined;
    const ajeno = { ...plan, id: 'viaje-ajeno-fixture' };
    await db.query('INSERT INTO itinerario.viajes VALUES ($1,0,$2)', [ajeno.id, serializarProgreso(crearProgreso(ajeno))]);
    // Esquema SQL admite JSON objeto opaco. No se presenta como DTO válido de
    // progreso/PhotoDB/legacy del cliente, ni se pide a la app migrarlo o repararlo.
    const raizCruda = '{"schemaAnterior":0,"nombre":"\\u0000e\\u0301","numero":-0}';
    const historiaCruda = '{"anterior":true,"texto":"\\u0000e\\u0301","hora":-0}';
    await db.query('INSERT INTO itinerario.viajes VALUES ($1,7,$2)', ['legado-sql-fixture', raizCruda]);
    await db.query('INSERT INTO itinerario.decisiones VALUES ($1,$2,$3,1,$4)',
      [ajeno.id, 'historia-ajena', 'positiva', historiaCruda]);
    await db.query('INSERT INTO itinerario.sesiones VALUES ($1,$2,$3,1,$4,false,$5)',
      ['fbcdef12-1234-4123-8123-123456789abc', 'f'.repeat(64), ajeno.id, Number.MAX_SAFE_INTEGER,
        '{"dispositivoId":"ajeno","nombreDispositivo":"e\\u0301"}']);
    await db.query('INSERT INTO itinerario.intentos_sesion VALUES ($1,1,3)', ['e'.repeat(64)]);
    const fotoId = 'EBCDEF12-1234-4123-8123-123456789ABD';
    const reservaId = 'FBCDEF12-1234-4123-8123-123456789ABD';
    const solicitudAjena = { ...base, viajeId: ajeno.id, fotoId, operacionId: '9BCDEF12-1234-4123-8123-123456789ABC',
      original: { ...base.original, fotoId, destino: { ...base.original.destino, viajeId: ajeno.id } } };
    const inicialAjeno = serializarSolicitudRespaldo(ajeno, solicitudAjena);
    const reciboAjeno = serializarReciboRespaldo(ajeno, { ...solicitudAjena, tipo: 'acuse-respaldo',
      objetoOriginalDurable: true, metadatosDurables: true });
    const claveAjena = clavePrivadaFotos(ajeno.id, fotoId, reservaId);
    await db.query('INSERT INTO itinerario.fotos_reservas VALUES ($1,$2,$3,$4,$5)',
      [ajeno.id, fotoId, reservaId, claveAjena, inicialAjeno]);
    await db.query('INSERT INTO itinerario.fotos_operaciones VALUES ($1,$2,$3,$4,$5,$6)',
      [ajeno.id, solicitudAjena.operacionId, fotoId, reservaId, inicialAjeno, reciboAjeno]);
    f.bucket.objetos.set(claveAjena, new Blob([new Uint8Array([0, 255, 3, 9])]));
    f.bucket.objetos.set('objeto-opaco-anterior-fixture', new Blob([new Uint8Array([7, 0, 8])]));
    const antes = await snapshot(f.bucket);
    for (const tabla of ['viajes', 'sesiones', 'decisiones', 'intentos_sesion', 'fotos_reservas', 'fotos_operaciones'])
      expect((antes.sql[tabla] as unknown[]).length).toBeGreaterThan(0);
    expect(antes.objetos.length).toBe(3);
    expect((antes.sql.fotos_operaciones as { recibo_canonico: unknown }[]).filter((r) => r.recibo_canonico === null)).toHaveLength(1);
    const entorno = { ...f.entorno, FOTOS_LISTADO_PRESUPUESTO: { ...presupuestoListado } };
    f.llamadas.length = 0; f.bucket.eventos.length = 0;
    const r = await worker.fetch(req('/api/fotos/listado', { headers: { Cookie: editor } }), entorno);
    expect(r.status).toBe(200); expect(await r.json()).toEqual({ version: 1, tipo: 'listado-respaldos', viajeId: plan.id,
      solicitudesIniciales: [serializarSolicitudRespaldo(plan, base)], continuacion: null });
    expect(f.llamadas.filter((q) => q.query.includes('listar_fotos_confirmadas'))).toHaveLength(1);
    expect(f.llamadas.filter((q) => q.query.includes('leer_sesion'))).toHaveLength(2);
    expect(fotosSql(f)).toEqual([]); expect(f.bucket.eventos).toEqual([]);
    expect(await snapshot(f.bucket)).toEqual(antes); // ANTES del ROLLBACK exterior.
  });

  it('INITIAL confirmable65486 y ACK65536 reales: página exacta bajo P cerrado, sin frame falso', async () => {
    const f = preparar(); const cookie = await iniciar(f.entorno);
    const sinNombre = { ...base, original: { ...base.original, nombre: '' } };
    const faltan = 65486 - new TextEncoder().encode(serializarSolicitudRespaldo(plan, sinNombre)).length;
    const s = { ...sinNombre, original: { ...sinNombre.original, nombre: 'x'.repeat(faltan) } };
    const inicial = serializarSolicitudRespaldo(plan, s);
    expect(new TextEncoder().encode(inicial).length).toBe(65486);
    expect(new TextEncoder().encode(acuse(s)).length).toBe(65536);
    const respaldo = await worker.fetch(post(cookie, s).solicitud, f.entorno);
    expect(respaldo.status).toBe(201); expect(await respaldo.text()).toBe(acuse(s));
    const antes = await snapshot(f.bucket); f.llamadas.length = 0; f.bucket.eventos.length = 0;
    const entorno = { ...f.entorno, FOTOS_LISTADO_PRESUPUESTO: { ...presupuestoListado } };
    const r = await worker.fetch(req('/api/fotos/listado', { headers: { Cookie: cookie } }), entorno);
    expect(r.status).toBe(200); const publico = await r.text();
    expect(publico).toBe('{"version":1,"tipo":"listado-respaldos","viajeId":' + JSON.stringify(plan.id)
      + ',"solicitudesIniciales":[' + JSON.stringify(inicial) + '],"continuacion":null}');
    expect(new TextEncoder().encode(publico).length).toBeLessThan(calcularCotasListadoFotos(1, 64).bytesRespuesta);
    expect(f.llamadas.filter((q) => q.query.includes('listar_fotos_confirmadas'))).toHaveLength(1);
    expect(f.llamadas.filter((q) => q.query.includes('leer_sesion'))).toHaveLength(2);
    expect(f.bucket.eventos).toEqual([]); expect(await snapshot(f.bucket)).toEqual(antes);
  });

  it('respalda con 201/acuse exacto y descarga privada de bytes íntegros', async () => {
    const f = preparar(); const cookie = await iniciar(f.entorno); const p = post(cookie);
    const r = await worker.fetch(p.solicitud, f.entorno);
    expect(r.status).toBe(201);
    expect(await r.text()).toBe(acuse());
    const original = await worker.fetch(req(`/api/fotos/${base.fotoId}/original`, { headers: { Cookie: cookie } }), f.entorno);
    expect(original.status).toBe(200);
    expect(original.headers.get('Cache-Control')).toBe('private, no-store');
    expect(new Uint8Array(await original.arrayBuffer())).toEqual(new Uint8Array([1, 2, 3]));
    expect(f.bucket.eventos).toEqual(['put', 'get', 'get']);
    expect(f.assets.fetch).not.toHaveBeenCalled();
  });

  it.each([0, 3, 1048581])('original nativo de %i bytes, dos editores iguales, retry y operación compatible inmutables', async (n) => {
    const f = preparar(); const uno = await iniciar(f.entorno, 'uno'); const dos = await iniciar(f.entorno, 'dos');
    const antes = await snapshot(f.bucket);
    const datos = new Uint8Array(n); if (n) datos[n - 1] = 127;
    const s = { ...base, original: { ...base.original, bytesOriginal: n } };
    const primero = await worker.fetch(post(uno, s, datos).solicitud, f.entorno);
    expect(primero.status).toBe(201); expect(await primero.text()).toBe(acuse(s));
    const inicial = await snapshot(f.bucket);
    expect(inicial.sql.viajes).toEqual(antes.sql.viajes);
    expect(inicial.sql.sesiones).toEqual(antes.sql.sesiones);
    expect(inicial.sql.decisiones).toEqual(antes.sql.decisiones);
    expect(inicial.sql.intentos_sesion).toEqual(antes.sql.intentos_sesion);
    const reservas = inicial.sql.fotos_reservas as { solicitud_canonica: string }[];
    expect(reservas[0].solicitud_canonica).toBe(serializarSolicitudRespaldo(plan, s));
    const bytes = Buffer.from(inicial.objetos[0][1], 'base64');
    const longitud = new DataView(bytes.buffer, bytes.byteOffset).getUint32(8, false);
    expect(new TextDecoder().decode(bytes.subarray(12, 12 + longitud))).toBe(serializarSolicitudRespaldo(plan, s));
    expect(bytes.subarray(12 + longitud).equals(Buffer.from(datos))).toBe(true);
    const repetido = await worker.fetch(post(dos, s, datos).solicitud, f.entorno);
    expect(repetido.status).toBe(200); expect(await repetido.text()).toBe(acuse(s));
    expect(await snapshot(f.bucket)).toEqual(inicial);
    const otra = { ...s, operacionId: 'BBCDEF12-1234-4123-8123-123456789ABC' };
    const compatible = await worker.fetch(post(dos, otra, datos).solicitud, f.entorno);
    expect(compatible.status).toBe(200); expect(await compatible.text()).toBe(acuse(otra));
    const final = await snapshot(f.bucket);
    expect(final.objetos).toEqual(inicial.objetos);
    expect(final.sql.fotos_reservas).toEqual(inicial.sql.fotos_reservas);
    expect(final.sql.fotos_operaciones).toHaveLength(2);
    expect(final.sql.fotos_operaciones).toEqual(expect.arrayContaining(inicial.sql.fotos_operaciones));
    for (const t of ['viajes', 'sesiones', 'decisiones', 'intentos_sesion']) expect(final.sql[t]).toEqual(antes.sql[t]);
    for (const cookie of [uno, dos]) {
      const r = await worker.fetch(req(`/api/fotos/${base.fotoId}/original`, { headers: { Cookie: cookie } }), f.entorno);
      expect(r.status).toBe(200); expect(r.headers.get('Content-Type')).toBe('application/octet-stream');
      expect(r.headers.get('Vary')).toBe('Cookie'); expect(r.headers.get('X-Content-Type-Options')).toBe('nosniff');
      expect(Buffer.from(await r.arrayBuffer()).equals(Buffer.from(datos))).toBe(true);
    }
    expect(f.bucket.eventos.filter((e) => e === 'put')).toHaveLength(1);
    expect(fotosSql(f, 'reservar_foto')).toHaveLength(3);
  });

  it.each(['ausente', 'malformada', 'revocada', 'caducada', 'otro-viaje'])('sesión %s antes del cuerpo, SQL fotos y R2', async (modo) => {
    const f = preparar(); let cookie = await iniciar(f.entorno);
    if (modo === 'ausente') cookie = '';
    if (modo === 'malformada') cookie = '__Host-itinerario=no-token';
    if (modo === 'revocada') await db.exec('UPDATE itinerario.sesiones SET revocada=true');
    if (modo === 'caducada') await db.exec('UPDATE itinerario.sesiones SET creada_en=0, vence_en=1');
    if (modo === 'otro-viaje') {
      await db.query('INSERT INTO itinerario.viajes VALUES ($1,0,$2)', ['otro', serializarProgreso(crearProgreso(plan))]);
      await db.exec("UPDATE itinerario.sesiones SET viaje_id='otro'");
    }
    const antes = await snapshot(f.bucket); const p = post(cookie);
    await errorPrivado(await worker.fetch(p.solicitud, f.entorno), 401);
    expect(p.lecturas()).toBe(0); expect(fotosSql(f)).toHaveLength(0); expect(f.bucket.eventos).toEqual([]);
    await errorPrivado(await worker.fetch(req(`/api/fotos/${base.fotoId}/original`, { headers: { Cookie: cookie } }), f.entorno),
      401);
    expect(await snapshot(f.bucket)).toEqual(antes);
  });

  it.each([undefined, origen + '/', 'null', 'https://otro.example'])('Origin %j no lee ni autentica', async (valor) => {
    const f = preparar(); const p = post('');
    if (valor === undefined) p.solicitud.headers.delete('Origin'); else p.solicitud.headers.set('Origin', valor);
    await errorPrivado(await worker.fetch(p.solicitud, f.entorno), 403);
    expect(p.lecturas()).toBe(0); expect(f.llamadas).toEqual([]); expect(f.bucket.eventos).toEqual([]);
  });

  it.each([
    ['/api/fotos/respaldo', 'GET', 405, 'POST'], ['/api/fotos/respaldo', 'PUT', 405, 'POST'],
    [`/api/fotos/${base.fotoId}/original`, 'POST', 405, 'GET'], ['/api/fotos/incorrecta/original', 'GET', 400, null],
    ['/api/fotos/%FF/original', 'GET', 400, null], ['/api/fotos/%2F/original', 'GET', 400, null],
    ['/api/fotos', 'GET', 404, null], ['/api/fotos/respaldo/', 'POST', 404, null],
    ['/api/fotos/a/b/original', 'GET', 404, null], ['/api/fotos/listado', 'GET', 503, null],
  ] as const)('ruta/método %s %s conserva %i', async (ruta, metodo, estado, allow) => {
    const f = preparar(); const r = await worker.fetch(req(ruta, { method: metodo }), f.entorno);
    expect(r.headers.get('Allow')).toBe(allow); await errorPrivado(r, estado);
    expect(f.llamadas).toEqual([]); expect(f.bucket.eventos).toEqual([]); expect(f.assets.fetch).not.toHaveBeenCalled();
  });

  it('GET confirmado ausente y caja distinta no adoptan fotos', async () => {
    const f = preparar(); const cookie = await iniciar(f.entorno);
    await errorPrivado(await worker.fetch(req(`/api/fotos/${base.fotoId}/original`, { headers: { Cookie: cookie } }), f.entorno), 404);
    expect((await worker.fetch(post(cookie).solicitud, f.entorno)).status).toBe(201);
    const antes = await snapshot(f.bucket);
    await errorPrivado(await worker.fetch(req(`/api/fotos/${base.fotoId.toLowerCase()}/original`, { headers: { Cookie: cookie } }), f.entorno), 404);
    expect(await snapshot(f.bucket)).toEqual(antes);
  });

  it.each(['FOTOS_ORIGEN', 'FOTOS_PRESUPUESTO', 'FOTOS_BUCKET'] as const)('configuración %s ausente o accessor aislada sin getter', async (campo) => {
    const f = preparar(); const cookie = await iniciar(f.entorno); const antes = await snapshot(f.bucket);
    const getters = vi.fn(() => { throw new Error('No ejecutar configuración'); });
    for (const accessor of [false, true]) {
      const entorno = { ...f.entorno }; delete (entorno as Partial<typeof entorno>)[campo];
      if (accessor) Object.defineProperty(entorno, campo, { get: getters });
      const p = post(cookie); await errorPrivado(await worker.fetch(p.solicitud, entorno), 503, true);
      expect(p.lecturas()).toBe(0);
      await errorPrivado(await worker.fetch(req(`/api/fotos/${base.fotoId}/original`, { headers: { Cookie: cookie } }), entorno), 503, true);
      expect((await worker.fetch(req('/entrar'), entorno)).status).toBe(200);
      expect((await worker.fetch(req('/', { headers: { Cookie: cookie } }), entorno)).status).toBe(200);
      expect((await worker.fetch(req('/api/progreso', { headers: { Cookie: cookie } }), entorno)).status).toBe(200);
    }
    expect(getters).not.toHaveBeenCalled(); expect(fotosSql(f)).toEqual([]); expect(f.bucket.eventos).toEqual([]);
    expect(await snapshot(f.bucket)).toEqual(antes);
  });

  it.each(['http://piloto.example', origen + '/', '', 'https://user@piloto.example', '{}'])('origen de configuración inválido %s', async (valor) => {
    const f = preparar(); f.entorno.FOTOS_ORIGEN = valor; const p = post('');
    await errorPrivado(await worker.fetch(p.solicitud, f.entorno), 503, true);
    expect(p.lecturas()).toBe(0); expect(f.llamadas).toEqual([]); expect(f.bucket.eventos).toEqual([]);
  });

  it.each([
    { maxBytesOriginal: Infinity }, { maxBytesOriginal: Number.MAX_SAFE_INTEGER + 1 }, { maxBytesEntrada: -1 },
    { bytesBloque: 0 }, { plazoMs: 0 }, { plazoMs: 2147483648 }, { desconocido: 1 },
  ])('presupuesto inválido %j rechaza configuración sin admisión', async (cambio) => {
    const f = preparar(); Object.assign(f.entorno.FOTOS_PRESUPUESTO, cambio); const p = post('');
    await errorPrivado(await worker.fetch(p.solicitud, f.entorno), 503, true);
    expect(p.lecturas()).toBe(0); expect(f.llamadas).toEqual([]); expect(f.bucket.eventos).toEqual([]);
  });

  it('accessors anidados del presupuesto/bucket jamás ejecutan código', async () => {
    const f = preparar(); const getter = vi.fn(() => { throw new Error('getter privado'); });
    Object.defineProperty(f.entorno.FOTOS_PRESUPUESTO, 'maxBytesOriginal', { get: getter });
    await errorPrivado(await worker.fetch(post('').solicitud, f.entorno), 503, true);
    f.entorno.FOTOS_PRESUPUESTO = { ...presupuesto };
    Object.defineProperty(f.bucket, 'get', { get: getter });
    await errorPrivado(await worker.fetch(post('').solicitud, f.entorno), 503, true);
    expect(getter).not.toHaveBeenCalled(); expect(f.llamadas).toEqual([]);
  });

  it.each([{ maxBytesOriginal: 0 }, { maxBytesEntrada: 0 }, { maxBytesChunk: 0 },
    { maxBytesRetenidos: 0 }, { maxBloquesOriginal: 0 }])('cero %j no es ilimitado y no reserva', async (cambio) => {
    const f = preparar(); const cookie = await iniciar(f.entorno); const antes = await snapshot(f.bucket);
    Object.assign(f.entorno.FOTOS_PRESUPUESTO, cambio);
    await errorPrivado(await worker.fetch(post(cookie).solicitud, f.entorno), 413);
    expect(fotosSql(f)).toEqual([]); expect(f.bucket.eventos).toEqual([]); expect(await snapshot(f.bucket)).toEqual(antes);
  });

  it.each([{ maxBytesChunk: 0 }, { maxBytesRetenidos: 0 }, { maxBytesOriginal: 0 }, { maxBytesEntrada: 0 }])
    ('GET presupuesto físico %j antes de SQL/objetos', async (cambio) => {
      const f = preparar(); const cookie = await iniciar(f.entorno);
      expect((await worker.fetch(post(cookie).solicitud, f.entorno)).status).toBe(201);
      const antes = await snapshot(f.bucket); f.llamadas.length = 0; f.bucket.eventos.length = 0;
      Object.assign(f.entorno.FOTOS_PRESUPUESTO, cambio);
      await errorPrivado(await worker.fetch(req(`/api/fotos/${base.fotoId}/original`, { headers: { Cookie: cookie } }), f.entorno), 'maxBytesChunk' in cambio ? 503 : 413);
      expect(f.bucket.eventos).toEqual([]); expect(fotosSql(f, 'reservar_foto')).toEqual([]);
      expect(await snapshot(f.bucket)).toEqual(antes);
    });

  it('captura presupuesto/origen/métodos receiver antes del primer await de credenciales', async () => {
    const f = preparar(); const cookie = await iniciar(f.entorno);
    const gate = barrera(); const llegada = barrera(); const digest = crypto.subtle.digest.bind(crypto.subtle);
    vi.spyOn(crypto.subtle, 'digest').mockImplementationOnce(async (...args) => {
      llegada.liberar(); await gate.espera; return digest(...args);
    });
    const pendiente = worker.fetch(post(cookie).solicitud, f.entorno);
    await llegada.espera;
    f.entorno.FOTOS_ORIGEN = 'https://otra.example'; f.entorno.FOTOS_PRESUPUESTO.maxBytesOriginal = 0;
    const originalPut = f.bucket.put; const originalGet = f.bucket.get;
    f.bucket.put = vi.fn(async () => { throw new Error('PUT mutado no capturado'); });
    f.bucket.get = vi.fn(async () => { throw new Error('GET mutado no capturado'); });
    gate.liberar(); const r = await pendiente;
    expect(r.status).toBe(201); expect(await r.text()).toBe(acuse());
    expect(f.bucket.put).not.toHaveBeenCalled(); expect(f.bucket.get).not.toHaveBeenCalled();
    f.bucket.put = originalPut; f.bucket.get = originalGet;
    // La siguiente solicitud NO comparte ese snapshot: configuración nueva inválida.
    await errorPrivado(await worker.fetch(post(cookie).solicitud, f.entorno), 400);
    expect(f.bucket.eventos).toEqual(['put', 'get']);
  });

  it.each(['reserva-perdida', 'put-perdido', 'put-null', 'put-429', 'get-ausente'])('resultado ambiguo %s no concede ACK ni segundo PUT', async (modo) => {
    const f = preparar(); const cookie = await iniciar(f.entorno); const antes = await snapshot(f.bucket);
    if (modo === 'reserva-perdida') f.hooks.despues = async (q) => { if (q.includes('reservar_foto')) throw new Error('Respuesta SQL perdida'); };
    if (modo === 'put-perdido') f.bucket.perdidaPut = true;
    if (modo === 'put-null') f.bucket.rechazoPut = 'null';
    if (modo === 'put-429') f.bucket.rechazoPut = '429';
    if (modo === 'get-ausente') f.bucket.ausente = true;
    await errorPrivado(await worker.fetch(post(cookie).solicitud, f.entorno), 503);
    const incierta = await snapshot(f.bucket);
    expect(incierta.sql.fotos_reservas).toHaveLength(1);
    expect(incierta.sql.fotos_operaciones).toHaveLength(1);
    expect((incierta.sql.fotos_operaciones as { recibo_canonico: unknown }[])[0].recibo_canonico).toBeNull();
    for (const t of ['viajes', 'sesiones', 'decisiones', 'intentos_sesion']) expect(incierta.sql[t]).toEqual(antes.sql[t]);
    expect(fotosSql(f, 'finalizar_foto')).toEqual([]);
    f.hooks.despues = undefined; f.bucket.perdidaPut = false;
    const retry = await worker.fetch(post(cookie).solicitud, f.entorno);
    if (modo === 'put-perdido') { expect(retry.status).toBe(200); expect(await retry.text()).toBe(acuse()); }
    else { await errorPrivado(retry, 503); expect(await snapshot(f.bucket)).toEqual(incierta); }
    expect(f.bucket.eventos.filter((e) => e === 'put')).toHaveLength(modo === 'reserva-perdida' ? 0 : 1);
  });

  it.each(['magic', 'metadata', 'ultimo-byte', 'corto', 'largo', 'stream'])('comparación íntegra %s impide finalizar y conserva filas/objetos', async (modo) => {
    const f = preparar(); const cookie = await iniciar(f.entorno);
    const datos = new Uint8Array(1048581); datos[datos.length - 1] = 7;
    const s = { ...base, original: { ...base.original, bytesOriginal: datos.length } };
    f.bucket.alterar = (b) => {
      if (modo === 'magic') b[0] ^= 1;
      if (modo === 'metadata') b[20] ^= 1;
      if (modo === 'ultimo-byte') b[b.length - 1] ^= 1;
      if (modo === 'corto') return b.slice(0, -1);
      if (modo === 'largo') { const mas = new Uint8Array(b.length + 1); mas.set(b); return mas; }
      return b;
    };
    f.bucket.errorStream = modo === 'stream';
    await errorPrivado(await worker.fetch(post(cookie, s, datos).solicitud, f.entorno), modo === 'ultimo-byte' ? 409 : 503);
    expect(fotosSql(f, 'finalizar_foto')).toEqual([]);
    const incierta = await snapshot(f.bucket);
    expect((incierta.sql.fotos_operaciones as { recibo_canonico: unknown }[])[0].recibo_canonico).toBeNull();
    await errorPrivado(await worker.fetch(post(cookie, s, datos).solicitud, f.entorno), modo === 'ultimo-byte' ? 409 : 503);
    expect(await snapshot(f.bucket)).toEqual(incierta);
    expect(f.bucket.eventos.filter((e) => e === 'put')).toHaveLength(1);
  });

  it.each(['revocada', 'caducada'])('auth fresca tras EOF %s impide final SQL y descarga', async (modo) => {
    const f = preparar(); const cookie = await iniciar(f.entorno);
    f.bucket.alEof = async () => {
      await db.exec(modo === 'revocada' ? 'UPDATE itinerario.sesiones SET revocada=true' :
        'UPDATE itinerario.sesiones SET creada_en=0,vence_en=1');
    };
    await errorPrivado(await worker.fetch(post(cookie).solicitud, f.entorno), 401);
    expect(fotosSql(f, 'finalizar_foto')).toEqual([]);
    expect((await filas('fotos_operaciones') as { recibo_canonico: unknown }[])[0].recibo_canonico).toBeNull();
  });

  it.each(['reserva', 'put', 'get-eof', 'final'])('espera %s sin ACK prematuro', async (paso) => {
    const f = preparar(); const cookie = await iniciar(f.entorno); const gate = barrera(); const llegada = barrera();
    const hook = async () => { llegada.liberar(); await gate.espera; };
    if (paso === 'reserva' || paso === 'final') f.hooks.despues = async (q) => {
      if (q.includes(paso === 'reserva' ? 'reservar_foto' : 'finalizar_foto')) await hook();
    };
    if (paso === 'put') f.bucket.antesPut = hook;
    if (paso === 'get-eof') f.bucket.alEof = hook;
    let terminada = false;
    const pendiente = worker.fetch(post(cookie).solicitud, f.entorno).then((r) => { terminada = true; return r; });
    await llegada.espera; expect(terminada).toBe(false);
    if (paso === 'reserva') expect(f.bucket.eventos).toEqual([]);
    if (paso !== 'final') expect(fotosSql(f, 'finalizar_foto')).toEqual([]);
    gate.liberar(); const r = await pendiente;
    expect(r.status).toBe(201); expect(await r.text()).toBe(acuse());
  });

  it.each(['reserva', 'get-eof'])('aborto durante %s no inicia PUT/final tardíos ni limpieza', async (paso) => {
    const f = preparar(); const cookie = await iniciar(f.entorno); const gate = barrera(); const llegada = barrera();
    const hook = async () => { llegada.liberar(); await gate.espera; };
    if (paso === 'reserva') f.hooks.despues = async (q) => { if (q.includes('reservar_foto')) await hook(); };
    else f.bucket.alEof = hook;
    const abortar = new AbortController();
    const p = post(cookie); const solicitud = new Request(p.solicitud, { signal: abortar.signal });
    const pendiente = worker.fetch(solicitud, f.entorno);
    await llegada.espera; abortar.abort(); await errorPrivado(await pendiente, 503);
    const antes = await snapshot(f.bucket); gate.liberar();
    // Barrera local posterior al hook: no temporizadores de polling ni aborto de promesas ajenas.
    await gate.espera; await Promise.resolve();
    expect(fotosSql(f, 'finalizar_foto')).toEqual([]);
    if (paso === 'reserva') expect(f.bucket.eventos).toEqual([]);
    expect(await snapshot(f.bucket)).toEqual(antes);
  });

  it('pérdida de respuesta final mantiene recibo comprometido y retry exacto', async () => {
    const f = preparar(); const cookie = await iniciar(f.entorno);
    f.hooks.despues = async (q) => { if (q.includes('finalizar_foto')) throw new Error('Acuse SQL perdido'); };
    await errorPrivado(await worker.fetch(post(cookie).solicitud, f.entorno), 503);
    const antes = await snapshot(f.bucket);
    expect((antes.sql.fotos_operaciones as { recibo_canonico: string }[])[0].recibo_canonico).toBe(acuse());
    f.hooks.despues = undefined;
    const r = await worker.fetch(post(cookie).solicitud, f.entorno);
    expect(r.status).toBe(200); expect(await r.text()).toBe(acuse());
    expect(await snapshot(f.bucket)).toEqual(antes); expect(f.bucket.eventos.filter((e) => e === 'put')).toHaveLength(1);
  });

  it('conserva íntegros raíz, decisiones previas, sesiones, reservas, recibos y objetos ajenos a la foto nueva', async () => {
    const f = preparar(); const cookie = await iniciar(f.entorno);
    const op = { id: 'operacion-previa', dispositivoId: 'otro-editor', tipo: 'parada',
      paradaId: plan.dias[0].paradas[0].id, marca: 'hecha', revision: 0, horaReal: -0 };
    expect((await worker.fetch(req('/api/progreso', { method: 'POST', headers: { Cookie: cookie,
      Origin: origen, 'Content-Type': 'application/json' }, body: serializarProgreso(op) }), f.entorno)).status).toBe(200);
    const previaId = 'CBCDEF12-1234-4123-8123-123456789ABD';
    const previa = { ...base, fotoId: previaId, operacionId: 'CBCDEF12-1234-4123-8123-123456789ABC',
      original: { ...base.original, fotoId: previaId } };
    expect((await worker.fetch(post(cookie, previa).solicitud, f.entorno)).status).toBe(201);
    const antes = await snapshot(f.bucket);
    expect((await worker.fetch(post(cookie).solicitud, f.entorno)).status).toBe(201);
    const despues = await snapshot(f.bucket);
    for (const t of ['viajes', 'sesiones', 'decisiones', 'intentos_sesion']) expect(despues.sql[t]).toEqual(antes.sql[t]);
    for (const t of ['fotos_reservas', 'fotos_operaciones']) {
      expect(despues.sql[t]).toHaveLength(2); expect(despues.sql[t]).toEqual(expect.arrayContaining(antes.sql[t]));
    }
    expect(despues.objetos).toHaveLength(2); expect(despues.objetos).toEqual(expect.arrayContaining(antes.objetos));
    expect(f.bucket.eventos.filter((e) => e === 'put')).toHaveLength(2);
    // Catálogo conserva también decisiones/historia previas, no sólo una raíz vacía.
    const entorno = { ...f.entorno, FOTOS_LISTADO_PRESUPUESTO: { ...presupuestoListado,
      maxFilas: 8, maxBytesSql: 24 * 1024 ** 2, maxBytesRespuesta: 4 * 1024 ** 2, maxBytesRetenidos: 256 * 1024 ** 2 } };
    f.llamadas.length = 0; f.bucket.eventos.length = 0;
    const listado = await worker.fetch(req('/api/fotos/listado', { headers: { Cookie: cookie } }), entorno);
    expect(listado.status).toBe(200); expect((await listado.json() as PaginaListadoFotos).solicitudesIniciales).toHaveLength(2);
    expect(await snapshot(f.bucket)).toEqual(despues); expect(f.bucket.eventos).toEqual([]);
    expect(f.llamadas.filter((q) => q.query.includes('listar_fotos_confirmadas'))).toHaveLength(1);
  });

  it('fábricas/importación preparan sin SQL, R2, body, azar ni hashing', async () => {
    const f = preparar(); const azar = vi.spyOn(crypto, 'getRandomValues'); const digest = vi.spyOn(crypto.subtle, 'digest');
    const composicion = crearComposicionFotos({ plan, ejecutor: crearEjecutorNeon({ urlBaseDatos: dsn }),
      origen, presupuesto, bucket: f.bucket });
    composicion.conAutenticacion(async () => null);
    await import('../../servidor/composicion-fotos');
    expect(f.transporte).not.toHaveBeenCalled(); expect(f.bucket.eventos).toEqual([]);
    expect(azar).not.toHaveBeenCalled(); expect(digest).not.toHaveBeenCalled();
  });

  it.each(['revocada', 'caducada'])('GET: auth fresca tras leer objeto %s impide entregar bytes', async (modo) => {
    const f = preparar(); const cookie = await iniciar(f.entorno);
    expect((await worker.fetch(post(cookie).solicitud, f.entorno)).status).toBe(201);
    const previo = await snapshot(f.bucket);
    f.bucket.alEof = async () => { await db.exec(modo === 'revocada' ? 'UPDATE itinerario.sesiones SET revocada=true' :
      'UPDATE itinerario.sesiones SET creada_en=0, vence_en=1'); };
    await errorPrivado(await worker.fetch(req(`/api/fotos/${base.fotoId}/original`, { headers: { Cookie: cookie } }), f.entorno), 401);
    const despues = await snapshot(f.bucket);
    for (const t of ['viajes', 'decisiones', 'intentos_sesion', 'fotos_reservas', 'fotos_operaciones']) expect(despues.sql[t]).toEqual(previo.sql[t]);
    expect(despues.objetos).toEqual(previo.objetos);
  });

  it.each(['ausente', 'magic', 'metadata', 'corto', 'trailer', 'stream'])('GET: %s falla privado sin copiar estado ni ACK', async (modo) => {
    const f = preparar(); const cookie = await iniciar(f.entorno);
    expect((await worker.fetch(post(cookie).solicitud, f.entorno)).status).toBe(201);
    const previo = await snapshot(f.bucket); f.llamadas.length = 0;
    f.bucket.ausente = modo === 'ausente'; f.bucket.errorStream = modo === 'stream';
    f.bucket.alterar = (b) => {
      if (modo === 'magic') b[0] ^= 1;
      if (modo === 'metadata') b[20] ^= 1;
      if (modo === 'corto') return b.slice(0, -1);
      if (modo === 'trailer') { const mas = new Uint8Array(b.length + 1); mas.set(b); return mas; }
      return b;
    };
    await errorPrivado(await worker.fetch(req(`/api/fotos/${base.fotoId}/original`, { headers: { Cookie: cookie } }), f.entorno), 503);
    expect(await snapshot(f.bucket)).toEqual(previo); expect(fotosSql(f, 'finalizar_foto')).toEqual([]);
  });

  it.each(['metadata', 'bytes'])('retry contradictorio %s no toca reserva, recibos ni objeto', async (modo) => {
    const f = preparar(); const cookie = await iniciar(f.entorno);
    expect((await worker.fetch(post(cookie).solicitud, f.entorno)).status).toBe(201);
    const antes = await snapshot(f.bucket);
    const s = modo === 'metadata' ? { ...base, original: { ...base.original, nombre: base.original.nombre.normalize('NFC') } } : base;
    await errorPrivado(await worker.fetch(post(cookie, s, new Uint8Array(modo === 'bytes' ? [1, 2, 4] : [1, 2, 3])).solicitud, f.entorno), 409);
    expect(await snapshot(f.bucket)).toEqual(antes); expect(f.bucket.eventos.filter((e) => e === 'put')).toHaveLength(1);
  });

  it.each(['reserva', 'get-eof'])('deadline durante %s no autoriza continuación tardía', async (paso) => {
    const f = preparar(); const cookie = await iniciar(f.entorno);
    const gate = barrera(); const llegada = barrera(); const salio = barrera();
    const hook = async () => { llegada.liberar(); await gate.espera; salio.liberar(); };
    if (paso === 'reserva') f.hooks.despues = async (q) => { if (q.includes('reservar_foto')) await hook(); };
    else f.bucket.alEof = hook;
    f.entorno.FOTOS_PRESUPUESTO.plazoMs = 20; vi.useFakeTimers();
    const pendiente = worker.fetch(post(cookie).solicitud, f.entorno);
    await llegada.espera; await vi.advanceTimersByTimeAsync(20); await errorPrivado(await pendiente, 503);
    const antes = await snapshot(f.bucket); gate.liberar(); await salio.espera;
    await Promise.allSettled(f.transporte.mock.results.map((r) => r.value));
    expect(fotosSql(f, 'finalizar_foto')).toEqual([]);
    if (paso === 'reserva') expect(f.bucket.eventos).toEqual([]);
    expect(await snapshot(f.bucket)).toEqual(antes);
  });

  it('sesiones/progreso/assets/entrada/límite reales siguen activos sin leer configuración fotos', async () => {
    const f = preparar(); const getters = vi.fn(() => { throw new Error('Configuración de fotos ajena a ruta'); });
    for (const c of ['FOTOS_ORIGEN', 'FOTOS_PRESUPUESTO', 'FOTOS_BUCKET']) Object.defineProperty(f.entorno, c, { get: getters });
    const cookie = await iniciar(f.entorno);
    expect((await worker.fetch(req('/entrar'), f.entorno)).status).toBe(200);
    expect((await worker.fetch(req('/', { headers: { Cookie: cookie } }), f.entorno)).status).toBe(200);
    const progreso = await worker.fetch(req('/api/progreso', { headers: { Cookie: cookie } }), f.entorno);
    expect(progreso.status).toBe(200);
    const etag = progreso.headers.get('ETag')!;
    const igual = await worker.fetch(req('/api/progreso', { headers: { Cookie: cookie, 'If-None-Match': etag } }), f.entorno);
    expect(igual.status).toBe(304); expect(await igual.text()).toBe('');
    expect((await worker.fetch(req('/api/fotos/listado'), f.entorno)).status).toBe(503);
    for (let i = 0; i < 9; i++) await iniciar(f.entorno, 'editor-' + i);
    const limite = await worker.fetch(req('/api/sesion', { method: 'POST', headers: { Origin: origen,
      'Content-Type': 'application/json', 'CF-Connecting-IP': '203.0.113.9' }, body: JSON.stringify({ clave, dispositivoId: 'extra' }) }), f.entorno);
    expect(limite.status).toBe(429); expect(limite.headers.get('Retry-After')).toBe('600');
    expect(getters).not.toHaveBeenCalled(); expect(fotosSql(f)).toEqual([]); expect(f.bucket.eventos).toEqual([]);
  });
});
