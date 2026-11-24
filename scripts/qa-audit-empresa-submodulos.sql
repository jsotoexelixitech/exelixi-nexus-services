-- srv001qa — Auditoría de submódulos por empresa (solo lectura)
-- Ejecutar: cd ~/nexus-api && source .env && psql "${DATABASE_URL%%\?*}" -f scripts/qa-audit-empresa-submodulos.sql
--
-- Plantilla objetivo QA (ver qa-standardize-empresa-submodulos.sql):
--   OFF  RCV Modular (7)      → subs 17-20 y 33-36 (duplicados)
--   ON   RCV Modular QA (14)  → subs 37-40
--   ON   Funerario (8)        → subs 21-24
--   ON   Catálogo Exélixi (13) → subs 29-32

\echo '=== Empresas activas ==='
SELECT empresa_id, empresa_nombre, empresa_estatus
FROM empresa
WHERE empresa_estatus = true
ORDER BY empresa_id;

\echo ''
\echo '=== Módulos padre por empresa (empresa_modulo) ==='
SELECT e.empresa_id,
       e.empresa_nombre,
       m.modulo_id,
       m.modulo_nombre,
       em.emmo_estatus AS modulo_activo
FROM empresa e
JOIN empresa_modulo em ON em.emmo_empresa_id = e.empresa_id
JOIN modulo m ON m.modulo_id = em.emmo_modulo_id
WHERE e.empresa_estatus = true
  AND m.modulo_id IN (7, 8, 13, 14)
ORDER BY e.empresa_id, m.modulo_id;

\echo ''
\echo '=== Submódulos activos por grupo (conteo — debe ser 4 o 0) ==='
SELECT e.empresa_id,
       e.empresa_nombre,
       m.modulo_id,
       m.modulo_nombre,
       COUNT(*) FILTER (WHERE es.emsm_estatus) AS activos,
       COUNT(*) AS total_filas
FROM empresa e
JOIN empresa_submodulo es ON es.emsm_empresa_id = e.empresa_id
JOIN submodulo s ON s.submodulo_id = es.emsm_submodulo_id
JOIN modulo m ON m.modulo_id = s.submodulo_modulo_id
WHERE e.empresa_estatus = true
  AND m.modulo_id IN (7, 8, 13, 14)
GROUP BY e.empresa_id, e.empresa_nombre, m.modulo_id, m.modulo_nombre
ORDER BY e.empresa_id, m.modulo_id;

\echo ''
\echo '=== Detalle submódulos RCV / Funerario / Catálogo ==='
SELECT e.empresa_id,
       e.empresa_nombre,
       m.modulo_id,
       m.modulo_nombre,
       s.submodulo_id,
       s.submodulo_nombre,
       es.emsm_estatus AS sub_activo,
       LEFT(s.submodulo_url, 50) AS url
FROM empresa e
JOIN empresa_submodulo es ON es.emsm_empresa_id = e.empresa_id
JOIN submodulo s ON s.submodulo_id = es.emsm_submodulo_id
JOIN modulo m ON m.modulo_id = s.submodulo_modulo_id
WHERE e.empresa_estatus = true
  AND m.modulo_id IN (7, 8, 13, 14)
ORDER BY e.empresa_id, m.modulo_id, s.submodulo_id;

\echo ''
\echo '=== Empresas que NO cumplen plantilla QA ==='
WITH expected AS (
  SELECT * FROM (VALUES
    (7,  ARRAY[17,18,19,20], false),
    (7,  ARRAY[33,34,35,36], false),
    (14, ARRAY[37,38,39,40], true),
    (8,  ARRAY[21,22,23,24], true),
    (13, ARRAY[29,30,31,32], true)
  ) AS t(modulo_id, sub_ids, want_active)
),
checks AS (
  SELECT e.empresa_id,
         e.empresa_nombre,
         ex.modulo_id,
         unnest(ex.sub_ids) AS submodulo_id,
         ex.want_active
  FROM empresa e
  CROSS JOIN expected ex
  WHERE e.empresa_estatus = true
    AND e.empresa_id >= 5
)
SELECT c.empresa_id,
       c.empresa_nombre,
       c.modulo_id,
       c.submodulo_id,
       c.want_active AS debe_estar_activo,
       COALESCE(es.emsm_estatus, false) AS esta_activo,
       CASE
         WHEN es.emsm_id IS NULL THEN 'FALTA FILA'
         WHEN es.emsm_estatus IS DISTINCT FROM c.want_active THEN 'DESALINEADO'
         ELSE 'OK'
       END AS estado
FROM checks c
LEFT JOIN empresa_submodulo es
  ON es.emsm_empresa_id = c.empresa_id
 AND es.emsm_submodulo_id = c.submodulo_id
WHERE es.emsm_id IS NULL
   OR es.emsm_estatus IS DISTINCT FROM c.want_active
ORDER BY c.empresa_id, c.modulo_id, c.submodulo_id;
