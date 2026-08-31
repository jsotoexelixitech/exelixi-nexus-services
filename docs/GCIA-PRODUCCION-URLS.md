# Srv-Gcia-proyect — URLs producción (\*.exelixitech.com)

**Host:** `Srv-Gcia-proyect` · **IP:** `172.30.149.75` · **PM2:** `proyect`  
**Puertos PM2:** iguales a QA/srv001 (no cambiar). DNS/Apache/Caddy apunta cada subdominio al puerto local.

## URLs públicas HTTPS

| Servicio    | URL producción                     | PM2                       | Puerto local |
| ----------- | ---------------------------------- | ------------------------- | ------------ |
| OCR         | https://ocr.exelixitech.com        | ocr-web / ocr-api         | 5181 / 4001  |
| Formulario  | https://formulario.exelixitech.com | form-web / form-api       | 5182 / 4002  |
| Emisión     | https://emision.exelixitech.com    | emision-web / emision-api | 5183 / 4004  |
| Pagos       | https://pagos.exelixitech.com      | pagos-web / pagos-api     | 5184 / 4003  |
| Nexus API   | https://nexus-api.exelixitech.com  | nexus-api                 | 3092         |
| nest-api    | https://nest-api.exelixitech.com   | sysip-nest-api            | 3002         |
| Nexus Admin | http://172.30.149.75:5200/         | nexus-admin               | 5200         |

Acceso interno (sin DNS): `http://172.30.149.75:<puerto>` — ver `07-srv-gcia-proyect.mdc`.

> **Dominio:** usar siempre **`exelixitech.com`** (con **i**). No registrar `exelicitech.com`.

## `.env` nexus-api (`~/exelixi/nexus-api/.env`)

```bash
# Bridge SSO — origen público del API (no reescribir módulos a :3092)
NEXUS_PUBLIC_ORIGIN=https://nexus-api.exelixitech.com

# Opcional — CORS extra (exelixitech.com ya permitido por sufijo)
# ALLOWED_ORIGINS=https://ocr.exelixitech.com,https://formulario.exelixitech.com
```

Tras editar:

```bash
unset PORT DATABASE_URL
cd ~/exelixi/nexus-api && npm run build && pm2 reload nexus-api --update-env && pm2 save
```

## `.env` nest-api (`~/server-api-sys/.env`)

```bash
PUBLIC_API_ORIGIN=https://nest-api.exelixitech.com
CORS_ORIGIN=https://ocr.exelixitech.com,https://formulario.exelixitech.com,https://emision.exelixitech.com,https://pagos.exelixitech.com,https://nexus-api.exelixitech.com
```

```bash
unset PORT DATABASE_URL
cd ~/server-api-sys && npm run build && pm2 reload sysip-nest-api --update-env && pm2 save
```

## Submódulos en BD (PostgreSQL `exelixi_nexus`)

Actualizar `submodulo_url` para el catálogo producción GCIA:

```bash
cd ~/exelixi/nexus-api && source .env && unset PORT
PSQL_URL="${DATABASE_URL%%\?*}"
psql "$PSQL_URL" -c "SELECT submodulo_id, submodulo_nombre, submodulo_url FROM submodulo WHERE submodulo_estatus = true ORDER BY submodulo_id;"
```

Ejemplo (ajustar IDs según el SELECT):

```sql
UPDATE submodulo SET submodulo_url = 'https://ocr.exelixitech.com/' WHERE submodulo_nombre ILIKE '%OCR%';
UPDATE submodulo SET submodulo_url = 'https://formulario.exelixitech.com/' WHERE submodulo_nombre ILIKE '%Formulario%';
UPDATE submodulo SET submodulo_url = 'https://emision.exelixitech.com/' WHERE submodulo_nombre ILIKE '%Emisi%';
UPDATE submodulo SET submodulo_url = 'https://pagos.exelixitech.com/' WHERE submodulo_nombre ILIKE '%Pagos%';
```

## Build fronts (subdominio en raíz `/`)

Desde el repo de módulos en servidor (o clon local):

```bash
unset PORT VITE_APP_BASE DATABASE_URL
cd ~/exelixi/exelixi-modulos   # o ruta donde esté scripts/build-gcia-produccion.sh
bash scripts/build-gcia-produccion.sh ocr
bash scripts/build-gcia-produccion.sh formulario
bash scripts/build-gcia-produccion.sh emision
bash scripts/build-gcia-produccion.sh pagos
```

Si cada módulo es repo separado (`~/exelixi/ocr-documentos-modulo`, etc.), copiar el script o exportar manualmente:

```bash
export VITE_NEXUS_API_URL=https://nexus-api.exelixitech.com
export VITE_NEXUS_USE_MODULE_PROXY=0
export VITE_APP_BASE=/
# + VITE_*_CONTINUE_BASE según módulo (ver build-gcia-produccion.sh)
cd ~/exelixi/Pagos-Poliza-modulo/frontend && npm run build
```

Reload PM2:

```bash
unset PORT VITE_APP_BASE DATABASE_URL
pm2 reload ocr-web form-web emision-web pagos-web --update-env
pm2 save
```

## Verificación

```bash
curl -sI https://ocr.exelixitech.com | head -3
curl -s https://nexus-api.exelixitech.com/health
curl -s https://nest-api.exelixitech.com/api/v1/health 2>/dev/null || curl -sI https://nest-api.exelixitech.com | head -3
curl -s http://127.0.0.1:3092/health
```

## No mezclar entornos

| Entorno             | URLs                                     |
| ------------------- | ---------------------------------------- |
| QA                  | `https://nexusqa.exelixitech.com/...`    |
| Cierre (srv001)     | `https://cierrelmds.exelixitech.com/...` |
| **Producción GCIA** | subdominios `*.exelixitech.com` arriba   |
