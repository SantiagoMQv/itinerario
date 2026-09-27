# Itinerario del viaje

Web para móvil que sirve para revisar el itinerario de un viaje a Shanghái (con excursión a Nankín) sobre un mapa, con una línea de tiempo que va dibujando la ruta hora a hora.

## Qué hace

- **Línea de tiempo por día:** arrastra el control o pulsa ▶ y la ruta se va dibujando, con un punto que avanza entre paradas. ⏮ ⏭ saltan de parada en parada y ×1…×8 cambia la velocidad.
- **Distancias:** cada trayecto muestra la distancia en línea recta, el medio de transporte y la duración (real o estimada con `~`). Cada parada indica también a qué distancia está del hotel.
- **Itinerario en lista:** desliza el panel hacia arriba para ver el día entero. Al tocar una parada se abren sus notas, la reserva y botones para abrirla en Amap, Apple Maps o Google Maps.
- **Enseñar al taxista:** muestra el nombre en chino a pantalla completa.
- **Todo el viaje:** la pestaña «Todo» enseña todos los días a la vez, cada uno de un color.
- **Sin conexión:** el botón ⬇ guarda la app y los mapas de todas las zonas del viaje (unos 30 MB).

Si hoy es un día del viaje (hora de China), la app se abre directamente en ese día y a esa hora.

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

Los hoteles no llevan número en el mapa (salen como 🏨). Si hay algo incoherente (una hora anterior a la de la parada previa, por ejemplo), la app lo avisa arriba.

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
