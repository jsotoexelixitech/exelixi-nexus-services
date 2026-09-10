#!/usr/bin/env bash
# =============================================================================
# deploy.sh — Despliegue de exelixi-nexus-services en servidor Linux con PM2
# Uso: bash deploy.sh [--branch nombre-rama] [--app nombre-pm2]
# =============================================================================
set -euo pipefail

# ---------- Colores ----------
RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; CYAN='\033[0;36m'; NC='\033[0m'
ok()   { echo -e "${GREEN}[OK]${NC} $*"; }
info() { echo -e "${CYAN}[INFO]${NC} $*"; }
warn() { echo -e "${YELLOW}[WARN]${NC} $*"; }
fail() { echo -e "${RED}[ERROR]${NC} $*" >&2; exit 1; }

# ---------- Parámetros ----------
BRANCH="${BRANCH:-feature/nexus-guard-tenant-access}"
APP_NAME="${APP_NAME:-nexus-api}"

while [[ $# -gt 0 ]]; do
  case $1 in
    --branch) BRANCH="$2"; shift 2 ;;
    --app)    APP_NAME="$2"; shift 2 ;;
    *) fail "Argumento desconocido: $1" ;;
  esac
done

# ---------- Verificaciones previas ----------
info "Verificando dependencias del sistema..."
command -v node  >/dev/null 2>&1 || fail "Node.js no instalado"
command -v npm   >/dev/null 2>&1 || fail "npm no instalado"
command -v pm2   >/dev/null 2>&1 || fail "PM2 no instalado. Instala con: npm i -g pm2"
command -v git   >/dev/null 2>&1 || fail "git no instalado"
command -v npx   >/dev/null 2>&1 || fail "npx no disponible"

NODE_VER=$(node -v)
ok "Node $NODE_VER detectado"
ok "PM2 $(pm2 -v) detectado"

# ---------- Estado actual de PM2 ----------
info "Procesos PM2 activos:"
pm2 list

echo ""
info "Puertos en uso por node:"
ss -tlnp 2>/dev/null | grep node || netstat -tlnp 2>/dev/null | grep node || warn "ss/netstat no disponibles"

echo ""
read -rp "$(echo -e ${YELLOW}¿Continuar con el despliegue? [s/N]:${NC} )" CONFIRM
[[ "$CONFIRM" =~ ^[sS]$ ]] || { warn "Despliegue cancelado."; exit 0; }

# ---------- Git ----------
info "Actualizando código desde rama '$BRANCH'..."
git fetch --all --prune
git checkout "$BRANCH" 2>/dev/null || git checkout -b "$BRANCH" --track "origin/$BRANCH"
git pull origin "$BRANCH"
ok "Código actualizado. Commit: $(git log -1 --format='%h %s')"

# ---------- Dependencias ----------
info "Instalando dependencias npm..."
npm install --production=false
ok "Dependencias instaladas"

# ---------- Prisma ----------
info "Generando cliente Prisma..."
npx prisma generate
ok "Prisma client generado"

info "Ejecutando migraciones de base de datos..."
npx prisma migrate deploy
ok "Migraciones aplicadas"

# ---------- Build ----------
info "Compilando TypeScript..."
npm run build
ok "Build completado → dist/"

# ---------- PM2: reiniciar o crear ----------
echo ""
if pm2 describe "$APP_NAME" >/dev/null 2>&1; then
  info "Reiniciando proceso PM2 '$APP_NAME'..."
  pm2 restart "$APP_NAME" --update-env
  ok "Proceso reiniciado"
else
  warn "Proceso '$APP_NAME' no encontrado en PM2. Creando nuevo proceso..."
  pm2 start dist/server.js \
    --name "$APP_NAME" \
    --instances 1 \
    --max-memory-restart 512M \
    --log-date-format "YYYY-MM-DD HH:mm:ss" \
    --merge-logs
  ok "Proceso '$APP_NAME' creado"

  info "Guardando configuración PM2 para reinicio automático..."
  pm2 save
  ok "PM2 guardado"
fi

# ---------- Verificación post-deploy ----------
echo ""
info "Esperando 3 segundos para que el servidor arranque..."
sleep 3

PORT="${PORT:-3091}"
HOST="${HOST:-localhost}"
HEALTH_URL="http://${HOST}:${PORT}/health"

info "Verificando endpoint de salud: $HEALTH_URL"
RESPONSE=$(curl -sf --max-time 5 "$HEALTH_URL" 2>/dev/null) || RESPONSE=""

if echo "$RESPONSE" | grep -q '"status"'; then
  ok "Servidor respondiendo: $RESPONSE"
else
  warn "El servidor no responde en $HEALTH_URL. Revisa los logs: pm2 logs $APP_NAME"
fi

# ---------- Verificar endpoint NexusGuard ----------
info "Verificando endpoint /api/access/verify (debe ser público)..."
VERIFY_STATUS=$(curl -so /dev/null -w "%{http_code}" --max-time 5 "http://${HOST}:${PORT}/api/access/verify")

if [[ "$VERIFY_STATUS" == "401" ]]; then
  ok "/api/access/verify responde 401 (público, pide token) — NexusGuard activo"
elif [[ "$VERIFY_STATUS" == "404" ]]; then
  fail "/api/access/verify devuelve 404 — el deploy no incluyó los cambios de NexusGuard"
else
  warn "/api/access/verify respondió con código $VERIFY_STATUS"
fi

# ---------- Resumen final ----------
echo ""
echo -e "${GREEN}========================================${NC}"
echo -e "${GREEN}  DESPLIEGUE COMPLETADO${NC}"
echo -e "${GREEN}========================================${NC}"
pm2 list
echo ""
echo -e "  API:        http://${HOST}:${PORT}"
echo -e "  Health:     http://${HOST}:${PORT}/health"
echo -e "  Verify:     http://${HOST}:${PORT}/api/access/verify"
echo -e "  Logs:       pm2 logs ${APP_NAME}"
echo -e "  Monitoreo:  pm2 monit"
echo -e "${GREEN}========================================${NC}"
