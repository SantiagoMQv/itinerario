import { describe, expect, it, vi } from 'vitest';
import { IDBFactory } from 'fake-indexeddb';
import { itinerario } from '../src/datos/itinerario';
import { abrirFotosLocal } from '../src/fotos-local';
import type { CapturaFoto } from '../src/fotos';
import { copiarOriginalRespaldo } from '../src/fotos-respaldo';
import { crearDescargaFotos, crearRecepcionOriginal } from '../src/fotos-descarga';

function barrera<T>() {
  let resolver!: (v: T) => void;
  const promesa = new Promise<T>((ok) => { resolver = ok; });
  return { promesa, resolver };
}

const fotoId = '12345678-1234-4123-8123-123456789abc';
const origen = 'https://fotos.example';
const ruta = `${origen}/api/fotos/${fotoId}/original`;
function captura(bytes = [0, 255, 17]): CapturaFoto {
  return { original: new Blob([new Uint8Array(bytes)], { type: 'image/heic' }), metadatos: {
    formato: 1, fotoId, destino: { tipo: 'parada', viajeId: itinerario.id,
      paradaId: itinerario.dias[0].paradas[0].id }, nombre: '\0 e\u0301 ', mimeDeclarado: 'image/heic',
    ultimaModificacion: -0, incorporada: -0, bytesOriginal: bytes.length, miniatura: { tipo: 'pendiente' },
  } };
}
function respuesta(bytes = [0, 255, 17], opciones: ResponseInit = {}) {
  return new Response(new Uint8Array(bytes), { status: 200,
    headers: { 'Content-Type': 'application/octet-stream', 'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff' }, ...opciones });
}
async function contexto() {
  const fabrica = new IDBFactory();
  const fotos = await abrirFotosLocal(itinerario, { fabrica });
  const a = captura();
  const enviar = vi.fn<typeof fetch>(async () => respuesta());
  const descarga = crearDescargaFotos({ plan: itinerario, origen, fotos, fetch: enviar });
  const ref = copiarOriginalRespaldo(itinerario, a.metadatos);
  const cerrar = () => { descarga.cerrar(); fotos.cerrar(); };
  return { fabrica, fotos, a, ref, enviar, descarga, cerrar };
}

describe('descarga manual protegida: confirmación exclusivamente local', () => {
  it('no hace IO al construir y confirma bytes completos después de guardar', async () => {
    const c = await contexto();
    try {
      const leer = vi.spyOn(c.fotos, 'leerMetadatos');
      expect(c.enviar).not.toHaveBeenCalled(); expect(leer).not.toHaveBeenCalled();
      const r = await c.descarga.descargar(c.ref);
      expect(r.tipo).toBe('guardada');
      expect(c.enviar).toHaveBeenCalledWith(ruta, expect.objectContaining({ method: 'GET',
        credentials: 'same-origin', cache: 'no-store', redirect: 'error' }));
      const opciones = c.enviar.mock.calls[0][1]!;
      expect([...new Headers(opciones.headers)]).toEqual([['accept', 'application/octet-stream']]);
      expect(opciones.body).toBeUndefined(); expect(opciones.signal).toBeInstanceOf(AbortSignal);
      const guardado = await c.fotos.leerOriginal(fotoId);
      expect([...new Uint8Array(await guardado!.arrayBuffer())]).toEqual([0, 255, 17]);
      const m = await c.fotos.leerMetadatos(fotoId);
      expect(m).toMatchObject({ nombre: '\0 e\u0301 ', mimeDeclarado: 'image/heic', miniatura: { tipo: 'pendiente' } });
      expect(Object.is((m as CapturaFoto['metadatos']).incorporada, -0)).toBe(true);
      expect(Object.is((m as CapturaFoto['metadatos']).ultimaModificacion, -0)).toBe(true);
    } finally { c.cerrar(); }
  });
});


describe('fronteras sin IO y snapshots', () => {
  it.each(['borrada', 'otra', 'corrupta', 'fallo', 'original-corrupto'] as const)(
    'rechaza estado local %s antes de HTTP', async (caso) => {
      const c = await contexto();
      try {
        if (caso === 'borrada') { await c.fotos.guardarOriginal(c.a); await c.fotos.borrarLocal(fotoId); }
        if (caso === 'otra') await c.fotos.guardarOriginal({ ...c.a, metadatos: { ...c.a.metadatos, incorporada: 0 } });
        const fotos = { ...c.fotos,
          leerMetadatos: caso === 'corrupta' ? async () => ({ formato: 9 } as never)
            : caso === 'fallo' ? async () => { throw new Error('Fuente cerrada'); } : c.fotos.leerMetadatos,
          leerOriginal: caso === 'original-corrupto' ? async () => null : c.fotos.leerOriginal,
        };
        if (caso === 'original-corrupto') await c.fotos.guardarOriginal(c.a);
        const d = crearDescargaFotos({ plan: itinerario, origen, fotos, fetch: c.enviar });
        expect((await d.descargar(c.ref)).tipo).toBe('fallida');
        expect(c.enviar).not.toHaveBeenCalled(); d.cerrar();
      } finally { c.cerrar(); }
    });
  it.each(['uuid', 'viaje', 'padre', 'subpadre', 'NaN', 'campo-extra'])(
    'rechaza identidad %s sin lectura ni red', async (caso) => {
      const c = await contexto();
      try {
        const leer = vi.spyOn(c.fotos, 'leerMetadatos');
        const ref = structuredClone(c.ref);
        if (caso === 'uuid') Object.assign(ref, { fotoId: '../imagen' });
        if (caso === 'viaje') Object.assign(ref.destino, { viajeId: 'ajeno' });
        if (caso === 'padre') Object.assign(ref.destino, { paradaId: 'ajena' });
        if (caso === 'subpadre') Object.assign(ref.destino, { tipo: 'subparada', subparadaId: 'ajena' });
        if (caso === 'NaN') Object.assign(ref, { bytesOriginal: NaN });
        if (caso === 'campo-extra') Object.assign(ref, { url: 'https://publico.example' });
        expect((await c.descarga.descargar(ref)).tipo).toBe('fallida');
        expect(leer).not.toHaveBeenCalled(); expect(c.enviar).not.toHaveBeenCalled();
      } finally { c.cerrar(); }
    });
  it.each([-1, 0.5, Infinity, NaN, Number.MAX_SAFE_INTEGER + 1])('rechaza límite %s', async (maxBytesOriginal) => {
    const c = await contexto();
    try { expect(() => crearDescargaFotos({ plan: itinerario, origen, fotos: c.fotos, maxBytesOriginal })).toThrow(); }
    finally { c.cerrar(); }
  });
  it.each(['https://usuario@fotos.example', `${origen}/`, `${origen}?x`, `${origen}#x`, 'file:///foto'])(
    'rechaza origen %s', async (valor) => {
      const c = await contexto();
      try { expect(() => crearDescargaFotos({ plan: itinerario, origen: valor, fotos: c.fotos })).toThrow(); }
      finally { c.cerrar(); }
    });
  it('cero bloquea positivo sin IO, admite vacío y conserva tres signos negativos', async () => {
    const c = await contexto();
    try {
      const leer = vi.spyOn(c.fotos, 'leerMetadatos');
      const d = crearDescargaFotos({ plan: itinerario, origen, fotos: c.fotos, fetch: c.enviar, maxBytesOriginal: 0 });
      expect((await d.descargar(c.ref)).tipo).toBe('fallida');
      expect(leer).not.toHaveBeenCalled(); expect(c.enviar).not.toHaveBeenCalled();
      c.enviar.mockImplementation(async () => respuesta([]));
      const r = await d.descargar({ ...c.ref, bytesOriginal: -0 });
      expect(r.tipo).toBe('guardada');
      if (r.tipo === 'guardada') {
        for (const k of ['bytesOriginal', 'ultimaModificacion', 'incorporada'] as const) {
          expect(Object.is(r.captura.metadatos[k], -0)).toBe(true);
        }
        expect(r.captura.original.size).toBe(0);
      }
      d.cerrar();
    } finally { c.cerrar(); }
  });
  it('copia selección y plan antes del await y captura funciones del puerto', async () => {
    const c = await contexto();
    const entrar = barrera<void>(); const liberar = barrera<void>();
    const plan = structuredClone(itinerario); const ref = structuredClone(c.ref);
    const puerto = { ...c.fotos, leerMetadatos: async (id: string) => {
      entrar.resolver(); await liberar.promesa; return c.fotos.leerMetadatos(id);
    } };
    const d = crearDescargaFotos({ plan, origen, fotos: puerto, fetch: c.enviar });
    try {
      const p = d.descargar(ref); await entrar.promesa;
      Object.assign(ref, { nombre: 'otro', fotoId: '22345678-1234-4123-8123-123456789abc' });
      Object.assign(ref.destino, { viajeId: 'otro' }); plan.dias.length = 0;
      puerto.leerOriginal = async () => { throw new Error('Puerto sustituido'); };
      liberar.resolver(); expect((await p).tipo).toBe('guardada');
      expect(c.enviar.mock.calls[0][0]).toBe(ruta);
    } finally { liberar.resolver(); d.cerrar(); c.cerrar(); }
  });
});

describe('HTTP protegido y medición real del stream', () => {
  it.each([206, 401, 303, 503])('rechaza estado %s, sin guardar ni retry', async (status) => {
    const c = await contexto();
    try {
      c.enviar.mockImplementation(async () => respuesta([0, 255, 17], { status }));
      expect((await c.descarga.descargar(c.ref)).tipo).toBe('fallida');
      expect(await c.fotos.leerMetadatos(fotoId)).toBeNull(); expect(c.enviar).toHaveBeenCalledTimes(1);
    } finally { c.cerrar(); }
  });
  it.each(['html', 'sin-no-store', 'sin-nosniff', 'publica', 'otra-ruta', 'redirect'])(
    'rechaza %s aunque tenga los mismos bytes', async (caso) => {
      const c = await contexto();
      try {
        const r = respuesta();
        if (caso === 'html') r.headers.set('Content-Type', 'text/html');
        if (caso === 'sin-no-store') r.headers.delete('Cache-Control');
        if (caso === 'sin-nosniff') r.headers.delete('X-Content-Type-Options');
        if (caso === 'publica') Object.defineProperty(r, 'url', { value: 'https://publico.example/original' });
        if (caso === 'otra-ruta') Object.defineProperty(r, 'url', { value: `${origen}/api/fotos/otra/original` });
        if (caso === 'redirect') Object.defineProperty(r, 'redirected', { value: true });
        c.enviar.mockImplementation(async () => r);
        expect((await c.descarga.descargar(c.ref)).tipo).toBe('fallida');
        expect(r.body!.locked).toBe(false); expect(await c.fotos.leerMetadatos(fotoId)).toBeNull();
      } finally { c.cerrar(); }
    });
  it('fetch global nativo exige URL no vacía; puerto inyectado acepta fixture sintética', async () => {
    const c = await contexto();
    const original = globalThis.fetch;
    try {
      globalThis.fetch = async () => respuesta();
      const d = crearDescargaFotos({ plan: itinerario, origen, fotos: c.fotos });
      expect((await d.descargar(c.ref)).tipo).toBe('fallida'); d.cerrar();
      expect((await c.descarga.descargar(c.ref)).tipo).toBe('guardada');
    } finally { globalThis.fetch = original; c.cerrar(); }
  });
  it.each([null, '0', '999999', 'basura'])('Content-Length %s nunca reemplaza el conteo', async (hint) => {
    const c = await contexto();
    try {
      c.enviar.mockImplementation(async () => {
        const r = respuesta(); if (hint !== null) r.headers.set('Content-Length', hint); return r;
      });
      const r = await c.descarga.descargar(c.ref);
      expect(r.tipo).toBe('guardada'); expect(r.bytesRecibidos).toBe(3);
    } finally { c.cerrar(); }
  });
  it.each([[0, 255], [0, 255, 17, 99]])('rechaza truncado/exceso %j sin captura ni escritura', async (...bytes) => {
    const c = await contexto();
    try {
      c.enviar.mockImplementation(async () => respuesta(bytes));
      const r = await c.descarga.descargar(c.ref);
      expect(r.tipo).toBe('fallida'); expect(r).not.toHaveProperty('captura');
      expect(await c.fotos.leerMetadatos(fotoId)).toBeNull();
    } finally { c.cerrar(); }
  });
  it('copia buffers compartidos por chunk y no usa Response.blob', async () => {
    const c = await contexto();
    try {
      let n = 0; const compartido = new Uint8Array(1);
      const stream = new ReadableStream<Uint8Array>({ pull(control) {
        if (n === 3) { control.close(); return; }
        compartido[0] = [0, 255, 17][n++]; control.enqueue(compartido);
      } }, { highWaterMark: 0 });
      const r = new Response(stream, { headers: respuesta().headers });
      const blob = vi.spyOn(r, 'blob'); c.enviar.mockImplementation(async () => r);
      expect((await c.descarga.descargar(c.ref)).tipo).toBe('guardada');
      expect([...new Uint8Array(await (await c.fotos.leerOriginal(fotoId))!.arrayBuffer())]).toEqual([0, 255, 17]);
      expect(blob).not.toHaveBeenCalled(); expect(stream.locked).toBe(false);
    } finally { c.cerrar(); }
  });
  it('exceso cancela en primer chunk sin consumir el siguiente', async () => {
    const c = await contexto();
    try {
      let pulls = 0; let cancelada = false;
      const stream = new ReadableStream<Uint8Array>({ pull(control) {
        pulls++; control.enqueue(new Uint8Array([0, 255, 17, 99]));
      }, cancel() { cancelada = true; } }, { highWaterMark: 0 });
      c.enviar.mockImplementation(async () => new Response(stream, { headers: respuesta().headers }));
      const r = await c.descarga.descargar(c.ref);
      expect(r.tipo).toBe('fallida'); expect(r.bytesRecibidos).toBe(4);
      expect(pulls).toBe(1); expect(cancelada).toBe(true); expect(stream.locked).toBe(false);
    } finally { c.cerrar(); }
  });
  it('error de red no dispara retry ni conserva captura ficticia', async () => {
    const c = await contexto();
    try {
      c.enviar.mockRejectedValue(new Error('offline'));
      const r = await c.descarga.descargar(c.ref);
      expect(r).toMatchObject({ tipo: 'fallida', bytesRecibidos: 0 }); expect(r).not.toHaveProperty('captura');
      expect(c.enviar).toHaveBeenCalledTimes(1);
    } finally { c.cerrar(); }
  });
});

describe('atestación completa, TX y recuperación manual', () => {
  it('original existente exacto requiere GET pero conserva miniatura sin guardar de nuevo', async () => {
    const c = await contexto();
    try {
      await c.fotos.guardarOriginal(c.a);
      await c.fotos.guardarMiniatura(fotoId, new Blob([new Uint8Array([9])], { type: 'image/png' }), 1, 1);
      const guardar = vi.fn(c.fotos.guardarOriginal);
      const d = crearDescargaFotos({ plan: itinerario, origen, fotos: { ...c.fotos, guardarOriginal: guardar }, fetch: c.enviar });
      const r = await d.descargar(c.ref);
      expect(r.tipo).toBe('guardada'); expect(guardar).not.toHaveBeenCalled();
      expect(c.enviar).toHaveBeenCalledTimes(1);
      expect(await c.fotos.leerMiniatura(fotoId)).not.toBeNull();
      if (r.tipo === 'guardada') expect(r.captura.metadatos.miniatura.tipo).toBe('lista');
      d.cerrar();
    } finally { c.cerrar(); }
  });
  it('metadata igual y último byte distinto nunca confirman candidato B como A', async () => {
    const c = await contexto();
    try {
      await c.fotos.guardarOriginal(c.a); c.enviar.mockImplementation(async () => respuesta([0, 255, 18]));
      const r = await c.descarga.descargar(c.ref);
      expect(r.tipo).toBe('fallida');
      if (r.tipo === 'fallida') expect([...new Uint8Array(await r.captura!.original.arrayBuffer())]).toEqual([0, 255, 18]);
      expect([...new Uint8Array(await (await c.fotos.leerOriginal(fotoId))!.arrayBuffer())]).toEqual([0, 255, 17]);
    } finally { c.cerrar(); }
  });
  it.each(['otra', 'borrada', 'exacta'] as const)('segunda conexión escribe %s entre GET y guardado', async (caso) => {
    const c = await contexto();
    const otra = await abrirFotosLocal(itinerario, { fabrica: c.fabrica });
    try {
      c.enviar.mockImplementation(async () => {
        await otra.guardarOriginal(caso === 'otra' ? captura([0, 255, 18]) : c.a);
        if (caso === 'borrada') await otra.borrarLocal(fotoId);
        return respuesta();
      });
      expect((await c.descarga.descargar(c.ref)).tipo).toBe(caso === 'exacta' ? 'guardada' : 'fallida');
      if (caso === 'borrada') expect(await otra.leerMetadatos(fotoId)).toMatchObject({ tipo: 'borrada' });
      if (caso === 'otra') expect([...new Uint8Array(await (await otra.leerOriginal(fotoId))!.arrayBuffer())]).toEqual([0, 255, 18]);
    } finally { otra.cerrar(); c.cerrar(); }
  });
  it.each(['exacta', 'otra', 'quota', 'falsa-respuesta'] as const)(
    'guardado %s exige comprobación fresca de bytes completos', async (caso) => {
      const c = await contexto();
      const otra = await abrirFotosLocal(itinerario, { fabrica: c.fabrica });
      const guardar = async (a: CapturaFoto) => {
        if (caso === 'quota') throw new DOMException('quota', 'QuotaExceededError');
        if (caso === 'falsa-respuesta') return { tipo: 'guardada' as const, metadatos: a.metadatos };
        await otra.guardarOriginal(caso === 'exacta' ? a : captura([0, 255, 18]));
        throw new Error('Respuesta perdida/Constraint');
      };
      const d = crearDescargaFotos({ plan: itinerario, origen, fotos: { ...c.fotos, guardarOriginal: guardar }, fetch: c.enviar });
      try {
        const r = await d.descargar(c.ref);
        expect(r.tipo).toBe(caso === 'exacta' ? 'guardada' : 'fallida');
        if (r.tipo === 'fallida') {
          expect(r.captura).toBeDefined(); expect(r.bytesRecibidos).toBe(3);
          expect([...new Uint8Array(await r.captura!.original.arrayBuffer())]).toEqual([0, 255, 17]);
        }
        if (caso === 'quota' || caso === 'falsa-respuesta') expect(await otra.leerMetadatos(fotoId)).toBeNull();
      } finally { d.cerrar(); otra.cerrar(); c.cerrar(); }
    });
  it('no confirma antes de TX.oncomplete y cancelación no promete rollback de escritura iniciada', async () => {
    const c = await contexto(); const entrar = barrera<void>(); const liberar = barrera<void>();
    const d = crearDescargaFotos({ plan: itinerario, origen, fotos: { ...c.fotos,
      guardarOriginal: async (a) => { entrar.resolver(); await liberar.promesa; return c.fotos.guardarOriginal(a); },
    }, fetch: c.enviar });
    try {
      let termino = false;
      const p = d.descargar(c.ref).then((r) => { termino = true; return r; });
      await entrar.promesa; expect(termino).toBe(false); d.cancelar(); liberar.resolver();
      const r = await p; expect(r.tipo).toBe('detenida'); expect(r).not.toHaveProperty('captura');
      expect(await c.fotos.leerOriginal(fotoId)).not.toBeNull();
    } finally { liberar.resolver(); d.cerrar(); c.cerrar(); }
  });
  it('MIME no representable por Blob queda raw en recuperación, nunca falsea confirmación', async () => {
    const c = await contexto();
    try {
      const r = await c.descarga.descargar({ ...c.ref, mimeDeclarado: 'IMAGE/HeIC' });
      expect(r.tipo).toBe('fallida');
      if (r.tipo === 'fallida') expect(r.captura!.metadatos.mimeDeclarado).toBe('IMAGE/HeIC');
      expect(await c.fotos.leerMetadatos(fotoId)).toBeNull();
    } finally { c.cerrar(); }
  });
});

describe('todos los campos originales y metadata final fresca', () => {
  it.each(['fotoId', 'nombre', 'mimeDeclarado', 'ultimaModificacion', 'incorporada', 'bytesOriginal', 'destino'] as const)(
    'estado fresco distinto en %s no se confunde por tamaño', async (campo) => {
      const c = await contexto();
      try {
        const m = structuredClone(c.a.metadatos);
        if (campo === 'fotoId') Object.assign(m, { fotoId: '22345678-1234-4123-8123-123456789abc' });
        if (campo === 'nombre') Object.assign(m, { nombre: '\0 é ' });
        if (campo === 'mimeDeclarado') Object.assign(m, { mimeDeclarado: 'image/png' });
        if (campo === 'ultimaModificacion' || campo === 'incorporada') Object.assign(m, { [campo]: 0 });
        if (campo === 'bytesOriginal') Object.assign(m, { bytesOriginal: 4 });
        if (campo === 'destino') Object.assign(m.destino, { paradaId: itinerario.dias[0].paradas[1].id });
        const d = crearDescargaFotos({ plan: itinerario, origen, fotos: { ...c.fotos, leerMetadatos: async () => m }, fetch: c.enviar });
        expect((await d.descargar(c.ref)).tipo).toBe('fallida');
        expect(c.enviar).not.toHaveBeenCalled(); d.cerrar();
      } finally { c.cerrar(); }
    });
  it('metadata -0 frente a +0 en tamaño vacío sigue siendo otra identidad', async () => {
    const c = await contexto();
    try {
      await c.fotos.guardarOriginal(captura([]));
      c.enviar.mockImplementation(async () => respuesta([]));
      const r = await c.descarga.descargar({ ...c.ref, bytesOriginal: -0 });
      expect(r.tipo).toBe('fallida'); expect(c.enviar).not.toHaveBeenCalled();
    } finally { c.cerrar(); }
  });
  it('tombstone en metadata final del helper rechaza atestación sin resucitar', async () => {
    const c = await contexto();
    const otra = await abrirFotosLocal(itinerario, { fabrica: c.fabrica });
    let lecturas = 0;
    const d = crearDescargaFotos({ plan: itinerario, origen, fotos: { ...c.fotos,
      leerMetadatos: async (id) => {
        lecturas++; if (lecturas === 5) await otra.borrarLocal(id);
        return c.fotos.leerMetadatos(id);
      },
    }, fetch: c.enviar });
    try {
      await c.fotos.guardarOriginal(c.a);
      expect((await d.descargar(c.ref)).tipo).toBe('fallida'); expect(lecturas).toBe(5);
      expect(await otra.leerMetadatos(fotoId)).toMatchObject({ tipo: 'borrada' });
    } finally { d.cerrar(); otra.cerrar(); c.cerrar(); }
  });
  it('fallo abortado de escritura conserva candidato solamente en resultado del llamador', async () => {
    const c = await contexto();
    const d = crearDescargaFotos({ plan: itinerario, origen, fotos: { ...c.fotos,
      guardarOriginal: async () => { throw new DOMException('TX abortada', 'AbortError'); },
    }, fetch: c.enviar });
    try {
      const r = await d.descargar(c.ref);
      expect(r.tipo).toBe('fallida'); expect(r).toHaveProperty('captura');
      const reabierta = await abrirFotosLocal(itinerario, { fabrica: c.fabrica });
      expect(await reabierta.leerMetadatos(fotoId)).toBeNull(); reabierta.cerrar();
    } finally { d.cerrar(); c.cerrar(); }
  });
});

describe('ownership, cancelación y cierre', () => {
  it('excluye antes del await y cancelando metadata no inicia HTTP ni cierra puerto', async () => {
    const c = await contexto(); const entrar = barrera<void>(); const liberar = barrera<void>();
    const d = crearDescargaFotos({ plan: itinerario, origen, fotos: { ...c.fotos,
      leerMetadatos: async (id) => { entrar.resolver(); await liberar.promesa; return c.fotos.leerMetadatos(id); },
    }, fetch: c.enviar });
    try {
      const p = d.descargar(c.ref);
      expect((await d.descargar(c.ref)).tipo).toBe('fallida'); await entrar.promesa;
      d.cancelar(); liberar.resolver(); expect((await p).tipo).toBe('detenida');
      expect(c.enviar).not.toHaveBeenCalled(); d.cerrar();
      expect((await d.descargar(c.ref)).tipo).toBe('detenida');
      expect(await c.fotos.leerMetadatos(fotoId)).toBeNull();
    } finally { liberar.resolver(); d.cerrar(); c.cerrar(); }
  });
  it('cancela chunk pendiente, libera reader y retry solo por nueva acción explícita', async () => {
    const c = await contexto(); const entrar = barrera<void>();
    let cancelada = false;
    const stream = new ReadableStream<Uint8Array>({ pull(control) {
      control.enqueue(new Uint8Array([0])); entrar.resolver(); return new Promise<void>(() => {});
    }, cancel() { cancelada = true; } }, { highWaterMark: 0 });
    try {
      c.enviar.mockImplementationOnce(async () => new Response(stream, { headers: respuesta().headers }));
      const p = c.descarga.descargar(c.ref); await entrar.promesa; c.descarga.cancelar();
      const r = await p; expect(r.tipo).toBe('detenida'); expect(r).not.toHaveProperty('captura');
      expect(cancelada).toBe(true); expect(stream.locked).toBe(false);
      expect(await c.fotos.leerMetadatos(fotoId)).toBeNull(); expect(c.enviar).toHaveBeenCalledTimes(1);
      expect((await c.descarga.descargar(c.ref)).tipo).toBe('guardada'); expect(c.enviar).toHaveBeenCalledTimes(2);
    } finally { c.cerrar(); }
  });
  it('respuesta tardía A abortada se cancela y no libera ownership prematuramente para B', async () => {
    const c = await contexto(); const entrar = barrera<void>(); const liberar = barrera<Response>();
    try {
      c.enviar.mockImplementationOnce(async () => { entrar.resolver(); return liberar.promesa; });
      const p = c.descarga.descargar(c.ref); await entrar.promesa; c.descarga.cancelar();
      expect((await c.descarga.descargar(c.ref)).tipo).toBe('fallida');
      const r = respuesta(); liberar.resolver(r);
      expect((await p).tipo).toBe('detenida'); expect(r.body!.locked).toBe(false);
      expect(await c.fotos.leerMetadatos(fotoId)).toBeNull();
      expect((await c.descarga.descargar(c.ref)).tipo).toBe('guardada');
    } finally { liberar.resolver(respuesta()); c.cerrar(); }
  });
});

// ---------- Recepción a memoria para ver una foto compartida (FO3): el mismo GET protegido, sin PhotoDB ----------

describe('recepción protegida a memoria, sin PhotoDB', () => {
  it('RC1 · el mismo GET protegido que la descarga, bytes exactos en un Blob y ninguna escritura local', async () => {
    const c = await contexto();
    try {
      const leer = vi.spyOn(c.fotos, 'leerMetadatos'); const guardar = vi.spyOn(c.fotos, 'guardarOriginal');
      const r = crearRecepcionOriginal({ plan: itinerario, origen, fetch: c.enviar });
      expect(c.enviar).not.toHaveBeenCalled();
      const recibido = await r.recibir(c.ref);
      expect(recibido.tipo).toBe('recibido');
      if (recibido.tipo !== 'recibido') return;
      expect([...new Uint8Array(await recibido.original.arrayBuffer())]).toEqual([0, 255, 17]);
      expect(recibido.bytesRecibidos).toBe(3);
      expect(c.enviar).toHaveBeenCalledWith(ruta, expect.objectContaining({ method: 'GET',
        credentials: 'same-origin', cache: 'no-store', redirect: 'error' }));
      expect([...new Headers(c.enviar.mock.calls[0][1]!.headers)]).toEqual([['accept', 'application/octet-stream']]);
      // Ver no toca PhotoDB: ni lecturas ni escrituras, y nada queda guardado.
      expect(leer).not.toHaveBeenCalled(); expect(guardar).not.toHaveBeenCalled();
      expect(await c.fotos.listar()).toEqual([]);
      expect((await c.fabrica.databases()).map((b) => b.name)).toHaveLength(1);
    } finally { c.cerrar(); }
  });
  it('RC2 · 401 del endpoint exacto es «sin sesión»; un 401 de una URL ajena, otros estados o el contrato roto no lo son', async () => {
    const c = await contexto();
    try {
      const casos: [Response, string][] = [
        [new Response('', { status: 401 }), 'sin-sesion'],
        [respuesta([0, 255, 17], { status: 503 }), 'respuesta'],
        [respuesta([0, 255, 17], { headers: { 'Content-Type': 'image/png', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' } }), 'respuesta'],
        [respuesta([0, 255, 17, 9]), 'respuesta'],
        [respuesta([0, 255]), 'respuesta'],
      ];
      for (const [res, motivo] of casos) {
        const r = crearRecepcionOriginal({ plan: itinerario, origen, fetch: async () => res });
        expect(await r.recibir(c.ref), motivo).toMatchObject({ tipo: 'fallida', motivo });
      }
      const ajena = new Response('', { status: 401 });
      Object.defineProperty(ajena, 'url', { value: 'https://otro.example/api/fotos/x/original' });
      expect(await crearRecepcionOriginal({ plan: itinerario, origen, fetch: async () => ajena }).recibir(c.ref))
        .toMatchObject({ tipo: 'fallida', motivo: 'respuesta' });
      expect(await crearRecepcionOriginal({ plan: itinerario, origen, fetch: async () => { throw new TypeError('red'); } })
        .recibir(c.ref)).toMatchObject({ tipo: 'fallida', motivo: 'red' });
    } finally { c.cerrar(); }
  });
  it('RC3 · límite de la composición e identidad inválida se rechazan sin red', async () => {
    const c = await contexto();
    try {
      const r = crearRecepcionOriginal({ plan: itinerario, origen, fetch: c.enviar, maxBytesOriginal: 2 });
      expect(await r.recibir(c.ref)).toEqual({ tipo: 'fallida', motivo: 'limite', bytesRecibidos: 0 });
      expect(await r.recibir({ ...c.ref, fotoId: '../imagen' })).toEqual({ tipo: 'fallida', motivo: 'identidad', bytesRecibidos: 0 });
      expect(await r.recibir({ ...c.ref, destino: { ...c.ref.destino, viajeId: 'ajeno' } }))
        .toMatchObject({ tipo: 'fallida', motivo: 'identidad' });
      expect(c.enviar).not.toHaveBeenCalled();
      expect(() => crearRecepcionOriginal({ plan: itinerario, origen: `${origen}/` })).toThrow();
      expect(() => crearRecepcionOriginal({ plan: itinerario, origen, fotos: c.fotos } as never)).toThrow();
    } finally { c.cerrar(); }
  });
  it('RC4 · la señal corta el lector a mitad y devuelve «detenida»; cerrar aborta todas las recepciones en curso', async () => {
    const c = await contexto();
    try {
      let cancelado = 0;
      const lento = () => new Response(new ReadableStream<Uint8Array>({
        start(control) { control.enqueue(new Uint8Array([0])); },
        cancel() { cancelado++; },
      }), { status: 200, headers: { 'Content-Type': 'application/octet-stream', 'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff' } });
      const r = crearRecepcionOriginal({ plan: itinerario, origen, fetch: async () => lento() });
      const control = new AbortController();
      const una = r.recibir(c.ref, control.signal);
      await new Promise((ok) => setTimeout(ok, 5));
      control.abort();
      expect(await una).toMatchObject({ tipo: 'detenida' });
      expect(cancelado).toBe(1);
      const otra = r.recibir(c.ref);
      await new Promise((ok) => setTimeout(ok, 5));
      r.cerrar();
      expect(await otra).toMatchObject({ tipo: 'detenida' });
      expect(cancelado).toBe(2);
      expect(await r.recibir(c.ref)).toEqual({ tipo: 'detenida', bytesRecibidos: 0 });
      const yaCortada = new AbortController(); yaCortada.abort();
      expect(await crearRecepcionOriginal({ plan: itinerario, origen, fetch: c.enviar }).recibir(c.ref, yaCortada.signal))
        .toEqual({ tipo: 'detenida', bytesRecibidos: 0 });
    } finally { c.cerrar(); }
  });
});

// ---------- Correcciones FO3: la sesión perdida llega tipada a quien guarda ----------

describe('descarga duradera: sesión tipada', () => {
  it('DX1 · un 401 del endpoint exacto falla con causa «sin-sesion» tipada y no escribe nada; otros fallos no la llevan', async () => {
    const c = await contexto();
    try {
      c.enviar.mockImplementation(async () => new Response('', { status: 401 }));
      const r = await c.descarga.descargar(c.ref);
      expect(r).toMatchObject({ tipo: 'fallida', causa: 'sin-sesion' });
      expect(await c.fotos.leerMetadatos(fotoId)).toBeNull();
      c.enviar.mockImplementation(async () => respuesta([0, 255, 17], { status: 503 }));
      const otro = await c.descarga.descargar(c.ref);
      expect(otro.tipo).toBe('fallida');
      expect(otro).not.toHaveProperty('causa');
    } finally { c.cerrar(); }
  });
});

describe('plazo finito de la recepción', () => {
  const lentoCon = (cancelados: string[]) => async () => new Response(new ReadableStream<Uint8Array>({
    start(control) { control.enqueue(new Uint8Array([0])); },
    cancel() { cancelados.push('cancelado'); },
  }), { status: 200, headers: { 'Content-Type': 'application/octet-stream', 'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff' } });
  it('DX2 · descarga duradera: si el original no termina de llegar, al vencer el plazo falla con causa «plazo» y no escribe nada', async () => {
    const c = await contexto();
    try {
      const cancelados: string[] = [];
      const d = crearDescargaFotos({ plan: itinerario, origen, fotos: c.fotos, fetch: lentoCon(cancelados), plazoMs: 30 });
      const r = await d.descargar(c.ref);
      expect(r).toMatchObject({ tipo: 'fallida', causa: 'plazo' });
      expect(r).not.toHaveProperty('captura');
      expect(cancelados).toEqual(['cancelado']);
      expect(await c.fotos.leerMetadatos(fotoId)).toBeNull();
      expect(() => crearDescargaFotos({ plan: itinerario, origen, fotos: c.fotos, plazoMs: 0 })).toThrow();
      d.cerrar();
    } finally { c.cerrar(); }
  });
  it('RC5 · recepción a memoria: al vencer el plazo se cancela el lector y falla con «plazo»; sin plazo no hay temporizador', async () => {
    const c = await contexto();
    try {
      const cancelados: string[] = [];
      const r = crearRecepcionOriginal({ plan: itinerario, origen, fetch: lentoCon(cancelados), plazoMs: 30 });
      expect(await r.recibir(c.ref)).toMatchObject({ tipo: 'fallida', motivo: 'plazo' });
      expect(cancelados).toEqual(['cancelado']);
      expect(() => crearRecepcionOriginal({ plan: itinerario, origen, plazoMs: 1.5 })).toThrow();
      // Un plazo amplio no interfiere con una entrega normal.
      const normal = crearRecepcionOriginal({ plan: itinerario, origen, fetch: c.enviar, plazoMs: 5_000 });
      expect((await normal.recibir(c.ref)).tipo).toBe('recibido');
    } finally { c.cerrar(); }
  });
});
