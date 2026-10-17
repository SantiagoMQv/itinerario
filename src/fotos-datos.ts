/** Una elección de datos para todas las transferencias de fotos; nunca intenta adivinar si hay wifi. */
export const MODOS_FOTOS = { ahorro: 'ahorro', ilimitados: 'ilimitados' } as const;
export type ModoFotos = typeof MODOS_FOTOS[keyof typeof MODOS_FOTOS];
export interface AlmacenPreferenciaFotos { getItem(clave: string): string | null; setItem(clave: string, valor: string): void }
export function crearPoliticaFotos(almacen: AlmacenPreferenciaFotos | null, alCambiar: () => void = () => {}) {
  const clave = 'fotos-datos';
  let modo: ModoFotos = MODOS_FOTOS.ahorro;
  try { if (almacen?.getItem(clave) === MODOS_FOTOS.ilimitados) modo = MODOS_FOTOS.ilimitados; } catch { /* Ahorro seguro. */ }
  let visible = true;
  let temporal = false;
  return {
    get modo() { return modo; },
    get permitida() { return visible && (temporal || modo === MODOS_FOTOS.ilimitados); },
    get automatica() { return visible && modo === MODOS_FOTOS.ilimitados; },
    elegir(nuevo: ModoFotos) {
      modo = nuevo; temporal = false;
      try { almacen?.setItem(clave, modo); } catch { /* La elección sigue vigente en esta sesión. */ }
      alCambiar();
    },
    permitirTemporal() { temporal = true; alCambiar(); },
    suspender() { visible = false; temporal = false; alCambiar(); },
    reanudar() { visible = true; alCambiar(); },
  };
}
