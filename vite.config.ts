import { defineConfig } from 'vite';

export default defineConfig({
  // Rutas relativas: la web funciona igual en GitHub Pages (/itinerario/) que en la raíz de un dominio.
  base: './',
  worker: { format: 'es' },
  build: { target: 'es2022', chunkSizeWarningLimit: 1600 },
  // Fecha de publicación: la app enseña de qué día es el plan que lleva guardado el móvil.
  define: { __PLAN__: JSON.stringify(new Date().toISOString()) },
});
