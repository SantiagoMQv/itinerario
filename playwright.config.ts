import { defineConfig } from '@playwright/test';

// Pruebas de humo en un móvil simulado, contra la web compilada (la misma que se publica).
export default defineConfig({
  testDir: 'pruebas',
  testMatch: '*.e2e.ts',
  forbidOnly: !!process.env.CI,
  reporter: process.env.CI ? [['github'], ['list']] : 'list',
  use: {
    baseURL: 'http://localhost:4173',
    browserName: 'chromium',
    locale: 'es-ES',
    viewport: { width: 390, height: 844 },
    deviceScaleFactor: 2,
    isMobile: true,
    hasTouch: true,
    // Sin service worker: cada prueba ve la versión recién compilada.
    serviceWorkers: 'block',
    trace: 'retain-on-failure',
  },
  webServer: {
    command: 'npm run build && npm run preview -- --port 4173 --strictPort',
    url: 'http://localhost:4173',
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
});
