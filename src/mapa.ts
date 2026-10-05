import { type GeoJSONSource, type LngLatBoundsLike, Map as Mapa, Marker, setWorkerUrl } from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import urlWorker from 'maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url';
import { type LngLat, cajaDe, partirArco, puntoEnArco } from './geo';
import { km } from './formato';
import type { DiaC, Modelo, Momento, ParadaC, TramoC } from './modelo';

setWorkerUrl(urlWorker);

export const ESTILO = 'https://tiles.openfreemap.org/styles/positron';

/** Fluorescente: solo marca lo que está pasando ahora. */
export const FLUOR = '#ddf94a';
const TINTA = { claro: '#14213d', oscuro: '#e8ecf2' };

interface Elemento<G, P> {
  type: 'Feature';
  geometry: G;
  properties: P;
}
type Linea = Elemento<{ type: 'LineString'; coordinates: LngLat[] }, { hecho: boolean; color: string }>;
type Punto = Elemento<{ type: 'Point'; coordinates: LngLat }, { id: number; color: string }>;

const linea = (coords: LngLat[], hecho: boolean, color: string): Linea => ({
  type: 'Feature',
  geometry: { type: 'LineString', coordinates: coords },
  properties: { hecho, color },
});
const coleccion = (features: (Linea | Punto)[]) => ({ type: 'FeatureCollection' as const, features });

export interface Margenes {
  top: number;
  bottom: number;
  left: number;
  right: number;
}

// ---------- Colores ----------

type RGBA = [number, number, number, number];

const lienzo = document.createElement('canvas').getContext('2d')!;
/** Convierte cualquier color CSS a [r, g, b, a]; null si no es un color. */
function leerColor(valor: string): RGBA | null {
  lienzo.fillStyle = '#010203';
  lienzo.fillStyle = valor;
  const v = lienzo.fillStyle;
  if (v === '#010203' && valor.trim().toLowerCase() !== '#010203') return null;
  if (v.startsWith('#')) return [parseInt(v.slice(1, 3), 16), parseInt(v.slice(3, 5), 16), parseInt(v.slice(5, 7), 16), 1];
  const n = v.match(/[\d.]+/g)!.map(Number);
  return [n[0], n[1], n[2], n[3] ?? 1];
}

const css = ([r, g, b, a]: RGBA) => `rgba(${Math.round(r)}, ${Math.round(g)}, ${Math.round(b)}, ${a})`;

function aHsl([r, g, b]: RGBA): [number, number, number] {
  r /= 255;
  g /= 255;
  b /= 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  if (max === min) return [0, 0, l];
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  const h = max === r ? (g - b) / d + (g < b ? 6 : 0) : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return [h * 60, s, l];
}

const desdeHsl = (h: number, s: number, l: number, a: number) => `hsla(${h.toFixed(0)}, ${(s * 100).toFixed(0)}%, ${(l * 100).toFixed(1)}%, ${a})`;

/** Mezcla un color con blanco (f > 0) o con negro (f < 0). */
export function aclarar(hex: string, f: number): string {
  const c = leerColor(hex)!;
  const destino = f > 0 ? 255 : 0;
  const k = Math.abs(f);
  return css([c[0] + (destino - c[0]) * k, c[1] + (destino - c[1]) * k, c[2] + (destino - c[2]) * k, 1]);
}

/** Tapa oscura: suelo y calles en azul noche, rótulos claros. */
function deNoche(valor: string, esTexto: boolean, esHalo: boolean): string {
  const c = leerColor(valor);
  if (!c) return valor;
  const [h, s, l] = aHsl(c);
  if (esHalo) return desdeHsl(216, 0.3, 0.12, c[3]);
  if (esTexto) return desdeHsl(h, Math.min(s, 0.35), Math.min(0.9, 1 - l * 0.7), c[3]);
  const nueva = Math.max(0.05, 0.075 + (l - 0.8) * 0.62);
  return desdeHsl(s > 0.15 ? h : 216, s > 0.15 ? Math.min(s, 0.4) : 0.28, nueva, c[3]);
}

/** Recorre una expresión de estilo cambiando cada color que encuentre. */
function mapearColores(valor: unknown, f: (c: string) => string): unknown {
  if (typeof valor === 'string') return leerColor(valor) ? f(valor) : valor;
  if (Array.isArray(valor)) return valor.map((v, i) => (i === 0 ? v : mapearColores(v, f)));
  return valor;
}

/** Agua azul y parques verdes, como en un plano dibujado (Positron los trae en gris). */
const RETOQUES: Record<string, { claro: Record<string, string>; oscuro: Record<string, string> }> = {
  water: { claro: { 'fill-color': '#c8ddf2' }, oscuro: { 'fill-color': '#16304d' } },
  waterway: { claro: { 'line-color': '#a8c8e8' }, oscuro: { 'line-color': '#1d3d60' } },
  park: { claro: { 'fill-color': '#deecd6' }, oscuro: { 'fill-color': '#1a2a24' } },
  landcover_wood: { claro: { 'fill-color': '#d6e7cd' }, oscuro: { 'fill-color': '#1a2a22' } },
  water_name_point_label: { claro: { 'text-color': '#3a5f9f' }, oscuro: { 'text-color': '#8db3ea' } },
  water_name_line_label: { claro: { 'text-color': '#3a5f9f' }, oscuro: { 'text-color': '#8db3ea' } },
};

/** [2, 3, 7] → «2·3·7»; si son más de tres, solo los extremos: «2–8». */
function rango(numeros: number[]): string {
  const n = [...new Set(numeros)].sort((a, b) => a - b);
  return n.length > 3 ? `${n[0]}–${n[n.length - 1]}` : n.join('·');
}

export class VistaMapa {
  readonly mapa: Mapa;
  readonly listo: Promise<void>;
  /** Un marcador por sitio: si se pasa dos veces por el mismo lugar, comparten marcador. */
  private marcadores: { m: Marker; grupo: ParadaC[]; etiqueta: string }[] = [];
  /** Marcadores que, a este zoom, representan a otros que se pisarían con ellos. */
  private racimos = new Map<Marker, ParadaC[]>();
  private pastillas: { m: Marker; t: TramoC }[] = [];
  private posicion: Marker;
  private dia: DiaC | null = null;
  private clave = '';
  private t = 0;
  private momento: Momento | null = null;
  private margenes: Margenes = { top: 0, bottom: 0, left: 0, right: 0 };
  private oscuro = false;
  private originales = new Map<string, Record<string, unknown>>();

  constructor(
    contenedor: HTMLElement,
    private modelo: Modelo,
    private eventos: { alPulsarParada: (p: ParadaC) => void; alArrastrar: () => void },
  ) {
    this.mapa = new Mapa({
      container: contenedor,
      style: ESTILO,
      center: [121.47, 31.23],
      zoom: 11,
      attributionControl: { compact: true },
      dragRotate: false,
      pitchWithRotate: false,
      touchPitch: false,
      maxPitch: 0,
    });
    this.mapa.touchZoomRotate.disableRotation();
    this.mapa.keyboard.disableRotation();
    this.mapa.on('dragstart', (e) => {
      if ('originalEvent' in e && e.originalEvent) this.eventos.alArrastrar();
    });
    this.mapa.on('zoom', () => this.ajustarPastillas());

    const el = document.createElement('div');
    el.className = 'posicion';
    this.posicion = new Marker({ element: el });

    this.listo = new Promise((ok) =>
      this.mapa.on('load', () => {
        this.guardarOriginales();
        this.crearCapas();
        this.pintarBase();
        ok();
      }),
    );
  }

  private get tinta() {
    return this.oscuro ? TINTA.oscuro : TINTA.claro;
  }

  /** Color de un día sobre el mapa: de noche, algo más claro para que se lea sobre fondo oscuro. */
  colorDe(dia: DiaC): string {
    return this.oscuro ? aclarar(dia.color, 0.38) : dia.color;
  }

  private crearCapas() {
    const m = this.mapa;
    const vacio = coleccion([]);
    m.addSource('ruta', { type: 'geojson', data: vacio });
    m.addSource('fluor', { type: 'geojson', data: vacio });
    m.addSource('tinta', { type: 'geojson', data: vacio });
    m.addSource('todo', { type: 'geojson', data: vacio });
    m.addSource('todo-puntos', { type: 'geojson', data: vacio });

    const redondo = { 'line-cap': 'round', 'line-join': 'round' } as const;
    // El trazo fluorescente va debajo de todo: subraya el tramo que toca ahora.
    m.addLayer({
      id: 'ruta-fluor',
      type: 'line',
      source: 'fluor',
      layout: redondo,
      paint: { 'line-color': FLUOR, 'line-width': ['interpolate', ['linear'], ['zoom'], 10, 12, 16, 20], 'line-opacity': 0.9 },
    });
    m.addLayer({
      id: 'ruta-pendiente',
      type: 'line',
      source: 'ruta',
      filter: ['==', ['get', 'hecho'], false],
      layout: redondo,
      paint: { 'line-color': ['get', 'color'], 'line-width': 2.5, 'line-opacity': 0.75 },
    });
    m.addLayer({
      id: 'ruta-hecha',
      type: 'line',
      source: 'ruta',
      filter: ['==', ['get', 'hecho'], true],
      layout: redondo,
      paint: { 'line-color': ['get', 'color'], 'line-width': 3.5 },
    });
    m.addLayer({
      id: 'ruta-tinta',
      type: 'line',
      source: 'tinta',
      layout: redondo,
      paint: { 'line-color': this.tinta, 'line-width': 3 },
    });
    m.addLayer({
      id: 'todo-lineas',
      type: 'line',
      source: 'todo',
      layout: { ...redondo, visibility: 'none' },
      paint: { 'line-color': ['get', 'color'], 'line-width': 3, 'line-opacity': 0.9 },
    });
    m.addLayer({
      id: 'todo-puntos',
      type: 'circle',
      source: 'todo-puntos',
      layout: { visibility: 'none' },
      paint: {
        'circle-radius': 5.5,
        'circle-color': ['get', 'color'],
        'circle-stroke-color': '#ffffff',
        'circle-stroke-width': 2,
      },
    });
    m.on('click', 'todo-puntos', (e) => {
      const id = e.features?.[0]?.properties?.id;
      if (typeof id === 'number') this.eventos.alPulsarParada(this.modelo.paradas[id]);
    });
    m.on('mouseenter', 'todo-puntos', () => (m.getCanvas().style.cursor = 'pointer'));
    m.on('mouseleave', 'todo-puntos', () => (m.getCanvas().style.cursor = ''));
  }

  // ---------- Tema claro / noche ----------

  private guardarOriginales() {
    for (const capa of this.mapa.getStyle().layers) {
      const paint = (capa as { paint?: Record<string, unknown> }).paint ?? {};
      const colores: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(paint)) if (k.endsWith('color')) colores[k] = v;
      if (Object.keys(colores).length) this.originales.set(capa.id, colores);
    }
  }

  private pintarBase() {
    const tema = this.oscuro ? 'oscuro' : 'claro';
    for (const [id, colores] of this.originales) {
      for (const [prop, valor] of Object.entries(colores)) {
        const retoque = RETOQUES[id]?.[tema][prop];
        const nuevo =
          retoque ??
          (this.oscuro
            ? mapearColores(valor, (c) => deNoche(c, prop === 'text-color', prop === 'text-halo-color'))
            : valor);
        this.mapa.setPaintProperty(id, prop as Parameters<Mapa['setPaintProperty']>[1], nuevo);
      }
    }
    if (this.mapa.getLayer('ruta-tinta')) {
      this.mapa.setPaintProperty('ruta-tinta', 'line-color', this.tinta);
      this.mapa.setPaintProperty('todo-puntos', 'circle-stroke-color', this.oscuro ? '#141a22' : '#ffffff');
    }
  }

  fijarTema(oscuro: boolean) {
    if (oscuro === this.oscuro) return;
    this.oscuro = oscuro;
    if (!this.mapa.isStyleLoaded() && !this.originales.size) return;
    this.pintarBase();
    if (this.dia) {
      for (const { m } of this.marcadores) m.getElement().style.setProperty('--color', this.colorDe(this.dia));
      if (this.momento) this.actualizar(this.t, this.momento);
    } else this.mostrarTodo();
  }

  // Si el estilo del mapa aún no ha cargado (o no hay conexión) las capas no existen todavía:
  // se ignora y se vuelve a pintar cuando cargue.
  private fuente(id: string) {
    return this.mapa.getSource(id) as GeoJSONSource | undefined;
  }

  private visibilidad(capas: string[], visible: boolean) {
    for (const c of capas) {
      if (this.mapa.getLayer(c)) this.mapa.setLayoutProperty(c, 'visibility', visible ? 'visible' : 'none');
    }
  }

  private limpiarMarcadores() {
    for (const { m } of this.marcadores) m.remove();
    for (const { m } of this.pastillas) m.remove();
    this.marcadores = [];
    this.racimos.clear();
    this.pastillas = [];
    this.posicion.remove();
  }

  /** Vista de un día: su ruta, sus paradas numeradas y la distancia de cada trayecto. */
  mostrarDia(dia: DiaC) {
    this.dia = dia;
    this.clave = '';
    this.momento = null;
    this.limpiarMarcadores();
    this.visibilidad(['todo-lineas', 'todo-puntos'], false);
    this.visibilidad(['ruta-fluor', 'ruta-pendiente', 'ruta-hecha', 'ruta-tinta'], true);

    const todas = dia.origen ? [dia.origen, ...dia.paradas] : dia.paradas;
    const grupos = new Map<string, ParadaC[]>();
    for (const p of todas) {
      const clave = p.pos.map((c) => c.toFixed(4)).join(',');
      grupos.set(clave, [...(grupos.get(clave) ?? []), p]);
    }
    for (const grupo of grupos.values()) {
      const numeros = grupo.map((p) => p.n).filter((n) => n !== null);
      const el = document.createElement('button');
      el.type = 'button';
      el.className = 'marcador';
      el.classList.toggle('hotel', !numeros.length);
      el.classList.toggle('varios', numeros.length > 1);
      el.classList.toggle('opcional', grupo.every((p) => p.p.opcional));
      el.style.setProperty('--color', this.colorDe(dia));
      el.setAttribute('aria-label', grupo[0].p.nombre);
      const etiqueta = numeros.length ? numeros.join('·') : 'H';
      el.innerHTML = `<span>${etiqueta}</span>`;
      el.addEventListener('click', (e) => {
        e.stopPropagation();
        const racimo = this.racimos.get(m);
        if (racimo) return this.encuadrar(racimo.map((p) => p.pos), true, 17);
        // De las visitas a ese sitio, la que se está haciendo, la siguiente o la última.
        const elegida =
          grupo.find((p) => p.inicio <= this.t && this.t < p.fin) ??
          grupo.find((p) => p.inicio > this.t) ??
          grupo[grupo.length - 1];
        this.eventos.alPulsarParada(elegida);
      });
      const m = new Marker({ element: el }).setLngLat(grupo[0].pos).addTo(this.mapa);
      this.marcadores.push({ m, grupo, etiqueta });
    }

    for (const t of dia.tramos) {
      if (t.nulo) continue;
      const el = document.createElement('div');
      el.className = 'pastilla';
      el.textContent = km(t.km);
      el.title = `${t.desde.p.nombre} → ${t.hasta.p.nombre}`;
      const m = new Marker({ element: el }).setLngLat(puntoEnArco(t.arco, 0.5)).addTo(this.mapa);
      this.pastillas.push({ m, t });
    }
    this.ajustarPastillas();
  }

  /**
   * Oculta la distancia de los trayectos que en pantalla son demasiado cortos para que quepa
   * y las que se pisarían con otra (tienen preferencia el tramo de ahora y los más largos).
   */
  private ajustarPastillas() {
    this.agruparMarcadores();
    const puestas: { x: number; y: number; w: number; h: number }[] = [];
    const ahora = this.tramoResaltado();
    const orden = [...this.pastillas].sort((a, b) => Number(b.t === ahora) - Number(a.t === ahora) || b.t.km - a.t.km);
    for (const { m, t } of orden) {
      const el = m.getElement();
      const a = this.mapa.project(t.desde.pos);
      const b = this.mapa.project(t.hasta.pos);
      el.classList.remove('oculta');
      el.classList.toggle('ahora', t === ahora);
      const c = this.mapa.project(puntoEnArco(t.arco, 0.5));
      const caja = { x: c.x, y: c.y, w: el.offsetWidth + 6, h: el.offsetHeight + 4 };
      const pisa = puestas.some((o) => Math.abs(o.x - caja.x) * 2 < o.w + caja.w && Math.abs(o.y - caja.y) * 2 < o.h + caja.h);
      const corto = Math.hypot(a.x - b.x, a.y - b.y) < 110;
      el.classList.toggle('oculta', corto || pisa);
      if (!corto && !pisa) puestas.push(caja);
    }
  }

  /**
   * Las paradas que en pantalla quedan casi encima unas de otras se juntan en un solo marcador
   * con su rango («2–8»); al tocarlo se acerca el mapa. La parada actual nunca se agrupa.
   */
  private agruparMarcadores() {
    this.racimos.clear();
    const puntos = this.marcadores.map((x) => {
      const el = x.m.getElement();
      el.classList.remove('oculto', 'racimo', 'junto-actual');
      el.querySelector('span')!.textContent = x.etiqueta;
      return { x, el, p: this.mapa.project(x.grupo[0].pos), actual: el.classList.contains('actual') };
    });
    const usados = new Set<(typeof puntos)[number]>();
    for (const a of puntos) {
      if (a.actual || usados.has(a)) continue;
      const cerca = puntos.filter((b) => b !== a && !b.actual && !usados.has(b) && Math.hypot(a.p.x - b.p.x, a.p.y - b.p.y) < 26);
      if (!cerca.length) continue;
      const todas = [a, ...cerca].flatMap((c) => c.x.grupo);
      usados.add(a);
      for (const b of cerca) {
        usados.add(b);
        b.el.classList.add('oculto');
      }
      a.el.classList.add('racimo');
      const actual = puntos.find((c) => c.actual);
      a.el.classList.toggle('junto-actual', !!actual && Math.hypot(a.p.x - actual.p.x, a.p.y - actual.p.y) < 40);
      a.el.querySelector('span')!.textContent = rango(todas.map((p) => p.n).filter((n) => n !== null)) || 'H';
      this.racimos.set(a.x.m, todas);
    }
  }

  /** Tramo que se subraya: el que se recorre ahora o, si se está en una parada, el que viene. */
  private tramoResaltado(): TramoC | null {
    const m = this.momento;
    const dia = this.dia;
    if (!m || !dia) return null;
    if (m.tipo === 'camino') return m.tramo;
    return dia.tramos.find((t) => t.desde === m.parada && !t.nulo) ?? null;
  }

  /** Vista de todo el viaje con cada día de un color. */
  mostrarTodo() {
    this.dia = null;
    this.momento = null;
    this.limpiarMarcadores();
    this.visibilidad(['ruta-fluor', 'ruta-pendiente', 'ruta-hecha', 'ruta-tinta'], false);
    this.visibilidad(['todo-lineas', 'todo-puntos'], true);
    const { dias, paradas } = this.modelo;
    this.fuente('todo')?.setData(
      coleccion(dias.flatMap((d) => d.tramos.filter((t) => !t.nulo).map((t) => linea(t.arco.coords, true, this.colorDe(d))))),
    );
    this.fuente('todo-puntos')?.setData(
      coleccion(
        paradas.map(
          (p): Punto => ({
            type: 'Feature',
            geometry: { type: 'Point', coordinates: p.pos },
            properties: { id: p.id, color: this.colorDe(dias[p.dia]) },
          }),
        ),
      ),
    );
  }

  /** Pinta el estado del día en el instante `t`. */
  actualizar(t: number, momento: Momento) {
    const dia = this.dia;
    if (!dia) return;
    this.t = t;
    this.momento = momento;
    const color = this.colorDe(dia);
    const resaltado = this.tramoResaltado();
    const lineas: Linea[] = [];
    for (const tramo of dia.tramos) {
      if (tramo.nulo || tramo === resaltado) continue;
      lineas.push(linea(tramo.arco.coords, tramo.llegada <= t, color));
    }
    // El tramo de ahora va en tinta sobre el fluorescente: de camino, solo lo que falta por recorrer.
    let tinta: LngLat[] = [];
    if (resaltado) {
      if (momento.tipo === 'camino') {
        const [hecho, falta] = partirArco(resaltado.arco, momento.f);
        lineas.push(linea(hecho, true, color));
        tinta = falta;
      } else tinta = resaltado.arco.coords;
    }
    this.fuente('ruta')?.setData(coleccion(lineas));
    this.fuente('fluor')?.setData(coleccion(resaltado ? [linea(resaltado.arco.coords, false, FLUOR)] : []));
    this.fuente('tinta')?.setData(coleccion(tinta.length ? [linea(tinta, false, this.tinta)] : []));

    const actual = momento.parada;
    for (const { m, grupo } of this.marcadores) {
      const el = m.getElement();
      const esActual = !!actual && grupo.includes(actual);
      el.classList.toggle('actual', esActual);
      el.classList.toggle('hecha', !esActual && grupo.some((p) => p.inicio <= t));
    }

    if (momento.tipo === 'camino') {
      this.posicion.setLngLat(puntoEnArco(momento.tramo.arco, momento.f)).addTo(this.mapa);
    } else {
      this.posicion.remove();
    }
    this.ajustarPastillas();
  }

  /**
   * Zona del mapa tapada por la barra de días y el panel: la cámara la tiene en cuenta.
   * (No se usa setPadding del mapa porque interrumpe las animaciones en curso.)
   */
  fijarMargenes(margenes: Margenes) {
    this.margenes = margenes;
    this.ajustarPastillas();
  }

  /** Desplazamiento para que el centro quede en el centro de la parte visible del mapa. */
  private get desplazamiento(): [number, number] {
    const { top, bottom, left, right } = this.margenes;
    return [(left - right) / 2, (top - bottom) / 2];
  }

  private centrar(pos: LngLat, zoom?: number, duration = 700) {
    this.mapa.easeTo({ center: pos, zoom, duration, offset: this.desplazamiento });
  }

  encuadrar(puntos: LngLat[], animar = true, maxZoom = 15.5) {
    if (!puntos.length) return;
    const caja = cajaDe(puntos) as LngLatBoundsLike;
    const { top, bottom, left, right } = this.margenes;
    const extra = 36;
    this.mapa.fitBounds(caja, {
      padding: { top: top + extra, bottom: bottom + extra, left: left + extra, right: right + extra },
      maxZoom,
      duration: animar ? 800 : 0,
      linear: true,
    });
  }

  encuadrarDia(dia: DiaC, animar = true) {
    const puntos = [...(dia.origen ? [dia.origen.pos] : []), ...dia.paradas.map((p) => p.pos)];
    this.encuadrar(puntos, animar);
  }

  encuadrarTodo(animar = true) {
    this.encuadrar(
      this.modelo.paradas.map((p) => p.pos),
      animar,
    );
  }

  private visible(pos: LngLat): boolean {
    const { x, y } = this.mapa.project(pos);
    const c = this.mapa.getContainer();
    const { top, bottom, left, right } = this.margenes;
    return x > left && x < c.clientWidth - right && y > top && y < c.clientHeight - bottom;
  }

  /**
   * Mueve la cámara para acompañar el recorrido: encuadra cada trayecto al empezarlo y
   * centra cada parada si queda fuera de la vista. Con `mover = false` solo toma nota
   * del momento actual; con `forzar` recoloca aunque no haya cambiado.
   */
  seguir(momento: Momento, mover = true, forzar = false) {
    const clave = momento.tipo === 'camino' ? `t${momento.tramo.id}` : `p${momento.parada.id}`;
    const cambio = forzar || clave !== this.clave;
    this.clave = clave;
    if (!mover) return;
    if (momento.tipo === 'camino') {
      const punto = puntoEnArco(momento.tramo.arco, momento.f);
      if (cambio) this.encuadrar(momento.tramo.arco.coords, true, 15);
      else if (!this.visible(punto) && !this.mapa.isMoving()) this.centrar(punto, undefined, 500);
    } else if (cambio) {
      // Parado: se encuadra la parada con la siguiente, que es el tramo subrayado.
      const siguiente = this.dia?.tramos.find((t) => t.desde === momento.parada && !t.nulo);
      if (siguiente) this.encuadrar([siguiente.desde.pos, siguiente.hasta.pos], true, 15);
      else if (forzar || !this.visible(momento.parada.pos)) this.centrar(momento.parada.pos);
    }
  }

  /** Centra una parada concreta (al pulsarla en la lista). */
  enfocar(p: ParadaC) {
    this.clave = `p${p.id}`;
    this.centrar(p.pos, Math.max(this.mapa.getZoom(), 14));
  }
}
