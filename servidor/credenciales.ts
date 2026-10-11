export const NOMBRE_COOKIE_SESION = '__Host-itinerario';
const SEGUNDOS_DIA = 24 * 60 * 60;
const ERROR_CONFIGURACION = 'La configuración de credenciales no es válida.';
const ERROR_SISTEMA = 'No se pudo realizar la operación de credenciales.';
const codificador = new TextEncoder();

export interface ConfiguracionCredenciales {
  readonly viajeId: string;
  readonly claveCompartida: string;
}

type Criptografia = Pick<typeof globalThis.crypto, 'subtle' | 'getRandomValues'>;

// Antes del despliegue: generar 32 bytes CSPRNG en base64url fuera del repositorio.
// El límite de bytes NO demuestra entropía: no usar frases humanas débiles.
// La configuración futura viene del entorno privado del servidor, nunca de VITE_ ni de la app.
function bytesTexto(entrada: unknown, minimo: number, maximo: number): Uint8Array<ArrayBuffer> | null {
  if (typeof entrada !== 'string' || entrada.length > maximo) return null;
  // TextEncoder reemplaza sustitutos aislados: rechazarlos evita alias de Unicode.
  for (let i = 0; i < entrada.length; i++) {
    const unidad = entrada.charCodeAt(i);
    if (unidad >= 0xd800 && unidad <= 0xdbff) {
      const siguiente = entrada.charCodeAt(++i);
      if (!(siguiente >= 0xdc00 && siguiente <= 0xdfff)) return null;
    } else if (unidad >= 0xdc00 && unidad <= 0xdfff) return null;
  }
  const bytes = codificador.encode(entrada);
  return bytes.length >= minimo && bytes.length <= maximo ? bytes : null;
}

function base64url(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function componente(texto: string): Uint8Array<ArrayBuffer> | null {
  if (!/^[A-Za-z0-9_-]{43}$/.test(texto)) return null;
  const binario = atob(texto.replace(/-/g, '+').replace(/_/g, '/') + '=');
  const bytes = Uint8Array.from(binario, (letra) => letra.charCodeAt(0));
  return bytes.length === 32 && base64url(bytes) === texto ? bytes : null;
}

function partesToken(token: unknown) {
  if (typeof token !== 'string' || token.length !== 87) return null;
  const partes = token.split('.');
  if (partes.length !== 2) return null;
  const nonce = componente(partes[0]);
  const firma = componente(partes[1]);
  return nonce && firma ? { nonce: partes[0], firma } : null;
}

function tokenCookie(cabecera: string | null): string | null {
  if (typeof cabecera !== 'string' || cabecera.length > 8192 || /[\x00-\x08\x0a-\x1f\x7f]/.test(cabecera)) return null;
  let encontrado = false;
  let token: string | null = null;
  for (const fragmento of cabecera.split(';')) {
    const par = fragmento.replace(/^[ \t]+|[ \t]+$/g, '');
    const separador = par.indexOf('=');
    const nombre = separador < 0 ? par : par.slice(0, separador);
    if (nombre !== NOMBRE_COOKIE_SESION) continue;
    if (encontrado) return null;
    encontrado = true;
    token = separador < 0 ? null : par.slice(separador + 1);
  }
  return token;
}

// Esperar la fábrica antes de servir solicitudes; no hay inicialización en segundo plano.
export async function crearCredenciales(configuracion: ConfiguracionCredenciales, cripto: Criptografia = globalThis.crypto) {
  const viajeId = configuracion?.viajeId;
  const claveBytes = bytesTexto(configuracion?.claveCompartida, 32, 256);
  if (!bytesTexto(viajeId, 1, 128) || !claveBytes) throw new Error(ERROR_CONFIGURACION);

  // JSON codifica cada campo sin ambigüedad; versión, propósito y viaje son obligatorios.
  const dominio = (proposito: string, nonce?: string) => codificador.encode(JSON.stringify(
    nonce === undefined ? ['itinerario', 'v1', proposito, viajeId] : ['itinerario', 'v1', proposito, viajeId, nonce],
  ));
  const importarClave = async (bytes: Uint8Array<ArrayBuffer>, usos: ('sign' | 'verify')[]) => {
    // SHA-256 fija 32 bytes: el relleno nativo de HMAC no debe igualar claves con NUL finales.
    const derivada = await cripto.subtle.digest('SHA-256', bytes);
    return cripto.subtle.importKey('raw', derivada, { name: 'HMAC', hash: 'SHA-256' }, false, usos);
  };
  const huellaToken = async (token: string) => {
    const bytes = new Uint8Array(await cripto.subtle.digest('SHA-256', codificador.encode(token)));
    return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
  };

  try {
    const clave = await importarClave(claveBytes, ['sign', 'verify']);
    const dominioClave = dominio('prueba-clave');
    const pruebaClave = await cripto.subtle.sign('HMAC', clave, dominioClave);

    return Object.freeze({
      async verificarClave(entrada: unknown): Promise<boolean> {
        const candidata = bytesTexto(entrada, 32, 256);
        if (!candidata) return false;
        try {
          const claveCandidata = await importarClave(candidata, ['verify']);
          // Comparación criptográfica nativa, sin comparación propia de claves ni bytes secretos.
          return await cripto.subtle.verify('HMAC', claveCandidata, pruebaClave, dominioClave);
        } catch { throw new Error(ERROR_SISTEMA); }
      },

      async emitirSesion(): Promise<{ token: string; huella: string }> {
        try {
          const nonce = base64url(cripto.getRandomValues(new Uint8Array(32)));
          const firma = await cripto.subtle.sign('HMAC', clave, dominio('sesion', nonce));
          const token = `${nonce}.${base64url(new Uint8Array(firma))}`;
          // token exclusivamente para Set-Cookie; persistir solamente huella, nunca token ni cuerpo/logs.
          return { token, huella: await huellaToken(token) };
        } catch { throw new Error(ERROR_SISTEMA); }
      },

      async leerCookie(cabecera: string | null): Promise<string | null> {
        const token = tokenCookie(cabecera);
        const partes = partesToken(token);
        if (!token || !partes) return null;
        try {
          if (!await cripto.subtle.verify('HMAC', clave, partes.firma, dominio('sesion', partes.nonce))) return null;
          // Solo prefiltro: comprobar existencia, caducidad y revocación en DB en CADA solicitud.
          // La huella NO contiene identidad ni permisos, y un MAC válido NO autoriza por sí solo.
          return await huellaToken(token);
        } catch { throw new Error(ERROR_SISTEMA); }
      },
    });
  } catch { throw new Error(ERROR_SISTEMA); }
}

function cabeceraCookie(token: string, duracionSegundos: number): string {
  return `${NOMBRE_COOKIE_SESION}=${token}; Path=/; Max-Age=${duracionSegundos}; Secure; HttpOnly; SameSite=Lax`;
}

export function formatearCookieSesion(token: string, duracionSegundos = 30 * SEGUNDOS_DIA): string {
  if (!partesToken(token)) throw new Error('El formato de la cookie de sesión no es válido.');
  if (!Number.isSafeInteger(duracionSegundos) || duracionSegundos <= 0 || duracionSegundos > 31 * SEGUNDOS_DIA) {
    throw new Error('La duración de la cookie no es válida.');
  }
  // Sin Domain: __Host- exige HTTPS y Path=/; Lax permite abrir enlaces externos.
  // Las mutaciones deben comprobar Origin exacto en la futura frontera HTTP.
  return cabeceraCookie(token, duracionSegundos);
}

export function borrarCookieSesion(): string {
  // Solo expira la cookie: revocar en DB aparte; no borrar IndexedDB ni copias offline.
  return cabeceraCookie('', 0);
}
