-- srv001qa — Módulo Patrimoniales (OCR→Formulario→Emisión→Pagos) para iframe.
-- Deja las URLs de acceso en Empresas → /empresas/7 (y otras QA 5–10).
--
--   cd ~/nexus-api && source .env && unset PORT
--   PSQL_URL="${DATABASE_URL%%\?*}"
--   psql "$PSQL_URL" -f scripts/qa-register-modulo-patrimoniales.sql
--   unset PORT
--   pm2 restart nexus-api
--
-- Luego: Admin → Empresas → 7 → pestaña URLs de acceso → copiar OCR (iframe).

DO $$
DECLARE
  v_modulo_nombre text := 'Patrimoniales';
  v_origin        text := 'https://nexusqa.exelixitech.com';
  v_modulo_id     int;
  rec             record;
BEGIN
  INSERT INTO modulo (modulo_nombre, modulo_estatus)
  SELECT v_modulo_nombre, true
  WHERE NOT EXISTS (
    SELECT 1 FROM modulo WHERE modulo_nombre = v_modulo_nombre
  );

  SELECT modulo_id INTO v_modulo_id
  FROM modulo
  WHERE modulo_nombre = v_modulo_nombre
  LIMIT 1;

  FOR rec IN
    SELECT * FROM (VALUES
      ('OCR Patrimoniales',        v_origin || '/ocr/?product=patrimoniales'),
      ('Formulario Patrimoniales', v_origin || '/formulario/?product=patrimoniales'),
      ('Emision Patrimoniales',    v_origin || '/emision/?product=patrimoniales'),
      ('Pagos Patrimoniales',      v_origin || '/pagos/?product=patrimoniales')
    ) AS t(nombre, url)
  LOOP
    INSERT INTO submodulo (
      submodulo_nombre,
      submodulo_url,
      submodulo_estatus,
      submodulo_modulo_id
    )
    SELECT rec.nombre, rec.url, true, v_modulo_id
    WHERE NOT EXISTS (
      SELECT 1 FROM submodulo
      WHERE submodulo_nombre = rec.nombre
        AND submodulo_modulo_id = v_modulo_id
    );

    UPDATE submodulo
    SET submodulo_url = rec.url,
        submodulo_estatus = true
    WHERE submodulo_nombre = rec.nombre
      AND submodulo_modulo_id = v_modulo_id
      AND submodulo_url IS DISTINCT FROM rec.url;
  END LOOP;

  INSERT INTO empresa_modulo (
    emmo_empresa_id, emmo_modulo_id, emmo_estatus, emmo_token, emmo_created_at
  )
  SELECT e.empresa_id,
         v_modulo_id,
         true,
         'qa-patrimoniales-emp-' || e.empresa_id,
         NOW()
  FROM empresa e
  WHERE e.empresa_estatus = true
    AND e.empresa_id IN (5, 6, 7, 8, 9, 10)
    AND NOT EXISTS (
      SELECT 1 FROM empresa_modulo em
      WHERE em.emmo_empresa_id = e.empresa_id
        AND em.emmo_modulo_id = v_modulo_id
    );

  UPDATE empresa_modulo
  SET emmo_estatus = true
  WHERE emmo_modulo_id = v_modulo_id
    AND emmo_empresa_id IN (5, 6, 7, 8, 9, 10);

  INSERT INTO empresa_submodulo (
    emsm_empresa_id, emsm_submodulo_id, emsm_estatus, emsm_created_at
  )
  SELECT e.empresa_id, s.submodulo_id, true, NOW()
  FROM empresa e
  JOIN submodulo s ON s.submodulo_modulo_id = v_modulo_id
  WHERE e.empresa_estatus = true
    AND e.empresa_id IN (5, 6, 7, 8, 9, 10)
    AND NOT EXISTS (
      SELECT 1 FROM empresa_submodulo es
      WHERE es.emsm_empresa_id = e.empresa_id
        AND es.emsm_submodulo_id = s.submodulo_id
    );

  UPDATE empresa_submodulo es
  SET emsm_estatus = true
  FROM submodulo s
  WHERE es.emsm_submodulo_id = s.submodulo_id
    AND s.submodulo_modulo_id = v_modulo_id
    AND es.emsm_empresa_id IN (5, 6, 7, 8, 9, 10);

  RAISE NOTICE 'Módulo Patrimoniales id=% listo para empresas 5–10.', v_modulo_id;
END $$;

SELECT m.modulo_id,
       m.modulo_nombre,
       s.submodulo_id,
       s.submodulo_nombre,
       s.submodulo_url
FROM modulo m
JOIN submodulo s ON s.submodulo_modulo_id = m.modulo_id
WHERE m.modulo_nombre = 'Patrimoniales'
ORDER BY s.submodulo_id;

SELECT e.empresa_id,
       e.empresa_nombre,
       m.modulo_nombre,
       COUNT(*) FILTER (WHERE es.emsm_estatus) AS subs_activos
FROM empresa e
JOIN empresa_modulo em ON em.emmo_empresa_id = e.empresa_id
JOIN modulo m ON m.modulo_id = em.emmo_modulo_id
JOIN submodulo s ON s.submodulo_modulo_id = m.modulo_id
LEFT JOIN empresa_submodulo es
  ON es.emsm_empresa_id = e.empresa_id
 AND es.emsm_submodulo_id = s.submodulo_id
WHERE m.modulo_nombre = 'Patrimoniales'
  AND e.empresa_id = 7
GROUP BY e.empresa_id, e.empresa_nombre, m.modulo_nombre;
