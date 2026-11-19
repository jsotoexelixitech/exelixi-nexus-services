-- srv001qa (121) — Submódulo «Cotizador RC» para el SSO de Sys2000 (sso-delegate, target `cotizador-rc`).
-- Idempotente: se puede correr varias veces. Solo QA (empresa La Mundial = 7). No toca otros módulos.
--
--   cd ~/nexus-api && source .env && unset PORT
--   PSQL_URL="${DATABASE_URL%%\?*}"
--   psql "$PSQL_URL" -f scripts/qa-register-submodulo-cotizador-rc.sql
--
-- El sso-delegate resuelve el target `cotizador-rc` por la URL del submódulo (contiene «cotizador-rc») o por su
-- nombre («Cotizador RC»), entre los submódulos activos asignados a la empresa (findSubmoduloPorNombreDeTarget).
-- El id que imprime al final va en el .env.local del cotizador: COTIZADOR_SSO_SUBMODULO_ID=<id>.

DO $$
DECLARE
  v_modulo_nombre    text := 'Cotizador RC';
  v_submodulo_nombre text := 'Cotizador RC';
  v_url              text := 'https://nexusqa.exelixitech.com/cotizador-rc/';
  v_empresa_id       int  := 7;
  v_modulo_id        int;
  v_submodulo_id     int;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM empresa WHERE empresa_id = v_empresa_id) THEN
    RAISE EXCEPTION 'No existe la empresa % en esta base: revisa que sea la de QA.', v_empresa_id;
  END IF;

  -- Módulo propio: así no se mezcla con la cadena RCV / Patrimoniales (OCR → Formulario → Emisión → Pagos).
  INSERT INTO modulo (modulo_nombre, modulo_estatus, created_at)
  SELECT v_modulo_nombre, true, NOW()
  WHERE NOT EXISTS (SELECT 1 FROM modulo WHERE modulo_nombre = v_modulo_nombre);

  SELECT modulo_id INTO v_modulo_id
  FROM modulo WHERE modulo_nombre = v_modulo_nombre
  ORDER BY modulo_id LIMIT 1;

  UPDATE modulo SET modulo_estatus = true
  WHERE modulo_id = v_modulo_id AND modulo_estatus IS DISTINCT FROM true;

  INSERT INTO submodulo (submodulo_nombre, submodulo_url, submodulo_estatus, submodulo_modulo_id)
  SELECT v_submodulo_nombre, v_url, true, v_modulo_id
  WHERE NOT EXISTS (
    SELECT 1 FROM submodulo
    WHERE submodulo_nombre = v_submodulo_nombre AND submodulo_modulo_id = v_modulo_id
  );

  SELECT submodulo_id INTO v_submodulo_id
  FROM submodulo
  WHERE submodulo_nombre = v_submodulo_nombre AND submodulo_modulo_id = v_modulo_id
  ORDER BY submodulo_id LIMIT 1;

  UPDATE submodulo
  SET submodulo_url = v_url, submodulo_estatus = true
  WHERE submodulo_id = v_submodulo_id
    AND (submodulo_url IS DISTINCT FROM v_url OR submodulo_estatus IS DISTINCT FROM true);

  -- Módulo y submódulo activos para La Mundial (QA).
  INSERT INTO empresa_modulo (emmo_empresa_id, emmo_modulo_id, emmo_estatus, emmo_token, emmo_created_at)
  SELECT v_empresa_id, v_modulo_id, true, 'qa-cotizador-rc-emp-' || v_empresa_id, NOW()
  WHERE NOT EXISTS (
    SELECT 1 FROM empresa_modulo WHERE emmo_empresa_id = v_empresa_id AND emmo_modulo_id = v_modulo_id
  );

  UPDATE empresa_modulo SET emmo_estatus = true
  WHERE emmo_empresa_id = v_empresa_id AND emmo_modulo_id = v_modulo_id AND emmo_estatus IS DISTINCT FROM true;

  INSERT INTO empresa_submodulo (emsm_empresa_id, emsm_submodulo_id, emsm_estatus, emsm_created_at)
  SELECT v_empresa_id, v_submodulo_id, true, NOW()
  WHERE NOT EXISTS (
    SELECT 1 FROM empresa_submodulo WHERE emsm_empresa_id = v_empresa_id AND emsm_submodulo_id = v_submodulo_id
  );

  UPDATE empresa_submodulo SET emsm_estatus = true
  WHERE emsm_empresa_id = v_empresa_id AND emsm_submodulo_id = v_submodulo_id AND emsm_estatus IS DISTINCT FROM true;

  RAISE NOTICE 'Cotizador RC: modulo_id=% submodulo_id=% activo para la empresa %. COTIZADOR_SSO_SUBMODULO_ID=%',
    v_modulo_id, v_submodulo_id, v_empresa_id, v_submodulo_id;
END $$;

-- Verificación: debe salir una sola fila, con submódulo y asignación activos.
SELECT m.modulo_id, m.modulo_nombre, s.submodulo_id, s.submodulo_nombre, s.submodulo_url, s.submodulo_estatus,
       em.emmo_estatus AS empresa_modulo_activo, es.emsm_estatus AS empresa_submodulo_activo
FROM modulo m
JOIN submodulo s ON s.submodulo_modulo_id = m.modulo_id
LEFT JOIN empresa_modulo em ON em.emmo_modulo_id = m.modulo_id AND em.emmo_empresa_id = 7
LEFT JOIN empresa_submodulo es ON es.emsm_submodulo_id = s.submodulo_id AND es.emsm_empresa_id = 7
WHERE m.modulo_nombre = 'Cotizador RC';

-- Ningún otro submódulo activo debería contener «cotizador-rc» en la URL o «cotizador rc» en el nombre (el
-- sso-delegate toma el de menor id asignado a la empresa).
SELECT submodulo_id, submodulo_nombre, submodulo_url, submodulo_estatus
FROM submodulo
WHERE submodulo_url ILIKE '%cotizador-rc%' OR submodulo_nombre ILIKE '%cotizador rc%' OR submodulo_nombre ILIKE '%cotizador-rc%'
ORDER BY submodulo_id;
