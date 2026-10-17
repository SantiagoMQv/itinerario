import { expect, test, type Page, type Locator } from '@playwright/test';
import { itinerario } from '../src/datos/itinerario';
import { construirModelo } from '../src/modelo';
import type { DestinoFoto, MetadatosFoto } from '../src/fotos';

/** Imágenes sintéticas legibles, añadidas por el selector real; no fotos ni datos del usuario. */
async function anadirMuestras(page: Page, cantidad = 3, camara: Locator = page.locator('[data-camara-parada]:visible').first()) {
  const colores = ['#2453d1', '#177968', '#b84c00'];
  for (let i = 0; i < cantidad; i++) {
    const datos = await page.evaluate(({ color, numero }) => {
      const lienzo = document.createElement('canvas'); lienzo.width = 480; lienzo.height = 360;
      const ctx = lienzo.getContext('2d')!;
      ctx.fillStyle = color; ctx.fillRect(0, 0, 480, 360);
      ctx.fillStyle = '#dfd7c6'; ctx.fillRect(0, 250, 480, 110);
      ctx.fillStyle = '#162236'; ctx.beginPath(); ctx.moveTo(0, 250); ctx.lineTo(150, 90); ctx.lineTo(300, 250); ctx.fill();
      ctx.fillStyle = '#f4d779'; ctx.beginPath(); ctx.arc(360, 70, 35, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = '#fff'; ctx.font = 'bold 24px sans-serif'; ctx.fillText(`MUESTRA ${numero}`, 18, 36);
      return lienzo.toDataURL('image/png').split(',')[1];
    }, { color: colores[i % colores.length], numero: i + 1 });
    const selector = page.waitForEvent('filechooser');
    await camara.click();
    await (await selector).setFiles({ name: `muestra-${i + 1}.png`, mimeType: 'image/png', buffer: Buffer.from(datos, 'base64') });
    await expect(page.locator('.fotos-cuenta').filter({ hasText: `· ${i + 1} en este móvil` }).first()).toBeAttached();
  }
}

/** Reubica únicamente las capturas sintéticas de ESTA prueba, como fotos conservadas de un plan anterior. */
async function reubicarMuestras(page: Page, destinos: readonly DestinoFoto[]) {
  await page.evaluate(async ({ nombre, destinos }) => {
    const db = await new Promise<IDBDatabase>((ok, no) => {
      const r = indexedDB.open(nombre); r.onsuccess = () => ok(r.result); r.onerror = () => no(r.error);
    });
    await new Promise<void>((ok, no) => {
      const tx = db.transaction('metadatos', 'readwrite');
      const r = tx.objectStore('metadatos').openCursor();
      let i = 0;
      r.onsuccess = () => {
        const cursor = r.result;
        if (!cursor) return;
        const m = cursor.value as MetadatosFoto;
        cursor.update({ ...m, destino: destinos[i++] }); cursor.continue();
      };
      tx.oncomplete = () => { db.close(); i === destinos.length ? ok() : no(new Error('Cantidad de muestras inesperada')); };
      tx.onabort = () => { db.close(); no(tx.error); };
    });
  }, { nombre: `itinerario-fotos:${encodeURIComponent(itinerario.id)}`, destinos });
}

test('las fotos retiradas respetan el día elegido antes de terminar IndexedDB', async ({ page }) => {
  await page.clock.setFixedTime(new Date('2026-10-21T16:10:00+08:00'));
  await page.goto('/');
  await anadirMuestras(page, 1);
  const retirada = itinerario.retiradas!.paradas![0];
  await reubicarMuestras(page, [{ tipo: 'parada', viajeId: itinerario.id, paradaId: retirada.id }]);
  // Se retiene la entrega de una apertura REAL, no se sustituyen ni metadata ni resultados de IndexedDB.
  await page.addInitScript((base) => {
    const abrir = indexedDB.open.bind(indexedDB);
    indexedDB.open = (nombre, version) => {
      const r = abrir(nombre, version);
      if (nombre === base) r.addEventListener('success', (e) => {
        e.stopImmediatePropagation();
        document.documentElement.dataset.aperturaFotosRetenida = 'true';
        addEventListener('prueba-liberar-fotos', () => r.dispatchEvent(new Event('success')), { once: true });
      }, { once: true });
      return r;
    };
  }, `itinerario-fotos:${encodeURIComponent(itinerario.id)}`);
  await page.reload();
  await page.getByRole('button', { name: 'Abrir fotos del viaje' }).click();
  const album = page.getByRole('dialog', { name: 'Fotos del viaje' });
  const filtro = album.getByRole('combobox', { name: 'Día de las fotos' });
  const retiradas = album.locator('[data-fotos-retiradas]');
  await filtro.selectOption('1');
  await expect(retiradas).toBeHidden();
  await expect(page.locator('html')).toHaveAttribute('data-apertura-fotos-retenida', 'true');
  await page.evaluate(() => dispatchEvent(new Event('prueba-liberar-fotos')));
  await expect(retiradas.locator('.retirada-nombre')).toHaveText(retirada.nombre);
  await expect(retiradas).toBeHidden();
  await expect(filtro).toHaveValue('1');
  await filtro.selectOption('todos');
  await expect(retiradas).toBeVisible();
});

test('borrar la última foto devuelve el foco dentro del álbum, sin taparlo con el selector', async ({ page }) => {
  await page.setViewportSize({ width: 360, height: 640 });
  await page.clock.setFixedTime(new Date('2026-10-21T16:10:00+08:00'));
  await page.goto('/');
  await anadirMuestras(page);
  const destinos = itinerario.dias[0].paradas.slice(0, 3).map((p): DestinoFoto => ({ tipo: 'parada', viajeId: itinerario.id, paradaId: p.id }));
  await reubicarMuestras(page, destinos);
  await page.reload();
  await page.getByRole('button', { name: 'Abrir fotos del viaje' }).click();
  const album = page.getByRole('dialog', { name: 'Fotos del viaje' });
  const bloque = album.locator(`[data-fotos-destino="p:${destinos[0].paradaId}"]`);
  await bloque.locator('[data-foto-id]').click();
  await page.getByRole('button', { name: 'Borrar de este móvil', exact: true }).click();
  await page.getByRole('button', { name: 'Borrar', exact: true }).click();
  const foco = bloque.locator('[data-fotos-anadir]');
  await expect(foco).toBeFocused();
  await expect(foco).toBeInViewport({ ratio: 1 });
  const navegacion = await album.locator('.album-navegacion').boundingBox();
  const limites = await foco.boundingBox();
  expect(limites!.y).toBeGreaterThanOrEqual(navegacion!.y + navegacion!.height);
  expect(limites!.y + limites!.height).toBeLessThanOrEqual(640);
});

test('el álbum prioriza fotos, filtra días y recoge los lugares sin fotos', async ({ page }) => {
  await page.setViewportSize({ width: 360, height: 640 });
  await page.clock.setFixedTime(new Date('2026-10-21T16:10:00+08:00'));
  await page.goto('/');
  await anadirMuestras(page);
  await page.getByRole('button', { name: 'Abrir fotos del viaje' }).click();
  const album = page.getByRole('dialog', { name: 'Fotos del viaje' });
  const dia = album.getByRole('combobox', { name: 'Día de las fotos' });
  await expect(dia).toHaveValue('todos');
  await expect(album.locator('[data-album-cuenta]').first()).toHaveText('3 fotos en este móvil · todo el viaje');
  const foto = album.locator('[data-foto-id]').first();
  await expect(foto).toBeVisible();
  await expect.poll(async () => (await foto.boundingBox())?.y ?? Infinity).toBeLessThan(300);
  await expect(album.locator('.album-vacios').first()).not.toHaveAttribute('open');
  await expect(album.locator('[data-fotos-anadir]:visible')).toHaveCount(0);
  await dia.focus();
  await dia.selectOption('1');
  await expect(album.locator('[data-album-dia="0"]')).toBeHidden();
  await expect(album.locator('[data-album-dia="1"]')).toBeVisible();
  await expect(dia).toBeFocused();
  await expect(album.locator('[data-album-cuenta]')).toHaveText('3 fotos en este móvil · todo el viaje');
  await dia.selectOption('todos');
  await expect(foto).toBeVisible();
  await album.locator('.utilidades-contenido').evaluate((e) => { e.scrollTop = 400; });
  const cabecera = await album.locator('.utilidades-cabecera').boundingBox();
  expect((await dia.boundingBox())!.y).toBeGreaterThanOrEqual(cabecera!.y + cabecera!.height);
  await expect(album.locator('[data-album-ayuda]')).toHaveCount(1);
  await expect(album).not.toContainText('Tus fotos y las compartidas');
});

test('el álbum vacío permite añadir y borrar sin perder una salida de foco visible', async ({ page }) => {
  await page.clock.setFixedTime(new Date('2026-10-21T16:10:00+08:00'));
  await page.goto('/');
  await page.getByRole('button', { name: 'Abrir fotos del viaje' }).click();
  const album = page.getByRole('dialog', { name: 'Fotos del viaje' });
  await expect(album.locator('[data-album-cuenta]')).toHaveText('0 fotos en este móvil · todo el viaje');
  await expect(album.locator('[data-album-inicio]')).toBeVisible();
  await album.locator('.album-vacios').first().locator('summary').first().click();
  const clave = await album.locator('[data-fotos-destino]').first().getAttribute('data-fotos-destino');
  const bloque = album.locator(`[data-fotos-destino="${clave}"]`);
  await bloque.locator('.album-acciones > summary').click();
  await anadirMuestras(page, 1, bloque.getByRole('button', { name: /Tomar foto/ }));
  await expect(album.locator('[data-album-cuenta]')).toHaveText('1 foto en este móvil · todo el viaje');
  await expect(album.locator('.album-vacios [data-foto-id]')).toHaveCount(0);
  await bloque.locator('[data-foto-id]').click();
  await page.getByRole('button', { name: 'Borrar de este móvil', exact: true }).click();
  await page.getByRole('button', { name: 'Borrar', exact: true }).click();
  await expect(album.locator('[data-album-cuenta]')).toHaveText('0 fotos en este móvil · todo el viaje');
  await expect(bloque.locator('[data-fotos-anadir]')).toBeVisible();
  await expect(bloque.locator('[data-fotos-anadir]')).toBeFocused();
});

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
  await anadirMuestras(page, 1);
  await page.getByRole('button', { name: 'Abrir fotos del viaje' }).click();
  const album = page.getByRole('dialog', { name: 'Fotos del viaje' });
  await album.getByRole('combobox', { name: 'Día de las fotos' }).selectOption('0');
  const bloque = album.locator('[data-fotos-destino]').filter({ has: page.locator('[data-foto-id]') }).first();
  await expect(bloque.locator('[data-foto-id]')).toHaveCount(1);
  const posicion = await album.locator('.utilidades-contenido').evaluate((e) => e.scrollTop);
  await bloque.locator('[data-foto-id]').click();
  await page.getByRole('button', { name: 'Cerrar la foto' }).click();
  await page.waitForTimeout(100);
  await expect(album).toBeVisible();
  await expect(album.getByRole('combobox', { name: 'Día de las fotos' })).toHaveValue('0');
  await expect(bloque.locator('[data-foto-id]')).toBeFocused();
  expect(await album.locator('.utilidades-contenido').evaluate((e) => e.scrollTop)).toBe(posicion);
});

for (const [ancho, alto, oscuro] of [[390, 844, false], [360, 640, false], [690, 829, false], [829, 690, false], [390, 844, true]] as const) {
  test(`lectura y álbum ${ancho}×${alto}${oscuro ? ' noche' : ''}`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width: ancho, height: alto });
    await page.emulateMedia({ colorScheme: oscuro ? 'dark' : 'light' });
    await page.clock.setFixedTime(new Date('2026-10-21T16:10:00+08:00'));
    await page.goto('/');
    const abrir = page.locator('#ahora [data-abrir]').first();
    await expect(abrir.locator('.pista-detalles')).toHaveText('Ver detalles');
    await expect(abrir.locator('.pista-detalles')).toBeVisible();
    expect((await abrir.boundingBox())!.height).toBeGreaterThanOrEqual(44);
    const deslizador = page.locator('#deslizador');
    expect((await deslizador.boundingBox())!.height).toBeGreaterThanOrEqual(44);
    await abrir.click();
    await expect(page.locator('#contenido li.parada.abierta')).toHaveCount(1);
    const detalle = page.locator('#contenido li.parada.abierta > .detalle');
    expect(await detalle.evaluate((e) => {
      const notas = e.querySelector(':scope > .notas')!;
      return ['[data-camara-parada]', '[data-taxi]', 'a[href^="https://uri.amap.com/"]', '[data-mas-mapas]'].every((selector) => {
        const accion = e.querySelector(selector)!;
        return Boolean(accion.compareDocumentPosition(notas) & Node.DOCUMENT_POSITION_FOLLOWING)
          && accion.getBoundingClientRect().bottom <= notas.getBoundingClientRect().top;
      });
    })).toBe(true);
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
    await page.screenshot({ path: testInfo.outputPath(`album-vacio-${ancho}-${alto}${oscuro ? '-noche' : ''}.png`) });
    await page.getByRole('button', { name: 'Volver al itinerario' }).click();
    await anadirMuestras(page);
    await page.getByRole('button', { name: 'Abrir fotos del viaje' }).click();
    await expect(page.locator('#utilidades [data-foto-id]')).toHaveCount(3);
    await expect(page.locator('#utilidades [data-foto-id] img').first()).toBeVisible();
    await page.screenshot({ path: testInfo.outputPath(`album-poblado-${ancho}-${alto}${oscuro ? '-noche' : ''}.png`) });
    await page.getByRole('button', { name: 'Volver al itinerario' }).click();
    await page.setViewportSize({ width: alto, height: ancho });
    await expect(page.locator('#contenido li.parada.abierta')).toHaveAttribute('data-id', seleccion!);
    if (oscuro) {
      // Estado real de camino, no una clase añadida por la prueba. El reloj del modelo está en hora de China.
      const tramo = construirModelo(itinerario).tramos.find((t) => t.detalle && !t.nulo && t.llegada > t.salida)!;
      await page.clock.setFixedTime(new Date(((tramo.salida + tramo.llegada) / 2 - 8 * 60) * 60000));
      await page.reload();
      const texto = page.locator('li.tramo.actual small:not(.apretado)').first();
      await expect(texto).toBeAttached();
      const colores = await texto.evaluate((e) => {
        const raiz = getComputedStyle(document.documentElement);
        const color = getComputedStyle(e).color;
        const papel = raiz.getPropertyValue('--papel').trim();
        const tinta = raiz.getPropertyValue('--tinta').trim();
        const rgb = (hex: string) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
        const luminancia = (canales: number[]) => canales.map((c) => c / 255).map((c) => c <= .04045 ? c / 12.92 : ((c + .055) / 1.055) ** 2.4)
          .reduce((suma, c, i) => suma + c * [0.2126, 0.7152, 0.0722][i]!, 0);
        const valores = [luminancia(color.match(/\d+/g)!.map(Number)), luminancia(rgb(papel))].sort((a, b) => b - a);
        return { color, esperado: `rgb(${rgb(tinta).join(', ')})`, contraste: (valores[0]! + .05) / (valores[1]! + .05) };
      });
      expect(colores.color).toBe(colores.esperado);
      expect(colores.contraste).toBeGreaterThanOrEqual(4.5);
    }
  });
}
