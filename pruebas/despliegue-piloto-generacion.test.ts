import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync,
  symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { crearPerfilOperativoPiloto } from '../scripts/perfil-operativo-piloto';
import { crearPerfilPiloto } from '../src/perfil-piloto';
import { prepararPiloto } from '../src/preparar-piloto';

// Cuenta ficticia EXCLUSIVA de fixtures; jamás otorga permiso de operación.
const cuenta = '0123456789abcdef0123456789abcdef';
const temporal = () => mkdtempSync(join(realpathSync(tmpdir()), 'despliegue-prueba-'));
const ejecutar = (...args: string[]) => spawnSync(process.execPath,
  [resolve('scripts/preparar-despliegue-piloto.mjs'), ...args], { encoding: 'utf8' });
// Conservamos estas carpetas sintéticas, incluso ante un fallo: sin borrado ni cleanup implícito.
describe('preparación local del despliegue privado', () => {
  it('genera perfil real y configuración coherente fuera de assets, sin construir web ni Worker', () => {
    const salida = join(temporal(), 'nueva');
    const resultado = ejecutar(cuenta, salida);
    expect(resultado.status, resultado.stderr).toBe(0);
    const datos = JSON.parse(readFileSync(join(salida, 'perfil.json'), 'utf8'));
    expect(datos).toEqual(crearPerfilOperativoPiloto());
    const perfil = crearPerfilPiloto(datos);
    expect(perfil.respaldo.maxBytesOriginal).toBe(8388608);
    expect(prepararPiloto(datos, perfil.origen).respaldo).toEqual(perfil.respaldo);
    const config = JSON.parse(readFileSync(join(salida, 'wrangler.privado.json'), 'utf8'));
    expect(config).toEqual({ name: 'itinerario-piloto', account_id: cuenta,
      main: resolve('servidor/worker.ts'), workers_dev: true, compatibility_date: '2026-10-11',
      assets: { directory: join(salida, 'web'), binding: 'ASSETS', run_worker_first: true },
      r2_buckets: [{ binding: 'FOTOS_BUCKET', bucket_name: 'itinerario-piloto-fotos' }],
      vars: { FOTOS_ORIGEN: perfil.origen, FOTOS_PRESUPUESTO: perfil.respaldoServidor,
        FOTOS_LISTADO_PRESUPUESTO: perfil.listadoServidor } });
    expect(typeof config.vars.FOTOS_PRESUPUESTO).toBe('object');
    expect(typeof config.vars.FOTOS_LISTADO_PRESUPUESTO).toBe('object');
    expect(JSON.stringify(config)).not.toMatch(/CLAVE_COMPARTIDA|URL_BASE_DATOS|token|dist\//i);
    expect(readdirSync(salida).sort()).toEqual(['perfil.json', 'wrangler.privado.json']);
    expect(existsSync(join(salida, 'web'))).toBe(false);
  });

  it('rechaza argumentos/cuenta/rutas sin reservar salida', () => {
    const padre = temporal(); const salida = join(padre, 'nueva');
    for (const args of [[], [cuenta], [cuenta, salida, 'extra'], ['', salida],
      ['g'.repeat(32), salida], ['a'.repeat(31), salida], ['a'.repeat(33), salida],
      [' ' + cuenta, salida], [cuenta, 'relativa'], [cuenta, salida + '/'],
      [cuenta, padre + '/./nueva'], [cuenta, padre + '/../nueva'],
      [cuenta, join(padre, 'ausente', 'nueva')]]) expect(ejecutar(...args).status).toBe(1);
    const interior = resolve('salida-despliegue-prueba-no-creada');
    expect(ejecutar(cuenta, interior).status).toBe(1);
    expect(existsSync(interior)).toBe(false);
    expect(readdirSync(padre)).toEqual([]);
  });

  it('preserva carpetas, archivos y enlaces existentes y rechaza padres no canónicos', () => {
    const padre = temporal(); const destino = join(padre, 'destino'); mkdirSync(destino);
    writeFileSync(join(destino, 'testigo'), 'intacto');
    const archivo = join(padre, 'archivo'); writeFileSync(archivo, 'intacto');
    symlinkSync(destino, join(padre, 'enlace'));
    symlinkSync(resolve('.'), join(padre, 'repo'));
    symlinkSync(join(padre, 'ausente'), join(padre, 'roto'));
    for (const salida of [destino, archivo, join(padre, 'enlace'), join(padre, 'enlace', 'nueva'),
      join(padre, 'repo', 'nueva'), join(padre, 'roto')]) expect(ejecutar(cuenta, salida).status).toBe(1);
    expect(readFileSync(join(destino, 'testigo'), 'utf8')).toBe('intacto');
    expect(readFileSync(archivo, 'utf8')).toBe('intacto');
    expect(readdirSync(destino)).toEqual(['testigo']);
    expect(readdirSync(padre).sort()).toEqual(['archivo', 'destino', 'enlace', 'repo', 'roto']);
  });
});
