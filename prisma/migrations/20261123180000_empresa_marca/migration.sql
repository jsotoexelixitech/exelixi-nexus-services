-- Marca por empresa (logo y colores) que toman los portales de los módulos (Condominio, Hogar…).
CREATE TABLE IF NOT EXISTS "empresa_marca" (
    "em_empresa_id" INTEGER NOT NULL,
    "em_color_principal" VARCHAR(7),
    "em_color_secundario" VARCHAR(7),
    "em_color_terciario" VARCHAR(7),
    "em_logo" BYTEA,
    "em_logo_mime" VARCHAR(40),
    "em_logo_tamano" INTEGER,
    "em_actualizado_por" VARCHAR(160),
    "em_updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "empresa_marca_pkey" PRIMARY KEY ("em_empresa_id"),
    CONSTRAINT "empresa_marca_empresa_fkey" FOREIGN KEY ("em_empresa_id") REFERENCES "empresa"("empresa_id") ON DELETE CASCADE ON UPDATE CASCADE
);
