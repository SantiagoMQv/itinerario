// Recorrido básico de la app. Los mapas (OpenFreeMap) se bloquean: la prueba no depende de la red
// y comprueba, de paso, que sin mapa la app sigue funcionando.
import { type Page, expect, test } from '@playwright/test';

/** Abre la app con el reloj parado en una hora de China («2026-10-23 10:30»). */
async function abrir(page: Page, horaChina: string, marcador = true) {
  const errores: string[] = [];
  page.on('pageerror', (e) => errores.push(e.message));
  await page.route(/^https?:\/\/(?!localhost)/, (r) => r.abort());
  if (marcador) await page.addInitScript(() => localStorage.setItem('marcador', 'true'));
  await page.clock.setFixedTime(new Date(`${horaChina.replace(' ', 'T')}:00+08:00`));
  await page.goto('/');
  await expect(page.locator('#contenido')).not.toBeEmpty();
  return errores;
}

test('antes del viaje se abre en «Todo» con lo pendiente', async ({ page }) => {
  const errores = await abrir(page, '2026-10-10 12:00');
  await expect(page.locator('.pestana.todo')).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByRole('heading', { name: /Antes de salir/ })).toContainText('faltan 11 días');
  expect(errores).toEqual([]);
});

test('en directo: Disney, su ficha con subparadas y la tarjeta del taxi', async ({ page }) => {
  const errores = await abrir(page, '2026-10-23 10:30');
  await expect(page.locator('#ahora')).toContainText('Disneyland');

  // Hoja arriba y ficha de Disney abierta desde la lista.
  await page.locator('#asa').tap();
  await expect(page.locator('#asa')).toHaveAttribute('aria-expanded', 'true');
  const fila = page.locator('#contenido li.parada .fila', { hasText: 'Shanghai Disneyland' });
  await fila.click();
  const ficha = page.locator('#contenido li.parada.abierta');
  await expect(ficha).toContainText('Shanghai Disneyland');
  expect(await ficha.locator('li.sub').count()).toBeGreaterThan(30);

  // Las de «si da tiempo» van plegadas en una línea.
  const grupo = ficha.locator('.subs-grupo');
  await expect(grupo).toHaveAttribute('aria-expanded', 'false');
  await grupo.click();
  await expect(grupo).toHaveAttribute('aria-expanded', 'true');

  // La píldora «Hotel» enseña la dirección en chino y se cierra con ✕.
  await page.locator('#btn-mapa').click();
  await page.locator('#btn-hotel').click();
  const taxi = page.locator('#taxi');
  await expect(taxi).toBeVisible();
  await expect(page.locator('#taxi-texto')).toContainText('苏河');
  await page.locator('#taxi-cerrar').click();
  await expect(taxi).toBeHidden();

  expect(errores).toEqual([]);
});

test('un móvil que solo mira sigue el plan sin preguntar', async ({ page }) => {
  const errores = await abrir(page, '2026-10-22 15:00', false);
  await expect(page.locator('.segun')).toContainText('según el plan');
  expect(errores).toEqual([]);
});

test.describe('en horizontal', () => {
  test.use({ viewport: { width: 844, height: 390 } });

  test('el itinerario pasa a una página a la izquierda', async ({ page }) => {
    const errores = await abrir(page, '2026-10-24 11:00');
    const caja = await page.locator('#panel').boundingBox();
    expect(caja).not.toBeNull();
    expect(caja!.x).toBeLessThan(80);
    expect(caja!.width).toBeLessThan(844 * 0.65);
    expect(caja!.height).toBeGreaterThan(390 * 0.8);
    expect(errores).toEqual([]);
  });
});
