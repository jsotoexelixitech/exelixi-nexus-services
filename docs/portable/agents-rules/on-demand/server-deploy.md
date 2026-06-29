---
trigger: always_on
priority: 3
---

# Servidor de Desarrollo — srv001 (192.168.8.120)

> **Todo cambio aprobado debe commitearse y pushearse al repo antes de desplegar.**

## Procesos PM2

| Servicio          | Puerto API | Puerto Web | Carpeta servidor                  |
| ----------------- | ---------- | ---------- | --------------------------------- |
| `nexus-api`       | 3092       | —          | `~/nexus-api`                     |
| `nexus-admin`     | —          | 5200       | `~/nexus-admin`                   |
| `ocr-api/web`     | 4001       | 5181       | `~/exelixi/ocr-documentos-modulo` |
| `form-api/web`    | 4002       | 5182       | `~/exelixi/Formulario-modulo`     |
| `emision-api/web` | 4004       | 5183       | `~/exelixi/Emision-Plan-modulo`   |
| `pagos-api/web`   | 4003       | 5184       | `~/exelixi/Pagos-Poliza-modulo`   |
| `rcv-api/web`     | 3001       | 5180       | `~/auto-casa`                     |
| `sysip-nest-api`  | 3002       | —          | `~/server-api-sys`                |

## Comandos de deploy por servicio

```bash
# Nexus API (backend central) → exelixi-nexus-services
cd ~/nexus-api && git pull origin main && npm run build && pm2 restart nexus-api

# Nexus Admin (frontend) → exelixi-nexus
cd ~/nexus-admin && git pull origin main && npm run build && pm2 restart nexus-admin

# Módulo OCR → exelixi-modulos/modulo-ocr
cd ~/exelixi/ocr-documentos-modulo && git pull origin main && cd frontend && npm run build && pm2 restart ocr-web

# Módulo Formulario → exelixi-modulos/modulo-formulario
cd ~/exelixi/Formulario-modulo && git pull origin main && cd frontend && npm run build && pm2 restart form-web

# Módulo Emisión → exelixi-modulos/modulo-emision
cd ~/exelixi/Emision-Plan-modulo && git pull origin main && cd frontend && npm run build && pm2 restart emision-web

# Módulo Pagos → exelixi-modulos/modulo-pagos
cd ~/exelixi/Pagos-Poliza-modulo && git pull origin main && cd frontend && npm run build && pm2 restart pagos-web

# Auto-casa (RCV) → auto-casa-inspeccion
cd ~/auto-casa && git pull origin main && npm run build && pm2 restart rcv-web
```

## Variable de entorno frontends

```
VITE_NEXUS_API_URL=http://192.168.8.120:3092
VITE_EMPRESA_ID=1
```

## Notas críticas

- Build con Vite+TS → siempre verificar que `tsc -b && vite build` pase sin errores.
- `@exelixi/shared` es paquete local en `~/exelixi/shared` — si falla, `npm install` en el frontend.
- `form-web` tiene historial de reinicios frecuentes — monitorear tras cada deploy.
- Puerto 3091 activo sin PM2 — posible instancia staging.
