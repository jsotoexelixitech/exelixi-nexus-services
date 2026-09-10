#!/usr/bin/env bash
# Inventario srv001 — PM2, puertos, Apache mapa, .env (sin secretos). Ejecutar EN srv001.
# Uso: bash ~/nexus-api/scripts/srv001-inventario-env.sh | tee ~/srv001-inventario-$(date +%F-%H%M).txt
set -uo pipefail

# Mapa canónico: nombre_pm2|puerto_esperado|tipo(api|web)
declare -a MAP=(
  "nexus-api|3092|api"
  "nexus-admin|5200|web"
  "ocr-api|4001|api"
  "ocr-web|5181|web"
  "form-api|4002|api"
  "form-web|5182|web"
  "emision-api|4004|api"
  "emision-web|5183|web"
  "pagos-api|4003|api"
  "pagos-web|5184|web"
  "sysip-nest-api|3002|api"
  "producto-builder-api|3015|api"
  "producto-builder-web|5215|web"
  "rcv-api|3001|api"
  "rcv-web|5180|web"
)

ALL_PORTS="3001|3002|3015|3092|4001|4002|4003|4004|5180|5181|5182|5183|5184|5200|5215"

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

pm2_port() {
  local name="$1"
  pm2 env "$name" 2>/dev/null | grep -E '^PORT:' | head -1 | awk '{print $2}' || true
}

pm2_preview_port() {
  local name="$1"
  pm2 describe "$name" 2>/dev/null | grep -oE 'preview --host --port [0-9]+' | awk '{print $4}' || \
  pm2 env "$name" 2>/dev/null | grep -E 'args|PORT' | head -3 || true
}

port_listener() {
  local port="$1"
  ss -tlnp 2>/dev/null | grep ":${port} " | head -1 || netstat -tlnp 2>/dev/null | grep ":${port} " | head -1 || true
}

echo "=== srv001 inventario $(date -Iseconds) ==="
echo "hostname: $(hostname)"
echo "user: $(whoami)"
echo "mapa: docs/SRV001-MAPA-PUERTOS.md (Apache = fuente de verdad)"
echo ""

echo "=== PM2 list ==="
pm2 list 2>/dev/null || echo "pm2 no disponible"
echo ""

echo "=== Cruce MAPA CANÓNICO vs PM2 vs puerto en escucha ==="
printf "  %-24s %6s  %6s  %s\n" "PROCESO" "ESP" "PM2" "LISTEN"
for entry in "${MAP[@]}"; do
  IFS='|' read -r name expected _type <<< "$entry"
  actual=""
  if [[ "$_type" == "api" ]]; then
    actual="$(pm2_port "$name")"
  else
    actual="$(pm2_preview_port "$name")"
    # preview port puede venir como línea completa; extraer número
    actual="$(echo "$actual" | grep -oE '[0-9]+' | tail -1)"
  fi
  listen="$(port_listener "$expected")"
  status="OK"
  if [[ -z "$actual" ]]; then
    status="PM2?"
  elif [[ "$actual" != "$expected" ]]; then
    status="MISMATCH"
  elif [[ -z "$listen" ]]; then
    status="DOWN"
  fi
  printf "  %-24s %6s  %6s  [%s]\n" "$name" "$expected" "${actual:--}" "$status"
  if [[ "$status" == "MISMATCH" ]]; then
    echo "    ⚠ $name: esperado :$expected, PM2 tiene :$actual — alinear ecosystem, NO Apache"
  fi
done
echo ""

echo "=== Conflictos de puerto (mismo :puerto, varios procesos) ==="
for p in 3001 3002 3015 3092 4001 4002 4003 4004 5180 5181 5182 5183 5184 5200 5215; do
  lines="$(ss -tlnp 2>/dev/null | grep ":${p} " || true)"
  if [[ -n "$lines" ]]; then
    echo "  :$p → $lines"
  fi
done
echo "  (rcv 3001/5180 y pagos 4003/5184 NO deben compartir puerto con otro servicio del mapa)"
echo ""

echo "=== Todos los puertos del mapa (ss) ==="
ss -tlnp 2>/dev/null | grep -E ":(${ALL_PORTS}) " || netstat -tlnp 2>/dev/null | grep -E "(${ALL_PORTS})" || echo "(ss/netstat no disponible)"
echo ""

echo "=== Shell actual (contaminación) ==="
echo "  PORT=${PORT:-<unset>}"
echo "  VITE_APP_BASE=${VITE_APP_BASE:-<unset>}"
echo "  DATABASE_URL=${DATABASE_URL:+<set>}${DATABASE_URL:-<unset>}"
if [[ -n "${PORT:-}" && "${PORT}" != "3092" ]]; then
  echo "  ⚠ PORT=$PORT en shell — ejecutar 'unset PORT' antes de pm2 reload módulos"
fi
echo ""

echo "=== Git status .env (módulos) ==="
for dir in \
  "$HOME/nexus-api" \
  "$HOME/exelixi/ocr-documentos-modulo" \
  "$HOME/exelixi/Formulario-modulo" \
  "$HOME/exelixi/Emision-Plan-modulo" \
  "$HOME/exelixi/Pagos-Poliza-modulo" \
  "$HOME/producto-builder" \
  "$HOME/server-api-sys" \
  "$HOME/auto-casa"
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
mask_env "$HOME/exelixi/Pagos-Poliza-modulo/server/.env"
mask_env "$HOME/exelixi/Pagos-Poliza-modulo/frontend/.env.production"
mask_env "$HOME/producto-builder/.env"
echo ""

echo "=== Health checks locales (APIs) ==="
curl -sf -o /dev/null -w "  nexus-api      :3092/health        → %{http_code}\n" http://127.0.0.1:3092/health 2>/dev/null || echo "  nexus-api: FAIL"
curl -sf -o /dev/null -w "  ocr-api        :4001/docs.json     → %{http_code}\n" http://127.0.0.1:4001/docs.json 2>/dev/null || echo "  ocr-api: FAIL"
curl -sf -o /dev/null -w "  form-api       :4002/docs.json     → %{http_code}\n" http://127.0.0.1:4002/docs.json 2>/dev/null || echo "  form-api: FAIL"
curl -sf -o /dev/null -w "  emision-api    :4004/health        → %{http_code}\n" http://127.0.0.1:4004/health 2>/dev/null || echo "  emision-api: FAIL (o ruta distinta)"
curl -sf -o /dev/null -w "  pagos-api      :4003/health        → %{http_code}\n" http://127.0.0.1:4003/health 2>/dev/null || echo "  pagos-api: FAIL"
curl -sf -o /dev/null -w "  nest-api       :3002/              → %{http_code}\n" http://127.0.0.1:3002/ 2>/dev/null || echo "  sysip-nest-api: FAIL"
curl -sf -o /dev/null -w "  ocr catalog    :4001/api/catalog   → %{http_code}\n" http://127.0.0.1:4001/api/catalog/products 2>/dev/null || echo "  ocr catalog: FAIL"
echo ""

echo "=== Health checks locales (frontends Vite preview) ==="
curl -sf -o /dev/null -w "  ocr-web        :5181/ocr/          → %{http_code}\n" http://127.0.0.1:5181/ocr/ 2>/dev/null || echo "  ocr-web: FAIL"
curl -sf -o /dev/null -w "  form-web       :5182/formulario/   → %{http_code}\n" http://127.0.0.1:5182/formulario/ 2>/dev/null || echo "  form-web: FAIL"
curl -sf -o /dev/null -w "  emision-web    :5183/emision/      → %{http_code}\n" http://127.0.0.1:5183/emision/ 2>/dev/null || echo "  emision-web: FAIL"
curl -sf -o /dev/null -w "  pagos-web      :5184/pagos/        → %{http_code}\n" http://127.0.0.1:5184/pagos/ 2>/dev/null || echo "  pagos-web: FAIL"
curl -sf -o /dev/null -w "  nexus-admin    :5200/admin/        → %{http_code}\n" http://127.0.0.1:5200/admin/ 2>/dev/null || echo "  nexus-admin: FAIL"
echo ""

echo "=== HTTPS prefijos Apache (desde srv001) ==="
for p in /ocr/ /formulario/ /emision/ /pagos/ /admin/ /producto-builder/; do
  code="$(curl -skI -o /dev/null -w '%{http_code}' "https://cierrelmds.exelixitech.com${p}" 2>/dev/null || echo "000")"
  loc="$(curl -skI "https://cierrelmds.exelixitech.com${p}" 2>/dev/null | grep -i '^location:' | tr -d '\r' || true)"
  echo "  ${p} → HTTP $code ${loc:+( $loc )}"
done
echo ""

echo "=== Fin inventario ==="
echo "Si hay MISMATCH: corregir ecosystem.config.js en repo, git pull, pm2 delete + start."
echo "NO cambiar ProxyPass Apache salvo intervención de infra."
