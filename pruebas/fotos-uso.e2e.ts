import { expect, test } from '@playwright/test';

test('fotos y ajustes tienen acceso propio sin abandonar el contexto del itinerario', async ({ page }) => {
  await page.clock.setFixedTime(new Date('2026-10-21T16:10:00+08:00'));
  await page.goto('/');
  await expect(page.locator('#contenido')).not.toBeEmpty();
  const hora = await page.locator('#hora').innerText();
  await page.getByRole('button', { name: 'Abrir fotos del viaje' }).click();
  await expect(page.getByRole('dialog', { name: 'Fotos del viaje' })).toBeVisible();
  await page.getByRole('button', { name: 'Volver al itinerario' }).click();
  await expect(page.locator('#hora')).toHaveText(hora);
  await page.getByRole('button', { name: 'Abrir ajustes' }).click();
  await expect(page.getByRole('dialog', { name: 'Ajustes' })).toBeVisible();
  await page.getByRole('button', { name: 'Volver al itinerario' }).click();
  await expect(page.locator('#ahora').getByRole('button', { name: /Tomar foto/ })).toBeVisible();
});

test('cerrar el visor conserva abierto el álbum, el desplazamiento y su foto enfocada', async ({ page }) => {
  await page.clock.setFixedTime(new Date('2026-10-21T16:10:00+08:00'));
  await page.goto('/');
  await page.getByRole('button', { name: 'Abrir fotos del viaje' }).click();
  const album = page.getByRole('dialog', { name: 'Fotos del viaje' });
  const bloque = album.locator('[data-fotos-destino]').first();
  await expect(bloque.locator('[data-fotos-anadir]')).toBeVisible();
  const selector = page.waitForEvent('filechooser');
  await bloque.locator('[data-fotos-anadir]').click();
  await (await selector).setFiles({ name: 'recuerdo.png', mimeType: 'image/png', buffer: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aB1EAAAAASUVORK5CYII=', 'base64') });
  await expect(bloque.locator('[data-foto-id]')).toHaveCount(1);
  const posicion = await album.locator('.utilidades-contenido').evaluate((e) => e.scrollTop);
  await bloque.locator('[data-foto-id]').click();
  await page.getByRole('button', { name: 'Cerrar la foto' }).click();
  await page.waitForTimeout(100);
  await expect(album).toBeVisible();
  await expect(bloque.locator('[data-foto-id]')).toBeFocused();
  expect(await album.locator('.utilidades-contenido').evaluate((e) => e.scrollTop)).toBe(posicion);
});

for (const [ancho, alto, oscuro] of [[390, 844, false], [360, 640, false], [690, 829, false], [829, 690, false], [390, 844, true]] as const) {
  test(`lectura y álbum ${ancho}×${alto}${oscuro ? ' noche' : ''}`, async ({ page }) => {
    await page.setViewportSize({ width: ancho, height: alto });
    await page.emulateMedia({ colorScheme: oscuro ? 'dark' : 'light' });
    await page.clock.setFixedTime(new Date('2026-10-21T16:10:00+08:00'));
    await page.goto('/');
    await page.locator('#ahora [data-abrir]').first().click();
    await expect(page.locator('#contenido li.parada.abierta')).toHaveCount(1);
    await page.waitForTimeout(450);
    const seleccion = await page.locator('#contenido li.parada.abierta').getAttribute('data-id');
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    if (ancho === 829) {
      const cabecera = await page.locator('#cabecera').boundingBox();
      expect(cabecera!.height).toBeLessThan(270);
      const reloj = await page.locator('#reloj').boundingBox();
      const ahora = await page.locator('#ahora').boundingBox();
      expect(reloj!.y + reloj!.height).toBeLessThanOrEqual(ahora!.y);
    }
    if (process.env.CAPTURAS_UX) await page.screenshot({ path: `${process.env.CAPTURAS_UX}/ficha-${ancho}-${alto}${oscuro ? '-noche' : ''}.png` });
    await page.getByRole('button', { name: 'Abrir fotos del viaje' }).click();
    await expect(page.getByRole('dialog', { name: 'Fotos del viaje' })).toBeVisible();
    await page.waitForTimeout(200);
    if (process.env.CAPTURAS_UX) await page.screenshot({ path: `${process.env.CAPTURAS_UX}/album-${ancho}-${alto}${oscuro ? '-noche' : ''}.png` });
    await page.getByRole('button', { name: 'Volver al itinerario' }).click();
    await page.setViewportSize({ width: alto, height: ancho });
    await expect(page.locator('#contenido li.parada.abierta')).toHaveAttribute('data-id', seleccion!);
  });
}
