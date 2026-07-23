# Integración Exélixi Nexus — Svelte / SvelteKit

Este directorio es un **kit completo**. No hace falta copiar otras carpetas del SDK (`react/`, `vue/`, `../core/` en la raíz): todo lo necesario está aquí.

Al terminar los pasos, el módulo queda conectado a **exelixi-nexus-services** (verify + heartbeat) y, si aplica, tu API validará el mismo token con el middleware incluido.

---

## Contenido del kit

```text
svelte/
├── README.md
├── INTEGRACION.md          ← este archivo
├── .env.example
├── NexusGuard.svelte
├── core/
│   └── nexus-core.ts
└── backend/
    ├── .env.example
    └── nexus-middleware.ts   ← solo si tienes API Express
```

---

## Checklist rápido

1. Copiar **toda** la carpeta `svelte/` a tu proyecto (ver abajo).
2. Añadir `VITE_NEXUS_API_URL` (desde `.env.example`).
3. Envolver la app con `<NexusGuard>`.
4. En **Nexus Admin**: módulo + submódulo + URL + empresa activa.
5. Abrir el módulo con enlace que incluya **`?nexus_token=…`** (desde el panel o SSO).
6. _(Opcional)_ Backend: copiar `backend/nexus-middleware.ts` y configurar `.env` del servidor.

---

## Paso 1 — Copiar archivos al proyecto

### Opción A — SvelteKit (`src/lib/nexus/`)

Copia el contenido de este kit a:

```text
src/lib/nexus/
├── NexusGuard.svelte
├── core/nexus-core.ts
└── (backend/ solo como referencia; el middleware va al repo de la API)
```

### Opción B — Svelte + Vite

```text
src/nexus/
├── NexusGuard.svelte
└── core/nexus-core.ts
```

No separes `NexusGuard.svelte` de `core/`; el import es `./core/nexus-core`.

---

## Paso 2 — Variables de entorno (frontend)

Copia `.env.example` a `.env` en la raíz de tu app Svelte:

```env
VITE_NEXUS_API_URL=http://localhost:3092
```

Producción (La Mundial):

```env
VITE_NEXUS_API_URL=https://cierrelmds.exelixitech.com/nexus-api
```

Sin barra final. Debe apuntar a **exelixi-nexus-services**, no al admin React.

---

## Paso 3 — Envolver la aplicación

### SvelteKit — `src/routes/+layout.svelte`

```svelte
<script lang="ts">
  import NexusGuard from '$lib/nexus/NexusGuard.svelte';

  const nexusApiUrl = import.meta.env.VITE_NEXUS_API_URL;
</script>

<NexusGuard {nexusApiUrl} serviceName="Nombre del módulo" logoUrl="/logo.png">
  <slot />
</NexusGuard>
```

### Svelte + Vite — `App.svelte`

```svelte
<script lang="ts">
  import NexusGuard from './nexus/NexusGuard.svelte';

  const nexusApiUrl = import.meta.env.VITE_NEXUS_API_URL;
</script>

<NexusGuard {nexusApiUrl} serviceName="Nombre del módulo">
  <Router />
</NexusGuard>
```

`NexusGuard` ya hace:

- `GET /api/access/verify` al cargar
- Heartbeat cada **5 minutos** (`POST /api/access/heartbeat`)
- Pantalla de bloqueo si falta token o la empresa/submódulo no están activos

**SSR:** la verificación corre en el navegador (`onMount`). No llames `verifyNexusAccess` en `load` del servidor.

---

## Paso 4 — Datos de empresa en la UI

```svelte
<script lang="ts">
  import { nexusStore } from '$lib/nexus/NexusGuard.svelte';
</script>

{#if $nexusStore.empresa}
  <p>Tenant: {$nexusStore.empresa.nombre} (id {$nexusStore.empresa.id})</p>
{/if}
```

En peticiones a **tu** backend, filtra siempre por `empresa.id`.

---

## Paso 5 — Llamadas a tu API

```typescript
import { nexusFetch } from '$lib/nexus/core/nexus-core';

const res = await nexusFetch('/api/recursos');
const data = await res.json();
```

Usa `nexusFetch` cuando tu Express use `nexus-middleware` (mismo Bearer token).

---

## Paso 6 — Backend Express (opcional)

Si el módulo expone `/api/*`:

1. Copia `backend/nexus-middleware.ts` → `src/middleware/nexusAuth.ts` (no edites el archivo).
2. Copia variables de `backend/.env.example` al `.env` de tu API.
3. Obtén **`TENANT_TOKEN_SECRET`** del equipo de Nexus (mismo que `exelixi-nexus-services`).
4. Pon **`NEXUS_EXPECTED_SUBMODULO_IDS`** = ID numérico del submódulo creado en Admin.

```typescript
import nexusAuth from './middleware/nexusAuth';

app.use('/api', nexusAuth);

app.get('/api/recursos', (req, res) => {
  const empresaId = req.empresa!.id;
  // ...
});
```

Dependencia: `jsonwebtoken` (+ tipos `@types/jsonwebtoken` si usas TS).

---

## Paso 7 — Alta en Nexus Admin (`exelixi-nexus`)

| Acción                        | Dónde                                      |
| ----------------------------- | ------------------------------------------ |
| Crear módulo y submódulo      | **Módulos** → _Nuevo módulo_ (UI)          |
| URL pública del front         | Campo **URL** del submódulo                |
| Activar / desactivar global   | **Módulos** → interruptor del módulo       |
| Activar por empresa           | **Empresas** → perfil → módulos/submódulos |
| Ver API Key (apps standalone) | **Conexiones de aplicaciones**             |

**Alternativa en BD (servidor):**  
`npm run register-modulo -- --modulo "…" --submodulo "…" --url "…"`  
(o `scripts/register-modulo.sql`). Guía completa: [`../ONBOARDING-MODULO-NUEVO.md`](../ONBOARDING-MODULO-NUEVO.md).

Flujo típico para el usuario final:

1. Admin activa empresa + submódulo.
2. Usuario entra desde Nexus con enlace que lleva **`nexus_token`** en la query.
3. `NexusGuard` verifica contra Nexus y muestra la app.

Flujo alternativo (app que no entra solo por enlace): API Key → `POST /api/access/token` → usar el `access_token` como Bearer (documentado en Swagger de Nexus).

---

## ¿Se conecta solo a Nexus?

**Sí**, si se cumple todo esto:

| Requisito                                                               |     |
| ----------------------------------------------------------------------- | --- |
| `VITE_NEXUS_API_URL` apunta a la API Nexus viva                         | ✓   |
| Submódulo existe y está **activo** para esa empresa                     | ✓   |
| El usuario llega con **token válido** (`?nexus_token=` o sesión previa) | ✓   |
| CORS de Nexus permite el origen de tu front (prod)                      | ✓   |

No hace falta tocar código de `exelixi-nexus` ni de `nexus-core`/`NexusGuard` más allá del wrap y el `.env`.

---

## Problemas frecuentes

| Síntoma                                    | Qué revisar                                                                          |
| ------------------------------------------ | ------------------------------------------------------------------------------------ |
| “No se proporcionó token de acceso”        | Falta `nexus_token` en URL; generar enlace desde Admin.                              |
| “VITE_NEXUS_API_URL no está configurada”   | `.env` + reiniciar `npm run dev`.                                                    |
| Error de red al verificar                  | URL incorrecta, API caída o CORS.                                                    |
| “Servicio no disponible para esta empresa” | Submódulo inactivo en Admin para esa empresa.                                        |
| 401 en tu `/api`                           | Middleware no montado, secret distinto, o `NEXUS_EXPECTED_SUBMODULO_IDS` incorrecto. |

---

## API Nexus (referencia)

| Método | Ruta                    |
| ------ | ----------------------- |
| GET    | `/api/access/verify`    |
| POST   | `/api/access/heartbeat` |
| POST   | `/api/access/token`     |

Detalle en Swagger del despliegue de **exelixi-nexus-services**.
