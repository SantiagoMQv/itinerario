import type { Itinerario } from '../src/tipos';
import { camposFoto, esIdFoto } from '../src/fotos';
import { mismosOriginalesRespaldo } from '../src/fotos-respaldo';
import { deserializarSolicitudRespaldo, serializarSolicitudRespaldo, serializarReciboRespaldo,
  type SolicitudRespaldo } from '../src/fotos-protocolo';
import { admitirOriginalFotos, CapturadorOriginalFotos, copiarPlanFotos, copiarPresupuestoFotos,
  FalloFotos, type PresupuestoFotos, type VigenciaFotos, type CapturaMultipartFotos } from './multipart-fotos';

/** Raw TEXT canónico; no JSONB, UUID cast, normalización de Unicode, -0 ni NUL.
 * La reserva NO contiene testigo binario durable, lease ni permiso de takeover. */
export interface ReservaFotos {
  readonly reservaId: string;
  readonly claveObjeto: string;
  readonly solicitudCanonica: string;
}
export type ResultadoReservaFotos = { readonly tipo: 'ganadora' | 'existente'; readonly reserva: ReservaFotos }
  | { readonly tipo: 'sin-sesion' | 'contradiccion' };
export type ResultadoFinalFotos = { readonly tipo: 'confirmada'; readonly reciboCanonico: string }
  | { readonly tipo: 'sin-sesion' | 'incierta' | 'contradiccion' };
export type ResultadoConsultaFoto = { readonly tipo: 'confirmada'; readonly reserva: ReservaFotos }
  | { readonly tipo: 'ausente' | 'sin-sesion' };

/** B implementará transacciones cortas con actor/trip vivos y reloj dentro del SQL.
 * reservar resuelve ganadora SOLO tras COMMIT confirmado del INSERT único nuevo; una
 * lectura, fila existente, respuesta perdida o repetición jamás concede ganadora.
 * Nunca reutilizar reservaId/clave, adoptar objetos ajenos ni cambiar metadata original.
 * finalizar comprueba reserva+payload+foto+operación y confirma COMMIT antes de resolver.
 * No locks SQL a través de put/scan; no atomicidad Neon/R2 ni prueba de proveedor en A.
 * Un mismo viaje permite editores iguales: creador/dispositivo NO son propietarios. */
export interface RepositorioFotos {
  reservar(huellaActor: string, viajeId: string, solicitudCanonica: string): Promise<unknown>;
  finalizar(huellaActor: string, viajeId: string, reserva: ReservaFotos, solicitudCanonica: string): Promise<unknown>;
  leerConfirmada(huellaActor: string, viajeId: string, fotoId: string): Promise<unknown>;
}
export interface ObjetoOriginalFotos {
  readonly claveObjeto: string;
  readonly solicitudCanonica: string;
  readonly original: ReadableStream<Uint8Array>;
}
/** Namespace privado e inmutable exclusivamente del protocolo; lectura fresca de objeto
 * completo+metadata, sin URLs públicas/presign/fallback. C implementará IF ABSENT real.
 * No delete, reemplazo, age-GC ni compensaciones. Resolución perdida es incertidumbre. */
export interface ObjetosFotos {
  ponerSiAusente(claveObjeto: string, original: Blob, solicitudCanonica: string): Promise<unknown>;
  leer(claveObjeto: string): Promise<unknown | null>;
}
export interface ConfiguracionAlmacenFotos {
  readonly plan: Itinerario;
  readonly repositorio: RepositorioFotos;
  readonly objetos: ObjetosFotos;
}
export interface ContextoAlmacenFotos {
  readonly huellaActor: string;
  readonly presupuesto: PresupuestoFotos;
  readonly vigencia: VigenciaFotos;
  /** Autenticación de cookie fresca DESPUÉS de objeto/scan; false nunca se convierte en ACK. */
  readonly reautenticar: () => Promise<boolean>;
}
export interface AlmacenFotos {
  respaldar(captura: CapturaMultipartFotos, contexto: ContextoAlmacenFotos): Promise<{ readonly texto: string; readonly primera: boolean }>;
  descargar(fotoId: string, contexto: ContextoAlmacenFotos): Promise<Blob>;
}

export function clavePrivadaFotos(viajeId: string, fotoId: string, reservaId: string): string {
  return `fotos/1/${encodeURIComponent(viajeId)}/${encodeURIComponent(fotoId)}/${encodeURIComponent(reservaId)}`;
}
function capturarReserva(plan: Itinerario, valor: unknown): { reserva: ReservaFotos; solicitud: SolicitudRespaldo } {
  if (!camposFoto(valor, ['reservaId', 'claveObjeto', 'solicitudCanonica']) || !esIdFoto(valor.reservaId)
    || typeof valor.claveObjeto !== 'string' || typeof valor.solicitudCanonica !== 'string') throw new FalloFotos(503);
  let solicitud: SolicitudRespaldo;
  try { solicitud = deserializarSolicitudRespaldo(plan, valor.solicitudCanonica); } catch { throw new FalloFotos(503); }
  if (serializarSolicitudRespaldo(plan, solicitud) !== valor.solicitudCanonica
    || clavePrivadaFotos(plan.id, solicitud.fotoId, valor.reservaId) !== valor.claveObjeto) throw new FalloFotos(503);
  Object.freeze(solicitud.original.destino); Object.freeze(solicitud.original); Object.freeze(solicitud);
  return { reserva: Object.freeze({ reservaId: valor.reservaId, claveObjeto: valor.claveObjeto,
    solicitudCanonica: valor.solicitudCanonica }), solicitud };
}

/** Fábrica sin IO. Captura plan y funciones antes del primer await; no estado compartido.
 * Ganador ligado a ESTE Blob inmutable y cuerpo canónico en ESTA invocación solamente.
 * Retry existente: GET+fullcompare+finalize; ausencia no permite put ni ACK. Si ganador
 * muere antes de put o pierde respuesta SQL hay reserva vacía irrecoverable en el mínimo:
 * disponibilidad pendiente T6S-R antes del rollout, sin inventar recovery fuerte. */
export function crearAlmacenFotos(configuracion: ConfiguracionAlmacenFotos): AlmacenFotos {
  if (!camposFoto(configuracion, ['plan', 'repositorio', 'objetos'])) throw new FalloFotos(503);
  const plan = copiarPlanFotos(configuracion.plan);
  const r = configuracion.repositorio; const o = configuracion.objetos;
  if (!r || !o || typeof r.reservar !== 'function' || typeof r.finalizar !== 'function'
    || typeof r.leerConfirmada !== 'function' || typeof o.ponerSiAusente !== 'function' || typeof o.leer !== 'function') throw new FalloFotos(503);
  const reservar = r.reservar.bind(r); const finalizar = r.finalizar.bind(r);
  const consultar = r.leerConfirmada.bind(r); const poner = o.ponerSiAusente.bind(o); const leer = o.leer.bind(o);

  async function objeto(reserva: ReservaFotos, c: ContextoAlmacenFotos): Promise<ObjetoOriginalFotos> {
    const cancelarValor = (valor: unknown) => {
      const stream = valor !== null && typeof valor === 'object'
        ? Object.getOwnPropertyDescriptor(valor, 'original')?.value : null;
      if (stream instanceof ReadableStream) {
        try { void stream.cancel().catch(() => {}); } catch { /* Sólo limpieza, sin await. */ }
      }
    };
    const valor = await c.vigencia.esperar(() => leer(reserva.claveObjeto).then((v) => {
      try { c.vigencia.comprobar(); } catch (e) { cancelarValor(v); throw e; }
      return v;
    }), true);
    if (valor === null) throw new FalloFotos(503);
    if (!camposFoto(valor, ['claveObjeto', 'solicitudCanonica', 'original'])
      || valor.claveObjeto !== reserva.claveObjeto || valor.solicitudCanonica !== reserva.solicitudCanonica
      || !(valor.original instanceof ReadableStream)) { cancelarValor(valor); throw new FalloFotos(503); }
    return { claveObjeto: valor.claveObjeto, solicitudCanonica: valor.solicitudCanonica, original: valor.original as ReadableStream<Uint8Array> };
  }
  /** Comparación íntegra streaming contra slices nativas <=1MiB; no wrapper MIME/raw MIME,
   * hash, ETag, tamaño solo ni receipt previo. Incluye EOF; diferencia probada =409.
   * No captura un segundo original entero para POST. */
  async function comparar(original: Blob, remoto: ObjetoOriginalFotos, c: ContextoAlmacenFotos): Promise<void> {
    const p = c.presupuesto; const v = c.vigencia;
    const lector = remoto.original.getReader();
    let offset = 0; let entrada = 0; let completa = false;
    let esperado = new Uint8Array(0); let inicioEsperado = -1;
    const cancelar = () => { try { void lector.cancel().catch(() => {}); } catch { /* No esperar. */ } };
    v.signal.addEventListener('abort', cancelar, { once: true });
    try {
      for (;;) {
        const lectura = await v.esperar(() => lector.read(), true);
        if (lectura.done) break;
        const chunk = lectura.value;
        if (!(chunk instanceof Uint8Array)) throw new FalloFotos(503);
        if (chunk.length > p.maxBytesChunk || chunk.length > p.maxBytesEntrada - entrada) throw new FalloFotos(413);
        entrada += chunk.length;
        if (chunk.length > original.size - offset) throw new FalloFotos(409);
        for (let i = 0; i < chunk.length;) {
          const inicio = Math.floor(offset / p.bytesBloque) * p.bytesBloque;
          if (inicio !== inicioEsperado) {
            const fin = Math.min(original.size, inicio + p.bytesBloque);
            const buffer = await v.esperar(() => Blob.prototype.arrayBuffer.call(Blob.prototype.slice.call(original, inicio, fin)) as Promise<ArrayBuffer>);
            esperado = new Uint8Array(buffer);
            if (esperado.length !== fin - inicio) throw new FalloFotos(503);
            inicioEsperado = inicio;
          }
          const cantidad = Math.min(chunk.length - i, esperado.length - (offset - inicio));
          for (let j = 0; j < cantidad; j++) if (chunk[i + j] !== esperado[offset - inicio + j]) throw new FalloFotos(409);
          i += cantidad; offset += cantidad;
          v.comprobar();
        }
      }
      if (offset !== original.size) throw new FalloFotos(409);
      v.comprobar(); completa = true;
    } finally {
      esperado = new Uint8Array(0);
      v.signal.removeEventListener('abort', cancelar);
      if (!completa) cancelar();
      try { lector.releaseLock(); } catch { /* No ocultar incertidumbre. */ }
    }
  }
  async function fresca(c: ContextoAlmacenFotos): Promise<void> {
    if (!await c.vigencia.esperar(c.reautenticar, true)) throw new FalloFotos(401);
  }
  return Object.freeze({
    async respaldar(captura: CapturaMultipartFotos, contexto: ContextoAlmacenFotos) {
      const p = copiarPresupuestoFotos(contexto.presupuesto);
      const c = { ...contexto, presupuesto: p };
      let solicitud: SolicitudRespaldo; let canonico: string; let recibo: string;
      try {
        canonico = serializarSolicitudRespaldo(plan, captura.solicitud);
        solicitud = deserializarSolicitudRespaldo(plan, canonico);
      } catch { throw new FalloFotos(400); }
      try {
        recibo = serializarReciboRespaldo(plan, { ...solicitud, tipo: 'acuse-respaldo',
          objetoOriginalDurable: true, metadatosDurables: true });
      } catch { throw new FalloFotos(413); }
      // Brand nativo, sin override local del size/métodos del Blob. Raw -0 conserva metadata.
      const original = Blob.prototype.slice.call(captura.original, 0) as Blob;
      if (original.size !== solicitud.original.bytesOriginal) throw new FalloFotos(400);
      admitirOriginalFotos(original.size, p);
      const resultado = await c.vigencia.esperar(() => reservar(c.huellaActor, plan.id, canonico), true);
      if (camposFoto(resultado, ['tipo'])) {
        if (resultado.tipo === 'sin-sesion') throw new FalloFotos(401);
        if (resultado.tipo === 'contradiccion') throw new FalloFotos(409);
      }
      if (!camposFoto(resultado, ['tipo', 'reserva']) || !['ganadora', 'existente'].includes(resultado.tipo as string)) throw new FalloFotos(503);
      // Copiar ANTES de otro await: jamás rebind a una respuesta mutable del adaptador.
      const primera = resultado.tipo === 'ganadora';
      const fija = capturarReserva(plan, resultado.reserva);
      if (fija.solicitud.fotoId !== solicitud.fotoId
        || !mismosOriginalesRespaldo(plan, fija.solicitud.original, solicitud.original)) throw new FalloFotos(409);
      if (primera && fija.reserva.solicitudCanonica !== canonico) throw new FalloFotos(503);
      if (primera) {
        const puesto = await c.vigencia.esperar(() => poner(fija.reserva.claveObjeto, original, canonico), true);
        // false indica que no ganó el IF ABSENT, no concede permiso nuevo; lectura decide.
        if (puesto !== true && puesto !== false) throw new FalloFotos(503);
      }
      await comparar(original, await objeto(fija.reserva, c), c);
      await fresca(c);
      const final = await c.vigencia.esperar(() => finalizar(c.huellaActor, plan.id, fija.reserva, canonico), true);
      if (camposFoto(final, ['tipo'])) {
        if (final.tipo === 'sin-sesion') throw new FalloFotos(401);
        if (final.tipo === 'contradiccion') throw new FalloFotos(409);
      }
      if (!camposFoto(final, ['tipo', 'reciboCanonico']) || final.tipo !== 'confirmada'
        || final.reciboCanonico !== recibo) throw new FalloFotos(503);
      c.vigencia.comprobar();
      return Object.freeze({ texto: recibo, primera });
    },
    async descargar(fotoId: string, contexto: ContextoAlmacenFotos): Promise<Blob> {
      const c = { ...contexto, presupuesto: copiarPresupuestoFotos(contexto.presupuesto) };
      if (!esIdFoto(fotoId)) throw new FalloFotos(400);
      const fila = await c.vigencia.esperar(() => consultar(c.huellaActor, plan.id, fotoId), true);
      if (camposFoto(fila, ['tipo'])) {
        if (fila.tipo === 'ausente') throw new FalloFotos(404);
        if (fila.tipo === 'sin-sesion') throw new FalloFotos(401);
      }
      if (!camposFoto(fila, ['tipo', 'reserva']) || fila.tipo !== 'confirmada') throw new FalloFotos(503);
      const fija = capturarReserva(plan, fila.reserva);
      if (fija.solicitud.fotoId !== fotoId) throw new FalloFotos(503);
      admitirOriginalFotos(fija.solicitud.original.bytesOriginal, c.presupuesto);
      const remoto = await objeto(fija.reserva, c);
      const lector = remoto.original.getReader();
      const captura = new CapturadorOriginalFotos(fija.solicitud.original.bytesOriginal, c.presupuesto);
      let total = 0; let completa = false;
      const cancelar = () => { try { void lector.cancel().catch(() => {}); } catch { /* No esperar. */ } };
      c.vigencia.signal.addEventListener('abort', cancelar, { once: true });
      try {
        for (;;) {
          const lectura = await c.vigencia.esperar(() => lector.read(), true);
          if (lectura.done) break;
          if (!(lectura.value instanceof Uint8Array)) throw new FalloFotos(503);
          const chunk = lectura.value;
          if (chunk.length > c.presupuesto.maxBytesChunk || chunk.length > c.presupuesto.maxBytesEntrada - total) throw new FalloFotos(413);
          total += chunk.length;
          for (const b of chunk) captura.agregar(b);
          c.vigencia.comprobar();
        }
        const original = captura.terminar();
        await fresca(c);
        c.vigencia.comprobar(); completa = true;
        return original;
      } finally {
        captura.liberar();
        c.vigencia.signal.removeEventListener('abort', cancelar);
        if (!completa) cancelar();
        try { lector.releaseLock(); } catch { /* No ocultar error. */ }
      }
    },
  });
}
