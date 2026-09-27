import { type GeoJSONSource, type LngLatBoundsLike, Map as Mapa, Marker, setWorkerUrl } from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import urlWorker from 'maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url';
import { type LngLat, cajaDe, partirArco, puntoEnArco } from './geo';
import { ICONO_CATEGORIA, TRANSPORTE, esc, km } from './formato';
import type { DiaC, Modelo, Momento, ParadaC, TramoC } from './modelo';

setWorkerUrl(urlWorker);

export const ESTILO = 'https://tiles.openfreemap.org/styles/positron';

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

export class VistaMapa {
  readonly mapa: Mapa;
  readonly listo: Promise<void>;
  /** Un marcador por sitio: si se pasa dos veces por el mismo lugar, comparten marcador. */
  private marcadores: { m: Marker; grupo: ParadaC[] }[] = [];
  private pastillas: { m: Marker; t: TramoC }[] = [];
  private posicion: Marker;
  private dia: DiaC | null = null;
  private clave = '';
  private t = 0;
  private margenes: Margenes = { top: 0, bottom: 0, left: 0, right: 0 };

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
        this.crearCapas();
        ok();
      }),
    );
  }

  private crearCapas() {
    const m = this.mapa;
    const vacio = coleccion([]);
    m.addSource('ruta', { type: 'geojson', data: vacio });
    m.addSource('todo', { type: 'geojson', data: vacio });
    m.addSource('todo-puntos', { type: 'geojson', data: vacio });

    m.addLayer({
      id: 'ruta-pendiente',
      type: 'line',
      source: 'ruta',
      filter: ['==', ['get', 'hecho'], false],
      layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: { 'line-color': ['get', 'color'], 'line-width': 3.5, 'line-opacity': 0.55, 'line-dasharray': [0.1, 2] },
    });
    m.addLayer({
      id: 'ruta-hecha-borde',
      type: 'line',
      source: 'ruta',
      filter: ['==', ['get', 'hecho'], true],
      layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: { 'line-color': '#ffffff', 'line-width': 8 },
    });
    m.addLayer({
      id: 'ruta-hecha',
      type: 'line',
      source: 'ruta',
      filter: ['==', ['get', 'hecho'], true],
      layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: { 'line-color': ['get', 'color'], 'line-width': 4.5 },
    });
    m.addLayer({
      id: 'todo-lineas',
      type: 'line',
      source: 'todo',
      layout: { 'line-cap': 'round', 'line-join': 'round', visibility: 'none' },
      paint: { 'line-color': ['get', 'color'], 'line-width': 3.5, 'line-opacity': 0.85 },
    });
    m.addLayer({
      id: 'todo-puntos',
      type: 'circle',
      source: 'todo-puntos',
      layout: { visibility: 'none' },
      paint: {
        'circle-radius': 5,
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
    this.pastillas = [];
    this.posicion.remove();
  }

  /** Vista de un día: su ruta, sus paradas numeradas y la distancia de cada trayecto. */
  mostrarDia(dia: DiaC) {
    this.dia = dia;
    this.clave = '';
    this.limpiarMarcadores();
    this.visibilidad(['todo-lineas', 'todo-puntos'], false);
    this.visibilidad(['ruta-pendiente', 'ruta-hecha-borde', 'ruta-hecha'], true);

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
      el.classList.toggle('origen', grupo.every((p) => p === dia.origen));
      el.classList.toggle('opcional', grupo.every((p) => p.p.opcional));
      el.style.setProperty('--color', dia.color);
      el.setAttribute('aria-label', grupo[0].p.nombre);
      el.innerHTML = numeros.length ? `<span>${numeros.join('·')}</span>` : ICONO_CATEGORIA.hotel;
      el.addEventListener('click', (e) => {
        e.stopPropagation();
        // De las visitas a ese sitio, la que se está haciendo, la siguiente o la última.
        const elegida =
          grupo.find((p) => p.inicio <= this.t && this.t < p.fin) ??
          grupo.find((p) => p.inicio > this.t) ??
          grupo[grupo.length - 1];
        this.eventos.alPulsarParada(elegida);
      });
      const m = new Marker({ element: el }).setLngLat(grupo[0].pos).addTo(this.mapa);
      this.marcadores.push({ m, grupo });
    }

    for (const t of dia.tramos) {
      if (t.nulo) continue;
      const el = document.createElement('div');
      el.className = 'pastilla';
      el.innerHTML = `${TRANSPORTE[t.modo].icono} ${esc(km(t.km))}`;
      const m = new Marker({ element: el }).setLngLat(puntoEnArco(t.arco, 0.5)).addTo(this.mapa);
      this.pastillas.push({ m, t });
    }
    this.ajustarPastillas();
  }

  /** Oculta la distancia de los trayectos que en pantalla son demasiado cortos para que quepa. */
  private ajustarPastillas() {
    for (const { m, t } of this.pastillas) {
      const a = this.mapa.project(t.desde.pos);
      const b = this.mapa.project(t.hasta.pos);
      m.getElement().classList.toggle('oculta', Math.hypot(a.x - b.x, a.y - b.y) < 110);
    }
  }

  /** Vista de todo el viaje con cada día de un color. */
  mostrarTodo() {
    this.dia = null;
    this.limpiarMarcadores();
    this.visibilidad(['ruta-pendiente', 'ruta-hecha-borde', 'ruta-hecha'], false);
    this.visibilidad(['todo-lineas', 'todo-puntos'], true);
    const { dias, paradas } = this.modelo;
    this.fuente('todo')?.setData(
      coleccion(dias.flatMap((d) => d.tramos.filter((t) => !t.nulo).map((t) => linea(t.arco.coords, true, d.color)))),
    );
    this.fuente('todo-puntos')?.setData(
      coleccion(
        paradas.map(
          (p): Punto => ({
            type: 'Feature',
            geometry: { type: 'Point', coordinates: p.pos },
            properties: { id: p.id, color: dias[p.dia].color },
          }),
        ),
      ),
    );
  }

  /** Pinta el estado del día en el instante `t`. */
  actualizar(t: number, momento: Momento) {
    const dia = this.dia;
    if (!dia) return;
    const lineas: Linea[] = [];
    for (const tramo of dia.tramos) {
      if (tramo.nulo) continue;
      if (momento.tramo === tramo) {
        const [hecho, pendiente] = partirArco(tramo.arco, momento.f);
        lineas.push(linea(pendiente, false, dia.color), linea(hecho, true, dia.color));
      } else {
        lineas.push(linea(tramo.arco.coords, tramo.llegada <= t, dia.color));
      }
    }
    // Primero las pendientes para que las recorridas queden por encima.
    lineas.sort((a, b) => Number(a.properties.hecho) - Number(b.properties.hecho));
    this.fuente('ruta')?.setData(coleccion(lineas));

    this.t = t;
    const actual = momento.parada;
    for (const { m, grupo } of this.marcadores) {
      const el = m.getElement();
      const esActual = !!actual && grupo.includes(actual);
      el.classList.toggle('actual', esActual);
      el.classList.toggle('hecha', !esActual && grupo.some((p) => p.inicio <= t));
    }

    if (momento.tipo === 'camino') {
      this.posicion.getElement().style.setProperty('--color', dia.color);
      this.posicion.setLngLat(puntoEnArco(momento.tramo.arco, momento.f)).addTo(this.mapa);
    } else {
      this.posicion.remove();
    }
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
    } else if (cambio && (forzar || !this.visible(momento.parada.pos))) {
      this.centrar(momento.parada.pos);
    }
  }

  /** Centra una parada concreta (al pulsarla en la lista). */
  enfocar(p: ParadaC) {
    this.clave = `p${p.id}`;
    this.centrar(p.pos, Math.max(this.mapa.getZoom(), 14));
  }
}
