// Las filas siguen siendo desconocidas hasta validarlas en la frontera de dominio.
export interface ResultadoSql {
  readonly filas: readonly unknown[];
}

// El adaptador debe enviar los valores separados del texto SQL, sin interpolarlos.
export interface EjecutorSql {
  ejecutar(consulta: string, parametros: readonly unknown[]): Promise<ResultadoSql>;
}

// Contrato estructural mínimo para el futuro vínculo ASSETS, sin tipos de la app.
export interface VinculoAssets {
  fetch(solicitud: Request): Promise<Response>;
}
