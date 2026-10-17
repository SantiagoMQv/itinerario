import { describe, expect, it, vi } from 'vitest';
import { CLAVE_IDENTIFICADOR_DISPOSITIVO, proveerRespuestaEntrada } from '../../servidor/entrada';
import { crearRouterViaje, type ConfiguracionRouterViaje } from '../../servidor/router';

const solicitar = (ruta = '/entrar', opciones: RequestInit = {}) => new Request(`https://viaje.test${ruta}`, opciones);
const nonceDe = (respuesta: Response) => /'nonce-([^']+)'/.exec(respuesta.headers.get('Content-Security-Policy') ?? '')?.[1];
// El nonce es lo único que puede cambiar entre respuestas.
const sinNonce = (html: string, nonce: string) => html.split(nonce).join('NONCE');

describe('página pública /entrar', () => {
  it('es compatible con el puerto del router y responde 200 HTML', async () => {
    const puerto: ConfiguracionRouterViaje['proveerRespuestaEntrada'] = proveerRespuestaEntrada;
    const respuesta = await puerto(solicitar());
    expect(respuesta).toBeInstanceOf(Response);
    expect(respuesta.status).toBe(200);
    expect(respuesta.headers.get('Content-Type')).toBe('text/html; charset=utf-8');
    const html = await respuesta.text();
    expect(html.startsWith('<!doctype html>')).toBe(true);
    expect(html).toContain('<html lang="es"');
  });

  it('lleva cabeceras privadas, sin caché ni cookies', async () => {
    const respuesta = await proveerRespuestaEntrada(solicitar('/entrar', { headers: { Cookie: '__Host-itinerario=vigente' } }));
    expect(respuesta.headers.get('Cache-Control')).toBe('private, no-store');
    expect(respuesta.headers.get('Pragma')).toBe('no-cache');
    expect(respuesta.headers.get('X-Content-Type-Options')).toBe('nosniff');
    expect(respuesta.headers.get('Vary')).toBe('Cookie');
    expect(respuesta.headers.get('Referrer-Policy')).toBe('no-referrer');
    expect(respuesta.headers.get('X-Frame-Options')).toBe('DENY');
    expect(respuesta.headers.has('Set-Cookie')).toBe(false);
  });

  it('el fetch usa la referencia del mismo sitio, sin vaciarla; el documento mantiene no-referrer', async () => {
    const respuesta = await proveerRespuestaEntrada(solicitar());
    const html = await respuesta.text();
    expect(respuesta.headers.get('Referrer-Policy')).toBe('no-referrer');
    expect(html).toContain('<meta name="referrer" content="no-referrer">');
    const opciones = /fetch\('\/api\/sesion', \{([\s\S]*?)\n      \}\)/.exec(html)?.[1] ?? '';
    expect(opciones).toContain("method: 'POST'");
    expect(opciones).toContain("mode: 'same-origin'");
    expect(opciones).toContain("credentials: 'same-origin'");
    expect(opciones).toContain("redirect: 'error'");
    expect(opciones).toContain("referrerPolicy: 'same-origin'");
    expect(opciones).not.toMatch(/\breferrer\s*:/);
    expect(html.match(/referrerPolicy:/g)).toHaveLength(1);
  });

  it('CSP defensiva con un nonce propio y distinto en cada respuesta', async () => {
    const [a, b] = await Promise.all([proveerRespuestaEntrada(solicitar()), proveerRespuestaEntrada(solicitar())]);
    const csp = a.headers.get('Content-Security-Policy')!;
    const nonce = nonceDe(a)!;
    expect(nonce).toMatch(/^[A-Za-z0-9+/]{22}==$/);
    expect(nonceDe(b)).not.toBe(nonce);
    const directivas = Object.fromEntries(csp.split(';').map((d) => d.trim().split(/\s+/)).map(([k, ...v]) => [k, v.join(' ')]));
    expect(directivas).toEqual({
      'default-src': "'none'",
      'script-src': `'nonce-${nonce}'`,
      'style-src': `'nonce-${nonce}'`,
      'img-src': 'data:',
      'connect-src': "'self'",
      'form-action': "'self'",
      'base-uri': "'none'",
      'frame-ancestors': "'none'",
      'require-trusted-types-for': "'script'",
    });
    const html = await a.text();
    const etiquetas = html.match(/<(script|style)\b[^>]*>/g) ?? [];
    expect(etiquetas.length).toBeGreaterThanOrEqual(2);
    for (const etiqueta of etiquetas) expect(etiqueta).toContain(` nonce="${nonce}"`);
    // Sin manejadores en línea ni estilos en atributos: la CSP los bloquearía.
    expect(html).not.toMatch(/\son[a-z]+=/i);
    expect(html).not.toMatch(/\sstyle=/i);
  });

  it('es autocontenida: sin URLs externas, hojas, módulos ni recursos del bundle', async () => {
    const html = await (await proveerRespuestaEntrada(solicitar())).text();
    expect(html).not.toMatch(/https?:\/\//);
    expect(html).not.toMatch(/\ssrc=/i);
    expect(html).not.toMatch(/<link\b(?![^>]*href="data:,")/i);
    expect(html).not.toMatch(/type="module"|\bimport\s*\(|@import|url\(/i);
    expect(html).not.toMatch(/assets\/|\.js["']|\.css["']|manifest/i);
  });

  it('solo enseña la puerta: ningún dato del plan antes de entrar', async () => {
    const html = await (await proveerRespuestaEntrada(solicitar())).text();
    for (const privado of ['Shangh', 'Nank', 'Disney', 'hotel', 'vuelo', '¥', 'itinerario.ts', 'marcas']) {
      expect(html).not.toContain(privado);
    }
    expect(html).toContain('<label for="clave">Contraseña del viaje</label>');
    expect(html).toContain('<label for="nombre">Nombre de este móvil');
    expect(html).toMatch(/<button[^>]*type="submit"[^>]*>Entrar<\/button>/);
  });

  it('el formulario no guarda ni expone la contraseña', async () => {
    const html = await (await proveerRespuestaEntrada(solicitar())).text();
    const campo = /<input[^>]*id="clave"[^>]*>/.exec(html)?.[0] ?? '';
    expect(campo).toContain('type="password"');
    expect(campo).toContain('autocomplete="current-password"');
    expect(campo).not.toMatch(/\s(value|name)=/);
    expect(html).not.toMatch(/\svalue=/);
    expect(html).not.toMatch(/sessionStorage/);
    // localStorage solo para la identidad del móvil (escritura) y el tema (lectura).
    expect(html.match(/localStorage\.setItem\(/g)).toHaveLength(1);
    expect(html).toContain(JSON.stringify(CLAVE_IDENTIFICADOR_DISPOSITIVO));
    expect(html).toMatch(/<form[^>]*method="post"[^>]*action="\/entrar"[^>]*novalidate/);
  });

  it('al entrar va siempre a «/», sin redirecciones elegidas por la URL', async () => {
    const html = await (await proveerRespuestaEntrada(solicitar())).text();
    expect(html.match(/location\.replace\(/g)).toHaveLength(1);
    expect(html).toContain("location.replace('/')");
    expect(html).not.toMatch(/location\.(search|hash|href\s*=)|URLSearchParams|returnTo|document\.referrer/);
    expect(html).toContain("fetch('/api/sesion'");
  });

  it('no refleja nada de la solicitud: ni query, ni cabeceras, ni cookie', async () => {
    const base = await proveerRespuestaEntrada(solicitar());
    const hostil = await proveerRespuestaEntrada(solicitar('/entrar?returnTo=https://ajeno.test&clave=secreto-xyz&n=<script>alert(1)</script>', {
      headers: { Cookie: '__Host-itinerario="><script>alert(2)</script>', Referer: 'https://ajeno.test/', 'Accept-Language': '"><b>' },
    }));
    const htmlBase = sinNonce(await base.text(), nonceDe(base)!);
    const htmlHostil = sinNonce(await hostil.text(), nonceDe(hostil)!);
    expect(htmlHostil).toBe(htmlBase);
    expect(htmlHostil).not.toMatch(/ajeno|secreto-xyz|alert\(/);
  });

  it('HEAD responde las mismas cabeceras sin cuerpo', async () => {
    const respuesta = await proveerRespuestaEntrada(solicitar('/entrar', { method: 'HEAD' }));
    expect(respuesta.status).toBe(200);
    expect(respuesta.body).toBeNull();
    expect(respuesta.headers.get('Content-Type')).toBe('text/html; charset=utf-8');
    expect(nonceDe(respuesta)).toBeTruthy();
  });

  it('pasa por el router real: /entrar pública, sin autenticar y sin Set-Cookie', async () => {
    const sesiones = { atender: vi.fn(async () => new Response(null)), autenticar: vi.fn(async () => null) };
    const progreso = { atender: vi.fn(async () => new Response(null)) };
    const assets = { fetch: vi.fn(async () => new Response('privado')) };
    const router = crearRouterViaje({ sesiones, progreso, assets, proveerRespuestaEntrada });
    const respuesta = await router.atender(solicitar('/entrar', { headers: { Accept: 'text/html' } }));
    expect(respuesta.status).toBe(200);
    expect(respuesta.headers.get('Content-Type')).toBe('text/html; charset=utf-8');
    expect(respuesta.headers.get('Content-Security-Policy')).toContain("'nonce-");
    expect(respuesta.headers.has('Set-Cookie')).toBe(false);
    expect(await respuesta.text()).toContain('Contraseña del viaje');
    expect(sesiones.autenticar).not.toHaveBeenCalled();
    expect(assets.fetch).not.toHaveBeenCalled();
    const cabeza = await router.atender(solicitar('/entrar', { method: 'HEAD' }));
    expect(cabeza.status).toBe(200);
    expect(cabeza.body).toBeNull();
  });

  it('la clave de identidad del móvil es española, nueva y no pisa claves antiguas', () => {
    expect(CLAVE_IDENTIFICADOR_DISPOSITIVO).toBe('identificador-dispositivo');
    for (const antigua of ['marcas', 'marcas-hora', 'marcador', 'pendientes-hechos', 'tema', 'mapas-descargados']) {
      expect(CLAVE_IDENTIFICADOR_DISPOSITIVO).not.toBe(antigua);
    }
  });
});
