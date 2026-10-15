import { describe, expect, it, vi } from 'vitest';
import { crearPerfilOperativoPiloto } from '../scripts/perfil-operativo-piloto';
import { admitirMarcoObjetoFotos } from '../servidor/almacen-fotos';
import { admitirOriginalFotos, bytesRetenidosFotos } from '../servidor/multipart-fotos';
import { prepararListadoFotos } from '../servidor/api-listado-fotos';
import { crearComposicionFotos } from '../servidor/composicion-fotos';
import { itinerario } from '../src/datos/itinerario';
import { crearPerfilPiloto } from '../src/perfil-piloto';
import { prepararPiloto } from '../src/preparar-piloto';
import { crearPortabilidadInterfaz } from '../src/portabilidad-interfaz';

const prohibido = () => { throw new Error('IO prohibido en preflight'); };
describe('perfil operativo inicial del piloto', () => {
  it('fija todos los valores operativos sin heredarlos de fixtures ni del entorno', () => {
    expect(crearPerfilOperativoPiloto()).toEqual({
      origen: 'https://itinerario-piloto.peyleth.workers.dev', maxBytesCuerpoProveedor: 16777216,
      respaldoServidor: { maxBytesOriginal: 8388608, maxBytesEntrada: 9437184, maxBytesChunk: 4194304,
        maxBytesCabeceras: 16384, maxBytesRetenidos: 67108864, maxBloquesOriginal: 128, bytesBloque: 65536, plazoMs: 120000 },
      listadoServidor: { maxFilas: 1, maxOperacionesPorFoto: 8, maxBytesSql: 5242880,
        maxBytesRespuesta: 524288, maxBytesRetenidos: 67108864, plazoMs: 60000 },
      listadoCliente: { maxFilas: 1, maxBytesPagina: 524288, maxBytesChunk: 4194304,
        maxBytesBackingChunk: 4194304, maxLecturas: 65536, maxBytesPlan: 1048576, maxBytesRetenidos: 67108864, plazoMs: 60000 },
      portabilidad: { limites: { maxRegistros: 256, maxBytesMetadatos: 8388608,
        maxBytesArchivo: 33554432, maxProfundidad: 64 }, limitesHistoria: { maxImportaciones: 16,
        maxObservaciones: 512, maxProcedencias: 512, maxBytesHistoria: 16777216 } },
    });
  });

  it('no inicia red, almacenamiento, DOM ni temporizadores en el preflight completo', () => {
    const io = vi.fn(prohibido);
    for (const clave of ['fetch', 'indexedDB', 'localStorage', 'document', 'setTimeout']) vi.stubGlobal(clave, io);
    try {
      expect(crearPerfilOperativoPiloto().respaldoServidor.maxBytesOriginal).toBe(8388608);
      expect(io).not.toHaveBeenCalled();
    } finally { vi.unstubAllGlobals(); }
  });

  it('admite 8 MiB sin reducir originales y activa catálogo y portabilidad reales', () => {
    const datos = crearPerfilOperativoPiloto();
    const perfil = crearPerfilPiloto(datos);
    expect(perfil.respaldo.maxBytesOriginal).toBe(8388608);
    expect(perfil.origen).toBe('https://itinerario-piloto.peyleth.workers.dev');
    expect(prepararPiloto(datos, 'https://itinerario-piloto.peyleth.workers.dev'))
      .toEqual({ respaldo: perfil.respaldo, portabilidad: perfil.portabilidad });
    expect(() => admitirOriginalFotos(8388608, perfil.respaldoServidor)).not.toThrow();
    expect(bytesRetenidosFotos(8388608, perfil.respaldoServidor)).toBe(21758464);
    expect(admitirMarcoObjetoFotos(8388608, 'x'.repeat(65536), perfil.respaldoServidor))
      .toEqual({ bytesMetadata: 65536, bytesFisicos: 8454156 });
    expect(crearPortabilidadInterfaz({ plan: itinerario, ...perfil.portabilidad,
      fabrica: null, leerLegado: () => null }).conHistoria).toBe(true);
    const ejecutor = { ejecutar: vi.fn(prohibido) };
    const bucket = { get: vi.fn(prohibido), put: vi.fn(prohibido) };
    expect(crearComposicionFotos({ plan: itinerario, origen: perfil.origen,
      presupuesto: perfil.respaldoServidor, ejecutor, bucket })).toHaveProperty('conAutenticacion');
    expect(prepararListadoFotos({ plan: itinerario, origen: perfil.origen,
      presupuesto: perfil.listadoServidor, ejecutor })).toHaveProperty('conAutenticacion');
    expect(ejecutor.ejecutar).not.toHaveBeenCalled();
    expect(bucket.get).not.toHaveBeenCalled();
    expect(bucket.put).not.toHaveBeenCalled();
  });

  it('cobra el encuadre R2 adicional y rechaza 32 MiB o un original mayor', () => {
    const p = crearPerfilOperativoPiloto().respaldoServidor;
    expect(() => admitirMarcoObjetoFotos(8388608, 'x', { ...p, maxBytesRetenidos: 33554432 })).toThrow();
    expect(() => admitirOriginalFotos(8388609, p)).toThrow();
    // Retención lógica exacta: multipart + otro original + tres chunks + metadata/cabecera.
    expect(() => admitirMarcoObjetoFotos(8388608, 'x', { ...p, maxBytesRetenidos: 43254283 })).toThrow();
    expect(() => admitirMarcoObjetoFotos(8388608, 'x', { ...p, maxBytesRetenidos: 43254284 })).not.toThrow();
  });

  it('cobra el catálogo real y la retención HTTP, no solo el esquema del perfil', () => {
    const datos = crearPerfilOperativoPiloto();
    const reducido = { ...datos, listadoCliente: { ...datos.listadoCliente, maxBytesPlan: 1 } };
    expect(() => crearPerfilPiloto(reducido)).not.toThrow();
    expect(() => prepararPiloto(reducido, datos.origen)).toThrow();
    expect(() => prepararListadoFotos({ plan: itinerario, origen: datos.origen,
      presupuesto: { ...datos.listadoServidor, maxBytesRetenidos: 33554432 },
      ejecutor: { ejecutar: async () => prohibido() } })).toThrow();
  });

  it('produce snapshots independientes, sin adoptar cambios del consumidor', () => {
    const uno = crearPerfilOperativoPiloto();
    const perfil = crearPerfilPiloto(uno);
    expect(Object.isFrozen(perfil.respaldoServidor)).toBe(true);
    expect(Reflect.set(uno.respaldoServidor, 'maxBytesOriginal', 1)).toBe(false);
    expect(crearPerfilOperativoPiloto().respaldoServidor.maxBytesOriginal).toBe(8388608);
    expect(perfil.respaldo.maxBytesOriginal).toBe(8388608);
  });
});
