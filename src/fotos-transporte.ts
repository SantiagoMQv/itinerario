import type { Itinerario } from './tipos';
import { camposFoto, copiarMetadatos, tamanoBlob, tipoBlob } from './fotos';
import { comprobarIdentidadFoto, type LecturasIdentidadFoto } from './fotos-identidad';
import { copiarCondicionesEnvio, ErrorAdmisionRespaldo, type CondicionesEnvio,
  type RespaldoFotosLocal } from './fotos-respaldo-local';
import { copiarEntradaRespaldo, copiarOriginalRespaldo, copiarReferenciaRespaldo, mismosOriginalesRespaldo,
  type EntradaRespaldo, type ReferenciaRespaldo } from './fotos-respaldo';
import { MAX_BYTES_JSON_RESPALDO, deserializarReciboRespaldo, reciboCorrespondeASolicitud,
  serializarSolicitudRespaldo } from './fotos-protocolo';

export interface OpcionesTransporteFotos {
  readonly plan: Itinerario;
  /** Origen confiable configurado por composición, sin ruta/query/hash/userinfo.
   * En navegador debe coincidir con location.origin. HTTP loopback sirve solo a pruebas locales. */
  readonly origen: string;
  /** Lecturas frescas: original vivo inmutable, tombstone definitivo, no ABA. No cierra este puerto. */
  readonly fuente: LecturasIdentidadFoto | null;
  /** Puerto durable propio del llamador: promesas de escritura resueltas después de TX.oncomplete. */
  readonly ledger: RespaldoFotosLocal | null;
  /** Puerto HTTP confiable; undefined captura fetch nativo AL CREAR, null expresa indisponibilidad.
   * Response sintética con url vacía se acepta en este puerto estructural: no prueba autenticación.
   * No inyectar JSON importado, código de usuario ni simulaciones en composición de producción. */
  readonly fetch?: typeof fetch | null;
  /** Política de producto opcional, finita y no negativa; no es techo de resolución/megapíxeles. */
  readonly maxBytesOriginal?: number;
  /** Plazo del POST y de la lectura de su acuse, entero positivo en ms (la composición pasa el de su cliente).
   * Al vencer se aborta: no prueba ausencia remota y, si ya salió, queda incierto. Omitido: sin plazo propio. */
  readonly plazoMs?: number;
}
export interface EstimacionTransporteFotos {
  readonly bytesOriginal: number;
  readonly bytesSolicitud: number;
  readonly bytesPayloadConocido: number;
  /** Multipart, headers, TLS y facturación desconocidos: no progreso real ni bytes subidos. */
  readonly traficoFacturable: 'desconocido';
}
export interface TransporteFotos {
  /** Acción explícita solo de metadata; no lee PhotoDB ni red, no reserva ni prepara operaciones. */
  estimar(referencia: ReferenciaRespaldo): EstimacionTransporteFotos;
  /** Envía solo una referencia ya preparada y no pausada. No programa ni reintenta automáticamente.
   * Con `soloPreparada` (el lote), solo si sigue preparada sin envío: se exige en el reclamo durable, no en una
   * lectura previa; si no, rechaza «sin-envio» con causa «admision» y no hace POST. */
  subir(referencia: ReferenciaRespaldo, condiciones?: CondicionesEnvio): Promise<EntradaRespaldo>;
  /** Única acción que quita pausa durable; conserva operación y payload originales. */
  reintentar(referencia: ReferenciaRespaldo): Promise<EntradaRespaldo>;
  /** Invalida primero la carga local y aborta; espera intención durable, no rollback remoto. */
  pausar(referencia: ReferenciaRespaldo): Promise<EntradaRespaldo>;
  /** Descarta ACK tardío y aborta. Nunca borra testigo enviada ni promete ausencia de costes. */
  cancelar(): void;
  /** Solo ownership/controller: no cierra puertos del usuario ni modifica su historia. */
  cerrar(): void;
}
/** sin-envio describe solo esta invocación antes de hallar testigo, no ausencia remota.
 * detenida tampoco revoca IO/confirmación ya iniciados. Consultar siempre el ledger durable. */
export class ErrorTransporteFotos extends Error {
  /** `causa`, cuando importa a quien llama: 401 del endpoint exacto («sin-sesion»), plazo vencido («plazo») o
   * una operación que ya no estaba preparada sin envío cuando el lote fue a reclamarla («admision»). */
  constructor(mensaje: string, readonly estado: 'sin-envio' | 'incierta' | 'detenida',
    readonly causa?: 'sin-sesion' | 'plazo' | 'admision') {
    super(mensaje); this.name = 'ErrorTransporteFotos';
  }
}
interface Carga {
  readonly ref: ReferenciaRespaldo;
  /** Condición del lote: solo una operación preparada sin envío ni pausa. */
  readonly soloPreparada: boolean;
  readonly controlador: AbortController;
  detenida: boolean;
  /** Conservador: puede existir testigo durable incluso si el puerto pierde su respuesta. */
  marcadorIniciado: boolean;
  /** Venció el plazo del POST (y por eso se abortó). */
  vencida?: boolean;
}

/** Biblioteca manual, sin UI, eventos globales, singleton, apertura de DB ni IO en constructor.
 * POST futuro: FormData EXACTA (solicitud STRING UTF-8 <=64 KiB; original binario).
 * El navegador genera boundary. Nombre/MIME raw exclusivamente en JSON, no headers multipart.
 * Exige 200/201 JSON no-store, ruta exacta sin redirect y acuse vinculado con ambos commits true.
 * Esto NO autentica JSON criptográficamente ni implementa sesión: producción requiere TLS,
 * cookie Secure/HttpOnly same-origin y sesión viva comprobada por servidor (unidad futura/T7).
 * Servidor deberá crear objeto condicionalmente, comprobar colisiones por TODOS los bytes y
 * confirmar metadata SQL durable. Size/MIME/ETag/GET/200 solos no lo prueban.
 * Una sola carga por instancia, no exclusión distribuida entre pestañas/instancias. Ledger fresco
 * antes de IO no observa pausas ajenas posteriores: no subscriptions, polling ni bus global.
 * GET manual protegido queda diferido: este módulo NO completa T6 ni descarga originales. */
export function crearTransporteFotos(opciones: OpcionesTransporteFotos): TransporteFotos {
  const obligatorias = ['plan', 'origen', 'fuente', 'ledger'];
  const opcionales = ['fetch', 'maxBytesOriginal', 'plazoMs'];
  const claves = typeof opciones === 'object' && opciones !== null ? Reflect.ownKeys(opciones) : [];
  if (claves.some((k) => typeof k !== 'string' || ![...obligatorias, ...opcionales].includes(k))
    || !obligatorias.every((k) => claves.includes(k))
    || !camposFoto(opciones, claves as string[])) throw new Error('Opciones de transporte inválidas');
  const plan = structuredClone(opciones.plan);
  const origen = opciones.origen;
  const url = typeof origen === 'string' ? new URL(origen) : null;
  if (!url || !['https:', 'http:'].includes(url.protocol) || url.origin !== origen
    || url.username || url.password || url.search || url.hash
    || (typeof location !== 'undefined' && location.origin !== origen)) {
    throw new Error('Origen confiable inválido o distinto del contexto');
  }
  const limite = opciones.maxBytesOriginal;
  if (limite !== undefined && (typeof limite !== 'number' || !Number.isFinite(limite) || limite < 0)) {
    throw new Error('Límite de original inválido');
  }
  const plazoMs = opciones.plazoMs;
  if (plazoMs !== undefined && (!Number.isSafeInteger(plazoMs) || plazoMs < 1 || plazoMs > 2147483647)) {
    throw new Error('Plazo de envío inválido');
  }
  const fuente = opciones.fuente; const ledger = opciones.ledger;
  const httpInyectado = typeof opciones.fetch === 'function';
  const enviar = opciones.fetch === undefined ? globalThis.fetch?.bind(globalThis) : opciones.fetch;
  const endpoint = `${origen}/api/fotos/respaldo`;
  let cerrada = false; let activa: Carga | null = null;
  // Intenciones pendientes de esta instancia, no outbox ni autoridad entre pestañas.
  const pausasPendientes = new Set<ReferenciaRespaldo>();
  function abierta() { if (cerrada) throw new ErrorTransporteFotos('Transporte cerrado', 'detenida'); }
  function vigente(c: Carga) {
    if (cerrada || activa !== c || c.detenida || c.controlador.signal.aborted) {
      throw new ErrorTransporteFotos('Carga detenida; aborto no demuestra ausencia remota', 'detenida');
    }
  }
  function misma(a: ReferenciaRespaldo, b: ReferenciaRespaldo) {
    return Object.is(a.fotoId, b.fotoId) && Object.is(a.operacionId, b.operacionId)
      && mismosOriginalesRespaldo(plan, a.original, b.original);
  }
  function solicitud(ref: ReferenciaRespaldo) {
    return { version: 1 as const, tipo: 'solicitud-respaldo' as const, viajeId: plan.id, ...ref };
  }
  function presupuesto(ref: ReferenciaRespaldo): EstimacionTransporteFotos {
    const texto = serializarSolicitudRespaldo(plan, solicitud(ref));
    if (limite !== undefined && ref.original.bytesOriginal > limite) throw new Error('Original supera política de producto');
    const bytesSolicitud = new TextEncoder().encode(texto).byteLength;
    return { bytesOriginal: ref.original.bytesOriginal, bytesSolicitud,
      bytesPayloadConocido: ref.original.bytesOriginal + bytesSolicitud, traficoFacturable: 'desconocido' };
  }
  function comprobarEntrada(valor: unknown, ref: ReferenciaRespaldo): EntradaRespaldo {
    const e = copiarEntradaRespaldo(plan, valor);
    if (!misma(e, ref) || e.pausada || e.fase === 'bloqueada' || e.fase === 'respaldada') {
      throw new Error('Referencia cambiada, pausada, bloqueada o ya respaldada');
    }
    return e;
  }
  const admisionRechazada = () => new ErrorTransporteFotos(
    'La operación ya no está preparada sin envío; el lote no la envía', 'sin-envio', 'admision');
  /** Antes del reclamo: con la condición del lote, solo una preparada sin envío (corta antes de leer bytes). */
  function comprobarPrevia(valor: unknown, c: Carga): EntradaRespaldo {
    if (!c.soloPreparada) return comprobarEntrada(valor, c.ref);
    let e: EntradaRespaldo;
    try { e = comprobarEntrada(valor, c.ref); } catch { throw admisionRechazada(); }
    if (e.fase !== 'preparado' || e.enviada) throw admisionRechazada();
    return e;
  }
  /** El reclamo durable: la condición se comprueba DENTRO de su transacción (no basta una lectura anterior). */
  async function reclamar(c: Carga, ledgerPropio: RespaldoFotosLocal): Promise<EntradaRespaldo> {
    try {
      return await esperar(c, c.soloPreparada ? ledgerPropio.marcarEnviada(c.ref, { soloPreparada: true })
        : ledgerPropio.marcarEnviada(c.ref));
    } catch (e) {
      if (e instanceof ErrorAdmisionRespaldo) throw admisionRechazada();
      throw e;
    }
  }
  async function esperar<T>(c: Carga, promesa: Promise<T>, liberar?: (valor: T) => Promise<void>): Promise<T> {
    try {
      const valor = await promesa;
      try { vigente(c); } catch (e) { if (liberar) await liberar(valor); throw e; }
      return valor;
    } catch (e) { vigente(c); throw e; }
  }
  function detener(c: Carga | null) {
    if (c) { c.detenida = true; c.controlador.abort(); }
    // No libera ownership hasta finally: fetch inyectado puede ignorar abort y contestar tarde.
  }
  async function textoAcotado(respuesta: Response, c: Carga): Promise<string> {
    if (!respuesta.body) throw new Error('Acuse sin cuerpo');
    const lector = respuesta.body.getReader();
    const decodificador = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
    let bytes = 0; let texto = ''; let completa = false;
    const abortar = () => { void lector.cancel().catch(() => {}); };
    c.controlador.signal.addEventListener('abort', abortar, { once: true });
    try {
      for (;;) {
        const bloque = await esperar(c, lector.read());
        if (bloque.done) { completa = true; break; }
        bytes += bloque.value.byteLength;
        if (bytes > MAX_BYTES_JSON_RESPALDO) throw new Error('Acuse supera 64 KiB UTF-8');
        texto += decodificador.decode(bloque.value, { stream: true });
      }
      texto += decodificador.decode(); vigente(c); return texto;
    } finally {
      c.controlador.signal.removeEventListener('abort', abortar);
      if (!completa) { await lector.cancel().catch(() => {}); }
      lector.releaseLock();
      // El llamador revalida también después del await que incluye esta limpieza.
    }
    // Se acota lo leído antes de text/parse; no se promete límite de chunk/heap interno del navegador.
  }
  async function ejecutar(c: Carga, retry: boolean): Promise<EntradaRespaldo> {
    let plazo: ReturnType<typeof setTimeout> | null = null;
    try {
      if (!fuente || !ledger || typeof enviar !== 'function') throw new Error('Fuente, ledger o fetch no disponibles');
      vigente(c); presupuesto(c.ref);
      // Retry nunca se llama desde catch ni desde apertura/constructor/estimación.
      const anterior = await esperar(c, ledger.leer(c.ref.fotoId));
      if (!anterior || !misma(copiarEntradaRespaldo(plan, anterior), c.ref)) throw new Error('Referencia no existente o cambiada');
      // Una invocación sin IO nuevo no elimina la incertidumbre de un envío histórico.
      c.marcadorIniciado = anterior.enviada;
      if (retry) {
        if (anterior.fase === 'bloqueada' || anterior.fase === 'respaldada') throw new Error('Estado no reintentable');
        comprobarEntrada(await esperar(c, ledger.reintentar(c.ref)), c.ref);
      } else comprobarPrevia(anterior, c);
      const metadata = copiarMetadatos(plan, await esperar(c, fuente.leerMetadatos(c.ref.fotoId)));
      if (!mismosOriginalesRespaldo(plan, copiarOriginalRespaldo(plan, metadata), c.ref.original)) {
        throw new Error('Metadata original cambió');
      }
      const original = await esperar(c, fuente.leerOriginal(c.ref.fotoId));
      if (tamanoBlob(original) !== metadata.bytesOriginal || tipoBlob(original as Blob) !== metadata.mimeDeclarado) {
        throw new Error('Original local incompatible');
      }
      const lecturas: LecturasIdentidadFoto = {
        leerMetadatos: (id) => esperar(c, fuente.leerMetadatos(id)),
        leerOriginal: (id) => esperar(c, fuente.leerOriginal(id)),
      };
      const identidad = await esperar(c, comprobarIdentidadFoto(plan, lecturas, metadata, original));
      if (identidad.tipo !== 'misma') throw new Error('Original no atestado contra fuente viva');
      comprobarPrevia(await esperar(c, ledger.leer(c.ref.fotoId)), c);
      const cuerpo = new FormData();
      cuerpo.append('solicitud', serializarSolicitudRespaldo(plan, solicitud(c.ref)));
      // Slice nativo cambia solo MIME del wrapper, sin arrayBuffer, reencode ni copia persistida.
      const binario = Blob.prototype.slice.call(original, 0, metadata.bytesOriginal, 'application/octet-stream') as Blob;
      cuerpo.append('original', binario, 'original');
      c.marcadorIniciado = true;
      // Desde aquí el marcador es propio: las lecturas siguientes aceptan la «enviada» que acaba de escribir.
      comprobarEntrada(await reclamar(c, ledger), c.ref);
      // Última lectura antes de IO, detecta pausa de otra instancia ya completada (no garantía distribuida).
      comprobarEntrada(await esperar(c, ledger.leer(c.ref.fotoId)), c.ref); vigente(c);
      // Plazo finito del POST y de su acuse: al vencer se aborta; el ownership sigue hasta que asiente.
      if (plazoMs !== undefined) plazo = setTimeout(() => { c.vencida = true; detener(c); }, plazoMs);
      const respuesta = await esperar(c, enviar(endpoint, { method: 'POST', body: cuerpo,
        headers: { Accept: 'application/json' }, credentials: 'same-origin', cache: 'no-store',
        redirect: 'error', signal: c.controlador.signal }), async (r) => {
        // Puertos inyectados pueden ignorar abort: liberar cuerpo tardío sin procesarlo como ACK.
        if (r instanceof Response) await r.body?.cancel().catch(() => {});
      });
      const propia = respuesta instanceof Response && !respuesta.redirected
        && (respuesta.url === '' ? httpInyectado : respuesta.url === endpoint);
      if (propia && respuesta.status === 401) {
        // Sesión no válida en el endpoint exacto: tipado para quien llama; si ya había salido, sigue incierto.
        await esperar(c, respuesta.body?.cancel() ?? Promise.resolve());
        throw new ErrorTransporteFotos('Sin sesión válida para el respaldo', c.marcadorIniciado ? 'incierta' : 'sin-envio', 'sin-sesion');
      }
      if (!(respuesta instanceof Response) || ![200, 201].includes(respuesta.status)
        || respuesta.redirected || (respuesta.url === '' ? !httpInyectado : respuesta.url !== endpoint)
        || respuesta.headers.get('content-type')?.split(';')[0].trim().toLowerCase() !== 'application/json'
        || !respuesta.headers.get('cache-control')?.split(',').some((v) => v.trim().toLowerCase() === 'no-store')) {
        if (respuesta instanceof Response) await esperar(c, respuesta.body?.cancel() ?? Promise.resolve());
        throw new Error('Respuesta HTTP no admisible como acuse');
      }
      const texto = await esperar(c, textoAcotado(respuesta, c));
      // El acuse ya está leído: el plazo no corta la confirmación durable local.
      if (plazo !== null) { clearTimeout(plazo); plazo = null; }
      const recibo = deserializarReciboRespaldo(plan, texto); vigente(c);
      // Política explícita: toda contradicción se rechaza SIN ACK; no bloquea otro job ni llama
      // confirmarRecibo con un payload contradictorio. Conserva enviada incierta y pruebas previas.
      if (!reciboCorrespondeASolicitud(plan, solicitud(c.ref), recibo)) throw new Error('Acuse de otra referencia o contradictorio');
      comprobarEntrada(await esperar(c, ledger.leer(c.ref.fotoId)), c.ref); vigente(c);
      const confirmada = copiarEntradaRespaldo(plan, await esperar(c, ledger.confirmarRecibo(recibo)));
      if (!misma(confirmada, c.ref) || confirmada.fase !== 'respaldada' || !confirmada.recibo
        || !reciboCorrespondeASolicitud(plan, solicitud(c.ref), confirmada.recibo)) throw new Error('Confirmación durable no corresponde');
      return confirmada;
    } catch (e) {
      if (c.vencida && !cerrada) {
        throw new ErrorTransporteFotos('Plazo de envío agotado; abortar no demuestra ausencia remota',
          c.marcadorIniciado ? 'incierta' : 'sin-envio', 'plazo');
      }
      if (e instanceof ErrorTransporteFotos) throw e;
      throw new ErrorTransporteFotos(e instanceof Error ? e.message : 'Fallo de transporte',
        c.marcadorIniciado ? 'incierta' : 'sin-envio');
    } finally {
      if (plazo !== null) clearTimeout(plazo);
      if (activa === c) activa = null;
    }
  }
  function iniciar(valor: ReferenciaRespaldo, retry: boolean, condiciones?: unknown): Promise<EntradaRespaldo> {
    // Captura y exclusión ANTES del primer await; errores siempre devueltos como rechazo.
    try {
      abierta();
      if (activa) throw new ErrorTransporteFotos('Ya hay una carga activa en esta instancia', 'sin-envio');
      const ref = copiarReferenciaRespaldo(plan, valor);
      const { soloPreparada } = copiarCondicionesEnvio(condiciones);
      if ([...pausasPendientes].some((pausa) => misma(pausa, ref))) {
        throw new ErrorTransporteFotos('Hay una intención de pausa pendiente', 'sin-envio');
      }
      const c: Carga = { ref, soloPreparada, controlador: new AbortController(), detenida: false, marcadorIniciado: false };
      activa = c; return ejecutar(c, retry);
    } catch (e) { return Promise.reject(e); }
  }
  return {
    estimar(valor) { abierta(); return presupuesto(copiarReferenciaRespaldo(plan, valor)); },
    subir: (ref, condiciones) => iniciar(ref, false, condiciones), reintentar: (ref) => iniciar(ref, true),
    async pausar(valor) {
      abierta(); const ref = copiarReferenciaRespaldo(plan, valor);
      if (!ledger) throw new Error('Ledger no disponible');
      pausasPendientes.add(ref);
      if (activa && misma(activa.ref, ref)) detener(activa);
      try {
        const resultado = await ledger.pausar(ref); abierta();
        const e = copiarEntradaRespaldo(plan, resultado);
        if (!misma(e, ref) || !e.pausada) throw new Error('Pausa durable no corresponde');
        return e;
      } finally { pausasPendientes.delete(ref); }
    },
    cancelar() { detener(activa); },
    cerrar() { if (!cerrada) { cerrada = true; detener(activa); } },
  };
}
