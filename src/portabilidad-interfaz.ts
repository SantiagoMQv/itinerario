import type { Itinerario } from './tipos';
import { esFotoBorrada, esIdFoto, esMetadatosFoto, tamanoBlob, type DestinoFoto, type MetadatosFoto } from './fotos';
import type { FotosLocal, ObservacionRestauracionFoto } from './fotos-local';
import { copiarLimitesPortables, type CampoLegadoPortable, type LimitesPortables, type ManifiestoPortable } from './portabilidad';
import { crearPortabilidadHistorica, type HistoriaArchivada, type LimitesHistoria, type ObservacionHistorica,
  type PortabilidadHistorica, type ResultadoImportacionHistorica } from './portabilidad-historico';
import { crearExportadorLocal, type ExportacionActual, type OpcionesPortabilidadLocal } from './portabilidad-local';

/**
 * «Copia de este móvil»: portabilidad local en la interfaz del viaje. Dos piezas:
 * 1. `crearPortabilidadInterfaz`: controlador sin DOM (pruebas en Node) sobre las bibliotecas existentes. Prepara la copia
 *    actual (sin la historia archivada), importa el archivo de otro móvil (primero lo archiva y después añade solo sus fotos
 *    que falten, con el restaurador aditivo) y consulta, reintenta o devuelve las copias importadas. Una acción a la vez.
 * 2. `componerPortabilidad`: la sección de «Todo», que solo existe con una composición EXPLÍCITA (la web publicada pasa
 *    null: ni sección, ni texto, ni base de historia). Preparar no es entregar: la descarga es otro toque y la app no puede
 *    comprobar que el archivo se haya guardado.
 * Cero red. Lo importado de progreso, registro de respaldos y legado es historia de solo consulta: nunca se aplica, encola,
 * envía ni cuenta como acuse. Nada se borra: ni la historia, ni el archivo de origen, ni fotos de este móvil.
 */

/** Composición del controlador. Los límites los fija quien compone, sin valores implícitos. */
export interface OpcionesPortabilidadInterfaz extends Pick<OpcionesPortabilidadLocal, 'plan' | 'limites' | 'fabrica' | 'leerLegado'> {
  /** Presupuesto de TODA la historia importada. Sin él no hay importación ni historia: nunca uno implícito. */
  readonly limitesHistoria?: LimitesHistoria;
  /** El MISMO FotosLocal vivo de la interfaz de fotos; null si no está abierto. Nunca se abre otro ni se cierra aquí. */
  readonly puerto?: () => FotosLocal | null;
  /** Única vía para indexar en la interfaz una foto restaurada (no escribe nada). */
  readonly incorporar?: (metadatos: MetadatosFoto) => void;
  /** Hay una acción del progreso compartido en curso: entonces no empieza ninguna de aquí. */
  readonly progresoOcupado?: () => boolean;
  /** Empezó o terminó una acción (0 IO). */
  readonly alCambiar?: () => void;
}

export type AccionPortable = 'preparar' | 'importar' | 'reintentar' | 'listar' | 'consultar' | 'original';
/** No empezó: nada se abrió, leyó ni escribió en esta acción. */
export interface NoIniciada {
  readonly tipo: 'no-iniciada';
  readonly motivo: 'ocupada' | 'progreso-ocupado' | 'sin-historia' | 'demasiado-grande';
}
/** «preparada» entrega la copia actual SIN la historia archivada. Preparar no es entregar:
 * la descarga y que el archivo llegue a guardarse son otro paso que la app no certifica.
 * Un fallo de la biblioteca se propaga como error, nunca como copia preparada. */
export type ResultadoPreparacionPortable =
  | { readonly tipo: 'no-preparada'; readonly motivo: 'ocupada' | 'progreso-ocupado' }
  | { readonly tipo: 'preparada'; readonly exportacion: ExportacionActual };
/** Importar o reintentar sus fotos. `nuevas`: fotos que el restaurador observó como añadidas; `indice`: si todas se
 * indexaron en la interfaz por el MISMO almacén capturado al empezar (si no, no se afirma que se vean). */
export type ResultadoFotosPortable = NoIniciada
  | { readonly tipo: 'hecha'; readonly resultado: ResultadoImportacionHistorica; readonly nuevas: number;
      readonly indice: 'al-dia' | 'sin-confirmar' };
export type ResultadoListaPortable = NoIniciada
  | { readonly tipo: 'lista'; readonly copias: readonly HistoriaArchivada[] } | { readonly tipo: 'fallo' };
export type ResultadoConsultaPortable = NoIniciada
  | { readonly tipo: 'consultada'; readonly copia: HistoriaArchivada } | { readonly tipo: 'ausente' | 'fallo' };
/** El archivo importado tal cual, como application/octet-stream (bytes sin cambios). */
export type ResultadoOriginalPortable = NoIniciada | { readonly tipo: 'preparado'; readonly archivo: Blob } | { readonly tipo: 'fallo' };

export interface PortabilidadInterfaz {
  /** Acción en curso (una a la vez para todas); null si ninguna. */
  readonly accion: AccionPortable | null;
  /** Hay presupuesto de historia: se puede importar y consultar. */
  readonly conHistoria: boolean;
  readonly maxBytesArchivo: number;
  /** Acción manual: fotos, progreso, registro de respaldos y legado de este móvil en un archivo; solo lee. */
  prepararActual(): Promise<ResultadoPreparacionPortable>;
  /** Archiva el archivo entero (validado con todos sus CRC) y después añade sus fotos que falten; nada se sobrescribe. */
  importar(archivo: Blob): Promise<ResultadoFotosPortable>;
  /** Vuelve a intentar añadir las fotos de una copia ya archivada; nunca archiva otra. */
  reintentar(trabajoId: string): Promise<ResultadoFotosPortable>;
  /** Lee y comprueba TODOS los archivos archivados (coste proporcional a sus bytes). */
  listar(): Promise<ResultadoListaPortable>;
  consultar(trabajoId: string): Promise<ResultadoConsultaPortable>;
  exportarOriginal(trabajoId: string): Promise<ResultadoOriginalPortable>;
}

function fotosNuevas(o: ObservacionHistorica | null): string[] {
  const fotos: readonly ObservacionRestauracionFoto[] = o?.fotos ?? [];
  return fotos.filter((f) => f.tipo === 'nueva' && esIdFoto(f.fotoId)).map((f) => f.fotoId);
}

/** Constructor sin IO: plan, límites, fábrica, puertos y funciones quedan fijados antes de cualquier await. */
export function crearPortabilidadInterfaz(opciones: OpcionesPortabilidadInterfaz): PortabilidadInterfaz {
  const exportador = crearExportadorLocal({ plan: opciones.plan, limites: opciones.limites,
    fabrica: opciones.fabrica, leerLegado: opciones.leerLegado });
  const limites = copiarLimitesPortables(opciones.limites);
  const historia: PortabilidadHistorica | null = opciones.limitesHistoria
    ? crearPortabilidadHistorica({ plan: opciones.plan, limites: opciones.limites,
      limitesHistoria: opciones.limitesHistoria, fabrica: opciones.fabrica })
    : null;
  const puerto = opciones.puerto ?? (() => null);
  const incorporar = opciones.incorporar ?? (() => {});
  const progresoOcupado = opciones.progresoOcupado ?? (() => false);
  const alCambiar = opciones.alCambiar ?? (() => {});
  let accion: AccionPortable | null = null;

  function avisar() {
    try { alCambiar(); } catch { /* La interfaz no altera lo guardado. */ }
  }
  function bloqueo(): 'ocupada' | 'progreso-ocupado' | null {
    if (accion) return 'ocupada';
    let ocupado = true;
    try { ocupado = progresoOcupado(); } catch { /* Ante la duda, no empieza. */ }
    return ocupado ? 'progreso-ocupado' : null;
  }
  function conHistoria(): { readonly h: PortabilidadHistorica } | NoIniciada {
    if (!historia) return { tipo: 'no-iniciada', motivo: 'sin-historia' };
    const motivo = bloqueo();
    return motivo ? { tipo: 'no-iniciada', motivo } : { h: historia };
  }
  /** La acción queda marcada de forma síncrona: un segundo toque antes del primer await ya la encuentra. */
  async function con<T>(a: AccionPortable, trabajo: () => Promise<T>): Promise<T> {
    accion = a; avisar();
    try { return await trabajo(); } finally { accion = null; avisar(); }
  }
  function puertoActual(): FotosLocal | null {
    try { return puerto(); } catch { return null; }
  }
  /** Solo el almacén capturado ANTES del primer await indexa lo restaurado, y solo si sigue siendo el de la interfaz
   * tras cada await. Cada foto «nueva» se relee de PhotoDB: nunca se indexa metadata del archivo sin comprobarla. */
  async function conFotos(trabajo: () => Promise<ResultadoImportacionHistorica>): Promise<ResultadoFotosPortable> {
    const almacen = puertoActual();
    const resultado = await trabajo();
    const nuevas = fotosNuevas(resultado.fotos);
    let incorporadas = 0;
    for (const id of nuevas) {
      if (!almacen || puertoActual() !== almacen) break;
      let m: Awaited<ReturnType<FotosLocal['leerMetadatos']>>;
      try { m = await almacen.leerMetadatos(id); } catch { break; }
      if (puertoActual() !== almacen || !m || esFotoBorrada(m)) break;
      try { incorporar(m); } catch { break; }
      incorporadas++;
    }
    return { tipo: 'hecha', resultado, nuevas: nuevas.length, indice: incorporadas === nuevas.length ? 'al-dia' : 'sin-confirmar' };
  }

  return {
    get accion() { return accion; },
    conHistoria: historia !== null,
    maxBytesArchivo: limites.maxBytesArchivo,
    // exportarActual, no exportar: este no admite historia archivada presente. Solo lee; cada toque es una copia
    // nueva, un solape se rechaza y cualquier error de la biblioteca se propaga sin reintentos.
    prepararActual: async () => {
      const motivo = bloqueo();
      if (motivo) return { tipo: 'no-preparada', motivo };
      return con('preparar', async (): Promise<ResultadoPreparacionPortable> =>
        ({ tipo: 'preparada', exportacion: await exportador.exportarActual() }));
    },
    importar: async (archivo) => {
      const g = conHistoria();
      if (!('h' in g)) return g;
      const { h } = g;
      // Presupuesto antes de leer un solo byte: un archivo mayor que el de la composición no se abre.
      if (tamanoBlob(archivo) > limites.maxBytesArchivo) return { tipo: 'no-iniciada', motivo: 'demasiado-grande' };
      return con('importar', () => conFotos(() => h.importar(archivo)));
    },
    reintentar: async (trabajoId) => {
      const g = conHistoria();
      if (!('h' in g)) return g;
      const { h } = g;
      return con('reintentar', () => conFotos(() => h.reintentar(trabajoId)));
    },
    listar: async () => {
      const g = conHistoria();
      if (!('h' in g)) return g;
      const { h } = g;
      return con('listar', async (): Promise<ResultadoListaPortable> => {
        try { return { tipo: 'lista', copias: await h.listar() }; } catch { return { tipo: 'fallo' }; }
      });
    },
    consultar: async (trabajoId) => {
      const g = conHistoria();
      if (!('h' in g)) return g;
      const { h } = g;
      return con('consultar', async (): Promise<ResultadoConsultaPortable> => {
        try {
          const copia = await h.consultar(trabajoId);
          return copia ? { tipo: 'consultada', copia } : { tipo: 'ausente' };
        } catch { return { tipo: 'fallo' }; }
      });
    },
    exportarOriginal: async (trabajoId) => {
      const g = conHistoria();
      if (!('h' in g)) return g;
      const { h } = g;
      return con('original', async (): Promise<ResultadoOriginalPortable> => {
        try {
          const b = await h.exportarOriginal(trabajoId);
          return { tipo: 'preparado', archivo: Blob.prototype.slice.call(b, 0, tamanoBlob(b), 'application/octet-stream') as Blob };
        } catch { return { tipo: 'fallo' }; }
      });
    },
  };
}

// ---------- Recuentos y textos (sin DOM) ----------

/** Recuentos de una captura ya inspeccionada (las tablas tipadas del manifiesto, nunca los bytes de las fotos). */
export interface ResumenCopia {
  readonly fotos: number;
  readonly borradas: number;
  /** Paradas con marca y casillas hechas en lo que mostraba ese móvil. */
  readonly marcas: number;
  readonly casillas: number;
  /** Cambios en su cola: enviados (sin acuse) y rechazados son historia, no autoridad. */
  readonly cambios: number;
  readonly enviados: number;
  readonly rechazados: number;
  readonly respaldos: number;
  readonly conRecibo: number;
  /** Claves de la versión anterior presentes (texto, aunque esté vacío). */
  readonly legado: number;
}
export function resumenCopia(m: ManifiestoPortable): ResumenCopia {
  const c = m.captura;
  const metadatos = c.fotos.tablas.metadatos ?? [];
  const borradas = metadatos.filter((r) => esFotoBorrada(r.valor)).length;
  const raiz = (c.progreso.tablas.viajes ?? [])[0]?.valor;
  const cola = raiz?.cola ?? [];
  const respaldos = c.respaldos.tablas.respaldos ?? [];
  return {
    fotos: metadatos.length - borradas,
    borradas,
    marcas: raiz ? Object.values(raiz.estado.paradas).filter((p) => p.marca !== null).length : 0,
    casillas: raiz ? Object.values(raiz.estado.pendientes).filter((p) => p.hecho).length : 0,
    cambios: cola.length,
    enviados: cola.filter((e) => e.enviada).length,
    rechazados: cola.filter((e) => e.rechazo !== undefined).length,
    respaldos: respaldos.length,
    conRecibo: respaldos.filter((r) => r.valor.recibo !== null).length,
    legado: Object.values(c.legado).filter((v) => v !== null).length,
  };
}
const cuenta = (n: number, uno: string, varios: string) => (n ? `${n} ${n === 1 ? uno : varios}` : '');
export function textoResumenCopia(r: ResumenCopia): string {
  const partes = [
    cuenta(r.fotos, 'foto', 'fotos'), cuenta(r.borradas, 'borrada', 'borradas'),
    cuenta(r.marcas, 'marca', 'marcas'), cuenta(r.casillas, 'casilla', 'casillas'),
    r.cambios ? `${cuenta(r.cambios, 'cambio en cola', 'cambios en cola')}${r.enviados ? ` (${cuenta(r.enviados, 'enviado', 'enviados')})` : ''}` : '',
    cuenta(r.rechazados, 'rechazado', 'rechazados'),
    r.respaldos ? `${cuenta(r.respaldos, 'registro de respaldo', 'registros de respaldo')}${r.conRecibo ? ` (${r.conRecibo} con recibo)` : ''}` : '',
    r.legado ? 'marcas de la versión anterior' : '',
  ].filter(Boolean);
  return partes.length ? partes.join(' · ') : 'sin fotos ni marcas';
}
export function pesoLegible(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return `${(bytes / (1024 * 1024)).toLocaleString('es-ES', { maximumFractionDigits: 1 })} MB`;
}
export function textoNoIniciada(motivo: NoIniciada['motivo'], maxBytesArchivo: number): string {
  switch (motivo) {
    case 'ocupada': return 'Ya hay otra acción de la copia en curso; espera a que termine.';
    case 'progreso-ocupado': return 'Se está guardando una marca en este móvil; prueba en un momento.';
    case 'sin-historia': return 'Importar no está disponible aquí.';
    case 'demasiado-grande': return `Ese archivo pasa del límite de ${pesoLegible(maxBytesArchivo)} de esta copia; no se ha leído ni guardado nada.`;
  }
}
/** Fallos de fotos con los que «Reintentar las fotos» tiene sentido (aditivo: nunca sobrescribe ni archiva otra copia). */
const REINTENTABLES: readonly string[] = ['conflicto-fresco', 'tx-abortada', 'tx-incierta', 'lectura-posterior-fallida', 'puerto-incierto'];
export function pideReintento(o: ObservacionHistorica | null): boolean {
  return !o || REINTENTABLES.includes(o.tipo);
}
/** Lo que pasó con las fotos de una copia archivada, según la observación durable del restaurador. */
export function textoFotos(o: ObservacionHistorica | null): string {
  if (!o) return 'Sus fotos aún no se han añadido.';
  switch (o.tipo) {
    case 'sin-fotos': return 'No traía fotos.';
    case 'observadas': {
      const fotos: readonly ObservacionRestauracionFoto[] = o.fotos;
      const n = (tipo: ObservacionRestauracionFoto['tipo']) => fotos.filter((f) => f.tipo === tipo).length;
      const partes = [cuenta(n('nueva'), 'añadida', 'añadidas'), cuenta(n('existente'), 'ya estaba', 'ya estaban'),
        cuenta(n('tombstone'), 'borrada, no se recupera', 'borradas, no se recuperan')].filter(Boolean);
      return partes.length ? `Fotos: ${partes.join(' · ')}.` : 'No traía fotos.';
    }
    case 'cambiadas': return 'Sus fotos se escribieron, pero al comprobarlas algo había cambiado: revisa las fotos de este móvil.';
    case 'conflicto-preflight': return 'No se añadió ninguna foto: alguna ya está en este móvil con otro contenido o se borró aquí. No se ha sobrescrito nada.';
    case 'conflicto-fresco': return 'No se añadió ninguna foto: algo cambió en las fotos de este móvil mientras tanto. No se ha sobrescrito nada.';
    case 'tx-abortada': return 'Sus fotos no se añadieron (puede faltar espacio en este móvil). Puedes reintentarlo.';
    default: return 'No se sabe si se añadieron sus fotos. Mira las copias importadas antes de repetir.';
  }
}
/** Resultado de importar (o de reintentar las fotos): dice qué consta archivado y qué pasó con las fotos, sin más. */
export function textoResultadoFotos(r: ResultadoFotosPortable, reintento: boolean, maxBytesArchivo: number): string {
  if (r.tipo === 'no-iniciada') return textoNoIniciada(r.motivo, maxBytesArchivo);
  const x = r.resultado;
  if (x.tipo === 'rechazado-antes-escribir') {
    return reintento ? 'No se reintentó: esa copia ya no se puede leer o no cabe en los límites de esta copia.'
      : 'No se ha guardado nada: el archivo no es una copia válida de este viaje o no cabe en los límites de esta copia.';
  }
  if (x.tipo === 'historia-no-confirmada') {
    return 'No consta que la copia quedara archivada en este móvil y no se añadió ninguna foto. Antes de repetir, mira las copias importadas.';
  }
  const partes = [reintento ? '' : 'Copia archivada en este móvil.', textoFotos(x.fotos)];
  if (x.tipo === 'resultado-durable-incierto') partes.push('No consta anotado este resultado en la copia archivada.');
  if (r.indice === 'sin-confirmar') partes.push('Puede que las fotos añadidas no se vean en sus fichas hasta volver a abrir la app.');
  return partes.filter(Boolean).join(' ');
}
/** Nombre de descarga de una foto: el del archivo original sin controles ni separadores de ruta. Los bytes no cambian. */
export function nombreDescarga(nombre: string): string {
  const limpio = nombre.replace(/[\u0000-\u001f\u007f/\\:*?"<>|]+/g, '_').trim().slice(0, 120);
  return /[^_.\s]/.test(limpio) ? limpio : 'foto-original';
}

// ---------- «Copia de este móvil» en «Todo» (DOM; solo con la composición explícita) ----------

/** Activación EXPLÍCITA. Publicado (Pages): null → 0 IO, 0 base de historia, 0 texto nuevo. No hay flag, entorno ni URL. */
export interface ComposicionPortabilidad {
  /** Presupuestos finitos de quien compone. No son la capacidad del móvil ni la garantizan. */
  readonly limites: LimitesPortables;
  readonly limitesHistoria: LimitesHistoria;
}
export interface DependenciasPortabilidadUi {
  readonly plan: Itinerario;
  /** Solo marcas, marcas-hora y pendientes-hechos. Una lectura imposible debe fallar, no devolver null. */
  readonly leerLegado: (campo: CampoLegadoPortable) => string | null;
  readonly puerto: () => FotosLocal | null;
  readonly incorporar: (metadatos: MetadatosFoto) => void;
  readonly progresoOcupado: () => boolean;
  readonly nombreDe: (destino: DestinoFoto) => string;
  /** Aviso general para un resultado cuya sección ya no está a la vista (sin nombres de archivo). */
  readonly anunciar: (texto: string) => void;
  /** Omitida: la del navegador. */
  readonly fabrica?: IDBFactory | null;
  readonly crearUrl?: (blob: Blob) => string;
  readonly revocarUrl?: (url: string) => void;
  /** Fecha del nombre del archivo descargado (no se guarda en ninguna parte). */
  readonly ahora?: () => Date;
}
export interface PortabilidadUi {
  /** Pinta la sección (0 IO: nada se lee, abre ni consulta al pintar). */
  montar(contenedor: HTMLElement): void;
  /** Delegación de clics: devuelve true si el clic era de la sección. */
  manejarClic(objetivo: Element): boolean;
  /** Solo la vista: una acción en curso no se corta; su resultado va al aviso general. */
  desmontar(): void;
  /** Libera las URLs de descarga y el selector de archivo; no cierra bases (las bibliotecas cierran las suyas). */
  cerrar(): void;
}

const INTRO = 'Guarda en un archivo las fotos, las marcas y el registro de respaldos de este móvil, o importa el archivo de otro móvil.';
const DESCARGA_PEDIDA = 'Descarga pedida al navegador. La app no puede comprobar que el archivo se haya guardado.';
const SOLO_CONSULTA = 'Solo consulta: sus marcas, sus cambios enviados o rechazados y sus recibos de respaldo no se aplican a este '
  + 'móvil ni se envían, y no son un respaldo remoto ni un acuse.';
const HISTORIA_REPOSO = 'Las copias importadas se guardan aparte en este móvil y solo se consultan. Verlas comprueba todos sus archivos.';

function elemento<K extends keyof HTMLElementTagNameMap>(tag: K, clase?: string, texto?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (clase) e.className = clase;
  if (texto !== undefined) e.textContent = texto;
  return e;
}
/** `hueco`: el sitio del botón; si se sustituye por otro (Preparar → Descargar), el foco lo sigue. */
function boton(texto: string, clase: string, accion: string, hueco: string, datos: Record<string, string> = {},
  apagado = false): HTMLButtonElement {
  const b = elemento('button', clase, texto);
  b.type = 'button';
  b.dataset.copia = accion;
  b.dataset.hueco = hueco;
  for (const [k, v] of Object.entries(datos)) b.dataset[k] = v;
  if (apagado) b.setAttribute('aria-disabled', 'true');
  return b;
}
/** Hueco al que va el foco si el suyo desaparece. */
function sustituto(hueco: string | null): string | null {
  if (!hueco) return null;
  if (hueco === 'confirmar' || hueco === 'cancelar') return 'importar';
  if (hueco === 'ocultar' || /^(ver|reintentar|archivo|original):/.test(hueco)) return 'historia';
  return null;
}

/** Gate de composición: con null no se construye nada. Sin IO al crearse (ni con la composición explícita). */
export function componerPortabilidad(composicion: ComposicionPortabilidad | null, d: DependenciasPortabilidadUi): PortabilidadUi | null {
  if (composicion === null) return null;
  const { plan, anunciar, nombreDe } = d;
  const crearUrl = d.crearUrl ?? ((b: Blob) => URL.createObjectURL(b));
  const revocarUrl = d.revocarUrl ?? ((u: string) => URL.revokeObjectURL(u));
  const ahora = d.ahora ?? (() => new Date());
  let controlador: PortabilidadInterfaz | null;
  try {
    controlador = crearPortabilidadInterfaz({ plan, limites: composicion.limites, limitesHistoria: composicion.limitesHistoria,
      fabrica: d.fabrica, leerLegado: d.leerLegado, puerto: d.puerto, incorporar: d.incorporar,
      progresoOcupado: d.progresoOcupado, alCambiar: () => pintar() });
  } catch {
    // Presupuesto o catálogo inválidos: la sección lo dice y no ofrece nada.
    controlador = null;
  }
  const maxArchivo = controlador?.maxBytesArchivo ?? 0;
  const maxHistoria = controlador ? composicion.limitesHistoria.maxBytesHistoria : 0;
  const NOTA = `El archivo lleva tus fotos originales y tus marcas: trátalo como privado. Nada se prepara, descarga ni importa solo: `
    + `cada paso empieza con un toque. Límites de esta copia: ${pesoLegible(maxArchivo)} por archivo y ${pesoLegible(maxHistoria)} `
    + 'para todas las importadas; no garantizan que quepan en el espacio del móvil.';

  let contenedor: HTMLElement | null = null;
  let mensaje = INTRO;
  let preparada: { readonly exportacion: ExportacionActual; readonly peso: string; readonly nombre: string } | null = null;
  let elegido: File | null = null;
  let reintento: string | null = null;
  let historia: { readonly tipo: 'reposo' | 'listando' | 'fallo' } | { readonly tipo: 'lista'; readonly copias: readonly HistoriaArchivada[] }
    = { tipo: 'reposo' };
  let notaHistoria = '';
  let abierta: HistoriaArchivada | null = null;
  let consultando: string | null = null;
  /** Archivos completos de copias importadas ya preparados (por trabajo). */
  const archivos = new Map<string, Blob>();
  /** Una URL por hueco de descarga, propiedad de la sección: se reutiliza para la misma fuente y se revoca al cambiarla. */
  const urls = new Map<string, { readonly fuente: Blob; readonly url: string }>();
  let entrada: HTMLInputElement | null = null;

  const vigente = () => contenedor !== null && contenedor.isConnected;
  const ocupada = () => controlador !== null && controlador.accion !== null;
  /** Con la sección a la vista lo dice su línea de estado (región viva); si no, el aviso general, sin nombres de archivo. */
  function decir(texto: string, enfocar?: string, fuera = texto) {
    mensaje = texto;
    if (vigente()) pintar(enfocar);
    else anunciar(fuera);
  }
  function soltar(prefijo: string) {
    for (const [k, u] of urls) {
      if (k === prefijo || k.startsWith(`${prefijo}:`)) { revocarUrl(u.url); urls.delete(k); }
    }
  }
  /** Descarga SÍNCRONA dentro del toque del usuario: un enlace con download, bytes exactos como octet-stream. */
  function descargar(hueco: string, blob: Blob, nombre: string) {
    let u = urls.get(hueco);
    if (!u || u.fuente !== blob) {
      if (u) revocarUrl(u.url);
      u = { fuente: blob, url: crearUrl(Blob.prototype.slice.call(blob, 0, tamanoBlob(blob), 'application/octet-stream') as Blob) };
      urls.set(hueco, u);
    }
    const a = elemento('a');
    a.href = u.url;
    a.download = nombre;
    a.hidden = true;
    document.body.append(a);
    a.click();
    a.remove();
  }
  function nombreCopia(): string {
    const f = ahora();
    const dos = (n: number) => String(n).padStart(2, '0');
    return `copia-itinerario-${f.getFullYear()}-${dos(f.getMonth() + 1)}-${dos(f.getDate())}.itinport`;
  }

  // ----- Copia de este móvil -----
  async function preparar() {
    if (!controlador) return;
    let r: ResultadoPreparacionPortable;
    try { r = await controlador.prepararActual(); }
    catch (e) {
      const limites = e instanceof Error && /max[A-Z]/.test(e.message);
      return decir(limites ? 'No se pudo preparar la copia: pasa de los límites de esta composición. No se ha cambiado nada en este móvil.'
        : 'No se pudo preparar la copia. No se ha cambiado nada en este móvil.');
    }
    if (r.tipo === 'no-preparada') return decir(textoNoIniciada(r.motivo, maxArchivo));
    soltar('actual');
    const archivo = r.exportacion.archivo;
    preparada = { exportacion: r.exportacion, peso: pesoLegible(tamanoBlob(archivo.archivo)), nombre: nombreCopia() };
    decir(`Copia preparada: ${preparada.peso} · ${textoResumenCopia(resumenCopia(archivo.manifiesto))}. No incluye las copias importadas.`,
      'actual', 'Copia preparada. Para descargarla, vuelve a «Copia de este móvil» en «Todo».');
  }
  function descargarActual() {
    if (!preparada) return;
    descargar('actual', preparada.exportacion.archivo.archivo, preparada.nombre);
    decir(DESCARGA_PEDIDA);
  }

  // ----- Importar: elegir (sin IO) → confirmar → archivar y añadir fotos -----
  function selector(): HTMLInputElement {
    if (entrada) return entrada;
    const input = elemento('input');
    input.type = 'file';
    // Sin «accept»: el tipo que declare el móvil no prueba nada; la biblioteca valida el contenido entero.
    input.hidden = true;
    input.tabIndex = -1;
    input.setAttribute('aria-hidden', 'true');
    input.addEventListener('change', () => {
      const archivo = input.files?.[0] ?? null;
      input.value = ''; // Permite elegir el mismo archivo otra vez.
      if (!archivo) return;
      if (tamanoBlob(archivo) > maxArchivo) { elegido = null; return decir(textoNoIniciada('demasiado-grande', maxArchivo)); }
      // Elegir no lee ni guarda nada: primero la pregunta.
      elegido = archivo;
      if (vigente()) pintar('cancelar');
    });
    document.body.append(input);
    entrada = input;
    return input;
  }
  function elegir() {
    if (!controlador?.conHistoria) return decir(textoNoIniciada('sin-historia', maxArchivo));
    const input = selector();
    input.value = '';
    input.click();
  }
  function trabajoParaReintentar(r: ResultadoFotosPortable): string | null {
    if (r.tipo !== 'hecha' || r.resultado.historia !== 'confirmada') return null;
    return pideReintento(r.resultado.fotos) ? r.resultado.trabajoId : null;
  }
  /** Tras escribir en la historia, la lista que se veía ya no vale: se cierra y se vuelve a leer a un toque. */
  function historiaCambio(r: ResultadoFotosPortable) {
    if (r.tipo !== 'hecha' || r.resultado.historia === 'no-intentada') return;
    historia = { tipo: 'reposo' }; abierta = null; notaHistoria = '';
    soltar('foto'); soltar('archivo'); archivos.clear();
  }
  async function importar() {
    const archivo = elegido;
    if (!controlador || !archivo) return;
    elegido = null;
    let r: ResultadoFotosPortable | null = null;
    let texto: string;
    try { r = await controlador.importar(archivo); texto = textoResultadoFotos(r, false, maxArchivo); }
    catch { texto = 'No se sabe si la copia se importó. Mira las copias importadas antes de repetir.'; }
    if (r) { reintento = trabajoParaReintentar(r); historiaCambio(r); }
    decir(texto);
  }
  function cancelar() {
    elegido = null;
    pintar('importar');
  }
  async function reintentar(id: string) {
    if (!controlador) return;
    let r: ResultadoFotosPortable | null = null;
    let texto: string;
    try { r = await controlador.reintentar(id); texto = textoResultadoFotos(r, true, maxArchivo); }
    catch { texto = 'No se sabe si se añadieron sus fotos. Mira las copias importadas antes de repetir.'; }
    if (r && r.tipo !== 'no-iniciada') { reintento = trabajoParaReintentar(r); historiaCambio(r); }
    decir(texto);
  }

  // ----- Copias importadas (solo consulta) -----
  async function listar() {
    if (!controlador) return;
    const antes = historia;
    historia = { tipo: 'listando' }; abierta = null; notaHistoria = '';
    soltar('foto'); soltar('archivo'); archivos.clear();
    pintar();
    let r: ResultadoListaPortable;
    try { r = await controlador.listar(); } catch { r = { tipo: 'fallo' }; }
    if (r.tipo === 'no-iniciada') {
      historia = antes.tipo === 'listando' ? { tipo: 'reposo' } : antes;
      notaHistoria = textoNoIniciada(r.motivo, maxArchivo);
    } else historia = r.tipo === 'lista' ? { tipo: 'lista', copias: r.copias } : { tipo: 'fallo' };
    if (vigente()) pintar();
    else if (historia.tipo === 'fallo') anunciar('No se pudieron leer las copias importadas. No se ha cambiado nada en este móvil.');
  }
  function ocultar() {
    historia = { tipo: 'reposo' }; abierta = null; notaHistoria = '';
    soltar('foto'); soltar('archivo'); archivos.clear();
    pintar();
  }
  async function alternarContenido(id: string) {
    if (!controlador) return;
    if (abierta?.trabajoId === id) { abierta = null; soltar('foto'); return pintar(); }
    consultando = id; notaHistoria = '';
    pintar();
    let r: ResultadoConsultaPortable;
    try { r = await controlador.consultar(id); } catch { r = { tipo: 'fallo' }; }
    consultando = null;
    if (r.tipo === 'consultada') { soltar('foto'); abierta = r.copia; }
    else notaHistoria = r.tipo === 'no-iniciada' ? textoNoIniciada(r.motivo, maxArchivo)
      : r.tipo === 'ausente' ? 'Esa copia ya no está en este móvil.' : 'No se pudo leer esa copia. No se ha cambiado nada en este móvil.';
    if (vigente()) pintar();
  }
  async function prepararArchivo(id: string) {
    if (!controlador) return;
    notaHistoria = '';
    let r: ResultadoOriginalPortable;
    try { r = await controlador.exportarOriginal(id); } catch { r = { tipo: 'fallo' }; }
    if (r.tipo === 'preparado') archivos.set(id, r.archivo);
    else notaHistoria = r.tipo === 'no-iniciada' ? textoNoIniciada(r.motivo, maxArchivo)
      : 'No se pudo preparar el archivo de esa copia. No se ha cambiado nada en este móvil.';
    if (vigente()) pintar();
    else if (r.tipo === 'preparado') anunciar('Archivo de la copia importada preparado. Para descargarlo, vuelve a «Copias importadas».');
  }
  function ordinal(id: string): number {
    return historia.tipo === 'lista' ? historia.copias.findIndex((c) => c.trabajoId === id) + 1 : 0;
  }
  function descargarArchivo(id: string) {
    const blob = archivos.get(id);
    if (!blob) return;
    descargar(`archivo:${id}`, blob, `copia-importada-${ordinal(id) || 'sin-numero'}.itinport`);
    notaHistoria = DESCARGA_PEDIDA;
    pintar();
  }
  /** Solo originales cuyo segmento coincide con su metadata RAW (nunca una miniatura); nada se muestra ni se ejecuta. */
  function fotosDe(copia: HistoriaArchivada): { vivas: { readonly m: MetadatosFoto; readonly segmento: number }[]; borradas: number } {
    const vivas: { readonly m: MetadatosFoto; readonly segmento: number }[] = [];
    let borradas = 0;
    for (const r of copia.contenido.captura.fotos.tablas.metadatos ?? []) {
      const v: unknown = r.valor;
      if (esFotoBorrada(v)) { borradas++; continue; }
      if (!esMetadatosFoto(plan, v)) continue;
      const segmento = copia.contenido.segmentos.findIndex((s) => s.tabla === 'originales' && s.clave === r.clave
        && s.bytes === v.bytesOriginal);
      vivas.push({ m: v, segmento });
    }
    return { vivas, borradas };
  }
  function descargarOriginal(id: string, fotoId: string) {
    const copia = abierta;
    if (!copia || copia.trabajoId !== id) return;
    const foto = fotosDe(copia).vivas.find((f) => f.m.fotoId === fotoId);
    if (!foto || foto.segmento < 0) return;
    let blob: Blob;
    try {
      blob = copia.leerSegmento(foto.segmento);
      if (tamanoBlob(blob) !== foto.m.bytesOriginal) throw new Error('Tamaño distinto');
    } catch {
      notaHistoria = 'No se pudo leer el original de esa foto en la copia. No se ha cambiado nada.';
      return pintar();
    }
    descargar(`foto:${id}:${fotoId}`, blob, nombreDescarga(foto.m.nombre));
    notaHistoria = DESCARGA_PEDIDA;
    pintar();
  }

  // ----- Pintar (esqueleto estable; las regiones vivas solo cambian su texto) -----
  function textoEstado(): string {
    const a = controlador?.accion;
    if (a === 'preparar') return 'Preparando la copia…';
    if (a === 'importar') return 'Importando: primero se archiva la copia y después se añaden sus fotos…';
    if (a === 'reintentar') return 'Añadiendo las fotos de la copia…';
    return mensaje;
  }
  function textoHistoria(): string {
    let base: string;
    if (historia.tipo === 'lista') {
      const n = historia.copias.length;
      base = n === 0 ? 'No hay copias importadas en este móvil.'
        : `${n === 1 ? 'Una copia importada' : `${n} copias importadas`}. No tienen fecha: el orden no es el de importación.`;
    } else if (historia.tipo === 'listando') base = 'Leyendo y comprobando las copias importadas…';
    else if (historia.tipo === 'fallo') base = 'No se pudieron leer las copias importadas. No se ha cambiado nada en este móvil.';
    else base = HISTORIA_REPOSO;
    return notaHistoria ? `${base} ${notaHistoria}` : base;
  }
  function accionesCopia(): HTMLElement[] {
    const apagado = ocupada();
    const lista: HTMLElement[] = [];
    if (preparada) lista.push(boton(`Descargar copia (${preparada.peso})`, 'boton tinta', 'descargar', 'actual'));
    lista.push(boton(controlador?.accion === 'preparar' ? 'Preparando…' : preparada ? 'Preparar otra' : 'Preparar copia',
      preparada ? 'mini suave' : 'boton', 'preparar', preparada ? 'preparar' : 'actual', {}, apagado));
    lista.push(boton('Importar una copia', 'boton', 'importar', 'importar', {}, apagado));
    if (reintento) lista.push(boton('Reintentar las fotos', 'boton', 'reintentar', 'reintentar', { id: reintento }, apagado));
    return lista;
  }
  function confirmacion(archivo: File): HTMLElement[] {
    const peso = pesoLegible(tamanoBlob(archivo));
    return [
      elemento('p', 'confirmar-copia-texto', `¿Importar «${archivo.name}» (${peso})? Se guarda en este móvil como copia importada, `
        + `aunque ya la hubieras importado antes (ocupa otros ${peso}), y se añaden sus fotos que falten aquí; nada de este móvil `
        + 'se sobrescribe. Sus marcas y sus respaldos solo se podrán consultar: no se aplican ni se envían.'),
      boton(`Importar (${peso})`, 'boton tinta', 'confirmar', 'confirmar', {}, ocupada()),
      boton('Cancelar', 'mini suave', 'cancelar', 'cancelar'),
    ];
  }
  function accionesHistoria(): HTMLElement[] {
    if (!controlador?.conHistoria) return [];
    const apagado = ocupada();
    if (historia.tipo === 'listando') return [boton('Leyendo…', 'boton', 'historia', 'historia', {}, true)];
    if (historia.tipo === 'lista') {
      return [boton('Volver a leer', 'mini suave', 'historia', 'historia', {}, apagado), boton('Ocultar', 'mini suave', 'ocultar', 'ocultar')];
    }
    return [boton('Ver copias importadas', 'boton', 'historia', 'historia', {}, apagado)];
  }
  function detalle(copia: HistoriaArchivada): HTMLElement {
    const id = copia.trabajoId;
    const div = elemento('div', 'copia-detalle');
    div.append(elemento('p', 'fila-estado', SOLO_CONSULTA));
    const { vivas, borradas } = fotosDe(copia);
    if (vivas.length) {
      const ul = elemento('ul', 'copia-fotos');
      for (const f of vivas) {
        const li = elemento('li');
        const texto = elemento('span', 'fila-texto', `«${f.m.nombre}»`);
        texto.append(elemento('small', 'fila-estado', `${nombreDe(f.m.destino)} · ${pesoLegible(f.m.bytesOriginal)}`));
        li.append(texto);
        if (f.segmento >= 0) {
          const b = boton(`Descargar original (${pesoLegible(f.m.bytesOriginal)})`, 'boton', 'original', `original:${id}:${f.m.fotoId}`,
            { id, foto: f.m.fotoId });
          b.setAttribute('aria-label', `Descargar el original de «${f.m.nombre}» (${pesoLegible(f.m.bytesOriginal)})`);
          li.append(b);
        } else texto.append(elemento('small', 'fila-estado', 'Su original no está en el archivo.'));
        ul.append(li);
      }
      div.append(ul);
    } else div.append(elemento('p', 'fila-estado', 'Esa copia no trae fotos.'));
    if (borradas) {
      div.append(elemento('p', 'fila-estado', `${borradas === 1 ? 'Una foto borrada' : `${borradas} fotos borradas`} en esa copia: no se pueden recuperar.`));
    }
    const acciones = elemento('div', 'acciones-bloque');
    const archivo = archivos.get(id);
    acciones.append(archivo
      ? boton(`Descargar el archivo completo (${pesoLegible(tamanoBlob(archivo))})`, 'boton', 'descargar-archivo', `archivo:${id}`, { id })
      : boton(controlador?.accion === 'original' ? 'Preparando…' : 'Preparar el archivo completo', 'boton', 'archivo', `archivo:${id}`,
        { id }, ocupada()));
    div.append(acciones);
    return div;
  }
  function fila(copia: HistoriaArchivada, i: number): HTMLLIElement {
    const id = copia.trabajoId;
    const li = elemento('li');
    const texto = elemento('span', 'fila-texto', `Copia importada ${i + 1}`);
    texto.append(elemento('small', 'fila-estado',
      `${pesoLegible(tamanoBlob(copia.archivo))} · ${textoResumenCopia(resumenCopia(copia.contenido))}`));
    const ultima = copia.observaciones[copia.observaciones.length - 1] ?? null;
    texto.append(elemento('small', 'fila-estado', textoFotos(ultima)));
    li.append(texto);
    const aqui = abierta?.trabajoId === id;
    li.append(boton(consultando === id ? 'Leyendo…' : aqui ? 'Ocultar contenido' : 'Ver contenido', 'boton', 'ver', `ver:${id}`,
      { id }, consultando === id || (!aqui && ocupada())));
    if (pideReintento(ultima)) li.append(boton('Reintentar las fotos', 'boton', 'reintentar', `reintentar:${id}`, { id }, ocupada()));
    if (aqui && abierta) li.append(detalle(abierta));
    return li;
  }
  function pintar(enfocar?: string) {
    const c = contenedor;
    if (!c || !c.isConnected || !controlador) return;
    const estado = c.querySelector<HTMLElement>('.estado-copia');
    const confirmar = c.querySelector<HTMLElement>('.confirmar-copia');
    const acciones = c.querySelector<HTMLElement>('.acciones-copia');
    const estadoHistoria = c.querySelector<HTMLElement>('.estado-historia');
    const accionesH = c.querySelector<HTMLElement>('.acciones-historia');
    const filas = c.querySelector<HTMLElement>('.filas-historia');
    if (!estado || !confirmar || !acciones || !estadoHistoria || !accionesH || !filas) return;
    const foco = document.activeElement instanceof HTMLElement && c.contains(document.activeElement) ? document.activeElement : null;
    const hueco = foco?.dataset.hueco ?? null;
    const texto = textoEstado();
    if (estado.textContent !== texto) estado.textContent = texto;
    confirmar.hidden = !elegido;
    confirmar.replaceChildren(...(elegido ? confirmacion(elegido) : []));
    acciones.replaceChildren(...accionesCopia());
    const th = textoHistoria();
    if (estadoHistoria.textContent !== th) estadoHistoria.textContent = th;
    accionesH.replaceChildren(...accionesHistoria());
    filas.replaceChildren(...(historia.tipo === 'lista' ? historia.copias.map((copia, i) => fila(copia, i)) : []));
    // El foco no se pierde ni salta al documento: el mismo hueco, su sustituto o el título de la sección.
    if (!foco) return;
    const buscar = (h: string | null | undefined) => (h ? [...c.querySelectorAll<HTMLElement>('[data-hueco]')]
      .find((b) => b.dataset.hueco === h) : undefined);
    const destino = (enfocar ? buscar(enfocar) : undefined)
      ?? (foco.isConnected ? undefined : buscar(hueco) ?? buscar(sustituto(hueco)) ?? c.querySelector<HTMLElement>('h3') ?? undefined);
    if (destino && destino !== document.activeElement) destino.focus();
  }

  return {
    montar(c) {
      contenedor = c;
      const titulo = elemento('h3', '', 'Copia de este móvil');
      titulo.tabIndex = -1;
      if (!controlador) {
        c.replaceChildren(titulo, elemento('p', 'estado-copia', 'La copia de este móvil no está disponible aquí.'));
        return;
      }
      const estado = elemento('p', 'estado-copia');
      estado.setAttribute('role', 'status');
      const confirmar = elemento('div', 'confirmar-copia');
      confirmar.setAttribute('role', 'group');
      confirmar.setAttribute('aria-label', 'Confirmar la importación');
      confirmar.hidden = true;
      const estadoHistoria = elemento('p', 'estado-historia');
      estadoHistoria.setAttribute('role', 'status');
      c.replaceChildren(titulo, estado, confirmar, elemento('div', 'acciones-bloque acciones-copia'),
        elemento('h4', 'subs-titulo', 'Copias importadas'), estadoHistoria, elemento('div', 'acciones-bloque acciones-historia'),
        elemento('ul', 'filas-fotos-viaje filas-historia'), elemento('p', 'cifras', NOTA));
      pintar();
    },
    manejarClic(objetivo) {
      const c = contenedor;
      if (!c || !c.contains(objetivo)) return false;
      const b = objetivo.closest<HTMLElement>('button[data-copia]');
      if (!b || !controlador || b.getAttribute('aria-disabled') === 'true') return true;
      const id = b.dataset.id ?? '';
      switch (b.dataset.copia) {
        case 'preparar': void preparar(); break;
        case 'descargar': descargarActual(); break;
        case 'importar': elegir(); break;
        case 'confirmar': void importar(); break;
        case 'cancelar': cancelar(); break;
        case 'reintentar': void reintentar(id); break;
        case 'historia': void listar(); break;
        case 'ocultar': ocultar(); break;
        case 'ver': void alternarContenido(id); break;
        case 'archivo': void prepararArchivo(id); break;
        case 'descargar-archivo': descargarArchivo(id); break;
        case 'original': descargarOriginal(id, b.dataset.foto ?? ''); break;
      }
      return true;
    },
    desmontar() {
      contenedor = null;
    },
    cerrar() {
      contenedor = null;
      for (const u of urls.values()) revocarUrl(u.url);
      urls.clear();
      entrada?.remove();
      entrada = null;
    },
  };
}
