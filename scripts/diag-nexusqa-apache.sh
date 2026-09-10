#!/usr/bin/env bash
# Diagnóstico rápido Apache + PM2 en srv001qa (nexusqa)
set -euo pipefail

echo "=== PM2 módulos ==="
pm2 jlist 2>/dev/null | node -e "
const a=JSON.parse(require('fs').readFileSync(0,'utf8'));
for (const p of a.filter(x=>/ocr|form|emision|pagos|nexus/.test(x.name)))
  console.log(p.name, p.pm2_env.status, 'port', (p.pm2_env.args||[]).join(' '));
" 2>/dev/null || pm2 list

echo ""
echo "=== Local PM2 (debe ser 200) ==="
for u in \
  "http://127.0.0.1:5181/ocr/" \
  "http://127.0.0.1:5182/formulario/" \
  "http://127.0.0.1:5183/emision/" \
  "http://127.0.0.1:5184/pagos/"; do
  code=$(curl -sI -o /dev/null -w "%{http_code}" "$u" || echo ERR)
  echo "$code  $u"
done

echo ""
echo "=== HTTPS nexusqa (NO debe haber 302 a sí mismo) ==="
for p in /ocr/ /formulario/ /emision/ /pagos/; do
  echo "--- https://nexusqa.exelixitech.com${p}"
  curl -sI "https://nexusqa.exelixitech.com${p}" | grep -iE '^HTTP|^Location' || true
done

echo ""
echo "=== Apache ProxyPass (requiere sudo) ==="
echo "sudo grep -nE 'ProxyPass|Redirect' /etc/apache2/sites-enabled/*nexusqa* 2>/dev/null || echo '(sin acceso sudo)'"
