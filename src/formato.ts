import type { Transporte } from './tipos';

// Los instantes se guardan como minutos desde 1970 tratando la hora de China como si fuera UTC:
// así no dependen de la zona horaria del móvil.

export function aMinutos(fecha: string, hora: string): number {
  const [a, m, d] = fecha.split('-').map(Number);
  const [h, min] = hora.split(':').map(Number);
  return Date.UTC(a, m - 1, d, h, min) / 60000;
}

const aFecha = (min: number) => new Date(min * 60000);
const dos = (n: number) => String(n).padStart(2, '0');

export function hora(min: number): string {
  const f = aFecha(Math.round(min));
  return `${dos(f.getUTCHours())}:${dos(f.getUTCMinutes())}`;
}

const SEMANA = ['dom', 'lun', 'mar', 'mié', 'jue', 'vie', 'sáb'];
const MESES = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic'];

export function fechaCorta(fecha: string): string {
  const f = aFecha(aMinutos(fecha, '00:00'));
  return `${SEMANA[f.getUTCDay()]} ${f.getUTCDate()}`;
}

export function fechaLarga(fecha: string): string {
  const f = aFecha(aMinutos(fecha, '00:00'));
  return `${SEMANA[f.getUTCDay()]} ${f.getUTCDate()} ${MESES[f.getUTCMonth()]}`;
}

/** Fecha y minutos actuales en China. */
export function ahoraEnChina(): { fecha: string; min: number } {
  const f = new Date(Date.now() + 8 * 3600000);
  const fecha = `${f.getUTCFullYear()}-${dos(f.getUTCMonth() + 1)}-${dos(f.getUTCDate())}`;
  return { fecha, min: Math.floor(f.getTime() / 60000) };
}

const numero = (n: number, dec: number) => n.toLocaleString('es-ES', { maximumFractionDigits: dec });

export function km(valor: number): string {
  if (valor < 1) return `${Math.max(10, Math.round(valor * 100) * 10)} m`;
  return `${numero(valor, valor < 10 ? 1 : 0)} km`;
}

export function duracion(min: number): string {
  const m = Math.round(min);
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  return m % 60 ? `${h} h ${m % 60} min` : `${h} h`;
}

export const TRANSPORTE: Record<Transporte, string> = {
  a_pie: 'A pie',
  metro: 'Metro',
  taxi: 'Taxi',
  bus: 'Bus',
  tren: 'Tren',
  maglev: 'Maglev',
  ferry: 'Ferry',
  avion: 'Avión',
  bici: 'Bici',
};

export function esc(texto: string): string {
  return texto.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}
