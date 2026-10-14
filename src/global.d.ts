/** Fecha (ISO) en que se publicó esta versión del plan. La pone Vite al compilar. */
declare const __PLAN__: string;

/** Datos crudos del perfil que el montaje privado (vite.config.privado.ts) pone en su build: desconocidos hasta validarlos. */
declare module 'virtual:perfil-privado' {
  const datos: unknown;
  export default datos;
}
