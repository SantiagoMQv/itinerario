import '@fontsource-variable/archivo/wdth.css';
import './estilos.css';
import { itinerario } from './datos/itinerario';
import { TRANSPORTE, aMinutos, ahoraEnChina, duracion, esc, fechaCorta, fechaLarga, hora, km } from './formato';
import { distanciaKm } from './geo';
import { type EstadoParada, VistaMapa } from './mapa';
import {
  type DiaC,
  type Momento,
  type ParadaC,
  type SubC,
  type TramoC,
  construirModelo,
  estimarMinutos,
  gastoTotal,
  hotelDe,
  momentoEn,
  trayectosApretados,
} from './modelo';
import { descargaAnterior, descargarMapas, registrarServiceWorker } from './offline';
import type { Enlace, Gasto, Transporte } from './tipos';

const modelo = construirModelo(itinerario);
const ultimoHotel = [...modelo.paradas].reverse().find((p) => p.p.categoria === 'hotel') ?? null;
for (const a of modelo.avisos) console.warn(a);

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const el = {
  barra: $('barra'),
  dias: $('dias'),
  hotel: $<HTMLButtonElement>('btn-hotel'),
  red: $('red'),
  aviso: $('aviso'),
  panel: $('panel'),
  asa: $('asa'),
  cabecera: $('cabecera'),
  reloj: $('hora'),
  cuenta: $('cuenta'),
  ahora: $('ahora'),
  play: $<HTMLButtonElement>('btn-play'),
  repasar: $<HTMLButtonElement>('btn-repasar'),
  anterior: $<HTMLButtonElement>('btn-anterior'),
  siguiente: $<HTMLButtonElement>('btn-siguiente'),
  velocidad: $<HTMLButtonElement>('btn-velocidad'),
  deslizador: $<HTMLInputElement>('deslizador'),
  puntos: $('puntos'),
  tramoAhora: $('tramo-ahora'),
  horaDesde: $('hora-desde'),
  horaHasta: $('hora-hasta'),
  contenido: $('contenido'),
  encuadrar: $<HTMLButtonElement>('btn-encuadrar'),
  offline: $<HTMLButtonElement>('btn-offline'),
  volverAhora: $<HTMLButtonElement>('btn-ahora'),
  seguir: $<HTMLButtonElement>('btn-seguir'),
  pildoras: $('pildoras'),
  irMapa: $<HTMLButtonElement>('btn-mapa'),
  botonesMapa: $('botones-mapa'),
  fichaCorta: $('ficha-corta'),
  fichaCortaContenido: $('ficha-corta-contenido'),
  pista: $('pista'),
  controles: $('controles'),
  tema: $<HTMLButtonElement>('btn-tema'),
  anuncio: $('anuncio'),
  taxi: $('taxi'),
  taxiCerrar: $<HTMLButtonElement>('taxi-cerrar'),
  dialogo: $<HTMLDialogElement>('dialogo'),
  toast: $('toast'),
  toastTexto: $('toast-texto'),
  toastAccion: $<HTMLButtonElement>('toast-accion'),
};

/** Minutos del viaje que pasan por cada segundo de repaso. En las paradas va 4 veces más rápido. */
const VELOCIDADES = [5, 10, 20, 40];
const ACELERACION_EN_PARADA = 4;
/** Cada cuánto avanza el modo en directo. */
const LATIDO_MS = 30_000;

/** Página a un lado en vez de hoja abajo (a la par con estilos.css). */
const pantallaAncha = matchMedia('(min-width: 760px), (min-width: 560px) and (orientation: landscape)');
/** Ancha pero baja: la página se desplaza de una pieza, con la cabecera. */
const panelCorrido = matchMedia(
  '(min-width: 760px) and (max-height: 560px), (min-width: 560px) and (orientation: landscape) and (max-height: 560px)',
);
const reducirMovimiento = matchMedia('(prefers-reduced-motion: reduce)');
const esMovil = () => !pantallaAncha.matches;

const estado = {
  vista: 'dia' as 'dia' | 'todo',
  /**
   * Directo: la hora real y lo que el viajero ha marcado como hecho.
   * Repaso: una hora cualquiera del plan (reproducir, arrastrar, otro día…).
   */
  modo: 'repaso' as 'directo' | 'repaso',
  dia: 0,
  t: 0,
  reproduciendo: false,
  velocidad: 0,
  seguir: true,
  expandido: false,
  /** Parada con la ficha desplegada en la lista (null o -1: ninguna). */
  abierta: null as number | null,
  claveMomento: '',
};

// ---------- Almacenamiento en este móvil ----------

function leer<T>(clave: string, porDefecto: T): T {
  try {
    const v = localStorage.getItem(clave);
    return v === null ? porDefecto : (JSON.parse(v) as T);
  } catch {
    return porDefecto;
  }
}

function guardar(clave: string, valor: unknown) {
  try {
    localStorage.setItem(clave, JSON.stringify(valor));
  } catch {
    // Sin almacenamiento local: el dato solo dura hasta recargar.
  }
}

// ---------- Hoy y marcas del viajero ----------

/** Fecha y minuto actuales en China, y qué día del viaje es (-1 si no es ninguno). */
function hoy() {
  const h = ahoraEnChina();
  // Pasada la medianoche, sigue siendo «hoy» el día de ayer mientras dure su plan (salidas de noche).
  const noche = modelo.dias.findIndex((d) => d.d.fecha < h.fecha && h.min <= d.hasta);
  return { ...h, idx: noche >= 0 ? noche : modelo.dias.findIndex((d) => d.d.fecha === h.fecha) };
}
let hoyIdx = hoy().idx;

/**
 * Lo que el viajero ha dicho de una parada. El horario del plan manda por defecto; las marcas lo
 * corrigen: «hecha» (ya terminada, aunque sea antes de tiempo), «saltada» y «aqui» (estoy aquí:
 * he llegado antes o sigo después de la hora).
 */
type Marca = 'hecha' | 'saltada' | 'aqui';
// Las marcas se guardan por fecha, hora y nombre: siguen valiendo aunque se añadan paradas al plan
// y, si ese día no hay otra parada con el mismo nombre, aunque se cambie su hora.
const CLAVE_MARCAS = 'marcas';
const marcas = leer<Record<string, Marca>>(CLAVE_MARCAS, {});
// Cuándo se marcó en la calle (minutos, hora de China): «Hecha» o «Ya salí» dicen cuándo se salió.
const CLAVE_HORAS = 'marcas-hora';
const horasMarca = leer<Record<string, number>>(CLAVE_HORAS, {});
// Un móvil que nunca ha marcado es el de quien solo mira: sigue el plan sin preguntar.
const CLAVE_MARCADOR = 'marcador';
let marcador = leer<boolean>(CLAVE_MARCADOR, false) || Object.keys(marcas).length > 0;
let versionMarcas = 0;
const claveParada = (p: ParadaC) => `${modelo.dias[p.dia].d.fecha}|${p.p.hora}|${p.p.nombre}`;
const clavesPlan = new Set(modelo.paradas.map(claveParada));

const cacheClaves = new Map<number, string | undefined>();
let versionCache = -1;
/** Clave con la que está guardada la marca de `p` (la suya, o la de antes de cambiarle la hora). */
function claveGuardada(p: ParadaC): string | undefined {
  if (versionCache !== versionMarcas) {
    cacheClaves.clear();
    versionCache = versionMarcas;
  }
  if (cacheClaves.has(p.id)) return cacheClaves.get(p.id);
  const exacta = claveParada(p);
  let clave: string | undefined = exacta in marcas ? exacta : undefined;
  if (!clave && modelo.paradas.filter((q) => q.dia === p.dia && q.p.nombre === p.p.nombre).length === 1) {
    const fecha = modelo.dias[p.dia].d.fecha;
    clave = Object.keys(marcas).find((k) => k.startsWith(`${fecha}|`) && k.endsWith(`|${p.p.nombre}`) && !clavesPlan.has(k));
  }
  cacheClaves.set(p.id, clave);
  return clave;
}
const marcaDe = (p: ParadaC): Marca | undefined => {
  const k = claveGuardada(p);
  return k ? marcas[k] : undefined;
};
const horaMarcaDe = (p: ParadaC): number | undefined => {
  const k = claveGuardada(p);
  return k ? horasMarca[k] : undefined;
};
const cerrada = (p: ParadaC) => marcaDe(p) === 'hecha' || marcaDe(p) === 'saltada';
const NOMBRE_MARCA: Record<Marca, string> = { hecha: 'hecha', saltada: 'saltada', aqui: 'aquí' };

function guardarMarcas() {
  guardar(CLAVE_MARCAS, marcas);
  guardar(CLAVE_HORAS, horasMarca);
  versionMarcas++;
}

/**
 * `enLaCalle`: marcada desde «ahora» (se guarda la hora, que dice cuándo se salió). Desde la ficha es
 * una corrección y no cuenta como salida.
 */
function marcar(p: ParadaC, marca: Marca | null, enLaCalle = false) {
  const antes = { ...marcas };
  const horasAntes = { ...horasMarca };
  const marcadorAntes = marcador;
  // Solo se puede «estar» en un sitio: la que estuviera en «aquí» pasa a hecha.
  if (marca === 'aqui') for (const [k, v] of Object.entries(marcas)) if (v === 'aqui') marcas[k] = 'hecha';
  const vieja = claveGuardada(p);
  if (vieja) {
    delete marcas[vieja];
    delete horasMarca[vieja];
  }
  if (marca) {
    marcas[claveParada(p)] = marca;
    if (enLaCalle) horasMarca[claveParada(p)] = hoy().min;
  }
  guardarMarcas();
  if (!marcador) guardar(CLAVE_MARCADOR, (marcador = true));
  // Tras repintar, el foco no se pierde: vuelve al primer botón de «Ahora».
  const enAhora = el.ahora.contains(document.activeElement);
  pintar(true);
  if (estado.vista === 'todo') pintarResumen();
  if (enAhora) el.ahora.querySelector<HTMLElement>('.mini, .abrir')?.focus();
  const texto = marca === 'aqui' ? `Estás en «${p.p.nombre}»` : `«${p.p.nombre}»: ${marca ? NOMBRE_MARCA[marca] : 'según el plan'}`;
  aviso(texto, 8000, {
    texto: 'Deshacer',
    hacer: () => {
      for (const k of Object.keys(marcas)) delete marcas[k];
      for (const k of Object.keys(horasMarca)) delete horasMarca[k];
      Object.assign(marcas, antes);
      Object.assign(horasMarca, horasAntes);
      guardarMarcas();
      if (marcador !== marcadorAntes) guardar(CLAVE_MARCADOR, (marcador = marcadorAntes));
      pintar(true);
      if (estado.vista === 'todo') pintarResumen();
    },
  });
}

/**
 * El primer toque que marca convierte este móvil en el que lleva el viaje (y empieza a preguntar):
 * se confirma una vez, para que el móvil de quien solo mira no cambie por un toque sin querer.
 */
async function puedeMarcar(): Promise<boolean> {
  if (marcador) return true;
  return preguntar(
    '¿Llevar el viaje en este móvil?',
    'Hasta ahora este móvil sigue el plan en silencio. Si marcas aquí, pasará a llevar el viaje: contará lo que marques y preguntará «¿Sigues en…?» cuando se acabe la hora de un sitio. En el móvil de quien solo mira, mejor no marcar.',
    'Sí, marcar aquí',
    'Cancelar',
  );
}

/** Parada de referencia de «ahora» (en la que se está o hacia la que se va); todo lo anterior va hecho. */
let ancla = -1;
const anclaDe = (m: Momento) => (m.tipo === 'parada' ? m.parada.id : m.tramo.hasta.id);

/**
 * Sello de cada parada. En directo, lo anterior a «ahora» se da por hecho salvo que se haya saltado,
 * y las marcas mandan. En el repaso, la hora del repaso (las saltadas siguen saltadas).
 */
function estadoDe(p: ParadaC): EstadoParada {
  const marca = marcaDe(p);
  if (marca === 'saltada') return 'saltada';
  if (estado.modo === 'directo') {
    if (marca === 'hecha') return 'hecha';
    if (marca === 'aqui') return null;
    return p.id < ancla ? 'hecha' : null;
  }
  return p.inicio <= estado.t ? 'hecha' : null;
}

/** Primera parada después de `p` que no está cerrada (hecha o saltada). */
function siguientePendiente(p: ParadaC): ParadaC | undefined {
  for (let i = p.id + 1; i < modelo.paradas.length; i++) if (!cerrada(modelo.paradas[i])) return modelo.paradas[i];
  return undefined;
}

const deCamino = (tramo: TramoC, t: number, salida: number, llegada: number, tope = 1): Momento => ({
  tipo: 'camino',
  parada: null,
  tramo,
  salida,
  llegada,
  f: Math.min(Math.max((t - salida) / Math.max(llegada - salida, 1), 0), tope),
});

/**
 * Dónde se está de verdad: lo que dice el horario del plan a esta hora, corregido por las marcas.
 * «Aquí» fija la parada; si la del plan ya está hecha o saltada, se va hacia la siguiente pendiente.
 * Si se dijo en la calle cuándo se salió de la anterior, el trayecto cuenta desde entonces: se llega
 * antes (o después) que en el plan.
 */
function momentoDirecto(t: number): Momento {
  const dia = diaActual();
  const aqui = [...(dia.origen ? [dia.origen] : []), ...dia.paradas].find((p) => marcaDe(p) === 'aqui');
  if (aqui) return { tipo: 'parada', parada: aqui, tramo: null };
  const plan = momentoEn(modelo, t);
  const objetivo = plan.tipo === 'parada' ? plan.parada : plan.tramo.hasta;
  const sig = cerrada(objetivo) ? siguientePendiente(objetivo) : objetivo;
  if (!sig || sig.dia !== dia.idx) return { tipo: 'parada', parada: objetivo, tramo: null };
  const tramo = modelo.tramos.find((tr) => tr.hasta === sig);
  if (!tramo || tramo.nulo) return sig === objetivo ? plan : { tipo: 'parada', parada: sig, tramo: null };
  let previa: ParadaC | undefined = modelo.paradas[sig.id - 1];
  while (previa && marcaDe(previa) === 'saltada') previa = modelo.paradas[previa.id - 1];
  const salida = previa && marcaDe(previa) === 'hecha' ? horaMarcaDe(previa) : undefined;
  if (salida !== undefined) {
    const llegada = salida + tramo.minutos;
    return t < llegada ? deCamino(tramo, t, salida, llegada) : { tipo: 'parada', parada: sig, tramo: null };
  }
  if (sig === objetivo) return plan;
  return t < sig.inicio ? deCamino(tramo, t, tramo.salida, tramo.llegada, 0.98) : { tipo: 'parada', parada: sig, tramo: null };
}

const momentoActual = (): Momento => (estado.modo === 'directo' ? momentoDirecto(estado.t) : momentoEn(modelo, estado.t));

/** Fin del día en directo: se está en la última parada del día (normalmente el hotel) y ya es su hora. */
function diaTerminado(m: Momento): boolean {
  if (estado.modo !== 'directo' || m.tipo !== 'parada') return false;
  const ultima = diaActual().paradas[diaActual().paradas.length - 1];
  // Si la última parada tiene hora de salida (el vuelo de vuelta), el día no acaba hasta entonces.
  const acaba = ultima.p.fin ? ultima.fin : ultima.inicio;
  return m.parada === ultima && (estado.t >= acaba || cerrada(ultima));
}

/** Siguiente parada del viaje después de `p` (en directo, saltándose las ya cerradas). */
function siguienteDe(p: ParadaC): ParadaC | undefined {
  return estado.modo === 'directo' ? siguientePendiente(p) : modelo.paradas[p.id + 1];
}

// ---------- Mapa ----------

const vista = new VistaMapa($('mapa'), modelo, {
  alPulsarParada: pulsarParada,
  alPulsarSubparada: pulsarSubparada,
  alPulsarMapa: () => cerrarFichaCorta(),
  alArrastrar: () => {
    estado.seguir = false;
    el.seguir.hidden = estado.vista !== 'dia';
  },
});

const diaActual = (): DiaC => modelo.dias[estado.dia];
const claveDe = (m: Momento) =>
  `${m.tipo === 'camino' ? `t${m.tramo.id}` : `p${m.parada.id}`}|${estado.modo}|${versionMarcas}`;

// ---------- Barra de días ----------

/** Ciudad más repetida del viaje: solo se rotulan en las pestañas los días que salen de ella. */
const ciudadBase = (() => {
  const cuenta = new Map<string, number>();
  for (const d of modelo.dias) if (d.d.ciudad) cuenta.set(d.d.ciudad, (cuenta.get(d.d.ciudad) ?? 0) + 1);
  return [...cuenta].sort((a, b) => b[1] - a[1])[0]?.[0];
})();

function pintarDias() {
  const pestanas = [
    `<button type="button" class="pestana todo${estado.vista === 'todo' ? ' activa' : ''}" data-dia="todo"
      aria-pressed="${estado.vista === 'todo'}"><b>Todo</b></button>`,
    ...modelo.dias.map((d) => {
      const activa = estado.vista === 'dia' && estado.dia === d.idx;
      const ciudad = d.d.ciudad && d.d.ciudad !== ciudadBase ? ` · ${esc(d.d.ciudad)}` : '';
      const esHoy = d.idx === hoyIdx ? ' · hoy' : '';
      return `<button type="button" class="pestana${activa ? ' activa' : ''}" data-dia="${d.idx}"
        aria-pressed="${activa}" style="--color:${d.color}">
        <b>Día ${d.idx + 1}</b><small>${esc(fechaCorta(d.d.fecha))}${ciudad}${esHoy}</small>
      </button>`;
    }),
  ];
  el.dias.innerHTML = pestanas.join('');
  // Que la pestaña activa (o, desde «Todo», la de hoy) quede a la vista sin mover nada más de la
  // página. «Todo» se queda fija a la izquierda y tapa lo que pasa por debajo.
  const activa =
    el.dias.querySelector<HTMLElement>('.activa:not(.todo)') ?? el.dias.querySelector<HTMLElement>(`[data-dia="${hoyIdx}"]`);
  const tapa = el.dias.querySelector<HTMLElement>('.todo')!.offsetWidth + 12;
  if (activa && (activa.offsetLeft < el.dias.scrollLeft + tapa || activa.offsetLeft + activa.offsetWidth > el.dias.scrollLeft + el.dias.clientWidth)) {
    el.dias.scrollLeft = activa.offsetLeft - tapa - 28;
  }
  marcarDesborde();
}

/** Difumina el borde derecho de las pestañas mientras quedan días por ver a la derecha (y separa «Todo» si han pasado por debajo). */
function marcarDesborde() {
  el.dias.classList.toggle('mas', el.dias.scrollLeft + el.dias.clientWidth < el.dias.scrollWidth - 4);
  el.dias.classList.toggle('corrido', el.dias.scrollLeft > 8);
}
el.dias.addEventListener('scroll', marcarDesborde, { passive: true });

el.dias.addEventListener('click', (e) => {
  const b = (e.target as HTMLElement).closest<HTMLButtonElement>('[data-dia]');
  if (!b) return;
  if (b.dataset.dia === 'todo') return verTodo();
  const idx = Number(b.dataset.dia);
  if (idx === hoyIdx) volverAhora();
  else seleccionarDia(idx);
});

// ---------- Cambio de vista y de modo ----------

function seleccionarDia(idx: number, t?: number, encuadrar = true, directo = false) {
  const dia = modelo.dias[idx];
  cerrarFichaCorta();
  if (estado.vista === 'todo') expandir(false);
  pausar();
  estado.vista = 'dia';
  estado.modo = directo ? 'directo' : 'repaso';
  estado.dia = idx;
  // En directo manda la hora real (aunque el plan del día aún no haya empezado o ya haya acabado).
  estado.t = directo ? (t ?? hoy().min) : Math.min(Math.max(t ?? dia.desde, dia.desde), dia.hasta);
  estado.abierta = null;
  estado.claveMomento = '';
  document.body.classList.remove('vista-todo');
  document.documentElement.style.setProperty('--color-dia', dia.color);
  el.seguir.hidden = estado.seguir;
  vista.mostrarDia(dia);
  pintarDias();
  prepararLineaTiempo(dia);
  pintarLista(dia);
  actualizarModo();
  pintar(false);
  if (encuadrar) {
    ajustarMargenes();
    vista.encuadrarDia(dia);
  }
}

function verTodo() {
  pausar();
  cerrarFichaCorta();
  estado.vista = 'todo';
  document.body.classList.add('vista-todo');
  el.hotel.hidden = !ultimoHotel;
  el.seguir.hidden = true;
  vista.mostrarTodo();
  pintarDias();
  pintarResumen();
  actualizarModo();
  // En el móvil, el viaje entero se ve en el mapa: la hoja a media altura, como un día.
  if (esMovil()) animarHoja('media');
  else expandir(true);
  ajustarMargenes();
  vista.encuadrarTodo();
}

/** Vuelve al día de hoy, a la hora real y a lo marcado. */
function volverAhora() {
  const h = hoy();
  hoyIdx = h.idx;
  if (h.idx < 0) return;
  estado.seguir = true;
  seleccionarDia(h.idx, h.min, false, true);
  ajustarMargenes();
  vista.seguir(momentoActual(), true, true);
}
el.volverAhora.addEventListener('click', volverAhora);

/** Cualquier movimiento de la hora (reproducir, arrastrar, saltar) pasa al repaso. */
function entrarRepaso() {
  if (estado.modo === 'repaso') return;
  estado.modo = 'repaso';
  actualizarModo();
}

function actualizarModo() {
  const repaso = estado.modo === 'repaso' || estado.vista === 'todo';
  document.body.classList.toggle('repaso', repaso);
  // En directo la línea del día solo informa: un roce al agarrar la hoja no debe sacar del directo.
  el.deslizador.disabled = !repaso;
  el.volverAhora.hidden = !(repaso && hoyIdx >= 0 && estado.vista === 'dia');
  if (hoyIdx >= 0) {
    el.volverAhora.querySelector('span:last-child')!.textContent = `Volver a ahora · ${hora(hoy().min)}`;
  }
  if (!estado.reproduciendo) el.play.setAttribute('aria-label', estado.modo === 'directo' ? 'Repasar el día' : 'Reproducir el repaso');
}

// Avanza solo cada medio minuto y al volver a la app (una PWA puede pasar horas en segundo plano).
function latido() {
  const h = hoy();
  const cambioDia = h.idx !== hoyIdx;
  hoyIdx = h.idx;
  if (cambioDia) pintarDias();
  if (estado.vista !== 'dia') return actualizarModo();
  if (estado.modo !== 'directo') return actualizarModo();
  if (h.idx < 0) {
    estado.modo = 'repaso';
    actualizarModo();
    return pintar(false);
  }
  if (estado.dia !== h.idx) return volverAhora();
  estado.t = h.min;
  pintar(true);
}
setInterval(latido, LATIDO_MS);
document.addEventListener('visibilitychange', () => document.visibilityState === 'visible' && latido());
addEventListener('pageshow', latido);

// ---------- Línea de tiempo ----------

/**
 * Escala de la línea de tiempo: cada parada a la misma distancia de la siguiente (como en un
 * cuaderno), y el tiempo se reparte de forma lineal dentro de cada tramo. Así las paradas no se
 * amontonan aunque el día dure 16 horas.
 */
let escala: number[] = [];
const RESOLUCION = 1000;

function prepararEscala(dia: DiaC) {
  const marcas = [dia.desde, ...(dia.origen ? [dia.origen.fin] : []), ...dia.paradas.map((p) => p.inicio), dia.hasta];
  escala = [...new Set(marcas.map((m) => Math.min(Math.max(m, dia.desde), dia.hasta)))].sort((a, b) => a - b);
}

/** Posición (0–100 %) de un instante en la línea de tiempo del día. */
function pct(m: number): number {
  const n = escala.length - 1;
  if (n < 1) return 0;
  let i = 0;
  while (i < n - 1 && m > escala[i + 1]) i++;
  const f = Math.min(Math.max((m - escala[i]) / (escala[i + 1] - escala[i]), 0), 1);
  return ((i + f) / n) * 100;
}

/** Instante que corresponde a una posición del deslizador. */
function instanteEn(valor: number): number {
  const n = escala.length - 1;
  if (n < 1) return escala[0] ?? 0;
  const x = (valor / RESOLUCION) * n;
  const i = Math.min(Math.floor(x), n - 1);
  return escala[i] + (x - i) * (escala[i + 1] - escala[i]);
}

function prepararLineaTiempo(dia: DiaC) {
  prepararEscala(dia);
  el.deslizador.min = '0';
  el.deslizador.max = String(RESOLUCION);
  el.horaDesde.textContent = hora(dia.desde);
  el.horaHasta.textContent = hora(dia.hasta);
  // Un punto por parada a su hora de llegada (y la salida del hotel, que no se marca).
  const puntos = [
    ...(dia.origen ? [`<span data-t="${dia.origen.fin}" style="left:${pct(dia.origen.fin)}%"></span>`] : []),
    ...dia.paradas.map((p) => `<span data-id="${p.id}" style="left:${pct(p.inicio)}%"></span>`),
  ];
  el.puntos.innerHTML = puntos.join('');
}

/** Puntos hechos rellenos y el fluorescente sobre lo que pasa ahora (la estancia o el trayecto). */
function pintarLineaTiempo(m: Momento) {
  for (const punto of el.puntos.children as HTMLCollectionOf<HTMLElement>) {
    const id = punto.dataset.id;
    const e = id === undefined ? (Number(punto.dataset.t) <= estado.t ? 'hecha' : null) : estadoDe(modelo.paradas[Number(id)]);
    punto.classList.toggle('pasado', e === 'hecha');
    punto.classList.toggle('saltado', e === 'saltada');
  }
  const [desde, hasta] = m.tipo === 'camino' ? [m.salida, m.llegada] : [m.parada.inicio, m.parada.fin];
  const izquierda = pct(desde);
  el.tramoAhora.style.left = `${izquierda}%`;
  el.tramoAhora.style.width = `${Math.max(pct(hasta) - izquierda, 1.5)}%`;
}

function moverHora(t: number) {
  pausar();
  entrarRepaso();
  const dia = diaActual();
  estado.t = Math.min(Math.max(t, dia.desde), dia.hasta);
  estado.abierta = null;
  pintar(true);
}

el.deslizador.addEventListener('input', () => moverHora(instanteEn(Number(el.deslizador.value))));

// Con teclado, el deslizador va de 5 en 5 minutos (y de media hora con Re Pág / Av Pág).
el.deslizador.addEventListener('keydown', (e) => {
  const pasos: Record<string, number> = { ArrowLeft: -5, ArrowDown: -5, ArrowRight: 5, ArrowUp: 5, PageDown: -30, PageUp: 30 };
  const dia = diaActual();
  if (e.key in pasos) moverHora(estado.t + pasos[e.key]);
  else if (e.key === 'Home') moverHora(dia.desde);
  else if (e.key === 'End') moverHora(dia.hasta);
  else return;
  e.preventDefault();
});

el.siguiente.addEventListener('click', () => {
  const dia = diaActual();
  const proxima = dia.paradas.find((p) => p.inicio > estado.t + 0.5);
  if (proxima) irA(proxima.inicio);
  else if (estado.dia + 1 < modelo.dias.length) seleccionarDia(estado.dia + 1);
});

el.anterior.addEventListener('click', () => {
  const dia = diaActual();
  const previa = [...dia.paradas].reverse().find((p) => p.inicio < estado.t - 0.5);
  if (previa) irA(previa.inicio);
  else if (estado.t > dia.desde + 0.5) irA(dia.desde);
  else if (estado.dia > 0) {
    const anterior = modelo.dias[estado.dia - 1];
    seleccionarDia(estado.dia - 1, anterior.paradas[anterior.paradas.length - 1]?.inicio);
  }
});

function irA(t: number) {
  estado.seguir = true;
  el.seguir.hidden = true;
  moverHora(t);
}

// ---------- Repaso ----------

let ultimoFotograma = 0;

function reproducir() {
  if (estado.vista !== 'dia') return;
  entrarRepaso();
  const dia = diaActual();
  if (estado.t >= dia.hasta - 1) {
    estado.t = dia.desde;
    vista.encuadrarDia(dia);
  }
  estado.reproduciendo = true;
  estado.seguir = true;
  estado.abierta = null;
  el.seguir.hidden = true;
  document.body.classList.add('reproduciendo');
  el.play.setAttribute('aria-label', 'Pausa');
  ultimoFotograma = performance.now();
  requestAnimationFrame(fotograma);
}

function pausar() {
  if (!estado.reproduciendo) return;
  estado.reproduciendo = false;
  document.body.classList.remove('reproduciendo');
  actualizarModo();
}

function fotograma(ahora: number) {
  if (!estado.reproduciendo) return;
  const dt = Math.min(0.1, (ahora - ultimoFotograma) / 1000);
  ultimoFotograma = ahora;
  const enParada = momentoEn(modelo, estado.t).tipo === 'parada';
  estado.t += dt * VELOCIDADES[estado.velocidad] * (enParada ? ACELERACION_EN_PARADA : 1);
  const dia = diaActual();
  if (estado.t >= dia.hasta) {
    if (estado.dia + 1 < modelo.dias.length) {
      seleccionarDia(estado.dia + 1);
      return reproducir();
    }
    estado.t = dia.hasta;
    pausar();
  }
  pintar(true);
  requestAnimationFrame(fotograma);
}

el.play.addEventListener('click', () => (estado.reproduciendo ? pausar() : reproducir()));
// En directo los controles del repaso se esconden; este botón (o arrastrar la tira) los saca.
el.repasar.addEventListener('click', () => {
  entrarRepaso();
  pintar(false);
  el.play.focus();
});

el.velocidad.addEventListener('click', () => {
  estado.velocidad = (estado.velocidad + 1) % VELOCIDADES.length;
  const texto = `×${2 ** estado.velocidad}`;
  el.velocidad.textContent = texto;
  el.velocidad.setAttribute('aria-label', `Velocidad del repaso: ${texto}`);
  aviso(`Repaso a ${texto}`, 1500);
});

// ---------- Pintado del instante actual ----------

function pintar(moverCamara: boolean) {
  if (estado.vista !== 'dia') return;
  const t = estado.t;
  const momento = momentoActual();
  ancla = anclaDe(momento);
  vista.actualizar(t, momento, estadoDe);
  if (estado.seguir) vista.seguir(momento, moverCamara);
  el.deslizador.value = String(Math.round((pct(t) / 100) * RESOLUCION));
  el.deslizador.setAttribute('aria-valuetext', hora(t));
  pintarReloj(momento);
  pintarLineaTiempo(momento);
  // Ya fuera del último hotel del viaje (de camino al aeropuerto), «Hotel» no lleva a ninguna parte.
  el.hotel.hidden = !ultimoHotel || ancla > ultimoHotel.id;

  // En directo, «ahora» y «después» cambian también con la hora (preguntas, ir tarde): cada 5 min.
  const clave = `${claveDe(momento)}|${estado.modo === 'directo' ? Math.floor(t / 5) : ''}`;
  if (clave !== estado.claveMomento) {
    const deNuevo = !estado.claveMomento;
    estado.claveMomento = clave;
    pintarAhora(momento);
    // El repintado de cada 5 min no mueve la lista (se puede estar leyendo); cuando cambia lo de
    // ahora, la lista lo sigue solo si lo de antes estaba a la vista.
    const ahora = claveDe(momento);
    marcarLista(momento, deNuevo ? 'si' : ahora === claveListaAhora ? 'no' : 'si-se-veia');
    claveListaAhora = ahora;
    // Se anuncia al cambiar lo de ahora, no cada vez que avanza la cuenta atrás.
    const anuncio = claveDe(momento);
    if (!estado.reproduciendo && anuncio !== ultimoAnuncio) {
      ultimoAnuncio = anuncio;
      anunciar();
    }
  }
}
let ultimoAnuncio = '';
let claveListaAhora = '';

/** Texto de un bloque para leerlo en voz alta: sin el chino, que una voz en castellano destroza. */
function textoParaLeer(e: HTMLElement): string {
  const copia = e.cloneNode(true) as HTMLElement;
  for (const n of copia.querySelectorAll('[lang="zh-Hans"]')) n.remove();
  return (copia.textContent ?? '').replace(/\s+/g, ' ').replace(/\(\s*\)/g, '').trim();
}

/** Para lectores de pantalla: la cuenta atrás y lo de ahora y después (sin los botones). */
function anunciar() {
  const bloques = [...el.ahora.querySelectorAll<HTMLElement>('.pregunta p, .abrir, .bloque.fin, .recuperar')].map(textoParaLeer);
  const cuenta = el.cuenta.cloneNode(true) as HTMLElement;
  cuenta.querySelector('.lugar')?.remove();
  el.anuncio.textContent = [`${el.reloj.textContent} ${cuenta.textContent}`, ...bloques].join('. ');
}

/** «39 min», «1 h 05», «+12 min». */
function cuantoQueda(min: number): string {
  const m = Math.round(Math.abs(min));
  const texto = m < 60 ? `${m} min` : `${Math.floor(m / 60)} h ${String(m % 60).padStart(2, '0')}`;
  return min < 0 ? `+${texto}` : texto;
}

const otroDia = (a: number, b: number) => Math.floor(a / 1440) !== Math.floor(b / 1440);

/**
 * En directo, lo grande es lo que hay que hacer: cuánto queda para salir o para llegar (la hora ya
 * la da el móvil). En el repaso, la hora del plan, en contorno para no confundirla con la real.
 */
function pintarReloj(m: Momento) {
  let grande: string;
  let detalle: string;
  let tarde = false;
  /** De dónde se sale o adónde se llega: solo se ve con la hoja baja, donde no asoma nada más. */
  let lugar = '';
  if (estado.modo === 'repaso') {
    grande = hora(estado.t);
    const h = hoy();
    const faltan = Math.round((aMinutos(modelo.dias[0].d.fecha, '00:00') - aMinutos(h.fecha, '00:00')) / 1440);
    detalle =
      h.idx >= 0 ? 'Repaso del plan' : faltan > 0 ? `Repaso · falta${faltan === 1 ? '' : 'n'} ${faltan} día${faltan === 1 ? '' : 's'}` : 'Repaso del viaje';
    el.cuenta.textContent = detalle;
  } else if (diaTerminado(m) && !siguienteDe(m.parada!)) {
    // Último día, ya en el avión: un final, no una cuenta atrás.
    grande = 'Buen viaje';
    el.cuenta.textContent = `de vuelta · ${modelo.dias.length} días, ${resumenParadas(modelo.paradas)}`;
  } else if (diaTerminado(m) && siguienteDe(m.parada!)!.dia !== m.parada!.dia) {
    // En el hotel por la noche: a qué hora se sale mañana (la hora en grande, que es lo que se recuerda).
    const sig = siguienteDe(m.parada!)!;
    const salida = modelo.tramos.find((tr) => tr.hasta === sig)?.salida ?? sig.inicio;
    grande = hora(salida);
    el.cuenta.textContent = `salida ${otroDia(salida, estado.t) ? 'mañana' : 'hoy'} · en ${cuantoQueda(salida - estado.t)}`;
    lugar = `hacia ${corto(sig)}`;
  } else {
    let objetivo: number;
    let accion: string;
    let estimada = false;
    if (diaTerminado(m)) {
      const sig = siguienteDe(m.parada!)!;
      [objetivo, accion] = [modelo.tramos.find((tr) => tr.hasta === sig)?.salida ?? sig.inicio, 'salir'];
      lugar = `hacia ${corto(sig)}`;
    } else if (m.tipo === 'camino') {
      [objetivo, accion] = [m.llegada, 'llegar'];
      estimada = m.llegada !== m.tramo.llegada;
      lugar = con('a', corto(m.tramo.hasta));
    } else {
      [objetivo, accion] = [m.parada.fin, 'salir'];
      lugar = con('de', corto(m.parada));
    }
    const resta = objetivo - estado.t;
    tarde = resta < 0;
    const cuando = `${otroDia(objetivo, estado.t) ? 'mañana ' : ''}${estimada ? '~' : ''}${hora(objetivo)}`;
    grande = cuantoQueda(resta);
    el.cuenta.innerHTML = tarde
      ? `<span class="tarde-etiqueta">Tarde</span> ${accion === 'salir' ? 'salida' : 'llegada'} prevista ${esc(cuando)}`
      : `para ${accion} · ${esc(cuando)}`;
  }
  // En el móvil de quien solo mira, «ahora» es el del plan: dicho, una diferencia con el otro móvil se entiende.
  if (lugar && !marcador) el.cuenta.insertAdjacentHTML('beforeend', '<span class="segun"> · según el plan</span>');
  if (lugar) el.cuenta.insertAdjacentHTML('beforeend', `<span class="lugar">${esc(lugar)}</span>`);
  el.reloj.textContent = grande;
  el.reloj.classList.toggle('largo', grande.length > 6);
  el.reloj.classList.toggle('tarde', tarde);
}

/** Parada que el plan acaba de dejar atrás sin que el viajero lo haya confirmado (para preguntar). */
function previaSinConfirmar(m: Momento): ParadaC | null {
  if (!marcador) return null;
  const plan = momentoEn(modelo, estado.t);
  const previa = plan.tipo === 'camino' ? plan.tramo.desde : modelo.paradas[plan.parada.id - 1];
  if (!previa || marcaDe(previa) || anclaDe(m) === previa.id) return null;
  const desde = estado.t - previa.fin;
  return desde >= 0 && desde <= 20 ? previa : null;
}

/** «Ahora» y «Después» a la derecha del margen. */
function pintarAhora(m: Momento) {
  const directo = estado.modo === 'directo';
  const dia = diaActual();
  // Con la pregunta abierta, «ahora» queda como contexto: un solo par de botones a la vez.
  const previa = directo ? previaSinConfirmar(m) : null;
  let ahora: string;
  let despues: ParadaC | undefined;
  let recuperar = '';
  let saltarlaPrimero = false;
  let taxiPrimero = false;
  if (diaTerminado(m)) {
    const visitas = dia.paradas.filter((p) => p.n !== null);
    const resumen = `día terminado · ${resumenParadas(visitas)}`;
    ahora = bloqueAhora(m.parada!, m.parada!.p.nombre, '', resumen, '', m.parada!.p.local);
    despues = siguienteDe(m.parada!);
  } else if (m.tipo === 'camino') {
    const tr = m.tramo;
    const q = tr.hasta;
    despues = siguienteDe(q);
    const acciones = (directo && !previa ? botonMarca(q, 'aqui') : '') + botonChino(q, tr);
    const llegada =
      Math.abs(m.llegada - tr.llegada) >= 5 ? `llegas ~${hora(m.llegada)} (plan ${hora(tr.llegada)})` : `llegada ${hora(tr.llegada)}`;
    ahora = bloqueAhora(q, q.p.nombre, `De camino · ${comoSeLlega(tr)}`, llegada, acciones, q.p.local);
  } else {
    const p = m.parada;
    despues = siguienteDe(p);
    const antes = !directo && estado.t < p.inicio;
    const esOrigen = p === dia.origen;
    const tarde = directo && estado.t > p.fin;
    const cuando = antes ? `desde ${hora(p.inicio)}` : tarde ? 'Ya es hora de salir' : esOrigen ? `salida ${hora(p.fin)}` : `hasta ${hora(p.fin)}`;
    // El vuelo de vuelta no se salta.
    const ultimaDelViaje = p.id === modelo.paradas.length - 1;
    const acciones =
      directo && !esOrigen && !previa ? botonMarca(p, 'hecha') + (ultimaDelViaje ? '' : botonMarca(p, 'saltada')) : '';
    ahora = bloqueAhora(p, p.p.nombre, '', cuando, acciones, p.p.local);
    // Se va tarde: cuándo se llegaría a lo siguiente saliendo ya y cuánto se podría estar allí. Si
    // el plan va a pie o en transporte público y un taxi gana tiempo, se dice; si solo en taxi da
    // tiempo, el taxi va primero; si ni así, saltárselo pasa a ser lo primero.
    if (directo && despues && estado.t > p.fin + 5) {
      const tramo = modelo.tramos.find((tr) => tr.hasta === despues);
      const llegaria = estado.t + (tramo?.minutos ?? 0);
      if (llegaria > despues.inicio) {
        const esHotel = despues.p.categoria === 'hotel';
        const conTaxi = tramo && !tramo.nulo && TAXI_ACORTA.includes(tramo.modo) ? estado.t + estimarMinutos('taxi', tramo.km) : null;
        const taxi = conTaxi !== null && conTaxi <= llegaria - 5 ? conTaxi : null;
        const cabe = (t: number) => esHotel || despues!.fin - t >= 10;
        const quedan = (t: number) => (esHotel ? '' : ` y te quedan ${duracion(despues!.fin - t)} allí`);
        if (cabe(llegaria)) {
          recuperar = `<p class="recuperar">Saliendo ya llegas a las <b>${hora(llegaria)}</b> (plan ${hora(despues.inicio)})${quedan(llegaria)}.${
            taxi !== null ? ` En taxi, ~${hora(taxi)}.` : ''
          }</p>`;
        } else if (taxi !== null && cabe(taxi)) {
          taxiPrimero = true;
          recuperar = `<p class="recuperar">Como en el plan llegarías a las ${hora(llegaria)}. <b>En taxi, ~${hora(taxi)}</b>${quedan(taxi)}.</p>`;
        } else {
          saltarlaPrimero = true;
          recuperar = `<p class="recuperar"><b>No da tiempo:</b> llegarías a las ${hora(llegaria)}${
            taxi !== null ? ` (en taxi, ~${hora(taxi)})` : ''
          } y acaba a las ${hora(despues.fin)}.</p>`;
        }
      }
    }
  }
  const pregunta = previa
    ? `<div class="pregunta"><p>¿Sigues en ${esc(previa.p.nombre)}?</p><div class="acciones-bloque">
        <button type="button" class="mini tinta" data-marcar="aqui" data-id="${previa.id}">Sigo aquí</button>
        <button type="button" class="mini" data-marcar="hecha" data-id="${previa.id}">Ya salí</button></div></div>`
    : '';
  const html = `${pregunta}${ahora}<hr />${bloqueDespues(despues, recuperar, saltarlaPrimero, taxiPrimero)}`;
  // Igual que estaba: no se toca (ni se pierde el foco ni lo que se esté leyendo).
  if (html === ultimoAhora) return;
  ultimoAhora = html;
  // Si el foco estaba en un botón de «Ahora», vuelve al mismo botón (o, si ya no está, a «Ahora»).
  const foco = document.activeElement instanceof HTMLElement && el.ahora.contains(document.activeElement) ? document.activeElement : null;
  const huella = (b: Element) => ['data-marcar', 'data-id', 'data-taxi', 'data-abrir'].map((a) => b.getAttribute(a)).join('|');
  const buscada = foco ? huella(foco) : '';
  el.ahora.innerHTML = html;
  if (foco) ([...el.ahora.querySelectorAll<HTMLElement>('button')].find((b) => huella(b) === buscada) ?? el.ahora).focus();
}
let ultimoAhora = '';

/** «8 de 8 paradas», «6 de 8 paradas (2 saltadas)»: lo hecho según el plan menos lo saltado. */
function resumenParadas(lista: ParadaC[]): string {
  const visitas = lista.filter((p) => p.n !== null);
  const saltadas = visitas.filter((p) => marcaDe(p) === 'saltada').length;
  return `${visitas.length - saltadas} de ${paradas(visitas.length)}${saltadas ? ` (${saltadas} saltada${saltadas === 1 ? '' : 's'})` : ''}`;
}

const segmentador = 'Segmenter' in Intl ? new Intl.Segmenter('zh', { granularity: 'word' }) : null;
const esHan = (t: string) => /^\p{Script=Han}+$/u.test(t);
/** El chino, partido solo entre palabras (nunca «外/滩»). */
const chino = (texto?: string) => (texto ? `<span lang="zh-Hans">${enTrozos(texto)}</span>` : '');

function comoSeLlega(t: TramoC): string {
  return t.nulo ? TRANSPORTE[t.modo] : `${TRANSPORTE[t.modo]} · ${km(t.km)} · ${t.estimado ? '~' : ''}${duracion(t.minutos)}`;
}

function bloqueAhora(p: ParadaC, titulo: string, detalle: string, cuando: string, acciones: string, local?: string): string {
  return `<div class="bloque">
    <button type="button" class="abrir" data-abrir="${p.id}">
      <span class="sr">Ahora: </span>
      <span class="titulo"><mark>${esc(titulo)}</mark></span>
      ${local ? `<span class="detalle-ahora">${chino(local)}</span>` : ''}
      ${detalle ? `<span class="detalle-ahora">${esc(detalle)}</span>` : ''}
      <span class="hasta">${esc(cuando)}</span>
      ${lineaSubs(p)}
    </button>
    ${acciones ? `<div class="acciones-bloque">${acciones}</div>` : ''}
  </div>`;
}

/**
 * «Aquí: No. 1 Department Store, First Food Store · +1 si da tiempo»: los sitios de dentro, a un
 * toque de su ficha.
 */
function lineaSubs(p: ParadaC): string {
  if (!p.subs.length || p === diaActual().origen) return '';
  const seguras = p.subs.filter((x) => !x.s.opcional).map((x) => x.s.nombre);
  const opcionales = p.subs.filter((x) => x.s.opcional).map((x) => x.s.nombre);
  const texto = seguras.length
    ? `<b>Aquí:</b> ${esc(seguras.join(', '))}${opcionales.length ? ` · +${opcionales.length} si da tiempo` : ''}`
    : `<b>Si da tiempo:</b> ${esc(opcionales.join(', '))}`;
  return `<span class="subs-ahora">${texto}</span>`;
}

function bloqueDespues(q: ParadaC | undefined, recuperar = '', saltarlaPrimero = false, taxiPrimero = false): string {
  if (!q) {
    return `<div class="bloque fin"><span class="titulo">Fin del viaje</span>
      <span class="detalle-ahora">${esc(modelo.titulo)} · ${modelo.dias.length} días</span></div>`;
  }
  const dia = diaActual();
  const cuando = q.dia === dia.idx ? hora(q.inicio) : `${fechaCorta(modelo.dias[q.dia].d.fecha)} ${hora(q.inicio)}`;
  const tramo = modelo.tramos.find((t) => t.hasta === q);
  const pie = tramo ? comoSeLlega(tramo) : '';
  // «Saltar el Bund» (lo siguiente, con su nombre) no se confunde con «Saltar» (lo de ahora).
  const saltar = recuperar ? botonSaltarla(q, saltarlaPrimero) : '';
  const chinoOTaxi = botonChino(q, tramo, taxiPrimero);
  const acciones = saltarlaPrimero ? `${saltar}${chinoOTaxi}` : `${chinoOTaxi}${saltar}`;
  return `<div class="bloque siguiente">
    <button type="button" class="abrir" data-abrir="${q.id}">
      <span class="sr">Después: </span>
      <span class="titulo"><span class="cuando">${esc(cuando)}</span> ${esc(q.p.nombre)}</span>
      ${pie ? `<span class="detalle-ahora">${esc(pie)}</span>` : ''}
    </button>
    ${recuperar}
    <div class="acciones-bloque">${acciones}${precioCorto(q)}</div>
  </div>`;
}

/**
 * Saltar lo siguiente, con su nombre corto («Saltar el Bund»). Nunca en tinta: en la cabecera solo hay
 * un botón en tinta a la vez (el de lo de ahora); si no da tiempo, va primero y con contorno.
 */
function botonSaltarla(q: ParadaC, principal: boolean): string {
  return `<button type="button" class="mini${principal ? '' : ' suave'}" data-marcar="saltada" data-id="${q.id}"
    aria-label="${esc(`Saltar ${q.p.nombre}`)}">Saltar ${esc(corto(q))}</button>`;
}

/** Medios a los que un taxi puede ganar tiempo dentro de la ciudad. */
const TAXI_ACORTA: Transporte[] = ['a_pie', 'metro', 'bus', 'bici'];

/** «el Bund», «Joy City»: el nombre corto de una parada (el suyo, o lo de antes de «:» o «(»). */
function corto(p: ParadaC): string {
  if (p.p.corto) return p.p.corto;
  const nombre = p.p.nombre.split(/:|\s\(/)[0].trim();
  if (nombre.length <= 24) return nombre;
  let r = '';
  for (const w of nombre.split(' ')) {
    if (`${r} ${w}`.trim().length > 22) break;
    r = `${r} ${w}`.trim();
  }
  return `${r}…`;
}

/** «a» + «el Bund» → «al Bund»; «de» + «el museo» → «del museo». */
const con = (prep: 'a' | 'de', nombre: string) =>
  nombre.startsWith('el ') ? `${prep === 'a' ? 'al' : 'del'} ${nombre.slice(3)}` : `${prep} ${nombre}`;

const ICONO_TAXI = `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 16V11l2-5h10l2 5v5M3.5 11h17M5 16h14v2.5H5zM7.5 13.5h.01M16.5 13.5h.01" /></svg>`;
const ICONO_CHINO = `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 5h16v11H9l-5 4zM8 9h8M12 9v4" /></svg>`;

/**
 * Enseñar el destino en chino. Si se va en taxi (o no se sabe), «Taxi»; si se va en tren, metro o a
 * pie, «En chino» (para preguntar a alguien), que abre la misma tarjeta.
 */
function botonChino(p: ParadaC, tramo?: TramoC, enTaxi = false): string {
  if (!p.p.local) return '';
  const taxi = enTaxi || !tramo || tramo.modo === 'taxi';
  const etiqueta = taxi ? `Taxi a ${p.p.nombre}: enseñar al taxista` : `Preguntar cómo llegar a ${p.p.nombre}: enseñar en chino`;
  return `<button type="button" class="mini" data-taxi="${p.id}"${taxi ? '' : ' data-pie'} aria-label="${esc(etiqueta)}">${
    taxi ? ICONO_TAXI : ICONO_CHINO
  }${taxi ? 'Taxi' : 'En chino'}</button>`;
}

const ICONO_HECHO = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12.5l4.5 4.5L19 7.5" /></svg>';

/**
 * Botones de la calle: el principal (Hecha / Llegué) siempre el primero. En tinta solo en el móvil
 * que marca; en el de quien solo mira, en contorno, para que no sea lo que más llama.
 */
function botonMarca(p: ParadaC, marca: Marca): string {
  const t = { hecha: 'Hecha', saltada: 'Saltar', aqui: 'Llegué' }[marca];
  const principal = marca !== 'saltada';
  const clase = principal ? (marcador ? 'tinta' : '') : 'suave';
  return `<button type="button" class="mini ${clase}" data-marcar="${marca}" data-id="${p.id}"
    aria-label="${esc(`${t}: ${p.p.nombre}`)}">${principal ? ICONO_HECHO : ''}${esc(t)}</button>`;
}

let enfriarHasta = 0;
el.ahora.addEventListener('click', (e) => {
  const objetivo = e.target as HTMLElement;
  const taxi = objetivo.closest<HTMLElement>('[data-taxi]');
  if (taxi) return mostrarTaxi(modelo.paradas[Number(taxi.dataset.taxi)].p, taxi, !('pie' in taxi.dataset));
  // Tras marcar, «ahora» cambia y otro botón aparece bajo el dedo: un segundo toque rápido no cuenta.
  if (performance.now() < enfriarHasta) return;
  const marca = objetivo.closest<HTMLElement>('[data-marcar]');
  if (marca) {
    enfriarHasta = performance.now() + 700;
    el.ahora.classList.add('enfriando');
    setTimeout(() => el.ahora.classList.remove('enfriando'), 700);
    const p = modelo.paradas[Number(marca.dataset.id)];
    return void puedeMarcar().then((si) => si && marcar(p, marca.dataset.marcar as Marca, true));
  }
  const b = objetivo.closest<HTMLElement>('[data-abrir]');
  if (b) abrirFicha(modelo.paradas[Number(b.dataset.abrir)]);
});

/** Despliega la ficha de una parada en la lista sin mover la hora. */
function abrirFicha(p: ParadaC) {
  if (p.dia !== estado.dia && p !== diaActual().origen) {
    if (p.dia === hoyIdx) volverAhora();
    else seleccionarDia(p.dia, p.inicio, false);
  }
  expandir(true);
  estado.abierta = p.id;
  marcarLista(momentoActual());
  requestAnimationFrame(() => mostrarFila(el.contenido.querySelector(`li.parada[data-id="${p.id}"]`)));
}

// ---------- Lista del día ----------

const parrafos = (texto: string, clase: string) =>
  texto
    .split('\n')
    .filter((l) => l.trim())
    .map((l) => `<p class="${clase}">${esc(l)}</p>`)
    .join('');

/** "20–40 ¥ (≈3–5 €)", o "gratis". */
function yuanes(min: number, max = min, conEuros = true): string {
  if (max === 0) return 'gratis';
  const texto = min === max ? `${min} ¥` : `${min}–${max} ¥`;
  const cambio = modelo.yuanesPorEuro;
  if (!conEuros || !cambio) return texto;
  const e = (v: number) => Math.round(v / cambio);
  return `${texto} (≈${min === max ? e(min) : `${e(min)}–${e(max)}`} €)`;
}

function gastosHtml(gastos: Gasto[] = []): string {
  if (!gastos.length) return '';
  const filas = gastos.map((g) => `<li><b>${esc(yuanes(g.min, g.max))}</b> ${esc(g.concepto)}</li>`).join('');
  return `<div class="gastos"><span>Por persona</span><ul>${filas}</ul></div>`;
}

const enlacesHtml = (enlaces: Enlace[] = []) =>
  enlaces.map((e) => `<a class="enlace" href="${esc(e.url)}" target="_blank" rel="noopener">${esc(e.texto)}</a>`).join('');

/** Amap a la vista (funciona en China); Apple Maps y Google Maps, a un toque más. */
function enlacesMapas(p: ParadaC): string {
  const [lng, lat] = p.pos;
  const nombre = encodeURIComponent(p.p.local ?? p.p.nombre);
  return `
    <a class="boton" href="https://uri.amap.com/marker?position=${lng},${lat}&name=${nombre}&coordinate=wgs84&callnative=1" target="_blank" rel="noopener">Amap</a>
    <button type="button" class="boton" data-mas-mapas>Más mapas</button>
    <a class="boton" hidden href="https://maps.apple.com/?ll=${lat},${lng}&q=${encodeURIComponent(p.p.nombre)}" target="_blank" rel="noopener">Apple Maps</a>
    <a class="boton" hidden href="https://www.google.com/maps/search/?api=1&query=${lat},${lng}" target="_blank" rel="noopener">Google Maps</a>`;
}

/** Hecha / saltada / según el plan, para corregir lo marcado (también días pasados o futuros). */
function selectorMarca(p: ParadaC): string {
  const opciones: [Marca | 'pendiente', string][] = [
    ['hecha', 'Hecha'],
    ['saltada', 'Saltada'],
    ['pendiente', 'Según el plan'],
  ];
  return `<div class="marcas" role="group" aria-label="Estado de la parada">${opciones
    .map(([v, t]) => `<button type="button" class="boton" data-fijar="${v}" data-id="${p.id}" aria-pressed="false">${ICONO_HECHO}${t}</button>`)
    .join('')}</div>`;
}

function filaParada(p: ParadaC, esOrigen: boolean): string {
  const q = p.p;
  const hotel = hotelDe(modelo, p);
  const aHotel = hotel && q.categoria !== 'hotel' ? distanciaKm(p.pos, hotel.pos) : null;
  const datos: [string, string][] = [];
  if (!esOrigen) datos.push(['Horario', `${hora(p.inicio)} – ${hora(p.fin)} (${duracion(p.fin - p.inicio)})`]);
  if (aHotel !== null) datos.push(['Hotel', `a ${km(aHotel)} en línea recta`]);
  if (q.direccion) datos.push(['Dirección', esc(q.direccion)]);
  if (q.direccionLocal) datos.push(['地址', chino(q.direccionLocal)]);
  if (q.reserva) datos.push(['Reserva', esc(q.reserva)]);
  const clases = ['parada', esOrigen && 'origen', q.opcional && 'opcional', q.categoria === 'hotel' && 'hotel'];
  return `
    <li class="${clases.filter(Boolean).join(' ')}" data-id="${p.id}">
      <button class="fila" type="button" aria-expanded="false">
        <span class="marca"><span>${p.n ?? 'H'}</span></span>
        <span class="hora-fila">${esOrigen ? '' : hora(p.inicio)}</span>
        <span class="texto">
          <span class="nombre">${esc(q.nombre)}</span>${q.local ? ` <span class="local">(${chino(q.local)})</span>` : ''}
          ${q.opcional ? '<span class="opcional-etiqueta">opcional</span>' : ''}
          ${esOrigen ? `<span class="salida">Salida ${hora(p.fin)}</span>` : ''}
        </span>
        ${esOrigen ? '' : precioCorto(p)}
      </button>
      <div class="detalle">
        ${q.notas && !esOrigen ? parrafos(q.notas, 'notas') : ''}
        ${esOrigen ? '' : subparadasHtml(p)}
        ${datos.length ? `<dl>${datos.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${k === 'Horario' || k === 'Hotel' ? esc(v) : v}</dd>`).join('')}</dl>` : ''}
        ${esOrigen ? '' : gastosHtml(q.gastos)}
        ${q.enlaces?.length && !esOrigen ? `<p class="enlaces">${enlacesHtml(q.enlaces)}</p>` : ''}
        ${esOrigen ? '' : selectorMarca(p)}
        <div class="acciones">
          ${q.local ? botonEnsenar(p) : ''}
          ${enlacesMapas(p)}
        </div>
      </div>
    </li>`;
}

/** En la ficha: al taxista si se llega en taxi; si se llega a pie, en metro o en tren, en chino para preguntar. */
function botonEnsenar(p: ParadaC): string {
  const tramo = modelo.tramos.find((t) => t.hasta === p);
  const taxi = !tramo || tramo.modo === 'taxi';
  return taxi
    ? `<button type="button" class="boton tinta" data-taxi="${p.id}">${ICONO_TAXI}Enseñar al taxista</button>`
    : `<button type="button" class="boton tinta" data-taxi="${p.id}" data-pie>${ICONO_CHINO}Enseñar en chino</button>`;
}

/** Los sitios de dentro de una parada, en dos grupos: «Aquí» (seguros) y «Si da tiempo». */
function subparadasHtml(p: ParadaC): string {
  if (!p.subs.length) return '';
  const fila = (x: SubC) => {
    const id = `sub-${p.id}-${x.i}`;
    const enChino = x.s.local || x.s.direccionLocal;
    return `
    <li class="sub${x.s.opcional ? ' opcional' : ''}" data-sub="${x.i}">
      <button type="button" class="sub-fila" aria-expanded="false" aria-controls="${id}">
        <span class="sub-marca" aria-hidden="true">${x.letra}</span>
        <span class="sub-nombre">${esc(x.s.nombre)}</span>
        ${ICONO_PLEGAR}
      </button>
      <div class="sub-detalle" id="${id}" hidden>
        ${x.s.local ? `<p class="local">${chino(x.s.local)}</p>` : ''}
        ${x.s.notas ? `<p class="sub-nota">${esc(x.s.notas)}</p>` : ''}
        <div class="acciones-bloque">
          ${
            x.pos
              ? `<button type="button" class="mini" data-ver-sub="${p.id}:${x.i}">${ICONO_MAPA}Ver en el mapa</button>`
              : '<span class="sub-aqui">En la misma parada</span>'
          }
          ${
            enChino
              ? `<button type="button" class="mini" data-chino-sub="${p.id}:${x.i}" aria-label="${esc(`Enseñar «${x.s.nombre}» en chino`)}">${ICONO_CHINO}En chino</button>`
              : ''
          }
        </div>
      </div>
    </li>`;
  };
  const seguras = p.subs.filter((x) => !x.s.opcional);
  const opcionales = p.subs.filter((x) => x.s.opcional);
  const idOpcionales = `subs-opcionales-${p.id}`;
  // Los seguros, un nombre por línea; los de «si da tiempo», plegados en una sola línea con sus nombres.
  return `<div class="subparadas">
    ${seguras.length ? `<p class="subs-titulo">Aquí</p><ol class="subs">${seguras.map(fila).join('')}</ol>` : ''}
    ${
      opcionales.length
        ? `<button type="button" class="subs-grupo" aria-expanded="false" aria-controls="${idOpcionales}">
            <span class="subs-titulo">Si da tiempo</span>
            <span class="subs-resumen">${esc(opcionales.map((x) => x.s.nombre).join(', '))}</span>
            ${ICONO_PLEGAR}
          </button>
          <ol class="subs" id="${idOpcionales}" hidden>${opcionales.map(fila).join('')}</ol>`
        : ''
    }
  </div>`;
}

const ICONO_PLEGAR = `<svg class="plegar" viewBox="0 0 24 24" aria-hidden="true"><path d="M9 6l6 6-6 6" /></svg>`;
const ICONO_MAPA = `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 4.5 3.5 6.8v12.7L9 17.2l6 2.3 5.5-2.3V4.5L15 6.8zM9 4.5v12.7M15 6.8v12.7" /></svg>`;

/** Abre o cierra lo que controla un botón plegable (una subparada o el grupo «Si da tiempo»). */
function plegar(boton: HTMLElement, abrir = boton.getAttribute('aria-expanded') !== 'true') {
  boton.setAttribute('aria-expanded', String(abrir));
  const panel = document.getElementById(boton.getAttribute('aria-controls') ?? '');
  if (panel) panel.hidden = !abrir;
}

/** Despliega una subparada de la lista (y su grupo, si es de «si da tiempo»). */
function desplegarSub(li: HTMLElement) {
  const grupo = li.closest<HTMLElement>('ol.subs');
  const botonGrupo = grupo?.id ? el.contenido.querySelector<HTMLElement>(`[aria-controls="${grupo.id}"]`) : null;
  if (botonGrupo) plegar(botonGrupo, true);
  const boton = li.querySelector<HTMLElement>('.sub-fila');
  if (boton) plegar(boton, true);
}

/** Etiqueta con el gasto de la parada. */
function precioCorto(p: ParadaC): string {
  if (!p.p.gastos?.length) return '';
  const [min, max] = gastoTotal([p]);
  return `<span class="precio">${esc(yuanes(min, max, false))}</span>`;
}

const apretados = new Set(trayectosApretados(modelo));
/** «solo hay 10 min para ~20 min»: el plan deja menos tiempo del que se tarda. */
const textoApretado = (t: TramoC) => `solo hay ${duracion(t.llegada - t.salida)} para ${t.estimado ? '~' : ''}${duracion(t.minutos)}`;

function filaTramo(t: TramoC): string {
  return `
    <li class="tramo" data-tramo="${t.id}">
      <span><span class="via">${esc(comoSeLlega(t))}</span>${
        apretados.has(t) ? `<small class="apretado">No da tiempo: ${esc(textoApretado(t))}</small>` : ''
      }${t.detalle ? `<small>${esc(t.detalle)}</small>` : ''}</span>
    </li>`;
}

const paradas = (n: number) => `${n} parada${n === 1 ? '' : 's'}`;

function lineaGasto(lista: ParadaC[]): string {
  const [min, max] = gastoTotal(lista);
  if (!max) return '';
  return `<p class="cifras">Gasto previsto: <b>${esc(yuanes(min, max))}</b> por persona (entradas, comidas y trenes; sin taxis, metro ni compras)</p>`;
}

/** Cómo leer las marcas del cuaderno, con las marcas de verdad. */
const LEYENDA = `
  <p class="leyenda">
    <span><i class="m hecha" aria-hidden="true"></i>hecha</span>
    <span><i class="m" aria-hidden="true"></i>pendiente</span>
    <span><i class="m opcional" aria-hidden="true"></i>opcional</span>
    <span><i class="m saltada" aria-hidden="true"></i>saltada</span>
    <span><mark>ahora</mark></span>
  </p>`;

function pintarLista(dia: DiaC) {
  const visitas = dia.paradas.filter((p) => p.n !== null).length;
  const filas: string[] = [];
  if (dia.origen) filas.push(filaParada(dia.origen, true));
  for (const p of dia.paradas) {
    const tramo = dia.tramos.find((t) => t.hasta === p);
    if (tramo) filas.push(filaTramo(tramo));
    filas.push(filaParada(p, false));
  }
  el.contenido.innerHTML = `
    <h2 class="titulo-lista"><span>Itinerario del día</span><small>${paradas(visitas)} · ${esc(km(dia.km))}</small></h2>
    <ol class="lista">${filas.join('')}</ol>
    <section class="sobre-dia">
      <h3>${esc(dia.d.titulo)}</h3>
      <p class="cifras">Día ${dia.idx + 1} · ${esc(fechaLarga(dia.d.fecha))}</p>
      ${lineaGasto(dia.paradas)}
      ${dia.d.notas ? `<div class="notas-dia">${parrafos(dia.d.notas, '')}</div>` : ''}
      ${LEYENDA}
    </section>`;
  estado.claveMomento = '';
}

/**
 * Marca en la lista lo de ahora, lo hecho y la ficha abierta, y la desplaza para enseñarlo: siempre
 * («si»), nunca («no»), o solo si la fila de ahora se estaba viendo («si-se-veia»: con la hoja arriba,
 * quien ha bajado a leer otra cosa no pierde el sitio).
 */
function marcarLista(m: Momento, desplazar: 'si' | 'no' | 'si-se-veia' = 'si') {
  const previa = el.contenido.querySelector<HTMLElement>('li.actual');
  const seVeia = !previa || filaALaVista(previa);
  const actual = m.parada?.id ?? null;
  const abierta = estado.abierta ?? -1;
  for (const li of el.contenido.querySelectorAll<HTMLLIElement>('li.parada')) {
    const id = Number(li.dataset.id);
    const p = modelo.paradas[id];
    const e = li.classList.contains('origen') ? null : estadoDe(p);
    li.classList.toggle('actual', id === actual);
    li.classList.toggle('abierta', id === abierta);
    li.querySelector('.fila')?.setAttribute('aria-expanded', String(id === abierta));
    li.classList.toggle('hecha', e === 'hecha' && id !== actual);
    li.classList.toggle('saltada', e === 'saltada');
    const marca = marcaDe(p) ?? 'pendiente';
    for (const b of li.querySelectorAll<HTMLElement>('[data-fijar]')) b.setAttribute('aria-pressed', String(b.dataset.fijar === marca));
  }
  for (const li of el.contenido.querySelectorAll<HTMLLIElement>('li.tramo')) {
    li.classList.toggle('actual', m.tramo?.id === Number(li.dataset.tramo));
  }
  vista.mostrarSubparadas(paradaMirada(m));
  // Con la página corrida de una pieza, desplazarla sola escondería la cabecera con lo de ahora.
  if (estado.abierta !== null || panelCorrido.matches || desplazar === 'no') return;
  if (desplazar === 'si-se-veia' && estado.expandido && !seVeia) return;
  const fila = el.contenido.querySelector<HTMLElement>('li.actual');
  // Plegado y en directo, la lista asoma por lo que viene después (lo de ahora ya está arriba).
  if (estado.expandido || estado.modo !== 'directo') mostrarFila(fila);
  else mostrarSiguientes(fila?.classList.contains('tramo') ? (fila.nextElementSibling as HTMLElement | null) : fila);
}

/** Lo que se desplaza para recorrer la lista: la lista o, en pantallas anchas y bajas, el panel entero. */
const rollo = () => (panelCorrido.matches ? el.panel : el.contenido);
/** Altura de una fila dentro de lo que se desplaza. */
const alturaEnRollo = (e: HTMLElement) => e.offsetTop + (panelCorrido.matches ? el.contenido.offsetTop : 0);
/** Si se ve algo de la fila en lo que se desplaza. */
function filaALaVista(li: HTMLElement): boolean {
  const c = rollo();
  const arriba = alturaEnRollo(li);
  return arriba + li.offsetHeight > c.scrollTop && arriba < c.scrollTop + c.clientHeight;
}

/**
 * Pone arriba de la lista la parada que viene detrás de «Después» (que ya está en la cabecera), con
 * su nombre arriba; si no hay nada más, lo de después.
 */
function mostrarSiguientes(actual: HTMLElement | null) {
  const siguienteParada = (desde: Element | null | undefined) => {
    let e = desde?.nextElementSibling ?? null;
    while (e && !e.classList.contains('parada')) e = e.nextElementSibling;
    return e as HTMLElement | null;
  };
  const despues = siguienteParada(actual);
  const sig = siguienteParada(despues) ?? (actual?.nextElementSibling as HTMLElement | null);
  if (!sig) return mostrarFila(actual);
  rollo().scrollTo({ top: alturaEnRollo(sig), behavior: 'smooth' });
}

/** Desplaza la lista para que se vea la fila, con la parada anterior encima como contexto. */
function mostrarFila(li: HTMLElement | null, suave = true) {
  if (!li) return;
  const c = rollo();
  const arriba = alturaEnRollo(li);
  const abajo = arriba + li.offsetHeight;
  if (arriba >= c.scrollTop && abajo <= c.scrollTop + c.clientHeight) return;
  // Contexto: la parada anterior con el trayecto que lleva a ella, para no cortar ninguna línea.
  let previa = li.previousElementSibling as HTMLElement | null;
  while (previa && !previa.classList.contains('parada')) previa = previa.previousElementSibling as HTMLElement | null;
  const encima = previa?.previousElementSibling as HTMLElement | null;
  if (previa && encima?.classList.contains('tramo')) previa = encima;
  const conContexto = previa && abajo - alturaEnRollo(previa) <= c.clientHeight ? alturaEnRollo(previa) : arriba;
  c.scrollTo({ top: Math.max(0, conContexto - 6), behavior: suave ? 'smooth' : 'auto' });
}

el.contenido.addEventListener(
  'scroll',
  () => el.panel.classList.toggle('desplazado', el.contenido.scrollTop > 2),
  { passive: true },
);

el.contenido.addEventListener('click', (e) => {
  const objetivo = e.target as HTMLElement;
  if (objetivo.closest('[data-guardar-mapas]')) return el.offline.click();
  const ancla = objetivo.closest<HTMLAnchorElement>('a[href^="#"]');
  if (ancla) {
    e.preventDefault();
    const destino = el.contenido.querySelector<HTMLElement>(ancla.getAttribute('href')!);
    if (destino) rollo().scrollTo({ top: alturaEnRollo(destino) - 8, behavior: 'smooth' });
    return;
  }
  const taxi = objetivo.closest<HTMLElement>('[data-taxi]');
  if (taxi) return mostrarTaxi(modelo.paradas[Number(taxi.dataset.taxi)].p, taxi, !('pie' in taxi.dataset));
  const plegable = objetivo.closest<HTMLElement>('.sub-fila, .subs-grupo');
  if (plegable) return plegar(plegable);
  const chinoSub = objetivo.closest<HTMLElement>('[data-chino-sub]');
  if (chinoSub) {
    const [pid, i] = chinoSub.dataset.chinoSub!.split(':').map(Number);
    return mostrarTaxi(modelo.paradas[pid].subs[i].s, chinoSub, false);
  }
  const verSub = objetivo.closest<HTMLElement>('[data-ver-sub]');
  if (verSub) {
    const [pid, i] = verSub.dataset.verSub!.split(':').map(Number);
    return verSubparada(modelo.paradas[pid], i);
  }
  const mas = objetivo.closest<HTMLElement>('[data-mas-mapas]');
  if (mas) {
    const otros = mas.parentElement!.querySelectorAll<HTMLElement>('a[hidden]');
    for (const a of otros) a.hidden = false;
    mas.hidden = true;
    return otros[0]?.focus();
  }
  const fijar = objetivo.closest<HTMLElement>('[data-fijar]');
  if (fijar) {
    const v = fijar.dataset.fijar;
    const p = modelo.paradas[Number(fijar.dataset.id)];
    return void puedeMarcar().then((si) => si && marcar(p, v === 'pendiente' ? null : (v as Marca)));
  }
  const dia = objetivo.closest<HTMLElement>('[data-ir-dia]');
  if (dia) {
    expandir(false);
    const idx = Number(dia.dataset.irDia);
    return idx === hoyIdx ? volverAhora() : seleccionarDia(idx);
  }
  const fila = objetivo.closest('.fila')?.closest<HTMLLIElement>('li.parada');
  if (!fila) return;
  // Leer una parada no cambia la hora: abre su ficha y la enseña en el mapa.
  const p = modelo.paradas[Number(fila.dataset.id)];
  const yaAbierta = fila.classList.contains('abierta');
  const c = rollo();
  const antes = fila.getBoundingClientRect().top;
  estado.abierta = yaAbierta ? -1 : p.id;
  if (!yaAbierta) enfocar(p);
  marcarLista(momentoActual());
  // La fila tocada se queda bajo el dedo: la ficha que se pliega encima (la de la parada anterior,
  // por ejemplo) no la mueve de sitio.
  c.scrollTop += fila.getBoundingClientRect().top - antes;
  // Abrir una ficha que no se ve no sirve: si la hoja no está arriba, sube (y al llegar la enseña).
  if (!yaAbierta && esMovil() && hoja.destino !== 'alta') return expandir(true);
  // Si la ficha abierta no cabe debajo, la lista sube lo justo para verla, sin pasar la fila de arriba.
  if (!yaAbierta) {
    const r = fila.getBoundingClientRect();
    const caja = c.getBoundingClientRect();
    const falta = Math.min(r.bottom - caja.bottom + 12, r.top - caja.top - 8);
    if (falta > 0) c.scrollBy({ top: falta, behavior: reducirMovimiento.matches ? 'auto' : 'smooth' });
  }
});

/** La parada cuyos sitios de dentro se enseñan en el mapa: la de la ficha abierta, o la de ahora. */
function paradaMirada(m: Momento): ParadaC | null {
  if (estado.vista !== 'dia') return null;
  if (estado.abierta !== null && estado.abierta >= 0) return modelo.paradas[estado.abierta];
  return m.tipo === 'parada' ? m.parada : m.tramo.hasta;
}

/** Desde la ficha: la hoja baja, el mapa va al sitio y queda su ficha corta. */
function verSubparada(p: ParadaC, i: number) {
  const sub = p.subs[i];
  estado.seguir = false;
  el.seguir.hidden = estado.vista !== 'dia';
  if (esMovil()) {
    estado.abierta = null;
    mostrarFichaCorta(p, sub);
    bajarParaFicha();
  }
  vista.mostrarSubparadas(p);
  vista.resaltarSub(sub.pos ? i : null);
  vista.enfocarPunto(sub.pos ?? p.pos);
}

/** Al tocar el sello de un sitio en el mapa: su ficha corta, con el mapa a la vista. */
function pulsarSubparada(p: ParadaC, i: number) {
  vista.resaltarSub(i);
  mostrarFichaCorta(p, p.subs[i]);
  bajarParaFicha();
}

// ---------- Ficha corta (lo que se toca en el mapa) ----------

/**
 * En el móvil, lo que se toca en el mapa no tapa el mapa: una ficha corta encima de la hoja con el
 * nombre, la hora o la nota, la tarjeta en chino y «Ver ficha» para la entera.
 */
let fichaCorta: { p: ParadaC; sub?: SubC } | null = null;
/** Si lo último fue el teclado (y no el dedo o el ratón), para mover el foco a lo que se abre. */
let conTeclado = false;
addEventListener('keydown', () => (conTeclado = true), true);
addEventListener('pointerdown', () => (conTeclado = false), true);
/** Altura de la hoja antes de la ficha corta, para volver a ella al cerrarla (null: no se toca). */
let alturaAntesDeFicha: AlturaHoja | null = null;

/** Lo que se ha tocado es el mapa: la hoja baja del todo y la ficha queda encima, junto al pulgar. */
function bajarParaFicha() {
  if (!esMovil()) return;
  if (alturaAntesDeFicha === null) alturaAntesDeFicha = hoja.destino === 'alta' ? 'media' : hoja.destino;
  if (hoja.destino !== 'baja') animarHoja('baja');
}

function mostrarFichaCorta(p: ParadaC, sub?: SubC) {
  fichaCorta = { p, sub };
  const tramo = modelo.tramos.find((t) => t.hasta === p);
  let html: string;
  if (sub) {
    const enChino = sub.s.local || sub.s.direccionLocal;
    html = `<div class="fc-cabeza">
        <span class="fc-sello sub${sub.s.opcional ? ' opcional' : ''}" aria-hidden="true">${sub.letra}</span>
        <div class="fc-texto">
          <p class="fc-nombre">${esc(sub.s.nombre)}${sub.s.local ? ` <span class="local">${chino(sub.s.local)}</span>` : ''}</p>
          <p class="fc-detalle">${sub.s.opcional ? 'Si da tiempo · ' : ''}en ${esc(p.p.nombre)}</p>
          ${sub.s.notas ? `<p class="fc-nota">${esc(sub.s.notas)}</p>` : ''}
        </div>
      </div>
      <div class="acciones-bloque">
        ${enChino ? `<button type="button" class="mini" data-fc-chino>${ICONO_CHINO}En chino</button>` : ''}
        <button type="button" class="mini suave" data-fc-ficha>Ver ficha</button>
      </div>`;
  } else {
    const esOrigen = p === diaActual().origen;
    const horario = esOrigen ? `salida ${hora(p.fin)}` : `${hora(p.inicio)}–${hora(p.fin)}`;
    html = `<div class="fc-cabeza">
        <span class="fc-sello${p.n === null ? ' hotel' : ''}" aria-hidden="true">${p.n ?? 'H'}</span>
        <div class="fc-texto">
          <p class="fc-nombre">${esc(p.p.nombre)}${p.p.local ? ` <span class="local">${chino(p.p.local)}</span>` : ''}</p>
          <p class="fc-detalle"><b>${esc(horario)}</b>${tramo && !esOrigen ? ` · ${esc(comoSeLlega(tramo))}` : ''}</p>
          ${esOrigen ? '' : lineaSubs(p)}
        </div>
      </div>
      <div class="acciones-bloque">
        ${botonChino(p, tramo)}
        <button type="button" class="mini suave" data-fc-ficha>Ver ficha</button>
        ${precioCorto(p)}
      </div>`;
  }
  el.fichaCortaContenido.innerHTML = html;
  el.fichaCorta.setAttribute('aria-label', sub ? sub.s.nombre : p.p.nombre);
  el.fichaCorta.hidden = false;
  // Para quien no la ve aparecer: se anuncia, y con teclado el foco entra en ella (está al final de la página).
  el.anuncio.textContent = textoParaLeer(el.fichaCortaContenido.querySelector('.fc-texto')!);
  if (conTeclado) el.fichaCorta.querySelector<HTMLElement>('button')?.focus();
  document.body.classList.add('con-ficha');
  document.documentElement.style.setProperty('--alto-ficha', `${el.fichaCorta.offsetHeight}px`);
  margenesMapa();
}

/** Cierra la ficha corta y, si `volver` y nadie ha movido la hoja, la deja como estaba antes. */
function cerrarFichaCorta(volver = true) {
  if (!fichaCorta) return;
  fichaCorta = null;
  const teniaFoco = el.fichaCorta.contains(document.activeElement);
  el.fichaCorta.hidden = true;
  if (teniaFoco) el.ahora.focus();
  document.body.classList.remove('con-ficha');
  vista.resaltarSub(null);
  const antes = alturaAntesDeFicha;
  alturaAntesDeFicha = null;
  if (volver && antes && antes !== 'baja' && esMovil() && hoja.destino === 'baja') animarHoja(antes);
  else margenesMapa();
}

$('ficha-corta-cerrar').addEventListener('click', () => cerrarFichaCorta());
el.fichaCorta.addEventListener('click', (e) => {
  const objetivo = e.target as HTMLElement;
  if (!fichaCorta) return;
  const { p, sub } = fichaCorta;
  const taxi = objetivo.closest<HTMLElement>('[data-taxi]');
  if (taxi) return mostrarTaxi(p.p, taxi, !('pie' in taxi.dataset));
  const chinoSub = objetivo.closest<HTMLElement>('[data-fc-chino]');
  if (chinoSub && sub) return mostrarTaxi(sub.s, chinoSub, false);
  if (!objetivo.closest('[data-fc-ficha]')) return;
  cerrarFichaCorta(false);
  abrirFicha(p);
  if (sub) {
    requestAnimationFrame(() => {
      const fila = el.contenido.querySelector<HTMLElement>(`li.parada[data-id="${p.id}"] li.sub[data-sub="${sub.i}"]`);
      for (const li of el.contenido.querySelectorAll('li.sub.vista')) li.classList.remove('vista');
      if (!fila) return;
      fila.classList.add('vista');
      desplegarSub(fila);
      fila.scrollIntoView({ block: 'center' });
    });
  }
});

/** Lleva el mapa a una parada sin tocar la hora; el recorrido deja de seguirse hasta que se pida. */
function enfocar(p: ParadaC) {
  estado.seguir = false;
  el.seguir.hidden = estado.vista !== 'dia';
  vista.enfocar(p);
}

/** Al tocar un marcador del mapa: se abre su ficha en la lista y se centra en lo que queda de mapa. */
function pulsarParada(p: ParadaC) {
  if (estado.vista === 'todo' || p.dia !== estado.dia) {
    if (p.dia === hoyIdx) volverAhora();
    else seleccionarDia(p.dia, undefined, false);
  }
  // En el móvil, el mapa se queda a la vista: la hoja baja y queda la ficha corta de la parada.
  if (esMovil()) {
    vista.mostrarSubparadas(p);
    mostrarFichaCorta(p);
    bajarParaFicha();
    return enfocar(p);
  }
  expandir(true);
  ajustarMargenes();
  estado.abierta = p.id;
  enfocar(p);
  marcarLista(momentoActual());
  mostrarFila(el.contenido.querySelector(`li.parada[data-id="${p.id}"]`), false);
}

// ---------- Vista de todo el viaje ----------

const fechaPlan = new Date(__PLAN__);
const textoPlan = `plan del ${fechaPlan.toLocaleDateString('es-ES', { day: 'numeric', month: 'short' })}, ${fechaPlan.toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit' })}`;

/** Días que faltan para el viaje (negativo o cero si ya empezó). */
const faltanDias = () => Math.round((aMinutos(modelo.dias[0].d.fecha, '00:00') - aMinutos(hoy().fecha, '00:00')) / 1440);

/** Antes del viaje: lo que queda por hacer, arriba del todo. */
function bloqueAntes(): string {
  const faltan = faltanDias();
  if (faltan <= 0) return '';
  const hechos = modelo.pendientes.filter((t) => pendientesHechos().has(t)).length;
  const mapas = descargaAnterior();
  return `<section class="seccion antes">
    <h3>Antes de salir <small>· falta${faltan === 1 ? '' : 'n'} ${faltan} día${faltan === 1 ? '' : 's'}</small></h3>
    <ul class="tareas">
      ${modelo.pendientes.length ? `<li><a href="#pendientes">Comprobar lo pendiente</a> <b>${hechos} de ${modelo.pendientes.length}</b></li>` : ''}
      <li>${mapas ? `Mapas guardados el ${esc(fechaCortaLocal(mapas))}` : '<button type="button" class="boton tinta" data-guardar-mapas>Guardar mapas para ir sin conexión</button>'}</li>
      ${[...apretados]
        .map(
          (t) => `<li class="apretado"><span><b>El plan no da tiempo</b> el día ${t.hasta.dia + 1}: de «${esc(t.desde.p.nombre)}» a «${esc(
            t.hasta.p.nombre,
          )}» ${esc(textoApretado(t))}.</span></li>`,
        )
        .join('')}
    </ul>
  </section>`;
}

const COMO_FUNCIONA = `
  <section class="seccion como">
    <h3>Cómo funciona</h3>
    <p>Durante el viaje la app sigue el horario del plan con la hora real. Si no coincide con lo que haces, díselo: «Hecha» al terminar antes, «Saltar», «Llegué» o «Sigo aquí». Las marcas y las casillas se guardan solo en este móvil.</p>
    <p>Si en un móvil no se marca nada, sigue el plan en silencio y no pregunta: es lo cómodo para quien solo mira.</p>
    <p>Arrastrar la línea de tiempo o mirar otro día es un repaso del plan (la hora sale en contorno); «Volver a ahora» te devuelve.</p>
    ${LEYENDA}
  </section>`;

function pintarResumen() {
  const visitas = modelo.paradas.filter((p) => p.n !== null).length;
  // Lo hecho lo da el plan; aquí solo cuenta lo que se ha cambiado: las paradas saltadas.
  const saltadas = modelo.paradas.filter((p) => marcaDe(p) === 'saltada').length;
  ultimoAhora = '';
  el.ahora.innerHTML = `
    <div class="bloque viaje">
      <h2 class="titulo-viaje">${esc(modelo.titulo)}</h2>
      ${modelo.subtitulo ? `<p class="detalle-ahora">${esc(modelo.subtitulo)}</p>` : ''}
      <p class="cifras">${modelo.dias.length} días · ${paradas(visitas)}${saltadas ? ` · ${saltadas} saltada${saltadas === 1 ? '' : 's'}` : ''} · ${esc(textoPlan)}</p>
    </div>`;
  rollo().scrollTop = 0;
  const antes = faltanDias() > 0;
  el.contenido.innerHTML = `
    ${bloqueAntes()}
    ${antes ? COMO_FUNCIONA : ''}
    ${lineaGasto(modelo.paradas)}
    <ol class="lista-dias">
      ${modelo.dias
        .map(
          (d) => `
        <li><button type="button" data-ir-dia="${d.idx}" style="--color:${d.color}">
          <span class="lomo">${d.idx + 1}</span>
          <span class="nombre"><b>${esc(fechaLarga(d.d.fecha))}${d.d.ciudad ? ` · ${esc(d.d.ciudad)}` : ''}${d.idx === hoyIdx ? ' · hoy' : ''}</b><small>${esc(d.d.titulo)}</small></span>
          <span class="cifras">${paradas(d.paradas.filter((p) => p.n !== null).length)} · ${km(d.km)}${
            gastoTotal(d.paradas)[1] ? `<br>${esc(yuanes(...gastoTotal(d.paradas), false))}` : ''
          }</span>
        </button></li>`,
        )
        .join('')}
    </ol>
    ${
      modelo.pendientes.length
        ? `<section class="seccion" id="pendientes">
            <h3>Pendiente de comprobar <small id="cuenta-pendientes"></small></h3>
            <ul class="pendientes">${modelo.pendientes
              .map(
                (t) => `<li><label><input type="checkbox" data-pendiente="${esc(t)}"${pendientesHechos().has(t) ? ' checked' : ''}>
                  <span>${esc(t)}</span></label></li>`,
              )
              .join('')}</ul>
            <p class="cifras">Las casillas y las paradas marcadas se guardan solo en este móvil.</p>
          </section>`
        : ''
    }
    ${modelo.secciones
      .map(
        (sec) => `<section class="seccion">
          <h3>${esc(sec.titulo)}</h3>
          <ul>${sec.puntos.map((pt) => `<li>${esc(pt)}</li>`).join('')}</ul>
          ${sec.enlaces?.length ? `<p class="enlaces">${enlacesHtml(sec.enlaces)}</p>` : ''}
        </section>`,
      )
      .join('')}
    ${antes ? '' : COMO_FUNCIONA}`;
  contarPendientes();
}

// Las casillas de pendientes se recuerdan en este móvil (no se comparten con otros).
const CLAVE_PENDIENTES = 'pendientes-hechos';
const pendientesHechos = () => new Set(leer<string[]>(CLAVE_PENDIENTES, []));

function contarPendientes() {
  const n = modelo.pendientes.filter((t) => pendientesHechos().has(t)).length;
  const c = document.getElementById('cuenta-pendientes');
  if (c) c.textContent = `· ${n} de ${modelo.pendientes.length}`;
}

el.contenido.addEventListener('change', (e) => {
  const casilla = e.target as HTMLInputElement;
  const texto = casilla.dataset.pendiente;
  if (texto === undefined) return;
  const hechos = pendientesHechos();
  if (casilla.checked) hechos.add(texto);
  else hechos.delete(texto);
  guardar(CLAVE_PENDIENTES, [...hechos]);
  contarPendientes();
});

// ---------- Hoja deslizable ----------

/*
 * En el móvil el panel es una hoja con tres alturas: baja (solo la cuenta atrás: casi todo es mapa),
 * media (la cabecera entera y un poco de lista) y alta (la lista). Sigue al dedo, conserva la
 * inercia al soltar y se asienta con un muelle. Se mueve con transform (sin recalcular la página en
 * cada fotograma) y el mapa solo cambia sus márgenes al empezar a moverse hacia una altura.
 */
type AlturaHoja = 'baja' | 'media' | 'alta';
const ORDEN_HOJA: AlturaHoja[] = ['baja', 'media', 'alta'];
/** Papel de más bajo la hoja: si al soltar rebota hacia arriba, no se ve el mapa por debajo. */
const SOBRANTE_HOJA = 60;
const hoja = {
  pos: 'media' as AlturaHoja,
  destino: 'media' as AlturaHoja,
  visible: 0,
  /** Altura visible la última vez que se paró: la que conocen las píldoras y el mapa. */
  asentada: 0,
  alturas: { baja: 0, media: 0, alta: 0 } as Record<AlturaHoja, number>,
  animacion: 0,
  /**
   * Media altura donde se paró por última vez, para lo mismo (vista, día, modo y pantalla): si lo de
   * dentro cambia solo (sale la pregunta, pasa el tiempo) y sigue cabiendo, la hoja no se mueve.
   */
  fija: { media: 0, clave: '' },
};
const claveHoja = () => `${estado.vista}|${estado.dia}|${estado.modo}|${innerWidth}x${innerHeight}`;
const seguidores = () => [
  el.pildoras,
  el.toast,
  el.fichaCorta,
  ...document.querySelectorAll<HTMLElement>('#mapa .maplibregl-ctrl-bottom-right, #mapa .maplibregl-ctrl-bottom-left'),
];

/** Las tres alturas visibles de la hoja, medidas sobre lo que lleva dentro ahora mismo. */
/** Con la hoja alta (en el móvil, en un día) la cabecera va reducida a lo esencial. */
const cabeceraReducida = () => esMovil() && estado.vista === 'dia' && document.body.classList.contains('panel-abierto');

function medirHoja() {
  const r = el.panel.getBoundingClientRect();
  const alta = el.panel.offsetHeight - SOBRANTE_HOJA;
  // Baja y media se miden con la cabecera entera: con la reducida se conserva lo medido antes.
  if (cabeceraReducida()) {
    hoja.alturas = hoja.alturas.media
      ? { ...hoja.alturas, alta }
      : { baja: Math.min(120, alta), media: Math.min(innerHeight * 0.5, alta), alta };
    return;
  }
  const abajo = (parseFloat(getComputedStyle(el.panel).paddingBottom) || 0) - SOBRANTE_HOJA;
  const fin = (e: Element | null) => (e ? e.getBoundingClientRect().bottom - r.top : 0);
  const tope = Math.min(innerHeight * 0.76, alta);
  const ideal = Math.min(Math.max(fin(el.cabecera) + 56 + abajo, innerHeight * 0.5), tope);
  const { fija } = hoja;
  const sigueValiendo = fija.clave === claveHoja() && fija.media <= tope && fin(el.cabecera) + abajo + 8 <= fija.media;
  const media = sigueValiendo ? fija.media : ideal;
  // Baja: el asa y la primera línea de la cabecera (la cuenta atrás, o la hora del repaso, o el viaje).
  const corte =
    estado.vista === 'todo'
      ? fin(el.ahora.querySelector('.titulo-viaje')) + 14
      : estado.modo === 'repaso'
        ? el.controles.getBoundingClientRect().top - r.top
        : el.pista.getBoundingClientRect().top - r.top + 6;
  hoja.alturas = { baja: Math.min(corte + abajo, media - 40), media, alta };
}

function moverHoja(v: number) {
  hoja.visible = v;
  el.panel.style.transform = `translateY(${hoja.alturas.alta - v}px)`;
  // Las píldoras y los avisos acompañan al borde de la hoja; de media a alta se van apagando.
  const d = hoja.asentada - v;
  const { media, alta } = hoja.alturas;
  const apagar = alta > media ? Math.min(Math.max((v - media) / (alta - media), 0), 1) : 0;
  // Yendo a alta, las píldoras ya están al pie (no siguen al borde) y aparecen al llegar.
  const alPie = document.body.classList.contains('panel-abierto');
  for (const e of seguidores()) e.style.transform = d && !(alPie && e === el.pildoras) ? `translateY(${d}px)` : '';
  el.botonesMapa.style.opacity = apagar ? String(1 - apagar) : '';
  el.pildoras.style.opacity = alPie ? (apagar < 1 ? String(apagar) : '') : apagar ? String(1 - apagar) : '';
}

function asentarHoja(pos: AlturaHoja) {
  const cambio = pos !== hoja.pos;
  hoja.animacion = 0;
  hoja.pos = pos;
  hoja.asentada = hoja.visible;
  for (const e of seguidores()) e.style.transform = '';
  for (const e of [el.pildoras, el.botonesMapa]) e.style.opacity = '';
  document.body.dataset.hoja = pos;
  if (pos === 'media') hoja.fija = { media: hoja.alturas.media, clave: claveHoja() };
  // Arriba, venga del asa o del dedo, a la vista lo de ahora (o la ficha abierta), con contexto.
  // (Si el foco del teclado está en la lista, manda lo enfocado.)
  if (cambio && pos === 'alta' && estado.vista === 'dia' && !el.contenido.contains(document.activeElement)) {
    mostrarFila(el.contenido.querySelector('li.abierta, li.actual'), false);
  }
  // Una ficha abierta que ha quedado fuera de la vista no sigue «abierta» a escondidas.
  if (pos !== 'alta' && esMovil() && estado.abierta !== null && estado.abierta >= 0) {
    estado.abierta = null;
    marcarLista(momentoActual());
  }
  ajustarMargenes();
  // Al bajar la hoja, el mapa ha crecido: se vuelve a encuadrar el viaje o, si se va siguiendo el
  // recorrido, lo de ahora.
  if (cambio && pos !== 'alta') {
    if (estado.vista === 'todo') vista.encuadrarTodo();
    else if (estado.seguir) vista.seguir(momentoActual(), true, true);
  }
  // Si mientras se movía cambió lo que lleva dentro (otra cabecera), se ajusta a la medida nueva.
  const antes = hoja.alturas[pos];
  medirHoja();
  if (Math.abs(hoja.alturas[pos] - antes) > 1) requestAnimationFrame(() => animarHoja(pos));
}

/** Lleva la hoja a una altura con un muelle casi crítico, partiendo de la velocidad del dedo (px/ms). */
function animarHoja(pos: AlturaHoja, velocidad = 0) {
  cancelAnimationFrame(hoja.animacion);
  fijarDestino(pos);
  const destino = hoja.alturas[pos];
  if (reducirMovimiento.matches || Math.abs(hoja.visible - destino) < 1) {
    moverHoja(destino);
    return asentarHoja(pos);
  }
  const k = 600;
  const c = 2 * Math.sqrt(k) * 0.9;
  let x = hoja.visible;
  let v = velocidad * 1000;
  let antes = performance.now();
  const paso = (ahora: number) => {
    const dt = Math.min((ahora - antes) / 1000, 1 / 30) / 4;
    antes = ahora;
    for (let i = 0; i < 4; i++) {
      v += (-k * (x - destino) - c * v) * dt;
      x += v * dt;
    }
    if (Math.abs(x - destino) < 0.5 && Math.abs(v) < 15) {
      moverHoja(destino);
      return asentarHoja(pos);
    }
    moverHoja(Math.min(x, hoja.alturas.alta + SOBRANTE_HOJA));
    hoja.animacion = requestAnimationFrame(paso);
  };
  hoja.animacion = requestAnimationFrame(paso);
}

/** Lo que depende de adónde va la hoja se decide al empezar a moverse, no al llegar. */
function fijarDestino(pos: AlturaHoja) {
  hoja.destino = pos;
  const alta = pos === 'alta';
  if (alta) cerrarFichaCorta(false);
  estado.expandido = alta;
  el.panel.classList.toggle('expandido', alta);
  el.asa.setAttribute('aria-expanded', String(alta));
  el.asa.setAttribute('aria-label', alta ? 'Mostrar menos itinerario' : 'Mostrar el itinerario entero');
  document.body.classList.toggle('panel-abierto', alta);
  margenesMapa();
}

/** Abre (alta) o pliega (media) la hoja; en el ordenador solo cambia el estado. */
function expandir(abrir = hoja.destino !== 'alta') {
  if (esMovil()) animarHoja(abrir ? 'alta' : 'media');
  else fijarDestino(abrir ? 'alta' : 'media');
  if (estado.vista !== 'dia') return;
  if (abrir) requestAnimationFrame(() => mostrarFila(el.contenido.querySelector('li.abierta, li.actual'), false));
  else if (estado.abierta === null) requestAnimationFrame(() => marcarLista(momentoActual()));
}

// Un toque en el asa: de baja a media, y de media a alta y vuelta.
el.asa.addEventListener('click', () => (hoja.destino === 'baja' ? animarHoja('media') : expandir()));
// Con teclado, las flechas suben y bajan la hoja por sus tres alturas.
el.asa.addEventListener('keydown', (e) => {
  if (!esMovil() || (e.key !== 'ArrowUp' && e.key !== 'ArrowDown')) return;
  e.preventDefault();
  const i = ORDEN_HOJA.indexOf(hoja.destino) + (e.key === 'ArrowUp' ? 1 : -1);
  const pos = ORDEN_HOJA[Math.min(Math.max(i, 0), ORDEN_HOJA.length - 1)];
  if (pos === hoja.destino) return;
  if (pos === 'alta' || hoja.destino === 'alta') expandir(pos === 'alta');
  else animarHoja(pos);
});
// Desde arriba del todo se vuelve al mapa sin estirar el dedo: «Mapa» al pie, o un toque en la cabecera.
el.irMapa.addEventListener('click', () => expandir(false));
el.cabecera.addEventListener('click', (e) => {
  if (!esMovil() || hoja.destino !== 'alta' || (e.target as HTMLElement).closest('button, a, input')) return;
  expandir(false);
});

// --- Arrastre con el dedo ---

let toque: {
  x0: number;
  y0: number;
  v0: number;
  arrastrando: boolean;
  desdeLista: boolean;
  muestras: { t: number; y: number }[];
} | null = null;
let ignorarClic = false;

/** Resistencia al pasarse de las alturas: cada vez cuesta más y nunca pasa de `max`. */
const goma = (d: number, max: number) => max * (1 - 1 / ((d / max) * 0.6 + 1));

el.panel.addEventListener(
  'touchstart',
  (e) => {
    if (!esMovil() || e.touches.length > 1) return (toque = null);
    const objetivo = e.target as HTMLElement;
    // La línea de tiempo se arrastra de lado: no es para la hoja.
    if (objetivo.closest('#pista') && estado.modo === 'repaso') return (toque = null);
    const t = e.touches[0];
    toque = {
      x0: t.clientX,
      y0: t.clientY,
      v0: hoja.visible,
      arrastrando: false,
      desdeLista: !!objetivo.closest('#contenido'),
      muestras: [{ t: e.timeStamp, y: t.clientY }],
    };
  },
  { passive: true },
);

el.panel.addEventListener(
  'touchmove',
  (e) => {
    if (!toque) return;
    const t = e.touches[0];
    const dx = t.clientX - toque.x0;
    const dy = t.clientY - toque.y0;
    if (!toque.arrastrando) {
      // Con la lista abierta, se desplaza la lista; solo arrastrando hacia abajo desde arriba del
      // todo se baja la hoja (se decide en el primer movimiento, antes de que el navegador desplace).
      if (toque.desdeLista && hoja.destino === 'alta') {
        if (dy < 0 || el.contenido.scrollTop > 0) return (toque = null);
        if (dy === 0) return;
      } else if (Math.abs(dx) < 6 && Math.abs(dy) < 6) return;
      if (Math.abs(dx) > Math.abs(dy)) return (toque = null);
      cancelAnimationFrame(hoja.animacion);
      hoja.animacion = 0;
      toque.arrastrando = true;
      toque.y0 = t.clientY;
      toque.v0 = hoja.visible;
    }
    e.preventDefault();
    toque.muestras.push({ t: e.timeStamp, y: t.clientY });
    if (toque.muestras.length > 8) toque.muestras.shift();
    const { baja, alta } = hoja.alturas;
    let v = toque.v0 - (t.clientY - toque.y0);
    if (v > alta) v = alta + goma(v - alta, SOBRANTE_HOJA);
    else if (v < baja) v = baja - goma(baja - v, 70);
    moverHoja(v);
  },
  { passive: false },
);

function soltarHoja(e: TouchEvent) {
  const t = toque;
  toque = null;
  if (!t?.arrastrando) return;
  // Tras arrastrar, el dedo no «pulsa» lo que haya debajo; y la hoja queda donde la deje el dedo.
  alturaAntesDeFicha = null;
  ignorarClic = true;
  setTimeout(() => (ignorarClic = false), 350);
  const ultima = t.muestras[t.muestras.length - 1];
  const primera = t.muestras.find((m) => ultima.t - m.t <= 100) ?? ultima;
  const quieto = e.timeStamp - ultima.t > 120;
  const velocidad = !quieto && ultima.t > primera.t ? -(ultima.y - primera.y) / (ultima.t - primera.t) : 0;
  // Se elige la altura más cercana a donde iría la hoja con su impulso.
  const proyectada = hoja.visible + velocidad * 220;
  const destino = ORDEN_HOJA.reduce((a, b) =>
    Math.abs(hoja.alturas[b] - proyectada) < Math.abs(hoja.alturas[a] - proyectada) ? b : a,
  );
  animarHoja(destino, velocidad);
}
el.panel.addEventListener('touchend', soltarHoja);
// Con teclado, lo enfocado nunca queda bajo el borde de la pantalla: la hoja sube lo que haga falta.
el.panel.addEventListener('focusin', (e) => {
  const objetivo = e.target as HTMLElement;
  if (!esMovil() || !conTeclado || toque || objetivo.getBoundingClientRect().bottom <= innerHeight - 8) return;
  if (hoja.destino === 'baja') animarHoja('media');
  else if (hoja.destino === 'media' && el.contenido.contains(objetivo)) expandir(true);
});
el.panel.addEventListener('touchcancel', soltarHoja);
el.panel.addEventListener(
  'click',
  (e) => {
    if (!ignorarClic) return;
    e.stopPropagation();
    e.preventDefault();
  },
  true,
);

/** Vuelve a medir y deja la hoja en su sitio (al girar el móvil o cambiar lo que lleva dentro). */
function recolocarHoja() {
  if (!esMovil()) {
    el.panel.style.transform = '';
    for (const e of seguidores()) e.style.transform = '';
    return ajustarMargenes();
  }
  medirHoja();
  if (toque?.arrastrando || hoja.animacion) return;
  if (Math.abs(hoja.alturas[hoja.destino] - hoja.visible) < 1) return ajustarMargenes();
  if (!hoja.asentada) {
    moverHoja(hoja.alturas[hoja.destino]);
    return asentarHoja(hoja.destino);
  }
  animarHoja(hoja.destino);
}

// ---------- Márgenes del mapa ----------

/** Lo que tapan la barra y la hoja (en la altura a la que va) no cuenta como mapa visible. */
function margenesMapa() {
  const ancha = pantallaAncha.matches;
  if (!ancha && !hoja.alturas.alta) medirHoja();
  // Con la hoja alta el mapa casi no se ve: se encuadra como si estuviera a media altura, que es
  // lo que se verá al bajarla.
  const visible = hoja.destino === 'alta' ? hoja.alturas.media : hoja.alturas[hoja.destino];
  // Encima de la hoja están las píldoras y los avisos (o la ficha corta): no cuentan como mapa.
  const encima = fichaCorta ? el.fichaCorta.offsetHeight + 20 : 60;
  // En móviles bajos los botones del mapa van en fila arriba a la derecha: se les deja medio sitio
  // (en esas pantallas el mapa es una franja y no se puede regalar entera).
  const botones = el.botonesMapa.getBoundingClientRect();
  const enFila = botones.width > botones.height && botones.height > 0;
  vista.fijarMargenes({
    top: el.barra.offsetHeight + 8 + (enFila ? 32 : 0),
    bottom: ancha ? 16 : (visible || hoja.visible) + encima,
    left: ancha ? el.panel.getBoundingClientRect().right + 12 : 16,
    right: enFila ? 16 : 68,
  });
}

function ajustarMargenes() {
  margenesMapa();
  const ancha = pantallaAncha.matches;
  document.documentElement.style.setProperty('--alto-panel', ancha ? '0px' : `${hoja.asentada}px`);
  document.documentElement.style.setProperty('--alto-barra', `${el.barra.offsetHeight}px`);
}
new ResizeObserver(recolocarHoja).observe(el.panel);
// Al girar el móvil se pasa de hoja abajo a página a un lado (y vuelta): la ficha corta es de la hoja.
pantallaAncha.addEventListener('change', () => {
  cerrarFichaCorta(false);
  recolocarHoja();
});
new ResizeObserver(recolocarHoja).observe(el.cabecera);
new ResizeObserver(ajustarMargenes).observe(el.barra);

// ---------- Botones del mapa ----------

el.encuadrar.addEventListener('click', () => {
  if (estado.vista === 'todo') vista.encuadrarTodo();
  else vista.encuadrarDia(diaActual());
});

el.seguir.addEventListener('click', () => {
  estado.seguir = true;
  el.seguir.hidden = true;
  estado.claveMomento = '';
  vista.seguir(momentoActual(), true, true);
});

const fechaCortaLocal = (fecha: string | number) => new Date(fecha).toLocaleDateString('es-ES', { day: 'numeric', month: 'short' });

let descargando = false;
el.offline.classList.toggle('hecho', !!descargaAnterior());
el.offline.addEventListener('click', async () => {
  if (descargando) return;
  const previa = descargaAnterior();
  const si = await preguntar(
    previa ? 'Comprobar los mapas guardados' : 'Guardar mapas para ir sin conexión',
    previa
      ? `Los mapas se guardaron el ${fechaCortaLocal(previa)}. Se comprobarán y se completará lo que falte. Este móvil lleva el ${textoPlan}.`
      : `Se guardarán la app y los mapas de todas las zonas del viaje (unos 20–40 MB) para usarla sin internet. Mejor con wifi. Este móvil lleva el ${textoPlan}.`,
    previa ? 'Comprobar' : 'Guardar mapas',
    'Ahora no',
  );
  if (!si) return;
  descargando = true;
  el.offline.classList.add('cargando');
  try {
    const { fallos, total } = await descargarMapas(vista.mapa, modelo, (hechas, total) =>
      aviso(`Guardando mapas… ${Math.round((hechas / total) * 100)} %`, 0),
    );
    if (fallos) aviso(`No se pudieron guardar ${fallos} de ${total} piezas del mapa. Vuelve a intentarlo con mejor conexión.`);
    else aviso('Mapas guardados. La app funcionará sin conexión.');
    el.offline.classList.toggle('hecho', !fallos);
    pintarRed();
  } catch (e) {
    aviso(`No se pudieron guardar los mapas: ${(e as Error).message}`);
  } finally {
    descargando = false;
    el.offline.classList.remove('cargando');
  }
});

// ---------- Conexión ----------

const ICONO_SIN_RED =
  '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M2.5 9a14 14 0 0 1 19 0M5.5 12.5a9.5 9.5 0 0 1 13 0M8.8 16a5 5 0 0 1 6.4 0M12 19.5h.01M4 4l16 16" /></svg>';

/** Lo que sigue funcionando sin conexión (lo que dice la píldora al tocarla). */
function textoSinRed(): string {
  const previa = descargaAnterior();
  return previa
    ? `Sin conexión, pero todo sigue funcionando: la lista, las fichas, la tarjeta del taxista y los mapas guardados el ${fechaCortaLocal(previa)}.`
    : 'Sin conexión. La lista, las fichas y la tarjeta del taxista funcionan; el mapa solo enseña las zonas que ya has visto. Guarda los mapas cuando vuelvas a tener wifi.';
}

function pintarRed() {
  const sinRed = !navigator.onLine;
  const antes = !el.red.hidden;
  el.red.hidden = !sinRed;
  if (!sinRed) return;
  const previa = descargaAnterior();
  el.red.innerHTML = `${ICONO_SIN_RED}Sin conexión · ${previa ? 'mapas guardados' : 'sin mapas guardados'}`;
  el.red.setAttribute('aria-label', `Sin conexión · ${previa ? 'mapas guardados' : 'sin mapas guardados'}: qué sigue funcionando`);
  if (!antes) el.anuncio.textContent = 'Sin conexión';
}
addEventListener('online', pintarRed);
addEventListener('offline', pintarRed);
el.red.addEventListener('click', () => aviso(textoSinRed(), 9000));
pintarRed();

// ---------- Día / noche ----------

// La elección se recuerda en este móvil. Sin elegir, sigue al móvil: claro de día y noche si el
// móvil se pone en modo oscuro al anochecer.
const CLAVE_TEMA = 'tema';
const metaColor = document.querySelector<HTMLMetaElement>('meta[name="theme-color"]')!;

function fijarTema(oscuro: boolean) {
  document.documentElement.dataset.tema = oscuro ? 'oscuro' : 'claro';
  metaColor.content = oscuro ? '#2a2119' : '#a8804f';
  el.tema.setAttribute('aria-pressed', String(oscuro));
  el.tema.setAttribute('aria-label', oscuro ? 'Modo claro' : 'Modo noche');
  el.tema.querySelector('.rotulo')!.textContent = oscuro ? 'Claro' : 'Noche';
  vista.fijarTema(oscuro);
}

el.tema.addEventListener('click', () => {
  const oscuro = document.documentElement.dataset.tema !== 'oscuro';
  fijarTema(oscuro);
  guardar(CLAVE_TEMA, oscuro ? 'oscuro' : 'claro');
});

const temaDelMovil = matchMedia('(prefers-color-scheme: dark)');
const temaElegido = () => leer<string | null>(CLAVE_TEMA, null);
fijarTema(temaElegido() ? temaElegido() === 'oscuro' : temaDelMovil.matches);
temaDelMovil.addEventListener('change', (e) => temaElegido() === null && fijarTema(e.matches));

// ---------- Tarjeta para el taxista ----------

let bloqueoPantalla: WakeLockSentinel | null = null;
let abridorTaxi: HTMLElement | null = null;


/**
 * El chino partido en trozos que no se cortan al cambiar de línea: las palabras, y cada número con
 * lo que le sigue («688号», «1號»). Así nunca sale «恒丰路6 / 88号», que es otra dirección.
 */
function enTrozos(texto: string): string {
  const piezas = segmentador ? [...segmentador.segment(texto)].map((s) => s.segment) : [...texto];
  const trozos: string[] = [];
  for (const pieza of piezas) {
    const previo = trozos[trozos.length - 1];
    // Pegados: un número con lo que le sigue, la puntuación con lo de antes y una sílaba suelta con
    // una palabra corta («怎么» + «走»), para que «怎么走？» no se parta.
    const pegar =
      previo !== undefined &&
      (/[0-9A-Za-z]$/.test(previo)
        ? /^[0-9A-Za-z.\-#]/.test(pieza) || pieza.length === 1
        : /^[，。、？！：；）」』]/.test(pieza) || (pieza.length === 1 && esHan(pieza) && esHan(previo) && previo.length <= 2));
    if (pegar) trozos[trozos.length - 1] += pieza;
    else trozos.push(pieza);
  }
  return trozos.map((t) => `<span class="trozo">${esc(t)}</span>`).join('');
}

const PEDIR = {
  taxi: { zh: '请带我去这里', es: 'Lléveme aquí, por favor' },
  pie: { zh: '我想去这里，怎么走？', es: 'Quiero ir aquí. ¿Cómo llego?' },
};

/**
 * Tarjeta a pantalla completa. Solo se cierra con ✕, Escape o el gesto de volver: no con un roce.
 * `taxi`: para el taxista («lléveme aquí»); si no, para preguntar a alguien por la calle.
 */
function mostrarTaxi(d: { nombre: string; local?: string; direccionLocal?: string }, abridor?: HTMLElement, taxi = true) {
  const pedir = PEDIR[taxi ? 'taxi' : 'pie'];
  $('taxi-pedir').innerHTML = `<span lang="zh-Hans">${enTrozos(pedir.zh)}</span><small>${esc(pedir.es)}</small>`;
  $('taxi-texto').innerHTML = enTrozos(d.local ?? d.direccionLocal ?? d.nombre);
  $('taxi-direccion').innerHTML = d.direccionLocal && d.local ? enTrozos(d.direccionLocal) : '';
  $('taxi-nombre').textContent = d.nombre;
  el.taxi.setAttribute('aria-label', `${taxi ? 'Tarjeta para el taxista' : 'Tarjeta para preguntar cómo llegar'}: ${d.nombre}`);
  abridorTaxi = abridor ?? null;
  el.taxi.hidden = false;
  // Mientras está abierta, lo de detrás no se puede tocar ni recorrer con el teclado.
  for (const n of document.body.children) if (n !== el.taxi && n.tagName !== 'SCRIPT') (n as HTMLElement).inert = true;
  history.pushState({ taxi: true }, '');
  el.taxiCerrar.focus();
  // Que la pantalla no se apague mientras el taxista la lee.
  navigator.wakeLock
    ?.request('screen')
    .then((w) => (bloqueoPantalla = w))
    .catch(() => {});
}

function cerrarTaxi(desdeHistorial = false) {
  if (el.taxi.hidden) return;
  el.taxi.hidden = true;
  for (const n of document.body.children) (n as HTMLElement).inert = false;
  bloqueoPantalla?.release().catch(() => {});
  bloqueoPantalla = null;
  if (!desdeHistorial && history.state?.taxi) history.back();
  abridorTaxi?.focus();
}

el.taxiCerrar.addEventListener('click', () => cerrarTaxi());
addEventListener('popstate', () => cerrarTaxi(true));
addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  if (!el.taxi.hidden) cerrarTaxi();
  else cerrarFichaCorta();
});

/** Hotel donde se duerme el día que se está viendo (o hoy): para «Llévame al hotel». */
function hotelActual(): ParadaC | null {
  const dia = modelo.dias[estado.vista === 'dia' ? estado.dia : Math.max(hoyIdx, 0)];
  const ultima = dia.paradas[dia.paradas.length - 1] ?? dia.origen;
  const hoteles = modelo.paradas.filter((p) => p.p.categoria === 'hotel');
  return [...hoteles].reverse().find((h) => h.id <= (ultima?.id ?? 0)) ?? hoteles[0] ?? null;
}

el.hotel.hidden = !ultimoHotel;
el.hotel.addEventListener('click', () => {
  const h = hotelActual();
  if (h) mostrarTaxi(h.p, el.hotel);
});

// Con teclado o lector de pantalla, el primer tabulador lleva a «ahora» sin recorrer el mapa.
$('saltar').addEventListener('click', (e) => {
  e.preventDefault();
  el.ahora.focus();
});

// ---------- Avisos y diálogo ----------

let temporizadorAviso = 0;
function aviso(texto: string, ms = 4000, accion?: { texto: string; hacer: () => void }) {
  el.toastTexto.textContent = texto;
  el.toastAccion.hidden = !accion;
  el.toastAccion.textContent = accion?.texto ?? '';
  el.toastAccion.onclick = accion
    ? () => {
        el.toast.hidden = true;
        accion.hacer();
      }
    : null;
  el.toast.hidden = false;
  clearTimeout(temporizadorAviso);
  if (ms) temporizadorAviso = window.setTimeout(() => (el.toast.hidden = true), ms);
}

/** Pregunta con el aspecto de la app (no el cuadro del navegador). */
function preguntar(titulo: string, texto: string, si: string, no: string): Promise<boolean> {
  $('dialogo-titulo').textContent = titulo;
  $('dialogo-texto').textContent = texto;
  $('dialogo-si').textContent = si;
  $('dialogo-no').textContent = no;
  el.dialogo.returnValue = '';
  el.dialogo.showModal();
  return new Promise((ok) => el.dialogo.addEventListener('close', () => ok(el.dialogo.returnValue === 'si'), { once: true }));
}

if (modelo.ejemplo || modelo.avisos.length) {
  el.aviso.hidden = false;
  el.aviso.textContent = modelo.avisos.length
    ? `${modelo.avisos.length} aviso(s) en el itinerario: ${modelo.avisos[0]}`
    : 'Itinerario de ejemplo';
}

// ---------- Arranque ----------

// Durante el viaje se abre en directo (hoy, la hora real y lo marcado); antes y después, en repaso.
// Fuera de las fechas del viaje se abre en «Todo»: antes, con lo que queda por preparar.
function arrancar() {
  if (estado.vista === 'todo' || (hoyIdx < 0 && !estado.claveMomento)) return verTodo();
  if (estado.modo === 'directo' || (hoyIdx >= 0 && !estado.claveMomento)) return volverAhora();
  seleccionarDia(estado.dia, estado.t);
}
estado.t = modelo.dias[0].desde;
arrancar();
// La lista y la línea de tiempo funcionan desde el principio; la ruta se dibuja cuando carga el mapa.
vista.listo.then(() => {
  if (estado.vista === 'todo') verTodo();
  else if (estado.modo === 'directo') volverAhora();
  else seleccionarDia(estado.dia, estado.t);
});
registrarServiceWorker();
