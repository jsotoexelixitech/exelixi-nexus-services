#!/bin/bash
# setup-ssl-srv001.sh — Let's Encrypt + nginx reverse proxy para srv001 (192.168.8.120)
#
# PRERREQUISITOS (infra/DNS — antes de ejecutar):
#   1. Registros A apuntando a la IP PUBLICA que hace NAT → 192.168.8.120
#   2. Puertos 80 y 443 abiertos en firewall/NAT hacia srv001
#   3. Ejecutar como root o con sudo en srv001 (Ubuntu/Debian)
#
# Uso:
#   chmod +x setup-ssl-srv001.sh
#   sudo ./setup-ssl-srv001.sh
#
# Renovacion: certbot timer (automatico). Probar: sudo certbot renew --dry-run

set -euo pipefail

EMAIL="javier.soto@exelixitech.com"

DOMAINS=(
  "nexus-api.lamundialdeseguros.com"
  "nexus-admin.lamundialdeseguros.com"
  "ocr-api.dev.lamundialdeseguros.com"
  "ocr.dev.lamundialdeseguros.com"
  "form-api.dev.lamundialdeseguros.com"
  "form.dev.lamundialdeseguros.com"
  "pagos-api.dev.lamundialdeseguros.com"
  "pagos.dev.lamundialdeseguros.com"
  "emision-api.dev.lamundialdeseguros.com"
  "emision.dev.lamundialdeseguros.com"
  "rcv-api.dev.lamundialdeseguros.com"
  "rcv.dev.lamundialdeseguros.com"
)

# Puerto local PM2 por host (HTTP interno — nginx termina SSL)
declare -A UPSTREAM=(
  ["nexus-api.lamundialdeseguros.com"]=3092
  ["nexus-admin.lamundialdeseguros.com"]=5200
  ["ocr-api.dev.lamundialdeseguros.com"]=4001
  ["ocr.dev.lamundialdeseguros.com"]=5181
  ["form-api.dev.lamundialdeseguros.com"]=4002
  ["form.dev.lamundialdeseguros.com"]=5182
  ["pagos-api.dev.lamundialdeseguros.com"]=4003
  ["pagos.dev.lamundialdeseguros.com"]=5184
  ["emision-api.dev.lamundialdeseguros.com"]=4004
  ["emision.dev.lamundialdeseguros.com"]=5183
  ["rcv-api.dev.lamundialdeseguros.com"]=3001
  ["rcv.dev.lamundialdeseguros.com"]=5180
)

echo "==> Instalando nginx y certbot..."
apt-get update -qq
apt-get install -y nginx certbot python3-certbot-nginx

echo "==> Configuracion nginx temporal HTTP (para validacion ACME)..."
NGINX_SITE="/etc/nginx/sites-available/dev-ssl-srv001.conf"
SERVER_NAMES="${DOMAINS[*]}"

cat > "$NGINX_SITE" <<EOF
server {
  listen 80;
  server_name ${SERVER_NAMES// / };
  location /.well-known/acme-challenge/ { root /var/www/html; }
  location / { return 404; }
}
EOF

ln -sf "$NGINX_SITE" /etc/nginx/sites-enabled/dev-ssl-srv001.conf
rm -f /etc/nginx/sites-enabled/default 2>/dev/null || true
nginx -t
systemctl reload nginx

echo "==> Solicitando certificado Let's Encrypt..."
CERT_ARGS=()
for d in "${DOMAINS[@]}"; do
  CERT_ARGS+=(-d "$d")
done

certbot certonly --webroot -w /var/www/html \
  --email "$EMAIL" --agree-tos --non-interactive \
  "${CERT_ARGS[@]}"

# Certificado multi-dominio: carpeta del primer -d
CERT_DIR="/etc/letsencrypt/live/${DOMAINS[0]}"

echo "==> nginx HTTPS final (proxy → PM2 local)..."
cat > "$NGINX_SITE" <<'HEADER'
# Generado por setup-ssl-srv001.sh — srv001 dev SSL
HEADER

for domain in "${DOMAINS[@]}"; do
  port="${UPSTREAM[$domain]}"
  cat >> "$NGINX_SITE" <<EOF

server {
  listen 443 ssl http2;
  server_name ${domain};

  ssl_certificate     ${CERT_DIR}/fullchain.pem;
  ssl_certificate_key ${CERT_DIR}/privkey.pem;
  include /etc/letsencrypt/options-ssl-nginx.conf;
  ssl_dhparam /etc/letsencrypt/ssl-dhparams.pem;

  location / {
    proxy_pass http://127.0.0.1:${port};
    proxy_http_version 1.1;
    proxy_set_header Host \$host;
    proxy_set_header X-Real-IP \$remote_addr;
    proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto https;
    proxy_set_header Upgrade \$http_upgrade;
    proxy_set_header Connection "upgrade";
  }
}
EOF
done

cat >> "$NGINX_SITE" <<EOF

server {
  listen 80;
  server_name ${SERVER_NAMES// / };
  return 301 https://\$host\$request_uri;
}
EOF

nginx -t
systemctl reload nginx

echo ""
echo "==> SSL activo. URLs HTTPS:"
for domain in "${DOMAINS[@]}"; do
  echo "  https://${domain}  -> 127.0.0.1:${UPSTREAM[$domain]}"
done
echo ""
echo "==> Siguiente paso: actualizar .env / VITE_* en apps:"
echo "    VITE_NEXUS_API_URL=https://nexus-api.lamundialdeseguros.com"
echo ""
echo "==> Probar renovacion:"
echo "    certbot renew --dry-run"
