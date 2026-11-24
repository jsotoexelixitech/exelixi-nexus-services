-- Portal La Mundial — Tablas de auditoría de accesos
-- Registra sesiones de login y acciones del launcher SSO

-- CreateTable portal_session
CREATE TABLE "portal_session" (
    "psess_id" SERIAL NOT NULL,
    "psess_usuario_id" INTEGER NOT NULL,
    "psess_ip" VARCHAR(64) NOT NULL DEFAULT '',
    "psess_user_agent" TEXT,
    "psess_token" TEXT NOT NULL,
    "psess_expires_at" TIMESTAMP(6) NOT NULL,
    "psess_created_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "portal_session_pkey" PRIMARY KEY ("psess_id")
);

-- CreateTable portal_audit_log
CREATE TABLE "portal_audit_log" (
    "paudit_id" SERIAL NOT NULL,
    "paudit_session_id" INTEGER NOT NULL,
    "paudit_accion" VARCHAR(64) NOT NULL,
    "paudit_producto" VARCHAR(32),
    "paudit_detalle" JSONB,
    "paudit_created_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "portal_audit_log_pkey" PRIMARY KEY ("paudit_id")
);

-- CreateIndex
CREATE INDEX "idx_portal_session_usuario" ON "portal_session"("psess_usuario_id");

-- CreateIndex
CREATE INDEX "idx_portal_audit_session" ON "portal_audit_log"("paudit_session_id");

-- AddForeignKey portal_session -> usuario
ALTER TABLE "portal_session" ADD CONSTRAINT "portal_session_psess_usuario_id_fkey"
    FOREIGN KEY ("psess_usuario_id")
    REFERENCES "usuario"("usuario_id")
    ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey portal_audit_log -> portal_session
ALTER TABLE "portal_audit_log" ADD CONSTRAINT "portal_audit_log_paudit_session_id_fkey"
    FOREIGN KEY ("paudit_session_id")
    REFERENCES "portal_session"("psess_id")
    ON DELETE CASCADE ON UPDATE CASCADE;
