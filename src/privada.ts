import datos from 'virtual:perfil-privado';
import { arrancarItinerario, type ComposicionItinerario } from './main';
import { prepararPiloto } from './preparar-piloto';
import './privada.css';

// Entrada del montaje privado LOCAL (npm run build:privado): solo la carga el index.html de ese build, nunca la web
// publicada. El build ya validó el perfil; aquí se vuelve a comprobar con el origen REAL de la página antes de arrancar.

/** Motivos conocidos de la preparación, dichos para la página; cualquier otro error se resume con uno genérico (nunca
 * se enseña su texto ni los datos del perfil). */
const MOTIVOS: Readonly<Record<string, string>> = {
  'Perfil del piloto inválido.': 'el perfil no tiene la forma o los límites que espera la app.',
  'El perfil del piloto es de otro origen.': 'el perfil es para otra dirección web, no para la de esta página.',
  'No se puede preparar el listado de fotos.': 'los límites del perfil no admiten el plan de este itinerario.',
};

/** Solo informa: cambia la página por una explicación, sin botones, enlaces ni nada que arranque o guarde. */
function explicarConfiguracionInvalida(error: unknown): void {
  const motivo = error instanceof Error && Object.hasOwn(MOTIVOS, error.message)
    ? MOTIVOS[error.message] : 'no se pudo comprobar la configuración de este montaje.';
  // Tema del sistema, sin leer la preferencia guardada en este móvil.
  document.documentElement.dataset.tema = matchMedia('(prefers-color-scheme: dark)').matches ? 'oscuro' : 'claro';
  document.documentElement.classList.add('configuracion-invalida');
  document.title = 'Itinerario privado no disponible';
  const parrafo = (texto: string, clase = '') => Object.assign(document.createElement('p'), { textContent: texto, className: clase });
  const titulo = Object.assign(document.createElement('h1'), { id: 'configuracion-invalida-titulo',
    textContent: 'No se puede abrir el itinerario privado', tabIndex: -1 });
  const columna = Object.assign(document.createElement('div'), { className: 'columna' });
  columna.append(titulo,
    parrafo('La configuración con la que se preparó este montaje privado no vale para esta página, así que la app no ha arrancado.'),
    parrafo(`Motivo: ${motivo}`, 'motivo'),
    parrafo('Quien lo preparó tiene que revisar su perfil y volver a generar el montaje.'),
    parrafo('El arranque se ha detenido antes de abrir o guardar fotos y marcas en este móvil.', 'nota'));
  const pagina = document.createElement('main');
  pagina.className = 'papel';
  pagina.setAttribute('aria-labelledby', titulo.id);
  pagina.append(columna);
  document.body.replaceChildren(pagina);
  titulo.focus({ preventScroll: true });
}

let composicion: ComposicionItinerario | null = null;
try {
  composicion = prepararPiloto(datos, location.origin);
} catch (error) {
  explicarConfiguracionInvalida(error);
}
// FUERA del try: un fallo dentro de la app no es de configuración; se propaga como error y el arranque queda consumido.
if (composicion) arrancarItinerario(composicion);
