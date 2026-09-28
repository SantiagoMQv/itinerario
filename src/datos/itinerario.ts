import type { Itinerario, Parada } from '../tipos';

// Itinerario del viaje. Todas las horas son hora de China.
// Si un plan acaba pasada la medianoche se escribe como "25:30" (01:30 del día siguiente).

/**
 * Coordenadas WGS-84 [lat, lng] de cada sitio (OpenStreetMap). Aproximadas, a falta de
 * confirmar el número exacto: masaje, Songmont (huaihai), Hush, Dongxin, CUBIC3 e Hinichijou.
 */
const C = {
  pvg: [31.151124, 121.798652],
  hotel: [31.2500138, 121.4467433],
  masaje: [31.2455627, 121.4650565],
  suzhouCreek: [31.2420692, 121.4659984],
  joyCity: [31.2457033, 121.4675727],
  noria: [31.2461038, 121.4675959],
  disney: [31.1462523, 121.6562825],
  estacionShanghai: [31.2504165, 121.4505223],
  estacionNankin: [32.0890655, 118.7913961],
  comidaJiming: [32.0597786, 118.7914078],
  museo: [32.0616702, 118.7901099],
  jiming: [32.0629615, 118.7899275],
  txHuaihai: [31.2225113, 121.4642123],
  lyceum: [31.2235781, 121.4554307],
  huaihai: [31.2188995, 121.4552697],
  yuyuan: [31.2273348, 121.4912311],
  nanxiang: [31.2285341, 121.4871017],
  bund: [31.24, 121.4903],
  speakLow: [31.2170628, 121.4605836],
  hush: [31.2205, 121.465],
  wukang: [31.2062561, 121.4337292],
  dongxin: [31.2079627, 121.4345823],
  demarzo: [31.2151229, 121.4355285],
  cubic3: [31.2129028, 121.4538854],
  hinichijou: [31.2129028, 121.4538854],
  lujiazui: [31.23962, 121.4960369],
  perla: [31.2419464, 121.4952604],
} satisfies Record<string, [number, number]>;

const en = ([lat, lng]: [number, number]) => ({ lat, lng });

const HOTEL = {
  nombre: 'Hotel Aqua Suhe NO.1',
  local: '上海静安苏河1號酒店',
  categoria: 'hotel',
  ...en(C.hotel),
  direccion: '688 Hengfeng Road, Jing’an',
  direccionLocal: '上海市静安区恒丰路688号',
} satisfies Omit<Parada, 'hora'>;

const PVG = {
  nombre: 'Aeropuerto de Pudong (PVG), T1',
  local: '浦东国际机场1号航站楼',
  categoria: 'transporte',
  ...en(C.pvg),
} satisfies Omit<Parada, 'hora'>;

const enlace = (texto: string, url: string) => ({ texto, url });

export const itinerario: Itinerario = {
  titulo: 'Shanghái y Nankín',
  subtitulo: '21–26 de octubre de 2026 · 2 personas',
  dias: [
    {
      fecha: '2026-10-21',
      titulo: 'Llegada, descanso y primeras compras',
      ciudad: 'Shanghái',
      notas:
        'El tiempo de llegada al hotel dependerá de inmigración y del tráfico.\n' +
        'No construir el día suponiendo que habrá habitación antes de las 14:00.',
      paradas: [
        {
          ...PVG,
          hora: '07:00',
          fin: '08:45',
          notas:
            'Llegada desde París. Air France y KLM operan en la Terminal 1 (confirmarlo en la tarjeta de embarque).\n' +
            'Inmigración, equipaje y traslado al hotel.',
        },
        {
          ...HOTEL,
          hora: '10:00',
          llegada: { modo: 'taxi', detalle: 'Taxi o DiDi desde PVG (según tráfico)', min: 75 },
          notas:
            'Entrada indicada después de las 14:00. Preguntar antes del viaje por Trip.com si pueden dar la habitación por la mañana y si tendría coste; volver a preguntarlo al llegar. Si no se puede, dejar el equipaje en consigna.\n' +
            'Si nos dan la habitación: descansar hasta ~13:30, comer sin prisas y salir hacia las 16:00.\n' +
            'Si no: brunch ligero y masaje (si encaja) o comida tranquila y paseo corto por Suzhou Creek; vuelta al hotel a las 14:00.',
          reserva: '5 noches, del 21 al 26. Salida antes de las 12:00.',
          enlaces: [enlace('Ficha del hotel', 'https://sg.trip.com/hotels/jing-an-district-hotel-detail-2895314/aqua-suhe-no-1-hotel-shanghai-jingan/')],
        },
        {
          hora: '11:45',
          fin: '13:00',
          nombre: 'Masaje en Kangyou Four Seasons',
          local: '康友四季(静安大悦城店)',
          categoria: 'ocio',
          ...en(C.masaje),
          opcional: true,
          llegada: { modo: 'taxi', detalle: 'Taxi o metro línea 12 (Hanzhong Rd → Qufu Rd)', min: 15 },
          direccion: '222 Jinyuan Road (zona Jing’an Joy City), a 260 m de la salida 4 del metro Qufu Road',
          direccionLocal: '上海市静安区晋元路222号',
          notas:
            'Solo si no nos dan la habitación y hay hueco para dos a un precio final adecuado (objetivo: máximo 230 ¥ por persona).\n' +
            'Klook anuncia masaje de pies de 70 min, masaje con aceite de 60 min y un combinado, desde 196 ¥ por persona: comprobar cuál entra realmente en el presupuesto antes de pagar. Horario: 11:00–01:00.\n' +
            'Si ninguno entra, no forzarlo: comida tranquila y paseo por Suzhou Creek.',
          enlaces: [
            enlace('Tratamientos y horario (Klook)', 'https://www.klook.cn/zh-CN/activity/223147-hikyou-four-seasons-massage-jing-an-joy-city-store/'),
          ],
        },
        {
          hora: '13:15',
          fin: '13:45',
          nombre: 'Paseo por Suzhou Creek',
          local: '苏州河 · 晋元纪念广场',
          categoria: 'naturaleza',
          ...en(C.suzhouCreek),
          opcional: true,
          llegada: { modo: 'a_pie' },
          notas:
            'Alternativa tranquila si no hay masaje: comer sin prisa y pasear un rato junto al río, junto al almacén Sihang.\n' +
            'Hay otro buen tramo de paseo justo detrás del hotel (zona M50).',
        },
        {
          ...HOTEL,
          hora: '14:00',
          fin: '16:10',
          llegada: { modo: 'taxi', min: 10 },
          notas: 'Entrada al hotel y descanso.',
        },
        {
          hora: '16:30',
          fin: '19:00',
          nombre: 'Jing’an Joy City: ropa y maleta',
          local: '静安大悦城',
          categoria: 'compras',
          ...en(C.joyCity),
          llegada: { modo: 'metro', detalle: 'Metro línea 12 (Hanzhong Rd → Qufu Rd) o taxi', min: 15 },
          direccionLocal: '上海市静安区西藏北路166号',
          notas:
            'Comprar la ropa imprescindible para el día siguiente y buscar una maleta resistente: comparar tamaño, peso, ruedas y precio. No dar por hecho que habrá existencias de maletas Xiaomi.\n' +
            'Antes de elegir el tamaño, revisar la franquicia de equipaje de los cuatro vuelos, sobre todo el Barcelona–Málaga de Vueling (según la tarifa, podría hacer falta añadir la maleta).\n' +
            'Horario general: 10:00–22:00.',
          enlaces: [
            enlace('Joy City', 'https://english.shanghai.gov.cn/en-ShoppingCenters/20231217/dbb23c40ef1b4ff68794226b8ca37d1a.html'),
            enlace('Equipaje en Vueling', 'https://help.vueling.com/hc/es/articles/19798835176081-Equipaje-de-mano-Maletas-de-mano'),
          ],
        },
        {
          hora: '19:00',
          fin: '19:45',
          nombre: 'Noria Sky Ring',
          local: 'SKY RING摩天轮',
          categoria: 'mirador',
          ...en(C.noria),
          opcional: true,
          llegada: { modo: 'a_pie' },
          notas:
            'En el edificio norte, con acceso por la planta 8. Solo si funciona ese día: confirmarlo por separado (el horario publicado, 10:00/11:00–21:30, es antiguo).',
        },
        {
          hora: '19:45',
          fin: '21:00',
          nombre: 'Cena en Top Banana Market',
          categoria: 'comida',
          ...en(C.joyCity),
          llegada: { modo: 'a_pie' },
          notas: 'Cena informal en la planta baja del edificio norte de Joy City: puestos asiáticos, bebidas y postres.',
          enlaces: [enlace('Top Banana Market', 'https://english.shanghai.gov.cn/en-FirstStores/20260211/4976961a80794cf495e4eb67df6371ee.html')],
        },
        {
          ...HOTEL,
          hora: '21:15',
          llegada: { modo: 'taxi', min: 10 },
        },
      ],
    },
    {
      fecha: '2026-10-22',
      titulo: 'Shanghai Disneyland',
      ciudad: 'Shanghái',
      notas:
        'Levantarnos a las 08:00 y dedicarle el día completo. No añadir otro plan obligatorio después.\n' +
        'Comida y cena: huecos flexibles dentro del parque o a la salida, según hambre, colas y hora de cierre.',
      paradas: [
        {
          hora: '09:45',
          fin: '20:30',
          nombre: 'Shanghai Disneyland',
          local: '上海迪士尼乐园',
          categoria: 'ocio',
          ...en(C.disney),
          llegada: { modo: 'metro', detalle: 'Metro hasta Disney Resort (línea 11) o taxi/DiDi', min: 60 },
          notas:
            'Comprar la entrada y consultar el horario de apertura y cierre publicado para el 22. La hora de salida de aquí es orientativa.\n' +
            'El punto del mapa es el centro del parque, no la puerta de entrada.',
        },
        {
          ...HOTEL,
          hora: '21:40',
          llegada: { modo: 'metro', detalle: 'Metro (línea 11 y transbordo) o taxi/DiDi', min: 70 },
        },
      ],
    },
    {
      fecha: '2026-10-23',
      titulo: 'Nankín: Museo Paleontológico',
      ciudad: 'Nankín',
      notas:
        'La excursión es para el Museo Paleontológico, no para encadenar monumentos. Levantarnos a las 10:00.\n' +
        'Billetes: comprobar ya la app oficial 12306. La venta suele abrir 15 días antes, pero en 2026 hay solicitud anticipada para algunos trenes del corredor Pekín–Shanghái. Solicitar plaza no es tenerla confirmada.\n' +
        'Fuera del plan: Niushoushan, Mausoleo Ming Xiaoling, Palacio Presidencial y los demás museos.',
      paradas: [
        {
          hora: '10:45',
          fin: '11:10',
          nombre: 'Estación de Shanghái',
          local: '上海站',
          categoria: 'transporte',
          ...en(C.estacionShanghai),
          llegada: { modo: 'a_pie', detalle: 'Unos 600 m por Hengfeng Rd y Moling Rd hasta la plaza sur', min: 10 },
          notas:
            'Tren hacia la estación de Nankín sobre las 11:00–11:30, si hay un horario que deje tiempo suficiente. Tren y duración exactos pendientes de reserva. Llevar el pasaporte.',
          enlaces: [
            enlace('Información ferroviaria', 'https://english.beijing.gov.cn/travellinginbeijing/transportation/railway/202607/t20260720_4772390.html'),
          ],
        },
        {
          hora: '12:50',
          nombre: 'Estación de Nankín',
          local: '南京站',
          categoria: 'transporte',
          ...en(C.estacionNankin),
          llegada: { modo: 'tren', detalle: 'Tren G/D (horario pendiente de reserva)', min: 100 },
        },
        {
          hora: '13:15',
          fin: '13:50',
          nombre: 'Comida junto a Jiming Temple',
          categoria: 'comida',
          ...en(C.comidaJiming),
          llegada: { modo: 'metro', detalle: 'Línea 3 hasta Jiming Temple (鸡鸣寺)', min: 15 },
          notas:
            'Comida sencilla por la zona, por ejemplo fideos locales con pato. El museo está a unos 200 m de la salida 5 del metro.\n' +
            'En días de mucha gente la salida 5 es solo de entrada; para salir se usa la 6 (o la 1 y la 4).',
        },
        {
          hora: '14:00',
          fin: '16:30',
          nombre: 'Museo Paleontológico de Nankín',
          local: '南京古生物博物馆',
          categoria: 'museo',
          ...en(C.museo),
          llegada: { modo: 'a_pie' },
          direccion: '39 Beijing East Road',
          direccionLocal: '北京东路39号',
          notas:
            'Gratuito. Abre de miércoles a domingo de 09:00 a 17:00, último acceso a las 16:00 (lunes y martes cerrado).\n' +
            'Cada adulto necesita reserva nominal y su propio código en el WeChat oficial del museo.',
          enlaces: [enlace('Guía oficial del museo', 'https://www.nmp.ac.cn/bwggk/cgzn/')],
        },
        {
          hora: '16:40',
          fin: '17:10',
          nombre: 'Paseo junto a Jiming Temple',
          local: '鸡鸣寺',
          categoria: 'cultura',
          ...en(C.jiming),
          opcional: true,
          llegada: { modo: 'a_pie' },
          notas: 'Breve, solo si apetece. El templo abre de 07:00 a 17:30.',
        },
        {
          hora: '17:35',
          fin: '18:00',
          nombre: 'Estación de Nankín',
          local: '南京站',
          categoria: 'transporte',
          ...en(C.estacionNankin),
          llegada: { modo: 'metro', detalle: 'Línea 3', min: 20 },
          notas: 'Tren de regreso a Shanghái (horario pendiente de reserva).',
        },
        {
          hora: '19:40',
          nombre: 'Estación de Shanghái',
          local: '上海站',
          categoria: 'transporte',
          ...en(C.estacionShanghai),
          llegada: { modo: 'tren', detalle: 'Tren G/D de vuelta', min: 100 },
        },
        {
          ...HOTEL,
          hora: '20:00',
          llegada: { modo: 'a_pie', min: 10 },
          notas: 'Cena sencilla cerca del hotel.',
        },
      ],
    },
    {
      fecha: '2026-10-24',
      titulo: 'Moda china, casco antiguo y noche de salida',
      ciudad: 'Shanghái',
      notas: 'Levantarnos a las 10:00.',
      paradas: [
        {
          hora: '10:30',
          fin: '12:45',
          nombre: 'Middle Huaihai Road: TX Huaihai',
          local: 'TX淮海｜年轻力中心',
          categoria: 'compras',
          ...en(C.txHuaihai),
          llegada: { modo: 'metro', detalle: 'Línea 1 hasta South Huangpi Road', min: 20 },
          direccionLocal: '淮海中路523号',
          notas:
            'Prioridad a marcas locales: Pane en TX Huaihai (planta baja, L1-05/06; en festivos ha tenido colas de más de 40 min), Mason Prince enfrente (淮海中路528号) y otras tiendas que nos gusten al recorrer la calle.\n' +
            'TX Huaihai abre de 11:00 a 22:00.',
          enlaces: [
            enlace('Guía de tiendas de Huaihai', 'https://english.shanghai.gov.cn/en-TrendyStores/20260525/8fc944e699224a4e9e9a609ad33fa0c0.html'),
          ],
        },
        {
          hora: '13:00',
          fin: '14:00',
          nombre: 'Lanxin (Lyceum Restaurant)',
          local: '兰心餐厅',
          categoria: 'comida',
          ...en(C.lyceum),
          llegada: { modo: 'a_pie' },
          direccion: '130 Jinxian Road',
          direccionLocal: '进贤路130号',
          notas:
            'Cocina shanghainesa. No admite reservas. Horario: 11:00–13:30 y 17:00–21:00: al mediodía cierra a las 13:30, así que conviene no llegar más tarde de las 13:00.\n' +
            'Alternativa si preferimos pato pekinés: Quanjude (no imprescindible).',
        },
        {
          hora: '14:10',
          fin: '15:00',
          nombre: 'Más tiendas por Huaihai',
          local: '淮海中路',
          categoria: 'compras',
          ...en(C.huaihai),
          llegada: { modo: 'a_pie' },
          notas:
            'Songmont para mirar bolsos, no como compra obligatoria porque sube de presupuesto (su tienda en esta calle está sin confirmar).',
        },
        {
          ...HOTEL,
          hora: '15:30',
          fin: '16:15',
          llegada: { modo: 'metro', detalle: 'Línea 1 o taxi', min: 25 },
          notas: 'Dejar las compras y descansar.',
        },
        {
          hora: '16:45',
          fin: '18:30',
          nombre: 'Yuyuan y Shanghai Old Street',
          local: '上海老街',
          categoria: 'barrio',
          ...en(C.yuyuan),
          llegada: { modo: 'taxi', min: 25 },
          notas:
            'Arquitectura, ambiente y tiendas, con la tienda insignia de Semir (marca china de ropa diaria con artículos exclusivos de Shanghái).\n' +
            'El jardín interior de Yuyuan no está incluido: cierra pronto y chocaría con las compras.',
          enlaces: [
            enlace('Semir en Yuyuan', 'https://english.shanghai.gov.cn/en-Latest-WhatsNew/20260917/1213b27578094564b1ad9630d36c24f2.html'),
          ],
        },
        {
          hora: '18:30',
          fin: '19:30',
          nombre: 'Xiaolongbao en Nanxiang',
          local: '南翔馒头店',
          categoria: 'comida',
          ...en(C.nanxiang),
          llegada: { modo: 'a_pie' },
          notas: 'Cena, en el bazar de Yuyuan. Ajustar según la cola y el horario efectivo.',
        },
        {
          hora: '20:00',
          fin: '21:30',
          nombre: 'The Bund',
          local: '外滩',
          categoria: 'mirador',
          ...en(C.bund),
          llegada: { modo: 'a_pie' },
          notas: 'Paseo y vistas nocturnas de Lujiazui.',
        },
        {
          hora: '22:00',
          fin: '23:30',
          nombre: 'Speak Low',
          local: 'Speak Low',
          categoria: 'ocio',
          ...en(C.speakLow),
          llegada: { modo: 'taxi', min: 20 },
          direccion: '579 Middle Fuxing Road',
          direccionLocal: '复兴中路579号',
          notas: 'Cócteles.',
          enlaces: [enlace('Speak Low', 'https://rachelgouk.com/listings/speak-low/')],
        },
        {
          hora: '23:45',
          fin: '26:00',
          nombre: 'Hush (INS Land)',
          local: 'INS新乐园',
          categoria: 'ocio',
          ...en(C.hush),
          opcional: true,
          llegada: { modo: 'a_pie' },
          direccion: '109 Yandang Road',
          direccionLocal: '雁荡路109号',
          notas:
            'Si apetece hip-hop/R&B. Comprobar la sesión y el precio de la entrada de esa noche antes de comprar pases.\n' +
            'Si llegamos cansados, el bar ya cumple el plan nocturno y la discoteca se puede omitir. Hora de salida orientativa.\n' +
            'INS Land está en el lado norte del parque Fuxing; el punto del mapa es aproximado.',
          enlaces: [enlace('Hush', 'https://www.smartshanghai.com/venue/28730/smshwxmpqr.jpeg?share=true28730')],
        },
        {
          ...HOTEL,
          hora: '26:30',
          llegada: { modo: 'taxi', min: 20 },
        },
      ],
    },
    {
      fecha: '2026-10-25',
      titulo: 'Anfu/Wukang, cafés curiosos y vistas',
      ciudad: 'Shanghái',
      notas: 'Después de la salida del sábado, levantarnos sobre las 11:00.',
      paradas: [
        {
          hora: '12:00',
          fin: '12:30',
          nombre: 'Wukang Road',
          local: '武康大楼 · 武康路',
          categoria: 'barrio',
          ...en(C.wukang),
          llegada: { modo: 'taxi', min: 20 },
          notas: 'Paseo y compras relajadas por Wukang Road y Anfu Road: boutiques y diseño local, sin obligación de comprar.',
        },
        {
          hora: '12:30',
          fin: '13:30',
          nombre: 'Dongxin Jiujia',
          categoria: 'comida',
          ...en(C.dongxin),
          llegada: { modo: 'a_pie' },
          direccion: '98 Wukang Road',
          direccionLocal: '武康路98号',
          notas:
            'Almuerzo recomendado, cocina shanghainesa.\n' +
            'Si preferimos un brunch occidental: SOMETHING Dining & Bar, en la segunda planta del mismo número.\n' +
            'Posición en el mapa aproximada.',
          enlaces: [
            enlace('Restaurantes de Wukang', 'https://english.shanghai.gov.cn/en-Restaurants/20250411/1dfa64b624304bff969afd23b9d2bb24.html'),
            enlace('SOMETHING', 'https://english.shanghai.gov.cn/en-Restaurants/20240416/b3de189a44064a76afd2e677f7e60b37.html'),
          ],
        },
        {
          hora: '13:40',
          fin: '14:40',
          nombre: '13DEMARZO Café',
          categoria: 'comida',
          ...en(C.demarzo),
          llegada: { modo: 'a_pie' },
          direccion: '322 Anfu Road',
          direccionLocal: '安福路322号',
          notas:
            'La bebida con el osito. Puede haber cola, sobre todo en domingo: pedir primero y seguir mirando tiendas por Anfu mientras esperamos, si el sistema de recogida lo permite.',
          enlaces: [
            enlace(
              'Ubicación y horarios',
              'https://maps.apple.com/place?address=Anfu+Road+No.322+Building+4+Building+1%2C+Xuhui%2C+Shanghai+China&auid=1118692146049105&coordinate=31.213256%2C121.440149&lsp=57879&name=13+DE+MARZO+Caf+%28Shanghai+Anfu+Road+Branch%29',
            ),
          ],
        },
        {
          hora: '15:00',
          fin: '15:45',
          nombre: 'CUBIC3: -86°C Dirty',
          categoria: 'comida',
          ...en(C.cubic3),
          llegada: { modo: 'taxi', min: 12 },
          direccion: '58 Yongkang Road',
          direccionLocal: '永康路58号',
          notas:
            'El «−86 °C» se refiere a la experiencia del vaso, no a beber líquido a esa temperatura.\n' +
            'Tramo flexible si la espera en 13DEMARZO se alarga. Posición en el mapa aproximada (Yongkang Road).',
          enlaces: [enlace('CUBIC3 en Amap', 'https://www.amap.com/place/B0LUF51YXH')],
        },
        {
          hora: '15:45',
          fin: '16:30',
          nombre: 'Hinichijou (Bear Paw Café)',
          categoria: 'comida',
          ...en(C.hinichijou),
          llegada: { modo: 'a_pie' },
          notas:
            'El café servido por una «garra» a través de un hueco en la pared. Muy cerca de CUBIC3; posición en el mapa aproximada.',
          enlaces: [enlace('Hinichijou', 'https://english.shanghai.gov.cn/en-Cafes/20240823/f098caef928a48a495162811624512a4.html')],
        },
        {
          hora: '17:30',
          fin: '18:30',
          nombre: 'Lujiazui: rascacielos',
          local: '陆家嘴环形天桥',
          categoria: 'mirador',
          ...en(C.lujiazui),
          llegada: { modo: 'metro', detalle: 'Metro hasta Lujiazui (línea 2)', min: 35 },
          notas: 'Pasarela circular y zona de rascacielos.',
        },
        {
          hora: '18:30',
          fin: '20:10',
          nombre: 'Torre Perla Oriental',
          local: '东方明珠',
          categoria: 'mirador',
          ...en(C.perla),
          llegada: { modo: 'a_pie' },
          notas:
            'Cena pendiente de decidir: restaurante giratorio si valoramos la experiencia y aceptamos su precio, o mirador y cena aparte por la zona.\n' +
            'No considerar la cena giratoria reservada.',
        },
        {
          ...HOTEL,
          hora: '20:45',
          llegada: { modo: 'metro', detalle: 'Línea 2 y transbordo', min: 35 },
          notas: 'Ordenar compras y pesar la maleta.',
        },
      ],
    },
    {
      fecha: '2026-10-26',
      titulo: 'Regreso',
      ciudad: 'Shanghái',
      notas: 'Salir del hotel a las 07:45–08:00. No dejar compras ni visitas para esta mañana.',
      paradas: [
        {
          ...HOTEL,
          hora: '07:15',
          fin: '07:50',
          notas: 'Check-out.',
        },
        {
          ...PVG,
          hora: '09:05',
          fin: '12:40',
          llegada: { modo: 'taxi', detalle: 'Taxi o DiDi (según tráfico)', min: 75 },
          notas: 'Vuelo a las 12:40 hacia Ámsterdam; llegada a Barcelona a las 23:05. Martes 27: Barcelona 06:50 → Málaga 08:35.',
        },
      ],
    },
  ],
  secciones: [
    {
      titulo: 'Lo que queremos priorizar',
      puntos: [
        'Disfrutar Shanghái sin madrugar: levantarnos a las 10:00 como muy pronto. Excepciones: Disneyland (08:00) y el vuelo de vuelta.',
        'Comprar una maleta y ropa allí; descubrir marcas chinas originales con buena relación calidad-precio.',
        'Probar comidas y bebidas curiosas.',
        'Disneyland, el Museo Paleontológico de Nankín y una noche de buenos cócteles y baile.',
        'No meter todos los sitios de la lista por obligación.',
      ],
    },
    {
      titulo: 'Vuelos',
      puntos: [
        'Ida: lunes 19, Málaga 23:05 → Barcelona 00:40 (martes 20).',
        'Martes 20: Barcelona 06:10 → París → Shanghái-Pudong, llegada el miércoles 21 a las 07:00.',
        'Vuelta: lunes 26, Pudong 12:40 → Ámsterdam → Barcelona 23:05.',
        'Martes 27: Barcelona 06:50 → Málaga 08:35.',
      ],
    },
    {
      titulo: 'Hotel',
      puntos: [
        'Aqua Suhe NO.1 Hotel (Shanghai Jing’an), 688 Hengfeng Road. Cinco noches, del 21 al 26.',
        'Entrada después de las 14:00; salida antes de las 12:00.',
        'Desayuno incluido del 22 al 26, de 07:00 a 10:00: preguntar si lo dan para llevar, sin contar con ello.',
      ],
      enlaces: [enlace('Ficha del hotel', 'https://sg.trip.com/hotels/jing-an-district-hotel-detail-2895314/aqua-suhe-no-1-hotel-shanghai-jingan/')],
    },
    {
      titulo: 'Fuera del plan por ahora',
      puntos: [
        'Nankín: Niushoushan, Mausoleo Ming Xiaoling, Palacio Presidencial y los demás museos.',
        'Shanghái: Museo de Historia Natural, Museo de Arte Contemporáneo, China Art Museum, Templo del Buda de Jade y varios centros comerciales.',
        'Nanjing Road, solo si pasamos por allí; no es el sitio para moda china original a buen precio.',
      ],
    },
  ],
  pendientes: [
    'Hotel: consultar early check-in (gratis o de pago) y consigna.',
    'Masaje: confirmar para dos el miércoles 21 hacia mediodía: tratamiento, duración y precio final (máx. 230 ¥/persona).',
    'Tren y museo: comprobar 12306, elegir estaciones y horarios reales y hacer la reserva nominal del museo.',
    'Disneyland: comprar la entrada y consultar el horario del 22.',
    'Equipaje: verificar la franquicia de los cuatro vuelos antes de comprar la maleta.',
    'Domingo noche: decidir cena giratoria en la Perla o solo vistas; reservar solo tras ver el precio final.',
    'Sábado noche: mirar la programación y la entrada de Hush/INS para el 24.',
  ],
};
