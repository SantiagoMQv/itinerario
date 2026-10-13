// Respaldo manual desde la interfaz. PhotoDB y ledger REALES sobre IndexedDB SIMULADA (fake-indexeddb); transporte real
// de la biblioteca a través de un puerto fetch explícito que lee la solicitud RAW (INITIAL) y responde 201 con el acuse
// canónico de los codecs reales. No prueba sesión, TLS, cookie, Worker, proveedor ni móvil.
import { describe, expect, it, vi } from 'vitest';
import { IDBFactory } from 'fake-indexeddb';
import { itinerario } from '../src/datos/itinerario';
import { crearCapturaFoto, type MetadatosFoto } from '../src/fotos';
import { abrirFotosLocal, type FotosLocal } from '../src/fotos-local';
import { abrirRespaldoFotosLocal } from '../src/fotos-respaldo-local';
import { deserializarReciboRespaldo, deserializarSolicitudRespaldo, serializarReciboRespaldo,
  serializarSolicitudRespaldo, type SolicitudRespaldo } from '../src/fotos-protocolo';
import { COPIA_SIN_CONFIRMAR, avisoBorradoRespaldo, componerRespaldoFotos, crearRespaldoFotos, textoCatalogo,
  textoFilaCatalogo, textoResultadoRespaldo, type CambioRespaldo, type ComposicionRespaldoFotos, type FilaCatalogo,
  type RespaldoFotos } from '../src/fotos-respaldo-interfaz';
import { copiarOriginalRespaldo, type OriginalRespaldo } from '../src/fotos-respaldo';
import { serializarCursorListadoFotos, serializarPaginaListadoFotos } from '../src/fotos-listado-protocolo';

const origen = 'https://itinerario.prueba';
const fotoId = '52345678-1234-4123-8123-123456789abc';
const operacionId = '62345678-1234-4123-8123-123456789abc';
/** Contenido arbitrario: el respaldo envía los bytes tal cual, sin decodificar ni inspeccionar la imagen. */
const bytes = [137, 80, 78, 71, 0, 255, 17];
/** Composición explícita de la prueba (en la web publicada es null). Catálogo N1 del mapa, sin defaults. */
const composicion: ComposicionRespaldoFotos = {
  origen,
  listado: { maxFilas: 1, maxBytesPagina: 404_231, maxBytesChunk: 1_048_576, maxBytesBackingChunk: 1_048_576,
    maxLecturas: 4_096, maxBytesPlan: 4_194_304, maxBytesRetenidos: 134_217_728, plazoMs: 30_000 },
};

interface Peticion {
  readonly url: string;
  readonly metodo: string | undefined;
  readonly campos: readonly string[];
  /** Texto RAW de la solicitud (INITIAL) tal como lo envió el transporte. */
  readonly solicitud: string;
  readonly original: readonly number[];
}

describe('respaldo manual desde la interfaz', () => {
  it('«Respaldar» envía una vez y deja la foto respaldada en el ledger durable, con la misma foto y la misma operación', async () => {
    const fabrica = new IDBFactory();
    const fotos = await abrirFotosLocal(itinerario, { fabrica });
    const captura = crearCapturaFoto(itinerario,
      { tipo: 'parada', viajeId: itinerario.id, paradaId: itinerario.dias[0].paradas[0].id },
      new File([new Uint8Array(bytes)], 'calle.png', { type: 'image/png', lastModified: 17 }), 1_000, { uuid: () => fotoId });
    await fotos.guardarOriginal(captura);

    const peticiones: Peticion[] = [];
    const acuses: string[] = [];
    // Puerto HTTP explícito: acuse 201 canónico para la solicitud recibida, construido con los codecs reales.
    const enviar: typeof fetch = async (entrada, opciones) => {
      const cuerpo = opciones?.body as FormData;
      const solicitud = cuerpo.get('solicitud') as string;
      const original = cuerpo.get('original') as Blob;
      peticiones.push({ url: String(entrada), metodo: opciones?.method, campos: [...cuerpo.keys()], solicitud,
        original: [...new Uint8Array(await original.arrayBuffer())] });
      const s = deserializarSolicitudRespaldo(itinerario, solicitud);
      const acuse = serializarReciboRespaldo(itinerario, { version: 1, tipo: 'acuse-respaldo', viajeId: s.viajeId,
        operacionId: s.operacionId, fotoId: s.fotoId, original: s.original, objetoOriginalDurable: true, metadatosDurables: true });
      acuses.push(acuse);
      return new Response(acuse, { status: 201,
        headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' } });
    };
    const incorporadas: MetadatosFoto[] = [];
    const respaldo = crearRespaldoFotos({ plan: itinerario, composicion, puerto: () => fotos,
      incorporar: (m) => { incorporadas.push(m); }, fetch: enviar, fabricaLedger: fabrica,
      uuidOperacion: () => operacionId, enLinea: () => true });
    try {
      // Fixture listo antes de la acción: la captura original está en PhotoDB.
      expect(await fotos.leerMetadatos(fotoId)).toEqual(captura.metadatos);

      const resultado = await respaldo.respaldar(fotoId);
      // Lectura tardía e independiente del ledger real (otra conexión a la misma base), antes de comprobar nada.
      const otra = await abrirRespaldoFotosLocal(itinerario, fotos, { fabrica });
      const durable = await otra.leer(fotoId);
      otra.cerrar();

      // Una acción explícita, un POST (el esqueleto neutro no envía nada).
      expect(peticiones).toHaveLength(1);
      const [p] = peticiones;
      expect(p).toMatchObject({ url: `${origen}/api/fotos/respaldo`, metodo: 'POST', campos: ['solicitud', 'original'],
        original: bytes });
      expect(deserializarSolicitudRespaldo(itinerario, p.solicitud)).toMatchObject({ viajeId: itinerario.id, fotoId, operacionId });
      expect(resultado).toEqual({ tipo: 'respaldada' });
      // Lo durable, no el resultado optimista: misma foto, misma operación y el acuse exacto que contestó el servidor.
      expect(durable).toMatchObject({ fotoId, operacionId, fase: 'respaldada', enviada: true, pausada: false });
      expect(durable?.recibo).toEqual(deserializarReciboRespaldo(itinerario, acuses[0]));
      expect(await respaldo.leer(fotoId)).toEqual({ tipo: 'respaldada' });
      // Respaldar no toca PhotoDB ni indexa nada en la interfaz.
      expect(await fotos.leerMetadatos(fotoId)).toEqual(captura.metadatos);
      expect(incorporadas).toEqual([]);
    } finally {
      respaldo.cerrar();
      fotos.cerrar();
    }
  });
});

// ---------- U1–U16: misma base real (PhotoDB, ledger, transporte, listado y descarga de las bibliotecas) ----------

/** Fotos remotas del catálogo (UUIDv4 en orden ascendente) y otra foto local con su propia operación. */
const R1 = '72345678-1234-4123-8123-123456789abc';
const R2 = '82345678-1234-4123-8123-123456789abc';
const R3 = '92345678-1234-4123-8123-123456789abc';
const R4 = 'a2345678-1234-4123-8123-123456789abc';
const R5 = 'b2345678-1234-4123-8123-123456789abc';
const R6 = 'c2345678-1234-4123-8123-123456789abc';
const otroId = 'd2345678-1234-4123-8123-123456789abc';
const operacionRemota = 'e2345678-1234-4123-8123-123456789abc';
const operacionBloqueada = 'f2345678-1234-4123-8123-123456789abc';
const destino = { tipo: 'parada', viajeId: itinerario.id, paradaId: itinerario.dias[0].paradas[0].id } as const;
const URL_LISTADO = `${origen}/api/fotos/listado`;
const CABECERAS_LISTADO = { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'private, no-store',
  Vary: 'Cookie', Pragma: 'no-cache', 'X-Content-Type-Options': 'nosniff' };
const CABECERAS_JSON = { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' };

interface Llamada {
  readonly tipo: 'subida' | 'listado' | 'descarga';
  readonly url: string;
  readonly senal: AbortSignal | null;
  readonly solicitud?: SolicitudRespaldo;
}
/** Respuestas del servidor simulado; sin manejador, la petición es un fallo de la prueba. */
interface Escenario {
  readonly subida?: (s: SolicitudRespaldo) => Response | Promise<Response>;
  readonly listado?: (url: string) => Response | Promise<Response>;
  readonly descarga?: (fotoId: string) => Response | Promise<Response>;
}
interface OpcionesMontaje {
  readonly composicion?: ComposicionRespaldoFotos;
  readonly enLinea?: () => boolean;
  /** Puerto a medida (otro PhotoDB, un almacén lleno…); por defecto el PhotoDB real de la prueba. */
  readonly puerto?: (fotos: FotosLocal) => () => FotosLocal | null;
}
interface Montaje {
  readonly fabrica: IDBFactory;
  readonly fotos: FotosLocal;
  readonly respaldo: RespaldoFotos;
  readonly llamadas: Llamada[];
  readonly incorporadas: MetadatosFoto[];
  readonly cambios: CambioRespaldo[];
  readonly blobs: Blob[];
  readonly revocadas: string[];
  lecturasPuerto(): number;
  cerrar(): void;
}

function diferido<T>() {
  let resolver!: (valor: T) => void;
  const promesa = new Promise<T>((ok) => { resolver = ok; });
  return { promesa, resolver };
}
function capturaLocal(id: string, o: { readonly nombre?: string; readonly lastModified?: number; readonly incorporada?: number } = {}) {
  return crearCapturaFoto(itinerario, destino, new File([new Uint8Array(bytes)], o.nombre ?? 'calle.png',
    { type: 'image/png', lastModified: o.lastModified ?? 17 }), o.incorporada ?? 1_000, { uuid: () => id });
}
function originalRemoto(id: string, nombre = 'remota.png'): OriginalRespaldo {
  return { formato: 1, fotoId: id, destino, nombre, mimeDeclarado: 'image/png', ultimaModificacion: 5, incorporada: 2_000,
    bytesOriginal: bytes.length };
}
/** INITIAL canónico de una foto respaldada desde el otro móvil. */
function inicial(o: OriginalRespaldo): string {
  return serializarSolicitudRespaldo(itinerario, { version: 1, tipo: 'solicitud-respaldo', viajeId: itinerario.id,
    operacionId: operacionRemota, fotoId: o.fotoId, original: o });
}
function pagina(iniciales: readonly string[], continuacion: string | null): Response {
  const texto = serializarPaginaListadoFotos(itinerario, { version: 1, tipo: 'listado-respaldos', viajeId: itinerario.id,
    solicitudesIniciales: [...iniciales], continuacion }, 1, 404_231);
  return new Response(texto, { status: 200, headers: CABECERAS_LISTADO });
}
function binario(contenido: readonly number[]): Response {
  return new Response(new Uint8Array(contenido), { status: 200,
    headers: { 'Content-Type': 'application/octet-stream', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' } });
}
function acuse(s: SolicitudRespaldo, original: OriginalRespaldo = s.original): Response {
  return new Response(serializarReciboRespaldo(itinerario, { version: 1, tipo: 'acuse-respaldo', viajeId: s.viajeId,
    operacionId: s.operacionId, fotoId: s.fotoId, original, objetoOriginalDurable: true, metadatosDurables: true }),
  { status: 201, headers: CABECERAS_JSON });
}
const servidorCaido = () => new Response('{"error":"no-disponible"}', { status: 503, headers: CABECERAS_JSON });

/** Puerto HTTP explícito: el listado llega como Request; subida y descarga, como (url, init). */
function puertoHttp(escenario: Escenario, llamadas: Llamada[]): typeof fetch {
  return async (entrada, opciones) => {
    if (entrada instanceof Request) {
      llamadas.push({ tipo: 'listado', url: entrada.url, senal: entrada.signal });
      if (!escenario.listado) throw new Error('Listado inesperado');
      return escenario.listado(entrada.url);
    }
    const url = String(entrada);
    const senal = opciones?.signal ?? null;
    if (url === `${origen}/api/fotos/respaldo`) {
      const s = deserializarSolicitudRespaldo(itinerario, (opciones?.body as FormData).get('solicitud'));
      llamadas.push({ tipo: 'subida', url, senal, solicitud: s });
      if (!escenario.subida) throw new Error('Subida inesperada');
      return escenario.subida(s);
    }
    llamadas.push({ tipo: 'descarga', url, senal });
    const id = /\/api\/fotos\/([^/]+)\/original$/.exec(url)?.[1];
    if (!id || !escenario.descarga) throw new Error('Descarga inesperada');
    return escenario.descarga(decodeURIComponent(id));
  };
}
async function montar(escenario: Escenario = {}, opciones: OpcionesMontaje = {}): Promise<Montaje> {
  const fabrica = new IDBFactory();
  const fotos = await abrirFotosLocal(itinerario, { fabrica });
  const llamadas: Llamada[] = [];
  const incorporadas: MetadatosFoto[] = [];
  const cambios: CambioRespaldo[] = [];
  const blobs: Blob[] = [];
  const revocadas: string[] = [];
  const puerto = opciones.puerto?.(fotos) ?? (() => fotos);
  let lecturas = 0;
  const respaldo = crearRespaldoFotos({ plan: itinerario, composicion: opciones.composicion ?? composicion,
    puerto: () => { lecturas++; return puerto(); }, incorporar: (m) => { incorporadas.push(m); },
    fetch: puertoHttp(escenario, llamadas), fabricaLedger: fabrica, uuidOperacion: () => operacionId,
    enLinea: opciones.enLinea ?? (() => true), alCambiar: (que) => { cambios.push(que); },
    crearUrl: (b) => { blobs.push(b); return `blob:prueba/${blobs.length}`; }, revocarUrl: (u) => { revocadas.push(u); } });
  return { fabrica, fotos, respaldo, llamadas, incorporadas, cambios, blobs, revocadas, lecturasPuerto: () => lecturas,
    cerrar() { respaldo.cerrar(); fotos.cerrar(); } };
}
const de = (m: Montaje, tipo: Llamada['tipo']) => m.llamadas.filter((l) => l.tipo === tipo);
const nombresLedger = async (fabrica: IDBFactory) => (await fabrica.databases())
  .map((b) => b.name ?? '').filter((n) => n.startsWith('itinerario-respaldo-fotos:'));
/** Lectura independiente del ledger real (otra conexión a la misma base). */
async function leerLedger(m: Montaje) {
  const otra = await abrirRespaldoFotosLocal(itinerario, m.fotos, { fabrica: m.fabrica });
  try { return await otra.listar(); } finally { otra.cerrar(); }
}
function filas(m: Montaje): readonly FilaCatalogo[] {
  const c = m.respaldo.catalogo;
  if (c.tipo !== 'pagina') throw new Error(`Se esperaba una página y hay ${c.tipo}`);
  return c.filas;
}
async function bytesDe(b: Blob | null): Promise<number[]> {
  return b ? [...new Uint8Array(await b.arrayBuffer())] : [];
}

describe('respaldo manual: activación, ledger y envíos (U1–U8)', () => {
  it('U1 · sin composición no se construye nada: ni ledger, ni red, ni lectura de PhotoDB', async () => {
    const fabrica = new IDBFactory();
    const fotos = await abrirFotosLocal(itinerario, { fabrica });
    let lecturas = 0;
    let peticiones = 0;
    const respaldo = componerRespaldoFotos(null, { plan: itinerario, puerto: () => { lecturas++; return fotos; },
      incorporar: () => { throw new Error('Nada que incorporar'); },
      fetch: async () => { peticiones++; throw new Error('Sin red'); }, fabricaLedger: fabrica });
    try {
      expect(respaldo).toBeNull();
      expect(lecturas).toBe(0);
      expect(peticiones).toBe(0);
      expect(await nombresLedger(fabrica)).toEqual([]);
    } finally {
      fotos.cerrar();
    }
  });

  it('U2 · con composición el ledger se abre perezoso, al primer uso, y sin crear entradas', async () => {
    const m = await montar();
    try {
      // Crear el controlador no lee PhotoDB, no abre el ledger ni consulta nada.
      expect(m.lecturasPuerto()).toBe(0);
      expect(m.respaldo.fase).toBe('cerrada');
      expect(m.respaldo.catalogo).toEqual({ tipo: 'reposo' });
      expect(m.respaldo.estado(fotoId)).toBeNull();
      expect(await nombresLedger(m.fabrica)).toEqual([]);

      await m.fotos.guardarOriginal(capturaLocal(fotoId));
      expect(await m.respaldo.leer(fotoId)).toEqual({ tipo: 'sin-respaldo' });
      expect(m.respaldo.fase).toBe('lista');
      expect(m.respaldo.estado(fotoId)).toEqual({ tipo: 'sin-respaldo' });
      // La interfaz se entera para repintar desde lo leído, sin otra lectura.
      expect(m.cambios).toContainEqual({ tipo: 'foto', fotoId });
      expect(await nombresLedger(m.fabrica)).toHaveLength(1);
      expect(await m.respaldo.resumen()).toEqual([]);
      expect(await m.respaldo.estimar(fotoId)).toEqual({ bytesOriginal: bytes.length });
      expect(await leerLedger(m)).toEqual([]);
      expect(m.llamadas).toEqual([]);
    } finally {
      m.cerrar();
    }
  });

  it('U4 · un 503 deja el envío sin confirmar (marca durable) y reabrir no reenvía nada solo', async () => {
    const m = await montar({ subida: () => servidorCaido() });
    try {
      await m.fotos.guardarOriginal(capturaLocal(fotoId));
      const r = await m.respaldo.respaldar(fotoId);
      expect(r).toEqual({ tipo: 'sin-confirmar' });
      expect(textoResultadoRespaldo(r)).toBe(COPIA_SIN_CONFIRMAR);
      expect(COPIA_SIN_CONFIRMAR).toBe('Respaldo sin confirmar. Conserva el original; reintentar no garantiza recuperarlo.');
      expect(de(m, 'subida')).toHaveLength(1);
      expect(await leerLedger(m)).toEqual([expect.objectContaining({ fotoId, operacionId, fase: 'enviada', enviada: true,
        pausada: false, recibo: null })]);

      // Como al reabrir la app: otra instancia lee lo durable y no envía, consulta ni reintenta nada.
      let peticiones = 0;
      const reabierto = crearRespaldoFotos({ plan: itinerario, composicion, puerto: () => m.fotos, incorporar: () => {},
        fetch: async () => { peticiones++; throw new Error('Sin red'); }, fabricaLedger: m.fabrica, enLinea: () => true });
      try {
        expect(await reabierto.leer(fotoId)).toEqual({ tipo: 'sin-confirmar' });
        expect(await reabierto.resumen()).toEqual([expect.objectContaining({ fotoId, estado: { tipo: 'sin-confirmar' } })]);
        expect(reabierto.catalogo).toEqual({ tipo: 'reposo' });
        expect(peticiones).toBe(0);
      } finally {
        reabierto.cerrar();
      }
      expect(de(m, 'subida')).toHaveLength(1);
    } finally {
      m.cerrar();
    }
  });

  it('U5 · reintentar reenvía la MISMA operación de la misma foto; respaldada no vuelve a salir', async () => {
    let n = 0;
    const m = await montar({ subida: (s) => (++n === 1 ? servidorCaido() : acuse(s)) });
    try {
      await m.fotos.guardarOriginal(capturaLocal(fotoId));
      expect(await m.respaldo.respaldar(fotoId)).toEqual({ tipo: 'sin-confirmar' });
      expect(await m.respaldo.reintentar(fotoId)).toEqual({ tipo: 'respaldada' });
      const [primera, segunda] = de(m, 'subida').map((l) => l.solicitud);
      expect(primera).toMatchObject({ fotoId, operacionId });
      expect(segunda).toEqual(primera);
      expect(await leerLedger(m)).toEqual([expect.objectContaining({ fotoId, operacionId, fase: 'respaldada' })]);

      // Ya respaldada: ni «Respaldar» ni «Reintentar» envían otra vez.
      expect(await m.respaldo.respaldar(fotoId)).toEqual({ tipo: 'respaldada' });
      expect(await m.respaldo.reintentar(fotoId)).toEqual({ tipo: 'respaldada' });
      // Reintentar nunca prepara: una foto sin respaldo no gana una operación nueva.
      await m.fotos.guardarOriginal(capturaLocal(otroId, { nombre: 'otra.png' }));
      expect(await m.respaldo.reintentar(otroId)).toEqual({ tipo: 'no-disponible' });
      expect(await leerLedger(m)).toHaveLength(1);
      expect(de(m, 'subida')).toHaveLength(2);
    } finally {
      m.cerrar();
    }
  });

  it('U6 · pausar durante el envío aborta, el acuse tardío no confirma y reanudar usa la misma operación', async () => {
    const tarde = diferido<void>();
    let n = 0;
    const m = await montar({ subida: (s) => (++n === 1 ? tarde.promesa.then(() => acuse(s)) : acuse(s)) });
    try {
      await m.fotos.guardarOriginal(capturaLocal(fotoId));
      const envio = m.respaldo.respaldar(fotoId);
      await vi.waitFor(() => expect(de(m, 'subida')).toHaveLength(1));
      expect(m.respaldo.enCurso(fotoId)).toBe(true);
      expect(m.respaldo.estado(fotoId)).toEqual({ tipo: 'enviando' });
      // Una carga a la vez: otra acción no se cuela ni se encola.
      expect(await m.respaldo.respaldar(otroId)).toEqual({ tipo: 'ocupada' });

      expect(await m.respaldo.pausar(fotoId)).toEqual({ tipo: 'pausado' });
      expect(de(m, 'subida')[0].senal?.aborted).toBe(true);
      // El servidor contesta tarde con un acuse válido: no se aplica (la carga ya no es la vigente).
      tarde.resolver();
      expect(await envio).toEqual({ tipo: 'pausado' });
      expect(await leerLedger(m)).toEqual([expect.objectContaining({ fotoId, operacionId, fase: 'enviada', enviada: true,
        pausada: true, recibo: null })]);
      expect(await m.respaldo.leer(fotoId)).toEqual({ tipo: 'pausado' });

      expect(await m.respaldo.reintentar(fotoId)).toEqual({ tipo: 'respaldada' });
      const [primera, segunda] = de(m, 'subida').map((l) => l.solicitud);
      expect(segunda).toEqual(primera);
      expect(await leerLedger(m)).toEqual([expect.objectContaining({ operacionId, fase: 'respaldada', pausada: false })]);
    } finally {
      m.cerrar();
    }
  });

  it('U7 · un acuse que no corresponde no confirma nada y una bloqueada no se vuelve a enviar', async () => {
    const m = await montar({ subida: (s) => acuse(s, { ...s.original, nombre: 'otra.png' }) });
    try {
      await m.fotos.guardarOriginal(capturaLocal(fotoId));
      expect(await m.respaldo.respaldar(fotoId)).toEqual({ tipo: 'sin-confirmar' });
      expect(await leerLedger(m)).toEqual([expect.objectContaining({ fotoId, fase: 'enviada', recibo: null })]);

      // Bloqueada sembrada con la API real del ledger: un recibo contradictorio de la operación ya enviada.
      const segunda = capturaLocal(otroId, { nombre: 'segunda.png' });
      await m.fotos.guardarOriginal(segunda);
      const ledger = await abrirRespaldoFotosLocal(itinerario, m.fotos, { fabrica: m.fabrica });
      try {
        const preparada = await ledger.preparar(segunda, operacionBloqueada);
        await ledger.marcarEnviada({ fotoId: otroId, operacionId: operacionBloqueada, original: preparada.original });
        await ledger.confirmarRecibo({ version: 1, tipo: 'acuse-respaldo', viajeId: itinerario.id,
          operacionId: operacionBloqueada, fotoId: otroId, original: { ...preparada.original, nombre: 'contradictoria.png' },
          objetoOriginalDurable: true, metadatosDurables: true });
      } finally {
        ledger.cerrar();
      }
      expect(await m.respaldo.leer(otroId)).toEqual({ tipo: 'bloqueada' });
      expect(await m.respaldo.respaldar(otroId)).toEqual({ tipo: 'bloqueada' });
      expect(await m.respaldo.reintentar(otroId)).toEqual({ tipo: 'bloqueada' });
      expect(textoResultadoRespaldo({ tipo: 'bloqueada' }))
        .toBe('El servidor contestó algo que no corresponde a esta foto. Se conserva todo y no se vuelve a enviar.');
      expect(de(m, 'subida')).toHaveLength(1);
      expect((await leerLedger(m)).find((e) => e.fotoId === otroId))
        .toMatchObject({ operacionId: operacionBloqueada, fase: 'bloqueada', enviada: true, pausada: false, recibo: null });
    } finally {
      m.cerrar();
    }
  });

  it('U8 · sin conexión no se prepara, no se marca envío y no sale nada', async () => {
    const m = await montar({ subida: (s) => acuse(s) }, { enLinea: () => false });
    try {
      await m.fotos.guardarOriginal(capturaLocal(fotoId));
      expect(await m.respaldo.respaldar(fotoId)).toEqual({ tipo: 'sin-conexion' });
      expect(await m.respaldo.reintentar(fotoId)).toEqual({ tipo: 'sin-conexion' });
      expect(textoResultadoRespaldo({ tipo: 'sin-conexion' })).toBe('Sin conexión: no se puede respaldar ahora.');
      expect(m.llamadas).toEqual([]);
      // Ni siquiera se abrió el ledger ni se leyó PhotoDB.
      expect(m.lecturasPuerto()).toBe(0);
      expect(await nombresLedger(m.fabrica)).toEqual([]);
    } finally {
      m.cerrar();
    }
  });
});

describe('catálogo de fotos respaldadas (U9–U16)', () => {
  it('U9 · una página por toque, continuación RAW sin seguirla sola y nada local cambia', async () => {
    const r1 = originalRemoto(R1);
    // R2 es la misma foto que ya hay en este móvil (misma identidad de original).
    const local = capturaLocal(R2, { nombre: 'r2.png', lastModified: 9, incorporada: 3_000 });
    const r2 = copiarOriginalRespaldo(itinerario, local.metadatos);
    const cursor = serializarCursorListadoFotos(itinerario, { version: 1, viajeId: itinerario.id, despuesDe: R1, hasta: R2 });
    const siguiente = `${URL_LISTADO}?continuacion=${encodeURIComponent(cursor)}`;
    const m = await montar({ listado: (url) => (url === URL_LISTADO ? pagina([inicial(r1)], cursor)
      : url === siguiente ? pagina([inicial(r2)], null) : new Response(null, { status: 400 })) });
    try {
      await m.fotos.guardarOriginal(local);
      const antes = await m.fotos.listar();
      expect(textoCatalogo(m.respaldo.catalogo, 1))
        .toBe('Fotos respaldadas desde cualquiera de los dos móviles. Se consultan de una en una.');

      await m.respaldo.listar('principio');
      expect(de(m, 'listado').map((l) => l.url)).toEqual([URL_LISTADO]);
      expect(m.respaldo.catalogo).toEqual({ tipo: 'pagina', primera: true, hayMas: true,
        filas: [{ original: r1, local: 'ausente', accion: 'guardar' }] });
      expect(textoCatalogo(m.respaldo.catalogo, 1)).toBe('Fotos respaldadas confirmadas en el servidor.');

      await m.respaldo.listar('siguiente');
      expect(de(m, 'listado').map((l) => l.url)).toEqual([URL_LISTADO, siguiente]);
      expect(m.respaldo.catalogo).toEqual({ tipo: 'pagina', primera: false, hayMas: false,
        filas: [{ original: r2, local: 'registrada', accion: 'comprobar' }] });
      expect(textoFilaCatalogo(filas(m)[0])).toBe('Foto registrada en este móvil.');

      // Sin continuación no hay «Siguientes»; «Desde el principio» es otra acción y otro GET.
      await m.respaldo.listar('siguiente');
      expect(de(m, 'listado')).toHaveLength(2);
      await m.respaldo.listar('principio');
      expect(de(m, 'listado')).toHaveLength(3);

      // Listar nunca es acuse ni envío: PhotoDB, ledger e interfaz quedan igual.
      expect(await m.fotos.listar()).toEqual(antes);
      expect(await leerLedger(m)).toEqual([]);
      expect(m.incorporadas).toEqual([]);
      expect(de(m, 'subida')).toEqual([]);
      expect(de(m, 'descarga')).toEqual([]);
    } finally {
      m.cerrar();
    }
  });

  it('U9 · una página vacía no dice que no haya envíos sin confirmar', async () => {
    const cursor = serializarCursorListadoFotos(itinerario, { version: 1, viajeId: itinerario.id, despuesDe: R1, hasta: R2 });
    const respuestas = [() => pagina([], null), () => pagina([inicial(originalRemoto(R1))], cursor), () => pagina([], null)];
    const m = await montar({ listado: () => respuestas.shift()!() });
    try {
      await m.respaldo.listar('principio');
      expect(m.respaldo.catalogo).toEqual({ tipo: 'pagina', filas: [], primera: true, hayMas: false });
      expect(textoCatalogo(m.respaldo.catalogo, 1))
        .toBe('No hay fotos respaldadas confirmadas en el servidor. No significa que no haya envíos sin confirmar.');
      await m.respaldo.listar('principio');
      await m.respaldo.listar('siguiente');
      expect(m.respaldo.catalogo).toEqual({ tipo: 'pagina', filas: [], primera: false, hayMas: false });
      expect(textoCatalogo(m.respaldo.catalogo, 1)).toBe('Esta página no tiene fotos respaldadas confirmadas.');
      expect(de(m, 'listado')).toHaveLength(3);
    } finally {
      m.cerrar();
    }
  });

  it('U10 · sin sesión, continuación rechazada, servidor, respuesta inválida, plazo y cancelación no guardan nada', async () => {
    const respuestas = [
      () => new Response(null, { status: 401 }),
      () => new Response(null, { status: 400 }),
      () => servidorCaido(),
      () => new Response('{}', { status: 200, headers: { ...CABECERAS_LISTADO, 'Cache-Control': 'no-store' } }),
    ];
    const m = await montar({ listado: () => respuestas.shift()!() });
    try {
      const textos: string[] = [];
      for (let i = 0; i < 4; i++) {
        await m.respaldo.listar('principio');
        textos.push(textoCatalogo(m.respaldo.catalogo, 1));
      }
      expect(textos).toEqual([
        'Este móvil no tiene sesión en el servidor.',
        'Esa continuación ya no vale.',
        'El servidor no respondió como se esperaba. No se ha cambiado nada en este móvil.',
        'La respuesta no es válida; no se ha guardado nada.',
      ]);
      expect(de(m, 'listado')).toHaveLength(4);
      expect(await leerLedger(m)).toEqual([]);
      expect(await m.fotos.listar()).toEqual([]);
    } finally {
      m.cerrar();
    }

    // Plazo propio del presupuesto: el servidor no contesta y la consulta se detiene sola, sin reintentar.
    const colgada = diferido<Response>();
    const lenta = await montar({ listado: () => colgada.promesa },
      { composicion: { ...composicion, listado: { ...composicion.listado, plazoMs: 50 } } });
    try {
      await lenta.respaldo.listar('principio');
      expect(lenta.respaldo.catalogo).toEqual({ tipo: 'detenido', motivo: 'plazo' });
      expect(textoCatalogo(lenta.respaldo.catalogo, 1)).toBe('Tardó demasiado; no se ha guardado nada.');
      expect(de(lenta, 'listado')).toHaveLength(1);
    } finally {
      colgada.resolver(pagina([], null));
      lenta.cerrar();
    }

    // Cancelar: el resultado llega enseguida, pero la consulta sigue ocupada hasta que su IO se asienta.
    const pendiente = diferido<Response>();
    let n = 0;
    const c = await montar({ listado: () => (++n === 1 ? pendiente.promesa : pagina([], null)) });
    try {
      const consulta = c.respaldo.listar('principio');
      await vi.waitFor(() => expect(de(c, 'listado')).toHaveLength(1));
      expect(c.respaldo.catalogo).toEqual({ tipo: 'consultando', desde: 'principio' });
      c.respaldo.cancelarListado();
      await consulta;
      expect(c.respaldo.catalogo).toEqual({ tipo: 'detenido', motivo: 'cancelada' });
      expect(textoCatalogo(c.respaldo.catalogo, 1)).toBe('Consulta cancelada; no se ha guardado nada.');
      expect(de(c, 'listado')[0].senal?.aborted).toBe(true);
      await c.respaldo.listar('principio');
      expect(c.respaldo.catalogo).toEqual({ tipo: 'fallo', motivo: 'ocupado' });
      expect(de(c, 'listado')).toHaveLength(1);
      pendiente.resolver(pagina([inicial(originalRemoto(R1))], null));
      await vi.waitFor(async () => {
        await c.respaldo.listar('principio');
        expect(c.respaldo.catalogo).toEqual({ tipo: 'pagina', filas: [], primera: true, hayMas: false });
      });
      expect(de(c, 'listado')).toHaveLength(2);
    } finally {
      c.cerrar();
    }
  });

  it('U10 · si cambia el PhotoDB durante la consulta, la página que llega tarde no se pinta', async () => {
    const pendiente = diferido<Response>();
    const otraFabrica = new IDBFactory();
    const otro = await abrirFotosLocal(itinerario, { fabrica: otraFabrica });
    let actual: FotosLocal | null = null;
    const m = await montar({ listado: () => pendiente.promesa }, { puerto: (fotos) => { actual = fotos; return () => actual; } });
    try {
      const consulta = m.respaldo.listar('principio');
      await vi.waitFor(() => expect(de(m, 'listado')).toHaveLength(1));
      actual = otro;
      // Cualquier acción observa el cambio: cancela la consulta y descarta lo que llegue después.
      expect(await m.respaldo.leer(fotoId)).toEqual({ tipo: 'sin-respaldo' });
      expect(m.respaldo.catalogo).toEqual({ tipo: 'reposo' });
      pendiente.resolver(pagina([inicial(originalRemoto(R1))], null));
      await consulta;
      expect(m.respaldo.catalogo).toEqual({ tipo: 'reposo' });
      expect(de(m, 'listado')[0].senal?.aborted).toBe(true);
    } finally {
      m.cerrar();
      otro.cerrar();
    }
  });

  it('U11 · guardar y comprobar: un GET por toque, se incorpora una vez y borradas o colisiones no piden nada', async () => {
    const r1 = originalRemoto(R1);
    const local2 = capturaLocal(R2, { nombre: 'r2.png', lastModified: 9, incorporada: 3_000 });
    const r2 = copiarOriginalRespaldo(itinerario, local2.metadatos);
    const paginas: string[][] = [[inicial(r1)], [inicial(r2)], [inicial(originalRemoto(R3))], [inicial(originalRemoto(R4))],
      [inicial(originalRemoto(R5))], [inicial(originalRemoto(R6))]];
    const m = await montar({ listado: () => pagina(paginas.shift()!, null), descarga: () => binario(bytes) });
    try {
      await m.fotos.guardarOriginal(local2);
      await m.fotos.guardarOriginal(capturaLocal(R3, { nombre: 'r3.png' }));
      await m.fotos.borrarLocal(R3);
      // R4 existe aquí con otra identidad (otro nombre): no es la del servidor.
      await m.fotos.guardarOriginal(capturaLocal(R4, { nombre: 'distinta.png' }));

      // Ausente: «Guardar en este móvil» → un GET, guardada e incorporada una vez.
      await m.respaldo.listar('principio');
      expect(filas(m)[0]).toEqual({ original: r1, local: 'ausente', accion: 'guardar' });
      await m.respaldo.guardar(R1);
      expect(de(m, 'descarga').map((l) => l.url)).toEqual([`${origen}/api/fotos/${R1}/original`]);
      expect(filas(m)[0]).toMatchObject({ estado: 'guardada', local: 'registrada' });
      expect(textoFilaCatalogo(filas(m)[0])).toBe('Guardada en este móvil.');
      expect(m.incorporadas.map((x) => x.fotoId)).toEqual([R1]);
      expect(copiarOriginalRespaldo(itinerario, m.incorporadas[0])).toEqual(r1);
      expect(await bytesDe(await m.fotos.leerOriginal(R1))).toEqual(bytes);

      // Registrada: «Comprobar y guardar» descarga para comparar; misma foto, nada nuevo escrito.
      await m.respaldo.listar('principio');
      expect(filas(m)[0]).toEqual({ original: r2, local: 'registrada', accion: 'comprobar' });
      await m.respaldo.guardar(R2);
      expect(de(m, 'descarga')).toHaveLength(2);
      expect(filas(m)[0]).toMatchObject({ estado: 'comprobada' });
      expect(textoFilaCatalogo(filas(m)[0])).toBe('Comprobada: es la misma foto que ya había en este móvil.');
      expect(m.incorporadas.map((x) => x.fotoId)).toEqual([R1, R2]);
      expect(await m.fotos.leerMetadatos(R2)).toEqual(local2.metadatos);

      // Borrada aquí o con otra identidad: sin acción y sin petición.
      await m.respaldo.listar('principio');
      expect(filas(m)[0]).toMatchObject({ local: 'borrada', accion: null });
      expect(textoFilaCatalogo(filas(m)[0])).toBe('Borrada en este móvil: aquí no se puede volver a guardar.');
      await m.respaldo.guardar(R3);
      await m.respaldo.listar('principio');
      expect(filas(m)[0]).toMatchObject({ local: 'otra', accion: null });
      expect(textoFilaCatalogo(filas(m)[0])).toBe('Otra foto de este móvil usa su identidad.');
      await m.respaldo.guardar(R4);
      expect(de(m, 'descarga')).toHaveLength(2);

      // Carreras: borrada o con colisión DESPUÉS de listar → la descarga lo ve antes del GET (0 peticiones).
      await m.respaldo.listar('principio');
      expect(filas(m)[0]).toMatchObject({ local: 'ausente', accion: 'guardar' });
      await m.fotos.guardarOriginal(capturaLocal(R5, { nombre: 'r5.png' }));
      await m.fotos.borrarLocal(R5);
      await m.respaldo.guardar(R5);
      expect(filas(m)[0]).toMatchObject({ estado: 'no-guardada' });
      expect(filas(m)[0].captura).toBeUndefined();
      await m.respaldo.listar('principio');
      await m.fotos.guardarOriginal(capturaLocal(R6, { nombre: 'colision.png' }));
      await m.respaldo.guardar(R6);
      expect(filas(m)[0]).toMatchObject({ estado: 'no-guardada' });
      expect(de(m, 'descarga')).toHaveLength(2);
      expect(m.incorporadas).toHaveLength(2);
      // Guardar nunca es acuse ni envío.
      expect(await leerLedger(m)).toEqual([]);
      expect(de(m, 'subida')).toEqual([]);
    } finally {
      m.cerrar();
    }
  });

  it('U12 · sin espacio, los bytes descargados se ofrecen como archivo octet-stream y la URL se revoca', async () => {
    const m = await montar({ listado: () => pagina([inicial(originalRemoto(R1))], null), descarga: () => binario(bytes) }, {
      // El mismo PhotoDB real, salvo que guardar un original falla por cuota.
      puerto: (fotos) => {
        const llena: FotosLocal = {
          listar: () => fotos.listar(), leerMetadatos: (id) => fotos.leerMetadatos(id),
          leerOriginal: (id) => fotos.leerOriginal(id), leerMiniatura: (id) => fotos.leerMiniatura(id),
          guardarOriginal: async () => { throw new DOMException('Sin espacio', 'QuotaExceededError'); },
          guardarMiniatura: (id, b, ancho, alto) => fotos.guardarMiniatura(id, b, ancho, alto),
          registrarFalloMiniatura: (id, motivo) => fotos.registrarFalloMiniatura(id, motivo),
          borrarLocal: (id) => fotos.borrarLocal(id), cerrar: () => {},
        };
        return () => llena;
      },
    });
    try {
      await m.respaldo.listar('principio');
      await m.respaldo.guardar(R1);
      expect(de(m, 'descarga')).toHaveLength(1);
      expect(filas(m)[0]).toMatchObject({ estado: 'no-guardada', captura: true });
      expect(textoFilaCatalogo(filas(m)[0])).toBe('No se pudo guardar aquí.');
      expect(await m.fotos.leerMetadatos(R1)).toBeNull();
      expect(m.incorporadas).toEqual([]);

      const archivo = m.respaldo.descargarArchivo(R1);
      expect(archivo).toEqual({ url: 'blob:prueba/1', nombre: 'remota.png' });
      expect(m.blobs[0].type).toBe('application/octet-stream');
      expect(await bytesDe(m.blobs[0])).toEqual(bytes);
      m.respaldo.soltarUrl('blob:prueba/1');
      m.respaldo.soltarUrl('blob:prueba/1');
      expect(m.revocadas).toEqual(['blob:prueba/1']);
      // Lo que queda entregado al cerrar también se revoca; nada pasa a PhotoDB ni al ledger.
      expect(m.respaldo.descargarArchivo(R1)).toEqual({ url: 'blob:prueba/2', nombre: 'remota.png' });
      m.respaldo.cerrar();
      expect(m.revocadas).toEqual(['blob:prueba/1', 'blob:prueba/2']);
      expect(await m.fotos.leerMetadatos(R1)).toBeNull();
      expect(await leerLedger(m)).toEqual([]);
    } finally {
      m.cerrar();
    }
  });

  it('U13 · borrar avisa según lo que consta; un envío propio se pausa antes y el ledger se conserva', async () => {
    const pregunta = '¿Borrar esta foto de este móvil?';
    const final = 'Si la borras, este móvil no podrá volver a guardarla. No se puede deshacer.';
    const sinRespaldo = 'No hay un respaldo confirmado en este móvil; puede que esta sea la única copia.';
    const sinConfirmar = 'Su respaldo está sin confirmar: puede que esta sea la única copia.';
    const confirmada = 'El servidor confirmó la copia al enviarla; no se ha vuelto a comprobar.';
    expect(avisoBorradoRespaldo(null)).toBe(`${pregunta} ${sinRespaldo} ${final}`);
    for (const tipo of ['sin-respaldo', 'preparado', 'ilegible'] as const) {
      expect(avisoBorradoRespaldo({ tipo })).toBe(`${pregunta} ${sinRespaldo} ${final}`);
    }
    for (const tipo of ['enviando', 'sin-confirmar', 'pausado', 'bloqueada'] as const) {
      expect(avisoBorradoRespaldo({ tipo })).toBe(`${pregunta} ${sinConfirmar} ${final}`);
    }
    expect(avisoBorradoRespaldo({ tipo: 'respaldada' })).toBe(`${pregunta} ${confirmada} ${final}`);

    const tarde = diferido<void>();
    const m = await montar({ subida: (s) => tarde.promesa.then(() => acuse(s)) });
    try {
      await m.fotos.guardarOriginal(capturaLocal(fotoId));
      const envio = m.respaldo.respaldar(fotoId);
      await vi.waitFor(() => expect(m.respaldo.enCurso(fotoId)).toBe(true));
      await vi.waitFor(() => expect(de(m, 'subida')).toHaveLength(1));
      // El orden del visor: primero la pausa propia (durable), después el borrado local explícito.
      expect(await m.respaldo.pausar(fotoId)).toEqual({ tipo: 'pausado' });
      expect(await m.fotos.borrarLocal(fotoId)).toEqual({ tipo: 'borrada', fotoId });
      tarde.resolver();
      expect(await envio).toEqual({ tipo: 'pausado' });
      // El ledger no se limpia: misma operación, marca de envío y pausa siguen ahí.
      const conservada = [expect.objectContaining({ fotoId, operacionId, fase: 'enviada', enviada: true, pausada: true,
        recibo: null })];
      expect(await leerLedger(m)).toEqual(conservada);
      // Sin la foto viva en este móvil no hay nada que reanudar: ni POST ni cambios en el ledger.
      expect(await m.respaldo.reintentar(fotoId)).toEqual({ tipo: 'no-disponible' });
      expect(await leerLedger(m)).toEqual(conservada);
      expect(de(m, 'subida')).toHaveLength(1);
    } finally {
      m.cerrar();
    }
  });

  it('U14 · si cambia el PhotoDB durante una descarga, no se escribe ni se incorpora nada', async () => {
    const pendiente = diferido<Response>();
    const otro = await abrirFotosLocal(itinerario, { fabrica: new IDBFactory() });
    let actual: FotosLocal | null = null;
    const m = await montar({ listado: () => pagina([inicial(originalRemoto(R1))], null), descarga: () => pendiente.promesa },
      { puerto: (fotos) => { actual = fotos; return () => actual; } });
    try {
      await m.respaldo.listar('principio');
      const guardado = m.respaldo.guardar(R1);
      await vi.waitFor(() => expect(de(m, 'descarga')).toHaveLength(1));
      expect(filas(m)[0]).toMatchObject({ estado: 'guardando' });
      actual = otro;
      await m.respaldo.leer(fotoId);
      expect(m.respaldo.catalogo).toEqual({ tipo: 'reposo' });
      pendiente.resolver(binario(bytes));
      await guardado;
      expect(de(m, 'descarga')[0].senal?.aborted).toBe(true);
      expect(m.incorporadas).toEqual([]);
      expect(await m.fotos.leerMetadatos(R1)).toBeNull();
      expect(await otro.leerMetadatos(R1)).toBeNull();
      expect(m.respaldo.catalogo).toEqual({ tipo: 'reposo' });
    } finally {
      m.cerrar();
      otro.cerrar();
    }
  });

  it('U15 · con origen sin HTTPS o presupuesto inválido el catálogo no existe aquí: cero peticiones', async () => {
    const malas: ComposicionRespaldoFotos[] = [
      { ...composicion, origen: 'http://itinerario.prueba' },
      { ...composicion, listado: { ...composicion.listado, maxFilas: 9 } },
      { ...composicion, listado: { ...composicion.listado, plazoMs: 0 } },
      { ...composicion, listado: { ...composicion.listado, maxBytesRetenidos: 1_000_000 } },
    ];
    for (const mala of malas) {
      const m = await montar({ listado: () => pagina([], null) }, { composicion: mala });
      try {
        await m.respaldo.listar('principio');
        expect(m.respaldo.catalogo).toEqual({ tipo: 'no-disponible' });
        expect(textoCatalogo(m.respaldo.catalogo, 1)).toBe('El catálogo no está disponible aquí.');
        // Sin reintento ni consulta: sigue sin existir.
        await m.respaldo.listar('principio');
        expect(m.respaldo.catalogo).toEqual({ tipo: 'no-disponible' });
        expect(m.llamadas).toEqual([]);
      } finally {
        m.cerrar();
      }
    }
  });

  it('U16 · el presupuesto N1 admite el plan real del viaje', async () => {
    const m = await montar({ listado: () => pagina([], null) });
    try {
      await m.respaldo.listar('principio');
      expect(m.respaldo.catalogo).toEqual({ tipo: 'pagina', filas: [], primera: true, hayMas: false });
      expect(de(m, 'listado').map((l) => l.url)).toEqual([URL_LISTADO]);
    } finally {
      m.cerrar();
    }
  });
});

describe('límite de original de la composición también en guardar y comprobar (U17–U18)', () => {
  /** Composición con política de producto 0 bytes: ningún original positivo puede bajar. */
  const sinOriginales: ComposicionRespaldoFotos = { ...composicion, maxBytesOriginal: 0 };
  /** Contenido opaco de 1 byte (válido para el protocolo; nadie lo decodifica). */
  const unByte = [0x89];
  function originalDeUnByte(id: string): OriginalRespaldo {
    return { formato: 1, fotoId: id, destino, nombre: 'un-byte.png', mimeDeclarado: 'image/png', ultimaModificacion: 5,
      incorporada: 2_000, bytesOriginal: unByte.length };
  }

  it('U17 · foto ausente de 1 byte con límite 0: «Guardar» no pide el original ni escribe nada', async () => {
    const remota = originalDeUnByte(R1);
    // El servidor simulado SÍ serviría el original (1 byte octet-stream): sin el límite, guardar lo pediría.
    const m = await montar({ listado: () => pagina([inicial(remota)], null), descarga: () => binario(unByte) },
      { composicion: sinOriginales });
    try {
      const antes = await m.fotos.listar();
      await m.respaldo.listar('principio');
      expect(de(m, 'listado').map((l) => l.url)).toEqual([URL_LISTADO]);
      expect(filas(m)).toEqual([{ original: remota, local: 'ausente', accion: 'guardar' }]);

      await m.respaldo.guardar(R1);
      // La política de la composición se aplica ANTES de cualquier GET del original (el listado no cuenta aquí).
      expect(de(m, 'descarga')).toHaveLength(0);
      expect(filas(m)[0]).toMatchObject({ estado: 'no-guardada' });
      expect(filas(m)[0].captura).toBeUndefined();
      expect(m.incorporadas).toEqual([]);
      expect(await m.fotos.leerMetadatos(R1)).toBeNull();
      expect(await m.fotos.listar()).toEqual(antes);
      expect(await leerLedger(m)).toEqual([]);
      expect(de(m, 'subida')).toEqual([]);
    } finally {
      m.cerrar();
    }
  });

  it('U18 · foto registrada de 1 byte con límite 0: «Comprobar y guardar» no pide el original ni toca nada', async () => {
    // La misma identidad exacta que el catálogo: File de 1 byte con el nombre, la fecha y la incorporación del original.
    const local = crearCapturaFoto(itinerario, destino, new File([new Uint8Array(unByte)], 'un-byte.png',
      { type: 'image/png', lastModified: 5 }), 2_000, { uuid: () => R2 });
    const remota = copiarOriginalRespaldo(itinerario, local.metadatos);
    expect(remota).toEqual(originalDeUnByte(R2));
    const m = await montar({ listado: () => pagina([inicial(remota)], null), descarga: () => binario(unByte) },
      { composicion: sinOriginales });
    try {
      await m.fotos.guardarOriginal(local);
      const antes = await m.fotos.listar();
      const ledgerAntes = await leerLedger(m);
      await m.respaldo.listar('principio');
      expect(de(m, 'listado').map((l) => l.url)).toEqual([URL_LISTADO]);
      expect(filas(m)).toEqual([{ original: remota, local: 'registrada', accion: 'comprobar' }]);

      await m.respaldo.guardar(R2);
      // Comprobar tampoco descarga un original por encima de la política (el listado no cuenta aquí).
      expect(de(m, 'descarga')).toHaveLength(0);
      expect(filas(m)[0]).toMatchObject({ estado: 'no-guardada' });
      expect(m.incorporadas).toEqual([]);
      expect(await m.fotos.leerMetadatos(R2)).toEqual(local.metadatos);
      expect(await bytesDe(await m.fotos.leerOriginal(R2))).toEqual(unByte);
      expect(await m.fotos.listar()).toEqual(antes);
      expect(await leerLedger(m)).toEqual(ledgerAntes);
      expect(de(m, 'subida')).toEqual([]);
    } finally {
      m.cerrar();
    }
  });
});
