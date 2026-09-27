import './estilos.css';
import { itinerario } from './datos/itinerario';
import { ICONO_CATEGORIA, TRANSPORTE, ahoraEnChina, duracion, esc, fechaCorta, fechaLarga, hora, km } from './formato';
import { distanciaKm } from './geo';
import { VistaMapa } from './mapa';
import { type DiaC, type Momento, type ParadaC, type TramoC, construirModelo, hotelDe, momentoEn } from './modelo';
import { descargaAnterior, descargarMapas, registrarServiceWorker } from './offline';

const modelo = construirModelo(itinerario);
for (const a of modelo.avisos) console.warn(a);

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const el = {
  barra: $('barra'),
  dias: $('dias'),
  aviso: $('aviso'),
  panel: $('panel'),
  asa: $('asa'),
  controles: $('controles'),
  play: $<HTMLButtonElement>('btn-play'),
  anterior: $<HTMLButtonElement>('btn-anterior'),
  siguiente: $<HTMLButtonElement>('btn-siguiente'),
  velocidad: $<HTMLButtonElement>('btn-velocidad'),
  deslizador: $<HTMLInputElement>('deslizador'),
  marcas: $('marcas'),
  horaDesde: $('hora-desde'),
  horaHasta: $('hora-hasta'),
  estado: $('estado'),
  contenido: $('contenido'),
  encuadrar: $<HTMLButtonElement>('btn-encuadrar'),
  offline: $<HTMLButtonElement>('btn-offline'),
  seguir: $<HTMLButtonElement>('btn-seguir'),
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
  /** Parada desplegada en la lista: null = la actual, -1 = ninguna. */
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

function pintarDias() {
  const chips = [
    `<button type="button" class="chip${estado.vista === 'todo' ? ' activo' : ''}" data-dia="todo">
      <b>Todo</b><small>${modelo.dias.length} días</small></button>`,
    ...modelo.dias.map(
      (d) => `<button type="button" class="chip${estado.vista === 'dia' && estado.dia === d.idx ? ' activo' : ''}"
        data-dia="${d.idx}" style="--color:${d.color}">
        <b>Día ${d.idx + 1}</b><small>${esc(fechaCorta(d.d.fecha))}${d.d.ciudad && d.d.ciudad !== 'Shanghái' ? ` · ${esc(d.d.ciudad)}` : ''}</small>
      </button>`,
    ),
  ];
  el.dias.innerHTML = chips.join('');
  el.dias.querySelector('.activo')?.scrollIntoView({ inline: 'nearest', block: 'nearest' });
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

function prepararLineaTiempo(dia: DiaC) {
  el.deslizador.min = String(dia.desde);
  el.deslizador.max = String(dia.hasta);
  el.horaDesde.textContent = hora(dia.desde);
  el.horaHasta.textContent = hora(dia.hasta);
  const total = dia.hasta - dia.desde;
  const pct = (m: number) => ((Math.min(Math.max(m, dia.desde), dia.hasta) - dia.desde) / total) * 100;
  // Bloques de estancia en cada parada; los huecos entre bloques son los trayectos.
  el.marcas.innerHTML = [dia.origen, ...dia.paradas]
    .filter((p): p is ParadaC => !!p)
    .map((p) => {
      const desde = pct(p.inicio);
      const ancho = Math.max(pct(p.fin) - desde, 0.6);
      return `<span style="left:${desde}%;width:${ancho}%;--color:${dia.color}"></span>`;
    })
    .join('');
}

el.deslizador.addEventListener('input', () => {
  pausar();
  estado.t = Number(el.deslizador.value);
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
  const dia = diaActual();
  const t = estado.t;
  const momento = momentoEn(modelo, t);
  vista.actualizar(t, momento);
  if (estado.seguir) vista.seguir(momento, moverCamara);
  el.deslizador.value = String(t);
  el.marcas.style.setProperty('--avance', `${((t - dia.desde) / (dia.hasta - dia.desde)) * 100}%`);

  const clave = claveDe(momento);
  if (clave !== estado.claveMomento) {
    estado.claveMomento = clave;
    pintarEstado(momento);
    marcarLista(momento);
  }
  el.estado.querySelector('.hora-grande')!.textContent = hora(t);
}

function pintarEstado(m: Momento) {
  const dia = diaActual();
  let titulo: string;
  let detalle: string;
  if (m.tipo === 'camino') {
    const tr = m.tramo;
    titulo = `${TRANSPORTE[tr.modo].icono} Hacia ${esc(tr.hasta.p.nombre)}`;
    detalle = [TRANSPORTE[tr.modo].nombre, km(tr.km), `llegada ${hora(tr.llegada)}`].map(esc).join(' · ');
  } else {
    const p = m.parada;
    titulo = `${ICONO_CATEGORIA[p.p.categoria]} ${esc(p.p.nombre)}`;
    const horario = p.dia === dia.idx ? `${hora(p.inicio)}–${hora(p.fin)}` : `hasta ${hora(p.fin)}`;
    detalle = [horario, p.p.local].filter(Boolean).map((s) => esc(s!)).join(' · ');
  }
  el.estado.innerHTML = `
    <span class="hora-grande"></span>
    <span class="resumen"><b>${titulo}</b><small>${detalle}</small></span>
    <svg class="flecha" viewBox="0 0 24 24" aria-hidden="true"><path d="m6 15 6-6 6 6" /></svg>`;
}

// ---------- Lista del día ----------

function enlacesMapas(p: ParadaC): string {
  const [lng, lat] = p.pos;
  const nombre = encodeURIComponent(p.p.local ?? p.p.nombre);
  return `
    <a href="https://uri.amap.com/marker?position=${lng},${lat}&name=${nombre}&coordinate=wgs84&callnative=1" target="_blank" rel="noopener">Amap</a>
    <a href="https://maps.apple.com/?ll=${lat},${lng}&q=${encodeURIComponent(p.p.nombre)}" target="_blank" rel="noopener">Apple Maps</a>
    <a href="https://www.google.com/maps/search/?api=1&query=${lat},${lng}" target="_blank" rel="noopener">Google Maps</a>`;
}

function filaParada(p: ParadaC, dia: DiaC, esOrigen: boolean): string {
  const q = p.p;
  const hotel = hotelDe(modelo, p);
  const aHotel = hotel && q.categoria !== 'hotel' ? distanciaKm(p.pos, hotel.pos) : null;
  const datos: [string, string][] = [];
  if (!esOrigen) datos.push(['Horario', `${hora(p.inicio)} – ${hora(p.fin)} (${duracion(p.fin - p.inicio)})`]);
  if (aHotel !== null) datos.push(['Hotel', `a ${km(aHotel)} en línea recta`]);
  if (q.direccion) datos.push(['Dirección', q.direccion]);
  if (q.direccionLocal) datos.push(['地址', q.direccionLocal]);
  if (q.reserva) datos.push(['Reserva', q.reserva]);
  return `
    <li class="parada${esOrigen ? ' origen' : ''}" data-id="${p.id}" style="--color:${dia.color}">
      <button class="fila" type="button">
        <span class="num">${q.categoria === 'hotel' ? ICONO_CATEGORIA.hotel : p.n}</span>
        <span class="horas">${esOrigen ? 'Salida' : hora(p.inicio)}<small>${esOrigen ? hora(p.fin) : ''}</small></span>
        <span class="nombre">${esc(q.nombre)}${q.local ? `<small>${esc(q.local)}</small>` : ''}</span>
        <span class="cat" aria-hidden="true">${ICONO_CATEGORIA[q.categoria]}</span>
      </button>
      <div class="detalle">
        ${q.notas ? `<p class="notas">${esc(q.notas)}</p>` : ''}
        ${datos.length ? `<dl>${datos.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join('')}</dl>` : ''}
        <div class="acciones">
          ${q.local ? `<button type="button" class="btn-taxi" data-taxi="${p.id}">🀄 Enseñar al taxista</button>` : ''}
          ${enlacesMapas(p)}
        </div>
      </div>
    </li>`;
}

function filaTramo(t: TramoC): string {
  const tp = TRANSPORTE[t.modo];
  const tiempo = `${t.estimado ? '~' : ''}${duracion(t.minutos)}`;
  const partes = t.nulo ? [tp.nombre] : [tp.nombre, km(t.km), tiempo];
  return `
    <li class="tramo" data-tramo="${t.id}">
      <span class="icono" aria-hidden="true">${tp.icono}</span>
      <span>${partes.map(esc).join(' · ')}${t.detalle ? `<small>${esc(t.detalle)}</small>` : ''}</span>
    </li>`;
}

function pintarLista(dia: DiaC) {
  const visitas = dia.paradas.filter((p) => p.n !== null).length;
  const filas: string[] = [];
  if (dia.origen) filas.push(filaParada(dia.origen, dia, true));
  for (const p of dia.paradas) {
    const tramo = dia.tramos.find((t) => t.hasta === p);
    if (tramo) filas.push(filaTramo(tramo));
    filas.push(filaParada(p, dia, false));
  }
  el.contenido.innerHTML = `
    <header class="cabecera">
      <h2>Día ${dia.idx + 1} · ${esc(fechaLarga(dia.d.fecha))}</h2>
      <p>${esc(dia.d.titulo)}</p>
      <p class="cifras">${visitas} paradas · ${km(dia.km)} en línea recta</p>
    </header>
    <ol class="lista">${filas.join('')}</ol>`;
  estado.claveMomento = '';
}

function marcarLista(m: Momento) {
  const actual = m.parada?.id ?? null;
  const abierta = estado.abierta ?? actual;
  for (const li of el.contenido.querySelectorAll<HTMLLIElement>('li.parada')) {
    const id = Number(li.dataset.id);
    const p = modelo.paradas[id];
    li.classList.toggle('actual', id === actual);
    li.classList.toggle('abierta', id === abierta);
    li.classList.toggle('hecha', p.inicio <= estado.t && id !== actual && !li.classList.contains('origen'));
  }
  for (const li of el.contenido.querySelectorAll<HTMLLIElement>('li.tramo')) {
    li.classList.toggle('actual', m.tramo?.id === Number(li.dataset.tramo));
  }
  if (estado.expandido && estado.abierta === null) {
    el.contenido.querySelector('li.actual')?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }
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
  el.contenido.querySelector(`li.parada[data-id="${p.id}"]`)?.scrollIntoView({ block: 'nearest' });
}

// ---------- Vista de todo el viaje ----------

function pintarResumen() {
  const visitas = modelo.paradas.filter((p) => p.n !== null).length;
  const total = modelo.tramos.reduce((s, t) => s + t.km, 0);
  el.estado.innerHTML = `
    <span class="resumen"><b>${esc(modelo.titulo)}</b>
    <small>${modelo.dias.length} días · ${visitas} paradas · ${km(total)} en línea recta</small></span>
    <svg class="flecha" viewBox="0 0 24 24" aria-hidden="true"><path d="m6 15 6-6 6 6" /></svg>`;
  el.contenido.innerHTML = `
    <ol class="lista-dias">
      ${modelo.dias
        .map(
          (d) => `
        <li><button type="button" data-ir-dia="${d.idx}" style="--color:${d.color}">
          <span class="punto"></span>
          <span class="nombre"><b>Día ${d.idx + 1} · ${esc(fechaLarga(d.d.fecha))}</b><small>${esc(d.d.titulo)}</small></span>
          <span class="cifras">${d.paradas.filter((p) => p.n !== null).length} paradas<br>${km(d.km)}</span>
        </button></li>`,
        )
        .join('')}
    </ol>`;
}

// ---------- Panel desplegable ----------

function expandir(abrir = !estado.expandido) {
  estado.expandido = abrir;
  el.panel.classList.toggle('expandido', abrir);
  if (abrir && estado.vista === 'dia') {
    requestAnimationFrame(() =>
      el.contenido.querySelector('li.abierta, li.actual')?.scrollIntoView({ block: 'nearest' }),
    );
  }
}

el.asa.addEventListener('click', () => expandir());
el.estado.addEventListener('click', () => expandir());

// Deslizar el panel arriba o abajo desde el asa o el resumen.
let inicioToque: number | null = null;
for (const zona of [el.asa, el.estado]) {
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
    ? `⚠ ${modelo.avisos.length} aviso(s) en el itinerario: ${modelo.avisos[0]}`
    : 'Itinerario de ejemplo';
}

// ---------- Arranque ----------

// Si hoy es un día del viaje (hora de China), se abre ese día a la hora actual.
const hoy = ahoraEnChina();
const hoyIdx = modelo.dias.findIndex((d) => d.d.fecha === hoy.fecha);
if (hoyIdx >= 0) seleccionarDia(hoyIdx, hoy.min);
else seleccionarDia(0);
// La lista y la línea de tiempo funcionan desde el principio; la ruta se dibuja cuando carga el mapa.
vista.listo.then(() => {
  if (estado.vista === 'todo') verTodo();
  else seleccionarDia(estado.dia, estado.t);
});
registrarServiceWorker();
