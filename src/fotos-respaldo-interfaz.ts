import type { Itinerario } from './tipos';
import { esFotoBorrada, esIdFoto, tamanoBlob, type CapturaFoto, type DestinoFoto, type MetadatosFoto } from './fotos';
import type { FotosLocal } from './fotos-local';
import { abrirRespaldoFotosLocal, type RespaldoFotosLocal } from './fotos-respaldo-local';
import { crearTransporteFotos, ErrorTransporteFotos, type TransporteFotos } from './fotos-transporte';
import { crearClienteListadoFotos, type ListadoFotos, type PresupuestoListadoFotosCliente,
  type ResultadoListadoFotosCliente } from './fotos-listado';
import { crearDescargaFotos, type DescargaFotos, type ResultadoDescargaFotos } from './fotos-descarga';
import { copiarOriginalRespaldo, mismosOriginalesRespaldo, type EntradaRespaldo, type OriginalRespaldo,
  type ReferenciaRespaldo } from './fotos-respaldo';
import { deserializarSolicitudRespaldo } from './fotos-protocolo';

/**
 * Respaldo manual y catálogo de fotos privadas en la interfaz del viaje.
 *
 * Controlador sin DOM (pruebas en Node) que compone, sobre el MISMO PhotoDB del controlador de fotos, el ledger
 * local, el transporte, el listado y la descarga de las bibliotecas existentes. Solo acciones explícitas: una
 * acción es UN POST o UN GET; nada se envía, consulta, reintenta ni descarga al abrir el visor, «Todo» ni una
 * página. Listar, guardar o comprobar nunca son acuse (ACK), marca de envío (SENT) ni entradas del ledger.
 * La web publicada lo compone con null: ni red, ni ledger, ni texto nuevo (ver componerRespaldoFotos).
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
export type CambioRespaldo = { readonly tipo: 'foto'; readonly fotoId: string } | { readonly tipo: 'catalogo' }
  | { readonly tipo: 'resumen' };

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
  /** Segunda acción explícita sobre una fila de la página vigente: siempre un GET si se admite. */
  guardar(fotoId: string): Promise<void>;
  cancelarGuardado(): void;
  /** Bytes de una descarga fallida (solo esta sesión) como archivo octet-stream; nunca entran en PhotoDB ni en el ledger. */
  descargarArchivo(fotoId: string): { readonly url: string; readonly nombre: string } | null;
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

/** Gate de composición: con null no se construye nada (ni fábricas, ni ledger, ni red). */
export function componerRespaldoFotos(composicion: ComposicionRespaldoFotos | null,
  resto: Omit<DependenciasRespaldoFotos, 'composicion'>): RespaldoFotos | null {
  return composicion ? crearRespaldoFotos({ ...resto, composicion }) : null;
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
  /** Ocupado hasta que la biblioteca asienta su IO propio, no hasta un resultado cancelado. */
  let cargaEnCurso: Promise<ResultadoRespaldo> | null = null;
  let descargaEnCurso: Promise<unknown> | null = null;
  let catalogo: EstadoCatalogo = { tipo: 'reposo' };
  let genCatalogo = 0;
  let consultando = false;
  /** Continuación RAW de la última página: posición, no permiso; nunca se sigue sola. */
  let continuacion: string | null = null;
  /** Bytes de descargas fallidas, solo en memoria de esta sesión. */
  const capturas = new Map<string, CapturaFoto>();
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
    transporte ??= crearTransporteFotos({ plan, origen, fuente: p, ledger: l,
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
    if (cargaEnCurso) return Promise.resolve({ tipo: 'ocupada' });
    if (!enLinea()) return Promise.resolve({ tipo: 'sin-conexion' });
    const p = sincronizarPuerto();
    if (!p || !esIdFoto(fotoId)) return Promise.resolve({ tipo: 'no-disponible' });
    const operacion = cargar(fotoId, preparar, p, genPuerto);
    cargaEnCurso = operacion;
    const liberar = () => { if (cargaEnCurso === operacion) cargaEnCurso = null; };
    void operacion.then(liberar, liberar);
    return operacion;
  }

  async function clasificar(o: OriginalRespaldo, p: FotosLocal | null): Promise<LocalCatalogo> {
    if (!p) return 'ilegible';
    try {
      const m = await p.leerMetadatos(o.fotoId);
      if (m === null) return 'ausente';
      if (esFotoBorrada(m)) return 'borrada';
      return mismosOriginalesRespaldo(plan, copiarOriginalRespaldo(plan, m), o) ? 'registrada' : 'otra';
    } catch { return 'ilegible'; }
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

  function actualizarFila(gen: number, fotoId: string, cambios: Partial<Omit<FilaCatalogo, 'original'>>) {
    if (gen !== genCatalogo || catalogo.tipo !== 'pagina') return;
    const filas = catalogo.filas.map((f) => (f.original.fotoId === fotoId ? { ...f, ...cambios } : f));
    catalogo = { ...catalogo, filas };
    avisar({ tipo: 'catalogo' });
  }

  function descargaDe(p: FotosLocal): DescargaFotos {
    // La misma política de original que el transporte: 0 también vale (ningún original positivo se pide).
    descarga ??= crearDescargaFotos({ plan, origen, fotos: p, ...(d.fetch ? { fetch: d.fetch } : {}),
      ...(composicion.maxBytesOriginal !== undefined ? { maxBytesOriginal: composicion.maxBytesOriginal } : {}) });
    return descarga;
  }

  return {
    get fase() { return fase; },
    get catalogo() { return catalogo; },
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
            const local = await clasificar(original, p);
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
    },
    cancelarListado() { if (consultando) listado?.cancelar(); },
    async guardar(fotoId) {
      if (terminado || descargaEnCurso) return;
      // Si cambió PhotoDB, la página se descarta antes de buscar la fila.
      const p = sincronizarPuerto();
      if (!p || catalogo.tipo !== 'pagina') return;
      const fila = catalogo.filas.find((f) => f.original.fotoId === fotoId);
      if (!fila || !fila.accion) return;
      // Referencia, puerto y generaciones capturados ANTES del primer await.
      const gen = genPuerto;
      const genC = genCatalogo;
      const ref = fila.original;
      let instancia: DescargaFotos;
      try { instancia = descargaDe(p); }
      catch { actualizarFila(genC, fotoId, { estado: 'no-guardada', captura: undefined }); return; }
      capturas.delete(fotoId);
      actualizarFila(genC, fotoId, { estado: 'guardando', captura: undefined });
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
      if (terminado) return;
      if (r.tipo === 'guardada') {
        let misma = false;
        try {
          misma = gen === genPuerto && d.puerto() === p
            && mismosOriginalesRespaldo(plan, copiarOriginalRespaldo(plan, r.captura.metadatos), ref);
        } catch { misma = false; }
        if (misma) {
          // Única condición de incorporación: guardada, misma identidad pedida y mismo PhotoDB capturado.
          try { d.incorporar(r.captura.metadatos); } catch { /* la interfaz no altera lo durable */ }
          actualizarFila(genC, fotoId, { estado: antes === 'presente' ? 'comprobada' : 'guardada',
            local: 'registrada', accion: 'comprobar' });
        } else actualizarFila(genC, fotoId, { estado: 'detenida' });
      } else if (r.tipo === 'fallida') {
        const conCaptura = !!r.captura && gen === genPuerto;
        if (conCaptura && r.captura) capturas.set(fotoId, r.captura);
        actualizarFila(genC, fotoId, conCaptura ? { estado: 'no-guardada', captura: true } : { estado: 'no-guardada' });
      } else actualizarFila(genC, fotoId, { estado: 'detenida' });
    },
    cancelarGuardado() { descarga?.cancelar(); },
    descargarArchivo(fotoId) {
      const c = capturas.get(fotoId);
      if (!c || terminado) return null;
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
  'data-viaje-reintentar'];

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
    if (!lineaResumen || !filasResumen || !lineaCatalogo || !acciones || !filasCatalogo) return;
    const foco = document.activeElement instanceof HTMLElement && contenedor.contains(document.activeElement)
      ? document.activeElement : null;
    const buscada = foco ? huella(foco) : '';
    lineaResumen.textContent = textoResumen();
    const pendientes = (resumen ?? []).filter((r) => ['sin-confirmar', 'pausado', 'bloqueada', 'enviando'].includes(r.estado.tipo));
    filasResumen.replaceChildren(...pendientes.map(filaResumen));
    const texto = textoCatalogo(respaldo.catalogo, o.maxFilas);
    // Región viva estable: solo cambia su texto.
    if (lineaCatalogo.textContent !== texto) lineaCatalogo.textContent = texto;
    acciones.replaceChildren(...accionesCatalogo());
    const c = respaldo.catalogo;
    filasCatalogo.replaceChildren(...(c.tipo === 'pagina' ? c.filas.map(filaCatalogo) : []));
    if (foco && !foco.isConnected) {
      const igual = [...contenedor.querySelectorAll<HTMLElement>('button, a')].find((b) => huella(b) === buscada);
      (igual ?? contenedor.querySelector<HTMLElement>('h3'))?.focus();
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

  return {
    montar(c) {
      gen++;
      contenedor = c;
      resumen = null; resumenFallido = false;
      const titulo = elemento('h3', '', 'Fotos del viaje');
      titulo.tabIndex = -1;
      const lineaCatalogo = elemento('p', 'estado-catalogo');
      lineaCatalogo.setAttribute('role', 'status');
      c.replaceChildren(titulo,
        elemento('h4', 'subs-titulo', 'En este móvil'), elemento('p', 'estado-fotos-viaje'),
        elemento('ul', 'filas-fotos-viaje filas-resumen'),
        elemento('h4', 'subs-titulo', 'En el servidor'), lineaCatalogo,
        elemento('div', 'acciones-bloque acciones-catalogo'), elemento('ul', 'filas-fotos-viaje filas-catalogo'),
        elemento('p', 'cifras', NOTA_VIAJE));
      pintar();
      refrescarResumen();
    },
    alCambiar(que) {
      if (!contenedor) return;
      if (que.tipo === 'catalogo') pintar();
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
      return true;
    },
    desmontar() {
      gen++;
      contenedor = null;
    },
  };
}
