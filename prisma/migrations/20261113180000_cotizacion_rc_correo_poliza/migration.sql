-- Correo automático de la póliza del cotizador RC: PDF «Condicionado y anexos» que el cotizador manda con el checkout
-- y estado del envío ({ enviadoEn, a, error }). Aditivo: columnas nuevas, todas opcionales.
-- AlterTable
ALTER TABLE "cotizacion_rc"
    ADD COLUMN "crc_anexos_pdf" BYTEA,
    ADD COLUMN "crc_anexos_nombre" VARCHAR(150),
    ADD COLUMN "crc_anexos_opcion" VARCHAR(4),
    ADD COLUMN "crc_correo_poliza" JSONB;
