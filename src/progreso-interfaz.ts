import { abrirProgresoLocal } from './progreso-local';
import type { ProgresoLocal, RegistroLocal } from './progreso-local';
import { crearTransporteProgreso } from './progreso-transporte';
import type { ConfiguracionTransporteProgreso, EstadoTransporteProgreso, TransporteProgreso } from './progreso-transporte';
import { proyectarCola } from './progreso-cola';
import type { Proyeccion } from './progreso-cola';
import { prepararDeshacer } from './progreso';
import type { EntradasLegadas, Marca, Operacion, ResultadoOperacion } from './progreso';
import type { Itinerario } from './tipos';

/**
 * Adaptador entre la interfaz y el progreso compartido: abre lo guardado en IndexedDB, construye
 * operaciones con las precondiciones de la raíz durable más reciente, deshace solo operaciones
 * propias y dispara el transporte. No toca el DOM; main.ts pinta a partir de `vista`.
 */

/** Claves de la versión anterior (localStorage). Se leen tal cual una vez y nunca se escriben ni se borran. */
export const CLAVES_LEGADAS = ['marcas', 'marcas-hora', 'pendientes-hechos'] as const;
/** Misma clave que servidor/entrada.ts: identidad del móvil. Es un metadato, no autoriza nada. */
export const CLAVE_DISPOSITIVO = 'identificador-dispositivo';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/**
 * Textos originales de las claves anteriores, sin interpretarlos: el importador conserva incluso
 * lo roto o desconocido. Si una lectura falla, queda constancia en `lectura-fallida` (la raíz
 * nueva no puede fingir que importó algo que no pudo leer).
 */
export function capturarLegado(almacen: Pick<Storage, 'getItem'> | null): EntradasLegadas {
  const entradas: Record<string, unknown> = {};
  const fallidas: string[] = [];
  for (const clave of CLAVES_LEGADAS) {
    try {
      const valor = almacen!.getItem(clave);
      if (valor !== null) entradas[clave] = valor;
    } catch {
      fallidas.push(clave);
    }
  }
  if (fallidas.length) entradas['lectura-fallida'] = fallidas;
  return entradas;
}

/** UUID v4 aleatorio; crypto.randomUUID solo existe en contextos seguros. */
export function uuidAleatorio(): string {
  if (typeof globalThis.crypto.randomUUID === 'function') return globalThis.crypto.randomUUID();
  const b = globalThis.crypto.getRandomValues(new Uint8Array(16));
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

/** Identidad estable del móvil; si no se puede guardar, vale solo para esta visita (y se dice). */
export function identidadDispositivo(almacen: Pick<Storage, 'getItem' | 'setItem'> | null, uuid: () => string) {
  try {
    const guardada = almacen!.getItem(CLAVE_DISPOSITIVO);
    if (guardada !== null && UUID.test(guardada)) return { id: guardada, duradera: true };
    const id = uuid();
    almacen!.setItem(CLAVE_DISPOSITIVO, id);
    if (almacen!.getItem(CLAVE_DISPOSITIVO) === id) return { id, duradera: true };
  } catch {
    // Almacenamiento bloqueado o lleno.
  }
  return { id: uuid(), duradera: false };
}

export type FaseProgreso = 'abriendo' | 'lista' | 'fallo-local' | 'cerrada';
/** Entradas de la cola que no se envían porque ya chocan en local (o dependen de una que choca). */
export interface Atascada {
  readonly operacionId: string;
  readonly tipo: 'conflicto' | 'invalida' | 'bloqueada';
  readonly motivo?: string;
}
export interface VistaProgreso {
  readonly fase: FaseProgreso;
  /** Última lectura durable de IndexedDB (nunca un estado optimista sin guardar). */
  readonly raiz: RegistroLocal | null;
  readonly transporte: EstadoTransporteProgreso | null;
  /** Hay una acción local en curso: las demás esperan. */
  readonly ocupado: boolean;
  readonly atascadas: readonly Atascada[];
}
/** `guardada`: la transacción de IndexedDB terminó. No dice nada del servidor ni del otro móvil. */
export type ResultadoAccion = { readonly tipo: 'guardada'; readonly operacionId: string; readonly sinCambio: boolean }
  | { readonly tipo: 'no-lista' | 'ocupada' | 'fallo-local' }
  | { readonly tipo: 'conflicto' | 'invalida'; readonly motivo: string };
export type ResultadoDeshacer = { readonly tipo: 'cancelada' | 'compensada' | 'sin-efecto' | 'no-aplicada' | 'no-lista' | 'ocupada' | 'fallo-local' }
  | { readonly tipo: 'conflicto'; readonly motivo: string };
export interface OpcionesInterfaz {
  readonly plan: Itinerario;
  readonly dispositivoId: string;
  /** Captura de capturarLegado: solo se usa si todavía no existe la raíz de este viaje. */
  readonly entradasLegadas: EntradasLegadas;
  readonly http: ConfiguracionTransporteProgreso['http'];
  readonly fabrica?: IDBFactory | null;
  readonly nombre?: string;
  readonly uuid?: () => string;
  readonly timeoutMs?: number;
  readonly alCambiar?: (vista: VistaProgreso) => void;
}
export interface ProgresoInterfaz {
  readonly vista: VistaProgreso;
  /** Abre (o reabre tras un fallo) lo guardado en este móvil. Nunca crea una raíz vacía sobre una rota. */
  abrir(): Promise<void>;
  /** `horaReal`: minutos de China, metadato de la marca, nunca orden ni precondición. */
  marcarParada(paradaId: string, marca: Marca | null, horaReal?: number): Promise<ResultadoAccion>;
  marcarPendiente(pendienteId: string, hecho: boolean): Promise<ResultadoAccion>;
  /** Cancela la intención si no salió del móvil; si ya salió, envía el inverso de su recibo actual. */
  deshacer(operacionId: string): Promise<ResultadoDeshacer>;
  /** Revisión manual de un rechazo del servidor: conserva lo confirmado, sin reenviar ni reformular. */
  conservarConfirmado(operacionId: string): Promise<ResultadoAccion>;
  /** Descarta una intención no enviada que ya choca en local. */
  descartar(operacionId: string): Promise<ResultadoAccion>;
  /** Sincronización explícita; una petición durante un ciclo activo provoca un único ciclo más. */
  sincronizar(): Promise<void>;
  /** Vuelve a leer la raíz durable (otra pestaña pudo cambiarla). */
  refrescar(): Promise<void>;
  cerrar(): void;
}

const propio = <T>(registros: Readonly<Record<string, T>>, id: string): T | undefined =>
  Object.hasOwn(registros, id) ? registros[id] : undefined;

export function crearProgresoInterfaz(opciones: OpcionesInterfaz): ProgresoInterfaz {
  const { plan, dispositivoId, entradasLegadas, http } = opciones;
  const uuid = opciones.uuid ?? uuidAleatorio;
  let vista: VistaProgreso = Object.freeze({ fase: 'abriendo', raiz: null, transporte: null, ocupado: false, atascadas: [] });
  let local: ProgresoLocal | undefined;
  let transporte: TransporteProgreso | undefined;
  // Cada apertura es una generación: avisos y lecturas de una anterior se ignoran.
  let generacion = 0;
  let apertura: Promise<void> | undefined;
  let lecturas = 0;
  let aplicada = 0;
  /** Ciclos de sincronización de una apertura; `otraVez` agrupa lo pedido mientras dura. */
  let bucle: { readonly gen: number; otraVez: boolean; promesa?: Promise<void> } | undefined;

  function publicar(cambios: Partial<VistaProgreso>) {
    if (vista.fase === 'cerrada') return;
    vista = Object.freeze({ ...vista, ...cambios });
    try { opciones.alCambiar?.(vista); } catch { /* La interfaz no altera lo durable. */ }
  }
  function atascadasDe(raiz: RegistroLocal): Atascada[] {
    const cola = { confirmado: { revisionServidor: raiz.revisionServidor, estado: raiz.confirmado }, entradas: raiz.cola };
    const proyeccion: Proyeccion | undefined = proyectarCola(plan, cola).proyeccion;
    return (proyeccion?.entradas ?? []).flatMap((e) => {
      const entrada = raiz.cola.find((c) => c.operacion.id === e.operacionId);
      if (!entrada || entrada.enviada || (e.tipo !== 'conflicto' && e.tipo !== 'invalida' && e.tipo !== 'bloqueada')) return [];
      return [{ operacionId: e.operacionId, tipo: e.tipo, ...(e.motivo ? { motivo: e.motivo } : {}) }];
    });
  }
  /** Lee la raíz durable; una lectura más antigua nunca pisa a una más reciente. */
  async function leerDurable(gen: number) {
    if (!local || gen !== generacion) return;
    const numero = ++lecturas;
    const raiz = await local.leer();
    if (gen !== generacion || numero < aplicada) return;
    aplicada = numero;
    publicar({ raiz, atascadas: atascadasDe(raiz) });
  }
  function falloLocal(gen: number) {
    if (gen === generacion) publicar({ fase: 'fallo-local', ocupado: false });
  }

  function abrir(): Promise<void> {
    if (vista.fase === 'cerrada') return Promise.resolve();
    if (apertura) return apertura;
    const gen = ++generacion;
    transporte?.cerrar();
    local?.cerrar();
    transporte = undefined;
    local = undefined;
    publicar({ fase: 'abriendo', transporte: null, ocupado: false });
    apertura = (async () => {
      try {
        const abierto = await abrirProgresoLocal(plan, { fabrica: opciones.fabrica, nombre: opciones.nombre,
          dispositivoId, uuid, entradasLegadas });
        if (gen !== generacion || vista.fase === 'cerrada') { abierto.cerrar(); return; }
        local = abierto;
        await leerDurable(gen);
        transporte = crearTransporteProgreso({ plan, local, http, timeoutMs: opciones.timeoutMs,
          alCambiar: (estado) => { if (gen === generacion) publicar({ transporte: estado }); } });
        publicar({ fase: 'lista', transporte: transporte.estado });
      } catch {
        // Sin respaldo en localStorage ni raíz nueva sobre una rota: fallo visible y reintento explícito.
        local?.cerrar();
        local = undefined;
        falloLocal(gen);
      } finally {
        apertura = undefined;
      }
    })();
    return apertura;
  }

  /** Una sola acción local a la vez, siempre sobre la raíz durable más reciente. */
  async function accion<T extends { tipo: string }>(trabajo: (local: ProgresoLocal) => Promise<T>): Promise<T | { tipo: 'no-lista' | 'ocupada' | 'fallo-local' }> {
    if (vista.fase !== 'lista' || !local) return { tipo: 'no-lista' };
    if (vista.ocupado) return { tipo: 'ocupada' };
    const gen = generacion;
    const almacen = local;
    publicar({ ocupado: true });
    let resultado: T | { tipo: 'fallo-local' };
    try {
      resultado = await trabajo(almacen);
      if (gen !== generacion) return resultado;
      publicar({ ocupado: false });
      await leerDurable(gen);
    } catch {
      falloLocal(gen);
      return { tipo: 'fallo-local' };
    }
    return resultado;
  }
  function guardada(operacionId: string, resultado: ResultadoOperacion): ResultadoAccion {
    if (resultado.tipo === 'conflicto' || resultado.tipo === 'invalida') return { tipo: resultado.tipo, motivo: resultado.motivo };
    return { tipo: 'guardada', operacionId, sinCambio: resultado.tipo !== 'aplicada' };
  }
  async function despues<T extends { tipo: string }>(resultado: T): Promise<T> {
    if (resultado.tipo === 'guardada' || resultado.tipo === 'compensada') void sincronizar();
    return resultado;
  }

  function sincronizar(): Promise<void> {
    // Sin raíz abierta ni transporte (abriendo, fallo local o cerrada) no hay ciclo posible: no se
    // crea ni se guarda ninguna promesa, así que la próxima petición, ya abierta, sí sincroniza.
    if (vista.fase !== 'lista' || !transporte) return Promise.resolve();
    const gen = generacion;
    if (bucle && bucle.gen === gen) {
      // Durante un ciclo activo, cualquier número de peticiones produce un único ciclo más.
      bucle.otraVez = true;
      return bucle.promesa ?? Promise.resolve();
    }
    const propio: NonNullable<typeof bucle> = { gen, otraVez: true };
    bucle = propio;
    const promesa = (async () => {
      try {
        while (propio.otraVez && transporte && gen === generacion && vista.fase === 'lista') {
          propio.otraVez = false;
          await transporte.sincronizar();
          await leerDurable(gen);
        }
      } catch {
        falloLocal(gen);
      } finally {
        // Solo libera su propio bucle: nunca el de una apertura posterior.
        if (bucle === propio) bucle = undefined;
      }
    })();
    // Si terminó sin esperar nada ya se liberó: no queda una promesa resuelta como candado.
    if (bucle === propio) propio.promesa = promesa;
    return promesa;
  }

  return {
    get vista() { return vista; },
    abrir,
    marcarParada: async (paradaId, marca, horaReal) => despues(await accion(async (almacen) => {
      const { estado } = await almacen.leer();
      const registro = propio(estado.paradas, paradaId) ?? { marca: null, revision: 0 };
      const anterior = estado.aqui.paradaId;
      const operacion: Operacion = { id: uuid(), dispositivoId, tipo: 'parada', paradaId, marca, revision: registro.revision,
        ...(horaReal !== undefined && marca !== null ? { horaReal } : {}),
        ...(marca === 'aqui' || anterior === paradaId ? { revisionAqui: estado.aqui.revision } : {}),
        ...(marca === 'aqui' && anterior !== null && anterior !== paradaId
          ? { revisionAnterior: (propio(estado.paradas, anterior) ?? { revision: 0 }).revision } : {}) };
      return guardada(operacion.id, await almacen.registrar(operacion));
    })),
    marcarPendiente: async (pendienteId, hecho) => despues(await accion(async (almacen) => {
      const { estado } = await almacen.leer();
      const registro = propio(estado.pendientes, pendienteId) ?? { hecho: false, revision: 0 };
      const operacion: Operacion = { id: uuid(), dispositivoId, tipo: 'pendiente', pendienteId, hecho, revision: registro.revision };
      return guardada(operacion.id, await almacen.registrar(operacion));
    })),
    deshacer: async (operacionId) => despues(await accion(async (almacen): Promise<ResultadoDeshacer> => {
      const raiz = await almacen.leer();
      const entrada = raiz.cola.find((e) => e.operacion.id === operacionId);
      if (entrada?.rechazo) return { tipo: 'no-aplicada' };
      if (entrada && !entrada.enviada) {
        // Solo una hoja que no salió del móvil se puede retirar sin rastro.
        if ((await almacen.cancelarIntencion(operacionId)).tipo === 'cancelada') return { tipo: 'cancelada' };
      }
      const fresca = await almacen.leer();
      const acuse = propio(fresca.estado.operaciones, operacionId);
      if (!acuse) return { tipo: 'no-aplicada' };
      if (!acuse.cambios) return { tipo: 'sin-efecto' };
      // Inverso del recibo ACTUAL (puede venir del servidor), con sus revisiones como precondición.
      const resultado = await almacen.registrar(prepararDeshacer(acuse.cambios, uuid(), dispositivoId));
      if (resultado.tipo === 'aplicada') return { tipo: 'compensada' };
      if (resultado.tipo === 'conflicto' || resultado.tipo === 'invalida') return { tipo: 'conflicto', motivo: resultado.motivo };
      return { tipo: 'sin-efecto' };
    })),
    conservarConfirmado: async (operacionId) => accion(async (almacen): Promise<ResultadoAccion> => {
      const r = await almacen.resolverRechazo(operacionId);
      return r.tipo === 'resuelta' ? { tipo: 'guardada', operacionId, sinCambio: false }
        : { tipo: 'conflicto', motivo: r.motivo ?? 'No hay un rechazo pendiente con ese ID' };
    }),
    descartar: async (operacionId) => accion(async (almacen): Promise<ResultadoAccion> => {
      const r = await almacen.cancelarIntencion(operacionId);
      return r.tipo === 'cancelada' ? { tipo: 'guardada', operacionId, sinCambio: false }
        : { tipo: 'conflicto', motivo: r.motivo ?? 'No se puede descartar' };
    }),
    sincronizar,
    refrescar: async () => {
      const gen = generacion;
      try { await leerDurable(gen); } catch { falloLocal(gen); }
    },
    cerrar() {
      generacion++;
      transporte?.cerrar();
      local?.cerrar();
      transporte = undefined;
      local = undefined;
      vista = Object.freeze({ ...vista, fase: 'cerrada', ocupado: false });
    },
  };
}

export interface ResumenCompartido {
  /** Texto de una línea para la píldora; null cuando no hay nada que pedir al viajero. */
  readonly pildora: string | null;
  readonly detalle: string;
  readonly accion: 'sincronizar' | 'entrar' | 'reintentar' | 'revisar' | null;
  readonly ocupado: boolean;
}

/**
 * Lo que la interfaz dice del progreso compartido. Distingue guardado aquí, sin enviar, sin
 * confirmar, sin sesión, fallo local, rechazo y cuarentena. Nunca afirma que el otro móvil vio
 * algo: un acuse prueba que el servidor lo guardó, no que el compañero lo haya recibido.
 * `enLinea` es solo un indicio (navigator.onLine), nunca una prueba de conexión.
 */
export function resumenCompartido(v: VistaProgreso, enLinea: boolean): ResumenCompartido {
  const t = v.transporte;
  const ocupado = t?.tipo === 'sincronizando';
  if (v.fase === 'abriendo') return { pildora: null, detalle: 'Abriendo lo marcado en este móvil…', accion: null, ocupado: true };
  if (v.fase === 'cerrada') return { pildora: null, detalle: '', accion: null, ocupado: false };
  if (v.fase === 'fallo-local' || t?.tipo === 'fallo-local' || !v.raiz) {
    return { pildora: 'Marcas sin abrir', accion: 'reintentar', ocupado: false,
      detalle: 'No se pudo abrir lo marcado en este móvil. El itinerario, el mapa y la tarjeta del taxi siguen funcionando, pero no se puede marcar hasta abrirlo.' };
  }
  const cola = v.raiz.cola;
  const rechazadas = cola.filter((e) => e.rechazo && !e.resolucion).length;
  const sinConfirmar = cola.filter((e) => e.enviada && !e.rechazo).length;
  const atascadas = new Set(v.atascadas.map((a) => a.operacionId));
  const sinEnviar = cola.filter((e) => !e.enviada && !e.rechazo && !atascadas.has(e.operacion.id)).length;
  const cambios = (n: number) => `${n} cambio${n === 1 ? '' : 's'}`;
  // Un rechazo o un choque manda en la píldora, pero no oculta otros cambios enviados sin respuesta.
  const tambienIncierto = sinConfirmar
    ? ` Además, ${sinConfirmar} sin confirmar: ${sinConfirmar === 1 ? 'se envió sin respuesta y se reenvía' : 'se enviaron sin respuesta y se reenvían'} tal cual al sincronizar.`
    : '';
  if (rechazadas) {
    return { pildora: rechazadas === 1 ? 'Un cambio no se aplicó' : `${rechazadas} cambios no se aplicaron`, accion: 'revisar', ocupado,
      detalle: `${rechazadas === 1 ? 'Un cambio de este móvil no se aplicó' : `${cambios(rechazadas)} de este móvil no se aplicaron`}: el servidor ya tenía otro cambio en lo mismo, del otro móvil o anterior. No se reintenta solo: hay que revisarlo y conservar lo del servidor.${tambienIncierto}` };
  }
  if (atascadas.size) {
    return { pildora: atascadas.size === 1 ? 'Un cambio choca' : `${atascadas.size} cambios chocan`, accion: 'revisar', ocupado,
      detalle: `${atascadas.size === 1 ? 'Un cambio guardado en este móvil choca' : `${cambios(atascadas.size)} guardados en este móvil chocan`} con lo que ya está en el servidor y no se envía. Se puede descartar en «Compartido».${tambienIncierto}` };
  }
  if (t?.tipo === 'cuarentena') {
    return { pildora: 'Cambio apartado', accion: null, ocupado: false,
      detalle: 'El servidor ya tenía otro cambio con la misma identidad. Este móvil no lo reenvía ni envía nada más hasta volver a abrir la app; lo marcado sigue guardado aquí.' };
  }
  const pendientes = sinEnviar + sinConfirmar;
  if (t?.tipo === 'sin-sesion') {
    return { pildora: `Sin sesión${pendientes ? ` · ${pendientes} sin enviar` : ''}`, accion: enLinea ? 'entrar' : null, ocupado: false,
      detalle: 'Este móvil no tiene sesión en el servidor: lo marcado se guarda aquí y se enviará al volver a entrar. Lo que ya está en el móvil sigue disponible.' };
  }
  if (sinConfirmar) {
    return { pildora: 'Sin confirmar', accion: 'sincronizar', ocupado,
      detalle: `${cambios(sinConfirmar)} ${sinConfirmar === 1 ? 'se envió' : 'se enviaron'} sin respuesta. Al sincronizar se reenvían tal cual; el servidor no aplica dos veces el mismo cambio.` };
  }
  if (sinEnviar) {
    return { pildora: enLinea ? `${sinEnviar} sin enviar` : `Sin conexión · ${sinEnviar} sin enviar`, accion: 'sincronizar', ocupado,
      detalle: `${cambios(sinEnviar)} ${sinEnviar === 1 ? 'guardado' : 'guardados'} en este móvil, sin enviar todavía al servidor.` };
  }
  return { pildora: null, accion: 'sincronizar', ocupado,
    detalle: ocupado ? 'Sincronizando…'
      : t?.tipo === 'incierto' ? 'No se pudo comprobar con el servidor. Lo marcado en este móvil está guardado aquí.'
        : 'Nada por enviar desde este móvil. Lo que marque el otro móvil llega al sincronizar.' };
}
