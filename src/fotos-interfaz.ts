import { crearPoliticaFotos, MODOS_FOTOS } from './fotos-datos';
import type { Itinerario } from './tipos';
import { copiarMetadatos, crearCapturaFoto, esDestinoActivo, esDestinoFoto, esFotoBorrada, tamanoBlob, tipoBlob,
  type CapturaFoto, type DestinoFoto, type MetadatosFoto } from './fotos';
import { abrirFotosLocal, type FotosLocal } from './fotos-local';
import { LIMITES_IMAGEN, crearMiniatura, inspeccionarImagen, type InspeccionImagen, type MiniaturaImagen,
  type MotorMiniatura } from './fotos-imagen';
import { avisoBorradoRespaldo, componerFotosRemotas, componerRespaldoFotos, crearSeccionFotosViaje, textoEstadoRespaldo,
  textoResultadoRespaldo, type CambioRespaldo, type ComposicionRespaldoFotos, type EstadoRespaldo,
  type ResultadoGuardado, type RespaldoFotos, type SeccionFotosViaje } from './fotos-respaldo-interfaz';
import { NOTA_VISOR_REMOTA, textoCeldaRemota, textoEstadoRemotas, textoLocalRemota, textoVisorRemota,
  type FotoRemota, type FotosRemotas, type SesionRemota, type VistaRemota } from './fotos-remotas';

/**
 * Fotos locales en la interfaz del viaje. Dos piezas:
 * 1. `crearFotosInterfaz`: controlador sin DOM (pruebas en Node). Abre la base de fotos solo para listar
 *    metadata, guarda originales sin optimismo, genera vistas previas en serie y solo para lo visible,
 *    y es dueño de cada URL blob que crea (visitas, visor y descargas).
 * 2. `crearFotosUi`: bloques «Fotos» de fichas y subparadas, selector de archivo y visor, sin innerHTML
 *    con nombres de archivo ni textos de error.
 * Cero red por sí mismas: las fotos no viajan ni se mezclan con el progreso compartido. Solo con la composición
 * EXPLÍCITA del respaldo (`OpcionesFotosUi.respaldo`; la web publicada pasa null) aparecen el respaldo manual en
 * el visor, «Fotos del viaje» en «Todo» y, en cada bloque «Fotos», las compartidas de ESE destino: al abrirlo se
 * consulta su primera página y cada celda pide su original solo a la vista, para una vista temporal que no se
 * guarda. «Guardar sin conexión» es otra acción, con la descarga duradera de siempre.
 */

export type ClaveDestino = string;
/** IDs persistentes del plan (p.p.id / sub.s.id), nunca índices visuales. */
export const claveDestino = (d: DestinoFoto): ClaveDestino =>
  d.tipo === 'parada' ? `p:${d.paradaId}` : `s:${d.paradaId}:${d.subparadaId}`;
export function destinoDeClave(plan: Itinerario, clave: string): DestinoFoto | null {
  const partes = clave.split(':');
  const destino = partes[0] === 'p' && partes.length === 2 ? { tipo: 'parada', viajeId: plan.id, paradaId: partes[1] }
    : partes[0] === 's' && partes.length === 3
      ? { tipo: 'subparada', viajeId: plan.id, paradaId: partes[1], subparadaId: partes[2] } : null;
  return destino && esDestinoFoto(plan, destino) ? destino : null;
}

export type EstadoEntrada = 'guardando' | 'guardada' | 'generando' | 'vista-pendiente' | 'sin-vista' | 'vista-sin-anotar'
  | 'no-guardada' | 'incierta' | 'borrando';
export interface EntradaFoto {
  readonly fotoId: string;
  readonly nombre: string;
  readonly bytesOriginal: number;
  readonly bytesMiniatura: number | null;
  readonly estado: EstadoEntrada;
  readonly motivo?: string;
  /** URL de la vista previa en la visita abierta de su destino (propiedad del controlador). */
  readonly url?: string;
  /** Solo en un intento de esta sesión aún sin guardar: su referencia para Reintentar y Descartar
   * (dos capturas con el mismo fotoId no se confunden ni se pisan). */
  readonly intento?: string;
}
export type ResultadoGuardar = { readonly tipo: 'guardada'; readonly fotoId: string }
  | { readonly tipo: 'no-guardada' | 'incierta'; readonly fotoId: string; readonly intento: string; readonly motivo: string }
  | { readonly tipo: 'no-lista' };
export interface DependenciasFotos {
  readonly plan: Itinerario;
  readonly abrir?: () => Promise<FotosLocal>;
  /** Un solo motor para toda la interfaz: una decodificación a la vez. */
  readonly crearMotor?: () => MotorMiniatura;
  readonly inspeccionar?: (b: Blob) => Promise<InspeccionImagen>;
  readonly crearUrl?: (b: Blob) => string;
  readonly revocarUrl?: (u: string) => void;
  /** Fecha informativa de la captura, nunca identidad ni orden. */
  readonly ahora?: () => number;
  readonly uuid?: () => string;
  readonly presentacion?: () => { readonly ladoCss: number; readonly dpr: number };
  readonly alCambiar?: (clave: ClaveDestino | null) => void;
}
export interface FotosInterfaz {
  readonly fase: 'cerrada' | 'abriendo' | 'lista' | 'fallo' | 'terminada';
  readonly error: string | null;
  /** Abre la base y lista SOLO metadata. Tras un fallo se puede volver a llamar (sin candado). */
  abrir(): Promise<void>;
  cuenta(destino: DestinoFoto): number;
  entradas(destino: DestinoFoto): readonly EntradaFoto[];
  /** Destinos que ya no están en el plan (retirados, por su tupla exacta) con fotos guardadas en este móvil. */
  destinosRetirados?(): readonly DestinoFoto[];
  /** Destino a la vista: lee sus vistas previas y prepara las pendientes, en serie. */
  abrirVisita(destino: DestinoFoto): void;
  /** Cancela lo pendiente de esa visita y revoca sus URLs. */
  cerrarVisita(destino: DestinoFoto): void;
  guardar(destino: DestinoFoto, archivo: File): Promise<ResultadoGuardar>;
  /** Mismo intento y misma identidad; antes comprueba si ESTA captura ya constaba guardada.
   * `referencia`: la de `EntradaFoto.intento` (o el fotoId, si solo un intento lo lleva). */
  reintentarGuardar(referencia: string): Promise<ResultadoGuardar>;
  /** Olvida un intento NO guardado de esta sesión (no toca la base). */
  descartar(referencia: string): void;
  reintentarVista(fotoId: string): Promise<void>;
  /** URL nueva de la vista previa para el visor; liberar con soltarUrl. */
  verMiniatura(fotoId: string): Promise<string | null>;
  /** Solo con cabecera identificada y dimensiones dentro del presupuesto; liberar con soltarUrl. */
  verOriginal(fotoId: string): Promise<{ readonly tipo: 'lista'; readonly url: string } | { readonly tipo: 'no-disponible'; readonly motivo: string }>;
  /** Bytes exactos como application/octet-stream: se descargan, nunca se muestran. */
  descargar(fotoId: string): Promise<{ readonly url: string; readonly nombre: string } | null>;
  soltarUrl(url: string): void;
  borrar(fotoId: string): Promise<'borrada' | 'ocupada' | 'fallo'>;
  urlsVivas(): number;
  cerrar(): void;
  /** El MISMO almacén abierto, para el respaldo (nunca una segunda conexión); null si no está listo.
   * Opcional para controladores sustitutos: sin él no hay respaldo. */
  puerto?(): FotosLocal | null;
  /** Indexa una foto que ya guardó en este móvil la descarga del catálogo (no escribe nada). */
  incorporar?(metadatos: MetadatosFoto): void;
}

const NO_GUARDADA = 'No se pudo guardar en este móvil.';
function motivoDe(e: unknown): string {
  return e instanceof DOMException && e.name === 'QuotaExceededError' ? 'No queda espacio en este móvil.' : NO_GUARDADA;
}

/**
 * Bloque para comparar originales: 1 MiB. Como mucho hay dos bloques en memoria a la vez (2 MiB), sea cual sea el
 * tamaño del original, y una foto de móvil de 3–12 MB son 3–12 vueltas, sin el coste por lectura de bloques pequeños.
 * No es un límite de peso: el original entero se compara.
 */
export const TROZO_IDENTIDAD = 1 << 20;
const leerBloque = async (b: Blob, inicio: number, fin: number) =>
  new Uint8Array(await Blob.prototype.arrayBuffer.call(Blob.prototype.slice.call(b, inicio, fin)));
/** Bytes exactos, por bloques; para en el primer bloque distinto. */
async function mismosBytes(a: Blob, b: Blob): Promise<boolean> {
  const n = tamanoBlob(a);
  if (n !== tamanoBlob(b)) return false;
  for (let inicio = 0; inicio < n; inicio += TROZO_IDENTIDAD) {
    const fin = Math.min(inicio + TROZO_IDENTIDAD, n);
    const [x, y] = await Promise.all([leerBloque(a, inicio, fin), leerBloque(b, inicio, fin)]);
    if (x.length !== y.length) return false;
    for (let i = 0; i < x.length; i++) if (x[i] !== y[i]) return false;
  }
  return true;
}
/** Metadata que fija la identidad de la captura, con Object.is (-0 no es 0). La miniatura no cuenta: es derivada
 * y puede haber cambiado después del commit sin que el original deje de ser el mismo. */
function mismaCaptura(a: MetadatosFoto, b: MetadatosFoto): boolean {
  const x = a.destino; const y = b.destino;
  return Object.is(a.formato, b.formato) && Object.is(a.fotoId, b.fotoId) && Object.is(a.nombre, b.nombre)
    && Object.is(a.mimeDeclarado, b.mimeDeclarado) && Object.is(a.ultimaModificacion, b.ultimaModificacion)
    && Object.is(a.incorporada, b.incorporada) && Object.is(a.bytesOriginal, b.bytesOriginal)
    && Object.is(x.tipo, y.tipo) && Object.is(x.viajeId, y.viajeId) && Object.is(x.paradaId, y.paradaId)
    && Object.is(x.tipo === 'subparada' ? x.subparadaId : null, y.tipo === 'subparada' ? y.subparadaId : null);
}
type Comprobacion = { readonly tipo: 'misma'; readonly metadatos: MetadatosFoto } | { readonly tipo: 'ausente' | 'otra' }
  | { readonly tipo: 'incierta'; readonly motivo: string };
/**
 * ¿Está ESTA captura guardada? La biblioteca rechaza siempre una colisión de ID (no hay idempotencia), así que una
 * metadata igual no prueba nada: hace falta la metadata del original idéntica y sus bytes exactos. Solo lecturas
 * locales; nunca escribe, repara ni borra. Un original vivo no cambia (solo puede pasar a tombstone, que es
 * definitivo), así que metadata → original → metadata otra vez, las tres iguales, es una lectura coherente.
 */
async function comprobar(almacen: FotosLocal, captura: CapturaFoto): Promise<Comprobacion> {
  const esperada = captura.metadatos;
  const id = esperada.fotoId;
  const incierta = (motivo: string): Comprobacion => ({ tipo: 'incierta', motivo });
  try {
    const antes = await almacen.leerMetadatos(id);
    if (!antes) return { tipo: 'ausente' };
    if (esFotoBorrada(antes)) return incierta('Su identidad ya consta como borrada.');
    if (!mismaCaptura(antes, esperada)) return { tipo: 'otra' };
    // leerOriginal valida tamaño y tipo contra la metadata en su misma transacción.
    const original = await almacen.leerOriginal(id);
    if (!original || tamanoBlob(original) !== esperada.bytesOriginal || tipoBlob(original) !== esperada.mimeDeclarado) {
      return incierta('No se pudo leer el original guardado para comprobarlo.');
    }
    if (!await mismosBytes(original, captura.original)) return { tipo: 'otra' };
    const despues = await almacen.leerMetadatos(id);
    if (!despues || esFotoBorrada(despues) || !mismaCaptura(despues, esperada)) return incierta('Cambió mientras se comprobaba.');
    return { tipo: 'misma', metadatos: despues };
  } catch {
    return incierta('No se pudo comprobar si se guardó.');
  }
}

export function crearFotosInterfaz(dependencias: DependenciasFotos): FotosInterfaz {
  const { plan } = dependencias;
  const abrirLocal = dependencias.abrir ?? (() => abrirFotosLocal(plan));
  const crearMotor = dependencias.crearMotor ?? (() => crearMiniatura());
  const inspeccionar = dependencias.inspeccionar ?? inspeccionarImagen;
  const crearUrl = dependencias.crearUrl ?? ((b: Blob) => URL.createObjectURL(b));
  const revocarUrl = dependencias.revocarUrl ?? ((u: string) => URL.revokeObjectURL(u));
  const ahora = dependencias.ahora ?? Date.now;
  const presentacion = dependencias.presentacion
    ?? (() => ({ ladoCss: 160, dpr: Math.min(globalThis.devicePixelRatio || 1, 3) }));

  let fase: FotosInterfaz['fase'] = 'cerrada';
  let error: string | null = null;
  let local: FotosLocal | undefined;
  let motor: MotorMiniatura | undefined;
  let apertura: Promise<void> | undefined;
  let generacion = 0;
  const indice = new Map<string, MetadatosFoto>();
  interface Intento { readonly clave: string; readonly destino: DestinoFoto; readonly captura: CapturaFoto;
    estado: 'guardando' | 'no-guardada' | 'incierta'; motivo?: string }
  /** Por una clave propia de la sesión, no por fotoId: una captura nueva nunca pisa a otra pendiente. */
  const intentos = new Map<string, Intento>();
  let secuencia = 0;
  function buscarIntento(referencia: string): Intento | undefined {
    const directo = intentos.get(referencia);
    if (directo) return directo;
    const conEseId = [...intentos.values()].filter((i) => i.captura.metadatos.fotoId === referencia);
    return conEseId.length === 1 ? conEseId[0] : undefined;
  }
  const generando = new Set<string>();
  /** Fallo de vista previa que no se pudo anotar: sigue pendiente en la base, sin reintento solo en esta sesión. */
  const sinAnotar = new Map<string, string>();
  const ilegibles = new Map<string, string>();
  const borrando = new Set<string>();
  interface Visita { readonly clave: ClaveDestino; readonly control: AbortController; readonly urls: Map<string, string> }
  const visitas = new Map<ClaveDestino, Visita>();
  const entregadas = new Set<string>();
  let cola: Promise<void> = Promise.resolve();

  function avisar(clave: ClaveDestino | null) {
    if (fase === 'terminada') return;
    try { dependencias.alCambiar?.(clave); } catch { /* La interfaz no altera lo guardado. */ }
  }
  const vigente = (v: Visita) => visitas.get(v.clave) === v && fase === 'lista';
  function encolar(trabajo: () => Promise<void>) { cola = cola.then(trabajo).catch(() => {}); }

  const VISTA_INVALIDA = 'La vista previa guardada no es válida; el original sigue guardado.';
  /**
   * Vista previa GUARDADA apta para un <img>; la misma comprobación para la lista y el visor. Sus bytes deben ser un
   * PNG identificado por el inspector de siempre (solo la cabecera, sin decodificar), con el peso y las dimensiones
   * de su metadata leída DESPUÉS del blob (fresca: si ya es tombstone, nada) y dentro del lado máximo de miniatura.
   * No exige CRC ni autentica el contenido. No borra, repara ni regenera nada; el original no se toca.
   */
  async function leerVistaSegura(almacen: FotosLocal, id: string):
    Promise<{ readonly tipo: 'lista'; readonly blob: Blob } | { readonly tipo: 'ninguna' | 'invalida' }> {
    const blob = await almacen.leerMiniatura(id);
    if (!blob) return { tipo: 'ninguna' };
    const m = await almacen.leerMetadatos(id);
    if (!m || esFotoBorrada(m) || m.miniatura.tipo !== 'lista') return { tipo: 'ninguna' };
    const v = m.miniatura;
    if (tamanoBlob(blob) !== v.bytes || tipoBlob(blob) !== 'image/png') return { tipo: 'invalida' };
    const i = await inspeccionar(blob);
    return i.tipo === 'identificada' && i.mime === 'image/png' && i.ancho === v.ancho && i.alto === v.alto
      && Math.max(i.ancho, i.alto) <= LIMITES_IMAGEN.ladoSalida ? { tipo: 'lista', blob } : { tipo: 'invalida' };
  }

  function abrir(): Promise<void> {
    if (fase === 'terminada' || fase === 'lista') return Promise.resolve();
    if (apertura) return apertura;
    const gen = ++generacion;
    fase = 'abriendo'; error = null;
    avisar(null);
    let terminada = false;
    let propia: Promise<void> | undefined;
    propia = (async () => {
      let abierta: FotosLocal | undefined;
      try {
        abierta = await abrirLocal();
        const lista = await abierta.listar();
        if (gen !== generacion || fase !== 'abriendo') { abierta.cerrar(); return; }
        local = abierta;
        indice.clear();
        for (const m of lista) indice.set(m.fotoId, m);
        fase = 'lista';
        for (const v of visitas.values()) cargarVisita(v);
      } catch {
        abierta?.cerrar();
        if (gen !== generacion || fase !== 'abriendo') return;
        fase = 'fallo'; error = 'No se pudieron abrir las fotos de este móvil.';
      } finally {
        terminada = true;
        if (apertura === propia) apertura = undefined;
      }
      avisar(null);
    })();
    // Igual que en la sincronización: nunca guardar una promesa ya resuelta como candado.
    if (!terminada) apertura = propia;
    return propia;
  }

  function estadoDe(m: MetadatosFoto): Pick<EntradaFoto, 'estado' | 'motivo'> {
    const id = m.fotoId;
    if (borrando.has(id)) return { estado: 'borrando' };
    if (ilegibles.has(id)) return { estado: 'sin-vista', motivo: ilegibles.get(id) };
    if (m.miniatura.tipo === 'lista') return { estado: 'guardada' };
    if (m.miniatura.tipo === 'fallida') return { estado: 'sin-vista', motivo: m.miniatura.motivo };
    if (generando.has(id)) return { estado: 'generando' };
    if (sinAnotar.has(id)) return { estado: 'vista-sin-anotar', motivo: sinAnotar.get(id) };
    return { estado: 'vista-pendiente' };
  }
  function entradas(destino: DestinoFoto): EntradaFoto[] {
    const clave = claveDestino(destino);
    const visita = visitas.get(clave);
    const salida: EntradaFoto[] = [];
    // Por fecha de captura solo para enseñarlas (la base las lista por ID); a igual fecha, como llegaron.
    const propias = [...indice.values()].filter((m) => claveDestino(m.destino) === clave)
      .sort((x, y) => x.incorporada - y.incorporada);
    for (const m of propias) {
      const url = visita?.urls.get(m.fotoId);
      salida.push({ fotoId: m.fotoId, nombre: m.nombre, bytesOriginal: m.bytesOriginal,
        bytesMiniatura: m.miniatura.tipo === 'lista' ? m.miniatura.bytes : null, ...estadoDe(m), ...(url ? { url } : {}) });
    }
    for (const i of intentos.values()) {
      if (claveDestino(i.destino) !== clave) continue;
      const m = i.captura.metadatos;
      salida.push({ fotoId: m.fotoId, nombre: m.nombre, bytesOriginal: m.bytesOriginal, bytesMiniatura: null,
        estado: i.estado, intento: i.clave, ...(i.motivo ? { motivo: i.motivo } : {}) });
    }
    return salida;
  }

  /** Solo con la confirmación de la propia escritura o con la identidad completa ya comprobada. */
  function confirmar(intento: Intento, m: MetadatosFoto): ResultadoGuardar {
    const id = m.fotoId;
    intentos.delete(intento.clave);
    indice.set(id, m);
    const visita = visitas.get(claveDestino(m.destino));
    // Solo esta foto, recién confirmada y a la vista, se decodifica ahora.
    if (visita && m.miniatura.tipo === 'pendiente') encolarVista(id, visita);
    avisar(claveDestino(m.destino));
    return { tipo: 'guardada', fotoId: id };
  }
  /** Ante un error comprueba la identidad completa antes de afirmar nada; nunca regenera el ID. */
  async function intentar(intento: Intento): Promise<ResultadoGuardar> {
    const almacen = local;
    if (intentos.get(intento.clave) !== intento || !almacen || fase !== 'lista') return { tipo: 'no-lista' };
    try {
      // Lo elegido con «Tomar foto» o «Elegir de la galería» (los dos acaban aquí) queda con su procedencia
      // positiva, en la MISMA transacción. Descargas e importaciones guardan sin vía: nunca la obtienen.
      const r = await almacen.guardarOriginal(intento.captura, 'camara-galeria');
      if (r.tipo !== 'guardada') throw new Error('Respuesta inesperada');
      return confirmar(intento, r.metadatos);
    } catch (e) {
      return decidir(intento, await comprobar(almacen, intento.captura), motivoDe(e));
    }
  }
  /** Sin identidad probada la captura se queda en la sesión (Reintentar o Descartar); nunca se toma otra por ella. */
  function decidir(intento: Intento, c: Comprobacion, motivo: string): ResultadoGuardar {
    if (c.tipo === 'misma') return confirmar(intento, c.metadatos);
    intento.estado = c.tipo === 'incierta' ? 'incierta' : 'no-guardada';
    intento.motivo = c.tipo === 'incierta' ? c.motivo : c.tipo === 'otra' ? 'Otra foto de este móvil ya usa su identidad.' : motivo;
    avisar(claveDestino(intento.destino));
    return { tipo: intento.estado, fotoId: intento.captura.metadatos.fotoId, intento: intento.clave, motivo: intento.motivo };
  }

  function cargarVisita(v: Visita) {
    for (const m of indice.values()) {
      if (claveDestino(m.destino) !== v.clave) continue;
      if (m.miniatura.tipo === 'lista') encolar(() => cargarMiniatura(m.fotoId, v));
      else if (m.miniatura.tipo === 'pendiente') encolarVista(m.fotoId, v);
    }
  }
  async function cargarMiniatura(id: string, v: Visita) {
    const almacen = local;
    if (!almacen || !vigente(v) || v.urls.has(id) || !indice.has(id)) return;
    try {
      const r = await leerVistaSegura(almacen, id);
      if (!vigente(v) || !indice.has(id) || v.urls.has(id)) return;
      if (r.tipo === 'lista') {
        v.urls.set(id, crearUrl(r.blob));
        ilegibles.delete(id);
      } else if (r.tipo === 'invalida') ilegibles.set(id, VISTA_INVALIDA);
    } catch {
      // Nunca se borra por un error de lectura: el original sigue guardado.
      if (indice.has(id)) ilegibles.set(id, 'No se pudo leer la vista previa; el original sigue guardado.');
    }
    avisar(v.clave);
  }
  function encolarVista(id: string, v: Visita | null, forzar = false) {
    if (generando.has(id) || (!forzar && sinAnotar.has(id))) return;
    generando.add(id);
    avisar(v?.clave ?? null);
    encolar(() => generarVista(id, v, forzar));
  }
  async function generarVista(id: string, v: Visita | null, forzar: boolean) {
    const almacen = local;
    const clave = v?.clave ?? null;
    const control = v?.control ?? new AbortController();
    try {
      const actual = indice.get(id);
      if (!almacen || fase !== 'lista' || !actual || (v && !vigente(v))) return;
      if (!forzar && actual.miniatura.tipo !== 'pendiente') return;
      const original = await almacen.leerOriginal(id);
      if (!original || (v && !vigente(v)) || !indice.has(id)) return;
      motor ??= crearMotor();
      let r: MiniaturaImagen;
      try {
        r = await motor.generar(original, { senal: control.signal, ...presentacion() });
      } catch {
        if (control.signal.aborted || (v && !vigente(v)) || fase !== 'lista') return;
        r = { tipo: 'no-disponible', motivo: 'Este navegador no pudo preparar la vista previa.' };
      }
      if (!indice.has(id)) return; // Borrada mientras tanto: nada que resucitar.
      if (r.tipo === 'lista') {
        try {
          const res = await almacen.guardarMiniatura(id, r.blob, r.ancho, r.alto);
          if (res.tipo === 'guardada' && indice.has(id)) {
            indice.set(id, res.metadatos);
            sinAnotar.delete(id); ilegibles.delete(id);
            const destino = visitas.get(claveDestino(res.metadatos.destino));
            if (destino && vigente(destino) && !destino.urls.has(id)) destino.urls.set(id, crearUrl(r.blob));
          }
        } catch {
          if (await sigueViva(id)) await anotarFallo(id, 'No se pudo guardar la vista previa.');
        }
        return;
      }
      await anotarFallo(id, r.motivo);
    } catch {
      // No se pudo leer el original: sigue pendiente, sin bucle automático en esta sesión.
      if (indice.has(id)) sinAnotar.set(id, 'No se pudo leer el original para preparar la vista previa.');
    } finally {
      generando.delete(id);
      const m = indice.get(id);
      avisar(clave ?? (m ? claveDestino(m.destino) : null));
    }
  }
  async function anotarFallo(id: string, motivo: string) {
    const almacen = local;
    if (!almacen) return;
    try {
      const res = await almacen.registrarFalloMiniatura(id, motivo);
      if (res.tipo === 'guardada' && indice.has(id)) { indice.set(id, res.metadatos); sinAnotar.delete(id); }
    } catch {
      if (await sigueViva(id)) sinAnotar.set(id, motivo);
    }
  }
  /** Tras un fallo, mira la base: si la foto ya no existe (otra conexión la borró), deja de mostrarla. */
  async function sigueViva(id: string): Promise<boolean> {
    try {
      const m = await local?.leerMetadatos(id);
      if (!m || esFotoBorrada(m)) { indice.delete(id); return false; }
      return true;
    } catch { return indice.has(id); }
  }
  function cerrarVisitaClave(clave: ClaveDestino) {
    const v = visitas.get(clave);
    if (!v) return;
    v.control.abort();
    for (const u of v.urls.values()) revocarUrl(u);
    v.urls.clear();
    visitas.delete(clave);
  }
  function entregar(blob: Blob): string {
    const u = crearUrl(blob);
    entregadas.add(u);
    return u;
  }

  return {
    get fase() { return fase; },
    get error() { return error; },
    abrir,
    cuenta: (destino) => {
      const clave = claveDestino(destino);
      let n = 0;
      for (const m of indice.values()) if (claveDestino(m.destino) === clave) n++;
      return n;
    },
    entradas,
    destinosRetirados() {
      const retirados = new Map<ClaveDestino, DestinoFoto>();
      for (const m of indice.values()) if (!esDestinoActivo(plan, m.destino)) retirados.set(claveDestino(m.destino), m.destino);
      return [...retirados.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([, d]) => d);
    },
    abrirVisita(destino) {
      const clave = claveDestino(destino);
      cerrarVisitaClave(clave);
      const v: Visita = { clave, control: new AbortController(), urls: new Map() };
      visitas.set(clave, v);
      if (fase === 'lista') cargarVisita(v);
      avisar(clave);
    },
    cerrarVisita(destino) {
      const clave = claveDestino(destino);
      cerrarVisitaClave(clave);
      avisar(clave);
    },
    async guardar(destino, archivo) {
      if (fase !== 'lista' || !local) return { tipo: 'no-lista' };
      // UNA captura por intento, con el destino que se fijó al abrir el selector.
      const captura = crearCapturaFoto(plan, destino, archivo, ahora(), dependencias.uuid ? { uuid: dependencias.uuid } : {});
      const intento: Intento = { clave: `intento:${++secuencia}`, destino, captura, estado: 'guardando' };
      intentos.set(intento.clave, intento);
      avisar(claveDestino(destino));
      return intentar(intento);
    },
    async reintentarGuardar(referencia) {
      const intento = buscarIntento(referencia);
      const almacen = local;
      if (!intento || fase !== 'lista' || !almacen) return { tipo: 'no-lista' };
      const fotoId = intento.captura.metadatos.fotoId;
      if (intento.estado === 'guardando') return { tipo: 'incierta', fotoId, intento: intento.clave, motivo: 'Ya se está guardando.' };
      intento.estado = 'guardando'; intento.motivo = undefined;
      avisar(claveDestino(intento.destino));
      // Si un intento anterior sí llegó a guardarse, solo vale con su identidad completa; si otra foto ocupa
      // el ID, no se escribe nada. Ausente o sin poder comprobarlo: se intenta (la biblioteca nunca sobrescribe).
      const c = await comprobar(almacen, intento.captura);
      if (c.tipo === 'misma' || c.tipo === 'otra') return decidir(intento, c, NO_GUARDADA);
      return intentar(intento);
    },
    descartar(referencia) {
      const intento = buscarIntento(referencia);
      if (!intento || intento.estado === 'guardando') return;
      intentos.delete(intento.clave);
      avisar(claveDestino(intento.destino));
    },
    async reintentarVista(id) {
      const m = indice.get(id);
      if (!m || fase !== 'lista') return;
      sinAnotar.delete(id); ilegibles.delete(id);
      const v = visitas.get(claveDestino(m.destino)) ?? null;
      encolarVista(id, v, true);
      await cola;
    },
    async verMiniatura(id) {
      const m = indice.get(id);
      const almacen = local;
      if (!almacen || !m || m.miniatura.tipo !== 'lista') return null;
      try {
        const r = await leerVistaSegura(almacen, id);
        if (!indice.has(id) || fase !== 'lista') return null;
        if (r.tipo === 'invalida') {
          ilegibles.set(id, VISTA_INVALIDA);
          avisar(claveDestino(m.destino));
        }
        return r.tipo === 'lista' ? entregar(r.blob) : null;
      } catch { return null; }
    },
    async verOriginal(id) {
      if (!local || !indice.has(id)) return { tipo: 'no-disponible', motivo: 'La foto ya no está en este móvil.' };
      try {
        const original = await local.leerOriginal(id);
        if (!original) return { tipo: 'no-disponible', motivo: 'La foto ya no está en este móvil.' };
        const inspeccion = await inspeccionar(original);
        if (inspeccion.tipo !== 'identificada') return { tipo: 'no-disponible', motivo: inspeccion.motivo };
        if (fase !== 'lista' || !indice.has(id)) return { tipo: 'no-disponible', motivo: 'La foto ya no está en este móvil.' };
        // MIME identificado por la cabecera, no el declarado: los bytes no cambian.
        return { tipo: 'lista', url: entregar(Blob.prototype.slice.call(original, 0, tamanoBlob(original), inspeccion.mime)) };
      } catch { return { tipo: 'no-disponible', motivo: 'No se pudo leer el original.' }; }
    },
    async descargar(id) {
      const m = indice.get(id);
      if (!local || !m) return null;
      try {
        const original = await local.leerOriginal(id);
        if (!original || fase !== 'lista') return null;
        return { url: entregar(Blob.prototype.slice.call(original, 0, tamanoBlob(original), 'application/octet-stream')),
          nombre: m.nombre };
      } catch { return null; }
    },
    soltarUrl(url) {
      if (entregadas.delete(url)) revocarUrl(url);
    },
    async borrar(id) {
      if (borrando.has(id)) return 'ocupada';
      const m = indice.get(id);
      if (!m || !local || fase !== 'lista') return 'fallo';
      const clave = claveDestino(m.destino);
      borrando.add(id);
      avisar(clave);
      try {
        const r = await local.borrarLocal(id);
        if (r.tipo !== 'borrada') throw new Error('Respuesta inesperada');
        indice.delete(id); sinAnotar.delete(id); ilegibles.delete(id);
        for (const v of visitas.values()) {
          const u = v.urls.get(id);
          if (u) { revocarUrl(u); v.urls.delete(id); }
        }
        return 'borrada';
      } catch {
        return 'fallo';
      } finally {
        borrando.delete(id);
        avisar(clave);
      }
    },
    urlsVivas() {
      let n = entregadas.size;
      for (const v of visitas.values()) n += v.urls.size;
      return n;
    },
    puerto: () => (fase === 'lista' && local ? local : null),
    incorporar(metadatos) {
      if (fase !== 'lista') return;
      let m: MetadatosFoto;
      try { m = copiarMetadatos(plan, metadatos); } catch { return; }
      if (borrando.has(m.fotoId)) return;
      indice.set(m.fotoId, m);
      const visita = visitas.get(claveDestino(m.destino));
      // Igual que una foto recién guardada: solo si su destino está a la vista se prepara o se lee su vista previa.
      if (visita && m.miniatura.tipo === 'pendiente') encolarVista(m.fotoId, visita);
      else if (visita && m.miniatura.tipo === 'lista') encolar(() => cargarMiniatura(m.fotoId, visita));
      avisar(claveDestino(m.destino));
    },
    cerrar() {
      generacion++;
      for (const clave of [...visitas.keys()]) cerrarVisitaClave(clave);
      for (const u of entregadas) revocarUrl(u);
      entregadas.clear();
      motor?.cerrar();
      local?.cerrar();
      local = undefined;
      fase = 'terminada';
    },
  };
}

// ---------- Interfaz (DOM) ----------

export interface OpcionesFotosUi {
  readonly plan: Itinerario;
  /** Contenedor de la lista de fichas: los bloques «Fotos» viven dentro. */
  readonly contenido: HTMLElement;
  /** Nombre legible del destino, para títulos y nombres accesibles. */
  readonly nombreDe: (destino: DestinoFoto) => string;
  /** Aviso para un resultado cuyo panel ya está cerrado (con el panel abierto lo dice su línea de estado). */
  readonly anunciar: (texto: string) => void;
  readonly controlador?: FotosInterfaz;
  /** Respaldo manual y catálogo, solo con composición EXPLÍCITA. null u omitido (la web publicada): ni red,
   * ni ledger, ni texto nuevo. No hay flag de compilación, entorno ni URL que lo active. */
  readonly respaldo?: ComposicionRespaldoFotos | null;
  /** Último refugio del foco al cerrar el visor cuando ya no existe lo que lo abrió ni la sección de sitios retirados
   * (main: el título de «Todo»). */
  readonly focoDeReserva?: () => HTMLElement | null;
}
export interface FotosUi {
  readonly controlador: FotosInterfaz;
  /** Hay composición de respaldo: solo entonces existen el bloque del visor y «Fotos del viaje». */
  readonly respaldoActivo: boolean;
  /** Monta «Fotos del viaje» en su sección de «Todo»; sin composición no hace nada. */
  montarFotosViaje(contenedor: HTMLElement): void;
  montarDatos(contenedor: HTMLElement): void;
  permitirDatos(): void;
  tomar(destino: DestinoFoto): void;
  abrirAlbum(contenedor: HTMLElement): void;
  /** «Sitios que ya no están en el plan» en «Todo»: el bloque «Fotos» de cada destino retirado con fotos en este móvil,
   * sin captura. Con o sin composición (también en la web publicada): solo lee metadata local, sin red. Vacía, oculta. */
  montarRetiradas(contenedor: HTMLElement): void;
  /** Bloque «Fotos» (solo atributos con IDs del plan y texto escapado) para incrustar en la ficha. */
  html(destino: DestinoFoto, prefijo?: string): string;
  /** Delegación de clics: devuelve true si el clic era de fotos (va antes que los manejadores de fila). */
  manejarClic(objetivo: Element): boolean;
  /** Abre la base (solo metadata) y pinta los recuentos. */
  preparar(): void;
  /** Antes de sustituir la lista: cierra las visitas y libera sus URLs. */
  desmontar(): void;
  pintarCuentas(): void;
  /** Cierra el visor si está abierto; devuelve si lo estaba. */
  cerrarVisor(desdeHistorial?: boolean): boolean;
  /** Ciclo de vida: la ficha (o el sitio de dentro) que contiene estos bloques se pliega. Sus «Fotos» abiertas se
   * cierran de verdad: consultas y originales cortados, vistas soltadas y URLs revocadas; las fotos de este móvil
   * no se tocan y el bloque se puede volver a abrir (con una consulta nueva). */
  cerrarEn(contenedor: Element): void;
}

const escapar = (texto: string) => texto.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
function peso(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return `${(bytes / (1024 * 1024)).toLocaleString('es-ES', { maximumFractionDigits: 1 })} MB`;
}
const TEXTO_ESTADO: Record<EstadoEntrada, string> = {
  'guardando': 'Guardando…',
  'guardada': 'Guardada en este móvil',
  'generando': 'Preparando…',
  'vista-pendiente': 'Vista previa pendiente',
  'sin-vista': 'Sin vista previa',
  'vista-sin-anotar': 'Vista previa pendiente',
  'no-guardada': 'No se ha guardado',
  'incierta': 'No se sabe si se guardó',
  'borrando': 'Borrando…',
};
const ICONO_CAMARA = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 8h3l1.6-2.2h6.8L17 8h3v11H4z" /><circle cx="12" cy="13.2" r="3.4" /></svg>';
const ICONO_CERRAR = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6 6 18" /></svg>';
const NOTA = 'Se guardan solo en este móvil y funcionan sin conexión. Por ahora no se comparten con el otro móvil ni tienen copia de seguridad.';
const NOTA_RESPALDO = 'Tus fotos se guardan primero en este móvil. Las compartidas se ven según tu elección de datos en Ajustes.';
const NOTA_RETIRADA = 'Este sitio ya no está en el plan: sus fotos siguen guardadas en este móvil, pero no se pueden añadir nuevas.';
const CONFIRMAR_BORRADO = '¿Borrar esta foto de este móvil? Se borran el original y su vista previa; no se puede deshacer.';

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

export function crearFotosUi(opciones: OpcionesFotosUi): FotosUi {
  const { plan, contenido, nombreDe, anunciar } = opciones;
  /** Bloques con el panel abierto, por destino. */
  const abiertos = new Map<ClaveDestino, HTMLElement>();
  /** Último resultado de una acción, por destino (se muestra en la línea de estado del panel). */
  const mensajes = new Map<ClaveDestino, string>();
  const controlador = opciones.controlador ?? crearFotosInterfaz({ plan, alCambiar: (clave) => alCambiar(clave) });
  // Gate de composición: con null no se construye nada (ni ledger, ni red, ni texto nuevo). Sin IO al crearse.
  const composicion = opciones.respaldo ?? null;
  const redPermitida = () => politica.permitida && navigator.onLine !== false;
  const httpFotos: typeof fetch = async (entrada, init) => {
    if (!redPermitida()) throw new Error('Transferencias de fotos pausadas.');
    const control = new AbortController(); permisosEnCurso.add(control);
    const abortar = () => control.abort();
    const origen = init?.signal ?? (entrada instanceof Request ? entrada.signal : undefined);
    origen?.addEventListener('abort', abortar, { once: true });
    if (origen?.aborted) control.abort();
    try { return await fetch(entrada, { ...init, signal: control.signal }); }
    finally { permisosEnCurso.delete(control); /* El signal de origen conserva el aborto durante la lectura del cuerpo. */ }
  };
  const respaldo: RespaldoFotos | null = componerRespaldoFotos(composicion, { plan, fetch: httpFotos, enLinea: redPermitida,
    puerto: () => controlador.puerto?.() ?? null,
    incorporar: (m) => {
      controlador.incorporar?.(m);
      // Guardada desde el catálogo o desde la ficha: deja de repetirse como compartida. Con su visor abierto,
      // se vuelve a clasificar al cerrarlo (su vista temporal sigue a la vista hasta entonces).
      if (!(visorRemoto && visorFoto === m.fotoId)) void remotas?.sesion(m.destino)?.reclasificar(m.fotoId);
    },
    alCambiar: (que) => alCambiarRespaldo(que) });
  // Compartidas de cada ficha, con la MISMA composición (null: ni recepción, ni listado, ni red). Sin IO al crearse.
  const remotas: FotosRemotas | null = componerFotosRemotas(composicion, { plan, fetch: httpFotos, enLinea: redPermitida,
    puerto: () => controlador.puerto?.() ?? null,
    alCambiar: (destino) => alCambiarRemotas(destino),
    // Un 401 de las compartidas suelta también las candidatas del catálogo global (y lo pendiente del visor).
    alPerderSesion: () => perderSesionUi('remotas') });
  let seccion: SeccionFotosViaje | null = null;
  /** Sección de sitios retirados de «Todo» y la lista de destinos que pinta (solo se sustituye si cambia). */
  let retiradas: { contenedor: HTMLElement; firma: string } | null = null;

  let almacenDatos: Storage | null = null;
  try { almacenDatos = localStorage; } catch { /* Ahorro si no hay preferencias legibles. */ }
  let datosContenedor: HTMLElement | null = null;
  let automaticoOcupado = false;
  let otraPasadaAutomatica = false;
  let automatismoBloqueado = false;
  const politica = crearPoliticaFotos(almacenDatos, aplicarDatos);
  const permisosEnCurso = new Set<AbortController>();
  if (composicion && !politica.permitida) remotas?.suspender();
  function pintarDatos() {
    if (!datosContenedor) return;
    // Controles estables: cambiar el modo con las flechas no destruye el radio que conserva el foco.
    if (!datosContenedor.querySelector('[name="datos-fotos"]')) datosContenedor.innerHTML = `<h3>Datos de las fotos</h3>
      <p>Elige cuándo usar internet. La app no puede asegurar que estés en wifi.</p>
      <label class="opcion-datos"><input type="radio" name="datos-fotos" value="ahorro"> Datos limitados</label>
      <p class="cifras">Tus fotos siempre se ven. Las compartidas no se consultan ni descargan sin tu permiso.</p>
      <label class="opcion-datos"><input type="radio" name="datos-fotos" value="ilimitados"> Datos ilimitados</label>
      <p class="cifras">Sube las pendientes y carga las compartidas visibles, también con datos móviles. Solo mientras la app esté abierta y visible.</p>
      <p role="status"></p>
      <div data-datos-temporal><button class="boton" type="button" data-datos-permitir>Permitir fotos durante esta visita</button><p class="cifras">Puede consumir datos móviles (hasta 8 MB por foto). Al ocultar o salir de la app, tendrás que permitirlo otra vez.</p></div>`;
    for (const input of datosContenedor.querySelectorAll<HTMLInputElement>('[name="datos-fotos"]')) {
      input.checked = input.value === politica.modo;
    }
    datosContenedor.querySelector('[role="status"]')!.textContent = politica.permitida
      ? 'Transferencias permitidas mientras usas la app.' : 'Ahorro activo. No se transfieren fotos.';
    datosContenedor.querySelector<HTMLElement>('[data-datos-temporal]')!.hidden = politica.modo !== 'ahorro' || politica.permitida;
  }
  function aplicarDatos() {
    if (!politica.permitida) {
      for (const c of permisosEnCurso) c.abort();
      remotas?.suspender(); respaldo?.abandonarLote(); respaldo?.cancelarGuardado(); respaldo?.cancelarListado();
    } else {
      remotas?.reanudar();
      for (const clave of abiertos.keys()) {
        const d = destinoDeClave(plan, clave);
        if (d && !visorFoto) { const sesion = remotas?.sesion(d); if (sesion) void sesion.refrescar(); else remotas?.abrir(d); }
      }
      automatismoBloqueado = false;
      void subirAutomaticamente();
    }
    pintarDatos();
    for (const [clave, bloque] of abiertos) if (bloque.isConnected) pintarPanel(clave, bloque);
  }
  async function subirAutomaticamente() {
    if (!respaldo || !politica.automatica || !redPermitida() || automatismoBloqueado || controlador.fase !== 'lista') return;
    if (automaticoOcupado) { otraPasadaAutomatica = true; return; }
    if (respaldo.lote.tipo === 'enviando' || respaldo.lote.tipo === 'contando') return;
    automaticoOcupado = true;
    try {
      await respaldo.contarLote();
      if (politica.automatica && redPermitida() && respaldo.lote.tipo === 'propuesta') {
        await respaldo.confirmarLote();
        if ((respaldo.lote as { tipo: string }).tipo === 'detenido') automatismoBloqueado = true;
      }
    } finally {
      automaticoOcupado = false;
      if (otraPasadaAutomatica) { otraPasadaAutomatica = false; void subirAutomaticamente(); }
    }
  }
  if (composicion) {
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden') politica.suspender(); else politica.reanudar();
    });
    addEventListener('pagehide', () => politica.suspender());
    addEventListener('pageshow', () => { if (document.visibilityState !== 'hidden') politica.reanudar(); });
    queueMicrotask(() => {
      if (document.visibilityState === 'hidden') politica.suspender();
      else if (politica.automatica) void controlador.abrir();
    });
    addEventListener('online', () => { if (document.visibilityState !== 'hidden') politica.reanudar(); });
  }

  function alCambiar(clave: ClaveDestino | null) {
    for (const [c, bloque] of abiertos) {
      if (clave === null || c === clave) {
        if (bloque.isConnected) pintarPanel(c, bloque);
        else cerrarAbierto(c);
      }
    }
    pintarRetiradas();
    pintarCuentas();
    if (visorFoto) actualizarVisor();
    // Al abrirse (o fallar) las fotos de este móvil, «Fotos del viaje» ya puede leer su estado local.
    if (clave === null) {
      seccion?.alCambiar({ tipo: 'resumen' }); void subirAutomaticamente();
      if (controlador.fase === 'lista' && respaldo) void respaldo.resumen().then(() => {
        for (const [c, bloque] of abiertos) if (bloque.isConnected) pintarPanel(c, bloque);
      }).catch(() => {});
    }
  }
  /** Repinta desde lo ya leído del ledger (0 IO): la línea del visor de ESA foto y «Fotos del viaje». */
  function alCambiarRespaldo(que: CambioRespaldo): void {
    // Un 401 del catálogo o de «Guardar sin conexión»: fuera todas las vistas y candidatas compartidas.
    if (que.tipo === 'sin-sesion') { perderSesionUi('respaldo'); return; }
    if (que.tipo === 'foto' && visorFoto === que.fotoId && respaldo) pintarRespaldo(que.fotoId, respaldo.estado(que.fotoId));
    seccion?.alCambiar(que);
    for (const [c, bloque] of abiertos) if (bloque.isConnected && que.tipo === 'foto') pintarPanel(c, bloque);
  }
  /** Repinta las compartidas de ese destino (null: de todos) y, si es la suya, el visor abierto. */
  function alCambiarRemotas(destino: DestinoFoto | null) {
    const clave = destino ? claveDestino(destino) : null;
    for (const [c, bloque] of abiertos) {
      if (clave !== null && c !== clave) continue;
      if (bloque.isConnected) pintarPanel(c, bloque);
      else cerrarAbierto(c);
    }
    if (visorFoto && visorRemoto && (clave === null || claveDestino(visorRemoto) === clave)) actualizarVisorRemoto();
    if (visorFoto) pintarNavegacionVisor();
  }
  function cerrarAbierto(clave: ClaveDestino) {
    const bloque = abiertos.get(clave);
    abiertos.delete(clave);
    const destino = destinoDeClave(plan, clave);
    if (destino) controlador.cerrarVisita(destino);
    // Cerrar el bloque cierra su consulta, corta su original en curso y revoca sus vistas temporales.
    if (bloque) {
      for (const b of bloque.querySelectorAll('[data-foto-remota]')) observador?.unobserve(b);
      const mas = bloque.querySelector('[data-remotas-mas]');
      if (mas) { paginasObservador?.unobserve(mas); paginasVisibles.delete(mas); }
    }
    if (destino) remotas?.cerrar(destino);
  }
  /** Solo lo que de verdad se ve pide su original: el observador avisa a la sesión de su destino. */
  const observador: IntersectionObserver | null = remotas && typeof IntersectionObserver === 'function'
    ? new IntersectionObserver((entradas) => {
      for (const e of entradas) {
        const celda = e.target as HTMLElement;
        const destino = destinoDeClave(plan, celda.closest<HTMLElement>('[data-fotos-destino]')?.dataset.fotosDestino ?? '');
        const id = celda.dataset.fotoRemota;
        if (destino && id) remotas.sesion(destino)?.visible(id, e.isIntersecting && celda.isConnected);
      }
    }) : null;
  if (remotas) {
    // En segundo plano se corta el original en curso; al salir de la página se sueltan todas las vistas temporales.
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden') remotas.suspender(); else if (politica.permitida) remotas.reanudar();
    });
    addEventListener('pagehide', () => { remotas.suspender(); remotas.soltarVistas(); });
    addEventListener('pageshow', () => { if (document.visibilityState !== 'hidden' && politica.permitida) remotas.reanudar(); });
  }

  // ----- Sitios que ya no están en el plan («Todo») -----
  function pintarRetiradas() {
    if (!retiradas) return;
    const c = retiradas.contenedor;
    if (!c.isConnected) { retiradas = null; return; }
    const destinos = controlador.fase === 'lista' ? controlador.destinosRetirados?.() ?? [] : [];
    const firma = destinos.map(claveDestino).join('|');
    if (firma === retiradas.firma) return;
    retiradas.firma = firma;
    const conFoco = document.activeElement instanceof HTMLElement && c.contains(document.activeElement);
    // Un bloque abierto que desaparece se cierra de verdad (consultas, vistas y URLs) antes de sustituir la sección.
    for (const [clave, bloque] of [...abiertos]) if (c.contains(bloque)) cerrarAbierto(clave);
    c.hidden = destinos.length === 0;
    c.innerHTML = destinos.length ? `<h3 tabindex="-1">Sitios que ya no están en el plan</h3>
      <p class="cifras">Fotos de este móvil de paradas o sitios que ya no están en el plan. Siguen guardadas aquí y se ven como siempre; no se pueden añadir nuevas.</p>
      <ul class="lista-retiradas">${destinos.map((d) => `<li><p class="retirada-nombre">${escapar(nombreDe(d))}</p>${html(d)}</li>`).join('')}</ul>` : '';
    if (conFoco) c.querySelector<HTMLElement>('h3')?.focus();
  }

  // ----- Bloque y panel -----
  function html(destino: DestinoFoto, prefijo = ''): string {
    const clave = claveDestino(destino);
    const id = `${prefijo}fotos-${clave.replace(/:/g, '-')}`;
    return `<div class="fotos" data-fotos-destino="${escapar(clave)}">
      <button type="button" class="mini fotos-alternar" data-fotos-alternar aria-expanded="false" aria-controls="${escapar(id)}">${ICONO_CAMARA}Fotos<span class="fotos-cuenta"></span><span class="sr"> de «${escapar(nombreDe(destino))}»</span></button>
      <div class="fotos-panel" id="${escapar(id)}" hidden></div>
    </div>`;
  }
  function pintarCuentas() {
    for (const bloque of contenido.querySelectorAll<HTMLElement>('[data-fotos-destino]')) {
      const destino = destinoDeClave(plan, bloque.dataset.fotosDestino ?? '');
      const cuenta = bloque.querySelector('.fotos-cuenta');
      if (!destino || !cuenta) continue;
      const n = controlador.fase === 'lista' ? controlador.cuenta(destino) : 0;
      const texto = n ? ` · ${n} en este móvil` : '';
      if (cuenta.textContent !== texto) cuenta.textContent = texto;
    }
  }
  /** Esqueleto estable (la línea de estado es una región viva que no se sustituye) y partes que cambian. */
  function pintarPanel(clave: ClaveDestino, bloque: HTMLElement) {
    const panel = bloque.querySelector<HTMLElement>('.fotos-panel');
    const destino = destinoDeClave(plan, clave);
    if (!panel || !destino) return;
    let estado = panel.querySelector<HTMLElement>('.fotos-estado');
    if (!estado) {
      estado = elemento('p', 'fotos-estado');
      estado.setAttribute('role', 'status');
      const lista = elemento('ul', 'fotos-lista');
      const sesion = elemento('ul', 'fotos-sesiones');
      const vacio = elemento('p', 'fotos-vacio');
      const error = elemento('div', 'fotos-error');
      const acciones = elemento('div', 'acciones-bloque fotos-acciones');
      // Las dos abren el mismo selector de archivos: «Tomar foto» con la pista de cámara trasera y la galería sin ella.
      const camara = boton('', 'mini', { 'fotos-camara': '' });
      camara.insertAdjacentHTML('afterbegin', ICONO_CAMARA);
      camara.append('Tomar foto');
      acciones.append(camara, boton('Elegir de la galería', 'mini', { 'fotos-anadir': '' }));
      // Compartidas (solo con composición): junto a las de este móvil, con su propia línea de estado estable.
      const compartidas = remotas ? [esqueletoRemotas()] : [];
      const rejilla = elemento('div', 'fotos-rejilla');
      rejilla.append(lista);
      if (remotas) rejilla.append(elemento('ul', 'fotos-lista fotos-remotas-lista'));
      panel.replaceChildren(acciones, estado, error, rejilla, sesion, vacio, ...compartidas,
        elemento('p', 'cifras fotos-nota', respaldo ? NOTA_RESPALDO : NOTA));
    }
    const foco = document.activeElement instanceof HTMLElement && panel.contains(document.activeElement) ? document.activeElement : null;
    const huella = (e: Element) => ['data-foto-id', 'data-foto-reintentar', 'data-foto-descartar', 'data-fotos-camara', 'data-fotos-anadir', 'data-fotos-reabrir',
      'data-foto-remota', 'data-remotas-mas', 'data-remotas-reintentar']
      .map((a) => `${a}=${e.getAttribute(a)}`).join('|');
    const buscada = foco ? huella(foco) : '';

    const lista = panel.querySelector<HTMLElement>('.fotos-lista')!;
    const sesion = panel.querySelector<HTMLElement>('.fotos-sesiones')!;
    const vacio = panel.querySelector<HTMLElement>('.fotos-vacio')!;
    const error = panel.querySelector<HTMLElement>('.fotos-error')!;
    const anadir = panel.querySelector<HTMLButtonElement>('[data-fotos-anadir]')!;
    const nombre = nombreDe(destino);
    const fase = controlador.fase;
    // Un sitio que ya no está en el plan conserva sus fotos (visor, original, borrar) pero no admite nuevas.
    const activo = esDestinoActivo(plan, destino);
    // Sin base abierta no hay nada que añadir: la acción no aparece (ni engaña con un botón muerto).
    const acciones = panel.querySelector<HTMLElement>('.fotos-acciones')!;
    acciones.hidden = fase !== 'lista' || !activo;
    const nota = panel.querySelector<HTMLElement>('.fotos-nota')!;
    const textoNota = activo ? (respaldo ? NOTA_RESPALDO : NOTA) : NOTA_RETIRADA;
    if (nota.textContent !== textoNota) nota.textContent = textoNota;
    panel.querySelector('[data-fotos-camara]')!.setAttribute('aria-label', `Tomar foto para «${nombre}»`);
    anadir.setAttribute('aria-label', `Elegir de la galería una foto para «${nombre}»`);

    error.replaceChildren();
    error.hidden = fase !== 'fallo';
    if (fase === 'fallo') {
      error.append(elemento('p', '', controlador.error ?? 'No se pudieron abrir las fotos de este móvil.'),
        boton('Reintentar', 'boton', { 'fotos-reabrir': '' }));
    }
    const entradas = fase === 'lista' ? controlador.entradas(destino) : [];
    const guardadas = entradas.filter((e) => !['guardando', 'no-guardada', 'incierta'].includes(e.estado));
    const intentos = entradas.filter((e) => ['guardando', 'no-guardada', 'incierta'].includes(e.estado));

    lista.replaceChildren(...guardadas.map((e) => {
      const li = elemento('li', 'foto');
      const b = boton('', 'foto-abrir', { 'foto-id': e.fotoId });
      b.setAttribute('aria-label', `Foto «${e.nombre}», ${peso(e.bytesOriginal)}: ${TEXTO_ESTADO[e.estado].toLowerCase()}. Abrir.`);
      const vista = elemento('span', 'foto-vista');
      if (e.url) {
        const img = elemento('img');
        img.alt = '';
        img.decoding = 'async';
        // Una vista previa ilegible no se borra: se dice que no hay vista previa.
        img.addEventListener('error', () => { vista.replaceChildren(elemento('span', 'foto-texto', 'Sin vista previa')); }, { once: true });
        img.src = e.url;
        vista.append(img);
      } else {
        vista.append(elemento('span', 'foto-texto', e.estado === 'guardada' ? 'Vista previa' : TEXTO_ESTADO[e.estado]));
      }
      b.append(vista);
      if (respaldo) {
        const estado = respaldo.estado(e.fotoId)?.tipo;
        const situacion = estado === 'respaldada' ? 'Compartida' : estado === 'enviando' ? 'Subiendo…'
          : estado === 'sin-confirmar' ? 'Sin confirmar' : estado === 'pausado' ? 'En pausa'
            : estado === 'bloqueada' || estado === 'ilegible' ? 'Revisar' : 'En este móvil';
        b.append(elemento('span', 'foto-situacion', situacion));
      }
      li.append(b);
      return li;
    }));
    sesion.replaceChildren(...intentos.map((e) => {
      const li = elemento('li', 'foto-sesion');
      li.append(elemento('span', '', `«${e.nombre}» · ${TEXTO_ESTADO[e.estado]}${e.motivo ? `: ${e.motivo}` : ''}`));
      if (e.estado !== 'guardando') {
        const reintentar = boton('Reintentar', 'mini', { 'foto-reintentar': e.intento ?? e.fotoId });
        reintentar.setAttribute('aria-label', `Reintentar guardar «${e.nombre}»`);
        const descartar = boton('Descartar', 'mini suave', { 'foto-descartar': e.intento ?? e.fotoId });
        descartar.setAttribute('aria-label', `Descartar «${e.nombre}» sin guardar`);
        li.append(reintentar, descartar);
      }
      return li;
    }));
    vacio.hidden = fase !== 'lista' || entradas.length > 0;
    vacio.textContent = `Aún no hay fotos de «${nombre}» en este móvil.`;

    const sinAnotar = entradas.some((e) => e.estado === 'vista-sin-anotar');
    const texto = fase === 'abriendo' || fase === 'cerrada' ? 'Abriendo las fotos de este móvil…'
      : fase !== 'lista' ? ''
        : [mensajes.get(clave) ?? '', sinAnotar ? 'Una vista previa falló y no se pudo anotar: se volverá a intentar al abrir otra vez la app.' : '']
          .filter(Boolean).join(' ');
    if (estado.textContent !== texto) estado.textContent = texto;
    pintarRemotas(destino, panel);

    if (foco && !foco.isConnected) {
      const igual = [...panel.querySelectorAll<HTMLElement>('button, a')].find((b) => huella(b) === buscada);
      // «Ver más» que ya no hace falta: el foco pasa a la última compartida, si la hay.
      const ultima = [...panel.querySelectorAll<HTMLElement>('[data-foto-remota]')].pop();
      const resguardo = activo ? anadir : bloque.querySelector<HTMLElement>('[data-fotos-alternar]');
      (igual ?? (foco.hasAttribute('data-remotas-mas') ? ultima : undefined) ?? resguardo)?.focus();
    }
  }

  // ----- Compartidas de este destino (solo con composición) -----
  function esqueletoRemotas(): HTMLElement {
    const caja = elemento('div', 'fotos-remotas');
    caja.hidden = true;
    const linea = elemento('p', 'fotos-remotas-estado');
    linea.setAttribute('role', 'status');
    caja.append(linea,
      elemento('div', 'acciones-bloque fotos-remotas-acciones'));
    return caja;
  }
  const firmaVista = (v: VistaRemota) => (v.tipo === 'lista' ? `lista:${v.url}` : v.tipo);
  const ESTADO_CELDA: Record<VistaRemota['tipo'], string> = { 'pendiente': 'sin cargar', 'en-cola': 'en espera',
    'cargando': 'cargando', 'lista': 'vista temporal', 'sin-vista': 'sin vista segura', 'fallida': 'no se pudo cargar',
    'sin-hueco': 'sin hueco para su vista temporal' };
  /** Una celda por referencia, reutilizada mientras exista (foco y observador estables); solo cambia su vista. */
  function pintarCeldaRemota(li: HTMLElement, f: FotoRemota) {
    const b = li.querySelector<HTMLElement>('[data-foto-remota]')!;
    const nombre = f.original.nombre;
    b.setAttribute('aria-label', `Foto compartida «${nombre}», ${peso(f.original.bytesOriginal)}: ${ESTADO_CELDA[f.vista.tipo]}. Abrir.`);
    const firma = firmaVista(f.vista);
    if (b.dataset.firma === firma) return;
    b.dataset.firma = firma;
    const vista = elemento('span', 'foto-vista');
    if (f.vista.tipo === 'lista') {
      const img = elemento('img');
      img.alt = '';
      img.decoding = 'async';
      img.addEventListener('error', () => { vista.replaceChildren(elemento('span', 'foto-texto', 'Sin vista segura')); }, { once: true });
      img.src = f.vista.url;
      vista.append(img);
    } else vista.append(elemento('span', 'foto-texto', textoCeldaRemota(f.vista)));
    b.replaceChildren(vista, elemento('span', 'foto-situacion', 'Compartida'));
  }
  function pintarRemotas(destino: DestinoFoto, panel: HTMLElement) {
    const caja = panel.querySelector<HTMLElement>('.fotos-remotas');
    if (!caja || !remotas) return;
    if (!politica.permitida) {
      caja.hidden = false;
      const linea = caja.querySelector<HTMLElement>('.fotos-remotas-estado')!;
      linea.textContent = 'Ahorro de datos: las fotos compartidas están pausadas. Tus fotos siguen aquí. Permitirlas puede consumir datos móviles (hasta 8 MB por foto); el permiso termina al ocultar o salir de la app. No podemos detectar wifi.';
      panel.querySelector('.fotos-remotas-lista')?.replaceChildren();
      caja.querySelector<HTMLElement>('.fotos-remotas-acciones')!.dataset.firma = 'ahorro';
      caja.querySelector('.fotos-remotas-acciones')!.replaceChildren(boton('Permitir fotos durante esta visita', 'boton', { 'datos-permitir': '' }));
      return;
    }
    const s = remotas.sesion(destino);
    // Hasta que la sesión exista (se abre tras las fotos de este móvil, para no duplicar), no se enseña nada.
    caja.hidden = !s;
    if (!s) return;
    const linea = caja.querySelector<HTMLElement>('.fotos-remotas-estado')!;
    const lista = panel.querySelector<HTMLElement>('.fotos-remotas-lista')!;
    const acciones = caja.querySelector<HTMLElement>('.fotos-remotas-acciones')!;
    const fotos = s.fotos;
    const texto = textoEstadoRemotas(s.estado, fotos.length, nombreDe(destino));
    if (linea.textContent !== texto) linea.textContent = texto;
    const previas = new Map([...lista.querySelectorAll<HTMLElement>(':scope > li')].map((li) => [li.dataset.remota ?? '', li]));
    const filas = fotos.map((f) => {
      let li = previas.get(f.original.fotoId);
      previas.delete(f.original.fotoId);
      if (!li) {
        li = elemento('li', 'foto foto-remota');
        li.dataset.remota = f.original.fotoId;
        li.append(boton('', 'foto-abrir', { 'foto-remota': f.original.fotoId }));
      }
      pintarCeldaRemota(li, f);
      return li;
    });
    for (const li of previas.values()) {
      const b = li.querySelector('[data-foto-remota]');
      if (b) observador?.unobserve(b);
    }
    if (filas.length !== lista.children.length || filas.some((li, i) => lista.children[i] !== li)) lista.replaceChildren(...filas);
    for (const li of filas) {
      const b = li.querySelector<HTMLElement>('[data-foto-remota]')!;
      if (b.dataset.observada) continue;
      b.dataset.observada = '1';
      // Sin observador no se sabe qué se ve: ningún original se pide solo (falla cerrado). Tocar la celda abre su
      // visor, que pide ESA foto.
      observador?.observe(b);
    }
    const botones: HTMLElement[] = [];
    const e = s.estado;
    if ((e.tipo === 'lista' && e.hayMas) || (e.tipo === 'consultando' && e.mas)) botones.push(boton('Cargar más fotos', 'mini', { 'remotas-mas': '' }));
    else if (e.tipo === 'sin-conexion' || (e.tipo === 'fallo' && e.motivo !== 'sin-sesion')) {
      botones.push(boton('Reintentar', 'mini', { 'remotas-reintentar': '' }));
    } else if (e.tipo === 'fallo' && e.motivo === 'sin-sesion' && enLinea()) {
      // Solo un enlace: la navegación es de quien lo toca, nunca una redirección sola.
      const a = elemento('a', 'mini', 'Entrar');
      a.href = '/entrar';
      botones.push(a);
    }
    const firma = botones.map((b) => b.outerHTML).join('');
    if (acciones.dataset.firma !== firma) { acciones.dataset.firma = firma; acciones.replaceChildren(...botones); }
    const mas = acciones.querySelector('[data-remotas-mas]');
    if (mas) paginasObservador?.observe(mas);
  }
  let albumObservador: IntersectionObserver | null = null;
  const paginando = new Set<string>();
  const paginasVisibles = new WeakSet<Element>();
  async function cargarPaginas(d: DestinoFoto, explicito = false) {
    const clave = claveDestino(d);
    if (!redPermitida() || visorFoto || paginando.has(clave)) return;
    const sesion = remotas?.sesion(d);
    const bloque = abiertos.get(clave);
    const mas = bloque?.querySelector<HTMLElement>('[data-remotas-mas]');
    if (!sesion || !mas || sesion.estado.tipo !== 'lista' || !sesion.estado.hayMas) return;
    const seguir = () => redPermitida() && !visorFoto && abiertos.get(clave) === bloque
      && remotas?.sesion(d) === sesion && mas.isConnected && !mas.closest('[hidden], [inert]')
      && (paginasVisibles.has(mas) || (explicito && mas.getBoundingClientRect().bottom > 0
        && mas.getBoundingClientRect().top < innerHeight));
    if (!seguir()) return;
    paginando.add(clave);
    try { await sesion.cargarSiguientes(seguir); }
    finally {
      paginando.delete(clave);
      paginasObservador?.unobserve(mas);
      paginasVisibles.delete(mas);
      // Cada tramo cede al navegador y vuelve a comprobar la intersección. Avanzar el cursor también es progreso
      // cuando todas las páginas eran copias locales; no exige otro toque ni eleva el límite del tramo.
      requestAnimationFrame(() => {
        const siguiente = abiertos.get(clave)?.querySelector('[data-remotas-mas]');
        if (redPermitida() && abiertos.get(clave) === bloque && siguiente) paginasObservador?.observe(siguiente);
      });
    }
  }
  const paginasObservador = typeof IntersectionObserver === 'function' ? new IntersectionObserver((entradas) => {
    for (const e of entradas) {
      if (e.isIntersecting) paginasVisibles.add(e.target); else paginasVisibles.delete(e.target);
      const d = destinoDeClave(plan, (e.target as HTMLElement).closest<HTMLElement>('[data-fotos-destino]')?.dataset.fotosDestino ?? '');
      if (e.isIntersecting && d && politica.permitida) void cargarPaginas(d);
    }
  }) : null;
  const enLinea = () => typeof navigator === 'undefined' || navigator.onLine !== false;

  async function alternar(bloque: HTMLElement) {
    const clave = bloque.dataset.fotosDestino ?? '';
    const destino = destinoDeClave(plan, clave);
    const control = bloque.querySelector<HTMLElement>('[data-fotos-alternar]');
    const panel = bloque.querySelector<HTMLElement>('.fotos-panel');
    if (!destino || !control || !panel) return;
    const abrir = control.getAttribute('aria-expanded') !== 'true';
    if (!abrir) { plegarBloque(bloque); return; }
    control.setAttribute('aria-expanded', 'true');
    panel.hidden = false;
    abiertos.set(clave, bloque);
    pintarPanel(clave, bloque);
    // La visita existe ya: si la base aún abre, el controlador la carga al terminar.
    controlador.abrirVisita(destino);
    // Tras un fallo no se reintenta solo: se ve el error y el reintento es del usuario.
    if (controlador.fase === 'cerrada' || controlador.fase === 'abriendo') await controlador.abrir();
    if (abiertos.get(clave) !== bloque) return;
    // Compartidas de ESTE destino, una vez abiertas las de este móvil (así no se repite lo que ya está aquí).
    if (politica.permitida) remotas?.abrir(destino);
    pintarPanel(clave, bloque);
  }

  /** Pliega un bloque abierto: cierra su visita y sus compartidas (consultas y originales cortados, vistas y URLs
   * soltadas) y vacía su panel. Las fotos de este móvil siguen guardadas. */
  function plegarBloque(bloque: HTMLElement) {
    const control = bloque.querySelector<HTMLElement>('[data-fotos-alternar]');
    const panel = bloque.querySelector<HTMLElement>('.fotos-panel');
    control?.setAttribute('aria-expanded', 'false');
    if (panel) panel.hidden = true;
    cerrarAbierto(bloque.dataset.fotosDestino ?? '');
    panel?.replaceChildren();
  }

  // ----- Selector de archivo: el destino se fija al abrirlo -----
  let entrada: HTMLInputElement | undefined;
  let intento: { readonly destino: DestinoFoto; readonly clave: ClaveDestino; usado: boolean } | null = null;
  function selector(): HTMLInputElement {
    if (entrada) return entrada;
    const input = elemento('input');
    input.type = 'file';
    // Pista para el navegador, no una promesa de cámara ni galería.
    input.accept = 'image/*';
    input.hidden = true;
    input.tabIndex = -1;
    input.setAttribute('aria-hidden', 'true');
    input.addEventListener('change', () => {
      const actual = intento;
      intento = null;
      const archivo = input.files?.[0] ?? null;
      input.value = ''; // Permite elegir el mismo archivo otra vez (un intento nuevo).
      if (!actual || actual.usado || !archivo) return;
      actual.usado = true;
      void guardarDesdeUi(actual.destino, actual.clave, archivo);
    });
    input.addEventListener('cancel', () => { intento = null; input.value = ''; });
    document.body.append(input);
    entrada = input;
    return input;
  }
  async function guardarDesdeUi(destino: DestinoFoto, clave: ClaveDestino, archivo: File) {
    if (controlador.fase !== 'lista') await controlador.abrir();
    mensajes.set(clave, 'Guardando…');
    alCambiar(clave);
    let r: ResultadoGuardar;
    try { r = await controlador.guardar(destino, archivo); } catch { r = { tipo: 'no-guardada', fotoId: '', intento: '', motivo: NO_GUARDADA }; }
    const texto = r.tipo === 'guardada' ? 'Guardada en este móvil.'
      : r.tipo === 'no-lista' ? 'No se ha guardado: las fotos de este móvil no están abiertas.'
        : `No se ha guardado: ${r.motivo} Puedes reintentarlo.`;
    mensajes.set(clave, texto);
    // Con el panel abierto ya lo dice su línea de estado (región viva); si se cerró, un aviso.
    if (!abiertos.has(clave)) anunciar(texto);
    alCambiar(clave);
    if (r.tipo === 'guardada') void subirAutomaticamente();
  }
  function elegir(bloque: HTMLElement, origen: 'camara' | 'galeria') {
    const clave = bloque.dataset.fotosDestino ?? '';
    const destino = destinoDeClave(plan, clave);
    // Fotos nuevas solo en destinos del plan actual: uno retirado no tiene «Tomar foto» ni galería.
    if (!destino || !esDestinoActivo(plan, destino)) return;
    if (controlador.fase === 'cerrada') void controlador.abrir();
    const input = selector();
    intento = { destino, clave, usado: false };
    input.value = '';
    // Pista de cámara trasera solo para «Tomar foto»: la galería nunca la hereda de la vez anterior.
    if (origen === 'camara') input.setAttribute('capture', 'environment');
    else input.removeAttribute('capture');
    input.click();
  }

  async function reintentarGuardar(b: HTMLElement, clave: ClaveDestino, id: string) {
    if (b.getAttribute('aria-disabled') === 'true') return;
    b.setAttribute('aria-disabled', 'true');
    const r = await controlador.reintentarGuardar(id);
    const texto = r.tipo === 'guardada' ? 'Guardada en este móvil.'
      : r.tipo === 'no-lista' ? '' : `No se ha guardado: ${r.motivo} Puedes reintentarlo.`;
    if (texto) mensajes.set(clave, texto);
    alCambiar(clave);
  }

  // ----- Visor -----
  let visor: HTMLElement | undefined;
  let visorFoto: string | null = null;
  let abridor: HTMLElement | null = null;
  let genVisor = 0;
  let urlsVisor: string[] = [];
  let historial = false;
  const inertesAntes = new Map<HTMLElement, boolean>();
  function datosFoto(id: string): { entrada: EntradaFoto; destino: DestinoFoto; bloque: HTMLElement | undefined } | null {
    for (const [clave, bloque] of abiertos) {
      const destino = destinoDeClave(plan, clave);
      const e = destino && controlador.entradas(destino).find((x) => x.fotoId === id);
      if (destino && e) return { entrada: e, destino, bloque };
    }
    return null;
  }
  function crearVisor(): HTMLElement {
    const v = elemento('div', 'visor-foto papel');
    v.id = 'visor-foto';
    v.setAttribute('role', 'dialog');
    v.setAttribute('aria-modal', 'true');
    v.setAttribute('aria-labelledby', 'visor-foto-titulo');
    v.hidden = true;
    v.addEventListener('click', (e) => { void clicVisor(e.target as Element); });
    v.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') { e.preventDefault(); moverVisor(e.key === 'ArrowLeft' ? -1 : 1); }
    });
    let inicio: { x: number; y: number } | null = null;
    v.addEventListener('touchstart', (e) => {
      const t = e.touches[0]; inicio = e.touches.length === 1 && t ? { x: t.clientX, y: t.clientY } : null;
    }, { passive: true });
    v.addEventListener('touchend', (e) => {
      const t = e.changedTouches[0];
      if (inicio && t) {
        const dx = t.clientX - inicio.x; const dy = t.clientY - inicio.y;
        if (Math.abs(dx) > 64 && Math.abs(dx) > Math.abs(dy) * 2) moverVisor(dx < 0 ? 1 : -1);
      }
      inicio = null;
    }, { passive: true });
    document.body.append(v);
    return v;
  }
  function soltarVisor() {
    for (const u of urlsVisor) controlador.soltarUrl(u);
    urlsVisor = [];
  }
  function pintarVisor(id: string) {
    const datos = datosFoto(id);
    if (!visor || !datos) return;
    const { entrada: e, destino } = datos;
    const cabecera = elemento('div', 'visor-cabecera');
    const titulo = elemento('h2', '', `Foto de «${nombreDe(destino)}»`);
    titulo.id = 'visor-foto-titulo';
    const nombre = elemento('p', 'visor-nombre', e.nombre);
    nombre.id = 'visor-foto-nombre';
    const cerrar = boton('', 'visor-cerrar', { 'visor-cerrar': '' });
    cerrar.setAttribute('aria-label', 'Cerrar la foto');
    cerrar.insertAdjacentHTML('afterbegin', ICONO_CERRAR);
    cabecera.append(titulo, nombre, cerrar);
    const imagen = elemento('div', 'visor-imagen');
    imagen.append(elemento('p', 'visor-texto', e.estado === 'generando' ? 'Preparando la vista previa…' : TEXTO_ESTADO[e.estado]));
    const pesos = elemento('p', 'visor-pesos',
      `Original ${peso(e.bytesOriginal)}${e.bytesMiniatura !== null ? ` · vista previa ${peso(e.bytesMiniatura)}` : ''}`);
    const avisoVisor = elemento('p', 'visor-aviso');
    avisoVisor.setAttribute('role', 'status');
    const acciones = elemento('div', 'visor-acciones');
    acciones.append(boton('Ver original', 'boton', { 'visor-original': '' }), boton('Descargar original', 'boton', { 'visor-descargar': '' }));
    if (e.estado === 'sin-vista' || e.estado === 'vista-sin-anotar') acciones.append(boton('Reintentar vista previa', 'boton', { 'visor-reintentar': '' }));
    acciones.append(boton('Borrar de este móvil', 'boton', { 'visor-borrar': '' }));
    const confirmar = elemento('div', 'visor-confirmar');
    confirmar.hidden = true;
    confirmar.append(elemento('p', 'visor-confirmar-texto', CONFIRMAR_BORRADO),
      boton('Cancelar', 'boton', { 'visor-cancelar': '' }), boton('Borrar', 'boton tinta', { 'visor-confirmar': '' }));
    const pie = elemento('div', 'visor-pie');
    pie.append(pesos, avisoVisor);
    if (respaldo) {
      // Solo con composición: estado durable del ledger de ESTA foto y sus acciones manuales. Abrir no envía nada.
      const bloque = elemento('div', 'visor-respaldo');
      const accionesRespaldo = elemento('div', 'visor-respaldo-acciones');
      accionesRespaldo.hidden = true;
      bloque.append(elemento('p', 'visor-respaldo-nota', 'Comprobando el respaldo en este móvil…'), accionesRespaldo);
      pie.append(bloque);
    }
    pie.append(acciones, confirmar);
    visor.replaceChildren(cabecera, imagen, pie);
  }
  /** Línea y botones del respaldo según lo durable; solo se sustituyen los botones si cambian (el foco no salta). */
  function pintarRespaldo(id: string, estado: EstadoRespaldo | null) {
    const bloque = visor?.querySelector<HTMLElement>('.visor-respaldo');
    const datos = datosFoto(id);
    if (!visor || !bloque || !datos || visorFoto !== id) return;
    const nota = bloque.querySelector<HTMLElement>('.visor-respaldo-nota');
    const acciones = bloque.querySelector<HTMLElement>('.visor-respaldo-acciones');
    if (!nota || !acciones) return;
    const texto = estado ? textoEstadoRespaldo(estado) : 'Comprobando el respaldo en este móvil…';
    if (nota.textContent !== texto) nota.textContent = texto;
    const nombre = datos.entrada.nombre;
    const botones: HTMLButtonElement[] = [];
    const tipo = estado?.tipo;
    if (tipo === 'sin-respaldo' || tipo === 'preparado') {
      const b = boton(`Respaldar (${peso(datos.entrada.bytesOriginal)})`, 'boton', { 'visor-respaldar': '' });
      b.setAttribute('aria-label', `Respaldar «${nombre}» en el servidor del viaje (${peso(datos.entrada.bytesOriginal)})`);
      botones.push(b);
    } else if (tipo === 'enviando') {
      botones.push(boton('Pausar el respaldo', 'boton', { 'visor-pausar': '' }));
    } else if (tipo === 'sin-confirmar' || tipo === 'pausado') {
      // Misma operación: reintentar nunca prepara otra y quita la pausa si la hay.
      botones.push(boton(tipo === 'pausado' ? 'Reanudar el respaldo' : 'Reintentar el respaldo', 'boton', { 'visor-reanudar': '' }));
    }
    const firma = botones.map((b) => `${b.textContent}|${b.getAttributeNames().join(',')}`).join(';');
    if (acciones.dataset.firma === firma) return;
    const foco = document.activeElement instanceof HTMLElement && acciones.contains(document.activeElement);
    acciones.dataset.firma = firma;
    acciones.replaceChildren(...botones);
    acciones.hidden = botones.length === 0;
    // El botón pulsado cambia (Respaldar → Pausar → ninguno): el foco pasa al nuevo o, si no hay, a «Ver original».
    if (foco) (botones[0] ?? visor.querySelector<HTMLElement>('.visor-acciones button'))?.focus();
  }
  function cargarRespaldo(id: string) {
    if (!respaldo) return;
    const gen = genVisor;
    void respaldo.leer(id).then((estado) => {
      if (gen === genVisor && visorFoto === id) pintarRespaldo(id, estado);
    }, () => {
      if (gen === genVisor && visorFoto === id) pintarRespaldo(id, { tipo: 'ilegible' });
    });
  }
  function mostrarEnVisor(url: string, alt: string) {
    const imagen = visor?.querySelector('.visor-imagen');
    if (!imagen) return;
    const img = elemento('img');
    img.alt = alt;
    img.addEventListener('error', () => {
      imagen.replaceChildren(elemento('p', 'visor-texto', 'No se pudo mostrar; la foto sigue guardada.'));
      controlador.soltarUrl(url);
      urlsVisor = urlsVisor.filter((u) => u !== url);
    }, { once: true });
    img.src = url;
    imagen.replaceChildren(img);
  }
  function avisoVisor(texto: string) {
    const a = visor?.querySelector('.visor-aviso');
    if (a) a.textContent = texto;
  }
  /** Repinta el estado del visor sin perder la imagen (p. ej. cuando termina la vista previa). */
  function actualizarVisor() {
    if (!visorFoto || !visor || visorRemoto) return;
    const datos = datosFoto(visorFoto);
    if (!datos) return;
    const texto = visor.querySelector('.visor-texto');
    if (texto && !visor.querySelector('.visor-imagen img')) texto.textContent = TEXTO_ESTADO[datos.entrada.estado];
  }
  /** Pantalla completa como la tarjeta del taxista: el resto inerte, una entrada de historial y el foco en ✕. */
  function mostrarVisor() {
    if (!visor) return;
    visor.hidden = false;
    for (const n of document.body.children) if (n !== visor && n.tagName !== 'SCRIPT') {
      if (!historial) inertesAntes.set(n as HTMLElement, (n as HTMLElement).inert);
      (n as HTMLElement).inert = true;
    }
    if (!historial) history.pushState({ visorFoto: true }, '');
    historial = true;
    pintarNavegacionVisor();
    visor.querySelector<HTMLElement>('[data-visor-cerrar]')?.focus();
  }
  async function abrirVisor(id: string, origen: HTMLElement) {
    if (!datosFoto(id)) return;
    visor ??= crearVisor();
    soltarVisor();
    soltarRemotaDelVisor();
    const gen = ++genVisor;
    visorFoto = id;
    abridor = origen;
    pintarVisor(id);
    mostrarVisor();
    // Solo el ledger local (0 red): abrir el visor nunca envía, consulta ni reintenta nada.
    cargarRespaldo(id);
    const url = await controlador.verMiniatura(id);
    if (!url) return;
    if (gen !== genVisor) { controlador.soltarUrl(url); return; }
    urlsVisor.push(url);
    mostrarEnVisor(url, `Vista previa de «${datosFoto(id)?.entrada.nombre ?? ''}»`);
  }
  /** Si ya no existe lo que abrió el visor ni su foto (se borró la última de un sitio retirado y con ella su fila o
   * la sección entera): el título visible de la sección de sitios retirados o, si tampoco está, el de quien compone. */
  function fotosVisor(): HTMLElement[] {
    const destino = visorRemoto ?? (visorFoto ? datosFoto(visorFoto)?.destino : null);
    const bloque = destino ? abiertos.get(claveDestino(destino)) : abridor?.closest('[data-fotos-destino]');
    return bloque ? [...bloque.querySelectorAll<HTMLElement>('[data-foto-id], [data-foto-remota]')] : [];
  }
  function pintarNavegacionVisor() {
    if (!visor) return;
    visor.querySelector('.visor-navegacion')?.remove();
    const fotos = fotosVisor();
    const i = fotos.findIndex((b) => (b.dataset.fotoId ?? b.dataset.fotoRemota) === visorFoto);
    const n = elemento('nav', 'visor-navegacion'); n.setAttribute('aria-label', 'Recorrer fotos');
    const anterior = boton('Anterior', 'boton', { 'visor-paso': '-1' }); anterior.disabled = i <= 0;
    const siguiente = boton('Siguiente', 'boton', { 'visor-paso': '1' }); siguiente.disabled = i < 0 || i >= fotos.length - 1;
    n.append(anterior, elemento('span', '', `${i + 1} de ${fotos.length} cargadas`), siguiente);
    visor.querySelector('.visor-cabecera')?.append(n);
  }
  function moverVisor(paso: number) {
    const fotos = fotosVisor();
    const i = fotos.findIndex((b) => (b.dataset.fotoId ?? b.dataset.fotoRemota) === visorFoto);
    const siguiente = fotos[i + paso];
    if (!siguiente) return;
    const d = destinoDeClave(plan, siguiente.closest<HTMLElement>('[data-fotos-destino]')?.dataset.fotosDestino ?? '');
    if (siguiente.dataset.fotoId) void abrirVisor(siguiente.dataset.fotoId, siguiente);
    else if (d && siguiente.dataset.fotoRemota && politica.permitida) {
      const sesion = remotas?.sesion(d); if (sesion) abrirVisorRemoto(sesion, siguiente.dataset.fotoRemota, siguiente);
    }
  }
  function refugioFoco(): HTMLElement | null {
    const c = retiradas?.contenedor;
    const titulo = c && c.isConnected && !c.hidden ? c.querySelector<HTMLElement>('h3') : null;
    return titulo ?? opciones.focoDeReserva?.() ?? null;
  }
  function cerrarVisor(desdeHistorial = false): boolean {
    if (!visor || visor.hidden) return false;
    genVisor++;
    visor.hidden = true;
    visor.replaceChildren();
    soltarVisor();
    const id = visorFoto;
    const guardada = guardadaRemota !== null && guardadaRemota === id ? visorRemoto : null;
    soltarRemotaDelVisor();
    visorFoto = null;
    for (const [n, antes] of inertesAntes) n.inert = antes;
    inertesAntes.clear();
    if (historial && !desdeHistorial && history.state?.visorFoto) history.back();
    historial = false;
    // Si la miniatura se repintó mientras tanto, el foco vuelve a la misma foto. Una compartida recién guardada
    // ya es de este móvil: el foco va a su celda local y la compartida deja de repetirse.
    const local = [...contenido.querySelectorAll<HTMLElement>('[data-foto-id]')].find((b) => b.dataset.fotoId === id) ?? null;
    const destino = guardada && local ? local : abridor?.isConnected ? abridor : local ?? refugioFoco();
    abridor = null;
    destino?.focus({ preventScroll: true });
    if (guardada && id) void remotas?.sesion(guardada)?.reclasificar(id);
    for (const bloque of abiertos.values()) {
      const mas = bloque.querySelector('[data-remotas-mas]');
      if (mas) { paginasObservador?.unobserve(mas); paginasObservador?.observe(mas); }
    }
    return true;
  }

  // ----- Visor de una compartida: vista temporal y «Guardar sin conexión» como acción aparte -----
  let visorRemoto: DestinoFoto | null = null;
  /** Guardada sin conexión desde ESTE visor: se reclasifica al cerrarlo (su vista sigue a la vista hasta entonces). */
  let guardadaRemota: string | null = null;
  /** Hay un «Guardar sin conexión» en curso (la descarga admite uno a la vez). */
  let guardandoRemota: string | null = null;
  /** Bytes de un guardado fallido de esta sesión, solo para descargarlos como archivo. */
  let archivoRemoto: string | null = null;
  /** Época de autorización de la interfaz: sube con cada sesión perdida, venga de donde venga. Un resultado que llega
   * después (p. ej. el de un «Guardar sin conexión» en curso) ya no deja archivo, botones ni estado de compartida. */
  let autorizacionUi = 0;
  /** Sesión perdida: fuera el archivo pendiente del visor y lo temporal del OTRO controlador (sin volver a avisar al
   * que la detectó: no hay eco), y el visor se repinta. Lo guardado en este móvil sigue. */
  function perderSesionUi(origen: 'respaldo' | 'remotas') {
    autorizacionUi++;
    archivoRemoto = null;
    if (origen === 'respaldo') remotas?.invalidarSesion();
    else respaldo?.invalidarSesion();
    actualizarVisorRemoto();
  }
  function soltarRemotaDelVisor() {
    if (visorRemoto) remotas?.sesion(visorRemoto)?.fijar(null);
    visorRemoto = null;
    guardadaRemota = null;
    archivoRemoto = null;
  }
  function remotaDelVisor(): { readonly sesion: SesionRemota; readonly foto: FotoRemota } | null {
    if (!visorRemoto || !visorFoto || !remotas) return null;
    const sesion = remotas.sesion(visorRemoto);
    const foto = sesion?.fotos.find((f) => f.original.fotoId === visorFoto);
    return sesion && foto ? { sesion, foto } : null;
  }
  function abrirVisorRemoto(sesion: SesionRemota, id: string, origen: HTMLElement) {
    const foto = sesion.fotos.find((f) => f.original.fotoId === id);
    if (!foto) return;
    visor ??= crearVisor();
    soltarVisor();
    soltarRemotaDelVisor();
    ++genVisor;
    visorFoto = id;
    visorRemoto = sesion.destino;
    abridor = origen;
    const cabecera = elemento('div', 'visor-cabecera');
    const titulo = elemento('h2', '', `Foto de «${nombreDe(sesion.destino)}»`);
    titulo.id = 'visor-foto-titulo';
    const nombre = elemento('p', 'visor-nombre', foto.original.nombre);
    nombre.id = 'visor-foto-nombre';
    const cerrar = boton('', 'visor-cerrar', { 'visor-cerrar': '' });
    cerrar.setAttribute('aria-label', 'Cerrar la foto');
    cerrar.insertAdjacentHTML('afterbegin', ICONO_CERRAR);
    cabecera.append(titulo, nombre, cerrar);
    const aviso = elemento('p', 'visor-aviso');
    aviso.setAttribute('role', 'status');
    const pie = elemento('div', 'visor-pie');
    pie.append(elemento('p', 'visor-pesos'), aviso, elemento('p', 'visor-remota-nota'), elemento('div', 'visor-acciones'));
    visor.replaceChildren(cabecera, elemento('div', 'visor-imagen'), pie);
    actualizarVisorRemoto();
    mostrarVisor();
    // Su vista temporal se pide (o se conserva) mientras el visor siga abierto. Abrirlo no guarda nada.
    sesion.fijar(id);
  }
  function textoGuardadoRemota(r: ResultadoGuardado): string {
    switch (r.tipo) {
      case 'guardada': return 'Guardada en este móvil: ya se puede ver sin conexión.';
      case 'comprobada': return 'Ya estaba en este móvil: es la misma foto.';
      case 'no-guardada':
        if (r.causa === 'sin-sesion') return 'Este móvil no tiene sesión en el servidor: no se ha guardado nada.';
        if (r.causa === 'plazo') return 'Tardó demasiado; no se ha guardado nada.';
        return r.captura
          ? 'No se pudo guardar en este móvil (puede faltar espacio). Puedes descargar el archivo: no queda en las fotos de este móvil.'
          : 'No se pudo guardar en este móvil; no se ha guardado nada.';
      case 'detenida': return 'Se detuvo; no se da nada por guardado.';
      case 'ocupada': return 'Ya se está guardando otra foto; espera a que termine.';
      case 'no-disponible': return 'No se pudo guardar ahora; no se da nada por guardado.';
    }
  }
  /** Imagen, pesos, nota y acciones según lo que la sesión sabe ahora; los botones solo se sustituyen si cambian. */
  function actualizarVisorRemoto() {
    if (!visor || !visorFoto || !visorRemoto) return;
    const imagen = visor.querySelector<HTMLElement>('.visor-imagen');
    const pesos = visor.querySelector<HTMLElement>('.visor-pesos');
    const nota = visor.querySelector<HTMLElement>('.visor-remota-nota');
    const acciones = visor.querySelector<HTMLElement>('.visor-acciones');
    if (!imagen || !pesos || !nota || !acciones) return;
    const id = visorFoto;
    const datos = remotaDelVisor();
    const botones: HTMLButtonElement[] = [];
    if (!datos) {
      // Sin sesión o consulta cerrada: fuera la vista temporal, sin copia de reserva.
      const sinSesion = remotas?.sesion(visorRemoto)?.estado;
      imagen.dataset.firma = 'ninguna';
      imagen.replaceChildren(elemento('p', 'visor-texto', sinSesion?.tipo === 'fallo' && sinSesion.motivo === 'sin-sesion'
        ? 'Este móvil no tiene sesión en el servidor: la foto compartida ya no se puede ver.'
        : 'Esta foto compartida ya no se puede ver aquí.'));
      pesos.textContent = '';
      nota.textContent = '';
    } else {
      const f = datos.foto;
      const firma = firmaVista(f.vista);
      if (imagen.dataset.firma !== firma) {
        imagen.dataset.firma = firma;
        if (f.vista.tipo === 'lista') {
          const img = elemento('img');
          img.alt = `Vista temporal de «${f.original.nombre}»`;
          img.addEventListener('error', () => {
            imagen.replaceChildren(elemento('p', 'visor-texto', 'No se pudo mostrar la vista temporal.'));
          }, { once: true });
          img.src = f.vista.url;
          imagen.replaceChildren(img);
        } else imagen.replaceChildren(elemento('p', 'visor-texto', textoVisorRemota(f.vista)));
      }
      pesos.textContent = `Original ${peso(f.original.bytesOriginal)}${f.vista.tipo === 'lista' ? ` · vista temporal ${peso(f.vista.bytes)}` : ''}`;
      nota.textContent = guardadaRemota === id ? 'Ya está en este móvil.' : textoLocalRemota(f.local) ?? NOTA_VISOR_REMOTA;
      if (guardadaRemota !== id) {
        if (guardandoRemota === id) botones.push(boton('Cancelar el guardado', 'boton', { 'visor-cancelar-remota': '' }));
        else if (f.local === 'ausente') {
          const b = boton(`Guardar sin conexión (${peso(f.original.bytesOriginal)})`, 'boton', { 'visor-guardar-remota': '' });
          b.setAttribute('aria-label', `Guardar «${f.original.nombre}» en este móvil para verla sin conexión (descarga ${peso(f.original.bytesOriginal)})`);
          botones.push(b);
        }
        if (f.vista.tipo === 'fallida' || f.vista.tipo === 'sin-hueco') {
          botones.push(boton('Reintentar la vista', 'boton', { 'visor-reintentar-remota': '' }));
        }
      }
    }
    if (archivoRemoto === id) botones.push(boton('Descargar archivo', 'boton', { 'visor-archivo-remota': '' }));
    const firma = botones.map((b) => b.outerHTML).join('');
    if (acciones.dataset.firma === firma) return;
    const foco = document.activeElement instanceof HTMLElement && acciones.contains(document.activeElement)
      ? document.activeElement.getAttributeNames().find((a) => a.startsWith('data-visor-')) ?? null : null;
    acciones.dataset.firma = firma;
    acciones.replaceChildren(...botones);
    acciones.hidden = botones.length === 0;
    // El botón pulsado cambia (Guardar → Cancelar → ninguno): el foco pasa al mismo, al primero o a ✕.
    if (foco) (acciones.querySelector<HTMLElement>(`[${foco}]`) ?? botones[0] ?? visor.querySelector<HTMLElement>('[data-visor-cerrar]'))?.focus();
  }
  async function guardarRemota() {
    if (!politica.permitida) return;
    const datos = remotaDelVisor();
    if (!datos || !respaldo || guardandoRemota) return;
    if (!enLinea()) { avisoVisor('Sin conexión: no se puede guardar ahora.'); return; }
    const { original } = datos.foto;
    const id = original.fotoId;
    const gen = genVisor;
    const epoca = autorizacionUi;
    guardandoRemota = id;
    avisoVisor('Guardando sin conexión…');
    actualizarVisorRemoto();
    let r: ResultadoGuardado;
    try { r = await respaldo.guardar(id, original); } catch { r = { tipo: 'no-disponible' }; }
    guardandoRemota = null;
    // Otra autorización (hubo un 401 mientras tanto): solo se dice lo que pasó de verdad, sin ofrecer ningún archivo.
    const autorizada = epoca === autorizacionUi;
    if (!autorizada && r.captura) r = { tipo: r.tipo, ...(r.causa ? { causa: r.causa } : {}) };
    const texto = textoGuardadoRemota(r);
    const vigente = gen === genVisor && visorFoto === id && visorRemoto !== null;
    const ok = r.tipo === 'guardada' || r.tipo === 'comprobada';
    if (!vigente) {
      // Visor cerrado o sustituido: el resultado se dice fuera, con el nombre de la foto; este visor no se toca.
      if (ok && autorizada) void remotas?.sesion(datos.sesion.destino)?.reclasificar(id);
      anunciar(`«${original.nombre}»: ${texto}`);
      return;
    }
    // Un guardado que sí terminó en PhotoDB es una copia deliberada aunque la sesión se perdiera después; pero el
    // estado de compartida (guardada, archivo) solo lo fija un resultado de la autorización vigente.
    if (autorizada) {
      if (ok) guardadaRemota = id;
      if (r.captura) archivoRemoto = id;
    }
    avisoVisor(texto);
    actualizarVisorRemoto();
  }
  function descargarArchivoRemoto(id: string) {
    // Solo el archivo que este visor ofreció en la autorización vigente (un 401 lo quita).
    if (archivoRemoto !== id) return;
    const d = respaldo?.descargarArchivo(id);
    if (!d || !respaldo) return;
    const a = elemento('a');
    a.href = d.url;
    a.download = d.nombre.trim() || 'foto';
    a.hidden = true;
    document.body.append(a);
    a.click();
    a.remove();
    // Se libera después de que el navegador haya tomado la descarga.
    setTimeout(() => respaldo.soltarUrl(d.url), 60_000);
    avisoVisor('Descarga pedida al navegador; el archivo no queda en las fotos de este móvil.');
  }
  async function clicVisor(objetivo: Element) {
    const id = visorFoto;
    if (!visor || !id) return;
    const gen = genVisor;
    // Tras cada await: solo el MISMO visor (misma generación y foto) recibe efectos. Cerrado o sustituido por
    // otro, aunque sea de la misma foto reabierta, no se toca: ni cierre, ni foco, ni historia, ni avisos.
    const vigenteVisor = () => gen === genVisor && visorFoto === id;
    // Si la foto ya no está (la borró un visor anterior), se dice en vez de afirmar que sigue guardada.
    const siSigue = (texto: string) => datosFoto(id) ? texto : 'Esta foto ya no está en este móvil.';
    const paso = objetivo.closest<HTMLElement>('[data-visor-paso]');
    if (paso) { moverVisor(Number(paso.dataset.visorPaso)); return; }
    if (objetivo.closest('[data-visor-cerrar]')) { cerrarVisor(); return; }
    if (visorRemoto) {
      // Compartida: ver no guarda nada; guardar sin conexión es su propia acción.
      if (objetivo.closest('[data-visor-guardar-remota]')) void guardarRemota();
      else if (objetivo.closest('[data-visor-cancelar-remota]')) respaldo?.cancelarGuardado();
      else if (objetivo.closest('[data-visor-reintentar-remota]')) remotaDelVisor()?.sesion.reintentarVista(id);
      else if (objetivo.closest('[data-visor-archivo-remota]')) descargarArchivoRemoto(id);
      return;
    }
    if (objetivo.closest('[data-visor-original]')) {
      const r = await controlador.verOriginal(id);
      if (!vigenteVisor()) { if (r.tipo === 'lista') controlador.soltarUrl(r.url); return; }
      if (r.tipo === 'lista') {
        urlsVisor.push(r.url);
        mostrarEnVisor(r.url, `Original de «${datosFoto(id)?.entrada.nombre ?? ''}»`);
        avisoVisor('Original a tamaño completo.');
      } else {
        const motivo = r.motivo.charAt(0).toLowerCase() + r.motivo.slice(1).replace(/\.$/, '');
        avisoVisor(siSigue(`No hay vista previa segura para este archivo (${motivo}). Sigue guardado y se puede descargar.`));
      }
      return;
    }
    if (objetivo.closest('[data-visor-descargar]')) {
      const d = await controlador.descargar(id);
      if (!vigenteVisor()) { if (d) controlador.soltarUrl(d.url); return; }
      if (!d) { avisoVisor(siSigue('No se pudo leer el original; sigue guardado.')); return; }
      const a = elemento('a');
      a.href = d.url;
      a.download = d.nombre.trim() || 'foto';
      a.hidden = true;
      document.body.append(a);
      a.click();
      a.remove();
      // Se libera después de que el navegador haya tomado la descarga.
      setTimeout(() => controlador.soltarUrl(d.url), 60_000);
      avisoVisor(`Descargando el original (${peso(datosFoto(id)?.entrada.bytesOriginal ?? 0)}).`);
      return;
    }
    if (objetivo.closest('[data-visor-reintentar]')) {
      avisoVisor('Preparando la vista previa…');
      await controlador.reintentarVista(id);
      if (!vigenteVisor()) return;
      const url = await controlador.verMiniatura(id);
      if (!vigenteVisor()) { if (url) controlador.soltarUrl(url); return; }
      if (url) { urlsVisor.push(url); mostrarEnVisor(url, 'Vista previa'); avisoVisor('Vista previa lista.'); }
      else avisoVisor(siSigue('Sigue sin vista previa; el original está guardado.'));
      return;
    }
    const enviar = objetivo.closest<HTMLElement>('[data-visor-respaldar], [data-visor-reanudar]');
    if (enviar && respaldo) {
      if (!politica.permitida) { avisoVisor('Activa las transferencias de fotos en Ajustes antes de subir. Puede consumir datos móviles.'); return; }
      // Un toque, una acción: con la carga en curso la línea de estado ya ofrece «Pausar».
      if (enviar.getAttribute('aria-disabled') === 'true') return;
      enviar.setAttribute('aria-disabled', 'true');
      const nombre = datosFoto(id)?.entrada.nombre ?? '';
      const r = await (enviar.hasAttribute('data-visor-reanudar') ? respaldo.reintentar(id) : respaldo.respaldar(id));
      const texto = textoResultadoRespaldo(r);
      // Visor cerrado o sustituido: el resultado se dice fuera, con el nombre de la foto; este visor no se toca.
      if (!vigenteVisor()) { anunciar(`«${nombre}»: ${texto}`); return; }
      enviar.removeAttribute('aria-disabled');
      avisoVisor(texto);
      pintarRespaldo(id, respaldo.estado(id));
      return;
    }
    const pausar = objetivo.closest<HTMLElement>('[data-visor-pausar]');
    if (pausar && respaldo) {
      if (pausar.getAttribute('aria-disabled') === 'true') return;
      pausar.setAttribute('aria-disabled', 'true');
      const r = await respaldo.pausar(id);
      if (!vigenteVisor()) return;
      pausar.removeAttribute('aria-disabled');
      // Solo se afirma la pausa si el ledger la tiene; si no, no se dice que se paró.
      avisoVisor(r.tipo === 'pausado' || r.tipo === 'respaldada' ? textoResultadoRespaldo(r)
        : 'No se pudo pausar; el envío puede seguir.');
      pintarRespaldo(id, respaldo.estado(id));
      return;
    }
    const acciones = visor.querySelector<HTMLElement>('.visor-acciones');
    const confirmar = visor.querySelector<HTMLElement>('.visor-confirmar');
    if (!acciones || !confirmar) return;
    if (objetivo.closest('[data-visor-borrar]')) {
      // Con respaldo, el aviso dice lo que consta en este móvil (D-U1): se permite borrar, avisando.
      const aviso = confirmar.querySelector('.visor-confirmar-texto');
      if (aviso) aviso.textContent = respaldo ? avisoBorradoRespaldo(respaldo.estado(id)) : CONFIRMAR_BORRADO;
      acciones.hidden = true; confirmar.hidden = false;
      confirmar.querySelector<HTMLElement>('[data-visor-cancelar]')?.focus();
      return;
    }
    if (objetivo.closest('[data-visor-cancelar]')) {
      confirmar.hidden = true; acciones.hidden = false;
      acciones.querySelector<HTMLElement>('[data-visor-borrar]')?.focus();
      return;
    }
    const borrar = objetivo.closest<HTMLElement>('[data-visor-confirmar]');
    if (borrar) {
      if (borrar.getAttribute('aria-disabled') === 'true') return;
      borrar.setAttribute('aria-disabled', 'true');
      const datos = datosFoto(id);
      // Un envío propio de esta foto se pausa ANTES de borrar la copia local. Si la pausa no consta, no se afirma.
      let pausa = '';
      if (respaldo?.enCurso(id)) {
        const p = await respaldo.pausar(id);
        // Nada destructivo fuera del visor vigente: si se cerró mientras tanto, no se borra.
        if (!vigenteVisor()) return;
        pausa = p.tipo === 'pausado' ? ' Su respaldo quedó en pausa, sin confirmar.'
          : p.tipo === 'respaldada' ? '' : ' No se pudo pausar su respaldo: el servidor puede recibirla igualmente.';
      }
      const r = await controlador.borrar(id);
      if (!vigenteVisor()) {
        // El resultado durable se dice en el panel de SU destino; el visor que haya ahora no se toca.
        if (datos && r !== 'ocupada') {
          const clave = claveDestino(datos.destino);
          const sigue = controlador.entradas(datos.destino).some((e) => e.fotoId === id);
          mensajes.set(clave, r === 'borrada' ? `Foto borrada de este móvil.${pausa}`
            : sigue ? 'No se pudo borrar una foto: sigue guardada en este móvil.' : '');
          alCambiar(clave);
        }
        return;
      }
      if (r === 'borrada') {
        // La miniatura ya no existe: el foco va a «Elegir de la galería» de su bloque (o, en un sitio retirado, que no
        // tiene galería, a su botón «Fotos»), buscado en la página de AHORA: borrar la última foto de un sitio retirado
        // quita su fila. Si ya no hay bloque, cerrarVisor usa su refugio (título de la sección o de «Todo»).
        const clave = datos ? claveDestino(datos.destino) : null;
        const bloque = datos?.bloque?.isConnected ? datos.bloque : [...contenido.querySelectorAll<HTMLElement>('[data-fotos-destino]')]
          .find((b) => b.dataset.fotosDestino === clave);
        abridor = (datos && bloque ? bloque.querySelector<HTMLElement>(esDestinoActivo(plan, datos.destino)
          ? '[data-fotos-anadir]' : '[data-fotos-alternar]') : null) ?? abridor;
        cerrarVisor();
        // Tras cerrar el visor (fuera del modal), para que la línea de estado se anuncie.
        if (datos) {
          const clave = claveDestino(datos.destino);
          mensajes.set(clave, `Foto borrada de este móvil.${pausa}`);
          alCambiar(clave);
        }
      } else {
        borrar.removeAttribute('aria-disabled');
        if (r === 'fallo') avisoVisor(siSigue(`No se pudo borrar: la foto sigue guardada en este móvil.${pausa}`));
      }
    }
  }

  return {
    controlador,
    respaldoActivo: respaldo !== null,
    montarFotosViaje(contenedor) {
      if (!respaldo || !composicion) return;
      seccion ??= crearSeccionFotosViaje({ respaldo, nombreDe, maxFilas: composicion.listado.maxFilas,
        fotos: () => controlador.fase });
      seccion.montar(contenedor);
      // Solo metadata local (0 red), como al abrir un bloque «Fotos»: el estado de cada respaldo vive en este móvil.
      if (controlador.fase === 'cerrada') void controlador.abrir();
    },
    montarRetiradas(contenedor) {
      retiradas = { contenedor, firma: '\0' };
      pintarRetiradas();
      pintarCuentas();
      // Solo metadata local (0 red): saber si hay fotos de sitios retirados no lee originales ni vistas previas.
      if (controlador.fase === 'cerrada') void controlador.abrir();
    },
    montarDatos(contenedor) {
      datosContenedor = contenedor; pintarDatos();
      contenedor.addEventListener('change', (e) => {
        const input = e.target as HTMLInputElement;
        if (input.name === 'datos-fotos') politica.elegir(input.value === 'ilimitados' ? MODOS_FOTOS.ilimitados : MODOS_FOTOS.ahorro);
      });
    },
    permitirDatos() { politica.permitirTemporal(); },
    tomar(destino) {
      const bloque = elemento('div'); bloque.dataset.fotosDestino = claveDestino(destino);
      elegir(bloque, 'camara');
    },
    abrirAlbum(contenedor) {
      albumObservador?.disconnect();
      if (typeof IntersectionObserver !== 'function') return;
      albumObservador = new IntersectionObserver((entradas) => {
        for (const e of entradas) if (e.isIntersecting && e.target.isConnected) {
          albumObservador?.unobserve(e.target);
          const bloque = e.target as HTMLElement;
          if (bloque.querySelector('[aria-expanded="false"]')) void alternar(bloque);
        }
      });
      for (const bloque of contenedor.querySelectorAll<HTMLElement>('[data-fotos-destino]')) albumObservador.observe(bloque);
    },
    html,
    manejarClic(objetivo) {
      if (objetivo.closest('[data-datos-permitir]')) { politica.permitirTemporal(); return true; }
      if (seccion && objetivo.closest('[data-fotos-viaje]')) {
        if (!politica.permitida && objetivo.closest('[data-lote-confirmar], [data-lote-continuar]')) politica.permitirTemporal();
        if (!politica.permitida && objetivo.closest('[data-lote-confirmar], [data-lote-continuar], [data-catalogo-ver], [data-catalogo-siguientes], [data-catalogo-principio], [data-catalogo-reintentar], [data-catalogo-guardar], [data-viaje-reintentar]')) { anunciar('Permite las transferencias de fotos en Ajustes. Pueden consumir datos móviles.'); return true; }
        return seccion.manejarClic(objetivo);
      }
      const bloque = objetivo.closest<HTMLElement>('[data-fotos-destino]');
      if (!bloque || !contenido.contains(bloque)) return false;
      if (objetivo.closest('[data-fotos-alternar]')) { void alternar(bloque); return true; }
      if (objetivo.closest('[data-fotos-camara]')) { elegir(bloque, 'camara'); return true; }
      if (objetivo.closest('[data-fotos-anadir]')) { elegir(bloque, 'galeria'); return true; }
      if (objetivo.closest('[data-fotos-reabrir]')) {
        const clave = bloque.dataset.fotosDestino ?? '';
        void controlador.abrir().then(() => alCambiar(clave));
        return true;
      }
      const reintentar = objetivo.closest<HTMLElement>('[data-foto-reintentar]');
      if (reintentar) {
        void reintentarGuardar(reintentar, bloque.dataset.fotosDestino ?? '', reintentar.dataset.fotoReintentar ?? '');
        return true;
      }
      const descartar = objetivo.closest<HTMLElement>('[data-foto-descartar]');
      if (descartar) { controlador.descartar(descartar.dataset.fotoDescartar ?? ''); return true; }
      const destinoBloque = destinoDeClave(plan, bloque.dataset.fotosDestino ?? '');
      const sesionBloque = destinoBloque ? remotas?.sesion(destinoBloque) ?? null : null;
      if (objetivo.closest('[data-remotas-mas]')) { if (destinoBloque) void cargarPaginas(destinoBloque, true); return true; }
      if (objetivo.closest('[data-remotas-reintentar]')) { sesionBloque?.reintentar(); return true; }
      const remota = objetivo.closest<HTMLElement>('[data-foto-remota]');
      if (remota && sesionBloque) { abrirVisorRemoto(sesionBloque, remota.dataset.fotoRemota ?? '', remota); return true; }
      const foto = objetivo.closest<HTMLElement>('[data-foto-id]');
      if (foto) { void abrirVisor(foto.dataset.fotoId ?? '', foto); return true; }
      // Cualquier otro clic dentro del bloque no debe plegar la ficha ni cambiar nada.
      return true;
    },
    preparar() {
      if (controlador.fase === 'cerrada') void controlador.abrir();
    },
    desmontar() {
      cerrarVisor();
      for (const clave of [...abiertos.keys()]) cerrarAbierto(clave);
      // Solo la vista: el respaldo y el catálogo siguen siendo del controlador (una acción en curso no se corta).
      seccion?.desmontar();
    },
    pintarCuentas,
    cerrarVisor,
    cerrarEn(contenedor) {
      for (const bloque of [...abiertos.values()]) if (contenedor.contains(bloque)) plegarBloque(bloque);
    },
  };
}
