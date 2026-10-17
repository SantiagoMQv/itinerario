// Adaptador de interfaz del progreso compartido. IndexedDB SIMULADA (fake-indexeddb) y HTTP hacia
// el controlador y el almacén REALES del servidor con una pasarela en memoria: no es IDB nativa,
// Cloudflare ni Neon (eso queda para pruebas/progreso-compartido.e2e.ts y T7/T8).
import { IDBFactory, IDBObjectStore } from 'fake-indexeddb';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { crearProgreso, type Operacion } from '../src/progreso';
import type { InstantaneaProgreso } from '../src/progreso-validacion';
import {
  CLAVE_DISPOSITIVO, capturarLegado, crearProgresoInterfaz, identidadDispositivo, resumenCompartido,
  type ProgresoInterfaz, type VistaProgreso,
} from '../src/progreso-interfaz';
import { CLAVE_IDENTIFICADOR_DISPOSITIVO } from '../servidor/entrada';
import { crearControladorProgreso } from '../servidor/api-progreso';
import { crearAlmacenProgreso, type DecisionHistorica } from '../servidor/almacen-progreso';
import type { Itinerario } from '../src/tipos';

const plan: Itinerario = {
  id: 'viaje', titulo: 'Prueba', dias: [{ fecha: '2026-10-21', titulo: 'Día', paradas: [
    { id: 'p1', nombre: 'Uno', hora: '09:00', categoria: 'otro', lat: 0, lng: 0 },
    { id: 'p2', nombre: 'Dos', hora: '10:00', categoria: 'otro', lat: 0, lng: 0 },
    { id: 'p3', nombre: 'Tres', hora: '11:00', categoria: 'otro', lat: 0, lng: 0 },
  ] }], pendientes: [{ id: 'c1', texto: 'Reserva' }, { id: 'c2', texto: 'Maleta' }],
};

/** Almacén de pruebas tipo localStorage que registra cada escritura. */
function almacen(inicial: Record<string, string> = {}, fallos: string[] = []) {
  const datos = new Map(Object.entries(inicial));
  const escrituras: string[] = [];
  return {
    datos, escrituras,
    getItem: (k: string) => { if (fallos.includes(k)) throw new DOMException('Bloqueado', 'SecurityError'); return datos.get(k) ?? null; },
    setItem: (k: string, v: string) => { escrituras.push(k); datos.set(k, v); },
    removeItem: (k: string) => { escrituras.push(`-${k}`); datos.delete(k); },
  };
}

/** Servidor real (controlador + almacén) con pasarela en memoria y control de sesión/red. */
function crearServidor() {
  let actual: InstantaneaProgreso = { revisionServidor: 0, estado: crearProgreso(plan) };
  const decisiones = new Map<string, DecisionHistorica>();
  const s = {
    sesion: true, perderRespuesta: false, cortada: false,
    peticiones: [] as string[], posts: [] as Operacion[],
    retener: undefined as Promise<void> | undefined,
    get actual() { return actual; },
    /** Escritura directa de «otro móvil» por la misma API. */
    async otro(op: Operacion) {
      const r = await s.http('/api/progreso', { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(op) }, false);
      return r.status;
    },
    async http(url: string, opciones: RequestInit, registrar = true): Promise<Response> {
      if (registrar) s.peticiones.push(String(opciones.method));
      if (s.cortada) throw new TypeError('Failed to fetch');
      if (opciones.method === 'POST' && registrar) {
        s.posts.push(JSON.parse(String(opciones.body)) as Operacion);
        if (s.retener) await s.retener;
      }
      const respuesta = await controlador.atender(new Request(`https://viaje.test${url}`, {
        method: opciones.method, body: opciones.body as string | undefined,
        headers: { ...(opciones.headers as Record<string, string>), Origin: 'https://viaje.test' },
      }));
      if (s.perderRespuesta && opciones.method === 'POST' && registrar) throw new TypeError('Failed to fetch');
      return respuesta;
    },
  };
  const controlador = crearControladorProgreso({ plan, autenticar: async () => (s.sesion ? {
    id: '00000000-0000-4000-8000-000000000001', huella: 'a'.repeat(64), viajeId: plan.id,
    dispositivoId: 'sesion', creadaEn: 0, venceEn: 4_000_000_000_000, revocada: false } : null),
  repositorio: crearAlmacenProgreso({ plan, pasarela: {
    async consultar(_h: string, _v: string, id?: string) {
      return { tipo: 'lectura', instantanea: structuredClone(actual),
        decision: id === undefined ? null : structuredClone(decisiones.get(id) ?? null) };
    },
    async confirmar(_h: string, _v: string, base: number, candidato: DecisionHistorica) {
      if (base !== actual.revisionServidor) return { tipo: 'desfase' };
      actual = structuredClone(candidato.tipo === 'positiva' ? candidato.acuse.instantanea
        : { revisionServidor: candidato.rechazo.instantanea.revisionServidor, estado: actual.estado });
      decisiones.set(candidato.tipo === 'positiva' ? candidato.acuse.operacionId : candidato.rechazo.operacionId,
        structuredClone(candidato));
      return { tipo: 'comprometida' };
    },
  } }) });
  return s;
}

const cierres: (() => void)[] = [];
afterEach(() => { for (const cerrar of cierres.splice(0)) cerrar(); vi.restoreAllMocks(); });
let numero = 0;
function interfaz(servidor = crearServidor(), opciones: { fabrica?: IDBFactory | null; legado?: Record<string, unknown>;
  dispositivoId?: string; vistas?: VistaProgreso[] } = {}) {
  const fabrica = opciones.fabrica === undefined ? new IDBFactory() : opciones.fabrica;
  const p = crearProgresoInterfaz({ plan, dispositivoId: opciones.dispositivoId ?? 'movil-a',
    entradasLegadas: opciones.legado ?? {}, fabrica, nombre: 'interfaz', http: (u, o) => servidor.http(u, o),
    uuid: () => `00000000-0000-4000-8000-${String(++numero).padStart(12, '0')}`,
    alCambiar: (v) => opciones.vistas?.push(v) });
  cierres.push(() => p.cerrar());
  return { p, fabrica, servidor };
}
async function abierta(...args: Parameters<typeof interfaz>) {
  const r = interfaz(...args);
  await r.p.abrir();
  await r.p.sincronizar();
  return r;
}
const marcaDe = (p: ProgresoInterfaz, id: string) => p.vista.raiz?.estado.paradas[id]?.marca ?? null;

describe('solo este móvil (web publicada: sin cliente de progreso)', () => {
  it('abre, marca, deshace e importa el legado sin transporte ni ninguna petición', async () => {
    const p = crearProgresoInterfaz({ plan, dispositivoId: 'movil-a', http: null, fabrica: new IDBFactory(), nombre: 'local',
      entradasLegadas: { marcas: '{"2026-10-21|10:00|Dos":"saltada"}' },
      uuid: () => `00000000-0000-4000-8000-${String(++numero).padStart(12, '0')}` });
    cierres.push(() => p.cerrar());
    await p.abrir();
    expect(p.vista.fase).toBe('lista');
    expect(p.vista.transporte).toBeNull();
    expect(p.compartido).toBe(false);
    expect(marcaDe(p, 'p2')).toBe('saltada');
    const r = await p.marcarParada('p1', 'hecha', 600);
    expect(r.tipo).toBe('guardada');
    await p.sincronizar();
    expect(marcaDe(p, 'p1')).toBe('hecha');
    expect(p.vista.raiz?.cola.every((e) => !e.enviada)).toBe(true);
    // Nada que pedir: ni «sin enviar» ni «Sincronizar»; lo guardado aquí es lo que hay.
    expect(resumenCompartido(p.vista, true, false)).toEqual({ pildora: null, accion: null, ocupado: false,
      detalle: 'Lo marcado se guarda solo en este móvil.' });
    if (r.tipo === 'guardada') expect((await p.deshacer(r.operacionId)).tipo).toBe('cancelada');
    expect(marcaDe(p, 'p1')).toBeNull();
  });
  it('si lo guardado no se puede abrir, lo sigue diciendo también sin compartir', () => {
    const v: VistaProgreso = { fase: 'fallo-local', raiz: null, transporte: null, ocupado: false, atascadas: [] };
    expect(resumenCompartido(v, true, false).pildora).toBe('Marcas sin abrir');
  });
});

describe('lectura de lo guardado antes en este móvil', () => {
  it('captura los textos originales de las tres claves sin interpretarlos ni escribir nada', () => {
    const s = almacen({ marcas: '{"roto":', 'marcas-hora': '{"x":1}', 'pendientes-hechos': '["Reserva"]', tema: '"oscuro"' });
    expect(capturarLegado(s)).toEqual({ marcas: '{"roto":', 'marcas-hora': '{"x":1}', 'pendientes-hechos': '["Reserva"]' });
    expect(s.escrituras).toEqual([]);
  });

  it('omite las ausentes y deja constancia de las que no se pudieron leer', () => {
    expect(capturarLegado(almacen({ marcas: '{}' }, ['marcas-hora']))).toEqual({ marcas: '{}', 'lectura-fallida': ['marcas-hora'] });
    expect(capturarLegado(null)).toEqual({ 'lectura-fallida': ['marcas', 'marcas-hora', 'pendientes-hechos'] });
  });

  it('la identidad del móvil es la misma clave que usa /entrar, estable y sin autoridad', () => {
    expect(CLAVE_DISPOSITIVO).toBe(CLAVE_IDENTIFICADOR_DISPOSITIVO);
    const s = almacen({ [CLAVE_DISPOSITIVO]: '3f2b8c1e-9d4a-4b6f-8a1c-2e5d7f9a0b3c', marcas: '{}' });
    expect(identidadDispositivo(s, () => 'nuevo')).toEqual({ id: '3f2b8c1e-9d4a-4b6f-8a1c-2e5d7f9a0b3c', duradera: true });
    expect(s.escrituras).toEqual([]);
    const vacio = almacen();
    const creada = identidadDispositivo(vacio, () => '11111111-1111-4111-8111-111111111111');
    expect(creada).toEqual({ id: '11111111-1111-4111-8111-111111111111', duradera: true });
    expect(vacio.escrituras).toEqual([CLAVE_DISPOSITIVO]);
    expect(identidadDispositivo(almacen({}, [CLAVE_DISPOSITIVO]), () => '22222222-2222-4222-8222-222222222222'))
      .toEqual({ id: '22222222-2222-4222-8222-222222222222', duradera: false });
  });
});

describe('apertura asíncrona', () => {
  it('mientras abre no acepta acciones; al abrir importa el legado una sola vez', async () => {
    const vistas: VistaProgreso[] = [];
    const legado = { marcas: '{"2026-10-21|09:00|Uno":"hecha"}', 'pendientes-hechos': '["Reserva","Otra"]' };
    const { p, fabrica, servidor } = interfaz(crearServidor(), { legado, vistas });
    const abriendo = p.abrir();
    expect(p.vista.fase).toBe('abriendo');
    expect(await p.marcarParada('p2', 'hecha')).toEqual({ tipo: 'no-lista' });
    await abriendo;
    expect(p.vista.fase).toBe('lista');
    expect(marcaDe(p, 'p1')).toBe('hecha');
    expect(p.vista.raiz!.estado.pendientes.c1.hecho).toBe(true);
    expect(p.vista.raiz!.legado!.originales).toEqual(legado);
    expect(vistas.map((v) => v.fase)).toContain('abriendo');
    p.cerrar();

    // Otra apertura con otro legado no reimporta ni pisa lo guardado.
    const otra = crearProgresoInterfaz({ plan, dispositivoId: 'movil-a', entradasLegadas: { marcas: '{"2026-10-21|10:00|Dos":"saltada"}' },
      fabrica, nombre: 'interfaz', http: (u, o) => servidor.http(u, o) });
    cierres.push(() => otra.cerrar());
    await otra.abrir();
    expect(otra.vista.raiz!.legado!.originales).toEqual(legado);
    expect(marcaDe(otra, 'p2')).toBe(null);
  });

  it('un fallo al abrir queda visible, no inventa una raíz y se puede reintentar', async () => {
    const fabrica = new IDBFactory();
    const abrir = vi.spyOn(fabrica, 'open').mockImplementationOnce(() => { throw new DOMException('roto', 'UnknownError'); });
    const { p } = interfaz(crearServidor(), { fabrica });
    await p.abrir();
    expect(p.vista.fase).toBe('fallo-local');
    expect(p.vista.raiz).toBeNull();
    expect(await p.marcarParada('p1', 'hecha')).toEqual({ tipo: 'no-lista' });
    expect(resumenCompartido(p.vista, true)).toMatchObject({ pildora: 'Marcas sin abrir', accion: 'reintentar' });
    abrir.mockRestore();
    await p.abrir();
    expect(p.vista.fase).toBe('lista');
  });

  it('sin IndexedDB no hay respaldo silencioso en localStorage', async () => {
    const { p } = interfaz(crearServidor(), { fabrica: null });
    await p.abrir();
    expect(p.vista.fase).toBe('fallo-local');
  });
});

describe('acciones locales durables', () => {
  it('un solo aquí: llegar a otra parada cierra la anterior en la misma operación', async () => {
    const { p, servidor } = await abierta();
    expect((await p.marcarParada('p1', 'aqui', 600)).tipo).toBe('guardada');
    expect((await p.marcarParada('p2', 'aqui', 660)).tipo).toBe('guardada');
    await p.sincronizar();
    const estado = p.vista.raiz!.estado;
    expect(estado.aqui.paradaId).toBe('p2');
    expect(estado.paradas.p1.marca).toBe('hecha');
    expect(Object.values(estado.paradas).filter((r) => r.marca === 'aqui')).toHaveLength(1);
    const segunda = servidor.posts.find((op) => op.tipo === 'parada' && op.paradaId === 'p2')!;
    expect(segunda).toMatchObject({ marca: 'aqui', revision: 0, revisionAqui: 1, revisionAnterior: 1, horaReal: 660 });
    expect(servidor.actual.estado.aqui.paradaId).toBe('p2');
  });

  it('no dice «guardada» si la escritura durable falla', async () => {
    const { p } = await abierta();
    vi.spyOn(IDBObjectStore.prototype, 'put').mockImplementation(() => { throw new DOMException('Lleno', 'QuotaExceededError'); });
    expect(await p.marcarParada('p1', 'hecha')).toEqual({ tipo: 'fallo-local' });
    vi.restoreAllMocks();
    expect(marcaDe(p, 'p1')).toBe(null);
  });

  it('una acción en curso bloquea la siguiente: no hay doble toque', async () => {
    const { p } = await abierta();
    const [a, b] = await Promise.all([p.marcarParada('p1', 'hecha'), p.marcarParada('p1', 'saltada')]);
    expect(a.tipo).toBe('guardada');
    expect(b).toEqual({ tipo: 'ocupada' });
    expect(marcaDe(p, 'p1')).toBe('hecha');
  });

  it('las casillas usan su ID y su revisión', async () => {
    const { p, servidor } = await abierta();
    expect((await p.marcarPendiente('c2', true)).tipo).toBe('guardada');
    await p.sincronizar();
    expect(servidor.actual.estado.pendientes.c2).toEqual({ hecho: true, revision: 1 });
    expect((await p.marcarPendiente('c2', false)).tipo).toBe('guardada');
    await p.sincronizar();
    expect(servidor.posts.at(-1)).toMatchObject({ tipo: 'pendiente', pendienteId: 'c2', hecho: false, revision: 1 });
  });
});

describe('deshacer solo la operación propia', () => {
  it('sin enviar se cancela y no llega al servidor', async () => {
    const servidor = crearServidor(); servidor.sesion = false;
    const { p } = await abierta(servidor);
    const r = await p.marcarParada('p1', 'hecha');
    if (r.tipo !== 'guardada') throw new Error('No se guardó');
    expect(await p.deshacer(r.operacionId)).toEqual({ tipo: 'cancelada' });
    expect(p.vista.raiz!.cola).toEqual([]);
    servidor.sesion = true;
    await p.sincronizar();
    expect(servidor.posts).toEqual([]);
  });

  it('enviado se compensa con el recibo actual sin tocar otras marcas', async () => {
    const { p, servidor } = await abierta();
    const r = await p.marcarParada('p1', 'hecha');
    await p.marcarParada('p2', 'saltada');
    await p.sincronizar();
    if (r.tipo !== 'guardada') throw new Error('No se guardó');
    expect((await p.deshacer(r.operacionId)).tipo).toBe('compensada');
    await p.sincronizar();
    expect(servidor.actual.estado.paradas.p1.marca).toBe(null);
    expect(servidor.actual.estado.paradas.p2.marca).toBe('saltada');
    expect(servidor.posts.at(-1)!.tipo).toBe('deshacer');
  });

  it('si el otro móvil cambió lo mismo después, no se deshace ni se pisa su cambio', async () => {
    const { p, servidor } = await abierta();
    const r = await p.marcarParada('p1', 'hecha');
    await p.sincronizar();
    expect(await servidor.otro({ id: 'otro-1', dispositivoId: 'movil-b', tipo: 'parada', paradaId: 'p1', marca: 'saltada', revision: 1 })).toBe(200);
    await p.sincronizar();
    if (r.tipo !== 'guardada') throw new Error('No se guardó');
    expect((await p.deshacer(r.operacionId)).tipo).toBe('conflicto');
    await p.sincronizar();
    expect(servidor.actual.estado.paradas.p1.marca).toBe('saltada');
    expect(marcaDe(p, 'p1')).toBe('saltada');
  });
});

describe('sincronización y estados honestos', () => {
  it('una acción durante un ciclo activo provoca un ciclo más, no un sondeo', async () => {
    const servidor = crearServidor();
    const { p } = await abierta(servidor);
    let soltar!: () => void;
    servidor.retener = new Promise((ok) => { soltar = ok; });
    await p.marcarParada('p1', 'hecha');
    const ciclo = p.sincronizar();
    await vi.waitFor(() => expect(servidor.posts).toHaveLength(1));
    await p.marcarParada('p2', 'hecha');
    soltar(); servidor.retener = undefined;
    await ciclo;
    await p.sincronizar();
    expect(servidor.posts.map((op) => op.tipo === 'parada' && op.paradaId)).toEqual(['p1', 'p2']);
    expect(p.vista.raiz!.cola).toEqual([]);
    const ciclos = servidor.peticiones.filter((m) => m === 'GET').length;
    await new Promise((ok) => setTimeout(ok, 30));
    expect(servidor.peticiones.filter((m) => m === 'GET').length).toBe(ciclos);
  });

  it('401: no borra la cola ni lo marcado y solo ofrece Entrar con conexión', async () => {
    const servidor = crearServidor(); servidor.sesion = false;
    const { p } = await abierta(servidor);
    await p.marcarParada('p1', 'hecha');
    await p.sincronizar();
    expect(p.vista.transporte!.tipo).toBe('sin-sesion');
    expect(p.vista.raiz!.cola).toHaveLength(1);
    expect(marcaDe(p, 'p1')).toBe('hecha');
    expect(resumenCompartido(p.vista, true)).toMatchObject({ pildora: 'Sin sesión · 1 sin enviar', accion: 'entrar' });
    expect(resumenCompartido(p.vista, false).accion).toBe(null);
  });

  it('respuesta perdida: reintenta el mismo original y nunca crea otro ID', async () => {
    const servidor = crearServidor(); servidor.perderRespuesta = true;
    const { p } = await abierta(servidor);
    await p.marcarParada('p1', 'hecha');
    await p.sincronizar();
    expect(resumenCompartido(p.vista, true).pildora).toBe('Sin confirmar');
    // El disparo tras la acción y el explícito se agrupan en dos ciclos: dos envíos perdidos.
    expect(servidor.posts).toHaveLength(2);
    servidor.perderRespuesta = false;
    await p.sincronizar();
    expect(servidor.posts).toHaveLength(3);
    for (const enviado of servidor.posts) expect(enviado).toEqual(servidor.posts[0]);
    expect(servidor.actual.revisionServidor).toBe(1);
    expect(p.vista.raiz!.cola).toEqual([]);
    expect(resumenCompartido(p.vista, true).pildora).toBe(null);
  });

  it('un rechazo del servidor espera a que se revise a mano y no se reenvía', async () => {
    const servidor = crearServidor();
    const { p } = await abierta(servidor);
    let soltar!: () => void;
    servidor.retener = new Promise((ok) => { soltar = ok; });
    await p.marcarParada('p1', 'aqui');
    const ciclo = p.sincronizar();
    await vi.waitFor(() => expect(servidor.posts).toHaveLength(1));
    expect(await servidor.otro({ id: 'otro-1', dispositivoId: 'movil-b', tipo: 'parada', paradaId: 'p2', marca: 'aqui',
      revision: 0, revisionAqui: 0 })).toBe(200);
    soltar(); servidor.retener = undefined;
    await ciclo;
    expect(resumenCompartido(p.vista, true)).toMatchObject({ pildora: 'Un cambio no se aplicó', accion: 'revisar' });
    const rechazada = p.vista.raiz!.cola.find((e) => e.rechazo)!;
    await p.sincronizar();
    expect(servidor.posts).toHaveLength(1);
    expect((await p.conservarConfirmado(rechazada.operacion.id)).tipo).toBe('guardada');
    expect(resumenCompartido(p.vista, true).pildora).toBe(null);
    expect(p.vista.raiz!.estado.aqui.paradaId).toBe('p2');
  });

  it('un cambio que ya choca en local no se envía y se puede descartar', async () => {
    const servidor = crearServidor();
    const { p } = await abierta(servidor);
    await p.marcarParada('p1', 'aqui');
    servidor.cortada = true;
    await p.sincronizar();
    servidor.cortada = false;
    // Mientras, el otro móvil cambia el aquí; este móvil lo descubre al leer.
    expect(await servidor.otro({ id: 'otro-1', dispositivoId: 'movil-b', tipo: 'parada', paradaId: 'p2', marca: 'aqui',
      revision: 0, revisionAqui: 0 })).toBe(200);
    await p.sincronizar();
    const resumen = resumenCompartido(p.vista, true);
    expect(resumen).toMatchObject({ pildora: 'Un cambio choca', accion: 'revisar' });
    expect(servidor.posts.filter((op) => op.dispositivoId === 'movil-a')).toHaveLength(0);
    const atascada = p.vista.atascadas[0];
    expect(atascada.tipo).toBe('conflicto');
    expect((await p.descartar(atascada.operacionId)).tipo).toBe('guardada');
    expect(p.vista.raiz!.cola).toEqual([]);
  });

  it('cerrar ignora avisos posteriores', async () => {
    const vistas: VistaProgreso[] = [];
    const { p } = await abierta(crearServidor(), { vistas });
    p.cerrar();
    const n = vistas.length;
    await p.sincronizar();
    expect(vistas.length).toBe(n);
    expect(p.vista.fase).toBe('cerrada');
  });
});

describe('sincronizar sin ciclo posible no deja un candado', () => {
  const lecturasGet = (servidor: ReturnType<typeof crearServidor>) => servidor.peticiones.filter((m) => m === 'GET').length;

  it('apertura fallida como en el arranque, reintento y marca: el envío llega al servidor', async () => {
    const servidor = crearServidor();
    const fabrica = new IDBFactory();
    vi.spyOn(fabrica, 'open').mockImplementationOnce(() => { throw new DOMException('roto', 'UnknownError'); });
    const { p } = interfaz(servidor, { fabrica });
    // Igual que main.ts: abrir y después sincronizar, también cuando la apertura falla.
    await p.abrir().then(() => p.sincronizar());
    expect(p.vista.fase).toBe('fallo-local');
    expect(servidor.peticiones).toEqual([]);

    await p.abrir();
    expect(p.vista.fase).toBe('lista');
    const r = await p.marcarParada('p1', 'hecha');
    if (r.tipo !== 'guardada') throw new Error('No se guardó');
    expect(p.vista.raiz!.cola.map((e) => e.operacion.id)).toEqual([r.operacionId]);
    await p.sincronizar();
    await p.sincronizar();
    expect(lecturasGet(servidor)).toBeGreaterThanOrEqual(2);
    expect(servidor.posts.map((op) => op.id)).toEqual([r.operacionId]);
    expect(servidor.actual.estado.paradas.p1.marca).toBe('hecha');
    expect(p.vista.raiz!.cola).toEqual([]);
    expect(resumenCompartido(p.vista, true).pildora).toBe(null);
  });

  it('pedirlo antes de abrir o mientras abre no hace nada ni bloquea los ciclos siguientes', async () => {
    const servidor = crearServidor();
    const { p } = interfaz(servidor);
    await p.sincronizar();
    const abriendo = p.abrir();
    expect(p.vista.fase).toBe('abriendo');
    await p.sincronizar();
    await abriendo;
    expect(servidor.peticiones).toEqual([]);
    await p.sincronizar();
    expect(servidor.peticiones).toEqual(['GET']);
  });

  it('reabrir durante un ciclo no se traga la sincronización de la nueva apertura', async () => {
    const servidor = crearServidor();
    const { p } = await abierta(servidor);
    let soltar!: () => void;
    servidor.retener = new Promise((ok) => { soltar = ok; });
    const r = await p.marcarParada('p1', 'hecha');
    if (r.tipo !== 'guardada') throw new Error('No se guardó');
    await vi.waitFor(() => expect(servidor.posts).toHaveLength(1));
    await p.abrir();
    const antes = lecturasGet(servidor);
    const nueva = p.sincronizar();
    soltar(); servidor.retener = undefined;
    await nueva;
    expect(lecturasGet(servidor)).toBeGreaterThan(antes);
    // El mismo original, reenviado; nunca otro ID.
    expect(new Set(servidor.posts.map((op) => op.id))).toEqual(new Set([r.operacionId]));
    expect(servidor.actual.estado.paradas.p1.marca).toBe('hecha');
    expect(p.vista.raiz!.cola).toEqual([]);
  });

  it('dos sincronizaciones seguidas son dos ciclos; cerrada, ninguno', async () => {
    const { p, servidor } = await abierta();
    const antes = lecturasGet(servidor);
    await p.sincronizar();
    await p.sincronizar();
    expect(lecturasGet(servidor)).toBe(antes + 2);
    p.cerrar();
    await p.sincronizar();
    expect(lecturasGet(servidor)).toBe(antes + 2);
  });
});

describe('incertidumbre independiente junto a un rechazo o un choque', () => {
  it('un rechazo conocido no oculta un envío sin confirmar de otro cambio', async () => {
    const servidor = crearServidor();
    const { p } = await abierta(servidor);
    let soltar!: () => void;
    servidor.retener = new Promise((ok) => { soltar = ok; });
    await p.marcarParada('p1', 'aqui');
    const ciclo = p.sincronizar();
    await vi.waitFor(() => expect(servidor.posts).toHaveLength(1));
    expect(await servidor.otro({ id: 'otro-1', dispositivoId: 'movil-b', tipo: 'parada', paradaId: 'p2', marca: 'aqui',
      revision: 0, revisionAqui: 0 })).toBe(200);
    soltar(); servidor.retener = undefined;
    await ciclo;
    // Solo el rechazo: ninguna incertidumbre inventada.
    const soloRechazo = resumenCompartido(p.vista, true);
    expect(soloRechazo).toMatchObject({ pildora: 'Un cambio no se aplicó', accion: 'revisar' });
    expect(soloRechazo.detalle).not.toMatch(/sin confirmar/);

    // Otro cambio, independiente, se envía y su respuesta se pierde.
    servidor.perderRespuesta = true;
    await p.marcarParada('p3', 'hecha');
    await p.sincronizar();
    const cola = p.vista.raiz!.cola;
    expect(cola.filter((e) => e.rechazo)).toHaveLength(1);
    expect(cola.filter((e) => e.enviada && !e.rechazo)).toHaveLength(1);
    const ambos = resumenCompartido(p.vista, true);
    expect(ambos).toMatchObject({ pildora: 'Un cambio no se aplicó', accion: 'revisar' });
    expect(ambos.detalle).toMatch(/1 sin confirmar/);
  });

  it('un choque local tampoco oculta un envío sin confirmar', async () => {
    const servidor = crearServidor();
    const { p } = await abierta(servidor);
    servidor.cortada = true;
    await p.marcarParada('p1', 'aqui');
    await p.sincronizar();
    servidor.cortada = false;
    expect(await servidor.otro({ id: 'otro-1', dispositivoId: 'movil-b', tipo: 'parada', paradaId: 'p2', marca: 'aqui',
      revision: 0, revisionAqui: 0 })).toBe(200);
    await p.sincronizar();
    const soloChoque = resumenCompartido(p.vista, true);
    expect(soloChoque).toMatchObject({ pildora: 'Un cambio choca', accion: 'revisar' });
    expect(soloChoque.detalle).not.toMatch(/sin confirmar/);

    servidor.perderRespuesta = true;
    await p.marcarParada('p3', 'hecha');
    await p.sincronizar();
    const ambos = resumenCompartido(p.vista, true);
    expect(ambos).toMatchObject({ pildora: 'Un cambio choca', accion: 'revisar' });
    expect(ambos.detalle).toMatch(/1 sin confirmar/);
  });
});

describe('resumen visible', () => {
  it('nada pendiente no se presenta como recibido por el otro móvil', async () => {
    const { p } = await abierta();
    const r = resumenCompartido(p.vista, true);
    expect(r.pildora).toBe(null);
    expect(r.detalle).not.toMatch(/otro móvil (ya )?(lo )?(tiene|recibió|vio)/);
  });

  it('sin conexión dice cuántos cambios quedan guardados aquí', async () => {
    const servidor = crearServidor(); servidor.cortada = true;
    const { p } = await abierta(servidor);
    await p.marcarParada('p1', 'hecha');
    await p.sincronizar();
    expect(resumenCompartido(p.vista, false).pildora).toBe('Sin conexión · 1 sin enviar');
    expect(resumenCompartido(p.vista, true).pildora).toBe('1 sin enviar');
  });
});
