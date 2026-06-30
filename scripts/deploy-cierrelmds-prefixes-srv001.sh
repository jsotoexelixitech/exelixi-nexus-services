#!/usr/bin/env bash
# Deploy frontends con prefijos HTTPS en cierrelmds.exelixitech.com (srv001).
# Requiere: git pull previo en cada repo + Apache con ProxyPass SIN strip:
#   /ocr/         → http://127.0.0.1:5181/ocr/
#   /formulario/  → http://127.0.0.1:5182/formulario/
#   /emision/     → http://127.0.0.1:5183/emision/
#   /pagos/       → http://127.0.0.1:5184/pagos/
#   /nexus-api/   → http://127.0.0.1:3092/
set -euo pipefail

export VITE_NEXUS_API_URL="${VITE_NEXUS_API_URL:-https://cierrelmds.exelixitech.com/nexus-api}"

build_module() {
  local dir="$1"
  local base="$2"
  local pm2_name="$3"
  echo "=== Build ${pm2_name} base=${base} ==="
  cd "${dir}/frontend"
  export VITE_APP_BASE="${base}"
  npm run build
  pm2 restart "${pm2_name}"
}

echo "=== Build nexus-admin base=/admin/ ==="
cd "$HOME/nexus-admin"
git pull origin main
export VITE_APP_BASE="/admin/"
export VITE_API_URL="${VITE_NEXUS_API_URL}"
npm run build && pm2 restart nexus-admin

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
curl -skI -H "Host: cierrelmds.exelixitech.com" "https://127.0.0.1/nexus-api/health" | head -3
curl -skI -H "Host: cierrelmds.exelixitech.com" "https://127.0.0.1/ocr/" | head -3
curl -skI -H "Host: cierrelmds.exelixitech.com" "https://127.0.0.1/admin/" | head -3
echo "Listo. Admin: https://cierrelmds.exelixitech.com/admin/"
echo "QASys2000 SSO: ${VITE_NEXUS_API_URL}/api/auth/sso-delegate"
