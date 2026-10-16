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

// Shanghái y Hangzhou, con margen. Unas coordenadas con lat y lng cambiadas caen fuera.
const CAJA = { lat: [29.9, 31.8], lng: [119.7, 122.1] };
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
  '2026-10-21|19:40|Parque Guilin de noche',
  '2026-10-21|20:40|Cena shanghainesa en Xiao Ping',
  '2026-10-21|22:20|Hotel Aqua Suhe NO.1',
  '2026-10-22|08:50|Estación de Shanghái Sur',
  '2026-10-22|09:53|Estación de Hangzhou Este',
  '2026-10-22|10:45|Lingyin y Feilai Feng',
  '2026-10-22|13:10|Comida y té en Meijiawu',
  '2026-10-22|14:45|Dique Su',
  '2026-10-22|15:20|Isla de los Tres Estanques',
  '2026-10-22|16:10|Embarcadero de Hubin',
  '2026-10-22|16:30|Atardecer en el puente roto y el dique Bai',
  '2026-10-22|18:25|Estación de Hangzhou Este',
  '2026-10-22|19:47|Estación de Shanghái Sur',
  '2026-10-22|20:25|Cena: pato pekinés en Siji Minfu',
  '2026-10-22|21:30|Maleta en Joy City',
  '2026-10-22|22:10|Hotel Aqua Suhe NO.1',
  '2026-10-23|09:45|Shanghai Disneyland',
  '2026-10-23|22:50|Hotel Aqua Suhe NO.1',
  '2026-10-24|09:40|Zhujiajiao: jardín Kezhi, barca y puente Fangsheng',
  '2026-10-24|12:15|Comida en Caoxi Renjia',
  '2026-10-24|13:05|Templo del Dios de la Ciudad y correos Qing',
  '2026-10-24|14:50|Jardín Yuyuan',
  '2026-10-24|16:20|Bazar de Yuyuan y Old Street',
  '2026-10-24|19:40|Hotel Aqua Suhe NO.1',
  '2026-10-24|20:45|Cena de Sichuan en Four Seasons Cuisine',
  '2026-10-24|22:15|Speak Low',
  '2026-10-24|24:00|Hush (INS Land)',
  '2026-10-24|26:30|Hotel Aqua Suhe NO.1',
  '2026-10-25|11:45|Museo de Historia Natural de Shanghái',
  '2026-10-25|14:15|Templo y pagoda de Longhua, con fideos',
  '2026-10-25|15:35|13DEMARZO Café y Anfu Road',
  '2026-10-25|16:25|Wukang Road y Wukang Mansion',
  '2026-10-25|17:05|Hinichijou (Bear Paw Café)',
  '2026-10-25|17:20|CUBIC3: -86°C Dirty',
  '2026-10-25|18:30|Bufé de cena en Yi Café (Pudong Shangri-La)',
  '2026-10-25|20:35|Pasarela de Lujiazui de noche',
  '2026-10-25|21:00|Shanghai Tower: mirador de la planta 118',
  '2026-10-25|22:15|Hotel Aqua Suhe NO.1',
  '2026-10-26|07:00|Hotel Aqua Suhe NO.1',
  '2026-10-26|09:05|Aeropuerto de Pudong (PVG), T1',
];
const TEXTOS_HEREDADOS = [
  'Museo de Historia Natural (domingo 25): las entradas salen el domingo 18 a las 09:00 de China (las 03:00 en España), con el pasaporte, en el miniprograma «上海科技馆自然博物馆天文馆门票». No hay taquilla y los fines de semana se agotan.',
  'Jueves 22, Hangzhou: reservar ya Lingyin (miniprograma «杭州灵隐飞来峰» en WeChat, con los dos pasaportes, turno de mañana; la reserva para el jueves ya está abierta) y comprar los trenes G255 (上海南站 09:07) y G1386 (杭州东站 19:01).',
  'Antes del jueves 22: probar en WeChat el miniprograma «美味不用等» (o la cuenta «四季民福» → «排队取号»), buscar «四季民福 静安大悦城» y comprobar que deja coger número sin teléfono chino. El jueves, hacia las 16:30, coger número para dos (los pasos, en la ficha de la cena).',
  'Sábado 24: reservar mesa para dos a las 20:45 en Four Seasons Cuisine (四吉饭店), al 021 6244 0086 o que llame el hotel.',
  'Disneyland (viernes 23, día de Halloween): comprar la entrada y consultar el horario del día.',
  'Equipaje: añadir por internet una maleta facturada en el Vueling VY1542 (Barcelona–Málaga, martes 27 a las 06:50), que la tarifa no la incluye. Y decidir dónde pasar la noche en Barcelona (llegada a las 23:05 del lunes).',
  'Domingo 25: reservar el bufé del Yi Café (Pudong Shangri-La) para dos a las 18:30 en la web de reservas del Shangri-La (o al +86 21 2828 6888); 487 ¥ con todo. Comprar la entrada de la Shanghai Tower (180 ¥) por internet.',
  'Sábado noche: mirar la programación y la entrada de Hush/INS para el 24.',
];

describe('identidades persistentes', () => {
  test('las 172 entidades tienen literales opacos únicos y un contrato de solo lectura', () => {
    const subs = paradas.flatMap(({ p }) => p.subparadas ?? []);
    const pendientes = itinerario.pendientes ?? [];
    expect(paradas).toHaveLength(46);
    expect(subs).toHaveLength(117);
    expect(pendientes).toHaveLength(8);
    const ids = [itinerario.id, ...paradas.map(({ p }) => p.id), ...subs.map((s) => s.id), ...pendientes.map((p) => p.id)];
    for (const id of ids) expect(id).toMatch(/^[a-f0-9]{16}$/);
    expect(new Set(ids).size).toBe(172);
    // Cada identidad está escrita en los datos, no calculada a partir del contenido ni del orden.
    const fuente = readFileSync(new URL('../src/datos/itinerario.ts', import.meta.url), 'utf8');
    const literales = [...fuente.matchAll(/\bid: '([a-f0-9]{16})'/g)].map((m) => m[1]);
    expect(literales).toHaveLength(172);
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
    expect(modelo.paradas.at(-1)!.id).toBe(45);
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
