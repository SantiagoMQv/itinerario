-- Cinco puertos de sesiones, sin limiter, semillas, TTL ni cambios al progreso.
-- Autoridad en columnas tipadas. Metadatos JSON/TEXT opacos: NO extraer valores en SQL;
-- PostgreSQL acepta escapes NUL pero extraerlos como TEXT provocaría 22P05.
CREATE OR REPLACE FUNCTION itinerario.crear_sesion(
  p_id UUID, p_huella TEXT, p_viaje TEXT, p_creada BIGINT, p_vence BIGINT,
  p_revocada BOOLEAN, p_metadatos TEXT
) RETURNS TEXT LANGUAGE plpgsql AS $$
BEGIN
  -- Constraints de 001 son autoridad: UUIDv4, hash, FK, tiempos y objeto JSON completo.
  -- INSERT deliberadamente sin UPSERT: duplicado o FK fallida nunca confirma éxito.
  INSERT INTO itinerario.sesiones
    (sesion_id, huella, viaje_id, creada_en, vence_en, revocada, metadatos_json)
    VALUES (p_id, p_huella, p_viaje, p_creada, p_vence, p_revocada, p_metadatos);
  RETURN '{"tipo":"creada"}';
END
$$;

CREATE OR REPLACE FUNCTION itinerario.leer_sesion(p_huella TEXT, p_viaje TEXT)
RETURNS TEXT LANGUAGE plpgsql AS $$
DECLARE
  sesion itinerario.sesiones%ROWTYPE;
BEGIN
  IF p_huella IS NULL OR p_huella !~ '^[a-f0-9]{64}$' OR p_viaje IS NULL
    OR octet_length(p_viaje) NOT BETWEEN 1 AND 128 THEN
    RAISE EXCEPTION 'No se pudo comprobar la sesión.';
  END IF;
  SELECT * INTO sesion FROM itinerario.sesiones WHERE huella = p_huella AND viaje_id = p_viaje;
  IF NOT FOUND THEN RETURN 'null'; END IF;
  -- Cruda, incluso caducada/revocada: controlador comprueba su reloj DESPUÉS del await.
  RETURN json_build_object('id', sesion.sesion_id, 'huella', sesion.huella,
    'viajeId', sesion.viaje_id, 'creadaEn', sesion.creada_en, 'venceEn', sesion.vence_en,
    'revocada', sesion.revocada, 'metadatosTexto', sesion.metadatos_json)::text;
END
$$;

CREATE OR REPLACE FUNCTION itinerario.revocar_sesion(p_huella TEXT, p_viaje TEXT)
RETURNS TEXT LANGUAGE plpgsql AS $$
BEGIN
  IF p_huella IS NULL OR p_huella !~ '^[a-f0-9]{64}$' OR p_viaje IS NULL
    OR octet_length(p_viaje) NOT BETWEEN 1 AND 128 THEN
    RAISE EXCEPTION 'No se pudo comprobar la sesión.';
  END IF;
  -- Logout por huella de cookie verificada; no es un segundo permiso basado en el cuerpo.
  -- Ausente/revocada/caducada son idempotentes. Nunca se bloquea ni actualiza el viaje.
  UPDATE itinerario.sesiones SET revocada = true
    WHERE huella = p_huella AND viaje_id = p_viaje AND NOT revocada;
  RETURN '{"tipo":"revocada"}';
END
$$;

CREATE OR REPLACE FUNCTION itinerario.listar_sesiones(p_huella TEXT, p_viaje TEXT)
RETURNS TEXT LANGUAGE plpgsql AS $$
DECLARE
  actor itinerario.sesiones%ROWTYPE;
  filas JSON;
BEGIN
  IF p_huella IS NULL OR p_huella !~ '^[a-f0-9]{64}$' OR p_viaje IS NULL
    OR octet_length(p_viaje) NOT BETWEEN 1 AND 128 THEN
    RAISE EXCEPTION 'No se pudo comprobar la sesión.';
  END IF;
  -- Solo actor SHARE; retenido hasta fin del statement/transacción. No locks del viaje.
  SELECT * INTO actor FROM itinerario.sesiones
    WHERE huella = p_huella AND viaje_id = p_viaje FOR SHARE;
  IF NOT FOUND OR actor.revocada
    OR actor.vence_en <= floor(extract(epoch FROM clock_timestamp()) * 1000)::bigint THEN
    RETURN '{"tipo":"sin-sesion"}';
  END IF;
  SELECT coalesce(json_agg(json_build_object('id', sesion_id, 'huella', huella,
    'viajeId', viaje_id, 'creadaEn', creada_en, 'venceEn', vence_en,
    'revocada', revocada, 'metadatosTexto', metadatos_json) ORDER BY sesion_id), '[]'::json)
    INTO filas FROM itinerario.sesiones WHERE viaje_id = p_viaje;
  -- Todas las filas: sin filtro/límite que esconda corrupción. Worker valida antes de publicar.
  -- Revalidación al final, no tiempo de inicio de transacción ni argumento del navegador.
  IF actor.vence_en <= floor(extract(epoch FROM clock_timestamp()) * 1000)::bigint THEN
    RETURN '{"tipo":"sin-sesion"}';
  END IF;
  RETURN json_build_object('tipo', 'lista', 'sesiones', filas)::text;
END
$$;

CREATE OR REPLACE FUNCTION itinerario.revocar_otra_sesion(p_huella TEXT, p_viaje TEXT, p_objetivo UUID)
RETURNS TEXT LANGUAGE plpgsql AS $$
DECLARE
  actor_id UUID;
  actor itinerario.sesiones%ROWTYPE;
  fila itinerario.sesiones%ROWTYPE;
  objetivo_existe BOOLEAN := false;
BEGIN
  IF p_huella IS NULL OR p_huella !~ '^[a-f0-9]{64}$' OR p_viaje IS NULL
    OR octet_length(p_viaje) NOT BETWEEN 1 AND 128 OR p_objetivo IS NULL
    OR p_objetivo::text !~ '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' THEN
    RAISE EXCEPTION 'No se pudo comprobar la sesión.';
  END IF;
  -- Resolver UUID no autoriza: la autoridad se relee bajo los locks siguientes.
  SELECT sesion_id INTO actor_id FROM itinerario.sesiones
    WHERE huella = p_huella AND viaje_id = p_viaje;
  IF NOT FOUND THEN RETURN '{"tipo":"sin-sesion"}'; END IF;
  -- Bloquear AMBAS filas antes de validar. UUID tipado, no collation/locale ni actor primero.
  -- Evita actor Share→target Update al cruzar A/B. Self bloquea una sola fila.
  -- Objetivo ajeno no entra ni se bloquea. Sin locks de viaje/counter: compatible con
  -- progreso sesión SHARE→viaje UPDATE, sin invertir esa jerarquía.
  FOR fila IN SELECT * FROM itinerario.sesiones
    WHERE viaje_id = p_viaje AND (sesion_id = actor_id OR sesion_id = p_objetivo)
    ORDER BY sesion_id FOR UPDATE
  LOOP
    IF fila.sesion_id = actor_id THEN actor := fila; END IF;
    IF fila.sesion_id = p_objetivo THEN objetivo_existe := true; END IF;
  END LOOP;
  -- clock_timestamp DESPUÉS de TODAS las esperas. La lectura previa HTTP no concede permiso.
  IF actor.sesion_id IS NULL OR actor.huella <> p_huella OR actor.viaje_id <> p_viaje
    OR actor.revocada OR actor.vence_en <= floor(extract(epoch FROM clock_timestamp()) * 1000)::bigint THEN
    RETURN '{"tipo":"sin-sesion"}';
  END IF;
  IF NOT objetivo_existe THEN RETURN '{"tipo":"ausente"}'; END IF;
  UPDATE itinerario.sesiones SET revocada = true
    WHERE sesion_id = p_objetivo AND viaje_id = p_viaje AND NOT revocada;
  RETURN '{"tipo":"revocada"}';
END
$$;
