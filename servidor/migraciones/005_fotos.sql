-- Metadata únicamente. Sin bytes, lease, propietario, contador o testigo de objeto.
-- Reaplicar preserva todas las filas; las funciones pertenecen exclusivamente a SQL005.
CREATE TABLE IF NOT EXISTS itinerario.fotos_reservas (
  viaje_id TEXT COLLATE "C" NOT NULL REFERENCES itinerario.viajes(id),
  foto_id TEXT COLLATE "C" NOT NULL CHECK (foto_id ~* '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'),
  reserva_id TEXT COLLATE "C" NOT NULL UNIQUE CHECK (reserva_id ~* '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'),
  clave_objeto TEXT COLLATE "C" NOT NULL UNIQUE,
  solicitud_canonica TEXT COLLATE "C" NOT NULL CHECK (octet_length(solicitud_canonica) BETWEEN 1 AND 65536),
  PRIMARY KEY (viaje_id, foto_id),
  UNIQUE (viaje_id, foto_id, reserva_id)
);
CREATE TABLE IF NOT EXISTS itinerario.fotos_operaciones (
  viaje_id TEXT COLLATE "C" NOT NULL,
  operacion_id TEXT COLLATE "C" NOT NULL CHECK (operacion_id ~* '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'),
  foto_id TEXT COLLATE "C" NOT NULL,
  reserva_id TEXT COLLATE "C" NOT NULL,
  solicitud_canonica TEXT COLLATE "C" NOT NULL CHECK (octet_length(solicitud_canonica) BETWEEN 1 AND 65536),
  recibo_canonico TEXT COLLATE "C" CHECK (recibo_canonico IS NULL OR octet_length(recibo_canonico) BETWEEN 1 AND 65536),
  PRIMARY KEY (viaje_id, operacion_id),
  FOREIGN KEY (viaje_id, foto_id, reserva_id)
    REFERENCES itinerario.fotos_reservas(viaje_id, foto_id, reserva_id)
);

-- Sólo renderizar escalares independientes de cabecera. NUNCA navegar/decodificar
-- JSON de solicitud/inicial/recibo/original: PostgreSQL puede rechazar metadata NUL.
CREATE OR REPLACE FUNCTION itinerario.fotos_cabecera(p_tipo TEXT, p_viaje TEXT, p_operacion TEXT, p_foto TEXT)
RETURNS TEXT LANGUAGE SQL IMMUTABLE AS $$
  SELECT '{"version":1,"tipo":' || to_json(p_tipo)::text || ',"viajeId":' || to_json(p_viaje)::text
    || ',"operacionId":' || to_json(p_operacion)::text || ',"fotoId":' || to_json(p_foto)::text || ',"original":'
$$;

-- Autoridad de dominio/canonicalidad: codec JS antes de IO. Este helper NO es parser
-- universal para clientes SQL arbitrarios que salten la pasarela privada del servidor.
CREATE OR REPLACE FUNCTION itinerario.fotos_solicitud_valida(
  p_viaje TEXT, p_foto TEXT, p_operacion TEXT, p_solicitud TEXT, p_original TEXT)
RETURNS BOOLEAN LANGUAGE SQL IMMUTABLE AS $$
  SELECT coalesce(octet_length(p_viaje) BETWEEN 1 AND 128
    AND octet_length(p_solicitud) BETWEEN 1 AND 65536 AND octet_length(p_original) BETWEEN 1 AND 65536
    AND p_foto ~* '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
    AND p_operacion ~* '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
    AND left(p_original,length('{"formato":1,"fotoId":' || to_json(p_foto)::text || ',')) COLLATE "C"
      = ('{"formato":1,"fotoId":' || to_json(p_foto)::text || ',') COLLATE "C"
    AND right(p_original,1) = '}'
    AND p_solicitud COLLATE "C" = (itinerario.fotos_cabecera('solicitud-respaldo',p_viaje,p_operacion,p_foto)
      || p_original || '}') COLLATE "C", false)
$$;

CREATE OR REPLACE FUNCTION itinerario.fotos_operacion_inicial(
  p_viaje TEXT, p_foto TEXT, p_reserva TEXT, p_inicial TEXT)
RETURNS TEXT LANGUAGE plpgsql STABLE AS $$
DECLARE
  cantidad BIGINT;
  operacion TEXT;
BEGIN
  SELECT count(*),min(operacion_id) INTO cantidad,operacion FROM itinerario.fotos_operaciones
    WHERE viaje_id = p_viaje AND foto_id = p_foto AND reserva_id = p_reserva AND solicitud_canonica = p_inicial;
  IF cantidad <> 1 THEN RAISE EXCEPTION 'No se pudo comprobar las fotos.'; END IF;
  RETURN operacion;
END
$$;

-- Relee fila y reloj después de esperas y DML. SHARE del llamador impide revocación
-- externa durante statement; no inmoviliza el reloj hasta el COMMIT físico del proveedor.
CREATE OR REPLACE FUNCTION itinerario.fotos_sesion_vigente(p_huella TEXT, p_viaje TEXT)
RETURNS BOOLEAN LANGUAGE SQL VOLATILE AS $$
  SELECT EXISTS (SELECT 1 FROM itinerario.sesiones WHERE huella = p_huella
    AND viaje_id = p_viaje AND NOT revocada
    AND vence_en > floor(extract(epoch FROM clock_timestamp()) * 1000)::bigint)
$$;

CREATE OR REPLACE FUNCTION itinerario.reservar_foto(
  p_huella TEXT, p_viaje TEXT, p_foto TEXT, p_operacion TEXT,
  p_solicitud TEXT, p_original TEXT, p_reserva TEXT, p_clave TEXT)
RETURNS TEXT LANGUAGE plpgsql AS $$
DECLARE
  sesion itinerario.sesiones%ROWTYPE;
  reserva itinerario.fotos_reservas%ROWTYPE;
  operacion itinerario.fotos_operaciones%ROWTYPE;
  inicial TEXT;
  respuesta TEXT;
  nueva BOOLEAN := false;
BEGIN
  IF p_huella IS NULL OR p_huella !~ '^[a-f0-9]{64}$'
    OR NOT itinerario.fotos_solicitud_valida(p_viaje,p_foto,p_operacion,p_solicitud,p_original)
    OR p_reserva IS NULL OR p_reserva !~* '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
    OR p_clave IS NULL OR p_clave = '' THEN RAISE EXCEPTION 'No se pudo comprobar las fotos.'; END IF;
  SELECT * INTO sesion FROM itinerario.sesiones WHERE huella = p_huella FOR SHARE;
  IF NOT FOUND OR NOT itinerario.fotos_sesion_vigente(p_huella,p_viaje) THEN RETURN '{"tipo":"sin-sesion"}'; END IF;
  PERFORM 1 FROM itinerario.viajes WHERE id = p_viaje FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'No se pudo comprobar las fotos.'; END IF;
  IF NOT itinerario.fotos_sesion_vigente(p_huella,p_viaje) THEN RETURN '{"tipo":"sin-sesion"}'; END IF;

  SELECT * INTO operacion FROM itinerario.fotos_operaciones WHERE viaje_id = p_viaje AND operacion_id = p_operacion;
  IF FOUND AND (operacion.foto_id <> p_foto OR operacion.solicitud_canonica <> p_solicitud) THEN
    respuesta := '{"tipo":"contradiccion"}';
  ELSE
    SELECT * INTO reserva FROM itinerario.fotos_reservas WHERE viaje_id = p_viaje AND foto_id = p_foto;
    IF FOUND THEN
      inicial := itinerario.fotos_operacion_inicial(p_viaje,p_foto,reserva.reserva_id,reserva.solicitud_canonica);
      IF reserva.solicitud_canonica <> itinerario.fotos_cabecera('solicitud-respaldo',p_viaje,inicial,p_foto) || p_original || '}' THEN
        respuesta := '{"tipo":"contradiccion"}';
      END IF;
      -- Retry existente sólo lee. Otra operación se vincula tras fullcompare A, en finalizar.
    ELSE
      IF NOT itinerario.fotos_sesion_vigente(p_huella,p_viaje) THEN RETURN '{"tipo":"sin-sesion"}'; END IF;
      -- Conflicto dirigido. Colisión ajena de reserva/clave = excepción, nunca adopción.
      INSERT INTO itinerario.fotos_reservas(viaje_id,foto_id,reserva_id,clave_objeto,solicitud_canonica)
        VALUES (p_viaje,p_foto,p_reserva,p_clave,p_solicitud)
        ON CONFLICT (viaje_id,foto_id) DO NOTHING RETURNING * INTO reserva;
      nueva := FOUND;
      IF nueva THEN
        INSERT INTO itinerario.fotos_operaciones(viaje_id,operacion_id,foto_id,reserva_id,solicitud_canonica)
          VALUES (p_viaje,p_operacion,p_foto,p_reserva,p_solicitud);
      ELSE
        SELECT * INTO reserva FROM itinerario.fotos_reservas WHERE viaje_id = p_viaje AND foto_id = p_foto;
        IF NOT FOUND THEN RAISE EXCEPTION 'No se pudo comprobar las fotos.'; END IF;
        inicial := itinerario.fotos_operacion_inicial(p_viaje,p_foto,reserva.reserva_id,reserva.solicitud_canonica);
        IF reserva.solicitud_canonica <> itinerario.fotos_cabecera('solicitud-respaldo',p_viaje,inicial,p_foto) || p_original || '}' THEN
          respuesta := '{"tipo":"contradiccion"}';
        END IF;
      END IF;
    END IF;
    IF respuesta IS NULL THEN
      respuesta := json_build_object('tipo', CASE WHEN nueva THEN 'ganadora' ELSE 'existente' END,
        'reserva', json_build_object('reservaId',reserva.reserva_id,'claveObjeto',reserva.clave_objeto,
        'solicitudCanonica',reserva.solicitud_canonica))::text;
    END IF;
  END IF;
  IF NOT itinerario.fotos_sesion_vigente(p_huella,p_viaje) THEN
    IF nueva THEN RAISE EXCEPTION 'No se pudo comprobar las fotos.'; END IF;
    RETURN '{"tipo":"sin-sesion"}';
  END IF;
  RETURN respuesta;
END
$$;

CREATE OR REPLACE FUNCTION itinerario.finalizar_foto(
  p_huella TEXT, p_viaje TEXT, p_foto TEXT, p_operacion TEXT, p_solicitud TEXT,
  p_original TEXT, p_reserva TEXT, p_clave TEXT, p_inicial TEXT, p_recibo TEXT)
RETURNS TEXT LANGUAGE plpgsql AS $$
DECLARE
  sesion itinerario.sesiones%ROWTYPE;
  reserva itinerario.fotos_reservas%ROWTYPE;
  operacion itinerario.fotos_operaciones%ROWTYPE;
  inicial TEXT;
  respuesta TEXT;
  escrita BOOLEAN := false;
BEGIN
  IF p_huella IS NULL OR p_huella !~ '^[a-f0-9]{64}$'
    OR NOT itinerario.fotos_solicitud_valida(p_viaje,p_foto,p_operacion,p_solicitud,p_original)
    OR p_reserva IS NULL OR p_clave IS NULL OR p_inicial IS NULL OR p_recibo IS NULL
    OR octet_length(p_inicial) NOT BETWEEN 1 AND 65536 OR octet_length(p_recibo) NOT BETWEEN 1 AND 65536
    OR p_recibo COLLATE "C" <> (itinerario.fotos_cabecera('acuse-respaldo',p_viaje,p_operacion,p_foto)
      || p_original || ',"objetoOriginalDurable":true,"metadatosDurables":true}') COLLATE "C" THEN
    RAISE EXCEPTION 'No se pudo comprobar las fotos.';
  END IF;
  SELECT * INTO sesion FROM itinerario.sesiones WHERE huella = p_huella FOR SHARE;
  IF NOT FOUND OR NOT itinerario.fotos_sesion_vigente(p_huella,p_viaje) THEN RETURN '{"tipo":"sin-sesion"}'; END IF;
  PERFORM 1 FROM itinerario.viajes WHERE id = p_viaje FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'No se pudo comprobar las fotos.'; END IF;
  IF NOT itinerario.fotos_sesion_vigente(p_huella,p_viaje) THEN RETURN '{"tipo":"sin-sesion"}'; END IF;

  SELECT * INTO reserva FROM itinerario.fotos_reservas WHERE viaje_id = p_viaje AND foto_id = p_foto;
  IF NOT FOUND THEN respuesta := '{"tipo":"incierta"}';
  ELSE
    inicial := itinerario.fotos_operacion_inicial(p_viaje,p_foto,reserva.reserva_id,reserva.solicitud_canonica);
    IF reserva.reserva_id <> p_reserva OR reserva.clave_objeto <> p_clave OR reserva.solicitud_canonica <> p_inicial
      OR p_inicial <> itinerario.fotos_cabecera('solicitud-respaldo',p_viaje,inicial,p_foto) || p_original || '}' THEN
      respuesta := '{"tipo":"contradiccion"}';
    ELSE
      SELECT * INTO operacion FROM itinerario.fotos_operaciones WHERE viaje_id = p_viaje AND operacion_id = p_operacion;
      IF FOUND AND (operacion.foto_id <> p_foto OR operacion.reserva_id <> p_reserva OR operacion.solicitud_canonica <> p_solicitud) THEN
        respuesta := '{"tipo":"contradiccion"}';
      ELSIF FOUND AND operacion.recibo_canonico IS NOT NULL THEN
        IF operacion.recibo_canonico <> p_recibo THEN RAISE EXCEPTION 'No se pudo comprobar las fotos.'; END IF;
        respuesta := json_build_object('tipo','confirmada','reciboCanonico',operacion.recibo_canonico)::text;
      ELSE
        IF NOT itinerario.fotos_sesion_vigente(p_huella,p_viaje) THEN RETURN '{"tipo":"sin-sesion"}'; END IF;
        IF operacion.operacion_id IS NULL THEN
          INSERT INTO itinerario.fotos_operaciones(viaje_id,operacion_id,foto_id,reserva_id,solicitud_canonica,recibo_canonico)
            VALUES (p_viaje,p_operacion,p_foto,p_reserva,p_solicitud,p_recibo);
        ELSE
          UPDATE itinerario.fotos_operaciones SET recibo_canonico = p_recibo
            WHERE viaje_id = p_viaje AND operacion_id = p_operacion AND recibo_canonico IS NULL;
        END IF;
        escrita := true;
        respuesta := json_build_object('tipo','confirmada','reciboCanonico',p_recibo)::text;
      END IF;
    END IF;
  END IF;
  -- Después de DML, perder sesión exige rollback, nunca retorno sin-sesion comprometible.
  IF NOT itinerario.fotos_sesion_vigente(p_huella,p_viaje) THEN
    IF escrita THEN RAISE EXCEPTION 'No se pudo comprobar las fotos.'; END IF;
    RETURN '{"tipo":"sin-sesion"}';
  END IF;
  RETURN respuesta;
END
$$;

CREATE OR REPLACE FUNCTION itinerario.consultar_foto(p_huella TEXT, p_viaje TEXT, p_foto TEXT)
RETURNS TEXT LANGUAGE plpgsql AS $$
DECLARE
  sesion itinerario.sesiones%ROWTYPE;
  reserva itinerario.fotos_reservas%ROWTYPE;
  operacion itinerario.fotos_operaciones%ROWTYPE;
  inicial TEXT;
  cabecera TEXT;
  original TEXT;
  respuesta TEXT;
BEGIN
  IF p_huella IS NULL OR p_huella !~ '^[a-f0-9]{64}$'
    OR p_viaje IS NULL OR octet_length(p_viaje) NOT BETWEEN 1 AND 128
    OR p_foto IS NULL OR p_foto !~* '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' THEN
    RAISE EXCEPTION 'No se pudo comprobar las fotos.';
  END IF;
  SELECT * INTO sesion FROM itinerario.sesiones WHERE huella = p_huella FOR SHARE;
  IF NOT FOUND OR NOT itinerario.fotos_sesion_vigente(p_huella,p_viaje) THEN RETURN '{"tipo":"sin-sesion"}'; END IF;
  PERFORM 1 FROM itinerario.viajes WHERE id = p_viaje FOR SHARE;
  IF NOT FOUND THEN RAISE EXCEPTION 'No se pudo comprobar las fotos.'; END IF;
  IF NOT itinerario.fotos_sesion_vigente(p_huella,p_viaje) THEN RETURN '{"tipo":"sin-sesion"}'; END IF;
  SELECT r.* INTO reserva FROM itinerario.fotos_reservas r WHERE r.viaje_id = p_viaje AND r.foto_id = p_foto
    AND EXISTS (SELECT 1 FROM itinerario.fotos_operaciones o WHERE o.viaje_id = r.viaje_id
      AND o.foto_id = r.foto_id AND o.reserva_id = r.reserva_id AND o.recibo_canonico IS NOT NULL);
  IF FOUND THEN
    inicial := itinerario.fotos_operacion_inicial(p_viaje,p_foto,reserva.reserva_id,reserva.solicitud_canonica);
    cabecera := itinerario.fotos_cabecera('solicitud-respaldo',p_viaje,inicial,p_foto);
    -- Offsets de encuadre completo; ningún marcador dentro de metadata es delimitador.
    original := substring(reserva.solicitud_canonica FROM length(cabecera)+1
      FOR length(reserva.solicitud_canonica)-length(cabecera)-1);
    IF NOT itinerario.fotos_solicitud_valida(p_viaje,p_foto,inicial,reserva.solicitud_canonica,original) THEN
      RAISE EXCEPTION 'No se pudo comprobar las fotos.';
    END IF;
    FOR operacion IN SELECT * FROM itinerario.fotos_operaciones
      WHERE viaje_id=p_viaje AND foto_id=p_foto AND reserva_id=reserva.reserva_id
        AND recibo_canonico IS NOT NULL LOOP
      IF NOT itinerario.fotos_solicitud_valida(p_viaje,p_foto,operacion.operacion_id,
        operacion.solicitud_canonica,original)
        OR operacion.recibo_canonico COLLATE "C" <> (itinerario.fotos_cabecera(
          'acuse-respaldo',p_viaje,operacion.operacion_id,p_foto) || original
          || ',"objetoOriginalDurable":true,"metadatosDurables":true}') COLLATE "C" THEN
        RAISE EXCEPTION 'No se pudo comprobar las fotos.';
      END IF;
    END LOOP;
    respuesta := json_build_object('tipo','confirmada','reserva',json_build_object('reservaId',reserva.reserva_id,
      'claveObjeto',reserva.clave_objeto,'solicitudCanonica',reserva.solicitud_canonica))::text;
  ELSE respuesta := '{"tipo":"ausente"}'; END IF;
  IF NOT itinerario.fotos_sesion_vigente(p_huella,p_viaje) THEN RETURN '{"tipo":"sin-sesion"}'; END IF;
  RETURN respuesta;
END
$$;
