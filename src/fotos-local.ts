import type { Itinerario } from './tipos';
import { camposFoto, copiarMetadatos, esFotoBorrada, esIdFoto, esEstadoMiniatura, tamanoBlob, tipoBlob,
  type CapturaFoto, type EstadoMiniatura, type FotoBorrada, type MetadatosFoto, type ResultadoFoto } from './fotos';

import { capturarBasePortable, copiarPlanPortable, validarBasePortable, type BasePortable, type LimitesPortables, type PuertoAperturaPortable } from './portabilidad';

export interface OpcionesFotosLocal { readonly fabrica?: IDBFactory | null; readonly nombre?: string }
export interface FotosLocal {
  /** Cursor exclusivo de metadata; excluye tombstones y falla visiblemente ante desconocidos. */
  listar(): Promise<MetadatosFoto[]>;
  leerMetadatos(fotoId: string): Promise<MetadatosFoto | FotoBorrada | null>;
  leerOriginal(fotoId: string): Promise<Blob | null>;
  leerMiniatura(fotoId: string): Promise<Blob | null>;
  /** Confirmación local al terminar TX, nunca acuse remoto. Colisión siempre es error:
   * aun tras respuesta perdida, no regenerar ID ni afirmar idempotencia sin comprobar identidad. */
  guardarOriginal(captura: CapturaFoto): Promise<ResultadoFoto>;
  guardarMiniatura(fotoId: string, blob: Blob, ancho: number, alto: number): Promise<ResultadoFoto>;
  /** Si también falla esta escritura, el motivo solo existe en la sesión; lo durable sigue
   * pendiente. No prometer recuperar el File al cerrar la visita si guardarOriginal falló. */
  registrarFalloMiniatura(fotoId: string, motivo: string): Promise<ResultadoFoto>;
  /** Solo original/miniatura/tombstone de ESTA base. No borra respaldos ni progreso. */
  borrarLocal(fotoId: string): Promise<ResultadoFoto>;
  /** Libera conexión. No cancela las transacciones que ya comenzaron. */
  cerrar(): void;
}
const tablas = ['metadatos', 'originales', 'miniaturas'];
function comprobarEsquemaFotos(db: IDBDatabase, tx?: IDBTransaction): void {
  if (db.version !== 1 || db.objectStoreNames.length !== tablas.length
    || tablas.some((t) => !db.objectStoreNames.contains(t))) throw new Error('Esquema de fotos no soportado');
  const transaccion = tx ?? db.transaction(tablas);
  for (const nombre of tablas) {
    const t = transaccion.objectStore(nombre);
    if (t.keyPath !== null || t.autoIncrement || t.indexNames.length) throw new Error('Esquema de fotos no soportado');
  }
}
function validarRelacionFoto(m: MetadatosFoto | FotoBorrada | null, original: unknown, miniatura: unknown): void {
  const viva = m && !esFotoBorrada(m) ? m : null;
  if (!viva) {
    if (original !== undefined || miniatura !== undefined) throw new Error('Blobs huérfanos o registro corrupto');
    return;
  }
  if (original === undefined || tamanoBlob(original) !== viva.bytesOriginal
    || tipoBlob(original as Blob) !== viva.mimeDeclarado) throw new Error('Original ausente o corrupto');
  if (viva.miniatura.tipo === 'lista') {
    if (miniatura === undefined || tamanoBlob(miniatura) !== viva.miniatura.bytes
      || tipoBlob(miniatura as Blob) !== 'image/png') throw new Error('Miniatura ausente o corrupta');
  } else if (miniatura !== undefined) throw new Error('Miniatura huérfana o registro corrupto');
}
/** Guard de historia RAW: materialización únicamente para validar, nunca como salida. */
export function validarFotosPortables(plan: Itinerario, base: BasePortable): void {
  validarBasePortable(base, tablas);
  if (!base.presente) return;
  const originales = new Map(base.tablas.originales.map((r) => [r.clave, r.valor]));
  const miniaturas = new Map(base.tablas.miniaturas.map((r) => [r.clave, r.valor]));
  const ids = new Set<string>();
  for (const r of base.tablas.metadatos) {
    try {
      if (!esIdFoto(r.clave)) throw new Error('ID inválido');
      const m = esFotoBorrada(r.valor) ? r.valor : copiarMetadatos(plan, r.valor);
      if (m.fotoId !== r.clave) throw new Error('Clave incompatible');
      validarRelacionFoto(m, originales.get(r.clave), miniaturas.get(r.clave));
      ids.add(r.clave);
    } catch (e) { throw new Error(`PhotoDB/metadatos/${r.clave}: ${e instanceof Error ? e.message : 'inválido'}`); }
  }
  for (const tabla of ['originales', 'miniaturas']) {
    for (const r of base.tablas[tabla]) {
      if (!ids.has(r.clave) || !esIdFoto(r.clave)) throw new Error(`PhotoDB/${tabla}/${r.clave}: Blob huérfano`);
      try { tamanoBlob(r.valor); } catch { throw new Error(`PhotoDB/${tabla}/${r.clave}: Blob no nativo`); }
    }
  }
}
/** Snapshot completo, tombstones incluidos; no usa listar ni abrirFotosLocal. */
export async function capturarFotosLocal(planEntrada: Itinerario, limites: LimitesPortables,
  opciones: { readonly fabrica?: PuertoAperturaPortable | null; readonly nombre?: string } = {}): Promise<BasePortable> {
  const plan = copiarPlanPortable(planEntrada);
  const fabrica = opciones.fabrica === undefined ? globalThis.indexedDB : opciones.fabrica;
  const nombre = opciones.nombre ?? `itinerario-fotos:${encodeURIComponent(plan.id)}`;
  return capturarBasePortable(fabrica, nombre, tablas, limites, comprobarEsquemaFotos,
    (base) => validarFotosPortables(plan, base));
}
function abrirBase(fabrica: IDBFactory, nombre: string): Promise<IDBDatabase> {
  return new Promise((ok, no) => {
    let terminada = false;
    const s = fabrica.open(nombre, 1);
    s.onupgradeneeded = (e) => {
      if (e.oldVersion === 0) tablas.forEach((t) => s.result.createObjectStore(t));
    };
    s.onblocked = () => { terminada = true; no(new Error('Apertura de fotos bloqueada; cerrar otras conexiones y reintentar')); };
    s.onerror = () => { terminada = true; no(s.error); };
    s.onsuccess = () => {
      const db = s.result;
      if (terminada) { db.close(); return; }
      terminada = true;
      try {
        comprobarEsquemaFotos(db);
        ok(db);
      } catch (e) { db.close(); no(e); }
    };
  });
}
/** Base propia v1, claves explícitas fotoId y sin índices: listar no necesita leer Blobs.
 * Una transacción confirmada no garantiza protección frente a evicción/cierre del navegador.
 * Sin red, caches, progreso, migraciones ni limpieza de registros desconocidos. */
export async function abrirFotosLocal(plan: Itinerario, opciones: OpcionesFotosLocal = {}): Promise<FotosLocal> {
  const fabrica = opciones.fabrica === undefined ? globalThis.indexedDB : opciones.fabrica;
  if (!fabrica) throw new Error('IndexedDB no está disponible');
  const copiaPlan = structuredClone(plan);
  const db = await abrirBase(fabrica, opciones.nombre ?? `itinerario-fotos:${encodeURIComponent(plan.id)}`);
  let cerrado = false;
  const cerrar = () => { cerrado = true; db.close(); };
  db.onversionchange = cerrar;
  db.onclose = () => { cerrado = true; };
  function validarId(id: string) { if (!esIdFoto(id)) throw new Error('Identidad de foto inválida'); }
  function metadata(valor: unknown, id: IDBValidKey): MetadatosFoto | FotoBorrada | null {
    if (valor === undefined) return null;
    const m = esFotoBorrada(valor) ? { formato: 1 as const, tipo: 'borrada' as const, fotoId: valor.fotoId }
      : copiarMetadatos(copiaPlan, valor);
    if (m.fotoId !== id) throw new Error('Clave de foto corrupta');
    return m;
  }
  function ejecutar<T>(nombres: string[], modo: IDBTransactionMode,
    trabajo: (tx: IDBTransaction, terminar: (v: T) => void, fallar: (e: unknown) => void) => void): Promise<T> {
    return new Promise((ok, no) => {
      if (cerrado) { no(new Error('El almacén de fotos está cerrado')); return; }
      let tx: IDBTransaction;
      try { tx = db.transaction(nombres, modo); } catch (e) { no(e); return; }
      let resultado: T;
      let error: unknown;
      const fallar = (e: unknown) => { error = e; try { tx.abort(); } catch { no(e); } };
      tx.oncomplete = () => ok(resultado);
      tx.onabort = () => no(error ?? tx.error ?? new DOMException('Transacción de fotos abortada', 'AbortError'));
      tx.onerror = (e) => { error ??= (e.target as IDBRequest).error ?? tx.error; };
      // Requests solo preparan resultado; el único éxito público es oncomplete.
      try { trabajo(tx, (v) => { resultado = v; }, fallar); } catch (e) { fallar(e); }
    });
  }
  function leer<T>(id: string, nombres: string[], trabajo: (m: MetadatosFoto | FotoBorrada | null,
    tx: IDBTransaction, terminar: (v: T) => void, fallar: (e: unknown) => void) => void, modo: IDBTransactionMode = 'readonly'): Promise<T> {
    validarId(id);
    return ejecutar(nombres, modo, (tx, terminar, fallar) => {
      const s = tx.objectStore('metadatos').get(id);
      s.onsuccess = () => { try { trabajo(metadata(s.result, id), tx, terminar, fallar); } catch (e) { fallar(e); } };
    });
  }
  /** Metadata y blob se comprueban dentro de la misma transacción fresca. */
  function leerBlob(id: string, tabla: 'originales' | 'miniaturas'): Promise<Blob | null> {
    return leer(id, ['metadatos', tabla], (m, tx, terminar, fallar) => {
      const s = tx.objectStore(tabla).get(id);
      s.onsuccess = () => {
        try {
          const esperado = m && !esFotoBorrada(m) ? tabla === 'originales' ? m.bytesOriginal
            : m.miniatura.tipo === 'lista' ? m.miniatura.bytes : null : null;
          if (esperado === null) {
            if (s.result !== undefined) throw new Error('Blob huérfano o registro corrupto');
            terminar(null); return;
          }
          if (s.result === undefined || tamanoBlob(s.result) !== esperado
            || (tabla === 'miniaturas' && tipoBlob(s.result) !== 'image/png')
            || (tabla === 'originales' && m && !esFotoBorrada(m) && tipoBlob(s.result) !== m.mimeDeclarado)) {
            throw new Error('Blob ausente o corrupto');
          }
          terminar(s.result as Blob);
        } catch (e) { fallar(e); }
      };
    });
  }
  /** Evita confirmar o borrar sobre relaciones corruptas; nunca repara ni elimina huérfanos. */
  const relacion = validarRelacionFoto;
  function conBlobs(tx: IDBTransaction, id: string, m: MetadatosFoto | FotoBorrada | null,
    trabajo: () => void, fallar: (e: unknown) => void): void {
    const original = tx.objectStore('originales').get(id);
    const miniatura = tx.objectStore('miniaturas').get(id);
    let recibidas = 0;
    const recibido = () => {
      if (++recibidas !== 2) return;
      try { relacion(m, original.result, miniatura.result); trabajo(); } catch (e) { fallar(e); }
    };
    original.onsuccess = recibido; miniatura.onsuccess = recibido;
  }
  function modificarMiniatura(id: string, estado: EstadoMiniatura, blob?: Blob): Promise<ResultadoFoto> {
    return leer(id, tablas, (m, tx, terminar, fallar) => {
      if (!m || esFotoBorrada(m)) throw new Error('Foto ausente o borrada; no se genera miniatura tardía');
      conBlobs(tx, id, m, () => {
        // Un fallo tardío de otro intento no pisa una miniatura que ya quedó lista.
        if (estado.tipo === 'fallida' && m.miniatura.tipo === 'lista') {
          terminar({ tipo: 'guardada', metadatos: m }); return;
        }
        const siguiente = copiarMetadatos(copiaPlan, { ...m, miniatura: estado });
        if (blob) tx.objectStore('miniaturas').put(blob, id);
        tx.objectStore('metadatos').put(siguiente, id);
        terminar({ tipo: 'guardada', metadatos: siguiente });
      }, fallar);
    }, 'readwrite');
  }
  return {
    cerrar,
    listar: () => ejecutar(['metadatos'], 'readonly', (tx, terminar, fallar) => {
      const lista: MetadatosFoto[] = [];
      const s = tx.objectStore('metadatos').openCursor();
      s.onsuccess = () => {
        try {
          const cursor = s.result;
          if (!cursor) { terminar(lista); return; }
          const m = metadata(cursor.value, cursor.primaryKey);
          if (m && !esFotoBorrada(m)) lista.push(m);
          cursor.continue();
        } catch (e) { fallar(e); }
      };
    }),
    leerMetadatos: async (id) => leer(id, ['metadatos'], (m, _tx, terminar) => terminar(m)),
    leerOriginal: async (id) => leerBlob(id, 'originales'),
    leerMiniatura: async (id) => leerBlob(id, 'miniaturas'),
    guardarOriginal: async (captura) => {
      if (!camposFoto(captura, ['metadatos', 'original'])) throw new Error('Captura inválida');
      const m = copiarMetadatos(copiaPlan, captura.metadatos);
      const original = captura.original;
      if (m.miniatura.tipo !== 'pendiente' || tamanoBlob(original) !== m.bytesOriginal
        || tipoBlob(original) !== m.mimeDeclarado) throw new Error('Original incompatible con metadata');
      return leer(m.fotoId, tablas, (anterior, tx, terminar, fallar) => {
        if (anterior) throw new Error('Colisión de identidad de foto; no se sobrescribe ni se presume idempotencia');
        conBlobs(tx, m.fotoId, anterior, () => {
          tx.objectStore('originales').add(original, m.fotoId);
          tx.objectStore('metadatos').add(m, m.fotoId);
          terminar({ tipo: 'guardada', metadatos: m });
        }, fallar);
      }, 'readwrite');
    },
    guardarMiniatura: async (id, blob, ancho, alto) => {
      const estado: EstadoMiniatura = { tipo: 'lista', bytes: tamanoBlob(blob), ancho, alto, mime: 'image/png' };
      if (tipoBlob(blob) !== 'image/png') throw new Error('Miniatura debe ser PNG');
      // Valida dimensiones antes de comenzar la transacción.
      if (!esEstadoMiniatura(estado)) throw new Error('Estado de miniatura inválido');
      return modificarMiniatura(id, estado, blob);
    },
    registrarFalloMiniatura: async (id, motivo) => {
      const estado: EstadoMiniatura = { tipo: 'fallida', motivo };
      if (!esEstadoMiniatura(estado)) throw new Error('Estado de miniatura inválido');
      return modificarMiniatura(id, estado);
    },
    borrarLocal: async (id) => leer(id, tablas, (m, tx, terminar, fallar) => {
      if (!m) throw new Error('Foto desconocida; no se inventa tombstone');
      conBlobs(tx, id, m, () => {
        tx.objectStore('originales').delete(id); tx.objectStore('miniaturas').delete(id);
        tx.objectStore('metadatos').put({ formato: 1, tipo: 'borrada', fotoId: id } satisfies FotoBorrada, id);
        terminar({ tipo: 'borrada', fotoId: id });
      }, fallar);
    }, 'readwrite'),
  };
}
