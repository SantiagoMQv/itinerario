import type { EjecutorSql } from './contratos';
import type { DecisionHistorica, PasarelaProgreso } from './almacen-progreso';
import { campos } from '../src/progreso-validacion';
import { capturarOperacionProgreso } from '../src/progreso-cola';
import { parsearProgreso, serializarProgreso } from '../src/progreso-json';

const ERROR = 'No se pudo comprobar el progreso.';
const codificador = new TextEncoder();
const fallar = (): never => { throw new Error(ERROR); };
function identidad(v: unknown): v is string {
  if (typeof v !== 'string' || !v || v.includes('\0')) return false;
  const bytes = codificador.encode(v);
  return bytes.length <= 128 && new TextDecoder('utf-8', { fatal: true }).decode(bytes) === v;
}
function sobre(v: unknown, claves: string[]): v is Record<string, unknown> {
  return campos(v, claves) && Reflect.ownKeys(v).every((k) =>
    Object.hasOwn(Object.getOwnPropertyDescriptor(v, k)!, 'value'));
}
const contador = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0;
function alcance(huella: string, viaje: string, id?: string): void {
  if (typeof huella !== 'string' || !/^[a-f0-9]{64}$/.test(huella)
    || !identidad(viaje) || (id !== undefined && !identidad(id))) fallar();
}
function diccionario(v: unknown, validar: (dato: unknown) => boolean): v is Record<string, unknown> {
  return campos(v, Object.getOwnPropertyNames(v ?? {}))
    && Object.entries(v).every(([id, dato]) => identidad(id) && validar(dato));
}
function estadoDto(v: Record<string, unknown>): boolean {
  const marca = (m: unknown) => m === null || m === 'hecha' || m === 'saltada' || m === 'aqui';
  const paradas = diccionario(v.paradas, (p) => campos(p, ['marca', 'revision'], ['horaReal'])
    && marca(p.marca) && contador(p.revision) && (!Object.hasOwn(p, 'horaReal')
      || (p.marca !== null && typeof p.horaReal === 'number' && Number.isFinite(p.horaReal))));
  const pendientes = diccionario(v.pendientes, (p) => sobre(p, ['hecho', 'revision'])
    && typeof p.hecho === 'boolean' && contador(p.revision));
  const aqui = sobre(v.aqui, ['paradaId', 'revision']) && contador(v.aqui.revision)
    && (v.aqui.paradaId === null || identidad(v.aqui.paradaId));
  const operaciones = diccionario(v.operaciones, (r) => campos(r, ['firma'], ['cambios'])
    && typeof r.firma === 'string' && (!Object.hasOwn(r, 'cambios')
      || capturarOperacionProgreso({ id: 'recibo', dispositivoId: 'interno', tipo: 'deshacer', cambios: r.cambios }) !== null));
  if (!paradas || !pendientes || !aqui || !operaciones) return false;
  const activas = Object.entries(v.paradas as Record<string, { marca: unknown }>).filter(([, p]) => p.marca === 'aqui');
  return activas.length <= 1 && (activas[0]?.[0] ?? null) === (v.aqui as { paradaId: unknown }).paradaId
    && Object.entries(v.operaciones as Record<string, { cambios?: { operacionId: string } }>).every(([id, r]) =>
      r.cambios === undefined || r.cambios.operacionId === id);
}
function payload(candidato: DecisionHistorica, viaje: string, base: number): string {
  // El códec captura datos propios sin accesores antes de inspeccionar ningún discriminante.
  const texto = serializarProgreso(candidato);
  const c = parsearProgreso(texto);
  let dto: Record<string, unknown>;
  let original: unknown;
  if (sobre(c, ['tipo', 'operacionOriginal', 'acuse']) && c.tipo === 'positiva'
    && sobre(c.acuse, ['operacionId', 'persistida', 'instantanea']) && c.acuse.persistida === true) {
    dto = c.acuse; original = c.operacionOriginal;
  } else if (sobre(c, ['tipo', 'rechazo']) && c.tipo === 'negativa'
    && sobre(c.rechazo, ['viajeId', 'protocolo', 'operacionId', 'operacionOriginal',
      'decisionPersistida', 'motivo', 'instantanea']) && c.rechazo.viajeId === viaje
    && c.rechazo.protocolo === 1 && c.rechazo.decisionPersistida === true
    && (c.rechazo.motivo === 'conflicto' || c.rechazo.motivo === 'invalida')) {
    dto = c.rechazo; original = c.rechazo.operacionOriginal;
  } else return fallar();
  const op = capturarOperacionProgreso(original);
  if (!op || !identidad(op.id) || !identidad(op.dispositivoId) || dto.operacionId !== op.id
    || !sobre(dto.instantanea, ['revisionServidor', 'estado']) || dto.instantanea.revisionServidor !== base + 1
    || !sobre(dto.instantanea.estado, ['viajeId', 'paradas', 'pendientes', 'aqui', 'operaciones'])
    || dto.instantanea.estado.viajeId !== viaje || !estadoDto(dto.instantanea.estado)) return fallar();
  const operaciones = dto.instantanea.estado.operaciones;
  if ((c.tipo === 'positiva') !== Object.hasOwn(operaciones as object, op.id)) return fallar();
  // Catálogo, recibos y semántica pertenecen al almacén/core; SQL comprueba estructura/CAS.
  return texto;
}

/** Cada llamada es UN SELECT de función transaccional, nunca BEGIN/COMMIT entre HTTP.
 * El ejecutor debe resolver después del compromiso del statement, no al recibir sus filas.
 * TEXT evita que el SDK normalice números del dominio (especialmente -0).
 */
export function crearPasarelaSql({ ejecutor }: { readonly ejecutor: EjecutorSql }): PasarelaProgreso {
  async function llamar(sql: string, parametros: readonly unknown[]): Promise<unknown> {
    const resultado = await ejecutor.ejecutar(sql, parametros);
    if (!sobre(resultado, ['filas']) || !Array.isArray(resultado.filas)
      || Reflect.ownKeys(resultado.filas).length !== 2 || resultado.filas.length !== 1) return fallar();
    const fila: unknown = Object.getOwnPropertyDescriptor(resultado.filas, '0')?.value;
    if (!sobre(fila, ['resultado']) || typeof fila.resultado !== 'string') return fallar();
    return parsearProgreso(fila.resultado); // Sigue siendo unknown: el almacén valida el DTO completo.
  }
  async function seguro(ejecutar: () => Promise<unknown>): Promise<unknown> {
    try { return await ejecutar(); } catch { return fallar(); }
  }
  return Object.freeze({
    consultar(huella: string, viaje: string, id?: string): Promise<unknown> {
      return seguro(async () => {
        alcance(huella, viaje, id);
        return llamar('SELECT itinerario.consultar_progreso($1, $2, $3) AS resultado', [huella, viaje, id ?? null]);
      });
    },
    confirmar(huella: string, viaje: string, base: number, candidato: DecisionHistorica): Promise<unknown> {
      return seguro(async () => {
        alcance(huella, viaje);
        if (!contador(base) || base === Number.MAX_SAFE_INTEGER) return fallar();
        const texto = payload(candidato, viaje, base);
        return llamar('SELECT itinerario.confirmar_progreso($1, $2, $3, $4) AS resultado', [huella, viaje, base, texto]);
      });
    },
  });
}
