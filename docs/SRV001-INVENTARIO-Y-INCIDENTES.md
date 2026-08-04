# srv001 — Inventario, .env y registro de incidentes

> **Servidor:** srv001 · `192.168.8.120` · usuario `jsoto`  
> **Dominio HTTPS:** `cierrelmds.exelixitech.com`  
> **Regla IDE:** `.cursor/rules/06-srv001-env-incidentes.mdc`  
> **Última actualización:** 2026-08-04 (sesión flujo Exélixi `/ocr/exelixi/`)

---

## 1. Protocolo obligatorio antes de deploy

### Checklist (agente + operador)

- [ ] Cambios **pusheados** al repo remoto (el usuario hace deploy en srv001).
- [ ] En srv001: `git status` — sin `.env` / `.env.production` locales sin commitear que bloqueen pull.
- [ ] Ejecutar inventario: `bash ~/nexus-api/scripts/srv001-inventario-env.sh > ~/srv001-inventario-$(date +%F).txt`
- [ ] `unset PORT VITE_APP_BASE VITE_EMISSION_CONTINUE_BASE DATABASE_URL`
- [ ] Build con `VITE_APP_BASE` correcto (tabla §3) — **no confiar en vars del shell**.
- [ ] Reinicio: `pm2 reload ecosystem.config.js --env production` (por módulo).
- [ ] Verificación curl local (§5).

### Qué NO hacer

| Prohibido                                                   | Por qué                                                     |
| ----------------------------------------------------------- | ----------------------------------------------------------- |
| `pm2 restart … --update-env` tras `source ~/nexus-api/.env` | Inyecta `PORT=3092` en OCR/form                             |
| Editar `.env.production` solo en srv001                     | Rompe `git pull` y diverge del repo                         |
| `npm run build` sin `unset VITE_APP_BASE`                   | Puede compilar OCR con base `/producto-builder/`            |
| Scripts SQL Nexus desde `~/server-api-sys`                  | Ese repo es nest-api / SQL Server, no PostgreSQL Nexus      |
| Mezclar puertos product-builder (3015) con OCR proxy (4001) | Catálogo OCR usa `PRODUCT_BUILDER_API_URL` en `server/.env` |

---

## 2. Inventario de servicios PM2

| PM2                    | API :puerto | Web :puerto   | Carpeta srv001                    | Repo GitHub            |
| ---------------------- | ----------- | ------------- | --------------------------------- | ---------------------- |
| `nexus-api`            | 3092        | —             | `~/nexus-api`                     | exelixi-nexus-services |
| `nexus-admin`          | —           | 5200          | `~/nexus-admin`                   | exelixi-nexus          |
| `ocr-api`              | 4001        | —             | `~/exelixi/ocr-documentos-modulo` | ocr-documentos-modulo  |
| `ocr-web`              | —           | 5181          | ↑                                 | ↑                      |
| `form-api`             | 4002        | —             | `~/exelixi/Formulario-modulo`     | Formulario-modulo      |
| `form-web`             | —           | 5182          | ↑                                 | ↑                      |
| `emision-api`          | 4004        | —             | `~/exelixi/Emision-Plan-modulo`   | Emision-Plan-modulo    |
| `emision-web`          | —           | 5183          | ↑                                 | ↑                      |
| `pagos-api`            | 4003        | —             | `~/exelixi/Pagos-Poliza-modulo`   | Pagos-Poliza-modulo    |
| `pagos-web`            | —           | 5184          | ↑                                 | ↑                      |
| `sysip-nest-api`       | 3002        | —             | `~/server-api-sys`                | server-api-sys         |
| `producto-builder-api` | 3015        | —             | `~/producto-builder`              | producto-builder       |
| `producto-builder-web` | —           | 5215          | ↑                                 | ↑                      |
| `rcv-api` / `rcv-web`  | 3001 / 5180 | `~/auto-casa` | auto-casa-inspeccion              |

### Apache ProxyPass (HTTPS :443)

| Prefijo público          | Backend                                |
| ------------------------ | -------------------------------------- |
| `/nexus-api/`            | `127.0.0.1:3092/` (strip)              |
| `/admin/`                | `127.0.0.1:5200/admin/`                |
| `/ocr/`                  | `127.0.0.1:5181/ocr/`                  |
| `/formulario/`           | `127.0.0.1:5182/formulario/`           |
| `/emision/`              | `127.0.0.1:5183/emision/`              |
| `/pagos/`                | `127.0.0.1:5184/pagos/`                |
| `/producto-builder/`     | `127.0.0.1:5215/producto-builder/`     |
| `/producto-builder-api/` | `127.0.0.1:3015/producto-builder-api/` |
| `/nest-api-docs/`        | `127.0.0.1:3002/` (strip)              |

Detalle: `docs/CIERRELMDS-HTTPS-PREFIJOS.md`

---

## 3. Archivos `.env` — qué verificar (sin commitear secretos)

### Por servicio

| Ubicación                                                  | Variables críticas                                        | Valor esperado srv001                   |
| ---------------------------------------------------------- | --------------------------------------------------------- | --------------------------------------- |
| `~/nexus-api/.env`                                         | `PORT`, `DATABASE_URL`                                    | `PORT=3092`, PostgreSQL Nexus           |
| `~/exelixi/ocr-documentos-modulo/server/.env`              | `PORT`, `PRODUCT_BUILDER_API_URL`, `BUILDER_CATALOG_MODE` | `4001`, `http://127.0.0.1:3015`, `true` |
| `~/exelixi/ocr-documentos-modulo/frontend/.env.production` | `VITE_APP_BASE`                                           | `/ocr/` (repo; no editar en srv001)     |
| `~/exelixi/Formulario-modulo/server/.env`                  | `PORT`, `NEST_API_URL`                                    | `4002`, `http://127.0.0.1:3002`         |
| `~/exelixi/Formulario-modulo/frontend/.env.production`     | `VITE_APP_BASE`                                           | `/formulario/`                          |
| `~/producto-builder/.env`                                  | `PORT`, prefijos API                                      | API `3015`, front `5215`                |

### Verificar claves (sin mostrar valores)

```bash
# Solo nombres de variables definidas — NO pegar secretos en chats
grep -E '^[A-Z_]+=' ~/nexus-api/.env | cut -d= -f1 | sort
grep -E '^[A-Z_]+=' ~/exelixi/ocr-documentos-modulo/server/.env | cut -d= -f1 | sort
pm2 env ocr-api | grep -E '^PORT:|^NODE_ENV'
pm2 env ocr-web | grep VITE
```

---

## 4. Registro de incidentes (historial)

### INC-2026-08-04-A — psql database "jsoto" does not exist

- **Cuándo:** Deploy script Nexus submódulo Exélixi
- **Síntoma:** `psql "$DATABASE_URL"` desde `~/server-api-sys`
- **Causa:** Repo incorrecto + `DATABASE_URL` vacía → psql usa usuario OS como BD
- **Fix:** `cd ~/nexus-api && source .env && PSQL_URL="${DATABASE_URL%%\?*}" && psql "$PSQL_URL" …`
- **Prevención:** SQL Nexus solo desde `~/nexus-api`

### INC-2026-08-04-B — ocr-api / form-api crash loop (↺ 300+)

- **Cuándo:** `pm2 restart ocr-api ocr-web --update-env` tras `source ~/nexus-api/.env`
- **Síntoma:** `EADDRINUSE :::3092`, curl `:4001` vacío
- **Causa:** Shell con `PORT=3092` (Nexus) inyectado en OCR (4001) y Form (4002)
- **Fix:** `unset PORT && pm2 reload ecosystem.config.js --env production` en cada módulo
- **Prevención:** Nunca `--update-env` post-nexus; siempre `unset PORT`

### INC-2026-08-04-C — Vite base `/producto-builder` en URL `/ocr/exelixi/`

- **Cuándo:** Tras builds OCR sin limpiar shell
- **Síntoma:** Página blanca: _"server is configured with a public base URL of `/producto-builder`"_
- **Causa:** `npm run build` con `VITE_APP_BASE=/producto-builder` en el entorno
- **Fix:** `bash scripts/build-cierrelmds.sh` en ocr-documentos-modulo
- **Prevención:** `.env.production` en repo con `/ocr/`; script build-cierrelmds.sh

### INC-2026-08-04-D — git pull bloqueado por .env.production local

- **Cuándo:** Pull OCR tras fix deploy
- **Síntoma:** `error: Your local changes to frontend/.env.production would be overwritten`
- **Causa:** Edición manual en srv001
- **Fix:** `git checkout -- frontend/.env.production && git pull`
- **Prevención:** No editar `.env.production` en servidor; cambios solo en repo + push

---

## 5. Comandos de verificación post-deploy

```bash
# PM2 estable (uptime > 30s, ↺ no sube)
pm2 list

# APIs locales
curl -sf http://127.0.0.1:3092/health && echo " nexus OK"
curl -sf http://127.0.0.1:4001/docs.json | head -c 60 && echo " … ocr OK"
curl -sf http://127.0.0.1:4002/docs.json | head -c 60 && echo " … form OK"
curl -sf http://127.0.0.1:4001/api/catalog/products | head -c 120 && echo " … catalog OK"

# HTTPS (desde srv001)
curl -skI https://cierrelmds.exelixitech.com/ocr/exelixi/ | head -3
curl -skI https://cierrelmds.exelixitech.com/ocr/ | head -3
```

---

## 6. URLs de flujos

| Flujo                       | URL entrada                                                         |
| --------------------------- | ------------------------------------------------------------------- |
| RCV La Mundial              | `https://cierrelmds.exelixitech.com/ocr/?product=rcv`               |
| Funerario La Mundial        | `…/ocr/?product=funerario`                                          |
| Exélixi genérico (catálogo) | `https://cierrelmds.exelixitech.com/ocr/exelixi/`                   |
| Exélixi (alternativa query) | `…/ocr/?flow=exelixi-catalog`                                       |
| Nexus submódulo BD          | `submodulo_url` → `/ocr/exelixi/` (módulo Emisión Genérica Exélixi) |

---

## 7. Mantenimiento de este documento

Al resolver un incidente nuevo en srv001:

1. Añadir fila en §4 con ID `INC-AAAA-MM-DD-X`
2. Actualizar regla `.cursor/rules/06-srv001-env-incidentes.mdc` si el fix es crítico
3. Opcional: adjuntar salida de `srv001-inventario-env.sh` fechada en `~/srv001-inventario-*.txt`
