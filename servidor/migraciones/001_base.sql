-- Base dedicada. Sin semilla implícita: T7 insertará crearProgreso serializado como TEXT.
-- Reaplicar esta migración no reinicia datos ni decisiones; no altera tablas preexistentes.
CREATE SCHEMA IF NOT EXISTS itinerario;

CREATE TABLE IF NOT EXISTS itinerario.viajes (
  id TEXT PRIMARY KEY CHECK (octet_length(id) BETWEEN 1 AND 128),
  revision_servidor BIGINT NOT NULL CHECK (revision_servidor BETWEEN 0 AND 9007199254740991),
  estado_json TEXT NOT NULL CHECK (json_typeof(estado_json::json) = 'object')
);

-- La identidad de dispositivo es metadato opaco, NO autoridad. Nunca guardar token/contraseña.
-- JSON (no JSONB) acepta escapes NUL; NO extraer sus campos en SQL: reconstruir DTO en Worker.
CREATE TABLE IF NOT EXISTS itinerario.sesiones (
  sesion_id UUID PRIMARY KEY CHECK (sesion_id::text ~ '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'),
  huella TEXT NOT NULL UNIQUE CHECK (huella ~ '^[0-9a-f]{64}$'),
  viaje_id TEXT NOT NULL REFERENCES itinerario.viajes(id),
  creada_en BIGINT NOT NULL CHECK (creada_en BETWEEN 0 AND 9007199254740991),
  vence_en BIGINT NOT NULL CHECK (vence_en BETWEEN 0 AND 9007199254740991 AND vence_en > creada_en),
  revocada BOOLEAN NOT NULL,
  metadatos_json TEXT NOT NULL CHECK (json_typeof(metadatos_json::json) = 'object')
);
CREATE INDEX IF NOT EXISTS sesiones_por_viaje ON itinerario.sesiones(viaje_id);

-- Un único ID por viaje excluye positivo/negativo simultáneo y retiene DTO histórico completo.
CREATE TABLE IF NOT EXISTS itinerario.decisiones (
  viaje_id TEXT NOT NULL REFERENCES itinerario.viajes(id),
  operacion_id TEXT NOT NULL CHECK (octet_length(operacion_id) BETWEEN 1 AND 128),
  tipo TEXT NOT NULL CHECK (tipo IN ('positiva', 'negativa')),
  revision_servidor BIGINT NOT NULL CHECK (revision_servidor BETWEEN 1 AND 9007199254740991),
  decision_json TEXT NOT NULL CHECK (json_typeof(decision_json::json) = 'object'),
  PRIMARY KEY (viaje_id, operacion_id)
);
