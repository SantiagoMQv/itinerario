import { describe, expect, test } from 'vitest';
import { aMinutos, duracion, hora, km } from '../src/formato';
import { estimarMinutos } from '../src/modelo';

describe('horas', () => {
  test('«24:30» es pasada la medianoche del mismo día de itinerario', () => {
    expect(aMinutos('2026-10-21', '24:30')).toBe(aMinutos('2026-10-22', '00:30'));
    expect(hora(aMinutos('2026-10-21', '24:30'))).toBe('00:30');
  });

  test('duraciones', () => {
    expect(duracion(45)).toBe('45 min');
    expect(duracion(60)).toBe('1 h');
    expect(duracion(95)).toBe('1 h 35 min');
  });
});

describe('distancias', () => {
  test('metros por debajo de 1 km y kilómetros con coma', () => {
    expect(km(0.004)).toBe('10 m');
    expect(km(0.46)).toBe('460 m');
    expect(km(2.35)).toBe('2,4 km');
    expect(km(12.6)).toBe('13 km');
  });

  test('el taxi es más rápido que ir a pie', () => {
    expect(estimarMinutos('taxi', 3)).toBeLessThan(estimarMinutos('a_pie', 3));
  });
});
