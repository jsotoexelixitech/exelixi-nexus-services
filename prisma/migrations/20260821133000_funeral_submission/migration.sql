-- Solicitudes funerario: revisión técnica + scoring (flujo aislado)

CREATE TABLE IF NOT EXISTS "funeral_submission" (
    "funeral_submission_id" UUID NOT NULL,
    "funeral_submission_empresa_id" INTEGER NOT NULL,
    "funeral_submission_session_id" VARCHAR(128) NOT NULL,
    "funeral_submission_canal" VARCHAR(64) NOT NULL DEFAULT 'default',
    "funeral_submission_estado" VARCHAR(32) NOT NULL DEFAULT 'pending',
    "funeral_submission_tomador_rif" VARCHAR(32),
    "funeral_submission_tomador_nombre" VARCHAR(256),
    "funeral_submission_tomador_email" VARCHAR(256),
    "funeral_submission_cplan" VARCHAR(16) NOT NULL,
    "funeral_submission_plan_name" VARCHAR(256),
    "funeral_submission_cramo" INTEGER,
    "funeral_submission_score_total" INTEGER NOT NULL DEFAULT 0,
    "funeral_submission_score_breakdown" JSONB NOT NULL DEFAULT '[]',
    "funeral_submission_health_answers" JSONB NOT NULL DEFAULT '{}',
    "funeral_submission_snapshot" JSONB NOT NULL,
    "funeral_submission_reject_reason" TEXT,
    "funeral_submission_reviewed_by" VARCHAR(128),
    "funeral_submission_reviewed_at" TIMESTAMP(6),
    "funeral_submission_payment_url" TEXT,
    "funeral_submission_payment_sid" VARCHAR(128),
    "funeral_submission_payment_expires_at" TIMESTAMP(6),
    "funeral_submission_created_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "funeral_submission_updated_at" TIMESTAMP(6) NOT NULL,

    CONSTRAINT "funeral_submission_pkey" PRIMARY KEY ("funeral_submission_id")
);

CREATE INDEX IF NOT EXISTS "idx_funeral_submission_empresa_estado"
    ON "funeral_submission"("funeral_submission_empresa_id", "funeral_submission_estado");

CREATE INDEX IF NOT EXISTS "idx_funeral_submission_session"
    ON "funeral_submission"("funeral_submission_session_id");

ALTER TABLE "funeral_submission"
    ADD CONSTRAINT "fk_funeral_submission_empresa"
    FOREIGN KEY ("funeral_submission_empresa_id")
    REFERENCES "empresa"("empresa_id")
    ON DELETE CASCADE ON UPDATE CASCADE;
