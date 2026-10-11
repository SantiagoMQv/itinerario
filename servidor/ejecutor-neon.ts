import { neon, types } from '@neondatabase/serverless';
import type { EjecutorSql, ResultadoSql } from './contratos';

const ERROR = 'No se pudo ejecutar la consulta.';
const PLAZO_MS = 10_000;
const fallar = (): never => { throw new Error(ERROR); };
const codificador = new TextEncoder();
function texto(v: unknown): v is string {
  return typeof v === 'string' && !v.includes('\0')
    && new TextDecoder('utf-8', { fatal: true }).decode(codificador.encode(v)) === v;
}
function propio(v: unknown, clave: string): unknown {
  if (v === null || typeof v !== 'object') return fallar();
  const d = Object.getOwnPropertyDescriptor(v, clave);
  if (!d || !Object.hasOwn(d, 'value')) return fallar();
  return d.value;
}
function plano(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object' && Object.getPrototypeOf(v) === Object.prototype;
}
function arreglo(v: unknown): unknown[] {
  if (!Array.isArray(v) || Object.getPrototypeOf(v) !== Array.prototype) return fallar();
  const longitud = propio(v, 'length');
  if (typeof longitud !== 'number' || !Number.isSafeInteger(longitud) || longitud < 0
    || Reflect.ownKeys(v).length !== longitud + 1) return fallar();
  const copia: unknown[] = [];
  for (let i = 0; i < longitud; i++) copia.push(propio(v, String(i)));
  return copia;
}
function parametrosSql(v: unknown): unknown[] {
  return arreglo(v).map((p) => {
    // Los repositorios ya serializaron sus metadatos/DTO como TEXT; no se recodifican.
    if (p === null || typeof p === 'boolean' || (typeof p === 'string' && texto(p))
      || (typeof p === 'number' && Number.isSafeInteger(p))) return p;
    return fallar();
  });
}
function conexion(configuracion: unknown): string {
  if (!plano(configuracion) || Reflect.ownKeys(configuracion).length !== 1) return fallar();
  const valor = propio(configuracion, 'urlBaseDatos');
  if (!texto(valor) || !valor || /\s/.test(valor) || !texto(decodeURIComponent(valor))) return fallar();
  const url = new URL(valor);
  if (!['postgres:', 'postgresql:'].includes(url.protocol) || !url.hostname || url.hostname === '-'
    || !decodeURIComponent(url.username) || !decodeURIComponent(url.password)
    || !decodeURIComponent(url.pathname.slice(1)) || url.hash) return fallar();
  return valor;
}
function resultadoSql(v: unknown): ResultadoSql {
  // El SDK añade _types/_parsers y metadatos; no se serializa ni exige un DTO de dominio.
  if (!plano(v) || propio(v, 'rowAsArray') !== false || propio(v, 'viaNeonFetch') !== true
    || typeof propio(v, 'command') !== 'string' || !propio(v, 'command')) return fallar();
  const columnas = arreglo(propio(v, 'fields')).map((campo) => {
    if (!plano(campo)) return fallar();
    const nombre = propio(campo, 'name');
    const tipo = propio(campo, 'dataTypeID');
    if (!texto(nombre) || !nombre || typeof tipo !== 'number' || !Number.isSafeInteger(tipo) || tipo <= 0) return fallar();
    if (propio(campo, 'format') !== 'text') return fallar();
    return { nombre, tipo };
  });
  if (new Set(columnas.map((c) => c.nombre)).size !== columnas.length) return fallar();
  const filas = arreglo(propio(v, 'rows'));
  if (propio(v, 'rowCount') !== filas.length) return fallar();
  for (const fila of filas) {
    if (!plano(fila) || Reflect.ownKeys(fila).length !== columnas.length) return fallar();
    for (const { nombre, tipo } of columnas) {
      const valor = propio(fila, nombre);
      // TEXT del dominio debe seguir siendo texto incluso ante un HTTP malformado.
      if (valor === undefined || (tipo === 25 && valor !== null && typeof valor !== 'string')) return fallar();
    }
  }
  return Object.freeze({ filas: Object.freeze(filas) });
}

/** HTTP oficial, una consulta parametrizada por llamada, sin conexiones TCP ni reintentos.
 * Recibe solo configuración privada y SQL fijo de repositorios, nunca entrada del navegador.
 * Un timeout es resultado incierto: el statement pudo comprometerse antes del aborto.
 */
export function crearEjecutorNeon(configuracion: { readonly urlBaseDatos: string }): EjecutorSql {
  try {
    const cliente = neon(conexion(configuracion));
    return Object.freeze({
      async ejecutar(consulta: string, parametros: readonly unknown[]): Promise<ResultadoSql> {
        let temporizador: ReturnType<typeof setTimeout> | undefined;
        try {
          if (!texto(consulta) || !consulta) return fallar();
          const valores = parametrosSql(parametros);
          const controlador = new AbortController();
          const vencimiento = new Promise<never>((_, rechazar) => {
            temporizador = setTimeout(() => {
              rechazar(new Error(ERROR));
              controlador.abort();
            }, PLAZO_MS);
          });
          const respuesta = await Promise.race([
            cliente.query(consulta, valores, { fullResults: true, arrayMode: false,
              // El protocolo raw-text exige cadenas: impedir coerciones del parser por defecto.
              // Parsers locales a esta consulta, sin modificar el registro global del SDK.
              types: { getTypeParser(id, formato) {
                const parsear = types.getTypeParser(id, formato);
                return (valor: unknown) => {
                  if (typeof valor !== 'string') return fallar();
                  return parsear(valor);
                };
              } },
              fetchOptions: { signal: controlador.signal } }),
            vencimiento,
          ]);
          return resultadoSql(respuesta);
        } catch { return fallar(); }
        finally { if (temporizador !== undefined) clearTimeout(temporizador); }
      },
    });
  } catch { return fallar(); }
}
