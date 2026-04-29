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
NC='\033[0m' # No Color

echo -e "🚀 Iniciando QA Test Suite v2 (Status Code aware)...\n"

# Helper para hacer peticiones y obtener status + body
# Uso: call_api <METHOD> <PATH> <DATA>
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

# 1. Login
echo "Step 1: Autenticación..."
LOGIN_RES=$(curl -s -X POST "$BASE_URL/api/auth/login" \
  -H "Content-Type: application/json" \
  -H "x-api-key: $API_KEY" \
  -d "{\"email\": \"$ADMIN_EMAIL\", \"password\": \"$ADMIN_PASS\"}")

TOKEN=$(echo $LOGIN_RES | grep -oP '(?<="token":")[^"]*')

if [ -z "$TOKEN" ]; then
    echo -e "${RED}[FAIL] No se pudo obtener el token JWT.${NC}"
    exit 1
else
    echo -e "${GREEN}[OK] Token obtenido exitosamente.${NC}"
fi

# 2. JSON Mal Formado
echo -e "\nStep 2: JSON Mal Formado..."
call_api "POST" "/api/roles" '{"nombre": "Test",}'
if [ "$STATUS_CODE" -ge 400 ]; then
    echo -e "${GREEN}[OK] Rechazado con status $STATUS_CODE.${NC}"
else
    echo -e "${RED}[FAIL] Se aceptó JSON mal formado (Status $STATUS_CODE).${NC}"
fi

# 3. Zod Validation
echo -e "\nStep 3: Esquema Inválido (Zod)..."
call_api "POST" "/api/users" '{"email": "not-an-email", "password": "123"}'
if [ "$STATUS_CODE" -eq 400 ]; then
    echo -e "${GREEN}[OK] Zod bloqueó la petición (Status 400).${NC}"
else
    echo -e "${RED}[FAIL] Zod no bloqueó la petición (Status $STATUS_CODE).${NC}"
fi

# 4. Multi-tenancy (Cross-access)
echo -e "\nStep 4: Multi-tenancy (Cross-access)..."
call_api "GET" "/api/roles?empresaId=999" ""
if [ "$STATUS_CODE" -eq 403 ]; then
    echo -e "${GREEN}[OK] Acceso cruzado bloqueado con 403.${NC}"
else
    echo -e "${RED}[FAIL] Acceso cruzado PERMITIDO (Status $STATUS_CODE).${NC}"
    echo "Body: $BODY"
fi

# 5. Token Manipulado
echo -e "\nStep 5: Token Manipulado..."
TAMPERED_TOKEN="${TOKEN%?}x"
TAMPERED_RES=$(curl -s -w "\n%{http_code}" -X GET "$BASE_URL/api/auth/me" \
  -H "x-api-key: $API_KEY" \
  -H "Authorization: Bearer $TAMPERED_TOKEN")
T_STATUS=$(echo "$TAMPERED_RES" | tail -n 1)

if [ "$T_STATUS" -eq 401 ]; then
    echo -e "${GREEN}[OK] Token manipulado rechazado con 401.${NC}"
else
    echo -e "${RED}[FAIL] Token manipulado aceptado (Status $T_STATUS).${NC}"
fi

# 6. Duplicate Entry
echo -e "\nStep 6: Duplicate Entry (Unique Constraint)..."
ROLE_NAME="QA_ROLE_$(date +%s)"
call_api "POST" "/api/roles" "{\"nombre\": \"$ROLE_NAME\", \"activo\": true}"
# Segunda vez
call_api "POST" "/api/roles" "{\"nombre\": \"$ROLE_NAME\", \"activo\": true}"

if [ "$STATUS_CODE" -eq 409 ]; then
    echo -e "${GREEN}[OK] Duplicado rechazado con 409.${NC}"
else
    echo -e "${YELLOW}[WARN] El duplicado NO falló (Status $STATUS_CODE). Posible falta de índice único en DB.${NC}"
    echo "Body: $BODY"
fi

echo -e "\n--- QA Suite v2 Finalizada ---"
