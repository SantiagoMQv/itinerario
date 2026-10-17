import type { Itinerario } from './tipos';
import { esFotoBorrada, esIdFoto, tamanoBlob, type CapturaFoto, type DestinoFoto, type MetadatosFoto } from './fotos';
import type { FotosLocal, ViaProcedencia } from './fotos-local';
import { abrirRespaldoFotosLocal, type RespaldoFotosLocal } from './fotos-respaldo-local';
import { crearTransporteFotos, ErrorTransporteFotos, type TransporteFotos } from './fotos-transporte';
import { crearClienteListadoFotos, type ListadoFotos, type PresupuestoListadoFotosCliente,
  type ResultadoListadoFotosCliente } from './fotos-listado';
import { crearDescargaFotos, crearRecepcionOriginal, type DescargaFotos, type RecepcionOriginal,
  type ResultadoDescargaFotos } from './fotos-descarga';
import { copiarIdentidadRespaldo, copiarOriginalRespaldo, mismosOriginalesRespaldo, type EntradaRespaldo,
  type OriginalRespaldo, type ReferenciaRespaldo } from './fotos-respaldo';
import { deserializarSolicitudRespaldo } from './fotos-protocolo';
import type { MotorMiniatura } from './fotos-imagen';
import { crearFotosRemotas, type FotosRemotas, type LimitesRemotas } from './fotos-remotas';

/**
 * Respaldo manual y catálogo de fotos privadas en la interfaz del viaje.
 *
 * Controlador sin DOM (pruebas en Node) que compone, sobre el MISMO PhotoDB del controlador de fotos, el ledger
 * local, el transporte, el listado y la descarga de las bibliotecas existentes. Solo acciones explícitas: una
 * acción es UN POST o UN GET; nada se envía, consulta, reintenta ni descarga al abrir el visor, «Todo» ni una
 * página. Listar, guardar o comprobar nunca son acuse (ACK), marca de envío (SENT) ni entradas del ledger.
 * La única acción que autoriza VARIOS POST es la confirmación explícita del lote «Respaldar pendientes»: solo las
 * fotos de su recuento finito (añadidas aquí con cámara o galería y sin respaldo), de una en una, con el mismo
 * ledger y el mismo transporte; no es sincronización ni nada que siga solo.
 * La web publicada lo compone con null: ni red, ni ledger, ni texto nuevo (ver componerRespaldoFotos).
 * Con la misma composición, las fotos compartidas de cada ficha (componerFotosRemotas): se consultan por destino al
 * abrir «Fotos», se ven con conexión sin guardarse y «Guardar sin conexión» es la descarga duradera de siempre.
 * Al final, la sección «Fotos del viaje» de «Todo» (DOM), que solo existe con la composición activada.
 */

/** Activación EXPLÍCITA. Publicado (Pages): null → 0 red, 0 ledger, 0 texto nuevo. T7 decidirá cómo se activa. */
export interface ComposicionRespaldoFotos {
  /** location.origin del contexto: las bibliotecas lo exigen igual a location.origin. */
  readonly origen: string;
  /** Presupuesto lógico del catálogo; N igual al maxFilas que sirva el servidor. Objeto plano de datos. */
  readonly listado: PresupuestoListadoFotosCliente;
  /** Omitido hasta que T7 lo configure; si llega, el mismo valor que el servidor. */
  readonly maxBytesOriginal?: number;
}

export interface DependenciasRespaldoFotos {
  readonly plan: Itinerario;
  readonly composicion: ComposicionRespaldoFotos;
  /** El MISMO FotosLocal vivo del controlador de fotos; nunca se abre otra conexión a PhotoDB ni se cierra aquí. */
  readonly puerto: () => FotosLocal | null;
  /** Única vía para indexar en la interfaz una foto guardada por la descarga. */
  readonly incorporar: (metadatos: MetadatosFoto) => void;
  /** Puerto HTTP de las bibliotecas (transporte y descarga: `fetch`; listado: `http: { fetch }`). Omitido: el nativo. */
  readonly fetch?: typeof fetch;
  /** Fábrica de IndexedDB del ledger local; omitida: la del navegador. */
  readonly fabricaLedger?: IDBFactory;
  /** CSPRNG UUIDv4 de la operación al preparar por primera vez (opción `uuid` del ledger); omitido: el del ledger. */
  readonly uuidOperacion?: () => string;
  /** Sin conexión no se envía nada ni se marca envío; omitido: navigator.onLine !== false. */
  readonly enLinea?: () => boolean;
  /** URLs blob del archivo de una descarga fallida (propiedad del controlador). */
  readonly crearUrl?: (blob: Blob) => string;
  readonly revocarUrl?: (url: string) => void;
  readonly alCambiar?: (que: CambioRespaldo) => void;
}
/** «sin-sesion»: este controlador vio un 401 (consulta o guardado); quien compone invalida también lo suyo. */
export type CambioRespaldo = { readonly tipo: 'foto'; readonly fotoId: string } | { readonly tipo: 'catalogo' }
  | { readonly tipo: 'resumen' } | { readonly tipo: 'sin-sesion' } | { readonly tipo: 'lote' };

/** Progreso del lote. «confirmadas»: solo acuses durables del servidor en el ledger de este móvil; los bytes
 * estimados de originales no son tráfico real (sobrecarga, reintentos y facturación no se conocen). */
export interface ProgresoLote {
  readonly total: number;
  readonly confirmadas: number;
  /** Ya no estaban, cambiaron o se confirmaron por otra vía entre medias: no se enviaron. */
  readonly omitidas: number;
  /** Salieron sin acuse o quedaron en un estado que no se reenvía a ciegas: revisión aparte. */
  readonly revision: number;
  /** Aún sin enviar dentro del recuento confirmado. */
  readonly restantes: number;
}
export type MotivoParadaLote = 'pausa' | 'sin-sesion' | 'plazo' | 'incierta' | 'error' | 'sin-conexion' | 'cerrado';
/** «propuesta»: recuento finito listo para confirmar (0 red, 0 preparaciones, 0 originales leídos). */
export type EstadoLote =
  | { readonly tipo: 'inactivo' }
  | { readonly tipo: 'contando' }
  | { readonly tipo: 'no-disponible' }
  | { readonly tipo: 'propuesta'; readonly fotos: number; readonly bytes: number; readonly confirmadas: number;
      readonly revision: number; readonly sinOrigen: number }
  | { readonly tipo: 'enviando'; readonly progreso: ProgresoLote; readonly pausando: boolean }
  | { readonly tipo: 'detenido'; readonly progreso: ProgresoLote; readonly motivo: MotivoParadaLote }
  | { readonly tipo: 'terminado'; readonly progreso: ProgresoLote };

/** Estado de una foto según el ledger durable de este móvil (nunca un resultado optimista). */
export type EstadoRespaldo =
  | { readonly tipo: 'sin-respaldo' }
  | { readonly tipo: 'preparado' }
  | { readonly tipo: 'enviando' }
  | { readonly tipo: 'sin-confirmar' }
  | { readonly tipo: 'pausado' }
  | { readonly tipo: 'respaldada' }
  | { readonly tipo: 'bloqueada' }
  /** El ledger no se pudo leer: sin acciones, sin reparar. */
  | { readonly tipo: 'ilegible' };

/** «no-enviada»: no se envió en ESTA acción; no dice nada de envíos anteriores ni de lo que haya en el servidor. */
export type ResultadoRespaldo = {
  readonly tipo: 'respaldada' | 'sin-confirmar' | 'pausado' | 'no-enviada' | 'ocupada' | 'sin-conexion'
    | 'no-disponible' | 'bloqueada';
};

/** Lo que este móvil sabe de una foto del catálogo: solo metadata local; «registrada» NO atesta sus bytes. */
export type LocalCatalogo = 'ausente' | 'registrada' | 'borrada' | 'otra' | 'ilegible';

export interface FilaCatalogo {
  readonly original: OriginalRespaldo;
  readonly local: LocalCatalogo;
  /** «guardar» si no está aquí; «comprobar» si solo coincide la metadata (descarga el original para compararlo). */
  readonly accion: 'guardar' | 'comprobar' | null;
  readonly estado?: 'guardando' | 'guardada' | 'comprobada' | 'no-guardada' | 'detenida';
  /** Hay bytes de una descarga fallida solo en esta sesión: se pueden descargar como archivo, nunca a PhotoDB. */
  readonly captura?: true;
}

export type EstadoCatalogo =
  | { readonly tipo: 'reposo' }
  /** El listado no se pudo crear aquí (origen sin HTTPS o presupuesto inválido): 0 IO. */
  | { readonly tipo: 'no-disponible' }
  | { readonly tipo: 'consultando'; readonly desde: 'principio' | 'siguiente' }
  | { readonly tipo: 'pagina'; readonly filas: readonly FilaCatalogo[]; readonly primera: boolean; readonly hayMas: boolean }
  | { readonly tipo: 'fallo'; readonly motivo: 'sin-sesion' | 'continuacion' | 'servidor' | 'respuesta' | 'presupuesto' | 'ocupado' }
  | { readonly tipo: 'detenido'; readonly motivo: 'cancelada' | 'plazo' | 'cerrada' };

/** Resultado de guardar en este móvil (desde el catálogo o desde la ficha): lo durable, nunca optimista.
 * «comprobada»: ya estaba con la misma identidad y los mismos bytes. `captura`: bytes de esta sesión, como archivo. */
export interface ResultadoGuardado {
  readonly tipo: 'guardada' | 'comprobada' | 'no-guardada' | 'detenida' | 'ocupada' | 'no-disponible';
  readonly captura?: true;
  /** Por qué no se guardó, cuando importa: 401 del endpoint («sin-sesion») o plazo de la recepción vencido. */
  readonly causa?: 'sin-sesion' | 'plazo';
}

export interface ResumenRespaldo {
  readonly fotoId: string;
  readonly estado: EstadoRespaldo;
  readonly original: OriginalRespaldo;
}

export interface RespaldoFotos {
  /** Ledger perezoso: se abre solo al primer leer, resumen o acción, sobre el MISMO PhotoDB. */
  readonly fase: 'cerrada' | 'abriendo' | 'lista' | 'fallo' | 'terminada';
  /** Lectura fresca del ledger local; 0 red, nunca crea entradas. */
  leer(fotoId: string): Promise<EstadoRespaldo>;
  /** Última lectura en memoria, o null si aún no se ha leído. */
  estado(fotoId: string): EstadoRespaldo | null;
  /** Hay un envío propio de esta foto en curso (esta instancia). */
  enCurso(fotoId: string): boolean;
  /** Todo el ledger de este móvil (metadata); 0 red. Rechaza si no se puede leer. */
  resumen(): Promise<readonly ResumenRespaldo[]>;
  /** Tamaño del original; el tráfico total no se conoce de antemano. */
  estimar(fotoId: string): Promise<{ readonly bytesOriginal: number } | null>;
  /** Acción explícita y con conexión: prepara una vez la operación si falta y envía con la MISMA identidad. */
  respaldar(fotoId: string): Promise<ResultadoRespaldo>;
  /** Reintento manual: misma operación, nunca prepara una nueva; quita la pausa si la hay. */
  reintentar(fotoId: string): Promise<ResultadoRespaldo>;
  /** Intención durable de pausa; si ya había salido, el servidor puede recibirla igualmente. */
  pausar(fotoId: string): Promise<ResultadoRespaldo>;
  readonly catalogo: EstadoCatalogo;
  /** Un GET por toque; la continuación se guarda RAW y nunca se sigue sola. */
  listar(desde: 'principio' | 'siguiente'): Promise<void>;
  cancelarListado(): void;
  /** Segunda acción explícita: una fila de la página vigente o, con `descubierta`, la referencia que encontró la
   * ficha de su destino (se valida con el plan; no depende de ninguna página global). Siempre un GET si se admite. */
  guardar(fotoId: string, descubierta?: OriginalRespaldo): Promise<ResultadoGuardado>;
  cancelarGuardado(): void;
  /** Sesión perdida vista fuera (p. ej. por las compartidas de una ficha): suelta la página del catálogo y las
   * capturas temporales; no toca el ledger ni las fotos guardadas en este móvil. */
  invalidarSesion(): void;
  /** Bytes de una descarga fallida (solo esta sesión) como archivo octet-stream; nunca entran en PhotoDB ni en el ledger. */
  descargarArchivo(fotoId: string): { readonly url: string; readonly nombre: string } | null;
  /** Lote manual global «Respaldar pendientes» (dentro de ESTE controlador: mismo PhotoDB, ledger y transporte). */
  readonly lote: EstadoLote;
  /** Recuento finito e inmutable: metadata local, procedencia y ledger. 0 red, 0 preparaciones, 0 originales. */
  contarLote(): Promise<void>;
  /** El consentimiento: envía SOLO el recuento, de una en una, revalidando cada foto antes de preparar y enviar. */
  confirmarLote(): Promise<void>;
  /** Corta el lote: la foto en curso se aborta (si ya salió, el servidor puede recibirla); su IO sigue siendo suyo
   * hasta que asiente. */
  pausarLote(): void;
  /** Continuación explícita: solo las restantes del MISMO recuento; lo que quedó incierto no se reenvía. */
  continuarLote(): Promise<void>;
  /** Cancela una propuesta o termina un lote detenido o acabado: nada sigue. */
  terminarLote(): void;
  /** La vista se cierra u oculta: fin de la continuidad y del consentimiento; volver no reanuda nada. */
  abandonarLote(): void;
  soltarUrl(url: string): void;
  /** Cierra lo propio (ledger, transporte, listado, descarga); NUNCA el PhotoDB del controlador de fotos. */
  cerrar(): void;
}

const ENVIANDO: EstadoRespaldo = { tipo: 'enviando' };
const ILEGIBLE: EstadoRespaldo = { tipo: 'ilegible' };

function estadoDeEntrada(e: EntradaRespaldo | null): EstadoRespaldo {
  if (!e) return { tipo: 'sin-respaldo' };
  if (e.fase === 'respaldada') return { tipo: 'respaldada' };
  if (e.fase === 'bloqueada') return { tipo: 'bloqueada' };
  if (e.pausada) return { tipo: 'pausado' };
  return e.fase === 'enviada' ? { tipo: 'sin-confirmar' } : { tipo: 'preparado' };
}
const referenciaDe = (e: EntradaRespaldo): ReferenciaRespaldo =>
  ({ fotoId: e.fotoId, operacionId: e.operacionId, original: e.original });
/** La verdad durable manda; el error solo matiza lo que pasó en ESTA acción. */
function resultadoDe(durable: EstadoRespaldo, error: unknown, exito: boolean): ResultadoRespaldo {
  // El transporte solo resuelve tras la confirmación durable del acuse en el ledger.
  if (exito || durable.tipo === 'respaldada') return { tipo: 'respaldada' };
  if (durable.tipo === 'bloqueada') return { tipo: 'bloqueada' };
  if (durable.tipo === 'pausado') return { tipo: 'pausado' };
  if (error instanceof ErrorTransporteFotos && error.estado === 'sin-envio') return { tipo: 'no-enviada' };
  if (durable.tipo === 'sin-confirmar') return { tipo: 'sin-confirmar' };
  if (error instanceof ErrorTransporteFotos && error.estado === 'incierta') return { tipo: 'sin-confirmar' };
  // Detenida o estado ilegible: no se afirma ni que salió ni que no salió.
  return { tipo: 'no-disponible' };
}
type MotivoListado = Extract<ResultadoListadoFotosCliente, { tipo: 'fallida' }>['motivo'];
type MotivoCatalogo = Extract<EstadoCatalogo, { tipo: 'fallo' }>['motivo'];
function motivoCatalogo(m: MotivoListado): MotivoCatalogo {
  if (m === 'sin-sesion') return 'sin-sesion';
  if (m === 'argumentos-invalidos' || m === 'consulta-rechazada') return 'continuacion';
  if (m === 'infraestructura') return 'servidor';
  if (m === 'presupuesto-excedido') return 'presupuesto';
  if (m === 'ocupada') return 'ocupado';
  return 'respuesta';
}
const accionDe = (local: LocalCatalogo): FilaCatalogo['accion'] =>
  local === 'ausente' ? 'guardar' : local === 'registrada' ? 'comprobar' : null;
const NO_DISPONIBLE: ResultadoGuardado = { tipo: 'no-disponible' };

/** Lo que este móvil tiene de un original: solo lecturas de metadata, identidad completa (sin bytes). */
export async function clasificarEnEsteMovil(plan: Itinerario, o: OriginalRespaldo, p: FotosLocal | null): Promise<LocalCatalogo> {
  if (!p) return 'ilegible';
  try {
    const m = await p.leerMetadatos(o.fotoId);
    if (m === null) return 'ausente';
    if (esFotoBorrada(m)) return 'borrada';
    return mismosOriginalesRespaldo(plan, copiarOriginalRespaldo(plan, m), o) ? 'registrada' : 'otra';
  } catch { return 'ilegible'; }
}

/** Gate de composición: con null no se construye nada (ni fábricas, ni ledger, ni red). */
export function componerRespaldoFotos(composicion: ComposicionRespaldoFotos | null,
  resto: Omit<DependenciasRespaldoFotos, 'composicion'>): RespaldoFotos | null {
  return composicion ? crearRespaldoFotos({ ...resto, composicion }) : null;
}

export interface DependenciasFotosRemotas {
  readonly plan: Itinerario;
  /** El MISMO FotosLocal vivo del controlador de fotos, solo para leer metadata (dedup); nunca se escribe aquí. */
  readonly puerto: () => FotosLocal | null;
  /** Puerto HTTP de las bibliotecas (recepción: `fetch`; listado: `http: { fetch }`). Omitido: el nativo. */
  readonly fetch?: typeof fetch;
  readonly enLinea?: () => boolean;
  readonly crearMotor?: () => MotorMiniatura;
  readonly crearUrl?: (blob: Blob) => string;
  readonly revocarUrl?: (url: string) => void;
  /** Cotas de fotos y vistas retenidas; omitidas: LIMITES_REMOTAS. */
  readonly limites?: Partial<LimitesRemotas>;
  readonly alCambiar?: (destino: DestinoFoto | null) => void;
  /** Las compartidas vieron un 401: para invalidar también el catálogo global. */
  readonly alPerderSesion?: () => void;
}
/** Gate de composición de las fotos compartidas de cada ficha: con null no se construye nada (ni recepción, ni
 * listado, ni red). Con composición: una instancia de listado NUEVA por ficha abierta (nunca la del catálogo
 * global), el mismo origen y presupuesto, y la misma política de original que la descarga duradera. */
export function componerFotosRemotas(composicion: ComposicionRespaldoFotos | null, d: DependenciasFotosRemotas): FotosRemotas | null {
  if (!composicion) return null;
  const { plan } = d;
  let recepcion: RecepcionOriginal | null;
  // Mismo plazo que el cliente del listado de la composición (su único plazo de cliente): finito también aquí.
  const plazoMs = composicion.listado.plazoMs;
  try {
    recepcion = crearRecepcionOriginal({ plan, origen: composicion.origen, plazoMs, ...(d.fetch ? { fetch: d.fetch } : {}),
      ...(composicion.maxBytesOriginal !== undefined ? { maxBytesOriginal: composicion.maxBytesOriginal } : {}) });
  } catch { recepcion = null; }
  return crearFotosRemotas({ plan, recepcion,
    crearListado: () => (d.fetch
      ? crearClienteListadoFotos({ plan, origen: composicion.origen, presupuesto: composicion.listado, http: { fetch: d.fetch } })
      : crearClienteListadoFotos({ plan, origen: composicion.origen, presupuesto: composicion.listado })),
    clasificar: (o) => clasificarEnEsteMovil(plan, o, d.puerto()),
    ...(d.enLinea ? { enLinea: d.enLinea } : {}), ...(d.crearMotor ? { crearMotor: d.crearMotor } : {}),
    ...(d.crearUrl ? { crearUrl: d.crearUrl } : {}), ...(d.revocarUrl ? { revocarUrl: d.revocarUrl } : {}),
    limites: { plazoMs, ...d.limites }, ...(d.alCambiar ? { alCambiar: d.alCambiar } : {}),
    ...(d.alPerderSesion ? { alPerderSesion: d.alPerderSesion } : {}) });
}

export function crearRespaldoFotos(d: DependenciasRespaldoFotos): RespaldoFotos {
  const { plan, composicion } = d;
  const origen = composicion.origen;
  const enLinea = d.enLinea ?? (() => typeof navigator === 'undefined' || navigator.onLine !== false);
  const crearUrl = d.crearUrl ?? ((b: Blob) => URL.createObjectURL(b));
  const revocarUrl = d.revocarUrl ?? ((u: string) => URL.revokeObjectURL(u));

  let terminado = false;
  let fase: RespaldoFotos['fase'] = 'cerrada';
  /** Puerto para el que existen las instancias propias; undefined antes de la primera acción. */
  let puertoActual: FotosLocal | null | undefined;
  let genPuerto = 0;
  let ledger: RespaldoFotosLocal | null = null;
  let apertura: Promise<RespaldoFotosLocal | null> | undefined;
  let transporte: TransporteFotos | null = null;
  let descarga: DescargaFotos | null = null;
  let listado: ListadoFotos | null = null;
  let listadoNoDisponible = false;
  const estados = new Map<string, EstadoRespaldo>();
  /** Foto con un envío propio en curso (el transporte admite uno por instancia). */
  let activa: string | null = null;
  /** Admisión COMPARTIDA (respaldo individual y cada paso del lote): ocupado hasta que la biblioteca asienta su IO
   * propio, no hasta un resultado cancelado. */
  let cargaEnCurso: Promise<unknown> | null = null;
  let descargaEnCurso: Promise<unknown> | null = null;
  let catalogo: EstadoCatalogo = { tipo: 'reposo' };
  let genCatalogo = 0;
  let consultando = false;
  /** Continuación RAW de la última página: posición, no permiso; nunca se sigue sola. */
  let continuacion: string | null = null;
  /** Época de autorización: sube con cada sesión perdida (401 propio o avisado desde fuera). Distinta de genPuerto
   * (PhotoDB): un 401 no cambia de base, pero invalida todo lo privado temporal iniciado antes. */
  let autorizacion = 0;
  /** Bytes de descargas fallidas, solo en memoria de esta sesión y de SU época de autorización. */
  const capturas = new Map<string, { readonly captura: CapturaFoto; readonly autorizacion: number }>();
  const entregadas = new Set<string>();

  function avisar(que: CambioRespaldo) {
    if (terminado) return;
    try { d.alCambiar?.(que); } catch { /* La interfaz no altera lo durable. */ }
  }

  /** Otro PhotoDB: lo propio se cierra y lo que llegue tarde ya no toca nada vigente. */
  function sincronizarPuerto(): FotosLocal | null {
    const p = d.puerto();
    if (p === puertoActual) return p;
    const habia = puertoActual !== undefined;
    genPuerto++;
    transporte?.cerrar(); transporte = null;
    descarga?.cerrar(); descarga = null;
    ledger?.cerrar(); ledger = null; apertura = undefined;
    if (fase !== 'terminada') fase = 'cerrada';
    estados.clear();
    // El listado no depende de PhotoDB: se cancela su acción, pero se conserva la instancia para que siga
    // ocupada hasta que su IO propio se asiente (la biblioteca no libera antes de eso).
    if (consultando) listado?.cancelar();
    genCatalogo++;
    continuacion = null;
    if (catalogo.tipo !== 'no-disponible') catalogo = { tipo: 'reposo' };
    puertoActual = p;
    if (habia) { avisar({ tipo: 'catalogo' }); avisar({ tipo: 'resumen' }); }
    return p;
  }

  /** Apertura perezosa y sin candado: tras un fallo se puede volver a intentar. Nunca crea entradas. */
  function abrirLedger(): Promise<RespaldoFotosLocal | null> {
    if (terminado) return Promise.resolve(null);
    if (ledger) return Promise.resolve(ledger);
    if (apertura) return apertura;
    const p = puertoActual;
    if (!p) return Promise.resolve(null);
    const gen = genPuerto;
    fase = 'abriendo';
    let terminada = false;
    let propia: Promise<RespaldoFotosLocal | null> | undefined;
    propia = (async () => {
      try {
        const l = await abrirRespaldoFotosLocal(plan, p, { fabrica: d.fabricaLedger, uuid: d.uuidOperacion });
        if (gen !== genPuerto || terminado) { l.cerrar(); return null; }
        ledger = l; fase = 'lista';
        return l;
      } catch {
        if (gen === genPuerto && !terminado) fase = 'fallo';
        return null;
      } finally {
        terminada = true;
        if (apertura === propia) apertura = undefined;
      }
    })();
    if (!terminada) apertura = propia;
    return propia;
  }

  /** Lectura durable fresca; solo actualiza la memoria si sigue siendo el mismo PhotoDB. */
  async function leerDurable(fotoId: string, gen: number): Promise<EstadoRespaldo> {
    if (gen !== genPuerto || terminado) return ILEGIBLE;
    let estado: EstadoRespaldo;
    try {
      const l = await abrirLedger();
      estado = l && gen === genPuerto ? estadoDeEntrada(await l.leer(fotoId)) : ILEGIBLE;
    } catch { estado = ILEGIBLE; }
    if (gen === genPuerto && !terminado) {
      estados.set(fotoId, estado);
      avisar({ tipo: 'foto', fotoId }); avisar({ tipo: 'resumen' });
    }
    return estado;
  }

  function transporteDe(p: FotosLocal, l: RespaldoFotosLocal): TransporteFotos {
    // El POST lleva el plazo del cliente de la composición (sin presupuesto ni servidor nuevos).
    transporte ??= crearTransporteFotos({ plan, origen, fuente: p, ledger: l, plazoMs: composicion.listado.plazoMs,
      ...(d.fetch ? { fetch: d.fetch } : {}),
      ...(composicion.maxBytesOriginal !== undefined ? { maxBytesOriginal: composicion.maxBytesOriginal } : {}) });
    return transporte;
  }

  async function cargar(fotoId: string, preparar: boolean, p: FotosLocal, gen: number): Promise<ResultadoRespaldo> {
    let error: unknown = null;
    let exito = false;
    let corto: ResultadoRespaldo | null = null;
    try {
      const l = await abrirLedger();
      let entrada = l && gen === genPuerto ? await l.leer(fotoId) : null;
      if (!l || gen !== genPuerto) corto = { tipo: 'no-disponible' };
      else if (entrada?.fase === 'respaldada') corto = { tipo: 'respaldada' };
      else if (entrada?.fase === 'bloqueada') corto = { tipo: 'bloqueada' };
      else if (!entrada && !preparar) corto = { tipo: 'no-disponible' };
      else {
        const metadatos = await p.leerMetadatos(fotoId);
        if (!metadatos || esFotoBorrada(metadatos) || gen !== genPuerto) {
          // Sin la foto viva en este móvil no hay nada que enviar: el ledger no se toca (ni pausa ni historia).
          corto = { tipo: 'no-disponible' };
        } else if (!entrada) {
          // Primera acción legítima: UNA operación nueva con la captura viva de PhotoDB, atestada por el ledger.
          const original = await p.leerOriginal(fotoId);
          if (!original || gen !== genPuerto) corto = { tipo: 'no-disponible' };
          else entrada = await l.preparar({ metadatos, original });
        }
        if (!corto && entrada && gen === genPuerto) {
          const t = transporteDe(p, l);
          activa = fotoId;
          avisar({ tipo: 'foto', fotoId }); avisar({ tipo: 'resumen' });
          // Misma operación siempre: reintentar solo quita la pausa durable, nunca regenera nada.
          if (entrada.pausada) await t.reintentar(referenciaDe(entrada));
          else await t.subir(referenciaDe(entrada));
          exito = true;
        }
      }
    } catch (e) {
      error = e;
    } finally {
      if (activa === fotoId) activa = null;
    }
    const durable = await leerDurable(fotoId, gen);
    return corto ?? resultadoDe(durable, error, exito);
  }

  function ejecutarCarga(fotoId: string, preparar: boolean): Promise<ResultadoRespaldo> {
    if (terminado) return Promise.resolve({ tipo: 'no-disponible' });
    // Un envío a la vez: tampoco mientras corre el lote (entre una foto y la siguiente).
    if (cargaEnCurso || recorriendo) return Promise.resolve({ tipo: 'ocupada' });
    if (!enLinea()) return Promise.resolve({ tipo: 'sin-conexion' });
    const p = sincronizarPuerto();
    if (!p || !esIdFoto(fotoId)) return Promise.resolve({ tipo: 'no-disponible' });
    const operacion = cargar(fotoId, preparar, p, genPuerto);
    cargaEnCurso = operacion;
    const liberar = () => { if (cargaEnCurso === operacion) cargaEnCurso = null; };
    void operacion.then(liberar, liberar);
    return operacion;
  }


  // ---------- Lote manual «Respaldar pendientes» ----------
  interface ElementoLote {
    readonly original: OriginalRespaldo;
    /** Operación ya preparada (sin envío ni pausa) que se conserva; null: se preparará al confirmar. */
    readonly operacionId: string | null;
    resultado: 'pendiente' | 'confirmada' | 'omitida' | 'revision';
  }
  type PasoLote = { readonly resultado: ElementoLote['resultado']; readonly motivo?: MotivoParadaLote };
  let lote: EstadoLote = { tipo: 'inactivo' };
  let elementosLote: ElementoLote[] = [];
  /** genPuerto del recuento: con otro PhotoDB, el consentimiento ya no vale. */
  let puertoLote = -1;
  /** Continuidad del consentimiento: sube al volver a contar, pausar, terminar o abandonar. */
  let genLote = 0;
  let recorriendo = false;
  let pasoLoteEnCurso = false;
  let motivoCorte: MotivoParadaLote | null = null;
  const VIA_LOTE: ViaProcedencia = 'camara-galeria';

  function ponerLote(e: EstadoLote) {
    lote = e;
    avisar({ tipo: 'lote' });
  }
  function progresoLote(): ProgresoLote {
    const cuenta = (r: ElementoLote['resultado']) => elementosLote.filter((x) => x.resultado === r).length;
    return { total: elementosLote.length, confirmadas: cuenta('confirmada'), omitidas: cuenta('omitida'),
      revision: cuenta('revision'), restantes: cuenta('pendiente') };
  }
  /** Solo un preparado sin envío, sin pausa y de la MISMA identidad sigue siendo enviable dentro del lote. */
  const preparadoLimpio = (e: EntradaRespaldo, o: OriginalRespaldo) => e.fase === 'preparado' && !e.enviada && !e.pausada
    && mismosOriginalesRespaldo(plan, e.original, o);

  async function contarLote(): Promise<void> {
    if (terminado || recorriendo || lote.tipo === 'contando') return;
    const gen = ++genLote;
    elementosLote = []; motivoCorte = null;
    const p = sincronizarPuerto();
    if (!p) { ponerLote({ tipo: 'no-disponible' }); return; }
    const genP = genPuerto;
    const vale = () => !terminado && gen === genLote && genP === genPuerto;
    ponerLote({ tipo: 'contando' });
    try {
      const l = await abrirLedger();
      if (!vale()) return;
      if (!l) throw new Error('Registro de respaldos no disponible');
      // Solo metadata: ningún original, miniatura, GET, POST ni preparación antes de confirmar.
      const fotos = await p.listar();
      if (!vale()) return;
      const porId = new Map((await l.listar()).map((e) => [e.fotoId, e]));
      if (!vale()) return;
      const elegibles: ElementoLote[] = [];
      let bytes = 0; let confirmadas = 0; let revision = 0; let sinOrigen = 0;
      for (const m of fotos) {
        const original = Object.freeze(copiarOriginalRespaldo(plan, m));
        const entrada = porId.get(m.fotoId);
        if (entrada?.fase === 'respaldada') { confirmadas++; continue; }
        // Enviada sin acuse, en pausa, bloqueada o de otra identidad: revisión aparte, nunca dentro del lote.
        if (entrada && !preparadoLimpio(entrada, original)) { revision++; continue; }
        let via: ViaProcedencia | null = null;
        try { via = p.leerProcedencia ? await p.leerProcedencia(m.fotoId) : null; } catch { via = null; }
        if (!vale()) return;
        if (via !== VIA_LOTE) { sinOrigen++; continue; }
        const suma = bytes + original.bytesOriginal;
        if (!Number.isSafeInteger(suma)) throw new Error('Suma de originales fuera de rango');
        bytes = suma;
        elegibles.push({ original, operacionId: entrada ? entrada.operacionId : null, resultado: 'pendiente' });
      }
      elementosLote = elegibles;
      puertoLote = genP;
      ponerLote({ tipo: 'propuesta', fotos: elegibles.length, bytes, confirmadas, revision, sinOrigen });
    } catch {
      if (vale()) { elementosLote = []; ponerLote({ tipo: 'no-disponible' }); }
    }
  }

  /** Una foto del recuento: revalida ledger, identidad viva y procedencia tras CADA await; la pausa (época) se
   * comprueba antes de preparar y antes de asignar el envío. Nunca adopta otra operación. */
  async function pasoLote(x: ElementoLote, gen: number): Promise<PasoLote> {
    pasoLoteEnCurso = true;
    const id = x.original.fotoId;
    try {
      const p = sincronizarPuerto();
      if (!p || puertoLote !== genPuerto) return { resultado: 'pendiente', motivo: 'error' };
      const genP = genPuerto;
      const sigue = () => !terminado && gen === genLote && genP === genPuerto;
      const l = await abrirLedger();
      if (!sigue()) return { resultado: 'pendiente' };
      if (!l) return { resultado: 'pendiente', motivo: 'error' };
      let entrada = await l.leer(id);
      if (!sigue()) return { resultado: 'pendiente' };
      if (entrada?.fase === 'respaldada') return { resultado: 'omitida' };
      if (entrada ? !preparadoLimpio(entrada, x.original) || (x.operacionId !== null && entrada.operacionId !== x.operacionId)
        : x.operacionId !== null) return { resultado: 'revision' };
      const m = await p.leerMetadatos(id);
      if (!sigue()) return { resultado: 'pendiente' };
      if (!m || esFotoBorrada(m) || !mismosOriginalesRespaldo(plan, copiarOriginalRespaldo(plan, m), x.original)) {
        return { resultado: 'omitida' };
      }
      const via = p.leerProcedencia ? await p.leerProcedencia(id) : null;
      if (!sigue()) return { resultado: 'pendiente' };
      if (via !== VIA_LOTE) return { resultado: 'omitida' };
      if (!entrada) {
        const original = await p.leerOriginal(id);
        if (!sigue()) return { resultado: 'pendiente' };
        if (!original) return { resultado: 'omitida' };
        entrada = await l.preparar({ metadatos: m, original });
        // Preparada y pausada a la vez: queda «preparado» sin envío y entra al continuar.
        if (!sigue()) return { resultado: 'pendiente' };
      }
      const t = transporteDe(p, l);
      activa = id;
      avisar({ tipo: 'foto', fotoId: id }); avisar({ tipo: 'resumen' });
      let error: unknown = null;
      // El lote solo envía su operación si sigue preparada sin envío: el transporte lo exige al reclamarla.
      try { await t.subir(referenciaDe(entrada), { soloPreparada: true }); } catch (e) { error = e; } finally {
        if (activa === id) activa = null;
      }
      const durable = await leerDurable(id, genP);
      if (error instanceof ErrorTransporteFotos && error.causa === 'admision') {
        // Otro contexto la envió, pausó o confirmó entretanto: sin POST del lote; se revisa aparte y el lote sigue.
        return { resultado: durable.tipo === 'respaldada' ? 'omitida' : 'revision' };
      }
      if (durable.tipo === 'respaldada') return { resultado: 'confirmada' };
      const resultado = ['sin-confirmar', 'pausado', 'bloqueada'].includes(durable.tipo) ? 'revision' : 'pendiente';
      if (error instanceof ErrorTransporteFotos) {
        if (error.causa === 'sin-sesion') return { resultado, motivo: 'sin-sesion' };
        if (error.causa === 'plazo') return { resultado, motivo: 'plazo' };
        // Detenida por la pausa del lote: el bucle lo ve en la época; por otra causa, se para.
        if (error.estado === 'detenida') return gen === genLote ? { resultado, motivo: 'error' } : { resultado };
        if (error.estado === 'incierta') return { resultado, motivo: 'incierta' };
      }
      return { resultado, motivo: 'error' };
    } catch {
      return { resultado: 'pendiente', motivo: 'error' };
    } finally { pasoLoteEnCurso = false; }
  }

  async function recorrerLote(): Promise<void> {
    const gen = ++genLote;
    motivoCorte = null;
    recorriendo = true;
    ponerLote({ tipo: 'enviando', progreso: progresoLote(), pausando: false });
    let motivo: MotivoParadaLote | null = null;
    try {
      // Admisión compartida: un respaldo individual en curso asienta antes de la primera foto del lote.
      while (cargaEnCurso && gen === genLote) { try { await cargaEnCurso; } catch { /* su resultado es suyo */ } }
      for (const x of elementosLote) {
        if (gen !== genLote) break;
        if (x.resultado !== 'pendiente') continue;
        if (!enLinea()) { motivo = 'sin-conexion'; break; }
        const paso = pasoLote(x, gen);
        cargaEnCurso = paso;
        let r: PasoLote;
        try { r = await paso; } finally { if (cargaEnCurso === paso) cargaEnCurso = null; }
        x.resultado = r.resultado;
        if (gen === genLote) ponerLote({ tipo: 'enviando', progreso: progresoLote(), pausando: false });
        if (r.motivo) { motivo = r.motivo; break; }
      }
    } finally {
      recorriendo = false;
    }
    if (terminado) return;
    if (gen !== genLote) motivo = motivoCorte ?? 'pausa';
    if (motivo) ponerLote({ tipo: 'detenido', progreso: progresoLote(), motivo });
    else ponerLote({ tipo: 'terminado', progreso: progresoLote() });
  }
  /** Corta la continuidad: la foto en curso se aborta, pero su IO sigue siendo suyo hasta que asienta. */
  function cortarLote(motivo: MotivoParadaLote) {
    motivoCorte = motivo;
    genLote++;
    if (pasoLoteEnCurso) transporte?.cancelar();
    if (lote.tipo === 'enviando') ponerLote({ tipo: 'enviando', progreso: lote.progreso, pausando: true });
  }

  function listadoDe(): ListadoFotos | null {
    if (listado) return listado;
    if (listadoNoDisponible) return null;
    try {
      listado = d.fetch
        ? crearClienteListadoFotos({ plan, origen, presupuesto: composicion.listado, http: { fetch: d.fetch } })
        : crearClienteListadoFotos({ plan, origen, presupuesto: composicion.listado });
      return listado;
    } catch {
      // Fábrica neutra: sin red ni reintento; el catálogo no existe en este contexto.
      listadoNoDisponible = true;
      catalogo = { tipo: 'no-disponible' };
      avisar({ tipo: 'catalogo' });
      return null;
    }
  }

  /** Sin sesión: la página del catálogo (candidatas temporales) y las capturas de esta sesión se sueltan; una
   * consulta en curso ya no se pinta. El ledger y las fotos guardadas en este móvil no se tocan. */
  function soltarPorSesion(propia: boolean) {
    autorizacion++;
    genCatalogo++;
    continuacion = null;
    capturas.clear();
    if (consultando) listado?.cancelar();
    if (catalogo.tipo === 'pagina' || catalogo.tipo === 'consultando') catalogo = { tipo: 'fallo', motivo: 'sin-sesion' };
    avisar({ tipo: 'catalogo' });
    if (propia) avisar({ tipo: 'sin-sesion' });
  }
  /** ÚNICA puerta de las capturas privadas (bytes recibidos de un guardado que no llegó a PhotoDB): solo se retienen
   * si siguen siendo de la MISMA autorización y del MISMO PhotoDB con que empezó ese guardado. Un 401 entretanto las
   * descarta: ni archivo, ni URL. Las fotos que sí se guardaron en este móvil no dependen de esto. */
  function retenerCaptura(fotoId: string, captura: CapturaFoto, epoca: number, gen: number): boolean {
    if (terminado || epoca !== autorizacion || gen !== genPuerto) return false;
    capturas.set(fotoId, { captura, autorizacion: epoca });
    return true;
  }
  function actualizarFila(gen: number, fotoId: string, cambios: Partial<Omit<FilaCatalogo, 'original'>>) {
    if (gen !== genCatalogo || catalogo.tipo !== 'pagina') return;
    const filas = catalogo.filas.map((f) => (f.original.fotoId === fotoId ? { ...f, ...cambios } : f));
    catalogo = { ...catalogo, filas };
    avisar({ tipo: 'catalogo' });
  }

  function descargaDe(p: FotosLocal): DescargaFotos {
    // La misma política de original que el transporte: 0 también vale (ningún original positivo se pide).
    descarga ??= crearDescargaFotos({ plan, origen, fotos: p, plazoMs: composicion.listado.plazoMs, ...(d.fetch ? { fetch: d.fetch } : {}),
      ...(composicion.maxBytesOriginal !== undefined ? { maxBytesOriginal: composicion.maxBytesOriginal } : {}) });
    return descarga;
  }

  return {
    get fase() { return fase; },
    get catalogo() { return catalogo; },
    get lote() { return lote; },
    contarLote,
    async confirmarLote() {
      if (terminado || recorriendo || lote.tipo !== 'propuesta') return;
      if (elementosLote.length === 0) { ponerLote({ tipo: 'inactivo' }); return; }
      await recorrerLote();
    },
    pausarLote() {
      if (lote.tipo === 'enviando' && !lote.pausando) cortarLote('pausa');
    },
    async continuarLote() {
      if (terminado || recorriendo || lote.tipo !== 'detenido' || lote.motivo === 'cerrado') return;
      if (!elementosLote.some((x) => x.resultado === 'pendiente')) return;
      await recorrerLote();
    },
    terminarLote() {
      if (recorriendo || lote.tipo === 'enviando') return;
      genLote++;
      elementosLote = []; motivoCorte = null;
      ponerLote({ tipo: 'inactivo' });
    },
    abandonarLote() {
      if (lote.tipo === 'contando' || lote.tipo === 'propuesta') {
        genLote++; elementosLote = [];
        ponerLote({ tipo: 'inactivo' });
      } else if (lote.tipo === 'enviando') cortarLote('cerrado');
      else if (lote.tipo === 'detenido' && lote.motivo !== 'cerrado') {
        ponerLote({ tipo: 'detenido', progreso: lote.progreso, motivo: 'cerrado' });
      }
    },
    async leer(fotoId) {
      if (terminado) return ILEGIBLE;
      const p = sincronizarPuerto();
      if (!p) return ILEGIBLE;
      const estado = await leerDurable(fotoId, genPuerto);
      return activa === fotoId ? ENVIANDO : estado;
    },
    estado(fotoId) {
      if (activa === fotoId) return ENVIANDO;
      return estados.get(fotoId) ?? null;
    },
    enCurso: (fotoId) => activa === fotoId,
    async resumen() {
      if (terminado) throw new Error('El respaldo de fotos está cerrado.');
      const p = sincronizarPuerto();
      if (!p) throw new Error('Las fotos de este móvil no están abiertas.');
      const gen = genPuerto;
      const l = await abrirLedger();
      if (!l || gen !== genPuerto) throw new Error('No se pudo abrir el estado de los respaldos.');
      const lista = await l.listar();
      return lista.map((e) => ({ fotoId: e.fotoId, estado: activa === e.fotoId ? ENVIANDO : estadoDeEntrada(e),
        original: e.original }));
    },
    async estimar(fotoId) {
      if (terminado) return null;
      const p = sincronizarPuerto();
      if (!p) return null;
      try {
        const m = await p.leerMetadatos(fotoId);
        return m && !esFotoBorrada(m) ? { bytesOriginal: m.bytesOriginal } : null;
      } catch { return null; }
    },
    respaldar: (fotoId) => ejecutarCarga(fotoId, true),
    reintentar: (fotoId) => ejecutarCarga(fotoId, false),
    async pausar(fotoId) {
      if (terminado) return { tipo: 'no-disponible' };
      const p = sincronizarPuerto();
      if (!p || !esIdFoto(fotoId)) return { tipo: 'no-disponible' };
      const gen = genPuerto;
      try {
        const l = await abrirLedger();
        const entrada = l && gen === genPuerto ? await l.leer(fotoId) : null;
        // Una respaldada o bloqueada no se toca: no hay nada que pausar.
        if (l && entrada && gen === genPuerto && entrada.fase !== 'respaldada' && entrada.fase !== 'bloqueada') {
          await transporteDe(p, l).pausar(referenciaDe(entrada));
        }
      } catch { /* No se afirma la pausa: manda la lectura durable. */ }
      const durable = await leerDurable(fotoId, gen);
      if (durable.tipo === 'pausado') return { tipo: 'pausado' };
      return durable.tipo === 'respaldada' ? { tipo: 'respaldada' } : { tipo: 'no-disponible' };
    },
    async listar(desde) {
      if (terminado || consultando) return;
      sincronizarPuerto();
      const l = listadoDe();
      if (!l) return;
      const cursor = desde === 'siguiente' ? continuacion : null;
      if (desde === 'siguiente' && cursor === null) return;
      const gen = ++genCatalogo;
      consultando = true;
      catalogo = { tipo: 'consultando', desde };
      avisar({ tipo: 'catalogo' });
      let r: ResultadoListadoFotosCliente;
      try { r = await l.listar(cursor); }
      catch { r = { tipo: 'fallida', motivo: 'respuesta-inesperada' }; }
      finally { consultando = false; }
      if (gen !== genCatalogo || terminado) return;
      if (r.tipo === 'pagina') {
        try {
          const p = sincronizarPuerto();
          if (gen !== genCatalogo) return;
          const filas: FilaCatalogo[] = [];
          for (const texto of r.pagina.solicitudesIniciales) {
            const original = deserializarSolicitudRespaldo(plan, texto).original;
            const local = await clasificarEnEsteMovil(plan, original, p);
            filas.push({ original, local, accion: accionDe(local) });
          }
          if (gen !== genCatalogo || terminado) return;
          // La página sustituye a la anterior: no se acumula ni se sigue la continuación.
          continuacion = r.pagina.continuacion;
          catalogo = { tipo: 'pagina', filas, primera: cursor === null, hayMas: continuacion !== null };
        } catch {
          if (gen !== genCatalogo || terminado) return;
          catalogo = { tipo: 'fallo', motivo: 'respuesta' };
        }
      } else if (r.tipo === 'fallida') catalogo = { tipo: 'fallo', motivo: motivoCatalogo(r.motivo) };
      else catalogo = { tipo: 'detenido', motivo: r.motivo };
      avisar({ tipo: 'catalogo' });
      // Un 401 del catálogo sube la época de autorización (capturas en curso incluidas) y avisa: también invalida
      // las compartidas de las fichas.
      if (r.tipo === 'fallida' && r.motivo === 'sin-sesion') soltarPorSesion(true);
    },
    cancelarListado() { if (consultando) listado?.cancelar(); },
    async guardar(fotoId, descubierta): Promise<ResultadoGuardado> {
      if (terminado) return NO_DISPONIBLE;
      if (descargaEnCurso) return { tipo: 'ocupada' };
      // Si cambió PhotoDB, la página se descarta antes de buscar la fila.
      const p = sincronizarPuerto();
      if (!p) return NO_DISPONIBLE;
      // Referencia, puerto, generaciones y época de autorización capturados ANTES del primer await.
      const gen = genPuerto;
      const genC = genCatalogo;
      const epoca = autorizacion;
      let ref: OriginalRespaldo;
      if (descubierta !== undefined) {
        // De la ficha de su destino: identidad completa validada con el plan y del MISMO fotoId. Borrada u ocupada
        // por otra captura aquí, la descarga lo rechaza antes de cualquier GET (nunca resucita ni sobrescribe).
        try { ref = copiarIdentidadRespaldo(plan, descubierta); } catch { return NO_DISPONIBLE; }
        if (ref.fotoId !== fotoId) return NO_DISPONIBLE;
      } else {
        if (catalogo.tipo !== 'pagina') return NO_DISPONIBLE;
        const fila = catalogo.filas.find((f) => f.original.fotoId === fotoId);
        if (!fila || !fila.accion) return NO_DISPONIBLE;
        ref = fila.original;
      }
      // La fila del catálogo (si la hay) solo cambia si es la MISMA identidad.
      const marcar = (cambios: Partial<Omit<FilaCatalogo, 'original'>>) => {
        if (catalogo.tipo === 'pagina' && catalogo.filas.some((f) => f.original.fotoId === fotoId
          && mismosOriginalesRespaldo(plan, f.original, ref))) actualizarFila(genC, fotoId, cambios);
      };
      let instancia: DescargaFotos;
      try { instancia = descargaDe(p); }
      catch { marcar({ estado: 'no-guardada', captura: undefined }); return { tipo: 'no-guardada' }; }
      capturas.delete(fotoId);
      marcar({ estado: 'guardando', captura: undefined });
      const operacion = (async () => {
        // Foto fresca de PhotoDB antes del GET: distingue una guardada nueva de una comprobada (bytes por la biblioteca).
        let antes: 'ausente' | 'presente' | 'desconocido' = 'desconocido';
        try { antes = (await p.leerMetadatos(ref.fotoId)) === null ? 'ausente' : 'presente'; }
        catch { /* sin afirmar nada */ }
        const r: ResultadoDescargaFotos = await instancia.descargar(ref);
        return { r, antes };
      })();
      descargaEnCurso = operacion;
      let salida: { r: ResultadoDescargaFotos; antes: 'ausente' | 'presente' | 'desconocido' };
      try { salida = await operacion; }
      finally { if (descargaEnCurso === operacion) descargaEnCurso = null; }
      const { r, antes } = salida;
      if (terminado) return NO_DISPONIBLE;
      if (r.tipo === 'guardada') {
        let misma = false;
        try {
          misma = gen === genPuerto && d.puerto() === p
            && mismosOriginalesRespaldo(plan, copiarOriginalRespaldo(plan, r.captura.metadatos), ref);
        } catch { misma = false; }
        if (misma) {
          // Única condición de incorporación: guardada, misma identidad pedida y mismo PhotoDB capturado.
          try { d.incorporar(r.captura.metadatos); } catch { /* la interfaz no altera lo durable */ }
          const estado = antes === 'presente' ? 'comprobada' : 'guardada';
          marcar({ estado, local: 'registrada', accion: 'comprobar' });
          return { tipo: estado };
        }
        marcar({ estado: 'detenida' });
        return { tipo: 'detenida' };
      }
      if (r.tipo === 'fallida') {
        if (r.causa === 'sin-sesion') {
          // 401: no se guardó nada y la sesión ya no vale: fuera todas las candidatas temporales.
          marcar({ estado: 'no-guardada' });
          soltarPorSesion(true);
          return { tipo: 'no-guardada', causa: 'sin-sesion' };
        }
        // Cuota, colisión o cualquier otro fallo de escritura: la captura pasa por la misma puerta.
        const conCaptura = !!r.captura && retenerCaptura(fotoId, r.captura, epoca, gen);
        marcar(conCaptura ? { estado: 'no-guardada', captura: true } : { estado: 'no-guardada' });
        const causa = r.causa === 'plazo' ? { causa: 'plazo' as const } : {};
        return conCaptura ? { tipo: 'no-guardada', captura: true, ...causa } : { tipo: 'no-guardada', ...causa };
      }
      marcar({ estado: 'detenida' });
      return { tipo: 'detenida' };
    },
    cancelarGuardado() { descarga?.cancelar(); },
    invalidarSesion() { if (!terminado) soltarPorSesion(false); },
    descargarArchivo(fotoId) {
      const guardada = capturas.get(fotoId);
      // Solo una captura de la autorización vigente; nunca una URL nueva tras un 401.
      if (!guardada || terminado || guardada.autorizacion !== autorizacion) return null;
      const c = guardada.captura;
      // Mismos bytes como octet-stream: se descargan, nunca se muestran ni se guardan en PhotoDB.
      const blob = Blob.prototype.slice.call(c.original, 0, tamanoBlob(c.original), 'application/octet-stream') as Blob;
      const url = crearUrl(blob);
      entregadas.add(url);
      return { url, nombre: c.metadatos.nombre };
    },
    soltarUrl(url) { if (entregadas.delete(url)) revocarUrl(url); },
    cerrar() {
      if (terminado) return;
      terminado = true;
      fase = 'terminada';
      genLote++;
      transporte?.cerrar(); transporte = null;
      descarga?.cerrar(); descarga = null;
      listado?.cerrar(); listado = null;
      ledger?.cerrar(); ledger = null;
      for (const u of entregadas) revocarUrl(u);
      entregadas.clear();
      capturas.clear();
    },
  };
}

// ---------- Copy (español, honesto) ----------

export const COPIA_SIN_CONFIRMAR = 'Respaldo sin confirmar. Conserva el original; reintentar no garantiza recuperarlo.';
export const COPIA_RESPALDADA = 'El servidor confirmó la copia al enviarla; no se ha vuelto a comprobar.';

export function pesoLegible(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return `${(bytes / (1024 * 1024)).toLocaleString('es-ES', { maximumFractionDigits: 1 })} MB`;
}

/** Línea de estado del respaldo en el visor. La ausencia de acuse en este móvil no prueba ausencia remota. */
export function textoEstadoRespaldo(e: EstadoRespaldo): string {
  switch (e.tipo) {
    case 'sin-respaldo': return 'Sin respaldo confirmado en este móvil.';
    case 'preparado': return 'Preparada para respaldar; aún no se ha enviado.';
    case 'enviando': return 'Respaldando… Puedes pausarlo; si ya salió, el servidor puede recibirla igualmente.';
    case 'sin-confirmar': return COPIA_SIN_CONFIRMAR;
    case 'pausado': return 'Respaldo en pausa. Conserva el original.';
    case 'respaldada': return COPIA_RESPALDADA;
    case 'bloqueada': return 'El servidor contestó algo que no corresponde a esta foto. Se conserva todo y no se vuelve a enviar.';
    case 'ilegible': return 'No se pudo leer el estado del respaldo en este móvil.';
  }
}

/** Advertencia al borrar la copia LOCAL (D-U1): se permite, diciendo que puede ser la única copia. */
export function avisoBorradoRespaldo(e: EstadoRespaldo | null): string {
  const tipo = e?.tipo;
  const situacion = tipo === 'respaldada' ? COPIA_RESPALDADA
    : tipo === 'sin-confirmar' || tipo === 'enviando' || tipo === 'pausado' || tipo === 'bloqueada'
      ? 'Su respaldo está sin confirmar: puede que esta sea la única copia.'
      : 'No hay un respaldo confirmado en este móvil; puede que esta sea la única copia.';
  return `¿Borrar esta foto de este móvil? ${situacion} Si la borras, este móvil no podrá volver a guardarla. No se puede deshacer.`;
}

/** Línea de estado del catálogo. Una página vacía nunca prueba que no haya envíos sin confirmar. */
export function textoCatalogo(c: EstadoCatalogo, maxFilas: number): string {
  switch (c.tipo) {
    case 'reposo': return `Fotos respaldadas desde cualquiera de los dos móviles. Se consultan ${maxFilas === 1 ? 'de una en una' : `de ${maxFilas} en ${maxFilas}`}.`;
    case 'no-disponible': return 'El catálogo no está disponible aquí.';
    case 'consultando': return 'Consultando…';
    case 'pagina':
      if (c.filas.length) return c.primera ? 'Fotos respaldadas confirmadas en el servidor.' : 'Siguientes fotos respaldadas confirmadas.';
      return c.primera ? 'No hay fotos respaldadas confirmadas en el servidor. No significa que no haya envíos sin confirmar.'
        : 'Esta página no tiene fotos respaldadas confirmadas.';
    case 'fallo':
      if (c.motivo === 'sin-sesion') return 'Este móvil no tiene sesión en el servidor.';
      if (c.motivo === 'servidor') return 'El servidor no respondió como se esperaba. No se ha cambiado nada en este móvil.';
      if (c.motivo === 'continuacion') return 'Esa continuación ya no vale.';
      if (c.motivo === 'ocupado') return 'La consulta anterior aún se está cerrando. Prueba en un momento.';
      return 'La respuesta no es válida; no se ha guardado nada.';
    case 'detenido':
      if (c.motivo === 'cancelada') return 'Consulta cancelada; no se ha guardado nada.';
      if (c.motivo === 'plazo') return 'Tardó demasiado; no se ha guardado nada.';
      return 'El catálogo se cerró.';
  }
}

/** Lo que este móvil sabe de una fila. «Registrada» es solo metadata: comprobar descarga el original para compararlo. */
export function textoFilaCatalogo(f: FilaCatalogo): string {
  if (f.estado === 'guardando') return 'Guardando…';
  if (f.estado === 'guardada') return 'Guardada en este móvil.';
  if (f.estado === 'comprobada') return 'Comprobada: es la misma foto que ya había en este móvil.';
  if (f.estado === 'no-guardada') return 'No se pudo guardar aquí.';
  if (f.estado === 'detenida') return 'Descarga detenida; no se da nada por guardado.';
  if (f.local === 'registrada') return 'Foto registrada en este móvil.';
  if (f.local === 'borrada') return 'Borrada en este móvil: aquí no se puede volver a guardar.';
  if (f.local === 'otra') return 'Otra foto de este móvil usa su identidad.';
  if (f.local === 'ilegible') return 'No se pudo comprobar en este móvil.';
  return '';
}

export function textoResultadoRespaldo(r: ResultadoRespaldo): string {
  switch (r.tipo) {
    case 'respaldada': return 'Respaldada: el servidor confirmó la copia.';
    case 'sin-confirmar': return COPIA_SIN_CONFIRMAR;
    case 'pausado': return 'Respaldo en pausa. Si ya había salido, el servidor puede recibirla igualmente.';
    case 'no-enviada': return 'No se envió en esta acción.';
    case 'ocupada': return 'Ya hay un respaldo en curso; espera a que termine.';
    case 'sin-conexion': return 'Sin conexión: no se puede respaldar ahora.';
    case 'no-disponible': return 'No se pudo hacer ahora; no se da nada por respaldado.';
    case 'bloqueada': return 'El servidor contestó algo que no corresponde a esta foto. Se conserva todo y no se vuelve a enviar.';
  }
}

/** Copy del lote «Respaldar pendientes». No promete datos móviles gratis, wifi ni que pausar evite costes. */
export function textoLote(l: EstadoLote): { readonly estado: string; readonly detalle: string } {
  const fotos = (n: number) => `${n} ${n === 1 ? 'foto' : 'fotos'}`;
  const fuera = (p: Extract<EstadoLote, { tipo: 'propuesta' }>) => {
    const partes: string[] = [];
    if (p.confirmadas) partes.push(`${p.confirmadas} ya ${p.confirmadas === 1 ? 'confirmada' : 'confirmadas'}`);
    if (p.revision) partes.push(`${p.revision} para revisar`);
    if (p.sinOrigen) {
      partes.push(p.sinOrigen === 1
        ? '1 sin origen comprobado aquí (anterior, descargada o importada: se respalda desde su visor)'
        : `${p.sinOrigen} sin origen comprobado aquí (anteriores, descargadas o importadas: se respaldan desde su visor)`);
    }
    return partes.length ? `Quedan fuera: ${partes.join(' · ')}.` : '';
  };
  const cuenta = (p: ProgresoLote) => `${p.confirmadas} de ${p.total} confirmadas`;
  const balance = (p: ProgresoLote) => [
    p.revision ? `${p.revision} para revisar aparte (sin confirmar).` : '',
    p.omitidas ? `${p.omitidas} ${p.omitidas === 1 ? 'omitida: ya no estaba o cambió.' : 'omitidas: ya no estaban o cambiaron.'}` : '',
  ].filter(Boolean).join(' ');
  switch (l.tipo) {
    case 'inactivo': return { estado: '', detalle: '' };
    case 'contando': return { estado: 'Contando las fotos pendientes de este móvil…', detalle: '' };
    case 'no-disponible':
      return { estado: 'No se pudieron leer las fotos o el registro de respaldos de este móvil; no se ha enviado nada.', detalle: '' };
    case 'propuesta':
      if (l.fotos === 0) return { estado: 'No hay fotos añadidas aquí con la cámara o la galería pendientes de respaldo.', detalle: fuera(l) };
      return { estado: `¿Respaldar ${fotos(l.fotos)} ${l.fotos === 1 ? 'añadida' : 'añadidas'} aquí con la cámara o la galería `
        + `(≈ ${pesoLegible(l.bytes)} de originales)?`,
      detalle: ['Se envían de una en una al servidor del viaje; los datos móviles pueden tener coste.', fuera(l)].filter(Boolean).join(' ') };
    case 'enviando':
      return { estado: l.pausando ? `Pausando: ${cuenta(l.progreso)}.` : `Respaldando: ${cuenta(l.progreso)} por el servidor.`, detalle: '' };
    case 'terminado': return { estado: `Lote terminado: ${cuenta(l.progreso)} por el servidor.`, detalle: balance(l.progreso) };
    case 'detenido': {
      const p = l.progreso;
      if (l.motivo === 'pausa') {
        return { estado: `En pausa: ${cuenta(p)}.`,
          detalle: ['Si una foto ya había salido, el servidor puede recibirla igualmente.', balance(p)].filter(Boolean).join(' ') };
      }
      if (l.motivo === 'cerrado') {
        return { estado: `Se detuvo al salir de esta vista: ${cuenta(p)}.`,
          detalle: ['Para seguir, vuelve a respaldar las pendientes.', balance(p)].filter(Boolean).join(' ') };
      }
      const causa = { 'sin-sesion': 'este móvil no tiene sesión en el servidor', 'plazo': 'tardó demasiado',
        'incierta': 'una foto quedó sin confirmar', 'error': 'no se pudo enviar', 'sin-conexion': 'sin conexión' }[l.motivo];
      return { estado: `Parado: ${causa}. ${cuenta(p)}.`, detalle: balance(p) };
    }
  }
}

// ---------- «Fotos del viaje» en «Todo» (DOM; solo con la composición activada) ----------

export interface OpcionesSeccionFotosViaje {
  readonly respaldo: RespaldoFotos;
  readonly nombreDe: (destino: DestinoFoto) => string;
  /** N del catálogo, para decir de cuántas en cuántas se consultan. */
  readonly maxFilas: number;
  /** Fase de las fotos de este móvil: el estado local solo se lee con la base abierta. */
  readonly fotos: () => 'cerrada' | 'abriendo' | 'lista' | 'fallo' | 'terminada';
  readonly enLinea?: () => boolean;
}
export interface SeccionFotosViaje {
  montar(contenedor: HTMLElement): void;
  /** Repinta la parte afectada; el resumen se vuelve a leer del ledger (0 red). */
  alCambiar(que: CambioRespaldo): void;
  /** Delegación de clics de la sección: devuelve true si era suyo. */
  manejarClic(objetivo: Element): boolean;
  desmontar(): void;
}

const NOTA_VIAJE = 'Nada se envía ni se consulta solo: cada respaldo y cada consulta empiezan con un toque. Los datos móviles pueden tener coste.';

function elemento<K extends keyof HTMLElementTagNameMap>(tag: K, clase?: string, texto?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (clase) e.className = clase;
  if (texto !== undefined) e.textContent = texto;
  return e;
}
function boton(texto: string, clase: string, datos: Record<string, string>): HTMLButtonElement {
  const b = elemento('button', clase, texto);
  b.type = 'button';
  for (const [k, v] of Object.entries(datos)) b.setAttribute(`data-${k}`, v);
  return b;
}
const ATRIBUTOS_ACCION = ['data-catalogo-ver', 'data-catalogo-siguientes', 'data-catalogo-principio', 'data-catalogo-reintentar',
  'data-catalogo-cancelar', 'data-catalogo-guardar', 'data-catalogo-cancelar-guardado', 'data-catalogo-archivo',
  'data-viaje-reintentar', 'data-lote-contar', 'data-lote-confirmar', 'data-lote-pausar', 'data-lote-continuar',
  'data-lote-terminar'];

export function crearSeccionFotosViaje(o: OpcionesSeccionFotosViaje): SeccionFotosViaje {
  const { respaldo, nombreDe } = o;
  const enLinea = o.enLinea ?? (() => typeof navigator === 'undefined' || navigator.onLine !== false);
  let contenedor: HTMLElement | null = null;
  let gen = 0;
  let resumen: readonly ResumenRespaldo[] | null = null;
  let resumenFallido = false;
  /** Solo la última lectura del ledger pinta: una respuesta anterior más lenta no pisa a la nueva. */
  let lecturaResumen = 0;
  let ultimoDesde: 'principio' | 'siguiente' = 'principio';
  /** Fotos con una acción de respaldo pedida desde esta sección y su último resultado (texto). */
  const enAccion = new Set<string>();
  const resultados = new Map<string, string>();

  function refrescarResumen() {
    const g = gen;
    const n = ++lecturaResumen;
    // Sin las fotos abiertas no hay ledger que leer todavía: se repinta cuando abran (sin error falso).
    if (o.fotos() !== 'lista') { resumen = null; resumenFallido = false; pintar(); return; }
    void respaldo.resumen().then((r) => {
      if (g !== gen || n !== lecturaResumen) return;
      resumen = r; resumenFallido = false; pintar();
    }, () => {
      if (g !== gen || n !== lecturaResumen) return;
      resumenFallido = true; pintar();
    });
  }
  function textoResumen(): string {
    const fase = o.fotos();
    if (fase === 'fallo' || fase === 'terminada') return 'No se pudieron abrir las fotos de este móvil.';
    if (fase !== 'lista') return 'Abriendo las fotos de este móvil…';
    if (resumenFallido) return 'No se pudo leer el estado de los respaldos de este móvil.';
    if (!resumen) return 'Leyendo el estado de los respaldos de este móvil…';
    const cuenta = (tipos: EstadoRespaldo['tipo'][]) => resumen!.filter((r) => tipos.includes(r.estado.tipo)).length;
    const partes = [
      [cuenta(['respaldada']), 'respaldada', 'respaldadas'],
      [cuenta(['sin-confirmar', 'enviando']), 'sin confirmar', 'sin confirmar'],
      [cuenta(['pausado']), 'en pausa', 'en pausa'],
      [cuenta(['bloqueada']), 'bloqueada', 'bloqueadas'],
      [cuenta(['preparado']), 'preparada sin enviar', 'preparadas sin enviar'],
    ] as const;
    const texto = partes.filter(([n]) => n > 0).map(([n, uno, varios]) => `${n} ${n === 1 ? uno : varios}`).join(' · ');
    return texto || 'Aún no hay respaldos registrados en este móvil.';
  }
  function filaResumen(r: ResumenRespaldo): HTMLLIElement {
    const li = elemento('li');
    const texto = elemento('span', 'fila-texto', `«${r.original.nombre}»`);
    const etiqueta = r.estado.tipo === 'pausado' ? 'En pausa' : r.estado.tipo === 'bloqueada' ? 'No se vuelve a enviar'
      : r.estado.tipo === 'enviando' ? 'Respaldando…' : 'Sin confirmar';
    texto.append(elemento('small', r.estado.tipo === 'bloqueada' ? 'fila-estado bloqueada' : 'fila-estado',
      `${nombreDe(r.original.destino)} · ${resultados.get(r.fotoId) ?? etiqueta}`));
    li.append(texto);
    const ocupada = enAccion.has(r.fotoId);
    if (r.estado.tipo === 'sin-confirmar' || r.estado.tipo === 'pausado') {
      const b = boton('Reintentar', 'boton', { 'viaje-reintentar': r.fotoId });
      b.setAttribute('aria-label', `Reintentar el respaldo de «${r.original.nombre}»`);
      if (ocupada) b.setAttribute('aria-disabled', 'true');
      li.append(b);
    }
    return li;
  }
  /** Botones del lote según su estado; un solo botón en tinta (la confirmación). */
  function accionesLote(): HTMLElement[] {
    const l = respaldo.lote;
    const contar = (ocupado = false) => {
      const b = boton('Respaldar pendientes', 'boton', { 'lote-contar': '' });
      if (ocupado) b.setAttribute('aria-disabled', 'true');
      return b;
    };
    switch (l.tipo) {
      case 'inactivo': case 'terminado': case 'no-disponible': return [contar()];
      case 'contando': return [contar(true)];
      case 'propuesta':
        if (l.fotos === 0) return [boton('Cerrar', 'mini suave', { 'lote-terminar': '' })];
        return [boton(`Respaldar ${l.fotos} ${l.fotos === 1 ? 'foto' : 'fotos'}`, 'boton tinta', { 'lote-confirmar': '' }),
          boton('Cancelar', 'mini suave', { 'lote-terminar': '' })];
      case 'enviando': {
        const b = boton(l.pausando ? 'Pausando…' : 'Pausar', 'boton', { 'lote-pausar': '' });
        if (l.pausando) b.setAttribute('aria-disabled', 'true');
        return [b];
      }
      case 'detenido': {
        if (l.motivo === 'cerrado') return [contar()];
        const r: HTMLElement[] = [];
        if (l.progreso.restantes > 0) r.push(boton(`Continuar (${l.progreso.restantes})`, 'boton', { 'lote-continuar': '' }));
        if (l.motivo === 'sin-sesion' && enLinea()) {
          // Solo un enlace: la navegación es de quien lo toca, nunca una redirección sola.
          const a = elemento('a', 'boton', 'Entrar');
          a.href = '/entrar';
          r.push(a);
        }
        r.push(boton('Terminar', 'mini suave', { 'lote-terminar': '' }));
        return r;
      }
    }
  }
  function accionesCatalogo(): HTMLElement[] {
    const c = respaldo.catalogo;
    const ver = () => boton('Ver fotos respaldadas', 'boton', { 'catalogo-ver': '' });
    switch (c.tipo) {
      case 'reposo': return [ver()];
      case 'no-disponible': return [];
      case 'consultando': return [boton('Cancelar', 'mini suave', { 'catalogo-cancelar': '' })];
      case 'pagina': return [
        ...(c.hayMas ? [boton('Siguientes', 'boton', { 'catalogo-siguientes': '' })] : []),
        boton(c.primera ? 'Volver a consultar' : 'Desde el principio', 'mini suave', { 'catalogo-principio': '' }),
      ];
      case 'fallo':
        if (c.motivo === 'sin-sesion') {
          if (!enLinea()) return [];
          // Solo un enlace: la navegación es del usuario, nunca una redirección sola.
          const a = elemento('a', 'boton', 'Entrar');
          a.href = '/entrar';
          return [a];
        }
        if (c.motivo === 'continuacion') return [boton('Desde el principio', 'boton', { 'catalogo-principio': '' })];
        return [boton('Reintentar', 'boton', { 'catalogo-reintentar': '' })];
      case 'detenido':
        return c.motivo === 'plazo' ? [boton('Reintentar', 'boton', { 'catalogo-reintentar': '' })] : [ver()];
    }
  }
  function filaCatalogo(f: FilaCatalogo): HTMLLIElement {
    const li = elemento('li');
    const o2 = f.original;
    const texto = elemento('span', 'fila-texto', `«${o2.nombre}»`);
    texto.append(elemento('small', 'fila-estado', `${nombreDe(o2.destino)} · ${pesoLegible(o2.bytesOriginal)}`));
    const situacion = textoFilaCatalogo(f);
    if (situacion) texto.append(elemento('small', 'fila-estado', situacion));
    if (f.captura) texto.append(elemento('small', 'fila-estado', 'El archivo no queda en las fotos de este móvil.'));
    li.append(texto);
    if (f.estado === 'guardando') {
      li.append(boton('Cancelar', 'mini suave', { 'catalogo-cancelar-guardado': o2.fotoId }));
      return li;
    }
    if (f.accion && f.estado !== 'guardada' && f.estado !== 'comprobada') {
      const b = boton(f.accion === 'guardar' ? `Guardar en este móvil (${pesoLegible(o2.bytesOriginal)})`
        : `Comprobar y guardar (descarga ${pesoLegible(o2.bytesOriginal)} para comparar)`, 'boton', { 'catalogo-guardar': o2.fotoId });
      li.append(b);
    }
    if (f.captura) li.append(boton('Descargar archivo', 'boton', { 'catalogo-archivo': o2.fotoId }));
    return li;
  }

  function huella(e: Element): string {
    return ATRIBUTOS_ACCION.map((a) => `${a}=${e.getAttribute(a)}`).join('|');
  }
  function pintar() {
    if (!contenedor || !contenedor.isConnected) return;
    const lineaResumen = contenedor.querySelector<HTMLElement>('.estado-fotos-viaje');
    const filasResumen = contenedor.querySelector<HTMLElement>('.filas-resumen');
    const lineaCatalogo = contenedor.querySelector<HTMLElement>('.estado-catalogo');
    const acciones = contenedor.querySelector<HTMLElement>('.acciones-catalogo');
    const filasCatalogo = contenedor.querySelector<HTMLElement>('.filas-catalogo');
    const lineaLote = contenedor.querySelector<HTMLElement>('.estado-lote');
    const detalleLote = contenedor.querySelector<HTMLElement>('.detalle-lote');
    const botonesLote = contenedor.querySelector<HTMLElement>('.acciones-lote');
    if (!lineaResumen || !filasResumen || !lineaCatalogo || !acciones || !filasCatalogo || !lineaLote || !detalleLote
      || !botonesLote) return;
    const foco = document.activeElement instanceof HTMLElement && contenedor.contains(document.activeElement)
      ? document.activeElement : null;
    const buscada = foco ? huella(foco) : '';
    lineaResumen.textContent = textoResumen();
    const pendientes = (resumen ?? []).filter((r) => ['sin-confirmar', 'pausado', 'bloqueada', 'enviando'].includes(r.estado.tipo));
    filasResumen.replaceChildren(...pendientes.map(filaResumen));
    // Lote: región viva estable (solo cambia su texto) y sus botones, sustituidos solo si cambian.
    const tl = textoLote(respaldo.lote);
    if (lineaLote.parentElement) lineaLote.parentElement.dataset.estado = respaldo.lote.tipo;
    if (lineaLote.textContent !== tl.estado) lineaLote.textContent = tl.estado;
    if (detalleLote.textContent !== tl.detalle) detalleLote.textContent = tl.detalle;
    const nuevosLote = accionesLote();
    const firmaLote = nuevosLote.map((b) => b.outerHTML).join('');
    if (botonesLote.dataset.firma !== firmaLote) { botonesLote.dataset.firma = firmaLote; botonesLote.replaceChildren(...nuevosLote); }
    const texto = textoCatalogo(respaldo.catalogo, o.maxFilas);
    // Región viva estable: solo cambia su texto.
    if (lineaCatalogo.textContent !== texto) lineaCatalogo.textContent = texto;
    acciones.replaceChildren(...accionesCatalogo());
    const c = respaldo.catalogo;
    filasCatalogo.replaceChildren(...(c.tipo === 'pagina' ? c.filas.map(filaCatalogo) : []));
    if (foco && !foco.isConnected) {
      const igual = [...contenedor.querySelectorAll<HTMLElement>('button, a')].find((b) => huella(b) === buscada);
      // Un botón del lote que cambia (Respaldar → confirmar → Pausar → Continuar…): el foco pasa al primero nuevo.
      const delLote = foco.getAttributeNames().some((a) => a.startsWith('data-lote-'))
        ? botonesLote.querySelector<HTMLElement>('button, a') : null;
      (igual ?? delLote ?? contenedor.querySelector<HTMLElement>('h3'))?.focus();
    }
  }
  function descargarArchivo(fotoId: string) {
    const d = respaldo.descargarArchivo(fotoId);
    if (!d) return;
    const a = elemento('a');
    a.href = d.url;
    a.download = d.nombre.trim() || 'foto';
    a.hidden = true;
    document.body.append(a);
    a.click();
    a.remove();
    // Se libera después de que el navegador haya tomado la descarga.
    setTimeout(() => respaldo.soltarUrl(d.url), 60_000);
  }
  /** Misma operación siempre: reintentar nunca prepara una nueva y quita la pausa si la hay. */
  async function reintentarDesdeResumen(fotoId: string) {
    if (enAccion.has(fotoId)) return;
    enAccion.add(fotoId);
    resultados.delete(fotoId);
    pintar();
    const g = gen;
    const r = await respaldo.reintentar(fotoId);
    enAccion.delete(fotoId);
    if (g !== gen) return;
    resultados.set(fotoId, textoResultadoRespaldo(r));
    refrescarResumen();
  }

  /** Ocultar la app corta el lote y su consentimiento: volver no reanuda nada. */
  const alOcultar = () => { if (document.visibilityState === 'hidden') respaldo.abandonarLote(); };
  return {
    montar(c) {
      gen++;
      contenedor = c;
      resumen = null; resumenFallido = false;
      const titulo = elemento('h3', '', 'Fotos del viaje');
      titulo.tabIndex = -1;
      const lineaCatalogo = elemento('p', 'estado-catalogo');
      lineaCatalogo.setAttribute('role', 'status');
      // «Respaldar pendientes»: bajo el recuento de este móvil, con su propia línea de estado estable.
      const loteFotos = elemento('div', 'lote-fotos');
      const lineaLote = elemento('p', 'estado-lote');
      lineaLote.setAttribute('role', 'status');
      loteFotos.append(lineaLote, elemento('p', 'detalle-lote'), elemento('div', 'acciones-bloque acciones-lote'));
      document.addEventListener('visibilitychange', alOcultar);
      c.replaceChildren(titulo,
        elemento('h4', 'subs-titulo', 'En este móvil'), elemento('p', 'estado-fotos-viaje'), loteFotos,
        elemento('ul', 'filas-fotos-viaje filas-resumen'),
        elemento('h4', 'subs-titulo', 'En el servidor'), lineaCatalogo,
        elemento('div', 'acciones-bloque acciones-catalogo'), elemento('ul', 'filas-fotos-viaje filas-catalogo'),
        elemento('p', 'cifras', NOTA_VIAJE));
      pintar();
      refrescarResumen();
    },
    alCambiar(que) {
      if (!contenedor) return;
      if (que.tipo === 'catalogo' || que.tipo === 'lote') pintar();
      else if (que.tipo === 'resumen') refrescarResumen();
    },
    manejarClic(objetivo) {
      if (!contenedor || !contenedor.contains(objetivo)) return false;
      const b = objetivo.closest<HTMLElement>('button');
      if (!b || b.getAttribute('aria-disabled') === 'true') return true;
      if (b.hasAttribute('data-catalogo-ver')) { ultimoDesde = 'principio'; void respaldo.listar('principio'); }
      else if (b.hasAttribute('data-catalogo-siguientes')) { ultimoDesde = 'siguiente'; void respaldo.listar('siguiente'); }
      else if (b.hasAttribute('data-catalogo-principio')) { ultimoDesde = 'principio'; void respaldo.listar('principio'); }
      else if (b.hasAttribute('data-catalogo-reintentar')) void respaldo.listar(ultimoDesde);
      else if (b.hasAttribute('data-catalogo-cancelar')) respaldo.cancelarListado();
      else if (b.hasAttribute('data-catalogo-cancelar-guardado')) respaldo.cancelarGuardado();
      else if (b.dataset.catalogoGuardar) void respaldo.guardar(b.dataset.catalogoGuardar);
      else if (b.dataset.catalogoArchivo) descargarArchivo(b.dataset.catalogoArchivo);
      else if (b.dataset.viajeReintentar) void reintentarDesdeResumen(b.dataset.viajeReintentar);
      else if (b.hasAttribute('data-lote-contar')) void respaldo.contarLote();
      else if (b.hasAttribute('data-lote-confirmar')) void respaldo.confirmarLote();
      else if (b.hasAttribute('data-lote-pausar')) respaldo.pausarLote();
      else if (b.hasAttribute('data-lote-continuar')) void respaldo.continuarLote();
      else if (b.hasAttribute('data-lote-terminar')) respaldo.terminarLote();
      return true;
    },
    desmontar() {
      const g = ++gen;
      contenedor = null;
      document.removeEventListener('visibilitychange', alOcultar);
      // Salir de «Todo» termina la continuidad del lote: nada sigue ni se reanuda solo. Repintar «Todo» (desmontar y
      // montar en el MISMO turno, como al cargar el mapa) no es salir: si se volvió a montar, el lote sigue.
      queueMicrotask(() => { if (gen === g && !contenedor) respaldo.abandonarLote(); });
    },
  };
}
