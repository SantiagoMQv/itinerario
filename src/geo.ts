export type LngLat = [number, number];

const RADIO_TIERRA_KM = 6371;
const rad = (g: number) => (g * Math.PI) / 180;

/** Distancia en línea recta (km). */
export function distanciaKm(a: LngLat, b: LngLat): number {
  const dLat = rad(b[1] - a[1]);
  const dLng = rad(b[0] - a[0]);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a[1])) * Math.cos(rad(b[1])) * Math.sin(dLng / 2) ** 2;
  return 2 * RADIO_TIERRA_KM * Math.asin(Math.min(1, Math.sqrt(h)));
}

// Proyección Web Mercator normalizada a [0, 1], la misma que usa el mapa.
const aMerc = ([lng, lat]: LngLat): [number, number] => [
  (lng + 180) / 360,
  (1 - Math.log(Math.tan(rad(lat)) + 1 / Math.cos(rad(lat))) / Math.PI) / 2,
];
const deMerc = ([x, y]: [number, number]): LngLat => [
  x * 360 - 180,
  (Math.atan(Math.sinh(Math.PI * (1 - 2 * y))) * 180) / Math.PI,
];

export interface Arco {
  coords: LngLat[];
  /** Longitud acumulada (en unidades Mercator) hasta cada punto. */
  acum: number[];
  total: number;
}

/**
 * Curva de Bézier cuadrática entre dos puntos, trazada en Mercator para que se vea
 * igual de curva a cualquier zoom. La ida y la vuelta entre dos sitios se curvan
 * hacia lados opuestos, así no se solapan.
 */
export function crearArco(a: LngLat, b: LngLat, curvatura = 0.18, pasos = 48): Arco {
  const A = aMerc(a);
  const B = aMerc(b);
  const dx = B[0] - A[0];
  const dy = B[1] - A[1];
  const cx = (A[0] + B[0]) / 2 - dy * curvatura;
  const cy = (A[1] + B[1]) / 2 + dx * curvatura;
  const merc: [number, number][] = [];
  for (let i = 0; i <= pasos; i++) {
    const t = i / pasos;
    const u = 1 - t;
    merc.push([u * u * A[0] + 2 * u * t * cx + t * t * B[0], u * u * A[1] + 2 * u * t * cy + t * t * B[1]]);
  }
  const acum = [0];
  for (let i = 1; i < merc.length; i++) {
    acum.push(acum[i - 1] + Math.hypot(merc[i][0] - merc[i - 1][0], merc[i][1] - merc[i - 1][1]));
  }
  const coords = merc.map(deMerc);
  coords[0] = a;
  coords[coords.length - 1] = b;
  return { coords, acum, total: acum[acum.length - 1] };
}

/** Punto situado a la fracción `f` (0–1) del recorrido del arco, y el índice del tramo donde cae. */
function localizar(arco: Arco, f: number): { punto: LngLat; i: number } {
  const { coords, acum, total } = arco;
  if (total === 0 || f <= 0) return { punto: coords[0], i: 0 };
  if (f >= 1) return { punto: coords[coords.length - 1], i: coords.length - 2 };
  const objetivo = f * total;
  let i = 1;
  while (i < acum.length - 1 && acum[i] < objetivo) i++;
  const k = (objetivo - acum[i - 1]) / (acum[i] - acum[i - 1] || 1);
  const [x0, y0] = coords[i - 1];
  const [x1, y1] = coords[i];
  return { punto: [x0 + (x1 - x0) * k, y0 + (y1 - y0) * k], i: i - 1 };
}

export const puntoEnArco = (arco: Arco, f: number): LngLat => localizar(arco, f).punto;

/** Divide el arco en la parte recorrida y la pendiente. */
export function partirArco(arco: Arco, f: number): [LngLat[], LngLat[]] {
  const { punto, i } = localizar(arco, f);
  return [
    [...arco.coords.slice(0, i + 1), punto],
    [punto, ...arco.coords.slice(i + 1)],
  ];
}

export type Caja = [LngLat, LngLat];

export function cajaDe(puntos: LngLat[]): Caja {
  let [minX, minY, maxX, maxY] = [Infinity, Infinity, -Infinity, -Infinity];
  for (const [x, y] of puntos) {
    minX = Math.min(minX, x);
    minY = Math.min(minY, y);
    maxX = Math.max(maxX, x);
    maxY = Math.max(maxY, y);
  }
  return [
    [minX, minY],
    [maxX, maxY],
  ];
}

/** Agranda la caja `km` kilómetros por cada lado. */
export function ampliarCaja([[x0, y0], [x1, y1]]: Caja, km: number): Caja {
  const dLat = km / 111;
  const dLng = km / (111 * Math.cos(rad((y0 + y1) / 2)));
  return [
    [x0 - dLng, y0 - dLat],
    [x1 + dLng, y1 + dLat],
  ];
}

/** Teselas x/y que cubren la caja a un zoom dado. */
export function teselasDeCaja([[x0, y0], [x1, y1]]: Caja, z: number): [number, number][] {
  const n = 2 ** z;
  const tx = (lng: number) => Math.floor(((lng + 180) / 360) * n);
  const ty = (lat: number) => Math.floor(aMerc([0, lat])[1] * n);
  const res: [number, number][] = [];
  for (let x = tx(x0); x <= tx(x1); x++) {
    for (let y = ty(y1); y <= ty(y0); y++) res.push([x, y]);
  }
  return res;
}
