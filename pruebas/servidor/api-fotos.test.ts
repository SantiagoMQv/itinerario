import { describe, it, expect } from 'vitest';
import { itinerario as plan } from '../../src/datos/itinerario';
import { serializarSolicitudRespaldo, serializarReciboRespaldo, deserializarSolicitudRespaldo,
  deserializarReciboRespaldo, type SolicitudRespaldo } from '../../src/fotos-protocolo';
import { crearControladorFotos } from '../../servidor/api-fotos';
import { clavePrivadaFotos, type ReservaFotos, type RepositorioFotos, type ObjetosFotos } from '../../servidor/almacen-fotos';
import type { PresupuestoFotos } from '../../servidor/multipart-fotos';
import type { RegistroSesion } from '../../servidor/sesiones';

const origen = 'https://viaje.test';
const presupuesto: PresupuestoFotos = { maxBytesOriginal: 2000000, maxBytesEntrada: 2200000,
  maxBytesChunk: 65536, maxBytesCabeceras: 1024, maxBytesRetenidos: 8000000,
  maxBloquesOriginal: 100, bytesBloque: 65536, plazoMs: 10000 };
const fotoId = 'ABCDEF12-1234-4123-8123-123456789ABD';
const ref: SolicitudRespaldo = { version: 1, tipo: 'solicitud-respaldo', viajeId: plan.id,
  operacionId: 'ABCDEF12-1234-4123-8123-123456789ABC', fotoId, original: { formato: 1, fotoId,
    destino: { tipo: 'parada', viajeId: plan.id, paradaId: plan.dias[0].paradas[0].id },
    nombre: '\0 e\u0301 ', mimeDeclarado: 'IMAGE/HEIC\0', incorporada: -0,
    ultimaModificacion: -0, bytesOriginal: 3 } };
function post(s = ref, datos = new Uint8Array([1, 2, 3])) {
  const form = new FormData(); form.append('solicitud', serializarSolicitudRespaldo(plan, s));
  form.append('original', new Blob([datos as Uint8Array<ArrayBuffer>], { type: 'application/octet-stream' }), 'original');
  return new Request(origen + '/api/fotos/respaldo', { method: 'POST', headers: { Origin: origen }, body: form });
}
function fixture() {
  let viva = true; let autentificaciones = 0; let reserva: ReservaFotos | null = null; let original: Blob | null = null;
  let confirmada = false; const eventos: string[] = [];
  const actor: RegistroSesion = { id: 'abcdef12-1234-4123-8123-123456789abd', huella: 'a'.repeat(64),
    viajeId: plan.id, dispositivoId: 'otro-editor', creadaEn: 0, venceEn: Number.MAX_SAFE_INTEGER, revocada: false };
  const autenticar = async () => { autentificaciones++; eventos.push('auth'); return viva ? actor : null; };
  const repositorio: RepositorioFotos = {
    async reservar(_a, _v, texto) {
      eventos.push('reserva'); if (reserva) return { tipo: 'existente', reserva };
      const s = deserializarSolicitudRespaldo(plan, texto); const reservaId = 'ABCDEF12-1234-4123-8123-123456789ABE';
      reserva = { reservaId, claveObjeto: clavePrivadaFotos(plan.id, s.fotoId, reservaId), solicitudCanonica: texto };
      return { tipo: 'ganadora', reserva };
    },
    async finalizar(_a, _v, _r, texto) {
      eventos.push('final'); confirmada = true;
      return { tipo: 'confirmada', reciboCanonico: serializarReciboRespaldo(plan,
        { ...deserializarSolicitudRespaldo(plan, texto), tipo: 'acuse-respaldo', objetoOriginalDurable: true, metadatosDurables: true }) };
    },
    async leerConfirmada() { eventos.push('consulta'); return confirmada ? { tipo: 'confirmada', reserva } : { tipo: 'ausente' }; },
  };
  const objetos: ObjetosFotos = {
    async ponerSiAusente(_k, b) { eventos.push('put'); if (original) return false; original = b; return true; },
    async leer(k) { eventos.push('get'); return original ? { claveObjeto: k,
      solicitudCanonica: reserva!.solicitudCanonica, original: original.stream() } : null; },
  };
  const crear = () => crearControladorFotos({ plan, origen, autenticar, repositorio, objetos });
  return { crear, eventos, repositorio, objetos, revocar: () => { viva = false; }, autentificaciones: () => autentificaciones };
}

describe('API autónoma HTTPS protegida', () => {
  it('201 y 200 usan codec exacto de recibo, GET privado conserva bytes y no confirma', async () => {
    const f = fixture(); const c = f.crear(); expect(f.eventos).toEqual([]);
    const primera = await c.atender(post(), presupuesto);
    expect(primera.status).toBe(201);
    const recibo = deserializarReciboRespaldo(plan, await primera.text());
    expect(recibo.original.nombre).toBe(ref.original.nombre);
    expect(Object.is(recibo.original.incorporada, -0)).toBe(true);
    expect(recibo.fotoId).toBe(fotoId); expect(recibo.metadatosDurables).toBe(true);
    expect((await c.atender(post(), presupuesto)).status).toBe(200);
    expect(f.eventos.filter((e) => e === 'put')).toHaveLength(1);
    f.eventos.length = 0;
    const r = await c.atender(new Request(`${origen}/api/fotos/${encodeURIComponent(fotoId)}/original`), presupuesto);
    expect(r.status).toBe(200); expect(new Uint8Array(await r.arrayBuffer())).toEqual(new Uint8Array([1, 2, 3]));
    expect(r.headers.get('Content-Type')).toBe('application/octet-stream');
    expect(r.headers.get('Cache-Control')).toBe('private, no-store');
    expect(r.headers.get('X-Content-Type-Options')).toBe('nosniff'); expect(r.headers.get('Vary')).toBe('Cookie');
    expect(f.eventos).toEqual(['auth', 'consulta', 'get', 'auth']);
  });
  it('HTTPS y Origin exactos antes de auth/body, sin relajación loopback', async () => {
    for (const [url, origin, estado] of [['http://viaje.test/api/fotos/respaldo', origen, 400],
      [origen + '/api/fotos/respaldo', origen + '/', 403], [origen + '/api/fotos/respaldo', 'null', 403],
      ['https://otro.test/api/fotos/respaldo', 'https://otro.test', 400]] as const) {
      const f = fixture(); const r = await f.crear().atender(new Request(url, { method: 'POST', headers: { Origin: origin } }), presupuesto);
      expect(r.status).toBe(estado); expect(f.eventos).toEqual([]);
    }
  });
  it('sesión antes de leer body y auth fresh después de scan', async () => {
    const f = fixture(); f.revocar();
    const solicitud = post(); expect((await f.crear().atender(solicitud, presupuesto)).status).toBe(401);
    expect(solicitud.bodyUsed).toBe(false); expect(f.eventos).toEqual(['auth']);
    const g = fixture(); const poner = g.objetos.ponerSiAusente;
    g.objetos.ponerSiAusente = async (...a) => { const r = await poner(...a); g.revocar(); return r; };
    expect((await g.crear().atender(post(), presupuesto)).status).toBe(401);
    expect(g.eventos).toEqual(['auth', 'reserva', 'put', 'get', 'auth']);
  });
  it('rutas/métodos exactos, no listado ni lowercase ni slash encubierto', async () => {
    const f = fixture(); const c = f.crear();
    for (const ruta of ['/api/fotos', '/api/fotos/respaldo/', `/api/fotos/${fotoId}/original/`,
      `/api/fotos/x/y/original`]) expect((await c.atender(new Request(origen + ruta), presupuesto)).status).toBe(404);
    expect((await c.atender(new Request(origen + '/api/fotos/respaldo'), presupuesto)).status).toBe(405);
    expect((await c.atender(new Request(`${origen}/api/fotos/${fotoId}/original`, { method: 'POST' }), presupuesto)).status).toBe(405);
    for (const id of ['%FF', '%2F', '%', 'no-uuid']) {
      expect((await c.atender(new Request(`${origen}/api/fotos/${id}/original`), presupuesto)).status).toBe(400);
    }
    expect(f.eventos).toEqual([]);
  });
  it('config/presupuesto inválidos antes de IO; error público constante sin secretos', async () => {
    const f = fixture(); const c = f.crear();
    expect((await c.atender(post(), {} as PresupuestoFotos)).status).toBe(503);
    expect(f.eventos).toEqual([]);
    f.repositorio.reservar = async () => { throw new Error('clave privada o uri'); };
    const r = await f.crear().atender(post(), presupuesto);
    expect(r.status).toBe(503); expect(await r.text()).toBe('{"error":"No se pudo completar la solicitud de fotos."}');
  });
  it('body no multipart/metadata/cabecera/count inválidos no reservan', async () => {
    const f = fixture(); const c = f.crear();
    const json = new Request(origen + '/api/fotos/respaldo', { method: 'POST', headers: { Origin: origen,
      'Content-Type': 'application/json' }, body: '{}' });
    expect((await c.atender(json, presupuesto)).status).toBe(415);
    expect((await c.atender(post(ref, new Uint8Array([1])), presupuesto)).status).toBe(400);
    expect(f.eventos).toEqual(['auth', 'auth']);
  });
  it('recibo potencial >64KiB rechaza antes de cualquier SQL u objeto', async () => {
    const vacia = { ...ref, original: { ...ref.original, nombre: '' } };
    const n = 65536 - new TextEncoder().encode(serializarSolicitudRespaldo(plan, vacia)).length;
    const s = { ...vacia, original: { ...vacia.original, nombre: 'x'.repeat(n) } };
    const f = fixture();
    expect((await f.crear().atender(post(s), presupuesto)).status).toBe(413);
    expect(f.eventos).toEqual(['auth']);
  });
  it('GET sesión ausente/objeto perdido no produce receipt ni fallback', async () => {
    const f = fixture(); const c = f.crear();
    const req = () => new Request(`${origen}/api/fotos/${fotoId}/original`);
    expect((await c.atender(req(), presupuesto)).status).toBe(404);
    await c.atender(post(), presupuesto);
    f.objetos.leer = async () => null;
    const perdido = await f.crear().atender(req(), presupuesto);
    expect(perdido.status).toBe(503); expect(await perdido.text()).not.toContain('acuse-respaldo');
    f.revocar(); expect((await c.atender(req(), presupuesto)).status).toBe(401);
  });
});
