-- Adición independiente de SQL005: sin tablas, índices, DML o normalización de metadata.
-- SHARE sesión -> viaje excluye escritores legítimos005 durante preflight/prueba.
-- No es aislamiento ante SQL privilegiado ni un snapshot durable entre páginas.
CREATE OR REPLACE FUNCTION itinerario.listar_fotos_confirmadas(
  p_huella TEXT, p_viaje TEXT, p_despues_de TEXT, p_hasta TEXT,
  p_max_filas INTEGER, p_max_operaciones INTEGER, p_max_bytes_sql BIGINT)
RETURNS TEXT LANGUAGE plpgsql VOLATILE AS $$
DECLARE
  superior TEXT;
  fila RECORD;
  fotos TEXT[] := ARRAY[]::TEXT[];
  reservas TEXT[] := ARRAY[]::TEXT[];
  cantidad BIGINT;
  consulta TEXT;
  elemento TEXT;
  candidatas TEXT := '';
  respuesta TEXT;
  minimo BIGINT;
  i INTEGER;
BEGIN
  IF p_huella IS NULL OR p_huella !~ '^[a-f0-9]{64}$'
    OR p_viaje IS NULL OR octet_length(p_viaje) NOT BETWEEN 1 AND 128
    OR p_max_filas IS NULL OR p_max_filas NOT BETWEEN 1 AND 8
    OR p_max_operaciones IS NULL OR p_max_operaciones NOT BETWEEN 1 AND 64
    OR p_max_bytes_sql IS NULL OR p_max_bytes_sql NOT BETWEEN 1 AND 9007199254740991
    OR (p_despues_de IS NULL) <> (p_hasta IS NULL) THEN
    RAISE EXCEPTION 'No se pudo comprobar el listado de fotos.';
  END IF;
  minimo := 4096 + (p_max_filas::bigint + 1) * (2379224 + 1);
  IF p_max_bytes_sql < minimo THEN RAISE EXCEPTION 'No se pudo comprobar el listado de fotos.'; END IF;
  IF p_despues_de IS NOT NULL AND (
    p_despues_de !~* '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
    OR p_hasta !~* '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
    OR NOT (p_despues_de COLLATE "C" < p_hasta COLLATE "C")) THEN
    RAISE EXCEPTION 'No se pudo comprobar el listado de fotos.';
  END IF;
  PERFORM 1 FROM itinerario.sesiones WHERE huella = p_huella FOR SHARE;
  IF NOT FOUND OR NOT itinerario.fotos_sesion_vigente(p_huella,p_viaje) THEN RETURN '{"tipo":"sin-sesion"}'; END IF;
  PERFORM 1 FROM itinerario.viajes WHERE id = p_viaje FOR SHARE;
  IF NOT FOUND THEN RAISE EXCEPTION 'No se pudo comprobar el listado de fotos.'; END IF;
  IF NOT itinerario.fotos_sesion_vigente(p_huella,p_viaje) THEN RETURN '{"tipo":"sin-sesion"}'; END IF;

  IF p_hasta IS NULL THEN
    SELECT max(r.foto_id COLLATE "C") INTO superior FROM itinerario.fotos_reservas r
      WHERE r.viaje_id = p_viaje AND EXISTS (SELECT 1 FROM itinerario.fotos_operaciones o
        WHERE o.viaje_id = r.viaje_id AND o.foto_id = r.foto_id AND o.reserva_id = r.reserva_id
          AND o.recibo_canonico IS NOT NULL);
  ELSE superior := p_hasta;
  END IF;
  -- Locator NO prueba: sólo selecciona escalares, nunca navega INITIAL/recibo JSON.
  FOR fila IN SELECT r.foto_id,r.reserva_id,r.clave_objeto FROM itinerario.fotos_reservas r
    WHERE r.viaje_id = p_viaje AND r.foto_id COLLATE "C" <= superior COLLATE "C"
      AND (p_despues_de IS NULL OR r.foto_id COLLATE "C" > p_despues_de COLLATE "C")
      AND EXISTS (SELECT 1 FROM itinerario.fotos_operaciones o WHERE o.viaje_id = r.viaje_id
        AND o.foto_id = r.foto_id AND o.reserva_id = r.reserva_id AND o.recibo_canonico IS NOT NULL)
    ORDER BY r.foto_id COLLATE "C" LIMIT p_max_filas + 1 LOOP
    IF octet_length(fila.clave_objeto) > 466 THEN RAISE EXCEPTION 'No se pudo comprobar el listado de fotos.'; END IF;
    -- TODAS las operaciones, incluido NULL y lookahead. LIMIT K+1 antes de count.
    SELECT count(*) INTO cantidad FROM (SELECT 1 FROM itinerario.fotos_operaciones o
      WHERE o.viaje_id = p_viaje AND o.foto_id = fila.foto_id AND o.reserva_id = fila.reserva_id
      LIMIT p_max_operaciones + 1) acotadas;
    IF cantidad > p_max_operaciones THEN RAISE EXCEPTION 'No se pudo comprobar el listado de fotos.'; END IF;
    fotos := array_append(fotos,fila.foto_id);
    reservas := array_append(reservas,fila.reserva_id);
  END LOOP;
  -- Ninguna prueba empieza hasta terminar TODOS los prechecks.
  IF cardinality(fotos) > 0 THEN
    FOR i IN 1..cardinality(fotos) LOOP
      consulta := itinerario.consultar_foto(p_huella,p_viaje,fotos[i]);
      IF consulta = '{"tipo":"sin-sesion"}' THEN RETURN consulta; END IF;
      IF consulta IS NULL OR consulta = '{"tipo":"ausente"}' OR octet_length(consulta) > 396490 THEN
        RAISE EXCEPTION 'No se pudo comprobar el listado de fotos.';
      END IF;
      elemento := json_build_object('fotoId',fotos[i],'consultaCanonica',consulta)::text;
      IF octet_length(elemento) > 2379224 THEN RAISE EXCEPTION 'No se pudo comprobar el listado de fotos.'; END IF;
      candidatas := candidatas || CASE WHEN i > 1 THEN ',' ELSE '' END || elemento;
      IF octet_length(candidatas) > p_max_bytes_sql THEN RAISE EXCEPTION 'No se pudo comprobar el listado de fotos.'; END IF;
    END LOOP;
  END IF;
  respuesta := '{"tipo":"pagina","hasta":' || coalesce(to_json(superior)::text,'null')
    || ',"candidatas":[' || candidatas || ']}';
  IF octet_length(respuesta) > p_max_bytes_sql OR octet_length(respuesta) > minimo THEN
    RAISE EXCEPTION 'No se pudo comprobar el listado de fotos.';
  END IF;
  -- Reloj fresco DESPUÉS de construir y medir todo: nunca página parcial.
  IF NOT itinerario.fotos_sesion_vigente(p_huella,p_viaje) THEN RETURN '{"tipo":"sin-sesion"}'; END IF;
  RETURN respuesta;
END
$$;
