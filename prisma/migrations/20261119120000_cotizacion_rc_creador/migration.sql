-- Cotizador RC con SSO de Sys2000: quién cotizó (intermediario) para emitir con su productor y usuario y mostrar
-- «Emitida por». Aditivo: una columna nueva opcional; NULL = cotización web (La Mundial directo, como hasta hoy).
-- AlterTable
ALTER TABLE "cotizacion_rc" ADD COLUMN IF NOT EXISTS "crc_creador" JSONB;
