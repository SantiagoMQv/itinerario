# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

Una persona que organiza y lleva el viaje (el dueño del repositorio) es el usuario principal: la consulta en su móvil antes del viaje para revisar el plan y, sobre todo, durante el viaje, en la calle. Su acompañante (viajan dos personas) la mira de vez en cuando. Ambos hablan español y no leen chino.

## Product Purpose

Herramienta personal para gestionar el itinerario de un viaje: ver el plan de cada día sobre un mapa real, entender las distancias entre lugares y reproducir la ruta hora a hora con una línea de tiempo. Durante el viaje responde de un vistazo a qué toca ahora y después, cómo llegar y cuánto hay, cómo pedirle al taxista que te lleve, y cuánto cuesta y qué queda por confirmar.

El primer viaje es Shanghái con excursión a Nankín (21–26 de octubre de 2026), pero la app debe poder reutilizarse para viajes futuros: nada del producto puede depender de Shanghái.

Éxito: en la calle, con una mano y poca atención, saber adónde ir y cómo, sin conexión a internet y sin tener que preguntar a nadie.

## Positioning

Une en una sola pantalla el mapa y el reloj: la ruta del día se reproduce sobre una línea de tiempo, y cada parada lleva todo lo necesario para ejecutarla en un país cuyo idioma y servicios no son los tuyos (nombre y dirección en el idioma local para enseñar al taxista, enlaces a las apps de mapas locales, coordenadas corregidas, gasto previsto por persona). El contenido es un plan curado con notas y decisiones propias, no un listado genérico de sitios.

## Operating Context

- Uso principal en el móvil, de pie y por la calle, a menudo con sol; también de noche. Uso secundario en el ordenador para revisar el plan.
- En China internet es poco fiable para servicios extranjeros (Google no funciona; algunos dominios pueden fallar sin roaming): la app se instala en la pantalla de inicio y guarda la app y los mapas para funcionar sin conexión.
- El itinerario no se edita desde la app: el usuario pide los cambios en una conversación con Claude, que actualiza los datos (`src/datos/itinerario.ts`) y vuelve a publicar en GitHub Pages.
- Interfaz en español; los nombres de lugares se muestran también en chino.

## Capabilities and Constraints

- Mapa (MapLibre + teselas de OpenFreeMap/OpenStreetMap) con la ruta de cada día en arcos curvos, paradas numeradas, distancia en línea recta y medio de transporte de cada trayecto.
- Línea de tiempo por día con reproducción, saltos entre paradas y velocidad; la cámara sigue el recorrido. Vista «Todo» con todos los días.
- Ficha de cada parada: horario, notas, enlaces, gasto por persona (yuanes y euros aproximados), distancia al hotel, enlaces a Amap, Apple Maps y Google Maps, y tarjeta a pantalla completa para el taxista.
- Planes opcionales, notas por día, secciones de información del viaje (vuelos, hotel, prioridades, descartes) y lista de pendientes que se marcan en el móvil. Piloto (sin publicar): las marcas y las casillas se guardan en el móvil y se comparten entre los dos editores al sincronizar; un acuse del servidor no prueba que el otro móvil lo haya visto.
- Fotos del viaje (piloto, sin publicar): se añaden desde la ficha de cada parada o sitio de dentro y se guardan solo en ese móvil (IndexedDB), con vista previa preparada en el propio móvil. En la web publicada no se envían, no se comparten con el otro móvil y no tienen copia de seguridad.
- Respaldo manual y catálogo de fotos en la interfaz (preparados, apagados en la web publicada): existen solo con una composición explícita en el código; la web publicada pasa `respaldo: null` (ni red, ni base de respaldo, ni texto nuevo) y no hay opción, variable de entorno ni URL que los active. Con la composición: el visor de cada foto dice lo que consta en el registro durable de ESE móvil y ofrece «Respaldar», «Pausar el respaldo» y «Reintentar»/«Reanudar» (siempre la misma operación); en «Todo», «Fotos del viaje» resume esos respaldos y consulta, a un toque y de una en una, las fotos confirmadas en el servidor desde cualquiera de los dos móviles, con «Guardar en este móvil» o «Comprobar y guardar» como segunda acción. Límite aceptado: cada toque es un POST o un GET y nada se envía, consulta, pagina, descarga ni reintenta solo; sin conexión no se prepara nada. «El servidor confirmó la copia» se dice solo con el acuse de ESE envío y nunca se vuelve a comprobar; un acuse perdido deja «sin confirmar» y reintentar no garantiza recuperarlo. Listar, guardar o comprobar nunca cuentan como respaldo confirmado, y una página vacía no prueba que no haya envíos sin confirmar. Borrar una foto de este móvil sigue permitido (D-U1): el aviso dice si puede ser la única copia, un envío propio en curso se pausa antes y el registro del respaldo se conserva; borrada, este móvil no puede volver a guardarla desde el catálogo. Sin espacio, los bytes descargados se ofrecen como archivo y no quedan en las fotos del móvil. No hay sincronización, reparación, limpieza ni activación en Pages: T7 decidirá dónde y cómo se compone.
- Capacidad backend preparada localmente, no función visible: composición Worker/router de respaldo privado POST y descarga GET, con configuración estructurada opcional, sesión comprobada en DB y admisión por solicitud. Incluye catálogo privado GET `/api/fotos/listado` de metadatos INITIAL confirmados, una página por petición explícita, sin R2, escritura, descarga ni acuse de ledger. Comprueba la misma sesión DB antes de consultar y después de la entrega SDK, con vigencia final. Las pruebas usan SQL001–006 real en PGlite propio, transporte del SDK totalmente local y R2 modelado, no proveedores reales; las cotas de retención propias no acreditan heap/GC/CPU/concurrencia ni presupuesto productivo. No hay subida automática; la interfaz manual existe pero está apagada en la web publicada (punto anterior) y su validación sigue pendiente; E3, recuperación de reservas vacías y T7–9 siguen pendientes; T6 no queda cerrado. Una reserva sin objeto devuelve 503 y no garantiza retry; no se promete atomicidad SQL/R2. [Detalle](servidor/README.md).
- PWA con service worker y descarga de mapas para uso sin conexión. Nada puede depender de servicios bloqueados en China (Google Fonts, CDN como jsDelivr): fuentes y recursos van incluidos en la app.
- Coordenadas en WGS-84; las de Amap, Apple Maps (en China) y Trip.com vienen en GCJ-02 y hay que convertirlas.
- Web estática publicada en GitHub Pages desde un repositorio público: el itinerario es visible para quien tenga el enlace.
- Sin decidir: cómo se cargarán otros viajes cuando la app se reutilice (hoy hay un único itinerario en el código).

## Evidence on Hand

- El itinerario real del primer viaje en `src/datos/itinerario.ts`: horarios, notas, enlaces, coordenadas verificadas y precios orientativos sacados de reseñas y guías (los estimados están marcados como tales).
- No hay fotografías de los lugares, logotipo ni identidad visual previa más allá de un icono provisional; no se deben inventar imágenes de lugares reales ni precios o datos que no estén en los datos.

## Product Principles

1. Primero la calle: lo que se necesita en movimiento (qué toca ahora, cómo llegar, la tarjeta del taxista) se encuentra en un gesto y se lee al sol.
2. Funciona sin conexión o no funciona: ninguna pieza esencial puede depender de la red ni de servicios que no estén disponibles en el país de destino.
3. El plan es del viajero: la app muestra decisiones, alternativas y dudas tal como son (opcionales, estimados, pendientes), sin maquillarlas.
4. Reutilizable: el producto sirve para cualquier viaje; lo propio de un destino vive en los datos, no en la interfaz.

## Accessibility & Inclusion

- Legible en exterior con luz solar directa y usable con una mano en un móvil.
- Textos en chino grandes y nítidos donde haya que enseñarlos a otra persona (tarjeta del taxista).
