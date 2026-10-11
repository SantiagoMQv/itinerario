import type { Itinerario } from './tipos';
import type { ProgresoLocal, RegistroLocal } from './progreso-local';
import { capturarAcusePersistido, capturarInstantaneaProgreso, capturarOperacionProgreso,
  capturarRechazoPersistido, proyectarCola, recibirAcuse, recibirRechazo } from './progreso-cola';
import type { Cola, ResultadoCola } from './progreso-cola';
import { iguales } from './progreso-validacion';
import { parsearProgreso, serializarProgreso } from './progreso-json';

export interface ConfiguracionTransporteProgreso {
  readonly plan: Itinerario;
  readonly local: Pick<ProgresoLocal, 'leer' | 'marcarEnviada' | 'recibirInstantanea' | 'recibirAcuse' | 'recibirRechazo'>;
  /** IO de mismo origen: el adaptador debe respetar credentials y redirect; no se generan credenciales. */
  readonly http: (url: string, opciones: RequestInit) => Promise<Response>;
  /** Tiempo total de cada solicitud, incluidos sus bytes. Por defecto 30 segundos. */
  readonly timeoutMs?: number;
  /** Máximo de originales distintos por ciclo explícito; por defecto 100, nunca un retry automático. */
  readonly maxEnvios?: number;
  readonly alCambiar?: (estado: EstadoTransporteProgreso) => void | Promise<void>;
}
export interface EstadoTransporteProgreso {
  /** listo significa reposo del transporte, NO sincronización total ni observación del compañero. */
  readonly tipo: 'listo' | 'sincronizando' | 'incierto' | 'sin-sesion' | 'rechazo-manual' | 'cuarentena' | 'fallo-local' | 'cerrado';
  /** Solo prueba una lectura/escritura local completada; no salud futura de IDB ni del servidor. */
  readonly localDurable: boolean;
  /** Entradas retenidas, incluidas negativas y dependientes; cero no implica recepción del compañero. */
  readonly pendientes: number;
  readonly incertidumbre: boolean;
}
export interface TransporteProgreso {
  readonly estado: EstadoTransporteProgreso;
  sincronizar(): Promise<void>;
  /** Aborta IO y libera el observador, no cierra IDB ni revierte decisiones históricas. */
  cerrar(): void;
}

// El diario crece con recibos históricos. Admitimos 16 MiB por respuesta (no 8 KiB de operación).
// Superarlo es incertidumbre explícita, nunca truncamiento ni acuse; no compactamos historia.
const LIMITE_RESPUESTA = 16 * 1024 * 1024;
const fuerte = (valor: string | null): valor is string => valor !== null
  && /^"[\x21\x23-\x7e\x80-\xff]*"$/.test(valor) && valor.length <= 1024;
class FalloLocal extends Error {}
class SinSesion extends Error {}
class Cuarentena extends Error {}
const colaDe = (raiz: RegistroLocal): Cola => ({
  confirmado: { revisionServidor: raiz.revisionServidor, estado: raiz.confirmado }, entradas: raiz.cola,
});
const aceptado = (resultado: ResultadoCola, tipos: ResultadoCola['tipo'][]) => tipos.includes(resultado.tipo);

export function crearTransporteProgreso(configuracion: ConfiguracionTransporteProgreso): TransporteProgreso {
  const { plan, local, http } = configuracion;
  const timeoutMs = configuracion.timeoutMs ?? 30_000;
  const maxEnvios = configuracion.maxEnvios ?? 100;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 120_000
    || !Number.isSafeInteger(maxEnvios) || maxEnvios < 1 || maxEnvios > 1000) {
    throw new Error('Límites de transporte inválidos');
  }
  let observador = configuracion.alCambiar;
  let estado: EstadoTransporteProgreso = Object.freeze({ tipo: 'listo', localDurable: false,
    pendientes: 0, incertidumbre: false });
  let activo: Promise<void> | undefined;
  let controlador: AbortController | undefined;
  let cerrado = false;
  let cuarentena = false;
  // Una sola asociación GET validado + escritura durable. Ni POST ni estado optimista crean ETag.
  let etiqueta: string | undefined;
  function publicar(cambios: Partial<EstadoTransporteProgreso>) {
    estado = Object.freeze({ ...estado, ...cambios, ...(cerrado ? { tipo: 'cerrado' as const } : {}) });
    try { void Promise.resolve(observador?.(estado)).catch(() => {}); }
    catch { /* Un consumidor no altera el resultado durable ni filtra errores. */ }
  }
  async function durable<T>(accion: () => Promise<T>): Promise<T> {
    try { return await accion(); } catch { throw new FalloLocal(); }
  }
  async function leer(): Promise<Cola> {
    const raiz = await durable(() => local.leer());
    const resultado = proyectarCola(plan, colaDe(raiz));
    if (!resultado.cola || raiz.formato !== 3 || !iguales(raiz.estado, resultado.proyeccion?.estado)) throw new FalloLocal();
    publicar({ localDurable: true, pendientes: resultado.cola.entradas.length,
      incertidumbre: resultado.cola.entradas.some((e) => e.enviada && !e.rechazo) });
    return resultado.cola;
  }

  async function solicitar(method: 'GET' | 'POST', body?: string) {
    if (cerrado) throw new Error('Transporte cerrado');
    const actual = new AbortController(); controlador = actual;
    let cancelarLectura: (() => void) | undefined;
    let cancelar!: () => void;
    const aborto = new Promise<never>((_, reject) => {
      cancelar = () => { cancelarLectura?.(); reject(new Error('Solicitud incierta')); };
      actual.signal.addEventListener('abort', cancelar, { once: true });
    });
    const reloj = setTimeout(() => actual.abort(), timeoutMs);
    const trabajo = async () => {
      const respuesta = await http('/api/progreso', {
        method, credentials: 'same-origin', cache: 'no-store', redirect: 'error', signal: actual.signal,
        headers: { Accept: 'application/json', ...(method === 'POST' ? { 'Content-Type': 'application/json' } : {}),
          ...(method === 'GET' && etiqueta ? { 'If-None-Match': etiqueta } : {}) },
        ...(body === undefined ? {} : { body }),
      });
      if (actual.signal.aborted) throw new Error('Solicitud incierta');
      const descartar = () => { void respuesta.body?.cancel().catch(() => {}); };
      if (respuesta.redirected || respuesta.status >= 300 && respuesta.status !== 304 && respuesta.status < 400) {
        descartar(); throw new Error('Respuesta inesperada');
      }
      if (respuesta.status === 401) { descartar(); throw new SinSesion(); }
      const etag = respuesta.headers.get('ETag');
      if (method === 'GET' && respuesta.status === 304) {
        if (!etiqueta || etag !== etiqueta) { descartar(); throw new Error('304 sin asociación validada'); }
        return { status: 304, etag, valor: null };
      }
      if (!/^application\/json(?:\s*;|\s*$)/i.test(respuesta.headers.get('Content-Type') ?? '')
        || !respuesta.body) { descartar(); throw new Error('Respuesta inesperada'); }
      const lector = respuesta.body.getReader();
      cancelarLectura = () => { void lector.cancel().catch(() => {}); };
      const decodificador = new TextDecoder('utf-8', { fatal: true });
      let bytes = 0; let texto = '';
      try {
        for (;;) {
          const tramo = await lector.read();
          if (actual.signal.aborted) throw new Error('Solicitud incierta');
          if (tramo.done) break;
          bytes += tramo.value.byteLength;
          if (bytes > LIMITE_RESPUESTA) throw new Error('Respuesta demasiado grande');
          texto += decodificador.decode(tramo.value, { stream: true });
        }
        texto += decodificador.decode();
        return { status: respuesta.status, etag, valor: parsearProgreso(texto) };
      } finally {
        cancelarLectura(); cancelarLectura = undefined;
        lector.releaseLock();
      }
    };
    // Race instala handlers también en el perdedor: una promesa inyectada que ignora signal
    // no bloquea el ciclo ni produce rechazo sin manejar al terminar posteriormente.
    try { return await Promise.race([trabajo(), aborto]); }
    finally {
      clearTimeout(reloj); actual.signal.removeEventListener('abort', cancelar);
      if (controlador === actual) controlador = undefined;
    }
  }

  async function ciclo() {
    let postIncierto = false;
    publicar({ tipo: 'sincronizando' });
    try {
      await leer(); // Corrupción/fallo crítico: ninguna solicitud HTTP.
      if (cerrado) return;
      const lectura = await solicitar('GET');
      if (lectura.status !== 304) {
        // Invalidar primero: si la nueva captura/commit falla, no reutilizar una asociación vieja.
        etiqueta = undefined;
        const instantanea = capturarInstantaneaProgreso(plan, lectura.valor);
        if (lectura.status !== 200 || !instantanea || !fuerte(lectura.etag)) throw new Error('GET inválido');
        const resultado = await durable(() => local.recibirInstantanea(instantanea));
        if (!aceptado(resultado, ['actualizada', 'ignorada'])) throw new Error('Instantánea incompatible');
        etiqueta = lectura.etag;
      }
      const intentadas = new Set<string>();
      while (!cerrado && intentadas.size < maxEnvios) {
        const cola = await leer();
        const proyeccion = proyectarCola(plan, cola).proyeccion!;
        const entrada = cola.entradas.find((e) => !intentadas.has(e.operacion.id) && !e.rechazo && !e.resolucion
          && (e.enviada || !e.dependeDe.length
            && proyeccion.entradas.some((p) => p.operacionId === e.operacion.id && p.tipo === 'lista')));
        if (!entrada) break;
        intentadas.add(entrada.operacion.id);
        const marcada = await durable(() => local.marcarEnviada(entrada.operacion.id));
        if (marcada.tipo === 'invalida') throw new FalloLocal();
        if (!aceptado(marcada, ['enviada'])) continue; // El guard local observa cambios concurrentes.
        const original = marcada.cola?.entradas.find((e) => e.operacion.id === entrada.operacion.id);
        const operacion = capturarOperacionProgreso(original?.operacion);
        if (!operacion || !original?.enviada || original.rechazo || original.resolucion
          || !iguales(operacion, entrada.operacion)) throw new FalloLocal();
        if (cerrado) break;
        postIncierto = true;
        const respuesta = await solicitar('POST', serializarProgreso(operacion));
        if (respuesta.status === 409 && respuesta.valor !== null && typeof respuesta.valor === 'object'
          && Object.hasOwn(respuesta.valor, 'codigo')
          && (respuesta.valor as { codigo: unknown }).codigo === 'identidad-reutilizada') {
          cuarentena = true; throw new Cuarentena();
        }
        // Validación causal contra raíz fresca antes del driver real; status/forma solos no prueban original.
        const fresca = await leer();
        if (respuesta.status === 200) {
          const acuse = capturarAcusePersistido(plan, respuesta.valor);
          if (!acuse || acuse.operacionId !== operacion.id
            || !aceptado(recibirAcuse(plan, fresca, acuse), ['confirmada'])) throw new Error('Acuse incompatible');
          const resultado = await durable(() => local.recibirAcuse(acuse));
          if (!aceptado(resultado, ['confirmada'])) throw new Error('Acuse no confirmado localmente');
        } else if (respuesta.status === 409) {
          const rechazo = capturarRechazoPersistido(plan, respuesta.valor);
          if (!rechazo || rechazo.operacionId !== operacion.id || !iguales(rechazo.operacionOriginal, operacion)
            || !aceptado(recibirRechazo(plan, fresca, rechazo), ['rechazada'])) throw new Error('Rechazo incompatible');
          const resultado = await durable(() => local.recibirRechazo(rechazo));
          if (!aceptado(resultado, ['rechazada'])) throw new Error('Rechazo no registrado localmente');
          postIncierto = false;
          await leer(); publicar({ tipo: 'rechazo-manual' }); return;
        } else throw new Error('Respuesta sin decisión');
        postIncierto = false;
      }
      const final = await leer();
      publicar({ tipo: final.entradas.some((e) => e.rechazo && !e.resolucion) ? 'rechazo-manual' : 'listo',
        incertidumbre: final.entradas.some((e) => e.enviada && !e.rechazo) });
    } catch (error) {
      publicar({ tipo: error instanceof FalloLocal ? 'fallo-local' : error instanceof SinSesion ? 'sin-sesion'
        : error instanceof Cuarentena ? 'cuarentena' : 'incierto',
      ...(error instanceof FalloLocal ? { localDurable: false } : {}),
      incertidumbre: estado.incertidumbre || postIncierto || !(error instanceof FalloLocal) });
    }
  }
  return {
    get estado() { return estado; },
    sincronizar() {
      if (activo) return activo;
      if (cerrado || cuarentena) return Promise.resolve();
      // Diferir protege reentrada del observador: activo existe antes de la primera publicación.
      activo = Promise.resolve().then(ciclo).finally(() => { activo = undefined; });
      return activo;
    },
    cerrar() {
      cerrado = true; observador = undefined; controlador?.abort(); etiqueta = undefined;
      publicar({ tipo: 'cerrado' });
    },
  };
}
