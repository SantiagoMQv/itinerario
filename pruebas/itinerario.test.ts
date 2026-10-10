// Comprobaciones del plan (src/datos/itinerario.ts). Fallan si un cambio deja el itinerario
// incoherente: horas que no encajan, coordenadas fuera de la zona del viaje, nombres en chino que no lo son…
import { describe, expect, test } from 'vitest';
import { itinerario } from '../src/datos/itinerario';
import { aMinutos } from '../src/formato';
import { distanciaKm } from '../src/geo';
import { construirModelo, trayectosApretados } from '../src/modelo';

const modelo = construirModelo(itinerario);
const paradas = itinerario.dias.flatMap((d) => d.paradas.map((p) => ({ d, p, quien: `${d.fecha} ${p.hora} «${p.nombre}»` })));

// Shanghái y Nankín, con margen. Unas coordenadas con lat y lng cambiadas caen fuera.
const CAJA = { lat: [30.6, 32.4], lng: [118.4, 122.1] };
const dentro = (lat: number, lng: number) => lat >= CAJA.lat[0] && lat <= CAJA.lat[1] && lng >= CAJA.lng[0] && lng <= CAJA.lng[1];
// Una subparada es un sitio dentro de la parada o a un paseo de ella.
const SUB_MAX_KM = 2;
const HORA = /^([01]\d|2[0-9]):[0-5]\d$/;
const HAN = /\p{Script=Han}/u;

describe('días', () => {
  test('fechas válidas, seguidas y sin repetir', () => {
    const fechas = itinerario.dias.map((d) => d.fecha);
    for (const f of fechas) expect(f, f).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    for (let i = 1; i < fechas.length; i++) {
      expect(aMinutos(fechas[i], '00:00') - aMinutos(fechas[i - 1], '00:00'), `${fechas[i - 1]} → ${fechas[i]}`).toBe(24 * 60);
    }
  });

  test('cada día tiene título y paradas', () => {
    for (const d of itinerario.dias) {
      expect(d.titulo.trim(), d.fecha).not.toBe('');
      expect(d.paradas.length, d.fecha).toBeGreaterThan(0);
    }
  });
});

describe('paradas', () => {
  test('la app no tiene avisos que enseñar', () => {
    expect(modelo.avisos).toEqual([]);
  });

  test('ningún trayecto se queda sin tiempo', () => {
    expect(trayectosApretados(modelo).map((t) => `${t.desde.p.nombre} → ${t.hasta.p.nombre}`)).toEqual([]);
  });

  test('horas con formato HH:MM y salida después de la llegada', () => {
    for (const { p, quien } of paradas) {
      expect(p.hora, quien).toMatch(HORA);
      if (p.fin) {
        expect(p.fin, quien).toMatch(HORA);
        expect(p.fin >= p.hora, `${quien}: sale (${p.fin}) antes de llegar`).toBe(true);
      }
    }
  });

  test('coordenadas dentro de la zona del viaje', () => {
    for (const { p, quien } of paradas) expect(dentro(p.lat, p.lng), `${quien}: ${p.lat}, ${p.lng}`).toBe(true);
  });

  test('las marcas no se confunden: fecha, hora y nombre no se repiten', () => {
    // La app guarda las marcas con la clave «fecha|hora|nombre».
    const claves = paradas.map(({ d, p }) => `${d.fecha}|${p.hora}|${p.nombre}`);
    expect(claves.length).toBe(new Set(claves).size);
  });

  test('la tarjeta del taxi lleva chino', () => {
    // Algunos sitios solo tienen nombre en letras latinas («Speak Low»): entonces cuenta la dirección.
    for (const { p, quien } of paradas) {
      if (p.direccionLocal) expect(p.direccionLocal, quien).toMatch(HAN);
      if (p.local) expect(`${p.local} ${p.direccionLocal ?? ''}`, quien).toMatch(HAN);
    }
  });

  test('el nombre corto cabe en un botón', () => {
    for (const { p, quien } of paradas) if (p.corto !== undefined) expect(p.corto.length, quien).toBeLessThanOrEqual(16);
  });

  test('trayectos con minutos razonables', () => {
    for (const { p, quien } of paradas) {
      const min = p.llegada?.min;
      if (min !== undefined) expect(Number.isInteger(min) && min > 0 && min < 6 * 60, `${quien}: ${min} min`).toBe(true);
    }
  });

  test('gastos con mínimo menor o igual que el máximo', () => {
    for (const { p, quien } of paradas) {
      for (const g of p.gastos ?? []) {
        expect(g.min, `${quien}: ${g.concepto}`).toBeGreaterThanOrEqual(0);
        if (g.max !== undefined) expect(g.max, `${quien}: ${g.concepto}`).toBeGreaterThanOrEqual(g.min);
      }
    }
  });

  test('enlaces con https', () => {
    const enlaces = [...paradas.flatMap(({ p }) => p.enlaces ?? []), ...(itinerario.secciones ?? []).flatMap((s) => s.enlaces ?? [])];
    for (const e of enlaces) expect(e.url, e.texto).toMatch(/^https:\/\//);
  });
});

describe('subparadas', () => {
  const subs = paradas.flatMap(({ p, quien }) => (p.subparadas ?? []).map((s) => ({ p, s, quien: `${quien} › ${s.nombre}` })));

  test('sin nombres repetidos dentro de una parada', () => {
    for (const { p, quien } of paradas) {
      const nombres = (p.subparadas ?? []).map((s) => s.nombre);
      expect(nombres.length, quien).toBe(new Set(nombres).size);
    }
  });

  test('con las dos coordenadas o ninguna', () => {
    for (const { s, quien } of subs) expect(s.lat === undefined, quien).toBe(s.lng === undefined);
  });

  test(`a menos de ${SUB_MAX_KM} km de su parada`, () => {
    for (const { p, s, quien } of subs) {
      if (s.lat === undefined || s.lng === undefined) continue;
      const km = distanciaKm([p.lng, p.lat], [s.lng, s.lat]);
      expect(km, quien).toBeLessThan(SUB_MAX_KM);
    }
  });

  test('la tarjeta del taxi lleva chino', () => {
    for (const { s, quien } of subs) {
      if (s.direccionLocal) expect(s.direccionLocal, quien).toMatch(HAN);
      if (s.local) expect(`${s.local} ${s.direccionLocal ?? ''}`, quien).toMatch(HAN);
    }
  });
});
