import type { EjecutorSql } from './contratos';
import { crearAlmacenIntentosSql } from './almacen-intentos';
import type { RegistroSesion, RepositorioSesiones, ResultadoRevocacion } from './sesiones';
import { parsearProgreso, serializarProgreso } from '../src/progreso-json';

const ERROR = 'No se pudo comprobar la sesión.';
const fallar = (): never => { throw new Error(ERROR); };
const codificador = new TextEncoder();
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const huellaValida = (v: unknown): v is string => typeof v === 'string' && /^[0-9a-f]{64}$/.test(v);
const tiempo = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0;
function texto(v: unknown, maximo: number, puntos = false): v is string {
  if (typeof v !== 'string' || !v) return false;
  const bytes = codificador.encode(v);
  return (puntos ? Array.from(v).length : bytes.length) <= maximo
    && new TextDecoder('utf-8', { fatal: true }).decode(bytes) === v;
}
function viaje(v: unknown): v is string { return texto(v, 128) && !v.includes('\0'); }

// Captura acotada, propia y aislada: admite datos ocultos, no prototipos/símbolos/getters.
// Esquemas exactos se declaran en cada uso; undefined propio NO significa campo ausente.
function capturar(v: unknown, requeridos: readonly string[], opcionales: readonly string[] = []): Record<string, unknown> {
  if (v === null || typeof v !== 'object' || Object.getPrototypeOf(v) !== Object.prototype) return fallar();
  const copia: Record<string, unknown> = {};
  for (const clave of Reflect.ownKeys(v)) {
    if (typeof clave !== 'string' || ![...requeridos, ...opcionales].includes(clave)) return fallar();
    const descriptor = Object.getOwnPropertyDescriptor(v, clave);
    if (!descriptor || !Object.hasOwn(descriptor, 'value')) return fallar();
    Object.defineProperty(copia, clave, { value: descriptor.value, enumerable: true });
  }
  if (!requeridos.every((clave) => Object.hasOwn(copia, clave))) return fallar();
  return Object.freeze(copia);
}
function arreglo(v: unknown): readonly unknown[] {
  if (!Array.isArray(v) || Object.getPrototypeOf(v) !== Array.prototype) return fallar();
  const longitud = Object.getOwnPropertyDescriptor(v, 'length')?.value;
  if (!tiempo(longitud) || Reflect.ownKeys(v).length !== longitud + 1) return fallar();
  const copia: unknown[] = [];
  for (let i = 0; i < longitud; i++) {
    const descriptor = Object.getOwnPropertyDescriptor(v, String(i));
    if (!descriptor || !Object.hasOwn(descriptor, 'value')) return fallar();
    copia.push(descriptor.value);
  }
  return Object.freeze(copia);
}
const autoridades = ['id', 'huella', 'viajeId', 'creadaEn', 'venceEn', 'revocada'] as const;
function metadatos(v: unknown) {
  const m = capturar(v, ['dispositivoId'], ['nombreDispositivo']);
  if (!texto(m.dispositivoId, 128) || (Object.hasOwn(m, 'nombreDispositivo') && !texto(m.nombreDispositivo, 80, true))) return fallar();
  return Object.freeze({ dispositivoId: m.dispositivoId,
    ...(Object.hasOwn(m, 'nombreDispositivo') ? { nombreDispositivo: m.nombreDispositivo as string } : {}) });
}
function registro(v: unknown, viajeId: string, nueva = false): RegistroSesion {
  const r = capturar(v, [...autoridades, 'dispositivoId'], ['nombreDispositivo']);
  if (typeof r.id !== 'string' || !uuid.test(r.id) || !huellaValida(r.huella)
    || !viaje(r.viajeId) || r.viajeId !== viajeId || !tiempo(r.creadaEn) || !tiempo(r.venceEn)
    // DTO crudo respeta el guard del controlador; al crear SQL exige caducidad estricta.
    // Rechazar ANTES de escribir evita un commit seguido de error antes de la cookie.
    || r.venceEn < r.creadaEn || (nueva && r.venceEn === r.creadaEn)
    || typeof r.revocada !== 'boolean') return fallar();
  const m = metadatos({ dispositivoId: r.dispositivoId,
    ...(Object.hasOwn(r, 'nombreDispositivo') ? { nombreDispositivo: r.nombreDispositivo } : {}) });
  return Object.freeze({ id: r.id.toLowerCase(), huella: r.huella, viajeId: r.viajeId,
    creadaEn: r.creadaEn, venceEn: r.venceEn, revocada: r.revocada, ...m });
}
function decodificar(v: unknown, viajeId: string): RegistroSesion {
  const r = capturar(v, [...autoridades, 'metadatosTexto']);
  const m = metadatos(parsearProgreso(r.metadatosTexto));
  return registro({ id: r.id, huella: r.huella, viajeId: r.viajeId,
    creadaEn: r.creadaEn, venceEn: r.venceEn, revocada: r.revocada, ...m }, viajeId);
}

/** Seis puertos reales, incluido el límite persistente con el mismo ejecutor.
 * Cada método ejecuta un SELECT ligado. El ejecutor resuelve solo después del commit.
 * Autoridad: id/huella/viaje/fechas/revocada; metadatosTexto contiene exclusivamente
 * dispositivoId y nombreDispositivo opcional. NUL permanece escapado en TEXT hasta Worker.
 * Argumentos de otro viaje fallan antes de SQL; no hay secretos por defecto ni bootstrap.
 */
export function crearRepositorioSesionesSql(configuracion: {
  readonly ejecutor: EjecutorSql; readonly viajeId: string;
}): RepositorioSesiones {
  let ejecutor: EjecutorSql, viajeId: string;
  let intentos: Pick<RepositorioSesiones, 'admitirIntento'>;
  try {
    const c = capturar(configuracion, ['ejecutor', 'viajeId']);
    if (!viaje(c.viajeId)) return fallar();
    viajeId = c.viajeId; ejecutor = c.ejecutor as EjecutorSql;
    intentos = crearAlmacenIntentosSql({ ejecutor });
  } catch { return fallar(); }
  function alcance(huella: unknown, solicitado: unknown = viajeId): void {
    if (!huellaValida(huella) || solicitado !== viajeId) return fallar();
  }
  async function llamar(sql: string, parametros: readonly unknown[]): Promise<unknown> {
    const r = capturar(await ejecutor.ejecutar(sql, parametros), ['filas']);
    const filas = arreglo(r.filas);
    if (filas.length !== 1) return fallar();
    const fila = capturar(filas[0], ['resultado']);
    if (typeof fila.resultado !== 'string') return fallar();
    return parsearProgreso(fila.resultado);
  }
  async function seguro<T>(accion: () => Promise<T>): Promise<T> {
    try { return await accion(); } catch { return fallar(); }
  }
  function literal(v: unknown, permitidos: readonly string[]): string {
    const r = capturar(v, ['tipo']);
    if (typeof r.tipo !== 'string' || !permitidos.includes(r.tipo)) return fallar();
    return r.tipo;
  }
  return Object.freeze({
    ...intentos,
    crear(r: RegistroSesion): Promise<void> {
      return seguro(async () => {
        const c = registro(r, viajeId, true);
        const m = { dispositivoId: c.dispositivoId,
          ...(Object.hasOwn(c, 'nombreDispositivo') ? { nombreDispositivo: c.nombreDispositivo } : {}) };
        const resultado = await llamar('SELECT itinerario.crear_sesion($1, $2, $3, $4, $5, $6, $7) AS resultado',
          [c.id, c.huella, viajeId, c.creadaEn, c.venceEn, c.revocada, serializarProgreso(m)]);
        literal(resultado, ['creada']);
      });
    },
    leer(huella: string): Promise<RegistroSesion | null> {
      return seguro(async () => {
        alcance(huella);
        const resultado = await llamar('SELECT itinerario.leer_sesion($1, $2) AS resultado', [huella, viajeId]);
        if (resultado === null) return null;
        const r = decodificar(resultado, viajeId);
        if (r.huella !== huella) return fallar();
        return r;
      });
    },
    revocar(huella: string, solicitado: string): Promise<void> {
      return seguro(async () => {
        alcance(huella, solicitado);
        literal(await llamar('SELECT itinerario.revocar_sesion($1, $2) AS resultado', [huella, viajeId]), ['revocada']);
      });
    },
    listar(huella: string, solicitado: string): Promise<unknown> {
      return seguro(async () => {
        alcance(huella, solicitado);
        const resultado = await llamar('SELECT itinerario.listar_sesiones($1, $2) AS resultado', [huella, viajeId]);
        const r = capturar(resultado, ['tipo'], ['sesiones']);
        if (r.tipo === 'sin-sesion' && !Object.hasOwn(r, 'sesiones')) return Object.freeze({ tipo: 'sin-sesion' });
        if (r.tipo !== 'lista' || !Object.hasOwn(r, 'sesiones')) return fallar();
        const sesiones = arreglo(r.sesiones).map((fila) => decodificar(fila, viajeId));
        const ids = new Set<string>(), huellas = new Set<string>();
        for (const s of sesiones) {
          if (ids.has(s.id) || huellas.has(s.huella)) return fallar();
          ids.add(s.id); huellas.add(s.huella);
        }
        // El actor debe estar en la lista completa; su identidad no puede aparecer dos veces.
        if (!sesiones.some((s) => s.huella === huella && !s.revocada)) return fallar();
        return Object.freeze({ tipo: 'lista', sesiones: Object.freeze(sesiones) });
      });
    },
    revocarOtra(huella: string, solicitado: string, objetivo: string): Promise<ResultadoRevocacion> {
      return seguro(async () => {
        alcance(huella, solicitado);
        if (typeof objetivo !== 'string' || !uuid.test(objetivo)) return fallar();
        return literal(await llamar('SELECT itinerario.revocar_otra_sesion($1, $2, $3) AS resultado',
          [huella, viajeId, objetivo.toLowerCase()]), ['revocada', 'ausente', 'sin-sesion']) as ResultadoRevocacion;
      });
    },
  });
}
