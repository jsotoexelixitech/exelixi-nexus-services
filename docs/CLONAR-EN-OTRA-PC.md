# Clonar workspace en otra PC

## Requisitos

- Node.js 18+
- Git
- Acceso a GitHub (`jsotoexelixitech`)
- `.env` de cada proyecto (no están en git — copiar manualmente o desde servidor)

## Paso 1 — Clonar repos

```bash
mkdir -p ~/Desktop/all-projects/exelixi-modulos
cd ~/Desktop/all-projects

git clone https://github.com/jsotoexelixitech/exelixi-nexus-services.git
git clone https://github.com/jsotoexelixitech/exelixi-nexus.git
git clone https://github.com/jsotoexelixitech/ocr-documentos-modulo.git       exelixi-modulos/modulo-ocr
git clone https://github.com/jsotoexelixitech/Formulario-modulo.git         exelixi-modulos/modulo-formulario
git clone https://github.com/jsotoexelixitech/Emision-Plan-modulo.git       exelixi-modulos/modulo-emision
git clone https://github.com/jsotoexelixitech/Pagos-Poliza-modulo.git       exelixi-modulos/modulo-pagos
```

## Paso 2 — Leer contexto

```bash
# Documento principal con todo el contexto de la sesión
cat exelixi-nexus-services/docs/HANDOFF-CONTEXTO-SESION.md

# SDK backend (acople módulos nuevos)
cat exelixi-nexus-services/sdk/nexus-server/README.md

# SDK frontend
cat exelixi-nexus-services/sdk/nexus-guard/README.md
```

## Paso 3 — Reglas Cursor (opcional)

Copiar a `all-projects/.cursor/rules/`:

```
exelixi-nexus-services/docs/portable/cursor-rules/*.mdc
```

## Paso 4 — Instalar dependencias

```bash
cd exelixi-nexus-services && npm install
cd ../exelixi-nexus && npm install
# Repetir en cada módulo (server/ y frontend/ según corresponda)
```

## Paso 5 — Variables de entorno

Obtener `.env` desde srv001 o backup seguro:

```bash
# En srv001
scp jsoto@192.168.8.120:~/nexus-api/.env ./exelixi-nexus-services/.env
```

**Nunca commitear `.env` a git.**

## Paso 6 — Verificar sync con producción

```bash
cd exelixi-nexus-services && git log -1 --oneline
# Debe incluir: feat(sdk): sistema completo de tokens + nexus-server SDK
```
