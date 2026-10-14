// Lanzador del montaje privado LOCAL: npm run build:privado -- <perfil.json> <salida-nueva>.
// Construye con la Vite instalada y vite.config.privado.ts, que lee esos dos argumentos, valida el perfil y reserva la
// salida. Sin entorno ni valores por defecto: nunca escribe en dist/ ni toca la web publicada.
import { fileURLToPath } from 'node:url';
import { build } from 'vite';

try {
  await build({
    root: fileURLToPath(new URL('..', import.meta.url)),
    configFile: fileURLToPath(new URL('../vite.config.privado.ts', import.meta.url)),
  });
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  // Nada se borra solo: si la salida nueva llegó a crearse antes del fallo, puede haber quedado a medias.
  console.error('Si la salida nueva llegó a crearse, puede haber quedado a medias: revísala; no se borra sola.');
  process.exitCode = 1;
}
