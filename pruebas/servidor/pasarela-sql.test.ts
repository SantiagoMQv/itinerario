import { readFile } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Itinerario } from '../../src/tipos';
import { aplicarOperacion, crearProgreso, type Operacion } from '../../src/progreso';
import { iniciarCola, agregarIntencion, marcarEnviada, recibirAcuse } from '../../src/progreso-cola';
import { serializarProgreso, parsearProgreso } from '../../src/progreso-json';
import { crearAlmacenProgreso, type DecisionHistorica } from '../../servidor/almacen-progreso';
import { crearPasarelaSql } from '../../servidor/pasarela-sql';

const plan: Itinerario = { id: 'viaje', titulo: 'Prueba', dias: [{ fecha: '2026-10-21', titulo: 'Día',
  paradas: ['a', 'b'].map((id) => ({ id, nombre: id, hora: '10:00', categoria: 'museo', lat: 31, lng: 121 })) }] };
const actor = 'a'.repeat(64);
const sesionId = '12345678-1234-4234-8234-123456789012';
const fallo = 'No se pudo comprobar el progreso.';
const op = (extra = {}): Operacion => ({ id: 'op', dispositivoId: 'dispositivo', tipo: 'parada',
  paradaId: 'a', marca: 'hecha', revision: 0, ...extra });
let db: PGlite;
const ejecutar = vi.fn(async (consulta: string, parametros: readonly unknown[]) => {
  const r = await db.query(consulta, [...parametros]);
  return { filas: r.rows };
});
const pasarela = crearPasarelaSql({ ejecutor: { ejecutar } });
const almacen = crearAlmacenProgreso({ plan, pasarela });
async function raiz(revision = 0, estado = crearProgreso(plan)) {
  await db.query('INSERT INTO itinerario.viajes VALUES ($1,$2,$3)', [plan.id, revision, serializarProgreso(estado)]);
}
function candidato(original = op(), base = 0): DecisionHistorica {
  const estado = aplicarOperacion(plan, crearProgreso(plan), original).estado;
  return { tipo: 'positiva', operacionOriginal: original,
    acuse: { operacionId: original.id, persistida: true, instantanea: { revisionServidor: base + 1, estado } } };
}
async function confirmarSql(c: unknown, base = 0) {
  return db.query('SELECT itinerario.confirmar_progreso($1,$2,$3,$4) AS resultado',
    [actor, plan.id, base, serializarProgreso(c)]);
}
async function tablas() {
  const viajes = await db.query('SELECT * FROM itinerario.viajes');
  const decisiones = await db.query('SELECT * FROM itinerario.decisiones');
  return { viajes: viajes.rows, decisiones: decisiones.rows };
}
async function migraciones() {
  for (const nombre of ['001_base.sql', '002_progreso.sql']) {
    await db.exec(await readFile(new URL('../../servidor/migraciones/' + nombre, import.meta.url), 'utf8'));
  }
}

// PostgreSQL nativo embebido, efímero y de UNA conexión. No prueba locks entre clientes Neon.
describe('Pasarela SQL sobre PostgreSQL WASM real', () => {
  beforeAll(async () => { db = await PGlite.create('memory://'); await migraciones(); }, 30000);
  afterAll(async () => { await db?.close(); });
  beforeEach(async () => {
    await db.exec('TRUNCATE itinerario.decisiones, itinerario.sesiones, itinerario.viajes');
    await raiz();
    await db.query(`INSERT INTO itinerario.sesiones
      (sesion_id,huella,viaje_id,creada_en,vence_en,revocada,metadatos_json)
      VALUES ($1,$2,$3,0,9007199254740991,false,$4)`,
    [sesionId, actor, plan.id, '{"dispositivoId":"sintético","nombreDispositivo":"\\u0000"}']);
    ejecutar.mockClear();
  });
  it('informa versión nativa y lee raíz sin decisión ni mutación', async () => {
    expect((await db.query<{ version: string }>('SELECT version()')).rows[0]!.version).toContain('PostgreSQL 18.3');
    expect(await pasarela.consultar(actor, plan.id)).toEqual({ tipo: 'lectura',
      instantanea: { revisionServidor: 0, estado: crearProgreso(plan) }, decision: null });
    expect(ejecutar).toHaveBeenCalledExactlyOnceWith(
      'SELECT itinerario.consultar_progreso($1, $2, $3) AS resultado', [actor, plan.id, null]);
    expect((await tablas()).decisiones).toHaveLength(0);
  });
  it.each(['desconocida', 'otro-viaje', 'revocada', 'caducada'])('no filtra raíz con sesión %s', async (caso) => {
    if (caso === 'revocada') await db.exec('UPDATE itinerario.sesiones SET revocada=true');
    if (caso === 'caducada') await db.exec('UPDATE itinerario.sesiones SET vence_en=1');
    const huella = caso === 'desconocida' ? 'b'.repeat(64) : actor;
    const viaje = caso === 'otro-viaje' ? 'ajeno' : plan.id;
    expect(await pasarela.consultar(huella, viaje, 'op')).toEqual({ tipo: 'sin-sesion' });
    const c = candidato();
    if (c.tipo === 'positiva' && caso === 'otro-viaje') {
      const ajeno = { ...c, acuse: { ...c.acuse, instantanea: { ...c.acuse.instantanea,
        estado: { ...c.acuse.instantanea.estado, viajeId: viaje } } } };
      expect(await pasarela.confirmar(huella, viaje, 0, ajeno)).toEqual({ tipo: 'sin-sesion' });
    } else expect(await pasarela.confirmar(huella, viaje, 0, c)).toEqual({ tipo: 'sin-sesion' });
    expect((await tablas()).decisiones).toHaveLength(0);
  });
  it('consulta reloj real: vence_en igual al milisegundo actual no autoriza', async () => {
    await db.exec('UPDATE itinerario.sesiones SET vence_en=floor(extract(epoch FROM clock_timestamp())*1000)::bigint');
    expect(await pasarela.consultar(actor, plan.id)).toEqual({ tipo: 'sin-sesion' });
  });
  it('sin raíz no crea viaje; sesión válida huérfana provoca error seguro', async () => {
    await db.transaction(async (tx) => {
      await tx.exec('ALTER TABLE itinerario.viajes DISABLE TRIGGER ALL');
      await tx.exec('DELETE FROM itinerario.viajes');
      await tx.exec('ALTER TABLE itinerario.viajes ENABLE TRIGGER ALL');
    });
    await expect(pasarela.consultar(actor, plan.id)).rejects.toThrow(fallo);
    expect((await tablas()).viajes).toHaveLength(0);
  });
  it.each([op(), op({ marca: null })])('aplicada/sin cambio persiste recibo junto al contador', async (original) => {
    const r = await almacen.procesar(actor, plan.id, original);
    expect(r.tipo).toBe('confirmada');
    expect((await almacen.leer(actor, plan.id))).toMatchObject({ instantanea: { revisionServidor: 1 } });
    expect((await tablas()).decisiones).toHaveLength(1);
    expect(ejecutar.mock.calls[1]![0]).toBe('SELECT itinerario.confirmar_progreso($1, $2, $3, $4) AS resultado');
    expect(ejecutar.mock.calls[1]![1]).toEqual([actor, plan.id, 0, serializarProgreso(candidato(original))]);
  });
  it.each(['conflicto', 'invalida'])('retiene rechazo %s completo sin modificar estado', async (motivo) => {
    await almacen.procesar(actor, plan.id, op());
    const previo = (await tablas()).viajes;
    const original: Operacion = motivo === 'invalida'
      ? { id: 'rechazada', dispositivoId: 'dispositivo', tipo: 'deshacer', cambios: { operacionId: 'inexistente', registros: [] } }
      : op({ id: 'rechazada', marca: 'saltada' });
    const r = await almacen.procesar(actor, plan.id, original);
    expect(r).toMatchObject({ tipo: 'rechazada', rechazo: { motivo, operacionOriginal: original,
      decisionPersistida: true, instantanea: { revisionServidor: 2 } } });
    expect((await tablas()).viajes).toMatchObject([{ estado_json: (previo[0] as { estado_json: string }).estado_json }]);
    await almacen.procesar(actor, plan.id, op({ id: 'posterior', paradaId: 'b' }));
    expect(await almacen.procesar(actor, plan.id, original)).toEqual(r);
  });
  it('replay n1 después de n5 conserva DTO original e identidad reutilizada no escribe', async () => {
    const primero = await almacen.procesar(actor, plan.id, op());
    for (let i = 1; i <= 4; i++) await almacen.procesar(actor, plan.id, op({ id: 'otra' + i, paradaId: 'b', revision: i - 1,
      marca: i % 2 ? 'hecha' : 'saltada' }));
    expect(await almacen.leer(actor, plan.id)).toMatchObject({ instantanea: { revisionServidor: 5 } });
    expect(await almacen.procesar(actor, plan.id, op())).toEqual(primero);
    expect(await almacen.procesar(actor, plan.id, op({ marca: 'saltada' }))).toEqual({ tipo: 'identidad-reutilizada' });
    expect((await tablas()).decisiones).toHaveLength(5);
  });
  it('aquí y deshacer válidos atraviesan el esquema SQL sin perder originales', async () => {
    const original = op({ marca: 'aqui', revisionAqui: 0, revisionAnterior: 0 });
    const primera = await almacen.procesar(actor, plan.id, original);
    if (primera.tipo !== 'confirmada') throw new Error('fixture');
    const cambios = primera.acuse.instantanea.estado.operaciones.op!.cambios!;
    const inversa: Operacion = { id: 'inversa', dispositivoId: 'dispositivo', tipo: 'deshacer', cambios };
    expect(await almacen.procesar(actor, plan.id, inversa)).toMatchObject({ tipo: 'confirmada' });
    expect(await almacen.procesar(actor, plan.id, original)).toEqual(primera);
  });
  it('CAS desfasado e ID conocido no sobrescriben historia', async () => {
    await almacen.procesar(actor, plan.id, op());
    const antes = await tablas();
    expect(await pasarela.confirmar(actor, plan.id, 0, candidato(op({ id: 'otra' })))).toEqual({ tipo: 'desfase' });
    expect(await pasarela.confirmar(actor, plan.id, 1, candidato(op(), 1))).toEqual({ tipo: 'desfase' });
    expect(await tablas()).toEqual(antes);
  });
  it('MAX permite replay pero no nuevo ID ni overflow SQL', async () => {
    const primero = await almacen.procesar(actor, plan.id, op());
    await db.exec('UPDATE itinerario.viajes SET revision_servidor=9007199254740991');
    expect(await almacen.procesar(actor, plan.id, op())).toEqual(primero);
    const antes = await tablas();
    await expect(almacen.procesar(actor, plan.id, op({ id: 'otra' }))).rejects.toThrow('El progreso alcanzó su capacidad.');
    await expect(confirmarSql(candidato(), Number.MAX_SAFE_INTEGER)).rejects.toThrow();
    expect(await tablas()).toEqual(antes);
  });
  it.each(['contador', 'viaje', 'persistida', 'id', 'tipo', 'original', 'instantanea'])('SQL rechaza candidato %s sin DML', async (caso) => {
    const c = candidato();
    if (c.tipo !== 'positiva') throw new Error('fixture');
    const adulterado = JSON.parse(serializarProgreso(c));
    if (caso === 'contador') adulterado.acuse.instantanea.revisionServidor = 2;
    if (caso === 'viaje') adulterado.acuse.instantanea.estado.viajeId = 'ajeno';
    if (caso === 'persistida') adulterado.acuse.persistida = false;
    if (caso === 'id') adulterado.acuse.operacionId = 'otro';
    if (caso === 'tipo') adulterado.tipo = 'inventada';
    if (caso === 'original') adulterado.operacionOriginal.id = '';
    if (caso === 'instantanea') adulterado.acuse.instantanea = null;
    const antes = await tablas();
    await expect(confirmarSql(adulterado)).rejects.toThrow();
    expect(await tablas()).toEqual(antes);
  });
  it('SQL negativo exige estado anterior exacto, protocolo, motivo y ausencia de recibo', async () => {
    const c = { tipo: 'negativa', rechazo: { viajeId: plan.id, protocolo: 1, operacionId: 'rechazo',
      operacionOriginal: op({ id: 'rechazo' }), decisionPersistida: true, motivo: 'conflicto',
      instantanea: { revisionServidor: 1, estado: crearProgreso(plan) } } };
    for (const cambio of [{ protocolo: 2 }, { motivo: 'otra' }, { decisionPersistida: false }, { viajeId: 'otro' },
      { instantanea: { revisionServidor: 1, estado: candidato().tipo === 'positiva' ? aplicarOperacion(plan, crearProgreso(plan), op()).estado : null } }]) {
      await expect(confirmarSql({ ...c, rechazo: { ...c.rechazo, ...cambio } })).rejects.toThrow();
    }
    expect((await tablas()).decisiones).toHaveLength(0);
    await confirmarSql(c);
    expect((await tablas()).decisiones).toHaveLength(1);
  });
  it('excepción posterior a INSERT/UPDATE revierte las tres piezas en transacción real', async () => {
    const antes = await tablas();
    await expect(db.transaction(async (tx) => {
      await tx.query('SELECT itinerario.confirmar_progreso($1,$2,$3,$4)', [actor, plan.id, 0, serializarProgreso(candidato())]);
      expect((await tx.query('SELECT * FROM itinerario.decisiones')).rows).toHaveLength(1);
      await tx.exec("DO $$ BEGIN RAISE EXCEPTION 'fallo sintético posterior'; END $$");
    })).rejects.toThrow('fallo sintético posterior');
    expect(await tablas()).toEqual(antes);
  });
  it('conserva -0 almacenado, lectura, historia, wire y aceptación en cola', async () => {
    const original = op({ horaReal: -0 });
    const r = await almacen.procesar(actor, plan.id, original);
    if (r.tipo !== 'confirmada') throw new Error('fixture');
    expect(Object.is(r.acuse.instantanea.estado.paradas.a!.horaReal, -0)).toBe(true);
    const filas = await tablas();
    expect((filas.viajes[0] as { estado_json: string }).estado_json).toContain('"horaReal":-0');
    expect((filas.decisiones[0] as { decision_json: string }).decision_json).toContain('"horaReal":-0');
    expect(await almacen.procesar(actor, plan.id, original)).toEqual(r);
    const leida = await almacen.leer(actor, plan.id);
    if (leida.tipo !== 'instantanea') throw new Error('fixture');
    expect(Object.is(leida.instantanea.estado.paradas.a!.horaReal, -0)).toBe(true);
    const wire = parsearProgreso(serializarProgreso(r.acuse));
    const inicial = iniciarCola(plan, { revisionServidor: 0, estado: crearProgreso(plan) });
    expect(inicial.tipo).toBe('iniciada');
    const agregado = agregarIntencion(plan, inicial.cola, original);
    expect(agregado.tipo).toBe('agregada');
    const enviada = marcarEnviada(plan, agregado.cola, original.id);
    expect(enviada.tipo).toBe('enviada');
    expect(recibirAcuse(plan, enviada.cola, wire as typeof r.acuse).tipo).toBe('confirmada');
  });
  it('semilla TEXT con -0 y rechazo preservan el estado lexical completo', async () => {
    const estado = { ...crearProgreso(plan), paradas: { a: { marca: 'hecha' as const, revision: 1, horaReal: -0 } } };
    const texto = serializarProgreso(estado);
    await db.query('UPDATE itinerario.viajes SET estado_json=$1', [texto]);
    expect(await almacen.leer(actor, plan.id)).toMatchObject({ instantanea: { estado } });
    const original = op({ marca: 'saltada' });
    const rechazo = await almacen.procesar(actor, plan.id, original);
    expect(rechazo.tipo).toBe('rechazada');
    expect((await tablas()).viajes).toMatchObject([{ estado_json: texto, revision_servidor: 1 }]);
    expect(await almacen.procesar(actor, plan.id, original)).toEqual(rechazo);
  });
  it.each(['__proto__', 'constructor', "'); DROP TABLE itinerario.viajes; --"])('ID %s es dato ligado', async (id) => {
    const original = op({ id, dispositivoId: "'); SELECT 1; --" });
    const r = await almacen.procesar(actor, plan.id, original);
    expect(r.tipo).toBe('confirmada');
    expect(await almacen.procesar(actor, plan.id, original)).toEqual(r);
    expect((await tablas()).viajes).toHaveLength(1);
  });
  it('respuesta de commit perdida no fabrica ACK; retry recupera historia real', async () => {
    const p = crearPasarelaSql({ ejecutor: { ejecutar: async (sql, valores) => {
      const r = await ejecutar(sql, valores);
      if (sql.includes('confirmar_progreso')) throw new Error('URI/contraseña sintética privada');
      return r;
    } } });
    const a = crearAlmacenProgreso({ plan, pasarela: p });
    await expect(a.procesar(actor, plan.id, op())).rejects.toThrow(fallo);
    expect((await tablas()).decisiones).toHaveLength(1);
    expect(await a.procesar(actor, plan.id, op())).toMatchObject({ tipo: 'confirmada', acuse: { instantanea: { revisionServidor: 1 } } });
  });
  it('migraciones repetidas no reinician ni podan historia; metadatos NUL quedan opacos', async () => {
    await almacen.procesar(actor, plan.id, op());
    const antes = await tablas();
    await migraciones();
    expect(await tablas()).toEqual(antes);
    const r = await db.query<{ metadatos_json: string }>('SELECT metadatos_json FROM itinerario.sesiones');
    expect(JSON.parse(r.rows[0]!.metadatos_json).nombreDispositivo).toBe('\0');
  });
  it.each([
    "UPDATE itinerario.viajes SET revision_servidor=-1",
    "UPDATE itinerario.viajes SET revision_servidor=9007199254740992",
    "UPDATE itinerario.viajes SET estado_json='[]'",
    "UPDATE itinerario.viajes SET id=''",
    "UPDATE itinerario.sesiones SET huella='A'",
    "UPDATE itinerario.sesiones SET sesion_id='12345678-1234-1234-8234-123456789012'",
    "UPDATE itinerario.sesiones SET vence_en=0",
    "UPDATE itinerario.sesiones SET metadatos_json='[]'",
  ])('constraint nativa rechaza %s', async (sql) => { await expect(db.exec(sql)).rejects.toThrow(); });
});

describe('Frontera estricta y privada del ejecutor SQL', () => {
  it.each([[], [{ resultado: '{}' }, { resultado: '{}' }], [null], ['{}'], [{ resultado: {} }],
    [{ resultado: '{}', extra: 1 }], [{ resultado: '{mal' }], [{ resultado: '{"n":1e999}' }],
    [Object.defineProperty({}, 'resultado', { get() { throw new Error('getter secreto'); } })]].map((filas) => ({ filas })))('rechaza filas inválidas %#', async ({ filas }) => {
    const p = crearPasarelaSql({ ejecutor: { ejecutar: async () => ({ filas }) } });
    await expect(p.consultar(actor, plan.id)).rejects.toThrow(fallo);
  });
  it.each([null, {}, { filas: [], extra: true }, Object.defineProperty({}, 'filas', { get() { throw new Error('secreto'); } })])('rechaza sobre del SDK %#', async (sobre) => {
    const p = crearPasarelaSql({ ejecutor: { ejecutar: async () => sobre as never } });
    await expect(p.consultar(actor, plan.id)).rejects.toThrow(fallo);
  });
  it.each([['A'.repeat(64), plan.id, undefined], [actor, '', undefined], [actor, 'x'.repeat(129), undefined],
    [actor, '\ud800', undefined], [actor, plan.id, '\0'], [actor, plan.id, '']])('no consulta para entrada malformada %#', async (a, v, id) => {
    const ejecutar = vi.fn();
    const p = crearPasarelaSql({ ejecutor: { ejecutar } });
    await expect(p.consultar(a!, v!, id)).rejects.toThrow(fallo);
    expect(ejecutar).not.toHaveBeenCalled();
  });
  it.each([
    { estado: { viajeId: plan.id, paradas: [], pendientes: {}, aqui: {}, operaciones: {} } },
    { estado: { ...crearProgreso(plan), paradas: { a: { marca: 'hecha', revision: -1 } } } },
    { estado: { ...crearProgreso(plan), operaciones: { op: { firma: 5 } } } },
    { estado: { ...crearProgreso(plan), operaciones: { op: { firma: 'opaca' } }, aqui: { paradaId: null, revision: 0.5 } } },
  ])('candidato DTO malformado no sale del proceso %#', async ({ estado }) => {
    const ejecutar = vi.fn();
    const p = crearPasarelaSql({ ejecutor: { ejecutar } });
    const c = candidato();
    if (c.tipo !== 'positiva') throw new Error('fixture');
    await expect(p.confirmar(actor, plan.id, 0,
      { ...c, acuse: { ...c.acuse, instantanea: { revisionServidor: 1, estado } } } as never)).rejects.toThrow(fallo);
    expect(ejecutar).not.toHaveBeenCalled();
  });
  it('valida candidato/counter antes de IO y nunca ejecuta getters', async () => {
    const ejecutar = vi.fn();
    const p = crearPasarelaSql({ ejecutor: { ejecutar } });
    for (const base of [-1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER]) {
      await expect(p.confirmar(actor, plan.id, base, candidato())).rejects.toThrow(fallo);
    }
    await expect(p.confirmar(actor, plan.id, 0, { tipo: 'positiva', get acuse() { throw new Error('secreto'); } } as never)).rejects.toThrow(fallo);
    await expect(p.confirmar(actor, plan.id, 0, { ...candidato(), extra: true } as never)).rejects.toThrow(fallo);
    expect(ejecutar).not.toHaveBeenCalled();
  });
  it('no ejecuta getters del envoltorio, fila ni candidato; no registra errores privados', async () => {
    const getter = vi.fn(() => 'secreto');
    const log = vi.spyOn(console, 'log');
    const error = vi.spyOn(console, 'error');
    try {
      for (const dato of [Object.defineProperty({}, 'filas', { get: getter }),
        { filas: [Object.defineProperty({}, 'resultado', { get: getter })] }]) {
        const p = crearPasarelaSql({ ejecutor: { ejecutar: async () => dato as never } });
        await expect(p.consultar(actor, plan.id)).rejects.toThrow(fallo);
      }
      const ejecutar = vi.fn();
      const p = crearPasarelaSql({ ejecutor: { ejecutar } });
      await expect(p.confirmar(actor, plan.id, 0, Object.defineProperty({}, 'tipo', { get: getter }) as never)).rejects.toThrow(fallo);
      expect(getter).not.toHaveBeenCalled();
      expect(ejecutar).not.toHaveBeenCalled();
      expect(log).not.toHaveBeenCalled();
      expect(error).not.toHaveBeenCalled();
    } finally { log.mockRestore(); error.mockRestore(); }
  });
  it('unknown pasa al dominio; parsear texto no afirma que el DTO sea válido', async () => {
    const p = crearPasarelaSql({ ejecutor: { ejecutar: async () => ({ filas: [{ resultado: '{"tipo":"ficticio"}' }] }) } });
    expect(await p.consultar(actor, plan.id)).toEqual({ tipo: 'ficticio' });
    await expect(crearAlmacenProgreso({ plan, pasarela: p }).leer(actor, plan.id)).rejects.toThrow(fallo);
  });
  it('un único SELECT ligado espera resolución y oculta error de SQL sin causa', async () => {
    let resolver!: (valor: { filas: unknown[] }) => void;
    const ejecutar = vi.fn(() => new Promise<{ filas: unknown[] }>((r) => { resolver = r; }));
    const p = crearPasarelaSql({ ejecutor: { ejecutar } });
    let completa = false;
    const respuesta = p.confirmar(actor, plan.id, 0, candidato()).then((r) => { completa = true; return r; });
    await Promise.resolve();
    expect(completa).toBe(false);
    expect(ejecutar).toHaveBeenCalledTimes(1);
    expect(ejecutar.mock.calls[0]).toHaveLength(2);
    resolver({ filas: [{ resultado: '{"tipo":"comprometida"}' }] });
    expect(await respuesta).toEqual({ tipo: 'comprometida' });
    const error = new Error('password/URI/params privados');
    const q = crearPasarelaSql({ ejecutor: { ejecutar: async () => { throw error; } } });
    try { await q.consultar(actor, plan.id); throw new Error('no falló'); }
    catch (e) { expect(e).toMatchObject({ message: fallo }); expect((e as Error).cause).toBeUndefined(); }
  });
});
