import { afterEach, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync,
  rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { itinerario } from '../src/datos/itinerario';
import { crearProgreso } from '../src/progreso';
import { serializarProgreso } from '../src/progreso-json';

const propias: string[] = [];
function temporal() {
  const carpeta = mkdtempSync(join(realpathSync(tmpdir()), 'semilla-prueba-'));
  propias.push(carpeta);
  return carpeta;
}
const ejecutar = (...argumentos: string[]) => spawnSync(process.execPath,
  [resolve('scripts/generar-semilla-piloto.mjs'), ...argumentos], { encoding: 'utf8' });
// Solo carpetas sintéticas creadas por esta prueba, nunca salidas del operador.
afterEach(() => { for (const carpeta of propias.splice(0)) rmSync(carpeta, { recursive: true }); });

describe('generación local de semilla', () => {
  it('genera parámetros y SQL desde el constructor y serializador reales', () => {
    const salida = join(temporal(), 'nueva');
    const resultado = ejecutar(salida);
    expect(resultado.status).toBe(0);
    expect(existsSync(join(salida, 'parametros-semilla.json'))).toBe(true);
    const parametros = JSON.parse(readFileSync(join(salida, 'parametros-semilla.json'), 'utf8'));
    expect(parametros).toEqual({ id: itinerario.id, revision_servidor: 0,
      estado_json: serializarProgreso(crearProgreso(itinerario)) });
    expect(typeof parametros.estado_json).toBe('string');
    const sql = readFileSync(join(salida, 'semilla-piloto.sql'), 'utf8');
    const textos = [...sql.matchAll(/E'((?:[^']|'')*)'::TEXT/g)]
      .map((m) => m[1].replace(/''/g, "'").replace(/\\\\/g, '\\'));
    expect(textos).toContain(parametros.estado_json);
    expect(sql).toContain(', 0,');
    expect(sql).toContain('RAISE EXCEPTION');
    expect(sql).not.toMatch(/ON CONFLICT|UPSERT|UPDATE|DELETE|JSONB/i);
    expect(readdirSync(salida).sort()).toEqual(['parametros-semilla.json', 'semilla-piloto.sql']);
  });

  it('no toca una salida existente ni su testigo', () => {
    const salida = temporal();
    writeFileSync(join(salida, 'testigo'), 'intacto');
    expect(ejecutar(salida).status).toBe(1);
    expect(readdirSync(salida)).toEqual(['testigo']);
    expect(readFileSync(join(salida, 'testigo'), 'utf8')).toBe('intacto');
  });

  it('rechaza argumentos malformados antes de crear salidas', () => {
    const padre = temporal();
    const salida = join(padre, 'nueva');
    for (const argumentos of [[], [salida, 'extra'], [''], ['--salida'], ['relativa'], [join(padre, '..')]]) {
      expect(ejecutar(...argumentos).status).toBe(1);
    }
    expect(readdirSync(padre)).toEqual([]);
  });

  it('rechaza contención en repositorio y padres inexistentes', () => {
    const padre = temporal();
    const interior = resolve('salida-semilla-prueba-no-creada');
    expect(ejecutar(interior).status).toBe(1);
    expect(existsSync(interior)).toBe(false);
    expect(ejecutar(join(padre, 'ausente', 'salida')).status).toBe(1);
    expect(readdirSync(padre)).toEqual([]);
  });

  it('rechaza enlaces como salida y como padre, incluso hacia el repositorio', () => {
    const padre = temporal();
    const destino = join(padre, 'destino');
    mkdirSync(destino);
    symlinkSync(destino, join(padre, 'enlace'));
    symlinkSync(resolve('.'), join(padre, 'repositorio'));
    symlinkSync(join(padre, 'ausente'), join(padre, 'roto'));
    for (const salida of [join(padre, 'enlace'), join(padre, 'enlace', 'nueva'),
      join(padre, 'repositorio', 'nueva'), join(padre, 'roto')]) {
      expect(ejecutar(salida).status).toBe(1);
    }
    expect(readdirSync(destino)).toEqual([]);
    expect(readdirSync(padre).sort()).toEqual(['destino', 'enlace', 'repositorio', 'roto']);
  });
});
