# Handoff — Sistema de tokens Exélixi Nexus + SDK

> **Fecha:** 28 jun 2026  
> **Estado en srv001:** Desplegado y online (nexus-api + 4 módulos API)  
> **Objetivo de este doc:** Clonar en otra PC y retomar el contexto completo sin depender del chat de Cursor.

---

## 1. Repositorios GitHub (clonar en otra PC)

```bash
mkdir ~/all-projects && cd ~/all-projects

# API central + SDK
git clone https://github.com/jsotoexelixitech/exelixi-nexus-services.git

# Admin Nexus (UI conexiones, empresas, submódulos)
git clone https://github.com/jsotoexelixitech/exelixi-nexus.git

# Módulos (cada uno es repo independiente)
git clone https://github.com/jsotoexelixitech/ocr-documentos-modulo.git       exelixi-modulos/modulo-ocr
git clone https://github.com/jsotoexelixitech/Formulario-modulo.git         exelixi-modulos/modulo-formulario
git clone https://github.com/jsotoexelixitech/Emision-Plan-modulo.git       exelixi-modulos/modulo-emision
git clone https://github.com/jsotoexelixitech/Pagos-Poliza-modulo.git       exelixi-modulos/modulo-pagos
```

| Repo                   | Rama | Último commit relevante                                      |
| ---------------------- | ---- | ------------------------------------------------------------ |
| exelixi-nexus-services | main | `feat(sdk): sistema completo de tokens + nexus-server SDK`   |
| exelixi-nexus          | main | `feat(empresas): pagina de conexiones de aplicaciones OAuth` |
| ocr-documentos-modulo  | main | `fix(nexusAuth): expose Access-Control-Expose-Headers`       |
| Formulario-modulo      | main | idem                                                         |
| Emision-Plan-modulo    | main | idem                                                         |
| Pagos-Poliza-modulo    | main | idem                                                         |

---

## 2. Qué se implementó (resumen ejecutivo)

### Sistema de tokens estilo Bitrix24 OAuth

```
tenantToken (permanente, API Key en Nexus Admin)
    │ POST /api/access/token
    ▼
access_token (JWT 1h)
    │ cada petición al módulo → heartbeat → renueva tokenExpiresAt +8h en BD
    ▼
access_token renovado (header X-Nexus-Token-Refreshed)
    │
    ▼ inactividad > tokenExpiresAt → 403 (sesión cortada)
```

### Cambios por capa

| Capa             | Archivos clave                         | Qué hace                                                                                                                        |
| ---------------- | -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| **nexus-api**    | `src/modules/access/access.service.ts` | `verify()` valida `tokenExpiresAt`; `heartbeat()` retorna `access_token` renovado; `exchangeToken()` también valida inactividad |
| **nexus-api**    | `src/modules/auth/auth.controller.ts`  | `ssoDelegate` con Zod en metadata; sin `console.log`                                                                            |
| **nexus-api**    | `src/modules/company/*`                | `GET /api/companies/:id/connection-tokens`                                                                                      |
| **nexus-admin**  | `src/pages/empresas/ConexionesApp.tsx` | UI de conexiones OAuth por empresa                                                                                              |
| **4 módulos**    | `server/src/middleware/nexusAuth.js`   | Heartbeat + header `X-Nexus-Token-Refreshed` + CORS expose                                                                      |
| **SDK frontend** | `sdk/nexus-guard/`                     | verify, heartbeat, `nexusFetch`, React/Vue/Vanilla                                                                              |
| **SDK backend**  | `sdk/nexus-server/`                    | `nexus-middleware.js/.ts` drop-in para módulos nuevos                                                                           |

### Compatibilidad

- **Apps externas existentes** (Angular, API Key, `sso-delegate`) **siguen funcionando**.
- El SDK es **opcional** para módulos nuevos; los 4 módulos actuales usan su propio `nexusAuth.js` (misma lógica).
- Solo se corta acceso si: empresa/módulo inactivo, sesión vencida por inactividad, token JWT expirado sin renovación, metadata SSO inválida.

---

## 3. Ubicación del SDK

```
exelixi-nexus-services/sdk/
├── nexus-guard/          ← Frontend (React, Vue, Svelte, Vanilla)
│   ├── core/nexus-core.ts
│   ├── react/useNexusAccess.ts
│   └── vanilla/nexus-guard.js
└── nexus-server/         ← Backend drop-in (NO editar, solo .env)
    ├── nexus-middleware.js
    ├── nexus-middleware.ts
    └── README.md
```

**Acoplar módulo nuevo (solo .env):**

```env
NEXUS_API_URL=http://192.168.8.120:3092
TENANT_TOKEN_SECRET=<mismo que nexus-api>
NEXUS_EXPECTED_SUBMODULO_IDS=25
```

```js
const nexusAuth = require('./middleware/nexusAuth');
app.use('/api', nexusAuth);
```

---

## 4. Deploy en srv001 (192.168.8.120)

```bash
# API Nexus
cd ~/nexus-api && git pull && npm run build && pm2 restart nexus-api

# Admin (si hubo cambios frontend)
cd ~/nexus-admin && git pull && npm run build && pm2 restart nexus-admin

# APIs de módulos
cd ~/exelixi/ocr-documentos-modulo && git pull && pm2 restart ocr-api
cd ~/exelixi/Formulario-modulo && git pull && pm2 restart form-api
cd ~/exelixi/Emision-Plan-modulo && git pull && pm2 restart emision-api
cd ~/exelixi/Pagos-Poliza-modulo && git pull && pm2 restart pagos-api
```

**Estado confirmado 28-jun-2026:** todos `online` en PM2.

---

## 5. Endpoints API relevantes

| Método | Ruta                                   | Uso                                            |
| ------ | -------------------------------------- | ---------------------------------------------- |
| GET    | `/api/access/verify`                   | Verificar token al cargar módulo               |
| POST   | `/api/access/heartbeat`                | Renovar sesión + `access_token`                |
| POST   | `/api/access/token`                    | OAuth: API Key → access_token                  |
| POST   | `/api/auth/sso-delegate`               | Apps externas con metadata (cproductor, canal) |
| GET    | `/api/companies/:id/connection-tokens` | Admin: ver tokens de conexión                  |

---

## 6. Metadata SSO (Zod)

Campos permitidos en `ssoDelegate`:

```typescript
cproductor?: string   // max 20
canal?:      string   // max 50
cramo?:      number   // entero positivo
cusuario?:   string   // max 60
ctipo?:      number   // entero >= 0
```

Campos extra se descartan. Tipos incorrectos → 400.

---

## 7. Pendientes identificados (no implementados aún)

1. **`GET /catalogo/planes`** — usar `req.nexusMetadata.cproductor` para planes RCV por canal/productor (módulo emisión).
2. **Frontends de módulos** — migrar a `nexusFetch()` / capturar `X-Nexus-Token-Refreshed` (hoy el backend ya renueva; el front puede quedarse con token viejo hasta 1h).
3. **Botón "Regenerar tenantToken"** en ConexionesApp (admin).
4. **Copiar SDK frontend** a los 4 módulos existentes (opcional, no bloqueante).

---

## 8. Workspace local (solo en PC original)

La carpeta `all-projects/` **no es un repo git**. Contiene reglas Cursor en:

```
all-projects/.cursor/rules/     ← 00-token-efficiency, 01-workspace-map, etc.
all-projects/.agents/           ← reglas on-demand
all-projects/tags               ← índice ctags (regenerar con update-tags.ps1)
```

Copias portables de reglas Cursor incluidas en:

```
exelixi-nexus-services/docs/portable/cursor-rules/
```

En otra PC: copiar esas reglas a `all-projects/.cursor/rules/` o al proyecto que uses.

---

## 9. Herramientas de eficiencia (Cursor)

| Herramienta    | Uso                                                        |
| -------------- | ---------------------------------------------------------- |
| `tags` (ctags) | `grep nombreSimbolo tags` → archivo + línea (0 tokens MCP) |
| MCP `code-rag` | Búsqueda semántica en workspace                            |
| MCP `context7` | Docs de librerías externas                                 |

Regenerar tags:

```powershell
cd all-projects
.\update-tags.ps1
```

---

## 10. Variables de entorno críticas

**nexus-api (.env):**

```
TENANT_TOKEN_SECRET=
DATABASE_URL=
JWT_SECRET=
```

**Cada módulo backend (.env):**

```
NEXUS_API_URL=http://192.168.8.120:3092
TENANT_TOKEN_SECRET=<igual que nexus-api>
NEXUS_EXPECTED_SUBMODULO_IDS=<id en BD>
NEXUS_AUTH_ENABLED=true
```

**Frontend módulos / admin:**

```
VITE_NEXUS_API_URL=http://192.168.8.120:3092
```

---

## 11. Flujo completo (diagrama)

```
[Nexus Admin] ──activa empresa+módulo──► genera tenantToken
       │
       ▼
[App externa / Admin] ──sso-delegate + metadata──► redirect ?nexus_token=
       │
       ▼
[Módulo frontend] ──verify──► nexus-api
       │
       ▼
[Módulo backend nexusAuth] ──heartbeat──► renueva token + req.empresa + req.nexusMetadata
       │
       ▼
[Rutas API del módulo] filtran por req.empresa.id
```

---

## 12. Contacto / continuidad

- **Transcript Cursor (PC original):** `agent-transcripts/d66ef781-d5e2-4bdc-b855-0fe71b3de111/` (solo local en Cursor, no está en git).
- **Este documento** reemplaza la necesidad del transcript para retomar trabajo.
- **Skills Cursor útiles:** `exelixi-nexus-backend`, `exelixi-nexus-frontend`, `exelixi-nexus-security` en `~/.cursor/skills/`.

---

## 13. AVISO DE SEGURIDAD (eliminar en otro chat)

Los siguientes archivos se subieron **temporalmente** para clonar contexto en otra PC.
**Pedir en Cursor que los elimine del repo** cuando ya no los necesites:

```
docs/HANDOFF-CONTEXTO-SESION.md
docs/CLONAR-EN-OTRA-PC.md
docs/portable/
```

Comando sugerido para limpieza futura:

```bash
git rm -r docs/HANDOFF-CONTEXTO-SESION.md docs/CLONAR-EN-OTRA-PC.md docs/portable/
git commit -m "chore(docs): eliminar handoff temporal por seguridad"
git push origin main
```

---

_Generado automáticamente al cierre de la sesión de implementación del sistema de tokens + SDK._
