import { describe, expect, it, vi } from 'vitest';
import type { Itinerario } from '../../src/tipos';
import { aplicarOperacion, crearProgreso, type Operacion } from '../../src/progreso';
import { capturarInstantaneaProgreso, capturarOperacionProgreso } from '../../src/progreso-cola';
import { iguales, type InstantaneaProgreso } from '../../src/progreso-validacion';
import { crearAlmacenProgreso, type DecisionHistorica, type PasarelaProgreso } from '../../servidor/almacen-progreso';

const plan: Itinerario = { id: 'viaje', titulo: 'Prueba', dias: [{ fecha: '2026-10-21', titulo: 'Día',
  paradas: ['a', 'b'].map((id) => ({ id, nombre: id, hora: '10:00', categoria: 'museo', lat: 31, lng: 121 })) }],
  pendientes: [{ id: 'entrada', texto: 'Entrada' }] };
const actor = 'a'.repeat(64);
const op = (extra = {}): Operacion => ({ id: 'op', dispositivoId: 'dispositivo', tipo: 'parada',
  paradaId: 'a', marca: 'hecha', revision: 0, ...extra });
const vacia = (): InstantaneaProgreso => ({ revisionServidor: 0, estado: crearProgreso(plan) });
const instantaneaDecision = (d: DecisionHistorica) => d.tipo === 'positiva' ? d.acuse.instantanea : d.rechazo.instantanea;
function diferida() {
  let resolver!: () => void;
  const promesa = new Promise<void>((r) => { resolver = r; });
  return { promesa, resolver };
}
function oculta<T>(valor: T): T {
  if (Array.isArray(valor)) return valor.map(oculta) as T;
  if (valor && typeof valor === 'object') {
    const copia = {};
    for (const clave of Object.getOwnPropertyNames(valor)) Object.defineProperty(copia, clave,
      { value: oculta((valor as Record<string, unknown>)[clave]) });
    return copia as T;
  }
  return valor;
}
function preparar(inicial = vacia(), maxIntentos?: number) {
  // Solo arnés: serializa CAS en memoria; NO demuestra locks, SQL ni sesiones reales.
  let actual = capturarInstantaneaProgreso(plan, inicial)!;
  let vigente = true;
  const decisiones = new Map<string, DecisionHistorica>();
  const consultar = vi.fn(async (huella: string, viaje: string, id?: string): Promise<unknown> => {
    expect(huella).toBe(actor); expect(viaje).toBe(plan.id);
    return vigente ? { tipo: 'lectura', instantanea: capturarInstantaneaProgreso(plan, actual), decision: id ? decisiones.get(id) ?? null : null }
      : { tipo: 'sin-sesion' };
  });
  const confirmar = vi.fn(async (huella: string, viaje: string, base: number, candidato: DecisionHistorica): Promise<unknown> => {
    expect(huella).toBe(actor); expect(viaje).toBe(plan.id);
    if (!vigente) return { tipo: 'sin-sesion' };
    if (actual.revisionServidor !== base) return { tipo: 'desfase' };
    const siguiente = instantaneaDecision(candidato);
    expect(siguiente.revisionServidor).toBe(base + 1);
    const id = candidato.tipo === 'positiva' ? candidato.operacionOriginal.id : candidato.rechazo.operacionId;
    expect(decisiones.has(id)).toBe(false);
    actual = capturarInstantaneaProgreso(plan, siguiente)!;
    decisiones.set(id, candidato);
    return { tipo: 'comprometida' };
  });
  const pasarela: PasarelaProgreso = { consultar, confirmar };
  const almacen = crearAlmacenProgreso({ plan, pasarela, ...(maxIntentos === undefined ? {} : { maxIntentos }) });
  return { almacen, pasarela, consultar, confirmar, decisiones, actual: () => actual, revocar: () => { vigente = false; } };
}
const fallo = 'No se pudo comprobar el progreso.';
async function segura(p: Promise<unknown>, mensaje = fallo) {
  await expect(p).rejects.toMatchObject({ message: mensaje });
}

describe('Almacén de progreso sobre pasarela CAS abstracta', () => {
  it('lee sin crear ni confirmar y pasa la huella, nunca el dispositivo', async () => {
    const p = preparar();
    expect(await p.almacen.leer(actor, plan.id)).toEqual({ tipo: 'instantanea', instantanea: vacia() });
    expect(p.consultar).toHaveBeenCalledWith(actor, plan.id);
    expect(p.confirmar).not.toHaveBeenCalled();
  });
  it.each([op(), op({ marca: null })])('persiste aplicada o sin-cambio con recibo y un único incremento', async (original) => {
    const p = preparar();
    const r = await p.almacen.procesar(actor, plan.id, original);
    expect(r.tipo).toBe('confirmada');
    expect(p.actual().revisionServidor).toBe(1);
    expect(Object.hasOwn(p.actual().estado.operaciones, original.id)).toBe(true);
    expect(aplicarOperacion(plan, p.actual().estado, original).tipo).toBe('duplicada');
    expect(p.confirmar).toHaveBeenCalledTimes(1);
  });
  it('repite el acuse histórico exacto tras actualizaciones posteriores', async () => {
    const p = preparar();
    const primero = await p.almacen.procesar(actor, plan.id, op());
    await p.almacen.procesar(actor, plan.id, op({ id: 'otro', paradaId: 'b' }));
    expect(await p.almacen.procesar(actor, plan.id, op())).toEqual(primero);
    expect(p.actual().revisionServidor).toBe(2);
    expect(p.confirmar).toHaveBeenCalledTimes(2);
  });
  it('rechaza conflicto sin cambiar entidades y conserva el rechazo histórico', async () => {
    const p = preparar();
    await p.almacen.procesar(actor, plan.id, op({ id: 'primera' }));
    const estado = p.actual().estado;
    const original = op({ marca: 'saltada' });
    const r = await p.almacen.procesar(actor, plan.id, original);
    expect(r.tipo).toBe('rechazada');
    expect(p.actual().estado).toEqual(estado);
    expect(p.actual().revisionServidor).toBe(2);
    expect(Object.hasOwn(p.actual().estado.operaciones, 'op')).toBe(false);
    await p.almacen.procesar(actor, plan.id, op({ id: 'otro', paradaId: 'b' }));
    expect(await p.almacen.procesar(actor, plan.id, original)).toEqual(r);
    expect(p.confirmar).toHaveBeenCalledTimes(3);
  });
  it.each(['positiva', 'negativa'])('cuarentena por otro cuerpo en identidad %s sin sobrescribir', async (tipo) => {
    const p = preparar();
    if (tipo === 'negativa') await p.almacen.procesar(actor, plan.id, op({ id: 'previa', marca: 'saltada' }));
    await p.almacen.procesar(actor, plan.id, op());
    const veces = p.confirmar.mock.calls.length;
    expect(await p.almacen.procesar(actor, plan.id, op({ dispositivoId: 'otro' }))).toEqual({ tipo: 'identidad-reutilizada' });
    expect(p.confirmar).toHaveBeenCalledTimes(veces);
  });
  it('deshacer desconocido permanece negativo aunque llegue después su padre', async () => {
    const p = preparar();
    const padre = op({ id: 'padre' });
    const aplicada = aplicarOperacion(plan, crearProgreso(plan), padre);
    if (aplicada.tipo !== 'aplicada') throw new Error('Preparación inválida');
    const deshacer: Operacion = { id: 'undo', dispositivoId: 'd', tipo: 'deshacer', cambios: aplicada.cambios };
    const rechazo = await p.almacen.procesar(actor, plan.id, deshacer);
    expect(rechazo.tipo).toBe('rechazada');
    await p.almacen.procesar(actor, plan.id, padre);
    expect(await p.almacen.procesar(actor, plan.id, deshacer)).toEqual(rechazo);
    expect(p.actual().revisionServidor).toBe(2);
  });
  it('deshacer usa el inverso condicional del núcleo compartido', async () => {
    const p = preparar();
    await p.almacen.procesar(actor, plan.id, op());
    const cambios = p.actual().estado.operaciones.op.cambios!;
    expect((await p.almacen.procesar(actor, plan.id, { id: 'undo', dispositivoId: 'd', tipo: 'deshacer', cambios })).tipo).toBe('confirmada');
    expect(p.actual().estado.paradas.a.marca).toBe(null);
  });
  it.each(['independientes', 'misma entidad', 'mismo ID', 'ID opuesto'])('intercalación de lecturas n0: %s', async (caso) => {
    const p = preparar();
    const lectura = p.consultar.getMockImplementation()!;
    const barrera = diferida();
    let entradas = 0;
    p.consultar.mockImplementation(async (...args) => {
      const r = await lectura(...args);
      if (++entradas <= 2) { if (entradas === 2) barrera.resolver(); await barrera.promesa; }
      return r;
    });
    const segunda = caso === 'independientes' ? op({ id: 'segunda', paradaId: 'b' })
      : caso === 'misma entidad' ? op({ id: 'segunda', marca: 'saltada' })
        : caso === 'ID opuesto' ? op({ marca: 'saltada' }) : op();
    const resultados = await Promise.all([p.almacen.procesar(actor, plan.id, op()), p.almacen.procesar(actor, plan.id, segunda)]);
    expect(resultados.map((r) => r.tipo)).toEqual(caso === 'misma entidad' ? ['confirmada', 'rechazada']
      : caso === 'ID opuesto' ? ['confirmada', 'identidad-reutilizada'] : ['confirmada', 'confirmada']);
    expect(p.actual().revisionServidor).toBe(caso.startsWith('ID') || caso === 'mismo ID' ? 1 : 2);
    expect(p.consultar).toHaveBeenCalledTimes(3);
  });
  it('revocación entre lectura y CAS no confirma ni muta', async () => {
    const p = preparar();
    const confirmar = p.confirmar.getMockImplementation()!;
    p.confirmar.mockImplementation(async (...args) => { p.revocar(); return confirmar(...args); });
    expect(await p.almacen.procesar(actor, plan.id, op())).toEqual({ tipo: 'sin-sesion' });
    expect(p.actual().revisionServidor).toBe(0);
    expect(await p.almacen.leer(actor, plan.id)).toEqual({ tipo: 'sin-sesion' });
  });
  it('no responde hasta resolver el commit; candidato aislado y congelado', async () => {
    const p = preparar();
    const puerta = diferida();
    const entrado = diferida();
    const confirmar = p.confirmar.getMockImplementation()!;
    p.confirmar.mockImplementation(async (...args) => {
      expect(Object.isFrozen(args[3])).toBe(true);
      expect(Object.isFrozen(instantaneaDecision(args[3]).estado)).toBe(true);
      expect(() => { (args[3] as { tipo: string }).tipo = 'alterada'; }).toThrow();
      entrado.resolver(); await puerta.promesa; return confirmar(...args);
    });
    const original = op();
    let respondio = false;
    const resultado = p.almacen.procesar(actor, plan.id, original).then((r) => { respondio = true; return r; });
    await Promise.race([entrado.promesa, resultado]);
    (original as { marca: string }).marca = 'saltada';
    expect(respondio).toBe(false);
    puerta.resolver();
    expect((await resultado).tipo).toBe('confirmada');
    expect(p.actual().estado.paradas.a.marca).toBe('hecha');
  });
  it('commit seguido de excepción no reintenta; siguiente llamada recupera decisión', async () => {
    const p = preparar();
    const confirmar = p.confirmar.getMockImplementation()!;
    p.confirmar.mockImplementationOnce(async (...args) => { await confirmar(...args); throw new Error('postgres://secreto'); });
    await segura(p.almacen.procesar(actor, plan.id, op()));
    expect(p.consultar).toHaveBeenCalledTimes(1);
    expect((await p.almacen.procesar(actor, plan.id, op())).tipo).toBe('confirmada');
    expect(p.actual().revisionServidor).toBe(1);
  });
  it.each([undefined, 1, 10])('desfases agotan el límite %s sin negativo', async (limite) => {
    const p = preparar(vacia(), limite);
    p.confirmar.mockResolvedValue({ tipo: 'desfase' });
    await segura(p.almacen.procesar(actor, plan.id, op()), 'El progreso está ocupado. Intentá de nuevo.');
    expect(p.consultar).toHaveBeenCalledTimes(limite ?? 3);
    expect(p.decisiones.size).toBe(0);
  });
  it('contador MAX impide nuevas decisiones pero permite repetición histórica', async () => {
    const p = preparar({ ...vacia(), revisionServidor: Number.MAX_SAFE_INTEGER - 1 });
    const r = await p.almacen.procesar(actor, plan.id, op());
    expect(await p.almacen.procesar(actor, plan.id, op())).toEqual(r);
    await segura(p.almacen.procesar(actor, plan.id, op({ id: 'nueva' })), 'El progreso alcanzó su capacidad.');
    expect(p.confirmar).toHaveBeenCalledTimes(1);
  });
  it('rechazo histórico en contador MAX sigue siendo repetible sin nuevas decisiones', async () => {
    const inicial = vacia();
    const p = preparar({ revisionServidor: Number.MAX_SAFE_INTEGER - 1,
      estado: { ...inicial.estado, paradas: { a: { marca: 'saltada', revision: 1 } } } });
    const r = await p.almacen.procesar(actor, plan.id, op());
    expect(r.tipo).toBe('rechazada');
    expect(await p.almacen.procesar(actor, plan.id, op())).toEqual(r);
    expect(p.confirmar).toHaveBeenCalledTimes(1);
  });
  it.each([{ ...vacia(), revisionServidor: NaN }, { ...vacia(), revisionServidor: -1 },
    { ...vacia(), estado: { ...crearProgreso(plan), viajeId: 'ajeno' } },
    { ...vacia(), estado: { ...crearProgreso(plan), paradas: { ajena: { marca: null, revision: 0 } } } }])('snapshot actual inválido no se aplica ni confirma', async (instantanea) => {
    const p = preparar(); p.consultar.mockResolvedValue({ tipo: 'lectura', instantanea, decision: null });
    await segura(p.almacen.leer(actor, plan.id));
    await segura(p.almacen.procesar(actor, plan.id, op()));
    expect(p.confirmar).not.toHaveBeenCalled();
  });
  it('revisión de entidad MAX genera negativo si queda capacidad global', async () => {
    const inicial = vacia();
    const p = preparar({ ...inicial, estado: { ...inicial.estado, paradas: { a: { marca: null, revision: Number.MAX_SAFE_INTEGER } } } });
    const r = await p.almacen.procesar(actor, plan.id, op({ revision: Number.MAX_SAFE_INTEGER }));
    expect(r.tipo).toBe('rechazada');
    expect(p.actual().revisionServidor).toBe(1);
  });
  it('captura DTO ocultos y preserva -0 sin normalización JSON ni alias', async () => {
    const p = preparar();
    const original = oculta(op({ horaReal: -0 }));
    expect((await p.almacen.procesar(actor, plan.id, original)).tipo).toBe('confirmada');
    const d = p.decisiones.get('op')!;
    expect(d.tipo).toBe('positiva');
    if (d.tipo !== 'positiva') return;
    expect(iguales(d.operacionOriginal, capturarOperacionProgreso(original))).toBe(true);
    expect(Object.is(p.actual().estado.paradas.a.horaReal, -0)).toBe(true);
    expect(await p.almacen.procesar(actor, plan.id, op({ horaReal: 0 }))).toEqual({ tipo: 'identidad-reutilizada' });
  });
  it.each(['__proto__', 'constructor', 'toString'])('ID opaco propio %s conserva recibo', async (id) => {
    const p = preparar();
    const r = await p.almacen.procesar(actor, plan.id, op({ id }));
    expect(r.tipo).toBe('confirmada');
    expect(await p.almacen.procesar(actor, plan.id, op({ id }))).toEqual(r);
  });
  it.each([op({ id: 'x\0' }), op({ dispositivoId: '\ud800' }), op({ id: 'x'.repeat(129) }),
    op({ paradaId: 'extranjera' }), { ...op(), extra: true }, op({ id: '' }),
    Object.defineProperty({}, 'id', { get() { throw new Error('secreto'); } })])('esquema o catálogo inválido no consume ID', async (valor) => {
    const p = preparar();
    await segura(p.almacen.procesar(actor, plan.id, valor as Operacion));
    expect(p.consultar).not.toHaveBeenCalled();
    expect(p.confirmar).not.toHaveBeenCalled();
  });
  it.each(['dispositivo', 'A'.repeat(63), 'g'.repeat(64)])('rechaza huella inválida %s antes de IO', async (huella) => {
    const p = preparar();
    await segura(p.almacen.leer(huella, plan.id));
    await segura(p.almacen.procesar(huella, plan.id, op()));
    expect(p.consultar).not.toHaveBeenCalled();
  });
  it('rechaza viaje ajeno antes de IO', async () => {
    const p = preparar();
    await segura(p.almacen.leer(actor, 'otro'));
    await segura(p.almacen.procesar(actor, 'otro', op()));
    expect(p.consultar).not.toHaveBeenCalled();
  });
  it.each([0, 11, 1.5, NaN])('configuración de intentos inválida %s', (maxIntentos) => {
    expect(() => crearAlmacenProgreso({ plan, pasarela: preparar().pasarela, maxIntentos })).toThrow(fallo);
  });
  it.each([null, { tipo: 'lectura' }, { tipo: 'sin-sesion', extra: true }, { tipo: new String('sin-sesion') },
    { tipo: 'lectura', instantanea: vacia(), decision: undefined },
    Object.defineProperty({}, 'tipo', { get() { throw new Error('secreto'); } }),
    { tipo: 'sin-sesion', [Symbol('secreto')]: true }])('rechaza respuesta de consulta malformada', async (valor) => {
    const p = preparar(); p.consultar.mockResolvedValue(valor);
    await segura(p.almacen.leer(actor, plan.id));
    await segura(p.almacen.procesar(actor, plan.id, op()));
    expect(p.confirmar).not.toHaveBeenCalled();
  });
  it.each([null, { tipo: 'comprometida', extra: true }, { tipo: 'confirmada' },
    Object.defineProperty({}, 'tipo', { get() { throw new Error('secreto'); } })])('no acepta confirmación malformada', async (valor) => {
    const p = preparar(); p.confirmar.mockResolvedValue(valor);
    await segura(p.almacen.procesar(actor, plan.id, op()));
    expect(p.consultar).toHaveBeenCalledTimes(1);
  });
  it.each(['ausente', 'otro ID', 'futuro', 'perdido', 'alterado', 'igual contador', 'getter', 'extra', 'original ajeno'])('historia positiva corrupta: %s', async (caso) => {
    const p = preparar(); await p.almacen.procesar(actor, plan.id, op());
    const decision = p.decisiones.get('op')!;
    if (decision.tipo !== 'positiva') throw new Error('Preparación inválida');
    let historica: unknown = decision;
    let actual = p.actual();
    if (caso === 'ausente') historica = null;
    if (caso === 'otro ID') historica = { ...decision, acuse: { ...decision.acuse, operacionId: 'otra' } };
    if (caso === 'futuro') historica = { ...decision, acuse: { ...decision.acuse, instantanea: { ...decision.acuse.instantanea, revisionServidor: 2 } } };
    if (caso === 'perdido') actual = { ...actual, estado: crearProgreso(plan) };
    if (caso === 'alterado') actual = { ...actual, revisionServidor: 2, estado: { ...actual.estado, operaciones: { op: { firma: 'otra' } } } };
    if (caso === 'igual contador') actual = { ...actual, estado: { ...actual.estado, paradas: { a: { marca: 'saltada', revision: 1 } } } };
    if (caso === 'getter') historica = Object.defineProperty({}, 'tipo', { get() { throw new Error('secreto'); } });
    if (caso === 'extra') historica = { ...decision, extra: true };
    if (caso === 'original ajeno') historica = { ...decision, operacionOriginal: op({ paradaId: 'ajena' }) };
    p.consultar.mockResolvedValue({ tipo: 'lectura', instantanea: actual, decision: historica });
    await segura(p.almacen.procesar(actor, plan.id, op()));
    expect(p.confirmar).toHaveBeenCalledTimes(1);
  });
  it('aquí cierra el anterior, limpia hora y conserva el inverso exacto del núcleo', async () => {
    const p = preparar();
    const primera = op({ marca: 'aqui', revisionAqui: 0, horaReal: 600 });
    const segunda = op({ id: 'segunda', paradaId: 'b', marca: 'aqui', revisionAqui: 1, revisionAnterior: 1, horaReal: 700 });
    const esperado1 = aplicarOperacion(plan, crearProgreso(plan), primera);
    const esperado2 = aplicarOperacion(plan, esperado1.estado, segunda);
    expect((await p.almacen.procesar(actor, plan.id, primera)).tipo).toBe('confirmada');
    expect((await p.almacen.procesar(actor, plan.id, segunda)).tipo).toBe('confirmada');
    expect(p.actual().estado).toEqual(esperado2.estado);
    expect(p.actual().estado.aqui.paradaId).toBe('b');
    expect(p.actual().estado.paradas.a.marca).toBe('hecha');
    const limpiar = op({ id: 'limpiar', paradaId: 'b', marca: null, revision: 1, revisionAqui: 2 });
    const esperado3 = aplicarOperacion(plan, esperado2.estado, limpiar);
    expect((await p.almacen.procesar(actor, plan.id, limpiar)).tipo).toBe('confirmada');
    expect(p.actual().estado).toEqual(esperado3.estado);
    expect(Object.hasOwn(p.actual().estado.paradas.b, 'horaReal')).toBe(false);
  });
  it('lectura sin ID rechaza decisión y acepta DTO propios ocultos sin getters', async () => {
    const p = preparar();
    p.consultar.mockResolvedValue(oculta({ tipo: 'lectura', instantanea: vacia(), decision: null }));
    expect(await p.almacen.leer(actor, plan.id)).toEqual({ tipo: 'instantanea', instantanea: vacia() });
    await p.almacen.procesar(actor, plan.id, op());
    p.consultar.mockResolvedValue({ tipo: 'lectura', instantanea: p.actual(), decision: p.decisiones.get('op') });
    await segura(p.almacen.leer(actor, plan.id));
  });
  it('rechaza getters anidados antes de leerlos, tanto entrada como pasarela', async () => {
    const p = preparar();
    const getter = vi.fn(() => 'secreto');
    const mala = Object.defineProperty({ ...op() }, 'dispositivoId', { get: getter });
    await segura(p.almacen.procesar(actor, plan.id, mala));
    const actual = Object.defineProperty({ ...vacia() }, 'estado', { get: getter });
    p.consultar.mockResolvedValue({ tipo: 'lectura', instantanea: actual, decision: null });
    await segura(p.almacen.procesar(actor, plan.id, op()));
    expect(getter).not.toHaveBeenCalled();
    expect(p.confirmar).not.toHaveBeenCalled();
  });
  it.each(['protocolo', 'viaje', 'otro ID', 'original', 'futuro', 'igual contador', 'getter'])('historia negativa corrupta: %s', async (caso) => {
    const p = preparar();
    await p.almacen.procesar(actor, plan.id, op({ id: 'previa', marca: 'saltada' }));
    await p.almacen.procesar(actor, plan.id, op());
    const d = p.decisiones.get('op')!;
    if (d.tipo !== 'negativa') throw new Error('Preparación inválida');
    const rechazo: Record<string, unknown> = { ...d.rechazo };
    if (caso === 'protocolo') rechazo.protocolo = 2;
    if (caso === 'viaje') rechazo.viajeId = 'ajeno';
    if (caso === 'otro ID') rechazo.operacionId = 'otro';
    if (caso === 'original') rechazo.operacionOriginal = op({ id: 'otro' });
    if (caso === 'futuro') rechazo.instantanea = { ...d.rechazo.instantanea, revisionServidor: 3 };
    if (caso === 'igual contador') rechazo.instantanea = { ...d.rechazo.instantanea, estado: crearProgreso(plan) };
    if (caso === 'getter') Object.defineProperty(rechazo, 'motivo', { get() { throw new Error('secreto'); } });
    p.consultar.mockResolvedValue({ tipo: 'lectura', instantanea: p.actual(), decision: { tipo: 'negativa', rechazo } });
    await segura(p.almacen.procesar(actor, plan.id, op()));
    expect(p.confirmar).toHaveBeenCalledTimes(2);
  });
  it('no puede perder otro recibo conocido en el snapshot histórico', async () => {
    const p = preparar();
    await p.almacen.procesar(actor, plan.id, op({ id: 'previa', paradaId: 'b' }));
    await p.almacen.procesar(actor, plan.id, op());
    const actual = p.actual();
    p.consultar.mockResolvedValue({ tipo: 'lectura', instantanea: { ...actual, revisionServidor: 3,
      estado: { ...actual.estado, operaciones: { op: actual.estado.operaciones.op } } }, decision: p.decisiones.get('op') });
    await segura(p.almacen.procesar(actor, plan.id, op()));
    expect(p.confirmar).toHaveBeenCalledTimes(2);
  });
  it('configuración inválida falla sin ejecutar getters ni revelar errores del catálogo', () => {
    const p = preparar();
    const getter = vi.fn(() => plan);
    const configuracion = Object.defineProperty({ pasarela: p.pasarela }, 'plan', { get: getter });
    expect(() => crearAlmacenProgreso(configuracion as unknown as Parameters<typeof crearAlmacenProgreso>[0])).toThrow(fallo);
    expect(getter).not.toHaveBeenCalled();
    expect(() => crearAlmacenProgreso({ plan: { ...plan, id: 'a' }, pasarela: p.pasarela })).toThrow(fallo);
    expect(() => crearAlmacenProgreso({ plan, pasarela: { ...p.pasarela, confirmar: null } as unknown as PasarelaProgreso })).toThrow(fallo);
  });
  it('transporte de consulta fallido es incertidumbre segura sin CAS', async () => {
    const p = preparar(); p.consultar.mockRejectedValue(new Error('postgres://secreto'));
    await segura(p.almacen.leer(actor, plan.id));
    await segura(p.almacen.procesar(actor, plan.id, op()));
    expect(p.confirmar).not.toHaveBeenCalled();
  });
  it('historia negativa contradicha por recibo positivo no es repetición válida', async () => {
    const p = preparar();
    const aplicada = aplicarOperacion(plan, crearProgreso(plan), op());
    p.consultar.mockResolvedValue({ tipo: 'lectura', instantanea: { revisionServidor: 2, estado: aplicada.estado },
      decision: { tipo: 'negativa', rechazo: { viajeId: plan.id, protocolo: 1, operacionId: 'op', operacionOriginal: op(),
        decisionPersistida: true, motivo: 'conflicto', instantanea: { ...vacia(), revisionServidor: 1 } } } });
    await segura(p.almacen.procesar(actor, plan.id, op()));
    expect(p.confirmar).not.toHaveBeenCalled();
  });
});
