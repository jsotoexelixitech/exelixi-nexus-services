#!/usr/bin/env bash
# Inventario srv001 — PM2, puertos, .env (sin secretos). Ejecutar EN srv001.
# Uso: bash ~/nexus-api/scripts/srv001-inventario-env.sh | tee ~/srv001-inventario-$(date +%F-%H%M).txt
set -uo pipefail

mask_env() {
  local f="$1"
  if [[ ! -f "$f" ]]; then
    echo "  (no existe) $f"
    return
  fi
  echo "  $f"
  grep -E '^[A-Z][A-Z0-9_]*=' "$f" 2>/dev/null | while IFS= read -r line; do
    key="${line%%=*}"
    val="${line#*=}"
    if [[ "$key" =~ (SECRET|PASSWORD|KEY|TOKEN|DATABASE_URL) ]]; then
      echo "    $key=***"
    else
      echo "    $key=$val"
    fi
  done
}

echo "=== srv001 inventario $(date -Iseconds) ==="
echo "hostname: $(hostname)"
echo "user: $(whoami)"
echo ""

echo "=== PM2 ==="
pm2 list 2>/dev/null || echo "pm2 no disponible"
echo ""

echo "=== Puertos en escucha (4001-4004, 3092, 5181-5184, 3015, 5215) ==="
ss -tlnp 2>/dev/null | grep -E ':400[1-4]|:3092|:518[1-4]|:3015|:5215|:3002' || netstat -tlnp 2>/dev/null | grep -E '400[1-4]|3092|518[1-4]|3015|5215|3002' || echo "(ss/netstat no disponible)"
echo ""

echo "=== PM2 PORT por proceso (ocr-api, form-api, nexus-api) ==="
for name in nexus-api ocr-api form-api emision-api pagos-api producto-builder-api sysip-nest-api; do
  echo -n "  $name: "
  pm2 env "$name" 2>/dev/null | grep -E '^PORT:' | head -1 || echo "(no encontrado)"
done
echo ""

echo "=== Shell actual (contaminación) ==="
echo "  PORT=${PORT:-<unset>}"
echo "  VITE_APP_BASE=${VITE_APP_BASE:-<unset>}"
echo "  DATABASE_URL=${DATABASE_URL:+<set>}${DATABASE_URL:-<unset>}"
echo ""

echo "=== Git status .env (módulos) ==="
for dir in \
  "$HOME/nexus-api" \
  "$HOME/exelixi/ocr-documentos-modulo" \
  "$HOME/exelixi/Formulario-modulo" \
  "$HOME/exelixi/Emision-Plan-modulo" \
  "$HOME/exelixi/Pagos-Poliza-modulo" \
  "$HOME/producto-builder" \
  "$HOME/server-api-sys"
do
  if [[ -d "$dir/.git" ]]; then
    echo "  $dir"
    git -C "$dir" status -sb -- '**/.env' '**/.env.production' 'frontend/.env.production' 2>/dev/null | sed 's/^/    /'
  fi
done
echo ""

echo "=== Archivos .env (variables, secretos enmascarados) ==="
mask_env "$HOME/nexus-api/.env"
mask_env "$HOME/exelixi/ocr-documentos-modulo/server/.env"
mask_env "$HOME/exelixi/ocr-documentos-modulo/frontend/.env.production"
mask_env "$HOME/exelixi/Formulario-modulo/server/.env"
mask_env "$HOME/exelixi/Formulario-modulo/frontend/.env.production"
mask_env "$HOME/producto-builder/.env"
echo ""

echo "=== Health checks locales ==="
curl -sf -o /dev/null -w "  nexus-api :3092/health → %{http_code}\n" http://127.0.0.1:3092/health 2>/dev/null || echo "  nexus-api: FAIL"
curl -sf -o /dev/null -w "  ocr-api   :4001/docs.json → %{http_code}\n" http://127.0.0.1:4001/docs.json 2>/dev/null || echo "  ocr-api: FAIL"
curl -sf -o /dev/null -w "  form-api  :4002/docs.json → %{http_code}\n" http://127.0.0.1:4002/docs.json 2>/dev/null || echo "  form-api: FAIL"
curl -sf -o /dev/null -w "  ocr catalog → %{http_code}\n" http://127.0.0.1:4001/api/catalog/products 2>/dev/null || echo "  ocr catalog: FAIL"
echo ""

echo "=== Fin inventario ==="
