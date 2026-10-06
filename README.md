# Itinerario del viaje

Web para móvil que sirve para revisar el itinerario de un viaje a Shanghái (con excursión a Nankín) sobre un mapa, con una línea de tiempo que va dibujando la ruta hora a hora.

## Qué hace

- **En directo durante el viaje:** los días del viaje la app se abre en el día de hoy y sigue el horario del plan con la hora real (avanza sola). Lo grande del panel es lo que hay que hacer: «39 min · para salir · 18:20» o «para llegar»; al acabar el día, la hora de salida de mañana. Si vas tarde sale «+15 min» con la etiqueta roja «Tarde», y en lo siguiente te dice a qué hora llegarías saliendo ya y cuánto podrías estar allí; si no da tiempo, te propone «Saltarla».
- **Marcas solo para corregir:** no hace falta marcar nada; si no marcas, la app da por hecho que vas según el plan. Si no coincide, díselo: «Hecha» (terminaste antes: cuenta el camino desde ese momento y te dice a qué hora llegas), «Saltar», «Llegué» (de camino) o «Sigo aquí» (cuando el plan ya te ha movido, sale «¿Sigues en…?» unos minutos). Todo se puede deshacer y corregir en la ficha de cada parada. Las marcas se guardan en tu móvil.
- **Quien solo mira:** en un móvil donde nunca se ha marcado nada, la app sigue el plan en silencio, sin preguntas. Así va el móvil de tu acompañante. La primera vez que se marca algo en un móvil, pregunta antes si ese móvil va a llevar el viaje.
- **El plan, honesto:** si un trayecto no cabe en el hueco que le deja el plan, lo dice en «Antes de salir» y en la lista («No da tiempo: solo hay 10 min para ~20 min»).
- **Repaso:** «Repasar el día», arrastrar la línea de tiempo, saltar de parada o mirar otro día es un repaso del plan: la hora sale en contorno, aparecen los controles de reproducción y la píldora «Volver a ahora» te devuelve al directo. Antes del viaje dice cuántos días faltan.
- **Ahora y después:** junto a la hora, lo que toca ahora (subrayado en fluorescente, igual que su tramo en el mapa y su fila en la lista) y lo siguiente, con medio, distancia, minutos y precio.
- **Taxi a un toque:** botón «Taxi» en lo siguiente si se va en taxi («En chino» si se va a pie o en metro, con «¿Cómo llego?» en chino para preguntar) y la píldora «Hotel» abajo, junto al pulgar. La tarjeta enseña el nombre y la dirección en chino a pantalla completa (también en horizontal), sin partir nunca un número ni una palabra; no se apaga la pantalla y solo se cierra con ✕ o el gesto de volver.
- **Distancias:** cada trayecto muestra la distancia en línea recta, el medio de transporte y la duración (real o estimada con `~`). Cada parada indica también a qué distancia está del hotel.
- **Subparadas:** cada parada puede tener sitios dentro (las tiendas de una calle, los puestos de un mercado, el restaurante de un edificio), seguros o «si da tiempo». En «ahora» salen en una línea («Aquí: No. 1 Department Store, First Food Store · +1 si da tiempo»); en la ficha, en dos grupos con su letra, para verlos en el mapa o enseñarlos en chino; y en el mapa, la parada que se está mirando enseña sus sitios con sellos pequeños (discontinuos los de «si da tiempo»).
- **Itinerario en lista:** el panel se arrastra con el dedo a tres alturas: abajo del todo (la cuenta atrás y de dónde sales o adónde vas; casi todo mapa), a media altura o arriba para ver el día entero (desde ahí, «Mapa» al pie lo vuelve a bajar). Al tocar una parada en la lista se abren sus notas, la reserva y botones para abrirla en Amap, Apple Maps o Google Maps; al tocarla en el mapa sale una ficha corta encima, sin tapar el mapa (leerla no cambia la hora).
- **Móvil en horizontal y móviles pequeños:** girado, el itinerario pasa a una página a la izquierda que se desplaza entera; en móviles bajos, «Después» va en una sola fila y los botones del mapa en fila arriba.
- **Todo el viaje:** la pestaña «Todo» enseña todos los días a la vez, cada uno de un color, con la lista de pendientes («3 de 7») y la fecha del plan que lleva tu móvil. Antes del viaje la app se abre aquí, con «Antes de salir»: lo pendiente por comprobar y el botón para guardar los mapas.
- **Sin conexión:** el botón «Mapas» guarda la app y los mapas de todas las zonas del viaje (unos 30 MB). Si te quedas sin internet, una píldora lo avisa junto a «Hotel».
- **Claro o noche:** sin tocar nada, sigue al móvil (si se pone oscuro al anochecer, la app también). El botón «Noche» / «Claro» lo fija a mano y se recuerda.

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
| `subparadas` | `[{ nombre: 'First Food Store', local: '第一食品商店', lat: 31.2375, lng: 121.4722, notas: 'Snacks' }]` | Sitios dentro de la parada (tiendas de una calle, puestos de un mercado…), sin hora propia. Con `opcional: true` van en «Si da tiempo». Sin `lat`/`lng`, están en la misma parada. |

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
