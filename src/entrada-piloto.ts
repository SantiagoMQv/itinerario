import { arrancarItinerario } from './main';
import { prepararPiloto } from './preparar-piloto';

/**
 * Entrada del piloto privado, todavía sin usar: ningún HTML la carga y no arranca nada al importarla.
 * Antes de llamar a la app comprueba el perfil explícito, el origen de la página y el plan real (src/preparar-piloto.ts);
 * si algo falla, lanza sin haber arrancado nada y se puede volver a llamar con un perfil corregido.
 * Importarla sí importa la app real (src/main.ts) con sus estilos y la biblioteca del mapa, que al evaluarse
 * configura su worker y crea un lienzo sin enlazar: no es un entorno libre de todo efecto.
 * La política la decide quien llama: aquí no hay valores por defecto, flags, entorno, URL ni sesión. El piloto comparte
 * el progreso con su servidor (`/api/progreso`, mismo origen) con un cliente explícito; la web publicada no lo tiene.
 */
export function arrancarPiloto(datos: unknown, origenPagina: string): void {
  arrancarItinerario({ ...prepararPiloto(datos, origenPagina), progreso: { http: (url, opciones) => fetch(url, opciones) } });
}
