-- srv001qa — Corregir 409 en POST /api/flow/start-from-token
--
-- Causa: el nexus_token lleva submoduloId 33 (OCR Documentos Cierre) pero en el
-- módulo 7 solo ese sub está activo → getActiveSlots devuelve 1 fila → 409.
--
-- Solución A (inmediata, sin redeploy nexus-api):
--   Cadena 33→34→35→36 activa; 17→20 OFF para que 33 sea el primer slot.
--
-- Solución B (recomendada + deploy nexus-api con chain-fallback):
--   Activar RCV Modular QA (37–40) y copiar URL nueva desde sub 37 en Admin.
--
-- Ejecutar:
--   cd ~/nexus-api && source .env
--   psql "${DATABASE_URL%%\?*}" -f scripts/qa-fix-start-from-token-409.sql

BEGIN;

CREATE TEMP TABLE tmp_qa_empresas AS
SELECT empresa_id FROM empresa
WHERE empresa_estatus = true AND empresa_id IN (5, 6, 7, 8, 9, 10);

-- Módulos padre necesarios para verify + cadena
UPDATE empresa_modulo em
SET emmo_estatus = true
FROM tmp_qa_empresas e
WHERE em.emmo_empresa_id = e.empresa_id
  AND em.emmo_modulo_id IN (7, 14);

INSERT INTO empresa_modulo (emmo_empresa_id, emmo_modulo_id, emmo_estatus, emmo_token, emmo_created_at)
SELECT e.empresa_id, 14, true, 'qa-14-emp-' || e.empresa_id, NOW()
FROM tmp_qa_empresas e
WHERE NOT EXISTS (
  SELECT 1 FROM empresa_modulo em
  WHERE em.emmo_empresa_id = e.empresa_id AND em.emmo_modulo_id = 14
);

-- Filas faltantes
INSERT INTO empresa_submodulo (emsm_empresa_id, emsm_submodulo_id, emsm_estatus, emsm_created_at)
SELECT e.empresa_id, s.submodulo_id, true, NOW()
FROM tmp_qa_empresas e
CROSS JOIN submodulo s
WHERE s.submodulo_id IN (33, 34, 35, 36, 37, 38, 39, 40)
AND NOT EXISTS (
  SELECT 1 FROM empresa_submodulo es
  WHERE es.emsm_empresa_id = e.empresa_id AND es.emsm_submodulo_id = s.submodulo_id
);

-- Evitar 8 slots mezclados: OFF 17–20, ON cadena Cierre 33–36
UPDATE empresa_submodulo es
SET emsm_estatus = CASE
  WHEN es.emsm_submodulo_id IN (17, 18, 19, 20) THEN false
  WHEN es.emsm_submodulo_id IN (33, 34, 35, 36) THEN true
  WHEN es.emsm_submodulo_id IN (37, 38, 39, 40) THEN true
  ELSE es.emsm_estatus
END
FROM tmp_qa_empresas e
WHERE es.emsm_empresa_id = e.empresa_id
  AND es.emsm_submodulo_id IN (17, 18, 19, 20, 33, 34, 35, 36, 37, 38, 39, 40);

COMMIT;

\echo ''
\echo '=== Conteo activos módulo 7 (debe ser 4: 33–36) ==='
SELECT e.empresa_id,
       e.empresa_nombre,
       COUNT(*) FILTER (WHERE es.emsm_estatus) AS activos_mod7
FROM tmp_qa_empresas t
JOIN empresa e ON e.empresa_id = t.empresa_id
JOIN empresa_submodulo es ON es.emsm_empresa_id = e.empresa_id
JOIN submodulo s ON s.submodulo_id = es.emsm_submodulo_id
WHERE s.submodulo_modulo_id = 7
GROUP BY e.empresa_id, e.empresa_nombre
ORDER BY e.empresa_id;

\echo ''
\echo '=== Conteo activos módulo 14 (debe ser 4: 37–40) ==='
SELECT e.empresa_id,
       e.empresa_nombre,
       COUNT(*) FILTER (WHERE es.emsm_estatus) AS activos_mod14
FROM tmp_qa_empresas t
JOIN empresa e ON e.empresa_id = t.empresa_id
JOIN empresa_submodulo es ON es.emsm_empresa_id = e.empresa_id
JOIN submodulo s ON s.submodulo_id = es.emsm_submodulo_id
WHERE s.submodulo_modulo_id = 14
GROUP BY e.empresa_id, e.empresa_nombre
ORDER BY e.empresa_id;

DROP TABLE IF EXISTS tmp_qa_empresas;
