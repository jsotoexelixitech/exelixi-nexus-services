-- Srv-Gcia-proyect — URLs producción (subdominios *.exelixitech.com)
-- Paridad con scripts/fix-nexusqa-submodulo-urls.sql (QA)
-- Ejecutar: cd ~/exelixi/nexus-api && source .env && unset PORT && psql "${DATABASE_URL%%\?*}" -f scripts/fix-gcia-produccion-submodulo-urls.sql

UPDATE submodulo
SET submodulo_url = 'https://ocr.exelixitech.com/'
WHERE submodulo_nombre ILIKE 'OCR%';

UPDATE submodulo
SET submodulo_url = 'https://formulario.exelixitech.com/'
WHERE submodulo_nombre ILIKE 'Formulario%';

UPDATE submodulo
SET submodulo_url = 'https://emision.exelixitech.com/'
WHERE submodulo_nombre ILIKE 'Emisión%'
   OR submodulo_nombre ILIKE 'Emision%';

UPDATE submodulo
SET submodulo_url = 'https://pagos.exelixitech.com/'
WHERE submodulo_nombre ILIKE 'Pagos%';

SELECT submodulo_id, submodulo_nombre, submodulo_url
FROM submodulo
WHERE submodulo_nombre ILIKE 'OCR%'
   OR submodulo_nombre ILIKE 'Formulario%'
   OR submodulo_nombre ILIKE 'Emisi%'
   OR submodulo_nombre ILIKE 'Pagos%'
ORDER BY submodulo_id;
