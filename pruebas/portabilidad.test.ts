import { describe, expect, it, vi } from 'vitest';
import { crearProgreso } from '../src/progreso';
import { itinerario } from '../src/datos/itinerario';
import { codificarJsonFiel, exportarArchivoPortable, inspeccionarArchivoPortable, crearConjuntoRecuperacion,
  type CapturaPortable, type LimitesPortables } from '../src/portabilidad';
const limites: LimitesPortables = { maxRegistros: 100, maxBytesMetadatos: 100000,
  maxBytesArchivo: 4000000, maxProfundidad: 64 };
const vacia = () => ({ presente: false, tablas: {} });
// Fixture de formato independiente: vuelve a calcular CRC para alcanzar guards estructurales,
// no evade integridad productiva ni cambia las implementaciones.
function empaquetar(manifiesto: unknown, binarios: readonly Blob[] = []): Blob {
  const bytes = new TextEncoder().encode(codificarJsonFiel(manifiesto, limites));
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte; for (let i = 0; i < 8; i++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
  }
  const cabecera = new Uint8Array(24); cabecera.set(new TextEncoder().encode('ITINPORT'));
  const dv = new DataView(cabecera.buffer); dv.setUint32(8, 1); dv.setBigUint64(12, BigInt(bytes.length));
  dv.setUint32(20, (crc ^ 0xffffffff) >>> 0); return new Blob([cabecera, bytes, ...binarios]);
}
const casosCatalogoInvalido = ['viaje-vacio', 'viaje-blanco', 'parada-vacia', 'parada-duplicada',
  'subparada-duplicada', 'subparadas-repetidas', 'pendiente-vacio', 'pendiente-duplicado', 'pendiente-cruzado'] as const;
function planConCatalogoInvalido(caso: typeof casosCatalogoInvalido[number]) {
  const plan = structuredClone(itinerario); const paradas = plan.dias.flatMap((d) => d.paradas);
  if (caso === 'viaje-vacio') Object.assign(plan, { id: '' });
  if (caso === 'viaje-blanco') Object.assign(plan, { id: ' \t\n ' });
  if (caso === 'parada-vacia') Object.assign(paradas[0], { id: '' });
  if (caso === 'parada-duplicada') Object.assign(paradas[1], { id: paradas[0].id });
  if (caso === 'subparada-duplicada') paradas[0].subparadas = [{ id: paradas[1].id, nombre: 'Colisión entre destinos' }];
  if (caso === 'subparadas-repetidas') {
    paradas[0].subparadas = [{ id: 'sub-fixture', nombre: 'Uno' }];
    paradas[1].subparadas = [{ id: 'sub-fixture', nombre: 'Dos' }];
  }
  if (caso === 'pendiente-vacio') plan.pendientes = [{ id: '', texto: 'Sin identidad' }];
  if (caso === 'pendiente-duplicado') plan.pendientes = [{ id: 'pendiente-fixture', texto: 'Uno' }, { id: 'pendiente-fixture', texto: 'Dos' }];
  if (caso === 'pendiente-cruzado') plan.pendientes = [{ id: paradas[0].id, texto: 'Colisión con parada' }];
  return plan;
}
const captura = (): CapturaPortable => ({ viajeId: itinerario.id, fotos: vacia(), progreso: vacia(),
  respaldos: vacia(), legado: { marcas: '', 'marcas-hora': null, 'pendientes-hechos': '\0 e\u0301 ' } });
describe('M1: catálogo válido también cuando no hay registros durables', () => {
  it.each(casosCatalogoInvalido)('exportador e inspector rechazan %s antes de leer bytes', async (caso) => {
    const plan = planConCatalogoInvalido(caso);
    expect(() => crearProgreso(plan)).toThrow('Identidad'); // Guard existente: baseline del dominio.
    const c = { ...captura(), viajeId: plan.id };
    // Archivo aparentemente coherente, viajeId coincide; no depender de registros para validar.
    const archivo = empaquetar({ formato: 1, alcance: 'historia-durable-por-base', captura: c, segmentos: [] });
    const leerBytes = vi.spyOn(Blob.prototype, 'arrayBuffer');
    try {
      await expect(exportarArchivoPortable(plan, c, limites)).rejects.toThrow('Identidad');
      await expect(inspeccionarArchivoPortable(plan, archivo, limites)).rejects.toThrow('Identidad');
      expect(leerBytes).not.toHaveBeenCalled();
    } finally { leerBytes.mockRestore(); }
  });
  it('guard no normaliza identidades válidas con espacios, NUL y NFD', async () => {
    const plan = structuredClone(itinerario); Object.assign(plan, { id: ' viaje \0 e\u0301 ' });
    const c = { ...captura(), viajeId: plan.id };
    const r = await exportarArchivoPortable(plan, c, limites);
    const leido = await inspeccionarArchivoPortable(plan, r.archivo, limites);
    expect(leido.manifiesto.captura.viajeId).toBe(' viaje \0 e\u0301 ');
    expect(plan.id).toBe(' viaje \0 e\u0301 ');
  });
  it('catálogo válido admite bases ausentes; inspección usa catálogo capturado antes del primer await', async () => {
    const r = await exportarArchivoPortable(itinerario, captura(), limites);
    const plan = structuredClone(itinerario);
    const pendiente = inspeccionarArchivoPortable(plan, r.archivo, limites);
    Object.assign(plan, { id: '' });
    const leido = await pendiente;
    expect(leido.manifiesto.captura.viajeId).toBe(itinerario.id);
    expect(leido.manifiesto.captura.progreso.presente).toBe(false);
    const duplicado = planConCatalogoInvalido('parada-duplicada');
    await expect(inspeccionarArchivoPortable(duplicado, r.archivo, limites)).rejects.toThrow('Identidad');
  });
});
describe('archivo portable completo, no autenticación ni importador', () => {
  it('constructor de conjunto no omite campos desconocidos en referencias históricas', async () => {
    const archivo = (await exportarArchivoPortable(itinerario, captura(), limites)).archivo;
    const presupuesto = { maxArchivos: 10, maxBytesConjunto: 40000000, maxBytesInventario: 100000,
      maxRegistrosConjunto: 1000, maxObservaciones: 1000, maxProcedencias: 1000 };
    const fuente = { trabajoId: 'origen', archivo, observaciones: [], procedencias: [], extra: new Map() };
    await expect(crearConjuntoRecuperacion(itinerario, archivo, [fuente], limites, presupuesto)).rejects.toThrow();
  });
  it('produce un Blob versionado verificable, distingue vacío/ausencia y conserva texto exacto', async () => {
    const r = await exportarArchivoPortable(itinerario, captura(), limites);
    expect(r.archivo).toBeInstanceOf(Blob); expect(r.archivo.size).toBeGreaterThan(20);
    const leido = await inspeccionarArchivoPortable(itinerario, r.archivo, limites);
    expect(leido.manifiesto.captura).toEqual(captura());
  });
  it('JSON fiel conserva -0 y propios sin ejecutar getters', () => {
    const texto = codificarJsonFiel({ cero: -0, nombre: '\0 e\u0301 ' }, limites);
    const r = JSON.parse(texto); expect(Object.is(r.cero, -0)).toBe(true);
    expect(r.nombre).toBe('\0 e\u0301 ');
  });
  it.each([undefined, NaN, Infinity, -Infinity, new Map(), new Date(), new Blob(), 1n])('rechaza opaco/no JSON sin omitirlo: %s', (valor) => {
    expect(() => codificarJsonFiel({ legado: valor }, limites)).toThrow();
  });
  it('rechaza getters, símbolos, propios ocultos, arrays dispersos y propiedades extra', () => {
    const getter = vi.fn(() => 1);
    const oculto = Object.defineProperty({}, 'oculto', { value: 1 });
    const accessor = Object.defineProperty({}, 'valor', { get: getter, enumerable: true });
    for (const valor of [oculto, accessor, { [Symbol('s')]: 1 }, new Array(2), Object.assign([1], { extra: 2 })]) {
      expect(() => codificarJsonFiel(valor, limites)).toThrow();
    }
    expect(getter).not.toHaveBeenCalled();
  });
  it('rechaza ciclos y referencia compartida, no confunde identidad con igualdad', () => {
    const rama = { numero: 1 }; const ciclo: Record<string, unknown> = {}; ciclo.yo = ciclo;
    expect(() => codificarJsonFiel(ciclo, limites)).toThrow();
    expect(() => codificarJsonFiel({ a: rama, b: rama }, limites)).toThrow();
    expect(codificarJsonFiel({ a: { numero: 1 }, b: { numero: 1 } }, limites)).toBe('{"a":{"numero":1},"b":{"numero":1}}');
  });
  it('fronteras profundidad y UTF8 reales; -0 no es normalizado', () => {
    expect(codificarJsonFiel('é', { ...limites, maxBytesMetadatos: 4 })).toBe('"é"');
    expect(() => codificarJsonFiel('é', { ...limites, maxBytesMetadatos: 3 })).toThrow('maxBytes');
    expect(() => codificarJsonFiel({ a: { b: 1 } }, { ...limites, maxProfundidad: 1 })).toThrow('maxProfundidad');
    expect(codificarJsonFiel([-0, 0], limites)).toBe('[-0,0]');
  });
  it.each([-1, NaN, Infinity, 0.5, Number.MAX_SAFE_INTEGER + 1])('rechaza límites inseguros %s', async (valor) => {
    await expect(exportarArchivoPortable(itinerario, captura(), { ...limites, maxRegistros: valor })).rejects.toThrow();
  });
  it('constructor JSON no evalúa toJSON y rechaza propias del array', () => {
    const toJSON = vi.fn(() => 'normalizado');
    expect(() => codificarJsonFiel({ toJSON }, limites)).toThrow(); expect(toJSON).not.toHaveBeenCalled();
  });
  it('rechaza unknown no representable en raíz entera: nunca devuelve archivo parcial', async () => {
    const estado = crearProgreso(itinerario);
    const raiz = { formato: 3, revisionServidor: 0, confirmado: estado, estado: structuredClone(estado), cola: [],
      legado: { originales: { extra: new Map([['incertidumbre', NaN]]) }, recuperacion: [] } };
    const c = captura();
    await expect(exportarArchivoPortable(itinerario, { ...c, progreso: { presente: true,
      tablas: { viajes: [{ clave: itinerario.id, valor: raiz }] } } }, limites)).rejects.toThrow();
    expect(raiz.legado.originales.extra).toBeInstanceOf(Map);
  });
  it.each([0, 1, (1 << 20) - 1, 1 << 20, (1 << 20) + 5])('binario completo %s bytes, CRC y último byte; sin arrayBuffer global', async (longitud) => {
    const bytes = new Uint8Array(longitud); bytes.fill(23); if (longitud) { bytes[0] = 0; bytes[longitud - 1] = 255; }
    const fotoId = '12345678-1234-4123-8123-123456789abc';
    const m = { formato: 1, fotoId, destino: { tipo: 'parada', viajeId: itinerario.id, paradaId: itinerario.dias[0].paradas[0].id },
      nombre: '\0 e\u0301 ', mimeDeclarado: 'image/heic', incorporada: -0, ultimaModificacion: -0,
      bytesOriginal: longitud, miniatura: { tipo: 'pendiente' } };
    const original = new Blob([bytes], { type: 'image/heic' }); const c = captura();
    const snapshot = { ...c, fotos: { presente: true, tablas: { metadatos: [{ clave: fotoId, valor: m }],
      originales: [{ clave: fotoId, valor: original }], miniaturas: [] } } };
    const spy = vi.spyOn(Blob.prototype, 'arrayBuffer');
    const pendiente = exportarArchivoPortable(itinerario, snapshot, limites);
    m.nombre = 'mutado después de await';
    let r: Awaited<ReturnType<typeof exportarArchivoPortable>>;
    try {
      r = await pendiente;
      const verificado = await inspeccionarArchivoPortable(itinerario, r.archivo, limites);
      expect((verificado.manifiesto.captura.fotos.tablas.metadatos[0].valor as typeof m).nombre).toBe('\0 e\u0301 ');
      expect(spy.mock.instances.every((b) => (b as Blob).size <= (1 << 20))).toBe(true);
      expect(verificado.leerSegmento(0).size).toBe(longitud);
      expect(new Uint8Array(await verificado.leerSegmento(0).arrayBuffer())).toEqual(bytes);
      expect(() => verificado.leerSegmento(-1)).toThrow();
    } finally { spy.mockRestore(); }
    await expect(inspeccionarArchivoPortable(itinerario, r!.archivo.slice(0, -1), limites)).rejects.toThrow();
    await expect(inspeccionarArchivoPortable(itinerario, new Blob([r!.archivo, new Uint8Array([0])]), limites)).rejects.toThrow();
    if (longitud) {
      const alterado = new Blob([r!.archivo.slice(0, -1), new Uint8Array([254])]);
      await expect(inspeccionarArchivoPortable(itinerario, alterado, limites)).rejects.toThrow('CRC');
    }
  });
  it.each(['IMAGE/HEIC', 'image/HEIC', 'image/heic\0', 'image/héic'])('descriptor MIME crudo %s rechaza aunque slice lo transforme', async (mime) => {
    const fotoId = '12345678-1234-4123-8123-123456789abc';
    const original = new Blob(['123456789'], { type: 'image/heic' });
    const metadata = { formato: 1, fotoId, destino: { tipo: 'parada', viajeId: itinerario.id,
      paradaId: itinerario.dias[0].paradas[0].id }, nombre: '\0 e\u0301 ', mimeDeclarado: 'image/heic',
      incorporada: -0, ultimaModificacion: -0, bytesOriginal: 9, miniatura: { tipo: 'pendiente' } };
    const a = await exportarArchivoPortable(itinerario, { ...captura(), fotos: { presente: true, tablas: {
      metadatos: [{ clave: fotoId, valor: metadata }], originales: [{ clave: fotoId, valor: original }],
      miniaturas: [] } } }, limites);
    const control = await inspeccionarArchivoPortable(itinerario, a.archivo, limites);
    expect(control.leerSegmento(0).type).toBe('image/heic');
    expect(a.manifiesto.segmentos[0].crc32).toBe(0xcbf43926);
    const manifiesto = JSON.parse(codificarJsonFiel(a.manifiesto, limites));
    manifiesto.segmentos[0].mime = mime;
    // CRC del manifiesto recalculado y CRC binario conocido intacto: no es un fallo de integridad.
    const incompatible = empaquetar(manifiesto, [original]);
    await expect(inspeccionarArchivoPortable(itinerario, incompatible, limites)).rejects.toThrow('MIME');
    expect(manifiesto.segmentos[0].mime).toBe(mime);
    expect(metadata.mimeDeclarado).toBe('image/heic');
  });
  it('archivo determinista; metadata corrupta/magic/versión y límites rechazan', async () => {
    const a = await exportarArchivoPortable(itinerario, captura(), limites);
    const b = await exportarArchivoPortable(itinerario, captura(), limites);
    expect(await a.archivo.arrayBuffer()).toEqual(await b.archivo.arrayBuffer());
    for (const posicion of [0, 11, 20, 24]) {
      const corrupto = new Blob([a.archivo.slice(0, posicion), new Uint8Array([255]), a.archivo.slice(posicion + 1)]);
      await expect(inspeccionarArchivoPortable(itinerario, corrupto, limites)).rejects.toThrow();
    }
    await expect(exportarArchivoPortable(itinerario, captura(), { ...limites, maxBytesArchivo: 24 })).rejects.toThrow('maxBytesArchivo');
    await expect(exportarArchivoPortable(itinerario, captura(), { ...limites, maxBytesMetadatos: 10 })).rejects.toThrow('maxBytesMetadatos');
    await expect(inspeccionarArchivoPortable(itinerario, a.archivo, { ...limites, maxBytesArchivo: a.archivo.size - 1 })).rejects.toThrow();
  });
  it('conocido con getter, ocultos, símbolos, undefined y extras rechaza antes de validar', async () => {
    const getter = vi.fn(() => 3); const estado = crearProgreso(itinerario);
    for (const modo of ['getter', 'oculto', 'simbolo', 'undefined', 'extra']) {
      const raiz: Record<string | symbol, unknown> = { formato: 3, revisionServidor: 0, confirmado: estado, estado, cola: [] };
      if (modo === 'getter') Object.defineProperty(raiz, 'revisionServidor', { get: getter, enumerable: true });
      if (modo === 'oculto') Object.defineProperty(raiz, 'extra', { value: 1 });
      if (modo === 'simbolo') raiz[Symbol('extra')] = 1;
      if (modo === 'undefined') raiz.legado = undefined;
      if (modo === 'extra') raiz.extra = 1;
      const c = captura(); await expect(exportarArchivoPortable(itinerario, { ...c, progreso: { presente: true,
        tablas: { viajes: [{ clave: itinerario.id, valor: raiz }] } } }, limites)).rejects.toThrow();
    }
    expect(getter).not.toHaveBeenCalled();
  });
  it.each(['extra', 'version', 'alcance', 'offset', 'duplicado', 'huerfano', 'longitud', 'viaje', 'registro'])('manifiesto con CRC válido rechaza estructura %s', async (caso) => {
    const a = await exportarArchivoPortable(itinerario, captura(), limites);
    const m = JSON.parse(codificarJsonFiel(a.manifiesto, limites));
    if (caso === 'extra') m.extra = true;
    if (caso === 'version') m.formato = 2;
    if (caso === 'alcance') m.alcance = 'snapshot-global';
    if (caso === 'viaje') m.captura.viajeId = 'otro';
    const segmento = { tabla: 'originales', clave: '12345678-1234-4123-8123-123456789abc',
      offset: 0, bytes: 0, mime: 'image/heic', crc32: 0 };
    if (caso === 'offset') m.segmentos = [{ ...segmento, offset: 1 }];
    if (caso === 'duplicado') m.segmentos = [segmento, { ...segmento }];
    if (caso === 'huerfano') m.segmentos = [segmento];
    if (caso === 'longitud') m.segmentos = [{ ...segmento, bytes: Number.MAX_SAFE_INTEGER }];
    if (caso === 'registro') m.captura.progreso = { presente: true, tablas: { viajes: [{ clave: itinerario.id, valor: {} }] } };
    await expect(inspeccionarArchivoPortable(itinerario, empaquetar(m), limites)).rejects.toThrow();
  });
  it('CRC32 IEEE conocido para original 123456789; referencias de vista aisladas del manifiesto público', async () => {
    const fotoId = '12345678-1234-4123-8123-123456789abc'; const c = captura();
    const m = { formato: 1, fotoId, destino: { tipo: 'parada', viajeId: itinerario.id, paradaId: itinerario.dias[0].paradas[0].id },
      nombre: '\0', mimeDeclarado: 'image/heic', incorporada: -0, ultimaModificacion: -0, bytesOriginal: 9, miniatura: { tipo: 'pendiente' } };
    const a = await exportarArchivoPortable(itinerario, { ...c, fotos: { presente: true, tablas: {
      metadatos: [{ clave: fotoId, valor: m }], originales: [{ clave: fotoId, valor: new Blob(['123456789'], { type: 'image/heic' }) }], miniaturas: [] } } }, limites);
    expect(a.manifiesto.segmentos[0].crc32).toBe(0xcbf43926);
    Object.assign(a.manifiesto.segmentos[0], { offset: 99999, bytes: 0 });
    expect(await a.leerSegmento(0).text()).toBe('123456789');
    await expect(inspeccionarArchivoPortable(itinerario, a.archivo, { ...limites, maxRegistros: 1 })).rejects.toThrow('maxRegistros');
  });
  it('rechaza getters dentro de arrays antes del guard de dominio', async () => {
    const getter = vi.fn(() => ({ clave: 'oculta', valor: null }));
    const lista = [null]; Object.defineProperty(lista, '0', { get: getter, enumerable: true });
    const c = captura();
    await expect(exportarArchivoPortable(itinerario, { ...c, progreso: { presente: true,
      tablas: { viajes: lista as unknown as import('../src/portabilidad').RegistroPortable[] } } }, limites)).rejects.toThrow();
    expect(getter).not.toHaveBeenCalled();
  });
});
