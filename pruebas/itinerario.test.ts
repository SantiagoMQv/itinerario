// Comprobaciones del plan (src/datos/itinerario.ts). Fallan si un cambio deja el itinerario
// incoherente: horas que no encajan, coordenadas fuera de la zona del viaje, nombres en chino que no lo son…
import { readFileSync } from 'node:fs';
import { describe, expect, expectTypeOf, test } from 'vitest';
import type { Itinerario, Parada, Pendiente, Subparada } from '../src/tipos';
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

// Claves «fecha|hora|nombre» del plan: las marcas antiguas de los móviles se recuperan con ellas. Si un
// cambio del itinerario las toca, actualizar la lista a propósito (antes del viaje no hay marcas que perder).
const CLAVES_HEREDADAS = [
  '2026-10-21|07:00|Aeropuerto de Pudong (PVG), T1',
  '2026-10-21|10:00|Hotel Aqua Suhe NO.1',
  '2026-10-21|15:15|Comida en Huanghe Road: Yang’s Dumpling',
  '2026-10-21|16:05|Nanjing Road: tramo de People’s Square',
  '2026-10-21|17:20|Nanjing Road: tramo hacia el Bund',
  '2026-10-21|18:30|The Bund al encenderse las luces',
  '2026-10-21|19:20|Jing’an Joy City: maleta y ropa',
  '2026-10-21|20:25|Noria Sky Ring',
  '2026-10-21|21:00|Cena en Top Banana Market',
  '2026-10-21|22:05|Hotel Aqua Suhe NO.1',
  '2026-10-22|11:10|Parque Fuxing',
  '2026-10-22|11:50|Middle Huaihai Road: TX Huaihai',
  '2026-10-22|12:55|Lanxin (Lyceum Restaurant)',
  '2026-10-22|13:55|Compras por Huaihai y parque Xiangyang',
  '2026-10-22|15:00|Disfraces en el mercado de Fuyou Road',
  '2026-10-22|15:45|Jardín Yuyuan',
  '2026-10-22|16:35|Bazar de Yuyuan y Old Street',
  '2026-10-22|19:45|Cena: pato pekinés en Quanjude',
  '2026-10-22|21:30|Hotel Aqua Suhe NO.1',
  '2026-10-23|09:45|Shanghai Disneyland',
  '2026-10-23|22:50|Hotel Aqua Suhe NO.1',
  '2026-10-24|10:45|Estación de Shanghái',
  '2026-10-24|12:50|Estación de Nankín',
  '2026-10-24|13:15|Comida junto a Jiming Temple',
  '2026-10-24|14:00|Museo Paleontológico de Nankín',
  '2026-10-24|16:40|Paseo junto a Jiming Temple',
  '2026-10-24|17:35|Estación de Nankín',
  '2026-10-24|19:40|Estación de Shanghái',
  '2026-10-24|20:00|Hotel Aqua Suhe NO.1',
  '2026-10-24|22:00|Speak Low',
  '2026-10-24|23:45|Hush (INS Land)',
  '2026-10-24|26:30|Hotel Aqua Suhe NO.1',
  '2026-10-25|11:45|Museo de Historia Natural de Shanghái',
  '2026-10-25|14:20|Comida en el n.º 98 de Wukang Road',
  '2026-10-25|15:25|Wukang Road y Wukang Mansion',
  '2026-10-25|16:05|13DEMARZO Café',
  '2026-10-25|17:05|CUBIC3: -86°C Dirty',
  '2026-10-25|17:35|Hinichijou (Bear Paw Café)',
  '2026-10-25|18:40|Lujiazui de noche',
  '2026-10-25|19:25|Torre Perla Oriental',
  '2026-10-25|21:40|Hotel Aqua Suhe NO.1',
  '2026-10-26|07:15|Hotel Aqua Suhe NO.1',
  '2026-10-26|09:05|Aeropuerto de Pudong (PVG), T1',
];
const TEXTOS_HEREDADOS = [
  'Museo de Historia Natural (domingo 25): reservar la entrada (no venden en taquilla).',
  'Miércoles 21: confirmar la última entrada de la noria Sky Ring y hasta qué hora sirve Top Banana Market.',
  'Tren y museo: comprobar 12306, elegir estaciones y horarios reales y hacer la reserva nominal del museo.',
  'Disneyland (viernes 23, día de Halloween): comprar la entrada y consultar el horario del día.',
  'Equipaje: verificar la franquicia de los cuatro vuelos antes de comprar la maleta.',
  'Domingo noche: decidir cena giratoria en la Perla o solo vistas; reservar solo tras ver el precio final.',
  'Sábado noche: mirar la programación y la entrada de Hush/INS para el 24.',
  'Jueves 22: reservar mesa en Quanjude para las 19:45 (021-6418 1577, o que llame el hotel).',
];

describe('identidades persistentes', () => {
  test('las 164 entidades tienen literales opacos únicos y un contrato de solo lectura', () => {
    const subs = paradas.flatMap(({ p }) => p.subparadas ?? []);
    const pendientes = itinerario.pendientes ?? [];
    expect(paradas).toHaveLength(43);
    expect(subs).toHaveLength(112);
    expect(pendientes).toHaveLength(8);
    const ids = [itinerario.id, ...paradas.map(({ p }) => p.id), ...subs.map((s) => s.id), ...pendientes.map((p) => p.id)];
    for (const id of ids) expect(id).toMatch(/^[a-f0-9]{16}$/);
    expect(new Set(ids).size).toBe(164);
    // Cada identidad está escrita en los datos, no calculada a partir del contenido ni del orden.
    const fuente = readFileSync(new URL('../src/datos/itinerario.ts', import.meta.url), 'utf8');
    const literales = [...fuente.matchAll(/\bid: '([a-f0-9]{16})'/g)].map((m) => m[1]);
    expect(literales).toHaveLength(164);
    expect(literales.sort()).toEqual([...ids].sort());
    expectTypeOf<Pick<Itinerario, 'id'>>().toEqualTypeOf<{ readonly id: string }>();
    expectTypeOf<Pick<Parada, 'id'>>().toEqualTypeOf<{ readonly id: string }>();
    expectTypeOf<Pick<Subparada, 'id'>>().toEqualTypeOf<{ readonly id: string }>();
    expectTypeOf<Pick<Pendiente, 'id'>>().toEqualTypeOf<{ readonly id: string }>();
  });

  test('cada aparición del hotel y del aeropuerto tiene identidad propia', () => {
    for (const nombre of ['Hotel Aqua Suhe NO.1', 'Aeropuerto de Pudong (PVG), T1']) {
      const apariciones = paradas.filter(({ p }) => p.nombre === nombre);
      expect(apariciones.length).toBeGreaterThan(1);
      for (const { p } of apariciones) expect(p.id).toMatch(/^[a-f0-9]{16}$/);
      expect(new Set(apariciones.map(({ p }) => p.id)).size).toBe(apariciones.length);
    }
  });

  test('copiar, reordenar y renombrar no cambia identidades, aunque cambien índices de vista', () => {
    const copia: Itinerario = structuredClone(itinerario);
    copia.titulo = 'Otro título';
    copia.dias.reverse();
    for (const d of copia.dias) {
      d.fecha = '2026-11-01';
      d.paradas.reverse();
      for (const p of d.paradas) {
        p.nombre = 'Otro nombre';
        p.hora = '12:00';
        p.lat += 0.001;
        p.subparadas?.reverse();
        for (const s of p.subparadas ?? []) s.nombre = 'Otro sitio';
      }
    }
    copia.pendientes?.reverse();
    for (const p of copia.pendientes ?? []) p.texto = 'Otro texto';
    const cambiado = construirModelo(copia);
    expect(copia.id).toBe(itinerario.id);
    expect(copia.id).toMatch(/^[a-f0-9]{16}$/);
    expect(cambiado.paradas.map((p) => p.p.id)).toEqual(modelo.paradas.map((p) => p.p.id).reverse());
    for (const p of cambiado.paradas) {
      const original = modelo.paradas.find((o) => o.p.id === p.p.id)!;
      expect(original).toBeDefined();
      expect(p.subs.map((s) => s.s.id).sort()).toEqual(original.subs.map((s) => s.s.id).sort());
    }
    expect(cambiado.paradas[0].id).toBe(0);
    expect(cambiado.paradas[0].p.id).toBe(modelo.paradas.at(-1)!.p.id);
    expect(modelo.paradas.at(-1)!.id).toBe(42);
    // Con tres sitios hay al menos dos del mismo grupo (seguros u opcionales): invertirlos cambia su índice.
    const conSubs = cambiado.paradas.find((p) => p.subs.length > 2)!;
    const original = modelo.paradas.find((p) => p.p.id === conSubs.p.id)!;
    expect(conSubs.subs.some((s) => original.subs.find((o) => o.s.id === s.s.id)!.i !== s.i)).toBe(true);
    for (const t of cambiado.tramos) expect(t.id).toBe(t.hasta.id);
    expect(cambiado.listaPendientes.map((p) => p.id)).toEqual(modelo.listaPendientes.map((p) => p.id).reverse());
    expect(cambiado.pendientes).toEqual(Array(8).fill('Otro texto'));
  });

  test('conserva exactamente las claves y los textos heredados en su orden original', () => {
    expect(paradas.map(({ d, p }) => `${d.fecha}|${p.hora}|${p.nombre}`)).toEqual(CLAVES_HEREDADAS);
    expect(modelo.pendientes).toEqual(TEXTOS_HEREDADOS);
    expect(modelo.listaPendientes).toEqual(itinerario.pendientes);
    expect(modelo.listaPendientes.map((p) => p.texto)).toEqual(TEXTOS_HEREDADOS);
    expect(modelo.listaPendientes.map((p) => p.id)).toEqual(itinerario.pendientes!.map((p) => p.id));
  });

  test('sin pendientes, las dos listas quedan vacías', () => {
    const copia = { ...itinerario, pendientes: undefined };
    const sinPendientes = construirModelo(copia);
    expect(sinPendientes.listaPendientes).toEqual([]);
    expect(sinPendientes.pendientes).toEqual([]);
  });
});

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
