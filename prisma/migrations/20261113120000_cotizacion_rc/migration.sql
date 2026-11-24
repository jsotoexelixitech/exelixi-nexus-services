-- Cotizaciones del cotizador RC (RCG / RCP / RCE): JSON completo, pago en línea y póliza emitida.
-- Registro permanente: crc_expira_en (creación + 15 días) solo cierra el acceso y el pago del cliente.
-- CreateTable
CREATE TABLE "cotizacion_rc" (
    "crc_id" SERIAL NOT NULL,
    "crc_codigo" VARCHAR(40) NOT NULL,
    "crc_producto" VARCHAR(8) NOT NULL,
    "crc_estado" VARCHAR(16) NOT NULL DEFAULT 'cotizada',
    "crc_origen" VARCHAR(16) NOT NULL DEFAULT 'admin',
    "crc_tomador_nombre" VARCHAR(200) NOT NULL,
    "crc_tomador_documento" VARCHAR(32),
    "crc_tomador_correo" VARCHAR(200),
    "crc_moneda" VARCHAR(8),
    "crc_opcion" VARCHAR(4),
    "crc_datos" JSONB NOT NULL,
    "crc_pago" JSONB,
    "crc_poliza" JSONB,
    "crc_error" TEXT,
    "crc_emitiendo_en" TIMESTAMP(6),
    "crc_expira_en" TIMESTAMP(6) NOT NULL,
    "crc_created_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "crc_updated_at" TIMESTAMP(6),

    CONSTRAINT "cotizacion_rc_pkey" PRIMARY KEY ("crc_id")
);

-- CreateIndex
CREATE UNIQUE INDEX "uq_cotizacion_rc_codigo" ON "cotizacion_rc"("crc_codigo");

-- CreateIndex
CREATE INDEX "idx_cotizacion_rc_created" ON "cotizacion_rc"("crc_created_at");

-- CreateIndex
CREATE INDEX "idx_cotizacion_rc_expira" ON "cotizacion_rc"("crc_expira_en");

-- CreateIndex
CREATE INDEX "idx_cotizacion_rc_documento" ON "cotizacion_rc"("crc_tomador_documento");
