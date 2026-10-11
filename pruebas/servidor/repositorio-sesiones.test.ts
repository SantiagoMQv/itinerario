import { readFile } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { crearRepositorioSesionesSql } from '../../servidor/repositorio-sesiones';
import { crearControladorSesiones, type RegistroSesion } from '../../servidor/sesiones';
import { crearCredenciales, formatearCookieSesion } from '../../servidor/credenciales';
import { serializarProgreso } from '../../src/progreso-json';

const fallo = 'No se pudo comprobar la sesión.';
const viajeId = 'viaje';
const a = 'a'.repeat(64), b = 'b'.repeat(64), c = 'c'.repeat(64);
const idA = 'abcdef12-1234-4234-8234-123456789012';
const idB = '12345678-1234-4234-8234-123456789012';
const idC = '12345678-1234-4234-8234-123456789013';
const registro = (extra: Partial<RegistroSesion> = {}): RegistroSesion => ({
  id: idA, huella: a, viajeId, dispositivoId: 'móvil\0设备', creadaEn: 0,
  venceEn: Number.MAX_SAFE_INTEGER, revocada: false, nombreDispositivo: ' teléfono\0📱 ', ...extra,
});
let db: PGlite;
let migracion: string;
const ejecutar = vi.fn(async (consulta: string, parametros: readonly unknown[]) => ({
  filas: (await db.query(consulta, [...parametros])).rows,
}));
const repo = crearRepositorioSesionesSql({ ejecutor: { ejecutar }, viajeId });
async function tablas() {
  return { viajes: (await db.query('SELECT * FROM itinerario.viajes ORDER BY id')).rows,
    decisiones: (await db.query('SELECT * FROM itinerario.decisiones ORDER BY viaje_id,operacion_id')).rows };
}
async function dos() { await repo.crear(registro()); await repo.crear(registro({ id: idB, huella: b })); }

// PostgreSQL WASM real, efímero y UNA conexión: no demuestra esperas/deadlocks entre clientes.
describe('Cinco puertos de sesiones SQL nativas', () => {
  beforeAll(async () => {
    db = await PGlite.create('memory://');
    for (const nombre of ['001_base.sql', '002_progreso.sql', '003_sesiones.sql', '004_limite.sql']) {
      const texto = await readFile(new URL('../../servidor/migraciones/' + nombre, import.meta.url), 'utf8');
      await db.exec(texto);
      if (nombre === '003_sesiones.sql') migracion = texto;
    }
  }, 30000);
  afterAll(async () => { await db?.close(); });
  beforeEach(async () => {
    await db.exec('TRUNCATE itinerario.intentos_sesion, itinerario.decisiones, itinerario.sesiones, itinerario.viajes');
    for (const id of [viajeId, 'ajeno']) await db.query('INSERT INTO itinerario.viajes VALUES ($1,0,$2)',
      [id, '{"viajeId":"' + id + '","prueba":-0}']);
    ejecutar.mockClear();
  });
  it('crea, lee desde SQL y conserva UUID canónico, NUL, espacios y Unicode sin normalizar', async () => {
    expect((await db.query<{ version: string }>('SELECT version()')).rows[0]!.version).toContain('PostgreSQL 18.3');
    await expect(repo.crear(Object.freeze(registro({ id: idA.toUpperCase() })))).resolves.toBeUndefined();
    expect(await repo.leer(a)).toEqual(registro());
    const r = (await db.query('SELECT metadatos_json FROM itinerario.sesiones WHERE huella=$1', [a])).rows[0];
    expect(r).toEqual({ metadatos_json: serializarProgreso({ dispositivoId: 'móvil\0设备', nombreDispositivo: ' teléfono\0📱 ' }) });
    expect(ejecutar.mock.calls[0]).toEqual(['SELECT itinerario.crear_sesion($1, $2, $3, $4, $5, $6, $7) AS resultado',
      [idA, a, viajeId, 0, Number.MAX_SAFE_INTEGER, false,
        serializarProgreso({ dispositivoId: 'móvil\0设备', nombreDispositivo: ' teléfono\0📱 ' })]]);
    expect(Reflect.ownKeys(repo).sort()).toEqual(['admitirIntento', 'crear', 'leer', 'listar', 'revocar', 'revocarOtra'].sort());
  });
  it('omite nombre ausente y acepta datos propios ocultos sin modificar el original congelado', async () => {
    const r = registro(); const { nombreDispositivo: _nombre, ...sinNombre } = r;
    Object.defineProperty(sinNombre, 'dispositivoId', { value: 'oculto', enumerable: false });
    Object.freeze(sinNombre);
    await repo.crear(sinNombre);
    const leida = await repo.leer(a);
    expect(leida).toEqual({ ...sinNombre, dispositivoId: 'oculto' });
    expect(Object.hasOwn(leida as object, 'nombreDispositivo')).toBe(false);
    expect(Object.isFrozen(leida)).toBe(true);
    expect(Object.getOwnPropertyDescriptor(sinNombre, 'dispositivoId')!.enumerable).toBe(false);
  });
  it.each(['id', 'huella'])('duplicar %s no sobrescribe ni confirma éxito', async (campo) => {
    await repo.crear(registro());
    await expect(repo.crear(registro({ id: campo === 'id' ? idA : idB, huella: campo === 'huella' ? a : b,
      dispositivoId: 'otro' }))).rejects.toThrow(fallo);
    expect(await repo.leer(a)).toEqual(registro());
    expect((await db.query('SELECT * FROM itinerario.sesiones')).rows).toHaveLength(1);
  });
  it('leer entrega registros revocados/caducados; nunca los confunde con ausencia', async () => {
    await repo.crear(registro({ venceEn: 1, revocada: true }));
    expect(await repo.leer(a)).toEqual(registro({ venceEn: 1, revocada: true }));
    expect(await repo.leer(b)).toBeNull();
    await crearRepositorioSesionesSql({ ejecutor: { ejecutar }, viajeId: 'ajeno' }).crear(registro({ id: idB, huella: b, viajeId: 'ajeno' }));
    expect(await repo.leer(b)).toBeNull();
  });
  it('revocar es duradero, idempotente, acepta ausencia y no toca otros viajes', async () => {
    await dos(); await repo.revocar(a, viajeId); await repo.revocar(a, viajeId); await repo.revocar(c, viajeId);
    expect(await repo.leer(a)).toMatchObject({ revocada: true });
    expect(await repo.leer(b)).toMatchObject({ revocada: false });
    await expect(repo.revocar(b, 'ajeno')).rejects.toThrow(fallo);
    expect(await repo.leer(b)).toMatchObject({ revocada: false });
  });
  it('listar recoge todas las filas propias incluidas caducadas/revocadas, sin límite ni filtrado', async () => {
    await dos(); await repo.crear(registro({ id: idC, huella: c, venceEn: 1, revocada: true }));
    const ajeno = crearRepositorioSesionesSql({ ejecutor: { ejecutar }, viajeId: 'ajeno' });
    await ajeno.crear(registro({ id: '12345678-1234-4234-8234-123456789014', huella: 'd'.repeat(64), viajeId: 'ajeno' }));
    expect(await repo.listar(a, viajeId)).toEqual({ tipo: 'lista', sesiones: [
      registro({ id: idB, huella: b }), registro({ id: idC, huella: c, venceEn: 1, revocada: true }), registro(),
    ] });
  });
  it.each(['ausente', 'caducado', 'revocado', 'frontera'])('actor %s no lista ni revoca', async (caso) => {
    await dos();
    if (caso === 'caducado') await db.query('UPDATE itinerario.sesiones SET vence_en=1 WHERE huella=$1', [a]);
    if (caso === 'revocado') await repo.revocar(a, viajeId);
    if (caso === 'frontera') await db.query('UPDATE itinerario.sesiones SET vence_en=floor(extract(epoch FROM clock_timestamp())*1000)::bigint WHERE huella=$1', [a]);
    const actor = caso === 'ausente' ? c : a;
    expect(await repo.listar(actor, viajeId)).toEqual({ tipo: 'sin-sesion' });
    expect(await repo.revocarOtra(actor, viajeId, idB)).toBe('sin-sesion');
    expect(await repo.leer(b)).toMatchObject({ revocada: false });
  });
  it('objetivo ausente/ajeno no concede autoridad; revocación repetida exige actor válido', async () => {
    await dos();
    const ajeno = crearRepositorioSesionesSql({ ejecutor: { ejecutar }, viajeId: 'ajeno' });
    await ajeno.crear(registro({ id: idC, huella: c, viajeId: 'ajeno' }));
    expect(await repo.revocarOtra(a, viajeId, idC)).toBe('ausente');
    expect(await repo.revocarOtra(a, viajeId, '12345678-1234-4234-8234-123456789015')).toBe('ausente');
    expect(await repo.revocarOtra(a, viajeId, idB.toUpperCase())).toBe('revocada');
    expect(await repo.revocarOtra(a, viajeId, idB)).toBe('revocada');
    expect(await repo.revocarOtra(b, viajeId, idA)).toBe('sin-sesion'); // A→B y después B→A, serial, no concurrencia.
    expect(await ajeno.leer(c)).toMatchObject({ revocada: false });
    expect(await repo.revocarOtra(a, viajeId, idA)).toBe('revocada');
    expect(await repo.revocarOtra(a, viajeId, idA)).toBe('sin-sesion');
  });
  it('todos los puertos dejan raíz, -0, revisiones e historia exactamente intactos', async () => {
    await db.query('INSERT INTO itinerario.decisiones VALUES ($1,$2,$3,1,$4)', [viajeId, 'historia', 'negativa', '{"prueba":-0}']);
    const antes = await tablas();
    await dos(); await repo.leer(a); await repo.listar(a, viajeId);
    await repo.revocarOtra(a, viajeId, idB); await repo.revocar(a, viajeId);
    expect(await tablas()).toEqual(antes);
  });
  it.each(['crear', 'revocar', 'revocarOtra'])('fallo nativo AFTER %s revierte realmente, sin falso void', async (puerto) => {
    if (puerto !== 'crear') await dos();
    await db.exec(`CREATE FUNCTION itinerario.fallar_sesion_prueba() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'detalle privado'; END $$;
      CREATE TRIGGER fallo_sesion AFTER ${puerto === 'crear' ? 'INSERT' : 'UPDATE'} ON itinerario.sesiones
      FOR EACH ROW EXECUTE FUNCTION itinerario.fallar_sesion_prueba()`);
    try {
      const accion = puerto === 'crear' ? repo.crear(registro())
        : puerto === 'revocar' ? repo.revocar(a, viajeId) : repo.revocarOtra(a, viajeId, idB);
      await expect(accion).rejects.toThrow(fallo);
      expect(await repo.leer(a)).toEqual(puerto === 'crear' ? null : registro());
      if (puerto === 'revocarOtra') expect(await repo.leer(b)).toEqual(registro({ id: idB, huella: b }));
    } finally { await db.exec('DROP TRIGGER fallo_sesion ON itinerario.sesiones; DROP FUNCTION itinerario.fallar_sesion_prueba()'); }
  });
  it('respuesta perdida después de commit propaga error; retry no sobrescribe y logout es idempotente', async () => {
    const perdida = crearRepositorioSesionesSql({ viajeId, ejecutor: { async ejecutar(sql, parametros) {
      await ejecutar(sql, parametros); throw new Error('DSN/token privados');
    } } });
    await expect(perdida.crear(registro())).rejects.toThrow(fallo);
    expect(await repo.leer(a)).toEqual(registro());
    await expect(repo.crear(registro())).rejects.toThrow(fallo);
    await expect(perdida.revocar(a, viajeId)).rejects.toThrow(fallo);
    expect(await repo.leer(a)).toMatchObject({ revocada: true });
    await expect(repo.revocar(a, viajeId)).resolves.toBeUndefined();
  });
  it.each(['{}', '{"dispositivoId":null}', '{"dispositivoId":"ok","extra":true}', '{mal', '[]'])('metadatos corruptos %s fallan sin ocultar fila', async (texto) => {
    await dos();
    if (texto === '{mal' || texto === '[]') {
      await expect(db.query('UPDATE itinerario.sesiones SET metadatos_json=$1 WHERE huella=$2', [texto, b])).rejects.toThrow();
    } else {
      await db.query('UPDATE itinerario.sesiones SET metadatos_json=$1 WHERE huella=$2', [texto, b]);
      await expect(repo.leer(b)).rejects.toThrow(fallo);
      await expect(repo.listar(a, viajeId)).rejects.toThrow(fallo);
    }
  });
  it.each([
    ['sesion_id', '12345678-1234-1234-8234-123456789012'], ['huella', 'Z'.repeat(64)],
    ['viaje_id', 'sin-raiz'], ['creada_en', -1], ['vence_en', 0], ['vence_en', '9007199254740992'],
  ])('constraints nativas impiden %s=%s sin escribir', async (columna, valor) => {
    await repo.crear(registro());
    await expect(db.query(`UPDATE itinerario.sesiones SET ${columna}=$1 WHERE huella=$2`, [valor, a])).rejects.toThrow();
    expect(await repo.leer(a)).toEqual(registro());
  });
  it('crear no fabrica raíz; FK rechazada llega como error privado', async () => {
    const sinRaiz = crearRepositorioSesionesSql({ ejecutor: { ejecutar }, viajeId: 'sin-raiz' });
    await expect(sinRaiz.crear(registro({ viajeId: 'sin-raiz' }))).rejects.toThrow(fallo);
    expect(await sinRaiz.leer(a)).toBeNull();
  });
  it.each([
    ['12345678-1234-1234-8234-123456789012', a, viajeId, 0, 1, false, '{}'],
    [idA, 'bad', viajeId, 0, 1, false, '{}'], [idA, a, 'sin-raiz', 0, 1, false, '{}'],
    [idA, a, viajeId, -1, 1, false, '{}'], [idA, a, viajeId, 1, 1, false, '{}'],
    [idA, a, viajeId, 0, '9007199254740992', false, '{}'],
    [idA, a, viajeId, 0, 1, null, '{}'], [idA, a, viajeId, 0, 1, false, '[]'],
    [idA, a, viajeId, 0, 1, false, '{mal'],
  ])('función crear rechaza argumentos nativos inválidos sin insertarlos', async (...parametros) => {
    await expect(db.query('SELECT itinerario.crear_sesion($1,$2,$3,$4,$5,$6,$7)', parametros)).rejects.toThrow();
    expect((await db.query('SELECT * FROM itinerario.sesiones')).rows).toHaveLength(0);
  });
  it('SQL directo limita autoridad por viaje aunque el actor exista en otro', async () => {
    await dos();
    for (const funcion of ['listar_sesiones', 'revocar_otra_sesion']) {
      const sql = funcion === 'listar_sesiones' ? 'SELECT itinerario.listar_sesiones($1,$2) AS resultado'
        : 'SELECT itinerario.revocar_otra_sesion($1,$2,$3) AS resultado';
      const parametros = funcion === 'listar_sesiones' ? [a, 'ajeno'] : [a, 'ajeno', idB];
      expect((await db.query<{ resultado: string }>(sql, parametros)).rows[0]!.resultado).toBe('{"tipo":"sin-sesion"}');
    }
    await db.query('SELECT itinerario.revocar_sesion($1,$2)', [a, 'ajeno']);
    expect(await repo.leer(a)).toMatchObject({ revocada: false });
  });
  it('SQL declara locks UUID ordenados y clock fresco; no usa JSONB ni extrae metadatos', () => {
    const otra = migracion.slice(migracion.indexOf('FUNCTION itinerario.revocar_otra_sesion'));
    expect(otra).toMatch(/ORDER BY sesion_id\s+FOR UPDATE/);
    expect(otra).not.toMatch(/FOR SHARE/);
    expect(otra.indexOf('clock_timestamp()')).toBeGreaterThan(otra.indexOf('FOR UPDATE'));
    expect(migracion).not.toMatch(/::jsonb|metadatos_json\s*->|now\(\)/i);
  });
  it('seis puertos nativos HTTP: red confiable limita antes de clave; cookie solo tras crear y DTO sin huella', async () => {
    const clave = 'sintética opaca de prueba '.repeat(3) + '\0';
    const credenciales = await crearCredenciales({ viajeId, claveCompartida: clave });
    const controlador = crearControladorSesiones({ viajeId, credenciales, repositorio: repo });
    await db.query('INSERT INTO itinerario.decisiones VALUES ($1,$2,$3,1,$4)',
      [viajeId, 'historia-login', 'negativa', '{"prueba":-0}']);
    const antes = await tablas();
    const post = (claveEntrada: string, dispositivoId: string, origen = 'https://viaje.test') =>
      new Request('https://viaje.test/api/sesion', { method: 'POST',
        headers: { Origin: origen, 'Content-Type': 'application/json' },
        body: JSON.stringify({ clave: claveEntrada, dispositivoId, nombreDispositivo: ' móvil\0设备 ' }) });
    ejecutar.mockClear();
    expect((await controlador.atender(post(clave, 'uno', 'https://ajeno.test'), { identidadRed: 'red sintética A' })).status).toBe(403);
    expect(ejecutar).not.toHaveBeenCalled();
    expect((await controlador.atender(post(clave, 'uno'))).status).toBe(503);
    expect(ejecutar).not.toHaveBeenCalled();
    const cuerpoNoConfiable = new Request('https://viaje.test/api/sesion', { method: 'POST',
      headers: { Origin: 'https://viaje.test', 'Content-Type': 'application/json' },
      body: JSON.stringify({ clave, dispositivoId: 'uno', identidadRed: 'inventada' }) });
    expect((await controlador.atender(cuerpoNoConfiable)).status).toBe(400);
    expect(ejecutar).not.toHaveBeenCalled();
    for (let i = 0; i < 10; i++) {
      const respuesta = await controlador.atender(post('incorrecta', 'cambiante-' + i), { identidadRed: 'red sintética A' });
      expect(respuesta.status).toBe(401); expect(respuesta.headers.get('Set-Cookie')).toBeNull();
    }
    expect((await db.query('SELECT * FROM itinerario.sesiones')).rows).toEqual([]);
    const buckets = (await db.query<{ huella_origen: string; intentos: number }>('SELECT huella_origen,intentos FROM itinerario.intentos_sesion')).rows;
    expect(buckets).toHaveLength(1); expect(buckets[0]!.intentos).toBe(10);
    const resumen = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(
      JSON.stringify(['itinerario', 'v1', 'intento-sesion', viajeId, 'red sintética A']))));
    expect(buckets[0]!.huella_origen).toBe(Array.from(resumen, (v) => v.toString(16).padStart(2, '0')).join(''));
    for (const candidata of ['incorrecta', clave]) {
      const respuesta = await controlador.atender(post(candidata, 'otro dispositivo'), { identidadRed: 'red sintética A' });
      expect(respuesta.status).toBe(429); expect(respuesta.headers.get('Retry-After')).toBe('600');
      expect(respuesta.headers.get('Set-Cookie')).toBeNull();
    }
    expect((await db.query('SELECT intentos FROM itinerario.intentos_sesion')).rows).toEqual([{ intentos: 10 }]);
    const entrada = await controlador.atender(post(clave, 'móvil\0设备'), { identidadRed: 'red sintética B' });
    expect(entrada.status).toBe(201);
    const setCookie = entrada.headers.get('Set-Cookie')!;
    expect(setCookie).toContain('Secure'); expect(setCookie).toContain('HttpOnly');
    const cookie = setCookie.split(';')[0]!;
    const dto = await entrada.json();
    const actor = await controlador.autenticar(new Request('https://viaje.test/api/sesion', { headers: { Cookie: cookie } }));
    expect(actor).not.toBeNull();
    expect(await repo.leer(actor!.huella)).toEqual(actor);
    expect(actor!.creadaEn).toBeGreaterThan(Date.now() - 60000); // Clock real, no sesión antigua de fixture.
    expect(dto).toEqual({ sesion: { id: actor!.id, viajeId, dispositivoId: 'móvil\0设备',
      nombreDispositivo: ' móvil\0设备 ', venceEn: actor!.venceEn } });
    expect(JSON.stringify(dto)).not.toContain(actor!.huella);
    const obtener = await controlador.atender(new Request('https://viaje.test/api/sesion', { headers: { Cookie: cookie } }));
    expect(obtener.status).toBe(200); expect(await obtener.json()).toEqual(dto);
    const lista = await controlador.atender(new Request('https://viaje.test/api/sesiones', { headers: { Cookie: cookie } }));
    expect(lista.status).toBe(200); expect(await lista.json()).toEqual({ sesiones: [{ id: actor!.id, viajeId,
      dispositivoId: 'móvil\0设备', nombreDispositivo: ' móvil\0设备 ', venceEn: actor!.venceEn, actual: true }] });
    const self = await controlador.atender(new Request('https://viaje.test/api/sesiones/' + actor!.id,
      { method: 'DELETE', headers: { Origin: 'https://viaje.test', Cookie: cookie } }));
    expect(self.status).toBe(200); expect(self.headers.get('Set-Cookie')).toContain('Max-Age=0');
    expect(await repo.leer(actor!.huella)).toMatchObject({ revocada: true });
    expect((await controlador.atender(new Request('https://viaje.test/api/sesion', { headers: { Cookie: cookie } }))).status).toBe(401);
    // Completar logout por el quinto algoritmo también con creación HTTP nativa.
    const otra = await controlador.atender(post(clave, 'otro'), { identidadRed: 'red sintética B' });
    expect(otra.status).toBe(201);
    const otroCookie = otra.headers.get('Set-Cookie')!.split(';')[0]!;
    const salida = await controlador.atender(new Request('https://viaje.test/api/sesion', { method: 'DELETE',
      headers: { Origin: 'https://viaje.test', Cookie: otroCookie } }));
    expect(salida.status).toBe(200); expect(salida.headers.get('Set-Cookie')).toContain('Max-Age=0');
    expect(await tablas()).toEqual(antes);
  });
  it('HTTP con limiter nativo pierde acuse tras commit: 503 sin cookie ni sesión, bucket consumido', async () => {
    const clave = 'sintética opaca de prueba '.repeat(3);
    const credenciales = await crearCredenciales({ viajeId, claveCompartida: clave });
    const perdida = crearRepositorioSesionesSql({ viajeId, ejecutor: { async ejecutar(sql, parametros) {
      const resultado = await ejecutar(sql, parametros);
      if (sql.includes('admitir_intento')) throw new Error('postgres://privado clave token');
      return resultado;
    } } });
    const controlador = crearControladorSesiones({ viajeId, credenciales, repositorio: perdida });
    const entrada = await controlador.atender(new Request('https://viaje.test/api/sesion', { method: 'POST',
      headers: { Origin: 'https://viaje.test', 'Content-Type': 'application/json' },
      body: JSON.stringify({ clave, dispositivoId: 'sintético' }) }), { identidadRed: 'red sintética' });
    expect(entrada.status).toBe(503); expect(entrada.headers.get('Set-Cookie')).toBeNull();
    expect(await entrada.json()).toEqual({ error: fallo });
    expect((await db.query('SELECT * FROM itinerario.sesiones')).rows).toEqual([]);
    expect((await db.query('SELECT intentos FROM itinerario.intentos_sesion')).rows).toEqual([{ intentos: 1 }]);
  });
  it('dos repositorios completos usan el mismo bucket nativo sin autoridad del viaje configurado', async () => {
    const otro = crearRepositorioSesionesSql({ viajeId: 'ajeno', ejecutor: { ejecutar } });
    const resultados = await Promise.all(Array.from({ length: 12 }, (_, i) =>
      (i % 2 ? repo : otro).admitirIntento(a, 0)));
    expect(resultados.filter(Boolean)).toHaveLength(10);
    expect((await db.query('SELECT intentos FROM itinerario.intentos_sesion')).rows).toEqual([{ intentos: 10 }]);
    // El caller debe derivar hashes diferentes por viaje; la factoría no vuelve a hashear.
    expect(await otro.admitirIntento(b, 0)).toBe(true);
  });
  it('HTTP no emite cookie tras perder acuse de creación; logout perdido admite retry duradero', async () => {
    const credenciales = await crearCredenciales({ viajeId, claveCompartida: 'sintética de prueba '.repeat(3) });
    const perdida = crearRepositorioSesionesSql({ viajeId, ejecutor: { async ejecutar(sql, parametros) {
      const resultado = await ejecutar(sql, parametros);
      if (sql.includes('crear_sesion') || sql.includes('revocar_sesion')) throw new Error('detalle privado');
      return resultado;
    } } });
    // Doble SOLO del limiter, exclusivamente en este arnés HTTP.
    const controlador = crearControladorSesiones({ viajeId, credenciales,
      repositorio: { ...perdida, admitirIntento: async () => true } });
    const entrada = await controlador.atender(new Request('https://viaje.test/api/sesion', { method: 'POST',
      headers: { Origin: 'https://viaje.test', 'Content-Type': 'application/json' }, body: JSON.stringify({ clave: 'sintética de prueba '.repeat(3),
        dispositivoId: 'móvil\0设备' }) }), { identidadRed: 'sintética' });
    expect(entrada.status).toBe(503); expect(entrada.headers.get('Set-Cookie')).toBeNull();
    expect((await db.query('SELECT * FROM itinerario.sesiones')).rows).toHaveLength(1);
    const { token, huella } = await credenciales.emitirSesion(); await repo.crear(registro({ huella }));
    const solicitar = () => new Request('https://viaje.test/api/sesion', { method: 'DELETE',
      headers: { Origin: 'https://viaje.test', Cookie: formatearCookieSesion(token).split(';')[0]! } });
    const primerLogout = await controlador.atender(solicitar());
    expect(primerLogout.status).toBe(503); expect(primerLogout.headers.get('Set-Cookie')).toBeNull();
    expect(await repo.leer(huella)).toMatchObject({ revocada: true });
    const retry = await controlador.atender(solicitar());
    expect(retry.status).toBe(200); expect(retry.headers.get('Set-Cookie')).toContain('Max-Age=0');
  });
  it('controlador real con credenciales nativas publica DTO seguro y limpia cookie solo tras revocación', async () => {
    const credenciales = await crearCredenciales({ viajeId, claveCompartida: 'sintética de prueba '.repeat(3) });
    // SOLO doble del sexto puerto en esta prueba: no wiring ni prueba del limiter persistente.
    const controlador = crearControladorSesiones({ viajeId, credenciales,
      repositorio: { ...repo, admitirIntento: async () => true } });
    const { token, huella } = await credenciales.emitirSesion();
    await repo.crear(registro({ huella })); await repo.crear(registro({ id: idB, huella: b, venceEn: 1 }));
    const cookie = formatearCookieSesion(token).split(';')[0]!;
    const listado = await controlador.atender(new Request('https://viaje.test/api/sesiones', { headers: { Cookie: cookie } }));
    expect(listado.status).toBe(200);
    const publico = await listado.json();
    expect(publico).toEqual({ sesiones: [{ id: idA, viajeId, dispositivoId: 'móvil\0设备', venceEn: Number.MAX_SAFE_INTEGER,
      nombreDispositivo: ' teléfono\0📱 ', actual: true }] });
    expect(JSON.stringify(publico)).not.toContain(huella);
    const salida = await controlador.atender(new Request('https://viaje.test/api/sesiones/' + idA,
      { method: 'DELETE', headers: { Cookie: cookie, Origin: 'https://viaje.test' } }));
    expect(salida.status).toBe(200); expect(salida.headers.get('Set-Cookie')).toContain('Max-Age=0');
    expect(await repo.leer(huella)).toMatchObject({ revocada: true });
  });
});

const crudo = (extra = {}) => ({ id: idA, huella: a, viajeId, creadaEn: 0, venceEn: 10,
  revocada: false, metadatosTexto: '{"dispositivoId":"ok"}', ...extra });
const respuesta = (valor: unknown) => ({ filas: [{ resultado: serializarProgreso(valor) }] });
describe('Frontera privada y captura estricta de sesiones SQL', () => {
  const fabrica = (resultado: unknown) => {
    const llamar = vi.fn(async (_sql: string, _parametros: readonly unknown[]) => resultado as { filas: readonly unknown[] });
    return { llamar, r: crearRepositorioSesionesSql({ viajeId, ejecutor: { ejecutar: llamar } }) };
  };
  it.each([
    { id: 'no-uuid' }, { huella: a.toUpperCase() }, { viajeId: 'ajeno' }, { dispositivoId: '' },
    { dispositivoId: 'é'.repeat(65) }, { dispositivoId: '\ud800' }, { nombreDispositivo: undefined },
    { nombreDispositivo: '📱'.repeat(81) }, { creadaEn: NaN }, { creadaEn: -1 }, { venceEn: 0 },
    { venceEn: Number.MAX_SAFE_INTEGER + 1 }, { revocada: 'false' }, { extra: true },
  ])('crear rechaza DTO inválido sin ejecutar SQL: %j', async (extra) => {
    const { r, llamar } = fabrica(respuesta({ tipo: 'creada' }));
    await expect(r.crear(registro(extra as Partial<RegistroSesion>))).rejects.toThrow(fallo);
    expect(llamar).not.toHaveBeenCalled();
  });
  it('getters/símbolos/prototipos extra se rechazan sin invocar accesores', async () => {
    const getter = vi.fn(() => 'oculto');
    for (const r of [Object.defineProperty(registro(), 'dispositivoId', { get: getter }),
      Object.assign(registro(), { [Symbol('extra')]: true }), Object.assign(Object.create(null), registro())]) {
      const { r: repo, llamar } = fabrica(respuesta({ tipo: 'creada' }));
      await expect(repo.crear(r)).rejects.toThrow(fallo); expect(llamar).not.toHaveBeenCalled();
    }
    expect(getter).not.toHaveBeenCalled();
  });
  it.each(['', 'x\0y', 'é'.repeat(65), '\ud800'])('configuración viaje %j falla de forma constante', (viaje) => {
    expect(() => crearRepositorioSesionesSql({ viajeId: viaje, ejecutor: { ejecutar } })).toThrow(fallo);
  });
  it('configuración completa rechaza getters y trampas de reflexión con error privado', () => {
    const getter = vi.fn(() => { throw new Error('postgres://privado'); });
    for (const config of [Object.defineProperty({ ejecutor: { ejecutar } }, 'viajeId', { get: getter }),
      { viajeId, ejecutor: Object.defineProperty({}, 'ejecutar', { get: getter }) },
      new Proxy({}, { ownKeys() { throw new Error('postgres://privado'); } })]) {
      expect(() => crearRepositorioSesionesSql(config as Parameters<typeof crearRepositorioSesionesSql>[0])).toThrow(fallo);
    }
    expect(getter).not.toHaveBeenCalled();
  });
  it('una consulta ligada por puerto; nunca interpola metadatos hostiles', async () => {
    const llamar = vi.fn(async (_sql: string, _parametros: readonly unknown[]) => respuesta({ tipo: 'creada' }));
    const r = crearRepositorioSesionesSql({ viajeId, ejecutor: { ejecutar: llamar } });
    await r.crear(registro({ nombreDispositivo: "'); DROP TABLE sesiones;--" }));
    expect(llamar).toHaveBeenCalledTimes(1);
    expect(llamar.mock.calls[0]).toHaveLength(2);
    expect(llamar.mock.calls[0]![0]).not.toContain('DROP');
  });
  it.each([
    null, {}, { filas: [] }, { filas: [{ resultado: 'null' }, { resultado: 'null' }] },
    { filas: [{ resultado: null }] }, { filas: [{ resultado: '{}' , extra: true }] },
    { filas: [{ resultado: '{mal' }] }, { filas: [{ resultado: '1e999' }] },
    { filas: [{ resultado: 'null' }], extra: true },
  ])('resultado RPC inválido nunca se convierte en ausencia: %j', async (rpc) => {
    await expect(fabrica(rpc).r.leer(a)).rejects.toThrow(fallo);
  });
  it('getters RPC no se ejecutan; array con propiedades/accesor no se acepta', async () => {
    const getter = vi.fn(() => 'null');
    const filas = [{ resultado: 'null' }]; Object.defineProperty(filas, 'extra', { value: 1 });
    for (const rpc of [{ filas: [Object.defineProperty({}, 'resultado', { get: getter })] },
      Object.defineProperty({}, 'filas', { get: getter }), { filas },
      { filas: Object.defineProperty([{}], '0', { get: getter }) }]) {
      await expect(fabrica(rpc).r.leer(a)).rejects.toThrow(fallo);
    }
    expect(getter).not.toHaveBeenCalled();
  });
  it.each([
    { revocada: 'false' }, { revocada: undefined }, { viajeId: 'ajeno' }, { huella: b },
    { id: 'mal' }, { creadaEn: 11 }, { extra: true }, { metadatosTexto: '{}' },
    { metadatosTexto: '{"dispositivoId":"ok","nombreDispositivo":null}' },
    { metadatosTexto: '{"dispositivoId":"ok","huella":"extra"}' },
  ])('fila inválida falla cerrada: %j', async (extra) => {
    // undefined elimina una autoridad requerida, no equivale a false.
    const valor = crudo(extra); if (extra.revocada === undefined && Object.hasOwn(extra, 'revocada')) delete (valor as Partial<typeof valor>).revocada;
    await expect(fabrica(respuesta(valor)).r.leer(a)).rejects.toThrow(fallo);
  });
  it.each([
    { tipo: 'lista', sesiones: [crudo(), crudo()] }, { tipo: 'lista', sesiones: [crudo({ viajeId: 'ajeno' })] },
    { tipo: 'lista', sesiones: [crudo({ id: idB, huella: b })] }, { tipo: 'lista', sesiones: 'no-array' },
    { tipo: 'sin-sesion', extra: true }, { tipo: 'otro' },
  ])('lista rechaza duplicados, alcance, identidad de actor y sobres inválidos', async (valor) => {
    await expect(fabrica(respuesta(valor)).r.listar(a, viajeId)).rejects.toThrow(fallo);
  });
  it.each(['REVOCADA', false, null, { tipo: 'revocada', extra: true }, { tipo: '404' }])('enum revocación inválido no es 404: %j', async (valor) => {
    await expect(fabrica(respuesta(valor)).r.revocarOtra(a, viajeId, idB)).rejects.toThrow(fallo);
  });
  it('DTO crudo con igualdad temporal conserva contrato del controlador; crear no lo acepta', async () => {
    expect(await fabrica(respuesta(crudo({ creadaEn: 10 }))).r.leer(a)).toMatchObject({ creadaEn: 10, venceEn: 10 });
    const { r, llamar } = fabrica(respuesta({ tipo: 'creada' }));
    await expect(r.crear(registro({ creadaEn: 10, venceEn: 10 }))).rejects.toThrow(fallo);
    expect(llamar).not.toHaveBeenCalled();
  });
  it('límites inclusivos Unicode y revocada true se conservan como datos, no se normalizan', async () => {
    const { r, llamar } = fabrica(respuesta({ tipo: 'creada' }));
    await r.crear(registro({ dispositivoId: 'é'.repeat(64), nombreDispositivo: '📱'.repeat(80), revocada: true }));
    expect(llamar.mock.calls[0]![1]).toEqual([idA, a, viajeId, 0, Number.MAX_SAFE_INTEGER, true,
      serializarProgreso({ dispositivoId: 'é'.repeat(64), nombreDispositivo: '📱'.repeat(80) })]);
  });
  it('cada uno de los otros cuatro puertos tiene un único SELECT con alcance ligado', async () => {
    const llamar = vi.fn(async (sql: string, _parametros: readonly unknown[]) => respuesta(
      sql.includes('leer_sesion') ? null : { tipo: sql.includes('listar_sesiones') ? 'sin-sesion' : 'revocada' }));
    const r = crearRepositorioSesionesSql({ viajeId, ejecutor: { ejecutar: llamar } });
    await r.leer(a); await r.revocar(a, viajeId); await r.listar(a, viajeId); await r.revocarOtra(a, viajeId, idB);
    expect(llamar.mock.calls).toEqual([
      ['SELECT itinerario.leer_sesion($1, $2) AS resultado', [a, viajeId]],
      ['SELECT itinerario.revocar_sesion($1, $2) AS resultado', [a, viajeId]],
      ['SELECT itinerario.listar_sesiones($1, $2) AS resultado', [a, viajeId]],
      ['SELECT itinerario.revocar_otra_sesion($1, $2, $3) AS resultado', [a, viajeId, idB]],
    ]);
  });
  it('captura antes de await, no retiene el registro mutable ni confirma void anticipadamente', async () => {
    let resolver!: (v: { filas: readonly unknown[] }) => void;
    const pendiente = new Promise<{ filas: readonly unknown[] }>((r) => { resolver = r; });
    const llamar = vi.fn((_sql: string, _parametros: readonly unknown[]) => pendiente);
    const r = crearRepositorioSesionesSql({ viajeId, ejecutor: { ejecutar: llamar } });
    const entrada = { ...registro() }; let resuelta = false;
    const accion = r.crear(entrada).then(() => { resuelta = true; });
    entrada.dispositivoId = 'modificado'; entrada.nombreDispositivo = 'modificado';
    await Promise.resolve(); expect(resuelta).toBe(false);
    expect(llamar.mock.calls[0]![1]![6]).toBe(serializarProgreso({ dispositivoId: 'móvil\0设备', nombreDispositivo: ' teléfono\0📱 ' }));
    resolver(respuesta({ tipo: 'creada' })); await accion; expect(resuelta).toBe(true);
  });
  it.each([null, { tipo: 'creada', extra: true }, { tipo: 'revocada' }])('crear no acepta falso acuse %j', async (v) => {
    await expect(fabrica(respuesta(v)).r.crear(registro())).rejects.toThrow(fallo);
  });
  it.each([null, { tipo: 'revocada', extra: true }, { tipo: 'ausente' }])('revocar no acepta falso acuse %j', async (v) => {
    await expect(fabrica(respuesta(v)).r.revocar(a, viajeId)).rejects.toThrow(fallo);
  });
  it('otros argumentos inválidos no tocan SQL', async () => {
    const { r, llamar } = fabrica(respuesta(null));
    for (const accion of [() => r.leer('bad'), () => r.revocar(a, 'ajeno'),
      () => r.listar(a, 'ajeno'), () => r.revocarOtra(a, 'ajeno', idB), () => r.revocarOtra(a, viajeId, 'bad')]) {
      await expect(accion()).rejects.toThrow(fallo);
    }
    expect(llamar).not.toHaveBeenCalled();
  });
  it('errores originales no exponen causa, DSN, token ni logs', async () => {
    const error = new Error('postgres://secreto token');
    const r = crearRepositorioSesionesSql({ viajeId, ejecutor: { async ejecutar() { throw error; } } });
    try { await r.leer(a); expect.fail('debe fallar'); } catch (e) {
      expect((e as Error).message).toBe(fallo); expect(Object.hasOwn(e as object, 'cause')).toBe(false);
    }
  });
});
