-- srv001qa — Estandarizar empresas de prueba QA (misma plantilla que La Mundial)
--
-- Plantilla por empresa activa (ids >= 5):
--   OFF  subs 17-20 y 33-36 (duplicados en módulo 7; el token viejo usa sub 33)
--   ON   modulo 14 RCV Modular QA      subs 37-40  (cadena OCR→Form→Emisión→Pagos)
--   módulo 7 padre ON mientras existan tokens con sub 33 (verify); migrar a sub 37
--   ON   modulo 8  Funerario Modular   subs 21-24
--   ON   modulo 13 Emisión Genérica    subs 29-32
--
-- Ejecutar:
--   cd ~/nexus-api && source .env
--   psql "${DATABASE_URL%%\?*}" -f scripts/qa-audit-empresa-submodulos.sql
--   psql "${DATABASE_URL%%\?*}" -f scripts/qa-standardize-empresa-submodulos.sql
--   psql "${DATABASE_URL%%\?*}" -f scripts/qa-audit-empresa-submodulos.sql
--
-- SSO / URLs de acceso: usar submodulo 37 (OCR Documentos QA) por empresa.

BEGIN;

-- Empresas objetivo: activas de prueba (5 Javier 1 … 10 Pruebas pago erick)
CREATE TEMP TABLE tmp_qa_empresas AS
SELECT empresa_id, empresa_nombre
FROM empresa
WHERE empresa_estatus = true
  AND empresa_id IN (5, 6, 7, 8, 9, 10);

-- --- 1) Crear filas faltantes en empresa_modulo ---
INSERT INTO empresa_modulo (emmo_empresa_id, emmo_modulo_id, emmo_estatus, emmo_token, emmo_created_at)
SELECT e.empresa_id,
       m.modulo_id,
       true,
       'qa-' || m.modulo_id || '-emp-' || e.empresa_id,
       NOW()
FROM tmp_qa_empresas e
CROSS JOIN (VALUES (8), (13), (14)) AS m(modulo_id)
WHERE NOT EXISTS (
  SELECT 1
  FROM empresa_modulo em
  WHERE em.emmo_empresa_id = e.empresa_id
    AND em.emmo_modulo_id = m.modulo_id
);

-- Módulo 7 padre ON (tokens legacy sub 33); activar 8, 13, 14
UPDATE empresa_modulo em
SET emmo_estatus = CASE em.emmo_modulo_id
  WHEN 7  THEN true
  WHEN 8  THEN true
  WHEN 13 THEN true
  WHEN 14 THEN true
  ELSE em.emmo_estatus
END
FROM tmp_qa_empresas e
WHERE em.emmo_empresa_id = e.empresa_id
  AND em.emmo_modulo_id IN (7, 8, 13, 14);

-- --- 2) Crear filas faltantes en empresa_submodulo ---
INSERT INTO empresa_submodulo (emsm_empresa_id, emsm_submodulo_id, emsm_estatus, emsm_created_at)
SELECT e.empresa_id, s.submodulo_id, true, NOW()
FROM tmp_qa_empresas e
CROSS JOIN submodulo s
WHERE s.submodulo_id IN (
  17, 18, 19, 20,
  21, 22, 23, 24,
  29, 30, 31, 32,
  33, 34, 35, 36,
  37, 38, 39, 40
)
AND NOT EXISTS (
  SELECT 1
  FROM empresa_submodulo es
  WHERE es.emsm_empresa_id = e.empresa_id
    AND es.emsm_submodulo_id = s.submodulo_id
);

-- --- 3) Activar / desactivar submódulos según plantilla ---
UPDATE empresa_submodulo es
SET emsm_estatus = CASE
  WHEN es.emsm_submodulo_id IN (17, 18, 19, 20) THEN false
  WHEN es.emsm_submodulo_id IN (33, 34, 35, 36) THEN false
  WHEN es.emsm_submodulo_id IN (21, 22, 23, 24) THEN true
  WHEN es.emsm_submodulo_id IN (29, 30, 31, 32) THEN true
  WHEN es.emsm_submodulo_id IN (37, 38, 39, 40) THEN true
  ELSE es.emsm_estatus
END
FROM tmp_qa_empresas e
WHERE es.emsm_empresa_id = e.empresa_id
  AND es.emsm_submodulo_id IN (
    17, 18, 19, 20,
    33, 34, 35, 36,
    21, 22, 23, 24,
    29, 30, 31, 32,
    37, 38, 39, 40
  );

COMMIT;

\echo ''
\echo '=== Resumen post-estandarización ==='
SELECT e.empresa_id,
       e.empresa_nombre,
       m.modulo_id,
       m.modulo_nombre,
       COUNT(*) FILTER (WHERE es.emsm_estatus) AS activos
FROM tmp_qa_empresas e
JOIN empresa_submodulo es ON es.emsm_empresa_id = e.empresa_id
JOIN submodulo s ON s.submodulo_id = es.emsm_submodulo_id
JOIN modulo m ON m.modulo_id = s.submodulo_modulo_id
WHERE m.modulo_id IN (7, 8, 13, 14)
GROUP BY e.empresa_id, e.empresa_nombre, m.modulo_id, m.modulo_nombre
ORDER BY e.empresa_id, m.modulo_id;

DROP TABLE IF EXISTS tmp_qa_empresas;
