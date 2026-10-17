// Solo pruebas: la app REAL (el index.html real y la fábrica real arrancarItinerario de src/main.ts) con una
// composición EXPLÍCITA de progreso compartido, como la del piloto, compilada en memoria con Vite (write: false: nada
// se escribe en dist/ ni en el repositorio). Se sirve en el MISMO origen de las pruebas interceptando «/» y sus
// archivos; el resto (iconos, manifiesto) sigue llegando del servidor de siempre y /api/progreso lo atiende cada
// prueba con su controlador. Respaldo y portabilidad siguen a null. No acredita autenticación, perfil privado ni
// despliegue: es la web publicada con el ÚNICO cambio de tener cliente de progreso.
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import type { BrowserContext } from '@playwright/test';
import { build, type Plugin, type Rollup } from 'vite';

const ORIGEN = 'http://localhost:4173';
const ENTRADA = 'virtual:app-con-progreso';
const TIPOS: Record<string, string> = { js: 'text/javascript; charset=utf-8', css: 'text/css; charset=utf-8',
  png: 'image/png', svg: 'image/svg+xml', woff2: 'font/woff2', woff: 'font/woff' };
interface App { readonly pagina: string; readonly archivos: ReadonlyMap<string, { cuerpo: string | Uint8Array; tipo: string }> }
let compilada: Promise<App> | undefined;

async function compilar(): Promise<App> {
  const main = JSON.stringify(fileURLToPath(new URL('../src/main.ts', import.meta.url)));
  const codigo = `import { arrancarItinerario } from ${main};
arrancarItinerario({ respaldo: null, portabilidad: null, progreso: { http: (url, opciones) => fetch(url, opciones) } });
`;
  const entrada: Plugin = { name: 'entrada-app-con-progreso',
    resolveId: (id) => (id === ENTRADA ? `\0${ENTRADA}` : null),
    load: (id) => (id === `\0${ENTRADA}` ? codigo : null) };
  // Como vite.config.ts, sin leerlo: formato de workers y una fecha del plan fija SOLO de prueba.
  const resultado = await build({ configFile: false, logLevel: 'silent', plugins: [entrada],
    define: { __PLAN__: JSON.stringify('2026-10-14T00:00:00.000Z') }, worker: { format: 'es' },
    build: { write: false, minify: false, target: 'es2022', rollupOptions: { preserveEntrySignatures: 'strict',
      input: { app: ENTRADA }, output: { entryFileNames: '[name].js', chunkFileNames: 'fragmento-[hash].js',
        assetFileNames: '[name][extname]' } } } });
  const salida = (Array.isArray(resultado) ? resultado[0] : resultado) as Rollup.RollupOutput;
  const archivos = new Map(salida.output.map((a) => [a.fileName, {
    cuerpo: a.type === 'chunk' ? a.code : typeof a.source === 'string' ? a.source : new Uint8Array(a.source),
    tipo: TIPOS[a.fileName.split('.').pop() ?? ''] ?? 'application/octet-stream' }]));
  const estilos = salida.output.filter((a) => a.type === 'asset' && a.fileName.endsWith('.css')).map((a) => a.fileName);
  if (!archivos.has('app.js') || !estilos.length) throw new Error('La app con progreso no produjo app.js y su CSS');
  // El index.html REAL con una sola sustitución: su script público por esta entrada, y el CSS emitido.
  const html = await readFile(new URL('../index.html', import.meta.url), 'utf8');
  const publico = '<script type="module" src="./src/publica.ts"></script>';
  if (html.split(publico).length !== 2 || html.split('</head>').length !== 2) {
    throw new Error('index.html no tiene un único script público y un único </head>');
  }
  const pagina = html.replace(publico, '<script type="module" src="/app.js"></script>')
    .replace('</head>', `${estilos.map((c) => `<link rel="stylesheet" href="/${c}">`).join('')}</head>`);
  return { pagina, archivos };
}

/** Compila una sola vez por proceso de pruebas (los E2E van con un worker). */
export function compilarAppConProgreso(): Promise<void> {
  compilada ??= compilar();
  return compilada.then(() => undefined);
}

/** En ESTE contexto, «/» y los archivos de la app vienen de la compilación en memoria; nada más cambia. */
export async function servirAppConProgreso(contexto: BrowserContext): Promise<void> {
  const app = await (compilada ??= compilar());
  await contexto.route((url) => url.origin === ORIGEN && (url.pathname === '/' || app.archivos.has(url.pathname.slice(1))),
    (route) => {
      const ruta = new URL(route.request().url()).pathname;
      if (ruta === '/') return route.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body: app.pagina });
      const a = app.archivos.get(ruta.slice(1))!;
      return route.fulfill({ status: 200, contentType: a.tipo,
        body: typeof a.cuerpo === 'string' ? a.cuerpo : Buffer.from(a.cuerpo) });
    });
}
