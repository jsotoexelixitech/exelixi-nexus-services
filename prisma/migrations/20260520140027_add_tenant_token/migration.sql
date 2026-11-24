-- AlterTable: agregar columna tenant_token a empresa_submodulo
-- Este campo almacena el token JWT firmado que identifica la combinación empresa+submódulo.
-- Es nullable para compatibilidad con registros existentes.
ALTER TABLE "empresa_submodulo" ADD COLUMN IF NOT EXISTS "emsm_tenant_token" TEXT;
