import { IDBFactory, IDBObjectStore } from 'fake-indexeddb';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { itinerario } from '../src/datos/itinerario';
import { abrirFotosLocal, capturarFotosLocal } from '../src/fotos-local';
import { abrirProgresoLocal, capturarProgresoLocal } from '../src/progreso-local';
import { abrirRespaldoFotosLocal, capturarRespaldoFotosLocal } from '../src/fotos-respaldo-local';
import { inspeccionarArchivoPortable, type CampoLegadoPortable } from '../src/portabilidad';
import { capturarHistoriaPortable, crearPortabilidadHistorica } from '../src/portabilidad-historico';
import { crearExportadorLocal } from '../src/portabilidad-local';
import { componerPortabilidad, crearPortabilidadInterfaz, nombreDescarga, resumenCopia, textoResultadoFotos,
  textoResumenCopia } from '../src/portabilidad-interfaz';

// Datos sintéticos sobre IndexedDB simulada: modela el contrato, no un navegador, su cuota ni un móvil.
const fotoId = '12345678-1234-4123-8123-123456789abc';
const borradaId = '22345678-1234-4123-8123-123456789abc';
const operacionId = '32345678-1234-4123-8123-123456789abc';
const historicaId = '42345678-1234-4123-8123-123456789abc';
// Límites de operador de la fixture (los de pruebas/portabilidad.e2e.ts), no el presupuesto de un viaje real.
const limites = { maxRegistros: 1000, maxBytesMetadatos: 1000000, maxBytesArchivo: 8000000, maxProfundidad: 64 };
const limitesHistoria = { maxImportaciones: 100, maxObservaciones: 1000, maxProcedencias: 1000, maxBytesHistoria: 80000000 };
const bases = [`itinerario-fotos:${encodeURIComponent(itinerario.id)}`, 'itinerario-progreso',
  `itinerario-respaldo-fotos:${encodeURIComponent(itinerario.id)}`, `itinerario-portabilidad:${encodeURIComponent(itinerario.id)}`].sort();
const bytesFoto = [0, 7, 255, 128, 1];
const bytesAntigua = [5, 6, 7, 8];
const legado: Record<CampoLegadoPortable, string | null> = { marcas: '', 'marcas-hora': '\0 é ', 'pendientes-hechos': null };
function metadatos(id: string, bytes: number, mime: string) {
  return { formato: 1 as const, fotoId: id, destino: { tipo: 'parada' as const, viajeId: itinerario.id,
    paradaId: itinerario.dias[0].paradas[0].id }, nombre: '\0 é ', mimeDeclarado: mime,
    ultimaModificacion: -0, incorporada: -0, bytesOriginal: bytes, miniatura: { tipo: 'pendiente' as const } };
}
const original = () => new Blob([new Uint8Array(bytesFoto)], { type: 'image/heic' });
const bytesDe = async (blob: Blob) => [...new Uint8Array(await blob.arrayBuffer())];
const cierres: (() => void)[] = [];
afterEach(() => { cierres.splice(0).forEach((c) => c()); });

describe('portabilidad en la interfaz: copia actual de este móvil', () => {
  it('prepara un archivo completo con foto, tombstone, progreso enviado, respaldo con recibo y legado, sin la historia archivada, que sigue intacta', async () => {
    const fabrica = new IDBFactory();
    // Historia previa: archivo válido de otro móvil, archivado a mano (archivar no restaura fotos).
    const origen = new IDBFactory();
    const fotosOrigen = await abrirFotosLocal(itinerario, { fabrica: origen }); cierres.push(() => fotosOrigen.cerrar());
    await fotosOrigen.guardarOriginal({ metadatos: metadatos(historicaId, bytesAntigua.length, 'image/jpeg'),
      original: new Blob([new Uint8Array(bytesAntigua)], { type: 'image/jpeg' }) });
    const antigua = await crearExportadorLocal({ plan: itinerario, limites, fabrica: origen,
      leerLegado: (c) => c === 'marcas' ? ' antiguo\0 ' : null }).exportarActual();
    const bytesHistoricos = await bytesDe(antigua.archivo.archivo);
    const historia = crearPortabilidadHistorica({ plan: itinerario, limites, limitesHistoria, fabrica });
    const archivado = await historia.archivar(antigua.archivo.archivo);
    expect(archivado).toMatchObject({ tipo: 'historia-confirmada', historia: 'confirmada', baseHistorica: 'creada', fotos: null });

    // PhotoDB de este móvil: una foto viva con su original y un tombstone.
    const fotos = await abrirFotosLocal(itinerario, { fabrica }); cierres.push(() => fotos.cerrar());
    await fotos.guardarOriginal({ metadatos: metadatos(fotoId, bytesFoto.length, 'image/heic'), original: original() });
    await fotos.guardarOriginal({ metadatos: metadatos(borradaId, 3, 'image/heic'), original: new Blob(['abc'], { type: 'image/heic' }) });
    await fotos.borrarLocal(borradaId);
    // Raíz de progreso v3 con una operación enviada y sin acuse.
    const progreso = await abrirProgresoLocal(itinerario, { fabrica, dispositivoId: 'movil-fixture' }); cierres.push(() => progreso.cerrar());
    await progreso.registrar({ id: 'op-enviada', dispositivoId: 'movil-fixture', tipo: 'parada',
      paradaId: itinerario.dias[0].paradas[0].id, marca: 'hecha', revision: 0 });
    await progreso.marcarEnviada('op-enviada');
    const raiz = await progreso.leer();
    // Respaldo preparado, enviado y con recibo válido: en la copia es historia local, nunca un acuse nuevo.
    const ledger = await abrirRespaldoFotosLocal(itinerario, fotos, { fabrica }); cierres.push(() => ledger.cerrar());
    const preparada = await ledger.preparar({ metadatos: metadatos(fotoId, bytesFoto.length, 'image/heic'), original: original() }, operacionId);
    await ledger.marcarEnviada({ fotoId, operacionId, original: preparada.original });
    const recibo = { version: 1 as const, tipo: 'acuse-respaldo' as const, viajeId: itinerario.id, fotoId, operacionId,
      original: preparada.original, objetoOriginalDurable: true as const, metadatosDurables: true as const };
    const respaldada = await ledger.confirmarRecibo(recibo);

    // Precondiciones con las bibliotecas reales, antes de afirmar nada del controlador.
    const releidas = await abrirFotosLocal(itinerario, { fabrica }); cierres.push(() => releidas.cerrar());
    expect(await releidas.listar()).toEqual([metadatos(fotoId, bytesFoto.length, 'image/heic')]);
    expect(await releidas.leerMetadatos(borradaId)).toEqual({ formato: 1, tipo: 'borrada', fotoId: borradaId });
    expect(await bytesDe((await releidas.leerOriginal(fotoId))!)).toEqual(bytesFoto);
    expect(await releidas.leerMetadatos(historicaId)).toBeNull();
    const fotosAntes = await capturarFotosLocal(itinerario, limites, { fabrica });
    expect(fotosAntes.tablas.metadatos.map((r) => r.clave)).toEqual([fotoId, borradaId]);
    expect(fotosAntes.tablas.originales.map((r) => r.clave)).toEqual([fotoId]);
    expect(fotosAntes.tablas.miniaturas).toEqual([]);
    expect(raiz).toMatchObject({ formato: 3, cola: [{ enviada: true, operacion: { id: 'op-enviada' } }] });
    expect((await capturarProgresoLocal(itinerario, limites, { fabrica })).tablas.viajes).toEqual([{ clave: itinerario.id, valor: raiz }]);
    expect(respaldada).toMatchObject({ fase: 'respaldada', enviada: true, recibo });
    expect((await capturarRespaldoFotosLocal(itinerario, limites, { fabrica })).tablas.respaldos).toEqual([{ clave: fotoId, valor: respaldada }]);
    const historiaAntes = await capturarHistoriaPortable(itinerario, limites, limitesHistoria, fabrica);
    expect(historiaAntes.registros.map((r) => r.trabajoId)).toEqual([archivado.trabajoId]);
    expect(historiaAntes.registros[0]).toMatchObject({ formato: 1, viajeId: itinerario.id, observaciones: [], procedencias: [] });
    expect(await bytesDe(historiaAntes.registros[0].archivo)).toEqual(bytesHistoricos);
    const consultada = (await historia.consultar(archivado.trabajoId!))!;
    expect(consultada.contenido.captura.legado.marcas).toBe(' antiguo\0 ');
    expect(consultada.contenido.captura.fotos.tablas.metadatos.map((r) => r.clave)).toEqual([historicaId]);
    expect((await fabrica.databases()).map((d) => d.name).sort()).toEqual(bases);

    const portabilidad = crearPortabilidadInterfaz({ plan: itinerario, limites, fabrica, leerLegado: (c) => legado[c] });
    const resultado = await portabilidad.prepararActual();
    expect(resultado.tipo).toBe('preparada');
    if (resultado.tipo !== 'preparada') throw new Error('Sin copia preparada');
    const { exportacion } = resultado;
    expect(exportacion.tipo).toBe('actual-sin-historia');
    expect(exportacion.excluidas).toEqual(['historia-archivada', 'caches', 'credenciales', 'transitorios']);
    const archivo = exportacion.archivo.archivo;
    const bytesArchivo = await bytesDe(archivo);
    expect(bytesArchivo).toHaveLength(archivo.size);
    expect(bytesArchivo.slice(0, 8)).toEqual([...new TextEncoder().encode('ITINPORT')]);
    expect(bytesArchivo).not.toEqual(bytesHistoricos);
    // Inspección completa: CRC del manifiesto y de cada segmento antes de entregar referencias.
    const leido = await inspeccionarArchivoPortable(itinerario, archivo, limites);
    const captura = leido.manifiesto.captura;
    expect(Object.keys(captura).sort()).toEqual(['fotos', 'legado', 'progreso', 'respaldos', 'viajeId']);
    expect(captura.viajeId).toBe(itinerario.id);
    expect(captura.fotos.tablas.metadatos).toEqual(fotosAntes.tablas.metadatos);
    expect(captura.fotos.tablas.metadatos.find((r) => r.clave === borradaId)!.valor).toEqual({ formato: 1, tipo: 'borrada', fotoId: borradaId });
    expect(leido.manifiesto.segmentos).toEqual([expect.objectContaining({ tabla: 'originales', clave: fotoId, bytes: bytesFoto.length, mime: 'image/heic' })]);
    expect(await bytesDe(leido.leerSegmento(0))).toEqual(bytesFoto);
    expect(captura.progreso.tablas.viajes).toEqual([{ clave: itinerario.id, valor: raiz }]);
    expect(captura.respaldos.tablas.respaldos).toEqual([{ clave: fotoId, valor: respaldada }]);
    expect(captura.legado).toEqual(legado);
    // La historia archivada no viaja en esta copia y sigue intacta en su base.
    expect([...captura.fotos.tablas.metadatos, ...leido.manifiesto.segmentos].map((r) => r.clave)).not.toContain(historicaId);
    const historiaDespues = await capturarHistoriaPortable(itinerario, limites, limitesHistoria, fabrica);
    expect(historiaDespues.registros.map((r) => r.trabajoId)).toEqual([archivado.trabajoId]);
    expect(historiaDespues.registros[0]).toMatchObject({ observaciones: [], procedencias: [] });
    expect(await bytesDe(historiaDespues.registros[0].archivo)).toEqual(bytesHistoricos);
    // Preparar solo lee: ni bases nuevas ni cambios en fotos, progreso o respaldos.
    expect((await fabrica.databases()).map((d) => d.name).sort()).toEqual(bases);
    const fotosDespues = await capturarFotosLocal(itinerario, limites, { fabrica });
    expect(fotosDespues.tablas.metadatos).toEqual(fotosAntes.tablas.metadatos);
    expect(await bytesDe(fotosDespues.tablas.originales[0].valor as Blob)).toEqual(bytesFoto);
    expect(await progreso.leer()).toEqual(raiz);
    expect(await ledger.leer(fotoId)).toEqual(respaldada);
  });
});

// ---------- Composición, una acción a la vez, importación e historia (bibliotecas reales sobre IndexedDB simulada) ----------

const BASE_FOTOS = `itinerario-fotos:${encodeURIComponent(itinerario.id)}`;
const BASE_HISTORIA = `itinerario-portabilidad:${encodeURIComponent(itinerario.id)}`;
const nombresBase = async (fabrica: IDBFactory) => (await fabrica.databases()).map((d) => d.name).sort();
/** Móvil sembrado con las bibliotecas reales: foto viva (y tombstone), raíz v3 con un cambio enviado y respaldo con recibo. */
async function movilSembrado(fabrica: IDBFactory, conBorrada = true) {
  const fotos = await abrirFotosLocal(itinerario, { fabrica }); cierres.push(() => fotos.cerrar());
  await fotos.guardarOriginal({ metadatos: metadatos(fotoId, bytesFoto.length, 'image/heic'), original: original() });
  if (conBorrada) {
    await fotos.guardarOriginal({ metadatos: metadatos(borradaId, 3, 'image/heic'), original: new Blob(['abc'], { type: 'image/heic' }) });
    await fotos.borrarLocal(borradaId);
  }
  const progreso = await abrirProgresoLocal(itinerario, { fabrica, dispositivoId: 'movil-a' }); cierres.push(() => progreso.cerrar());
  await progreso.registrar({ id: 'op-a', dispositivoId: 'movil-a', tipo: 'parada',
    paradaId: itinerario.dias[0].paradas[0].id, marca: 'hecha', revision: 0 });
  await progreso.marcarEnviada('op-a');
  const ledger = await abrirRespaldoFotosLocal(itinerario, fotos, { fabrica }); cierres.push(() => ledger.cerrar());
  const e = await ledger.preparar({ metadatos: metadatos(fotoId, bytesFoto.length, 'image/heic'), original: original() }, operacionId);
  await ledger.marcarEnviada({ fotoId, operacionId, original: e.original });
  await ledger.confirmarRecibo({ version: 1, tipo: 'acuse-respaldo', viajeId: itinerario.id, fotoId, operacionId,
    original: e.original, objetoOriginalDurable: true, metadatosDurables: true });
  return { raiz: await progreso.leer() };
}
/** La copia actual de ese móvil, preparada con el propio controlador (ya probado arriba). */
async function copiaDe(fabrica: IDBFactory) {
  const r = await crearPortabilidadInterfaz({ plan: itinerario, limites, fabrica, leerLegado: (c) => legado[c] }).prepararActual();
  if (r.tipo !== 'preparada') throw new Error('La copia de la fixture no se preparó');
  return r.exportacion.archivo;
}

describe('portabilidad en la interfaz: composición, acciones manuales e importación', () => {
  it('composición null no crea nada; la explícita y el controlador no hacen IO al crearse; presupuestos o catálogo inválidos se rechazan sin IO', async () => {
    const fabrica = new IDBFactory(); const abrir = vi.spyOn(fabrica, 'open');
    const deps = { plan: itinerario, fabrica, leerLegado: vi.fn(() => null), puerto: vi.fn(() => null), incorporar: vi.fn(),
      progresoOcupado: vi.fn(() => false), nombreDe: vi.fn(() => 'parada'), anunciar: vi.fn(),
      crearUrl: vi.fn(() => 'blob:fixture'), revocarUrl: vi.fn() };
    expect(componerPortabilidad(null, deps)).toBeNull();
    expect(componerPortabilidad({ limites, limitesHistoria }, deps)).not.toBeNull();
    // Inválida: la sección existe y dirá que no está disponible; tampoco abre ni lee nada.
    expect(componerPortabilidad({ limites: { ...limites, maxProfundidad: 0 }, limitesHistoria }, deps)).not.toBeNull();
    expect(() => crearPortabilidadInterfaz({ plan: itinerario, limites, fabrica, leerLegado: () => null,
      limitesHistoria: { ...limitesHistoria, maxImportaciones: -1 } })).toThrow();
    expect(() => crearPortabilidadInterfaz({ plan: { ...itinerario, id: '' }, limites, limitesHistoria, fabrica,
      leerLegado: () => null })).toThrow('Identidad');
    const ui = crearPortabilidadInterfaz({ plan: itinerario, limites, limitesHistoria, fabrica, leerLegado: deps.leerLegado,
      puerto: deps.puerto, incorporar: deps.incorporar, progresoOcupado: deps.progresoOcupado });
    expect([ui.accion, ui.conHistoria, ui.maxBytesArchivo]).toEqual([null, true, limites.maxBytesArchivo]);
    expect(abrir).not.toHaveBeenCalled();
    for (const f of [deps.leerLegado, deps.puerto, deps.incorporar, deps.progresoOcupado, deps.nombreDe, deps.anunciar,
      deps.crearUrl, deps.revocarUrl]) expect(f).not.toHaveBeenCalled();
    expect(await fabrica.databases()).toEqual([]);
  });

  it('una acción a la vez entre preparar, importar y consultar; seguidas sí; con el progreso ocupado no empieza ninguna ni abre nada', async () => {
    const fabrica = new IDBFactory(); await movilSembrado(fabrica);
    let ocupado = false;
    const ui = crearPortabilidadInterfaz({ plan: itinerario, limites, limitesHistoria, fabrica, leerLegado: (c) => legado[c],
      progresoOcupado: () => ocupado });
    const primera = ui.prepararActual();
    expect(ui.accion).toBe('preparar');
    expect(await ui.prepararActual()).toEqual({ tipo: 'no-preparada', motivo: 'ocupada' });
    expect(await ui.importar(new Blob(['x']))).toEqual({ tipo: 'no-iniciada', motivo: 'ocupada' });
    expect(await ui.listar()).toEqual({ tipo: 'no-iniciada', motivo: 'ocupada' });
    const a = await primera;
    expect(ui.accion).toBeNull();
    const b = await ui.prepararActual();
    if (a.tipo !== 'preparada' || b.tipo !== 'preparada') throw new Error('Sin copias seguidas');
    // Dos copias seguidas del mismo estado: completas e idénticas byte a byte (sin un solo uso por instancia).
    expect(await bytesDe(b.exportacion.archivo.archivo)).toEqual(await bytesDe(a.exportacion.archivo.archivo));
    ocupado = true;
    const abrir = vi.spyOn(fabrica, 'open');
    try {
      expect(await ui.prepararActual()).toEqual({ tipo: 'no-preparada', motivo: 'progreso-ocupado' });
      expect(await ui.importar(a.exportacion.archivo.archivo)).toEqual({ tipo: 'no-iniciada', motivo: 'progreso-ocupado' });
      expect(await ui.reintentar(fotoId)).toEqual({ tipo: 'no-iniciada', motivo: 'progreso-ocupado' });
      expect(await ui.listar()).toEqual({ tipo: 'no-iniciada', motivo: 'progreso-ocupado' });
      expect(abrir).not.toHaveBeenCalled();
    } finally { abrir.mockRestore(); }
  });

  it('importa en otro móvil: archiva antes de añadir fotos, indexa solo las nuevas por el MISMO almacén y deja progreso, ledger y legado en cuarentena consultable', async () => {
    const a = new IDBFactory(); const { raiz } = await movilSembrado(a);
    const archivo = await copiaDe(a);
    const bytesArchivo = await bytesDe(archivo.archivo);
    expect(resumenCopia(archivo.manifiesto)).toEqual({ fotos: 1, borradas: 1, marcas: 1, casillas: 0, cambios: 1, enviados: 1,
      rechazados: 0, respaldos: 1, conRecibo: 1, legado: 2 });
    expect(textoResumenCopia(resumenCopia(archivo.manifiesto))).toBe('1 foto · 1 borrada · 1 marca · 1 cambio en cola (1 enviado) · '
      + '1 registro de respaldo (1 con recibo) · marcas de la versión anterior');

    const b = new IDBFactory();
    const fotosB = await abrirFotosLocal(itinerario, { fabrica: b }); cierres.push(() => fotosB.cerrar());
    const incorporar = vi.fn();
    const ui = crearPortabilidadInterfaz({ plan: itinerario, limites, limitesHistoria, fabrica: b, leerLegado: () => null,
      puerto: () => fotosB, incorporar });
    // El tipo que declare el móvil no cuenta: la biblioteca valida el contenido entero.
    const r = await ui.importar(new Blob([new Uint8Array(bytesArchivo)], { type: 'application/x-desconocido' }));
    // La base se crea al archivar; el resultado devuelto es el de anotar la restauración sobre la base ya archivada.
    expect(r).toMatchObject({ tipo: 'hecha', nuevas: 1, indice: 'al-dia', resultado: { tipo: 'historia-confirmada',
      historia: 'confirmada', baseHistorica: 'existente', fotos: { tipo: 'observadas', fotos: [
        { fotoId, tipo: 'nueva', derivacion: 'igual' }, { fotoId: borradaId, tipo: 'tombstone', derivacion: 'igual' }] } } });
    expect(textoResultadoFotos(r, false, limites.maxBytesArchivo))
      .toBe('Copia archivada en este móvil. Fotos: 1 añadida · 1 borrada, no se recupera.');
    expect(incorporar).toHaveBeenCalledTimes(1);
    expect(incorporar).toHaveBeenCalledWith(metadatos(fotoId, bytesFoto.length, 'image/heic'));
    expect(await bytesDe((await fotosB.leerOriginal(fotoId))!)).toEqual(bytesFoto);
    expect(await fotosB.leerMetadatos(borradaId)).toEqual({ formato: 1, tipo: 'borrada', fotoId: borradaId });
    // Ni progreso ni ledger en B: lo importado de esas bases solo vive en la historia.
    expect(await nombresBase(b)).toEqual([BASE_FOTOS, BASE_HISTORIA].sort());
    if (r.tipo !== 'hecha') throw new Error('Sin importación');
    const id = r.resultado.trabajoId!;

    const consulta = await ui.consultar(id);
    if (consulta.tipo !== 'consultada') throw new Error('Sin consulta');
    expect(consulta.copia.contenido.captura.progreso.tablas.viajes).toEqual([{ clave: itinerario.id, valor: raiz }]);
    expect(consulta.copia.contenido.captura.respaldos.tablas.respaldos[0].valor)
      .toMatchObject({ fase: 'respaldada', enviada: true, recibo: { tipo: 'acuse-respaldo', fotoId, operacionId } });
    expect(consulta.copia.contenido.captura.legado).toEqual(legado);
    expect(consulta.copia.observaciones).toEqual([r.resultado.fotos]);
    const completo = await ui.exportarOriginal(id);
    if (completo.tipo !== 'preparado') throw new Error('Sin archivo');
    expect(completo.archivo.type).toBe('application/octet-stream');
    expect(await bytesDe(completo.archivo)).toEqual(bytesArchivo);
    expect(await ui.consultar('52345678-1234-4123-8123-123456789abc')).toEqual({ tipo: 'ausente' });

    // Importar otra vez el mismo archivo es otra copia archivada (vuelve a ocupar espacio); sus fotos ya estaban.
    const otra = await ui.importar(new Blob([new Uint8Array(bytesArchivo)]));
    expect(otra).toMatchObject({ tipo: 'hecha', nuevas: 0, indice: 'al-dia', resultado: { tipo: 'historia-confirmada',
      baseHistorica: 'existente', fotos: { tipo: 'observadas', fotos: [{ fotoId, tipo: 'existente' }, { fotoId: borradaId, tipo: 'tombstone' }] } } });
    expect(incorporar).toHaveBeenCalledTimes(1);
    const lista = await ui.listar();
    if (lista.tipo !== 'lista') throw new Error('Sin lista');
    expect(new Set(lista.copias.map((c) => c.trabajoId)).size).toBe(2);
    for (const c of lista.copias) expect(await bytesDe(c.archivo)).toEqual(bytesArchivo);
    // El almacén prestado sigue abierto: la interfaz no lo cerró.
    expect(await fotosB.listar()).toEqual([metadatos(fotoId, bytesFoto.length, 'image/heic')]);
  });

  it('si el almacén de la interfaz cambia durante la importación no se indexa nada y lo dice; el prestado nunca se cierra', async () => {
    const a = new IDBFactory(); await movilSembrado(a, false);
    const archivo = await copiaDe(a);
    const b = new IDBFactory();
    const fotosB = await abrirFotosLocal(itinerario, { fabrica: b }); cierres.push(() => fotosB.cerrar());
    let actual: typeof fotosB | null = fotosB;
    const incorporar = vi.fn();
    const ui = crearPortabilidadInterfaz({ plan: itinerario, limites, limitesHistoria, fabrica: b, leerLegado: () => null,
      puerto: () => actual, incorporar });
    const pendiente = ui.importar(archivo.archivo);
    actual = null; // p. ej., la interfaz cerró sus fotos mientras se importaba
    const r = await pendiente;
    expect(r).toMatchObject({ tipo: 'hecha', nuevas: 1, indice: 'sin-confirmar',
      resultado: { historia: 'confirmada', fotos: { tipo: 'observadas' } } });
    expect(textoResultadoFotos(r, false, limites.maxBytesArchivo)).toBe('Copia archivada en este móvil. Fotos: 1 añadida. '
      + 'Puede que las fotos añadidas no se vean en sus fichas hasta volver a abrir la app.');
    expect(incorporar).not.toHaveBeenCalled();
    expect(await fotosB.listar()).toEqual([metadatos(fotoId, bytesFoto.length, 'image/heic')]);
  });

  it.each(['grande', 'sin-historia', 'crc', 'truncado', 'bom'] as const)('importación %s: nada se abre, escribe ni indexa', async (caso) => {
    const a = new IDBFactory(); await movilSembrado(a, false);
    const bytes = await bytesDe((await copiaDe(a)).archivo);
    const b = new IDBFactory(); const abrir = vi.spyOn(b, 'open'); const incorporar = vi.fn();
    const ui = crearPortabilidadInterfaz({ plan: itinerario,
      limites: caso === 'grande' ? { ...limites, maxBytesArchivo: bytes.length - 1 } : limites,
      ...(caso === 'sin-historia' ? {} : { limitesHistoria }), fabrica: b, leerLegado: () => null, puerto: () => null, incorporar });
    const contenido = caso === 'crc' ? [...bytes.slice(0, -1), bytes[bytes.length - 1] ^ 1]
      : caso === 'truncado' ? bytes.slice(0, -1) : caso === 'bom' ? [0xef, 0xbb, 0xbf, ...bytes] : bytes;
    const r = await ui.importar(new Blob([new Uint8Array(contenido)]));
    if (caso === 'grande') expect(r).toEqual({ tipo: 'no-iniciada', motivo: 'demasiado-grande' });
    else if (caso === 'sin-historia') expect(r).toEqual({ tipo: 'no-iniciada', motivo: 'sin-historia' });
    else expect(r).toMatchObject({ tipo: 'hecha', nuevas: 0, resultado: { tipo: 'rechazado-antes-escribir', historia: 'no-intentada' } });
    expect(abrir).not.toHaveBeenCalled(); expect(incorporar).not.toHaveBeenCalled();
    expect(await b.databases()).toEqual([]);
  });

  it('cuota MODELADA al añadir el original: la copia queda archivada, sus fotos no, y reintentar las añade sin otra copia', async () => {
    const a = new IDBFactory(); await movilSembrado(a, false);
    const archivo = await copiaDe(a);
    const b = new IDBFactory();
    const fotosB = await abrirFotosLocal(itinerario, { fabrica: b }); cierres.push(() => fotosB.cerrar());
    const incorporar = vi.fn();
    const ui = crearPortabilidadInterfaz({ plan: itinerario, limites, limitesHistoria, fabrica: b, leerLegado: () => null,
      puerto: () => fotosB, incorporar });
    // Modelo de «sin espacio» en la escritura del original (una vez); no certifica la cuota de un móvil real.
    const add = IDBObjectStore.prototype.add; let fallar = true;
    const espia = vi.spyOn(IDBObjectStore.prototype, 'add').mockImplementation(function (this: IDBObjectStore, ...args) {
      if (fallar && this.name === 'originales') { fallar = false; throw new DOMException('Cuota modelada', 'QuotaExceededError'); }
      return add.apply(this, args);
    });
    const r = await ui.importar(archivo.archivo).finally(() => espia.mockRestore());
    expect(r).toMatchObject({ tipo: 'hecha', nuevas: 0, indice: 'al-dia', resultado: { tipo: 'historia-confirmada', historia: 'confirmada',
      fotos: { tipo: 'tx-abortada', transaccion: 'abortada', fotos: [] } } });
    expect(textoResultadoFotos(r, false, limites.maxBytesArchivo)).toBe('Copia archivada en este móvil. '
      + 'Sus fotos no se añadieron (puede faltar espacio en este móvil). Puedes reintentarlo.');
    expect(incorporar).not.toHaveBeenCalled();
    expect(await fotosB.leerMetadatos(fotoId)).toBeNull();
    if (r.tipo !== 'hecha') throw new Error('Sin importación');
    const id = r.resultado.trabajoId!;
    const otra = await ui.reintentar(id);
    expect(otra).toMatchObject({ tipo: 'hecha', nuevas: 1, indice: 'al-dia',
      resultado: { tipo: 'historia-confirmada', trabajoId: id, fotos: { tipo: 'observadas' } } });
    expect(textoResultadoFotos(otra, true, limites.maxBytesArchivo)).toBe('Fotos: 1 añadida.');
    expect(incorporar).toHaveBeenCalledTimes(1);
    expect(await bytesDe((await fotosB.leerOriginal(fotoId))!)).toEqual(bytesFoto);
    expect(await ui.listar()).toMatchObject({ tipo: 'lista', copias: [{ trabajoId: id,
      observaciones: [{ tipo: 'tx-abortada' }, { tipo: 'observadas' }] }] });
  });

  it('nombre de descarga de una foto: sin controles ni rutas; los bytes no dependen de él', () => {
    expect(nombreDescarga('\0 é «calle».heic')).toBe('_ é «calle».heic');
    expect(nombreDescarga('a/b\\c.png')).toBe('a_b_c.png');
    expect(nombreDescarga('../..')).toBe('foto-original');
    expect(nombreDescarga('  ')).toBe('foto-original');
  });
});

describe('portabilidad en la interfaz: fallo de lectura de la historia justo después de archivar', () => {
  it('con la copia ya archivada (oncomplete) y la primera lectura posterior fallida, el resultado no niega lo guardado y reintentar añade sus fotos sin otra copia', async () => {
    const a = new IDBFactory(); const { raiz } = await movilSembrado(a);
    const archivo = await copiaDe(a);
    const bytesArchivo = await bytesDe(archivo.archivo);
    const b = new IDBFactory();
    const fotosB = await abrirFotosLocal(itinerario, { fabrica: b }); cierres.push(() => fotosB.cerrar());
    // Fallo MODELADO (no cuota ni móvil): se arma solo con el oncomplete de la transacción que añade el archivo a la
    // historia, y la PRIMERA apertura posterior de esa base falla una vez. La fábrica se espía antes de crear el
    // controlador, que fija su open al construirse.
    const estado = { armado: false, fallos: 0, completos: 0, archivos: 0 };
    const abrirOriginal = b.open.bind(b);
    const abrir = vi.spyOn(b, 'open').mockImplementation((nombre, version) => {
      if (estado.armado && nombre === BASE_HISTORIA) {
        estado.armado = false; estado.fallos++;
        throw new DOMException('Fallo modelado de apertura', 'AbortError');
      }
      return version === undefined ? abrirOriginal(nombre) : abrirOriginal(nombre, version);
    });
    const add = IDBObjectStore.prototype.add;
    const espia = vi.spyOn(IDBObjectStore.prototype, 'add').mockImplementation(function (this: IDBObjectStore, ...args) {
      if (this.name === 'importaciones' && this.transaction.db.name === BASE_HISTORIA) {
        estado.archivos++;
        this.transaction.addEventListener('complete', () => { estado.completos++; estado.armado = true; });
      }
      return add.apply(this, args);
    });
    try {
      const incorporar = vi.fn();
      const ui = crearPortabilidadInterfaz({ plan: itinerario, limites, limitesHistoria, fabrica: b, leerLegado: () => null,
        puerto: () => fotosB, incorporar });
      const r = await ui.importar(new Blob([new Uint8Array(bytesArchivo)]));

      // Testigo causal ANTES del mensaje: un archivo añadido, su oncomplete y un único fallo después.
      expect(estado).toEqual({ armado: false, fallos: 1, completos: 1, archivos: 1 });
      // Lectura fresca ya sin fallo: la copia está archivada entera, con sus CRC, y sin ninguna restauración intentada.
      const historia = await capturarHistoriaPortable(itinerario, limites, limitesHistoria, b);
      expect(historia.registros).toHaveLength(1);
      const [registro] = historia.registros;
      expect(registro).toMatchObject({ formato: 1, viajeId: itinerario.id, observaciones: [], procedencias: [] });
      expect(await bytesDe(registro.archivo)).toEqual(bytesArchivo);
      const leido = await inspeccionarArchivoPortable(itinerario, registro.archivo, limites);
      expect(leido.manifiesto.captura.fotos.tablas.metadatos.map((x) => x.clave)).toEqual([fotoId, borradaId]);
      expect(await bytesDe(leido.leerSegmento(0))).toEqual(bytesFoto);
      expect(leido.manifiesto.captura.progreso.tablas.viajes).toEqual([{ clave: itinerario.id, valor: raiz }]);
      expect(leido.manifiesto.captura.respaldos.tablas.respaldos[0].valor)
        .toMatchObject({ fase: 'respaldada', enviada: true, recibo: { tipo: 'acuse-respaldo', fotoId, operacionId } });
      expect(leido.manifiesto.captura.legado).toEqual(legado);
      expect(r.tipo === 'hecha' ? r.resultado.trabajoId : null).toBe(registro.trabajoId);
      // B sin cambios: ni fotos, ni índice, ni progreso, ledger o legado importados.
      expect(await fotosB.listar()).toEqual([]);
      expect(await fotosB.leerMetadatos(fotoId)).toBeNull();
      expect(await fotosB.leerMetadatos(borradaId)).toBeNull();
      expect(incorporar).not.toHaveBeenCalled();
      expect(await nombresBase(b)).toEqual([BASE_FOTOS, BASE_HISTORIA].sort());

      // RED esperado: la copia está archivada y el mensaje visible hoy dice «No se ha guardado nada…».
      expect(textoResultadoFotos(r, false, limites.maxBytesArchivo)).toBe('Copia archivada en este móvil. Sus fotos aún no se han añadido.');
      expect(r).toMatchObject({ tipo: 'hecha', nuevas: 0, resultado: { historia: 'confirmada', trabajoId: registro.trabajoId, fotos: null } });
      // Con el resultado veraz, un reintento manual añade sus fotos sobre la MISMA copia.
      const otra = await ui.reintentar(registro.trabajoId);
      expect(otra).toMatchObject({ tipo: 'hecha', nuevas: 1, indice: 'al-dia',
        resultado: { historia: 'confirmada', trabajoId: registro.trabajoId, fotos: { tipo: 'observadas' } } });
      expect(incorporar).toHaveBeenCalledTimes(1);
      expect(await bytesDe((await fotosB.leerOriginal(fotoId))!)).toEqual(bytesFoto);
      expect(await fotosB.leerMetadatos(borradaId)).toEqual({ formato: 1, tipo: 'borrada', fotoId: borradaId });
      const despues = await capturarHistoriaPortable(itinerario, limites, limitesHistoria, b);
      expect(despues.registros.map((x) => x.trabajoId)).toEqual([registro.trabajoId]);
      expect(despues.registros[0].observaciones).toHaveLength(1);
      expect(estado.archivos).toBe(1);
    } finally {
      espia.mockRestore(); abrir.mockRestore();
    }
  });
});
