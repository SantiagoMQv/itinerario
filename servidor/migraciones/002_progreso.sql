-- Todos los payloads de dominio son JSON/TEXT: nunca JSONB ni normalización de -0.
-- Helpers estructurales, no motor de negocio ni intérprete de firma.
CREATE OR REPLACE FUNCTION itinerario.campos_json(objeto JSON, requeridos TEXT[], opcionales TEXT[] DEFAULT '{}')
RETURNS BOOLEAN LANGUAGE SQL IMMUTABLE AS $$
  SELECT CASE WHEN json_typeof(objeto) = 'object' THEN
    (SELECT count(*) = count(DISTINCT clave)
      AND coalesce(bool_and(clave = ANY(requeridos || opcionales)), true)
      FROM json_object_keys(objeto) AS claves(clave))
    AND NOT EXISTS (SELECT 1 FROM unnest(requeridos) AS claves(clave) WHERE objeto->clave IS NULL)
  ELSE false END
$$;
CREATE OR REPLACE FUNCTION itinerario.contador_json(valor JSON)
RETURNS BOOLEAN LANGUAGE SQL IMMUTABLE AS $$
  SELECT CASE WHEN json_typeof(valor) = 'number' AND valor::text ~ '^(-0|[0-9]+)$'
    THEN valor::text::numeric BETWEEN 0 AND 9007199254740991 ELSE false END
$$;
CREATE OR REPLACE FUNCTION itinerario.identidad_json(valor JSON)
RETURNS BOOLEAN LANGUAGE SQL IMMUTABLE AS $$
  SELECT json_typeof(valor) = 'string' AND octet_length(valor#>>'{}') BETWEEN 1 AND 128
$$;

CREATE OR REPLACE FUNCTION itinerario.consultar_progreso(p_huella TEXT, p_viaje TEXT, p_operacion TEXT DEFAULT NULL)
RETURNS TEXT LANGUAGE plpgsql AS $$
DECLARE
  sesion itinerario.sesiones%ROWTYPE;
  viaje itinerario.viajes%ROWTYPE;
  decision JSON;
BEGIN
  IF p_huella IS NULL OR p_huella !~ '^[a-f0-9]{64}$' OR p_viaje IS NULL
    OR octet_length(p_viaje) NOT BETWEEN 1 AND 128
    OR (p_operacion IS NOT NULL AND octet_length(p_operacion) NOT BETWEEN 1 AND 128) THEN
    RAISE EXCEPTION 'No se pudo comprobar el progreso.';
  END IF;
  -- Orden fijo sesión SHARE -> viaje SHARE. Solo el actor autorizado consulta historia.
  SELECT * INTO sesion FROM itinerario.sesiones WHERE huella = p_huella FOR SHARE;
  IF NOT FOUND OR sesion.viaje_id <> p_viaje OR sesion.revocada
    OR sesion.vence_en <= floor(extract(epoch FROM clock_timestamp()) * 1000)::bigint THEN
    RETURN '{"tipo":"sin-sesion"}';
  END IF;
  SELECT * INTO viaje FROM itinerario.viajes WHERE id = p_viaje FOR SHARE;
  IF NOT FOUND THEN RAISE EXCEPTION 'No se pudo comprobar el progreso.'; END IF;
  IF p_operacion IS NOT NULL THEN
    SELECT decision_json::json INTO decision FROM itinerario.decisiones
      WHERE viaje_id = p_viaje AND operacion_id = p_operacion;
  END IF;
  -- clock_timestamp, no reloj de inicio de transacción: revalidar después de esperas.
  IF sesion.huella <> p_huella OR sesion.viaje_id <> p_viaje OR sesion.revocada
    OR sesion.vence_en <= floor(extract(epoch FROM clock_timestamp()) * 1000)::bigint THEN
    RETURN '{"tipo":"sin-sesion"}';
  END IF;
  RETURN json_build_object('tipo', 'lectura', 'instantanea', json_build_object(
    'revisionServidor', viaje.revision_servidor, 'estado', viaje.estado_json::json), 'decision', decision)::text;
END
$$;

CREATE OR REPLACE FUNCTION itinerario.confirmar_progreso(p_huella TEXT, p_viaje TEXT, p_base BIGINT, p_candidato TEXT)
RETURNS TEXT LANGUAGE plpgsql AS $$
DECLARE
  sesion itinerario.sesiones%ROWTYPE;
  viaje itinerario.viajes%ROWTYPE;
  candidato JSON;
  dto JSON;
  original JSON;
  instantanea JSON;
  estado JSON;
  estado_texto TEXT;
  operacion TEXT;
  tipo TEXT;
BEGIN
  IF p_huella IS NULL OR p_huella !~ '^[a-f0-9]{64}$' OR p_viaje IS NULL
    OR octet_length(p_viaje) NOT BETWEEN 1 AND 128 OR p_base IS NULL
    OR p_base NOT BETWEEN 0 AND 9007199254740991 OR p_candidato IS NULL THEN
    RAISE EXCEPTION 'No se pudo comprobar el progreso.';
  END IF;
  -- SHARE impide revocación concurrente; UPDATE serializa CAS del viaje en este statement.
  SELECT * INTO sesion FROM itinerario.sesiones WHERE huella = p_huella FOR SHARE;
  IF NOT FOUND OR sesion.viaje_id <> p_viaje OR sesion.revocada
    OR sesion.vence_en <= floor(extract(epoch FROM clock_timestamp()) * 1000)::bigint THEN
    RETURN '{"tipo":"sin-sesion"}';
  END IF;
  SELECT * INTO viaje FROM itinerario.viajes WHERE id = p_viaje FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'No se pudo comprobar el progreso.'; END IF;
  IF sesion.huella <> p_huella OR sesion.viaje_id <> p_viaje OR sesion.revocada
    OR sesion.vence_en <= floor(extract(epoch FROM clock_timestamp()) * 1000)::bigint THEN
    RETURN '{"tipo":"sin-sesion"}';
  END IF;
  IF viaje.revision_servidor <> p_base THEN RETURN '{"tipo":"desfase"}'; END IF;
  IF p_base = 9007199254740991 THEN RAISE EXCEPTION 'El progreso alcanzó su capacidad.'; END IF;

  candidato := p_candidato::json;
  tipo := candidato->>'tipo';
  IF tipo = 'positiva' AND itinerario.campos_json(candidato, ARRAY['tipo','operacionOriginal','acuse']) THEN
    dto := candidato->'acuse'; original := candidato->'operacionOriginal';
    IF NOT coalesce(itinerario.campos_json(dto, ARRAY['operacionId','persistida','instantanea'])
      AND (dto->'persistida')::text = 'true', false) THEN
      RAISE EXCEPTION 'No se pudo comprobar el progreso.';
    END IF;
  ELSIF tipo = 'negativa' AND itinerario.campos_json(candidato, ARRAY['tipo','rechazo']) THEN
    dto := candidato->'rechazo'; original := dto->'operacionOriginal';
    IF NOT coalesce(itinerario.campos_json(dto, ARRAY['viajeId','protocolo','operacionId','operacionOriginal',
        'decisionPersistida','motivo','instantanea']) AND json_typeof(dto->'viajeId') = 'string'
      AND dto->>'viajeId' = p_viaje AND (dto->'protocolo')::text = '1'
      AND (dto->'decisionPersistida')::text = 'true' AND dto->>'motivo' IN ('conflicto','invalida'), false) THEN
      RAISE EXCEPTION 'No se pudo comprobar el progreso.';
    END IF;
  ELSE RAISE EXCEPTION 'No se pudo comprobar el progreso.';
  END IF;
  instantanea := dto->'instantanea'; estado := instantanea->'estado';
  IF NOT coalesce(itinerario.identidad_json(dto->'operacionId')
    AND itinerario.identidad_json(original->'id') AND itinerario.identidad_json(original->'dispositivoId')
    AND dto->>'operacionId' = original->>'id' AND original->>'tipo' IN ('parada','pendiente','deshacer')
    AND itinerario.campos_json(instantanea, ARRAY['revisionServidor','estado'])
    AND itinerario.contador_json(instantanea->'revisionServidor')
    AND (instantanea->>'revisionServidor')::numeric = p_base + 1
    AND itinerario.campos_json(estado, ARRAY['viajeId','paradas','pendientes','aqui','operaciones'])
    AND json_typeof(estado->'viajeId') = 'string' AND estado->>'viajeId' = p_viaje
    AND json_typeof(estado->'paradas') = 'object' AND json_typeof(estado->'pendientes') = 'object'
    AND json_typeof(estado->'aqui') = 'object' AND json_typeof(estado->'operaciones') = 'object', false) THEN
    RAISE EXCEPTION 'No se pudo comprobar el progreso.';
  END IF;
  -- Solo forma original; los guards/core JS validan catálogo, precondiciones y resultado.
  IF NOT coalesce(CASE original->>'tipo'
    WHEN 'parada' THEN itinerario.campos_json(original, ARRAY['id','dispositivoId','tipo','paradaId','marca','revision'], ARRAY['horaReal','revisionAqui','revisionAnterior'])
      AND itinerario.identidad_json(original->'paradaId') AND itinerario.contador_json(original->'revision')
      AND ((original->'marca')::text = 'null' OR original->>'marca' IN ('hecha','saltada','aqui'))
      AND (original->'horaReal' IS NULL OR (json_typeof(original->'horaReal') = 'number' AND (original->'marca')::text <> 'null'))
      AND (original->'revisionAqui' IS NULL OR itinerario.contador_json(original->'revisionAqui'))
      AND (original->'revisionAnterior' IS NULL OR itinerario.contador_json(original->'revisionAnterior'))
    WHEN 'pendiente' THEN itinerario.campos_json(original, ARRAY['id','dispositivoId','tipo','pendienteId','hecho','revision'])
      AND itinerario.identidad_json(original->'pendienteId') AND itinerario.contador_json(original->'revision')
      AND json_typeof(original->'hecho') = 'boolean'
    WHEN 'deshacer' THEN itinerario.campos_json(original, ARRAY['id','dispositivoId','tipo','cambios'])
      AND json_typeof(original->'cambios') = 'object'
    ELSE false END, false) THEN RAISE EXCEPTION 'No se pudo comprobar el progreso.'; END IF;
  operacion := dto->>'operacionId';
  IF EXISTS (SELECT 1 FROM itinerario.decisiones WHERE viaje_id = p_viaje AND operacion_id = operacion) THEN
    RETURN '{"tipo":"desfase"}';
  END IF;
  -- -> JSON conserva texto lexical (incluido -0). Nunca interpretar la firma del recibo.
  estado_texto := estado::text;
  IF tipo = 'positiva' THEN
    IF NOT coalesce(json_typeof(estado->'operaciones'->operacion) = 'object'
      AND json_typeof(estado->'operaciones'->operacion->'firma') = 'string', false) THEN
      RAISE EXCEPTION 'No se pudo comprobar el progreso.';
    END IF;
  ELSE
    IF estado_texto <> viaje.estado_json OR estado->'operaciones'->operacion IS NOT NULL THEN
      RAISE EXCEPTION 'No se pudo comprobar el progreso.';
    END IF;
    estado_texto := viaje.estado_json; -- Negativo: preservar EXACTAMENTE la raíz, sin recibo positivo.
  END IF;
  -- Último control antes del DML. Locks siguen vigentes hasta compromiso del statement.
  IF sesion.vence_en <= floor(extract(epoch FROM clock_timestamp()) * 1000)::bigint THEN
    RETURN '{"tipo":"sin-sesion"}';
  END IF;
  INSERT INTO itinerario.decisiones(viaje_id, operacion_id, tipo, revision_servidor, decision_json)
    VALUES (p_viaje, operacion, tipo, p_base + 1, p_candidato);
  UPDATE itinerario.viajes SET revision_servidor = p_base + 1, estado_json = estado_texto WHERE id = p_viaje;
  -- Una excepción posterior revierte también ambas escrituras. El driver espera commit para responder.
  IF sesion.vence_en <= floor(extract(epoch FROM clock_timestamp()) * 1000)::bigint THEN
    RAISE EXCEPTION 'No se pudo comprobar el progreso.';
  END IF;
  RETURN '{"tipo":"comprometida"}';
END
$$;
