import datos from 'virtual:perfil-privado';
import { arrancarItinerario } from './main';
import { prepararPiloto } from './preparar-piloto';

// Entrada del montaje privado LOCAL (npm run build:privado): solo la carga el index.html de ese build, nunca la web
// publicada. El build ya validó el perfil; aquí se vuelve a comprobar con el origen REAL de la página antes de arrancar
// la app, y si no vale lanza sin haber arrancado nada (cómo se presenta ese caso es otra unidad).
arrancarItinerario(prepararPiloto(datos, location.origin));
