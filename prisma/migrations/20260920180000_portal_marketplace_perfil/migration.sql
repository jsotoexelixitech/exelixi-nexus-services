-- Perfil portal / marketplace (Sis2000) por empresa y usuario

CREATE TABLE IF NOT EXISTS "empresa_portal_config" (
    "epc_empresa_id" INTEGER NOT NULL,
    "epc_centidad" CHAR(1) NOT NULL DEFAULT 'P',
    "epc_citem" VARCHAR(20) NOT NULL DEFAULT '80080',
    "epc_cproductor" VARCHAR(20),
    "epc_cusuario" VARCHAR(20),
    "epc_resolver_gestor_email" BOOLEAN NOT NULL DEFAULT true,
    "epc_ccanalalt_in" VARCHAR(20),
    "epc_cscanalalt_in" VARCHAR(20),
    "epc_updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "empresa_portal_config_pkey" PRIMARY KEY ("epc_empresa_id"),
    CONSTRAINT "empresa_portal_config_empresa_fkey" FOREIGN KEY ("epc_empresa_id") REFERENCES "empresa"("empresa_id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE TABLE IF NOT EXISTS "usuario_portal_perfil" (
    "upp_usuario_id" INTEGER NOT NULL,
    "upp_resolver_gestor_email" BOOLEAN NOT NULL DEFAULT true,
    "upp_centidad" CHAR(1),
    "upp_citem" VARCHAR(20),
    "upp_cproductor" VARCHAR(20),
    "upp_cusuario" VARCHAR(20),
    "upp_cgestor" VARCHAR(50),
    "upp_ccanalalt_in" VARCHAR(20),
    "upp_cscanalalt_in" VARCHAR(20),
    "upp_updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "usuario_portal_perfil_pkey" PRIMARY KEY ("upp_usuario_id"),
    CONSTRAINT "usuario_portal_perfil_usuario_fkey" FOREIGN KEY ("upp_usuario_id") REFERENCES "usuario"("usuario_id") ON DELETE CASCADE ON UPDATE CASCADE
);
