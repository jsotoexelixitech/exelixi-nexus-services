#!/bin/bash

# --- CONFIGURACIÓN ---
BASE_URL="http://localhost:3021"
API_KEY="bd7c4671ebcc7e9c23cd51fa75df9f57"
ADMIN_EMAIL="admin@acme.com"
ADMIN_PASS="password123"

# Colores para salida
GREEN='\033[0;32m'
RED='\033[0;31m'
YELLOW='\033[0;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

echo -e "${BLUE}====================================================${NC}"
echo -e "${BLUE}🚀  EXELIXI NEXUS - FULL API QA SUITE v3.1          ${NC}"
echo -e "${BLUE}====================================================${NC}\n"

# Helper para peticiones
call_api() {
    local method=$1
    local path=$2
    local data=$3
    
    local response=$(curl -s -w "\n%{http_code}" -X "$method" "$BASE_URL$path" \
      -H "Content-Type: application/json" \
      -H "x-api-key: $API_KEY" \
      -H "Authorization: Bearer $TOKEN" \
      -d "$data")
      
    STATUS_CODE=$(echo "$response" | tail -n 1)
    BODY=$(echo "$response" | sed '$d')
}

check_status() {
    local expected=$1
    local name=$2
    if [ "$STATUS_CODE" -eq "$expected" ]; then
        echo -e "  ${GREEN}[PASS]${NC} $name (Status $STATUS_CODE)"
    else
        echo -e "  ${RED}[FAIL]${NC} $name (Esperado $expected, obtenido $STATUS_CODE)"
        echo -e "         Body: $BODY"
    fi
}

# --- 1. AUTH MODULE ---
echo -e "${BLUE}[1] AUTH MODULE${NC}"
call_api "POST" "/api/auth/login" "{\"email\": \"$ADMIN_EMAIL\", \"password\": \"$ADMIN_PASS\"}"
check_status 200 "Login con credenciales válidas"
# Extraer token usando python3 para ser más robustos con JSON
TOKEN=$(echo $BODY | python3 -c "import sys, json; print(json.load(sys.stdin)['token'])" 2>/dev/null)

call_api "POST" "/api/auth/login" "{\"email\": \"admin@acme.com\", \"password\": \"wrongpassword\"}"
check_status 401 "Login con password incorrecto"

# --- 2. MODULES MODULE ---
echo -e "\n${BLUE}[2] MODULES MODULE${NC}"
call_api "GET" "/api/modules" ""
check_status 200 "Listar módulos"
MODULO_ID=$(echo $BODY | python3 -c "import sys, json; print(json.load(sys.stdin)['data'][0]['id'])" 2>/dev/null)
echo "  [INFO] Modulo ID capturado: $MODULO_ID"

# --- 3. COMPANIES MODULE ---
echo -e "\n${BLUE}[3] COMPANIES MODULE${NC}"
call_api "GET" "/api/companies" ""
check_status 200 "Listar empresas"
EMPRESA_ID=$(echo $BODY | python3 -c "import sys, json; print(json.load(sys.stdin)['data'][0]['id'])" 2>/dev/null)

call_api "GET" "/api/companies/$EMPRESA_ID" ""
check_status 200 "Obtener detalle de empresa ($EMPRESA_ID)"

# --- 4. ROLES MODULE ---
echo -e "\n${BLUE}[4] ROLES MODULE${NC}"
ROLE_NAME="QA_ROLE_$(date +%s)"
call_api "POST" "/api/roles" "{\"nombre\": \"$ROLE_NAME\", \"activo\": true}"
check_status 201 "Crear nuevo rol ($ROLE_NAME)"
ROLE_ID=$(echo $BODY | python3 -c "import sys, json; print(json.load(sys.stdin)['data']['id'])" 2>/dev/null)
echo "  [INFO] Role ID capturado: $ROLE_ID"

echo "  Asignando permisos granulares..."
if [ -n "$MODULO_ID" ] && [ -n "$ROLE_ID" ]; then
    PERM_DATA="{\"roleId\": $ROLE_ID, \"permissions\": [{\"moduloId\": $MODULO_ID, \"canRead\": true, \"canCreate\": true}]}"
    call_api "POST" "/api/roles/permissions" "$PERM_DATA"
    check_status 200 "Asignación de permisos granulares"
else
    echo -e "  ${RED}[SKIP]${NC} No se pudo capturar ModuloID o RoleID"
fi

# --- 5. USERS MODULE ---
echo -e "\n${BLUE}[5] USERS MODULE${NC}"
USER_EMAIL="qa_$(date +%s)@test.com"
# Importante: roleId debe ser número si el esquema lo pide así, o coincidir con la validación
USER_DATA="{\"email\": \"$USER_EMAIL\", \"password\": \"password123\", \"nombre\": \"QA User\", \"roleId\": $ROLE_ID}"
call_api "POST" "/api/users" "$USER_DATA"
check_status 201 "Crear nuevo usuario ($USER_EMAIL)"

# --- 6. SECURITY ---
echo -e "\n${BLUE}[6] SECURITY${NC}"
call_api "GET" "/api/roles?empresaId=999" ""
check_status 403 "Cross-tenant access attempt"

echo -e "\n${BLUE}====================================================${NC}"
echo -e "${GREEN}QA SUITE v3.1 FINALIZADA${NC}"
echo -e "${BLUE}====================================================${NC}"
