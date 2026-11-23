-- Carga histórica 2026 del monitor de expedientes (aditiva: solo crea una tabla nueva).
-- CreateTable
CREATE TABLE "mkt_poliza_historica" (
    "mph_id" SERIAL NOT NULL,
    "mph_cnpoliza" VARCHAR(30) NOT NULL,
    "mph_cramo" INTEGER,
    "mph_cprog" VARCHAR(20),
    "mph_origen" VARCHAR(20) NOT NULL,
    "mph_fingreso" TIMESTAMP(3) NOT NULL,
    "mph_mes" VARCHAR(7) NOT NULL,
    "mph_resultado" VARCHAR(16) NOT NULL DEFAULT 'pendiente',
    "mph_ubicacion_ocr" VARCHAR(16),
    "mph_expediente_id" INTEGER,
    "mph_ccanalalt" VARCHAR(32),
    "mph_cproductor" VARCHAR(32),
    "mph_intentos" INTEGER NOT NULL DEFAULT 0,
    "mph_consultado_en" TIMESTAMP(6),
    "mph_created_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "mph_updated_at" TIMESTAMP(6) NOT NULL,

    CONSTRAINT "mkt_poliza_historica_pkey" PRIMARY KEY ("mph_id")
);

-- CreateIndex
CREATE UNIQUE INDEX "uq_mkt_poliza_historica_cnpoliza" ON "mkt_poliza_historica"("mph_cnpoliza");

-- CreateIndex
CREATE INDEX "idx_mkt_poliza_historica_mes_origen" ON "mkt_poliza_historica"("mph_mes", "mph_origen", "mph_resultado");

-- CreateIndex
CREATE INDEX "idx_mkt_poliza_historica_resultado" ON "mkt_poliza_historica"("mph_resultado");
