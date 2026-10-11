import { describe, expect, it, vi } from 'vitest';
import { comprobarOrigen, FalloHttp, leerJsonAcotado, respuestaJson } from '../../servidor/http';

const direccion = 'https://viaje.example:8443/api';
const codificador = new TextEncoder();

function peticion(texto: string, cabeceras: Record<string, string> = {}) {
  return new Request(direccion, {
    method: 'POST', body: texto,
    headers: { 'Content-Type': 'application/json', ...cabeceras },
  });
}

function flujo(trozos: Uint8Array[], cabeceras: Record<string, string> = {}, alCancelar = () => {}, alLeer = () => {}) {
  let indice = 0;
  const cuerpo = new ReadableStream<Uint8Array>({
    pull(controlador) {
      if (indice < trozos.length) {
        alLeer();
        controlador.enqueue(trozos[indice++]);
      }
      else controlador.close();
    },
    cancel: alCancelar,
  });
  const opciones: RequestInit & { duplex: 'half' } = {
    method: 'POST', body: cuerpo, duplex: 'half',
    headers: { 'Content-Type': 'application/json', ...cabeceras },
  };
  return new Request(direccion, opciones);
}

async function exigirFallo(solicitud: Request, codigo: number, limite = 64) {
  const fallo = await leerJsonAcotado(solicitud, limite).catch((error: unknown) => error);
  expect(fallo).toBeInstanceOf(FalloHttp);
  expect(fallo).toMatchObject({ codigo });
  return fallo as FalloHttp;
}

describe('frontera HTTP compartida', () => {
  it('responde JSON privado sin caché ni permisos CORS', async () => {
    const respuesta = respuestaJson({ bien: true });
    expect(respuesta.status).toBe(200);
    expect(await respuesta.json()).toEqual({ bien: true });
    expect(respuesta.headers.get('Cache-Control')).toBe('private, no-store');
    expect(respuesta.headers.get('Vary')).toBe('Cookie');
    expect(respuesta.headers.get('Content-Type')).toBe('application/json; charset=utf-8');
    expect(respuesta.headers.get('X-Content-Type-Options')).toBe('nosniff');
    expect(respuesta.headers.has('Access-Control-Allow-Origin')).toBe(false);
    expect(respuestaJson(null, 403, false).headers.get('Cache-Control')).toBe('no-store');
  });

  it('permite solamente el Origin exacto, sin consumir el cuerpo', () => {
    const solicitud = peticion('{}', { Origin: 'https://viaje.example:8443' });
    expect(() => comprobarOrigen(solicitud)).not.toThrow();
    expect(solicitud.bodyUsed).toBe(false);
  });

  it.each([
    undefined, 'null', 'http://viaje.example:8443', 'https://viaje.example',
    'https://sub.viaje.example:8443', 'https://viaje.example:8443.evil',
    'https://viaje.example:8444', 'https://viaje.example.evil:8443',
    'https://viaje.example:8443/', 'https://usuario@viaje.example:8443',
    'https://viaje.example:8443/otra', 'https://viaje.example:8443 https://evil.example',
  ])('rechaza Origin %s antes de leer', (origen) => {
    const solicitud = peticion('{}', origen === undefined ? {} : { Origin: origen });
    expect(() => comprobarOrigen(solicitud)).toThrow(FalloHttp);
    try { comprobarOrigen(solicitud); } catch (error) {
      expect(error).toMatchObject({ codigo: 403 });
    }
    expect(solicitud.bodyUsed).toBe(false);
  });

  it.each(['application/json', 'APPLICATION/JSON', 'Application/Json; charset=utf-8'])
  ('acepta el tipo JSON %s', async (tipo) => {
    expect(await leerJsonAcotado(peticion('{}', { 'Content-Type': tipo }), 2)).toEqual({});
  });

  it.each(['text/plain', 'application/jsonp', 'application/problem+json', ''])
  ('rechaza el tipo %s', async (tipo) => {
    await exigirFallo(peticion('{}', { 'Content-Type': tipo }), 415);
  });

  it('rechaza un tipo ausente antes de leer', async () => {
    const solicitud = new Request(direccion, { method: 'POST', body: codificador.encode('{}') });
    await exigirFallo(solicitud, 415);
    expect(solicitud.bodyUsed).toBe(false);
  });

  it.each([0, -1, 1.5, Infinity, NaN, Number.MAX_SAFE_INTEGER + 1])
  ('rechaza un límite configurado inválido %s', async (limite) => {
    const solicitud = peticion('{}');
    await expect(leerJsonAcotado(solicitud, limite)).rejects.toThrow(RangeError);
    expect(solicitud.bodyUsed).toBe(false);
  });

  it.each(['-1', '+2', '02', '2.0', '2e0', 'abc', '', '9007199254740992'])
  ('rechaza Content-Length no canónico %s', async (longitud) => {
    const solicitud = peticion('{}', { 'Content-Length': longitud });
    await exigirFallo(solicitud, 400);
    expect(solicitud.bodyUsed).toBe(false);
  });

  it('rechaza la longitud declarada excesiva antes de leer', async () => {
    const solicitud = peticion('{}', { 'Content-Length': '3' });
    await exigirFallo(solicitud, 413, 2);
    expect(solicitud.bodyUsed).toBe(false);
  });

  const longitudesDeclaradas: Record<string, string>[] = [{}, { 'Content-Length': '0' }, { 'Content-Length': '2' }];
  it.each(longitudesDeclaradas)
  ('cuenta bytes reales con longitud ausente o mentirosa %j', async (cabeceras) => {
    const bytes = codificador.encode('"ñ"');
    expect(await leerJsonAcotado(flujo([bytes.slice(0, 2), bytes.slice(2)], cabeceras), 4)).toBe('ñ');
    await exigirFallo(flujo([bytes.slice(0, 2), bytes.slice(2)], cabeceras), 413, 3);
  });

  it('cancela al superar el límite sin consumir el resto del stream', async () => {
    let cancelado = false;
    let trozosLeidos = 0;
    const solicitud = flujo(
      [codificador.encode('123'), codificador.encode('4'), new Uint8Array(1024)], {},
      () => { cancelado = true; }, () => { trozosLeidos++; },
    );
    await exigirFallo(solicitud, 413, 2);
    expect(cancelado).toBe(true);
    // El stream puede anticipar un trozo; no llega a producir el último.
    expect(trozosLeidos).toBeLessThan(3);
  });

  it.each(['null', 'true', '42', '"texto"', '[1,2]', '{}'])
  ('devuelve JSON desconocido sin coerción: %s', async (texto) => {
    expect(await leerJsonAcotado(peticion(texto), 64)).toEqual(JSON.parse(texto));
  });

  it('no refleja contenidos ni detalles del parser en errores públicos', async () => {
    const secretoFicticio = 'clave-ficticia-no-real';
    const fallo = await exigirFallo(peticion(`{"clave":"${secretoFicticio}"`), 400);
    expect(fallo.message).toBe('El cuerpo JSON no es válido.');
    expect(JSON.stringify(fallo)).not.toContain(secretoFicticio);
    expect(await respuestaJson({ error: fallo.message }, fallo.codigo).text()).not.toContain(secretoFicticio);
  });

  it.each([[34, 0xc3, 34], [34, 0xc3]])('rechaza UTF-8 inválido o truncado %j', async (...bytes) => {
    await exigirFallo(flujo([new Uint8Array(bytes)]), 400);
  });

  it('mantiene el 413 aunque falle la cancelación', async () => {
    const solicitud = flujo([codificador.encode('123')], {}, () => { throw new Error('cancelación-ficticia'); });
    const fallo = await exigirFallo(solicitud, 413, 2);
    expect(fallo.message).toBe('El cuerpo supera el límite permitido.');
  });

  it('rechaza un cuerpo ya consumido sin intentar otra lectura', async () => {
    const solicitud = peticion('{}');
    await solicitud.text();
    await exigirFallo(solicitud, 400);
  });

  it('rechaza una interrupción después de recibir JSON aparentemente completo', async () => {
    let enviado = false;
    const cuerpo = new ReadableStream<Uint8Array>({
      pull(controlador) {
        if (enviado) controlador.error(new Error('interrupción-ficticia'));
        else { enviado = true; controlador.enqueue(codificador.encode('{}')); }
      },
    });
    const opciones: RequestInit & { duplex: 'half' } = {
      method: 'POST', body: cuerpo, duplex: 'half', headers: { 'Content-Type': 'application/json' },
    };
    await exigirFallo(new Request(direccion, opciones), 400);
  });

  it('rechaza cuerpo ausente o vacío', async () => {
    await exigirFallo(new Request(direccion, { method: 'POST', headers: { 'Content-Type': 'application/json' } }), 400);
    await exigirFallo(peticion(''), 400);
  });

  it('rechaza errores y abortos del stream sin divulgar su motivo', async () => {
    for (const motivo of [new Error('transporte-ficticio'), new DOMException('aborto-ficticio', 'AbortError')]) {
      const cuerpo = new ReadableStream<Uint8Array>({ start(controlador) { controlador.error(motivo); } });
      const opciones: RequestInit & { duplex: 'half' } = {
        method: 'POST', body: cuerpo, duplex: 'half', headers: { 'Content-Type': 'application/json' },
      };
      const fallo = await exigirFallo(new Request(direccion, opciones), 400);
      expect(fallo.message).toBe('El cuerpo JSON no es válido.');
      expect(fallo.message).not.toContain(motivo.message);
    }
  });

  it('rechaza una señal ya abortada sin consumir un JSON válido', async () => {
    const aborto = new AbortController();
    aborto.abort(new Error('motivo-ficticio-privado'));
    const solicitud = new Request(direccion, {
      method: 'POST', body: '{}', signal: aborto.signal,
      headers: { 'Content-Type': 'application/json' },
    });
    const fallo = await exigirFallo(solicitud, 400);
    expect(fallo.message).toBe('El cuerpo JSON no es válido.');
    expect(solicitud.bodyUsed).toBe(false);
    expect(solicitud.body?.locked).toBe(false);
  });

  it.each(['normal', 'pendiente', 'rechazada'] as const)
  ('el aborto de Request.signal resuelve una lectura detenida con cancelación %s', async (cancelacion) => {
    const aborto = new AbortController();
    let controlador!: ReadableStreamDefaultController<Uint8Array>;
    const cancelar = vi.fn((_motivo?: unknown) => {
      if (cancelacion === 'pendiente') return new Promise<void>(() => {});
      if (cancelacion === 'rechazada') return Promise.reject(new Error('cancelación-ficticia-privada'));
    });
    const cuerpo = new ReadableStream<Uint8Array>({
      start(actual) { controlador = actual; }, cancel: cancelar,
    });
    const opciones: RequestInit & { duplex: 'half' } = {
      method: 'POST', body: cuerpo, duplex: 'half', signal: aborto.signal,
      headers: { 'Content-Type': 'application/json' },
    };
    const solicitud = new Request(direccion, opciones);
    const lectura = leerJsonAcotado(solicitud, 64).catch((error: unknown) => error);
    aborto.abort(new Error('motivo-ficticio-privado'));
    let temporizador: ReturnType<typeof setTimeout> | undefined;
    try {
      const resultado = await Promise.race([
        lectura,
        new Promise<string>((resolver) => { temporizador = setTimeout(() => resolver('sigue pendiente'), 100); }),
      ]);
      expect(resultado).toBeInstanceOf(FalloHttp);
      expect(resultado).toMatchObject({ codigo: 400, message: 'El cuerpo JSON no es válido.' });
      expect(cancelar).toHaveBeenCalledOnce();
      expect(cancelar.mock.calls[0][0]).toBeUndefined();
      expect(cuerpo.locked).toBe(false);
      // Da oportunidad de detectar rechazos de cancelación no manejados en Vitest.
      await new Promise<void>((resolver) => setTimeout(resolver, 0));
    } finally {
      clearTimeout(temporizador);
      // Solo limpieza tras el RED: nunca entrega datos para conseguir el resultado probado.
      if (!cancelar.mock.calls.length) controlador.close();
      await lectura;
    }
  });

  it.each(['último trozo', 'EOF'] as const)
  ('no devuelve JSON si la señal aborta durante %s', async (momento) => {
    const aborto = new AbortController();
    let enviado = false;
    const cuerpo = new ReadableStream<Uint8Array>({
      pull(controlador) {
        if (!enviado) {
          enviado = true;
          controlador.enqueue(codificador.encode('{}'));
          if (momento === 'último trozo') aborto.abort('motivo-ficticio-privado');
        } else {
          controlador.close();
          aborto.abort('motivo-ficticio-privado');
        }
      },
    }, { highWaterMark: 0 });
    const opciones: RequestInit & { duplex: 'half' } = {
      method: 'POST', body: cuerpo, duplex: 'half', signal: aborto.signal,
      headers: { 'Content-Type': 'application/json' },
    };
    const fallo = await exigirFallo(new Request(direccion, opciones), 400);
    expect(fallo.message).toBe('El cuerpo JSON no es válido.');
    expect(cuerpo.locked).toBe(false);
  });

  it.each(['normal', 'JSON inválido', 'excesivo', 'aborto'] as const)
  ('retira el listener y libera el lector al salir por %s', async (salida) => {
    const aborto = new AbortController();
    const solicitud = new Request(direccion, {
      method: 'POST', body: salida === 'JSON inválido' ? '{' : '{}', signal: aborto.signal,
      headers: { 'Content-Type': 'application/json' },
    });
    const agregar = vi.spyOn(solicitud.signal, 'addEventListener');
    const retirar = vi.spyOn(solicitud.signal, 'removeEventListener');
    try {
      const lectura = leerJsonAcotado(solicitud, salida === 'excesivo' ? 1 : 64);
      if (salida === 'aborto') aborto.abort('motivo-ficticio-privado');
      if (salida === 'normal') expect(await lectura).toEqual({});
      else await expect(lectura).rejects.toMatchObject({ codigo: salida === 'excesivo' ? 413 : 400 });
      expect(agregar).toHaveBeenCalledOnce();
      expect(agregar.mock.calls[0][0]).toBe('abort');
      expect(retirar).toHaveBeenCalledOnce();
      expect(retirar.mock.calls[0].slice(0, 2)).toEqual(agregar.mock.calls[0].slice(0, 2));
      expect(solicitud.body?.locked).toBe(false);
    } finally {
      agregar.mockRestore();
      retirar.mockRestore();
    }
  });

  it('usa WebCrypto y APIs web del entorno Node sin DOM de la app', async () => {
    const resumen = await crypto.subtle.digest('SHA-256', codificador.encode('viaje'));
    expect(resumen.byteLength).toBe(32);
    expect(crypto.getRandomValues(new Uint8Array(16))).toHaveLength(16);
  });
});
