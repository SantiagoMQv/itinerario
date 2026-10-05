---
name: Itinerario
description: El día como una página de cuaderno de campo que se va marcando mientras se vive.
colors:
  papel: "#ffffff"
  reticula: "#dce7f2"
  tinta: "#14213d"
  tinta-suave: "#4f5b73"
  tinta-fija-suave: "#3a4660"
  hecho: "#1e7f3e"
  margen: "#e0454d"
  fluor: "#ddf94a"
  fluor-suave: "#ebfaaa"
  etiqueta: "#e2ecf6"
  etiqueta-texto: "#33415c"
  kraft: "#a8804f"
  pestana-todo: "#efe3d2"
  dia-cobalto: "#2453d1"
  dia-verde-hoja: "#1e7f3e"
  dia-magenta: "#c8327e"
  dia-naranja: "#c45200"
  dia-verde-azulado: "#00777a"
  dia-ciruela: "#7a2e8e"
  dia-rojo: "#b3261e"
  dia-oliva: "#5c6b12"
  dia-tabaco: "#8a4b1f"
  dia-indigo: "#3949ab"
  mapa-agua: "#c8ddf2"
  mapa-parque: "#deecd6"
  papel-noche: "#121820"
  tinta-noche: "#e8ecf2"
  tinta-suave-noche: "#a5b0c3"
  margen-noche: "#ff6b72"
  fluor-suave-noche: "#d3ec4a"
  etiqueta-noche: "#1f2a3a"
  etiqueta-texto-noche: "#c3cfe1"
  kraft-noche: "#2a2119"
  pestana-todo-noche: "#4a3d2e"
  boton-mapa-noche: "#1b2330"
  mapa-agua-noche: "#16304d"
  mapa-parque-noche: "#1a2a24"
typography:
  display:
    fontFamily: "Archivo Variable, Archivo, system-ui, -apple-system, Segoe UI, Roboto, PingFang SC, Hiragino Sans GB, Noto Sans SC, Microsoft YaHei, sans-serif"
    fontSize: "50px"
    fontWeight: 800
    lineHeight: 0.92
    letterSpacing: "0.01em"
    fontFeature: "tnum"
    fontVariation: "'wdth' 62"
  headline:
    fontFamily: "Archivo Variable, Archivo, system-ui, sans-serif"
    fontSize: "30px"
    fontWeight: 800
    lineHeight: 1.02
    fontVariation: "'wdth' 75"
  title:
    fontFamily: "Archivo Variable, Archivo, system-ui, sans-serif"
    fontSize: "17px"
    fontWeight: 700
    lineHeight: 1.24
    fontVariation: "'wdth' 92"
  title-sm:
    fontFamily: "Archivo Variable, Archivo, system-ui, sans-serif"
    fontSize: "16px"
    fontWeight: 700
    lineHeight: 1.24
    fontVariation: "'wdth' 92"
  body:
    fontFamily: "Archivo Variable, Archivo, system-ui, sans-serif"
    fontSize: "15.5px"
    fontWeight: 500
    lineHeight: 1.3
    fontFeature: "tnum"
  body-prose:
    fontFamily: "Archivo Variable, Archivo, system-ui, sans-serif"
    fontSize: "15px"
    fontWeight: 400
    lineHeight: 1.45
  meta:
    fontFamily: "Archivo Variable, Archivo, system-ui, sans-serif"
    fontSize: "14px"
    fontWeight: 400
    lineHeight: 1.35
    fontVariation: "'wdth' 90"
  numeral:
    fontFamily: "Archivo Variable, Archivo, system-ui, sans-serif"
    fontSize: "15.5px"
    fontWeight: 650
    fontFeature: "tnum"
    fontVariation: "'wdth' 88"
  label:
    fontFamily: "Archivo Variable, Archivo, system-ui, sans-serif"
    fontSize: "12.5px"
    fontWeight: 800
    letterSpacing: "0.1em"
  tab:
    fontFamily: "Archivo Variable, Archivo, system-ui, sans-serif"
    fontSize: "15px"
    fontWeight: 700
    lineHeight: 1.12
rounded:
  sello: "50%"
  pestana: "9px 9px 0 0"
  lomo: "7px 7px 2px 2px"
  pagina: "14px"
  boton: "8px"
  etiqueta: "5px"
  pildora: "20px"
  rotulador: "0.5em 0.2em 0.6em 0.3em"
spacing:
  reticula: "12px"
  xs: "4px"
  sm: "6px"
  md: "10px"
  lg: "16px"
  xl: "24px"
  columna-reloj: "156px"
  sangria-tramo: "94px"
components:
  pestana-dia:
    backgroundColor: "{colors.dia-cobalto}"
    textColor: "{colors.papel}"
    typography: "{typography.tab}"
    rounded: "{rounded.pestana}"
    padding: "0 12px 6px"
    height: "50px"
  pestana-todo:
    backgroundColor: "{colors.pestana-todo}"
    textColor: "{colors.tinta}"
    typography: "{typography.tab}"
    rounded: "{rounded.pestana}"
    height: "50px"
  boton-play:
    backgroundColor: "{colors.dia-cobalto}"
    textColor: "{colors.papel}"
    rounded: "{rounded.sello}"
    size: "48px"
  boton-control:
    textColor: "{colors.tinta}"
    rounded: "{rounded.sello}"
    size: "40px"
  boton-mapa:
    backgroundColor: "{colors.papel}"
    textColor: "{colors.tinta}"
    rounded: "{rounded.sello}"
    size: "44px"
  boton:
    backgroundColor: "{colors.papel}"
    textColor: "{colors.tinta}"
    rounded: "{rounded.boton}"
    padding: "0 14px"
    height: "42px"
  boton-tinta:
    backgroundColor: "{colors.tinta}"
    textColor: "{colors.papel}"
    rounded: "{rounded.boton}"
    padding: "0 14px"
    height: "42px"
  precio:
    backgroundColor: "{colors.etiqueta}"
    textColor: "{colors.etiqueta-texto}"
    rounded: "{rounded.etiqueta}"
    padding: "2px 7px"
  fila:
    textColor: "{colors.tinta}"
    typography: "{typography.body}"
    rounded: "{rounded.rotulador}"
    padding: "7px 6px"
    height: "50px"
  fila-actual:
    backgroundColor: "{colors.fluor-suave}"
    textColor: "{colors.tinta}"
    rounded: "{rounded.rotulador}"
  marca:
    backgroundColor: "{colors.papel}"
    textColor: "{colors.dia-cobalto}"
    rounded: "{rounded.sello}"
    size: "28px"
  marca-hecha:
    backgroundColor: "{colors.dia-cobalto}"
    textColor: "{colors.papel}"
    rounded: "{rounded.sello}"
    size: "28px"
  marca-actual:
    backgroundColor: "{colors.tinta}"
    textColor: "{colors.fluor}"
    rounded: "{rounded.sello}"
    size: "28px"
  marcador-mapa:
    backgroundColor: "{colors.papel}"
    textColor: "{colors.dia-cobalto}"
    rounded: "{rounded.sello}"
    size: "30px"
  marcador-mapa-actual:
    backgroundColor: "{colors.tinta}"
    textColor: "{colors.fluor}"
    rounded: "{rounded.sello}"
    size: "36px"
  pastilla-distancia:
    backgroundColor: "{colors.papel}"
    textColor: "{colors.tinta}"
    rounded: "{rounded.etiqueta}"
    padding: "2px 7px"
  titulo-ahora:
    backgroundColor: "{colors.fluor}"
    textColor: "{colors.tinta}"
    typography: "{typography.title}"
    rounded: "{rounded.rotulador}"
  tarjeta-taxista:
    backgroundColor: "{colors.papel}"
    textColor: "{colors.tinta}"
---

# Design System: Itinerario

## Overview

**Creative North Star: "El cuaderno de campo"**

El día es una página de cuaderno que se va marcando mientras se vive. Mapa y hora comparten una sola pantalla: arriba, la tapa de cartón kraft con una pestaña de separador por día; en medio, el mapa real; abajo, una página blanca de papel cuadriculado con margen rojo. Lo que pasa ahora se resalta con el mismo rotulador fluorescente a la vez en el mapa, en la lista y en la línea de tiempo. Cada día tiene su color de pestaña, que tiñe la ruta, los números y el botón de reproducir.

El sistema se diseña para la calle: de pie, con una mano, al sol. Por eso el texto va unas 1,4 veces más grande que en el boceto aprobado, la densidad es la de un cuaderno (filas de 50 px, no tarjetas) y una sola familia grotesca variable cubre todo, de la hora enorme y estrecha a las cifras tabulares de la lista. Los estados son marcas de tinta, no colores de interfaz: sello relleno (hecho), rotulador (ahora), anillo abierto (pendiente), anillo discontinuo (opcional).

Rechaza la app de mapas genérica (mapa gris, una sola ruta azul para todo, hoja blanca de tarjetas) y el cuaderno nostálgico de papel crema: la página es blanca y la tinta, azul casi negra. Nada propio de un destino vive en la interfaz; los colores de día y las pestañas salen de los datos para que el sistema sirva para cualquier viaje.

**Key Characteristics:**
- Tapa kraft solo en la barra de días; el resto es papel blanco con retícula azul pálida de 12 px.
- Un color saturado por día, repetido en pestaña, ruta, sellos, línea de tiempo y botón de reproducir.
- Fluorescente único para «ahora», presente en mapa, lista y reloj a la vez.
- Una sola familia, Archivo Variable, con anchura (wdth 62–125) como eje de jerarquía y cifras tabulares siempre.
- Tema noche manual que oscurece la tapa y la página, aclara la tinta y recolorea el mapa base sin conexión.

## Colors

Tinta casi negra sobre papel blanco, una paleta de pestañas saturadas por día y un único fluorescente amarillo verdoso que solo significa «ahora».

### Primary
- **Color del día** (de **Cobalto** a **Índigo**, diez tonos `dia-*`): se asigna por orden a cada día y entra como `--color-dia`. Pinta la pestaña del día, el arco de la ruta en el mapa, los anillos y sellos de las paradas, el hilo vertical que las une en la lista, la línea de tiempo y el botón de reproducir. Todos tienen contraste suficiente para texto blanco encima. De noche se aclaran (mezcla al 62 % con blanco en la interfaz, 38 % hacia blanco en el mapa) para leerse sobre la página oscura.

### Secondary
- **Fluorescente de rotulador** (`fluor`): solo para lo de ahora. El título de «ahora», el trazo ancho bajo el tramo actual del mapa (debajo de la línea de tinta), el segmento actual de la línea de tiempo, el anillo del marcador actual y el número de la parada actual sobre su sello de tinta. No cambia de noche.
- **Fluorescente pálido** (`fluor-suave`): la banda de la fila activa de la lista. De noche pasa a `fluor-suave-noche`, más intenso para que la banda se vea sobre papel oscuro; el texto encima sigue en tinta fija.

### Tertiary
- **Rojo de margen** (`margen`): la raya vertical de 1,5 px del margen del cuaderno, que separa reloj y «ahora/después» solo en la cabecera del panel, y los avisos de texto.
- **Cartón kraft** (`kraft`): la textura de la barra de días (placa `assets/plates/kraft.png`, en mosaico a 231 px de ancho) y el color de tema del navegador y del icono. De noche la textura se cubre con un velo marrón oscuro al 72 %.

### Neutral
- **Papel** (`papel`): fondo de la página, de los botones sobre el mapa y relleno de los anillos pendientes.
- **Retícula** (`reticula`): cuadrícula de 12 px pintada con dos degradados de 1 px sobre el panel.
- **Tinta** (`tinta`): texto, aguja del deslizador, botón de acción principal (taxista), toasts, y sello de la parada actual. Su versión fija (`--tinta-fija`, el mismo valor) se usa sobre fluorescente en ambos temas.
- **Tinta suave** (`tinta-suave`): horas de inicio y fin, nombres locales en chino, trayectos, metadatos y paradas ya hechas.
- **Etiqueta** (`etiqueta` / `etiqueta-texto`): fondo y texto de las pastillas de precio.
- **Pestaña Todo** (`pestana-todo`): pestaña de la vista de todo el viaje, color de cartulina para no competir con los colores de día.
- **Agua y parque del mapa** (`mapa-agua`, `mapa-parque`): retoques del mapa base para que parezca un plano dibujado en vez de gris.
- Bordes como tinta translúcida: `--borde` (tinta al 14 %) para divisores y `--borde-fuerte` (al 32 %) para contornos de botones, asa y separador de «ahora/después».

### Named Rules
**La Regla del Rotulador Único.** El fluorescente saturado marca una sola cosa: lo que pasa ahora. Solo lo llevan el título de «ahora», el tramo del mapa y el segmento de la línea de tiempo (y el anillo y número del marcador actual). La fila activa de la lista usa la banda pálida, nunca el saturado.

**La Regla del Color de Pestaña.** El color de un día viene de los datos y se repite en todo lo que pertenece a ese día. Nunca se escribe un color de día a mano en un componente: se lee de `--color-dia` (o `--tono` de noche).

**La Regla de la Tinta Fija.** Sobre fluorescente, el texto va siempre en tinta oscura fija, también de noche.

## Typography

**Display Font:** Archivo Variable (con Archivo, system-ui y las sans chinas del sistema: PingFang SC, Hiragino Sans GB, Noto Sans SC, Microsoft YaHei)
**Body Font:** la misma familia
**Label/Mono Font:** la misma familia; las cifras son tabulares en todo el documento

**Character:** Una grotesca de una sola familia que gana jerarquía con la anchura y el peso, no con otra fuente: estrecha y pesada para la hora, ancha y tranquila para leer. Se autoaloja con `@fontsource-variable/archivo` (ejes wdth 62–125 y wght 100–900); los textos en chino caen en la sans del sistema.

### Hierarchy
- **Display** (800, 50 px, 0,92, wdth 62 %): la hora del viaje en la cabecera del panel. Solo hay una por pantalla.
- **Headline** (800, 30 px, 1,02, wdth 75 %): el título del viaje en la vista «Todo».
- **Title** (700, 17 px, 1,24, wdth 92 %): el título de «ahora», hasta tres líneas; «después» va a 16 px. El resumen del día usa 18 px.
- **Body** (500, 15,5 px, 1,3): nombre de cada parada en la lista. Las notas largas usan 15 px a 1,45.
- **Meta** (400–600, 13,5–14,5 px, wdth 88–90 %): trayectos, detalles de «ahora», cifras del día, nombre local.
- **Numeral** (650, 15,5 px, wdth 88 %, tabular): la hora de cada fila; las marcas de parada usan 800 a 13,5 px.
- **Label** (800, 12,5–13 px, 0,08–0,1 em, mayúsculas): solo como encabezado de una lista o sección («Itinerario del día» con su recuento) y como término de la ficha de parada (750, 12 px, 0,06 em).

### Named Rules
**La Regla de la Calle.** El texto va aproximadamente 1,4 veces más grande que las alturas de mayúscula medidas en el boceto. Ningún texto de lectura baja de 12 px y el cuerpo de la lista no baja de 15,5 px. El criterio de fallo del usuario es «Difícil de leer».

**La Regla de la Anchura.** La jerarquía se construye con el eje de anchura: cuanto más importante y numérico, más estrecho (62 % la hora, 75 % el título del viaje, 88–92 % títulos y horas); el cuerpo va a anchura normal.

**La Regla Sin Red.** Las fuentes van dentro de la app. Nunca Google Fonts ni CDN: están bloqueados en China y la app debe funcionar sin conexión.

## Layout

Móvil primero, a pantalla completa y sin desplazamiento de página: el mapa ocupa todo el fondo, la barra de días va fija arriba (54 px de pestañas más el área segura) y el panel de papel ocupa la mitad inferior (50 dvh, 80 dvh expandido con el asa). Los botones redondos del mapa se apilan a la derecha, 12 px del borde, con 10 px entre ellos.

La cabecera del panel es una rejilla de dos columnas: a la izquierda una columna fija de 156 px con la hora, los controles y la línea de tiempo; a la derecha, tras el margen rojo, «ahora» y «después» separados por una raya. El margen rojo recorre solo la cabecera. Debajo, la lista del día va a todo el ancho del panel, con 16 px de margen lateral y la retícula de 12 px como pauta visual.

Las filas de la lista son una rejilla de cuatro columnas (marca 28 px, hora 46 px, texto flexible, precio) con 10 px de separación y 50 px de alto mínimo. Los trayectos se sangran 94 px para alinearse con el texto y van pegados a la parada a la que llevan. La ficha desplegada se sangra 38 px.

En pantallas de 760 px o más, el panel se convierte en una página flotante de 440 px a la izquierda, 16 px del borde, desde debajo de la barra hasta 16 px del fondo, con esquinas de 14 px en los cuatro lados; el asa desaparece.

### Named Rules
**La Regla de la Línea de Tiempo por Paradas.** Las paradas se reparten a distancias iguales en la línea de tiempo y el tiempo es lineal dentro de cada intervalo, para que un día con mañanas largas no apriete las paradas de la tarde. La velocidad de reproducción (×1–×8) se sitúa entre las horas de inicio y fin.

## Elevation & Depth

Híbrido y discreto: la página es plana y la profundidad la dan objetos físicos del cuaderno. Los botones sobre el mapa y la página flotante de escritorio comparten una sombra ambiental doble; la pestaña activa sube 6 px y proyecta una sombra cálida hacia arriba; las inactivas quedan hundidas con un filo inferior. Los marcadores del mapa llevan un halo de papel de 2 px más una sombra corta para despegarse de las calles. De noche las sombras pasan a negro más denso.

### Shadow Vocabulary
- **Botón sobre mapa** (`--sombra-boton`: `0 1px 2px rgba(20, 33, 61, 0.2), 0 4px 12px rgba(20, 33, 61, 0.14)`): botones redondos, «Seguir recorrido» y el panel en escritorio.
- **Panel móvil** (`0 -2px 14px rgba(20, 33, 61, 0.18)`): la página que sube desde abajo.
- **Pestaña activa** (`0 -2px 6px rgba(20, 16, 10, 0.28)`): sombra cálida de cartón sobre la tapa.
- **Halo del marcador** (`0 0 0 2px papel, 0 2px 5px rgba(20, 33, 61, 0.3)`): paradas en el mapa; la actual cambia el halo por un anillo fluorescente de 5 px.
- **Brillo del play** (`0 2px 6px` del color del día al 40 %): solo el botón de reproducir.

### Named Rules
**La Regla del Papel Plano.** Nada dentro de la página proyecta sombra salvo el sello de tinta; la jerarquía dentro del panel se hace con tinta, rotulador y retícula, no con tarjetas elevadas.

## Shapes

Dos geometrías conviven. Lo físico del cuaderno es redondo o con esquinas de cartón: sellos y botones son círculos perfectos, las pestañas tienen 9 px arriba y canto recto abajo, el lomo de cada día en la vista «Todo» 7 px arriba y 2 px abajo, la página 14 px. Lo dibujado a mano es irregular: el rotulador fluorescente usa radios distintos en cada esquina (0,5 / 0,2 / 0,6 / 0,3 em en la fila; 0,3 / 0,12 / 0,36 / 0,2 em en el título) y el sello de una parada hecha cae girado −8°. Los botones de texto llevan 8 px y las pastillas de precio y distancia 5 px. Los contornos son de 1,5 a 2,5 px; el discontinuo significa opcional y el doble significa grupo de paradas.

## Components

### Buttons
Redondos, táctiles y sin texto superfluo.
- **Shape:** círculo completo (50 %) para controles e iconos; 8 px para botones de texto.
- **Play:** 48 px, relleno del color del día, icono blanco y su brillo. Es la acción principal del panel.
- **Controles anterior/siguiente:** 40 px, sin fondo, icono en tinta.
- **Botones del mapa:** 44 px, papel con sombra de botón, icono de trazo de 2 px a 23 px; un punto verde de 11 px indica mapas guardados y el icono late mientras descarga.
- **Botón de texto:** 42 px de alto, contorno de 1,5 px en `--borde-fuerte`, papel y tinta, 650. La variante **tinta** (relleno de tinta, texto papel) es la acción principal de la ficha: «Enseñar al taxista».
- **Focus:** contorno de 2,5 px en el color del día con 2 px de separación, en todos los elementos.

### Chips
- **Precio:** pastilla de 5 px, fondo `etiqueta`, texto `etiqueta-texto`, 13 px a 600 y wdth 90 %. En la fila activa pasa a blanco translúcido con tinta fija.
- **Opcional:** contorno discontinuo de 1,5 px, 12 px a 600, sin relleno.
- **Velocidad:** píldora de 26 px de alto con contorno de 1,5 px, 12,5 px a 700.
- **Distancia en el mapa:** pastilla de papel de 5 px, 12,5 px a 700; la del tramo actual lleva además un contorno de tinta de 1,5 px.

### Navigation
- **Pestañas de día:** separadores de cartón sobre la tapa kraft, mínimo 78 px de ancho y 50 px de alto, relleno del color del día con texto blanco («Día N» a 15 px/700 y fecha corta a 12,5 px/500 con wdth 92 %). Inactivas, bajan 6 px; la activa sube a su sitio con 0,25 s de transición y sombra cálida. La pestaña «Todo» va primero en color cartulina con texto en tinta. La barra se desplaza en horizontal sin barra de scroll.

### Fila del itinerario (signature)
Número en anillo, hora tabular, nombre y precio. La fila activa se resalta con una banda de rotulador pálido que se traza de izquierda a derecha en 0,45 s. Un hilo de 2 px en el color del día une las marcas. Los trayectos van entre filas en tinta suave y se vuelven tinta fija y rotulador saturado cuando son el tramo de ahora. Al tocar, la fila despliega su ficha: notas, datos en lista de definiciones, gasto por persona, enlaces subrayados con 2 px del color del día y botones Amap, Apple Maps, Google Maps y taxista.

### Marcas de estado (signature)
- **Pendiente:** anillo de 2 px en el color del día sobre papel.
- **Opcional:** el mismo anillo, discontinuo.
- **Hecha / hotel / salida:** sello relleno del color del día con un filo interior de papel; la hecha gira −8° y, al reproducir, cae con 0,36 s de escala y giro.
- **Ahora:** sello de tinta fija con el número en fluorescente.
Los marcadores del mapa repiten la misma gramática a 30 px (36 px el actual, con anillo fluorescente de 5 px); los grupos de paradas cercanas usan una píldora con contorno doble y se apartan a un lado si caen bajo la parada actual.

### Ahora y después (signature)
Sin etiquetas encima. «Ahora» se reconoce por el título trazado con rotulador saturado (que se dibuja en 0,5 s), seguido del nombre local y «hasta HH:MM» en negrita. «Después» usa la gramática de fila: «18:30 Nombre» con la hora en negrita estrecha, y debajo el medio, la distancia y el precio.

### Línea de tiempo
Línea de 3 px en el color del día, un punto de 8 px por parada (vacío pendiente, relleno pasado), el segmento de ahora como un trazo fluorescente de 17 px de alto con extremos irregulares, y una aguja de tinta fina de 6 × 26 px con filo de papel para no tapar el fluorescente.

### Mapa
Mapa base real (OpenFreeMap) con agua azul y parques verdes retocados. Rutas en arcos del color del día: pendiente a 2,5 px y 75 % de opacidad, recorrida a 3,5 px, y el tramo de ahora en tinta de 3 px sobre un trazo fluorescente de 12–20 px según el zoom. De noche, cada color del estilo base se recolorea en sitio (suelo y calles en azul noche, rótulos claros con halo oscuro), sin descargar otro estilo, para que siga funcionando sin conexión. Los marcadores y pastillas reservan su hueco con símbolos invisibles para que los rótulos del mapa se aparten.

### Tarjeta para el taxista
Pantalla completa en blanco y tinta fijos en ambos temas, con la petición en chino, el nombre en chino a min(17vw, 112 px) y la dirección a min(7vw, 34 px). Es para enseñarla a otra persona, no para leerla uno mismo.

## Do's and Don'ts

### Do:
- **Do** tomar el color de cualquier elemento de un día de `--color-dia` / `--tono`, nunca de un valor escrito a mano.
- **Do** reservar `fluor` para lo de ahora y usar `fluor-suave` en la banda de la fila activa.
- **Do** poner tinta fija (#14213d) sobre cualquier fluorescente, también de noche.
- **Do** expresar el estado con marcas de tinta: anillo, anillo discontinuo, sello relleno, sello de tinta con número fluorescente.
- **Do** mantener el cuerpo de la lista a 15,5 px o más y las cifras tabulares en toda la interfaz.
- **Do** autoalojar fuentes, texturas e iconos dentro de la app.
- **Do** respetar `prefers-reduced-motion`: sin trazos, sellos ni pulsos.

### Don't:
- **Don't** usar la textura kraft fuera de la barra de días ni teñir la página de crema: la página es blanca con retícula azul pálida.
- **Don't** pintar todas las rutas de un mismo azul de interfaz; cada día lleva su propio color de pestaña.
- **Don't** poner etiquetas o antetítulos encima de «ahora» o «después», ni encima de otros títulos.
- **Don't** convertir las filas del itinerario en tarjetas elevadas.
- **Don't** cargar Google Fonts ni recursos de CDN.
- **Don't** escribir en la interfaz nada propio de un destino; eso vive en los datos.
