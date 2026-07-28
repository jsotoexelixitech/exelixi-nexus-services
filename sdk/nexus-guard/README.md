# NexusGuard SDK

Control de acceso Exélixi Nexus para cualquier framework frontend.

Cada carpeta es un **kit autocontenido** (mismo comportamiento que Svelte):

| Kit     | Carpeta                  | Wrapper                            |
| ------- | ------------------------ | ---------------------------------- |
| Svelte  | [`svelte/`](./svelte/)   | `NexusGuard.svelte` + `nexusStore` |
| React   | [`react/`](./react/)     | `NexusGuard.tsx` + `useNexus()`    |
| Vue 3   | [`vue/`](./vue/)         | `NexusGuard.vue` + `useNexus()`    |
| Vanilla | [`vanilla/`](./vanilla/) | `NexusGuard.init()`                |

Todos incluyen: `core/nexus-core.ts`, `backend/nexus-middleware.ts`, `.env.example`, `INTEGRACION.md`.

---

## Comportamiento común

1. Prop / opción **`nexusApiUrl`** (desde `VITE_NEXUS_API_URL`)
2. `GET /api/access/verify` al cargar
3. Re-verificación cada **~30 s** (`startNexusAccessPoll`)
4. Estados: **loading** → **active** (slot/children) o **blocked**
5. `nexusFetch()` / `NexusGuard.fetch()` con Bearer automático

---

## Inicio rápido

1. Copia el kit de tu framework a `src/nexus/`
2. Lee `INTEGRACION.md` dentro de esa carpeta
3. `.env`: `VITE_NEXUS_API_URL=https://cierrelmds.exelixitech.com/nexus-api`

---

## Núcleo compartido (`core/nexus-core.ts`)

También en la raíz `sdk/nexus-guard/core/` para referencia; **cada kit trae su copia** en `{framework}/core/` para entrega autocontenida.

```typescript
import {
  verifyNexusAccess,
  startNexusAccessPoll,
  nexusFetch,
  getNexusToken,
} from './core/nexus-core';
```

---

## Onboarding módulo nuevo

[`../ONBOARDING-MODULO-NUEVO.md`](../ONBOARDING-MODULO-NUEVO.md)
