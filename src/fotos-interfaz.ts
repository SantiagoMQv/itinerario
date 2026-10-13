import type { Itinerario } from './tipos';
import { copiarMetadatos, crearCapturaFoto, esDestinoFoto, esFotoBorrada, tamanoBlob, tipoBlob, type CapturaFoto,
  type DestinoFoto, type MetadatosFoto } from './fotos';
import { abrirFotosLocal, type FotosLocal } from './fotos-local';
import { LIMITES_IMAGEN, crearMiniatura, inspeccionarImagen, type InspeccionImagen, type MiniaturaImagen,
  type MotorMiniatura } from './fotos-imagen';
import { avisoBorradoRespaldo, componerRespaldoFotos, crearSeccionFotosViaje, textoEstadoRespaldo,
  textoResultadoRespaldo, type CambioRespaldo, type ComposicionRespaldoFotos, type EstadoRespaldo,
  type RespaldoFotos, type SeccionFotosViaje } from './fotos-respaldo-interfaz';

/**
 * Fotos locales en la interfaz del viaje. Dos piezas:
 * 1. `crearFotosInterfaz`: controlador sin DOM (pruebas en Node). Abre la base de fotos solo para listar
 *    metadata, guarda originales sin optimismo, genera vistas previas en serie y solo para lo visible,
 *    y es dueño de cada URL blob que crea (visitas, visor y descargas).
 * 2. `crearFotosUi`: bloques «Fotos» de fichas y subparadas, selector de archivo y visor, sin innerHTML
 *    con nombres de archivo ni textos de error.
 * Cero red por sí mismas: las fotos no viajan ni se mezclan con el progreso compartido. Solo con la composición
 * EXPLÍCITA del respaldo (`OpcionesFotosUi.respaldo`; la web publicada pasa null) aparecen el respaldo manual en
 * el visor y «Fotos del viaje» en «Todo», y cada envío o consulta empieza con un toque.
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
      const r = await almacen.guardarOriginal(intento.captura);
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
}
export interface FotosUi {
  readonly controlador: FotosInterfaz;
  /** Hay composición de respaldo: solo entonces existen el bloque del visor y «Fotos del viaje». */
  readonly respaldoActivo: boolean;
  /** Monta «Fotos del viaje» en su sección de «Todo»; sin composición no hace nada. */
  montarFotosViaje(contenedor: HTMLElement): void;
  /** Bloque «Fotos» (solo atributos con IDs del plan y texto escapado) para incrustar en la ficha. */
  html(destino: DestinoFoto): string;
  /** Delegación de clics: devuelve true si el clic era de fotos (va antes que los manejadores de fila). */
  manejarClic(objetivo: Element): boolean;
  /** Abre la base (solo metadata) y pinta los recuentos. */
  preparar(): void;
  /** Antes de sustituir la lista: cierra las visitas y libera sus URLs. */
  desmontar(): void;
  pintarCuentas(): void;
  /** Cierra el visor si está abierto; devuelve si lo estaba. */
  cerrarVisor(desdeHistorial?: boolean): boolean;
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
const NOTA_RESPALDO = 'Se guardan en este móvil y funcionan sin conexión. Puedes respaldar cada foto en el servidor del viaje desde su visor.';
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
  const respaldo: RespaldoFotos | null = componerRespaldoFotos(composicion, { plan,
    puerto: () => controlador.puerto?.() ?? null,
    incorporar: (m) => controlador.incorporar?.(m),
    alCambiar: (que) => alCambiarRespaldo(que) });
  let seccion: SeccionFotosViaje | null = null;

  function alCambiar(clave: ClaveDestino | null) {
    for (const [c, bloque] of abiertos) {
      if (clave === null || c === clave) {
        if (bloque.isConnected) pintarPanel(c, bloque);
        else cerrarAbierto(c);
      }
    }
    pintarCuentas();
    if (visorFoto) actualizarVisor();
    // Al abrirse (o fallar) las fotos de este móvil, «Fotos del viaje» ya puede leer su estado local.
    if (clave === null) seccion?.alCambiar({ tipo: 'resumen' });
  }
  /** Repinta desde lo ya leído del ledger (0 IO): la línea del visor de ESA foto y «Fotos del viaje». */
  function alCambiarRespaldo(que: CambioRespaldo): void {
    if (que.tipo === 'foto' && visorFoto === que.fotoId && respaldo) pintarRespaldo(que.fotoId, respaldo.estado(que.fotoId));
    seccion?.alCambiar(que);
  }
  function cerrarAbierto(clave: ClaveDestino) {
    abiertos.delete(clave);
    const destino = destinoDeClave(plan, clave);
    if (destino) controlador.cerrarVisita(destino);
  }

  // ----- Bloque y panel -----
  function html(destino: DestinoFoto): string {
    const clave = claveDestino(destino);
    const id = `fotos-${clave.replace(/:/g, '-')}`;
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
      const texto = n ? ` · ${n}` : '';
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
      const anadir = boton('', 'mini', { 'fotos-anadir': '' });
      anadir.insertAdjacentHTML('afterbegin', ICONO_CAMARA);
      anadir.append('Añadir foto');
      acciones.append(anadir);
      panel.replaceChildren(estado, error, lista, sesion, vacio, acciones,
        elemento('p', 'cifras fotos-nota', respaldo ? NOTA_RESPALDO : NOTA));
    }
    const foco = document.activeElement instanceof HTMLElement && panel.contains(document.activeElement) ? document.activeElement : null;
    const huella = (e: Element) => ['data-foto-id', 'data-foto-reintentar', 'data-foto-descartar', 'data-fotos-anadir', 'data-fotos-reabrir']
      .map((a) => `${a}=${e.getAttribute(a)}`).join('|');
    const buscada = foco ? huella(foco) : '';

    const lista = panel.querySelector<HTMLElement>('.fotos-lista')!;
    const sesion = panel.querySelector<HTMLElement>('.fotos-sesiones')!;
    const vacio = panel.querySelector<HTMLElement>('.fotos-vacio')!;
    const error = panel.querySelector<HTMLElement>('.fotos-error')!;
    const anadir = panel.querySelector<HTMLButtonElement>('[data-fotos-anadir]')!;
    const nombre = nombreDe(destino);
    const fase = controlador.fase;
    // Sin base abierta no hay nada que añadir: la acción no aparece (ni engaña con un botón muerto).
    const acciones = panel.querySelector<HTMLElement>('.fotos-acciones')!;
    acciones.hidden = fase !== 'lista';
    anadir.setAttribute('aria-label', `Añadir foto de «${nombre}»`);

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

    if (foco && !foco.isConnected) {
      const igual = [...panel.querySelectorAll<HTMLElement>('button')].find((b) => huella(b) === buscada);
      (igual ?? anadir).focus();
    }
  }

  async function alternar(bloque: HTMLElement) {
    const clave = bloque.dataset.fotosDestino ?? '';
    const destino = destinoDeClave(plan, clave);
    const control = bloque.querySelector<HTMLElement>('[data-fotos-alternar]');
    const panel = bloque.querySelector<HTMLElement>('.fotos-panel');
    if (!destino || !control || !panel) return;
    const abrir = control.getAttribute('aria-expanded') !== 'true';
    control.setAttribute('aria-expanded', String(abrir));
    panel.hidden = !abrir;
    if (!abrir) {
      cerrarAbierto(clave);
      panel.replaceChildren();
      return;
    }
    abiertos.set(clave, bloque);
    pintarPanel(clave, bloque);
    // La visita existe ya: si la base aún abre, el controlador la carga al terminar.
    controlador.abrirVisita(destino);
    // Tras un fallo no se reintenta solo: se ve el error y el reintento es del usuario.
    if (controlador.fase === 'cerrada' || controlador.fase === 'abriendo') await controlador.abrir();
    if (abiertos.get(clave) === bloque) pintarPanel(clave, bloque);
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
  }
  function elegir(bloque: HTMLElement) {
    const clave = bloque.dataset.fotosDestino ?? '';
    const destino = destinoDeClave(plan, clave);
    if (!destino) return;
    if (controlador.fase !== 'lista') {
      mensajes.set(clave, controlador.fase === 'fallo' ? 'Primero hay que abrir las fotos de este móvil (Reintentar).' : 'Aún se están abriendo las fotos de este móvil.');
      alCambiar(clave);
      return;
    }
    const input = selector();
    intento = { destino, clave, usado: false };
    input.value = '';
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
    if (!visorFoto || !visor) return;
    const datos = datosFoto(visorFoto);
    if (!datos) return;
    const texto = visor.querySelector('.visor-texto');
    if (texto && !visor.querySelector('.visor-imagen img')) texto.textContent = TEXTO_ESTADO[datos.entrada.estado];
  }
  async function abrirVisor(id: string, origen: HTMLElement) {
    if (!datosFoto(id)) return;
    visor ??= crearVisor();
    soltarVisor();
    const gen = ++genVisor;
    visorFoto = id;
    abridor = origen;
    pintarVisor(id);
    visor.hidden = false;
    for (const n of document.body.children) if (n !== visor && n.tagName !== 'SCRIPT') (n as HTMLElement).inert = true;
    history.pushState({ visorFoto: true }, '');
    historial = true;
    visor.querySelector<HTMLElement>('[data-visor-cerrar]')?.focus();
    // Solo el ledger local (0 red): abrir el visor nunca envía, consulta ni reintenta nada.
    cargarRespaldo(id);
    const url = await controlador.verMiniatura(id);
    if (!url) return;
    if (gen !== genVisor) { controlador.soltarUrl(url); return; }
    urlsVisor.push(url);
    mostrarEnVisor(url, `Vista previa de «${datosFoto(id)?.entrada.nombre ?? ''}»`);
  }
  function cerrarVisor(desdeHistorial = false): boolean {
    if (!visor || visor.hidden) return false;
    genVisor++;
    visor.hidden = true;
    visor.replaceChildren();
    soltarVisor();
    const id = visorFoto;
    visorFoto = null;
    for (const n of document.body.children) (n as HTMLElement).inert = false;
    if (historial && !desdeHistorial && history.state?.visorFoto) history.back();
    historial = false;
    // Si la miniatura se repintó mientras tanto, el foco vuelve a la misma foto.
    const destino = abridor?.isConnected ? abridor
      : [...contenido.querySelectorAll<HTMLElement>('[data-foto-id]')].find((b) => b.dataset.fotoId === id) ?? null;
    abridor = null;
    destino?.focus();
    return true;
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
    if (objetivo.closest('[data-visor-cerrar]')) { cerrarVisor(); return; }
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
        // La miniatura ya no existe: el foco va a «Añadir foto» de su bloque.
        abridor = datos?.bloque?.querySelector<HTMLElement>('[data-fotos-anadir]') ?? abridor;
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
    html,
    manejarClic(objetivo) {
      if (seccion && objetivo.closest('[data-fotos-viaje]')) return seccion.manejarClic(objetivo);
      const bloque = objetivo.closest<HTMLElement>('[data-fotos-destino]');
      if (!bloque || !contenido.contains(bloque)) return false;
      if (objetivo.closest('[data-fotos-alternar]')) { void alternar(bloque); return true; }
      if (objetivo.closest('[data-fotos-anadir]')) { elegir(bloque); return true; }
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
  };
}
