import { defineConfig } from 'vite';

export default defineConfig({
  // Rutas relativas: la web funciona igual en GitHub Pages (/itinerario/) que en la raíz de un dominio.
  base: './',
  worker: { format: 'es' },
  build: { target: 'es2022', chunkSizeWarningLimit: 1600 },
});
