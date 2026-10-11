import { IDBFactory } from 'fake-indexeddb';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { abrirProgresoLocal } from '../src/progreso-local';
import type { ProgresoLocal } from '../src/progreso-local';
import { aplicarOperacion, crearProgreso } from '../src/progreso';
import type { Operacion } from '../src/progreso';
import { parsearProgreso, serializarProgreso } from '../src/progreso-json';
import { crearTransporteProgreso } from '../src/progreso-transporte';
import type { Itinerario } from '../src/tipos';

const plan: Itinerario = { id: 'viaje', titulo: 'Prueba', dias: [{ fecha: '2026-10-21', titulo: 'Día',
  paradas: [{ id: 'p1', nombre: 'Uno', hora: '09:00', categoria: 'otro', lat: 0, lng: 0 },
    { id: 'p2', nombre: 'Dos', hora: '10:00', categoria: 'otro', lat: 0, lng: 0 }] }] };
const operacion = (id = 'a', revision = 0): Extract<Operacion, { tipo: 'parada' }> => ({ id, dispositivoId: 'movil',
  tipo: 'parada', paradaId: 'p1', marca: 'hecha', revision, horaReal: -0 });
function instantanea(revisionServidor = 0, ...ops: Operacion[]) {
  let estado = crearProgreso(plan);
  for (const op of ops) {
    const resultado = aplicarOperacion(plan, estado, op);
    if (resultado.tipo === 'invalida' || resultado.tipo === 'conflicto') throw new Error('Fixture inválida');
    estado = resultado.estado;
  }
  return { revisionServidor, estado };
}
const acuse = (op: Operacion, revision = 1, ...ops: Operacion[]) => ({ operacionId: op.id,
  persistida: true, instantanea: instantanea(revision, ...ops, op) });
const rechazo = (op: Operacion, revision = 0, ...ops: Operacion[]) => ({ viajeId: plan.id, protocolo: 1,
  operacionId: op.id, operacionOriginal: op, decisionPersistida: true, motivo: 'conflicto',
  instantanea: instantanea(revision, ...ops) });
const respuesta = (valor: unknown, status = 200, etag?: string) => new Response(serializarProgreso(valor),
  { status, headers: { 'Content-Type': 'application/json', ...(etag ? { ETag: etag } : {}) } });
const cierres: (() => void)[] = [];
afterEach(() => { for (const cerrar of cierres.splice(0)) cerrar(); vi.restoreAllMocks(); vi.useRealTimers(); });
async function contexto(ops: Operacion[] = [operacion()]) {
  const local = await abrirProgresoLocal(plan, { fabrica: new IDBFactory(), nombre: 'transporte', dispositivoId: 'movil' });
  cierres.push(() => local.cerrar());
  for (const op of ops) await local.registrar(op);
  return local;
}
function transporte(local: ProgresoLocal, http: (url: string, opciones: RequestInit) => Promise<Response>,
  opciones: Partial<Parameters<typeof crearTransporteProgreso>[0]> = {}) {
  const emisor = crearTransporteProgreso({ plan, local, http, ...opciones });
  cierres.push(() => emisor.cerrar());
  return emisor;
}

describe('Transporte explícito de progreso, IDB simulada y HTTP inyectado', () => {
  it('confirma la marca durable antes del POST y usa endpoint y opciones privados', async () => {
    const local = await contexto();
    const llamadas: RequestInit[] = [];
    const emisor = transporte(local, async (url, opciones) => {
      expect(url).toBe('/api/progreso');
      expect(opciones.credentials).toBe('same-origin');
      expect(opciones.cache).toBe('no-store');
      expect(opciones.redirect).toBe('error');
      llamadas.push(opciones);
      if (opciones.method === 'GET') return respuesta(instantanea(), 200, '"base"');
      expect((await local.leer()).cola[0].enviada).toBe(true);
      expect(opciones.body).toBe(serializarProgreso(operacion()));
      expect(Object.is((parsearProgreso(String(opciones.body)) as { horaReal: number }).horaReal, -0)).toBe(true);
      return respuesta(acuse(operacion()));
    });
    await emisor.sincronizar();
    expect(llamadas.map((o) => o.method)).toEqual(['GET', 'POST']);
    expect((await local.leer()).cola).toEqual([]);
    expect(emisor.estado.pendientes).toBe(0);
    expect(emisor.estado.localDurable).toBe(true);
  });

  it('no envía el hijo hasta recibir acuse explícito, ni siquiera con recibo en GET', async () => {
    const a = operacion(); const b = { ...operacion('b', 1), marca: 'saltada' as const };
    const local = await contexto([a, b]);
    expect((await local.leer()).cola[1].dependeDe).toEqual(['a']);
    const enviados: string[] = [];
    const emisor = transporte(local, async (_, opciones) => {
      if (opciones.method === 'GET') return respuesta(instantanea(1, a), 200, '"uno"');
      const op = parsearProgreso(String(opciones.body)) as Operacion;
      enviados.push(op.id);
      if (op.id === 'a') {
        expect((await local.leer()).cola[1].dependeDe).toEqual(['a']);
        return respuesta(acuse(a));
      }
      expect((await local.leer()).cola[0].dependeDe).toEqual([]);
      return respuesta(acuse(b, 2, a));
    });
    await emisor.sincronizar();
    expect(enviados).toEqual(['a', 'b']);
    expect((await local.leer()).cola).toEqual([]);
  });

  it('reintenta el original enviado incluso tras GET conflictivo, conservando ID y menos cero', async () => {
    const local = await contexto(); const cuerpos: string[] = [];
    let segunda = false;
    const ajena = { ...operacion('ajena'), marca: 'saltada' as const };
    const emisor = transporte(local, async (_, opciones) => {
      if (opciones.method === 'GET') return respuesta(segunda ? instantanea(2, ajena) : instantanea(), 200, '"base"');
      cuerpos.push(String(opciones.body));
      throw new Error('Respuesta perdida con datos privados');
    });
    await emisor.sincronizar(); segunda = true; await emisor.sincronizar();
    expect(cuerpos).toEqual([serializarProgreso(operacion()), serializarProgreso(operacion())]);
    expect((await local.leer()).cola[0].enviada).toBe(true);
    expect(emisor.estado.incertidumbre).toBe(true);
  });

  it.each(['marcarEnviada', 'leer'] as const)('no hace POST si falla el almacén en %s', async (metodo) => {
    const local = await contexto();
    vi.spyOn(local, metodo).mockRejectedValue(new Error('Fallo privado'));
    const http = vi.fn(async () => respuesta(instantanea(), 200, '"base"'));
    const emisor = transporte(local, http);
    await emisor.sincronizar();
    expect(http.mock.calls.length).toBe(metodo === 'leer' ? 0 : 1);
    expect(emisor.estado.tipo).toBe('fallo-local');
    expect(emisor.estado.localDurable).toBe(false);
  });

  it('un acuse histórico válido retira sin rebobinar el confirmado nuevo', async () => {
    const a = operacion(); const ajena = { ...operacion('ajena'), paradaId: 'p2' } as Operacion;
    const local = await contexto(); await local.marcarEnviada(a.id);
    const emisor = transporte(local, async (_, o) => o.method === 'GET'
      ? respuesta(instantanea(4, a, ajena), 200, '"cuatro"') : respuesta(acuse(a)));
    await emisor.sincronizar();
    expect((await local.leer()).revisionServidor).toBe(4);
    expect((await local.leer()).cola).toEqual([]);
  });

  it('persiste rechazo histórico, detiene reintentos y mantiene los hijos bloqueados', async () => {
    const a = operacion(); const b = { ...operacion('b', 1), marca: 'saltada' as const };
    const ajena = { ...operacion('ajena'), paradaId: 'p2' } as Operacion;
    const local = await contexto([a, b]);
    let posts = 0;
    const emisor = transporte(local, async (_, o) => {
      if (o.method === 'GET') return respuesta(instantanea(4, ajena), 200, '"cuatro"');
      posts++; return respuesta(rechazo(a), 409);
    });
    await emisor.sincronizar(); await emisor.sincronizar();
    const raiz = await local.leer();
    expect(posts).toBe(1); expect(raiz.revisionServidor).toBe(4);
    expect(raiz.cola[0].rechazo?.operacionId).toBe('a');
    expect(raiz.cola[1].dependeDe).toEqual(['a']);
    expect(emisor.estado.tipo).toBe('rechazo-manual');
  });

  it.each([false, true])('el rechazo conocido conserva incertidumbre de otra enviada: %s', async (otraEnviada) => {
    const a = operacion(); const b = { ...operacion('b'), paradaId: 'p2' };
    const local = await contexto(otraEnviada ? [a, b] : [a]);
    if (otraEnviada) expect((await local.marcarEnviada(b.id)).tipo).toBe('enviada');
    const anterior = await local.leer();
    const negativo = rechazo(a);
    const metodos: (string | undefined)[] = [];
    const emisor = transporte(local, async (_, opciones) => {
      metodos.push(opciones.method);
      if (opciones.method === 'GET') return respuesta(instantanea(), 200, '"base"');
      expect(opciones.body).toBe(serializarProgreso(a));
      return respuesta(negativo, 409);
    });
    await emisor.sincronizar();
    const raiz = await local.leer();
    expect(raiz.formato).toBe(3);
    expect(raiz.cola[0].operacion).toEqual(a);
    expect(raiz.cola[0].enviada).toBe(true);
    expect(raiz.cola[0].rechazo).toEqual(negativo);
    if (otraEnviada) {
      expect(raiz.cola[1]).toEqual(anterior.cola[1]);
      expect(raiz.cola[1].enviada).toBe(true);
      expect(raiz.cola[1].rechazo).toBeUndefined();
      expect(raiz.cola[1].dependeDe).toEqual([]);
      const original = raiz.cola[1].operacion;
      expect(original.tipo === 'parada' && Object.is(original.horaReal, -0)).toBe(true);
    }
    expect(metodos).toEqual(['GET', 'POST']);
    expect(emisor.estado.tipo).toBe('rechazo-manual');
    expect(emisor.estado.pendientes).toBe(otraEnviada ? 2 : 1);
    expect(emisor.estado.incertidumbre).toBe(otraEnviada);
  });

  it.each([
    ['acuse ajeno', 200, acuse(operacion('otra'))],
    ['sin recibo', 200, { operacionId: 'a', persistida: true, instantanea: instantanea() }],
    ['payload ajeno positivo', 200, acuse({ ...operacion(), marca: 'saltada' } as Operacion)],
    ['payload ajeno negativo', 409, rechazo({ ...operacion(), horaReal: 0 } as Operacion)],
    ['negativo con status incorrecto', 200, rechazo(operacion())],
    ['positivo con status incorrecto', 409, acuse(operacion())],
    ['malformado', 200, { persistida: true }],
  ])('no decide ante %s', async (_, status, dto) => {
    const local = await contexto();
    const emisor = transporte(local, async (_, o) => o.method === 'GET'
      ? respuesta(instantanea(), 200, '"base"') : respuesta(dto, status as number));
    await emisor.sincronizar();
    const raiz = await local.leer();
    expect(raiz.cola).toHaveLength(1); expect(raiz.cola[0].rechazo).toBeUndefined();
    expect(emisor.estado.incertidumbre).toBe(true);
  });

  it.each([401, 409])('conserva original ante HTTP %s y cuarentena no reintenta', async (status) => {
    const local = await contexto(); let posts = 0;
    const emisor = transporte(local, async (_, o) => {
      if (o.method === 'GET') return respuesta(instantanea(), 200, '"base"');
      posts++; return respuesta({ codigo: 'identidad-reutilizada' }, status);
    });
    await emisor.sincronizar();
    expect(emisor.estado.tipo).toBe(status === 401 ? 'sin-sesion' : 'cuarentena');
    expect((await local.leer()).cola[0].enviada).toBe(true);
    expect((await local.leer()).cola[0].rechazo).toBeUndefined();
    if (status === 409) { await emisor.sincronizar(); expect(posts).toBe(1); }
  });

  it('asocia 304 exclusivamente al GET validado y reiniciar olvida ETag', async () => {
    const local = await contexto([]); const etiquetas: (string | null)[] = [];
    const http = vi.fn(async (_, o: RequestInit) => {
      const etiqueta = new Headers(o.headers).get('If-None-Match'); etiquetas.push(etiqueta);
      return etiqueta ? new Response(null, { status: 304, headers: { ETag: '"base"' } })
        : respuesta(instantanea(), 200, '"base"');
    });
    const emisor = transporte(local, http);
    await emisor.sincronizar(); await emisor.sincronizar();
    const nuevo = transporte(local, http); await nuevo.sincronizar();
    expect(etiquetas).toEqual([null, '"base"', null]);
  });

  it('no memoriza ETag cuando falla la escritura durable del GET', async () => {
    const local = await contexto([]); const recibir = local.recibirInstantanea.bind(local);
    const fallo = vi.spyOn(local, 'recibirInstantanea').mockRejectedValueOnce(new Error('IDB'));
    const etiquetas: (string | null)[] = [];
    const emisor = transporte(local, async (_, o) => {
      etiquetas.push(new Headers(o.headers).get('If-None-Match'));
      return respuesta(instantanea(), 200, '"base"');
    });
    await emisor.sincronizar(); fallo.mockImplementation(recibir); await emisor.sincronizar();
    expect(etiquetas).toEqual([null, null]);
  });

  it.each(['304', 'HTML', 'redirect', 'etiqueta débil', 'instantánea inválida'])('rechaza GET %s sin POST', async (caso) => {
    const local = await contexto();
    const http = vi.fn(async () => {
      if (caso === '304') return new Response(null, { status: 304 });
      if (caso === 'HTML') return new Response('<html>Entrar</html>', { headers: { 'Content-Type': 'text/html' } });
      if (caso === 'redirect') { const r = respuesta(instantanea(), 200, '"base"');
        Object.defineProperty(r, 'redirected', { value: true }); return r; }
      if (caso === 'etiqueta débil') return respuesta(instantanea(), 200, 'W/"base"');
      return respuesta({ revisionServidor: 1, estado: {} }, 200, '"base"');
    });
    const emisor = transporte(local, http); await emisor.sincronizar();
    expect(http).toHaveBeenCalledTimes(1); expect((await local.leer()).cola[0].enviada).toBe(false);
    expect(emisor.estado.incertidumbre).toBe(true);
  });

  it('coalesce llamadas concurrentes sin ciclos simultáneos ni polling', async () => {
    const local = await contexto([]); let liberar!: (r: Response) => void;
    const http = vi.fn(() => new Promise<Response>((resolve) => { liberar = resolve; }));
    const emisor = transporte(local, http);
    const primera = emisor.sincronizar(); const segunda = emisor.sincronizar();
    expect(primera).toBe(segunda);
    await vi.waitFor(() => expect(http).toHaveBeenCalledTimes(1));
    liberar(respuesta(instantanea(), 200, '"base"')); await Promise.all([primera, segunda]);
    expect(http).toHaveBeenCalledTimes(1);
  });

  it.each(['cerrar', 'timeout'])('termina %s aunque HTTP ignore signal y conserva enviada', async (caso) => {
    const local = await contexto(); let signal: AbortSignal | null | undefined;
    const emisor = transporte(local, async (_, o) => {
      if (o.method === 'GET') return respuesta(instantanea(), 200, '"base"');
      signal = o.signal; return new Promise<Response>(() => {});
    }, { timeoutMs: 20 });
    const ciclo = emisor.sincronizar();
    await vi.waitFor(() => expect(signal).toBeDefined(), { interval: 1 });
    if (caso === 'cerrar') emisor.cerrar();
    await ciclo;
    expect(signal?.aborted).toBe(true);
    expect((await local.leer()).cola[0].enviada).toBe(true);
    expect(emisor.estado.incertidumbre).toBe(true);
    expect(emisor.estado.tipo).toBe(caso === 'cerrar' ? 'cerrado' : 'incierto');
  });

  it('no declara confirmación cuando falla persistir el acuse ya recibido', async () => {
    const local = await contexto(); vi.spyOn(local, 'recibirAcuse').mockRejectedValue(new Error('IDB'));
    const emisor = transporte(local, async (_, o) => o.method === 'GET'
      ? respuesta(instantanea(), 200, '"base"') : respuesta(acuse(operacion())));
    await emisor.sincronizar();
    expect(emisor.estado.tipo).toBe('fallo-local'); expect(emisor.estado.incertidumbre).toBe(true);
    expect((await local.leer()).cola).toHaveLength(1);
  });

  it('dos clientes y dos cabezas simuladas preservan decisión histórica tras perder respuesta', async () => {
    const a = operacion(); const ajena = { ...operacion('ajena'), paradaId: 'p2' } as Operacion;
    const primero = await contexto([a]); const segundo = await contexto([ajena]);
    let cabeza = instantanea();
    const decisiones = new Map<string, ReturnType<typeof acuse>>();
    let perder = true; const cuerpos: string[] = [];
    const http = async (_: string, opciones: RequestInit) => {
      if (opciones.method === 'GET') return respuesta(cabeza, 200, `"r${cabeza.revisionServidor}"`);
      const op = parsearProgreso(String(opciones.body)) as Operacion;
      cuerpos.push(String(opciones.body));
      let decision = decisiones.get(op.id);
      if (!decision) {
        const aplicada = aplicarOperacion(plan, cabeza.estado, op);
        if (aplicada.tipo !== 'aplicada') throw new Error('Fixture de servidor');
        cabeza = { revisionServidor: cabeza.revisionServidor + 1, estado: aplicada.estado };
        decision = { operacionId: op.id, persistida: true, instantanea: structuredClone(cabeza) };
        decisiones.set(op.id, decision);
      }
      if (op.id === a.id && perder) { perder = false; throw new Error('Acuse perdido tras persistir'); }
      return respuesta(decision);
    };
    const emisorA = transporte(primero, http); const emisorB = transporte(segundo, http);
    await emisorA.sincronizar(); await emisorB.sincronizar(); await emisorA.sincronizar();
    expect(cuerpos).toEqual([serializarProgreso(a), serializarProgreso(ajena), serializarProgreso(a)]);
    expect(cabeza.revisionServidor).toBe(2); expect(decisiones.get('a')?.instantanea.revisionServidor).toBe(1);
    expect((await primero.leer()).revisionServidor).toBe(2); expect((await primero.leer()).cola).toEqual([]);
    expect((await segundo.leer()).cola).toEqual([]);
  });

  it('acotar un ciclo mantiene al hijo durable para la próxima invocación explícita', async () => {
    const a = operacion(); const b = { ...operacion('b', 1), marca: 'saltada' as const };
    const local = await contexto([a, b]); let cabeza = instantanea(); const ids: string[] = [];
    const emisor = transporte(local, async (_, o) => {
      if (o.method === 'GET') return respuesta(cabeza, 200, `"r${cabeza.revisionServidor}"`);
      const op = parsearProgreso(String(o.body)) as Operacion; ids.push(op.id);
      const dto = op.id === 'a' ? acuse(a) : acuse(b, 2, a); cabeza = dto.instantanea;
      return respuesta(dto);
    }, { maxEnvios: 1 });
    await emisor.sincronizar(); expect(ids).toEqual(['a']); expect(emisor.estado.pendientes).toBe(1);
    await emisor.sincronizar(); expect(ids).toEqual(['a', 'b']);
  });

  it('el guard durable fresco impide POST cuando otra acción cancela la intención', async () => {
    const local = await contexto(); const marcar = local.marcarEnviada.bind(local);
    vi.spyOn(local, 'marcarEnviada').mockImplementation(async (id) => {
      await local.cancelarIntencion(id); return marcar(id);
    });
    const http = vi.fn(async () => respuesta(instantanea(), 200, '"base"'));
    const emisor = transporte(local, http); await emisor.sincronizar();
    expect(http).toHaveBeenCalledTimes(1); expect((await local.leer()).cola).toEqual([]);
  });

  it('rechaza una raíz corrupta antes de HTTP y no olvida incertidumbre ya conocida', async () => {
    const local = await contexto(); await local.marcarEnviada('a');
    const http = vi.fn(async () => respuesta(instantanea(), 200, '"base"'));
    const emisor = transporte(local, http);
    vi.spyOn(local, 'marcarEnviada').mockRejectedValue(new Error('IDB'));
    await emisor.sincronizar(); expect(emisor.estado.incertidumbre).toBe(true);
    const raiz = await local.leer();
    vi.spyOn(local, 'leer').mockResolvedValue({ ...raiz, estado: crearProgreso(plan) });
    await emisor.sincronizar();
    expect(http).toHaveBeenCalledTimes(1); expect(emisor.estado.tipo).toBe('fallo-local');
  });

  it('no persiste negativo si el commit local falla ni habilita dependientes', async () => {
    const a = operacion(); const b = { ...operacion('b', 1), marca: 'saltada' as const };
    const local = await contexto([a, b]);
    vi.spyOn(local, 'recibirRechazo').mockRejectedValue(new Error('IDB'));
    const emisor = transporte(local, async (_, o) => o.method === 'GET'
      ? respuesta(instantanea(), 200, '"base"') : respuesta(rechazo(a), 409));
    await emisor.sincronizar();
    const raiz = await local.leer();
    expect(raiz.cola[0].rechazo).toBeUndefined(); expect(raiz.cola[1].dependeDe).toEqual(['a']);
    expect(emisor.estado.tipo).toBe('fallo-local'); expect(emisor.estado.incertidumbre).toBe(true);
  });

  it('304 con etiqueta distinta no libera cola y POST nunca modifica la etiqueta del GET', async () => {
    const local = await contexto(); const etiquetas: (string | null)[] = []; let gets = 0;
    const emisor = transporte(local, async (_, o) => {
      if (o.method === 'POST') return respuesta(acuse(operacion()), 200, '"post-no-get"');
      etiquetas.push(new Headers(o.headers).get('If-None-Match'));
      return ++gets === 1 ? respuesta(instantanea(), 200, '"get"')
        : new Response(null, { status: 304, headers: { ETag: '"ajena"' } });
    });
    await emisor.sincronizar(); await emisor.sincronizar();
    expect(etiquetas).toEqual([null, '"get"']); expect(emisor.estado.tipo).toBe('incierto');
  });

  it('un GET 401 detiene toda salida sin transformar pendientes en negativas', async () => {
    const local = await contexto(); const http = vi.fn(async () => new Response(null, { status: 401 }));
    const emisor = transporte(local, http); await emisor.sincronizar();
    expect(http).toHaveBeenCalledTimes(1); expect(emisor.estado.tipo).toBe('sin-sesion');
    expect((await local.leer()).cola[0].enviada).toBe(false);
  });

  it('acepta diario validado mayor de 8 KiB sin inventar un límite de operación para GET', async () => {
    const local = await contexto([]); const ops: Operacion[] = [];
    for (let i = 0; i < 60; i++) ops.push({ ...operacion(`historia-${i}`, i),
      marca: i % 2 === 0 ? 'hecha' : 'saltada' });
    const grande = instantanea(60, ...ops);
    expect(serializarProgreso(grande).length).toBeGreaterThan(8192);
    const emisor = transporte(local, async () => respuesta(grande, 200, '"grande"'));
    await emisor.sincronizar(); expect((await local.leer()).revisionServidor).toBe(60);
    expect(emisor.estado.tipo).toBe('listo');
  });

  it('timeout también limita un cuerpo que se cuelga y un rechazo tardío no queda sin manejar', async () => {
    const local = await contexto(); let rechazar!: (error: Error) => void;
    const emisor = transporte(local, async (_, o) => {
      if (o.method === 'GET') return respuesta(instantanea(), 200, '"base"');
      return new Promise<Response>((_, reject) => { rechazar = reject; });
    }, { timeoutMs: 10 });
    await emisor.sincronizar(); rechazar(new Error('Tardío privado'));
    await Promise.resolve(); expect(emisor.estado.incertidumbre).toBe(true);
    const otro = transporte(local, async (_, o) => o.method === 'GET'
      ? respuesta(instantanea(), 200, '"base"')
      : new Response(new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode('{')); } }),
        { headers: { 'Content-Type': 'application/json' } }), { timeoutMs: 10 });
    await otro.sincronizar(); expect(otro.estado.tipo).toBe('incierto');
    expect((await local.leer()).cola[0].enviada).toBe(true);
  });

  it('rechaza respuesta que supera 16 MiB sin truncar ni confirmar', async () => {
    const local = await contexto([]);
    const emisor = transporte(local, async () => new Response(new Uint8Array(16 * 1024 * 1024 + 1),
      { headers: { 'Content-Type': 'application/json', ETag: '"grande"' } }));
    await emisor.sincronizar(); expect(emisor.estado.tipo).toBe('incierto');
    expect((await local.leer()).revisionServidor).toBe(0);
  });

  it('reentrada del observador se coalesce y cerrar no cierra el almacén propio', async () => {
    const local = await contexto([]); let reentrada: Promise<void> | undefined; let avisos = 0;
    const http = vi.fn(async () => respuesta(instantanea(), 200, '"base"'));
    const emisor = transporte(local, http, { alCambiar: () => { avisos++; reentrada = emisor.sincronizar(); } });
    const ciclo = emisor.sincronizar(); await ciclo; expect(reentrada).toBe(ciclo);
    expect(http).toHaveBeenCalledTimes(1); emisor.cerrar(); const antes = avisos;
    await emisor.sincronizar(); expect(avisos).toBe(antes); expect((await local.leer()).formato).toBe(3);
  });

  it.each(['HTML', 'redirect', 'JSON roto'])('POST %s conserva incertidumbre sin decidir', async (caso) => {
    const local = await contexto();
    const emisor = transporte(local, async (_, o) => {
      if (o.method === 'GET') return respuesta(instantanea(), 200, '"base"');
      if (caso === 'HTML') return new Response('<html>Entrar</html>', { headers: { 'Content-Type': 'text/html' } });
      if (caso === 'JSON roto') return new Response('{', { headers: { 'Content-Type': 'application/json' } });
      const r = respuesta(acuse(operacion())); Object.defineProperty(r, 'redirected', { value: true }); return r;
    });
    await emisor.sincronizar(); expect(emisor.estado.incertidumbre).toBe(true);
    expect((await local.leer()).cola[0].enviada).toBe(true);
    expect((await local.leer()).cola[0].rechazo).toBeUndefined();
  });

  it('también aísla un observador asíncrono rechazado sin alterar IDB', async () => {
    const local = await contexto([]);
    const emisor = transporte(local, async () => respuesta(instantanea(), 200, '"base"'),
      { alCambiar: async () => { throw new Error('Privado asíncrono'); } });
    await emisor.sincronizar(); expect(emisor.estado.tipo).toBe('listo');
  });

  it('errores del observador no destruyen el acuse durable ni exponen errores privados', async () => {
    const local = await contexto();
    const emisor = transporte(local, async (_, o) => o.method === 'GET'
      ? respuesta(instantanea(), 200, '"base"') : respuesta(acuse(operacion())),
    { alCambiar: () => { throw new Error('Privado'); } });
    await emisor.sincronizar();
    expect((await local.leer()).cola).toEqual([]); expect(emisor.estado.tipo).toBe('listo');
  });
});
