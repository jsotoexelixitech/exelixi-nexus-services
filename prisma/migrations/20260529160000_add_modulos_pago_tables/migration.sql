-- CreateTable
CREATE TABLE "producto" (
    "producto_id" SERIAL NOT NULL,
    "producto_nombre" VARCHAR NOT NULL,
    "producto_empresa_id" INTEGER NOT NULL,
    "producto_created_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "producto_pkey" PRIMARY KEY ("producto_id")
);

-- CreateTable
CREATE TABLE "plan" (
    "plan_id" SERIAL NOT NULL,
    "plan_nombre" VARCHAR NOT NULL,
    "plan_producto_id" INTEGER NOT NULL,
    "plan_empresa_id" INTEGER NOT NULL,
    "plan_created_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "plan_pkey" PRIMARY KEY ("plan_id")
);

-- CreateTable
CREATE TABLE "cotizacion" (
    "cotizacion_id" SERIAL NOT NULL,
    "cotizacion_empresa_id" INTEGER NOT NULL,
    "cotizacion_producto_id" INTEGER,
    "cotizacion_plan_id" INTEGER,
    "cotizacion_estado" VARCHAR NOT NULL DEFAULT 'borrador',
    "cotizacion_json_data" JSONB NOT NULL,
    "cotizacion_created_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "cotizacion_updated_at" TIMESTAMP(6),

    CONSTRAINT "cotizacion_pkey" PRIMARY KEY ("cotizacion_id")
);

-- CreateTable
CREATE TABLE "ocr" (
    "ocr_id" SERIAL NOT NULL,
    "ocr_empresa_id" INTEGER NOT NULL,
    "ocr_cotizacion_id" INTEGER,
    "ocr_tipo_documento" VARCHAR NOT NULL,
    "ocr_ruta_documento" VARCHAR NOT NULL,
    "ocr_json_data" JSONB,
    "ocr_created_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ocr_pkey" PRIMARY KEY ("ocr_id")
);

-- CreateTable
CREATE TABLE "pago_metodo" (
    "pago_metodo_id" SERIAL NOT NULL,
    "pago_metodo_nombre" VARCHAR NOT NULL,
    "pago_metodo_empresa_id" INTEGER,

    CONSTRAINT "pago_metodo_pkey" PRIMARY KEY ("pago_metodo_id")
);

-- CreateTable
CREATE TABLE "pago" (
    "pago_id" SERIAL NOT NULL,
    "pago_empresa_id" INTEGER NOT NULL,
    "pago_cotizacion_id" INTEGER,
    "pago_metodo_id" INTEGER NOT NULL,
    "pago_referencia_banco" VARCHAR NOT NULL,
    "pago_monto" DECIMAL(18,2) NOT NULL,
    "pago_moneda" CHAR(3) NOT NULL DEFAULT 'VES',
    "pago_estado" VARCHAR NOT NULL DEFAULT 'pendiente',
    "pago_banco_origen" VARCHAR,
    "pago_telefono_origen" VARCHAR,
    "pago_fecha_pago" TIMESTAMP(6) NOT NULL,
    "pago_respuesta_json" JSONB,
    "pago_created_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "pago_pkey" PRIMARY KEY ("pago_id")
);

-- CreateTable
CREATE TABLE "emision" (
    "emision_id" SERIAL NOT NULL,
    "emision_empresa_id" INTEGER NOT NULL,
    "emision_cotizacion_id" INTEGER NOT NULL,
    "emision_pago_id" INTEGER,
    "emision_poliza_numero" VARCHAR NOT NULL,
    "emision_estado" VARCHAR NOT NULL DEFAULT 'emitida',
    "emision_json_data" JSONB,
    "emision_created_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "emision_pkey" PRIMARY KEY ("emision_id")
);

-- CreateIndex
CREATE UNIQUE INDEX "uq_pago_empresa_referencia" ON "pago"("pago_empresa_id", "pago_referencia_banco");

-- AddForeignKey
ALTER TABLE "producto" ADD CONSTRAINT "fk_producto_empresa" FOREIGN KEY ("producto_empresa_id") REFERENCES "empresa"("empresa_id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "plan" ADD CONSTRAINT "fk_plan_producto" FOREIGN KEY ("plan_producto_id") REFERENCES "producto"("producto_id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "plan" ADD CONSTRAINT "fk_plan_empresa" FOREIGN KEY ("plan_empresa_id") REFERENCES "empresa"("empresa_id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "cotizacion" ADD CONSTRAINT "fk_cotizacion_empresa" FOREIGN KEY ("cotizacion_empresa_id") REFERENCES "empresa"("empresa_id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "cotizacion" ADD CONSTRAINT "fk_cotizacion_producto" FOREIGN KEY ("cotizacion_producto_id") REFERENCES "producto"("producto_id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "cotizacion" ADD CONSTRAINT "fk_cotizacion_plan" FOREIGN KEY ("cotizacion_plan_id") REFERENCES "plan"("plan_id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "ocr" ADD CONSTRAINT "fk_ocr_empresa" FOREIGN KEY ("ocr_empresa_id") REFERENCES "empresa"("empresa_id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "ocr" ADD CONSTRAINT "fk_ocr_cotizacion" FOREIGN KEY ("ocr_cotizacion_id") REFERENCES "cotizacion"("cotizacion_id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "pago_metodo" ADD CONSTRAINT "fk_pago_metodo_empresa" FOREIGN KEY ("pago_metodo_empresa_id") REFERENCES "empresa"("empresa_id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "pago" ADD CONSTRAINT "fk_pago_empresa" FOREIGN KEY ("pago_empresa_id") REFERENCES "empresa"("empresa_id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "pago" ADD CONSTRAINT "fk_pago_cotizacion" FOREIGN KEY ("pago_cotizacion_id") REFERENCES "cotizacion"("cotizacion_id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "pago" ADD CONSTRAINT "fk_pago_metodo" FOREIGN KEY ("pago_metodo_id") REFERENCES "pago_metodo"("pago_metodo_id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "emision" ADD CONSTRAINT "fk_emision_empresa" FOREIGN KEY ("emision_empresa_id") REFERENCES "empresa"("empresa_id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "emision" ADD CONSTRAINT "fk_emision_cotizacion" FOREIGN KEY ("emision_cotizacion_id") REFERENCES "cotizacion"("cotizacion_id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "emision" ADD CONSTRAINT "fk_emision_pago" FOREIGN KEY ("emision_pago_id") REFERENCES "pago"("pago_id") ON DELETE NO ACTION ON UPDATE NO ACTION;
