// La entrada importa la app real (src/main.ts usa __PLAN__, que Vite define y declara src/global.d.ts).
/// <reference path="../src/global.d.ts" />
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { itinerario } from '../src/datos/itinerario';
import { crearClienteListadoFotos } from '../src/fotos-listado';
import type { ComposicionItinerario } from '../src/main';
import { crearPerfilPiloto, type DatosPerfilPiloto } from '../src/perfil-piloto';
import { copiarPlanPortable } from '../src/portabilidad';
import { arrancarPiloto } from '../src/entrada-piloto';

// Solo se sustituye la frontera con la app (src/main.ts): aquí se prueba el contrato de la entrada. Que importar
// la app real en frío no arranque nada y que no pueda arrancar dos veces se prueba después en un navegador (V2).
const arrancarItinerario = vi.hoisted(() => vi.fn<(composicion: ComposicionItinerario) => void>());
vi.mock('../src/main', () => ({ arrancarItinerario }));

const ORIGEN = 'https://piloto.example';
const LISTADO = 'No se puede preparar el listado de fotos.';
/** Presupuestos SINTÉTICOS, solo de prueba: admisión lógica, no política desplegada ni memoria reservada. */
function ejemplo() {
  return {
    origen: ORIGEN, maxBytesCuerpoProveedor: 67045,
    respaldoServidor: { maxBytesOriginal: 1024, maxBytesEntrada: 67044, maxBytesChunk: 4096,
      maxBytesCabeceras: 256, maxBytesRetenidos: 2000000, maxBloquesOriginal: 4, bytesBloque: 256, plazoMs: 1000 },
    listadoServidor: { maxFilas: 1, maxOperacionesPorFoto: 1, maxBytesSql: 5000000,
      maxBytesRespuesta: 500000, maxBytesRetenidos: 60000000, plazoMs: 1000 },
    listadoCliente: { maxFilas: 1, maxBytesPagina: 500000, maxBytesChunk: 4096, maxBytesBackingChunk: 4096,
      maxLecturas: 100, maxBytesPlan: 4194304, maxBytesRetenidos: 512 * 1024 ** 2, plazoMs: 1000 },
    portabilidad: { limites: { maxRegistros: 10, maxBytesMetadatos: 10000, maxBytesArchivo: 100000, maxProfundidad: 8 },
      limitesHistoria: { maxImportaciones: 2, maxObservaciones: 10, maxProcedencias: 10, maxBytesHistoria: 200000 } },
  } satisfies DatosPerfilPiloto;
}
/** Lo que la fábrica real del catálogo admite con ese perfil para el plan REAL (sin red: http null). */
function listadoReal(d: unknown) {
  const perfil = crearPerfilPiloto(d);
  return crearClienteListadoFotos({ plan: itinerario, origen: perfil.origen, presupuesto: perfil.respaldo.listado, http: null });
}
beforeEach(() => arrancarItinerario.mockClear());
afterEach(() => vi.unstubAllGlobals());

describe('entrada del piloto: valida perfil, origen y plan real antes de arrancar la app', () => {
  it('perfil válido: arranca UNA vez con las composiciones del perfil, congeladas y sin referencias de la entrada', () => {
    const d = ejemplo();
    // Precondiciones con constructores reales y puros: el perfil vale, el catálogo admite el plan real y su
    // catálogo de portabilidad es válido.
    expect(() => crearPerfilPiloto(d)).not.toThrow();
    listadoReal(d).cerrar();
    expect(() => copiarPlanPortable(itinerario)).not.toThrow();

    arrancarPiloto(d, ORIGEN);
    expect(arrancarItinerario).toHaveBeenCalledTimes(1);
    const [composicion] = arrancarItinerario.mock.calls[0];
    expect(composicion).toEqual({ respaldo: { origen: ORIGEN, listado: ejemplo().listadoCliente, maxBytesOriginal: 1024 },
      portabilidad: ejemplo().portabilidad });
    const { respaldo, portabilidad } = composicion;
    if (!respaldo || !portabilidad) throw new Error('Faltan composiciones');
    for (const hoja of [respaldo, respaldo.listado, portabilidad, portabilidad.limites, portabilidad.limitesHistoria]) {
      expect(Object.isFrozen(hoja)).toBe(true);
    }
    expect(respaldo.listado).not.toBe(d.listadoCliente);
    expect(portabilidad.limites).not.toBe(d.portabilidad.limites);
    // Cambiar después lo que se pasó no cambia lo que recibió la app.
    d.origen = 'https://otro.example'; d.listadoCliente.maxFilas = 8; d.portabilidad.limites.maxRegistros = 999;
    expect(composicion).toEqual({ respaldo: { origen: ORIGEN, listado: ejemplo().listadoCliente, maxBytesOriginal: 1024 },
      portabilidad: ejemplo().portabilidad });
  });

  it.each([
    ['null', null], ['objeto vacío', {}], ['texto', ORIGEN], ['origen http', { ...ejemplo(), origen: 'http://piloto.example' }],
    ['campo extra', { ...ejemplo(), extra: 1 }],
  ])('perfil inválido (%s): rechaza antes de arrancar', (_caso, datos) => {
    expect(() => crearPerfilPiloto(datos)).toThrow('Perfil del piloto inválido.');
    expect(() => arrancarPiloto(datos, ORIGEN)).toThrow('Perfil del piloto inválido.');
    expect(arrancarItinerario).not.toHaveBeenCalled();
  });

  it.each(['https://otro.example', 'https://piloto.example/', 'http://piloto.example', ''])(
    'origen de la página distinto (%j): rechaza antes de arrancar', (origenPagina) => {
      expect(() => crearPerfilPiloto(ejemplo())).not.toThrow();
      expect(() => arrancarPiloto(ejemplo(), origenPagina)).toThrow('El perfil del piloto es de otro origen.');
      expect(arrancarItinerario).not.toHaveBeenCalled();
    });

  it('con location real de otro origen, un origenPagina que imita al perfil no salta la comprobación del catálogo', () => {
    vi.stubGlobal('location', { origin: 'https://otro.example' });
    expect(() => crearPerfilPiloto(ejemplo())).not.toThrow();
    expect(() => listadoReal(ejemplo())).toThrow(LISTADO);
    expect(() => arrancarPiloto(ejemplo(), ORIGEN)).toThrow(LISTADO);
    expect(arrancarItinerario).not.toHaveBeenCalled();
    // Con la página en el mismo origen, la misma llamada sí arranca.
    vi.stubGlobal('location', { origin: ORIGEN });
    listadoReal(ejemplo()).cerrar();
    arrancarPiloto(ejemplo(), ORIGEN);
    expect(arrancarItinerario).toHaveBeenCalledTimes(1);
  });

  it('el D del plan real no cabe en maxBytesPlan: el perfil lo admite, pero la entrada rechaza antes de arrancar', () => {
    const d = ejemplo();
    d.listadoCliente.maxBytesPlan = 4096;
    expect(() => crearPerfilPiloto(d)).not.toThrow();
    expect(() => listadoReal(d)).toThrow(LISTADO);
    expect(() => arrancarPiloto(d, ORIGEN)).toThrow(LISTADO);
    expect(arrancarItinerario).not.toHaveBeenCalled();
  });

  it('retención suficiente para el perfil pero no para el plan real: rechaza antes de arrancar', () => {
    const d = ejemplo();
    // El mínimo del perfil sin D (16P + 32NM + C + 1 MiB); el catálogo cobra además (8N+16)·D del plan real.
    d.listadoCliente.maxBytesRetenidos = 9617520;
    expect(() => crearPerfilPiloto(d)).not.toThrow();
    expect(() => crearPerfilPiloto({ ...d, listadoCliente: { ...d.listadoCliente, maxBytesRetenidos: 9617519 } })).toThrow();
    expect(() => listadoReal(d)).toThrow(LISTADO);
    listadoReal(ejemplo()).cerrar();
    expect(() => arrancarPiloto(d, ORIGEN)).toThrow(LISTADO);
    expect(arrancarItinerario).not.toHaveBeenCalled();
  });

  it('durante la validación no toca red, temporizadores, IndexedDB, localStorage, documento ni navigator', () => {
    const io = vi.fn(() => { throw new Error('IO prohibido'); });
    try {
      for (const clave of ['fetch', 'indexedDB', 'localStorage', 'document', 'navigator', 'setTimeout', 'setInterval']) {
        vi.stubGlobal(clave, io);
      }
      arrancarPiloto(ejemplo(), ORIGEN);
    } finally {
      vi.unstubAllGlobals();
    }
    expect(io).not.toHaveBeenCalled();
    expect(arrancarItinerario).toHaveBeenCalledTimes(1);
  });

  it('un rechazo previo no consume el arranque: una llamada corregida después sí arranca', () => {
    const malo = { ...ejemplo(), listadoCliente: { ...ejemplo().listadoCliente, maxBytesPlan: 4096 } };
    expect(() => arrancarPiloto(malo, ORIGEN)).toThrow(LISTADO);
    expect(() => arrancarPiloto(ejemplo(), 'https://otro.example')).toThrow('El perfil del piloto es de otro origen.');
    expect(arrancarItinerario).not.toHaveBeenCalled();
    arrancarPiloto(ejemplo(), ORIGEN);
    expect(arrancarItinerario).toHaveBeenCalledTimes(1);
  });
});
