import { IDBFactory, IDBObjectStore } from 'fake-indexeddb';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { aplicarOperacion, crearProgreso, importarLegado, type EstadoProgreso, type Operacion } from '../src/progreso';
import { esEstadoProgreso, esInstantaneaProgreso, iguales, type InstantaneaProgreso } from '../src/progreso-validacion';
import { agregarIntencion, cancelarIntencion, capturarInstantaneaProgreso, iniciarCola, marcarEnviada,
  recibirAcuse, recibirRechazo } from '../src/progreso-cola';
import { abrirProgresoLocal, validarProgresoPortable } from '../src/progreso-local';
import { crearAlmacenProgreso, type DecisionHistorica, type PasarelaProgreso } from '../servidor/almacen-progreso';
import { crearControladorProgreso } from '../servidor/api-progreso';
import type { RegistroSesion } from '../servidor/sesiones';
import { identidades } from '../src/identidades';
import { copiarMetadatos, crearCapturaFoto, esDestinoFoto, esMetadatosFoto, type DestinoFoto } from '../src/fotos';
import { abrirFotosLocal, validarFotosPortables } from '../src/fotos-local';
import { deserializarDestinoListadoFotos, deserializarPaginaListadoFotos, serializarCursorListadoFotos,
  serializarDestinoListadoFotos, serializarPaginaListadoFotos } from '../src/fotos-listado-protocolo';
import { deserializarSolicitudRespaldo, serializarSolicitudRespaldo } from '../src/fotos-protocolo';
import { copiarOriginalRespaldo } from '../src/fotos-respaldo';
import type { Itinerario, Parada, Subparada } from '../src/tipos';

// Plan sintético antes → después del MISMO viaje: «vieja» desaparece con su sitio, «tb» pasa de parada a
// subparada de «cena», el sitio «sx» de «p1» desaparece y el pendiente «cv» se retira. Nada de datos reales.
const parada = (id: string, nombre: string, hora: string, subparadas?: Subparada[]): Parada =>
  ({ id, nombre, hora, categoria: 'otro', lat: 31, lng: 121, ...(subparadas ? { subparadas } : {}) });
const antes: Itinerario = { id: 'viaje', titulo: 'Antes', dias: [{ fecha: '2026-10-21', titulo: 'Día', paradas: [
  parada('p1', 'Uno', '09:00', [{ id: 's1', nombre: 'Dentro' }, { id: 'sx', nombre: 'Sitio quitado' }]),
  parada('vieja', 'Vieja', '10:00', [{ id: 'sv', nombre: 'Sitio viejo' }]),
  parada('tb', 'Top Banana', '21:00', [{ id: 'tbs', nombre: 'Puesto' }]),
] }], pendientes: [{ id: 'c1', texto: 'Reserva' }, { id: 'cv', texto: 'Comprobar la noria' }] };
const retiradas = {
  paradas: [{ id: 'vieja', nombre: 'Vieja' }, { id: 'tb', nombre: 'Top Banana' }],
  subparadas: [{ paradaId: 'p1', id: 'sx', nombre: 'Sitio quitado' }, { paradaId: 'vieja', id: 'sv', nombre: 'Sitio viejo' },
    { paradaId: 'tb', id: 'tbs', nombre: 'Puesto' }],
  pendientes: [{ id: 'cv' }],
};
const despues: Itinerario = { id: 'viaje', titulo: 'Después', dias: [{ fecha: '2026-10-22', titulo: 'Día', paradas: [
  parada('p1', 'Uno', '09:00', [{ id: 's1', nombre: 'Dentro' }]),
  parada('cena', 'Cena', '20:00', [{ id: 'tb', nombre: 'Top Banana' }]),
  parada('p3', 'Nueva', '22:00'),
] }], pendientes: [{ id: 'c1', texto: 'Reserva' }, { id: 'cn', texto: 'Acción nueva' }], retiradas };
/** El mismo plan nuevo sin su historia: el comportamiento de antes de esta unidad. */
const sinHistoria: Itinerario = { ...structuredClone(despues), retiradas: undefined };
delete (sinHistoria as { retiradas?: unknown }).retiradas;

const marca = (id: string, paradaId: string, extra: Partial<Extract<Operacion, { tipo: 'parada' }>> = {}): Operacion =>
  ({ id, dispositivoId: 'movil', tipo: 'parada', paradaId, marca: 'hecha', revision: 0, ...extra });
const casilla = (id: string, pendienteId: string, hecho: boolean, revision = 0): Operacion =>
  ({ id, dispositivoId: 'movil', tipo: 'pendiente', pendienteId, hecho, revision });
function aplicar(plan: Itinerario, estado: EstadoProgreso, op: Operacion): EstadoProgreso {
  const r = aplicarOperacion(plan, estado, op);
  if (r.tipo !== 'aplicada' && r.tipo !== 'sin-cambio') throw new Error(`No se aplicó ${op.id}: ${r.tipo}`);
  return r.estado;
}
/** Historia completa hecha con el plan ANTERIOR: hecha con hora, desmarcada, aquí, casillas true/false y un deshacer. */
function historiaAntigua(): EstadoProgreso {
  let e = crearProgreso(antes);
  e = aplicar(antes, e, marca('op-vieja', 'vieja', { horaReal: 29877930 }));
  e = aplicar(antes, e, marca('op-p1', 'p1'));
  e = aplicar(antes, e, marca('op-p1-desmarca', 'p1', { marca: null, revision: 1 }));
  e = aplicar(antes, e, marca('op-tb-aqui', 'tb', { marca: 'aqui', horaReal: 29877990, revisionAqui: 0 }));
  e = aplicar(antes, e, casilla('op-cv', 'cv', true));
  e = aplicar(antes, e, casilla('op-cv-false', 'cv', false, 1));
  e = aplicar(antes, e, casilla('op-c1', 'c1', true));
  const recibo = e.operaciones['op-c1'].cambios!;
  return aplicar(antes, e, { id: 'op-c1-deshacer', dispositivoId: 'movil', tipo: 'deshacer', cambios: recibo });
}

describe('R1 · historia conocida del mismo viaje se lee entera', () => {
  it('el estado del plan anterior (null, false, aquí, recibos y deshacer) se acepta con su historia', () => {
    const estado = historiaAntigua();
    expect(esEstadoProgreso(antes, estado)).toBe(true);
    expect(esEstadoProgreso(sinHistoria, estado)).toBe(false);
    expect(esEstadoProgreso(despues, estado)).toBe(true);
    expect(esInstantaneaProgreso(despues, { revisionServidor: 7, estado })).toBe(true);
    // Lo leído no se reescribe: el aquí retirado y su hora siguen tal cual.
    expect(estado.aqui.paradaId).toBe('tb');
    expect(estado.paradas.tb).toEqual({ marca: 'aqui', horaReal: 29877990, revision: 1 });
  });
  it('desconocidos, viajes ajenos y categorías cruzadas siguen rechazando el estado entero', () => {
    const base = historiaAntigua();
    const con = (cambio: (e: Record<string, any>) => void) => {
      const e = structuredClone(base) as unknown as Record<string, any>;
      cambio(e);
      return esEstadoProgreso(despues, e);
    };
    expect(con((e) => { e.paradas.nadie = { marca: 'hecha', revision: 1 }; })).toBe(false);
    expect(con((e) => { e.viajeId = 'otro'; })).toBe(false);
    // Un pendiente retirado no es una parada, ni al revés, ni un sitio de dentro tiene progreso.
    expect(con((e) => { e.paradas.cv = { marca: 'hecha', revision: 1 }; })).toBe(false);
    expect(con((e) => { e.pendientes.vieja = { hecho: true, revision: 1 }; })).toBe(false);
    expect(con((e) => { e.paradas.sx = { marca: 'hecha', revision: 1 }; })).toBe(false);
    expect(con((e) => { e.aqui = { paradaId: 'nadie', revision: e.aqui.revision }; })).toBe(false);
  });
});

describe('R2 · operación nueva sobre una retirada no se aplica; el replay exacto conserva su acuse', () => {
  it('nuevas sobre parada o pendiente retirados son inválidas sin tocar el estado', () => {
    const estado = historiaAntigua();
    for (const op of [marca('nueva-vieja', 'vieja', { revision: 1 }), marca('nueva-tb', 'tb', { marca: 'saltada', revision: 1,
      revisionAqui: 1 }), casilla('nueva-cv', 'cv', true, 2)]) {
      const r = aplicarOperacion(despues, estado, op);
      expect(r.tipo).toBe('invalida');
      expect(r.estado).toBe(estado);
    }
  });
  it('mismo ID y misma firma ya aceptados → duplicada; otra firma con ese ID → inválida', () => {
    const estado = historiaAntigua();
    expect(aplicarOperacion(despues, estado, marca('op-vieja', 'vieja', { horaReal: 29877930 })).tipo).toBe('duplicada');
    expect(aplicarOperacion(despues, estado, casilla('op-cv', 'cv', true)).tipo).toBe('duplicada');
    expect(aplicarOperacion(despues, estado, marca('op-vieja', 'vieja', { horaReal: 1 })).tipo).toBe('invalida');
    expect(aplicarOperacion(despues, estado, marca('op-nadie', 'nadie')).tipo).toBe('invalida');
  });
  it('marcar aquí una activa con el aquí en una retirada: la anterior queda hecha con recibo, sin inventar hora', () => {
    const estado = historiaAntigua();
    const r = aplicarOperacion(despues, estado, marca('aqui-p3', 'p3', { marca: 'aqui', revisionAqui: estado.aqui.revision,
      revisionAnterior: estado.paradas.tb.revision }));
    expect(r.tipo).toBe('aplicada');
    if (r.tipo !== 'aplicada') return;
    expect(r.estado.paradas.tb).toEqual({ marca: 'hecha', revision: 2 });
    expect(r.estado.aqui.paradaId).toBe('p3');
    expect(esEstadoProgreso(despues, r.estado)).toBe(true);
    // Deshacer es el inverso exacto de ese recibo, también sobre la retirada.
    const d = aplicarOperacion(despues, r.estado, { id: 'deshacer-aqui', dispositivoId: 'movil', tipo: 'deshacer', cambios: r.cambios });
    expect(d.tipo).toBe('aplicada');
    if (d.tipo === 'aplicada') expect(d.estado.paradas.tb).toEqual({ marca: 'aqui', horaReal: 29877990, revision: 3 });
  });
});

describe('R3 · colas con historia retirada siguen teniendo salida', () => {
  const confirmado = (): InstantaneaProgreso => ({ revisionServidor: 7, estado: historiaAntigua() });
  it('una intención sin enviar sobre una retirada queda inválida en la proyección y se puede descartar', () => {
    const iniciada = iniciarCola(despues, confirmado(), [marca('sin-enviar', 'vieja', { revision: 1 })]);
    expect(iniciada.tipo).toBe('iniciada');
    expect(iniciada.proyeccion?.entradas).toEqual([expect.objectContaining({ operacionId: 'sin-enviar', tipo: 'invalida' })]);
    expect(cancelarIntencion(despues, iniciada.cola, 'sin-enviar').tipo).toBe('cancelada');
  });
  it('una enviada antes del cambio de plan recibe su acuse; un rechazo persistido bloquea a su dependiente', () => {
    const base = { revisionServidor: 6, estado: crearProgreso(antes) };
    const op = marca('enviada', 'vieja');
    let cola = agregarIntencion(antes, iniciarCola(antes, base).cola, op).cola;
    cola = marcarEnviada(antes, cola, 'enviada').cola;
    const acuse = { operacionId: 'enviada', persistida: true,
      instantanea: { revisionServidor: 7, estado: aplicar(antes, base.estado, op) } };
    expect(recibirAcuse(despues, cola, acuse).tipo).toBe('confirmada');

    // La dependencia se formó ANTES del cambio de plan (con el nuevo no se podría formar sobre una retirada).
    const op2 = marca('rechazada', 'vieja', { marca: 'saltada', revision: 1 });
    const dependiente = marca('dependiente', 'vieja', { marca: null, revision: 2 });
    let otra = iniciarCola(antes, confirmado()).cola;
    otra = agregarIntencion(antes, otra, op2).cola;
    otra = agregarIntencion(antes, otra, dependiente).cola;
    expect(otra?.entradas[1].dependeDe).toEqual(['rechazada']);
    otra = marcarEnviada(antes, otra, 'rechazada').cola;
    const rechazo = { viajeId: 'viaje', protocolo: 1, operacionId: 'rechazada', operacionOriginal: op2,
      decisionPersistida: true, motivo: 'invalida', instantanea: { revisionServidor: 8, estado: confirmado().estado } };
    const r = recibirRechazo(despues, otra, rechazo);
    expect(r.tipo).toBe('rechazada');
    expect(r.proyeccion?.entradas.map((e) => [e.operacionId, e.tipo])).toEqual([['rechazada', 'rechazada'],
      ['dependiente', 'bloqueada']]);
  });
});

describe('R4 · raíz IndexedDB creada con el plan anterior se abre con el nuevo sin reescribirla', () => {
  const bases: IDBFactory[] = [];
  afterEach(() => { vi.restoreAllMocks(); bases.splice(0); });
  async function crudo(fabrica: IDBFactory): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const s = fabrica.open('prueba');
      s.onsuccess = () => {
        const g = s.result.transaction('viajes').objectStore('viajes').get('viaje');
        g.onsuccess = () => { s.result.close(); resolve(g.result); };
        g.onerror = () => reject(g.error);
      };
      s.onerror = () => reject(s.error);
    });
  }
  async function guardarCrudo(fabrica: IDBFactory, valor: unknown): Promise<void> {
    return new Promise((resolve, reject) => {
      const s = fabrica.open('prueba');
      s.onsuccess = () => {
        const tx = s.result.transaction('viajes', 'readwrite');
        tx.objectStore('viajes').put(valor, 'viaje');
        tx.oncomplete = () => { s.result.close(); resolve(); };
        tx.onabort = () => reject(tx.error);
      };
      s.onerror = () => reject(s.error);
    });
  }
  /** Raíz guardada con el plan ANTERIOR: confirmada con historia y una cola sin confirmar sobre retiradas. */
  async function raizAntigua() {
    const fabrica = new IDBFactory(); bases.push(fabrica);
    let n = 0;
    const opciones = { fabrica, nombre: 'prueba', dispositivoId: 'movil', uuid: () => `id-${++n}`,
      entradasLegadas: { marcas: '{"2026-10-20|08:00|Nada":"hecha"}', extra: 'íntegro' } };
    const viejo = await abrirProgresoLocal(antes, opciones);
    expect((await viejo.recibirInstantanea({ revisionServidor: 7, estado: historiaAntigua() })).tipo).toBe('actualizada');
    await viejo.registrar(marca('m-vieja', 'vieja', { marca: 'saltada', revision: 1 }));
    await viejo.registrar(marca('m-p1', 'p1', { revision: 2 }));
    await viejo.registrar(casilla('m-cv', 'cv', true, 2));
    expect((await viejo.marcarEnviada('m-vieja')).tipo).toBe('enviada');
    viejo.cerrar();
    return { fabrica, opciones, anterior: await crudo(fabrica) };
  }
  it('abre con el plan nuevo sin reescribir: confirmado, cola, recibos y legado intactos; la proyección es estricta', async () => {
    const { fabrica, opciones, anterior } = await raizAntigua();
    const nuevo = await abrirProgresoLocal(despues, opciones);
    const leido = await nuevo.leer();
    expect(await crudo(fabrica)).toEqual(anterior);
    expect(leido.confirmado).toEqual((anterior as { confirmado: unknown }).confirmado);
    expect(leido.cola).toEqual((anterior as { cola: unknown }).cola);
    expect(leido.legado).toEqual((anterior as { legado: unknown }).legado);
    // Lo nuevo sobre retiradas no se aplica con el plan nuevo; lo activo de la misma cola sí.
    expect(leido.estado.paradas.vieja).toEqual({ marca: 'hecha', horaReal: 29877930, revision: 1 });
    expect(leido.estado.pendientes.cv).toEqual({ hecho: false, revision: 2 });
    expect(leido.estado.paradas.p1).toEqual({ marca: 'hecha', revision: 3 });
    nuevo.cerrar();
  });
  it('salidas de siempre: la no enviada se descarta, la enviada recibe su acuse y una activa nueva no depende de ellas', async () => {
    const { opciones } = await raizAntigua();
    const nuevo = await abrirProgresoLocal(despues, opciones);
    expect((await nuevo.cancelarIntencion('m-cv')).tipo).toBe('cancelada');
    expect((await nuevo.cancelarIntencion('m-vieja')).tipo).toBe('conflicto');
    const tras = (await nuevo.leer()).confirmado;
    const conVieja = aplicar(antes, tras, marca('m-vieja', 'vieja', { marca: 'saltada', revision: 1 }));
    expect((await nuevo.recibirAcuse({ operacionId: 'm-vieja', persistida: true,
      instantanea: { revisionServidor: 8, estado: conVieja } })).tipo).toBe('confirmada');
    const r = await nuevo.registrar(marca('m-p3', 'p3'));
    expect(r.tipo).toBe('aplicada');
    const final = await nuevo.leer();
    expect(final.cola.find((e) => e.operacion.id === 'm-p3')?.dependeDe).toEqual([]);
    expect(final.estado.paradas.vieja.marca).toBe('saltada');
    nuevo.cerrar();
  });
  it('copia portable con esa raíz se valida; corrupción, desconocidos y otro viaje siguen rechazados', async () => {
    const { fabrica, anterior } = await raizAntigua();
    const base = (valor: unknown, clave = 'viaje') => ({ presente: true, tablas: { viajes: [{ clave, valor }] } });
    expect(() => validarProgresoPortable(despues, base(anterior))).not.toThrow();
    const raiz = anterior as { estado: { paradas: Record<string, unknown> }; cola: { operacion: Operacion }[] };
    const manipulada = structuredClone(raiz);
    manipulada.estado.paradas.p3 = { marca: 'hecha', revision: 1 };
    expect(() => validarProgresoPortable(despues, base(manipulada))).toThrow();
    const desconocida = structuredClone(raiz);
    desconocida.cola[0].operacion = { ...desconocida.cola[0].operacion, paradaId: 'nadie' } as Operacion;
    expect(() => validarProgresoPortable(despues, base(desconocida))).toThrow();
    expect(() => validarProgresoPortable(despues, base(anterior, 'otro'))).toThrow();
    expect(() => validarProgresoPortable(sinHistoria, base(anterior))).toThrow();
    await guardarCrudo(fabrica, manipulada);
    await expect(abrirProgresoLocal(despues, { fabrica, nombre: 'prueba', dispositivoId: 'movil' }))
      .rejects.toThrow('Registro de progreso corrupto');
  });
});

describe('R5 · servidor: GET con historia, replay del acuse y rechazo persistido de lo nuevo', () => {
  const actor = 'a'.repeat(64);
  /** Arnés CAS en memoria que guarda lo que le dan, sin validar con ningún plan. */
  function pasarelaCruda() {
    let actual: InstantaneaProgreso = { revisionServidor: 0, estado: crearProgreso(antes) };
    const decisiones = new Map<string, DecisionHistorica>();
    const pasarela: PasarelaProgreso = {
      consultar: async (_h: string, _v: string, id?: string) => ({ tipo: 'lectura', instantanea: structuredClone(actual),
        decision: id ? structuredClone(decisiones.get(id) ?? null) : null }),
      confirmar: async (_h: string, _v: string, base: number, candidato: DecisionHistorica) => {
        if (actual.revisionServidor !== base) return { tipo: 'desfase' };
        actual = structuredClone(candidato.tipo === 'positiva' ? candidato.acuse.instantanea : candidato.rechazo.instantanea);
        decisiones.set(candidato.tipo === 'positiva' ? candidato.operacionOriginal.id : candidato.rechazo.operacionId,
          structuredClone(candidato));
        return { tipo: 'comprometida' };
      },
    };
    return { pasarela, actual: () => actual };
  }
  it('almacén: lee, repite el acuse exacto, persiste el rechazo de una nueva y sigue rechazando desconocidos', async () => {
    const p = pasarelaCruda();
    const viejo = crearAlmacenProgreso({ plan: antes, pasarela: p.pasarela });
    const primero = await viejo.procesar(actor, 'viaje', marca('op-vieja', 'vieja', { horaReal: 29877930 }));
    expect(primero.tipo).toBe('confirmada');
    const nuevo = crearAlmacenProgreso({ plan: despues, pasarela: p.pasarela });
    expect(await nuevo.leer(actor, 'viaje')).toEqual({ tipo: 'instantanea', instantanea: p.actual() });
    expect(await nuevo.procesar(actor, 'viaje', marca('op-vieja', 'vieja', { horaReal: 29877930 }))).toEqual(primero);
    const rechazo = await nuevo.procesar(actor, 'viaje', marca('op-nueva', 'vieja', { marca: 'saltada', revision: 1 }));
    expect(rechazo.tipo).toBe('rechazada');
    expect(Object.hasOwn(p.actual().estado.operaciones, 'op-nueva')).toBe(false);
    await expect(nuevo.procesar(actor, 'viaje', marca('op-nadie', 'nadie'))).rejects.toThrow();
  });
  it('API: GET 200 con la historia, replay 200 con el acuse original, nueva 409 y desconocida 400', async () => {
    const p = pasarelaCruda();
    const viejo = crearAlmacenProgreso({ plan: antes, pasarela: p.pasarela });
    await viejo.procesar(actor, 'viaje', marca('op-vieja', 'vieja'));
    const sesion: RegistroSesion = { id: 's', huella: actor, viajeId: 'viaje', dispositivoId: 'movil', creadaEn: 0,
      venceEn: 9999, revocada: false };
    const api = crearControladorProgreso({ plan: despues, autenticar: async () => sesion,
      repositorio: crearAlmacenProgreso({ plan: despues, pasarela: p.pasarela }) });
    const origen = 'https://viaje.example';
    const post = (op: Operacion) => api.atender(new Request(origen + '/api/progreso', { method: 'POST',
      headers: { Origin: origen, 'Content-Type': 'application/json' }, body: JSON.stringify(op) }));
    const get = await api.atender(new Request(origen + '/api/progreso', { headers: { Origin: origen } }));
    expect(get.status).toBe(200);
    expect(capturarInstantaneaProgreso(despues, await get.json())?.estado.paradas.vieja.marca).toBe('hecha');
    const replay = await post(marca('op-vieja', 'vieja'));
    expect(replay.status).toBe(200);
    expect((await replay.json()).instantanea.revisionServidor).toBe(1);
    expect((await post(marca('op-nueva', 'vieja', { marca: 'saltada', revision: 1 }))).status).toBe(409);
    expect((await post(marca('op-nadie', 'nadie'))).status).toBe(400);
  });
});

describe('Catálogo de retiradas: una sola verdad tipada, estricta y determinista', () => {
  const con = (cambio: (r: Record<string, any>) => unknown): Itinerario => {
    const p = structuredClone(despues) as Itinerario & { retiradas: Record<string, any> };
    const nuevo = cambio(p.retiradas);
    if (nuevo !== undefined) p.retiradas = nuevo as Record<string, any>;
    return p;
  };
  const invalida = 'Identidades retiradas inválidas';
  it('acepta el cambio de tipo (Top Banana: sitio activo y parada retirada) como tuplas distintas', () => {
    expect(() => crearProgreso(despues)).not.toThrow();
    expect(identidades(despues).destino('cena', 'tb')).toBe('activo');
    expect(identidades(despues).destino('tb')).toBe('retirado');
    expect(identidades(despues).destino('tb', 'tbs')).toBe('retirado');
    expect(identidades(despues).destino('p1', 'sx')).toBe('retirado');
    expect(identidades(despues).destino('cena', 'tbs')).toBeNull();
    expect(identidades(despues).destino('p1', 'tb')).toBeNull();
    expect(identidades(despues).destino('nadie')).toBeNull();
    expect(identidades(despues).nombreRetirado('tb')).toBe('Top Banana');
    expect(identidades(despues).nombreRetirado('p1', 'sx')).toBe('Sitio quitado');
    expect(identidades(despues).paradas.activas.has('tb')).toBe(false);
  });
  it.each([
    ['parada retirada que sigue activa', (r: Record<string, any>) => { r.paradas.push({ id: 'p1', nombre: 'Uno' }); }],
    ['sitio retirado que sigue activo en la misma parada', (r: Record<string, any>) => { r.subparadas.push({ paradaId: 'p1', id: 's1', nombre: 'Dentro' }); }],
    ['sitio retirado de una parada inventada', (r: Record<string, any>) => { r.subparadas.push({ paradaId: 'nadie', id: 'sz', nombre: 'Z' }); }],
    ['retirada repetida', (r: Record<string, any>) => { r.paradas.push({ id: 'vieja', nombre: 'Otra vez' }); }],
    ['retirada repetida entre tipos', (r: Record<string, any>) => { r.pendientes.push({ id: 'sv' }); }],
    ['pendiente retirado que sigue activo', (r: Record<string, any>) => { r.pendientes.push({ id: 'c1' }); }],
    ['pendiente retirado con ID de una parada activa', (r: Record<string, any>) => { r.pendientes.push({ id: 'p3' }); }],
    ['parada retirada con ID de un pendiente activo', (r: Record<string, any>) => { r.paradas.push({ id: 'cn', nombre: 'X' }); }],
    ['parada retirada con el ID del viaje', (r: Record<string, any>) => { r.paradas.push({ id: 'viaje', nombre: 'X' }); }],
    ['ID vacío', (r: Record<string, any>) => { r.pendientes.push({ id: ' ' }); }],
    ['campo de más', (r: Record<string, any>) => { r.paradas[0].hora = '10:00'; }],
    ['sin nombre', (r: Record<string, any>) => { delete r.paradas[0].nombre; }],
    ['tipo desconocido', (r: Record<string, any>) => { r.notas = []; }],
    ['no es lista', (r: Record<string, any>) => { r.paradas = { 0: r.paradas[0] }; }],
    ['lista con huecos', (r: Record<string, any>) => { r.pendientes.length = 3; }],
    ['nulo', () => null],
    ['accesor', (r: Record<string, any>) => { Object.defineProperty(r.pendientes[0], 'id', { get: () => 'cv', enumerable: true }); }],
    ['prototipo ajeno', (r: Record<string, any>) => Object.setPrototypeOf({ ...r }, { pendientes: [] })],
  ])('rechaza %s en crearProgreso, sin aceptar luego lo guardado', (_, cambio) => {
    const plan = con(cambio);
    expect(() => crearProgreso(plan)).toThrow(invalida);
    expect(() => identidades(plan)).toThrow(invalida);
    expect(esEstadoProgreso(plan, historiaAntigua())).toBe(false);
  });
  it('los duplicados del plan activo siguen con su error de siempre', () => {
    const plan = structuredClone(despues);
    plan.dias[0].paradas[2] = { ...plan.dias[0].paradas[2], id: 'p1' };
    expect(() => crearProgreso(plan)).toThrow('Identidad del itinerario vacía o duplicada');
  });
});

describe('R7 · retiradas sucesivas: lo guardado entre dos versiones del plan se sigue abriendo', () => {
  // Tres versiones del MISMO viaje: P0 tiene A, B y C (y las casillas X, Y); P1 retira A y X; P2 retira también B e Y.
  const VIAJE = 'viaje-sintetico';
  const p = (id: string): Parada => ({ id, nombre: id, hora: '09:00', categoria: 'otro', lat: 31, lng: 121 });
  const version = (activas: string[], retiradasP: string[], casillas: string[] = [], casillasRetiradas: string[] = []): Itinerario => ({
    id: VIAJE, titulo: 'Sintético', dias: [{ fecha: '2026-10-21', titulo: 'Día', paradas: activas.map(p) }],
    ...(casillas.length ? { pendientes: casillas.map((id) => ({ id, texto: id })) } : {}),
    ...(retiradasP.length || casillasRetiradas.length ? { retiradas: {
      paradas: retiradasP.map((id) => ({ id, nombre: id })), pendientes: casillasRetiradas.map((id) => ({ id })) } } : {}),
  });
  const P0 = version(['A', 'B', 'C'], []);
  const P1 = version(['B', 'C'], ['A']);
  const P2 = version(['C'], ['A', 'B']);
  const Q0 = version(['A', 'B', 'C'], [], ['X', 'Y']);
  const Q1 = version(['B', 'C'], ['A'], ['Y'], ['X']);
  const Q2 = version(['C'], ['A', 'B'], [], ['X', 'Y']);
  const op = (id: string, paradaId: string, extra: Partial<Extract<Operacion, { tipo: 'parada' }>> = {}): Operacion =>
    ({ id, dispositivoId: 'movil-sintetico', tipo: 'parada', paradaId, marca: 'hecha', revision: 0, ...extra });
  const casillaS = (id: string, pendienteId: string, revision = 0): Operacion =>
    ({ id, dispositivoId: 'movil-sintetico', tipo: 'pendiente', pendienteId, hecho: true, revision });
  type Raiz = { estado: EstadoProgreso; confirmado: EstadoProgreso; cola: { operacion: Operacion; dependeDe: string[]; enviada: boolean }[] };
  function base() {
    const fabrica = new IDBFactory();
    const opciones = { fabrica, nombre: 'repro-sintetico', dispositivoId: 'movil-sintetico' };
    const crudo = () => new Promise<Raiz>((ok, ko) => {
      const s = fabrica.open('repro-sintetico');
      s.onsuccess = () => {
        const g = s.result.transaction('viajes').objectStore('viajes').get(VIAJE);
        g.onsuccess = () => { s.result.close(); ok(g.result as Raiz); };
        g.onerror = () => ko(g.error);
      };
      s.onerror = () => ko(s.error);
    });
    const guardarCrudo = (valor: unknown) => new Promise<void>((ok, ko) => {
      const s = fabrica.open('repro-sintetico');
      s.onsuccess = () => {
        const tx = s.result.transaction('viajes', 'readwrite');
        tx.objectStore('viajes').put(valor, VIAJE);
        tx.oncomplete = () => { s.result.close(); ok(); };
        tx.onabort = () => ko(tx.error);
      };
      s.onerror = () => ko(s.error);
    });
    const abrir = (plan: Itinerario) => abrirProgresoLocal(plan, opciones);
    return { crudo, guardarCrudo, abrir };
  }
  const portable = (valor: unknown) => ({ presente: true, tablas: { viajes: [{ clave: VIAJE, valor }] } });

  /** El repro del verificador: A y B sin enviar con P0; con P1 (A retirada) se registra C; P2 retira también B. */
  async function reproduccion() {
    const b = base();
    const v0 = await b.abrir(P0);
    expect((await v0.registrar(op('op-A', 'A'))).tipo).toBe('aplicada');
    expect((await v0.registrar(op('op-B', 'B'))).tipo).toBe('aplicada');
    v0.cerrar();
    const v1 = await b.abrir(P1);
    expect((await v1.leer()).estado.paradas.B.marca).toBe('hecha');
    expect((await v1.registrar(op('op-C', 'C'))).tipo).toBe('aplicada');
    v1.cerrar();
    return b;
  }

  it('P0 → P1 → P2: la raíz (B y C guardadas, A ya no) se abre con P2 sin reescribirla y lo efectivo es solo C', async () => {
    const b = await reproduccion();
    const antesDeAbrir = await b.crudo();
    expect(Object.keys(antesDeAbrir.estado.paradas).sort()).toEqual(['B', 'C']);
    expect(antesDeAbrir.cola.map((e) => [e.operacion.id, e.enviada, e.dependeDe])).toEqual([
      ['op-A', false, []], ['op-B', false, []], ['op-C', false, []]]);
    expect(esEstadoProgreso(P2, antesDeAbrir.estado)).toBe(true);
    // Abrir y leer no escriben NADA en la base (ni un put): la proyección estricta solo vive en memoria.
    const put = vi.spyOn(IDBObjectStore.prototype, 'put');
    const v2 = await b.abrir(P2);
    const leido = await v2.leer();
    v2.cerrar();
    expect(put).not.toHaveBeenCalled();
    put.mockRestore();
    expect(await b.crudo()).toEqual(antesDeAbrir);
    // Nada retirado vuelve a lo efectivo: la proyección que usa la app es la estricta.
    expect(Object.keys(leido.estado.paradas)).toEqual(['C']);
    expect(Object.keys(leido.estado.operaciones)).toEqual(['op-C']);
    expect(leido.cola).toEqual(antesDeAbrir.cola);
    expect(leido.confirmado).toEqual(antesDeAbrir.confirmado);
    expect(() => validarProgresoPortable(P2, portable(antesDeAbrir))).not.toThrow();
  });

  it('casillas retiradas por partes, escrituras entre versiones, un acuse y una cola sin enviar', async () => {
    const b = base();
    const v0 = await b.abrir(Q0);
    for (const o of [op('op-A', 'A'), op('op-B', 'B'), casillaS('op-X', 'X')]) expect((await v0.registrar(o)).tipo).toBe('aplicada');
    v0.cerrar();
    const v1 = await b.abrir(Q1);
    // Con Q1 se envía y se confirma op-B (sigue activa), y se registran C e Y.
    expect((await v1.marcarEnviada('op-B')).tipo).toBe('enviada');
    const conB = aplicar(Q1, crearProgreso(Q1), op('op-B', 'B'));
    expect((await v1.recibirAcuse({ operacionId: 'op-B', persistida: true, instantanea: { revisionServidor: 1, estado: conB } })).tipo)
      .toBe('confirmada');
    expect((await v1.registrar(op('op-C', 'C'))).tipo).toBe('aplicada');
    expect((await v1.registrar(casillaS('op-Y', 'Y'))).tipo).toBe('aplicada');
    v1.cerrar();
    const guardada = await b.crudo();
    expect(Object.keys(guardada.estado.pendientes)).toEqual(['Y']);
    const v2 = await b.abrir(Q2);
    expect(await b.crudo()).toEqual(guardada);
    const leido = await v2.leer();
    expect(leido.estado.paradas.B.marca).toBe('hecha'); // confirmada por el servidor: es historia, no una intención
    expect(Object.keys(leido.estado.pendientes)).toEqual([]);
    // Salidas de siempre: descartar lo no enviado; una activa nueva depende solo de lo efectivo y se escribe normal.
    expect((await v2.cancelarIntencion('op-X')).tipo).toBe('cancelada');
    expect((await v2.registrar(op('op-C2', 'C', { marca: 'saltada', revision: 1 }))).tipo).toBe('aplicada');
    const despuesDeEscribir = await b.crudo();
    expect(despuesDeEscribir.cola.map((e) => e.operacion.id)).toEqual(['op-A', 'op-C', 'op-Y', 'op-C2']);
    expect(despuesDeEscribir.cola.find((e) => e.operacion.id === 'op-C2')!.dependeDe).toEqual(['op-C']);
    v2.cerrar();
    const otraVez = await b.abrir(Q2);
    expect((await otraVez.leer()).estado.paradas.C.marca).toBe('saltada');
    otraVez.cerrar();
  });

  it('enviada, no-op, deshacer y aquí cruzando la retirada de B', async () => {
    const b = base();
    const v0 = await b.abrir(P0);
    expect((await v0.registrar(op('op-A', 'A'))).tipo).toBe('aplicada');
    expect((await v0.registrar(op('op-B', 'B'))).tipo).toBe('aplicada');
    v0.cerrar();
    const v1 = await b.abrir(P1);
    expect((await v1.registrar(op('op-B-igual', 'B', { revision: 1 }))).tipo).toBe('sin-cambio');
    expect((await v1.marcarEnviada('op-B')).tipo).toBe('enviada');
    const recibo = (await v1.leer()).estado.operaciones['op-B'].cambios!;
    expect((await v1.registrar({ id: 'op-B-deshacer', dispositivoId: 'movil-sintetico', tipo: 'deshacer', cambios: recibo })).tipo)
      .toBe('aplicada');
    expect((await v1.registrar(op('op-aqui-B', 'B', { marca: 'aqui', revision: 2, revisionAqui: 0 }))).tipo).toBe('aplicada');
    expect((await v1.registrar(op('op-aqui-C', 'C', { marca: 'aqui', revisionAqui: 1, revisionAnterior: 3 }))).tipo).toBe('aplicada');
    v1.cerrar();
    const guardada = await b.crudo();
    expect(guardada.estado.aqui.paradaId).toBe('C');
    expect(guardada.estado.paradas.B).toEqual({ marca: 'hecha', revision: 4 });
    expect(Object.keys(guardada.estado.operaciones)).toEqual(['op-B', 'op-B-igual', 'op-B-deshacer', 'op-aqui-B', 'op-aqui-C']);
    const v2 = await b.abrir(P2);
    expect(await b.crudo()).toEqual(guardada);
    const leido = await v2.leer();
    // Estricto con P2: lo que dependía de B (ya retirada) no se aplica, tampoco el «aquí» en C que salía de B.
    expect(leido.estado.aqui).toEqual({ paradaId: null, revision: 0 });
    expect(Object.keys(leido.estado.paradas)).toEqual([]);
    expect(leido.cola).toEqual(guardada.cola);
    // La salida de siempre: descartar el cambio que no salió del móvil y quedó bloqueado.
    expect((await v2.cancelarIntencion('op-aqui-C')).tipo).toBe('cancelada');
    v2.cerrar();
  });

  it.each([
    ['la firma de un acuse guardado', (r: any) => { r.estado.operaciones['op-B'].firma = '["otra"]'; }],
    ['los cambios de un acuse guardado', (r: any) => {
      r.estado.operaciones['op-B'].cambios.registros[0].despues.marca = 'saltada'; }],
    ['un acuse inventado para lo que no se aplicó', (r: any) => {
      r.estado.operaciones['op-A'] = { firma: JSON.stringify(['op-A', 'movil-sintetico', 'parada', 'A', 'hecha', null, 0, null, null]) }; }],
    ['un registro sin su acuse', (r: any) => { delete r.estado.operaciones['op-B']; }],
    ['la identidad de una operación de la cola', (r: any) => { r.cola[1].operacion.id = 'op-otra'; }],
    ['sus dependencias', (r: any) => { r.cola[2].dependeDe = ['op-A']; }],
    ['una operación hacia una parada desconocida', (r: any) => { r.cola[1].operacion.paradaId = 'Z'; }],
    ['el viaje', (r: any) => { r.estado.viajeId = 'otro'; }],
  ])('sigue rechazando la raíz y el archivo si se manipula %s', async (_, manipular) => {
    const b = await reproduccion();
    const r = structuredClone(await b.crudo()) as any;
    manipular(r);
    expect(() => validarProgresoPortable(P2, portable(r))).toThrow();
    await b.guardarCrudo(r);
    await expect(b.abrir(P2)).rejects.toThrow('Registro de progreso corrupto');
  });
});

// ---------- Fotos con destino retirado (S2) ----------

type Destino = DestinoFoto;
const enParada = (paradaId: string, viajeId = 'viaje'): Destino => ({ tipo: 'parada', viajeId, paradaId });
const enSitio = (paradaId: string, subparadaId: string): Destino => ({ tipo: 'subparada', viajeId: 'viaje', paradaId, subparadaId });
const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const metadatos = (n: number, destino: Destino) => ({ formato: 1, fotoId: uuid(n), destino, nombre: `foto-${n}.jpg`,
  mimeDeclarado: 'image/jpeg', ultimaModificacion: 1000 + n, incorporada: 2000 + n, bytesOriginal: 3,
  miniatura: { tipo: 'pendiente' } });
const original = (n: number) => new Blob([new Uint8Array([n, n + 1, n + 2])], { type: 'image/jpeg' });

describe('F1 · destino de foto por tupla exacta: activo o retirado del mismo viaje', () => {
  it.each([
    ['parada retirada', enParada('vieja'), true],
    ['Top Banana como parada antigua', enParada('tb'), true],
    ['Top Banana como sitio actual de la cena', enSitio('cena', 'tb'), true],
    ['sitio retirado de una parada retirada', enSitio('tb', 'tbs'), true],
    ['sitio retirado de una parada activa', enSitio('p1', 'sx'), true],
    ['activo de siempre', enSitio('p1', 's1'), true],
    ['sitio retirado con otro padre', enSitio('vieja', 'tbs'), false],
    ['sitio retirado bajo el padre actual de Top Banana', enSitio('cena', 'tbs'), false],
    ['Top Banana bajo una parada que no es la suya', enSitio('p1', 'tb'), false],
    ['parada desconocida', enParada('nadie'), false],
    ['otro viaje', enParada('vieja', 'otro'), false],
    ['un pendiente retirado no es destino', enParada('cv'), false],
  ])('%s', (_, destino, valido) => {
    expect(esDestinoFoto(despues, destino)).toBe(valido);
    expect(esMetadatosFoto(despues, metadatos(1, destino))).toBe(valido);
    if (destino.paradaId !== 'p1' || destino.tipo !== 'subparada' || destino.subparadaId !== 's1') {
      expect(esDestinoFoto(sinHistoria, destino)).toBe(destino.tipo === 'subparada' && destino.paradaId === 'cena' && destino.subparadaId === 'tb');
    }
  });
});

describe('F2 · solo se añade una foto nueva a un destino activo', () => {
  const archivo = () => new File([new Uint8Array([1, 2, 3])], 'nueva.jpg', { type: 'image/jpeg', lastModified: 5 });
  it('crearCapturaFoto rechaza los retirados y acepta los activos (Top Banana solo como sitio de la cena)', () => {
    for (const destino of [enParada('vieja'), enParada('tb'), enSitio('tb', 'tbs'), enSitio('p1', 'sx')]) {
      expect(() => crearCapturaFoto(despues, destino, archivo(), 9, { uuid: () => uuid(9) })).toThrow('Destino o fecha inválidos');
    }
    for (const destino of [enSitio('cena', 'tb'), enParada('p3'), enSitio('p1', 's1')]) {
      expect(crearCapturaFoto(despues, destino, archivo(), 9, { uuid: () => uuid(9) }).metadatos.destino).toEqual(destino);
    }
  });
});

describe('F3 · PhotoDB guardada con el plan anterior se lista y se lee entera con el nuevo', () => {
  it('originales, metadata y procedencia intactos; nada se pierde por una foto retirada', async () => {
    const fabrica = new IDBFactory();
    const viejo = await abrirFotosLocal(antes, { fabrica, nombre: 'fotos' });
    const vieja = { metadatos: copiarMetadatos(antes, metadatos(1, enParada('vieja'))), original: original(1) };
    const tb = { metadatos: copiarMetadatos(antes, metadatos(2, enParada('tb'))), original: original(2) };
    const activa = { metadatos: copiarMetadatos(antes, metadatos(3, enSitio('p1', 's1'))), original: original(3) };
    expect((await viejo.guardarOriginal(vieja, 'camara-galeria')).tipo).toBe('guardada');
    expect((await viejo.guardarOriginal(tb)).tipo).toBe('guardada');
    expect((await viejo.guardarOriginal(activa, 'camara-galeria')).tipo).toBe('guardada');
    viejo.cerrar();
    const nuevo = await abrirFotosLocal(despues, { fabrica, nombre: 'fotos' });
    const lista = await nuevo.listar();
    expect(lista.map((m) => m.fotoId).sort()).toEqual([uuid(1), uuid(2), uuid(3)]);
    expect(lista.find((m) => m.fotoId === uuid(1))!.destino).toEqual(enParada('vieja'));
    expect(new Uint8Array(await (await nuevo.leerOriginal(uuid(1)))!.arrayBuffer())).toEqual(new Uint8Array([1, 2, 3]));
    expect(await nuevo.leerMetadatos(uuid(2))).toEqual(tb.metadatos);
    expect(await nuevo.leerProcedencia!(uuid(1))).toBe('camara-galeria');
    expect(await nuevo.leerProcedencia!(uuid(2))).toBeNull();
    nuevo.cerrar();
  });
});

describe('F4 · catálogo remoto: página con lookahead y consulta por destino', () => {
  const solicitud = (n: number, destino: Destino) => serializarSolicitudRespaldo(antes, { version: 1, tipo: 'solicitud-respaldo',
    viajeId: 'viaje', fotoId: uuid(n), operacionId: uuid(100 + n), original: copiarOriginalRespaldo(antes, metadatos(n, destino)) });
  it('una página con una foto retirada (y su continuación hasta la siguiente) se acepta con el plan nuevo', () => {
    const continuacion = serializarCursorListadoFotos(antes, { version: 1, viajeId: 'viaje', despuesDe: uuid(2), hasta: uuid(3) });
    const texto = serializarPaginaListadoFotos(antes, { version: 1, tipo: 'listado-respaldos', viajeId: 'viaje',
      solicitudesIniciales: [solicitud(1, enSitio('p1', 's1')), solicitud(2, enSitio('tb', 'tbs'))], continuacion }, 8, 1 << 20);
    const pagina = deserializarPaginaListadoFotos(despues, texto, 8, 1 << 20);
    expect(pagina.solicitudesIniciales).toHaveLength(2);
    expect(() => deserializarPaginaListadoFotos(sinHistoria, texto, 8, 1 << 20)).toThrow();
  });
  it('la consulta por destino admite la tupla retirada exacta y sigue rechazando la inventada', () => {
    const texto = serializarDestinoListadoFotos(antes, enParada('vieja'));
    expect(deserializarDestinoListadoFotos(despues, texto)).toEqual(enParada('vieja'));
    expect(() => deserializarDestinoListadoFotos(despues, JSON.stringify(enSitio('cena', 'tbs')))).toThrow();
  });
});

describe('F5 · copia portable con fotos retiradas se valida entera', () => {
  it('metadata y original retirados pasan; uno desconocido sigue rechazando el archivo', () => {
    const base = (destino: Destino) => ({ presente: true, tablas: {
      metadatos: [{ clave: uuid(1), valor: metadatos(1, destino) }], originales: [{ clave: uuid(1), valor: original(1) }],
      miniaturas: [] } });
    expect(() => validarFotosPortables(despues, base(enSitio('p1', 'sx')))).not.toThrow();
    expect(() => validarFotosPortables(despues, base(enParada('nadie')))).toThrow();
  });
});

describe('F6 · respaldo: la identidad ORIGINAL retirada se conserva sin reescribir su destino', () => {
  it('solicitud y original de una foto retirada se copian y comparan con el plan nuevo', () => {
    const o = copiarOriginalRespaldo(antes, metadatos(4, enParada('tb')));
    expect(copiarOriginalRespaldo(despues, metadatos(4, enParada('tb')))).toEqual(o);
    const texto = serializarSolicitudRespaldo(antes, { version: 1, tipo: 'solicitud-respaldo', viajeId: 'viaje', fotoId: uuid(4),
      operacionId: uuid(104), original: o });
    expect(deserializarSolicitudRespaldo(despues, texto).original.destino).toEqual(enParada('tb'));
    expect(() => copiarOriginalRespaldo(despues, metadatos(4, enSitio('cena', 'tbs')))).toThrow();
  });
});

describe('R6 · legado: solo lo activo se importa y lo retirado queda en recuperación', () => {
  it('claves antiguas de una retirada (también la parada Top Banana) no se mapean a nada', () => {
    const entradas = { marcas: '{"2026-10-21|10:00|Vieja":"hecha","2026-10-21|21:00|Top Banana":"saltada","2026-10-22|09:00|Uno":"hecha"}',
      'pendientes-hechos': '["Comprobar la noria","Reserva"]' };
    const r = importarLegado(despues, crearProgreso(despues), entradas);
    expect(Object.keys(r.estado.paradas)).toEqual(['p1']);
    expect(Object.keys(r.estado.pendientes)).toEqual(['c1']);
    expect(r.recuperacion.map((x) => [x.campo, x.clave ?? x.valor, x.motivo])).toEqual([
      ['marcas', '2026-10-21|10:00|Vieja', 'desconocida'], ['marcas', '2026-10-21|21:00|Top Banana', 'desconocida'],
      ['pendientes-hechos', '0', 'desconocida']]);
    expect(iguales(r.originales, entradas)).toBe(true);
  });
});
