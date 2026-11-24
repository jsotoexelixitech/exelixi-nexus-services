-- Campos de póliza emitida (funerario) — distintos del link de pago checkout.

ALTER TABLE "funeral_submission"
    ADD COLUMN IF NOT EXISTS "funeral_submission_cnpoliza" VARCHAR(64),
    ADD COLUMN IF NOT EXISTS "funeral_submission_cnrecibo" VARCHAR(64),
    ADD COLUMN IF NOT EXISTS "funeral_submission_urlpoliza" TEXT,
    ADD COLUMN IF NOT EXISTS "funeral_submission_emitted_at" TIMESTAMP(6);
