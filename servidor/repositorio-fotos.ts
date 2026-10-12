import type { Itinerario } from '../src/tipos';
import { camposFoto, esIdFoto } from '../src/fotos';
import { mismosOriginalesRespaldo } from '../src/fotos-respaldo';
import { deserializarSolicitudRespaldo, serializarSolicitudRespaldo, serializarReciboRespaldo,
  deserializarReciboRespaldo, type SolicitudRespaldo } from '../src/fotos-protocolo';
import { parsearProgreso } from '../src/progreso-json';
import { copiarPlanFotos } from './multipart-fotos';
import type { EjecutorSql } from './contratos';
import { clavePrivadaFotos, type RepositorioFotos, type ReservaFotos,
  type ResultadoReservaFotos, type ResultadoFinalFotos, type ResultadoConsultaFoto } from './almacen-fotos';

const ERROR = 'No se pudo comprobar las fotos.';
const fallar = (): never => {
  const error = new Error(ERROR);
  // La frontera privada no transporta stack/cause/respuesta SQL ni credenciales.
  delete error.stack;
  throw error;
};
const RESERVAR = 'SELECT itinerario.reservar_foto($1, $2, $3, $4, $5, $6, $7, $8) AS resultado';
const FINALIZAR = 'SELECT itinerario.finalizar_foto($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) AS resultado';
const CONSULTAR = 'SELECT itinerario.consultar_foto($1, $2, $3) AS resultado';
const codificador = new TextEncoder();

/** UN statement parametrizado por puerto. Resolver ejecutor significa COMMIT confirmado
 * por SU contrato, no una prueba de durabilidad Neon ni atomicidad SQL/R2.
 * No retries: resultado perdido conserva incertidumbre; nunca recrea ni adopta reserva.
 */
export function crearRepositorioFotosSql(configuracion: {
  readonly plan: Itinerario; readonly ejecutor: EjecutorSql;
}): RepositorioFotos {
  let plan: Itinerario;
  let ejecutar: EjecutorSql['ejecutar'];
  try {
    if (!camposFoto(configuracion, ['plan', 'ejecutor'])) return fallar();
    // Capturar plan antes de inspeccionar el puerto: no getters del original/clonado.
    plan = copiarPlanFotos(configuracion.plan);
    const puerto = configuracion.ejecutor;
    if (puerto === null || typeof puerto !== 'object') return fallar();
    const descriptor = Object.getOwnPropertyDescriptor(puerto, 'ejecutar');
    if (!descriptor || !Object.hasOwn(descriptor, 'value') || typeof descriptor.value !== 'function') return fallar();
    ejecutar = Function.prototype.bind.call(descriptor.value, puerto) as EjecutorSql['ejecutar'];
  } catch { return fallar(); }

  function alcance(huella: unknown, viaje: unknown): void {
    if (typeof huella !== 'string' || !/^[a-f0-9]{64}$/.test(huella)
      || typeof viaje !== 'string' || viaje !== plan.id || !viaje || viaje.includes('\0')
      || codificador.encode(viaje).length > 128
      || new TextDecoder('utf-8', { fatal: true }).decode(codificador.encode(viaje)) !== viaje) return fallar();
  }
  function solicitud(texto: unknown): SolicitudRespaldo {
    const valor = deserializarSolicitudRespaldo(plan, texto);
    if (serializarSolicitudRespaldo(plan, valor) !== texto) return fallar();
    return valor;
  }
  function recibo(valor: SolicitudRespaldo): string {
    // Un request válido puede producir un recibo >64KiB: siempre antes de TODO IO/DML.
    return serializarReciboRespaldo(plan, { ...valor, tipo: 'acuse-respaldo',
      objetoOriginalDurable: true, metadatosDurables: true });
  }
  function cabecera(s: SolicitudRespaldo, tipo: 'solicitud-respaldo' | 'acuse-respaldo'): string {
    // Sólo strings primitivos de la copia validada; nunca stringify de objetos/metadata.
    return '{"version":1,"tipo":' + JSON.stringify(tipo) + ',"viajeId":' + JSON.stringify(s.viajeId)
      + ',"operacionId":' + JSON.stringify(s.operacionId) + ',"fotoId":' + JSON.stringify(s.fotoId) + ',"original":';
  }
  function originalCanonico(s: SolicitudRespaldo, texto: string, potencial: string): string {
    const prefijo = cabecera(s, 'solicitud-respaldo');
    if (!texto.startsWith(prefijo) || !texto.endsWith('}')) return fallar();
    // Offsets del encuadre COMPLETO del codec, no buscar marcadores en las strings.
    const original = texto.slice(prefijo.length, texto.length - 1);
    if (prefijo + original + '}' !== texto || cabecera(s, 'acuse-respaldo') + original
      + ',"objetoOriginalDurable":true,"metadatosDurables":true}' !== potencial) return fallar();
    return original;
  }
  function reserva(valor: unknown): { fija: ReservaFotos; inicial: SolicitudRespaldo } {
    if (!camposFoto(valor, ['reservaId', 'claveObjeto', 'solicitudCanonica'])
      || !esIdFoto(valor.reservaId) || typeof valor.claveObjeto !== 'string'
      || typeof valor.solicitudCanonica !== 'string') return fallar();
    const inicial = solicitud(valor.solicitudCanonica);
    if (valor.claveObjeto !== clavePrivadaFotos(plan.id, inicial.fotoId, valor.reservaId)) return fallar();
    const fija = Object.freeze({ reservaId: valor.reservaId, claveObjeto: valor.claveObjeto,
      solicitudCanonica: valor.solicitudCanonica });
    return { fija, inicial };
  }
  async function llamar(consulta: string, parametros: readonly unknown[]): Promise<unknown> {
    const resultado: unknown = await ejecutar(consulta, Object.freeze([...parametros]));
    if (!camposFoto(resultado, ['filas']) || !Array.isArray(resultado.filas)
      || Object.getPrototypeOf(resultado.filas) !== Array.prototype
      || Reflect.ownKeys(resultado.filas).length !== 2
      || Object.getOwnPropertyDescriptor(resultado.filas, 'length')?.value !== 1) return fallar();
    const fila: unknown = Object.getOwnPropertyDescriptor(resultado.filas, '0')?.value;
    if (!camposFoto(fila, ['resultado']) || typeof fila.resultado !== 'string'
      || fila.resultado.length > 1024 * 1024) return fallar();
    // Sólo envelope interno; las cadenas de fotos vuelven a su codec estricto abajo.
    return parsearProgreso(fila.resultado);
  }
  async function seguro<T>(accion: () => Promise<T>): Promise<T> {
    try { return await accion(); } catch { return fallar(); }
  }
  return Object.freeze({
    reservar(huella: string, viaje: string, texto: string): Promise<ResultadoReservaFotos> {
      return seguro(async () => {
        alcance(huella, viaje);
        const s = solicitud(texto);
        const potencial = recibo(s);
        const original = originalCanonico(s, texto, potencial);
        const id = crypto.randomUUID();
        if (!esIdFoto(id)) return fallar();
        const clave = clavePrivadaFotos(plan.id, s.fotoId, id);
        const valor = await llamar(RESERVAR, [huella, viaje, s.fotoId, s.operacionId, texto, original, id, clave]);
        if (camposFoto(valor, ['tipo']) && (valor.tipo === 'sin-sesion' || valor.tipo === 'contradiccion')) {
          return Object.freeze({ tipo: valor.tipo });
        }
        if (!camposFoto(valor, ['tipo', 'reserva']) || (valor.tipo !== 'ganadora' && valor.tipo !== 'existente')) return fallar();
        const r = reserva(valor.reserva);
        if (r.inicial.fotoId !== s.fotoId || !mismosOriginalesRespaldo(plan, r.inicial.original, s.original)
          || (valor.tipo === 'ganadora' && (r.fija.reservaId !== id || r.fija.claveObjeto !== clave
            || r.fija.solicitudCanonica !== texto))) return fallar();
        return Object.freeze({ tipo: valor.tipo, reserva: r.fija });
      });
    },
    finalizar(huella: string, viaje: string, valorReserva: ReservaFotos, texto: string): Promise<ResultadoFinalFotos> {
      return seguro(async () => {
        alcance(huella, viaje);
        const s = solicitud(texto);
        const potencial = recibo(s);
        const original = originalCanonico(s, texto, potencial);
        const r = reserva(valorReserva); // copia completa antes del primer await
        if (r.inicial.fotoId !== s.fotoId || !mismosOriginalesRespaldo(plan, r.inicial.original, s.original)) {
          return Object.freeze({ tipo: 'contradiccion' });
        }
        const valor = await llamar(FINALIZAR, [huella, viaje, s.fotoId, s.operacionId, texto,
          original, r.fija.reservaId, r.fija.claveObjeto, r.fija.solicitudCanonica, potencial]);
        if (camposFoto(valor, ['tipo']) && (valor.tipo === 'sin-sesion' || valor.tipo === 'contradiccion' || valor.tipo === 'incierta')) {
          return Object.freeze({ tipo: valor.tipo });
        }
        if (!camposFoto(valor, ['tipo', 'reciboCanonico']) || valor.tipo !== 'confirmada'
          || typeof valor.reciboCanonico !== 'string' || valor.reciboCanonico !== potencial) return fallar();
        const dto = deserializarReciboRespaldo(plan, valor.reciboCanonico);
        if (serializarReciboRespaldo(plan, dto) !== valor.reciboCanonico) return fallar();
        return Object.freeze({ tipo: 'confirmada', reciboCanonico: valor.reciboCanonico });
      });
    },
    leerConfirmada(huella: string, viaje: string, foto: string): Promise<ResultadoConsultaFoto> {
      return seguro(async () => {
        alcance(huella, viaje);
        if (!esIdFoto(foto)) return fallar();
        const valor = await llamar(CONSULTAR, [huella, viaje, foto]);
        if (camposFoto(valor, ['tipo']) && (valor.tipo === 'sin-sesion' || valor.tipo === 'ausente')) {
          return Object.freeze({ tipo: valor.tipo });
        }
        if (!camposFoto(valor, ['tipo', 'reserva']) || valor.tipo !== 'confirmada') return fallar();
        const r = reserva(valor.reserva);
        if (r.inicial.fotoId !== foto) return fallar();
        return Object.freeze({ tipo: 'confirmada', reserva: r.fija });
      });
    },
  });
}
