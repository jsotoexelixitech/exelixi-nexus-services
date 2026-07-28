# Integración Exélixi Nexus — React / Vite

Kit **autocontenido**. Copia toda la carpeta `react/` a tu proyecto; no necesitas otras carpetas del SDK.

---

## Contenido del kit

```text
react/
├── README.md
├── INTEGRACION.md
├── .env.example
├── NexusGuard.tsx
├── useNexusAccess.ts
├── core/nexus-core.ts
└── backend/
    ├── .env.example
    └── nexus-middleware.ts
```

---

## Checklist

1. Copiar **toda** la carpeta `react/` → `src/nexus/`
2. `VITE_NEXUS_API_URL` en `.env`
3. Envolver la app con `<NexusGuard nexusApiUrl={...}>`
4. Alta en Nexus Admin (módulo + submódulo + empresa activa)
5. Entrar con `?nexus_token=…`
6. _(Opcional)_ Middleware Express en tu API

---

## Paso 1 — Copiar archivos

```text
src/nexus/
├── NexusGuard.tsx
├── useNexusAccess.ts
└── core/nexus-core.ts
```

---

## Paso 2 — `.env`

```env
VITE_NEXUS_API_URL=http://localhost:3092
# Producción: https://cierrelmds.exelixitech.com/nexus-api
```

---

## Paso 3 — Envolver la app (`main.tsx`)

```tsx
import { NexusGuard } from './nexus/NexusGuard';

const nexusApiUrl = import.meta.env.VITE_NEXUS_API_URL;

ReactDOM.createRoot(document.getElementById('root')!).render(
  <NexusGuard
    nexusApiUrl={nexusApiUrl}
    serviceName="Nombre del módulo"
    logoUrl="/logo.png"
  >
    <App />
  </NexusGuard>,
);
```

`NexusGuard` hace:

- `GET /api/access/verify` al cargar
- Re-verificación cada **~30 s** (`startNexusAccessPoll`)
- Pantalla de bloqueo si falta token o empresa/submódulo inactivos

---

## Paso 4 — Datos de empresa

```tsx
import { useNexus } from './nexus/NexusGuard';

function Header() {
  const { empresa, submodulo, metadata } = useNexus();
  return <span>{empresa.nombre}</span>;
}
```

---

## Paso 5 — Llamadas a tu API

```typescript
import { nexusFetch } from './nexus/core/nexus-core';

const res = await nexusFetch('/api/recursos');
```

---

## Paso 6 — Backend Express (opcional)

Igual que el kit Svelte: copia `backend/nexus-middleware.ts` → `src/middleware/nexusAuth.ts` y variables de `backend/.env.example`.

---

## Problemas frecuentes

| Síntoma                                  | Revisar                       |
| ---------------------------------------- | ----------------------------- |
| “No se proporcionó token…”               | Falta `nexus_token` en URL    |
| “VITE_NEXUS_API_URL no está configurada” | `.env` + reiniciar dev server |
| “Servicio no disponible…”                | Submódulo inactivo en Admin   |

Referencia API Nexus: `GET /api/access/verify`, `POST /api/access/heartbeat`, `POST /api/access/token`.
