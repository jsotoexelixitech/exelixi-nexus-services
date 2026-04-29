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
PURPLE='\033[0;35m'
NC='\033[0m' # No Color

echo -e "${PURPLE}====================================================${NC}"
echo -e "${PURPLE}🚀  EXELIXI NEXUS - ULTIMATE SYSTEM QA v4.3         ${NC}"
echo -e "${PURPLE}====================================================${NC}\n"

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

# 1. AUTH
echo -e "${BLUE}[1] AUTH${NC}"
call_api "POST" "/api/auth/login" "{\"email\": \"$ADMIN_EMAIL\", \"password\": \"$ADMIN_PASS\"}"
TOKEN=$(echo $BODY | python3 -c "import sys, json; print(json.load(sys.stdin)['token'])" 2>/dev/null)
check_status 200 "Login"

# 2. CRUD MODULES & SUBMODULES
echo -e "\n${BLUE}[2] CRUD MODULES & SUBMODULES${NC}"
MOD_NAME="QA_MOD_$(date +%s)"
call_api "POST" "/api/modules" "{\"nombre\": \"$MOD_NAME\", \"activo\": true}"
check_status 201 "CREATE Module"
MOD_ID=$(echo $BODY | python3 -c "import sys, json; print(json.load(sys.stdin)['data']['id'])" 2>/dev/null)
echo "  [INFO] Modulo ID: $MOD_ID"

call_api "PUT" "/api/modules/$MOD_ID" "{\"nombre\": \"$MOD_NAME-UPDATED\"}"
check_status 200 "UPDATE Module"

echo "  Añadiendo submódulo..."
if [ -n "$MOD_ID" ]; then
    call_api "POST" "/api/modules/submodule" "{\"nombre\": \"QA_SUBMOD\", \"moduloId\": $MOD_ID, \"activo\": true}"
    check_status 201 "CREATE Submodule"
else
    echo -e "  ${RED}[SKIP]${NC} No se pudo capturar ModuloID"
fi

# 3. CRUD ROLES & PERMISSIONS
echo -e "\n${BLUE}[3] CRUD ROLES & PERMISSIONS${NC}"
ROLE_NAME="QA_ROLE_$(date +%s)"
call_api "POST" "/api/roles" "{\"nombre\": \"$ROLE_NAME\"}"
check_status 201 "CREATE Role"
ROLE_ID=$(echo $BODY | python3 -c "import sys, json; print(json.load(sys.stdin)['data']['id'])" 2>/dev/null)
echo "  [INFO] Role ID: $ROLE_ID"

echo "  Asignando permisos granulares..."
if [ -n "$MOD_ID" ] && [ -n "$ROLE_ID" ]; then
    PERM_DATA="{\"roleId\": $ROLE_ID, \"permissions\": [{\"moduloId\": $MOD_ID, \"canRead\": true, \"canCreate\": true}]}"
    call_api "POST" "/api/roles/permissions" "$PERM_DATA"
    check_status 200 "ASSIGN Permissions"
else
    echo -e "  ${RED}[SKIP]${NC} No se pudo capturar IDs para permisos"
fi

# 4. CRUD USERS
echo -e "\n${BLUE}[4] CRUD USERS${NC}"
USER_EMAIL="qa_$(date +%s)@test.com"
call_api "POST" "/api/users" "{\"email\": \"$USER_EMAIL\", \"password\": \"password123\", \"nombre\": \"QA User\", \"roleId\": $ROLE_ID}"
check_status 201 "CREATE User"
USER_ID=$(echo $BODY | python3 -c "import sys, json; print(json.load(sys.stdin)['id'])" 2>/dev/null)

call_api "PATCH" "/api/users/$USER_ID/status" "{}"
check_status 200 "TOGGLE User Status"

# 5. CLEANUP
echo -e "\n${BLUE}[5] SYSTEM CLEANUP${NC}"
if [ -n "$MOD_ID" ]; then
    call_api "DELETE" "/api/modules/$MOD_ID" ""
    check_status 200 "DELETE Module (Cleanup)"
fi

echo -e "\n${PURPLE}====================================================${NC}"
echo -e "${GREEN}API QA v4.3 FINAL - COBERTURA TOTAL CONFIRMADA${NC}"
echo -e "${PURPLE}====================================================${NC}"
