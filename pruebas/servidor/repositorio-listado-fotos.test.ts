import { readFile } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import type { Itinerario } from '../../src/tipos';
import { crearProgreso } from '../../src/progreso';
import { serializarProgreso } from '../../src/progreso-json';
import { crearRepositorioListadoFotosSql, calcularCotasListadoFotos, copiarPresupuestoListadoFotos,
  type ResultadoListadoFotos } from '../../servidor/repositorio-listado-fotos';
import { deserializarSolicitudRespaldo, serializarSolicitudRespaldo, serializarReciboRespaldo } from '../../src/fotos-protocolo';
import { deserializarPaginaListadoFotos, deserializarCursorListadoFotos } from '../../src/fotos-listado-protocolo';
import { clavePrivadaFotos } from '../../servidor/almacen-fotos';
import { crearRepositorioFotosSql } from '../../servidor/repositorio-fotos';
import { crearEjecutorNeon } from '../../servidor/ejecutor-neon';
import type { EjecutorSql } from '../../servidor/contratos';
const plan: Itinerario = { id: 'viaje', titulo: 'Prueba', dias: [{ fecha: '2026-10-21', titulo: 'Día',
  paradas: [{ id: 'a', nombre: 'A', hora: '10:00', categoria: 'museo', lat: 31, lng: 121 }] }] };
const actor = 'a'.repeat(64);
const presupuesto = { maxFilas: 1, maxOperacionesPorFoto: 64, maxBytesSql: 5242880,
  maxBytesRespuesta: 524288, maxBytesRetenidos: 67108864, plazoMs: 1000 };
let db: PGlite;
const SQL = 'SELECT itinerario.listar_fotos_confirmadas($1, $2, $3, $4, $5, $6, $7) AS resultado';
const ERROR = 'No se pudo comprobar el listado de fotos.';
const id = (n: number) => n.toString(16).padStart(8, '0') + '-1234-4234-8234-123456789012';
let contador = 100;
const signal = () => new AbortController().signal;
const presupuesto8 = { maxFilas: 8, maxOperacionesPorFoto: 64, maxBytesSql: 25165824,
  maxBytesRespuesta: 4194304, maxBytesRetenidos: 268435456, plazoMs: 1000 };
// Los plazos más grandes se declaran para fixtures con SQL/metadata pesada, NO defaults.
const pesado = { ...presupuesto, plazoMs: 10000 };
function cuerpo(fotoId: string, operacionId: string, nombre = 'e\u0301\0"original":}\\.jpg', p = plan) {
  return serializarSolicitudRespaldo(p, { version: 1, tipo: 'solicitud-respaldo', viajeId: p.id,
    fotoId, operacionId, original: { formato: 1, fotoId, destino: { tipo: 'parada', viajeId: p.id, paradaId: 'a' },
      nombre, mimeDeclarado: 'IMAGE/HEIC\0;☃', ultimaModificacion: -0, incorporada: -0, bytesOriginal: -0 } });
}
function acuse(texto: string, p = plan) {
  return serializarReciboRespaldo(p, { ...deserializarSolicitudRespaldo(p, texto), tipo: 'acuse-respaldo',
    objetoOriginalDurable: true, metadatosDurables: true });
}
async function sembrar(fotoId: string, confirmada = true, nombre?: string, p = plan) {
  const operacionId = id(++contador); const reservaId = id(++contador);
  const texto = cuerpo(fotoId, operacionId, nombre, p);
  const clave = clavePrivadaFotos(p.id, fotoId, reservaId);
  await db.query('INSERT INTO itinerario.fotos_reservas VALUES ($1,$2,$3,$4,$5)', [p.id, fotoId, reservaId, clave, texto]);
  await db.query('INSERT INTO itinerario.fotos_operaciones VALUES ($1,$2,$3,$4,$5,$6)',
    [p.id, operacionId, fotoId, reservaId, texto, confirmada ? acuse(texto, p) : null]);
  return { fotoId, operacionId, reservaId, texto, clave };
}
async function asociar(r: Awaited<ReturnType<typeof sembrar>>, confirmada = false) {
  const operacionId = id(++contador);
  const texto = r.texto.replace(r.operacionId, operacionId);
  await db.query('INSERT INTO itinerario.fotos_operaciones VALUES ($1,$2,$3,$4,$5,$6)',
    [plan.id, operacionId, r.fotoId, r.reservaId, texto, confirmada ? acuse(texto) : null]);
  return { operacionId, texto };
}
const ejecutorLocal: EjecutorSql = { async ejecutar(q, p) {
  expect(q).toBe(SQL); expect(p).toHaveLength(7); expect(Object.isFrozen(p)).toBe(true);
  return { filas: (await db.query(q, [...p])).rows };
} };
function repo(p = presupuesto, ejecutor = ejecutorLocal, itinerario = plan) {
  return crearRepositorioListadoFotosSql({ plan: itinerario, presupuesto: p, ejecutor });
}
function pagina(r: ResultadoListadoFotos) {
  expect(r.tipo).toBe('pagina');
  if (r.tipo !== 'pagina') throw new Error('Fixture sin página');
  expect(Object.isFrozen(r)).toBe(true); expect(Object.isFrozen(r.pagina)).toBe(true);
  expect(Object.isFrozen(r.pagina.solicitudesIniciales)).toBe(true);
  expect(deserializarPaginaListadoFotos(plan, r.textoCanonico, 8, 4194304)).toEqual(r.pagina);
  return r.pagina;
}
async function snapshot() {
  const tablas = ['viajes', 'sesiones', 'decisiones', 'intentos_sesion', 'fotos_reservas', 'fotos_operaciones'];
  const resultado: unknown[] = [];
  for (const tabla of tablas) {
    const filas = (await db.query('SELECT * FROM itinerario.' + tabla)).rows;
    resultado.push([tabla, filas.map((f) => JSON.stringify(f)).sort()]);
  }
  return resultado;
}
async function listarConservado(r = repo(), huella = actor, viaje = plan.id, cursor: string | null = null) {
  const antes = await snapshot(); const resultado = await r.listar(huella, viaje, cursor, signal());
  expect(await snapshot()).toEqual(antes); return resultado;
}
async function falloConservado(r = repo(), cursor: string | null = null) {
  const antes = await snapshot(); await db.exec('SAVEPOINT listado');
  let error: unknown;
  try { await r.listar(actor, plan.id, cursor, signal()); } catch (e) { error = e; }
  await db.exec('ROLLBACK TO SAVEPOINT listado; RELEASE SAVEPOINT listado');
  expect(error).toBeInstanceOf(Error); expect((error as Error).message).toBe(ERROR);
  expect(Object.hasOwn(error as object, 'stack')).toBe(false); expect(Object.hasOwn(error as object, 'cause')).toBe(false);
  expect(await snapshot()).toEqual(antes);
}
async function instrumentarConsultas() {
  await db.exec('CREATE TEMP SEQUENCE llamadas_consulta START 1');
  const sql = await readFile(new URL('../../servidor/migraciones/005_fotos.sql', import.meta.url), 'utf8');
  const inicio = sql.indexOf('CREATE OR REPLACE FUNCTION itinerario.consultar_foto(');
  expect(inicio).toBeGreaterThan(0);
  await db.exec(sql.slice(inicio).replace('BEGIN\n', "BEGIN\n  PERFORM nextval('pg_temp.llamadas_consulta');\n"));
}
async function llamadasConsulta() {
  const r = (await db.query<{ last_value: number; is_called: boolean }>('SELECT last_value,is_called FROM pg_temp.llamadas_consulta')).rows[0];
  return r.is_called ? Number(r.last_value) : 0;
}
function barrera() {
  let liberar!: () => void;
  const promesa = new Promise<void>((r) => { liberar = r; });
  return { promesa, liberar };
}
describe('Listado SQL local de una conexión', () => {
  beforeAll(async () => {
    db = await PGlite.create('memory://');
    for (const nombre of ['001_base.sql', '002_progreso.sql', '003_sesiones.sql', '004_limite.sql', '005_fotos.sql', '006_listado_fotos.sql']) {
      await db.exec(await readFile(new URL('../../servidor/migraciones/' + nombre, import.meta.url), 'utf8'));
    }
    await db.query('INSERT INTO itinerario.viajes VALUES ($1,0,$2)', [plan.id, serializarProgreso(crearProgreso(plan))]);
    await db.query('INSERT INTO itinerario.sesiones VALUES ($1,$2,$3,0,9007199254740991,false,$4)',
      ['12345678-1234-4234-8234-123456789012', actor, plan.id, '{}']);
    // Datos previos ajenos no vacíos: TODOS los casos SQL comparan las seis tablas
    // completas (incluido estado_json, metadata, historia y operaciones/recibos).
    const ajeno = { ...plan, id: 'previo' };
    await db.query('INSERT INTO itinerario.viajes VALUES ($1,9,$2)', [ajeno.id, serializarProgreso(crearProgreso(ajeno))]);
    await db.query('INSERT INTO itinerario.sesiones VALUES ($1,$2,$3,0,9007199254740991,false,$4)', [id(++contador), 'e'.repeat(64), ajeno.id, '{"dispositivo":"previo"}']);
    await db.query('INSERT INTO itinerario.decisiones VALUES ($1,$2,$3,$4,$5)', [ajeno.id, 'previa', 'positiva', 1, '{}']);
    await db.query('INSERT INTO itinerario.intentos_sesion VALUES ($1,0,4)', ['f'.repeat(64)]);
    await sembrar(id(80), true, 'previa', ajeno);
  }, 30000);
  beforeEach(async () => { await db.exec('BEGIN'); });
  afterEach(async () => { vi.useRealTimers(); vi.unstubAllGlobals(); await db.exec('ROLLBACK'); });
  afterAll(async () => { await db?.close(); });
  it('admite cotas exactas N1 y cuenta candidatas, preflight y pruebas', () => {
    expect(calcularCotasListadoFotos(1, 64)).toEqual({ candidatas: 2, operacionesPreflight: 130,
      pruebas: 2, bytesSql: 4762546, bytesRespuesta: 404231, bytesRetenidos: 48940554 });
  });
  it('sesión viva sin fotos recibe página vacía sin cursor', async () => {
    const repo = crearRepositorioListadoFotosSql({ plan, presupuesto, ejecutor: { async ejecutar(q, p) {
      return { filas: (await db.query(q, [...p])).rows };
    } } });
    const pagina = { version: 1, tipo: 'listado-respaldos', viajeId: plan.id, solicitudesIniciales: [], continuacion: null };
    expect(await repo.listar(actor, plan.id, null, new AbortController().signal))
      .toEqual({ tipo: 'pagina', pagina, textoCanonico: JSON.stringify(pagina) });
  });
  it('N8/K64 usa aritmética y preflight finitos, no fitness de heap productivo', () => {
    expect(calcularCotasListadoFotos(8, 64)).toEqual({ candidatas: 9, operacionesPreflight: 585,
      pruebas: 9, bytesSql: 21417121, bytesRespuesta: 3156764, bytesRetenidos: 224474136 });
  });
  it('SQL y codec publican INITIAL raw, no recibo/reserva/objeto ni ACK', async () => {
    const r = await sembrar('ABCDEF12-1234-4234-8234-123456789012');
    const p = pagina(await listarConservado());
    expect(p.solicitudesIniciales).toEqual([r.texto]); expect(p.continuacion).toBeNull();
    const s = deserializarSolicitudRespaldo(plan, p.solicitudesIniciales[0]);
    expect(s.original.nombre).toBe('e\u0301\0"original":}\\.jpg');
    expect(s.original.mimeDeclarado).toBe('IMAGE/HEIC\0;☃');
    for (const n of [s.original.ultimaModificacion, s.original.incorporada, s.original.bytesOriginal]) expect(Object.is(n, -0)).toBe(true);
    expect(Object.keys(p)).toEqual(['version', 'tipo', 'viajeId', 'solicitudesIniciales', 'continuacion']);
    expect(JSON.stringify(p)).not.toContain(r.clave); expect(JSON.stringify(p)).not.toContain('metadatosDurables');
  });
  it('INITIAL con surrogate escapado, NUL y marcadores no se navega en SQL', async () => {
    const r = await sembrar(id(1), true, '\uD800\0[]{}"original":}');
    expect(pagina(await listarConservado()).solicitudesIniciales).toEqual([r.texto]);
  });
  it('clave privada legítima extrema466 y viaje128bytes funcionan sin normalizar', async () => {
    const p = { ...plan, id: '\u0001'.repeat(128) }; const huella = 'c'.repeat(64);
    await db.query('INSERT INTO itinerario.viajes VALUES ($1,0,$2)', [p.id, serializarProgreso(crearProgreso(p))]);
    await db.query('INSERT INTO itinerario.sesiones VALUES ($1,$2,$3,0,9007199254740991,false,$4)', [id(++contador), huella, p.id, '{}']);
    const r = await sembrar(id(1), true, 'extrema', p); expect(new TextEncoder().encode(r.clave).length).toBe(466);
    const antes = await snapshot(); const resultado = await repo(pesado, ejecutorLocal, p).listar(huella, p.id, null, signal());
    expect(resultado.tipo).toBe('pagina');
    if (resultado.tipo === 'pagina') expect(resultado.pagina.solicitudesIniciales).toEqual([r.texto]);
    expect(await snapshot()).toEqual(antes);
  });
  it('retry y operación compatible de SQL005 conservan INITIAL y recibos previos', async () => {
    const r = await sembrar(id(1));
    const antiguo = crearRepositorioFotosSql({ plan, ejecutor: { async ejecutar(q, p) {
      return { filas: (await db.query(q, [...p])).rows };
    } } });
    expect(await antiguo.reservar(actor, plan.id, r.texto)).toMatchObject({ tipo: 'existente' });
    const otra = r.texto.replace(r.operacionId, id(++contador));
    const reserva = { reservaId: r.reservaId, claveObjeto: r.clave, solicitudCanonica: r.texto };
    expect(await antiguo.finalizar(actor, plan.id, reserva, otra)).toEqual({ tipo: 'confirmada', reciboCanonico: acuse(otra) });
    expect(await antiguo.finalizar(actor, plan.id, reserva, otra)).toEqual({ tipo: 'confirmada', reciboCanonico: acuse(otra) });
    expect(pagina(await listarConservado()).solicitudesIniciales).toEqual([r.texto]);
  });
  it('no confirmadas con INITIAL 65536 se omiten; la página permanece vacía', async () => {
    const base = cuerpo(id(1), id(101), '');
    const nombre = 'x'.repeat(65536 - new TextEncoder().encode(base).length);
    const r = await sembrar(id(1), false, nombre);
    expect(new TextEncoder().encode(r.texto).length).toBe(65536);
    expect(pagina(await listarConservado(repo(pesado))).solicitudesIniciales).toEqual([]);
  });
  it('INITIAL 65486 y ACK 65536 reales se confirman por SQL005 y se listan', async () => {
    const base = cuerpo(id(1), id(101), '');
    const r = await sembrar(id(1), false, 'x'.repeat(65486 - new TextEncoder().encode(base).length));
    const antiguo = crearRepositorioFotosSql({ plan, ejecutor: { async ejecutar(q, p) { return { filas: (await db.query(q, [...p])).rows }; } } });
    expect(new TextEncoder().encode(r.texto).length).toBe(65486);
    expect(new TextEncoder().encode(acuse(r.texto)).length).toBe(65536);
    expect(await antiguo.finalizar(actor, plan.id, { reservaId: r.reservaId, claveObjeto: r.clave, solicitudCanonica: r.texto }, r.texto))
      .toEqual({ tipo: 'confirmada', reciboCanonico: acuse(r.texto) });
    expect(pagina(await listarConservado(repo(pesado))).solicitudesIniciales).toEqual([r.texto]);
  });
  it('INITIAL 65536 falsamente marcado con recibo pequeño falla el fullframe005', async () => {
    const base = cuerpo(id(1), id(101), '');
    const r = await sembrar(id(1), false, 'x'.repeat(65536 - new TextEncoder().encode(base).length));
    await db.query('UPDATE itinerario.fotos_operaciones SET recibo_canonico=$1 WHERE operacion_id=$2', ['{}', r.operacionId]);
    await falloConservado(repo(pesado));
  });
  it('N1 prueba N+1 completo; keyset C conserva upper y casing sin snapshot', async () => {
    const ids = ['ABCDEF12-1234-4234-8234-123456789012', 'abcdef12-1234-4234-8234-123456789012'];
    const a = await sembrar(ids[0]); const b = await sembrar(ids[1]); await instrumentarConsultas();
    const primera = pagina(await listarConservado()); expect(primera.solicitudesIniciales).toEqual([a.texto]);
    expect(await llamadasConsulta()).toBe(2);
    expect(deserializarCursorListadoFotos(plan, primera.continuacion)).toEqual({ version: 1, viajeId: plan.id, despuesDe: ids[0], hasta: ids[1] });
    const segunda = pagina(await listarConservado(repo(), actor, plan.id, primera.continuacion));
    expect(segunda.solicitudesIniciales).toEqual([b.texto]); expect(segunda.continuacion).toBeNull();
    expect(await llamadasConsulta()).toBe(3);
  });
  it('N8 publica ocho y prueba la novena; todos los INITIAL permanecen en C', async () => {
    const textos: string[] = [];
    for (let i = 1; i <= 9; i++) textos.push((await sembrar(id(i))).texto);
    await instrumentarConsultas();
    const primera = pagina(await listarConservado(repo(presupuesto8)));
    expect(primera.solicitudesIniciales).toEqual(textos.slice(0, 8)); expect(await llamadasConsulta()).toBe(9);
    const segunda = pagina(await listarConservado(repo(presupuesto8), actor, plan.id, primera.continuacion));
    expect(segunda.solicitudesIniciales).toEqual(textos.slice(8)); expect(segunda.continuacion).toBeNull();
  });
  it('N8/K64 valida nueve candidatas con64 operaciones cada una antes de publicar ocho', async () => {
    const textos: string[] = [];
    for (let i = 1; i <= 9; i++) {
      const r = await sembrar(id(i)); textos.push(r.texto);
      for (let op = 1; op < 64; op++) await asociar(r, op % 2 === 0);
    }
    await instrumentarConsultas();
    const p = pagina(await listarConservado(repo({ ...presupuesto8, plazoMs: 10000 })));
    expect(p.solicitudesIniciales).toEqual(textos.slice(0, 8)); expect(await llamadasConsulta()).toBe(9);
  });
  it('N8 publica INITIAL confirmables65486 sin exceder S/P, sin certificar heap físico', async () => {
    const base = cuerpo(id(1), id(101), ''); const textos: string[] = [];
    for (let i = 1; i <= 9; i++) textos.push((await sembrar(id(i), true, 'x'.repeat(65486 - new TextEncoder().encode(base).length))).texto);
    const ejecutar = vi.fn(async (q: string, parametros: readonly unknown[]) => {
      const resultado = await db.query<{ resultado: string }>(q, [...parametros]);
      expect(new TextEncoder().encode(resultado.rows[0].resultado).length).toBeLessThanOrEqual(21417121);
      return { filas: resultado.rows };
    });
    const resultado = await listarConservado(repo({ ...presupuesto8, plazoMs: 10000 }, { ejecutar }));
    expect(pagina(resultado).solicitudesIniciales).toEqual(textos.slice(0, 8));
    if (resultado.tipo === 'pagina') expect(new TextEncoder().encode(resultado.textoCanonico).length).toBeLessThanOrEqual(3156764);
    expect(ejecutar).toHaveBeenCalledTimes(1);
  });
  it('confirmación nueva inferior se pierde hasta reinicio manual, superior no cruza hasta', async () => {
    await sembrar(id(2)); const tres = await sembrar(id(3));
    const primera = pagina(await listarConservado());
    const uno = await sembrar(id(1)); await sembrar(id(4));
    const segunda = pagina(await listarConservado(repo(), actor, plan.id, primera.continuacion));
    expect(segunda.solicitudesIniciales).toEqual([tres.texto]); expect(segunda.continuacion).toBeNull();
    expect(pagina(await listarConservado()).solicitudesIniciales).toEqual([uno.texto]);
  });
  it('cursor válido con rango ahora vacío conserva hasta y termina sin continuación', async () => {
    await sembrar(id(1));
    const c = JSON.stringify({ version: 1, viajeId: plan.id, despuesDe: id(2), hasta: id(3) });
    expect(pagina(await listarConservado(repo(), actor, plan.id, c)).solicitudesIniciales).toEqual([]);
  });
  it('dos actores iguales del viaje ven las mismas fotos, no dueño/dispositivo', async () => {
    await db.query('INSERT INTO itinerario.sesiones VALUES ($1,$2,$3,0,9007199254740991,false,$4)', [id(++contador), 'b'.repeat(64), plan.id, '{"dispositivo":"otro"}']);
    await sembrar(id(1));
    expect(await listarConservado(repo(), 'b'.repeat(64))).toEqual(await listarConservado());
  });
  it('otro viaje y su sesión no descubren fotos del primero; los seis snapshots incluyen datos ajenos', async () => {
    const otro = { ...plan, id: 'otro' };
    await db.query('INSERT INTO itinerario.viajes VALUES ($1,7,$2)', [otro.id, serializarProgreso(crearProgreso(otro))]);
    await db.query('INSERT INTO itinerario.sesiones VALUES ($1,$2,$3,0,9007199254740991,false,$4)', [id(++contador), 'b'.repeat(64), otro.id, '{}']);
    await db.query('INSERT INTO itinerario.decisiones VALUES ($1,$2,$3,$4,$5)', [plan.id, 'historia', 'positiva', 1, '{}']);
    await db.query('INSERT INTO itinerario.intentos_sesion VALUES ($1,0,3)', ['c'.repeat(64)]);
    await sembrar(id(1)); await sembrar(id(2), true, 'ajena', otro);
    const antes = await snapshot();
    const resultado = await repo(presupuesto, ejecutorLocal, otro).listar('b'.repeat(64), otro.id, null, signal());
    expect(resultado.tipo).toBe('pagina');
    if (resultado.tipo === 'pagina') expect(deserializarSolicitudRespaldo(otro, resultado.pagina.solicitudesIniciales[0]).viajeId).toBe('otro');
    expect(await snapshot()).toEqual(antes);
    expect(await listarConservado(repo(), 'b'.repeat(64))).toEqual({ tipo: 'sin-sesion' });
    expect(await listarConservado(repo(), 'd'.repeat(64))).toEqual({ tipo: 'sin-sesion' });
  });
  it.each(['revocada=true', 'vence_en=1'])('sesión %s no publica nada y conserva filas', async (cambio) => {
    await sembrar(id(1)); await db.exec('UPDATE itinerario.sesiones SET ' + cambio);
    expect(await listarConservado()).toEqual({ tipo: 'sin-sesion' });
  });
  it('reaplicar006 preserva filas, columnas y todas las funciones001–005', async () => {
    await sembrar(id(1));
    const funciones = async () => (await db.query(`SELECT p.proname,pg_get_functiondef(p.oid) AS definicion
      FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='itinerario'
      AND p.proname<>'listar_fotos_confirmadas' ORDER BY p.proname`)).rows;
    const antes = await snapshot(); const f = await funciones();
    await db.exec(await readFile(new URL('../../servidor/migraciones/006_listado_fotos.sql', import.meta.url), 'utf8'));
    expect(await snapshot()).toEqual(antes); expect(await funciones()).toEqual(f);
    expect(pagina(await listarConservado()).solicitudesIniciales).toHaveLength(1);
  });
  it('K64 todas las operaciones incluidas NULL y compatibles confirmadas pasan', async () => {
    const r = await sembrar(id(1));
    for (let i = 1; i < 64; i++) await asociar(r, i % 2 === 0);
    await instrumentarConsultas();
    expect(pagina(await listarConservado(repo(pesado))).solicitudesIniciales).toEqual([r.texto]);
    expect(await llamadasConsulta()).toBe(1);
  });
  it.each(['primera-ops', 'lookahead-ops', 'primera-clave', 'lookahead-clave'])('preflight ALL antes de ANY consultar_foto: %s', async (caso) => {
    const a = await sembrar(id(1)); const b = await sembrar(id(2));
    const r = caso.startsWith('primera') ? a : b;
    if (caso.endsWith('ops')) for (let i = 1; i < 65; i++) await asociar(r); // 64 NULL + 1 confirmada.
    else await db.query('UPDATE itinerario.fotos_reservas SET clave_objeto=$1 WHERE foto_id=$2', ['x'.repeat(467), r.fotoId]);
    await instrumentarConsultas(); await falloConservado(repo(pesado)); expect(await llamadasConsulta()).toBe(0);
  });
  it.each(['{}', 'false', 'request', 'objeto-falso', 'metadata-falsa', 'otra-op', 'trailer', 'bracket', 'otro-original'])('005 fullreceipt %s falla cerrado y no repara', async (caso) => {
    const r = await sembrar(id(1)); let texto = acuse(r.texto);
    if (caso === '{}' || caso === 'false') texto = caso;
    if (caso === 'request') texto = r.texto;
    if (caso === 'objeto-falso') texto = texto.replace('"objetoOriginalDurable":true', '"objetoOriginalDurable":false');
    if (caso === 'metadata-falsa') texto = texto.replace('"metadatosDurables":true', '"metadatosDurables":false');
    if (caso === 'otra-op') texto = texto.replace(r.operacionId, id(++contador));
    if (caso === 'trailer') texto += 'false';
    if (caso === 'bracket') texto = texto.slice(0, -1) + ']';
    if (caso === 'otro-original') texto = texto.replace('é', 'é');
    await db.query('UPDATE itinerario.fotos_operaciones SET recibo_canonico=$1 WHERE operacion_id=$2', [texto, r.operacionId]);
    await falloConservado();
  });
  it.each(['ausente', 'doble', 'encuadre'])('asociación INITIAL %s falla sin adoptar nueva operación', async (caso) => {
    const r = await sembrar(id(1));
    if (caso === 'ausente') await db.query('UPDATE itinerario.fotos_operaciones SET solicitud_canonica=$1 WHERE operacion_id=$2', [r.texto.replace('é', 'é'), r.operacionId]);
    if (caso === 'doble') await db.query('INSERT INTO itinerario.fotos_operaciones VALUES ($1,$2,$3,$4,$5,NULL)', [plan.id, id(++contador), r.fotoId, r.reservaId, r.texto]);
    if (caso === 'encuadre') await db.query('UPDATE itinerario.fotos_reservas SET solicitud_canonica=$1 WHERE foto_id=$2', [r.texto + 'false', r.fotoId]);
    await falloConservado();
  });
  it('operación confirmada con solicitud incompatible falla aunque INITIAL sea válido', async () => {
    const r = await sembrar(id(1)); const otra = await asociar(r, true);
    await db.query('UPDATE itinerario.fotos_operaciones SET solicitud_canonica=$1 WHERE operacion_id=$2', [otra.texto.replace('IMAGE/HEIC', 'image/heic'), otra.operacionId]);
    await falloConservado();
  });
  it.each(['primera', 'lookahead'])('clave corta incorrecta %s supera SQL pero JS rechaza toda la página', async (posicion) => {
    await sembrar(id(1)); await sembrar(id(2));
    await db.query('UPDATE itinerario.fotos_reservas SET clave_objeto=$1 WHERE foto_id=$2', ['clave-corta-incorrecta', id(posicion === 'primera' ? 1 : 2)]);
    await instrumentarConsultas(); await falloConservado(); expect(await llamadasConsulta()).toBe(2);
  });
  it('corrupción del recibo lookahead no se salta ni avanza cursor', async () => {
    await sembrar(id(1)); const r = await sembrar(id(2));
    await db.query('UPDATE itinerario.fotos_operaciones SET recibo_canonico=$1 WHERE operacion_id=$2', ['{}', r.operacionId]);
    await falloConservado();
  });
  it('reloj fresco tras espera modelada impide publicar una sesión que venció', async () => {
    await sembrar(id(1));
    await db.exec(`CREATE OR REPLACE FUNCTION itinerario.fotos_sesion_vigente(p_huella TEXT,p_viaje TEXT)
      RETURNS BOOLEAN LANGUAGE plpgsql VOLATILE AS $$ BEGIN PERFORM pg_sleep(0.03);
      RETURN EXISTS(SELECT 1 FROM itinerario.sesiones WHERE huella=p_huella AND viaje_id=p_viaje AND NOT revocada
        AND vence_en>floor(extract(epoch FROM clock_timestamp())*1000)::bigint); END $$;`);
    await db.exec('UPDATE itinerario.sesiones SET vence_en=floor(extract(epoch FROM clock_timestamp())*1000)::bigint+10');
    expect(await listarConservado(repo(pesado))).toEqual({ tipo: 'sin-sesion' });
  });
  it.each([2, 8])('vigencia falsa en comprobación posterior #%s cancela toda la página', async (umbral) => {
    await sembrar(id(1)); await sembrar(id(2));
    await db.exec(`CREATE TEMP SEQUENCE llamadas_reloj START 1;
      CREATE OR REPLACE FUNCTION itinerario.fotos_sesion_vigente(p_huella TEXT,p_viaje TEXT)
      RETURNS BOOLEAN LANGUAGE plpgsql VOLATILE AS $$ BEGIN
      RETURN nextval('pg_temp.llamadas_reloj')<=${umbral} AND EXISTS(SELECT 1 FROM itinerario.sesiones
        WHERE huella=p_huella AND viaje_id=p_viaje AND NOT revocada
        AND vence_en>floor(extract(epoch FROM clock_timestamp())*1000)::bigint); END $$;`);
    // umbral2: consultar devuelve sin-sesion; umbral8: sólo el último guard006,
    // DESPUÉS de construir y medir dos pruebas completas, cancela la página.
    expect(await listarConservado()).toEqual({ tipo: 'sin-sesion' });
    expect(Number((await db.query<{ last_value: number }>('SELECT last_value FROM pg_temp.llamadas_reloj')).rows[0].last_value)).toBe(umbral + 1);
  });
  it('SDK real con fetch 100% local: SELECT exacta siete parámetros, una llamada y cero IO en fábrica', async () => {
    const r = await sembrar('ABCDEF12-1234-4234-8234-123456789012');
    const llamadas: { query: string; params: string[] }[] = [];
    const fetchLocal = vi.fn(async (destino: unknown, opciones: RequestInit) => {
      // Cualquier tráfico inesperado se rechaza ANTES de ejecutar SQL local.
      expect(String(destino)).toBe('https://api.eu-central-1.aws.neon.tech/sql');
      const entrada = JSON.parse(String(opciones.body)) as { query: string; params: string[] };
      expect(entrada.query).toBe(SQL); expect(entrada.params).toHaveLength(7); llamadas.push(entrada);
      const resultado = await db.query<{ resultado: string }>(entrada.query, entrada.params);
      return new Response(JSON.stringify({ command: 'SELECT', rowCount: resultado.rows.length,
        fields: [{ name: 'resultado', dataTypeID: 25, tableID: 0, columnID: 0, dataTypeSize: -1, dataTypeModifier: -1, format: 'text' }],
        rows: resultado.rows.map((f) => [f.resultado]) }));
    });
    vi.stubGlobal('fetch', fetchLocal);
    const ejecutor = crearEjecutorNeon({ urlBaseDatos: 'postgresql://prueba:clave-sintetica@ep-prueba.eu-central-1.aws.neon.tech/prueba?sslmode=require' });
    const ejecutar = vi.fn(ejecutor.ejecutar); const listado = repo(pesado, { ejecutar });
    expect(fetchLocal).not.toHaveBeenCalled(); expect(ejecutar).not.toHaveBeenCalled();
    expect(pagina(await listarConservado(listado)).solicitudesIniciales).toEqual([r.texto]);
    expect(ejecutar).toHaveBeenCalledTimes(1); expect(fetchLocal).toHaveBeenCalledTimes(1);
    expect(Object.isFrozen(ejecutar.mock.calls[0][1])).toBe(true);
    expect(llamadas[0].params).toEqual([actor, plan.id, null, null, '1', '64', '4762546']);
  });
  it('SDK SQL real pendiente captura inputs y sólo publica después de entrega, no prueba COMMIT físico', async () => {
    const r = await sembrar(id(1)); const entrada = barrera(); const entrega = barrera();
    const fetchLocal = vi.fn(async (destino: unknown, opciones: RequestInit) => {
      expect(String(destino)).toBe('https://api.eu-central-1.aws.neon.tech/sql');
      const datos = JSON.parse(String(opciones.body)) as { query: string; params: string[] };
      expect(datos.query).toBe(SQL); expect(datos.params).toHaveLength(7);
      const sql = await db.query<{ resultado: string }>(datos.query, datos.params);
      entrada.liberar(); await entrega.promesa;
      return new Response(JSON.stringify({ command: 'SELECT', rowCount: sql.rows.length,
        fields: [{ name: 'resultado', dataTypeID: 25, tableID: 0, columnID: 0, dataTypeSize: -1, dataTypeModifier: -1, format: 'text' }],
        rows: sql.rows.map((f) => [f.resultado]) }));
    });
    vi.stubGlobal('fetch', fetchLocal);
    const p = { ...pesado }; const copiaPlan = structuredClone(plan);
    const puerto = crearEjecutorNeon({ urlBaseDatos: 'postgresql://prueba:clave-sintetica@ep-prueba.eu-central-1.aws.neon.tech/prueba?sslmode=require' });
    const mutable = { ejecutar: puerto.ejecutar }; const listado = repo(p, mutable, copiaPlan);
    let publicada = false;
    const antes = await snapshot();
    const pendiente = listado.listar(actor, plan.id, null, signal()).then((v) => { publicada = true; return v; });
    await entrada.promesa; expect(publicada).toBe(false);
    p.maxFilas = 8; p.maxBytesSql = 1; Object.defineProperty(copiaPlan, 'id', { value: 'mutado' });
    mutable.ejecutar = vi.fn(async () => { throw new Error('Puerto cambiado'); });
    entrega.liberar(); expect(pagina(await pendiente).solicitudesIniciales).toEqual([r.texto]);
    expect(pagina(await listado.listar(actor, plan.id, null, signal())).solicitudesIniciales).toEqual([r.texto]);
    expect(mutable.ejecutar).not.toHaveBeenCalled(); expect(fetchLocal).toHaveBeenCalledTimes(2);
    expect(await snapshot()).toEqual(antes);
    expect(() => repo(p, mutable, copiaPlan)).toThrow(ERROR); // Fábrica nueva sí ve config nueva.
  });
  it('revocación posterior a RETURN SQL no es reauth E1; siguiente página sí ve sesión revocada', async () => {
    await sembrar(id(1)); const entrada = barrera(); const entrega = barrera();
    const ejecutar = vi.fn(async (q: string, p: readonly unknown[]) => {
      const resultado = await db.query(q, [...p]); entrada.liberar(); await entrega.promesa;
      return { filas: resultado.rows };
    });
    const listado = repo(pesado, { ejecutar }); const pendiente = listado.listar(actor, plan.id, null, signal());
    await entrada.promesa; await db.exec("UPDATE itinerario.sesiones SET revocada=true WHERE huella='" + actor + "'");
    const despuesRevocacion = await snapshot(); entrega.liberar();
    expect(pagina(await pendiente).solicitudesIniciales).toHaveLength(1);
    expect(await snapshot()).toEqual(despuesRevocacion);
    expect(await listarConservado()).toEqual({ tipo: 'sin-sesion' }); expect(ejecutar).toHaveBeenCalledTimes(1);
    // Modelo local de transporte retenido; NO locks/COMMIT remotos. E2 necesita
    // autenticación HTTP posterior, sin convertir E1 en dos SELECT ni un snapshot.
  });
  it.each([
    [null, plan.id, null, null, 1, 64, 4762546], [actor, '', null, null, 1, 64, 4762546],
    [actor, plan.id, id(1), null, 1, 64, 4762546], [actor, plan.id, null, id(2), 1, 64, 4762546],
    [actor, plan.id, id(2), id(1), 1, 64, 4762546], [actor, plan.id, 'bad', id(2), 1, 64, 4762546],
    [actor, plan.id, null, null, 0, 64, 4762546], [actor, plan.id, null, null, 9, 64, 4762546],
    [actor, plan.id, null, null, 1, 65, 4762546], [actor, plan.id, null, null, 1, 64, 4762545],
  ])('SQL006 rechaza parámetros inválidos %# antes de consultar_foto', async (...parametros) => {
    await sembrar(id(1)); await instrumentarConsultas(); const antes = await snapshot();
    await db.exec('SAVEPOINT parametros');
    await expect(db.query(SQL, parametros)).rejects.toThrow();
    await db.exec('ROLLBACK TO SAVEPOINT parametros; RELEASE SAVEPOINT parametros');
    expect(await llamadasConsulta()).toBe(0); expect(await snapshot()).toEqual(antes);
  });
});

// Fronteras puras negativas: estos envelopes sintéticos NO son prueba SQL integrada.
describe('Listado: admisión, respuestas hostiles y vigencia local sin proveedor', () => {
  const sinSesion = { filas: [{ resultado: '{"tipo":"sin-sesion"}' }] };
  afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });
  function puerto(valor: unknown = sinSesion) {
    return { ejecutar: vi.fn(async () => valor) } as unknown as EjecutorSql & { ejecutar: ReturnType<typeof vi.fn> };
  }
  it.each([1, 8])('admite mínimos S/P/R exactos N%s, sin consulta ni reducir N', (n) => {
    const c = calcularCotasListadoFotos(n, 64); const ejecutar = vi.fn();
    const p = { maxFilas: n, maxOperacionesPorFoto: 64, maxBytesSql: c.bytesSql,
      maxBytesRespuesta: c.bytesRespuesta, maxBytesRetenidos: c.bytesRetenidos, plazoMs: 1000 };
    expect(() => repo(p, { ejecutar })).not.toThrow(); expect(ejecutar).not.toHaveBeenCalled();
    expect(Object.isFrozen(copiarPresupuestoListadoFotos(p))).toBe(true);
  });
  it.each(['maxBytesSql', 'maxBytesRespuesta', 'maxBytesRetenidos'] as const)('mínimo menos1 %s se rechaza en fábrica cero IO', (clave) => {
    for (const n of [1, 8]) {
      const c = calcularCotasListadoFotos(n, 64); const ejecutar = vi.fn();
      const p = { maxFilas: n, maxOperacionesPorFoto: 64, maxBytesSql: c.bytesSql,
        maxBytesRespuesta: c.bytesRespuesta, maxBytesRetenidos: c.bytesRetenidos, plazoMs: 1000 };
      p[clave]--; expect(() => repo(p, { ejecutar })).toThrow(ERROR); expect(ejecutar).not.toHaveBeenCalled();
    }
  });
  it.each([0, -1, NaN, Infinity, 1.5, Number.MAX_SAFE_INTEGER + 1])('los seis campos rechazan %s sin IO', (n) => {
    const ejecutar = vi.fn();
    for (const clave of Object.keys(presupuesto)) expect(() => repo({ ...presupuesto, [clave]: n }, { ejecutar })).toThrow(ERROR);
    expect(ejecutar).not.toHaveBeenCalled();
  });
  it.each([{ ...presupuesto, maxFilas: 9 }, { ...presupuesto, maxOperacionesPorFoto: 65 },
    { ...presupuesto, plazoMs: 2147483648 }, { ...presupuesto, extra: 1 }, {}, Object.create(presupuesto)])('budget exacto %#', (p) => {
    expect(() => copiarPresupuestoListadoFotos(p)).toThrow(ERROR);
  });
  it.each([0, -1, 9, NaN, Infinity, 1.5, Number.MAX_SAFE_INTEGER])('rango N%s se comprueba antes de multiplicar', (n) => {
    expect(() => calcularCotasListadoFotos(n, 64)).toThrow(ERROR);
  });
  it.each([0, -1, 65, NaN, Infinity, 1.5, Number.MAX_SAFE_INTEGER])('rango K%s se comprueba antes de multiplicar', (k) => {
    expect(() => calcularCotasListadoFotos(1, k)).toThrow(ERROR);
  });
  it('MAX_SAFE presupuestado usa S derivada, no asigna ni acepta SQL ampliado', async () => {
    const c = calcularCotasListadoFotos(1, 64);
    const p = { ...presupuesto, maxBytesSql: Number.MAX_SAFE_INTEGER, maxBytesRespuesta: Number.MAX_SAFE_INTEGER, maxBytesRetenidos: Number.MAX_SAFE_INTEGER };
    const ejecutar = vi.fn(async (_q: string, parametros: readonly unknown[]) => {
      expect(parametros[6]).toBe(c.bytesSql);
      return { filas: [{ resultado: ' '.repeat(c.bytesSql + 1 - 21) + '{"tipo":"sin-sesion"}' }] };
    });
    // Valid JSON+whitespace que cabría si se usara maxBytesSql arbitrario. S+1 falla.
    await expect(repo(p, { ejecutar }).listar(actor, plan.id, null, signal())).rejects.toThrow(ERROR);
    expect(ejecutar).toHaveBeenCalledTimes(1);
  });
  it('M1: plan capturado antes de presupuesto/puerto, sin getters o toJSON', () => {
    const getter = vi.fn(() => plan.id); const gBudget = vi.fn(() => 1); const gPuerto = vi.fn(() => vi.fn());
    const p = structuredClone(plan); Object.defineProperty(p, 'id', { get: getter });
    const b = { ...presupuesto }; Object.defineProperty(b, 'maxFilas', { get: gBudget });
    const e = {}; Object.defineProperty(e, 'ejecutar', { get: gPuerto });
    expect(() => repo(b, e as EjecutorSql, p)).toThrow(ERROR);
    expect(getter).not.toHaveBeenCalled(); expect(gBudget).not.toHaveBeenCalled(); expect(gPuerto).not.toHaveBeenCalled();
    const json = { ...plan, toJSON: getter }; expect(() => repo(presupuesto, puerto(), json)).toThrow(ERROR);
    expect(getter).not.toHaveBeenCalled();
  });
  it('budget y método propios accessors se rechazan sin leerlos; heredado no es puerto', () => {
    const getter = vi.fn(() => 1); const b = { ...presupuesto }; Object.defineProperty(b, 'plazoMs', { get: getter });
    expect(() => repo(b, puerto())).toThrow(ERROR);
    const e = {}; Object.defineProperty(e, 'ejecutar', { get: getter });
    expect(() => repo(presupuesto, e as EjecutorSql)).toThrow(ERROR);
    expect(() => repo(presupuesto, Object.create({ ejecutar: vi.fn() }))).toThrow(ERROR);
    expect(getter).not.toHaveBeenCalled();
  });
  it('config propia exacta sin getters, extras ni subclases', () => {
    const getter = vi.fn(() => plan);
    const c = { plan, presupuesto, ejecutor: puerto() }; Object.defineProperty(c, 'plan', { get: getter });
    expect(() => crearRepositorioListadoFotosSql(c)).toThrow(ERROR);
    expect(() => crearRepositorioListadoFotosSql({ plan, presupuesto, ejecutor: puerto(), extra: 1 } as never)).toThrow(ERROR);
    expect(getter).not.toHaveBeenCalled();
  });
  it.each(['', '\0', 'x'.repeat(129), '\uD800'])('plan id inválido %# antes de consultar', (idPlan) => {
    const e = puerto(); expect(() => repo(presupuesto, e, { ...plan, id: idPlan })).toThrow(ERROR);
    expect(e.ejecutar).not.toHaveBeenCalled();
  });
  it('puerto capturado vincula this; llamada sin-sesion no crea cache ni consultas adicionales', async () => {
    const e = { dato: 7, async ejecutar() { expect(this.dato).toBe(7); return sinSesion; } };
    const r = repo(presupuesto, e); expect(await r.listar(actor, plan.id, null, signal())).toEqual({ tipo: 'sin-sesion' });
  });
  it.each(['', 'A'.repeat(64), 'a'.repeat(63), 'g'.repeat(64)])('huella %# cero consultas', async (huella) => {
    const e = puerto(); await expect(repo(presupuesto, e).listar(huella, plan.id, null, signal())).rejects.toThrow(ERROR);
    expect(e.ejecutar).not.toHaveBeenCalled();
  });
  it.each(['otro', undefined, new String('viaje')])('viaje primitivo capturado %# cero consultas', async (v) => {
    const e = puerto(); await expect(repo(presupuesto, e).listar(actor, v as string, null, signal())).rejects.toThrow(ERROR);
    expect(e.ejecutar).not.toHaveBeenCalled();
  });
  it.each(['{}', 'null', '{} ', JSON.stringify({ version: 1, viajeId: 'otro', despuesDe: id(1), hasta: id(2) }),
    JSON.stringify({ version: 1, viajeId: plan.id, despuesDe: id(2), hasta: id(1) }),
    JSON.stringify({ version: 1, viajeId: plan.id, despuesDe: id(1), hasta: id(2), extra: 1 }),
    '{"version":1,"viajeId":"viaje","despuesDe":"x","hasta":"y"}'])('cursor inválido %# cero consultas', async (c) => {
    const e = puerto(); await expect(repo(presupuesto, e).listar(actor, plan.id, c, signal())).rejects.toThrow(ERROR);
    expect(e.ejecutar).not.toHaveBeenCalled();
  });
  it.each([{}, { filas: [] }, { filas: new Array(1) }, { filas: [{ resultado: 1 }] },
    { filas: [{ resultado: '{}', extra: 1 }] }, { filas: [{ resultado: '{"tipo":"sin-sesion"}' }], extra: 1 },
    { filas: [{ resultado: '{"tipo":"sin-sesion","tipo":"pagina"}' }] },
    { filas: [{ resultado: '\uFEFF{"tipo":"sin-sesion"}' }] },
    { filas: [{ resultado: '"\uD800"' }] }])('respuesta adaptador hostil %# falla privada', async (valor) => {
    const e = puerto(valor); let error: unknown;
    try { await repo(presupuesto, e).listar(actor, plan.id, null, signal()); } catch (v) { error = v; }
    expect((error as Error).message).toBe(ERROR); expect(Object.hasOwn(error as object, 'stack')).toBe(false);
    expect(e.ejecutar).toHaveBeenCalledTimes(1);
  });
  it('filas y columna con getters, prototipo, extras o subclase: cero getters', async () => {
    const getter = vi.fn(() => '{"tipo":"sin-sesion"}');
    const fila = {}; Object.defineProperty(fila, 'resultado', { get: getter });
    const filas = [{}]; Object.defineProperty(filas, '0', { get: getter });
    class Subclase extends Array<unknown> {}
    for (const valor of [{ filas: [fila] }, { filas }, { filas: new Subclase({ resultado: '{}' }) },
      { filas: [Object.create({ resultado: '{}' })] }, { filas: Object.assign([{ resultado: '{}' }], { extra: 1 }) }]) {
      await expect(repo(presupuesto, puerto(valor)).listar(actor, plan.id, null, signal())).rejects.toThrow(ERROR);
    }
    expect(getter).not.toHaveBeenCalled();
  });
  it('errores de proveedor no filtran stack, cause, clasificación ni cuerpo SQL', async () => {
    const ejecutar = vi.fn(async () => { throw new Error('SELECT secreto proveedor', { cause: 'credencial ficticia' }); });
    let error: unknown; try { await repo(presupuesto, { ejecutar }).listar(actor, plan.id, null, signal()); } catch (e) { error = e; }
    expect((error as Error).message).toBe(ERROR); expect(Reflect.ownKeys(error as object)).toEqual(['message']);
    expect(ejecutar).toHaveBeenCalledTimes(1);
  });
  function candidata(fotoId = id(2)) {
    const reservaId = id(99); const texto = cuerpo(fotoId, id(98));
    return { fotoId, consultaCanonica: JSON.stringify({ tipo: 'confirmada', reserva: {
      reservaId, claveObjeto: clavePrivadaFotos(plan.id, fotoId, reservaId), solicitudCanonica: texto } }) };
  }
  it.each(['foto-inicial', 'lookahead-inicial', 'upper', 'after', 'duplicada', 'sin-upper', 'too-many',
    'sin-sesion-interior', 'ausente-interior', 'inner-extras', 'inicial-no-canonico', 'inicial-otro-viaje', 'clave-incorrecta'])('frame interno negativo %s no concede página', async (caso) => {
    const c = JSON.stringify({ version: 1, viajeId: plan.id, despuesDe: id(1), hasta: id(4) });
    const frame: { tipo: string; hasta: string | null; candidatas: ReturnType<typeof candidata>[] } = {
      tipo: 'pagina', hasta: id(4), candidatas: [candidata(id(2)), candidata(id(3))] };
    if (caso === 'foto-inicial') {
      frame.candidatas[0].fotoId = id(3); frame.candidatas[1] = candidata(id(4));
      // Orden/rango válidos, pero el INITIAL de la primera sigue nombrando foto2.
    }
    if (caso === 'lookahead-inicial') frame.candidatas[1].fotoId = id(4);
    if (caso === 'upper') frame.candidatas[1] = candidata(id(5)); // TODO lo demás válido, excede hasta.
    if (caso === 'after') frame.candidatas[0] = candidata(id(1));
    if (caso === 'duplicada') frame.candidatas[1] = frame.candidatas[0];
    if (caso === 'sin-upper') frame.hasta = null;
    if (caso === 'too-many') frame.candidatas.push(candidata(id(4)));
    if (caso === 'sin-sesion-interior') frame.candidatas[1].consultaCanonica = '{"tipo":"sin-sesion"}';
    if (caso === 'ausente-interior') frame.candidatas[1].consultaCanonica = '{"tipo":"ausente"}';
    if (caso === 'inner-extras') frame.candidatas[1].consultaCanonica = '{"tipo":"confirmada","reserva":{},"extra":1}';
    if (caso === 'inicial-no-canonico') {
      const valor = JSON.parse(frame.candidatas[1].consultaCanonica); valor.reserva.solicitudCanonica = ' ' + valor.reserva.solicitudCanonica;
      frame.candidatas[1].consultaCanonica = JSON.stringify(valor);
    }
    if (caso === 'inicial-otro-viaje') frame.candidatas[1].consultaCanonica = frame.candidatas[1].consultaCanonica.replaceAll('viaje', 'ajeno');
    if (caso === 'clave-incorrecta') {
      const valor = JSON.parse(frame.candidatas[1].consultaCanonica); valor.reserva.claveObjeto += '\0';
      frame.candidatas[1].consultaCanonica = JSON.stringify(valor);
    }
    await expect(repo(presupuesto, puerto({ filas: [{ resultado: JSON.stringify(frame) }] })).listar(actor, plan.id, c, signal())).rejects.toThrow(ERROR);
  });
  it('aborto previo cero consultas, cerrar retira listener y timer propios', async () => {
    vi.useFakeTimers(); const controlador = new AbortController(); controlador.abort(); const e = puerto();
    const agregar = vi.spyOn(controlador.signal, 'addEventListener'); const retirar = vi.spyOn(controlador.signal, 'removeEventListener');
    await expect(repo(presupuesto, e).listar(actor, plan.id, null, controlador.signal)).rejects.toThrow(ERROR);
    expect(e.ejecutar).not.toHaveBeenCalled(); expect(agregar).toHaveBeenCalledTimes(1); expect(retirar).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });
  it.each(['aborto', 'plazo', 'error-tardio'])('SQL pendiente %s ignora toda entrega tardía, sin retry', async (caso) => {
    vi.useFakeTimers(); const controlador = new AbortController(); const entrega = barrera();
    const ejecutar = vi.fn(async () => { await entrega.promesa; if (caso === 'error-tardio') throw new Error('error proveedor tardío'); return sinSesion; });
    const quitar = vi.spyOn(controlador.signal, 'removeEventListener');
    const pendiente = repo({ ...presupuesto, plazoMs: 20 }, { ejecutar }).listar(actor, plan.id, null, controlador.signal);
    const rechazo = expect(pendiente).rejects.toThrow(ERROR);
    if (caso === 'aborto') controlador.abort(); else await vi.advanceTimersByTimeAsync(20);
    await rechazo; entrega.liberar(); await ejecutar.mock.results[0].value.catch(() => {});
    expect(ejecutar).toHaveBeenCalledTimes(1); expect(quitar).toHaveBeenCalledTimes(1); expect(vi.getTimerCount()).toBe(0);
  });
  it('éxito sin-sesion cierra timer/listener, sin singleton de vigencia', async () => {
    vi.useFakeTimers(); const controlador = new AbortController(); const quitar = vi.spyOn(controlador.signal, 'removeEventListener'); const e = puerto();
    const r = repo(presupuesto, e);
    expect(await r.listar(actor, plan.id, null, controlador.signal)).toEqual({ tipo: 'sin-sesion' });
    expect(await r.listar(actor, plan.id, null, controlador.signal)).toEqual({ tipo: 'sin-sesion' });
    expect(e.ejecutar).toHaveBeenCalledTimes(2); expect(quitar).toHaveBeenCalledTimes(2); expect(vi.getTimerCount()).toBe(0);
  });
});
