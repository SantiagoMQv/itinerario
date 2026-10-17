import { afterEach, describe, expect, it, vi } from 'vitest';
import { itinerario as plan } from '../../src/datos/itinerario';
import { serializarSolicitudRespaldo, type SolicitudRespaldo } from '../../src/fotos-protocolo';
import { admitirMarcoObjetoFotos, clavePrivadaFotos, MAGIC_OBJETO_FOTOS,
  type ContextoObjetosFotos, type ObjetoOriginalFotos } from '../../servidor/almacen-fotos';
import { crearObjetosFotosR2, type VinculoR2Fotos } from '../../servidor/objetos-r2';
import { crearVigenciaFotos, type PresupuestoFotos, type VigenciaFotos } from '../../servidor/multipart-fotos';

const presupuesto: PresupuestoFotos = { maxBytesOriginal: 2000000, maxBytesEntrada: 2200000,
  maxBytesChunk: 65536, maxBytesCabeceras: 1024, maxBytesRetenidos: 8000000,
  maxBloquesOriginal: 100, bytesBloque: 65536, plazoMs: 10000 };
const vigencias: VigenciaFotos[] = [];
afterEach(() => { vigencias.splice(0).forEach((v) => v.cerrar()); });
function contexto(p = presupuesto, signal = new AbortController().signal, plazo = 10000): ContextoObjetosFotos {
  const vigencia = crearVigenciaFotos(signal, plazo); vigencias.push(vigencia);
  return { presupuesto: p, vigencia };
}
const reservaId = 'ABCDEF12-1234-4123-8123-123456789ABE';
function solicitud(bytesOriginal = 3, nombre = '\0 e\u0301 '): SolicitudRespaldo {
  const fotoId = 'ABCDEF12-1234-4123-8123-123456789ABD';
  return { version: 1, tipo: 'solicitud-respaldo', viajeId: plan.id,
    operacionId: 'ABCDEF12-1234-4123-8123-123456789ABC', fotoId, original: { formato: 1, fotoId,
      destino: { tipo: 'parada', viajeId: plan.id, paradaId: plan.dias[0].paradas[0].id },
      nombre, mimeDeclarado: 'IMAGE/HEIC\0', ultimaModificacion: -0, incorporada: -0, bytesOriginal } };
}
function texto(bytes = 3, nombre?: string): string { return serializarSolicitudRespaldo(plan, solicitud(bytes, nombre)); }
const clave = clavePrivadaFotos(plan.id, solicitud().fotoId, reservaId);
function marco(canonico = texto(), original = new Uint8Array([1, 2, 3])): Uint8Array<ArrayBuffer> {
  const metadata = new TextEncoder().encode(canonico);
  const bytes = new Uint8Array(12 + metadata.length + original.length);
  bytes.set(MAGIC_OBJETO_FOTOS); new DataView(bytes.buffer).setUint32(8, metadata.length, false);
  bytes.set(metadata, 12); bytes.set(original, 12 + metadata.length); return bytes;
}
function cuerpo(bytes: Uint8Array, tamano = 65536, cancelar = () => {}): ReadableStream<Uint8Array> {
  let pos = 0;
  return new ReadableStream({ pull(c) {
    if (pos === bytes.length) { c.close(); return; }
    const fin = Math.min(pos + tamano, bytes.length); c.enqueue(bytes.slice(pos, fin)); pos = fin;
  }, cancel: cancelar }, { highWaterMark: 0 });
}
class BucketLocal implements VinculoR2Fotos {
  readonly objetos = new Map<string, Blob>();
  readonly llamadas: string[] = [];
  opciones: Parameters<VinculoR2Fotos['put']>[2] | null = null;
  perder = false;
  async put(k: string, b: Blob, opciones: Parameters<VinculoR2Fotos['put']>[2]) {
    this.llamadas.push('put'); this.opciones = opciones;
    if (this.objetos.has(k)) return null;
    this.objetos.set(k, b);
    if (this.perder) throw new Error('respuesta perdida privada');
    return { key: k, size: b.size };
  }
  async get(k: string) {
    this.llamadas.push('get'); const b = this.objetos.get(k);
    return b ? { key: k, size: b.size, bodyUsed: false,
      body: cuerpo(new Uint8Array(await b.arrayBuffer())) } : null;
  }
}
async function consumir(valor: unknown): Promise<Uint8Array> {
  const lector = (valor as ObjetoOriginalFotos).original.getReader(); const partes: Uint8Array[] = [];
  try { for (;;) { const r = await lector.read(); if (r.done) break; partes.push(r.value); } }
  finally { lector.releaseLock(); }
  const salida = new Uint8Array(partes.reduce((n, p) => n + p.length, 0)); let pos = 0;
  for (const p of partes) { salida.set(p, pos); pos += p.length; } return salida;
}
function remoto(bytes: Uint8Array, cambios: object = {}, tamano = 65536) {
  return { key: clave, size: bytes.length, bodyUsed: false, body: cuerpo(bytes, tamano), ...cambios };
}
function lectura(valor: unknown) {
  const bucket: VinculoR2Fotos = { async put() { throw new Error('put prohibido'); }, async get() { return valor; } };
  return crearObjetosFotosR2({ plan, bucket });
}

describe('admisión del marco físico privado', () => {
  it('cobra retención adicional exacta incluso con original vacío', () => {
    const c = texto(0); const p = { ...presupuesto, maxBytesRetenidos: 1450508 };
    expect(admitirMarcoObjetoFotos(0, c, p)).toEqual({ bytesMetadata: new TextEncoder().encode(c).length,
      bytesFisicos: 12 + new TextEncoder().encode(c).length });
    expect(() => admitirMarcoObjetoFotos(0, c, { ...p, maxBytesRetenidos: p.maxBytesRetenidos - 1 })).toThrow();
  });
  for (const [campo, valor] of [['maxBytesChunk', 0], ['maxBytesRetenidos', NaN], ['maxBytesEntrada', Infinity],
    ['maxBytesOriginal', Number.MAX_SAFE_INTEGER + 1]] as const) {
    it(`configuración ${campo}=${valor} no se interpreta como ilimitada`, () => {
      expect(() => admitirMarcoObjetoFotos(0, texto(0), { ...presupuesto, [campo]: valor })).toThrow();
    });
  }
  it('rechaza exceso físico aunque el original esté admitido', () => {
    expect(() => admitirMarcoObjetoFotos(3, texto(), { ...presupuesto, maxBytesEntrada: 3 })).toThrow();
  });
  it('rechaza metadata de 65537 bytes antes de encoding ilimitado', () => {
    expect(() => admitirMarcoObjetoFotos(0, 'x'.repeat(65537), presupuesto)).toThrow();
  });
});

describe('fronteras adicionales de admisión y captura', () => {
  for (const bytes of [0, 3, 1048581, 2000000]) {
    it(`retención exacta para ${bytes} bytes, sin cambiar multipart`, () => {
      const minimo = 2 * Math.ceil(bytes / 65536) * 65536 + 729600 + 720908 + bytes;
      expect(admitirMarcoObjetoFotos(bytes, texto(bytes), { ...presupuesto, maxBytesRetenidos: minimo }).bytesFisicos).toBe(12 + new TextEncoder().encode(texto(bytes)).length + bytes);
      expect(() => admitirMarcoObjetoFotos(bytes, texto(bytes), { ...presupuesto, maxBytesRetenidos: minimo - 1 })).toThrow();
    });
  }
  for (const bytes of [-1, NaN, Infinity, Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER + 1]) {
    it(`tamaño original no admisible ${bytes}`, () => {
      expect(() => admitirMarcoObjetoFotos(bytes, texto(), presupuesto)).toThrow();
    });
  }
  it('overflow de cargo adicional falla sin configurar un ilimitado', () => {
    expect(() => admitirMarcoObjetoFotos(0, texto(0), { ...presupuesto,
      maxBytesChunk: Number.MAX_SAFE_INTEGER, maxBytesRetenidos: Number.MAX_SAFE_INTEGER })).toThrow();
  });
  it('frontera física 5 GiB incluye metadata y cabecera', () => {
    const c = texto(0); const n = new TextEncoder().encode(c).length;
    const b = 5 * 1024 ** 3 - 12 - n;
    const p = { ...presupuesto, maxBytesOriginal: b + 1, maxBytesEntrada: 5 * 1024 ** 3 + 1,
      maxBytesRetenidos: Number.MAX_SAFE_INTEGER, maxBloquesOriginal: 1000000 };
    expect(admitirMarcoObjetoFotos(b, c, p).bytesFisicos).toBe(5 * 1024 ** 3);
    expect(() => admitirMarcoObjetoFotos(b + 1, c, p)).toThrow();
  });
  for (const c of ['', '\ufeff' + texto(), texto() + ' ', '{}', 'x'.repeat(65537)]) {
    it(`solicitud inválida o no canónica, longitud ${c.length}, cero IO`, async () => {
      const bucket = new BucketLocal(); const a = crearObjetosFotosR2({ plan, bucket });
      await expect(a.leer(clave, c, contexto())).rejects.toMatchObject({ codigo: 503 });
      await expect(a.ponerSiAusente(clave, new Blob([new Uint8Array([1, 2, 3])]), c, contexto())).rejects.toMatchObject({ codigo: 503 });
      expect(bucket.llamadas).toEqual([]);
    });
  }
  for (const k of ['ajena', clave.toLowerCase(), clave + '/', 'x'.repeat(1025), '😀'.repeat(257)]) {
    it(`clave no vinculada/cap excedido ${k.length} unidades, cero IO`, async () => {
      const bucket = new BucketLocal(); const a = crearObjetosFotosR2({ plan, bucket });
      await expect(a.leer(k, texto(), contexto())).rejects.toMatchObject({ codigo: 503 });
      await expect(a.ponerSiAusente(k, new Blob([new Uint8Array([1, 2, 3])]), texto(), contexto())).rejects.toMatchObject({ codigo: 503 });
      expect(bucket.llamadas).toEqual([]);
    });
  }
  for (const p of [{ ...presupuesto, maxBytesChunk: 0 }, { ...presupuesto, maxBytesEntrada: 1 },
    { ...presupuesto, maxBytesRetenidos: 1 }, { ...presupuesto, maxBytesChunk: Infinity }]) {
    it(`configuración/admisión previa sin PUT ni GET ${JSON.stringify(p)}`, async () => {
      const bucket = new BucketLocal(); const a = crearObjetosFotosR2({ plan, bucket });
      await expect(a.leer(clave, texto(), contexto(p))).rejects.toThrow();
      await expect(a.ponerSiAusente(clave, new Blob([new Uint8Array([1, 2, 3])]), texto(), contexto(p))).rejects.toThrow();
      expect(bucket.llamadas).toEqual([]);
    });
  }
  it('presupuesto con accessor no ejecuta getter', async () => {
    let llamadas = 0; const p = { ...presupuesto };
    Object.defineProperty(p, 'maxBytesRetenidos', { get() { llamadas++; return 8000000; }, enumerable: true });
    await expect(lectura(null).leer(clave, texto(), contexto(p))).rejects.toMatchObject({ codigo: 503 });
    expect(llamadas).toBe(0);
  });
  for (const campo of ['plan', 'bucket'] as const) {
    it(`fábrica no evalúa getter de ${campo}`, () => {
      let llamadas = 0; const c = { plan, bucket: new BucketLocal() };
      Object.defineProperty(c, campo, { get() { llamadas++; throw new Error('privado'); }, enumerable: true });
      expect(() => crearObjetosFotosR2(c)).toThrow(); expect(llamadas).toBe(0);
    });
  }
  for (const campo of ['get', 'put'] as const) {
    it(`método accessor heredado ${campo} no se invoca`, () => {
      let llamadas = 0; const bucket = new BucketLocal();
      const proto = Object.create(BucketLocal.prototype);
      Object.defineProperty(proto, campo, { get() { llamadas++; throw new Error('privado'); } });
      Object.setPrototypeOf(bucket, proto);
      expect(() => crearObjetosFotosR2({ plan, bucket })).toThrow(); expect(llamadas).toBe(0);
    });
  }
  it('plan getter anidado rechazado sin invocación', () => {
    const copia = structuredClone(plan); let llamadas = 0;
    Object.defineProperty(copia.dias[0].paradas[0], 'id', { get() { llamadas++; return 'otro'; }, enumerable: true });
    expect(() => crearObjetosFotosR2({ plan: copia, bucket: new BucketLocal() })).toThrow(); expect(llamadas).toBe(0);
  });
  it('captura plan y métodos antes de mutación tardía, conservando receiver', async () => {
    const copia = structuredClone(plan); const bucket = new BucketLocal(); const a = crearObjetosFotosR2({ plan: copia, bucket });
    Object.assign(copia, { id: 'otro' }); bucket.put = async () => { throw new Error('sustituido'); };
    bucket.get = async () => { throw new Error('sustituido'); };
    await expect(a.ponerSiAusente(clave, new Blob([new Uint8Array([1, 2, 3])]), texto(), contexto())).resolves.toBe(true);
    expect(await consumir(await a.leer(clave, texto(), contexto()))).toEqual(new Uint8Array([1, 2, 3]));
  });
  it('Blob usa brand/tamaño intrínseco sin slice ni arrayBuffer extra', async () => {
    const b = new Blob([new Uint8Array([1, 2, 3])]); let llamadas = 0;
    b.slice = () => { llamadas++; throw new Error(); };
    b.arrayBuffer = async () => { llamadas++; throw new Error(); };
    await expect(crearObjetosFotosR2({ plan, bucket: new BucketLocal() }).ponerSiAusente(clave, b, texto(), contexto())).resolves.toBe(true);
    expect(llamadas).toBe(0);
  });
  it('size sobrescrito del Blob se rechaza sin invocar getter ni crear slice', async () => {
    const b = new Blob([new Uint8Array([1, 2, 3])]); let getters = 0; const bucket = new BucketLocal();
    Object.defineProperty(b, 'size', { get() { getters++; throw new Error(); } });
    await expect(crearObjetosFotosR2({ plan, bucket }).ponerSiAusente(clave, b, texto(), contexto())).rejects.toMatchObject({ codigo: 503 });
    expect(getters).toBe(0); expect(bucket.llamadas).toEqual([]);
  });
  for (const original of [{} as Blob, new Blob([]), new Blob(['cuatro'])]) {
    it(`Blob inválido/tamaño contrario ${String(original)} no escribe`, async () => {
      const bucket = new BucketLocal();
      await expect(crearObjetosFotosR2({ plan, bucket }).ponerSiAusente(clave, original, texto(), contexto())).rejects.toMatchObject({ codigo: 503 });
      expect(bucket.llamadas).toEqual([]);
    });
  }
});

describe('metadata completa y lectura física hasta EOF', () => {
  for (const n of [8193, 16384, 65535, 65536]) {
    it(`metadata ${n} bytes cabe dentro del objeto, no customMetadata`, async () => {
      const base = new TextEncoder().encode(texto(0, '')).length;
      const canonico = texto(0, 'x'.repeat(n - base)); const bucket = new BucketLocal();
      const a = crearObjetosFotosR2({ plan, bucket });
      await expect(a.ponerSiAusente(clave, new Blob([]), canonico, contexto())).resolves.toBe(true);
      expect(new TextEncoder().encode(canonico)).toHaveLength(n);
      expect(await consumir(await a.leer(clave, canonico, contexto()))).toHaveLength(0);
      expect(Object.keys(bucket.opciones!)).toEqual(['onlyIf', 'httpMetadata']);
    });
  }
  it('no BMP cuenta bytes UTF8 sin normalizar NFD/NUL/-0/caja/MIME', async () => {
    const c = texto(3, '\0 e\u0301 😀'); const bucket = new BucketLocal(); const a = crearObjetosFotosR2({ plan, bucket });
    await a.ponerSiAusente(clave, new Blob([new Uint8Array([1, 2, 3])]), c, contexto());
    expect(new Uint8Array(await bucket.objetos.get(clave)!.arrayBuffer())).toEqual(marco(c));
    const o = await a.leer(clave, c, contexto()); expect((o as ObjetoOriginalFotos).solicitudCanonica).toBe(c);
    expect(await consumir(o)).toEqual(new Uint8Array([1, 2, 3]));
  });
  it('65537 UTF8 con menos unidades UTF16 falla antes de IO', async () => {
    const base = new TextEncoder().encode(texto(0, '')).length;
    const nombre = '😀'.repeat(Math.floor((65537 - base) / 4)) + 'x'.repeat((65537 - base) % 4);
    // El codec productor rechaza el exceso; construir sólo el texto de prueba inválido.
    const c = texto(0, '').replace('"nombre":""', '"nombre":' + JSON.stringify(nombre));
    expect(new TextEncoder().encode(c)).toHaveLength(65537); expect(c.length).toBeLessThan(65536);
    const bucket = new BucketLocal(); await expect(crearObjetosFotosR2({ plan, bucket }).leer(clave, c, contexto())).rejects.toThrow();
    expect(bucket.llamadas).toEqual([]);
  });
  for (const variante of ['BOM', 'UTF8', 'metadata-distinta', 'truncado-header', 'truncado-metadata'] as const) {
    it(`rechaza ${variante} sin entregar original`, async () => {
      let bytes = marco(); const n = new TextEncoder().encode(texto()).length;
      if (variante === 'BOM') bytes.set([239, 187, 191], 12);
      if (variante === 'UTF8') bytes[12 + n - 1] = 0xc3;
      if (variante === 'metadata-distinta') bytes[12 + 2] ^= 1;
      if (variante === 'truncado-header') bytes = bytes.slice(0, 11);
      if (variante === 'truncado-metadata') bytes = bytes.slice(0, 12 + n - 1);
      const r = remoto(bytes, { size: marco().length });
      await expect(lectura(r).leer(clave, texto(), contexto())).rejects.toMatchObject({ codigo: 503 });
      expect(r.body.locked).toBe(false);
    });
  }
  for (const delta of [-1, 1]) {
    it(`EOF ${delta < 0 ? 'corto' : 'largo'} no es tamaño declarado como testigo`, async () => {
      const b = marco(); const datos = delta < 0 ? b.slice(0, -1) : new Uint8Array([...b, 4]);
      // Prefijo separado: error ocurre al consumir, no se oculta cerrando a B/P.
      const r = remoto(datos, { size: b.length }, 12 + new TextEncoder().encode(texto()).length);
      const o = await lectura(r).leer(clave, texto(), contexto());
      await expect(consumir(o)).rejects.toMatchObject({ codigo: 503 }); expect(r.body.locked).toBe(false);
    });
  }
  it('cero original no cierra antes del EOF: error después de prefijo falla', async () => {
    const bytes = marco(texto(0), new Uint8Array()); let lecturas = 0;
    const body = new ReadableStream<Uint8Array>({ pull(c) { lecturas++; if (lecturas === 1) c.enqueue(bytes); else c.error(new Error('EOF perdido')); } }, { highWaterMark: 0 });
    const a = lectura({ key: clave, size: bytes.length, bodyUsed: false, body });
    const o = await a.leer(clave, texto(0), contexto()); expect(lecturas).toBe(1);
    await expect(consumir(o)).rejects.toMatchObject({ codigo: 503 }); expect(lecturas).toBe(2);
  });
  it('cero original con trailer no entrega éxito', async () => {
    const b = marco(texto(0), new Uint8Array());
    const o = await lectura(remoto(new Uint8Array([...b, 0]), { size: b.length }, b.length)).leer(clave, texto(0), contexto());
    await expect(consumir(o)).rejects.toMatchObject({ codigo: 503 });
  });
  it('EOF pendiente con cero bytes mantiene incertidumbre hasta deadline', async () => {
    const b = marco(texto(0), new Uint8Array()); let paso = 0; let cancelados = 0;
    const body = new ReadableStream<Uint8Array>({ pull(c) {
      if (paso++ === 0) c.enqueue(b); else return new Promise<void>(() => {});
    }, cancel() { cancelados++; } }, { highWaterMark: 0 });
    const o = await lectura({ key: clave, size: b.length, bodyUsed: false, body }).leer(clave, texto(0),
      contexto(presupuesto, new AbortController().signal, 10));
    await expect(consumir(o)).rejects.toMatchObject({ codigo: 503 });
    expect(cancelados).toBe(1); expect(body.locked).toBe(false);
  });
  it('HWM0 propio no pide payload/EOF especulativo antes del consumidor', async () => {
    const b = marco(); let pulls = 0; let pos = 0;
    const body = new ReadableStream<Uint8Array>({ pull(c) { pulls++; if (pos === b.length) c.close();
      else { const fin = pos === 0 ? b.length - 3 : b.length; c.enqueue(b.slice(pos, fin)); pos = fin; } } }, { highWaterMark: 0 });
    const o = await lectura({ key: clave, size: b.length, bodyUsed: false, body }).leer(clave, texto(), contexto());
    await Promise.resolve(); expect(pulls).toBe(1); expect(body.locked).toBe(true);
    expect(await consumir(o)).toEqual(new Uint8Array([1, 2, 3])); expect(pulls).toBe(3); expect(body.locked).toBe(false);
  });
  it('backing mutable se copia antes de esperar otra lectura', async () => {
    const b = marco(); let vueltas = 0;
    const body = new ReadableStream<Uint8Array>({ pull(c) { if (vueltas++ === 0) c.enqueue(b); else c.close(); } }, { highWaterMark: 0 });
    const o = await lectura({ key: clave, size: b.length, bodyUsed: false, body }).leer(clave, texto(), contexto());
    b.fill(99); expect(await consumir(o)).toEqual(new Uint8Array([1, 2, 3]));
  });
  it('chunks vacíos no prueban EOF ni generan datos', async () => {
    const b = marco(); let paso = 0;
    const body = new ReadableStream<Uint8Array>({ pull(c) { const i = paso++;
      if (i === 1) c.enqueue(b); else if (i < 4) c.enqueue(new Uint8Array()); else c.close(); } }, { highWaterMark: 0 });
    expect(await consumir(await lectura({ key: clave, size: b.length, bodyUsed: false, body }).leer(clave, texto(), contexto()))).toEqual(new Uint8Array([1, 2, 3]));
  });
  for (const variante of ['tipo', 'SharedArrayBuffer', 'exceso-chunk', 'exceso-fisico'] as const) {
    it(`rechaza chunk ${variante} antes de copiar o refragmentar`, async () => {
      const b = marco(); let cancelados = 0; let valor: unknown;
      if (variante === 'tipo') valor = 'bytes';
      if (variante === 'SharedArrayBuffer') valor = new Uint8Array(new SharedArrayBuffer(b.length));
      if (variante === 'exceso-chunk') valor = new Uint8Array(65537);
      if (variante === 'exceso-fisico') valor = new Uint8Array(b.length + 1);
      const body = new ReadableStream<Uint8Array>({ pull(c) { c.enqueue(valor as Uint8Array); }, cancel() { cancelados++; } }, { highWaterMark: 0 });
      await expect(lectura({ key: clave, size: b.length, bodyUsed: false, body }).leer(clave, texto(), contexto())).rejects.toMatchObject({ codigo: 503 });
      expect(cancelados).toBe(1); expect(body.locked).toBe(false);
    });
  }
});

describe('propiedad del reader, deadlines y errores privados', () => {
  for (const bloqueado of [false, true]) {
    it(`bodyUsed/reader ajeno no se invade, locked=${bloqueado}`, async () => {
      let cancelados = 0; const body = cuerpo(marco(), 65536, () => { cancelados++; });
      const propietario = body.getReader();
      if (!bloqueado) { await propietario.read(); propietario.releaseLock(); }
      const r = { key: clave, size: marco().length, bodyUsed: !bloqueado, body };
      await expect(lectura(r).leer(clave, texto(), contexto())).rejects.toMatchObject({ codigo: 503 });
      expect(cancelados).toBe(0); expect(body.locked).toBe(bloqueado);
      if (bloqueado) { await propietario.cancel(); propietario.releaseLock(); }
    });
  }
  it('cancel propio idempotente no espera hook colgado', async () => {
    const b = marco(); let cancelados = 0;
    const body = cuerpo(b, b.length, () => { cancelados++; return new Promise<void>(() => {}); });
    const o = await lectura({ key: clave, size: b.length, bodyUsed: false, body }).leer(clave, texto(), contexto());
    const original = (o as ObjetoOriginalFotos).original;
    await original.cancel(); await original.cancel();
    expect(cancelados).toBe(1); expect(body.locked).toBe(false);
  });
  it('rechazo del hook cancel no sustituye el fallo principal', async () => {
    const b = marco(); b[0] = 0; let cancelados = 0;
    const body = cuerpo(b, b.length, () => { cancelados++; return Promise.reject(new Error('privado cancel')); });
    await expect(lectura({ key: clave, size: b.length, bodyUsed: false, body }).leer(clave, texto(), contexto())).rejects.toMatchObject({ codigo: 503 });
    await Promise.resolve(); expect(cancelados).toBe(1); expect(body.locked).toBe(false);
  });
  it('abort previo impide todo IO de PUT y GET', async () => {
    const abort = new AbortController(); abort.abort(); const bucket = new BucketLocal(); const a = crearObjetosFotosR2({ plan, bucket });
    await expect(a.leer(clave, texto(), contexto(presupuesto, abort.signal))).rejects.toMatchObject({ codigo: 503 });
    await expect(a.ponerSiAusente(clave, new Blob([new Uint8Array([1, 2, 3])]), texto(), contexto(presupuesto, abort.signal))).rejects.toMatchObject({ codigo: 503 });
    expect(bucket.llamadas).toEqual([]);
  });
  it('PUT pendiente que persiste tarde no se reintenta ni inicia GET', async () => {
    vi.useFakeTimers();
    let c: ContextoObjetosFotos | undefined;
    try {
      c = contexto(presupuesto, new AbortController().signal, 10);
      let resolver: (v: { key: string; size: number } | null) => void = () => {}; const bucket = new BucketLocal();
      bucket.put = (k, b) => { bucket.llamadas.push('put'); bucket.objetos.set(k, b);
        return new Promise((ok) => { resolver = ok; }); };
      const pendiente = crearObjetosFotosR2({ plan, bucket }).ponerSiAusente(clave, new Blob([new Uint8Array([1, 2, 3])]), texto(), c);
      const rechazo = expect(pendiente).rejects.toMatchObject({ codigo: 503 });
      // El caso exige un PUT ya iniciado: la validación previa no puede consumir el plazo por carga del equipo.
      expect(bucket.llamadas).toEqual(['put']);
      await vi.advanceTimersByTimeAsync(10);
      await rechazo;
      resolver({ key: clave, size: marco().length }); await Promise.resolve(); await Promise.resolve();
      expect(bucket.llamadas).toEqual(['put']); expect(bucket.objetos.size).toBe(1);
    } finally {
      c?.vigencia.cerrar();
      vi.useRealTimers();
    }
  });
  it('máximo un read pendiente aunque consumidor solicite varios', async () => {
    const b = marco(); let paso = 0; let activos = 0; let maximo = 0;
    let liberar: () => void = () => {}; let iniciada: () => void = () => {};
    const entrada = new Promise<void>((ok) => { iniciada = ok; });
    const body = new ReadableStream<Uint8Array>({ async pull(c) {
      activos++; maximo = Math.max(maximo, activos);
      try {
        if (paso++ === 0) c.enqueue(b.slice(0, -3));
        else if (paso === 2) { iniciada(); await new Promise<void>((ok) => { liberar = ok; }); c.enqueue(new Uint8Array([1, 2, 3])); }
        else c.close();
      } finally { activos--; }
    } }, { highWaterMark: 0 });
    const o = await lectura({ key: clave, size: b.length, bodyUsed: false, body }).leer(clave, texto(), contexto());
    const lector = (o as ObjetoOriginalFotos).original.getReader(); const primero = lector.read(); const segundo = lector.read();
    await entrada; expect(maximo).toBe(1); liberar();
    expect((await primero).value).toEqual(new Uint8Array([1, 2, 3])); expect((await segundo).done).toBe(true);
    expect(maximo).toBe(1); expect(body.locked).toBe(false); lector.releaseLock();
  });
  it('deadline durante prefijo cancela reader propio aunque cancel cuelgue', async () => {
    let cancelados = 0;
    const body = new ReadableStream<Uint8Array>({ pull() { return new Promise<void>(() => {}); },
      cancel() { cancelados++; return new Promise<void>(() => {}); } }, { highWaterMark: 0 });
    await expect(lectura({ key: clave, size: marco().length, bodyUsed: false, body }).leer(clave, texto(), contexto(presupuesto, new AbortController().signal, 10))).rejects.toMatchObject({ codigo: 503 });
    expect(cancelados).toBe(1); await Promise.resolve(); expect(body.locked).toBe(false);
  });
  it('abort tras prefijo libera bloqueo y no emite remainder', async () => {
    const abort = new AbortController(); let cancelados = 0; const b = marco();
    const body = cuerpo(b, b.length, () => { cancelados++; });
    const o = await lectura({ key: clave, size: b.length, bodyUsed: false, body }).leer(clave, texto(), contexto(presupuesto, abort.signal));
    abort.abort(); await expect(consumir(o)).rejects.toMatchObject({ codigo: 503 });
    expect(cancelados).toBe(1); expect(body.locked).toBe(false);
  });
  it('cancel durante lectura pendiente no emite respuesta tardía', async () => {
    const b = marco(); let paso = 0; let canal: ReadableStreamDefaultController<Uint8Array> | null = null; let cancelados = 0;
    const body = new ReadableStream<Uint8Array>({ pull(c) {
      if (paso++ === 0) c.enqueue(b.slice(0, -3)); else canal = c;
    }, cancel() { cancelados++; } }, { highWaterMark: 0 });
    const o = await lectura({ key: clave, size: b.length, bodyUsed: false, body }).leer(clave, texto(), contexto());
    const lector = (o as ObjetoOriginalFotos).original.getReader(); const pendiente = lector.read();
    await Promise.resolve(); await Promise.resolve();
    await lector.cancel(); expect(await pendiente).toEqual({ done: true, value: undefined });
    expect(cancelados).toBe(1); expect(body.locked).toBe(false);
    expect(() => (canal as ReadableStreamDefaultController<Uint8Array> | null)?.enqueue(new Uint8Array([1, 2, 3]))).toThrow();
    lector.releaseLock();
  });
  it('GET tardío expirado cancela sólo cuerpo libre, cero pulls', async () => {
    let resolver: (r: unknown) => void = () => {}; let pulls = 0; let cancelados = 0;
    const body = new ReadableStream<Uint8Array>({ pull() { pulls++; }, cancel() { cancelados++; } }, { highWaterMark: 0 });
    const bucket: VinculoR2Fotos = { get() { return new Promise((ok) => { resolver = ok; }); }, async put() { return null; } };
    await expect(crearObjetosFotosR2({ plan, bucket }).leer(clave, texto(), contexto(presupuesto, new AbortController().signal, 10))).rejects.toMatchObject({ codigo: 503 });
    resolver({ key: clave, size: marco().length, bodyUsed: false, body });
    await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
    expect(cancelados).toBe(1); expect(pulls).toBe(0); expect(body.locked).toBe(false);
  });
  it('GET tardío con reader ajeno no lo cancela', async () => {
    let resolver: (r: unknown) => void = () => {}; let cancelados = 0; const body = cuerpo(marco(), 1, () => { cancelados++; });
    const propietario = body.getReader();
    const bucket: VinculoR2Fotos = { get() { return new Promise((ok) => { resolver = ok; }); }, async put() { return null; } };
    await expect(crearObjetosFotosR2({ plan, bucket }).leer(clave, texto(), contexto(presupuesto, new AbortController().signal, 10))).rejects.toMatchObject({ codigo: 503 });
    resolver({ key: clave, size: marco().length, bodyUsed: false, body });
    await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
    expect(cancelados).toBe(0); expect(body.locked).toBe(true); await propietario.cancel(); propietario.releaseLock();
  });
  it('contexto y métodos de vigencia capturados antes de GET pendiente', async () => {
    let resolver: (r: unknown) => void = () => {}; let iniciada: () => void = () => {};
    const entrada = new Promise<void>((ok) => { iniciada = ok; });
    const p = { ...presupuesto }; const c = contexto(p);
    const bucket: VinculoR2Fotos = { get() { iniciada(); return new Promise((ok) => { resolver = ok; }); }, async put() { return null; } };
    const pendiente = crearObjetosFotosR2({ plan, bucket }).leer(clave, texto(), c); await entrada;
    p.maxBytesChunk = 0; c.vigencia.comprobar = () => { throw new Error('tardío'); };
    resolver(remoto(marco())); expect(await consumir(await pendiente)).toEqual(new Uint8Array([1, 2, 3]));
  });
  for (const campo of ['presupuesto', 'vigencia'] as const) {
    it(`contexto accessor ${campo} no se evalúa`, async () => {
      const c = contexto(); let getters = 0;
      Object.defineProperty(c, campo, { get() { getters++; throw new Error(); }, enumerable: true });
      await expect(lectura(null).leer(clave, texto(), c)).rejects.toMatchObject({ codigo: 503 }); expect(getters).toBe(0);
    });
  }
  for (const fase of ['get', 'put'] as const) {
    it(`429/exception privada en ${fase} es neutral sin retry`, async () => {
      let llamadas = 0;
      const bucket: VinculoR2Fotos = { async get() { llamadas++; throw new Error('429 secreto'); }, async put() { llamadas++; throw new Error('429 secreto'); } };
      const a = crearObjetosFotosR2({ plan, bucket });
      const accion = fase === 'get' ? a.leer(clave, texto(), contexto()) : a.ponerSiAusente(clave, new Blob([new Uint8Array([1, 2, 3])]), texto(), contexto());
      await expect(accion).rejects.toMatchObject({ codigo: 503, message: 'No se pudo completar la solicitud de fotos.' }); expect(llamadas).toBe(1);
    });
  }
  for (const resultado of [undefined, true, {}, { key: 'ajeno', size: marco().length }, { key: clave, size: NaN }]) {
    it(`PUT con resultado mal formado ${JSON.stringify(resultado)} no confirma`, async () => {
      let llamadas = 0; const bucket: VinculoR2Fotos = { async get() { throw new Error(); }, async put() { llamadas++; return resultado; } };
      await expect(crearObjetosFotosR2({ plan, bucket }).ponerSiAusente(clave, new Blob([new Uint8Array([1, 2, 3])]), texto(), contexto())).rejects.toMatchObject({ codigo: 503 });
      expect(llamadas).toBe(1);
    });
  }
});

describe('R2 condicional, un solo objeto y solicitud íntegra', () => {
  it('una PUT condicional produce el marco exacto y una GET quita sólo el prefijo', async () => {
    const bucket = new BucketLocal(); const adapter = crearObjetosFotosR2({ plan, bucket });
    expect(bucket.llamadas).toEqual([]);
    expect(await adapter.ponerSiAusente(clave, new Blob([new Uint8Array([1, 2, 3])]), texto(), contexto())).toBe(true);
    expect(bucket.llamadas).toEqual(['put']); expect(bucket.objetos.size).toBe(1);
    const b = bucket.objetos.get(clave)!;
    expect(new Uint8Array(await b.arrayBuffer())).toEqual(marco()); expect(b.type).toBe('application/octet-stream');
    expect([...bucket.opciones!.onlyIf]).toEqual([['if-none-match', '*']]);
    expect(bucket.opciones!.httpMetadata).toEqual({ contentType: 'application/octet-stream' });
    const objeto = await adapter.leer(clave, texto(), contexto());
    expect((objeto as ObjetoOriginalFotos).solicitudCanonica).toBe(texto());
    expect(await consumir(objeto)).toEqual(new Uint8Array([1, 2, 3]));
  });
  it('null de precondición no reemplaza objeto anterior ni inicia GET', async () => {
    const bucket = new BucketLocal(); const previo = new Blob(['previo']); bucket.objetos.set(clave, previo);
    expect(await crearObjetosFotosR2({ plan, bucket }).ponerSiAusente(clave, new Blob([new Uint8Array([1, 2, 3])]), texto(), contexto())).toBe(false);
    expect(bucket.objetos.get(clave)).toBe(previo); expect(bucket.llamadas).toEqual(['put']);
  });
  it('respuesta perdida conserva objeto sin retry ni lectura', async () => {
    const bucket = new BucketLocal(); bucket.perder = true;
    await expect(crearObjetosFotosR2({ plan, bucket }).ponerSiAusente(clave, new Blob([new Uint8Array([1, 2, 3])]), texto(), contexto())).rejects.toMatchObject({ codigo: 503 });
    expect(bucket.llamadas).toEqual(['put']); expect(bucket.objetos.size).toBe(1);
  });
  it('ausencia devuelve null', async () => {
    expect(await crearObjetosFotosR2({ plan, bucket: new BucketLocal() }).leer(clave, texto(), contexto())).toBeNull();
  });
  it('original vacío requiere prefijo válido y EOF real', async () => {
    const datos = marco(texto(0), new Uint8Array());
    expect(await consumir(await lectura(remoto(datos, {}, 1)).leer(clave, texto(0), contexto()))).toEqual(new Uint8Array());
  });
  for (const campo of ['key', 'size', 'bodyUsed'] as const) {
    it(`rechaza ${campo} incorrecto del proveedor`, async () => {
      const cambios = { [campo]: campo === 'key' ? 'ajeno' : campo === 'size' ? 0 : true };
      await expect(lectura(remoto(marco(), cambios)).leer(clave, texto(), contexto())).rejects.toMatchObject({ codigo: 503 });
    });
  }
  it('cabecera repartida byte a byte y payload mixto conservan datos', async () => {
    expect(await consumir(await lectura(remoto(marco(), {}, 1)).leer(clave, texto(), contexto()))).toEqual(new Uint8Array([1, 2, 3]));
  });
  for (const indice of [0, 7, 8, 11]) {
    it(`cabecera corrupta byte ${indice} no entrega original`, async () => {
      const bytes = marco(); bytes[indice] ^= 1;
      await expect(lectura(remoto(bytes)).leer(clave, texto(), contexto())).rejects.toMatchObject({ codigo: 503 });
    });
  }
});
