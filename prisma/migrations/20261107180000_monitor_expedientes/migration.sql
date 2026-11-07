-- CreateTable
CREATE TABLE "mkt_expediente" (
    "mexp_id" SERIAL NOT NULL,
    "mexp_empresa_id" INTEGER NOT NULL,
    "mexp_emision_id" INTEGER,
    "mexp_cnpoliza" VARCHAR(64) NOT NULL,
    "mexp_cnrecibo" VARCHAR(64),
    "mexp_producto" VARCHAR(32) NOT NULL,
    "mexp_cramo" INTEGER,
    "mexp_area" VARCHAR(16) NOT NULL DEFAULT 'desconocida',
    "mexp_centidad" VARCHAR(1),
    "mexp_citem" VARCHAR(32),
    "mexp_cgestor" VARCHAR(50),
    "mexp_ccanalalt" VARCHAR(32),
    "mexp_cusuario" VARCHAR(32),
    "mexp_xlogin" VARCHAR(100),
    "mexp_estado_pago" VARCHAR(16) NOT NULL DEFAULT 'pagada',
    "mexp_estado_documental" VARCHAR(16) NOT NULL DEFAULT 'incompleto',
    "mexp_asegurado_key" VARCHAR(120),
    "mexp_asegurado_tipo_doc" VARCHAR(2),
    "mexp_asegurado_documento" VARCHAR(32),
    "mexp_asegurado_nombre" VARCHAR(150),
    "mexp_asegurado_apellido" VARCHAR(150),
    "mexp_asegurado_email" VARCHAR(200),
    "mexp_asegurado_telefono" VARCHAR(40),
    "mexp_snapshot" JSONB,
    "mexp_carpeta" TEXT,
    "mexp_origen" VARCHAR(16) NOT NULL DEFAULT 'emision',
    "mexp_etapa_enviada" INTEGER NOT NULL DEFAULT -1,
    "mexp_intentos" INTEGER NOT NULL DEFAULT 0,
    "mexp_ultimo_envio" TIMESTAMP(6),
    "mexp_cadencia_agotada" BOOLEAN NOT NULL DEFAULT false,
    "mexp_cambios_detectados" BOOLEAN NOT NULL DEFAULT false,
    "mexp_emitida_en" TIMESTAMP(6) NOT NULL,
    "mexp_completado_en" TIMESTAMP(6),
    "mexp_created_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "mexp_updated_at" TIMESTAMP(6) NOT NULL,

    CONSTRAINT "mkt_expediente_pkey" PRIMARY KEY ("mexp_id")
);

-- CreateTable
CREATE TABLE "mkt_expediente_requisito" (
    "mreq_id" SERIAL NOT NULL,
    "mreq_expediente_id" INTEGER NOT NULL,
    "mreq_tipo" VARCHAR(32) NOT NULL,
    "mreq_estado" VARCHAR(16) NOT NULL DEFAULT 'faltante',
    "mreq_motivo" TEXT,
    "mreq_ref" TEXT,
    "mreq_origen" VARCHAR(16),
    "mreq_ocr_datos" JSONB,
    "mreq_ocr_confianza" DOUBLE PRECISION,
    "mreq_recibido_en" TIMESTAMP(6),
    "mreq_validado_en" TIMESTAMP(6),
    "mreq_validado_por" VARCHAR(128),
    "mreq_updated_at" TIMESTAMP(6) NOT NULL,

    CONSTRAINT "mkt_expediente_requisito_pkey" PRIMARY KEY ("mreq_id")
);

-- CreateTable
CREATE TABLE "mkt_expediente_evento" (
    "mevt_id" SERIAL NOT NULL,
    "mevt_expediente_id" INTEGER,
    "mevt_tipo" VARCHAR(48) NOT NULL,
    "mevt_actor" VARCHAR(128) NOT NULL,
    "mevt_detalle" JSONB,
    "mevt_created_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "mkt_expediente_evento_pkey" PRIMARY KEY ("mevt_id")
);

-- CreateTable
CREATE TABLE "mkt_expediente_config" (
    "mcfg_clave" VARCHAR(32) NOT NULL,
    "mcfg_valor" JSONB NOT NULL,
    "mcfg_actualizado_por" VARCHAR(128),
    "mcfg_updated_at" TIMESTAMP(6) NOT NULL,

    CONSTRAINT "mkt_expediente_config_pkey" PRIMARY KEY ("mcfg_clave")
);

-- CreateTable
CREATE TABLE "mkt_expediente_exclusion" (
    "mexc_id" SERIAL NOT NULL,
    "mexc_alcance" VARCHAR(16) NOT NULL,
    "mexc_empresa_id" INTEGER,
    "mexc_cnpoliza" VARCHAR(64),
    "mexc_asegurado_key" VARCHAR(120),
    "mexc_expediente_id" INTEGER,
    "mexc_motivo" TEXT NOT NULL,
    "mexc_creado_por" VARCHAR(128) NOT NULL,
    "mexc_activo" BOOLEAN NOT NULL DEFAULT true,
    "mexc_eliminado_por" VARCHAR(128),
    "mexc_eliminado_en" TIMESTAMP(6),
    "mexc_motivo_eliminacion" TEXT,
    "mexc_created_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "mkt_expediente_exclusion_pkey" PRIMARY KEY ("mexc_id")
);

-- CreateTable
CREATE TABLE "mkt_expediente_notificacion" (
    "mnot_id" SERIAL NOT NULL,
    "mnot_expediente_id" INTEGER,
    "mnot_asegurado_key" VARCHAR(120),
    "mnot_tipo" VARCHAR(32) NOT NULL,
    "mnot_etapa" INTEGER,
    "mnot_resultado" VARCHAR(24) NOT NULL,
    "mnot_destinatario" VARCHAR(200),
    "mnot_proveedor" VARCHAR(32),
    "mnot_error" TEXT,
    "mnot_lote" VARCHAR(64),
    "mnot_created_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "mkt_expediente_notificacion_pkey" PRIMARY KEY ("mnot_id")
);

-- CreateTable
CREATE TABLE "mkt_expediente_enlace" (
    "menl_id" SERIAL NOT NULL,
    "menl_token_hash" VARCHAR(64) NOT NULL,
    "menl_proposito" VARCHAR(32) NOT NULL DEFAULT 'carga_documental',
    "menl_asegurado_key" VARCHAR(120),
    "menl_expediente_ids" JSONB NOT NULL,
    "menl_expira_en" TIMESTAMP(6) NOT NULL,
    "menl_usado_en" TIMESTAMP(6),
    "menl_revocado_en" TIMESTAMP(6),
    "menl_ultimo_acceso_en" TIMESTAMP(6),
    "menl_accesos" INTEGER NOT NULL DEFAULT 0,
    "menl_created_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "mkt_expediente_enlace_pkey" PRIMARY KEY ("menl_id")
);

-- CreateTable
CREATE TABLE "mkt_expediente_job_run" (
    "mjob_id" SERIAL NOT NULL,
    "mjob_job" VARCHAR(32) NOT NULL,
    "mjob_fecha" VARCHAR(48) NOT NULL,
    "mjob_origen" VARCHAR(16) NOT NULL DEFAULT 'auto',
    "mjob_estado" VARCHAR(16) NOT NULL DEFAULT 'en_curso',
    "mjob_inicio" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "mjob_fin" TIMESTAMP(6),
    "mjob_resumen" JSONB,
    "mjob_error" TEXT,

    CONSTRAINT "mkt_expediente_job_run_pkey" PRIMARY KEY ("mjob_id")
);

-- CreateIndex
CREATE INDEX "idx_mkt_expediente_estado_area" ON "mkt_expediente"("mexp_estado_documental", "mexp_area");

-- CreateIndex
CREATE INDEX "idx_mkt_expediente_emitida" ON "mkt_expediente"("mexp_emitida_en");

-- CreateIndex
CREATE INDEX "idx_mkt_expediente_asegurado" ON "mkt_expediente"("mexp_asegurado_key");

-- CreateIndex
CREATE INDEX "idx_mkt_expediente_emision" ON "mkt_expediente"("mexp_emision_id");

-- CreateIndex
CREATE UNIQUE INDEX "uq_mkt_expediente_empresa_poliza" ON "mkt_expediente"("mexp_empresa_id", "mexp_cnpoliza");

-- CreateIndex
CREATE UNIQUE INDEX "uq_mkt_requisito_expediente_tipo" ON "mkt_expediente_requisito"("mreq_expediente_id", "mreq_tipo");

-- CreateIndex
CREATE INDEX "idx_mkt_evento_expediente" ON "mkt_expediente_evento"("mevt_expediente_id");

-- CreateIndex
CREATE INDEX "idx_mkt_evento_tipo_fecha" ON "mkt_expediente_evento"("mevt_tipo", "mevt_created_at");

-- CreateIndex
CREATE INDEX "idx_mkt_exclusion_activo" ON "mkt_expediente_exclusion"("mexc_activo", "mexc_alcance");

-- CreateIndex
CREATE INDEX "idx_mkt_notificacion_expediente" ON "mkt_expediente_notificacion"("mnot_expediente_id");

-- CreateIndex
CREATE INDEX "idx_mkt_notificacion_fecha" ON "mkt_expediente_notificacion"("mnot_created_at");

-- CreateIndex
CREATE UNIQUE INDEX "uq_mkt_enlace_hash" ON "mkt_expediente_enlace"("menl_token_hash");

-- CreateIndex
CREATE UNIQUE INDEX "uq_mkt_job_run_job_fecha" ON "mkt_expediente_job_run"("mjob_job", "mjob_fecha");

-- AddForeignKey
ALTER TABLE "mkt_expediente_requisito" ADD CONSTRAINT "fk_mkt_requisito_expediente" FOREIGN KEY ("mreq_expediente_id") REFERENCES "mkt_expediente"("mexp_id") ON DELETE CASCADE ON UPDATE CASCADE;

