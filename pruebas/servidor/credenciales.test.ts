import { webcrypto } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  borrarCookieSesion, crearCredenciales, formatearCookieSesion, NOMBRE_COOKIE_SESION,
} from '../../servidor/credenciales';

// Datos ficticios explícitos; no son claves de despliegue ni sugieren una contraseña humana.
const claveFicticia = 'solo-fixture-no-usar-en-produccion-0123456789';
const configuracion = { viajeId: 'viaje-ficticio', claveCompartida: claveFicticia };
const codificador = new TextEncoder();
const atributos = '; Path=/; Max-Age=2592000; Secure; HttpOnly; SameSite=Lax';
const errorConfiguracion = 'La configuración de credenciales no es válida.';
const errorSistema = 'No se pudo realizar la operación de credenciales.';
const cookie = (token: string) => `${NOMBRE_COOKIE_SESION}=${token}`;
const base64 = (bytes: Uint8Array) => Buffer.from(bytes).toString('base64url');
const cambiar = (componente: string) => base64(Buffer.from(componente, 'base64url').map((valor, i) => i === 0 ? valor ^ 1 : valor));

async function huellaReal(token: string) {
  return Buffer.from(await webcrypto.subtle.digest('SHA-256', codificador.encode(token))).toString('hex');
}

// Inyección solo de fallos: las pruebas criptográficas usan operaciones nativas reales.
function fallarEn(operacion: string, omitir = 0) {
  const nativa = globalThis.crypto;
  return {
    getRandomValues: ((bytes: Parameters<typeof nativa.getRandomValues>[0]) => {
      if (operacion === 'getRandomValues') throw new Error(claveFicticia);
      return nativa.getRandomValues(bytes);
    }) as typeof nativa.getRandomValues,
    subtle: new Proxy(nativa.subtle, {
      get(objeto, propiedad) {
        if (propiedad === operacion) return (...argumentos: unknown[]) => {
          if (omitir-- <= 0) return Promise.reject(new Error(claveFicticia));
          const metodo = Reflect.get(objeto, propiedad, objeto) as (...entradas: unknown[]) => unknown;
          return metodo.apply(objeto, argumentos);
        };
        const valor = Reflect.get(objeto, propiedad, objeto) as unknown;
        return typeof valor === 'function' ? valor.bind(objeto) : valor;
      },
    }),
  };
}

describe('credenciales privadas con WebCrypto de Node', () => {
  it('emite dos nonces y MAC de 32 bytes con huella SHA-256 del token completo', async () => {
    expect(process.versions.node.split('.')[0]).toBe('22');
    const credenciales = await crearCredenciales(configuracion);
    const primera = await credenciales.emitirSesion();
    const segunda = await credenciales.emitirSesion();
    for (const sesion of [primera, segunda]) {
      expect(Object.keys(sesion).sort()).toEqual(['huella', 'token']);
      expect(sesion.token).toMatch(/^[A-Za-z0-9_-]{43}\.[A-Za-z0-9_-]{43}$/);
      for (const componente of sesion.token.split('.')) {
        const bytes = Buffer.from(componente, 'base64url');
        expect(bytes.length).toBe(32);
        expect(base64(bytes)).toBe(componente);
      }
      expect(sesion.huella).toMatch(/^[0-9a-f]{64}$/);
      expect(sesion.huella).toBe(await huellaReal(sesion.token));
      expect(sesion.huella).not.toContain(sesion.token);
      expect(await credenciales.leerCookie(cookie(sesion.token))).toBe(sesion.huella);
    }
    expect(primera.token).not.toBe(segunda.token);
    expect(primera.token.split('.')[0]).not.toBe(segunda.token.split('.')[0]);
    expect(primera.huella).not.toBe(segunda.huella);
    expect(Object.keys(credenciales).sort()).toEqual(['emitirSesion', 'leerCookie', 'verificarClave']);
    expect(JSON.stringify(credenciales)).not.toContain(claveFicticia);
  });

  it('verifica la clave exacta, sin aceptar espacios añadidos ni normalizaciones', async () => {
    const credenciales = await crearCredenciales(configuracion, globalThis.crypto);
    expect(await credenciales.verificarClave(claveFicticia)).toBe(true);
    expect(await credenciales.verificarClave(`${claveFicticia} `)).toBe(false);
    expect(await credenciales.verificarClave(` ${claveFicticia}`)).toBe(false);
    const exacta = ` ${'ñ🔐é'.repeat(8)} `;
    const unicode = await crearCredenciales({ ...configuracion, claveCompartida: exacta });
    expect(await unicode.verificarClave(exacta)).toBe(true);
    expect(await unicode.verificarClave(exacta.trim())).toBe(false);
    expect(await unicode.verificarClave(exacta.normalize('NFD'))).toBe(false);
    const descompuesta = await crearCredenciales({ ...configuracion, claveCompartida: exacta.normalize('NFD') });
    expect(await descompuesta.verificarClave(exacta.normalize('NFD'))).toBe(true);
    expect(await descompuesta.verificarClave(exacta)).toBe(false);
  });

  const variantesNulas = [32, 62, 63, 64, 65, 254].flatMap((longitud) =>
    [1, 2].map((ceros) => ({ longitud, ceros })));

  it.each(variantesNulas)('distingue contraseñas exactas de $longitud bytes con $ceros NUL finales', async ({ longitud, ceros }) => {
    const clave = 'x'.repeat(longitud);
    const conNulos = clave + '\0'.repeat(ceros);
    const original = await crearCredenciales({ ...configuracion, claveCompartida: clave });
    const rotada = await crearCredenciales({ ...configuracion, claveCompartida: conNulos });
    expect(await original.verificarClave(clave)).toBe(true);
    expect(await rotada.verificarClave(conNulos)).toBe(true);
    expect.soft(await original.verificarClave(conNulos)).toBe(false);
    expect.soft(await rotada.verificarClave(clave)).toBe(false);
  });

  it.each(variantesNulas)('invalida cookies al rotar $longitud bytes por $ceros NUL finales', async ({ longitud, ceros }) => {
    const clave = 'x'.repeat(longitud);
    const original = await crearCredenciales({ ...configuracion, claveCompartida: clave });
    const rotada = await crearCredenciales({ ...configuracion, claveCompartida: clave + '\0'.repeat(ceros) });
    const anterior = await original.emitirSesion();
    const nueva = await rotada.emitirSesion();
    expect(await original.leerCookie(cookie(anterior.token))).toBe(anterior.huella);
    expect(await rotada.leerCookie(cookie(nueva.token))).toBe(nueva.huella);
    expect.soft(await rotada.leerCookie(cookie(anterior.token))).toBeNull();
    expect.soft(await original.leerCookie(cookie(nueva.token))).toBeNull();
  });

  it('no acepta sustitutos aislados como alias del carácter de reemplazo', async () => {
    const clave = `${claveFicticia}\ufffd`;
    const credenciales = await crearCredenciales({ ...configuracion, claveCompartida: clave });
    expect(await credenciales.verificarClave(clave)).toBe(true);
    expect(await credenciales.verificarClave(`${claveFicticia}\ud800`)).toBe(false);
    expect(await credenciales.verificarClave(`${claveFicticia}\udc00`)).toBe(false);
  });

  it.each([null, undefined, [], [claveFicticia], {}, new String(claveFicticia), 42, true,
    '', 'x'.repeat(257), '🔐'.repeat(65), `${claveFicticia}\ud800`, `${claveFicticia}\udc00`,
  ])('rechaza entradas públicas inválidas sin coerción: %s', async (entrada) => {
    const credenciales = await crearCredenciales(configuracion);
    expect(await credenciales.verificarClave(entrada)).toBe(false);
  });

  it.each([null, undefined, [], new String(claveFicticia), '', 'x'.repeat(31), 'x'.repeat(257),
    '🔐'.repeat(65), `${claveFicticia}\ud800`, `${claveFicticia}\udc00`])
  ('rechaza configuración de clave inválida sin divulgarla: %s', async (clave) => {
    const fallo = await crearCredenciales({ ...configuracion, claveCompartida: clave as unknown as string }).catch((error: unknown) => error);
    expect(fallo).toBeInstanceOf(Error);
    expect((fallo as Error).message).toBe(errorConfiguracion);
  });

  it('acota bytes UTF-8 de clave e identificador y conserva los extremos', async () => {
    for (const clave of ['x'.repeat(32), '🔐'.repeat(8), 'x'.repeat(256), '🔐'.repeat(64)]) {
      const credenciales = await crearCredenciales({ ...configuracion, claveCompartida: clave });
      expect(await credenciales.verificarClave(clave)).toBe(true);
    }
    for (const viajeId of ['', 'x'.repeat(129), '🔐'.repeat(33), '\ud800']) {
      await expect(crearCredenciales({ ...configuracion, viajeId })).rejects.toThrow(errorConfiguracion);
    }
    await expect(crearCredenciales({ ...configuracion, viajeId: '🔐'.repeat(32) })).resolves.toBeDefined();
  });

  it('fija la configuración al inicializar y separa viaje, rotación y propósitos', async () => {
    const mutable = { ...configuracion };
    const original = await crearCredenciales(mutable);
    mutable.claveCompartida = 'otra-clave-ficticia-0123456789-abcdef';
    mutable.viajeId = 'otro-viaje-ficticio';
    const sesion = await original.emitirSesion();
    const rotada = await crearCredenciales({ ...configuracion, claveCompartida: mutable.claveCompartida });
    const otroViaje = await crearCredenciales({ ...configuracion, viajeId: mutable.viajeId });
    expect(await original.verificarClave(claveFicticia)).toBe(true);
    expect(await rotada.leerCookie(cookie(sesion.token))).toBeNull();
    expect(await otroViaje.leerCookie(cookie(sesion.token))).toBeNull();
    expect(await original.verificarClave(sesion.token)).toBe(false);
    expect(await original.leerCookie(cookie(claveFicticia))).toBeNull();
    // Identificadores con separadores se representan sin concatenaciones ambiguas.
    const separado = await crearCredenciales({ ...configuracion, viajeId: 'viaje|sesion|v1' });
    expect(await original.leerCookie(cookie((await separado.emitirSesion()).token))).toBeNull();
  });

  it('rechaza alteraciones independientes del nonce y de la firma', async () => {
    const credenciales = await crearCredenciales(configuracion);
    const { token } = await credenciales.emitirSesion();
    const [nonce, firma] = token.split('.');
    expect(await credenciales.leerCookie(cookie(`${cambiar(nonce)}.${firma}`))).toBeNull();
    expect(await credenciales.leerCookie(cookie(`${nonce}.${cambiar(firma)}`))).toBeNull();
    expect(await credenciales.leerCookie(cookie(`${firma}.${nonce}`))).toBeNull();
  });

  it('lee solo un nombre exacto y admite cookies ajenas', async () => {
    const credenciales = await crearCredenciales(configuracion);
    const { token, huella } = await credenciales.emitirSesion();
    const cabecera = new Headers({ Cookie: `ajena=123; ${cookie(token)}; otra=a=b` });
    expect(await credenciales.leerCookie(cabecera.get('Cookie'))).toBe(huella);
    expect(await credenciales.leerCookie(` ${cookie(token)} ; otra=123`)).toBe(huella);
    for (const cabecera of [null, '', 'ajena=123', `prefijo${cookie(token)}`, `${NOMBRE_COOKIE_SESION}extra=${token}`,
      `${NOMBRE_COOKIE_SESION.toLowerCase()}=${token}`, `%5f%5fHost-itinerario=${token}`,
      `${cookie(token)}; ${cookie(token)}`, `${cookie(token)}; ${cookie('invalida')}`,
      `${cookie(token)}; ${NOMBRE_COOKIE_SESION}`, `${cookie(token)}; ${NOMBRE_COOKIE_SESION}=`,
      `${cookie(token)}\r\n`, `${cookie(token)}\0`, `${NOMBRE_COOKIE_SESION} =${token}`,
      `${cookie('invalida')}; ${cookie(token)}`, `ajena=${'x'.repeat(8192)}; ${cookie(token)}`,
    ]) expect(await credenciales.leerCookie(cabecera)).toBeNull();
    const alLimite = `${cookie(token)}; ajena=${'x'.repeat(8192 - cookie(token).length - 8)}`;
    expect(alLimite.length).toBe(8192);
    expect(await credenciales.leerCookie(alLimite)).toBe(huella);
    expect(await credenciales.leerCookie(`${alLimite}x`)).toBeNull();
  });

  it('rechaza base64 no canónico, relleno, porcentajes, longitudes e inyección', async () => {
    const credenciales = await crearCredenciales(configuracion);
    const { token } = await credenciales.emitirSesion();
    const [nonce, firma] = token.split('.');
    const alfabeto = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
    const alias = (texto: string) => texto.slice(0, -1) + alfabeto[alfabeto.indexOf(texto.at(-1)!) + 1];
    expect(Buffer.from(alias(nonce), 'base64url')).toEqual(Buffer.from(nonce, 'base64url'));
    for (const invalido of [alias(nonce) + '.' + firma, nonce + '.' + alias(firma), `${nonce}=.${firma}`,
      `${nonce}.${firma}=`, token.replace('.', '%2E'), `${nonce}+${firma}`, `${nonce}/${firma}`,
      token.slice(1), `${token}x`, `${token}.`, `.${firma}`, `${nonce}.`, `${token}\r\nX: 1`,
      `${nonce}. ${firma}`, `"${token}"`, 'null',
    ]) {
      expect(await credenciales.leerCookie(cookie(invalido))).toBeNull();
      expect(() => formatearCookieSesion(invalido)).toThrow();
    }
    expect(() => formatearCookieSesion(`${token}; Secure`)).toThrow();
  });

  it('usa HMAC no extraíble y dominios distintos para clave y sesión', async () => {
    const importaciones: boolean[] = [];
    const dominios: string[] = [];
    const nativa = globalThis.crypto;
    const cripto = {
      getRandomValues: nativa.getRandomValues.bind(nativa),
      subtle: new Proxy(nativa.subtle, {
        get(objeto, propiedad) {
          if (propiedad === 'importKey') return (...argumentos: Parameters<typeof objeto.importKey>) => {
            importaciones.push(argumentos[3]);
            return objeto.importKey(...argumentos);
          };
          if (propiedad === 'sign') return (...argumentos: Parameters<typeof objeto.sign>) => {
            const datos = argumentos[2];
            const bytes = ArrayBuffer.isView(datos)
              ? new Uint8Array(datos.buffer, datos.byteOffset, datos.byteLength) : new Uint8Array(datos);
            dominios.push(new TextDecoder().decode(bytes));
            return objeto.sign(...argumentos);
          };
          const valor = Reflect.get(objeto, propiedad, objeto) as unknown;
          return typeof valor === 'function' ? valor.bind(objeto) : valor;
        },
      }),
    };
    const credenciales = await crearCredenciales(configuracion, cripto);
    const { token } = await credenciales.emitirSesion();
    expect(await credenciales.verificarClave(claveFicticia)).toBe(true);
    expect(await credenciales.leerCookie(cookie(token))).toBe(await huellaReal(token));
    expect(importaciones.length).toBeGreaterThanOrEqual(2);
    expect(importaciones.every((extraible) => extraible === false)).toBe(true);
    const login = JSON.parse(dominios[0]) as string[];
    const sesion = JSON.parse(dominios[1]) as string[];
    expect(login).toEqual(['itinerario', 'v1', 'prueba-clave', configuracion.viajeId]);
    expect(sesion).toEqual(['itinerario', 'v1', 'sesion', configuracion.viajeId, token.split('.')[0]]);
  });

  it.each(['importKey', 'sign', 'digest'])('propaga fallo seguro en inicialización %s', async (operacion) => {
    await expect(crearCredenciales(configuracion, fallarEn(operacion))).rejects.toThrow(errorSistema);
  });

  it.each(['getRandomValues', 'digest'])('propaga fallo seguro al emitir %s', async (operacion) => {
    const credenciales = await crearCredenciales(configuracion, fallarEn(operacion, operacion === 'digest' ? 1 : 0));
    await expect(credenciales.emitirSesion()).rejects.toThrow(errorSistema);
  });

  it('propaga fallo seguro al derivar la candidata y rechaza entradas inválidas antes del hash', async () => {
    const credenciales = await crearCredenciales(configuracion, fallarEn('digest', 1));
    expect(await credenciales.verificarClave('x'.repeat(31))).toBe(false);
    expect(await credenciales.verificarClave('x'.repeat(257))).toBe(false);
    expect(await credenciales.verificarClave(`${claveFicticia}\ud800`)).toBe(false);
    await expect(credenciales.verificarClave(claveFicticia)).rejects.toThrow(errorSistema);
  });

  it('no oculta fallos de verificación como credenciales simplemente ausentes', async () => {
    const original = await crearCredenciales(configuracion);
    const { token } = await original.emitirSesion();
    const fallo = await crearCredenciales(configuracion, fallarEn('verify'));
    await expect(fallo.verificarClave(claveFicticia)).rejects.toThrow(errorSistema);
    await expect(fallo.leerCookie(cookie(token))).rejects.toThrow(errorSistema);
    expect(await fallo.leerCookie(cookie('invalida'))).toBeNull();
    const falloHuella = await crearCredenciales(configuracion, fallarEn('digest', 1));
    await expect(falloHuella.leerCookie(cookie(token))).rejects.toThrow(errorSistema);
    const [nonce, firma] = token.split('.');
    // Un MAC falso no llega siquiera al hash para buscar en el repositorio futuro.
    expect(await falloHuella.leerCookie(cookie(`${nonce}.${cambiar(firma)}`))).toBeNull();
    expect(await falloHuella.leerCookie(cookie('invalida'))).toBeNull();
  });
});

describe('cabeceras de cookie de sesión', () => {
  it('formatea cookie host-only con seguridad exacta y TTL predeterminado', async () => {
    const { token } = await (await crearCredenciales(configuracion)).emitirSesion();
    const cabecera = formatearCookieSesion(token);
    expect(cabecera).toBe(cookie(token) + atributos);
    const headers = new Headers({ 'Set-Cookie': cabecera });
    expect(headers.get('Set-Cookie')).toBe(cabecera);
    expect(cabecera).not.toContain('Domain');
    expect(formatearCookieSesion(token, 1)).toContain('Max-Age=1;');
    expect(formatearCookieSesion(token, 31 * 24 * 60 * 60)).toContain('Max-Age=2678400;');
  });

  it.each([0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER, 31 * 24 * 60 * 60 + 1])
  ('rechaza TTL inválido %s', async (duracion) => {
    const { token } = await (await crearCredenciales(configuracion)).emitirSesion();
    expect(() => formatearCookieSesion(token, duracion)).toThrow('La duración de la cookie no es válida.');
  });

  it('borra con igual ámbito y atributos, sin acción sobre copias offline', () => {
    expect(borrarCookieSesion()).toBe(`${NOMBRE_COOKIE_SESION}=; Path=/; Max-Age=0; Secure; HttpOnly; SameSite=Lax`);
    expect(new Headers({ 'Set-Cookie': borrarCookieSesion() }).get('Set-Cookie')).toBe(borrarCookieSesion());
  });
});
