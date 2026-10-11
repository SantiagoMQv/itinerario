-- Bucket global por hash derivado en servidor de viaje e identidad de red confiable.
-- Antes de autenticar: no exige sesión ni modifica viajes, progreso o decisiones.
CREATE TABLE IF NOT EXISTS itinerario.intentos_sesion (
  huella_origen TEXT PRIMARY KEY CHECK (octet_length(huella_origen) = 64 AND huella_origen ~ '^[0-9a-f]{64}$'),
  inicio_en BIGINT NOT NULL CHECK (inicio_en BETWEEN 0 AND 9007199254740991),
  intentos INTEGER NOT NULL CHECK (intentos BETWEEN 1 AND 10)
);

CREATE OR REPLACE FUNCTION itinerario.admitir_intento(p_huella TEXT, p_ahora BIGINT)
RETURNS TEXT LANGUAGE plpgsql AS $$
DECLARE
  bucket itinerario.intentos_sesion%ROWTYPE;
BEGIN
  IF p_huella IS NULL OR octet_length(p_huella) <> 64 OR p_huella !~ '^[0-9a-f]{64}$' OR p_ahora IS NULL
    OR p_ahora NOT BETWEEN 0 AND 9007199254740991 THEN
    RAISE EXCEPTION 'No se pudo comprobar la sesión.';
  END IF;
  -- La PK serializa también el primer acceso: únicamente el INSERT ganador admite.
  INSERT INTO itinerario.intentos_sesion (huella_origen, inicio_en, intentos)
    VALUES (p_huella, p_ahora, 1) ON CONFLICT DO NOTHING RETURNING * INTO bucket;
  IF FOUND THEN RETURN 'true'; END IF;
  SELECT * INTO bucket FROM itinerario.intentos_sesion
    WHERE huella_origen = p_huella FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'No se pudo comprobar la sesión.'; END IF;
  -- Política conservadora explícita: regresión siempre deniega, sin escribir/reiniciar.
  IF p_ahora < bucket.inicio_en THEN RETURN 'false'; END IF;
  -- Ambos operandos son BIGINT acotados: resta segura, sin sumar al límite MAX_SAFE.
  IF p_ahora - bucket.inicio_en >= 600000 THEN
    UPDATE itinerario.intentos_sesion SET inicio_en = p_ahora, intentos = 1
      WHERE huella_origen = p_huella;
    RETURN 'true';
  END IF;
  IF bucket.intentos = 10 THEN RETURN 'false'; END IF;
  UPDATE itinerario.intentos_sesion SET intentos = intentos + 1 WHERE huella_origen = p_huella;
  RETURN 'true';
END
$$;
