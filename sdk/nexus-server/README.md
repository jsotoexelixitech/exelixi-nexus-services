# nexus-server SDK — Acople de módulos a Exélixi Nexus

Middleware Express listo para usar. Un módulo nuevo se integra al ecosistema **sin tocar código**: solo copia el archivo y configura `.env`.

---

## Flujo completo

```
Nexus Admin (nexus-admin)
    │
    │  1. Admin activa empresa + módulo → genera tenantToken
    │
    ▼
nexus-api (nexus-api)
    │  /api/access/verify   — verifica tenantToken al cargar el módulo
    │  /api/access/heartbeat — renueva access_token en cada petición
    │  /api/access/token     — intercambia API Key por access_token (OAuth)
    │  /api/auth/sso-delegate — genera token con metadata (canal/productor)
    │
    ▼
Módulo (nuevo o existente)
    │  nexus-middleware.js / .ts (este SDK)
    │  Valida token → heartbeat → renueva → inyecta req.empresa
    │
    ▼
Frontend del módulo
    NexusGuard SDK (sdk/nexus-guard)
    Verifica token → heartbeat automático cada 5 min → nexusFetch()
```

---

## Pasos para acoplar un módulo nuevo

### 1. Obtener submódulo en Nexus Admin

1. Ingresar a Nexus Admin → **Submódulos** → Crear o verificar que existe el nuevo módulo.
2. Anotar el **ID de submódulo** asignado (ejemplo: `25`).
3. Activar el submódulo para cada empresa cliente en **Empresas → Conexiones**.

### 2. Configurar el backend del módulo

**2a. Copiar el middleware (elige una versión)**

| Stack            | Archivo a copiar      | Destino                       |
| ---------------- | --------------------- | ----------------------------- |
| Node.js/CommonJS | `nexus-middleware.js` | `src/middleware/nexusAuth.js` |
| TypeScript/ESM   | `nexus-middleware.ts` | `src/middleware/nexusAuth.ts` |

> **Regla:** NO edites el archivo. Solo configura `.env`.

**2b. Configurar `.env`**

```env
# ── Nexus (requerido) ────────────────────────────────────────────
NEXUS_API_URL=http://192.168.8.120:3092
TENANT_TOKEN_SECRET=<mismo_secret_que_nexus_api>
NEXUS_EXPECTED_SUBMODULO_IDS=25

# ── Nexus (opcional) ────────────────────────────────────────────
NEXUS_AUTH_ENABLED=true
NEXUS_BYPASS_EMPRESA_ID=1
WHITELISTED_ORIGINS=192.168.8.1,localhost
```

**2c. Aplicar el middleware en Express**

```js
// app.js / server.js
const nexusAuth = require('./middleware/nexusAuth');

// Aplicar ANTES de todas las rutas de la API
app.use('/api', nexusAuth);
```

**2d. Usar los datos del token en rutas**

```js
// GET /api/polizas
app.get('/api/polizas', async (req, res) => {
  const { id: empresaId } = req.empresa; // tenant activo
  const { cproductor, canal } = req.nexusMetadata; // metadata SSO (si aplica)

  const polizas = await Poliza.findAll({
    where: { empresaId, ...(cproductor ? { cproductor } : {}) },
  });

  res.json({ data: polizas });
});
```

### 3. Configurar el frontend del módulo

**3a. Copiar el SDK de frontend** (React, Vue, Svelte o Vanilla JS):

```
sdk/nexus-guard/core/nexus-core.ts       ← siempre requerido
sdk/nexus-guard/react/useNexusAccess.ts  ← React
sdk/nexus-guard/react/NexusGuard.tsx     ← componente wrapper React
sdk/nexus-guard/vue/NexusGuard.vue       ← Vue 3
sdk/nexus-guard/svelte/NexusGuard.svelte ← Svelte
sdk/nexus-guard/vanilla/nexus-guard.js   ← HTML puro / cualquier JS
```

**3b. Configurar `.env` del frontend**

```env
VITE_NEXUS_API_URL=http://192.168.8.120:3092
```

**3c. Envolver la app (React)**

```tsx
// main.tsx
import { NexusGuard } from './nexus/NexusGuard';

ReactDOM.createRoot(document.getElementById('root')!).render(
  <NexusGuard serviceName="Nombre del Módulo">
    <App />
  </NexusGuard>,
);
```

**3d. Usar `nexusFetch` en vez de `fetch`**

```tsx
import { nexusFetch } from './nexus/nexus-core';

// Token incluido automáticamente + renovación capturada
const data = await nexusFetch('/api/polizas').then((r) => r.json());
```

### 4. Agregar el módulo a Nexus Admin (UI)

Registrar la URL del nuevo módulo en **Submódulos → Editar → URL**. A partir de ese momento el botón en Nexus Admin generará el link de acceso con `?nexus_token=...` para cada empresa.

---

## Tabla de referencia rápida

| Variable `.env`                | Requerida | Descripción                              |
| ------------------------------ | --------- | ---------------------------------------- |
| `NEXUS_API_URL`                | Sí        | URL base de nexus-api                    |
| `TENANT_TOKEN_SECRET`          | Sí        | Secreto JWT compartido                   |
| `NEXUS_EXPECTED_SUBMODULO_IDS` | Sí        | IDs de submódulo (coma si son varios)    |
| `NEXUS_AUTH_ENABLED`           | No        | `false` para deshabilitar temporalmente  |
| `NEXUS_BYPASS_EMPRESA_ID`      | No        | empresaId en bypass (default: 1)         |
| `WHITELISTED_ORIGINS`          | No        | IPs/dominios que saltan la auth (dev/QA) |

---

## Datos disponibles en `req` después del middleware

| Campo               | Tipo     | Descripción                                       |
| ------------------- | -------- | ------------------------------------------------- |
| `req.empresa.id`    | `number` | ID de la empresa tenant activa                    |
| `req.submoduloId`   | `number` | ID del submódulo del token                        |
| `req.nexusToken`    | `string` | Token activo (renovado si heartbeat lo actualizó) |
| `req.nexusMetadata` | `object` | Metadata del SSO: `cproductor`, `canal`, `cramo`… |

---

## Diagrama de seguridad del token

```
tenantToken (permanente, API Key)
    │ POST /api/access/token
    ▼
access_token (1h)
    │  cada petición → heartbeat → se renueva
    ▼
access_token renovado
    │  X-Nexus-Token-Refreshed header → frontend lo actualiza
    ▼
... mientras empresa.activo = true y hay actividad
    │
    ▼ inactividad > tokenExpiresAt
403 Sesión expirada → el cliente reconecta con tenantToken
```

---

## Versión del SDK

| Componente              | Versión | Compatible con     |
| ----------------------- | ------- | ------------------ |
| nexus-middleware.js/.ts | 1.2.0   | nexus-api >= 1.4.0 |
| nexus-core.ts           | 1.2.0   | nexus-api >= 1.4.0 |
| useNexusAccess.ts       | 1.2.0   | React >= 18        |
