-- Registra un módulo global + submódulo en Nexus (PostgreSQL).
-- Edita los tres literales abajo antes de ejecutar.
--
--   psql "$DATABASE_URL" -f scripts/register-modulo.sql
--
-- Tras ejecutar: Nexus Admin → Módulos (ver/desactivar) y Empresas → activar por tenant.

DO $$
DECLARE
  v_modulo_nombre   text := 'EDITAR_NombreModulo';
  v_submodulo_nombre text := 'EDITAR_NombreSubmodulo';
  v_submodulo_url   text := 'https://cierrelmds.exelixitech.com/EDITAR-ruta/';
  v_modulo_id       int;
BEGIN
  IF v_modulo_nombre LIKE 'EDITAR_%' THEN
    RAISE EXCEPTION 'Edita v_modulo_nombre, v_submodulo_nombre y v_submodulo_url en register-modulo.sql antes de ejecutar.';
  END IF;

  INSERT INTO modulo (modulo_nombre, modulo_estatus)
  SELECT v_modulo_nombre, true
  WHERE NOT EXISTS (
    SELECT 1 FROM modulo WHERE modulo_nombre = v_modulo_nombre
  );

  SELECT modulo_id INTO v_modulo_id
  FROM modulo
  WHERE modulo_nombre = v_modulo_nombre
  LIMIT 1;

  INSERT INTO submodulo (
    submodulo_nombre,
    submodulo_url,
    submodulo_estatus,
    submodulo_modulo_id
  )
  SELECT v_submodulo_nombre, v_submodulo_url, true, v_modulo_id
  WHERE NOT EXISTS (
    SELECT 1 FROM submodulo
    WHERE submodulo_nombre = v_submodulo_nombre
      AND submodulo_modulo_id = v_modulo_id
  );

  RAISE NOTICE 'Módulo id=% nombre=% — submódulo registrado o ya existía.', v_modulo_id, v_modulo_nombre;
END $$;

SELECT m.modulo_id, m.modulo_nombre, m.modulo_estatus,
       s.submodulo_id, s.submodulo_nombre, s.submodulo_url, s.submodulo_estatus
FROM modulo m
LEFT JOIN submodulo s ON s.submodulo_modulo_id = m.modulo_id
WHERE m.modulo_nombre NOT LIKE 'EDITAR_%'
ORDER BY m.modulo_id, s.submodulo_id;
