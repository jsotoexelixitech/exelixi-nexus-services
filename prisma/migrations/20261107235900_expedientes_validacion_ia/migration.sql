-- AlterTable
ALTER TABLE "mkt_expediente_requisito" ADD COLUMN     "mreq_analisis_intentos" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "mreq_analisis_ref" TEXT,
ADD COLUMN     "mreq_archivo_hash" VARCHAR(64),
ADD COLUMN     "mreq_decision" VARCHAR(16),
ADD COLUMN     "mreq_diagnostico" JSONB,
ADD COLUMN     "mreq_huella_poliza" VARCHAR(64),
ADD COLUMN     "mreq_proximo_analisis" TIMESTAMP(6);

