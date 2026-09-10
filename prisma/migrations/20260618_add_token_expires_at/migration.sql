-- Migration: add token_expires_at to empresa_submodulo
-- Adds sliding-window token expiry for DB-backed session renewal

ALTER TABLE "empresa_submodulo"
  ADD COLUMN IF NOT EXISTS "emsm_token_expires_at" TIMESTAMP;

-- Initialize active records so they are not immediately expired.
-- The heartbeat will renew on first request anyway, but this avoids
-- any edge case on modules that are loaded right after migration.
UPDATE "empresa_submodulo"
  SET "emsm_token_expires_at" = NOW() + INTERVAL '8 hours'
  WHERE "emsm_estatus" = true
    AND "emsm_tenant_token" IS NOT NULL;
