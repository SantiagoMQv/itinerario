import type { Itinerario } from './tipos';
import { camposFoto, copiarMetadatos, esIdFoto, type CapturaFoto } from './fotos';
import { comprobarIdentidadFoto, type LecturasIdentidadFoto } from './fotos-identidad';
import { copiarEntradaRespaldo, copiarOriginalRespaldo, copiarReciboRespaldo, copiarReferenciaRespaldo,
  mismosOriginalesRespaldo, type EntradaRespaldo, type ReferenciaRespaldo } from './fotos-respaldo';

export interface OpcionesRespaldoFotosLocal {
  /** Fábrica de IndexedDB propia del contexto; null expresa indisponibilidad sin fallback. */
  readonly fabrica?: IDBFactory | null;
  /** CSPRNG UUIDv4 inyectable; solo se consulta al crear una preparación explícita nueva. */
  readonly uuid?: () => string;
}
export interface RespaldoFotosLocal {
  /** Metadata exclusivamente: no carga originales ni implica consulta remota. */
  listar(): Promise<EntradaRespaldo[]>;
  /** Estado durable local; ausencia de registro NO prueba ausencia del objeto remoto. */
  leer(fotoId: string): Promise<EntradaRespaldo | null>;
  /** Captura validada/copiada antes de await y atestada con el puerto readonly de PhotoDB.
   * Original vivo inmutable/no-ABA son requisitos del puerto; no prueba R2 distribuida.
   * Retorna operación existente sin rebobinarla; operación distinta siempre es colisión. */
  preparar(captura: CapturaFoto, operacionId?: string): Promise<EntradaRespaldo>;
  /** Resolver TX antes de IO externo. El transporte FUTURO deberá reatestar el original
   * antes de IO: este marcador irreversible por sí solo no autoriza bytes ni autentica sesión. */
  marcarEnviada(referencia: ReferenciaRespaldo): Promise<EntradaRespaldo>;
  /** Intención local, no prueba de aborto remoto/rollback ni ausencia de bytes/costes. */
  pausar(referencia: ReferenciaRespaldo): Promise<EntradaRespaldo>;
  /** Solo acción explícita manual: quita pausa sin regenerar operación, payload ni testigo. */
  reintentar(referencia: ReferenciaRespaldo): Promise<EntradaRespaldo>;
  /** Entrada PRIVILEGIADA para el futuro transporte autenticado de mismo origen.
   * El llamador debe entregar el recibo del servidor, nunca una simulación/GET/importación.
   * El guard local no puede autenticar JSON: sin ese transporte no hay prueba remota real.
   * Contradicción vinculada a la misma operación bloquea, preservando cualquier recibo anterior.
   * Una respaldada no afirma que otra persona ya recibió/leyó la foto. */
  confirmarRecibo(recibo: unknown): Promise<EntradaRespaldo>;
  /** Cierra conexión, no aborta transacciones iniciadas ni reabre automáticamente. */
  cerrar(): void;
}
const almacen = 'respaldos';
function abrirBase(fabrica: IDBFactory, nombre: string): Promise<IDBDatabase> {
  return new Promise((ok, no) => {
    let terminada = false;
    const s = fabrica.open(nombre, 1);
    s.onupgradeneeded = (e) => {
      // Única creación permitida: esquema inicial de ESTA base nueva. Nunca migración/reset.
      if (e.oldVersion === 0) s.result.createObjectStore(almacen);
    };
    s.onblocked = () => { terminada = true; no(new Error('Apertura de respaldo bloqueada; cerrar otras conexiones y reintentar')); };
    s.onerror = () => { terminada = true; no(new Error('No se pudo abrir el respaldo local')); };
    s.onsuccess = () => {
      const db = s.result;
      if (terminada) { db.close(); return; }
      terminada = true;
      try {
        if (db.version !== 1 || db.objectStoreNames.length !== 1 || !db.objectStoreNames.contains(almacen)) {
          throw new Error('Esquema de respaldo no soportado');
        }
        const t = db.transaction(almacen).objectStore(almacen);
        if (t.keyPath !== null || t.autoIncrement || t.indexNames.length) throw new Error('Esquema de respaldo no soportado');
        ok(db);
      } catch (e) { db.close(); no(e); }
    };
  });
}
/** Ledger separado por viaje, v1/una tabla/sin índices ni Blobs. No toca PhotoDB, progreso,
 * CacheStorage, legado ni red. Sin borrados, polling, scheduler, backoff o reanudación autónoma.
 * TX oncomplete es éxito local, no garantía frente a evicción ni durabilidad física del móvil. */
export async function abrirRespaldoFotosLocal(plan: Itinerario, fuente: LecturasIdentidadFoto,
  opciones: OpcionesRespaldoFotosLocal = {}): Promise<RespaldoFotosLocal> {
  const fabrica = opciones.fabrica === undefined ? globalThis.indexedDB : opciones.fabrica;
  if (!fabrica) throw new Error('IndexedDB no está disponible');
  const planFijo = structuredClone(plan);
  const uuid = opciones.uuid ?? (() => globalThis.crypto.randomUUID());
  // Captura de funciones del puerto: no singleton mutable ni dependencia de UI/PhotoDB física.
  const lecturas: LecturasIdentidadFoto = { leerMetadatos: (id) => leerMetadata.call(fuente, id),
    leerOriginal: (id) => leerOriginal.call(fuente, id) };
  const leerMetadata = fuente.leerMetadatos; const leerOriginal = fuente.leerOriginal;
  const db = await abrirBase(fabrica, `itinerario-respaldo-fotos:${encodeURIComponent(planFijo.id)}`);
  let cerrado = false;
  const cerrar = () => { cerrado = true; db.close(); };
  db.onversionchange = cerrar; db.onclose = () => { cerrado = true; };
  function ejecutar<T>(modo: IDBTransactionMode, trabajo: (t: IDBObjectStore, terminar: (v: T) => void,
    fallar: (e: unknown) => void) => void): Promise<T> {
    return new Promise((ok, no) => {
      if (cerrado) { no(new Error('El almacén de respaldo está cerrado')); return; }
      let tx: IDBTransaction;
      try { tx = db.transaction(almacen, modo); } catch (e) { no(e); return; }
      let resultado: T; let error: unknown;
      const fallar = (e: unknown) => { error = e; try { tx.abort(); } catch { no(e); } };
      tx.oncomplete = () => ok(resultado);
      tx.onabort = () => no(error ?? tx.error ?? new DOMException('Transacción de respaldo abortada', 'AbortError'));
      tx.onerror = (e) => { error ??= (e.target as IDBRequest).error ?? tx.error; };
      try { trabajo(tx.objectStore(almacen), (v) => { resultado = v; }, fallar); } catch (e) { fallar(e); }
    });
  }
  function validarId(id: unknown): asserts id is string {
    if (!esIdFoto(id)) throw new Error('Identidad de foto inválida');
  }
  function registro(valor: unknown, clave: IDBValidKey): EntradaRespaldo | null {
    if (valor === undefined) return null;
    const e = copiarEntradaRespaldo(planFijo, valor);
    if (!Object.is(e.fotoId, clave)) throw new Error('Clave de respaldo corrupta');
    return e;
  }
  function conRegistro<T>(id: string, modo: IDBTransactionMode,
    trabajo: (anterior: EntradaRespaldo | null, t: IDBObjectStore, terminar: (v: T) => void) => void): Promise<T> {
    validarId(id);
    return ejecutar(modo, (t, terminar, fallar) => {
      const s = t.get(id);
      s.onsuccess = () => { try { trabajo(registro(s.result, id), t, terminar); } catch (e) { fallar(e); } };
    });
  }
  function comprobarReferencia(actual: EntradaRespaldo | null, ref: ReferenciaRespaldo): EntradaRespaldo {
    if (!actual) throw new Error('Respaldo desconocido; preparar explícitamente');
    if (!Object.is(actual.operacionId, ref.operacionId) || !mismosOriginalesRespaldo(planFijo, actual.original, ref.original)) {
      throw new Error('Colisión de operación o identidad original de respaldo');
    }
    return actual;
  }
  function cambiar(refEntrada: unknown, accion: 'enviar' | 'pausar' | 'reintentar'): Promise<EntradaRespaldo> {
    // Copia antes de transacción/await: una acción tardía nunca cambia su destino.
    const ref = copiarReferenciaRespaldo(planFijo, refEntrada);
    return conRegistro(ref.fotoId, 'readwrite', (anterior, t, terminar) => {
      const actual = comprobarReferencia(anterior, ref);
      let siguiente: EntradaRespaldo;
      if (accion === 'pausar') siguiente = { ...actual, pausada: true };
      else {
        if (actual.fase === 'bloqueada' || actual.fase === 'respaldada') {
          throw new Error('Respaldo bloqueado o ya respaldado; no se vuelve a enviar');
        }
        if (accion === 'enviar') {
          if (actual.pausada) throw new Error('Respaldo pausado; reintentar manualmente');
          siguiente = { ...actual, fase: 'enviada', enviada: true };
        } else siguiente = { ...actual, pausada: false };
      }
      const copia = copiarEntradaRespaldo(planFijo, siguiente);
      t.put(copia, ref.fotoId); terminar(copia);
    });
  }
  return {
    cerrar,
    listar: () => ejecutar('readonly', (t, terminar, fallar) => {
      const lista: EntradaRespaldo[] = []; const s = t.openCursor();
      s.onsuccess = () => {
        try {
          const cursor = s.result;
          if (!cursor) { terminar(lista); return; }
          const e = registro(cursor.value, cursor.primaryKey); if (e) lista.push(e);
          cursor.continue();
        } catch (e) { fallar(e); }
      };
    }),
    leer: async (id) => conRegistro(id, 'readonly', (e, _t, terminar) => terminar(e)),
    preparar: async (captura, operacionId) => {
      if (!camposFoto(captura, ['metadatos', 'original'])) throw new Error('Captura de respaldo inválida');
      const metadata = copiarMetadatos(planFijo, captura.metadatos); const originalBlob = captura.original;
      if (operacionId !== undefined && !esIdFoto(operacionId)) throw new Error('Operación de respaldo inválida');
      const identidad = copiarOriginalRespaldo(planFijo, metadata);
      const comprobada = await comprobarIdentidadFoto(planFijo, lecturas, metadata, originalBlob);
      if (comprobada.tipo !== 'misma') throw new Error('No se pudo atestar la captura original guardada');
      return conRegistro(metadata.fotoId, 'readwrite', (anterior, t, terminar) => {
        if (anterior) {
          if (!mismosOriginalesRespaldo(planFijo, anterior.original, identidad)
            || (operacionId !== undefined && !Object.is(anterior.operacionId, operacionId))) {
            throw new Error('Colisión de preparación; no se sobrescribe la historia');
          }
          terminar(anterior); return;
        }
        const id = operacionId ?? uuid();
        if (!esIdFoto(id)) throw new Error('Generador de operación inválido; se exige UUIDv4 criptográfico');
        const siguiente = copiarEntradaRespaldo(planFijo, { formato: 1, fotoId: metadata.fotoId, operacionId: id,
          original: identidad, fase: 'preparado', enviada: false, pausada: false, recibo: null });
        t.add(siguiente, metadata.fotoId); terminar(siguiente);
      });
    },
    marcarEnviada: async (ref) => cambiar(ref, 'enviar'),
    pausar: async (ref) => cambiar(ref, 'pausar'),
    reintentar: async (ref) => cambiar(ref, 'reintentar'),
    confirmarRecibo: async (entrada) => {
      const recibo = copiarReciboRespaldo(planFijo, entrada);
      return conRegistro(recibo.fotoId, 'readwrite', (actual, t, terminar) => {
        if (!actual || !Object.is(actual.operacionId, recibo.operacionId)) throw new Error('Colisión o acuse de operación desconocida');
        if (!actual.enviada) throw new Error('No consta marcador enviada; acuse inesperado');
        const coincide = mismosOriginalesRespaldo(planFijo, actual.original, recibo.original);
        // Una contradicción nunca limpia prueba previa ni rehabilita automáticamente el registro.
        const siguiente: EntradaRespaldo = !coincide ? { ...actual, fase: 'bloqueada' }
          : actual.fase === 'bloqueada' ? actual : { ...actual, fase: 'respaldada', recibo: actual.recibo ?? recibo };
        const copia = copiarEntradaRespaldo(planFijo, siguiente);
        t.put(copia, actual.fotoId); terminar(copia);
      });
    },
  };
}
