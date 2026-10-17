import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// Contratos estáticos del HTML y CSS reales: no sustituyen geometría ni gestos en un navegador.
const estilos = readFileSync(new URL('../src/estilos.css', import.meta.url), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
const interfaz = readFileSync(new URL('../src/main.ts', import.meta.url), 'utf8');

function regla(selector: string): Record<string, string> {
  const declaraciones: Record<string, string> = {};
  for (const coincidencia of estilos.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    if (!coincidencia[1]!.split(',').some((s) => s.trim() === selector)) continue;
    for (const declaracion of coincidencia[2]!.split(';')) {
      const separador = declaracion.indexOf(':');
      if (separador >= 0) declaraciones[declaracion.slice(0, separador).trim()] = declaracion.slice(separador + 1).trim();
    }
  }
  return declaraciones;
}

function contraste(a: string, b: string): number {
  const luminancia = (color: string) => {
    expect(color).toMatch(/^#[\da-f]{6}$/i);
    const canales = [1, 3, 5].map((i) => {
      const canal = parseInt(color.slice(i, i + 2), 16) / 255;
      return canal <= 0.04045 ? canal / 12.92 : ((canal + 0.055) / 1.055) ** 2.4;
    });
    return canales[0]! * 0.2126 + canales[1]! * 0.7152 + canales[2]! * 0.0722;
  };
  const valores = [luminancia(a), luminancia(b)].sort((x, y) => y - x);
  return (valores[0]! + 0.05) / (valores[1]! + 0.05);
}

function cuerpo(nombre: string, siguiente: string): string {
  const inicio = interfaz.indexOf(`function ${nombre}(`);
  const fin = interfaz.indexOf(`function ${siguiente}(`, inicio);
  expect(inicio).toBeGreaterThanOrEqual(0);
  expect(fin).toBeGreaterThan(inicio);
  return interfaz.slice(inicio, fin);
}

describe('Uso móvil: contratos de lectura y acceso', () => {
  it.each(['claro', 'oscuro'])('mantiene contraste AA en el detalle del trayecto actual: %s', (tema) => {
    const tokens = { ...regla(':root'), ...(tema === 'oscuro' ? regla(":root[data-tema='oscuro']") : {}) };
    const color = regla('li.tramo.actual small').color ?? regla('li.tramo.actual').color;
    const variable = color?.match(/^var\((--[\w-]+)\)$/)?.[1];
    expect(variable).toBeTruthy();
    expect(contraste(tokens[variable!]!, tokens['--papel']!)).toBeGreaterThanOrEqual(4.5);
    // El rótulo fluorescente y los avisos conservan su tinta propia, no la del padre.
    expect(regla('li.tramo.actual .via').color).toBe('var(--tinta-fija)');
    expect(regla('.apretado').color).toBe('var(--aviso)');
    expect(contraste(tokens['--tinta-fija']!, tokens['--fluor']!)).toBeGreaterThanOrEqual(4.5);
    expect(contraste(tokens['--aviso']!, tokens['--papel']!)).toBeGreaterThanOrEqual(4.5);
  });

  it('indica dentro del botón Ahora que abre los detalles y conserva foco y área táctil', () => {
    const ahora = cuerpo('bloqueAhora', 'lineaSubs');
    const boton = ahora.match(/<button\b[^>]*data-abrir=[\s\S]*?<\/button>/)?.[0];
    expect(boton).toContain('<span class="pista-detalles">Ver detalles</span>');
    expect(Number.parseFloat(regla('.bloque .abrir')['min-height']!)).toBeGreaterThanOrEqual(44);
    expect(regla('.pista-detalles').display).not.toBe('none');
    expect(regla(':focus-visible').outline).toContain('solid');
  });

  it('ofrece cámara, taxi y mapas antes de fotos y notas sin duplicar los controles', () => {
    const ficha = cuerpo('filaParada', 'botonEnsenar');
    const camara = ficha.indexOf('botonCamara(p)');
    const taxi = ficha.indexOf('botonEnsenar(p)');
    const mapas = ficha.indexOf('enlacesMapas(p)');
    const fotos = ficha.indexOf('fotosUi.html(');
    const notas = ficha.indexOf('parrafos(q.notas');
    expect(camara).toBeGreaterThan(0);
    expect(taxi).toBeGreaterThan(camara);
    expect(mapas).toBeGreaterThan(taxi);
    expect(fotos).toBeGreaterThan(mapas);
    expect(notas).toBeGreaterThan(fotos);
    expect(ficha.indexOf('selectorMarca(p)')).toBeGreaterThan(notas);
    expect(ficha.match(/enlacesMapas\(p\)/g)).toHaveLength(1);
    expect(ficha.match(/botonEnsenar\(p\)/g)).toHaveLength(1);
    expect(regla('.acciones')['flex-wrap']).toBe('wrap');
    expect(regla('.boton')['min-height']).toBe('44px');
  });

  it('amplía a 44 px el deslizador sin mover la aguja ni cambiar su contrato táctil', () => {
    const deslizador = regla('#deslizador');
    const pista = regla('#deslizador::-webkit-slider-runnable-track');
    const aguja = regla('#deslizador::-webkit-slider-thumb');
    expect(Number.parseFloat(deslizador.height!)).toBeGreaterThanOrEqual(44);
    expect(pista.height).toBe(deslizador.height);
    expect(Number.parseFloat(deslizador.top!) + Number.parseFloat(aguja['margin-top']!) + Number.parseFloat(aguja.height!) / 2).toBe(20);
    expect(deslizador['touch-action']).toBe('none');
  });
});
