import { describe, expect, it } from 'vitest';
import { itinerario as plan } from '../src/datos/itinerario';
import { copiarIdentidadRespaldo, esReciboRespaldo, mismosOriginalesRespaldo,
  type ReciboRespaldo } from '../src/fotos-respaldo';
import { copiarSolicitudRespaldo, serializarSolicitudRespaldo, deserializarSolicitudRespaldo,
  serializarReciboRespaldo, deserializarReciboRespaldo, reciboCorrespondeASolicitud,
  MAX_BYTES_JSON_RESPALDO, type SolicitudRespaldo } from '../src/fotos-protocolo';

const fotoId = '12345678-1234-4123-8123-123456789abc';
const operacionId = '87654321-4321-4321-9321-cba987654321';
const otraId = '11111111-1111-4111-8111-111111111111';
function solicitud(): SolicitudRespaldo {
  return { version: 1, tipo: 'solicitud-respaldo', viajeId: plan.id, operacionId, fotoId,
    original: { formato: 1, fotoId, destino: { tipo: 'parada', viajeId: plan.id,
      paradaId: plan.dias[0].paradas[0].id }, nombre: '\0 e\u0301 " \\ [-0] ',
    mimeDeclarado: '\0image/raw e\u0301', ultimaModificacion: -0, incorporada: -0, bytesOriginal: -0 } };
}
function recibo(s = solicitud()): ReciboRespaldo {
  return { ...s, tipo: 'acuse-respaldo', objetoOriginalDurable: true, metadatosDurables: true };
}
const pares = [
  { nombre: 'solicitud', crear: solicitud, codificar: serializarSolicitudRespaldo, decodificar: deserializarSolicitudRespaldo },
  { nombre: 'recibo', crear: recibo, codificar: serializarReciboRespaldo, decodificar: deserializarReciboRespaldo },
];

describe.each(pares)('codec $nombre', ({ crear, codificar, decodificar }) => {
  it('conserva los tres ceros negativos y texto raw interoperable', () => {
    const valor = crear(); const texto = codificar(plan, valor); const copia = decodificar(plan, texto);
    expect(copia).toEqual(valor);
    expect(mismosOriginalesRespaldo(plan, copia.original, valor.original)).toBe(true);
    for (const clave of ['incorporada', 'ultimaModificacion', 'bytesOriginal'] as const) {
      expect(Object.is(JSON.parse(texto).original[clave], -0)).toBe(true);
      expect(Object.is(copia.original[clave], -0)).toBe(true);
      const positivo = { ...valor, original: { ...valor.original, [clave]: 0 } };
      const resultado = decodificar(plan, codificar(plan, positivo));
      expect(Object.is(resultado.original[clave], 0)).toBe(true);
      expect(mismosOriginalesRespaldo(plan, copia.original, resultado.original)).toBe(false);
    }
    expect(copia.original.nombre).toBe('\0 e\u0301 " \\ [-0] ');
    expect(copia.original.mimeDeclarado).toBe('\0image/raw e\u0301');
  });

  it('materializa propios no enumerables sin alias ni mutación', () => {
    const valor = crear(); Object.defineProperty(valor.original, 'nombre', { value: 'raw', enumerable: false, writable: true });
    const texto = codificar(plan, valor); const copia = decodificar(plan, texto);
    expect(copia.original.nombre).toBe('raw');
    expect(Object.keys(copia.original)).toContain('nombre');
    expect(copia.original).not.toBe(valor.original);
    expect(copia.original.destino).not.toBe(valor.original.destino);
    Object.assign(valor.original.destino, { paradaId: 'mutada' });
    Object.assign(valor.original, { nombre: 'mutado' });
    expect(copia.original.destino.paradaId).toBe(plan.dias[0].paradas[0].id);
    expect(decodificar(plan, texto).original.nombre).toBe('raw');
  });

  it('rechaza accessors, extras ocultos, símbolos, prototipos y ciclos', () => {
    let llamadas = 0;
    const getter = crear(); Object.defineProperty(getter.original, 'nombre', { get: () => { llamadas++; return 'x'; } });
    const toJSON = crear(); Object.assign(toJSON, { toJSON: () => { llamadas++; return {}; } });
    const oculto = crear(); Object.defineProperty(oculto.original, 'secreto', { value: 'x' });
    const simbolo = crear(); Object.assign(simbolo, { [Symbol('extra')]: true });
    const ciclo = crear(); Object.assign(ciclo, { original: ciclo });
    const prototipo = Object.assign(Object.create({ ajeno: true }), crear());
    for (const malo of [getter, toJSON, oculto, simbolo, ciclo, prototipo, new Blob(['x']), new String('x')]) {
      expect(() => codificar(plan, malo)).toThrow();
    }
    expect(llamadas).toBe(0);
  });

  it('rechaza contradicciones de viaje, UUID, foto y dominio original', () => {
    const valor = crear();
    const invalidos = [ { ...valor, version: 2 }, { ...valor, viajeId: 'otro' },
      { ...valor, operacionId: 'token' }, { ...valor, fotoId: otraId },
      { ...valor, original: { ...valor.original, destino: { ...valor.original.destino, viajeId: 'otro' } } },
      { ...valor, original: { ...valor.original, bytesOriginal: -1 } },
      { ...valor, original: { ...valor.original, incorporada: NaN } },
      { ...valor, original: { ...valor.original, ultimaModificacion: Infinity } },
      { ...valor, original: { ...valor.original, bytesOriginal: 0.5 } },
      { ...valor, original: { ...valor.original, miniatura: { tipo: 'pendiente' } } },
      { ...valor, credencial: 'no' },
    ];
    for (const malo of invalidos) {
      expect(() => codificar(plan, malo)).toThrow();
      expect(() => decodificar(plan, JSON.stringify(malo))).toThrow();
    }
    for (const clave of Object.keys(valor)) {
      const incompleto = { ...valor } as Record<string, unknown>; delete incompleto[clave];
      expect(() => codificar(plan, incompleto)).toThrow();
      expect(() => decodificar(plan, JSON.stringify(incompleto))).toThrow();
    }
  });

  it('rechaza claves duplicadas incluso escapadas en cualquier objeto', () => {
    const texto = codificar(plan, crear());
    const duplicados = [
      texto.replace('"version":1', '"version":1,"version":1'),
      texto.replace('"version":1', '"version":1,"\\u0076ersion":1'),
      texto.replace('"formato":1', '"formato":1,"formato":1'),
      texto.replace('"paradaId":', '"paradaId":"otra","\\u0070aradaId":'),
      '{"desconocido":{"a":1,"\\u0061":2}}',
      '{"desconocido":[{"a":1,"\\u0061":2}]}',
    ];
    for (const malo of duplicados) expect(() => decodificar(plan, malo)).toThrow(/duplicada/);
  });

  it('acota UTF-8 exactamente, no longitud JS ni peso de foto', () => {
    const valor = crear(); const vacio = { ...valor, original: { ...valor.original, nombre: '' } };
    const base = new TextEncoder().encode(codificar(plan, vacio)).length;
    const espacio = MAX_BYTES_JSON_RESPALDO - base;
    const nombre = '界'.repeat(Math.floor(espacio / 3)) + 'a'.repeat(espacio % 3);
    const limite = { ...vacio, original: { ...vacio.original, nombre } };
    const texto = codificar(plan, limite);
    expect(new TextEncoder().encode(texto).length).toBe(MAX_BYTES_JSON_RESPALDO);
    expect(decodificar(plan, texto).original.nombre).toBe(nombre);
    expect(() => codificar(plan, { ...limite, original: { ...limite.original, nombre: nombre + '界' } })).toThrow();
    expect(() => decodificar(plan, texto + ' ')).toThrow();
    expect(() => decodificar(plan, '界'.repeat(22000))).toThrow(/UTF-8/);
  });

  it('rechaza JSON inválido, profundidad excesiva y objetos ajenos', () => {
    const texto = codificar(plan, crear());
    for (const malo of [undefined, null, 1, {}, '', '\ufeff' + texto, texto + texto,
      texto.slice(0, -1), texto + 'x', texto.replace('"version":1', '"version":01'),
      texto.replace('"version":1', '"version":NaN'), texto.replace('\\u0000', '\0'),
      '['.repeat(10000) + '0' + ']'.repeat(10000), '{"a":}', '{}', '[]', 'true', '"token"']) {
      expect(() => decodificar(plan, malo)).toThrow();
    }
    expect(decodificar(plan, '\t\r\n ' + texto + ' ')).toEqual(crear());
  });

  it('conserva Unicode sin imponer otra restricción al dominio', () => {
    const valor = crear();
    const original = { ...valor.original, nombre: '\ud800\udfff\ud800', mimeDeclarado: '\udc00' };
    expect(copiarIdentidadRespaldo(plan, original)).toEqual(original);
    expect(decodificar(plan, codificar(plan, { ...valor, original })).original).toEqual(original);
    const texto = codificar(plan, crear()).replace('"version":1', '"\\u0076ersion":1e0');
    expect(decodificar(plan, texto)).toEqual(crear());
  });
});

it('copia solicitud válida y valida subparada contra su padre exacto', () => {
  const s = solicitud(); const copia = copiarSolicitudRespaldo(plan, s);
  expect(copia).toEqual(s); expect(copia.original).not.toBe(s.original);
  const padres = plan.dias.flatMap((d) => d.paradas);
  const padre = padres.find((p) => p.subparadas?.length)!;
  const destino = { tipo: 'subparada', viajeId: plan.id, paradaId: padre.id, subparadaId: padre.subparadas![0].id };
  const sub = { ...s, original: { ...s.original, destino } };
  expect(deserializarSolicitudRespaldo(plan, serializarSolicitudRespaldo(plan, sub)).original.destino).toEqual(destino);
  expect(() => copiarSolicitudRespaldo(plan, { ...sub, original: { ...sub.original,
    destino: { ...destino, paradaId: padres.find((p) => p.id !== padre.id)!.id } } })).toThrow();
});

it('recibo exige ambos true literales; binding no autentica al emisor', () => {
  const s = solicitud(); const r = recibo(s);
  expect(esReciboRespaldo(plan, r)).toBe(true);
  expect(reciboCorrespondeASolicitud(plan, s, r)).toBe(true);
  for (const clave of ['objetoOriginalDurable', 'metadatosDurables']) {
    for (const valor of [false, 1, 'true', new Boolean(true), null]) {
      const malo = { ...r, [clave]: valor };
      expect(esReciboRespaldo(plan, malo)).toBe(false);
      expect(() => serializarReciboRespaldo(plan, malo)).toThrow();
      // Un wrapper Boolean no es válido como objeto de entrada, pero JSON.stringify
      // lo convierte en true literal. El texto ya no conserva esa procedencia.
      if (!(valor instanceof Boolean)) {
        expect(() => deserializarReciboRespaldo(plan, JSON.stringify(malo))).toThrow();
      } else {
        expect(deserializarReciboRespaldo(plan, JSON.stringify(malo))[clave as keyof ReciboRespaldo]).toBe(true);
      }
    }
  }
  expect(reciboCorrespondeASolicitud(plan, s, { ...r, operacionId: otraId })).toBe(false);
  for (const clave of ['incorporada', 'ultimaModificacion', 'bytesOriginal']) {
    expect(reciboCorrespondeASolicitud(plan, s, { ...r, original: { ...r.original, [clave]: 0 } })).toBe(false);
  }
  const otraFoto = { ...r, fotoId: otraId, original: { ...r.original, fotoId: otraId } };
  expect(esReciboRespaldo(plan, otraFoto)).toBe(true);
  expect(reciboCorrespondeASolicitud(plan, s, otraFoto)).toBe(false);
  expect(reciboCorrespondeASolicitud(plan, {}, r)).toBe(false);
});
