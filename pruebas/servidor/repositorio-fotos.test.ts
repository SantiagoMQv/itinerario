import { readFile } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Itinerario } from '../../src/tipos';
import { crearProgreso } from '../../src/progreso';
import { serializarProgreso } from '../../src/progreso-json';
import { deserializarSolicitudRespaldo, serializarReciboRespaldo, serializarSolicitudRespaldo } from '../../src/fotos-protocolo';
import { crearRepositorioFotosSql } from '../../servidor/repositorio-fotos';
import { crearEjecutorNeon } from '../../servidor/ejecutor-neon';
import { crearAlmacenFotos, type ObjetosFotos, type ResultadoReservaFotos } from '../../servidor/almacen-fotos';
import { crearVigenciaFotos } from '../../servidor/multipart-fotos';

const plan: Itinerario = { id: 'viaje', titulo: 'Prueba', dias: [{ fecha: '2026-10-21', titulo: 'Día',
  paradas: [{ id: 'a', nombre: 'A', hora: '10:00', categoria: 'museo', lat: 31, lng: 121 }] }] };
const actor = 'a'.repeat(64);
const fotoId = 'ABCDEF12-1234-4234-8234-123456789012';
const operacionId = '12345678-1234-4234-8234-123456789012';
const solicitud = serializarSolicitudRespaldo(plan, { version: 1, tipo: 'solicitud-respaldo', viajeId: plan.id,
  fotoId, operacionId, original: { formato: 1, fotoId, destino: { tipo: 'parada', viajeId: plan.id, paradaId: 'a' },
    nombre: 'e\u0301\0.jpg', mimeDeclarado: 'IMAGE/HEIC\0', ultimaModificacion: -0, incorporada: -0, bytesOriginal: 3 } });
let db: PGlite;
const repositorio = crearRepositorioFotosSql({ plan, ejecutor: { async ejecutar(q, p) {
  return { filas: (await db.query(q, [...p])).rows };
} } });

describe('Repositorio fotos: PostgreSQL local de una conexión, sin proveedor', () => {
  beforeAll(async () => {
    db = await PGlite.create('memory://');
    for (const nombre of ['001_base.sql', '002_progreso.sql', '003_sesiones.sql', '004_limite.sql', '005_fotos.sql']) {
      await db.exec(await readFile(new URL('../../servidor/migraciones/' + nombre, import.meta.url), 'utf8'));
    }
    await db.query('INSERT INTO itinerario.viajes VALUES ($1,0,$2)', [plan.id, serializarProgreso(crearProgreso(plan))]);
    await db.query('INSERT INTO itinerario.sesiones VALUES ($1,$2,$3,0,9007199254740991,false,$4)',
      [operacionId, actor, plan.id, '{}']);
  }, 30000);
  afterAll(async () => { await db?.close(); });
  it('reserva nueva válida concede ganadora sólo a su inserción', async () => {
    expect(await repositorio.reservar(actor, plan.id, solicitud)).toMatchObject({ tipo: 'ganadora', reserva: { solicitudCanonica: solicitud } });
  });
  it('sesión desconocida no obtiene reserva ni identidad', async () => {
    expect(await repositorio.reservar('b'.repeat(64), plan.id, solicitud)).toEqual({ tipo: 'sin-sesion' });
  });
  it('NUL y marcadores de cabecera dentro de metadata no rompen el vínculo de texto', async () => {
    const texto = solicitud.replace('12345678-1234-4234-8234-123456789012', '22345678-1234-4234-8234-123456789012')
      .replaceAll(fotoId, 'BBCDEF12-1234-4234-8234-123456789012');
    const marcador = texto.replace('é\\u0000.jpg', 'é\\u0000\\\"original\\\":}\\\\.jpg');
    const resultado = await repositorio.reservar(actor, plan.id, marcador);
    expect(resultado).toMatchObject({ tipo: 'ganadora', reserva: { solicitudCanonica: marcador } });
  });
  it('leer una foto sin confirmación no concede ACK', async () => {
    expect(await repositorio.leerConfirmada(actor, plan.id, fotoId)).toEqual({ tipo: 'ausente' });
  });
  it.each(['{}', 'false', solicitud])('recibo corrupto %s no confirma una reserva', async (recibo) => {
    await db.exec('BEGIN');
    try {
      await db.query('UPDATE itinerario.fotos_operaciones SET recibo_canonico=$1 WHERE viaje_id=$2 AND operacion_id=$3',
        [recibo, plan.id, operacionId]);
      await expect(repositorio.leerConfirmada(actor, plan.id, fotoId)).rejects.toThrow('No se pudo comprobar las fotos.');
    } finally { await db.exec('ROLLBACK'); }
  });
  it('finalizar produce su recibo exacto y consultar conserva la reserva inicial', async () => {
    const reserva = await repositorio.reservar(actor, plan.id, solicitud) as ResultadoReservaFotos;
    expect(reserva.tipo).toBe('existente');
    if (reserva.tipo !== 'existente') throw new Error('Fixture sin reserva');
    const recibo = serializarReciboRespaldo(plan, { ...deserializarSolicitudRespaldo(plan, solicitud),
      tipo: 'acuse-respaldo', objetoOriginalDurable: true, metadatosDurables: true });
    expect(await repositorio.finalizar(actor, plan.id, reserva.reserva, solicitud))
      .toEqual({ tipo: 'confirmada', reciboCanonico: recibo });
    expect(await repositorio.finalizar(actor, plan.id, reserva.reserva, solicitud))
      .toEqual({ tipo: 'confirmada', reciboCanonico: recibo });
    expect(await repositorio.leerConfirmada(actor, plan.id, fotoId))
      .toEqual({ tipo: 'confirmada', reserva: reserva.reserva });
  });
  it('otra operación compatible conserva el inicial y crea únicamente su propio ACK', async () => {
    const otra = solicitud.replace(operacionId, '32345678-1234-4234-8234-123456789012');
    const reserva = await repositorio.reservar(actor, plan.id, otra) as ResultadoReservaFotos;
    expect(reserva.tipo).toBe('existente');
    if (reserva.tipo !== 'existente') throw new Error('Fixture sin reserva');
    expect(reserva.reserva.solicitudCanonica).toBe(solicitud);
    expect((await db.query('SELECT * FROM itinerario.fotos_operaciones WHERE operacion_id=$1',
      ['32345678-1234-4234-8234-123456789012'])).rows).toHaveLength(0);
    const final = await repositorio.finalizar(actor, plan.id, reserva.reserva, otra);
    expect(final).toEqual({ tipo: 'confirmada', reciboCanonico: serializarReciboRespaldo(plan,
      { ...deserializarSolicitudRespaldo(plan, otra), tipo: 'acuse-respaldo',
        objetoOriginalDurable: true, metadatosDurables: true }) });
    expect(await repositorio.leerConfirmada(actor, plan.id, fotoId))
      .toEqual({ tipo: 'confirmada', reserva: reserva.reserva });
  });
  it.each(['"objetoOriginalDurable":false', '"metadatosDurables":false'])('recibo con bit falso %s falla cerrado', async (campo) => {
    const recibo = serializarReciboRespaldo(plan, { ...deserializarSolicitudRespaldo(plan, solicitud),
      tipo: 'acuse-respaldo', objetoOriginalDurable: true, metadatosDurables: true });
    await db.exec('BEGIN');
    try {
      await db.query('UPDATE itinerario.fotos_operaciones SET recibo_canonico=$1 WHERE operacion_id=$2',
        [recibo.replace(campo.replace('false', 'true'), campo), operacionId]);
      await expect(repositorio.leerConfirmada(actor, plan.id, fotoId)).rejects.toThrow('No se pudo comprobar las fotos.');
    } finally { await db.exec('ROLLBACK'); }
  });
  it('otra operación no puede confirmar con recibo de la inicial', async () => {
    const recibo = serializarReciboRespaldo(plan, { ...deserializarSolicitudRespaldo(plan, solicitud),
      tipo: 'acuse-respaldo', objetoOriginalDurable: true, metadatosDurables: true });
    await db.exec('BEGIN');
    try {
      await db.query('UPDATE itinerario.fotos_operaciones SET recibo_canonico=$1 WHERE operacion_id=$2',
        [recibo, '32345678-1234-4234-8234-123456789012']);
      await expect(repositorio.leerConfirmada(actor, plan.id, fotoId)).rejects.toThrow('No se pudo comprobar las fotos.');
    } finally { await db.exec('ROLLBACK'); }
  });
  it('asociación inicial ausente falla cerrado sin reparación', async () => {
    await db.exec('BEGIN');
    try {
      await db.query('UPDATE itinerario.fotos_operaciones SET solicitud_canonica=$1 WHERE operacion_id=$2',
        [solicitud.replace('é', 'é'), operacionId]);
      await expect(repositorio.reservar(actor, plan.id, solicitud)).resolves.toEqual({ tipo: 'contradiccion' });
      await expect(repositorio.leerConfirmada(actor, plan.id, fotoId)).rejects.toThrow('No se pudo comprobar las fotos.');
    } finally { await db.exec('ROLLBACK'); }
  });
  it.each([solicitud.replaceAll('-0', '0'), solicitud.replace('é', 'é'), solicitud.replace('IMAGE/HEIC', 'image/heic')])
    ('original diferente conserva contradicción exacta', async (texto) => {
      expect(await repositorio.reservar(actor, plan.id, texto)).toEqual({ tipo: 'contradiccion' });
    });
  it('identidad de foto distingue mayúsculas', async () => {
    expect(await repositorio.leerConfirmada(actor, plan.id, fotoId.toLowerCase())).toEqual({ tipo: 'ausente' });
  });
  it.each(['revocada=true', 'vence_en=1', "viaje_id='otro'"])
    ('sesión %s no accede a reserva/final/consulta', async (cambio) => {
      const reserva = await repositorio.reservar(actor, plan.id, solicitud) as ResultadoReservaFotos;
      if (reserva.tipo !== 'existente') throw new Error('Fixture sin reserva');
      await db.exec('BEGIN');
      try {
        if (cambio.includes('otro')) await db.query('INSERT INTO itinerario.viajes VALUES ($1,0,$2)',
          ['otro', serializarProgreso(crearProgreso(plan))]);
        await db.exec('UPDATE itinerario.sesiones SET ' + cambio);
        expect(await repositorio.reservar(actor, plan.id, solicitud)).toEqual({ tipo: 'sin-sesion' });
        expect(await repositorio.finalizar(actor, plan.id, reserva.reserva, solicitud)).toEqual({ tipo: 'sin-sesion' });
        expect(await repositorio.leerConfirmada(actor, plan.id, fotoId)).toEqual({ tipo: 'sin-sesion' });
      } finally { await db.exec('ROLLBACK'); }
    });
  it('resultado pendiente del ejecutor no concede ganador y captura puerto/plan antes de await', async () => {
    const texto = solicitud.replaceAll(fotoId, 'FBCDEF12-1234-4234-8234-123456789012')
      .replace(operacionId, '72345678-1234-4234-8234-123456789012');
    let liberar!: () => void; let avisar!: () => void;
    const pendienteCommit = new Promise<void>((r) => { liberar = r; });
    const invocada = new Promise<void>((r) => { avisar = r; });
    const copiaPlan = structuredClone(plan);
    const puerto = { async ejecutar(q: string, p: readonly unknown[]) {
      expect(Object.isFrozen(p)).toBe(true);
      const resultado = await db.query(q, [...p]); avisar();
      await pendienteCommit;
      return { filas: resultado.rows };
    } };
    const repo = crearRepositorioFotosSql({ plan: copiaPlan, ejecutor: puerto });
    let resuelta = false;
    const operacion = repo.reservar(actor, plan.id, texto).then((valor) => { resuelta = true; return valor; });
    await invocada;
    Object.defineProperty(copiaPlan, 'id', { value: 'mutado' }); puerto.ejecutar = vi.fn(() => { throw new Error('No usar puerto mutado'); });
    expect(resuelta).toBe(false); liberar();
    expect(await operacion).toMatchObject({ tipo: 'ganadora' });
    expect(await repo.reservar(actor, plan.id, texto)).toMatchObject({ tipo: 'existente' });
  });
  it('respuesta de reserva perdida no reintenta ni recupera permiso ganador', async () => {
    const texto = solicitud.replaceAll(fotoId, 'ABCDEF12-1234-4234-8234-123456789013')
      .replace(operacionId, '82345678-1234-4234-8234-123456789012');
    const ejecutar = vi.fn(async (q: string, p: readonly unknown[]) => {
      await db.query(q, [...p]); throw new Error('Respuesta perdida simulada');
    });
    const repo = crearRepositorioFotosSql({ plan, ejecutor: { ejecutar } });
    await expect(repo.reservar(actor, plan.id, texto)).rejects.toThrow('No se pudo comprobar las fotos.');
    expect(ejecutar).toHaveBeenCalledTimes(1);
    expect(await repositorio.reservar(actor, plan.id, texto)).toMatchObject({ tipo: 'existente' });
    expect(await repositorio.leerConfirmada(actor, plan.id, 'ABCDEF12-1234-4234-8234-123456789013'))
      .toEqual({ tipo: 'ausente' });
  });
  it.each(['igual', 'ultimo-byte', 'corto', 'largo', 'ausente', 'revocada'])
    ('composición A+B compara >1MiB y EOF sin segundo PUT: %s', async (caso) => {
      await db.exec('BEGIN');
      const vigencia = crearVigenciaFotos(new AbortController().signal, 10000);
      try {
        const datos = new Uint8Array(1048581); datos[datos.length - 1] = 7;
        const base = deserializarSolicitudRespaldo(plan, solicitud);
        const s = { ...base, fotoId: 'EBCDEF12-1234-4234-8234-123456789012',
          operacionId: '62345678-1234-4234-8234-123456789012', original: { ...base.original,
            fotoId: 'EBCDEF12-1234-4234-8234-123456789012', bytesOriginal: datos.length } };
        let guardado: Blob | null = null; let inicial = ''; let modo = 'igual';
        const poner = vi.fn(async (_clave: string, blob: Blob, texto: string) => {
          guardado = blob; inicial = texto; return true;
        });
        const objetos: ObjetosFotos = { ponerSiAusente: poner, async leer(claveObjeto) {
          if (!guardado || modo === 'ausente') return null;
          let bytes = new Uint8Array(await guardado.arrayBuffer());
          if (modo === 'ultimo-byte') bytes[bytes.length - 1] ^= 1;
          if (modo === 'corto') bytes = bytes.slice(0, -1);
          if (modo === 'largo') { const largos = new Uint8Array(bytes.length + 1); largos.set(bytes); bytes = largos; }
          let offset = 0;
          return { claveObjeto, solicitudCanonica: inicial, original: new ReadableStream<Uint8Array>({
            pull(controlador) {
              if (offset === bytes.length) { controlador.close(); return; }
              const fin = Math.min(offset + 65536, bytes.length);
              controlador.enqueue(bytes.slice(offset, fin)); offset = fin;
            },
          }) };
        } };
        const almacen = crearAlmacenFotos({ plan, repositorio, objetos });
        const contexto = { huellaActor: actor, vigencia, reautenticar: async () => {
          if (modo === 'revocada') await db.exec('UPDATE itinerario.sesiones SET revocada=true');
          return true;
        }, presupuesto: { maxBytesOriginal: 2000000, maxBytesEntrada: 2200000, maxBytesChunk: 65536,
          maxBytesCabeceras: 1024, maxBytesRetenidos: 8000000, maxBloquesOriginal: 100,
          bytesBloque: 65536, plazoMs: 10000 } };
        const captura = { solicitud: s, original: new Blob([datos]) };
        expect(await almacen.respaldar(captura, contexto)).toMatchObject({ primera: true });
        modo = caso;
        if (caso === 'igual') expect(await almacen.respaldar(captura, contexto)).toMatchObject({ primera: false });
        else await expect(almacen.respaldar(captura, contexto)).rejects.toMatchObject({ codigo:
          caso === 'ausente' ? 503 : caso === 'revocada' ? 401 : 409 });
        expect(poner).toHaveBeenCalledTimes(1);
      } finally { vigencia.cerrar(); await db.exec('ROLLBACK'); }
    });
  it('SDK real usa sólo fetch sustituido y ejecuta reserva/final/consulta SQL real local', async () => {
    const llamadas: { query: string; params: string[] }[] = [];
    const fetchLocal = vi.fn(async (_destino: unknown, opciones: RequestInit) => {
      const entrada = JSON.parse(String(opciones.body)) as { query: string; params: string[] };
      expect(entrada.query).toMatch(/^SELECT itinerario\.(reservar_foto|finalizar_foto|consultar_foto)\(/);
      llamadas.push(entrada);
      const resultado = await db.query<{ resultado: string }>(entrada.query, entrada.params);
      return new Response(JSON.stringify({ command: 'SELECT', rowCount: resultado.rows.length,
        fields: [{ name: 'resultado', dataTypeID: 25, tableID: 0, columnID: 0,
          dataTypeSize: -1, dataTypeModifier: -1, format: 'text' }],
        rows: resultado.rows.map((fila) => [fila.resultado]) }));
    });
    vi.stubGlobal('fetch', fetchLocal);
    try {
      const repo = crearRepositorioFotosSql({ plan, ejecutor: crearEjecutorNeon({
        urlBaseDatos: 'postgresql://prueba:clave-sintetica@ep-prueba.eu-central-1.aws.neon.tech/prueba?sslmode=require' }) });
      const texto = solicitud.replaceAll(fotoId, 'CBCDEF12-1234-4234-8234-123456789012')
        .replace(operacionId, '42345678-1234-4234-8234-123456789012');
      const reserva = await repo.reservar(actor, plan.id, texto) as ResultadoReservaFotos;
      expect(reserva.tipo).toBe('ganadora');
      if (reserva.tipo !== 'ganadora') throw new Error('Fixture sin ganadora');
      expect(llamadas[0].params[4]).toBe(texto);
      expect(llamadas[0].params[5]).toContain('"ultimaModificacion":-0');
      expect(llamadas[0].params[5]).toContain('\\u0000');
      expect(await repo.finalizar(actor, plan.id, reserva.reserva, texto)).toMatchObject({ tipo: 'confirmada' });
      expect(await repo.leerConfirmada(actor, plan.id, 'CBCDEF12-1234-4234-8234-123456789012'))
        .toEqual({ tipo: 'confirmada', reserva: reserva.reserva });
      expect(fetchLocal).toHaveBeenCalledTimes(3);
      expect(llamadas.map((llamada) => llamada.params.length)).toEqual([8, 10, 3]);
    } finally { vi.unstubAllGlobals(); }
  });
  it('excepción postDML revierte reserva, operación y revocación del trigger', async () => {
    const texto = solicitud.replaceAll(fotoId, 'DBCDEF12-1234-4234-8234-123456789012')
      .replace(operacionId, '52345678-1234-4234-8234-123456789012');
    await db.exec('BEGIN');
    await db.exec(`CREATE FUNCTION itinerario.prueba_revocar_fotos() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN UPDATE itinerario.sesiones SET revocada=true; RETURN NEW; END $$;
      CREATE TRIGGER prueba_revocar_fotos AFTER INSERT ON itinerario.fotos_operaciones
      FOR EACH ROW EXECUTE FUNCTION itinerario.prueba_revocar_fotos();`);
    // DDL del fixture propio queda en una transacción que se revierte completa.
    try {
      await expect(repositorio.reservar(actor, plan.id, texto)).rejects.toThrow('No se pudo comprobar las fotos.');
    } finally { await db.exec('ROLLBACK'); }
    expect((await db.query('SELECT * FROM itinerario.fotos_reservas WHERE foto_id=$1',
      ['DBCDEF12-1234-4234-8234-123456789012'])).rows).toHaveLength(0);
    expect((await db.query('SELECT * FROM itinerario.fotos_operaciones WHERE operacion_id=$1',
      ['52345678-1234-4234-8234-123456789012'])).rows).toHaveLength(0);
    expect(await repositorio.reservar(actor, plan.id, solicitud)).toMatchObject({ tipo: 'existente' });
  });
  it.each(['viaje', 'foto', 'operacion', 'original', 'body'])
    ('SQL reserva rechaza argumentos discordantes: %s', async (campo) => {
      let consulta = ''; let parametros: readonly unknown[] = [];
      const repo = crearRepositorioFotosSql({ plan, ejecutor: { async ejecutar(q, p) {
        consulta = q; parametros = p; return { filas: (await db.query(q, [...p])).rows };
      } } });
      await repo.reservar(actor, plan.id, solicitud);
      const p = [...parametros];
      if (campo === 'viaje') p[1] = 'otro';
      if (campo === 'foto') p[2] = fotoId.toLowerCase();
      if (campo === 'operacion') p[3] = '92345678-1234-4234-8234-123456789012';
      if (campo === 'original') p[5] = String(p[5]).replace('-0', '0');
      if (campo === 'body') p[4] = solicitud + '{}';
      await expect(db.query(consulta, p)).rejects.toThrow('No se pudo comprobar las fotos.');
      expect(await repositorio.reservar(actor, plan.id, solicitud)).toMatchObject({ tipo: 'existente' });
    });
  it.each(['viaje', 'foto', 'operacion', 'original', 'body', 'bit-objeto', 'bit-metadata', 'recibo-body'])
    ('SQL final rechaza argumentos discordantes: %s', async (campo) => {
      const r = await repositorio.reservar(actor, plan.id, solicitud) as ResultadoReservaFotos;
      if (r.tipo !== 'existente') throw new Error('Fixture sin reserva');
      let consulta = ''; let parametros: readonly unknown[] = [];
      const repo = crearRepositorioFotosSql({ plan, ejecutor: { async ejecutar(q, p) {
        consulta = q; parametros = p; return { filas: (await db.query(q, [...p])).rows };
      } } });
      await repo.finalizar(actor, plan.id, r.reserva, solicitud);
      const p = [...parametros];
      if (campo === 'viaje') p[1] = 'otro';
      if (campo === 'foto') p[2] = fotoId.toLowerCase();
      if (campo === 'operacion') p[3] = '92345678-1234-4234-8234-123456789012';
      if (campo === 'original') p[5] = String(p[5]).replace('-0', '0');
      if (campo === 'body') p[4] = solicitud + '{}';
      if (campo === 'bit-objeto') p[9] = String(p[9]).replace('"objetoOriginalDurable":true', '"objetoOriginalDurable":false');
      if (campo === 'bit-metadata') p[9] = String(p[9]).replace('"metadatosDurables":true', '"metadatosDurables":false');
      if (campo === 'recibo-body') p[9] = String(p[9]).replace('-0', '0');
      const antes = (await db.query('SELECT * FROM itinerario.fotos_operaciones ORDER BY operacion_id')).rows;
      await expect(db.query(consulta, p)).rejects.toThrow('No se pudo comprobar las fotos.');
      expect((await db.query('SELECT * FROM itinerario.fotos_operaciones ORDER BY operacion_id')).rows).toEqual(antes);
    });
  it.each(['reserva', 'clave', 'inicial'])('SQL final no reata reserva discordante: %s', async (campo) => {
    const r = await repositorio.reservar(actor, plan.id, solicitud) as ResultadoReservaFotos;
    if (r.tipo !== 'existente') throw new Error('Fixture sin reserva');
    let consulta = ''; let parametros: readonly unknown[] = [];
    const repo = crearRepositorioFotosSql({ plan, ejecutor: { async ejecutar(q, p) {
      consulta = q; parametros = p; return { filas: (await db.query(q, [...p])).rows };
    } } });
    await repo.finalizar(actor, plan.id, r.reserva, solicitud);
    const p = [...parametros];
    if (campo === 'reserva') p[6] = '92345678-1234-4234-8234-123456789012';
    if (campo === 'clave') p[7] = String(p[7]) + '/ajena';
    if (campo === 'inicial') p[8] = solicitud.replace('-0', '0');
    expect((await db.query<{ resultado: string }>(consulta, p)).rows)
      .toEqual([{ resultado: '{"tipo":"contradiccion"}' }]);
    expect(await repositorio.leerConfirmada(actor, plan.id, fotoId)).toEqual({ tipo: 'confirmada', reserva: r.reserva });
  });
  it.each(['reserva', 'clave'])('colisión única ajena no adopta ni crea filas: %s', async (campo) => {
    const r = await repositorio.reservar(actor, plan.id, solicitud) as ResultadoReservaFotos;
    if (r.tipo !== 'existente') throw new Error('Fixture sin reserva');
    const texto = solicitud.replaceAll(fotoId, 'ABCDEF12-1234-4234-8234-123456789099')
      .replace(operacionId, '92345678-1234-4234-8234-123456789012');
    let consulta = ''; let parametros: readonly unknown[] = [];
    const capturar = crearRepositorioFotosSql({ plan, ejecutor: { async ejecutar(q, p) {
      consulta = q; parametros = p; throw new Error('Sólo captura sintética');
    } } });
    await expect(capturar.reservar(actor, plan.id, texto)).rejects.toThrow('No se pudo comprobar las fotos.');
    const p = [...parametros];
    if (campo === 'reserva') p[6] = r.reserva.reservaId;
    if (campo === 'clave') p[7] = r.reserva.claveObjeto;
    const antes = (await db.query('SELECT * FROM itinerario.fotos_reservas ORDER BY foto_id')).rows;
    await expect(db.query(consulta, p)).rejects.toThrow(/unique constraint/);
    expect((await db.query('SELECT * FROM itinerario.fotos_reservas ORDER BY foto_id')).rows).toEqual(antes);
    expect((await db.query('SELECT * FROM itinerario.fotos_operaciones WHERE operacion_id=$1', [p[3]])).rows).toHaveLength(0);
  });
  it('dos editores con mismo dispositivo tienen iguales derechos sin cambiar el inicial', async () => {
    await db.exec('BEGIN');
    try {
      const segundo = 'c'.repeat(64);
      const metadata = '{"dispositivoId":"mismo-dispositivo"}';
      await db.query('UPDATE itinerario.sesiones SET metadatos_json=$1 WHERE huella=$2', [metadata, actor]);
      await db.query('INSERT INTO itinerario.sesiones VALUES ($1,$2,$3,0,9007199254740991,false,$4)',
        ['92345678-1234-4234-8234-123456789012', segundo, plan.id, metadata]);
      const texto = solicitud.replace(operacionId, '92345678-1234-4234-8234-123456789012');
      const r = await repositorio.reservar(segundo, plan.id, texto) as ResultadoReservaFotos;
      expect(r.tipo).toBe('existente');
      if (r.tipo !== 'existente') throw new Error('Fixture sin reserva');
      expect(r.reserva.solicitudCanonica).toBe(solicitud);
      expect(await repositorio.finalizar(segundo, plan.id, r.reserva, texto)).toMatchObject({ tipo: 'confirmada' });
      expect(await repositorio.leerConfirmada(segundo, plan.id, fotoId)).toEqual({ tipo: 'confirmada', reserva: r.reserva });
      expect(await repositorio.leerConfirmada(actor, plan.id, fotoId)).toEqual({ tipo: 'confirmada', reserva: r.reserva });
    } finally { await db.exec('ROLLBACK'); }
  });
  it('cabeceras SQL escalares equivalen a JS con comillas, barras y delimitadores', async () => {
    const viaje = 'v"\\} é'; const prefijo = '{"version":1,"tipo":"solicitud-respaldo","viajeId":'
      + JSON.stringify(viaje) + ',"operacionId":' + JSON.stringify(operacionId)
      + ',"fotoId":' + JSON.stringify(fotoId) + ',"original":';
    expect((await db.query<{ valor: string }>('SELECT itinerario.fotos_cabecera($1,$2,$3,$4) AS valor',
      ['solicitud-respaldo', viaje, operacionId, fotoId])).rows[0].valor).toBe(prefijo);
  });
  it.each(['"original":}\\\\', '} ,"metadatosDurables":true}', '{"version":1,"tipo":"acuse-respaldo"'])
    ('marcadores dentro de nombre y MIME no delimitan el fragmento: %s', async (marcador) => {
      await db.exec('BEGIN');
      try {
        const base = deserializarSolicitudRespaldo(plan, solicitud);
        const s = { ...base, fotoId: 'ABCDEF12-1234-4234-8234-123456789098',
          operacionId: '92345678-1234-4234-8234-123456789012', original: { ...base.original,
            fotoId: 'ABCDEF12-1234-4234-8234-123456789098', nombre: marcador + '\0é', mimeDeclarado: marcador + '\0' } };
        const texto = serializarSolicitudRespaldo(plan, s);
        const r = await repositorio.reservar(actor, plan.id, texto) as ResultadoReservaFotos;
        expect(r.tipo).toBe('ganadora');
        if (r.tipo !== 'ganadora') throw new Error('Fixture sin reserva');
        expect(await repositorio.finalizar(actor, plan.id, r.reserva, texto)).toEqual({ tipo: 'confirmada',
          reciboCanonico: serializarReciboRespaldo(plan, { ...s, tipo: 'acuse-respaldo',
            objetoOriginalDurable: true, metadatosDurables: true }) });
        expect(await repositorio.leerConfirmada(actor, plan.id, s.fotoId)).toEqual({ tipo: 'confirmada', reserva: r.reserva });
      } finally { await db.exec('ROLLBACK'); }
    });
  it('reloj fresco tras demora previa al statement: modelo local, no espera de lock remoto', async () => {
    await db.exec('BEGIN');
    try {
      await db.exec(`UPDATE itinerario.sesiones SET vence_en=floor(extract(epoch FROM clock_timestamp())*1000)::bigint+20;
        SELECT pg_sleep(0.04);`);
      const texto = solicitud.replaceAll(fotoId, 'ABCDEF12-1234-4234-8234-123456789097')
        .replace(operacionId, '92345678-1234-4234-8234-123456789012');
      expect(await repositorio.reservar(actor, plan.id, texto)).toEqual({ tipo: 'sin-sesion' });
      expect((await db.query('SELECT * FROM itinerario.fotos_reservas WHERE foto_id=$1',
        ['ABCDEF12-1234-4234-8234-123456789097'])).rows).toHaveLength(0);
    } finally { await db.exec('ROLLBACK'); }
  });
  it.each(['revocacion', 'caducidad'])('final postDML %s lanza excepción y revierte todos los datos', async (caso) => {
    const foto = caso === 'revocacion' ? 'ABCDEF12-1234-4234-8234-123456789096' : 'ABCDEF12-1234-4234-8234-123456789094';
    const op = caso === 'revocacion' ? '92345678-1234-4234-8234-123456789012' : 'A2345678-1234-4234-8234-123456789012';
    const texto = solicitud.replaceAll(fotoId, foto).replace(operacionId, op);
    const r = await repositorio.reservar(actor, plan.id, texto) as ResultadoReservaFotos;
    if (r.tipo !== 'ganadora') throw new Error('Fixture sin ganadora');
    const tablas = (await db.query<{ tablename: string }>(
      'SELECT tablename FROM pg_tables WHERE schemaname=$1 ORDER BY tablename', ['itinerario'])).rows;
    const capturar = async () => Promise.all(tablas.map(async ({ tablename }) =>
      (await db.query('SELECT row_to_json(t)::text AS fila FROM itinerario.' + tablename + ' t ORDER BY row_to_json(t)::text')).rows));
    const antes = await capturar();
    await db.exec('BEGIN');
    try {
      await db.exec(`CREATE FUNCTION itinerario.prueba_final_fotos() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN ${caso === 'revocacion' ? 'UPDATE itinerario.sesiones SET revocada=true;' :
          'UPDATE itinerario.sesiones SET vence_en=floor(extract(epoch FROM clock_timestamp())*1000)::bigint+20; PERFORM pg_sleep(0.04);'}
        RETURN NEW; END $$;
        CREATE TRIGGER prueba_final_fotos AFTER UPDATE ON itinerario.fotos_operaciones
        FOR EACH ROW EXECUTE FUNCTION itinerario.prueba_final_fotos();`);
      await expect(repositorio.finalizar(actor, plan.id, r.reserva, texto)).rejects.toThrow('No se pudo comprobar las fotos.');
    } finally { await db.exec('ROLLBACK'); }
    expect(await capturar()).toEqual(antes);
    expect((await db.query('SELECT recibo_canonico FROM itinerario.fotos_operaciones WHERE operacion_id=$1',
      [op])).rows).toEqual([{ recibo_canonico: null }]);
    expect(await repositorio.leerConfirmada(actor, plan.id, foto))
      .toEqual({ tipo: 'ausente' });
    // Cada caso deja su reserva inicial intacta y confirma luego sin el trigger temporal.
    expect(await repositorio.finalizar(actor, plan.id, r.reserva, texto)).toMatchObject({ tipo: 'confirmada' });
  });
  it.each(['put-perdido', 'final-perdido', 'put-tarde', 'final-tarde', 'scan-tarde'])
    ('A+B+SDK local: %s conserva incertidumbre y retry sin segundo PUT', async (caso) => {
      await db.exec('BEGIN');
      vi.useFakeTimers();
      let vigencia = crearVigenciaFotos(new AbortController().signal, 10000);
      let liberar!: () => void; let avisar!: () => void;
      const gate = new Promise<void>((r) => { liberar = r; });
      const llegada = new Promise<void>((r) => { avisar = r; });
      let primera = true; let guardado: Blob | null = null; let inicial = '';
      let consultaTardia: Promise<unknown> | undefined;
      const queries: string[] = [];
      const fetchLocal = vi.fn(async (_destino: unknown, opciones: RequestInit) => {
        const entrada = JSON.parse(String(opciones.body)) as { query: string; params: string[] };
        expect(entrada.query).toMatch(/^SELECT itinerario\.(reservar_foto|finalizar_foto|consultar_foto)\(/);
        queries.push(entrada.query);
        const ejecutar = async () => {
          const resultado = await db.query<{ resultado: string }>(entrada.query, entrada.params);
          if (primera && entrada.query.includes('finalizar_foto')) {
            if (caso === 'final-perdido') throw new Error('Respuesta SQL perdida tras statement local');
            if (caso === 'final-tarde') { avisar(); await gate; }
          }
          return new Response(JSON.stringify({ command: 'SELECT', rowCount: resultado.rows.length,
            fields: [{ name: 'resultado', dataTypeID: 25, tableID: 0, columnID: 0,
              dataTypeSize: -1, dataTypeModifier: -1, format: 'text' }],
            rows: resultado.rows.map((fila) => [fila.resultado]) }));
        };
        const respuesta = ejecutar();
        if (caso === 'final-tarde') consultaTardia = respuesta;
        return respuesta;
      });
      vi.stubGlobal('fetch', fetchLocal);
      try {
        const repo = crearRepositorioFotosSql({ plan, ejecutor: crearEjecutorNeon({
          urlBaseDatos: 'postgresql://prueba:clave-sintetica@ep-prueba.eu-central-1.aws.neon.tech/prueba?sslmode=require' }) });
        const poner = vi.fn(async (_clave: string, blob: Blob, texto: string) => {
          guardado = blob; inicial = texto;
          if (primera && caso === 'put-perdido') throw new Error('PUT local almacenado, respuesta perdida');
          if (primera && caso === 'put-tarde') { avisar(); await gate; }
          return true;
        });
        const leer = vi.fn(async (claveObjeto: string) => {
          if (!guardado) return null;
          const blob = guardado; let enviada = false;
          return { claveObjeto, solicitudCanonica: inicial, original: new ReadableStream<Uint8Array>({
            async pull(c) {
              if (primera && caso === 'scan-tarde') { avisar(); await gate; }
              if (enviada) { c.close(); return; }
              enviada = true;
              if (!vigencia.signal.aborted) c.enqueue(new Uint8Array(await blob.arrayBuffer()));
            },
          }) };
        });
        const almacen = crearAlmacenFotos({ plan, repositorio: repo, objetos: { ponerSiAusente: poner, leer } });
        const base = deserializarSolicitudRespaldo(plan, solicitud);
        const s = { ...base, fotoId: 'ABCDEF12-1234-4234-8234-123456789095',
          operacionId: 'B2345678-1234-4234-8234-123456789012', original: { ...base.original,
            fotoId: 'ABCDEF12-1234-4234-8234-123456789095' } };
        const captura = { solicitud: s, original: new Blob([new Uint8Array([1, 2, 3])]) };
        const fresca = vi.fn(async () => true);
        const contexto = () => ({ huellaActor: actor, vigencia, reautenticar: fresca,
          presupuesto: { maxBytesOriginal: 2000000, maxBytesEntrada: 2200000, maxBytesChunk: 65536,
            maxBytesCabeceras: 1024, maxBytesRetenidos: 8000000, maxBloquesOriginal: 100,
            bytesBloque: 65536, plazoMs: 10000 } });
        let acuses = 0;
        const pendiente = almacen.respaldar(captura, contexto()).then((valor) => { acuses++; return valor; });
        // Registrar el rechazo antes de disparar el reloj evita rechazos no observados.
        const fallo = pendiente.catch((valor: unknown) => valor);
        if (caso.endsWith('tarde')) {
          await llegada;
          expect(acuses).toBe(0);
          await vi.advanceTimersByTimeAsync(10001);
        }
        expect(await fallo).toMatchObject({ codigo: 503 });
        expect(acuses).toBe(0);
        const finalesAntes = queries.filter((q) => q.includes('finalizar_foto')).length;
        expect(finalesAntes).toBe(caso.startsWith('final') ? 1 : 0);
        if (caso.endsWith('tarde')) {
          liberar();
          if (consultaTardia) await consultaTardia;
          await Promise.resolve(); await Promise.resolve();
          expect(acuses).toBe(0);
          expect(queries.filter((q) => q.includes('finalizar_foto'))).toHaveLength(finalesAntes);
        }
        primera = false; vigencia.cerrar();
        vigencia = crearVigenciaFotos(new AbortController().signal, 10000);
        expect(await almacen.respaldar(captura, contexto())).toMatchObject({ primera: false });
        expect(poner).toHaveBeenCalledTimes(1);
        expect(fresca).toHaveBeenCalledTimes(caso.startsWith('final') ? 2 : 1);
      } finally {
        liberar(); vigencia.cerrar(); vi.useRealTimers(); vi.unstubAllGlobals(); await db.exec('ROLLBACK');
      }
    });
  it('SQL real acepta recibo UTF8 exactamente 64KiB y conserva todo su texto', async () => {
    await db.exec('BEGIN');
    try {
      const base = deserializarSolicitudRespaldo(plan, solicitud);
      const s = { ...base, fotoId: 'ABCDEF12-1234-4234-8234-123456789093',
        operacionId: 'C2345678-1234-4234-8234-123456789012', original: { ...base.original,
          fotoId: 'ABCDEF12-1234-4234-8234-123456789093', nombre: '' } };
      const acuse = { ...s, tipo: 'acuse-respaldo', objetoOriginalDurable: true, metadatosDurables: true };
      const hueco = 65536 - new TextEncoder().encode(serializarReciboRespaldo(plan, acuse)).length;
      const candidato = { ...s, original: { ...s.original,
        nombre: '界'.repeat(Math.floor(hueco / 3)) + 'a'.repeat(hueco % 3) } };
      const texto = serializarSolicitudRespaldo(plan, candidato);
      const recibo = serializarReciboRespaldo(plan, { ...acuse, original: candidato.original });
      expect(new TextEncoder().encode(recibo).length).toBe(65536);
      const r = await repositorio.reservar(actor, plan.id, texto) as ResultadoReservaFotos;
      expect(r.tipo).toBe('ganadora');
      if (r.tipo !== 'ganadora') throw new Error('Fixture sin reserva');
      expect(await repositorio.finalizar(actor, plan.id, r.reserva, texto))
        .toEqual({ tipo: 'confirmada', reciboCanonico: recibo });
      expect(await repositorio.leerConfirmada(actor, plan.id, candidato.fotoId))
        .toEqual({ tipo: 'confirmada', reserva: r.reserva });
    } finally { await db.exec('ROLLBACK'); }
  });
  it('reserva postDML caduca tras demora acotada y revierte sus dos inserts', async () => {
    const tablas = (await db.query<{ tablename: string }>(
      'SELECT tablename FROM pg_tables WHERE schemaname=$1 ORDER BY tablename', ['itinerario'])).rows;
    const capturar = async () => Promise.all(tablas.map(async ({ tablename }) =>
      (await db.query('SELECT row_to_json(t)::text AS fila FROM itinerario.' + tablename + ' t ORDER BY row_to_json(t)::text')).rows));
    const antes = await capturar();
    await db.exec('BEGIN');
    try {
      await db.exec(`CREATE FUNCTION itinerario.prueba_expirar_reserva() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN UPDATE itinerario.sesiones SET vence_en=floor(extract(epoch FROM clock_timestamp())*1000)::bigint+20;
        PERFORM pg_sleep(0.04); RETURN NEW; END $$;
        CREATE TRIGGER prueba_expirar_reserva AFTER INSERT ON itinerario.fotos_operaciones
        FOR EACH ROW EXECUTE FUNCTION itinerario.prueba_expirar_reserva();`);
      const texto = solicitud.replaceAll(fotoId, 'ABCDEF12-1234-4234-8234-123456789092')
        .replace(operacionId, 'C2345678-1234-4234-8234-123456789012');
      await expect(repositorio.reservar(actor, plan.id, texto)).rejects.toThrow('No se pudo comprobar las fotos.');
    } finally { await db.exec('ROLLBACK'); }
    expect(await capturar()).toEqual(antes);
  });
  it('reaplicar 005 conserva todas las tablas y recibos existentes', async () => {
    const anterior = await db.query<{ tablename: string }>('SELECT tablename FROM pg_tables WHERE schemaname=$1 ORDER BY tablename', ['itinerario']);
    const nombres = anterior.rows.map((fila) => String(fila.tablename));
    const capturar = async () => Promise.all(nombres.map(async (nombre) =>
      (await db.query('SELECT row_to_json(t)::text AS fila FROM itinerario.' + nombre + ' t ORDER BY row_to_json(t)::text')).rows));
    const datos = await capturar();
    await db.exec(await readFile(new URL('../../servidor/migraciones/005_fotos.sql', import.meta.url), 'utf8'));
    expect(await capturar()).toEqual(datos);
  });
});

describe('Frontera privada sin IO', () => {
  it('fábrica no ejecuta getters de configuración, plan ni ejecutor', () => {
    const getter = vi.fn(() => plan);
    for (const configuracion of [
      Object.defineProperty({}, 'plan', { get: getter }),
      { plan: Object.defineProperty({ ...plan }, 'id', { get: getter }), ejecutor: { ejecutar: vi.fn() } },
      { plan, ejecutor: Object.defineProperty({}, 'ejecutar', { get: getter }) },
    ]) {
      expect(() => crearRepositorioFotosSql(configuracion as Parameters<typeof crearRepositorioFotosSql>[0]))
        .toThrow('No se pudo comprobar las fotos.');
    }
    expect(getter).not.toHaveBeenCalled();
  });
  it.each([' ' + solicitud, solicitud + ' ', solicitud.slice(0, -1), solicitud + '{}',
    solicitud.replace('"version":1', '"version":1,"version":1'),
    solicitud.replace('"version":1', '"version":1,"\\u0076ersion":1'),
    solicitud.replace('"version":1', '"version": 1')])('texto no canónico rechazado antes de IO: %s', async (texto) => {
    const ejecutar = vi.fn();
    const repo = crearRepositorioFotosSql({ plan, ejecutor: { ejecutar } });
    await expect(repo.reservar(actor, plan.id, texto)).rejects.toThrow('No se pudo comprobar las fotos.');
    expect(ejecutar).not.toHaveBeenCalled();
  });
  it.each(['', 'A'.repeat(64), 'b'.repeat(63), 'b'.repeat(65)])('huella inválida %s no hace IO', async (huella) => {
    const ejecutar = vi.fn();
    const repo = crearRepositorioFotosSql({ plan, ejecutor: { ejecutar } });
    await expect(repo.reservar(huella, plan.id, solicitud)).rejects.toThrow('No se pudo comprobar las fotos.');
    expect(ejecutar).not.toHaveBeenCalled();
  });
  it.each([undefined, {}, { filas: [] }, { filas: [{ resultado: '{}' }] },
    { filas: [{ resultado: '{"tipo":"ganadora"}' }] }, { filas: [{ resultado: '{"tipo":"ausente"}' }] }])
    ('respuesta SQL inválida permanece privada sin retry', async (respuesta) => {
      const ejecutar = vi.fn(async () => respuesta as never);
      const repo = crearRepositorioFotosSql({ plan, ejecutor: { ejecutar } });
      await expect(repo.reservar(actor, plan.id, solicitud)).rejects.toThrow('No se pudo comprobar las fotos.');
      expect(ejecutar).toHaveBeenCalledTimes(1);
    });
  it.each(['{"original":' + solicitud + '}', solicitud.slice(0, -1) + ',"original":{}}',
    solicitud.replace('"version":1,"tipo":"solicitud-respaldo"', '"tipo":"solicitud-respaldo","version":1')])
    ('encuadre, orden o profundidad adversaria no hace IO', async (texto) => {
      const ejecutar = vi.fn(); const repo = crearRepositorioFotosSql({ plan, ejecutor: { ejecutar } });
      await expect(repo.reservar(actor, plan.id, texto)).rejects.toThrow('No se pudo comprobar las fotos.');
      expect(ejecutar).not.toHaveBeenCalled();
    });
  it('JSON sintácticamente válido con profundidad >16 se rechaza antes de IO', async () => {
    let original = '0';
    for (let i = 0; i < 17; i++) original = '[' + original + ']';
    const texto = '{"version":1,"tipo":"solicitud-respaldo","viajeId":"viaje","operacionId":'
      + JSON.stringify(operacionId) + ',"fotoId":' + JSON.stringify(fotoId) + ',"original":' + original + '}';
    expect(() => JSON.parse(texto)).not.toThrow();
    expect(() => deserializarSolicitudRespaldo(plan, texto)).toThrow(/Profundidad/);
    const ejecutar = vi.fn(); const repo = crearRepositorioFotosSql({ plan, ejecutor: { ejecutar } });
    await expect(repo.reservar(actor, plan.id, texto)).rejects.toThrow('No se pudo comprobar las fotos.');
    expect(ejecutar).not.toHaveBeenCalled();
  });
  it.each([0, 1])('solicitud válida cerca de 64KiB, recibo excedido, cero IO: +%i bytes', async (extra) => {
    const base = deserializarSolicitudRespaldo(plan, solicitud);
    const vacia = { ...base, original: { ...base.original, nombre: '' } };
    const overhead = new TextEncoder().encode(serializarSolicitudRespaldo(plan, vacia)).length;
    const hueco = 65536 - overhead;
    const nombre = '界'.repeat(Math.floor(hueco / 3)) + 'a'.repeat(hueco % 3 + extra);
    const candidato = { ...base, original: { ...base.original, nombre } };
    const ejecutar = vi.fn(); const repo = crearRepositorioFotosSql({ plan, ejecutor: { ejecutar } });
    if (extra === 0) {
      const texto = serializarSolicitudRespaldo(plan, candidato);
      expect(new TextEncoder().encode(texto).length).toBe(65536);
      expect(() => serializarReciboRespaldo(plan, { ...candidato, tipo: 'acuse-respaldo',
        objetoOriginalDurable: true, metadatosDurables: true })).toThrow(/64 KiB/);
      await expect(repo.reservar(actor, plan.id, texto)).rejects.toThrow('No se pudo comprobar las fotos.');
      await expect(repo.finalizar(actor, plan.id, { reservaId: operacionId,
        claveObjeto: 'irrelevante-antes-del-preflight', solicitudCanonica: texto }, texto))
        .rejects.toThrow('No se pudo comprobar las fotos.');
    } else {
      expect(() => serializarSolicitudRespaldo(plan, candidato)).toThrow(/64 KiB/);
      // La representación cruda de 65537 bytes alcanza además la frontera del puerto.
      const texto = serializarSolicitudRespaldo(plan, { ...candidato, original: { ...candidato.original,
        nombre: nombre.slice(0, -1) } }).replace('"nombre":"', '"nombre":"a');
      expect(new TextEncoder().encode(texto).length).toBe(65537);
      await expect(repo.reservar(actor, plan.id, texto)).rejects.toThrow('No se pudo comprobar las fotos.');
    }
    expect(ejecutar).not.toHaveBeenCalled();
  });
  it('recibo multibyte exactamente 64KiB pasa preflight sin perder -0 o NUL', async () => {
    const base = deserializarSolicitudRespaldo(plan, solicitud);
    const vacia = { ...base, original: { ...base.original, nombre: '' } };
    const reciboVacio = serializarReciboRespaldo(plan, { ...vacia, tipo: 'acuse-respaldo',
      objetoOriginalDurable: true, metadatosDurables: true });
    const hueco = 65536 - new TextEncoder().encode(reciboVacio).length;
    const s = { ...vacia, original: { ...vacia.original,
      nombre: '界'.repeat(Math.floor(hueco / 3)) + 'a'.repeat(hueco % 3) } };
    expect(new TextEncoder().encode(serializarReciboRespaldo(plan, { ...s, tipo: 'acuse-respaldo',
      objetoOriginalDurable: true, metadatosDurables: true })).length).toBe(65536);
    const ejecutar = vi.fn(async () => ({ filas: [{ resultado: '{"tipo":"sin-sesion"}' }] }));
    const repo = crearRepositorioFotosSql({ plan, ejecutor: { ejecutar } });
    expect(await repo.reservar(actor, plan.id, serializarSolicitudRespaldo(plan, s))).toEqual({ tipo: 'sin-sesion' });
    expect(ejecutar).toHaveBeenCalledTimes(1);
  });
  it('error de ejecutor no expone cause, stack ni detalles y no reintenta', async () => {
    const ejecutar = vi.fn(async () => { throw new Error('detalle privado simulado'); });
    const repo = crearRepositorioFotosSql({ plan, ejecutor: { ejecutar } });
    const error = await repo.reservar(actor, plan.id, solicitud).catch((valor: unknown) => valor);
    expect(error).toBeInstanceOf(Error);
    expect(Object.getOwnPropertyNames(error)).toEqual(['message']);
    expect((error as Error).message).toBe('No se pudo comprobar las fotos.');
    expect(ejecutar).toHaveBeenCalledTimes(1);
  });
});
