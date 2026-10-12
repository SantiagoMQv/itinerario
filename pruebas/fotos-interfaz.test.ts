// Controlador de fotos de la interfaz, sin DOM. IndexedDB SIMULADA (fake-indexeddb) con la biblioteca real de
// T5A; decoder y lienzo inyectados (Node no decodifica imágenes); inspector de cabeceras real; URLs contadas.
import { IDBFactory } from 'fake-indexeddb';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { itinerario } from '../src/datos/itinerario';
import { abrirFotosLocal, type FotosLocal } from '../src/fotos-local';
import { crearMiniatura, type ImagenDecodificada } from '../src/fotos-imagen';
import { crearCapturaFoto, esFotoBorrada, type DestinoFoto } from '../src/fotos';
import { TROZO_IDENTIDAD, claveDestino, crearFotosInterfaz, destinoDeClave, type FotosInterfaz } from '../src/fotos-interfaz';

const PARADA = 'c80e3471f9ab562d';
const SUB = 'eb6438fa172dc905';
const parada: DestinoFoto = { tipo: 'parada', viajeId: itinerario.id, paradaId: PARADA };
const sub: DestinoFoto = { tipo: 'subparada', viajeId: itinerario.id, paradaId: PARADA, subparadaId: SUB };
const otra: DestinoFoto = { tipo: 'parada', viajeId: itinerario.id, paradaId: itinerario.dias[0].paradas[0].id };

/** Cabecera PNG genuina (firma + IHDR); el decoder es inyectado, así que no hace falta IDAT. */
function png(ancho = 40, alto = 30): Uint8Array<ArrayBuffer> {
  const b = new Uint8Array(45);
  b.set([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82]);
  new DataView(b.buffer).setUint32(16, ancho); new DataView(b.buffer).setUint32(20, alto);
  b[24] = 8; b[25] = 6;
  return b;
}
const archivo = (nombre = 'a.png', bytes: Uint8Array<ArrayBuffer> = png(), tipo = 'image/png') => new File([bytes], nombre, { type: tipo, lastModified: 7 });

const cierres: (() => void)[] = [];
afterEach(() => { cierres.splice(0).forEach((c) => c()); vi.restoreAllMocks(); });

interface Opciones { fabrica?: IDBFactory; fallarApertura?: number; ahora?: () => number; uuid?: () => string; envolver?: (l: FotosLocal) => FotosLocal; decodificar?: (b: Blob) => Promise<ImagenDecodificada> }
function montar(opciones: Opciones = {}) {
  const fabrica = opciones.fabrica ?? new IDBFactory();
  let fallos = opciones.fallarApertura ?? 0;
  const lecturas = { originales: 0, miniaturas: 0 };
  const decodes = { activos: 0, maximo: 0, total: 0 };
  const urls = new Map<string, Blob>(); let n = 0;
  const cambios: (string | null)[] = [];
  let id = 0;
  const abrir = async () => {
    if (fallos-- > 0) throw new DOMException('Fallo inyectado', 'UnknownError');
    const real = await abrirFotosLocal(itinerario, { fabrica, nombre: 'fotos-interfaz' });
    const local: FotosLocal = { ...real,
      leerOriginal: (i) => { lecturas.originales++; return real.leerOriginal(i); },
      leerMiniatura: (i) => { lecturas.miniaturas++; return real.leerMiniatura(i); } };
    return opciones.envolver ? opciones.envolver(local) : local;
  };
  const decodificar = opciones.decodificar ?? (async (b: Blob) => {
    decodes.total++; decodes.activos++; decodes.maximo = Math.max(decodes.maximo, decodes.activos);
    await new Promise((ok) => setTimeout(ok, 2));
    decodes.activos--;
    const v = new DataView(await b.slice(16, 24).arrayBuffer());
    return { ancho: v.getUint32(0), alto: v.getUint32(4), fuente: {} as CanvasImageSource, cerrar: () => {} };
  });
  const interfaz = crearFotosInterfaz({ plan: itinerario, abrir,
    crearMotor: () => crearMiniatura({ decodificar, crearLienzo: (ancho, alto) => ({ dibujar: () => {},
      png: async () => new Blob([png(ancho, alto)], { type: 'image/png' }), liberar: () => {} }) }),
    crearUrl: (b) => { const u = `blob:prueba/${++n}`; urls.set(u, b); return u; },
    revocarUrl: (u) => { urls.delete(u); },
    ahora: opciones.ahora ?? (() => 1000), uuid: opciones.uuid ?? (() => `00000000-0000-4000-8000-${String(++id).padStart(12, '0')}`),
    alCambiar: (c) => cambios.push(c) });
  cierres.push(() => interfaz.cerrar());
  return { interfaz, fabrica, lecturas, decodes, urls, cambios };
}
const esperar = (_f: FotosInterfaz, condicion: () => boolean) => vi.waitFor(() => { if (!condicion()) throw new Error('aún no'); }, { timeout: 2000 });

describe('claves de destino', () => {
  it('usan IDs persistentes y solo admiten destinos del plan', () => {
    expect(claveDestino(parada)).toBe(`p:${PARADA}`);
    expect(claveDestino(sub)).toBe(`s:${PARADA}:${SUB}`);
    expect(destinoDeClave(itinerario, `s:${PARADA}:${SUB}`)).toEqual(sub);
    expect(destinoDeClave(itinerario, `s:${otra.paradaId}:${SUB}`)).toBeNull();
    expect(destinoDeClave(itinerario, 'p:inventada')).toBeNull();
  });
});

describe('apertura y lectura perezosa', () => {
  it('al reabrir la misma base solo se lista metadata: cuentas por destino sin leer blobs', async () => {
    const a = montar();
    await a.interfaz.abrir();
    await a.interfaz.guardar(parada, archivo('uno.png'));
    await a.interfaz.guardar(otra, archivo('otra.png'));
    a.interfaz.cerrar();
    const b = montar({ fabrica: a.fabrica });
    await b.interfaz.abrir();
    expect([b.interfaz.cuenta(parada), b.interfaz.cuenta(otra), b.interfaz.cuenta(sub)]).toEqual([1, 1, 0]);
    expect(b.interfaz.entradas(parada).map((e) => e.nombre)).toEqual(['uno.png']);
    expect(b.lecturas).toEqual({ originales: 0, miniaturas: 0 });
  });

  it('cuenta por destino, sin decodificar ni leer blobs al abrir; la visita genera en serie una sola vez', async () => {
    const { interfaz, lecturas, decodes } = montar();
    await interfaz.abrir();
    for (const n of ['a', 'b', 'c']) expect((await interfaz.guardar(parada, archivo(`${n}.png`))).tipo).toBe('guardada');
    await interfaz.guardar(sub, archivo('sub.png'));
    expect(interfaz.cuenta(parada)).toBe(3);
    expect(interfaz.cuenta(sub)).toBe(1);
    expect(decodes.total).toBe(0);
    expect(lecturas).toEqual({ originales: 0, miniaturas: 0 });
    interfaz.abrirVisita(parada);
    await esperar(interfaz, () => interfaz.entradas(parada).every((e) => e.estado === 'guardada' && e.url));
    expect(decodes).toMatchObject({ total: 3, maximo: 1 });
    expect(lecturas.originales).toBe(3);
    expect(interfaz.entradas(sub)[0].estado).toBe('vista-pendiente');
    interfaz.cerrarVisita(parada);
    interfaz.abrirVisita(parada);
    await esperar(interfaz, () => interfaz.entradas(parada).every((e) => e.url));
    expect(decodes.total).toBe(3);
    expect(lecturas.miniaturas).toBe(3);
  });

  it('al reabrir se enseñan por fecha de captura, no por el orden de sus IDs en la base', async () => {
    const ids = ['00000000-0000-4000-8000-00000000000b', '00000000-0000-4000-8000-00000000000a'];
    let t = 0;
    const a = montar({ uuid: () => ids.shift()!, ahora: () => ++t });
    await a.interfaz.abrir();
    await a.interfaz.guardar(parada, archivo('primera.png'));
    await a.interfaz.guardar(parada, archivo('segunda.png'));
    a.interfaz.cerrar();
    const b = montar({ fabrica: a.fabrica });
    await b.interfaz.abrir();
    expect(b.interfaz.entradas(parada).map((e) => e.nombre)).toEqual(['primera.png', 'segunda.png']);
  });

  it('un fallo al abrir se ve y se reintenta en la misma visita, sin candado', async () => {
    const { interfaz } = montar({ fallarApertura: 1 });
    await interfaz.abrir();
    expect(interfaz.fase).toBe('fallo');
    expect(interfaz.error).toMatch(/No se pudieron abrir las fotos/);
    expect(await interfaz.guardar(parada, archivo())).toEqual({ tipo: 'no-lista' });
    await interfaz.abrir();
    expect(interfaz.fase).toBe('lista');
    expect((await interfaz.guardar(parada, archivo())).tipo).toBe('guardada');
  });
});

describe('guardar sin optimismo ni IDs nuevos', () => {
  it('un intento es una captura; el mismo archivo elegido dos veces son dos fotos', async () => {
    const { interfaz } = montar();
    await interfaz.abrir();
    const f = archivo('misma.png');
    const a = await interfaz.guardar(parada, f);
    const b = await interfaz.guardar(parada, f);
    expect(a.tipo).toBe('guardada'); expect(b.tipo).toBe('guardada');
    expect(a.tipo === 'guardada' && b.tipo === 'guardada' && a.fotoId !== b.fotoId).toBe(true);
  });

  it('si el original falla no se da por guardada; Reintentar usa la MISMA identidad', async () => {
    let fallar = true;
    const { interfaz } = montar({ envolver: (l) => ({ ...l, guardarOriginal: (c) => fallar
      ? Promise.reject(new DOMException('Cuota', 'QuotaExceededError')) : l.guardarOriginal(c) }) });
    await interfaz.abrir();
    const r = await interfaz.guardar(parada, archivo('cuota.png'));
    expect(r.tipo).toBe('no-guardada');
    expect(interfaz.cuenta(parada)).toBe(0);
    const [entrada] = interfaz.entradas(parada);
    expect(entrada).toMatchObject({ estado: 'no-guardada', nombre: 'cuota.png' });
    fallar = false;
    const reintento = await interfaz.reintentarGuardar(entrada.fotoId);
    expect(reintento).toEqual({ tipo: 'guardada', fotoId: entrada.fotoId });
    expect(interfaz.cuenta(parada)).toBe(1);
    expect(interfaz.entradas(parada).map((e) => e.fotoId)).toEqual([entrada.fotoId]);
  });

  it('respuesta perdida tras guardar: se comprueba antes de afirmar y no se duplica', async () => {
    const { interfaz } = montar({ envolver: (l) => ({ ...l, guardarOriginal: async (c) => {
      await l.guardarOriginal(c); throw new DOMException('Respuesta perdida', 'AbortError');
    } }) });
    await interfaz.abrir();
    const r = await interfaz.guardar(parada, archivo('perdida.png'));
    expect(r.tipo).toBe('guardada');
    expect(interfaz.cuenta(parada)).toBe(1);
    expect(interfaz.entradas(parada)).toHaveLength(1);
  });

  it('si ni siquiera se puede comprobar, queda incierta con su captura para reintentar', async () => {
    let roto = true;
    const { interfaz } = montar({ envolver: (l) => ({ ...l,
      guardarOriginal: (c) => roto ? Promise.reject(new Error('x')) : l.guardarOriginal(c),
      leerMetadatos: (i) => roto ? Promise.reject(new Error('y')) : l.leerMetadatos(i) }) });
    await interfaz.abrir();
    expect((await interfaz.guardar(parada, archivo())).tipo).toBe('incierta');
    roto = false;
    const [e] = interfaz.entradas(parada);
    expect((await interfaz.reintentarGuardar(e.fotoId)).tipo).toBe('guardada');
    expect(interfaz.entradas(parada)).toHaveLength(1);
  });
});

describe('vistas previas', () => {
  it('fallida se anota y no se reintenta sola; Reintentar vista previa es explícito', async () => {
    let romper = true;
    const { interfaz, decodes } = montar({ decodificar: async (b) => {
      decodes.total++;
      if (romper) throw new DOMException('decode', 'EncodingError');
      const v = new DataView(await b.slice(16, 24).arrayBuffer());
      return { ancho: v.getUint32(0), alto: v.getUint32(4), fuente: {} as CanvasImageSource, cerrar: () => {} };
    } });
    await interfaz.abrir();
    await interfaz.guardar(parada, archivo());
    interfaz.abrirVisita(parada);
    await esperar(interfaz, () => interfaz.entradas(parada)[0].estado === 'sin-vista');
    interfaz.cerrarVisita(parada); interfaz.abrirVisita(parada);
    await new Promise((ok) => setTimeout(ok, 20));
    expect(decodes.total).toBe(1);
    romper = false;
    await interfaz.reintentarVista(interfaz.entradas(parada)[0].fotoId);
    await esperar(interfaz, () => interfaz.entradas(parada)[0].estado === 'guardada');
    expect(decodes.total).toBe(2);
  });

  it('si tampoco se puede anotar el fallo, queda pendiente durable y avisa solo en esta sesión', async () => {
    const { interfaz, decodes } = montar({
      decodificar: async () => { decodes.total++; throw new DOMException('decode', 'EncodingError'); },
      envolver: (l) => ({ ...l, registrarFalloMiniatura: () => Promise.reject(new DOMException('Cuota', 'QuotaExceededError')) }) });
    await interfaz.abrir();
    const r = await interfaz.guardar(parada, archivo());
    interfaz.abrirVisita(parada);
    await esperar(interfaz, () => interfaz.entradas(parada)[0].estado === 'vista-sin-anotar');
    interfaz.cerrarVisita(parada); interfaz.abrirVisita(parada);
    await new Promise((ok) => setTimeout(ok, 20));
    expect(decodes.total).toBe(1);
    expect(r.tipo === 'guardada' && interfaz.entradas(parada)[0].fotoId === r.fotoId).toBe(true);
  });

  it('original >32 MP: sin decoder ni vista previa, el original sigue guardado', async () => {
    const { interfaz, decodes } = montar();
    await interfaz.abrir();
    await interfaz.guardar(parada, archivo('enorme.png', png(6000, 6000)));
    interfaz.abrirVisita(parada);
    await esperar(interfaz, () => interfaz.entradas(parada)[0].estado === 'sin-vista');
    expect(decodes.total).toBe(0);
    expect(interfaz.cuenta(parada)).toBe(1);
  });
});

describe('URLs, visitas y borrado', () => {
  it('cerrar la visita revoca sus URLs y una generación vieja no crea URL en la visita nueva', async () => {
    let soltar!: () => void;
    const puerta = new Promise<void>((ok) => { soltar = ok; });
    const { interfaz, urls } = montar({ decodificar: async (b) => {
      await puerta;
      const v = new DataView(await b.slice(16, 24).arrayBuffer());
      return { ancho: v.getUint32(0), alto: v.getUint32(4), fuente: {} as CanvasImageSource, cerrar: () => {} };
    } });
    await interfaz.abrir();
    await interfaz.guardar(parada, archivo());
    interfaz.abrirVisita(parada);
    interfaz.cerrarVisita(parada);
    interfaz.abrirVisita(otra);
    soltar();
    await new Promise((ok) => setTimeout(ok, 30));
    expect(urls.size).toBe(0);
    expect(interfaz.urlsVivas()).toBe(0);
    interfaz.abrirVisita(parada);
    await esperar(interfaz, () => !!interfaz.entradas(parada)[0].url);
    expect(urls.size).toBe(1);
    interfaz.cerrarVisita(parada);
    expect(urls.size).toBe(0);
  });

  it('borrar durante la generación no resucita la miniatura y libera URLs; un segundo borrado espera', async () => {
    let soltar!: () => void;
    const puerta = new Promise<void>((ok) => { soltar = ok; });
    const { interfaz, urls } = montar({ decodificar: async (b) => {
      await puerta;
      const v = new DataView(await b.slice(16, 24).arrayBuffer());
      return { ancho: v.getUint32(0), alto: v.getUint32(4), fuente: {} as CanvasImageSource, cerrar: () => {} };
    } });
    await interfaz.abrir();
    const r = await interfaz.guardar(parada, archivo());
    if (r.tipo !== 'guardada') throw new Error('no guardada');
    interfaz.abrirVisita(parada);
    const [primero, segundo] = await Promise.all([interfaz.borrar(r.fotoId), interfaz.borrar(r.fotoId)]);
    expect(primero).toBe('borrada'); expect(segundo).toBe('ocupada');
    soltar();
    await new Promise((ok) => setTimeout(ok, 30));
    expect(interfaz.entradas(parada)).toEqual([]);
    expect(interfaz.cuenta(parada)).toBe(0);
    expect(urls.size).toBe(0);
  });

  it('un borrado que falla no hace desaparecer la foto', async () => {
    const { interfaz } = montar({ envolver: (l) => ({ ...l, borrarLocal: () => Promise.reject(new Error('IDB')) }) });
    await interfaz.abrir();
    const r = await interfaz.guardar(parada, archivo());
    if (r.tipo !== 'guardada') throw new Error('no guardada');
    expect(await interfaz.borrar(r.fotoId)).toBe('fallo');
    expect(interfaz.cuenta(parada)).toBe(1);
  });

  it('ver el original solo con cabecera identificada; lo opaco no; la descarga entrega los bytes exactos', async () => {
    const { interfaz, urls } = montar();
    await interfaz.abrir();
    const html = new TextEncoder().encode('<script>x()</script>');
    const a = await interfaz.guardar(parada, archivo('pagina.html', html, 'text/html'));
    const b = await interfaz.guardar(parada, archivo('foto.png'));
    if (a.tipo !== 'guardada' || b.tipo !== 'guardada') throw new Error('no guardadas');
    expect(await interfaz.verOriginal(a.fotoId)).toMatchObject({ tipo: 'no-disponible' });
    const vista = await interfaz.verOriginal(b.fotoId);
    expect(vista.tipo).toBe('lista');
    if (vista.tipo === 'lista') { expect(urls.get(vista.url)!.type).toBe('image/png'); interfaz.soltarUrl(vista.url); }
    const descarga = (await interfaz.descargar(a.fotoId))!;
    expect(descarga.nombre).toBe('pagina.html');
    const blob = urls.get(descarga.url)!;
    expect(blob.type).toBe('application/octet-stream');
    expect(Array.from(new Uint8Array(await blob.arrayBuffer()))).toEqual(Array.from(html));
    interfaz.soltarUrl(descarga.url);
    expect(urls.size).toBe(0);
  });

  it('cerrar libera todas las URLs y deja de avisar', async () => {
    const { interfaz, urls, cambios } = montar();
    await interfaz.abrir();
    await interfaz.guardar(parada, archivo());
    interfaz.abrirVisita(parada);
    await esperar(interfaz, () => !!interfaz.entradas(parada)[0].url);
    interfaz.cerrar();
    const n = cambios.length;
    expect(urls.size).toBe(0);
    expect(await interfaz.guardar(parada, archivo())).toEqual({ tipo: 'no-lista' });
    expect(cambios.length).toBe(n);
  });
});

// T5B-ID-01: la biblioteca rechaza SIEMPRE la colisión de ID. Tras un error, solo la lectura de vuelta de la MISMA
// captura entera (metadata del original + bytes exactos) prueba que se guardó; una metadata igual no basta.
describe('identidad completa antes de confirmar', () => {
  const ID = '00000000-0000-4000-8000-0000000000aa';
  // Mismo valor que TROZO_IDENTIDAD (se comprueba aparte), para poner diferencias justo en los bordes.
  const TROZO = 1 << 20;
  const perdida = () => new DOMException('Respuesta perdida', 'AbortError');
  const cuota = () => new DOMException('Cuota', 'QuotaExceededError');
  /** Bytes de tamaño n con cabecera PNG genuina y relleno; `cambios` invierte esos bytes. */
  function grande(n: number, cambios: number[] = []): Uint8Array<ArrayBuffer> {
    const b = new Uint8Array(n);
    for (let i = 0; i < n; i++) b[i] = (i * 7) % 251;
    b.set(png());
    for (const i of cambios) b[i] ^= 0xff;
    return b;
  }
  /** «Otra conexión»: la biblioteca real de T5A sobre la misma base, como otra pestaña. */
  async function otraConexion(fabrica: IDBFactory): Promise<FotosLocal> {
    const l = await abrirFotosLocal(itinerario, { fabrica, nombre: 'fotos-interfaz' });
    cierres.push(() => l.cerrar());
    return l;
  }
  async function enBase(fabrica: IDBFactory) {
    const l = await otraConexion(fabrica);
    const m = await l.leerMetadatos(ID);
    const o = m && !esFotoBorrada(m) ? await l.leerOriginal(ID) : null;
    return { m, bytes: o ? Array.from(new Uint8Array(await o.arrayBuffer())) : null, total: (await l.listar()).length };
  }
  interface Variante { destino?: DestinoFoto; nombre?: string; ultimaModificacion?: number; incorporada?: number }
  const capturaOtra = (bytes: Uint8Array<ArrayBuffer>, v: Variante = {}) => crearCapturaFoto(itinerario, v.destino ?? parada,
    new File([bytes], v.nombre ?? 'misma.png', { type: 'image/png', lastModified: v.ultimaModificacion ?? 7 }), v.incorporada ?? 1000, { uuid: () => ID });
  const sesion = (f: FotosInterfaz, d: DestinoFoto = parada) => f.entradas(d).filter((e) => ['guardando', 'no-guardada', 'incierta'].includes(e.estado));

  it('otra captura con el MISMO ID, metadata y tamaño pero un byte distinto no se confirma; se conserva y A no cambia', async () => {
    const bytesA = png(); const bytesB = png(); bytesB[44] ^= 1;
    const { interfaz, fabrica } = montar({ uuid: () => ID });
    await interfaz.abrir();
    expect(await interfaz.guardar(parada, archivo('misma.png', bytesA))).toEqual({ tipo: 'guardada', fotoId: ID });
    const antes = await enBase(fabrica);
    const b = await interfaz.guardar(parada, archivo('misma.png', bytesB));
    expect(b.tipo).toBe('no-guardada');
    expect(interfaz.cuenta(parada)).toBe(1);
    expect(sesion(interfaz).map((e) => [e.fotoId, e.nombre, e.bytesOriginal, e.estado])).toEqual([[ID, 'misma.png', 45, 'no-guardada']]);
    // Reintentar sigue comparando con los bytes de B (no se ha cambiado por A) y no escribe nada.
    expect((await interfaz.reintentarGuardar(sesion(interfaz)[0].intento!)).tipo).toBe('no-guardada');
    expect(sesion(interfaz)).toHaveLength(1);
    const despues = await enBase(fabrica);
    expect(despues).toEqual(antes);
    expect(despues.bytes).toEqual(Array.from(bytesA));
    interfaz.descartar(sesion(interfaz)[0].intento!);
    expect(interfaz.entradas(parada).map((e) => e.fotoId)).toEqual([ID]);
  });

  it('Reintentar no confirma una foto distinta que otra conexión guardó con su ID mientras tanto', async () => {
    let fallar = true;
    const bytesB = png(); bytesB[44] ^= 1;
    const { interfaz, fabrica } = montar({ uuid: () => ID,
      envolver: (l) => ({ ...l, guardarOriginal: (c) => fallar ? Promise.reject(cuota()) : l.guardarOriginal(c) }) });
    await interfaz.abrir();
    expect((await interfaz.guardar(parada, archivo('misma.png', bytesB))).tipo).toBe('no-guardada');
    await (await otraConexion(fabrica)).guardarOriginal(capturaOtra(png()));
    fallar = false;
    const r = await interfaz.reintentarGuardar(ID);
    expect(r.tipo).toBe('no-guardada');
    expect(interfaz.cuenta(parada)).toBe(0);
    expect(sesion(interfaz).map((e) => [e.fotoId, e.estado])).toEqual([[ID, 'no-guardada']]);
    expect((await enBase(fabrica)).bytes).toEqual(Array.from(png()));
  });

  it('falló antes de escribir y Reintentar sin colisión la guarda una sola vez, con sus bytes exactos', async () => {
    let fallar = true;
    const bytes = png(); bytes[44] ^= 1;
    const { interfaz, fabrica } = montar({ uuid: () => ID,
      envolver: (l) => ({ ...l, guardarOriginal: (c) => fallar ? Promise.reject(cuota()) : l.guardarOriginal(c) }) });
    await interfaz.abrir();
    expect((await interfaz.guardar(parada, archivo('b.png', bytes))).tipo).toBe('no-guardada');
    fallar = false;
    expect(await interfaz.reintentarGuardar(sesion(interfaz)[0].intento!)).toEqual({ tipo: 'guardada', fotoId: ID });
    const base = await enBase(fabrica);
    expect([base.total, base.bytes]).toEqual([1, Array.from(bytes)]);
    expect(sesion(interfaz)).toEqual([]);
  });

  it('respuesta perdida tras el commit: la misma captura entera vale aunque su miniatura ya haya cambiado', async () => {
    const { interfaz, fabrica, lecturas } = montar({ uuid: () => ID, envolver: (l) => ({ ...l, guardarOriginal: async (c) => {
      await l.guardarOriginal(c);
      await l.guardarMiniatura(c.metadatos.fotoId, new Blob([png(4, 3)], { type: 'image/png' }), 4, 3);
      throw perdida();
    } }) });
    await interfaz.abrir();
    expect(await interfaz.guardar(parada, archivo('misma.png'))).toEqual({ tipo: 'guardada', fotoId: ID });
    expect(interfaz.entradas(parada).map((e) => e.estado)).toEqual(['guardada']);
    const base = await enBase(fabrica);
    expect([base.total, base.m && !esFotoBorrada(base.m) && base.m.miniatura.tipo]).toEqual([1, 'lista']);
    expect(lecturas.originales).toBe(1);
  });

  it('mismos bytes con otra metadata (destino, nombre, fecha del archivo o incorporada -0) no prueban identidad', async () => {
    const variantes: [Variante, number?][] = [[{ destino: sub }], [{ nombre: 'otra.png' }], [{ ultimaModificacion: 8 }], [{ incorporada: 0 }, -0]];
    for (const [v, ahora] of variantes) {
      const { interfaz, fabrica } = montar({ uuid: () => ID, ...(ahora === undefined ? {} : { ahora: () => ahora }) });
      await interfaz.abrir();
      await (await otraConexion(fabrica)).guardarOriginal(capturaOtra(png(), v));
      const r = await interfaz.guardar(parada, archivo('misma.png'));
      expect([JSON.stringify(v), r.tipo]).toEqual([JSON.stringify(v), 'no-guardada']);
      expect(interfaz.cuenta(parada) + interfaz.cuenta(sub)).toBe(0);
      expect(sesion(interfaz)).toHaveLength(1);
    }
  });

  it('una diferencia en el borde de un bloque, al final o en varios bloques se detecta; se para al primer bloque distinto', async () => {
    const n = 2 * TROZO + 17;
    const casos = [[0], [TROZO - 1], [TROZO], [n - 1], [TROZO + 5, 2 * TROZO + 3]];
    for (const cambios of casos) {
      const { interfaz, fabrica } = montar({ uuid: () => ID });
      await interfaz.abrir();
      await (await otraConexion(fabrica)).guardarOriginal(capturaOtra(grande(n)));
      const cortes = vi.spyOn(Blob.prototype, 'slice');
      const r = await interfaz.guardar(parada, archivo('misma.png', grande(n, cambios)));
      expect([cambios, r.tipo]).toEqual([cambios, 'no-guardada']);
      // Un bloque por original y por vuelta; el primer bloque distinto termina la comparación.
      expect(cortes.mock.calls.length).toBeLessThanOrEqual(2 * (Math.floor(cambios[0] / TROZO) + 1));
      cortes.mockRestore();
    }
  });

  it('si la identidad no se puede probar (original ilegible, borrada al comprobar, registro corrupto) queda incierta y se conserva', async () => {
    // Original ilegible justo al comprobar: incierta; luego se puede probar y vale.
    let ilegible = true;
    const a = montar({ uuid: () => ID, envolver: (l) => ({ ...l,
      guardarOriginal: async (c) => { await l.guardarOriginal(c); throw perdida(); },
      leerOriginal: (i) => ilegible ? Promise.reject(new Error('IDB')) : l.leerOriginal(i) }) });
    await a.interfaz.abrir();
    expect((await a.interfaz.guardar(parada, archivo('misma.png'))).tipo).toBe('incierta');
    expect([a.interfaz.cuenta(parada), sesion(a.interfaz).length]).toEqual([0, 1]);
    ilegible = false;
    expect(await a.interfaz.reintentarGuardar(ID)).toEqual({ tipo: 'guardada', fotoId: ID });
    expect((await enBase(a.fabrica)).total).toBe(1);

    // Otra conexión la borra mientras se comprueba: nada que confirmar ni resucitar.
    const b = montar({ uuid: () => ID, envolver: (l) => ({ ...l,
      guardarOriginal: async (c) => { await l.guardarOriginal(c); throw perdida(); },
      leerOriginal: async (i) => { await l.borrarLocal(i); return l.leerOriginal(i); } }) });
    await b.interfaz.abrir();
    expect((await b.interfaz.guardar(parada, archivo('misma.png'))).tipo).toBe('incierta');
    expect([b.interfaz.cuenta(parada), sesion(b.interfaz).length]).toEqual([0, 1]);
    expect(esFotoBorrada((await enBase(b.fabrica)).m)).toBe(true);

    // Registro corrupto bajo su ID (clave y fotoId distintos): la biblioteca lo rechaza y no se repara.
    const c = montar({ uuid: () => ID });
    await c.interfaz.abrir();
    await new Promise<void>((ok, ko) => {
      const r = c.fabrica.open('fotos-interfaz', 1);
      r.onerror = () => ko(r.error);
      r.onsuccess = () => {
        const tx = r.result.transaction(['metadatos', 'originales'], 'readwrite');
        const m = capturaOtra(png()).metadatos;
        tx.objectStore('metadatos').put({ ...m, fotoId: '00000000-0000-4000-8000-0000000000bb' }, ID);
        tx.objectStore('originales').put(new Blob([png()], { type: 'image/png' }), ID);
        tx.oncomplete = () => { r.result.close(); ok(); };
      };
    });
    expect((await c.interfaz.guardar(parada, archivo('misma.png'))).tipo).toBe('incierta');
    expect([c.interfaz.cuenta(parada), sesion(c.interfaz).length]).toEqual([0, 1]);
  });

  it('original opaco: la identidad se prueba con sus bytes crudos, sin decodificar ni inspeccionar', async () => {
    const svg = new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg" onload="x()"/>');
    const { interfaz, decodes } = montar({ uuid: () => ID,
      envolver: (l) => ({ ...l, guardarOriginal: async (c) => { await l.guardarOriginal(c); throw perdida(); } }) });
    await interfaz.abrir();
    expect(await interfaz.guardar(parada, archivo('dibujo.heic', svg, 'image/heic'))).toEqual({ tipo: 'guardada', fotoId: ID });
    expect(decodes.total).toBe(0);
  });

  it('dos capturas pendientes con el mismo ID no se pisan en la sesión', async () => {
    let fallar = true;
    const bytesB = png(); bytesB[44] ^= 1;
    const { interfaz, fabrica } = montar({ uuid: () => ID,
      envolver: (l) => ({ ...l, guardarOriginal: (c) => fallar ? Promise.reject(cuota()) : l.guardarOriginal(c) }) });
    await interfaz.abrir();
    expect((await interfaz.guardar(parada, archivo('a.png'))).tipo).toBe('no-guardada');
    expect((await interfaz.guardar(parada, archivo('b.png', bytesB))).tipo).toBe('no-guardada');
    const [a, b] = sesion(interfaz);
    expect([a, b].map((e) => [e?.fotoId, e?.nombre])).toEqual([[ID, 'a.png'], [ID, 'b.png']]);
    fallar = false;
    expect(await interfaz.reintentarGuardar(a.intento!)).toEqual({ tipo: 'guardada', fotoId: ID });
    expect((await interfaz.reintentarGuardar(b.intento!)).tipo).toBe('no-guardada');
    expect(interfaz.entradas(parada).map((e) => [e.nombre, e.estado])).toEqual([['a.png', 'vista-pendiente'], ['b.png', 'no-guardada']]);
    expect((await enBase(fabrica)).bytes).toEqual(Array.from(png()));
  });

  it('el bloque de comparación es de 1 MiB', () => {
    expect(TROZO_IDENTIDAD).toBe(TROZO);
  });
});

// PREV-01: una vista previa GUARDADA solo llega a una URL si sus bytes son un PNG identificado por el inspector
// existente, con las dimensiones y el peso de su metadata fresca (leída después del blob) y dentro de los límites.
describe('vistas previas guardadas: validación compartida por lista y visor', () => {
  const svg = new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg" onload="x()"><script>x()</script></svg>');
  /** Escribe en crudo (como otra conexión) una vista previa y su metadata «lista» coherente para la biblioteca. */
  function ponerVista(fabrica: IDBFactory, id: string, bytes: Uint8Array<ArrayBuffer>, ancho: number, alto: number) {
    return new Promise<void>((ok, ko) => {
      const r = fabrica.open('fotos-interfaz', 1);
      r.onerror = () => ko(r.error);
      r.onsuccess = () => {
        const tx = r.result.transaction(['metadatos', 'miniaturas'], 'readwrite');
        const g = tx.objectStore('metadatos').get(id);
        g.onsuccess = () => {
          tx.objectStore('metadatos').put({ ...g.result, miniatura: { tipo: 'lista', bytes: bytes.length, ancho, alto, mime: 'image/png' } }, id);
          tx.objectStore('miniaturas').put(new Blob([bytes], { type: 'image/png' }), id);
        };
        tx.oncomplete = () => { r.result.close(); ok(); };
        tx.onabort = () => { r.result.close(); ko(tx.error); };
      };
    });
  }
  async function conVistaGenerada(opciones: Opciones = {}) {
    const montaje = montar(opciones);
    await montaje.interfaz.abrir();
    const r = await montaje.interfaz.guardar(parada, archivo('foto.png'));
    if (r.tipo !== 'guardada') throw new Error('no guardada');
    montaje.interfaz.abrirVisita(parada);
    await esperar(montaje.interfaz, () => !!montaje.interfaz.entradas(parada)[0]?.url);
    montaje.interfaz.cerrarVisita(parada);
    return { ...montaje, id: r.fotoId };
  }
  async function originalEnBase(fabrica: IDBFactory, id: string) {
    const l = await abrirFotosLocal(itinerario, { fabrica, nombre: 'fotos-interfaz' });
    try { return Array.from(new Uint8Array(await (await l.leerOriginal(id))!.arrayBuffer())); } finally { l.cerrar(); }
  }
  /** Abre la visita y espera a que termine la lectura de su vista previa (haya o no URL). */
  async function visitar(m: Awaited<ReturnType<typeof conVistaGenerada>>) {
    const antes = m.lecturas.miniaturas;
    m.interfaz.abrirVisita(parada);
    await esperar(m.interfaz, () => m.lecturas.miniaturas > antes);
    await new Promise((ok) => setTimeout(ok, 20));
  }

  it('PNG con otras dimensiones, SVG declarado PNG o cabecera de 36 MP no llegan a una URL ni en la lista ni en el visor; un PNG coherente sí', async () => {
    const m = await conVistaGenerada();
    const original = await originalEnBase(m.fabrica, m.id);
    const casos: [string, Uint8Array<ArrayBuffer>][] = [['PNG 128×64 con metadata 72×72', png(128, 64)], ['SVG declarado PNG', svg],
      ['cabecera PNG de 6000×6000', png(6000, 6000)]];
    for (const [caso, bytes] of casos) {
      await ponerVista(m.fabrica, m.id, bytes, 72, 72);
      await visitar(m);
      // Lista y visor por separado (soft): cada camino se comprueba aunque falle el otro.
      expect.soft([caso, m.urls.size, m.interfaz.entradas(parada)[0].url, m.interfaz.entradas(parada)[0].estado]).toEqual([caso, 0, undefined, 'sin-vista']);
      const u = await m.interfaz.verMiniatura(m.id);
      expect.soft([caso, u]).toEqual([caso, null]);
      if (u) m.interfaz.soltarUrl(u);
      m.interfaz.cerrarVisita(parada);
    }
    expect(m.decodes.total).toBe(1); // solo la generación inicial: validar no decodifica
    await ponerVista(m.fabrica, m.id, png(72, 72), 72, 72);
    await visitar(m);
    const [e] = m.interfaz.entradas(parada);
    expect([e.estado, e.bytesOriginal, m.urls.size]).toEqual(['guardada', 45, 1]);
    const u = (await m.interfaz.verMiniatura(m.id))!;
    expect(Array.from(new Uint8Array(await m.urls.get(u)!.arrayBuffer()))).toEqual(Array.from(png(72, 72)));
    m.interfaz.soltarUrl(u);
    expect(await originalEnBase(m.fabrica, m.id)).toEqual(original);
  });

  it('la metadata se relee tras el blob: si la foto se borra mientras se valida no hay URL; una visita cerrada tampoco la recibe', async () => {
    let borrarAlLeer = false;
    let soltar: (() => void) | null = null;
    const m = await conVistaGenerada({ envolver: (l) => ({ ...l, leerMiniatura: async (i) => {
      const blob = await l.leerMiniatura(i);
      if (borrarAlLeer) {
        const otra = await abrirFotosLocal(itinerario, { fabrica: m.fabrica, nombre: 'fotos-interfaz' });
        try { await otra.borrarLocal(i); } finally { otra.cerrar(); }
      }
      if (soltar === null && !borrarAlLeer) await new Promise<void>((ok) => { soltar = ok; });
      return blob;
    } }) });
    // Visita cerrada mientras se lee: la lectura vieja no crea URL en ninguna visita.
    soltar = null;
    m.interfaz.abrirVisita(parada);
    await esperar(m.interfaz, () => soltar !== null);
    m.interfaz.cerrarVisita(parada);
    soltar!();
    await new Promise((ok) => setTimeout(ok, 20));
    expect(m.urls.size).toBe(0);
    // Borrada (tombstone) entre el blob y la metadata fresca: ni lista ni visor la enseñan.
    borrarAlLeer = true;
    await visitar(m);
    expect([m.urls.size, m.interfaz.entradas(parada)[0]?.url]).toEqual([0, undefined]);
    expect([await m.interfaz.verMiniatura(m.id), m.urls.size]).toEqual([null, 0]);
  });
});
