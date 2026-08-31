# Srv-Gcia-proyect — URLs producción (\*.exelixitech.com)

**Host:** `Srv-Gcia-proyect` · **IP:** `172.30.149.75` · **PM2:** `proyect`

## Mapa DNS (infra)

| Rol                     | URL                                   | PM2                        | Puerto local |
| ----------------------- | ------------------------------------- | -------------------------- | ------------ |
| **Nexus Admin (front)** | **https://nexus.exelixitech.com**     | nexus-admin                | 5200         |
| **APIs (nexus + nest)** | **https://nexus-api.exelixitech.com** | nexus-api / sysip-nest-api | 3092 / 3002  |
| OCR                     | https://ocr.exelixitech.com           | ocr-web / ocr-api          | 5181 / 4001  |
| Formulario              | https://formulario.exelixitech.com    | form-web / form-api        | 5182 / 4002  |
| Emisión                 | https://emision.exelixitech.com       | emision-web / emision-api  | 5183 / 4004  |
| Pagos                   | https://pagos.exelixitech.com         | pagos-web / pagos-api      | 5184 / 4003  |

Acceso interno: `http://172.30.149.75:<puerto>`

## `.env` nexus-api

```bash
NEXUS_PUBLIC_ORIGIN=https://nexus-api.exelixitech.com
```

## `.env` nest-api

```bash
PUBLIC_API_ORIGIN=https://nexus-api.exelixitech.com
```

## `.env.production` nexus-admin

```bash
VITE_APP_BASE=/
VITE_DIRECT_ACCESS=1
VITE_API_URL=https://nexus-api.exelixitech.com
```

Admin se sirve en **`https://nexus.exelixitech.com`** (proxy → `:5200`).

## Build módulos RCV

```bash
export VITE_NEXUS_API_URL=https://nexus-api.exelixitech.com
export VITE_NEXUS_USE_MODULE_PROXY=0
export VITE_APP_BASE=/
```

## Verificación (PC con VPN/DNS)

```bash
curl -s https://nexus-api.exelixitech.com/health
curl -sI https://nexus.exelixitech.com | head -3
curl -sI https://ocr.exelixitech.com | head -3
```

## QA (referencia)

|             | QA                    | Producción GCIA             |
| ----------- | --------------------- | --------------------------- |
| Front admin | `nexusqa…/admin/`     | `nexus.exelixitech.com`     |
| APIs        | `nexusqa…/nexus-api/` | `nexus-api.exelixitech.com` |
| OCR         | `nexusqa…/ocr/`       | `ocr.exelixitech.com`       |
