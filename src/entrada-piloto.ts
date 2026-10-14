import { itinerario } from './datos/itinerario';
import { crearClienteListadoFotos } from './fotos-listado';
import { arrancarItinerario } from './main';
import { crearPerfilPiloto } from './perfil-piloto';
import { copiarPlanPortable } from './portabilidad';

/**
 * Entrada del piloto privado, todavía sin usar: ningún HTML la carga y no arranca nada al importarla.
 * Antes de llamar a la app comprueba el perfil explícito, el origen de la página y el plan real; si algo
 * falla, lanza sin haber arrancado nada y se puede volver a llamar con un perfil corregido.
 * Importarla sí importa la app real (src/main.ts) con sus estilos y la biblioteca del mapa, que al evaluarse
 * configura su worker y crea un lienzo sin enlazar: no es un entorno libre de todo efecto.
 * La política la decide quien llama: aquí no hay valores por defecto, flags, entorno, URL ni sesión.
 */
export function arrancarPiloto(datos: unknown, origenPagina: string): void {
  // Perfil validado, copiado por valor y congelado: nada de la entrada queda enlazado con lo que recibe la app.
  const perfil = crearPerfilPiloto(datos);
  if (perfil.origen !== origenPagina) throw new Error('El perfil del piloto es de otro origen.');
  // Plan REAL: la fábrica del catálogo cobra su D (y en el navegador vuelve a comprobar location.origin).
  // Sin red ni temporizadores: http null y se cierra sin haber listado nada.
  crearClienteListadoFotos({ plan: itinerario, origen: perfil.origen, presupuesto: perfil.respaldo.listado, http: null }).cerrar();
  // Catálogo del plan para la copia de este móvil, sin abrir almacenes. Lo que ocupen las copias o las
  // importaciones solo se sabe al hacerlas a mano; esta comprobación no lo garantiza.
  copiarPlanPortable(itinerario);
  arrancarItinerario({ respaldo: perfil.respaldo, portabilidad: perfil.portabilidad });
}
