-- Registra el submódulo "Emisión genérica Exélixi" (catálogo product-builder → OCR).
-- Distinto del flujo RCV La Mundial (OCR Documentos / ?product=rcv).
--
--   psql "$DATABASE_URL" -f scripts/register-emision-generica-exelixi.sql
--
-- Luego en Nexus Admin:
--   1. Empresas → activar módulo "Emisión Genérica Exélixi" para el tenant
--   2. Activar submódulo "OCR Catálogo Exélixi"
--   3. Copiar URL de acceso (incluye nexus_token) y abrir en navegador

DO $$
DECLARE
  v_modulo_nombre    text := 'Emisión Genérica Exélixi';
  v_submodulo_nombre text := 'OCR Catálogo Exélixi';
  v_submodulo_url    text := 'https://cierrelmds.exelixitech.com/ocr/?flow=exelixi-catalog';
  v_modulo_id        int;
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

  RAISE NOTICE 'Módulo id=% — submódulo "%" registrado o ya existía.', v_modulo_id, v_submodulo_nombre;
END $$;

SELECT m.modulo_id, m.modulo_nombre, s.submodulo_id, s.submodulo_nombre, s.submodulo_url
FROM modulo m
JOIN submodulo s ON s.submodulo_modulo_id = m.modulo_id
WHERE m.modulo_nombre = 'Emisión Genérica Exélixi';
