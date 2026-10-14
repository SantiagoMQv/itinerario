import { itinerario } from '../src/datos/itinerario';
import { crearProgreso } from '../src/progreso';
import { serializarProgreso } from '../src/progreso-json';
import { esInstantaneaProgreso } from '../src/progreso-validacion';
import type { Itinerario } from '../src/tipos';

/** Literal PostgreSQL explícito: conserva barras y comillas sin depender de la sesión SQL. */
const literal = (texto: string) => "E'" + texto.replace(/\\/g, '\\\\').replace(/'/g, "''") + "'::TEXT";

/** Semilla PURA; no abre conexiones ni conoce credenciales o recursos del proveedor. */
export function crearSemillaPiloto(plan: Itinerario = itinerario) {
  const estado = crearProgreso(plan);
  if (!esInstantaneaProgreso(plan, { revisionServidor: 0, estado })) {
    throw new Error('La instantánea inicial no es válida.');
  }
  if (plan.id.includes('\0') || new TextEncoder().encode(plan.id).length > 128) {
    throw new Error('La identidad del viaje no cabe en el esquema SQL.');
  }
  const parametros = { id: estado.viajeId, revision_servidor: 0,
    estado_json: serializarProgreso(estado) };
  const cuerpo = `BEGIN
  LOCK TABLE itinerario.viajes IN EXCLUSIVE MODE;
  IF EXISTS (SELECT 1 FROM itinerario.viajes WHERE id = ${literal(parametros.id)}) THEN
    RAISE EXCEPTION 'La raíz del viaje ya existe; detener el bootstrap.';
  END IF;
  INSERT INTO itinerario.viajes (id, revision_servidor, estado_json)
    VALUES (${literal(parametros.id)}, 0, ${literal(parametros.estado_json)});
END;`;
  // La etiqueta del bloque no puede aparecer dentro del texto del dominio.
  let etiqueta = '$semilla$';
  while (cuerpo.includes(etiqueta)) etiqueta = etiqueta.replace(/\$$/, '_$');
  return { parametros, sql: `-- Semilla inicial: ejecutar solamente en la base dedicada verificada.\nDO ${etiqueta}\n${cuerpo}\n${etiqueta};\n` };
}
