import '@fontsource-variable/archivo/wdth.css';
import './estilos.css';
import { itinerario } from './datos/itinerario';
import { TRANSPORTE, ahoraEnChina, duracion, esc, fechaCorta, fechaLarga, hora, km } from './formato';
import { distanciaKm } from './geo';
import { VistaMapa } from './mapa';
import {
  type DiaC,
  type Momento,
  type ParadaC,
  type TramoC,
  construirModelo,
  gastoTotal,
  hotelDe,
  momentoEn,
} from './modelo';
import { descargaAnterior, descargarMapas, registrarServiceWorker } from './offline';
import type { Enlace, Gasto } from './tipos';

const modelo = construirModelo(itinerario);
for (const a of modelo.avisos) console.warn(a);

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const el = {
  barra: $('barra'),
  dias: $('dias'),
  aviso: $('aviso'),
  panel: $('panel'),
  asa: $('asa'),
  cabecera: $('cabecera'),
  reloj: $('hora'),
  ahora: $('ahora'),
  play: $<HTMLButtonElement>('btn-play'),
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
  seguir: $<HTMLButtonElement>('btn-seguir'),
  tema: $<HTMLButtonElement>('btn-tema'),
  taxi: $('taxi'),
  toast: $('toast'),
};

/** Minutos del viaje que pasan por cada segundo de reproducción. En las paradas va 4 veces más rápido. */
const VELOCIDADES = [5, 10, 20, 40];
const ACELERACION_EN_PARADA = 4;

const estado = {
  vista: 'dia' as 'dia' | 'todo',
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

const vista = new VistaMapa($('mapa'), modelo, {
  alPulsarParada: pulsarParada,
  alArrastrar: () => {
    estado.seguir = false;
    el.seguir.hidden = estado.vista !== 'dia';
  },
});

const diaActual = (): DiaC => modelo.dias[estado.dia];
const claveDe = (m: Momento) => (m.tipo === 'camino' ? `t${m.tramo.id}` : `p${m.parada.id}`);

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
      return `<button type="button" class="pestana${activa ? ' activa' : ''}" data-dia="${d.idx}"
        aria-pressed="${activa}" style="--color:${d.color}">
        <b>Día ${d.idx + 1}</b><small>${esc(fechaCorta(d.d.fecha))}${ciudad}</small>
      </button>`;
    }),
  ];
  el.dias.innerHTML = pestanas.join('');
  // Que la pestaña activa quede a la vista sin mover nada más de la página.
  const activa = el.dias.querySelector<HTMLElement>('.activa');
  if (activa && (activa.offsetLeft < el.dias.scrollLeft || activa.offsetLeft + activa.offsetWidth > el.dias.scrollLeft + el.dias.clientWidth)) {
    el.dias.scrollLeft = activa.offsetLeft - 40;
  }
}

el.dias.addEventListener('click', (e) => {
  const b = (e.target as HTMLElement).closest<HTMLButtonElement>('[data-dia]');
  if (!b) return;
  if (b.dataset.dia === 'todo') verTodo();
  else seleccionarDia(Number(b.dataset.dia));
});

// ---------- Cambio de vista ----------

function seleccionarDia(idx: number, t?: number, encuadrar = true) {
  const dia = modelo.dias[idx];
  if (estado.vista === 'todo') expandir(false);
  estado.vista = 'dia';
  estado.dia = idx;
  estado.t = Math.min(Math.max(t ?? dia.desde, dia.desde), dia.hasta);
  estado.abierta = null;
  estado.claveMomento = '';
  document.body.classList.remove('vista-todo');
  document.documentElement.style.setProperty('--color-dia', dia.color);
  el.seguir.hidden = estado.seguir;
  vista.mostrarDia(dia);
  pintarDias();
  prepararLineaTiempo(dia);
  pintarLista(dia);
  pintar(false);
  if (encuadrar) {
    ajustarMargenes();
    vista.encuadrarDia(dia);
  }
}

function verTodo() {
  pausar();
  estado.vista = 'todo';
  document.body.classList.add('vista-todo');
  el.seguir.hidden = true;
  vista.mostrarTodo();
  pintarDias();
  pintarResumen();
  expandir(true);
  ajustarMargenes();
  vista.encuadrarTodo();
}

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
  // Un punto por parada (y la salida del hotel), a su hora de llegada.
  const marcas = [...(dia.origen ? [dia.origen.fin] : []), ...dia.paradas.map((p) => p.inicio)];
  el.puntos.innerHTML = marcas.map((m) => `<span data-t="${m}" style="left:${pct(m)}%"></span>`).join('');
}

/** Puntos ya pasados rellenos y el fluorescente sobre lo que pasa ahora (la estancia o el trayecto). */
function pintarLineaTiempo(m: Momento) {
  for (const punto of el.puntos.children as HTMLCollectionOf<HTMLElement>) {
    punto.classList.toggle('pasado', Number(punto.dataset.t) <= estado.t);
  }
  const [desde, hasta] = m.tipo === 'camino' ? [m.tramo.salida, m.tramo.llegada] : [m.parada.inicio, m.parada.fin];
  const izquierda = pct(desde);
  el.tramoAhora.style.left = `${izquierda}%`;
  el.tramoAhora.style.width = `${Math.max(pct(hasta) - izquierda, 1.5)}%`;
}

el.deslizador.addEventListener('input', () => {
  pausar();
  estado.t = instanteEn(Number(el.deslizador.value));
  estado.abierta = null;
  pintar(true);
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
  pausar();
  estado.t = t;
  estado.abierta = null;
  estado.seguir = true;
  el.seguir.hidden = true;
  pintar(true);
}

// ---------- Reproducción ----------

let ultimoFotograma = 0;

function reproducir() {
  if (estado.vista !== 'dia') return;
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
  estado.reproduciendo = false;
  document.body.classList.remove('reproduciendo');
  el.play.setAttribute('aria-label', 'Reproducir');
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
    } else {
      estado.t = dia.hasta;
      pausar();
    }
  }
  pintar(true);
  requestAnimationFrame(fotograma);
}

el.play.addEventListener('click', () => (estado.reproduciendo ? pausar() : reproducir()));

el.velocidad.addEventListener('click', () => {
  estado.velocidad = (estado.velocidad + 1) % VELOCIDADES.length;
  el.velocidad.textContent = `×${2 ** estado.velocidad}`;
});

// ---------- Pintado del instante actual ----------

function pintar(moverCamara: boolean) {
  if (estado.vista !== 'dia') return;
  const t = estado.t;
  const momento = momentoEn(modelo, t);
  vista.actualizar(t, momento);
  if (estado.seguir) vista.seguir(momento, moverCamara);
  el.deslizador.value = String(Math.round((pct(t) / 100) * RESOLUCION));
  el.reloj.textContent = hora(t);
  pintarLineaTiempo(momento);

  const clave = claveDe(momento);
  if (clave !== estado.claveMomento) {
    estado.claveMomento = clave;
    pintarAhora(momento);
    marcarLista(momento);
  }
}

/** «Ahora» y «Después» a la derecha del margen. */
function pintarAhora(m: Momento) {
  let ahora: string;
  let despues: ParadaC | undefined;
  if (m.tipo === 'camino') {
    const tr = m.tramo;
    despues = tr.hasta;
    ahora = bloqueAhora(
      tr.hasta.id,
      `Camino de ${tr.hasta.p.nombre}`,
      `${TRANSPORTE[tr.modo]} · ${km(tr.km)}`,
      `llegada ${hora(tr.llegada)}`,
    );
  } else {
    const p = m.parada;
    despues = modelo.paradas[p.id + 1];
    ahora = bloqueAhora(p.id, p.p.nombre, p.p.local ?? '', `hasta ${hora(p.fin)}`);
  }
  el.ahora.innerHTML = `${ahora}<hr />${bloqueDespues(despues, m)}`;
}

function bloqueAhora(id: number, titulo: string, detalle: string, hasta = ''): string {
  return `<button type="button" class="bloque" data-abrir="${id}" aria-label="Ahora: ${esc(titulo)}">
    <span class="titulo"><mark>${esc(titulo)}</mark></span>
    ${detalle ? `<span class="detalle-ahora">${esc(detalle)}</span>` : ''}
    ${hasta ? `<span class="hasta">${esc(hasta)}</span>` : ''}
  </button>`;
}

function bloqueDespues(q: ParadaC | undefined, m: Momento): string {
  if (!q) return `<p class="bloque fin"><span class="titulo">Fin del viaje</span></p>`;
  const dia = diaActual();
  const cuando = q.dia === dia.idx ? hora(q.inicio) : `${fechaCorta(modelo.dias[q.dia].d.fecha)} ${hora(q.inicio)}`;
  // Parado: cómo se llega a lo siguiente. De camino: el nombre local del destino, que es lo útil al llegar.
  const tramo = m.tipo === 'parada' ? modelo.tramos.find((t) => t.hasta === q && !t.nulo) : undefined;
  const pie = tramo ? `${TRANSPORTE[tramo.modo]} · ${km(tramo.km)}` : (q.p.local ?? '');
  return `<button type="button" class="bloque siguiente" data-abrir="${q.id}" aria-label="Después: ${esc(q.p.nombre)} a las ${esc(cuando)}">
    <span class="titulo"><span class="cuando">${esc(cuando)}</span> ${esc(q.p.nombre)}</span>
    <span class="pie"><span>${esc(pie)}</span>${precioCorto(q)}</span>
  </button>`;
}

el.ahora.addEventListener('click', (e) => {
  const b = (e.target as HTMLElement).closest<HTMLElement>('[data-abrir]');
  if (!b) return;
  abrirFicha(modelo.paradas[Number(b.dataset.abrir)]);
});

/** Despliega la ficha de una parada en la lista sin mover la hora. */
function abrirFicha(p: ParadaC) {
  if (p.dia !== estado.dia && p !== diaActual().origen) seleccionarDia(p.dia, p.inicio, false);
  expandir(true);
  estado.abierta = p.id;
  marcarLista(momentoEn(modelo, estado.t));
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

function enlacesMapas(p: ParadaC): string {
  const [lng, lat] = p.pos;
  const nombre = encodeURIComponent(p.p.local ?? p.p.nombre);
  return `
    <a class="boton" href="https://uri.amap.com/marker?position=${lng},${lat}&name=${nombre}&coordinate=wgs84&callnative=1" target="_blank" rel="noopener">Amap</a>
    <a class="boton" href="https://maps.apple.com/?ll=${lat},${lng}&q=${encodeURIComponent(p.p.nombre)}" target="_blank" rel="noopener">Apple Maps</a>
    <a class="boton" href="https://www.google.com/maps/search/?api=1&query=${lat},${lng}" target="_blank" rel="noopener">Google Maps</a>`;
}

function filaParada(p: ParadaC, esOrigen: boolean): string {
  const q = p.p;
  const hotel = hotelDe(modelo, p);
  const aHotel = hotel && q.categoria !== 'hotel' ? distanciaKm(p.pos, hotel.pos) : null;
  const datos: [string, string][] = [];
  if (!esOrigen) datos.push(['Horario', `${hora(p.inicio)} – ${hora(p.fin)} (${duracion(p.fin - p.inicio)})`]);
  if (aHotel !== null) datos.push(['Hotel', `a ${km(aHotel)} en línea recta`]);
  if (q.direccion) datos.push(['Dirección', q.direccion]);
  if (q.direccionLocal) datos.push(['地址', q.direccionLocal]);
  if (q.reserva) datos.push(['Reserva', q.reserva]);
  const clases = ['parada', esOrigen && 'origen', q.opcional && 'opcional', q.categoria === 'hotel' && 'hotel'];
  return `
    <li class="${clases.filter(Boolean).join(' ')}" data-id="${p.id}">
      <button class="fila" type="button" aria-expanded="false">
        <span class="marca"><span>${p.n ?? 'H'}</span></span>
        <span class="hora-fila">${esOrigen ? '' : hora(p.inicio)}</span>
        <span class="texto">
          <span class="nombre">${esc(q.nombre)}</span>${q.local ? ` <span class="local">(${esc(q.local)})</span>` : ''}
          ${q.opcional ? '<span class="opcional-etiqueta">opcional</span>' : ''}
          ${esOrigen ? `<span class="salida">Salida ${hora(p.fin)}</span>` : ''}
        </span>
        ${esOrigen ? '' : precioCorto(p)}
      </button>
      <div class="detalle">
        ${q.notas && !esOrigen ? parrafos(q.notas, 'notas') : ''}
        ${datos.length ? `<dl>${datos.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join('')}</dl>` : ''}
        ${esOrigen ? '' : gastosHtml(q.gastos)}
        ${q.enlaces?.length && !esOrigen ? `<p class="enlaces">${enlacesHtml(q.enlaces)}</p>` : ''}
        <div class="acciones">
          ${q.local ? `<button type="button" class="boton tinta" data-taxi="${p.id}">Enseñar al taxista</button>` : ''}
          ${enlacesMapas(p)}
        </div>
      </div>
    </li>`;
}

/** Etiqueta con el gasto de la parada. */
function precioCorto(p: ParadaC): string {
  if (!p.p.gastos?.length) return '';
  const [min, max] = gastoTotal([p]);
  return `<span class="precio">${esc(yuanes(min, max, false))}</span>`;
}

function filaTramo(t: TramoC): string {
  const tiempo = `${t.estimado ? '~' : ''}${duracion(t.minutos)}`;
  const partes = t.nulo ? [TRANSPORTE[t.modo]] : [TRANSPORTE[t.modo], km(t.km), tiempo];
  return `
    <li class="tramo" data-tramo="${t.id}">
      <span>${partes.map(esc).join(' · ')}${t.detalle ? `<small>${esc(t.detalle)}</small>` : ''}</span>
    </li>`;
}

const paradas = (n: number) => `${n} parada${n === 1 ? '' : 's'}`;

function lineaGasto(lista: ParadaC[]): string {
  const [min, max] = gastoTotal(lista);
  if (!max) return '';
  return `<p class="cifras">Gasto previsto: <b>${esc(yuanes(min, max))}</b> por persona (entradas, comidas y trenes; sin taxis, metro ni compras)</p>`;
}

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
    </section>`;
  estado.claveMomento = '';
}

function marcarLista(m: Momento) {
  const actual = m.parada?.id ?? null;
  const abierta = estado.abierta ?? -1;
  for (const li of el.contenido.querySelectorAll<HTMLLIElement>('li.parada')) {
    const id = Number(li.dataset.id);
    const p = modelo.paradas[id];
    li.classList.toggle('actual', id === actual);
    li.classList.toggle('abierta', id === abierta);
    li.querySelector('.fila')?.setAttribute('aria-expanded', String(id === abierta));
    li.classList.toggle('hecha', p.inicio <= estado.t && id !== actual && !li.classList.contains('origen'));
  }
  for (const li of el.contenido.querySelectorAll<HTMLLIElement>('li.tramo')) {
    li.classList.toggle('actual', m.tramo?.id === Number(li.dataset.tramo));
  }
  if (estado.abierta === null) mostrarFila(el.contenido.querySelector('li.actual'));
}

/** Desplaza la lista para que se vea la fila, con la parada anterior encima como contexto. */
function mostrarFila(li: HTMLElement | null, suave = true) {
  if (!li) return;
  const c = el.contenido;
  const arriba = li.offsetTop;
  const abajo = arriba + li.offsetHeight;
  if (arriba >= c.scrollTop && abajo <= c.scrollTop + c.clientHeight) return;
  // Contexto: la parada anterior con el trayecto que lleva a ella, para no cortar ninguna línea.
  let previa = li.previousElementSibling as HTMLElement | null;
  while (previa && !previa.classList.contains('parada')) previa = previa.previousElementSibling as HTMLElement | null;
  const encima = previa?.previousElementSibling as HTMLElement | null;
  if (previa && encima?.classList.contains('tramo')) previa = encima;
  const conContexto = previa && abajo - previa.offsetTop <= c.clientHeight ? previa.offsetTop : arriba;
  c.scrollTo({ top: Math.max(0, conContexto - 6), behavior: suave ? 'smooth' : 'auto' });
}

el.contenido.addEventListener('click', (e) => {
  const objetivo = e.target as HTMLElement;
  const taxi = objetivo.closest<HTMLElement>('[data-taxi]');
  if (taxi) return mostrarTaxi(modelo.paradas[Number(taxi.dataset.taxi)]);
  const dia = objetivo.closest<HTMLElement>('[data-ir-dia]');
  if (dia) {
    expandir(false);
    return seleccionarDia(Number(dia.dataset.irDia));
  }
  const fila = objetivo.closest('.fila')?.closest<HTMLLIElement>('li.parada');
  if (!fila) return;
  const p = modelo.paradas[Number(fila.dataset.id)];
  const yaAbierta = fila.classList.contains('abierta');
  irAParada(p);
  estado.abierta = yaAbierta ? -1 : p.id;
  marcarLista(momentoEn(modelo, estado.t));
});

function irAParada(p: ParadaC) {
  pausar();
  const dia = diaActual();
  estado.t = p.dia === dia.idx ? p.inicio : dia.desde;
  estado.seguir = true;
  el.seguir.hidden = true;
  vista.enfocar(p);
  pintar(false);
}

/** Al tocar un marcador del mapa: se abre su ficha en la lista y se centra en lo que queda de mapa. */
function pulsarParada(p: ParadaC) {
  if (estado.vista === 'todo') seleccionarDia(p.dia, p.inicio, false);
  expandir(true);
  ajustarMargenes();
  irAParada(p);
  estado.abierta = p.id;
  estado.claveMomento = '';
  pintar(false);
  mostrarFila(el.contenido.querySelector(`li.parada[data-id="${p.id}"]`), false);
}

// ---------- Vista de todo el viaje ----------

function pintarResumen() {
  const visitas = modelo.paradas.filter((p) => p.n !== null).length;
  const total = modelo.tramos.reduce((s, t) => s + t.km, 0);
  el.ahora.innerHTML = `
    <div class="bloque viaje">
      <h2 class="titulo-viaje">${esc(modelo.titulo)}</h2>
      ${modelo.subtitulo ? `<p class="detalle-ahora">${esc(modelo.subtitulo)}</p>` : ''}
      <p class="cifras">${modelo.dias.length} días · ${paradas(visitas)} · ${esc(km(total))} en línea recta</p>
    </div>`;
  const hechos = pendientesHechos();
  el.contenido.scrollTop = 0;
  el.contenido.innerHTML = `
    ${lineaGasto(modelo.paradas)}
    <ol class="lista-dias">
      ${modelo.dias
        .map(
          (d) => `
        <li><button type="button" data-ir-dia="${d.idx}" style="--color:${d.color}">
          <span class="lomo">${d.idx + 1}</span>
          <span class="nombre"><b>${esc(fechaLarga(d.d.fecha))}${d.d.ciudad ? ` · ${esc(d.d.ciudad)}` : ''}</b><small>${esc(d.d.titulo)}</small></span>
          <span class="cifras">${paradas(d.paradas.filter((p) => p.n !== null).length)} · ${km(d.km)}${
            gastoTotal(d.paradas)[1] ? `<br>${esc(yuanes(...gastoTotal(d.paradas), false))}` : ''
          }</span>
        </button></li>`,
        )
        .join('')}
    </ol>
    ${
      modelo.pendientes.length
        ? `<section class="seccion">
            <h3>Pendiente de comprobar</h3>
            <ul class="pendientes">${modelo.pendientes
              .map(
                (t) => `<li><label><input type="checkbox" data-pendiente="${esc(t)}"${hechos.has(t) ? ' checked' : ''}>
                  <span>${esc(t)}</span></label></li>`,
              )
              .join('')}</ul>
          </section>`
        : ''
    }
    ${modelo.secciones
      .map(
        (sec) => `<section class="seccion">
          <h3>${esc(sec.titulo)}</h3>
          <ul>${sec.puntos.map((pt) => `<li>${esc(pt)}</li>`).join('')}</ul>
          ${sec.enlaces?.length ? `<div class="acciones">${enlacesHtml(sec.enlaces)}</div>` : ''}
        </section>`,
      )
      .join('')}`;
}

// Las casillas de pendientes se recuerdan en este móvil (no se comparten con otros).
const CLAVE_PENDIENTES = 'pendientes-hechos';
function pendientesHechos(): Set<string> {
  try {
    return new Set(JSON.parse(localStorage.getItem(CLAVE_PENDIENTES) ?? '[]'));
  } catch {
    return new Set();
  }
}

el.contenido.addEventListener('change', (e) => {
  const casilla = e.target as HTMLInputElement;
  const texto = casilla.dataset.pendiente;
  if (texto === undefined) return;
  const hechos = pendientesHechos();
  if (casilla.checked) hechos.add(texto);
  else hechos.delete(texto);
  try {
    localStorage.setItem(CLAVE_PENDIENTES, JSON.stringify([...hechos]));
  } catch {
    // Sin almacenamiento local: la casilla solo dura hasta recargar.
  }
});

// ---------- Panel desplegable ----------

function expandir(abrir = !estado.expandido) {
  estado.expandido = abrir;
  el.panel.classList.toggle('expandido', abrir);
  el.asa.setAttribute('aria-expanded', String(abrir));
  document.body.classList.toggle('panel-abierto', abrir);
  if (abrir && estado.vista === 'dia') {
    requestAnimationFrame(() => mostrarFila(el.contenido.querySelector('li.abierta, li.actual'), false));
  }
}

el.asa.addEventListener('click', () => expandir());

// Deslizar el panel arriba o abajo desde el asa o la cabecera.
let inicioToque: number | null = null;
for (const zona of [el.asa, el.cabecera]) {
  zona.addEventListener('touchstart', (e) => (inicioToque = e.touches[0].clientY), { passive: true });
  zona.addEventListener('touchend', (e) => {
    if (inicioToque === null) return;
    const dy = e.changedTouches[0].clientY - inicioToque;
    inicioToque = null;
    if (Math.abs(dy) > 30) {
      e.preventDefault();
      expandir(dy < 0);
    }
  });
}

// Lo que tapan la barra y el panel no cuenta como mapa visible.
const pantallaAncha = matchMedia('(min-width: 760px)');
function ajustarMargenes() {
  const ancha = pantallaAncha.matches;
  vista.fijarMargenes({
    top: el.barra.offsetHeight + 8,
    bottom: ancha ? 16 : el.panel.offsetHeight + 8,
    left: ancha ? el.panel.offsetWidth + 28 : 16,
    right: 60,
  });
  document.documentElement.style.setProperty('--alto-panel', ancha ? '0px' : `${el.panel.offsetHeight}px`);
}
new ResizeObserver(ajustarMargenes).observe(el.panel);
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
  vista.seguir(momentoEn(modelo, estado.t), true, true);
});

let descargando = false;
el.offline.classList.toggle('hecho', !!descargaAnterior());
el.offline.addEventListener('click', async () => {
  if (descargando) return;
  const previa = descargaAnterior();
  const pregunta = previa
    ? `Los mapas se guardaron el ${new Date(previa).toLocaleDateString('es-ES')}. ¿Volver a comprobarlos y completar lo que falte?`
    : 'Se guardarán la app y los mapas de todas las zonas del viaje para poder usarla sin conexión (unos 20–40 MB). ¿Continuar?';
  if (!confirm(pregunta)) return;
  descargando = true;
  el.offline.classList.add('cargando');
  try {
    const { fallos, total } = await descargarMapas(vista.mapa, modelo, (hechas, total) =>
      aviso(`Guardando mapas… ${Math.round((hechas / total) * 100)} %`, 0),
    );
    if (fallos) aviso(`No se pudieron guardar ${fallos} de ${total} piezas del mapa. Vuelve a intentarlo con mejor conexión.`);
    else aviso('Mapas guardados. La app funcionará sin conexión.');
    el.offline.classList.toggle('hecho', !fallos);
  } catch (e) {
    aviso(`No se pudieron guardar los mapas: ${(e as Error).message}`);
  } finally {
    descargando = false;
    el.offline.classList.remove('cargando');
  }
});

// ---------- Día / noche ----------

// La elección se recuerda en este móvil; por defecto, claro (se usa sobre todo de día, en la calle).
const CLAVE_TEMA = 'tema';
const metaColor = document.querySelector<HTMLMetaElement>('meta[name="theme-color"]')!;

function fijarTema(oscuro: boolean) {
  document.documentElement.dataset.tema = oscuro ? 'oscuro' : 'claro';
  metaColor.content = oscuro ? '#2a2119' : '#a8804f';
  el.tema.setAttribute('aria-pressed', String(oscuro));
  const texto = oscuro ? 'Modo día' : 'Modo noche';
  el.tema.title = texto;
  el.tema.setAttribute('aria-label', texto);
  vista.fijarTema(oscuro);
}

el.tema.addEventListener('click', () => {
  const oscuro = document.documentElement.dataset.tema !== 'oscuro';
  fijarTema(oscuro);
  try {
    localStorage.setItem(CLAVE_TEMA, oscuro ? 'oscuro' : 'claro');
  } catch {
    // Sin almacenamiento local: el modo dura hasta recargar.
  }
});

try {
  if (localStorage.getItem(CLAVE_TEMA) === 'oscuro') fijarTema(true);
} catch {
  // Sin almacenamiento local: se queda en modo día.
}

// ---------- Tarjeta para el taxista ----------

function mostrarTaxi(p: ParadaC) {
  $('taxi-texto').textContent = p.p.local ?? p.p.nombre;
  $('taxi-direccion').textContent = p.p.direccionLocal ?? '';
  $('taxi-nombre').textContent = p.p.nombre;
  el.taxi.hidden = false;
}
el.taxi.addEventListener('click', () => (el.taxi.hidden = true));

// ---------- Avisos ----------

let temporizadorAviso = 0;
function aviso(texto: string, ms = 4000) {
  el.toast.textContent = texto;
  el.toast.hidden = false;
  clearTimeout(temporizadorAviso);
  if (ms) temporizadorAviso = window.setTimeout(() => (el.toast.hidden = true), ms);
}

if (modelo.ejemplo || modelo.avisos.length) {
  el.aviso.hidden = false;
  el.aviso.textContent = modelo.avisos.length
    ? `${modelo.avisos.length} aviso(s) en el itinerario: ${modelo.avisos[0]}`
    : 'Itinerario de ejemplo';
}

// ---------- Arranque ----------

// Si hoy es un día del viaje (hora de China), se abre ese día a la hora actual.
// Durante el viaje el mapa arranca sobre el tramo de ahora; antes, con el día entero.
const hoy = ahoraEnChina();
const hoyIdx = modelo.dias.findIndex((d) => d.d.fecha === hoy.fecha);
function arrancar() {
  if (estado.vista === 'todo') return verTodo();
  if (hoyIdx < 0) return seleccionarDia(estado.dia, estado.t);
  seleccionarDia(estado.dia, estado.t, false);
  ajustarMargenes();
  vista.seguir(momentoEn(modelo, estado.t), true, true);
}
estado.dia = Math.max(hoyIdx, 0);
estado.t = hoyIdx >= 0 ? hoy.min : modelo.dias[0].desde;
arrancar();
// La lista y la línea de tiempo funcionan desde el principio; la ruta se dibuja cuando carga el mapa.
vista.listo.then(arrancar);
registrarServiceWorker();
