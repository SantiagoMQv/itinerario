import { describe, expect, it } from 'vitest';
import { crearPoliticaFotos, MODOS_FOTOS } from '../src/fotos-datos';

describe('datos de las fotos: permiso único y conservador', () => {
  const almacen = () => {
    const valores = new Map<string, string>();
    return { getItem: (k: string) => valores.get(k) ?? null, setItem: (k: string, v: string) => { valores.set(k, v); } };
  };
  it('empieza en ahorro sin red y el permiso temporal no sobrevive a ocultar la app', () => {
    const a = almacen(); const p = crearPoliticaFotos(a);
    expect(p.permitida).toBe(false);
    p.permitirTemporal(); expect(p.permitida).toBe(true); expect(p.automatica).toBe(false);
    p.suspender(); expect(p.permitida).toBe(false);
    p.reanudar(); expect(p.permitida).toBe(false);
    expect(crearPoliticaFotos(a).permitida).toBe(false);
  });
  it('ilimitados es una elección persistida, solo permite red en primer plano y ahorro revoca todo permiso', () => {
    const a = almacen(); const p = crearPoliticaFotos(a);
    p.elegir(MODOS_FOTOS.ilimitados); expect(p.automatica).toBe(true);
    const q = crearPoliticaFotos(a); expect(q.automatica).toBe(true);
    q.suspender(); expect(q.permitida).toBe(false);
    q.reanudar(); expect(q.automatica).toBe(true);
    q.elegir(MODOS_FOTOS.ahorro); expect(q.permitida).toBe(false);
  });
  it('un almacenamiento ilegible no activa transferencias ni pierde el control en esta sesión', () => {
    const p = crearPoliticaFotos({ getItem() { throw Error('no disponible'); }, setItem() { throw Error('no disponible'); } });
    expect(p.permitida).toBe(false);
    p.elegir(MODOS_FOTOS.ilimitados); expect(p.automatica).toBe(true);
    p.elegir(MODOS_FOTOS.ahorro); expect(p.permitida).toBe(false);
  });
});
