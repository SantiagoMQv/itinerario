import { describe, it, expect, afterEach } from 'vitest';
import { itinerario as plan } from '../../src/datos/itinerario';
import { serializarSolicitudRespaldo, serializarReciboRespaldo, deserializarSolicitudRespaldo,
  type SolicitudRespaldo } from '../../src/fotos-protocolo';
import { crearAlmacenFotos, clavePrivadaFotos, type ReservaFotos, type RepositorioFotos,
  type ObjetosFotos, type ContextoAlmacenFotos } from '../../servidor/almacen-fotos';
import { crearVigenciaFotos, type VigenciaFotos, type PresupuestoFotos } from '../../servidor/multipart-fotos';

const presupuesto: PresupuestoFotos = { maxBytesOriginal: 2000000, maxBytesEntrada: 2200000,
  maxBytesChunk: 65536, maxBytesCabeceras: 1024, maxBytesRetenidos: 8000000,
  maxBloquesOriginal: 100, bytesBloque: 65536, plazoMs: 10000 };
const vigencias: VigenciaFotos[] = [];
afterEach(() => { vigencias.splice(0).forEach((v) => v.cerrar()); });
function contexto(reautenticar = async () => true, plazoMs = 10000): ContextoAlmacenFotos {
  const vigencia = crearVigenciaFotos(new AbortController().signal, plazoMs); vigencias.push(vigencia);
  return { huellaActor: 'actor-vivo', presupuesto, vigencia, reautenticar };
}
function ref(bytesOriginal = 3): SolicitudRespaldo {
  const fotoId = 'ABCDEF12-1234-4123-8123-123456789ABD';
  return { version: 1, tipo: 'solicitud-respaldo', viajeId: plan.id,
    operacionId: 'ABCDEF12-1234-4123-8123-123456789ABC', fotoId, original: { formato: 1, fotoId,
      destino: { tipo: 'parada', viajeId: plan.id, paradaId: plan.dias[0].paradas[0].id },
      nombre: '\0 e\u0301 ', mimeDeclarado: 'IMAGE/HEIC\0', ultimaModificacion: -0,
      incorporada: -0, bytesOriginal } };
}
function recibo(s: SolicitudRespaldo): string {
  return serializarReciboRespaldo(plan, { ...s, tipo: 'acuse-respaldo', objetoOriginalDurable: true, metadatosDurables: true });
}
function fixture() {
  const eventos: string[] = [];
  let reserva: ReservaFotos | null = null;
  let guardado: Blob | null = null;
  let finalizada = false;
  const repositorio: RepositorioFotos = {
    async reservar(_actor, _viaje, texto) {
      eventos.push('reserva-commit');
      if (reserva) return { tipo: 'existente', reserva };
      const s = deserializarSolicitudRespaldo(plan, texto);
      const reservaId = 'ABCDEF12-1234-4123-8123-123456789ABE';
      reserva = { reservaId, claveObjeto: clavePrivadaFotos(plan.id, s.fotoId, reservaId), solicitudCanonica: texto };
      return { tipo: 'ganadora', reserva };
    },
    async finalizar(_actor, _viaje, _reserva, texto) {
      eventos.push('final-commit'); finalizada = true;
      return { tipo: 'confirmada', reciboCanonico: recibo(deserializarSolicitudRespaldo(plan, texto)) };
    },
    async leerConfirmada() { eventos.push('consulta'); return finalizada ? { tipo: 'confirmada', reserva } : { tipo: 'ausente' }; },
  };
  const objetos: ObjetosFotos = {
    async ponerSiAusente(_clave, original) {
      eventos.push('put');
      if (guardado) return false;
      guardado = original; return true;
    },
    async leer(claveObjeto) {
      eventos.push('get');
      if (!guardado) return null;
      const blob = guardado; let pos = 0;
      const stream = new ReadableStream<Uint8Array>({ async pull(c) {
        if (pos === blob.size) { c.close(); return; }
        const fin = Math.min(blob.size, pos + 65536);
        c.enqueue(new Uint8Array(await blob.slice(pos, fin).arrayBuffer())); pos = fin;
      } });
      return { claveObjeto, solicitudCanonica: reserva!.solicitudCanonica, original: stream };
    },
  };
  const crear = () => crearAlmacenFotos({ plan, repositorio, objetos });
  const captura = (datos = new Uint8Array([1, 2, 3]), solicitud = ref(datos.length)) => ({ solicitud,
    original: new Blob([datos as Uint8Array<ArrayBuffer>], { type: 'application/octet-stream' }) });
  return { eventos, repositorio, objetos, crear, captura,
    reserva: () => reserva, cambiarObjeto: (b: Blob | null) => { guardado = b; } };
}

describe('reserva SQL primero, ganador único ligado al original', () => {
  it('primera y repetición verifican bytes completos antes del final/acuse', async () => {
    const f = fixture(); const almacen = f.crear();
    const c = contexto(async () => { f.eventos.push('auth-fresca'); return true; });
    const primera = await almacen.respaldar(f.captura(), c);
    expect(primera).toEqual({ primera: true, texto: recibo(ref()) });
    expect(f.eventos).toEqual(['reserva-commit', 'put', 'get', 'auth-fresca', 'final-commit']);
    f.eventos.length = 0;
    expect((await almacen.respaldar(f.captura(), c)).primera).toBe(false);
    expect(f.eventos).toEqual(['reserva-commit', 'get', 'auth-fresca', 'final-commit']);
  });
  it('SQL reserve respuesta perdida conserva reserva vacía, nunca retry put', async () => {
    const f = fixture(); const original = f.repositorio.reservar;
    f.repositorio.reservar = async (...args) => { await original(...args); throw new Error('detalle SQL privado'); };
    await expect(f.crear().respaldar(f.captura(), contexto())).rejects.toMatchObject({ codigo: 503 });
    expect(f.reserva()).not.toBeNull(); expect(f.eventos).toEqual(['reserva-commit']);
    f.repositorio.reservar = original;
    await expect(f.crear().respaldar(f.captura(), contexto())).rejects.toMatchObject({ codigo: 503 });
    expect(f.eventos).toEqual(['reserva-commit', 'reserva-commit', 'get']);
  });
  it('ganador muerto antes del put no habilita takeover/edad/otro intento', async () => {
    const f = fixture();
    await f.repositorio.reservar('a', plan.id, serializarSolicitudRespaldo(plan, ref()));
    await expect(f.crear().respaldar(f.captura(), contexto())).rejects.toMatchObject({ codigo: 503 });
    expect(f.eventos).not.toContain('put'); expect(f.eventos).not.toContain('final-commit');
  });
  it('respuesta R2 perdida y respuesta final perdida son inciertas; retry solo compara', async () => {
    const f = fixture(); const poner = f.objetos.ponerSiAusente;
    f.objetos.ponerSiAusente = async (...args) => { await poner(...args); throw new Error('R2 perdido'); };
    await expect(f.crear().respaldar(f.captura(), contexto())).rejects.toMatchObject({ codigo: 503 });
    expect(f.eventos).toEqual(['reserva-commit', 'put']);
    f.objetos.ponerSiAusente = poner;
    const finalizar = f.repositorio.finalizar;
    f.repositorio.finalizar = async (...args) => { await finalizar(...args); throw new Error('SQL final perdido'); };
    await expect(f.crear().respaldar(f.captura(), contexto())).rejects.toMatchObject({ codigo: 503 });
    f.repositorio.finalizar = finalizar;
    expect((await f.crear().respaldar(f.captura(), contexto())).primera).toBe(false);
    expect(f.eventos.filter((e) => e === 'put')).toHaveLength(1);
  });
  it('misma operación con metadata/foto diferente contradice, no get/put/ACK', async () => {
    const f = fixture(); const a = f.crear(); await a.respaldar(f.captura(), contexto());
    f.eventos.length = 0;
    for (const s of [{ ...ref(), original: { ...ref().original, incorporada: 0 } },
      { ...ref(), fotoId: 'ABCDEF12-1234-4123-8123-123456789ABF', original: { ...ref().original,
        fotoId: 'ABCDEF12-1234-4123-8123-123456789ABF' } }]) {
      await expect(a.respaldar(f.captura(undefined, s), contexto())).rejects.toMatchObject({ codigo: 409 });
    }
    expect(f.eventos).toEqual(['reserva-commit', 'reserva-commit']);
  });
  it('otra operación de misma foto compara objeto immutable sin permiso put', async () => {
    const f = fixture(); const a = f.crear(); await a.respaldar(f.captura(), contexto());
    f.eventos.length = 0;
    const solicitud = { ...ref(), operacionId: 'ABCDEF12-1234-4123-8123-123456789ABF' };
    expect((await a.respaldar(f.captura(undefined, solicitud), contexto())).texto).toBe(recibo(solicitud));
    expect(f.eventos).toEqual(['reserva-commit', 'get', 'final-commit']);
  });
  it('payload >1MiB, último byte distinto y EOF corto/largo no usan hash/size solos', async () => {
    const f = fixture(); const a = f.crear(); const datos = new Uint8Array(1048576 + 5); datos.fill(42);
    await a.respaldar(f.captura(datos), contexto());
    const distintos = datos.slice(); distintos[distintos.length - 1] = 43;
    for (const candidato of [distintos, datos.slice(0, -1), new Uint8Array(datos.length + 1)]) {
      // Size diferente en incoming significa metadata distinta; para EOF probar remoto alterado.
      f.cambiarObjeto(new Blob([candidato])); f.eventos.length = 0;
      await expect(a.respaldar(f.captura(datos), contexto())).rejects.toMatchObject({ codigo: 409 });
      expect(f.eventos).toEqual(['reserva-commit', 'get']);
    }
    f.cambiarObjeto(new Blob([datos]));
    await expect(a.respaldar(f.captura(datos), contexto())).resolves.toMatchObject({ primera: false });
  });
  it('revocación tras put/scan niega acuse y preserva objeto/reserva', async () => {
    const f = fixture();
    await expect(f.crear().respaldar(f.captura(), contexto(async () => false))).rejects.toMatchObject({ codigo: 401 });
    expect(f.eventos).toEqual(['reserva-commit', 'put', 'get']);
    await expect(f.crear().respaldar(f.captura(), contexto())).resolves.toMatchObject({ primera: false });
  });
  it('final SQL revalida sesión viva aun con auth HTTP válida', async () => {
    const f = fixture(); f.repositorio.finalizar = async () => ({ tipo: 'sin-sesion' });
    await expect(f.crear().respaldar(f.captura(), contexto())).rejects.toMatchObject({ codigo: 401 });
    expect(f.eventos).toContain('put');
  });
  it('namespace/metadata de objeto o grant incorrecto jamás adopta huérfano extranjero', async () => {
    for (const campo of ['claveObjeto', 'solicitudCanonica']) {
      const f = fixture(); const leer = f.objetos.leer;
      f.objetos.leer = async (...args) => ({ ...await leer(...args) as object, [campo]: 'objeto-ajeno' });
      await expect(f.crear().respaldar(f.captura(), contexto())).rejects.toMatchObject({ codigo: 503 });
      expect(f.eventos).not.toContain('final-commit');
    }
    const f = fixture(); const reservar = f.repositorio.reservar;
    f.repositorio.reservar = async (...args) => {
      await reservar(...args); return { tipo: 'ganadora', reserva: { ...f.reserva(), claveObjeto: 'otra-clave' } };
    };
    await expect(f.crear().respaldar(f.captura(), contexto())).rejects.toMatchObject({ codigo: 503 });
    expect(f.eventos).not.toContain('put');
  });
  it('deadline con reserva pendiente nunca continúa put al resolver tarde', async () => {
    const f = fixture(); let resolver: (v: unknown) => void = () => {};
    f.repositorio.reservar = () => new Promise((ok) => { resolver = ok; });
    const c = contexto(undefined, 10);
    await expect(f.crear().respaldar(f.captura(), c)).rejects.toMatchObject({ codigo: 503 });
    resolver({ tipo: 'ganadora', reserva: { reservaId: 'ABCDEF12-1234-4123-8123-123456789ABE',
      claveObjeto: clavePrivadaFotos(plan.id, ref().fotoId, 'ABCDEF12-1234-4123-8123-123456789ABE'),
      solicitudCanonica: serializarSolicitudRespaldo(plan, ref()) } });
    await Promise.resolve(); await Promise.resolve();
    expect(f.eventos).toEqual([]);
  });
  for (const fase of ['put', 'get', 'final'] as const) {
    it(`deadline en ${fase} no habilita continuaciones ni ACK tardío`, async () => {
      const f = fixture(); let resolver: (valor: unknown) => void = () => {};
      const pendiente = () => {
        f.eventos.push('pendiente-' + fase);
        return new Promise<unknown>((ok) => { resolver = ok; });
      };
      if (fase === 'put') f.objetos.ponerSiAusente = pendiente;
      if (fase === 'get') f.objetos.leer = pendiente;
      if (fase === 'final') f.repositorio.finalizar = pendiente;
      await expect(f.crear().respaldar(f.captura(), contexto(undefined, 10))).rejects.toMatchObject({ codigo: 503 });
      const eventos = [...f.eventos];
      const tardio = fase === 'put' ? true : fase === 'get'
        ? { claveObjeto: f.reserva()!.claveObjeto, solicitudCanonica: f.reserva()!.solicitudCanonica,
          original: new Blob([new Uint8Array([1, 2, 3])]).stream() }
        : { tipo: 'confirmada', reciboCanonico: recibo(ref()) };
      resolver(tardio); await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
      expect(f.eventos).toEqual(eventos);
      if (fase !== 'final') expect(f.eventos).not.toContain('final-commit');
    });
  }
  it('fábrica captura puertos y plan, no IO modular ni constructor', async () => {
    const f = fixture(); const copia = structuredClone(plan);
    const a = crearAlmacenFotos({ plan: copia, repositorio: f.repositorio, objetos: f.objetos });
    expect(f.eventos).toEqual([]);
    Object.assign(copia, { id: 'otro' }); f.objetos.ponerSiAusente = async () => { throw new Error('sustituido'); };
    await expect(a.respaldar(f.captura(), contexto())).resolves.toMatchObject({ primera: true });
  });
});

describe('puerto de objetos con admisión física y contexto capturado', () => {
  it('rechaza presupuesto físico insuficiente antes de reservar', async () => {
    const f = fixture();
    await expect(f.crear().respaldar(f.captura(), { ...contexto(),
      presupuesto: { ...presupuesto, maxBytesEntrada: 3 } })).rejects.toMatchObject({ codigo: 413 });
    expect(f.eventos).toEqual([]);
  });
  it('GET de otra operación recibe el cuerpo inicial, no el actual', async () => {
    const f = fixture(); const leer = f.objetos.leer; const textos: string[] = [];
    f.objetos.leer = async (...args) => { textos.push(args[1]); return leer(...args); };
    const a = f.crear(); await a.respaldar(f.captura(), contexto());
    const otra = { ...ref(), operacionId: 'ABCDEF12-1234-4123-8123-123456789ABF' };
    await a.respaldar(f.captura(undefined, otra), contexto());
    expect(textos).toEqual([serializarSolicitudRespaldo(plan, ref()), serializarSolicitudRespaldo(plan, ref())]);
    expect(f.eventos.filter((e) => e === 'put')).toHaveLength(1);
  });
  for (const p of [{ ...presupuesto, maxBytesChunk: 0 }, { ...presupuesto, maxBytesRetenidos: 1000000 },
    { ...presupuesto, maxBytesEntrada: 1 }, { ...presupuesto, maxBytesRetenidos: NaN }]) {
    it(`presupuesto ${JSON.stringify(p)} deniega antes de reserva y GET`, async () => {
      const f = fixture(); const a = f.crear(); await a.respaldar(f.captura(), contexto());
      f.eventos.length = 0;
      await expect(a.respaldar(f.captura(), { ...contexto(), presupuesto: p })).rejects.toThrow();
      expect(f.eventos).toEqual([]);
      await expect(a.descargar(ref().fotoId, { ...contexto(), presupuesto: p })).rejects.toThrow();
      expect(f.eventos).not.toContain('get'); expect(f.eventos).not.toContain('put'); expect(f.eventos).not.toContain('final-commit');
    });
  }
  it('chunk cero es configuración inválida incluso en descarga ausente: cero SQL', async () => {
    const f = fixture();
    await expect(f.crear().descargar(ref().fotoId, { ...contexto(),
      presupuesto: { ...presupuesto, maxBytesChunk: 0 } })).rejects.toMatchObject({ codigo: 503 });
    expect(f.eventos).toEqual([]);
  });
  it('GET presupuesto getter rechazado antes de consulta sin invocarlo', async () => {
    const f = fixture(); const p = { ...presupuesto }; let llamadas = 0;
    Object.defineProperty(p, 'maxBytesEntrada', { get() { llamadas++; return 2200000; }, enumerable: true });
    await expect(f.crear().descargar(ref().fotoId, { ...contexto(), presupuesto: p })).rejects.toMatchObject({ codigo: 503 });
    expect(llamadas).toBe(0); expect(f.eventos).toEqual([]);
  });
  for (const bytes of [0, 3]) {
    it(`frontera de retención exacta ${bytes} bytes antes de reservar`, async () => {
      const f = fixture(); const c = contexto(); const minimo = 2 * Math.ceil(bytes / 65536) * 65536 + 729600 + 720908 + bytes;
      const captura = f.captura(new Uint8Array(bytes));
      await expect(f.crear().respaldar(captura, { ...c, presupuesto: { ...presupuesto, maxBytesRetenidos: minimo - 1 } })).rejects.toMatchObject({ codigo: 413 });
      expect(f.eventos).toEqual([]);
      await expect(f.crear().respaldar(captura, { ...c, presupuesto: { ...presupuesto, maxBytesRetenidos: minimo } })).resolves.toMatchObject({ primera: true });
    });
  }
  it('PUT y GET reciben presupuesto congelado y la misma vigencia', async () => {
    const f = fixture(); const c = contexto(); const poner = f.objetos.ponerSiAusente; const leer = f.objetos.leer;
    const recibidos: unknown[] = [];
    f.objetos.ponerSiAusente = async (...args) => { recibidos.push(args[3]); return poner(...args); };
    f.objetos.leer = async (...args) => { recibidos.push(args[2]); expect(args[1]).toBe(f.reserva()!.solicitudCanonica); return leer(...args); };
    await f.crear().respaldar(f.captura(), c);
    for (const valor of recibidos) {
      const capturado = valor as { presupuesto: PresupuestoFotos; vigencia: VigenciaFotos };
      expect(Object.isFrozen(capturado)).toBe(true); expect(Object.isFrozen(capturado.presupuesto)).toBe(true);
      expect(capturado.presupuesto).toEqual(presupuesto); expect(capturado.vigencia).toBe(c.vigencia);
      expect(Object.keys(capturado)).toEqual(['presupuesto', 'vigencia']);
    }
  });
});

describe('GET privado confirmado no es ACK', () => {
  it('ausente, reserva no finalizada y descarga exacta con auth fresca', async () => {
    const f = fixture(); const a = f.crear();
    await expect(a.descargar(ref().fotoId, contexto())).rejects.toMatchObject({ codigo: 404 });
    await a.respaldar(f.captura(), contexto()); f.eventos.length = 0;
    const b = await a.descargar(ref().fotoId, contexto(async () => { f.eventos.push('auth-fresca'); return true; }));
    expect(Array.from(new Uint8Array(await b.arrayBuffer()))).toEqual([1, 2, 3]);
    expect(f.eventos).toEqual(['consulta', 'get', 'auth-fresca']);
  });
  it('no entrega original después de revocación, fallo o cuerpo incompleto', async () => {
    const f = fixture(); const a = f.crear(); await a.respaldar(f.captura(), contexto());
    await expect(a.descargar(ref().fotoId, contexto(async () => false))).rejects.toMatchObject({ codigo: 401 });
    f.cambiarObjeto(null);
    await expect(a.descargar(ref().fotoId, contexto())).rejects.toMatchObject({ codigo: 503 });
    f.cambiarObjeto(new Blob([new Uint8Array([1])]));
    await expect(a.descargar(ref().fotoId, contexto())).rejects.toMatchObject({ codigo: 400 });
  });
});
