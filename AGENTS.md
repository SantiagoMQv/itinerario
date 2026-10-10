# Guía para agentes

Web para móvil (PWA estática) con el itinerario de un viaje a Shanghái y Nankín del 21 al 26 de octubre de 2026. Se publica en GitHub Pages desde `main`: <https://santiagomqv.github.io/itinerario/>. Se usa sobre todo en el móvil, en directo durante el viaje.

## Idioma

Todo en español: la interfaz, los comentarios, los nombres del código (`parada`, `tramo`, `hoja`…), la documentación y los mensajes de commit. Los commits dicen qué cambia para quien usa la app («Día 2: Disneyland con imprescindibles y entradas»), no qué archivos se tocaron.

## Mapa del código

| Archivo | Qué hay |
| --- | --- |
| `src/datos/itinerario.ts` | El plan: días, paradas, subparadas, notas, precios. Casi todos los cambios de contenido son aquí. |
| `src/tipos.ts` | Formato del itinerario, con un comentario por campo. |
| `src/modelo.ts` | Convierte el plan en horas absolutas, tramos y avisos de incoherencias. |
| `src/main.ts` | Interfaz: panel (hoja de tres alturas en móvil), «ahora», lista, fichas, marcas, tarjeta del taxi. |
| `src/mapa.ts` | Mapa (MapLibre + OpenFreeMap), marcadores, cámara. |
| `src/offline.ts` | Service worker y descarga de mapas para usar sin conexión. |
| `src/estilos.css` | Estilos. Tokens de color en `:root`; la noche, con `:root[data-tema='oscuro']`. |
| `DESIGN.md`, `PRODUCT.md` | Sistema visual y comportamiento del producto. Son la referencia para cualquier cambio de interfaz. |
| `pruebas/` | `*.test.ts`: pruebas del plan y utilidades (Vitest). `*.e2e.ts`: pruebas de humo en un móvil simulado (Playwright). |

## Reglas del plan (`src/datos/itinerario.ts`)

- **Coordenadas WGS-84**, las de OpenStreetMap o el GPS. Nunca las de Amap, Baidu o Google China (GCJ-02): van desplazadas unos 500 m. Se guardan en las constantes `C` (y `D` para Disneyland) como `[lat, lng]`, con un comentario si la posición es aproximada.
- **Nombre en chino** (`local`, `direccionLocal`): es lo que se enseña al taxista. Que lleve caracteres chinos.
- **Horas** en hora de China, `"HH:MM"`; pasada la medianoche del mismo día de plan se escribe `"24:30"`. Cada parada empieza después de la anterior y los trayectos tienen que caber en el hueco (las pruebas lo comprueban).
- **Las marcas del usuario** («Hecha», «Saltar»…) se guardan en su móvil con la clave `fecha|hora|nombre`. Cambiar la hora o el nombre de una parada que ya se ha marcado pierde esa marca: durante el viaje, evitarlo salvo que se pida.
- **`corto`**: nombre corto con artículo («el Bund») para botones como «Saltar el Bund». Hasta 16 caracteres.
- **Subparadas**: sitios dentro de una parada, a menos de 2 km. Seguras por defecto; `opcional: true` para «si da tiempo». Sin `lat`/`lng` están en la misma parada.
- Los datos investigados (horarios, precios, direcciones) se contrastan con fuentes y se enlazan en `enlaces` cuando importan para decidir.

## Interfaz

- Primero el móvil en vertical (390 × 844 y también 360 × 640). Luego el móvil en horizontal y pantallas anchas.
- Las consultas de pantalla están duplicadas en `estilos.css` y en `main.ts` (`pantallaAncha`, `panelCorrido`; móvil es lo que no es ancho). Si cambia una, cambia la otra.
- Antes de tocar diseño, leer `DESIGN.md`. Si cambia un comportamiento visible, actualizar `DESIGN.md` y la lista «Qué hace» del `README.md`.
- Accesibilidad: objetivos táctiles de 44 px, foco visible, `aria-*` correctos, contraste AA también de noche.

## Comandos

```sh
npm ci                        # dependencias (Node 22, ver .nvmrc)
npm run dev                   # servidor local en http://localhost:5173
npm run check                 # tipos (app y pruebas)
npm test                      # pruebas del plan (Vitest)
npx playwright install chromium   # solo la primera vez
npm run test:e2e              # compila y prueba la web en un móvil simulado
npm run verify                # todo lo anterior: pasarlo antes de integrar en main
```

## Ramas y publicación

- `main` es lo publicado: cada push a `main` se comprueba y, si todo pasa, se publica en GitHub Pages en un par de minutos. Si algo falla, la web se queda como estaba.
- Se trabaja en una rama propia que sale de `main` actualizada (`git switch -c <tema> origin/main`). Cada push a cualquier rama pasa las mismas comprobaciones en GitHub Actions.
- Antes de integrar: `git fetch origin`, traer `main` a la rama (merge o rebase de la rama propia), `npm run verify` y entonces integrar en `main` (fast-forward o pull request). Nunca `push --force` a `main`.
- Puede haber más de un agente a la vez: no reescribir el historial de ramas ajenas y, si dos trabajos tocan `src/datos/itinerario.ts`, integrar uno antes de empezar el otro.
- No se suben `dist/`, `node_modules/`, resultados de pruebas ni claves. La app no necesita ninguna clave (OpenFreeMap es abierto).
