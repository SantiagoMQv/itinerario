import type { Itinerario } from './tipos';
import { tamanoBlob, type DestinoFoto } from './fotos';
import type { ListadoFotos, ResultadoListadoFotosDestinoCliente } from './fotos-listado';
import { serializarDestinoListadoFotos } from './fotos-listado-protocolo';
import type { RecepcionOriginal } from './fotos-descarga';
import { LIMITES_IMAGEN, crearMiniatura, type MiniaturaImagen, type MotorMiniatura } from './fotos-imagen';
import { deserializarSolicitudRespaldo } from './fotos-protocolo';
import type { OriginalRespaldo } from './fotos-respaldo';

/**
 * Fotos compartidas de UNA ficha, vistas con conexión y sin guardarlas en este móvil.
 *
 * Controlador sin DOM (pruebas en Node). Por cada destino abierto, una sesión con su PROPIA instancia de listado
 * (nunca la del catálogo global): al abrirse pide la primera página de ESE destino y avanza en tramos acotados
 * cuando la interfaz lo solicita con permiso de datos. De cada referencia solo se pide el original cuando su celda está a la vista (o
 * en el visor), con UNA tubería para todo: recepción protegida a memoria → decodificador seguro de siempre
 * (PNG/JPEG/WebP identificados por cabecera) → PNG nuevo de 1024 px como mucho. Nada pasa por PhotoDB, el ledger,
 * CacheStorage ni storage: la vista temporal vive en un Blob con una URL propia que se revoca al soltarla.
 * El original privado puede llegar ENTERO (hasta 8 MiB en el piloto): no hay miniaturas compartidas.
 * Guardar sin conexión NO es de aquí: es otra acción, con la descarga duradera de siempre.
 *
 * Cotas por instancia (la interfaz crea UNA para toda la app): vistas retenidas con tope DURO de número y de bytes,
 * admitidas antes de publicarse (lo que no cabe no se retiene ni se enseña); además, en vuelo, un solo original
 * (hasta su tamaño y el límite de la composición) y un decode a la vez, que no se cuentan ahí ni acotan el heap
 * físico del navegador. Cada paso de la tubería tiene plazo finito: al vencer, la celda lo dice y se aborta lo
 * abortable; la tubería sigue ocupada hasta que el trabajo externo (puerto o decodificador) termina, y lo que llega
 * tarde se descarta. Un 401 sube la generación de autorización: nada anterior (página, clasificación, decode,
 * callback) vuelve a publicarse.
 */

/** Lo que este móvil tiene de una referencia (solo metadata local; «registrada» no atesta bytes). */
export type LocalRemota = 'ausente' | 'registrada' | 'borrada' | 'otra' | 'ilegible';

export type VistaRemota =
  /** Sin pedir: su celda no se ha visto, o se soltó su vista (se vuelve a pedir si se ve otra vez). */
  | { readonly tipo: 'pendiente' }
  /** A la vista, esperando la tubería o un hueco entre las vistas retenidas. */
  | { readonly tipo: 'en-cola' }
  | { readonly tipo: 'cargando' }
  | { readonly tipo: 'lista'; readonly url: string; readonly bytes: number }
  /** Sin vista segura: tipo declarado no decodificable (no se pide) o cabecera no identificada (se pidió). */
  | { readonly tipo: 'sin-vista'; readonly motivo: string; readonly declarado: boolean }
  /** Red, servidor, decodificador o plazo vencido: se reintenta con un toque, nunca solo. */
  | { readonly tipo: 'fallida'; readonly motivo: 'plazo' | 'error' }
  /** La vista no cabe entre las retenidas sin soltar lo que se está mirando: ni se retiene ni se enseña. */
  | { readonly tipo: 'sin-hueco' };

export interface FotoRemota {
  readonly original: OriginalRespaldo;
  /** Nunca «registrada»: esas ya se ven como foto de este móvil (local primero, sin duplicar). */
  readonly local: Exclude<LocalRemota, 'registrada'>;
  readonly vista: VistaRemota;
}

export type EstadoRemotas =
  /** El listado no se pudo crear aquí (sin HTTPS o presupuesto inválido): 0 IO. */
  | { readonly tipo: 'no-disponible' }
  | { readonly tipo: 'sin-conexion' }
  | { readonly tipo: 'consultando'; readonly mas: boolean }
  /** `yaAqui`: referencias ocultas porque este móvil ya tiene esa foto. `completa`: se llegó a `maxFotos`. */
  | { readonly tipo: 'lista'; readonly hayMas: boolean; readonly yaAqui: number; readonly completa: boolean }
  | { readonly tipo: 'fallo'; readonly motivo: 'sin-sesion' | 'servidor' | 'respuesta' | 'plazo' | 'ocupada' };

export interface SesionRemota {
  readonly destino: DestinoFoto;
  readonly estado: EstadoRemotas;
  readonly fotos: readonly FotoRemota[];
  /** Repite la última consulta que no llegó (la primera página o «ver más»). Un toque, un GET. */
  reintentar(): void;
  /** Siguiente página del MISMO destino; la continuación vive solo en memoria y nunca se sigue sola. */
  verMas(): void;
  /** Hasta doce fotos nuevas o 24 páginas; comprueba la continuidad entre páginas, sin descargar originales. */
  cargarSiguientes(seguir?: () => boolean): Promise<void>;
  /** Actualiza metadatos sin retirar las imágenes ni la selección que se está leyendo. */
  refrescar(): Promise<void>;
  /** Su celda está (o deja de estar) a la vista: solo entonces se pide su original; oculta, se corta. */
  visible(fotoId: string, si: boolean): void;
  /** Foto del visor: su vista se pide aunque la celda no se vea y no se suelta mientras siga abierta. */
  fijar(fotoId: string | null): void;
  reintentarVista(fotoId: string): void;
  /** Tras guardarla sin conexión (u otro cambio local), se vuelve a clasificar contra este móvil. */
  reclasificar(fotoId: string): Promise<void>;
}

export interface FotosRemotas {
  /** Abre desde cero la sesión de ese destino (cierra la anterior si la había) y pide su primera página. */
  abrir(destino: DestinoFoto): SesionRemota;
  sesion(destino: DestinoFoto): SesionRemota | null;
  /** Cierra su listado, corta su original en curso, revoca sus URLs y olvida sus referencias. */
  cerrar(destino: DestinoFoto): void;
  /** Segundo plano: corta el original en curso; la tubería sigue ocupada hasta que ese trabajo termine. */
  suspender(): void;
  /** Sesión perdida vista por otro (p. ej. «Guardar sin conexión» con 401): fuera TODAS las vistas y referencias
   * temporales y se cierran las consultas en curso; lo guardado a propósito en este móvil no se toca. */
  invalidarSesion(): void;
  reanudar(): void;
  /** Suelta todas las vistas temporales (al salir de la página); las celdas a la vista las vuelven a pedir. */
  soltarVistas(): void;
  urlsVivas(): number;
  cerrarTodo(): void;
}

/** Cotas explícitas por instancia. `maxVistas` y `maxBytesVistas` son topes DUROS de las vistas retenidas: una vista
 * nueva entra soltando las que no se miran (de la menos reciente a la más) y, si ni así cabe, no se retiene ni se
 * publica («sin-hueco»). Lo que se está mirando (a la vista o en el visor) nunca se suelta para hacer sitio.
 * `plazoMs` acota cada paso de la tubería (recepción y decode). */
export interface LimitesRemotas {
  readonly maxFotos: number;
  readonly maxVistas: number;
  readonly maxBytesVistas: number;
  readonly ladoVista: number;
  readonly plazoMs: number;
}
export const LIMITES_REMOTAS: LimitesRemotas = Object.freeze({ maxFotos: 24, maxVistas: 12,
  maxBytesVistas: 24 * 1024 * 1024, ladoVista: LIMITES_IMAGEN.ladoSalida, plazoMs: 60_000 });

export interface DependenciasRemotas {
  readonly plan: Itinerario;
  /** Una instancia de listado NUEVA por sesión; null si aquí no puede existir (0 IO). */
  readonly crearListado: () => Pick<ListadoFotos, 'listarDestino' | 'cerrar'> | null;
  /** Recepción a memoria; null: no hay fotos compartidas aquí. */
  readonly recepcion: RecepcionOriginal | null;
  /** Solo lecturas de metadata local (dedup fuerte por identidad completa del original). */
  readonly clasificar: (original: OriginalRespaldo) => Promise<LocalRemota>;
  readonly crearMotor?: () => MotorMiniatura;
  /** Sin conexión no se consulta nada; omitido: navigator.onLine !== false. */
  readonly enLinea?: () => boolean;
  readonly crearUrl?: (b: Blob) => string;
  readonly revocarUrl?: (u: string) => void;
  readonly limites?: Partial<LimitesRemotas>;
  /** Cambió lo que se pinta de ese destino (null: de todos). */
  readonly alCambiar?: (destino: DestinoFoto | null) => void;
  /** Esta instancia vio un 401 (consulta u original): para que quien compone invalide también lo suyo. */
  readonly alPerderSesion?: () => void;
}

/** Tipos que el decodificador seguro sabe identificar; cualquier otro declarado ni se pide para verlo. */
const DECODIFICABLES = ['image/png', 'image/jpeg', 'image/webp'];
type MotivoListado = Extract<ResultadoListadoFotosDestinoCliente, { tipo: 'fallida' }>['motivo'];
function motivoFallo(m: MotivoListado): Extract<EstadoRemotas, { tipo: 'fallo' }>['motivo'] {
  if (m === 'sin-sesion') return 'sin-sesion';
  if (m === 'infraestructura') return 'servidor';
  if (m === 'ocupada') return 'ocupada';
  return 'respuesta';
}
function vistaInicial(o: OriginalRespaldo): VistaRemota {
  const mime = o.mimeDeclarado.trim().toLowerCase();
  return DECODIFICABLES.includes(mime) ? { tipo: 'pendiente' }
    : { tipo: 'sin-vista', motivo: o.mimeDeclarado.trim() || 'sin tipo', declarado: true };
}

interface Item {
  readonly original: OriginalRespaldo;
  local: Exclude<LocalRemota, 'registrada'>;
  vista: VistaRemota;
  visible: boolean;
  fijada: boolean;
  /** Último uso, para soltar primero la vista menos reciente. */
  uso: number;
}
interface Sesion {
  readonly destino: DestinoFoto;
  readonly clave: string;
  listado: Pick<ListadoFotos, 'listarDestino' | 'cerrar'> | null | undefined;
  estado: EstadoRemotas;
  items: Item[];
  continuacion: string | null;
  ultima: 'principio' | 'mas';
  yaAqui: number;
  consultando: boolean;
  avanzando: boolean;
  revision: number;
  cursores: Set<string>;
  cerrada: boolean;
  api?: SesionRemota;
}
interface Carga { readonly sesion: Sesion; readonly item: Item; readonly control: AbortController }

export function crearFotosRemotas(d: DependenciasRemotas): FotosRemotas {
  const { plan } = d;
  const limites: LimitesRemotas = { ...LIMITES_REMOTAS, ...d.limites };
  for (const v of Object.values(limites)) if (!Number.isSafeInteger(v) || v < 1) throw new Error('Límites de fotos compartidas inválidos');
  if (limites.plazoMs > 2147483647) throw new Error('Plazo de fotos compartidas inválido');
  const enLinea = d.enLinea ?? (() => typeof navigator === 'undefined' || navigator.onLine !== false);
  const crearUrl = d.crearUrl ?? ((b: Blob) => URL.createObjectURL(b));
  const revocarUrl = d.revocarUrl ?? ((u: string) => URL.revokeObjectURL(u));
  const sesiones = new Map<string, Sesion>();
  let motor: MotorMiniatura | undefined;
  /** UNA tubería: ocupada hasta que su trabajo externo (recepción y decodificador) termina, aunque se haya cortado. */
  let carga: Carga | null = null;
  let suspendida = false;
  let cerrado = false;
  let reloj = 0;
  /** Generación de autorización: sube con cada sesión perdida; nada iniciado antes vuelve a publicarse. */
  let autorizacion = 0;

  const claveDe = (destino: DestinoFoto) => serializarDestinoListadoFotos(plan, destino);
  function avisar(destino: DestinoFoto | null) {
    if (cerrado) return;
    try { d.alCambiar?.(destino); } catch { /* La interfaz no altera lo que se ve. */ }
  }
  function soltar(item: Item) {
    if (item.vista.tipo === 'lista') revocarUrl(item.vista.url);
    item.vista = { tipo: 'pendiente' };
  }
  function vistas(): { readonly sesion: Sesion; readonly item: Item }[] {
    const todas: { sesion: Sesion; item: Item }[] = [];
    for (const s of sesiones.values()) for (const i of s.items) if (i.vista.tipo === 'lista') todas.push({ sesion: s, item: i });
    return todas;
  }
  const bytesVistas = () => vistas().reduce((n, v) => n + (v.item.vista.tipo === 'lista' ? v.item.vista.bytes : 0), 0);
  /** Suelta la vista retenida menos reciente que no se esté mirando; false si no hay ninguna que soltar. */
  function soltarUna(): boolean {
    const candidata = vistas().filter((v) => !v.item.visible && !v.item.fijada).sort((a, b) => a.item.uso - b.item.uso)[0];
    if (!candidata) return false;
    soltar(candidata.item);
    avisar(candidata.sesion.destino);
    return true;
  }
  /** Admisión DURA de una vista nueva de `bytes`: comprueba primero que quepa soltando solo lo que no se mira y,
   * si cabe, suelta lo justo (de la menos reciente a la más). Si no cabe, no suelta nada y devuelve false. */
  function admitir(bytes: number): boolean {
    if (bytes > limites.maxBytesVistas) return false;
    const retenidas = vistas();
    const sueltas = retenidas.filter((v) => !v.item.visible && !v.item.fijada).sort((a, b) => a.item.uso - b.item.uso);
    let n = retenidas.length + 1;
    let total = bytesVistas() + bytes;
    let soltar = 0;
    while ((n > limites.maxVistas || total > limites.maxBytesVistas) && soltar < sueltas.length) {
      const v = sueltas[soltar++].item.vista;
      n--; total -= v.tipo === 'lista' ? v.bytes : 0;
    }
    if (n > limites.maxVistas || total > limites.maxBytesVistas) return false;
    for (let i = 0; i < soltar; i++) soltarUna();
    return true;
  }
  function siguiente(): Carga | null {
    let elegida: { sesion: Sesion; item: Item } | null = null;
    for (const s of sesiones.values()) {
      for (const i of s.items) {
        if (!(i.visible || i.fijada) || (i.vista.tipo !== 'pendiente' && i.vista.tipo !== 'en-cola')) continue;
        // La del visor primero; después, la primera a la vista.
        if (!elegida || (i.fijada && !elegida.item.fijada)) elegida = { sesion: s, item: i };
      }
    }
    return elegida ? { ...elegida, control: new AbortController() } : null;
  }
  /** Marca «en cola» lo que espera a la vista y arranca la tubería si está libre y hay hueco. */
  function bombear() {
    if (cerrado) return;
    for (const s of sesiones.values()) {
      let cambio = false;
      for (const i of s.items) {
        if ((i.visible || i.fijada) && i.vista.tipo === 'pendiente') { i.vista = { tipo: 'en-cola' }; cambio = true; }
        else if (!i.visible && !i.fijada && i.vista.tipo === 'en-cola') { i.vista = { tipo: 'pendiente' }; cambio = true; }
      }
      if (cambio) avisar(s.destino);
    }
    if (carga || suspendida || !d.recepcion) return;
    const proxima = siguiente();
    if (!proxima) return;
    // Tope duro de vistas retenidas: sin hueco (todas a la vista), la celda espera sin pedir nada.
    if (vistas().length >= limites.maxVistas && !soltarUna()) return;
    void ejecutar(proxima);
  }
  async function ejecutar(c: Carga) {
    carga = c;
    const { sesion: s, item } = c;
    const gen = autorizacion;
    const vigente = () => !cerrado && gen === autorizacion && sesiones.get(s.clave) === s && !s.cerrada && s.items.includes(item);
    item.vista = { tipo: 'cargando' };
    avisar(s.destino);
    let vencida = false;
    // Resultado finito: al vencer, la celda lo dice ya y se aborta lo abortable; la tubería sigue ocupada hasta que
    // el trabajo externo (puerto o decodificador) termine, y lo que llegue después se descarta.
    const plazo = setTimeout(() => {
      vencida = true;
      c.control.abort();
      if (vigente() && item.vista.tipo === 'cargando') { item.vista = { tipo: 'fallida', motivo: 'plazo' }; avisar(s.destino); }
    }, limites.plazoMs);
    let png: Blob | null = null;
    let fin: 'lista' | 'sin-vista' | 'fallida' | 'detenida' | 'sin-sesion' = 'fallida';
    let motivo = '';
    try {
      const r = await d.recepcion!.recibir(item.original, c.control.signal);
      if (r.tipo === 'detenida') fin = 'detenida';
      else if (r.tipo === 'fallida') fin = r.motivo === 'sin-sesion' ? 'sin-sesion' : 'fallida';
      else if (c.control.signal.aborted) fin = 'detenida';
      else {
        motor ??= (d.crearMotor ?? (() => crearMiniatura()))();
        // El decodificador no se puede interrumpir a mitad: si se corta, su resultado se descarta al llegar.
        const m: MiniaturaImagen = await motor.generar(r.original, { senal: c.control.signal, ladoCss: limites.ladoVista, dpr: 1 });
        if (m.tipo === 'lista') { png = m.blob; fin = 'lista'; }
        else { fin = 'sin-vista'; motivo = m.motivo; }
      }
    } catch {
      fin = c.control.signal.aborted ? 'detenida' : 'fallida';
    } finally {
      clearTimeout(plazo);
      carga = null;
    }
    if (cerrado) return;
    if (fin === 'sin-sesion' && !vencida && gen === autorizacion) { invalidarSesion(true); return; }
    if (vencida || !vigente() || fin === 'detenida' || fin === 'sin-sesion' || c.control.signal.aborted) {
      // Entrega tardía, cortada o de otra autorización: no crea URL ni publica nada; la celda vuelve a esperar a
      // verse (salvo si ya dice que venció el plazo).
      if (vigente() && item.vista.tipo === 'cargando') item.vista = { tipo: 'pendiente' };
      if (vigente()) avisar(s.destino);
      bombear();
      return;
    }
    if (fin === 'lista' && png) {
      const bytes = tamanoBlob(png);
      if (admitir(bytes)) {
        item.vista = { tipo: 'lista', url: crearUrl(png), bytes };
        item.uso = ++reloj;
      } else item.vista = { tipo: 'sin-hueco' };
    } else if (fin === 'sin-vista') {
      item.vista = { tipo: 'sin-vista', motivo: motivo || 'formato sin vista segura', declarado: false };
    } else item.vista = { tipo: 'fallida', motivo: 'error' };
    avisar(s.destino);
    bombear();
  }
  function cortar(item: Item) {
    if (carga?.item === item) carga.control.abort();
  }
  /** Un 401 (consulta, original o, desde fuera, «Guardar sin conexión»): sube la generación de autorización, corta el
   * original en curso, cierra las consultas (un reintento explícito crea un listado nuevo) y quita TODAS las vistas
   * y referencias temporales, sin copia de reserva. Lo guardado a propósito en este móvil no se toca. */
  function invalidarSesion(propia: boolean) {
    autorizacion++;
    if (carga) carga.control.abort();
    for (const s of sesiones.values()) {
      for (const i of s.items) soltar(i);
      s.items = [];
      s.continuacion = null;
      s.yaAqui = 0;
      try { s.listado?.cerrar(); } catch { /* Su cierre no altera lo que ya se soltó. */ }
      s.listado = undefined;
      s.estado = { tipo: 'fallo', motivo: 'sin-sesion' };
    }
    avisar(null);
    if (propia) {
      try { d.alPerderSesion?.(); } catch { /* Quien compone no altera lo que ya se invalidó aquí. */ }
    }
  }
  async function consultar(s: Sesion, mas: boolean) {
    if (cerrado || suspendida || s.cerrada || s.consultando) return;
    if (mas && s.continuacion === null) return;
    if (!enLinea()) { s.estado = { tipo: 'sin-conexion' }; avisar(s.destino); return; }
    if (s.listado === undefined) {
      try { s.listado = d.recepcion ? d.crearListado() : null; } catch { s.listado = null; }
    }
    const listado = s.listado;
    if (!listado) { s.estado = { tipo: 'no-disponible' }; avisar(s.destino); return; }
    const cursor = mas ? s.continuacion : null;
    if (!mas) s.cursores.clear();
    if (cursor !== null && s.cursores.has(cursor)) {
      s.estado = { tipo: 'fallo', motivo: 'respuesta' }; avisar(s.destino); return;
    }
    const gen = autorizacion;
    const revision = s.revision;
    const vale = () => !cerrado && !s.cerrada && sesiones.get(s.clave) === s && gen === autorizacion && revision === s.revision;
    s.consultando = true;
    s.ultima = mas ? 'mas' : 'principio';
    s.estado = { tipo: 'consultando', mas };
    avisar(s.destino);
    let r: ResultadoListadoFotosDestinoCliente;
    try { r = await listado.listarDestino(s.destino, cursor); }
    catch { r = { tipo: 'fallida', motivo: 'respuesta-inesperada' }; }
    finally { s.consultando = false; }
    // Tras CADA await: ni sesión cerrada, ni otra autorización (un 401 en otra ficha también la invalida).
    if (!vale()) return;
    if (r.tipo === 'fallida' && r.motivo === 'sin-sesion') { invalidarSesion(true); return; }
    if (r.tipo === 'pagina') {
      try {
        const nuevos: Item[] = [];
        let yaAqui = 0;
        for (const texto of r.pagina.solicitudesIniciales) {
          const original = deserializarSolicitudRespaldo(plan, texto).original;
          // El codec ya lo exige; se repite aquí: nada de otro destino entra en esta ficha.
          if (claveDe(original.destino) !== s.clave) throw new Error('Referencia de otro destino');
          if (s.items.some((i) => i.original.fotoId === original.fotoId)
            || nuevos.some((i) => i.original.fotoId === original.fotoId)) continue;
          let local: LocalRemota;
          try { local = await d.clasificar(original); } catch { local = 'ilegible'; }
          if (!vale()) return;
          if (local === 'registrada') { yaAqui++; continue; }
          nuevos.push({ original, local, vista: vistaInicial(original), visible: false, fijada: false, uso: 0 });
        }
        if (!vale()) return;
        s.items.push(...nuevos);
        s.yaAqui += yaAqui;
        if (cursor !== null) s.cursores.add(cursor);
        if (r.pagina.continuacion !== null && (r.pagina.continuacion === cursor || s.cursores.has(r.pagina.continuacion))) {
          s.continuacion = null;
          throw new Error('La continuación no avanza');
        }
        s.continuacion = r.pagina.continuacion;
        s.estado = { tipo: 'lista', hayMas: s.continuacion !== null, yaAqui: s.yaAqui, completa: false };
      } catch {
        s.estado = { tipo: 'fallo', motivo: 'respuesta' };
      }
    } else if (r.tipo === 'fallida') s.estado = { tipo: 'fallo', motivo: motivoFallo(r.motivo) };
    else if (r.motivo === 'plazo') s.estado = { tipo: 'fallo', motivo: 'plazo' };
    else return; // Cancelada o cerrada: solo pasa al cerrar la sesión, que ya no se pinta.
    avisar(s.destino);
    bombear();
  }
  function itemDe(s: Sesion, fotoId: string): Item | undefined {
    return s.items.find((i) => i.original.fotoId === fotoId);
  }
  function api(s: Sesion): SesionRemota {
    return {
      destino: s.destino,
      get estado() { return s.estado; },
      get fotos() { return s.items.map((i) => ({ original: i.original, local: i.local, vista: i.vista })); },
      reintentar() {
        if (s.estado.tipo !== 'fallo' && s.estado.tipo !== 'sin-conexion') return;
        void consultar(s, s.ultima === 'mas' && s.continuacion !== null);
      },
      verMas() { void consultar(s, true); },
      async cargarSiguientes(seguir = () => true) {
        if (s.avanzando || s.consultando || suspendida) return;
        s.avanzando = true;
        const hasta = s.items.length + 12;
        try {
          for (let paginas = 0; paginas < 24 && s.items.length < hasta && s.continuacion !== null; paginas++) {
            if (s.cerrada || suspendida || s.estado.tipo !== 'lista' || !seguir()) break;
            await consultar(s, true);
          }
        } finally { s.avanzando = false; }
      },
      async refrescar() { if (!s.avanzando) await consultar(s, false); },
      visible(fotoId, si) {
        const item = itemDe(s, fotoId);
        if (!item || s.cerrada || item.visible === si) return;
        item.visible = si;
        if (si) item.uso = ++reloj;
        else if (!item.fijada) cortar(item);
        bombear();
      },
      fijar(fotoId) {
        for (const i of s.items) {
          const fijada = i.original.fotoId === fotoId;
          if (i.fijada === fijada) continue;
          i.fijada = fijada;
          if (fijada) i.uso = ++reloj;
          else if (!i.visible) cortar(i);
        }
        bombear();
      },
      reintentarVista(fotoId) {
        const item = itemDe(s, fotoId);
        if (!item || (item.vista.tipo !== 'fallida' && item.vista.tipo !== 'sin-hueco')) return;
        item.vista = { tipo: 'pendiente' };
        avisar(s.destino);
        bombear();
      },
      async reclasificar(fotoId) {
        const item = itemDe(s, fotoId);
        if (!item) return;
        const gen = autorizacion;
        let local: LocalRemota;
        try { local = await d.clasificar(item.original); } catch { local = 'ilegible'; }
        if (cerrado || s.cerrada || !s.items.includes(item) || gen !== autorizacion) return;
        if (local === 'registrada') {
          // Ya es de este móvil: se ve como foto local y la compartida deja de repetirse.
          cortar(item);
          soltar(item);
          s.items = s.items.filter((i) => i !== item);
          s.yaAqui++;
          if (s.estado.tipo === 'lista') s.estado = { ...s.estado, yaAqui: s.yaAqui };
        } else item.local = local;
        avisar(s.destino);
        bombear();
      },
    };
  }
  function cerrarSesion(s: Sesion) {
    s.cerrada = true;
    for (const i of s.items) { cortar(i); soltar(i); }
    s.items = [];
    s.continuacion = null;
    try { s.listado?.cerrar(); } catch { /* Su cierre no altera lo que ya se soltó. */ }
    if (sesiones.get(s.clave) === s) sesiones.delete(s.clave);
  }

  return {
    abrir(destino) {
      const clave = claveDe(destino);
      if (cerrado) throw new Error('Las fotos compartidas están cerradas.');
      const anterior = sesiones.get(clave);
      if (anterior) cerrarSesion(anterior);
      const s: Sesion = { destino, clave, listado: undefined, estado: { tipo: 'consultando', mas: false }, items: [],
        continuacion: null, ultima: 'principio', yaAqui: 0, consultando: false, avanzando: false, revision: 0, cursores: new Set(), cerrada: false };
      s.api = api(s);
      sesiones.set(clave, s);
      void consultar(s, false);
      return s.api;
    },
    sesion(destino) {
      let clave: string;
      try { clave = claveDe(destino); } catch { return null; }
      return sesiones.get(clave)?.api ?? null;
    },
    cerrar(destino) {
      let clave: string;
      try { clave = claveDe(destino); } catch { return; }
      const s = sesiones.get(clave);
      if (!s) return;
      cerrarSesion(s);
      bombear();
    },
    suspender() {
      suspendida = true;
      for (const s of sesiones.values()) {
        s.revision++;
        if (s.consultando) { s.listado?.cerrar(); s.listado = undefined; }
      }
      if (carga) carga.control.abort();
    },
    invalidarSesion() { if (!cerrado) invalidarSesion(false); },
    reanudar() {
      if (!suspendida) return;
      suspendida = false;
      bombear();
    },
    soltarVistas() {
      if (carga) carga.control.abort();
      for (const s of sesiones.values()) {
        for (const i of s.items) soltar(i);
        avisar(s.destino);
      }
    },
    urlsVivas: () => vistas().length,
    cerrarTodo() {
      if (cerrado) return;
      for (const s of [...sesiones.values()]) cerrarSesion(s);
      cerrado = true;
      motor?.cerrar();
      d.recepcion?.cerrar();
    },
  };
}

// ---------- Copy (español, honesto: lo que se ve no se guarda; guardar es otra acción) ----------

export const VISTA_TEMPORAL = 'Se ven con conexión y no se guardan en este móvil.';
export const SIN_SESION_REMOTAS = 'Este móvil no tiene sesión en el servidor: las fotos compartidas no se pueden ver.';
export const NOTA_VISOR_REMOTA = 'Compartida en el servidor del viaje: se ve con conexión y no se guarda en este móvil.';

/** Línea de estado (región viva) de las compartidas de una ficha. Una página vacía no prueba que no haya envíos
 * sin confirmar: solo que el servidor no tiene ninguna confirmada de ese destino. */
export function textoEstadoRemotas(e: EstadoRemotas, vistas: number, nombre: string, maxFotos = LIMITES_REMOTAS.maxFotos): string {
  switch (e.tipo) {
    case 'no-disponible': return 'Las fotos compartidas no están disponibles aquí.';
    case 'sin-conexion': return 'Sin conexión: las fotos compartidas solo se ven con conexión.';
    case 'consultando': return e.mas ? 'Buscando más fotos compartidas…' : 'Buscando fotos compartidas…';
    case 'lista':
      if (vistas > 0) return e.completa ? `${VISTA_TEMPORAL} Se enseñan ${maxFotos} como mucho.` : VISTA_TEMPORAL;
      if (e.yaAqui > 0) return e.hayMas ? 'Las encontradas hasta ahora ya están en este móvil. Puede haber más.'
        : `Las fotos compartidas de «${nombre}» ya están en este móvil.`;
      return e.hayMas ? 'Esta consulta no trajo fotos. Puede haber más.' : `No hay fotos compartidas de «${nombre}».`;
    case 'fallo':
      if (e.motivo === 'sin-sesion') return SIN_SESION_REMOTAS;
      if (e.motivo === 'servidor') return 'El servidor no respondió como se esperaba. No se ha guardado nada.';
      if (e.motivo === 'plazo') return 'Tardó demasiado; no se ha guardado nada.';
      if (e.motivo === 'ocupada') return 'La consulta anterior aún se está cerrando. Prueba en un momento.';
      return 'La respuesta no es válida; no se ha guardado nada.';
  }
}
/** Texto dentro de la celda cuando no hay imagen (y, en minúscula, en su nombre accesible). */
export function textoCeldaRemota(v: VistaRemota): string {
  switch (v.tipo) {
    case 'pendiente': return 'Compartida';
    case 'en-cola': return 'En espera';
    case 'cargando': return 'Cargando…';
    case 'lista': return 'Vista temporal';
    case 'sin-vista': return 'Sin vista segura';
    case 'fallida': return v.motivo === 'plazo' ? 'Tardó demasiado' : 'No se pudo cargar';
    case 'sin-hueco': return 'Sin hueco';
  }
}
/** Texto del visor de una compartida cuando no hay imagen que enseñar. */
export function textoVisorRemota(v: VistaRemota): string {
  switch (v.tipo) {
    case 'sin-vista': {
      const motivo = v.declarado ? v.motivo : v.motivo.charAt(0).toLowerCase() + v.motivo.slice(1).replace(/\.$/, '');
      return `No hay vista segura para ${v.declarado ? 'este tipo de archivo' : 'este archivo'} (${motivo}). `
        + 'Puedes guardarlo sin conexión y, después, descargar el original.';
    }
    case 'fallida': return v.motivo === 'plazo' ? 'Tardó demasiado en llegar; no se ha guardado nada. Puedes reintentarlo.'
      : 'No se pudo cargar la vista temporal. Puedes reintentarlo.';
    case 'sin-hueco': return 'No cabe otra vista temporal mientras se ven las demás: deja de mirar alguna o pliega otra ficha y reinténtalo.';
    default: return 'Cargando la vista temporal…';
  }
}
/** Por qué no se ofrece «Guardar sin conexión» (null: se ofrece). */
export function textoLocalRemota(local: FotoRemota['local']): string | null {
  if (local === 'borrada') return 'La borraste de este móvil: aquí no se puede volver a guardar.';
  if (local === 'otra') return 'Otra foto de este móvil usa su identidad: aquí no se puede guardar.';
  if (local === 'ilegible') return 'No se pudo comprobar este móvil: ahora no se puede guardar.';
  return null;
}
