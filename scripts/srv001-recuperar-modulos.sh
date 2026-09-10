#!/usr/bin/env bash
# Recuperación PM2 módulos La Mundial (OCR/Form/Emisión/Pagos) en srv001.
# NO arregla Apache — si curl HTTPS sigue en 302 → producto-builder, pedir admin
# que aplique deploy/apache-cierrelmds-modulos.conf
set -euo pipefail

unset PORT VITE_APP_BASE VITE_EMISSION_CONTINUE_BASE DATABASE_URL 2>/dev/null || true
export VITE_NEXUS_API_URL="${VITE_NEXUS_API_URL:-https://cierrelmds.exelixitech.com/nexus-api}"

echo "=== 1. Puertos en escucha ==="
ss -tlnp 2>/dev/null | grep -E ':518[1-4]|:5215|:400[1-4]' || true
echo ""

echo "=== 2. PM2 cwd (ocr-web debe ser ocr-documentos-modulo, NO producto-builder) ==="
for n in ocr-web form-web emision-web pagos-web producto-builder-web; do
  echo "--- $n ---"
  pm2 describe "$n" 2>/dev/null | grep -E 'status|cwd|script path|exec cwd|args' || echo "  (no existe)"
done
echo ""

build_ocr() {
  cd "$HOME/exelixi/ocr-documentos-modulo"
  git checkout -- frontend/.env.production 2>/dev/null || true
  git pull --ff-only
  bash scripts/build-cierrelmds.sh
  pm2 reload ecosystem.config.js --env production
}

build_mod() {
  local dir="$1" base="$2"
  cd "$dir"
  git pull --ff-only || true
  cd frontend
  export VITE_APP_BASE="$base"
  export VITE_NEXUS_API_URL
  npm run build
  cd ..
  pm2 reload ecosystem.config.js --env production
}

echo "=== 3. Rebuild + reload PM2 ==="
build_ocr
build_mod "$HOME/exelixi/Formulario-modulo" "/formulario/"
build_mod "$HOME/exelixi/Emision-Plan-modulo" "/emision/"
build_mod "$HOME/exelixi/Pagos-Poliza-modulo" "/pagos/"

echo ""
echo "=== 4. Health local (debe responder, sin producto-builder) ==="
curl -sf -o /dev/null -w "  :4001 ocr-api → %{http_code}\n" http://127.0.0.1:4001/docs.json || echo "  :4001 FAIL"
curl -sf -o /dev/null -w "  :5181 ocr-web → %{http_code}\n" http://127.0.0.1:5181/ocr/ || echo "  :5181 FAIL"
curl -sf -o /dev/null -w "  :5182 form-web → %{http_code}\n" http://127.0.0.1:5182/formulario/ || echo "  :5182 FAIL"
echo ""
echo "  Primeras líneas :5181/ocr/ (NO debe decir producto-builder):"
curl -s http://127.0.0.1:5181/ocr/ 2>/dev/null | head -3 || true
echo ""

echo "=== 5. HTTPS Apache (si 302 → producto-builder, FALTA fix Apache) ==="
curl -sI "https://cierrelmds.exelixitech.com/ocr/" | grep -E 'HTTP|Location' || true
curl -sI "https://cierrelmds.exelixitech.com/formulario/" | grep -E 'HTTP|Location' || true
echo ""
echo "Si Location: /producto-builder/ → enviar deploy/apache-cierrelmds-modulos.conf al admin infra."
echo "=== Fin ==="
