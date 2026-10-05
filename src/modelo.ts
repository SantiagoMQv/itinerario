import { type Arco, type LngLat, crearArco, distanciaKm } from './geo';
import { aMinutos } from './formato';
import type { Dia, Itinerario, Parada, Seccion, Transporte } from './tipos';

export interface ParadaC {
  /** Índice global en todo el viaje. */
  id: number;
  p: Parada;
  dia: number;
  /** Número dentro del día (los hoteles no llevan número). */
  n: number | null;
  pos: LngLat;
  inicio: number;
  fin: number;
  /** Zona geográfica (Shanghái, Nankín…) calculada por cercanía. */
  zona: number;
}

export interface TramoC {
  /** Igual al id de la parada de destino. */
  id: number;
  desde: ParadaC;
  hasta: ParadaC;
  salida: number;
  llegada: number;
  km: number;
  modo: Transporte;
  detalle?: string;
  minutos: number;
  estimado: boolean;
  /** Origen y destino prácticamente en el mismo sitio: no se dibuja. */
  nulo: boolean;
  arco: Arco;
}

export interface DiaC {
  idx: number;
  d: Dia;
  color: string;
  paradas: ParadaC[];
  /** Última parada del día anterior, desde la que sale el primer trayecto. */
  origen: ParadaC | null;
  tramos: TramoC[];
  desde: number;
  hasta: number;
  km: number;
}

export interface Modelo {
  titulo: string;
  subtitulo?: string;
  yuanesPorEuro?: number;
  ejemplo: boolean;
  secciones: Seccion[];
  pendientes: string[];
  dias: DiaC[];
  paradas: ParadaC[];
  tramos: TramoC[];
  avisos: string[];
}

export type Momento =
  | { tipo: 'parada'; parada: ParadaC; tramo: null }
  | { tipo: 'camino'; parada: null; tramo: TramoC; f: number };

/** Colores de pestaña de cada día (todos con contraste suficiente para texto blanco). */
export const COLORES_DIA = [
  '#2453d1', // cobalto
  '#1e7f3e', // verde hoja
  '#c8327e', // magenta
  '#c45200', // naranja
  '#00777a', // verde azulado
  '#7a2e8e', // ciruela
  '#b3261e', // rojo
  '#5c6b12', // oliva
  '#8a4b1f', // tabaco
  '#3949ab', // índigo
];

/** Duración aproximada (min) de un trayecto según el medio y la distancia en línea recta. */
function estimarMinutos(modo: Transporte, km: number): number {
  const porModo: Record<Transporte, number> = {
    a_pie: ((km * 1.3) / 4.5) * 60,
    bici: ((km * 1.3) / 12) * 60,
    metro: 12 + ((km * 1.3) / 28) * 60,
    taxi: 5 + ((km * 1.4) / 22) * 60,
    bus: 8 + ((km * 1.3) / 15) * 60,
    tren: 20 + (km / 180) * 60,
    maglev: 8 + (km / 200) * 60,
    ferry: 5 + (km / 12) * 60,
    avion: 60 + (km / 700) * 60,
  };
  return Math.max(5, Math.round(porModo[modo] / 5) * 5);
}

/** Agrupa paradas en zonas: todo lo que está a menos de 40 km encadenado es la misma zona. */
function zonas(puntos: LngLat[]): number[] {
  const zona = puntos.map((_, i) => i);
  const raiz = (i: number): number => (zona[i] === i ? i : (zona[i] = raiz(zona[i])));
  for (let i = 0; i < puntos.length; i++) {
    for (let j = i + 1; j < puntos.length; j++) {
      if (distanciaKm(puntos[i], puntos[j]) < 40) zona[raiz(j)] = raiz(i);
    }
  }
  return puntos.map((_, i) => raiz(i));
}

const MEDIA_HORA = 30;
const bajarA = (m: number, paso: number) => Math.floor(m / paso) * paso;
const subirA = (m: number, paso: number) => Math.ceil(m / paso) * paso;

export function construirModelo(it: Itinerario): Modelo {
  const avisos: string[] = [];
  const paradas: ParadaC[] = [];

  it.dias.forEach((d, di) => {
    let n = 0;
    for (const p of d.paradas) {
      if (!Number.isFinite(p.lat) || !Number.isFinite(p.lng)) avisos.push(`«${p.nombre}» no tiene coordenadas.`);
      paradas.push({
        id: paradas.length,
        p,
        dia: di,
        n: p.categoria === 'hotel' ? null : ++n,
        pos: [p.lng, p.lat],
        inicio: aMinutos(d.fecha, p.hora),
        fin: NaN,
        zona: 0,
      });
    }
  });

  const zona = zonas(paradas.map((p) => p.pos));
  paradas.forEach((p, i) => (p.zona = zona[i]));

  for (let i = 1; i < paradas.length; i++) {
    if (paradas[i].inicio < paradas[i - 1].inicio) {
      avisos.push(`«${paradas[i].p.nombre}» empieza antes que «${paradas[i - 1].p.nombre}».`);
    }
  }

  const tramos: TramoC[] = [];
  for (let i = 1; i < paradas.length; i++) {
    const a = paradas[i - 1];
    const b = paradas[i];
    const distancia = distanciaKm(a.pos, b.pos);
    const modo = b.p.llegada?.modo ?? (distancia < 1.2 ? 'a_pie' : 'taxi');
    const minutos = b.p.llegada?.min ?? estimarMinutos(modo, distancia);
    const hueco = Math.max(0, b.inicio - a.inicio);
    let salida: number;
    if (a.p.fin) {
      salida = aMinutos(it.dias[a.dia].fecha, a.p.fin);
      if (salida > b.inicio || salida < a.inicio) {
        avisos.push(`La hora de salida de «${a.p.nombre}» no encaja con la llegada a «${b.p.nombre}».`);
        salida = Math.min(Math.max(salida, a.inicio), b.inicio);
      }
    } else {
      salida = Math.max(b.inicio - minutos, a.inicio + Math.min(hueco / 2, 15));
    }
    a.fin = salida;
    tramos.push({
      id: b.id,
      desde: a,
      hasta: b,
      salida,
      llegada: b.inicio,
      km: distancia,
      modo,
      detalle: b.p.llegada?.detalle,
      minutos,
      estimado: b.p.llegada?.min === undefined,
      nulo: distancia < 0.05,
      arco: crearArco(a.pos, b.pos),
    });
  }
  const ultima = paradas[paradas.length - 1];
  if (ultima) ultima.fin = ultima.p.fin ? aMinutos(it.dias[ultima.dia].fecha, ultima.p.fin) : ultima.inicio + 60;

  const dias: DiaC[] = it.dias.map((d, idx) => {
    const propias = paradas.filter((p) => p.dia === idx);
    const primera = propias[0];
    const origen = primera && primera.id > 0 ? paradas[primera.id - 1] : null;
    const delDia = tramos.filter((t) => t.hasta.dia === idx);
    const ultimaDelDia = propias[propias.length - 1];
    const comienzo = Math.min(primera?.inicio ?? aMinutos(d.fecha, '09:00'), delDia[0]?.salida ?? Infinity);
    const cierre = ultimaDelDia
      ? ultimaDelDia.p.fin
        ? ultimaDelDia.fin
        : ultimaDelDia.inicio + MEDIA_HORA
      : aMinutos(d.fecha, '21:00');
    return {
      idx,
      d,
      color: COLORES_DIA[idx % COLORES_DIA.length],
      paradas: propias,
      origen,
      tramos: delDia,
      desde: bajarA(comienzo - 15, MEDIA_HORA),
      hasta: subirA(cierre, MEDIA_HORA),
      km: delDia.reduce((s, t) => s + t.km, 0),
    };
  });

  return {
    titulo: it.titulo,
    subtitulo: it.subtitulo,
    yuanesPorEuro: it.yuanesPorEuro,
    ejemplo: !!it.ejemplo,
    secciones: it.secciones ?? [],
    pendientes: it.pendientes ?? [],
    dias,
    paradas,
    tramos,
    avisos,
  };
}

/** Dónde se está en el instante `t`: en una parada o de camino entre dos. */
export function momentoEn(m: Modelo, t: number): Momento {
  for (const tramo of m.tramos) {
    if (!tramo.nulo && tramo.salida <= t && t < tramo.llegada) {
      return { tipo: 'camino', parada: null, tramo, f: (t - tramo.salida) / (tramo.llegada - tramo.salida) };
    }
  }
  let actual = m.paradas[0];
  for (const p of m.paradas) {
    if (p.inicio <= t) actual = p;
    else break;
  }
  return { tipo: 'parada', parada: actual, tramo: null };
}

/** Hotel de referencia para una parada: el último usado en la misma zona. */
export function hotelDe(m: Modelo, p: ParadaC): ParadaC | null {
  const hoteles = m.paradas.filter((h) => h.p.categoria === 'hotel' && h.zona === p.zona);
  return hoteles.filter((h) => h.id <= p.id).pop() ?? hoteles[0] ?? null;
}

/** Suma de los gastos por persona de un conjunto de paradas: [mínimo, máximo] en yuanes. */
export function gastoTotal(paradas: ParadaC[]): [number, number] {
  let min = 0;
  let max = 0;
  for (const p of paradas) {
    for (const g of p.p.gastos ?? []) {
      min += g.min;
      max += g.max ?? g.min;
    }
  }
  return [min, max];
}
