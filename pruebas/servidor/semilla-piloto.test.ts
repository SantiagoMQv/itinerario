import { describe, expect, it } from 'vitest';
import { itinerario } from '../../src/datos/itinerario';
import { crearProgreso } from '../../src/progreso';
import { serializarProgreso } from '../../src/progreso-json';
import { esInstantaneaProgreso } from '../../src/progreso-validacion';
import { crearSemillaPiloto } from '../../servidor/semilla-piloto';

describe('semilla inicial del piloto', () => {
  it('conserva el texto real y la revisión inicial sin sobre', () => {
    const semilla = crearSemillaPiloto();
    expect(semilla.parametros).toEqual({ id: 'd64bf870a2c193e5', revision_servidor: 0,
      estado_json: serializarProgreso(crearProgreso(itinerario)) });
    const estado = JSON.parse(semilla.parametros.estado_json);
    expect(esInstantaneaProgreso(itinerario, { revisionServidor: 0, estado })).toBe(true);
    expect(estado).toMatchObject({ paradas: {}, pendientes: {}, operaciones: {},
      aqui: { paradaId: null, revision: 0 } });
    expect(Array.isArray(estado.paradas)).toBe(false);
    expect(estado).not.toHaveProperty('estado');
    expect(semilla.sql).toContain('itinerario.viajes (id, revision_servidor, estado_json)');
    expect(semilla.sql).toContain('::TEXT');
  });

  it('rechaza identidades duplicadas mediante el constructor del catálogo', () => {
    expect(() => crearSemillaPiloto({ ...itinerario, id: itinerario.dias[0].paradas[0].id }))
      .toThrow('Identidad del itinerario vacía o duplicada');
  });

  it('aborta ante raíz existente y conserva comillas y barras como TEXT', () => {
    const id = "viaje'\\$semilla$";
    const semilla = crearSemillaPiloto({ ...itinerario, id });
    const literales = [...semilla.sql.matchAll(/E'((?:[^']|'')*)'::TEXT/g)]
      .map((m) => m[1].replace(/''/g, "'").replace(/\\\\/g, '\\'));
    expect(literales).toContain(id);
    expect(literales).toContain(semilla.parametros.estado_json);
    expect(semilla.sql).toContain('LOCK TABLE itinerario.viajes IN EXCLUSIVE MODE');
    expect(semilla.sql).toContain('IF EXISTS (SELECT 1 FROM itinerario.viajes WHERE id =');
    expect(semilla.sql).toContain('RAISE EXCEPTION');
    expect(semilla.sql).toContain('END;\n');
    expect(semilla.sql).not.toMatch(/ON CONFLICT|UPSERT|UPDATE|DELETE|JSONB/i);
    expect(semilla.sql.match(/INSERT INTO/g)).toHaveLength(1);
  });
});
