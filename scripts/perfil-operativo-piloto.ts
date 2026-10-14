import { crearPerfilPiloto, type DatosPerfilPiloto } from '../src/perfil-piloto';
import { prepararPiloto } from '../src/preparar-piloto';
import { itinerario } from '../src/datos/itinerario';
import { crearPortabilidadInterfaz } from '../src/portabilidad-interfaz';
import { crearTransporteFotos } from '../src/fotos-transporte';
import { crearDescargaFotos } from '../src/fotos-descarga';
import { admitirOriginalFotos } from '../servidor/multipart-fotos';
import { admitirMarcoObjetoFotos } from '../servidor/almacen-fotos';
import { crearComposicionFotos } from '../servidor/composicion-fotos';
import { prepararListadoFotos } from '../servidor/api-listado-fotos';

/** Política inicial de una persona, acciones secuenciales; no certifica proveedor ni heap.
 * Valida las fábricas reales con puertos indisponibles: nunca ejecuta IO ni concede autoridad.
 * Devuelve datos semánticos aptos para el build privado, no un PerfilPiloto serializado. */
export function crearPerfilOperativoPiloto(): DatosPerfilPiloto {
  const datos = {
    origen: 'https://itinerario-piloto.tumanag3r.workers.dev', maxBytesCuerpoProveedor: 16777216,
    respaldoServidor: { maxBytesOriginal: 8388608, maxBytesEntrada: 9437184, maxBytesChunk: 4194304,
      maxBytesCabeceras: 16384, maxBytesRetenidos: 67108864, maxBloquesOriginal: 128,
      bytesBloque: 65536, plazoMs: 120000 },
    listadoServidor: { maxFilas: 1, maxOperacionesPorFoto: 8, maxBytesSql: 5242880,
      maxBytesRespuesta: 524288, maxBytesRetenidos: 67108864, plazoMs: 60000 },
    listadoCliente: { maxFilas: 1, maxBytesPagina: 524288, maxBytesChunk: 4194304,
      maxBytesBackingChunk: 4194304, maxLecturas: 65536, maxBytesPlan: 1048576,
      maxBytesRetenidos: 67108864, plazoMs: 60000 },
    portabilidad: { limites: { maxRegistros: 256, maxBytesMetadatos: 8388608,
      maxBytesArchivo: 33554432, maxProfundidad: 64 }, limitesHistoria: { maxImportaciones: 16,
      maxObservaciones: 512, maxProcedencias: 512, maxBytesHistoria: 16777216 } },
  };
  return validarDatosPerfil(datos);
}

/** Separa la política declarada de su admisión; no duplica las fórmulas del dominio. */
function validarDatosPerfil(datos: DatosPerfilPiloto): DatosPerfilPiloto {
  const perfil = crearPerfilPiloto(datos);
  prepararPiloto(datos, perfil.origen);
  admitirOriginalFotos(perfil.respaldo.maxBytesOriginal, perfil.respaldoServidor);
  // Metadata máxima admitida por el encuadre, además del multipart y del otro Blob.
  admitirMarcoObjetoFotos(perfil.respaldo.maxBytesOriginal, 'x'.repeat(65536), perfil.respaldoServidor);
  const indisponible = async (): Promise<never> => { throw new Error('Preflight sin IO.'); };
  const ejecutor = { ejecutar: indisponible };
  crearComposicionFotos({ plan: itinerario, origen: perfil.origen, presupuesto: perfil.respaldoServidor,
    ejecutor, bucket: { get: indisponible, put: indisponible } });
  prepararListadoFotos({ plan: itinerario, origen: perfil.origen, presupuesto: perfil.listadoServidor, ejecutor });
  crearPortabilidadInterfaz({ plan: itinerario, ...perfil.portabilidad, fabrica: null, leerLegado: () => null });
  crearTransporteFotos({ plan: itinerario, origen: perfil.origen, maxBytesOriginal: perfil.respaldo.maxBytesOriginal,
    fuente: null, ledger: null, fetch: null }).cerrar();
  crearDescargaFotos({ plan: itinerario, origen: perfil.origen, maxBytesOriginal: perfil.respaldo.maxBytesOriginal,
    fotos: { leerMetadatos: indisponible, leerOriginal: indisponible, guardarOriginal: indisponible }, fetch: null }).cerrar();
  // Se emiten los snapshots validados; listadoCliente es el nombre del esquema de entrada.
  return { origen: perfil.origen, maxBytesCuerpoProveedor: perfil.maxBytesCuerpoProveedor,
    respaldoServidor: perfil.respaldoServidor, listadoServidor: perfil.listadoServidor,
    listadoCliente: perfil.respaldo.listado, portabilidad: perfil.portabilidad };
}
