-- srv001qa — URLs de submódulos para bridge OCR → Formulario → Emisión → Pagos
-- Ejecutar desde ~/nexus-api: source .env && psql "$DATABASE_URL" -f scripts/fix-nexusqa-submodulo-urls.sql

UPDATE submodulo
SET submodulo_url = 'https://nexusqa.exelixitech.com/ocr/'
WHERE submodulo_nombre ILIKE 'OCR Documentos%';

UPDATE submodulo
SET submodulo_url = 'https://nexusqa.exelixitech.com/formulario/'
WHERE submodulo_nombre ILIKE 'Formulario%';

UPDATE submodulo
SET submodulo_url = 'https://nexusqa.exelixitech.com/emision/'
WHERE submodulo_nombre ILIKE 'Emisión%'
   OR submodulo_nombre ILIKE 'Emision%';

UPDATE submodulo
SET submodulo_url = 'https://nexusqa.exelixitech.com/pagos/'
WHERE submodulo_nombre ILIKE 'Pagos%';

-- Verificación
SELECT submodulo_id, submodulo_nombre, submodulo_url
FROM submodulo
WHERE submodulo_nombre ILIKE 'OCR%'
   OR submodulo_nombre ILIKE 'Formulario%'
   OR submodulo_nombre ILIKE 'Emisi%'
   OR submodulo_nombre ILIKE 'Pagos%'
ORDER BY submodulo_id;
