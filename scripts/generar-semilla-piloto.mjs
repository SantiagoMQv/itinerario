// Generación LOCAL: no carga configuraciones públicas, entorno, sesiones ni clientes SQL.
import { mkdirSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'vite';

const USO = 'Uso: node scripts/generar-semilla-piloto.mjs <carpeta-absoluta-externa-nueva>';
const repositorio = realpathSync(fileURLToPath(new URL('..', import.meta.url)));
function dentro(ruta, base) {
  const distancia = relative(base, ruta);
  return distancia === '' || !(distancia === '..' || distancia.startsWith('..' + sep) || isAbsolute(distancia));
}

try {
  const argumentos = process.argv.slice(2);
  const ruta = argumentos[0];
  if (argumentos.length !== 1 || !ruta || ruta.trim() !== ruta || ruta.includes('\0')
    || !isAbsolute(ruta) || ruta.split(sep).some((parte) => parte === '.' || parte === '..')
    || ruta.endsWith(sep)) throw new Error(USO);
  const pedida = resolve(ruta);
  const padre = realpathSync(dirname(pedida));
  // Rechaza enlaces en cualquier ancestro, no solo los que entran al repositorio.
  if (padre !== dirname(pedida) || !statSync(padre).isDirectory()) {
    throw new Error('El padre debe existir y ser una carpeta canónica sin enlaces.');
  }
  const salida = join(padre, basename(pedida));
  if (dentro(salida, repositorio) || dentro(repositorio, salida)) {
    throw new Error('La salida debe ser externa y no contener el repositorio.');
  }
  // Reserva atómica no recursiva: falla también para archivos y enlaces rotos existentes.
  mkdirSync(salida);
  // Estas rutas deliberadamente vacías nunca se crean: Vite no tiene .env que leer.
  const raizVacia = join(salida, 'raiz-vite-vacia');
  const resultado = await build({
    configFile: false, root: raizVacia, envDir: raizVacia, publicDir: false,
    logLevel: 'silent', plugins: [],
    build: { write: false, emptyOutDir: false, minify: false,
      lib: { entry: join(repositorio, 'servidor/semilla-piloto.ts'), formats: ['es'], fileName: 'semilla' } },
  });
  const bundles = Array.isArray(resultado) ? resultado : [resultado];
  if (bundles.length !== 1 || !('output' in bundles[0])) throw new Error('Bundle de semilla inesperado.');
  const fragmentos = bundles[0].output.filter((pieza) => pieza.type === 'chunk');
  if (fragmentos.length !== 1 || bundles[0].output.length !== 1) throw new Error('La semilla debe ser un único módulo puro.');
  const modulo = await import('data:text/javascript;base64,' + Buffer.from(fragmentos[0].code).toString('base64'));
  const semilla = modulo.crearSemillaPiloto();
  writeFileSync(join(salida, 'parametros-semilla.json'), JSON.stringify(semilla.parametros, null, 2) + '\n', { flag: 'wx' });
  writeFileSync(join(salida, 'semilla-piloto.sql'), semilla.sql, { flag: 'wx' });
  console.log('Generados parametros-semilla.json y semilla-piloto.sql; no se ejecutó SQL.');
} catch {
  // No imprimir errores de dependencias que pudieran incluir información ambiental.
  console.error(USO);
  console.error('Generación rechazada o fallida. Si se reservó la salida, puede estar parcial; no se borra ni se reintenta.');
  process.exitCode = 1;
}
