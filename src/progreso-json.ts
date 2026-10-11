const ERROR_JSON = 'Datos JSON de progreso inválidos.';
// Límite de transporte, no de esquema DTO: evita depender de la pila del motor.
const PROFUNDIDAD_MAXIMA = 512;

function codificar(valor: unknown, ancestros: Set<object>, profundidad: number): string {
  if (profundidad > PROFUNDIDAD_MAXIMA) throw new Error(ERROR_JSON);
  if (valor === null) return 'null';
  if (typeof valor === 'string' || typeof valor === 'boolean') return JSON.stringify(valor);
  if (typeof valor === 'number') {
    if (!Number.isFinite(valor)) throw new Error(ERROR_JSON);
    return Object.is(valor, -0) ? '-0' : JSON.stringify(valor);
  }
  if (typeof valor !== 'object' || ancestros.has(valor)) throw new Error(ERROR_JSON);
  const arreglo = Array.isArray(valor);
  const prototipo = Object.getPrototypeOf(valor);
  if (prototipo !== null && prototipo !== (arreglo ? Array.prototype : Object.prototype)) {
    throw new Error(ERROR_JSON);
  }
  // Leer únicamente descriptores propios: jamás ejecutar accesores ni toJSON.
  // Un Proxy puede ejecutar trampas de reflexión; los errores se ocultan en la frontera pública.
  const campos = Reflect.ownKeys(valor).map((clave) => {
    const descriptor = Object.getOwnPropertyDescriptor(valor, clave);
    if (typeof clave !== 'string' || !descriptor || !Object.hasOwn(descriptor, 'value')) {
      throw new Error(ERROR_JSON);
    }
    return { clave, valor: descriptor.value as unknown };
  });
  ancestros.add(valor);
  try {
    if (arreglo) {
      const longitud = campos.find((campo) => campo.clave === 'length')?.valor;
      if (typeof longitud !== 'number' || !Number.isSafeInteger(longitud) || longitud < 0
        || campos.length !== longitud + 1) throw new Error(ERROR_JSON);
      const indices = new Map(campos.map((campo) => [campo.clave, campo.valor]));
      const elementos: string[] = [];
      for (let i = 0; i < longitud; i++) {
        if (!indices.has(String(i))) throw new Error(ERROR_JSON);
        elementos.push(codificar(indices.get(String(i)), ancestros, profundidad + 1));
      }
      return '[' + elementos.join(',') + ']';
    }
    return '{' + campos.map((campo) => JSON.stringify(campo.clave) + ':'
      + codificar(campo.valor, ancestros, profundidad + 1)).join(',') + '}';
  } finally {
    // Una referencia compartida acíclica puede aparecer nuevamente en otra rama.
    ancestros.delete(valor);
  }
}

/** JSON de dominio sin pérdida del signo de cero; incluye datos propios ocultos.
 * No es el códec de respaldos legados (Map/NaN/Blob), ni reemplaza los guards DTO.
 * T4 debe usarlo también al enviar; SQL debe conservar este texto opaco, no JSONB.
 */
export function serializarProgreso(valor: unknown): string {
  try { return codificar(valor, new Set(), 0); } catch { throw new Error(ERROR_JSON); }
}

/** JSON nativo: última clave duplicada gana; no hay normalización ni validación de esquema.
 * Rechaza desbordamientos numéricos y no expone mensajes del parser ni el texto recibido.
 */
export function parsearProgreso(texto: unknown): unknown {
  try {
    if (typeof texto !== 'string') throw new Error(ERROR_JSON);
    const valor: unknown = JSON.parse(texto);
    // Mismo recorrido finito/denso, sin un segundo validador de esquemas de progreso.
    codificar(valor, new Set(), 0);
    return valor;
  } catch { throw new Error(ERROR_JSON); }
}
