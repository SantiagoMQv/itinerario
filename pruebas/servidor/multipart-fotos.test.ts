import { describe, it, expect } from 'vitest';
import { itinerario as plan } from '../../src/datos/itinerario';
import { serializarSolicitudRespaldo, serializarReciboRespaldo, type SolicitudRespaldo } from '../../src/fotos-protocolo';
import { copiarPresupuestoFotos, crearVigenciaFotos, leerMultipartFotos, copiarPlanFotos,
  bytesRetenidosFotos, type PresupuestoFotos } from '../../servidor/multipart-fotos';

import { crearControladorFotos } from '../../servidor/api-fotos';
import { crearAlmacenFotos } from '../../servidor/almacen-fotos';
import type { Itinerario } from '../../src/tipos';

const presupuesto: PresupuestoFotos = {
  maxBytesOriginal: 2000000, maxBytesEntrada: 2200000, maxBytesChunk: 65536,
  maxBytesCabeceras: 1024, maxBytesRetenidos: 8000000, maxBloquesOriginal: 100,
  bytesBloque: 65536, plazoMs: 10000,
};
const ref = (bytesOriginal = 3): SolicitudRespaldo => ({ version: 1, tipo: 'solicitud-respaldo',
  viajeId: plan.id, operacionId: 'ABCDEF12-1234-4123-8123-123456789ABC',
  fotoId: 'ABCDEF12-1234-4123-8123-123456789ABD', original: { formato: 1,
    fotoId: 'ABCDEF12-1234-4123-8123-123456789ABD', destino: { tipo: 'parada',
      viajeId: plan.id, paradaId: plan.dias[0].paradas[0].id }, nombre: '\0 e\u0301 😀 ',
    mimeDeclarado: 'IMAGE/HEIC\0', ultimaModificacion: -0, incorporada: -0, bytesOriginal } });
const codificador = new TextEncoder();
function unir(...partes: Uint8Array[]): Uint8Array {
  const resultado = new Uint8Array(partes.reduce((n, p) => n + p.length, 0));
  let pos = 0;
  for (const p of partes) { resultado.set(p, pos); pos += p.length; }
  return resultado;
}
function cuerpo(texto = serializarSolicitudRespaldo(plan, ref()), original = new Uint8Array([1, 2, 3]), cierre = '\r\n--frontera--') {
  return unir(codificador.encode('--frontera\r\nContent-Disposition: form-data; name="solicitud"\r\n\r\n' + texto
    + '\r\n--frontera\r\nContent-Disposition: form-data; name="original"; filename="original"\r\nContent-Type: application/octet-stream\r\n\r\n'),
  original, codificador.encode(cierre));
}
function request(datos: Uint8Array, tamano = 31, tipo = 'multipart/form-data; boundary=frontera') {
  let offset = 0; let cancelaciones = 0;
  const stream = new ReadableStream<Uint8Array>({ pull(c) {
    if (offset === datos.length) { c.close(); return; }
    const fin = Math.min(datos.length, offset + tamano); c.enqueue(datos.slice(offset, fin)); offset = fin;
  }, cancel() { cancelaciones++; } });
  const solicitud = new Request('https://viaje.test/api/fotos/respaldo', {
    method: 'POST', headers: { 'Content-Type': tipo }, body: stream, duplex: 'half',
  } as RequestInit);
  return { solicitud, cancelaciones: () => cancelaciones };
}
async function leer(datos = cuerpo(), p = presupuesto, tamano = 31, tipo?: string) {
  const { solicitud } = request(datos, tamano, tipo);
  const v = crearVigenciaFotos(solicitud.signal, p.plazoMs);
  try { return await leerMultipartFotos(plan, solicitud, p, v); } finally { v.cerrar(); }
}

describe('presupuesto explícito por invocación', () => {
  it('rechaza un campo desconocido antes de IO', () => {
    expect(() => copiarPresupuestoFotos({ ...presupuesto, ilimitado: true })).toThrow();
  });
  it('rechaza ausencia, símbolos y accessors sin ejecutarlos', () => {
    let llamadas = 0;
    const getter = { ...presupuesto };
    Object.defineProperty(getter, 'maxBytesOriginal', { get() { llamadas++; return 1; } });
    for (const valor of [undefined, {}, { ...presupuesto, [Symbol()]: 1 }, getter]) {
      expect(() => copiarPresupuestoFotos(valor)).toThrow();
    }
    expect(llamadas).toBe(0);
  });
  for (const campo of Object.keys(presupuesto)) {
    it(`rechaza ${campo} negativo, infinito, inseguro y fraccionario`, () => {
      for (const n of [-1, Infinity, NaN, Number.MAX_SAFE_INTEGER + 1, 0.5]) {
        expect(() => copiarPresupuestoFotos({ ...presupuesto, [campo]: n })).toThrow();
      }
    });
  }
  it('bloque y plazo tienen intervalos positivos propios', () => {
    for (const n of [0, 1048577]) expect(() => copiarPresupuestoFotos({ ...presupuesto, bytesBloque: n })).toThrow();
    for (const n of [0, 2147483648]) expect(() => copiarPresupuestoFotos({ ...presupuesto, plazoMs: n })).toThrow();
  });
  it('snapshot independiente, propios no enumerables y ceros de límites', () => {
    const original = { ...presupuesto, maxBytesOriginal: 0 };
    Object.defineProperty(original, 'maxBytesChunk', { value: 0, enumerable: false });
    const copia = copiarPresupuestoFotos(original);
    original.maxBytesOriginal = 9;
    expect(copia.maxBytesOriginal).toBe(0); expect(copia.maxBytesChunk).toBe(0);
    expect(Object.isFrozen(copia)).toBe(true);
  });
});

describe('snapshot puro del plan de operador', () => {
  const blancos: [string, (p: Itinerario) => object, string][] = [
    ['raíz', (p) => p, 'id'], ['días', (p) => p, 'dias'],
    ['día', (p) => p.dias[0], 'titulo'],
    ['parada', (p) => p.dias[0].paradas[0], 'id'],
    ['subparada', (p) => p.dias.flatMap((d) => d.paradas).find((s) => s.subparadas?.length)!.subparadas![0], 'nombre'],
    ['llegada', (p) => p.dias.flatMap((d) => d.paradas).find((s) => s.llegada)!.llegada!, 'detalle'],
    ['gasto', (p) => p.dias.flatMap((d) => d.paradas).find((s) => s.gastos?.length)!.gastos![0], 'min'],
    ['enlace', (p) => p.dias.flatMap((d) => d.paradas).find((s) => s.enlaces?.length)!.enlaces![0], 'url'],
    ['sección', (p) => p.secciones![0], 'titulo'],
    ['pendiente', (p) => p.pendientes![0], 'texto'],
    ['índice array', (p) => p.dias, '0'], ['propiedad array', (p) => p.dias, 'oculta'],
  ];
  for (const [nombre, objeto, clave] of blancos) {
    for (const modo of ['cambia', 'lanza', 'setter', 'oculto', 'heredado']) {
      it(`rechaza ${nombre}/${modo} en helper y fábricas sin evaluar accessors ni puertos`, () => {
        const copia = structuredClone(plan);
        const destino = objeto(copia);
        let llamadas = 0; let io = 0;
        const descriptor: PropertyDescriptor = modo === 'setter'
          ? { set() { llamadas++; } }
          : { get() { llamadas++; if (modo === 'lanza') throw new Error('sonda'); return llamadas === 1 ? 'válido' : 'otro'; } };
        descriptor.enumerable = modo !== 'oculto';
        if (modo === 'heredado') {
          Reflect.deleteProperty(destino, clave);
          Object.setPrototypeOf(destino, Object.create(Object.getPrototypeOf(destino), { [clave]: descriptor }));
        } else Object.defineProperty(destino, clave, descriptor);
        const puerto = async () => { io++; return null; };
        const repositorio = { reservar: puerto, finalizar: puerto, leerConfirmada: puerto };
        const objetos = { ponerSiAusente: puerto, leer: puerto };
        for (const fabricar of [() => copiarPlanFotos(copia),
          () => crearAlmacenFotos({ plan: copia, repositorio, objetos }),
          () => crearControladorFotos({ plan: copia, origen: 'https://viaje.test', autenticar: puerto, repositorio, objetos })]) {
          expect(fabricar).toThrow();
          expect(llamadas).toBe(0);
          expect(io).toBe(0);
        }
      });
    }
  }
  it('preserva datos tipados, alias por valor y aislamiento de mutaciones tardías', () => {
    const original = structuredClone(plan);
    const llegada = { modo: 'metro' as const, detalle: 'NUL\0 e\u0301 ABCDEF', min: -0 };
    original.dias[0].paradas[0].llegada = llegada;
    original.dias[0].paradas[1].llegada = llegada;
    original.yuanesPorEuro = -0;
    const copia = copiarPlanFotos(original);
    expect(copia).toEqual(original);
    expect(Object.is(copia.yuanesPorEuro, -0)).toBe(true);
    expect(Object.is(copia.dias[0].paradas[0].llegada!.min, -0)).toBe(true);
    llegada.detalle = 'mutado'; original.dias[0].paradas[0].nombre = 'mutado';
    expect(copia.dias[0].paradas[0].llegada!.detalle).toBe('NUL\0 e\u0301 ABCDEF');
    expect(copia.dias[0].paradas[1].llegada).toEqual(copia.dias[0].paradas[0].llegada);
    expect(copia.dias[0].paradas[0].nombre).not.toBe('mutado');
  });
  it('rechaza funciones, objetos exóticos y ciclos sin conversión implícita', () => {
    for (const valor of [() => {}, new Date(), new Map(), /sonda/]) {
      const copia = structuredClone(plan);
      Object.defineProperty(copia, 'titulo', { value: valor });
      expect(() => copiarPlanFotos(copia)).toThrow();
    }
    const ciclo = structuredClone(plan);
    Object.defineProperty(ciclo, 'titulo', { value: ciclo });
    expect(() => copiarPlanFotos(ciclo)).toThrow();
  });
});

describe('multipart incremental cerrado', () => {
  it('fragmentos de un byte preservan -0/NUL/NFD/UTF8 y UUID mayúscula', async () => {
    const c = await leer(cuerpo(), { ...presupuesto, maxBloquesOriginal: 1 }, 1);
    expect(c.solicitud).toEqual(ref());
    expect(Object.is(c.solicitud.original.incorporada, -0)).toBe(true);
    expect(c.original.type).toBe('application/octet-stream');
    expect(Array.from(new Uint8Array(await c.original.arrayBuffer()))).toEqual([1, 2, 3]);
  });
  it('FormData nativo mantiene MIME wrapper separado del raw', async () => {
    const form = new FormData(); form.append('solicitud', serializarSolicitudRespaldo(plan, ref()));
    form.append('original', new Blob([new Uint8Array([1, 2, 3])], { type: 'application/octet-stream' }), 'original');
    const solicitud = new Request('https://viaje.test/api/fotos/respaldo', { method: 'POST', body: form });
    const v = crearVigenciaFotos(solicitud.signal, 10000);
    try {
      const c = await leerMultipartFotos(plan, solicitud, presupuesto, v);
      expect(c.solicitud.original.mimeDeclarado).toBe('IMAGE/HEIC\0');
    } finally { v.cerrar(); }
  });
  it('prefijos de frontera inválidos y solapados siguen siendo payload', async () => {
    const binario = codificador.encode('a\r\n--fronteraXXb\r\n--frontera-X\r\n--fronte\r\n--fronteraX-');
    const c = await leer(cuerpo(serializarSolicitudRespaldo(plan, ref(binario.length)), binario), presupuesto, 1);
    expect(new Uint8Array(await c.original.arrayBuffer())).toEqual(binario);
  });
  it('cierre con CRLF único y EOF, incluso Blob físico vacío y metadata -0', async () => {
    const c = await leer(cuerpo(serializarSolicitudRespaldo(plan, ref(-0)), new Uint8Array(), '\r\n--frontera--\r\n'),
      { ...presupuesto, maxBytesOriginal: 0, maxBloquesOriginal: 0 });
    expect(c.original.size).toBe(0); expect(Object.is(c.solicitud.original.bytesOriginal, -0)).toBe(true);
  });
  for (const [nombre, final] of [['truncado', '\r\n--frontera-'], ['epílogo', '\r\n--frontera--x'],
    ['dobleCRLF', '\r\n--frontera--\r\n\r\n'], ['parteextra', '\r\n--frontera\r\n']]) {
    it(`rechaza ${nombre}`, async () => { await expect(leer(cuerpo(undefined, undefined, final))).rejects.toMatchObject({ codigo: 400 }); });
  }
  it('rechaza preámbulo y EOF prematuro en cabecera/metadata/original', async () => {
    await expect(leer(unir(codificador.encode('x'), cuerpo()))).rejects.toMatchObject({ codigo: 400 });
    for (const n of [1, 30, 100, cuerpo().length - 3]) {
      await expect(leer(cuerpo().slice(0, n))).rejects.toMatchObject({ codigo: 400 });
    }
  });
  it('rechaza count físico corto/largo sin normalizar metadata', async () => {
    for (const n of [2, 4]) await expect(leer(cuerpo(serializarSolicitudRespaldo(plan, ref(n))))).rejects.toMatchObject({ codigo: 400 });
  });
  for (const [nombre, cambio] of [
    ['duplicada', (s: string) => s.replace('Content-Disposition:', 'Content-Disposition: x\r\nContent-Disposition:')],
    ['plegada', (s: string) => s.replace('name="solicitud"', '\r\n name="solicitud"')],
    ['filename metadata', (s: string) => s.replace('name="solicitud"', 'name="solicitud"; filename="x"')],
    ['filename original', (s: string) => s.replace('filename="original"', 'filename="otro"')],
    ['parámetro repetido', (s: string) => s.replace('name="original";', 'name="original"; name="original";')],
    ['MIME wrapper', (s: string) => s.replace('application/octet-stream', 'image/heic')],
  ] as const) {
    it(`rechaza cabecera ${nombre}`, async () => {
      await expect(leer(codificador.encode(cambio(new TextDecoder().decode(cuerpo()))))).rejects.toMatchObject({ codigo: 400 });
    });
  }
  it('no elimina BOM, rechaza UTF8 inválido/duplicados escaped y padre falso', async () => {
    const canonico = serializarSolicitudRespaldo(plan, ref());
    for (const texto of ['\ufeff' + canonico, canonico.replace('"version":1', '"version":1,"vers\\u0069on":1'),
      canonico.replace(plan.dias[0].paradas[0].id, 'padre-desconocido')]) {
      await expect(leer(cuerpo(texto))).rejects.toMatchObject({ codigo: 400 });
    }
    const invalido = cuerpo(); const inicio = invalido.indexOf(123); invalido[inicio + 1] = 255;
    await expect(leer(invalido)).rejects.toMatchObject({ codigo: 400 });
  });
  it('64KiB metadata medidos antes de decode y recibo potencial antes de captura', async () => {
    await expect(leer(cuerpo(' '.repeat(65537)))).rejects.toMatchObject({ codigo: 413 });
    const s = ref();
    const vacia = { ...s, original: { ...s.original, nombre: '' } };
    const nombre = 'x'.repeat(65536 - codificador.encode(serializarSolicitudRespaldo(plan, vacia)).length);
    const valida = { ...s, original: { ...s.original, nombre } };
    const texto = serializarSolicitudRespaldo(plan, valida);
    expect(() => serializarReciboRespaldo(plan, { ...valida, tipo: 'acuse-respaldo', objetoOriginalDurable: true, metadatosDurables: true })).toThrow();
    await expect(leer(cuerpo(texto))).rejects.toMatchObject({ codigo: 413 });
  });
  it('límites exactos y exceso de input/chunk/header/original/bloques/retención', async () => {
    const datos = cuerpo();
    await expect(leer(datos, { ...presupuesto, maxBytesEntrada: datos.length, maxBytesOriginal: 3,
      maxBytesChunk: 31, maxBloquesOriginal: 1, maxBytesRetenidos: bytesRetenidosFotos(3, presupuesto) })).resolves.toBeDefined();
    for (const cambio of [{ maxBytesEntrada: datos.length - 1 }, { maxBytesChunk: 30 },
      { maxBytesCabeceras: 0 }, { maxBytesOriginal: 0 }, { maxBloquesOriginal: 0 }, { maxBytesRetenidos: 0 },
      { maxBytesRetenidos: bytesRetenidosFotos(3, presupuesto) - 1 }]) {
      await expect(leer(datos, { ...presupuesto, ...cambio })).rejects.toMatchObject({ codigo: 413 });
    }
    expect(() => bytesRetenidosFotos(3, { ...presupuesto, maxBytesCabeceras: Number.MAX_SAFE_INTEGER })).toThrow();
  });
  it('Content-Length mentiroso no evita conteo ni EOF', async () => {
    const { solicitud } = request(cuerpo()); solicitud.headers.set('Content-Length', '0');
    const v = crearVigenciaFotos(solicitud.signal, 10000);
    try { expect((await leerMultipartFotos(plan, solicitud, presupuesto, v)).original.size).toBe(3); } finally { v.cerrar(); }
  });
  it('boundary quoted válido; parámetros extra, espacios, escapes o longitud no soportados', async () => {
    await expect(leer(cuerpo(), presupuesto, 31, 'multipart/form-data; boundary="frontera"')).resolves.toBeDefined();
    for (const tipo of ['application/json', 'multipart/form-data', 'multipart/form-data; boundary=a b',
      'multipart/form-data; boundary="a\\b"', 'multipart/form-data; boundary=x; boundary=x',
      'multipart/form-data; boundary=' + 'a'.repeat(71)]) {
      await expect(leer(cuerpo(), presupuesto, 31, tipo)).rejects.toMatchObject({ codigo: 415 });
    }
  });
  it('catálogo puro rechaza identidades duplicadas/vacías sin leer stream', async () => {
    for (const malo of ['', plan.dias[0].paradas[1].id]) {
      const copia = structuredClone(plan); Object.assign(copia.dias[0].paradas[0], { id: malo });
      expect(() => copiarPlanFotos(copia)).toThrow();
    }
  });
  it('deadline cancela y libera readlock sin esperar un cancel externo colgado', async () => {
    let cancelada = false;
    const stream = new ReadableStream<Uint8Array>({ cancel() { cancelada = true; return new Promise(() => {}); } });
    const solicitud = new Request('https://viaje.test/api/fotos/respaldo', { method: 'POST',
      headers: { 'Content-Type': 'multipart/form-data; boundary=frontera' }, body: stream, duplex: 'half' } as RequestInit);
    const v = crearVigenciaFotos(solicitud.signal, 10);
    try { await expect(leerMultipartFotos(plan, solicitud, presupuesto, v)).rejects.toMatchObject({ codigo: 503 }); }
    finally { v.cerrar(); }
    expect(cancelada).toBe(true); expect(stream.locked).toBe(false);
  });
});
