# Srv-Gcia-proyect — URLs producción (\*.exelixitech.com)

**Host:** `Srv-Gcia-proyect` · **IP:** `172.30.149.75` · **PM2:** `proyect`  
**Puertos PM2:** iguales a QA/srv001 (no cambiar). DNS/Apache/Caddy apunta cada subdominio al puerto local.

## URLs públicas HTTPS

| Servicio      | URL producción                        | PM2                       | Puerto local |
| ------------- | ------------------------------------- | ------------------------- | ------------ |
| OCR           | https://ocr.exelixitech.com           | ocr-web / ocr-api         | 5181 / 4001  |
| Formulario    | https://formulario.exelixitech.com    | form-web / form-api       | 5182 / 4002  |
| Emisión       | https://emision.exelixitech.com       | emision-web / emision-api | 5183 / 4004  |
| Pagos         | https://pagos.exelixitech.com         | pagos-web / pagos-api     | 5184 / 4003  |
| **Nexus API** | **https://nexus.exelixitech.com**     | nexus-api                 | 3092         |
| **nest-api**  | **https://nexus-api.exelixitech.com** | sysip-nest-api            | 3002         |
| Nexus Admin   | http://172.30.149.75:5200/            | nexus-admin               | 5200         |

Acceso interno (sin DNS): `http://172.30.149.75:<puerto>` — ver `07-srv-gcia-proyect.mdc`.

> **Dominio:** usar siempre **`exelixitech.com`** (con **i**).

## `.env` nexus-api (`~/exelixi/nexus-api/.env`)

```bash
NEXUS_PUBLIC_ORIGIN=https://nexus.exelixitech.com
```

```bash
unset PORT DATABASE_URL
cd ~/exelixi/nexus-api && npm run build && pm2 reload nexus-api --update-env && pm2 save
```

## `.env` nest-api (`~/server-api-sys/.env`)

```bash
PUBLIC_API_ORIGIN=https://nexus-api.exelixitech.com
CORS_ORIGIN=https://ocr.exelixitech.com,https://formulario.exelixitech.com,https://emision.exelixitech.com,https://pagos.exelixitech.com,https://nexus.exelixitech.com
```

```bash
unset PORT DATABASE_URL
cd ~/server-api-sys && npm run build && pm2 reload sysip-nest-api --update-env && pm2 save
```

## Submódulos BD

Script: `scripts/fix-gcia-produccion-submodulo-urls.sql`

## Build fronts

```bash
export VITE_NEXUS_API_URL=https://nexus.exelixitech.com
export VITE_NEXUS_USE_MODULE_PROXY=0
export VITE_APP_BASE=/
```

## Verificación (desde PC con VPN/DNS, no desde el servidor)

```bash
curl -s https://nexus.exelixitech.com/health
curl -s https://nexus-api.exelixitech.com/docs | head -c 80
curl -sI https://ocr.exelixitech.com | head -3
```

## No mezclar entornos

| Entorno             | URLs                                     |
| ------------------- | ---------------------------------------- |
| QA                  | `https://nexusqa.exelixitech.com/...`    |
| Cierre              | `https://cierrelmds.exelixitech.com/...` |
| **Producción GCIA** | tabla arriba                             |
