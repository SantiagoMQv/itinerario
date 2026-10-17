/**
 * Página pública /entrar: la única que se sirve sin sesión. Todo va dentro de la respuesta (HTML,
 * estilos y scripts con un nonce propio), porque los archivos de la app solo salen con sesión.
 * La página no inicia sesión por sí misma: envía la contraseña a POST /api/sesion y, si la API
 * confirma la sesión, va a «/». No refleja nada de la solicitud (ni query, ni cabeceras, ni cookie).
 */

/**
 * Clave de localStorage con la identidad estable de este móvil (un UUID). Es un metadato para
 * distinguir móviles y sus cambios: NO autoriza nada; la autorización es la cookie de sesión.
 */
export const CLAVE_IDENTIFICADOR_DISPOSITIVO = 'identificador-dispositivo';

/** Pasado este tiempo sin respuesta se deja de esperar (la entrada pudo completarse igualmente). */
const ESPERA_MAXIMA_MS = 30_000;

// Tokens del cuaderno de campo (DESIGN.md), sin la textura kraft ni Archivo: son archivos protegidos.
const NOCHE = `
  --papel: #121820;
  --reticula: rgba(126, 156, 196, 0.13);
  --tinta: #e8ecf2;
  --tinta-suave: #b0bacb;
  --borde-fuerte: rgba(232, 236, 242, 0.5);
  --margen: #ff6b72;
  --aviso: #ff8a8f;
  --kraft: #2a2119;
  --pestana: #4a3d2e;
  --campo: #1b2330;
  --tono: color-mix(in srgb, #2453d1 62%, #ffffff);
  --sombra-rgb: 0, 0, 0;
  color-scheme: dark;`;

const ESTILOS = `
:root {
  --papel: #ffffff;
  --reticula: #dce7f2;
  --tinta: #14213d;
  --tinta-suave: #46526a;
  --tinta-fija: #14213d;
  --borde-fuerte: rgba(20, 33, 61, 0.55);
  --margen: #e0454d;
  --aviso: #b8323a;
  --fluor: #ddf94a;
  --kraft: #a8804f;
  --pestana: #efe3d2;
  --campo: #ffffff;
  --tono: #2453d1;
  --sombra-rgb: 20, 33, 61;
  --izq: env(safe-area-inset-left, 0px);
  --der: env(safe-area-inset-right, 0px);
  --fuente: 'Archivo Variable', 'Archivo', system-ui, -apple-system, 'Segoe UI', Roboto, 'PingFang SC',
    'Hiragino Sans GB', 'Noto Sans SC', 'Microsoft YaHei', sans-serif;
  color-scheme: light;
}
:root[data-tema='oscuro'] {${NOCHE}
}
@media (prefers-color-scheme: dark) {
  :root:not([data-tema]) {${NOCHE}
  }
}
* { box-sizing: border-box; }
[hidden] { display: none !important; }
html { -webkit-text-size-adjust: 100%; }
body {
  margin: 0;
  min-height: 100vh;
  min-height: 100dvh;
  background-color: var(--papel);
  background-image: linear-gradient(var(--reticula) 1px, transparent 1px),
    linear-gradient(90deg, var(--reticula) 1px, transparent 1px);
  background-size: 12px 12px;
  background-position: -1px -1px;
  color: var(--tinta);
  font-family: var(--fuente);
  font-variant-numeric: tabular-nums;
  -webkit-font-smoothing: antialiased;
  -webkit-tap-highlight-color: transparent;
}
::selection { background: var(--fluor); color: var(--tinta-fija); }
:focus-visible { outline: 2.5px solid var(--tono); outline-offset: 2px; }

/* Tapa de cartón con una sola pestaña: la del cuaderno cerrado. */
.tapa {
  display: flex;
  align-items: flex-end;
  height: calc(54px + env(safe-area-inset-top, 0px));
  padding: env(safe-area-inset-top, 0px) calc(16px + var(--der)) 0 calc(16px + var(--izq));
  background: var(--kraft);
  box-shadow: 0 1px 0 rgba(var(--sombra-rgb), 0.25);
}
.pestana {
  display: inline-flex;
  align-items: center;
  height: 42px;
  padding: 0 16px;
  border-radius: 9px 9px 0 0;
  background: var(--pestana);
  color: var(--tinta);
  font-size: 15px;
  font-weight: 700;
  box-shadow: 0 -2px 6px rgba(20, 16, 10, 0.28);
}

/* Página con margen rojo, como la hoja del cuaderno. */
.pagina {
  position: relative;
  max-width: 480px;
  /* El margen rojo llega hasta el pie de la pantalla, como en la hoja. */
  min-height: calc(100dvh - 54px - env(safe-area-inset-top, 0px));
  margin: 0 auto;
  padding: 28px calc(16px + var(--der)) calc(32px + env(safe-area-inset-bottom, 0px)) calc(38px + var(--izq));
}
.pagina::before {
  content: '';
  position: absolute;
  top: 0;
  bottom: 0;
  left: calc(22px + var(--izq));
  width: 1.5px;
  background: var(--margen);
}
h1 {
  margin: 0 0 8px;
  font-size: 28px;
  font-weight: 800;
  font-stretch: 75%;
  line-height: 1.05;
  letter-spacing: -0.01em;
  text-wrap: balance;
}
.entradilla {
  max-width: 36ch;
  margin: 0 0 24px;
  color: var(--tinta-suave);
  font-size: 15.5px;
  line-height: 1.45;
  text-wrap: pretty;
}
.campo { margin: 0 0 20px; }
label {
  display: block;
  margin: 0 0 6px;
  font-size: 16px;
  font-weight: 700;
  line-height: 1.25;
}
.opcional { color: var(--tinta-suave); font-weight: 500; }
.ayuda {
  margin: -2px 0 8px;
  color: var(--tinta-suave);
  font-size: 14px;
  line-height: 1.35;
}
.fila-clave { display: flex; gap: 8px; }
input {
  flex: 1;
  width: 100%;
  min-width: 0;
  min-height: 48px;
  margin: 0;
  padding: 0 12px;
  border: 1.5px solid var(--borde-fuerte);
  border-radius: 8px;
  background: var(--campo);
  color: var(--tinta);
  caret-color: var(--tinta);
  font: 600 17px/1.2 var(--fuente);
}
input[aria-invalid='true'] { border-color: var(--aviso); box-shadow: inset 0 0 0 1px var(--aviso); }
input:read-only { color: var(--tinta-suave); }
input:-webkit-autofill {
  -webkit-text-fill-color: var(--tinta);
  box-shadow: inset 0 0 0 40px var(--campo);
}
.boton {
  display: inline-flex;
  flex: none;
  align-items: center;
  justify-content: center;
  gap: 6px;
  min-width: 48px;
  min-height: 48px;
  margin: 0;
  padding: 0 14px;
  border: 1.5px solid var(--borde-fuerte);
  border-radius: 8px;
  background: var(--papel);
  color: var(--tinta);
  font: 650 15px/1.2 var(--fuente);
  text-decoration: none;
  cursor: pointer;
}
.boton svg {
  width: 20px;
  height: 20px;
  fill: none;
  stroke: currentColor;
  stroke-width: 2;
  stroke-linecap: round;
  stroke-linejoin: round;
}
.boton[aria-pressed='true'] { border-color: var(--tinta); box-shadow: inset 0 0 0 1px var(--tinta); }
.boton[aria-pressed='true'] .ojo, .boton[aria-pressed='false'] .ojo-tachado { display: none; }
.boton.tinta {
  width: 100%;
  min-height: 52px;
  border-color: var(--tinta);
  background: var(--tinta);
  color: var(--papel);
  font-size: 16.5px;
  font-weight: 700;
}
.boton.tinta[aria-disabled='true'] { cursor: progress; }
.boton:active { transform: translateY(1px); }
@media (hover: hover) {
  .boton:hover { border-color: var(--tinta); }
  .boton.tinta:hover { background: color-mix(in srgb, var(--tinta) 86%, var(--papel)); }
}
.error {
  margin: 8px 0 0;
  color: var(--aviso);
  font-size: 14.5px;
  font-weight: 650;
  line-height: 1.35;
}
/* Avisos que informan sin alarmar: papel con borde discontinuo, como «Sin conexión». */
.nota, .resultado p {
  margin: 0 0 16px;
  padding: 9px 11px;
  border: 1.5px dashed var(--borde-fuerte);
  border-radius: 8px;
  background: var(--papel);
  font-size: 14.5px;
  line-height: 1.4;
}
.nota { color: var(--tinta-suave); }
.campo .nota { margin: 10px 0 0; }
.resultado p { margin: 14px 0 0; border-style: solid; color: var(--tinta); font-size: 15px; }
.resultado p:empty { display: none; }
.resultado .boton { margin-top: 10px; }
.estado { margin: 12px 0 0; color: var(--tinta-suave); font-size: 14.5px; }
.estado:empty { display: none; }
.pie {
  margin: 28px 0 0;
  color: var(--tinta-suave);
  font-size: 14px;
  line-height: 1.4;
}
.sr {
  position: absolute;
  width: 1px;
  height: 1px;
  overflow: hidden;
  clip-path: inset(50%);
  white-space: nowrap;
}
`;

// Tema elegido en este móvil (la misma clave «tema» que la app, solo lectura); si no, el del sistema.
const SCRIPT_TEMA = String.raw`(() => {
  const raiz = document.documentElement;
  const sistemaOscuro = matchMedia('(prefers-color-scheme: dark)');
  let elegido = null;
  try { elegido = JSON.parse(localStorage.getItem('tema') ?? 'null'); } catch { elegido = null; }
  const aplicar = () => {
    const oscuro = elegido === 'oscuro' || (elegido !== 'claro' && sistemaOscuro.matches);
    raiz.dataset.tema = oscuro ? 'oscuro' : 'claro';
    document.querySelector('meta[name="theme-color"]')?.setAttribute('content', oscuro ? '#2a2119' : '#a8804f');
  };
  aplicar();
  sistemaOscuro.addEventListener('change', aplicar);
})();`;

const SCRIPT_ENTRADA = String.raw`document.addEventListener('DOMContentLoaded', () => {
  'use strict';
  const CLAVE_DISPOSITIVO = ${JSON.stringify(CLAVE_IDENTIFICADOR_DISPOSITIVO)};
  const ESPERA_MAXIMA_MS = ${ESPERA_MAXIMA_MS};
  const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
  const TEXTOS = {
    claveVacia: 'Escribe la contraseña del viaje.',
    claveIncorrecta: 'La contraseña no es correcta. Revísala y vuelve a intentarlo.',
    nombreIlegible: 'El nombre tiene caracteres que no se pueden guardar. Escríbelo de otra forma.',
    nombreLargo: 'El nombre puede tener como máximo 80 caracteres.',
    comprobando: 'Comprobando la contraseña…',
    entrando: 'Contraseña aceptada. Abriendo el itinerario…',
    demasiados: 'Demasiados intentos seguidos. Espera unos minutos antes de volver a intentarlo.',
    rechazada: 'No se pudo entrar: el servidor no aceptó la solicitud. Recarga la página y vuelve a intentarlo.',
    noConfirmada: 'No se pudo confirmar la entrada. Puede que se haya completado igualmente: abre el itinerario para comprobarlo o vuelve a intentarlo.',
    sinRespuesta: 'No llegó respuesta del servidor. Puede que la entrada se haya completado igualmente: abre el itinerario para comprobarlo o vuelve a intentarlo.',
    sinConexion: 'Sin conexión: para entrar en este móvil hace falta internet. Esta página no cambia lo que este móvil ya tenga guardado.',
    conexion: 'Sin conexión. Para entrar hace falta internet.',
    almacen: 'Este navegador no deja guardar datos aquí: el identificador de este móvil solo durará mientras esta página siga abierta. Puedes entrar igualmente.',
  };
  const $ = (id) => document.getElementById(id);
  const formulario = $('entrada');
  const clave = $('clave');
  const nombre = $('nombre');
  const ver = $('ver-clave');
  const entrar = $('entrar');
  const errorClave = $('error-clave');
  const errorNombre = $('error-nombre');
  const estado = $('estado');
  const resultado = $('resultado-texto');
  const abrir = $('abrir');
  const conexion = $('conexion');

  const mostrar = (elemento, texto) => { elemento.textContent = texto; elemento.hidden = false; };
  const ocultar = (elemento) => { elemento.textContent = ''; elemento.hidden = true; };

  function nuevoIdentificador() {
    if (typeof crypto.randomUUID === 'function') return crypto.randomUUID();
    const b = crypto.getRandomValues(new Uint8Array(16));
    b[6] = (b[6] & 0x0f) | 0x40;
    b[8] = (b[8] & 0x3f) | 0x80;
    const h = Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
    return h.slice(0, 8) + '-' + h.slice(8, 12) + '-' + h.slice(12, 16) + '-' + h.slice(16, 20) + '-' + h.slice(20);
  }
  // Identidad estable del móvil. Si no se puede guardar, vale solo para esta visita, y se dice.
  const dispositivo = (() => {
    try {
      const guardado = localStorage.getItem(CLAVE_DISPOSITIVO);
      if (guardado !== null && UUID.test(guardado)) return { id: guardado, duradero: true };
      const id = nuevoIdentificador();
      localStorage.setItem(CLAVE_DISPOSITIVO, id);
      if (localStorage.getItem(CLAVE_DISPOSITIVO) === id) return { id, duradero: true };
    } catch { /* Almacenamiento bloqueado o lleno. */ }
    return { id: nuevoIdentificador(), duradero: false };
  })();
  if (!dispositivo.duradero) mostrar($('aviso-almacen'), TEXTOS.almacen);

  // Sin normalizar ni recortar: lo que no se puede guardar tal cual se rechaza aquí.
  function bienFormado(texto) {
    for (let i = 0; i < texto.length; i++) {
      const u = texto.charCodeAt(i);
      if (u >= 0xd800 && u <= 0xdbff) {
        const s = texto.charCodeAt(i + 1);
        if (!(s >= 0xdc00 && s <= 0xdfff)) return false;
        i++;
      } else if (u >= 0xdc00 && u <= 0xdfff) return false;
    }
    return true;
  }
  function problemaNombre(texto) {
    if (texto === '') return null;
    if (texto.includes('\u0000') || !bienFormado(texto)) return TEXTOS.nombreIlegible;
    if (Array.from(texto).length > 80) return TEXTOS.nombreLargo;
    return null;
  }

  const plano = (v) => v !== null && typeof v === 'object' && Object.getPrototypeOf(v) === Object.prototype;
  const camposExactos = (v, requeridos, opcionales) => plano(v) &&
    requeridos.every((c) => Object.hasOwn(v, c)) &&
    Object.keys(v).every((c) => requeridos.includes(c) || opcionales.includes(c));
  const errorPublico = (datos) => camposExactos(datos, ['error'], []) && typeof datos.error === 'string';
  // Igual que identificador() en servidor/sesiones.ts: texto no vacío, UTF-8 exacto (sin sustitutos
  // sueltos) y como mucho 128 bytes. Sin recortar, normalizar ni prohibir más caracteres.
  function identificadorValido(valor) {
    if (typeof valor !== 'string' || valor.length === 0) return false;
    const bytes = new TextEncoder().encode(valor);
    return bytes.length <= 128 && new TextDecoder('utf-8', { fatal: true }).decode(bytes) === valor;
  }
  // Solo la sesión pública exacta de este móvil confirma la entrada.
  function sesionConfirmada(datos, enviado) {
    if (!camposExactos(datos, ['sesion'], [])) return false;
    const s = datos.sesion;
    const conNombre = Object.hasOwn(enviado, 'nombreDispositivo');
    return camposExactos(s, ['id', 'viajeId', 'dispositivoId', 'venceEn'], ['nombreDispositivo']) &&
      typeof s.id === 'string' && UUID.test(s.id) &&
      identificadorValido(s.viajeId) &&
      s.dispositivoId === enviado.dispositivoId &&
      Number.isSafeInteger(s.venceEn) && s.venceEn > 0 &&
      (conNombre ? s.nombreDispositivo === enviado.nombreDispositivo : !Object.hasOwn(s, 'nombreDispositivo'));
  }
  async function leerJson(respuesta) {
    const tipo = (respuesta.headers.get('Content-Type') || '').split(';')[0].trim().toLowerCase();
    if (tipo !== 'application/json') return undefined;
    try {
      const texto = await respuesta.text();
      return texto.length > 8192 ? undefined : JSON.parse(texto);
    } catch { return undefined; }
  }
  function desenlace(codigo, datos, enviado) {
    if (codigo === 201 && sesionConfirmada(datos, enviado)) return 'dentro';
    if (codigo === 401 && errorPublico(datos)) return 'clave';
    if (codigo === 429) return 'esperar';
    if ([400, 403, 413, 415].includes(codigo) && errorPublico(datos)) return 'rechazada';
    return 'no-confirmada';
  }

  let ocupado = false;
  function ocupar(si) {
    ocupado = si;
    for (const [elemento, atributo] of [[formulario, 'aria-busy'], [entrar, 'aria-disabled']]) {
      if (si) elemento.setAttribute(atributo, 'true');
      else elemento.removeAttribute(atributo);
    }
    entrar.textContent = si ? 'Entrando…' : 'Entrar';
    clave.readOnly = si;
    nombre.readOnly = si;
  }
  function limpiar() {
    for (const [campo, error] of [[clave, errorClave], [nombre, errorNombre]]) {
      campo.removeAttribute('aria-invalid');
      ocultar(error);
    }
    resultado.textContent = '';
    abrir.hidden = true;
    estado.textContent = '';
  }
  function marcarCampo(campo, error, texto) {
    campo.setAttribute('aria-invalid', 'true');
    mostrar(error, texto);
    campo.focus();
  }
  function avisar(texto, conAbrir) {
    resultado.textContent = texto;
    abrir.hidden = !conAbrir;
  }

  formulario.addEventListener('submit', async (evento) => {
    evento.preventDefault();
    if (ocupado) return;
    limpiar();
    const textoClave = clave.value;
    const textoNombre = nombre.value;
    if (textoClave === '') return marcarCampo(clave, errorClave, TEXTOS.claveVacia);
    const problema = problemaNombre(textoNombre);
    if (problema) return marcarCampo(nombre, errorNombre, problema);
    if (navigator.onLine === false) return avisar(TEXTOS.sinConexion, false);
    const cuerpo = { clave: textoClave, dispositivoId: dispositivo.id };
    if (textoNombre !== '') cuerpo.nombreDispositivo = textoNombre;
    ocupar(true);
    estado.textContent = TEXTOS.comprobando;
    const control = new AbortController();
    const reloj = setTimeout(() => control.abort(), ESPERA_MAXIMA_MS);
    let fin;
    try {
      const respuesta = await fetch('/api/sesion', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(cuerpo),
        mode: 'same-origin',
        credentials: 'same-origin',
        cache: 'no-store',
        redirect: 'error',
        // La política no-referrer convertiría Origin en null en este POST.
        // El referrer vacío omite Referer sin perder el Origin del mismo sitio.
        referrerPolicy: 'same-origin',
        referrer: '',
        signal: control.signal,
      });
      fin = desenlace(respuesta.status, await leerJson(respuesta), cuerpo);
    } catch {
      // Red caída o tiempo agotado: no se sabe si el servidor llegó a crear la sesión.
      fin = 'sin-respuesta';
    } finally {
      clearTimeout(reloj);
    }
    if (fin === 'dentro') {
      clave.value = '';
      clave.type = 'password';
      estado.textContent = TEXTOS.entrando;
      location.replace('/');
      return;
    }
    ocupar(false);
    estado.textContent = '';
    if (fin === 'clave') marcarCampo(clave, errorClave, TEXTOS.claveIncorrecta);
    else if (fin === 'esperar') avisar(TEXTOS.demasiados, false);
    else if (fin === 'rechazada') avisar(TEXTOS.rechazada, false);
    else if (fin === 'sin-respuesta') avisar(TEXTOS.sinRespuesta, true);
    else avisar(TEXTOS.noConfirmada, true);
  });

  ver.addEventListener('click', () => {
    const visible = ver.getAttribute('aria-pressed') !== 'true';
    ver.setAttribute('aria-pressed', String(visible));
    clave.type = visible ? 'text' : 'password';
  });

  const pintarConexion = () => (navigator.onLine === false ? mostrar(conexion, TEXTOS.conexion) : ocultar(conexion));
  addEventListener('online', pintarConexion);
  addEventListener('offline', pintarConexion);
  pintarConexion();
  // Al volver con «Atrás» desde la app, la página no se queda ocupada.
  addEventListener('pageshow', (evento) => { if (evento.persisted) { ocupar(false); limpiar(); } });
});`;

const OJO = '<path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12Z" /><circle cx="12" cy="12" r="3" />';

function pagina(nonce: string): string {
  return `<!doctype html>
<html lang="es">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="robots" content="noindex, nofollow">
<meta name="referrer" content="no-referrer">
<meta name="color-scheme" content="light dark">
<meta name="theme-color" content="#a8804f">
<title>Entrar · Itinerario</title>
<link rel="icon" href="data:,">
<style nonce="${nonce}">${ESTILOS}</style>
<script nonce="${nonce}">${SCRIPT_TEMA}</script>
<script nonce="${nonce}">${SCRIPT_ENTRADA}</script>
</head>
<body>
<header class="tapa"><span class="pestana">Itinerario</span></header>
<main class="pagina">
  <h1>Entrar en el itinerario</h1>
  <p class="entradilla">Escribe la contraseña del viaje para abrirlo en este móvil.</p>
  <p id="conexion" class="nota" role="status" hidden></p>
  <form id="entrada" method="post" action="/entrar" novalidate>
    <div class="campo">
      <label for="clave">Contraseña del viaje</label>
      <div class="fila-clave">
        <input id="clave" type="password" autocomplete="current-password" autocapitalize="none" autocorrect="off"
          spellcheck="false" required aria-describedby="error-clave">
        <button id="ver-clave" class="boton" type="button" aria-pressed="false" aria-controls="clave">
          <svg class="ojo" viewBox="0 0 24 24" aria-hidden="true">${OJO}</svg>
          <svg class="ojo-tachado" viewBox="0 0 24 24" aria-hidden="true">${OJO}<path d="M4 4l16 16" /></svg>
          Mostrar<span class="sr"> contraseña</span>
        </button>
      </div>
      <p id="error-clave" class="error" hidden></p>
    </div>
    <div class="campo">
      <label for="nombre">Nombre de este móvil <span class="opcional">(opcional)</span></label>
      <p id="ayuda-nombre" class="ayuda">Para distinguirlo del otro móvil, por ejemplo «Fold» o «iPhone».</p>
      <input id="nombre" type="text" autocomplete="off" enterkeyhint="go"
        aria-describedby="ayuda-nombre error-nombre aviso-almacen">
      <p id="error-nombre" class="error" hidden></p>
      <p id="aviso-almacen" class="nota" role="status" hidden></p>
    </div>
    <button id="entrar" class="boton tinta" type="submit">Entrar</button>
    <p id="estado" class="estado" role="status"></p>
    <div id="resultado" class="resultado" role="alert">
      <p id="resultado-texto"></p>
      <a id="abrir" class="boton" href="/" hidden>Abrir el itinerario</a>
    </div>
  </form>
  <p class="pie">Cada móvil entra por separado. Esta página no guarda la contraseña.</p>
</main>
</body>
</html>
`;
}

/** Nonce de 128 bits, nuevo en cada respuesta, para los estilos y scripts de esta página. */
function nonceNuevo(): string {
  return btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(16))));
}

function politicaContenido(nonce: string): string {
  return [
    "default-src 'none'",
    `script-src 'nonce-${nonce}'`,
    `style-src 'nonce-${nonce}'`,
    'img-src data:',
    "connect-src 'self'",
    "form-action 'self'",
    "base-uri 'none'",
    "frame-ancestors 'none'",
    "require-trusted-types-for 'script'",
  ].join('; ');
}

/**
 * Puerto `proveerRespuestaEntrada` del router (servidor/router.ts). Siempre 200 HTML, privado y sin
 * caché; nunca Set-Cookie ni autenticación. El router atiende /entrar solo con GET y HEAD.
 */
export async function proveerRespuestaEntrada(solicitud: Request): Promise<Response> {
  const nonce = nonceNuevo();
  return new Response(solicitud.method === 'HEAD' ? null : pagina(nonce), {
    status: 200,
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'private, no-store',
      Pragma: 'no-cache',
      'X-Content-Type-Options': 'nosniff',
      Vary: 'Cookie',
      'Referrer-Policy': 'no-referrer',
      'X-Frame-Options': 'DENY',
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Content-Security-Policy': politicaContenido(nonce),
    },
  });
}
