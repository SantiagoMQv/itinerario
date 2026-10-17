// Fotos compartidas de una ficha: controlador real (fotos-remotas) compuesto como en la interfaz
// (componerFotosRemotas: listado y recepción reales a través de un puerto HTTP explícito), con PhotoDB real sobre
// IndexedDB SIMULADA (fake-indexeddb) para la deduplicación y para medir que ver no escribe nada. Node no decodifica
// imágenes: decodificador y lienzo inyectados; el inspector de cabeceras es el real. PNG sintéticos de cabecera.
// No prueba sesión real, TLS, navegador, R2/Neon ni teléfono.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { IDBFactory } from 'fake-indexeddb';
import { itinerario } from '../src/datos/itinerario';
import { crearCapturaFoto, type DestinoFoto } from '../src/fotos';
import { abrirFotosLocal, type FotosLocal } from '../src/fotos-local';
import { crearMiniatura, type ImagenDecodificada } from '../src/fotos-imagen';
import { serializarSolicitudRespaldo } from '../src/fotos-protocolo';
import { deserializarCursorListadoFotosDestino, deserializarDestinoListadoFotos, serializarCursorListadoFotosDestino,
  serializarDestinoListadoFotos, serializarPaginaListadoFotosDestino } from '../src/fotos-listado-protocolo';
import { componerFotosRemotas, type ComposicionRespaldoFotos } from '../src/fotos-respaldo-interfaz';
import { LIMITES_REMOTAS, SIN_SESION_REMOTAS, VISTA_TEMPORAL, textoCeldaRemota, textoEstadoRemotas, textoLocalRemota,
  textoVisorRemota, type FotosRemotas, type LimitesRemotas, type SesionRemota } from '../src/fotos-remotas';
import type { OriginalRespaldo } from '../src/fotos-respaldo';

const origen = 'https://itinerario.prueba';
const paradas = itinerario.dias.flatMap((d) => d.paradas);
const conSitios = paradas.find((p) => (p.subparadas ?? []).length > 0)!;
const D: DestinoFoto = { tipo: 'parada', viajeId: itinerario.id, paradaId: conSitios.id };
const D_SUB: DestinoFoto = { tipo: 'subparada', viajeId: itinerario.id, paradaId: conSitios.id, subparadaId: conSitios.subparadas![0].id };
const D_OTRA: DestinoFoto = { tipo: 'parada', viajeId: itinerario.id, paradaId: paradas.find((p) => p !== conSitios)!.id };
// UUIDv4 en orden ascendente (el listado los entrega por fotoId).
const R1 = '13345678-1234-4123-8123-123456789abc';
const R2 = '23345678-1234-4123-8123-123456789abc';
const R3 = '33345678-1234-4123-8123-123456789abc';
const R4 = '43345678-1234-4123-8123-123456789abc';
const operacion = 'e3345678-1234-4123-8123-123456789abc';

/** Cabecera PNG genuina (firma + IHDR); el decodificador es inyectado, así que no hace falta IDAT. */
function png(ancho = 40, alto = 30): Uint8Array<ArrayBuffer> {
  const b = new Uint8Array(45);
  b.set([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82]);
  new DataView(b.buffer).setUint32(16, ancho); new DataView(b.buffer).setUint32(20, alto);
  b[24] = 8; b[25] = 6;
  return b;
}
const SVG: Uint8Array<ArrayBuffer> = new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');
function compartida(id: string, destino: DestinoFoto = D, o: { nombre?: string; mime?: string; bytes?: Uint8Array<ArrayBuffer> } = {}) {
  const bytes = o.bytes ?? png();
  const original: OriginalRespaldo = { formato: 1, fotoId: id, destino, nombre: o.nombre ?? `remota-${id.slice(0, 2)}.png`,
    mimeDeclarado: o.mime ?? 'image/png', ultimaModificacion: 5, incorporada: 2_000, bytesOriginal: bytes.length };
  return { original, bytes };
}
type Compartida = ReturnType<typeof compartida>;
const CABECERAS_LISTADO = { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'private, no-store',
  Vary: 'Cookie', Pragma: 'no-cache', 'X-Content-Type-Options': 'nosniff' };
const binario = (b: Uint8Array<ArrayBuffer>) => new Response(new Uint8Array(b), { status: 200,
  headers: { 'Content-Type': 'application/octet-stream', 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff' } });
const noAutorizado = () => new Response('{"error":"sin-sesion"}', { status: 401,
  headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' } });
function composicion(maxFilas = 1): ComposicionRespaldoFotos {
  return { origen, listado: { maxFilas, maxBytesPagina: maxFilas === 1 ? 524_288 : 4_194_304, maxBytesChunk: 1_048_576,
    maxBytesBackingChunk: 1_048_576, maxLecturas: 4_096, maxBytesPlan: 4_194_304, maxBytesRetenidos: 268_435_456, plazoMs: 30_000 } };
}
function diferido() {
  let soltar!: () => void;
  const promesa = new Promise<void>((ok) => { soltar = ok; });
  return { promesa, soltar };
}

/** Servidor modelado: las compartidas por destino, en orden de fotoId, una página de `maxFilas` por petición. */
interface Servidor {
  readonly fotos: Compartida[];
  /** Peticiones en orden: «listado <destino> <continuación|->» u «original <fotoId>». */
  readonly llamadas: string[];
  readonly senales: Map<string, AbortSignal>;
  sinSesion: boolean;
  repetirPagina: boolean;
  /** Retiene la respuesta de esa petición hasta soltarla (ignora el abort, como un puerto que no lo atiende). */
  readonly retener: Map<string, Promise<void>>;
  /** Originales cuyo cuerpo manda un byte y no termina nunca; al cancelarlo, se anota aquí. */
  readonly lentos: Set<string>;
  readonly cancelados: string[];
}
function puertoHttp(s: Servidor, maxFilas: number): typeof fetch {
  return async (entrada, opciones) => {
    if (entrada instanceof Request) {
      const url = new URL(entrada.url);
      const destino = deserializarDestinoListadoFotos(itinerario, url.searchParams.get('destino'));
      const continuacion = url.searchParams.get('continuacion');
      const clave = serializarDestinoListadoFotos(itinerario, destino);
      const nombre = `listado ${clave} ${continuacion === null ? '-' : 'cont'}`;
      s.llamadas.push(nombre);
      await s.retener.get(nombre);
      if (s.sinSesion) return noAutorizado();
      const todas = s.fotos.filter((f) => serializarDestinoListadoFotos(itinerario, f.original.destino) === clave)
        .sort((a, b) => (a.original.fotoId < b.original.fotoId ? -1 : 1));
      const desde = continuacion === null || s.repetirPagina ? 0
        : todas.findIndex((f) => f.original.fotoId > deserializarCursorListadoFotosDestino(itinerario, continuacion).despuesDe);
      const pagina = todas.slice(desde, desde + maxFilas);
      const ultima = todas.at(-1)?.original.fotoId;
      const siguiente = desde + maxFilas < todas.length && ultima
        ? serializarCursorListadoFotosDestino(itinerario, { version: 1, tipo: 'cursor-respaldos-destino', viajeId: itinerario.id,
          destino, despuesDe: pagina.at(-1)!.original.fotoId, hasta: ultima }) : null;
      return new Response(serializarPaginaListadoFotosDestino(itinerario, { version: 1, tipo: 'listado-respaldos-destino',
        viajeId: itinerario.id, destino, continuacion: siguiente,
        solicitudesIniciales: pagina.map((f) => serializarSolicitudRespaldo(itinerario, { version: 1, tipo: 'solicitud-respaldo',
          viajeId: itinerario.id, operacionId: operacion, fotoId: f.original.fotoId, original: f.original })) },
      maxFilas, maxFilas === 1 ? 524_288 : 4_194_304), { status: 200, headers: CABECERAS_LISTADO });
    }
    const id = decodeURIComponent(/\/api\/fotos\/([^/]+)\/original$/.exec(String(entrada))![1]);
    s.llamadas.push(`original ${id}`);
    if (opciones?.signal) s.senales.set(id, opciones.signal);
    await s.retener.get(`original ${id}`);
    if (s.sinSesion) return noAutorizado();
    if (s.lentos.has(id)) {
      return new Response(new ReadableStream<Uint8Array>({
        start(control) { control.enqueue(new Uint8Array([137])); },
        cancel() { s.cancelados.push(id); },
      }), { status: 200, headers: { 'Content-Type': 'application/octet-stream', 'Cache-Control': 'private, no-store',
        'X-Content-Type-Options': 'nosniff' } });
    }
    const f = s.fotos.find((x) => x.original.fotoId === id);
    return f ? binario(f.bytes) : new Response('', { status: 404 });
  };
}

const cierres: (() => void)[] = [];
afterEach(() => { cierres.splice(0).reverse().forEach((c) => c()); });
interface Montaje {
  remotas: FotosRemotas;
  readonly fotos: FotosLocal;
  readonly fabrica: IDBFactory;
  readonly servidor: Servidor;
  readonly urls: Map<string, Blob>;
  readonly revocadas: string[];
  readonly decodes: { total: number; activos: number; maximo: number };
  readonly cambios: (DestinoFoto | null)[];
  enLinea: boolean;
  /** Fotos cuya clasificación local (lectura de metadata) quedó retenida en la compuerta. */
  readonly clasificando: Set<string>;
  soltarClasificacion(id: string): void;
}
async function montar(fotos: Compartida[], o: { maxFilas?: number; limites?: Partial<LimitesRemotas>;
  decodificar?: (b: Blob) => Promise<ImagenDecodificada>; retenerClasificacion?: readonly string[];
  /** Bytes de relleno de la vista PNG del lienzo falso según sus dimensiones (por defecto, ninguno). */
  relleno?: (ancho: number, alto: number) => number } = {}): Promise<Montaje> {
  const fabrica = new IDBFactory();
  const local = await abrirFotosLocal(itinerario, { fabrica });
  const servidor: Servidor = { fotos, llamadas: [], senales: new Map(), sinSesion: false, repetirPagina: false, retener: new Map(),
    lentos: new Set(), cancelados: [] };
  const compuertas = new Map((o.retenerClasificacion ?? []).map((id) => [id, diferido()]));
  const clasificando = new Set<string>();
  // El MISMO PhotoDB real; solo la lectura de metadata de las fotos indicadas espera a su compuerta.
  const puerto: FotosLocal = { ...local, leerMetadatos: async (id) => {
    const compuerta = compuertas.get(id);
    if (compuerta) { clasificando.add(id); await compuerta.promesa; }
    return local.leerMetadatos(id);
  } };
  const urls = new Map<string, Blob>(); const revocadas: string[] = []; let n = 0;
  const decodes = { total: 0, activos: 0, maximo: 0 };
  const cambios: (DestinoFoto | null)[] = [];
  const decodificar = o.decodificar ?? (async (b: Blob) => {
    decodes.total++; decodes.activos++; decodes.maximo = Math.max(decodes.maximo, decodes.activos);
    await new Promise((ok) => setTimeout(ok, 2));
    decodes.activos--;
    const v = new DataView(await b.slice(16, 24).arrayBuffer());
    return { ancho: v.getUint32(0), alto: v.getUint32(4), fuente: {} as CanvasImageSource, cerrar: () => {} };
  });
  const m: Montaje = { remotas: null as unknown as FotosRemotas, fotos: local, fabrica, servidor, urls, revocadas, decodes, cambios,
    enLinea: true, clasificando, soltarClasificacion: (id) => compuertas.get(id)?.soltar() };
  const relleno = o.relleno ?? (() => 0);
  m.remotas = componerFotosRemotas(composicion(o.maxFilas ?? 1), { plan: itinerario, puerto: () => puerto,
    fetch: puertoHttp(servidor, o.maxFilas ?? 1), enLinea: () => m.enLinea, ...(o.limites ? { limites: o.limites } : {}),
    crearMotor: () => crearMiniatura({ decodificar, crearLienzo: (ancho, alto) => ({ dibujar: () => {},
      png: async () => new Blob([png(ancho, alto), new Uint8Array(relleno(ancho, alto))], { type: 'image/png' }),
      liberar: () => {} }) }),
    crearUrl: (b) => { const u = `blob:prueba/${++n}`; urls.set(u, b); return u; },
    revocarUrl: (u) => { revocadas.push(u); urls.delete(u); },
    alCambiar: (d) => { cambios.push(d); } })!;
  cierres.push(() => { m.remotas.cerrarTodo(); local.cerrar(); });
  return m;
}
const esperar = (condicion: () => boolean) => vi.waitFor(() => { if (!condicion()) throw new Error('aún no'); }, { timeout: 2000 });
const vista = (s: SesionRemota, id: string) => s.fotos.find((f) => f.original.fotoId === id)?.vista;
const originales = (m: Montaje) => m.servidor.llamadas.filter((l) => l.startsWith('original '));
const listados = (m: Montaje) => m.servidor.llamadas.filter((l) => l.startsWith('listado '));
const clave = (d: DestinoFoto) => serializarDestinoListadoFotos(itinerario, d);
/** Nombres de las bases y todo lo guardado en PhotoDB, para comprobar que ver no escribe nada. */
async function huellaLocal(m: Montaje) {
  return { bases: (await m.fabrica.databases()).map((b) => b.name).sort(), fotos: await m.fotos.listar() };
}

describe('fotos compartidas de una ficha: consulta por destino y vistas a la vista (FR1–FR4)', () => {
  it('FR1 · sin composición no se construye nada; al abrir, UNA consulta de SU destino y ningún original sin celdas a la vista', async () => {
    let peticiones = 0;
    expect(componerFotosRemotas(null, { plan: itinerario, puerto: () => null, fetch: async () => { peticiones++; throw new Error('Sin red'); } }))
      .toBeNull();
    expect(peticiones).toBe(0);

    const m = await montar([compartida(R1), compartida(R2, D_OTRA)]);
    const antes = await huellaLocal(m);
    expect(m.servidor.llamadas).toEqual([]);
    const s = m.remotas.abrir(D);
    expect(s.estado).toEqual({ tipo: 'consultando', mas: false });
    await esperar(() => s.estado.tipo === 'lista');
    expect(listados(m)).toEqual([`listado ${clave(D)} -`]);
    expect(s.fotos.map((f) => [f.original.fotoId, f.local, f.vista.tipo])).toEqual([[R1, 'ausente', 'pendiente']]);
    expect(s.estado).toEqual({ tipo: 'lista', hayMas: false, yaAqui: 0, completa: false });
    await new Promise((ok) => setTimeout(ok, 20));
    expect(originales(m)).toEqual([]);
    expect(m.urls.size).toBe(0);
    // Otra ficha no se consulta hasta abrirla, y la suya no mezcla lo de la primera.
    const otra = m.remotas.abrir(D_SUB);
    await esperar(() => otra.estado.tipo === 'lista');
    expect(otra.fotos).toEqual([]);
    expect(listados(m)).toEqual([`listado ${clave(D)} -`, `listado ${clave(D_SUB)} -`]);
    expect(await huellaLocal(m)).toEqual(antes);
  });

  it('FR2 · a la vista: UN original a memoria y una vista PNG saneada en una URL propia; PhotoDB y las bases no cambian', async () => {
    const m = await montar([compartida(R1, D, { bytes: png(2400, 1600) })]);
    const antes = await huellaLocal(m);
    const s = m.remotas.abrir(D);
    await esperar(() => s.fotos.length === 1);
    s.visible(R1, true);
    await esperar(() => vista(s, R1)?.tipo === 'lista');
    expect(originales(m)).toEqual([`original ${R1}`]);
    const v = vista(s, R1);
    if (v?.tipo !== 'lista') throw new Error('sin vista');
    // PNG nuevo del lienzo, acotado a 1024 px: nunca el original ni otro tipo.
    const blob = m.urls.get(v.url)!;
    expect(blob.type).toBe('image/png');
    const dims = new DataView(await blob.slice(16, 24).arrayBuffer());
    expect([dims.getUint32(0), dims.getUint32(4)]).toEqual([1024, 683]);
    expect(v.bytes).toBe(blob.size);
    expect(m.remotas.urlsVivas()).toBe(1);
    expect(await huellaLocal(m)).toEqual(antes);
    // Ocultarla no la suelta (sigue retenida y acotada); volver a verla no la pide otra vez.
    s.visible(R1, false); s.visible(R1, true);
    await new Promise((ok) => setTimeout(ok, 10));
    expect(originales(m)).toHaveLength(1);
  });

  it('FR3 · una sola tubería: dos celdas a la vista se cargan de una en una y la del visor va primero', async () => {
    const m = await montar([compartida(R1), compartida(R2), compartida(R3)], { maxFilas: 3 });
    const s = m.remotas.abrir(D);
    await esperar(() => s.fotos.length === 3);
    const retenida = diferido();
    m.servidor.retener.set(`original ${R1}`, retenida.promesa);
    s.visible(R1, true);
    await esperar(() => originales(m).length === 1);
    s.visible(R2, true);
    s.fijar(R3);
    await new Promise((ok) => setTimeout(ok, 20));
    // La tubería sigue ocupada con R1: nada más sale; las demás esperan en cola.
    expect(originales(m)).toEqual([`original ${R1}`]);
    expect([vista(s, R2)?.tipo, vista(s, R3)?.tipo]).toEqual(['en-cola', 'en-cola']);
    retenida.soltar();
    await esperar(() => ['lista'].includes(vista(s, R2)?.tipo ?? ''));
    // La del visor (fijada) antes que la otra celda a la vista.
    expect(originales(m)).toEqual([`original ${R1}`, `original ${R3}`, `original ${R2}`]);
    expect(m.decodes.maximo).toBe(1);
  });

  it('FR4 · ocultar la celda corta su original; la entrega tardía no crea URL y la tubería no se libera hasta que acaba', async () => {
    const m = await montar([compartida(R1), compartida(R2)], { maxFilas: 3 });
    const s = m.remotas.abrir(D);
    await esperar(() => s.fotos.length === 2);
    const retenida = diferido();
    m.servidor.retener.set(`original ${R1}`, retenida.promesa);
    s.visible(R1, true);
    await esperar(() => originales(m).length === 1);
    s.visible(R1, false);
    expect(m.servidor.senales.get(R1)?.aborted).toBe(true);
    s.visible(R2, true);
    await new Promise((ok) => setTimeout(ok, 20));
    // El puerto ignoró el abort y aún no ha contestado: R2 no sale todavía (sin liberar antes del trabajo externo).
    expect(originales(m)).toEqual([`original ${R1}`]);
    retenida.soltar();
    await esperar(() => vista(s, R2)?.tipo === 'lista');
    expect(vista(s, R1)).toEqual({ tipo: 'pendiente' });
    expect(originales(m)).toEqual([`original ${R1}`, `original ${R2}`]);
    expect(m.urls.size).toBe(1);
  });
});

describe('ciclo de vida, sesión y formatos (FR5–FR8)', () => {
  it('FR5 · cerrar la sesión revoca sus URLs y cierra su listado; una página que llega tarde no se pinta', async () => {
    const m = await montar([compartida(R1), compartida(R2, D_OTRA)]);
    const s = m.remotas.abrir(D);
    await esperar(() => s.fotos.length === 1);
    s.visible(R1, true);
    await esperar(() => vista(s, R1)?.tipo === 'lista');
    const url = (vista(s, R1) as { url: string }).url;
    m.remotas.cerrar(D);
    expect(m.revocadas).toEqual([url]);
    expect(m.remotas.urlsVivas()).toBe(0);
    expect(m.remotas.sesion(D)).toBeNull();

    const retenida = diferido();
    m.servidor.retener.set(`listado ${clave(D_OTRA)} -`, retenida.promesa);
    const otra = m.remotas.abrir(D_OTRA);
    await esperar(() => listados(m).length === 2);
    m.remotas.cerrar(D_OTRA);
    retenida.soltar();
    await new Promise((ok) => setTimeout(ok, 20));
    expect(otra.fotos).toEqual([]);
    expect(otra.estado).toEqual({ tipo: 'consultando', mas: false });
    expect(originales(m)).toEqual([`original ${R1}`]);
  });

  it('FR6 · un 401 del original o de la consulta limpia TODAS las vistas temporales sin reserva; lo guardado aquí sigue', async () => {
    const m = await montar([compartida(R1), compartida(R2), compartida(R3, D_OTRA)], { maxFilas: 3 });
    const guardada = crearCapturaFoto(itinerario, D_OTRA, new File([png()], 'mia.png', { type: 'image/png', lastModified: 1 }),
      1_000, { uuid: () => R4 });
    await m.fotos.guardarOriginal(guardada);
    const a = m.remotas.abrir(D);
    const b = m.remotas.abrir(D_OTRA);
    await esperar(() => a.fotos.length === 2 && b.fotos.length === 1);
    a.visible(R1, true); b.visible(R3, true);
    await esperar(() => vista(a, R1)?.tipo === 'lista' && vista(b, R3)?.tipo === 'lista');
    expect(m.remotas.urlsVivas()).toBe(2);
    m.servidor.sinSesion = true;
    a.visible(R2, true);
    await esperar(() => a.estado.tipo === 'fallo');
    for (const s of [a, b]) {
      expect(s.estado).toEqual({ tipo: 'fallo', motivo: 'sin-sesion' });
      expect(s.fotos).toEqual([]);
    }
    expect(m.remotas.urlsVivas()).toBe(0);
    expect(m.revocadas).toHaveLength(2);
    expect(await m.fotos.leerMetadatos(R4)).toEqual(guardada.metadatos);
    // Reintentar sin sesión: la consulta también contesta 401 y nada vuelve.
    a.reintentar();
    await esperar(() => listados(m).length === 3);
    await new Promise((ok) => setTimeout(ok, 10));
    expect(a.estado).toEqual({ tipo: 'fallo', motivo: 'sin-sesion' });
    expect(textoEstadoRemotas(a.estado, 0, 'X')).toBe(SIN_SESION_REMOTAS);
  });

  it('FR7 · sin vista segura: un tipo declarado no decodificable ni se pide; una cabecera no identificada se pide y no llega a URL', async () => {
    const m = await montar([compartida(R1, D, { mime: 'image/heic', nombre: 'foto.heic' }),
      compartida(R2, D, { mime: 'image/png', nombre: 'dibujo.png', bytes: SVG })], { maxFilas: 3 });
    const s = m.remotas.abrir(D);
    await esperar(() => s.fotos.length === 2);
    expect(vista(s, R1)).toEqual({ tipo: 'sin-vista', motivo: 'image/heic', declarado: true });
    s.visible(R1, true); s.visible(R2, true);
    await esperar(() => vista(s, R2)?.tipo === 'sin-vista');
    expect(originales(m)).toEqual([`original ${R2}`]);
    expect(vista(s, R2)).toEqual({ tipo: 'sin-vista', motivo: 'Formato sin previsualización segura', declarado: false });
    // El inspector la rechaza antes del decodificador: ni decodificación ni URL.
    expect(m.decodes.total).toBe(0);
    expect(m.urls.size).toBe(0);
    expect(textoVisorRemota(vista(s, R1)!)).toBe('No hay vista segura para este tipo de archivo (image/heic). '
      + 'Puedes guardarlo sin conexión y, después, descargar el original.');
    expect(textoVisorRemota(vista(s, R2)!)).toBe('No hay vista segura para este archivo (formato sin previsualización segura). '
      + 'Puedes guardarlo sin conexión y, después, descargar el original.');
  });

  it('FR8 · local primero: la misma identidad no se repite; borrada u ocupada por otra se ven sin poder guardarse', async () => {
    const enMovil = compartida(R1, D, { nombre: 'misma.png' });
    const borrada = compartida(R2, D, { nombre: 'borrada.png' });
    const ocupada = compartida(R3, D, { nombre: 'remota.png' });
    const m = await montar([enMovil, borrada, ocupada, compartida(R4)], { maxFilas: 3 });
    const capturar = (c: Compartida, nombre = c.original.nombre) => crearCapturaFoto(itinerario, c.original.destino,
      new File([c.bytes], nombre, { type: 'image/png', lastModified: c.original.ultimaModificacion }),
      c.original.incorporada, { uuid: () => c.original.fotoId });
    await m.fotos.guardarOriginal(capturar(enMovil));
    await m.fotos.guardarOriginal(capturar(borrada));
    await m.fotos.borrarLocal(R2);
    await m.fotos.guardarOriginal(capturar(ocupada, 'otra-captura.png'));
    const s = m.remotas.abrir(D);
    await esperar(() => s.estado.tipo === 'lista');
    expect(s.fotos.map((f) => [f.original.fotoId, f.local])).toEqual([[R2, 'borrada'], [R3, 'otra']]);
    expect(s.estado).toEqual({ tipo: 'lista', hayMas: true, yaAqui: 1, completa: false });
    expect(textoLocalRemota('borrada')).toBe('La borraste de este móvil: aquí no se puede volver a guardar.');
    expect(textoLocalRemota('otra')).toBe('Otra foto de este móvil usa su identidad: aquí no se puede guardar.');
    expect(textoLocalRemota('ausente')).toBeNull();
    // «Ver más»: la siguiente página del MISMO destino, con su continuación.
    s.verMas();
    await esperar(() => s.fotos.length === 3);
    expect(listados(m)).toEqual([`listado ${clave(D)} -`, `listado ${clave(D)} cont`]);
    // Guardada después en este móvil (como «Guardar sin conexión»): al reclasificar deja de repetirse.
    await m.fotos.guardarOriginal(capturar(compartida(R4)));
    await s.reclasificar(R4);
    expect(s.fotos.map((f) => f.original.fotoId)).toEqual([R2, R3]);
    expect(s.estado).toMatchObject({ yaAqui: 2 });
  });
});

describe('cotas, conexión y segundo plano (FR9–FR11)', () => {
  it('FR9 · paginar conserva acceso más allá de 24 fotos y no descarga originales', async () => {
    const fotos = Array.from({ length: 27 }, (_, i) => compartida(`${(i + 1).toString(16).padStart(8, '0')}-1234-4123-8123-123456789abc`));
    const m = await montar(fotos);
    const s = m.remotas.abrir(D);
    await esperar(() => s.estado.tipo === 'lista');
    await s.cargarSiguientes();
    await s.cargarSiguientes();
    await s.cargarSiguientes();
    expect(s.fotos).toHaveLength(27);
    expect(s.estado).toMatchObject({ hayMas: false });
    expect(originales(m)).toEqual([]);
    expect(LIMITES_REMOTAS.maxVistas).toBe(12);
  });

  it('FR9b · avanza páginas solo locales sin blobs y limita cada tramo automático a 24 páginas', async () => {
    const fotos = Array.from({ length: 28 }, (_, i) => compartida(`${(i + 1).toString(16).padStart(8, '0')}-1234-4123-8123-123456789abc`));
    const m = await montar(fotos);
    for (const f of fotos.slice(0, 26)) await m.fotos.guardarOriginal(crearCapturaFoto(itinerario, D,
      new File([f.bytes], f.original.nombre, { type: 'image/png', lastModified: f.original.ultimaModificacion }),
      f.original.incorporada, { uuid: () => f.original.fotoId }));
    const s = m.remotas.abrir(D);
    await esperar(() => s.estado.tipo === 'lista');
    await s.cargarSiguientes();
    expect(listados(m)).toHaveLength(25);
    expect(s.fotos).toHaveLength(0);
    expect(s.estado).toMatchObject({ hayMas: true });
    await s.cargarSiguientes();
    expect(s.fotos.map((f) => f.original.fotoId)).toEqual(fotos.slice(26).map((f) => f.original.fotoId));
    expect(s.estado).toMatchObject({ hayMas: false });
    expect(originales(m)).toEqual([]);
  });

  it('FR9c · entre páginas respeta que la galería deje de estar visible, sin perder la continuación', async () => {
    const m = await montar([compartida(R1), compartida(R2), compartida(R3)]);
    const s = m.remotas.abrir(D);
    await esperar(() => s.estado.tipo === 'lista');
    const retenida = diferido();
    m.servidor.retener.set(`listado ${clave(D)} cont`, retenida.promesa);
    let visible = true;
    const tramo = s.cargarSiguientes(() => visible);
    await esperar(() => listados(m).length === 2);
    visible = false;
    retenida.soltar();
    await tramo;
    expect(listados(m)).toHaveLength(2);
    expect(s.fotos).toHaveLength(2);
    expect(s.estado).toMatchObject({ hayMas: true });
    visible = true;
    await s.cargarSiguientes(() => visible);
    expect(s.fotos).toHaveLength(3);
    expect(originales(m)).toEqual([]);
  });

  it('FR9d · un cursor repetido detiene la paginación automática sin bucle ni originales', async () => {
    const m = await montar([compartida(R1), compartida(R2), compartida(R3)]);
    const s = m.remotas.abrir(D);
    await esperar(() => s.estado.tipo === 'lista');
    m.servidor.repetirPagina = true;
    await s.cargarSiguientes();
    await s.cargarSiguientes();
    expect(s.estado).toMatchObject({ tipo: 'fallo' });
    expect(listados(m)).toHaveLength(2);
    expect(originales(m)).toEqual([]);
  });

  it('FR10 · vistas retenidas acotadas: se suelta la menos reciente fuera de la vista y, sin hueco, la celda espera sin pedir nada', async () => {
    const m = await montar([compartida(R1), compartida(R2), compartida(R3)], { maxFilas: 3, limites: { maxVistas: 1 } });
    const s = m.remotas.abrir(D);
    await esperar(() => s.fotos.length === 3);
    s.visible(R1, true);
    await esperar(() => vista(s, R1)?.tipo === 'lista');
    const primera = (vista(s, R1) as { url: string }).url;
    s.visible(R1, false);
    s.visible(R2, true);
    await esperar(() => vista(s, R2)?.tipo === 'lista');
    expect(m.revocadas).toEqual([primera]);
    expect(vista(s, R1)).toEqual({ tipo: 'pendiente' });
    // R2 se está mirando: no se suelta. R3 a la vista espera, sin pedir su original.
    s.visible(R3, true);
    await new Promise((ok) => setTimeout(ok, 20));
    expect(vista(s, R3)).toEqual({ tipo: 'en-cola' });
    expect(originales(m)).toEqual([`original ${R1}`, `original ${R2}`]);
    expect(m.remotas.urlsVivas()).toBe(1);
    s.visible(R2, false);
    await esperar(() => vista(s, R3)?.tipo === 'lista');
    expect(m.remotas.urlsVivas()).toBe(1);
  });

  it('FR11 · sin conexión no consulta; segundo plano corta el original en curso; al salir se sueltan las vistas y se vuelven a pedir a la vista', async () => {
    const m = await montar([compartida(R1), compartida(R2)], { maxFilas: 3 });
    m.enLinea = false;
    const s = m.remotas.abrir(D);
    expect(s.estado).toEqual({ tipo: 'sin-conexion' });
    expect(m.servidor.llamadas).toEqual([]);
    m.enLinea = true;
    s.reintentar();
    await esperar(() => s.fotos.length === 2);
    s.visible(R1, true);
    await esperar(() => vista(s, R1)?.tipo === 'lista');
    const retenida = diferido();
    m.servidor.retener.set(`original ${R2}`, retenida.promesa);
    s.visible(R2, true);
    await esperar(() => originales(m).length === 2);
    m.remotas.suspender();
    expect(m.servidor.senales.get(R2)?.aborted).toBe(true);
    retenida.soltar();
    await esperar(() => vista(s, R2)?.tipo === 'en-cola');
    // Al salir de la página: fuera todas las vistas temporales; nada se pide mientras siga suspendida.
    m.remotas.soltarVistas();
    expect(m.remotas.urlsVivas()).toBe(0);
    await new Promise((ok) => setTimeout(ok, 10));
    expect(originales(m)).toHaveLength(2);
    m.remotas.reanudar();
    await esperar(() => vista(s, R1)?.tipo === 'lista' && vista(s, R2)?.tipo === 'lista');
    expect(originales(m)).toEqual([`original ${R1}`, `original ${R2}`, `original ${R1}`, `original ${R2}`]);
    m.remotas.cerrarTodo();
    expect(m.remotas.urlsVivas()).toBe(0);
    expect(m.urls.size).toBe(0);
  });

  it('FR12 · textos de la ficha: lo que se ve no se guarda, una consulta vacía no promete nada y cada celda dice su estado', () => {
    expect(textoEstadoRemotas({ tipo: 'consultando', mas: false }, 0, 'Pane')).toBe('Buscando fotos compartidas…');
    expect(textoEstadoRemotas({ tipo: 'lista', hayMas: false, yaAqui: 0, completa: false }, 0, 'Pane'))
      .toBe('No hay fotos compartidas de «Pane».');
    expect(textoEstadoRemotas({ tipo: 'lista', hayMas: false, yaAqui: 2, completa: false }, 0, 'Pane'))
      .toBe('Las fotos compartidas de «Pane» ya están en este móvil.');
    expect(textoEstadoRemotas({ tipo: 'lista', hayMas: true, yaAqui: 0, completa: false }, 1, 'Pane')).toBe(VISTA_TEMPORAL);
    expect(textoEstadoRemotas({ tipo: 'sin-conexion' }, 0, 'Pane')).toBe('Sin conexión: las fotos compartidas solo se ven con conexión.');
    expect(textoEstadoRemotas({ tipo: 'fallo', motivo: 'plazo' }, 0, 'Pane')).toBe('Tardó demasiado; no se ha guardado nada.');
    expect(['pendiente', 'en-cola', 'cargando', 'fallida'].map((tipo) => textoCeldaRemota({ tipo } as never)))
      .toEqual(['Compartida', 'En espera', 'Cargando…', 'No se pudo cargar']);
  });
});

// ---------- Correcciones FO3: plazo finito, invalidación por sesión y cota dura de vistas (FR13–FR17) ----------

const bytesRetenidos = (m: Montaje) => [...m.urls.values()].reduce((n, b) => n + b.size, 0);

describe('plazo finito de la vista temporal (FR13–FR15)', () => {
  it('FR13 · con el puerto colgado (ignora el abort) la celda falla al vencer el plazo y la tubería no se suelta hasta que el trabajo externo acaba', async () => {
    const m = await montar([compartida(R1), compartida(R2)], { maxFilas: 3, limites: { plazoMs: 40 } });
    const s = m.remotas.abrir(D);
    await esperar(() => s.fotos.length === 2);
    const colgada = diferido();
    m.servidor.retener.set(`original ${R1}`, colgada.promesa);
    s.visible(R1, true); s.visible(R2, true);
    await esperar(() => vista(s, R1)?.tipo === 'fallida');
    expect(vista(s, R1)).toEqual({ tipo: 'fallida', motivo: 'plazo' });
    expect(m.servidor.senales.get(R1)?.aborted).toBe(true);
    await new Promise((ok) => setTimeout(ok, 30));
    // Ownership: mientras el puerto no conteste, no sale otro original.
    expect(originales(m)).toEqual([`original ${R1}`]);
    colgada.soltar();
    await esperar(() => vista(s, R2)?.tipo === 'lista');
    // La entrega tardía de R1 no se publica: sigue fallida y sin URL.
    expect(vista(s, R1)).toEqual({ tipo: 'fallida', motivo: 'plazo' });
    expect(m.urls.size).toBe(1);
  });

  it('FR14 · con un original que no termina de llegar, al vencer el plazo se cancela su lector y la celda dice que tardó', async () => {
    const m = await montar([compartida(R1)], { limites: { plazoMs: 40 } });
    m.servidor.lentos.add(R1);
    const s = m.remotas.abrir(D);
    await esperar(() => s.fotos.length === 1);
    s.visible(R1, true);
    await esperar(() => vista(s, R1)?.tipo === 'fallida');
    expect(vista(s, R1)).toEqual({ tipo: 'fallida', motivo: 'plazo' });
    await esperar(() => m.servidor.cancelados.includes(R1));
    expect(m.urls.size).toBe(0);
    expect(textoCeldaRemota(vista(s, R1)!)).toBe('Tardó demasiado');
  });

  it('FR15 · un decodificador que ignora el abort: al vencer, la celda falla; su PNG tardío no llega a URL y la siguiente espera a que acabe', async () => {
    const lento = diferido();
    const m = await montar([compartida(R1), compartida(R2)], { maxFilas: 3, limites: { plazoMs: 40 },
      decodificar: async (b) => {
        await lento.promesa;
        const v = new DataView(await b.slice(16, 24).arrayBuffer());
        return { ancho: v.getUint32(0), alto: v.getUint32(4), fuente: {} as CanvasImageSource, cerrar: () => {} };
      } });
    const s = m.remotas.abrir(D);
    await esperar(() => s.fotos.length === 2);
    s.visible(R1, true); s.visible(R2, true);
    await esperar(() => vista(s, R1)?.tipo === 'fallida');
    expect(vista(s, R1)).toEqual({ tipo: 'fallida', motivo: 'plazo' });
    await new Promise((ok) => setTimeout(ok, 30));
    expect(originales(m)).toEqual([`original ${R1}`]);
    lento.soltar();
    await esperar(() => vista(s, R2)?.tipo === 'lista');
    expect(vista(s, R1)).toEqual({ tipo: 'fallida', motivo: 'plazo' });
    expect(m.urls.size).toBe(1);
  });
});

describe('sesión perdida y cota dura (FR16–FR17)', () => {
  it('FR16 · un 401 en una ficha invalida también las consultas de las demás: la clasificación retenida de otra no publica nada después', async () => {
    const m = await montar([compartida(R1), compartida(R2), compartida(R3, D_OTRA)], { retenerClasificacion: [R3] });
    const a = m.remotas.abrir(D);
    await esperar(() => a.fotos.length === 1);
    a.visible(R1, true);
    await esperar(() => vista(a, R1)?.tipo === 'lista');
    const b = m.remotas.abrir(D_OTRA);
    await esperar(() => m.clasificando.has(R3));
    m.servidor.sinSesion = true;
    a.verMas();
    await esperar(() => a.estado.tipo === 'fallo');
    m.soltarClasificacion(R3);
    await new Promise((ok) => setTimeout(ok, 30));
    // Nada vuelve: ni la referencia de B, ni vistas, ni URLs.
    expect(b.fotos).toEqual([]);
    expect(b.estado).toEqual({ tipo: 'fallo', motivo: 'sin-sesion' });
    expect(m.remotas.urlsVivas()).toBe(0);
    expect(m.urls.size).toBe(0);
    b.visible(R3, true);
    await new Promise((ok) => setTimeout(ok, 20));
    expect(originales(m)).toEqual([`original ${R1}`]);
    // Nada se reintenta solo; un toque explícito vuelve a consultar con un listado nuevo.
    m.servidor.sinSesion = false;
    const antes = listados(m).length;
    await new Promise((ok) => setTimeout(ok, 20));
    expect(listados(m)).toHaveLength(antes);
    b.reintentar();
    await esperar(() => b.fotos.length === 1);
    expect(b.estado).toMatchObject({ tipo: 'lista' });
  });

  it('FR17 · cota dura de bytes: una vista que no cabe ni se retiene ni se publica, y las que se miran no se sueltan para hacerle sitio', async () => {
    // Vista de 20×20: 45 + 400 B; de 40×30: 45 + 1200 B (más que toda la cota).
    const m = await montar([compartida(R1, D, { bytes: png(20, 20) }), compartida(R2, D, { bytes: png(20, 20) }),
      compartida(R3, D, { bytes: png(40, 30) }), compartida(R4, D, { bytes: png(20, 20) })],
    { maxFilas: 3, limites: { maxBytesVistas: 1000 }, relleno: (ancho, alto) => ancho * alto });
    const s = m.remotas.abrir(D);
    await esperar(() => s.fotos.length === 3);
    s.verMas();
    await esperar(() => s.fotos.length === 4);
    s.visible(R1, true); s.visible(R2, true);
    await esperar(() => vista(s, R1)?.tipo === 'lista' && vista(s, R2)?.tipo === 'lista');
    expect(bytesRetenidos(m)).toBe(890);
    // Ni sola cabe: no se retiene ni se publica, tampoco fijada en el visor.
    s.fijar(R3);
    await esperar(() => vista(s, R3)?.tipo === 'sin-hueco');
    expect(bytesRetenidos(m)).toBeLessThanOrEqual(1000);
    // Cabría sola, pero R1 y R2 se están mirando: no se sueltan; R4 dice que no hay hueco.
    s.fijar(null);
    s.visible(R4, true);
    await esperar(() => vista(s, R4)?.tipo === 'sin-hueco');
    expect([vista(s, R1)?.tipo, vista(s, R2)?.tipo]).toEqual(['lista', 'lista']);
    expect(bytesRetenidos(m)).toBe(890);
    // Deja de mirarse R1: con un toque se reintenta R4 y entra soltando la menos reciente fuera de la vista.
    s.visible(R1, false);
    s.reintentarVista(R4);
    await esperar(() => vista(s, R4)?.tipo === 'lista');
    expect(vista(s, R1)).toEqual({ tipo: 'pendiente' });
    expect(bytesRetenidos(m)).toBe(890);
    expect(textoCeldaRemota({ tipo: 'sin-hueco' } as never)).toBe('Sin hueco');
  });
});
