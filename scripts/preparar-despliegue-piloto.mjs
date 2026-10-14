// Preparación LOCAL no secreta: no configura cuentas, carga entorno ni construye el Worker.
import { mkdirSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'vite';

const USO = 'Uso: node scripts/preparar-despliegue-piloto.mjs <account-id-32hex> <carpeta-absoluta-externa-nueva>';
const repositorio = realpathSync(fileURLToPath(new URL('..', import.meta.url)));
function dentro(ruta, base) {
  const distancia = relative(base, ruta);
  return distancia === '' || !(distancia === '..' || distancia.startsWith('..' + sep) || isAbsolute(distancia));
}

try {
  const argumentos = process.argv.slice(2);
  const [cuenta, ruta] = argumentos;
  if (argumentos.length !== 2 || !/^[a-fA-F0-9]{32}$/.test(cuenta ?? '')
    || !ruta || ruta.trim() !== ruta || ruta.includes('\0') || !isAbsolute(ruta)
    || ruta.split(sep).some((parte) => parte === '.' || parte === '..') || ruta.endsWith(sep)) throw new Error(USO);
  const pedida = resolve(ruta);
  const padre = realpathSync(dirname(pedida));
  if (padre !== dirname(pedida) || !statSync(padre).isDirectory()) {
    throw new Error('El padre debe existir y ser canónico sin enlaces.');
  }
  const salida = join(padre, basename(pedida));
  if (dentro(salida, repositorio) || dentro(repositorio, salida)) throw new Error('Salida no externa.');
  // Reserva exclusiva no recursiva: ninguna salida previa se adopta o sobrescribe.
  mkdirSync(salida);
  // Rutas inexistentes propias: Vite no puede leer .env ni copiar public/.
  const raizVacia = join(salida, 'raiz-vite-vacia');
  const resultado = await build({
    configFile: false, root: raizVacia, envDir: raizVacia, publicDir: false, logLevel: 'silent', plugins: [],
    build: { write: false, emptyOutDir: false, minify: false,
      lib: { entry: join(repositorio, 'scripts/perfil-operativo-piloto.ts'), formats: ['es'], fileName: 'perfil' } },
  });
  const bundles = Array.isArray(resultado) ? resultado : [resultado];
  if (bundles.length !== 1 || !('output' in bundles[0])) throw new Error('Bundle inesperado.');
  const piezas = bundles[0].output;
  if (piezas.length !== 1 || piezas[0].type !== 'chunk') throw new Error('Se exige un módulo puro único.');
  const modulo = await import('data:text/javascript;base64,' + Buffer.from(piezas[0].code).toString('base64'));
  const perfil = modulo.crearPerfilOperativoPiloto();
  const config = {
    name: 'itinerario-piloto', account_id: cuenta, main: join(repositorio, 'servidor/worker.ts'),
    workers_dev: true, compatibility_date: '2026-10-11',
    assets: { directory: join(salida, 'web'), binding: 'ASSETS', run_worker_first: true },
    r2_buckets: [{ binding: 'FOTOS_BUCKET', bucket_name: 'itinerario-piloto-fotos' }],
    vars: { FOTOS_ORIGEN: perfil.origen, FOTOS_PRESUPUESTO: perfil.respaldoServidor,
      FOTOS_LISTADO_PRESUPUESTO: perfil.listadoServidor },
  };
  writeFileSync(join(salida, 'perfil.json'), JSON.stringify(perfil, null, 2) + '\n', { flag: 'wx' });
  writeFileSync(join(salida, 'wrangler.privado.json'), JSON.stringify(config, null, 2) + '\n', { flag: 'wx' });
  console.log('Generados perfil.json y wrangler.privado.json; web y Worker todavía no construidos.');
} catch {
  // No imprimir causas de dependencias, datos ambientales ni argumentos recibidos.
  console.error(USO);
  console.error('Preparación rechazada o fallida. La salida nueva puede estar parcial; no se borra ni se reintenta.');
  process.exitCode = 1;
}
