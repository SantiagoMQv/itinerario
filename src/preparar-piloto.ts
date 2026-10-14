import { itinerario } from './datos/itinerario';
import { crearClienteListadoFotos } from './fotos-listado';
import type { ComposicionItinerario } from './main';
import { crearPerfilPiloto } from './perfil-piloto';
import { copiarPlanPortable } from './portabilidad';

/**
 * Comprobación previa del piloto privado, SIN la app (de main solo importa el tipo): perfil explícito, origen exacto de
 * la página y plan real. Devuelve la composición que recibirá la app o lanza sin haber abierto nada. La usan la entrada
 * del piloto en el navegador y el build privado en Node, que así rechaza un perfil antes de construir.
 */
export function prepararPiloto(datos: unknown, origenPagina: string): ComposicionItinerario {
  // Perfil validado, copiado por valor y congelado: nada de la entrada queda enlazado con lo que recibe la app.
  const perfil = crearPerfilPiloto(datos);
  if (perfil.origen !== origenPagina) throw new Error('El perfil del piloto es de otro origen.');
  // Plan REAL: la fábrica del catálogo cobra su D (y en el navegador vuelve a comprobar location.origin).
  // Sin red ni temporizadores: http null y se cierra sin haber listado nada.
  crearClienteListadoFotos({ plan: itinerario, origen: perfil.origen, presupuesto: perfil.respaldo.listado, http: null }).cerrar();
  // Catálogo del plan para la copia de este móvil, sin abrir almacenes. Lo que ocupen las copias o las
  // importaciones solo se sabe al hacerlas a mano; esta comprobación no lo garantiza.
  copiarPlanPortable(itinerario);
  return { respaldo: perfil.respaldo, portabilidad: perfil.portabilidad };
}
