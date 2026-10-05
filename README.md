# Itinerario del viaje

Web para móvil que sirve para revisar el itinerario de un viaje a Shanghái (con excursión a Nankín) sobre un mapa, con una línea de tiempo que va dibujando la ruta hora a hora.

## Qué hace

- **En directo durante el viaje:** los días del viaje la app se abre en el día de hoy y sigue el horario del plan con la hora real (avanza sola). Lo grande del panel es lo que hay que hacer: «39 min · para salir · 18:20» o «para llegar · 18:30»; al acabar el día, la salida de mañana. Si vas tarde sale «+15 min» con la etiqueta roja «Tarde», y en lo siguiente te dice a qué hora llegarías saliendo ya, con la opción de saltártelo.
- **Marcas solo para corregir:** no hace falta marcar nada; si no marcas, la app da por hecho que vas según el plan. Si no coincide, díselo: «Hecha» (terminaste antes), «Saltar», «Llegué» (de camino) o «Sigo aquí» (cuando el plan ya te ha movido, sale «¿Sigues en…?» unos minutos). Todo se puede deshacer y corregir en la ficha de cada parada. Las marcas se guardan en tu móvil.
- **Repaso:** «Repasar el día», arrastrar la línea de tiempo, saltar de parada o mirar otro día es un repaso del plan: la hora sale en contorno, aparecen los controles de reproducción y la píldora «Volver a ahora» te devuelve al directo. Antes del viaje dice cuántos días faltan.
- **Ahora y después:** junto a la hora, lo que toca ahora (subrayado en fluorescente, igual que su tramo en el mapa y su fila en la lista) y lo siguiente, con medio, distancia, minutos y precio.
- **Taxi a un toque:** botón «Taxi» en lo siguiente si se va en taxi («En chino» si se va a pie o en metro, para preguntar) y la píldora «Hotel» abajo, junto al pulgar. La tarjeta enseña el nombre y la dirección en chino a pantalla completa (también en horizontal), no se apaga la pantalla y solo se cierra con ✕ o el gesto de volver.
- **Distancias:** cada trayecto muestra la distancia en línea recta, el medio de transporte y la duración (real o estimada con `~`). Cada parada indica también a qué distancia está del hotel.
- **Itinerario en lista:** desliza el panel hacia arriba para ver el día entero. Al tocar una parada se abren sus notas, la reserva y botones para abrirla en Amap, Apple Maps o Google Maps (leerla no cambia la hora).
- **Todo el viaje:** la pestaña «Todo» enseña todos los días a la vez, cada uno de un color, con la lista de pendientes («3 de 7») y la fecha del plan que lleva tu móvil. Antes del viaje la app se abre aquí, con «Antes de salir»: lo pendiente por comprobar y el botón para guardar los mapas.
- **Sin conexión:** el botón «Mapas» guarda la app y los mapas de todas las zonas del viaje (unos 30 MB). Si te quedas sin internet, una píldora lo avisa junto a «Hotel».
- **Claro o noche:** el botón «Noche» cambia a modo noche (y «Claro», de vuelta). Se recuerda en el móvil.

## Cambiar el itinerario

Todo el itinerario está en [`src/datos/itinerario.ts`](src/datos/itinerario.ts). Cada parada lleva:

| Campo | Ejemplo | Notas |
| --- | --- | --- |
| `hora` | `'09:00'` | Hora de llegada, en hora de China. |
| `fin` | `'11:00'` | Opcional. Si falta, se calcula con la siguiente parada. |
| `nombre` / `local` | `'Jardín Yuyuan'` / `'豫园'` | El nombre en chino es el que se enseña al taxista. |
| `categoria` | `'cultura'` | `hotel`, `comida`, `cultura`, `museo`, `mirador`, `barrio`, `naturaleza`, `compras`, `ocio`, `transporte`, `otro`. |
| `lat` / `lng` | `31.2289, 121.4879` | Coordenadas WGS-84 (las de OpenStreetMap o el GPS, **no** las de Amap o Baidu, que van desplazadas unos 500 m). |
| `llegada` | `{ modo: 'metro', detalle: 'Línea 10', min: 20 }` | Cómo se llega desde la parada anterior: `a_pie`, `metro`, `taxi`, `bus`, `tren`, `maglev`, `ferry`, `avion`, `bici`. |
| `notas`, `direccion`, `direccionLocal`, `reserva` | | Opcionales. |

Los hoteles no llevan número en el mapa (salen con una H). Si hay algo incoherente (una hora anterior a la de la parada previa, por ejemplo), la app lo avisa arriba.

## Desarrollo

```sh
npm install
npm run dev      # servidor local
npm run build    # comprueba tipos y genera dist/
```

Hecho con Vite, TypeScript y MapLibre GL. El mapa usa [OpenFreeMap](https://openfreemap.org) (datos de OpenStreetMap), que no necesita clave. La web es estática: cualquier hosting gratuito sirve (GitHub Pages, Cloudflare Pages, Vercel…).

## Consejos para usarla en China

- Antes del viaje, abre la web en el móvil y **añádela a la pantalla de inicio**. En iPhone, Safari borra los datos de las webs que no se abren en 7 días, pero no los de las apps instaladas así.
- Con buena conexión, pulsa ⬇ para guardar los mapas. Vuelve a hacerlo si cambia el itinerario y se añaden zonas nuevas.
- Con una eSIM o tarjeta extranjera (roaming) todo funciona como en casa. Con una SIM china o el wifi del hotel, algunos servicios extranjeros pueden fallar; con los mapas guardados la app sigue funcionando.
