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
  textoFilaCatalogo, textoLote, textoResultadoRespaldo, type CambioRespaldo, type ComposicionRespaldoFotos, type FilaCatalogo,
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
  /** Operaciones nuevas; por defecto siempre la misma (una foto por prueba). */
  readonly uuidOperacion?: () => string;
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
    fetch: puertoHttp(escenario, llamadas), fabricaLedger: fabrica, uuidOperacion: opciones.uuidOperacion ?? (() => operacionId),
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

// ---------- «Guardar sin conexión» desde la ficha de su destino (FO3) ----------

describe('guardar sin conexión una referencia descubierta en su ficha (U19)', () => {
  it('U19 · sin página global activa: un GET por toque, PhotoDB guarda los bytes exactos, se incorpora y el ledger no cambia',
    async () => {
      const m = await montar({ descarga: () => binario(bytes) });
      try {
        // Ninguna página del catálogo global: la referencia llega de la consulta de la ficha de su destino.
        expect(m.respaldo.catalogo).toEqual({ tipo: 'reposo' });
        const ref = originalRemoto(R1);
        const r = await m.respaldo.guardar(R1, ref);
        expect(r).toEqual({ tipo: 'guardada' });
        expect(de(m, 'descarga').map((l) => l.url)).toEqual([`${origen}/api/fotos/${R1}/original`]);
        expect(await bytesDe(await m.fotos.leerOriginal(R1))).toEqual(bytes);
        expect(copiarOriginalRespaldo(itinerario, await m.fotos.leerMetadatos(R1))).toEqual(ref);
        expect(m.incorporadas.map((x) => x.fotoId)).toEqual([R1]);
        // Guardar no consulta, no envía ni es acuse: ni listado, ni POST, ni ledger; el catálogo global sigue igual.
        expect(de(m, 'listado')).toEqual([]);
        expect(de(m, 'subida')).toEqual([]);
        expect(await leerLedger(m)).toEqual([]);
        expect(m.respaldo.catalogo).toEqual({ tipo: 'reposo' });
      } finally {
        m.cerrar();
      }
    });
});

describe('referencia descubierta que no se puede guardar aquí (U20)', () => {
  it('U20 · otro fotoId, identidad inválida o borrada en este móvil no piden nada; ocupada dice que hay otra en curso', async () => {
    const retenida = diferido<Response>();
    const m = await montar({ descarga: () => retenida.promesa });
    try {
      const ref = originalRemoto(R1);
      expect(await m.respaldo.guardar(R2, ref)).toEqual({ tipo: 'no-disponible' });
      expect(await m.respaldo.guardar(R1, { ...ref, destino: { ...ref.destino, viajeId: 'ajeno' } })).toEqual({ tipo: 'no-disponible' });
      expect(await m.respaldo.guardar(R1, { ...ref, url: 'https://publico.example' } as never)).toEqual({ tipo: 'no-disponible' });
      // Borrada aquí: la descarga lo rechaza antes de cualquier GET (nunca resucita).
      await m.fotos.guardarOriginal(capturaLocal(R3));
      await m.fotos.borrarLocal(R3);
      const r3 = copiarOriginalRespaldo(itinerario, capturaLocal(R3).metadatos);
      expect(await m.respaldo.guardar(R3, r3)).toEqual({ tipo: 'no-guardada' });
      expect(de(m, 'descarga')).toEqual([]);
      // Una a la vez: con otro guardado en curso, el segundo toque no pide nada.
      const primera = m.respaldo.guardar(R1, ref);
      expect(await m.respaldo.guardar(R4, originalRemoto(R4))).toEqual({ tipo: 'ocupada' });
      retenida.resolver(binario(bytes));
      expect(await primera).toEqual({ tipo: 'guardada' });
      expect(de(m, 'descarga')).toHaveLength(1);
      expect(m.incorporadas.map((x) => x.fotoId)).toEqual([R1]);
    } finally {
      m.cerrar();
    }
  });
});

describe('sesión perdida al guardar (U21)', () => {
  it('U21 · Guardar recibe 401: resultado tipado sin sesión, el catálogo global suelta su página y avisa; lo guardado aquí no cambia', async () => {
    const sinSesion = () => new Response('{"error":"sin-sesion"}', { status: 401, headers: CABECERAS_JSON });
    const m = await montar({ listado: () => pagina([inicial(originalRemoto(R1))], null), descarga: () => sinSesion() });
    try {
      const deliberada = capturaLocal(fotoId);
      await m.fotos.guardarOriginal(deliberada);
      await m.respaldo.listar('principio');
      expect(filas(m)).toHaveLength(1);
      const r = await m.respaldo.guardar(R2, originalRemoto(R2));
      expect(r).toEqual({ tipo: 'no-guardada', causa: 'sin-sesion' });
      // Ninguna candidata temporal sigue a la vista: la página global se suelta y la interfaz se entera.
      expect(m.respaldo.catalogo).toEqual({ tipo: 'fallo', motivo: 'sin-sesion' });
      expect(m.cambios).toContainEqual({ tipo: 'sin-sesion' });
      // La copia deliberada de este móvil sigue intacta; nada nuevo se guardó ni se incorporó.
      expect(await m.fotos.leerMetadatos(fotoId)).toEqual(deliberada.metadatos);
      expect(await m.fotos.leerMetadatos(R2)).toBeNull();
      expect(m.incorporadas).toEqual([]);
      expect(de(m, 'descarga')).toHaveLength(1);
    } finally {
      m.cerrar();
    }
  });
});

describe('capturas privadas y sesión perdida a mitad de un guardado (U22)', () => {
  it('U22 · un 401 en otra operación mientras se escribe: la captura de un fallo posterior por cuota no vuelve, ni su archivo ni su URL; '
    + 'lo guardado de verdad sigue', async () => {
    const sinSesion = () => new Response('{"error":"sin-sesion"}', { status: 401, headers: CABECERAS_JSON });
    let compuerta = diferido<'cuota' | 'real'>();
    let escribiendo = 0;
    const m = await montar({ listado: () => sinSesion(), descarga: () => binario(bytes) }, {
      // El mismo PhotoDB real; guardar un original espera a la compuerta y entonces falla por cuota o escribe de verdad.
      puerto: (fotos) => {
        const retenida: FotosLocal = {
          listar: () => fotos.listar(), leerMetadatos: (id) => fotos.leerMetadatos(id),
          leerOriginal: (id) => fotos.leerOriginal(id), leerMiniatura: (id) => fotos.leerMiniatura(id),
          guardarOriginal: async (c) => {
            escribiendo++;
            if (await compuerta.promesa === 'cuota') throw new DOMException('Sin espacio', 'QuotaExceededError');
            return fotos.guardarOriginal(c);
          },
          guardarMiniatura: (id, b, ancho, alto) => fotos.guardarMiniatura(id, b, ancho, alto),
          registrarFalloMiniatura: (id, motivo) => fotos.registrarFalloMiniatura(id, motivo),
          borrarLocal: (id) => fotos.borrarLocal(id), cerrar: () => {},
        };
        return () => retenida;
      },
    });
    try {
      const deliberada = capturaLocal(fotoId);
      await m.fotos.guardarOriginal(deliberada);
      // Guardar ya recibió el original válido y espera su escritura en PhotoDB.
      const guardado = m.respaldo.guardar(R1, originalRemoto(R1));
      await vi.waitFor(() => { if (escribiendo !== 1) throw new Error('aún no escribe'); });
      expect(de(m, 'descarga')).toHaveLength(1);
      // Otra operación recibe 401: la sesión ya no vale.
      await m.respaldo.listar('principio');
      expect(m.respaldo.catalogo).toEqual({ tipo: 'fallo', motivo: 'sin-sesion' });
      expect(m.cambios).toContainEqual({ tipo: 'sin-sesion' });
      // Después, la escritura falla por cuota: su captura privada no se retiene ni se ofrece como archivo.
      compuerta.resolver('cuota');
      expect(await guardado).toEqual({ tipo: 'no-guardada' });
      expect(m.respaldo.descargarArchivo(R1)).toBeNull();
      expect(m.blobs).toEqual([]);
      expect(await m.fotos.leerMetadatos(R1)).toBeNull();
      expect(await m.fotos.leerMetadatos(fotoId)).toEqual(deliberada.metadatos);
      expect(m.incorporadas).toEqual([]);
      // Un guardado que sí termina en PhotoDB después de otra invalidación es una copia deliberada: no se deshace.
      compuerta = diferido<'cuota' | 'real'>();
      const segundo = m.respaldo.guardar(R2, originalRemoto(R2));
      await vi.waitFor(() => { if (escribiendo !== 2) throw new Error('aún no escribe'); });
      m.respaldo.invalidarSesion();
      compuerta.resolver('real');
      expect(await segundo).toEqual({ tipo: 'guardada' });
      expect(m.incorporadas.map((x) => x.fotoId)).toEqual([R2]);
      expect(await bytesDe(await m.fotos.leerOriginal(R2))).toEqual(bytes);
      expect(m.respaldo.descargarArchivo(R2)).toBeNull();
      expect(m.blobs).toEqual([]);
    } finally {
      m.cerrar();
    }
  });
});

// ---------- Plazo del POST desde la composición (RP1) ----------

describe('plazo del envío de un respaldo', () => {
  it('RR1 · «Respaldar» usa el plazo del cliente de la composición: un POST que no contesta se corta y queda sin confirmar', async () => {
    let m!: Montaje;
    m = await montar({ subida: () => new Promise<Response>((_ok, no) => {
      // Un puerto que respeta el aborto, como fetch del navegador.
      const senal = de(m, 'subida').at(-1)!.senal!;
      senal.addEventListener('abort', () => no(new DOMException('Abortada', 'AbortError')), { once: true });
    }) }, { composicion: { ...composicion, listado: { ...composicion.listado, plazoMs: 40 } } });
    try {
      await m.fotos.guardarOriginal(capturaLocal(fotoId));
      const resultado = await Promise.race([m.respaldo.respaldar(fotoId),
        new Promise((ok) => setTimeout(() => ok('sigue-abierta'), 1500))]);
      expect(resultado).toEqual({ tipo: 'sin-confirmar' });
      expect(de(m, 'subida')).toHaveLength(1);
      expect(de(m, 'subida')[0].senal?.aborted).toBe(true);
      expect(await leerLedger(m)).toEqual([expect.objectContaining({ fotoId, fase: 'enviada', enviada: true, recibo: null })]);
    } finally {
      m.cerrar();
    }
  });
});

// ---------- Lote manual «Respaldar pendientes» (RP1) ----------

const VIA = 'camara-galeria' as const;
/** Operaciones nuevas distintas y válidas (UUID v4). */
function operaciones(): () => string {
  let n = 0;
  return () => `${(++n).toString(16).padStart(8, '0')}-2222-4222-8222-222222222222`;
}
/** Siembra el ledger con su API real (otra conexión), como si lo hubiera hecho un respaldo individual anterior. */
async function sembrarLedger(m: Montaje, captura: ReturnType<typeof capturaLocal>, fase: 'preparado' | 'enviada' | 'respaldada',
  op: string) {
  const ledger = await abrirRespaldoFotosLocal(itinerario, m.fotos, { fabrica: m.fabrica });
  try {
    const p = await ledger.preparar(captura, op);
    if (fase === 'preparado') return;
    await ledger.marcarEnviada({ fotoId: p.fotoId, operacionId: op, original: p.original });
    if (fase === 'enviada') return;
    await ledger.confirmarRecibo({ version: 1, tipo: 'acuse-respaldo', viajeId: itinerario.id, operacionId: op,
      fotoId: p.fotoId, original: p.original, objetoOriginalDurable: true, metadatosDurables: true });
  } finally { ledger.cerrar(); }
}
/** Un POST que solo acaba si se aborta, como fetch del navegador. */
function colgada(m: () => Montaje): Promise<Response> {
  return new Promise<Response>((_ok, no) => {
    const senal = de(m(), 'subida').at(-1)!.senal!;
    senal.addEventListener('abort', () => no(new DOMException('Abortada', 'AbortError')), { once: true });
  });
}
const resumenLedger = async (m: Montaje) => Object.fromEntries((await leerLedger(m))
  .map((e) => [e.fotoId, { fase: e.fase, operacionId: e.operacionId, enviada: e.enviada, pausada: e.pausada }]));

describe('lote «Respaldar pendientes»: recuento, consentimiento y envío de una en una (L1–L8)', () => {
  it('L1 · el recuento solo lee metadata, procedencia y ledger: 0 red, 0 preparaciones, 0 originales; cancelar no deja nada', async () => {
    const m = await montar({}, { uuidOperacion: operaciones() });
    try {
      const op = '12345678-3333-4333-8333-333333333333';
      for (const id of [R1, R2]) await m.fotos.guardarOriginal(capturaLocal(id, { nombre: `${id.slice(0, 2)}.png` }), VIA);
      await m.fotos.guardarOriginal(capturaLocal(R3, { nombre: 'anterior.png' })); // sin procedencia: anterior o importada
      const confirmada = capturaLocal(R4, { nombre: 'confirmada.png' });
      const enviada = capturaLocal(R5, { nombre: 'enviada.png' });
      const preparada = capturaLocal(R6, { nombre: 'preparada.png' });
      for (const c of [confirmada, enviada, preparada]) await m.fotos.guardarOriginal(c, VIA);
      await sembrarLedger(m, confirmada, 'respaldada', '22345678-3333-4333-8333-333333333333');
      await sembrarLedger(m, enviada, 'enviada', '32345678-3333-4333-8333-333333333333');
      await sembrarLedger(m, preparada, 'preparado', op);
      const antes = await resumenLedger(m);
      const originales = vi.spyOn(m.fotos, 'leerOriginal');
      const miniaturas = vi.spyOn(m.fotos, 'leerMiniatura');

      expect(m.respaldo.lote).toEqual({ tipo: 'inactivo' });
      const contando = m.respaldo.contarLote();
      expect(m.respaldo.lote).toEqual({ tipo: 'contando' });
      await contando;
      expect(m.respaldo.lote).toEqual({ tipo: 'propuesta', fotos: 3, bytes: 3 * bytes.length, confirmadas: 1, revision: 1,
        sinOrigen: 1 });
      expect(m.cambios).toContainEqual({ tipo: 'lote' });
      expect(m.llamadas).toEqual([]);
      expect([originales.mock.calls.length, miniaturas.mock.calls.length]).toEqual([0, 0]);
      expect(await resumenLedger(m)).toEqual(antes);

      m.respaldo.terminarLote();
      expect(m.respaldo.lote).toEqual({ tipo: 'inactivo' });
      // Sin consentimiento vigente, confirmar no hace nada.
      await m.respaldo.confirmarLote();
      expect(m.llamadas).toEqual([]);
      expect(await resumenLedger(m)).toEqual(antes);
    } finally {
      m.cerrar();
    }
  });

  it('L2 · confirmar envía SOLO el recuento, de una en una; un preparado limpio conserva su operación', async () => {
    let enVuelo = 0; let maximo = 0;
    const m = await montar({ subida: async (s) => {
      enVuelo++; maximo = Math.max(maximo, enVuelo);
      await new Promise((ok) => setTimeout(ok, 5));
      enVuelo--;
      return acuse(s);
    } }, { uuidOperacion: operaciones() });
    try {
      const op = '12345678-3333-4333-8333-333333333333';
      for (const id of [R1, R2]) await m.fotos.guardarOriginal(capturaLocal(id, { nombre: `${id.slice(0, 2)}.png` }), VIA);
      const preparada = capturaLocal(R6, { nombre: 'preparada.png' });
      await m.fotos.guardarOriginal(preparada, VIA);
      await sembrarLedger(m, preparada, 'preparado', op);
      await m.fotos.guardarOriginal(capturaLocal(R3, { nombre: 'anterior.png' }));
      await m.respaldo.contarLote();
      // Añadida después del recuento: no entra en este consentimiento.
      await m.fotos.guardarOriginal(capturaLocal(R4, { nombre: 'nueva.png' }), VIA);

      await m.respaldo.confirmarLote();
      expect(m.respaldo.lote).toEqual({ tipo: 'terminado',
        progreso: { total: 3, confirmadas: 3, omitidas: 0, revision: 0, restantes: 0 } });
      expect(maximo).toBe(1);
      const subidas = de(m, 'subida').map((l) => l.solicitud!);
      expect(subidas.map((s) => s.fotoId).sort()).toEqual([R1, R2, R6].sort());
      expect(subidas.find((s) => s.fotoId === R6)?.operacionId).toBe(op);
      expect(new Set(subidas.map((s) => s.operacionId)).size).toBe(3);
      const ledger = await resumenLedger(m);
      expect(Object.keys(ledger).sort()).toEqual([R1, R2, R6].sort());
      expect(Object.values(ledger).every((e) => e.fase === 'respaldada')).toBe(true);
      // Terminado: nada sigue solo y un nuevo recuento ya no incluye las confirmadas.
      await m.respaldo.contarLote();
      expect(m.respaldo.lote).toMatchObject({ tipo: 'propuesta', fotos: 1, confirmadas: 3, sinOrigen: 1 });
      expect(de(m, 'subida')).toHaveLength(3);
    } finally {
      m.cerrar();
    }
  });

  it('L3 · tras CADA await se revalida: borrada, ya confirmada, identidad cambiada, enviada aparte o sin procedencia no salen', async () => {
    const m = await montar({ subida: (s) => (s.fotoId === R4 ? servidorCaido() : acuse(s)) }, { uuidOperacion: operaciones() });
    try {
      for (const id of [R1, R2, R3, R4, R5, R6]) {
        await m.fotos.guardarOriginal(capturaLocal(id, { nombre: `${id.slice(0, 2)}.png` }), VIA);
      }
      await m.respaldo.contarLote();
      expect(m.respaldo.lote).toMatchObject({ tipo: 'propuesta', fotos: 6 });
      // Entre el recuento y la confirmación.
      await m.fotos.borrarLocal(R1);
      expect(await m.respaldo.respaldar(R2)).toEqual({ tipo: 'respaldada' });
      expect(await m.respaldo.respaldar(R4)).toEqual({ tipo: 'sin-confirmar' });
      const leerMetadatos = m.fotos.leerMetadatos.bind(m.fotos);
      vi.spyOn(m.fotos, 'leerMetadatos').mockImplementation(async (id) => {
        const v = await leerMetadatos(id);
        return id === R3 && v && !('tipo' in v && v.tipo === 'borrada') ? { ...v, nombre: 'otra-identidad.png' } : v;
      });
      const leerProcedencia = m.fotos.leerProcedencia!.bind(m.fotos);
      vi.spyOn(m.fotos, 'leerProcedencia').mockImplementation(async (id) => (id === R5 ? null : leerProcedencia(id)));
      const antes = de(m, 'subida').length;

      await m.respaldo.confirmarLote();
      expect(m.respaldo.lote).toEqual({ tipo: 'terminado',
        progreso: { total: 6, confirmadas: 1, omitidas: 4, revision: 1, restantes: 0 } });
      expect(de(m, 'subida').slice(antes).map((l) => l.solicitud?.fotoId)).toEqual([R6]);
      const ledger = await resumenLedger(m);
      expect(Object.keys(ledger).sort()).toEqual([R2, R4, R6].sort());
      expect(ledger[R4]).toMatchObject({ fase: 'enviada', enviada: true });
    } finally {
      m.cerrar();
    }
  });

  it('L4 · pausar durante el POST lo aborta y para; continuar envía SOLO las restantes, nunca la que ya salió', async () => {
    let m!: Montaje;
    let n = 0;
    m = await montar({ subida: (s) => (++n === 1 ? colgada(() => m) : acuse(s)) }, { uuidOperacion: operaciones() });
    try {
      for (const id of [R1, R2, R3]) await m.fotos.guardarOriginal(capturaLocal(id, { nombre: `${id.slice(0, 2)}.png` }), VIA);
      await m.respaldo.contarLote();
      const enviando = m.respaldo.confirmarLote();
      await vi.waitFor(() => expect(de(m, 'subida')).toHaveLength(1));
      expect(m.respaldo.lote).toMatchObject({ tipo: 'enviando', pausando: false });
      expect(await m.respaldo.respaldar(R2)).toEqual({ tipo: 'ocupada' });

      m.respaldo.pausarLote();
      expect(m.respaldo.lote).toMatchObject({ tipo: 'enviando', pausando: true });
      await enviando;
      const primera = de(m, 'subida')[0];
      expect(primera.senal?.aborted).toBe(true);
      expect(m.respaldo.lote).toEqual({ tipo: 'detenido', motivo: 'pausa',
        progreso: { total: 3, confirmadas: 0, omitidas: 0, revision: 1, restantes: 2 } });
      // La que ya salió queda sin confirmar (no es una pausa durable de esa foto) y no se reenvía.
      expect((await resumenLedger(m))[primera.solicitud!.fotoId]).toMatchObject({ fase: 'enviada', pausada: false });

      await m.respaldo.continuarLote();
      expect(m.respaldo.lote).toEqual({ tipo: 'terminado',
        progreso: { total: 3, confirmadas: 2, omitidas: 0, revision: 1, restantes: 0 } });
      const ids = de(m, 'subida').map((l) => l.solicitud!.fotoId);
      expect(ids).toHaveLength(3);
      expect(new Set(ids).size).toBe(3);
    } finally {
      m.cerrar();
    }
  });

  it('L4 · pausar antes de preparar no prepara ni envía; continuar sigue con el mismo recuento', async () => {
    const m = await montar({ subida: (s) => acuse(s) }, { uuidOperacion: operaciones() });
    try {
      for (const id of [R1, R2]) await m.fotos.guardarOriginal(capturaLocal(id, { nombre: `${id.slice(0, 2)}.png` }), VIA);
      await m.respaldo.contarLote();
      const retenida = diferido<void>();
      const leerOriginal = m.fotos.leerOriginal.bind(m.fotos);
      const espia = vi.spyOn(m.fotos, 'leerOriginal').mockImplementationOnce(async (id) => {
        await retenida.promesa; return leerOriginal(id);
      });
      const enviando = m.respaldo.confirmarLote();
      await vi.waitFor(() => expect(espia).toHaveBeenCalledTimes(1));
      m.respaldo.pausarLote();
      retenida.resolver();
      await enviando;
      expect(m.respaldo.lote).toEqual({ tipo: 'detenido', motivo: 'pausa',
        progreso: { total: 2, confirmadas: 0, omitidas: 0, revision: 0, restantes: 2 } });
      expect(await resumenLedger(m)).toEqual({});
      expect(m.llamadas).toEqual([]);

      await m.respaldo.continuarLote();
      expect(m.respaldo.lote).toMatchObject({ tipo: 'terminado', progreso: { confirmadas: 2, restantes: 0 } });
      expect(de(m, 'subida')).toHaveLength(2);
    } finally {
      m.cerrar();
    }
  });

  it('L5 · admisión compartida: el lote espera al respaldo individual en curso y, mientras corre, otro respaldo está ocupado', async () => {
    const suelta = diferido<void>();
    let n = 0;
    const m = await montar({ subida: (s) => (++n === 1 ? suelta.promesa.then(() => acuse(s)) : acuse(s)) },
      { uuidOperacion: operaciones() });
    try {
      for (const id of [R1, R2, R3]) await m.fotos.guardarOriginal(capturaLocal(id, { nombre: `${id.slice(0, 2)}.png` }), VIA);
      const individual = m.respaldo.respaldar(R1);
      await vi.waitFor(() => expect(de(m, 'subida')).toHaveLength(1));
      await m.respaldo.contarLote();
      // R1 ya salió por su cuenta (enviada, sin acuse aún): revisión aparte, fuera del lote.
      expect(m.respaldo.lote).toMatchObject({ tipo: 'propuesta', fotos: 2, revision: 1 });
      const enviando = m.respaldo.confirmarLote();
      await new Promise((ok) => setTimeout(ok, 30));
      expect(de(m, 'subida')).toHaveLength(1);
      expect(await m.respaldo.respaldar(R2)).toEqual({ tipo: 'ocupada' });
      suelta.resolver();
      expect(await individual).toEqual({ tipo: 'respaldada' });
      await enviando;
      expect(m.respaldo.lote).toEqual({ tipo: 'terminado',
        progreso: { total: 2, confirmadas: 2, omitidas: 0, revision: 0, restantes: 0 } });
      expect(de(m, 'subida').map((l) => l.solicitud!.fotoId).slice(1).sort()).toEqual([R2, R3].sort());
    } finally {
      m.cerrar();
    }
  });

  it('L6 · un 401 para el lote sin soltar la sesión global; el plazo y la falta de conexión también paran sin reintentar', async () => {
    const sinSesion = () => new Response('{"error":"sin-sesion"}', { status: 401, headers: CABECERAS_JSON });
    const a = await montar({ subida: () => sinSesion() }, { uuidOperacion: operaciones() });
    try {
      for (const id of [R1, R2, R3]) await a.fotos.guardarOriginal(capturaLocal(id, { nombre: `${id.slice(0, 2)}.png` }), VIA);
      await a.respaldo.contarLote();
      await a.respaldo.confirmarLote();
      expect(a.respaldo.lote).toEqual({ tipo: 'detenido', motivo: 'sin-sesion',
        progreso: { total: 3, confirmadas: 0, omitidas: 0, revision: 1, restantes: 2 } });
      expect(de(a, 'subida')).toHaveLength(1);
      expect(a.cambios).not.toContainEqual({ tipo: 'sin-sesion' });
    } finally {
      a.cerrar();
    }

    let b!: Montaje;
    b = await montar({ subida: () => colgada(() => b) },
      { uuidOperacion: operaciones(), composicion: { ...composicion, listado: { ...composicion.listado, plazoMs: 40 } } });
    try {
      for (const id of [R1, R2]) await b.fotos.guardarOriginal(capturaLocal(id, { nombre: `${id.slice(0, 2)}.png` }), VIA);
      await b.respaldo.contarLote();
      await b.respaldo.confirmarLote();
      expect(b.respaldo.lote).toEqual({ tipo: 'detenido', motivo: 'plazo',
        progreso: { total: 2, confirmadas: 0, omitidas: 0, revision: 1, restantes: 1 } });
      expect(de(b, 'subida')).toHaveLength(1);
      expect(de(b, 'subida')[0].senal?.aborted).toBe(true);
    } finally {
      b.cerrar();
    }

    let conectado = true;
    const c = await montar({ subida: (s) => acuse(s) }, { uuidOperacion: operaciones(), enLinea: () => conectado });
    try {
      for (const id of [R1, R2]) await c.fotos.guardarOriginal(capturaLocal(id, { nombre: `${id.slice(0, 2)}.png` }), VIA);
      await c.respaldo.contarLote();
      conectado = false;
      await c.respaldo.confirmarLote();
      expect(c.respaldo.lote).toEqual({ tipo: 'detenido', motivo: 'sin-conexion',
        progreso: { total: 2, confirmadas: 0, omitidas: 0, revision: 0, restantes: 2 } });
      expect(c.llamadas).toEqual([]);
      expect(await resumenLedger(c)).toEqual({});
    } finally {
      c.cerrar();
    }
  });

  it('L7 · cerrar u ocultar la vista acaba la continuidad: una propuesta se olvida y un lote en curso no se puede continuar', async () => {
    let m!: Montaje;
    let n = 0;
    m = await montar({ subida: (s) => (++n === 1 ? colgada(() => m) : acuse(s)) }, { uuidOperacion: operaciones() });
    try {
      for (const id of [R1, R2]) await m.fotos.guardarOriginal(capturaLocal(id, { nombre: `${id.slice(0, 2)}.png` }), VIA);
      await m.respaldo.contarLote();
      m.respaldo.abandonarLote();
      expect(m.respaldo.lote).toEqual({ tipo: 'inactivo' });
      await m.respaldo.confirmarLote();
      expect(m.llamadas).toEqual([]);

      await m.respaldo.contarLote();
      const enviando = m.respaldo.confirmarLote();
      await vi.waitFor(() => expect(de(m, 'subida')).toHaveLength(1));
      m.respaldo.abandonarLote();
      await enviando;
      expect(m.respaldo.lote).toMatchObject({ tipo: 'detenido', motivo: 'cerrado', progreso: { revision: 1, restantes: 1 } });
      await m.respaldo.continuarLote();
      expect(de(m, 'subida')).toHaveLength(1);
      expect(m.respaldo.lote).toMatchObject({ tipo: 'detenido', motivo: 'cerrado' });
    } finally {
      m.cerrar();
    }
  });

  it('L8 · el copy dice qué queda fuera y no promete que pausar evite lo que ya salió', () => {
    expect(textoLote({ tipo: 'propuesta', fotos: 2, bytes: 14, confirmadas: 1, revision: 2, sinOrigen: 3 }).detalle)
      .toBe('Se envían de una en una al servidor del viaje; los datos móviles pueden tener coste. Confirmar permite transferencias durante esta visita, hasta ocultar la app. No detectamos wifi. Quedan fuera: 1 ya confirmada'
        + ' · 2 para revisar · 3 sin origen comprobado aquí (anteriores, descargadas o importadas: se respaldan desde su visor).');
    expect(textoLote({ tipo: 'propuesta', fotos: 0, bytes: 0, confirmadas: 0, revision: 0, sinOrigen: 1 })).toEqual({
      estado: 'No hay fotos añadidas aquí con la cámara o la galería pendientes de respaldo.',
      detalle: 'Quedan fuera: 1 sin origen comprobado aquí (anterior, descargada o importada: se respalda desde su visor).' });
    expect(textoLote({ tipo: 'detenido', motivo: 'pausa',
      progreso: { total: 3, confirmadas: 1, omitidas: 0, revision: 1, restantes: 1 } })).toEqual({
      estado: 'En pausa: 1 de 3 confirmadas.',
      detalle: 'Si una foto ya había salido, el servidor puede recibirla igualmente. 1 para revisar aparte (sin confirmar).' });
    expect(textoLote({ tipo: 'detenido', motivo: 'sin-sesion',
      progreso: { total: 2, confirmadas: 0, omitidas: 0, revision: 0, restantes: 2 } }).estado)
      .toBe('Parado: este móvil no tiene sesión en el servidor. 0 de 2 confirmadas.');
  });
});

describe('lote: admisión durable frente a otra instancia (H1)', () => {
  it('H1-I1 · otra instancia envía la MISMA operación mientras el lote espera la metadata: el lote no hace POST y la deja para revisar',
    async () => {
      const op = '42345678-3333-4333-8333-333333333333';
      const m = await montar({ subida: (s) => acuse(s) }, { uuidOperacion: operaciones() });
      // Otra instancia real: su propia conexión a PhotoDB y al ledger, su propio transporte; su POST queda sin acuse.
      const otraFotos = await abrirFotosLocal(itinerario, { fabrica: m.fabrica });
      const llamadasOtra: Llamada[] = [];
      const otra = crearRespaldoFotos({ plan: itinerario, composicion, puerto: () => otraFotos, incorporar: () => {},
        fetch: puertoHttp({ subida: () => servidorCaido() }, llamadasOtra), fabricaLedger: m.fabrica,
        uuidOperacion: operaciones(), enLinea: () => true });
      try {
        const preparada = capturaLocal(R1, { nombre: 'preparada.png' });
        await m.fotos.guardarOriginal(preparada, VIA);
        await sembrarLedger(m, preparada, 'preparado', op);
        await m.respaldo.contarLote();
        expect(m.respaldo.lote).toMatchObject({ tipo: 'propuesta', fotos: 1, revision: 0 });

        // Barrera en el lote DESPUÉS de su primera lectura del ledger: la metadata de la foto.
        const retenida = diferido<void>(); let llegada!: () => void;
        const llego = new Promise<void>((ok) => { llegada = ok; });
        const leerMetadatos = m.fotos.leerMetadatos.bind(m.fotos);
        const espia = vi.spyOn(m.fotos, 'leerMetadatos').mockImplementationOnce(async (id) => {
          llegada(); await retenida.promesa; return leerMetadatos(id);
        });
        const enviando = m.respaldo.confirmarLote();
        await llego;
        expect(espia).toHaveBeenCalledTimes(1);
        expect((await resumenLedger(m))[R1]).toMatchObject({ fase: 'preparado', enviada: false, operacionId: op });

        // La otra instancia envía la MISMA operación y queda sin confirmar, durable antes de soltar al lote.
        expect(await otra.respaldar(R1)).toEqual({ tipo: 'sin-confirmar' });
        expect(llamadasOtra.filter((l) => l.tipo === 'subida').map((l) => l.solicitud?.operacionId)).toEqual([op]);
        const ajena = await leerLedger(m);
        expect(ajena).toEqual([expect.objectContaining({ fotoId: R1, operacionId: op, fase: 'enviada', enviada: true,
          pausada: false, recibo: null })]);

        retenida.resolver();
        await enviando;
        // El lote no hace ningún POST: solo salió el intencionado de la otra instancia.
        expect(de(m, 'subida')).toEqual([]);
        expect(m.respaldo.lote).toEqual({ tipo: 'terminado',
          progreso: { total: 1, confirmadas: 0, omitidas: 0, revision: 1, restantes: 0 } });
        expect(await leerLedger(m)).toEqual(ajena);

        // Revisarla a mano: «Reintentar» envía la MISMA operación y el acuse la confirma.
        expect(await m.respaldo.reintentar(R1)).toEqual({ tipo: 'respaldada' });
        expect(de(m, 'subida').map((l) => l.solicitud?.operacionId)).toEqual([op]);
        expect(await leerLedger(m)).toEqual([expect.objectContaining({ fotoId: R1, operacionId: op, fase: 'respaldada' })]);
      } finally {
        otra.cerrar(); otraFotos.cerrar(); m.cerrar();
      }
    });
});
