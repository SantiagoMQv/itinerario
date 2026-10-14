// Montaje privado LOCAL: npm run build:privado -- <perfil.json> <salida-nueva>. Nunca la web publicada (vite.config.ts).
// El perfil (no secreto) y la salida los da quien opera como argumentos explícitos: no hay rutas, topes ni valores por
// defecto, ni entorno, URL, window o sesión que lo activen. Importar este archivo no lee nada: solo la función del
// export default lee los dos argumentos, y únicamente cuando Vite construye con ella (scripts/build-privado.mjs).
import { mkdirSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig, mergeConfig, type Plugin, type UserConfig } from 'vite';
import { crearPerfilPiloto } from './src/perfil-piloto';
import { prepararPiloto } from './src/preparar-piloto';
import publica from './vite.config';

const USO = 'Uso: npm run build:privado -- <perfil.json> <salida-nueva>';
const PUBLICO = '<script type="module" src="./src/publica.ts"></script>';
const PRIVADO = '<script type="module" src="./src/privada.ts"></script>';
const MODULO = 'virtual:perfil-privado';

const repositorio = () => realpathSync(dirname(fileURLToPath(import.meta.url)));
/** ¿La ruta (ya canónica) es la base o está dentro de ella? */
function dentro(ruta: string, base: string): boolean {
  const r = relative(base, ruta);
  return r === '' || !(r === '..' || r.startsWith('..' + sep) || isAbsolute(r));
}

/** Plugin PURO (también para fixtures en memoria): sustituye EXACTAMENTE una vez el script público de index.html por la
 * entrada privada y sirve los datos del perfil como virtual:perfil-privado. No lee archivos ni valida nada. */
export function pluginPrivado(datos: unknown): Plugin {
  const codigo = `export default ${JSON.stringify(datos)};`;
  return {
    name: 'montaje-privado',
    resolveId: (id) => (id === MODULO ? `\0${MODULO}` : null),
    load: (id) => (id === `\0${MODULO}` ? codigo : null),
    transformIndexHtml: {
      order: 'pre',
      handler(html) {
        if (html.split(PUBLICO).length !== 2) throw new Error('index.html no tiene un único script público.');
        return html.replace(PUBLICO, PRIVADO);
      },
    },
  };
}

/** Configuración PURA: la publicada (base, workers, __PLAN__ del momento) con otra entrada y otra salida, que nunca se
 * vacía. */
export function configPrivada(datos: unknown, salida: string): UserConfig {
  return mergeConfig(publica, { plugins: [pluginPrivado(datos)], build: { outDir: salida, emptyOutDir: false } });
}

/** Exactamente dos rutas: el perfil y la salida nueva. Cualquier otra cosa (incluido un vite build a mano) se rechaza. */
export function leerArgumentos(argv: readonly string[]): { readonly perfil: string; readonly salida: string } {
  if (argv.length !== 2 || argv.some((a) => a.trim() === '' || a.startsWith('-'))) throw new Error(USO);
  return { perfil: argv[0], salida: argv[1] };
}

/** Perfil externo: archivo regular FUERA del repositorio (no se puede subir por error), JSON y válido para el plan real
 * con los mismos constructores que la página, que lo vuelve a comprobar con su origen real. Devuelve los datos crudos. */
export function leerPerfilPrivado(ruta: string): unknown {
  let real: string;
  try { real = realpathSync(resolve(ruta)); } catch { throw new Error(`No existe el perfil privado: ${ruta}`); }
  if (!statSync(real).isFile()) throw new Error(`El perfil privado no es un archivo: ${ruta}`);
  if (dentro(real, repositorio())) throw new Error('El perfil privado tiene que estar fuera del repositorio.');
  let datos: unknown;
  try { datos = JSON.parse(readFileSync(real, 'utf8')); } catch { throw new Error(`El perfil privado no es JSON válido: ${ruta}`); }
  prepararPiloto(datos, crearPerfilPiloto(datos).origen);
  return datos;
}

/** Salida NUEVA fuera del repositorio: su carpeta padre tiene que existir (canónica, así un enlace no la mete en el repo)
 * y la propia ruta no puede existir de ninguna forma (carpeta, archivo o enlace, aunque esté roto). mkdir no recursivo la
 * reserva de forma atómica; nunca se vacía, borra ni sobrescribe nada que ya existiera. */
export function reservarSalida(ruta: string): string {
  const pedida = resolve(ruta);
  let padre: string;
  try { padre = realpathSync(dirname(pedida)); } catch { throw new Error(`No existe la carpeta donde crear la salida: ${dirname(pedida)}`); }
  if (!statSync(padre).isDirectory()) throw new Error(`No existe la carpeta donde crear la salida: ${dirname(pedida)}`);
  const salida = join(padre, basename(pedida));
  if (dentro(salida, repositorio())) throw new Error('La salida tiene que estar fuera del repositorio.');
  try {
    mkdirSync(salida);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new Error(`La salida ya existe; elige una carpeta nueva: ${ruta}`);
    throw error;
  }
  return salida;
}

export default defineConfig(() => {
  const { perfil, salida } = leerArgumentos(process.argv.slice(2));
  const datos = leerPerfilPrivado(perfil);
  // La salida se reserva la ÚLTIMA: un perfil que no vale no deja carpeta. Si el build falla después, queda como mucho
  // esa carpeta nueva, a medias, y no se borra sola.
  return configPrivada(datos, reservarSalida(salida));
});
