const mensajes = {
  400: 'El cuerpo JSON no es válido.',
  403: 'El origen de la solicitud no está permitido.',
  413: 'El cuerpo supera el límite permitido.',
  415: 'El cuerpo debe ser application/json.',
} as const;

// El mensaje público depende solo del código, nunca de datos ni errores externos.
export class FalloHttp extends Error {
  constructor(readonly codigo: keyof typeof mensajes) {
    super(mensajes[codigo]);
    this.name = 'FalloHttp';
  }
}

export function respuestaJson(datos: unknown, estado = 200, privada = true): Response {
  return new Response(JSON.stringify(datos), {
    status: estado,
    headers: {
      'Cache-Control': privada ? 'private, no-store' : 'no-store',
      'Vary': 'Cookie',
      'Content-Type': 'application/json; charset=utf-8',
      'X-Content-Type-Options': 'nosniff',
    },
  });
}

// Las mutaciones deben invocarlo antes de leer el cuerpo. No autentica sesiones.
// Las lecturas GET no necesitan invocarlo; no se normaliza el Origin recibido.
export function comprobarOrigen(solicitud: Request): void {
  if (solicitud.headers.get('Origin') !== new URL(solicitud.url).origin) {
    throw new FalloHttp(403);
  }
}

export async function leerJsonAcotado(solicitud: Request, limiteBytes: number): Promise<unknown> {
  if (!Number.isSafeInteger(limiteBytes) || limiteBytes <= 0) {
    throw new RangeError('El límite de bytes debe ser un entero seguro positivo.');
  }
  const tipo = solicitud.headers.get('Content-Type')?.split(';', 1)[0].trim().toLowerCase();
  if (tipo !== 'application/json') throw new FalloHttp(415);

  const longitud = solicitud.headers.get('Content-Length');
  if (longitud !== null) {
    if (!/^(0|[1-9][0-9]*)$/.test(longitud) || !Number.isSafeInteger(Number(longitud))) {
      throw new FalloHttp(400);
    }
    if (Number(longitud) > limiteBytes) throw new FalloHttp(413);
  }
  if (solicitud.signal.aborted || !solicitud.body) throw new FalloHttp(400);

  let lector: ReadableStreamDefaultReader<Uint8Array>;
  try { lector = solicitud.body.getReader(); } catch { throw new FalloHttp(400); }
  const decodificador = new TextDecoder('utf-8', { fatal: true });
  let total = 0;
  let texto = '';
  let cancelado = false;
  const cancelarSeguro = () => {
    if (cancelado) return;
    cancelado = true;
    // cancel() cierra lecturas pendientes aunque el hook de la fuente no termine.
    // No esperar ese hook ni divulgar su rechazo o el motivo de la señal.
    try { void lector.cancel().catch(() => {}); } catch { /* Conservar el fallo público. */ }
  };
  try {
    solicitud.signal.addEventListener('abort', cancelarSeguro);
    while (true) {
      if (solicitud.signal.aborted) { cancelarSeguro(); throw new FalloHttp(400); }
      let lectura: Awaited<ReturnType<typeof lector.read>>;
      try { lectura = await lector.read(); } catch { throw new FalloHttp(400); }
      if (solicitud.signal.aborted) throw new FalloHttp(400);
      if (lectura.done) break;
      // La longitud declarada no sustituye este conteo, también para UTF-8 partido.
      if (lectura.value.byteLength > limiteBytes - total) {
        cancelarSeguro();
        throw new FalloHttp(413);
      }
      total += lectura.value.byteLength;
      try { texto += decodificador.decode(lectura.value, { stream: true }); } catch {
        cancelarSeguro();
        throw new FalloHttp(400);
      }
    }
    if (solicitud.signal.aborted) throw new FalloHttp(400);
    try {
      texto += decodificador.decode();
      return JSON.parse(texto) as unknown;
    } catch { throw new FalloHttp(400); }
  } finally {
    solicitud.signal.removeEventListener('abort', cancelarSeguro);
    try { lector.releaseLock(); } catch { /* No ocultar el error original. */ }
  }
}
