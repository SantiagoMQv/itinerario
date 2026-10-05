// Formato del itinerario. Todas las horas son hora local de China (UTC+8, sin cambio de horario).

export type Categoria =
  | 'hotel'
  | 'comida'
  | 'cultura' // templos, jardines clásicos, lugares históricos
  | 'museo'
  | 'mirador' // rascacielos y vistas
  | 'barrio' // calles y barrios para pasear
  | 'naturaleza'
  | 'compras'
  | 'ocio' // espectáculos, vida nocturna
  | 'transporte' // estaciones, aeropuertos
  | 'otro';

export type Transporte = 'a_pie' | 'metro' | 'taxi' | 'bus' | 'tren' | 'maglev' | 'ferry' | 'avion' | 'bici';

export interface Enlace {
  texto: string;
  url: string;
}

/** Gasto aproximado por persona, en yuanes. Sin `max` es un precio fijo; 0 es gratis. */
export interface Gasto {
  concepto: string;
  min: number;
  max?: number;
}

export interface Llegada {
  modo: Transporte;
  /** Texto libre, p. ej. "Línea 2 → Nanjing Rd East". */
  detalle?: string;
  /** Duración del trayecto en minutos. Si falta se estima por distancia. */
  min?: number;
}

export interface Parada {
  /** "HH:MM". Se admite "24:30" para pasada la medianoche del mismo día de itinerario. */
  hora: string;
  /** Hora de salida "HH:MM". Si falta, se calcula a partir de la siguiente parada. */
  fin?: string;
  nombre: string;
  /** Nombre en chino, para enseñárselo al taxista. */
  local?: string;
  categoria: Categoria;
  /** Coordenadas WGS-84 (las de OpenStreetMap / GPS, no las de Amap o Baidu). */
  lat: number;
  lng: number;
  /** Cómo se llega desde la parada anterior (que puede ser la última del día anterior). */
  llegada?: Llegada;
  notas?: string;
  direccion?: string;
  /** Dirección en chino. */
  direccionLocal?: string;
  reserva?: string;
  /** Plan que se hace solo si apetece o si se cumple alguna condición. */
  opcional?: boolean;
  enlaces?: Enlace[];
  gastos?: Gasto[];
}

export interface Dia {
  /** "YYYY-MM-DD" */
  fecha: string;
  titulo: string;
  /** Ciudad principal del día, solo para mostrar. */
  ciudad?: string;
  /** Notas generales del día. */
  notas?: string;
  paradas: Parada[];
}

/** Bloque de información general del viaje (vuelos, hotel, prioridades…). */
export interface Seccion {
  titulo: string;
  puntos: string[];
  enlaces?: Enlace[];
}

export interface Itinerario {
  titulo: string;
  subtitulo?: string;
  /** Yuanes por euro, para mostrar la equivalencia aproximada de los gastos. */
  yuanesPorEuro?: number;
  /** Marca los datos como de ejemplo (se avisa en pantalla). */
  ejemplo?: boolean;
  dias: Dia[];
  secciones?: Seccion[];
  /** Cosas por comprobar o reservar; se pueden ir marcando en la app. */
  pendientes?: string[];
}
