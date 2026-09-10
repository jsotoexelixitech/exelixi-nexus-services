#!/usr/bin/env bash
# Deploy frontends con prefijos HTTPS en cierrelmds.exelixitech.com (srv001).
# URLs públicas: https://cierrelmds.exelixitech.com/admin/, /ocr/, /formulario/, etc.
set -euo pipefail

export VITE_NEXUS_API_URL="${VITE_NEXUS_API_URL:-https://cierrelmds.exelixitech.com/nexus-api}"

build_module() {
  local dir="$1"
  local base="$2"
  local pm2_name="$3"
  echo "=== Build ${pm2_name} base=${base} ==="
  cd "${dir}/frontend"
  export VITE_APP_BASE="${base}"
  export VITE_NEXUS_API_URL
  npm run build
  pm2 restart "${pm2_name}"
}

echo "=== Build nexus-admin (VITE_APP_BASE=./, Apache strip /admin/) ==="
cd "$HOME/nexus-admin"
git pull origin main
export VITE_APP_BASE="./"
export VITE_API_URL="${VITE_NEXUS_API_URL}"
npm run build && pm2 restart nexus-admin
if [[ ! -f dist/logo-dark-bg.png ]]; then
  echo "ERROR: dist/logo-dark-bg.png no existe — verifique public/logo-dark-bg.png en el repo"
  exit 1
fi
curl -skI "https://cierrelmds.exelixitech.com/admin/logo-dark-bg.png" | head -3 || true

build_module "$HOME/exelixi/ocr-documentos-modulo"     "/ocr/"         "ocr-web"
build_module "$HOME/exelixi/Formulario-modulo"         "/formulario/"  "form-web"
build_module "$HOME/exelixi/Emision-Plan-modulo"       "/emision/"     "emision-web"
build_module "$HOME/exelixi/Pagos-Poliza-modulo"       "/pagos/"       "pagos-web"

echo "=== URLs BD (ejecutar si aún no están) ==="
cd "$HOME/nexus-api"
set -a
# shellcheck disable=SC1091
source .env 2>/dev/null || true
set +a
PSQL_URL="${DATABASE_URL%%\?*}"
psql "$PSQL_URL" <<'SQL'
UPDATE submodulo SET submodulo_url = 'https://cierrelmds.exelixitech.com/ocr/'         WHERE submodulo_nombre ILIKE 'OCR Documentos%';
UPDATE submodulo SET submodulo_url = 'https://cierrelmds.exelixitech.com/formulario/'  WHERE submodulo_nombre ILIKE 'Formulario%';
UPDATE submodulo SET submodulo_url = 'https://cierrelmds.exelixitech.com/emision/'    WHERE submodulo_nombre ILIKE 'Emisión%' OR submodulo_nombre ILIKE 'Emision%';
UPDATE submodulo SET submodulo_url = 'https://cierrelmds.exelixitech.com/pagos/'       WHERE submodulo_nombre ILIKE 'Pagos%';
SELECT submodulo_id, submodulo_nombre, submodulo_url FROM submodulo WHERE submodulo_url LIKE '%cierrelmds%';
SQL

echo "=== Verificación ==="
curl -skI "https://cierrelmds.exelixitech.com/admin/" | head -3
curl -skI "https://cierrelmds.exelixitech.com/ocr/" | head -3
curl -sk  "https://cierrelmds.exelixitech.com/nexus-api/health"
echo ""
echo "Listo."
echo "  Admin: https://cierrelmds.exelixitech.com/admin/"
echo "  SSO:   ${VITE_NEXUS_API_URL}/api/auth/sso-delegate"
