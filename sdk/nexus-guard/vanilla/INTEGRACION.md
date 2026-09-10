# Integración Exélixi Nexus — Vanilla JS

Kit **autocontenido** para HTML sin bundler o proyectos con Vite/Webpack.

---

## Contenido del kit

```text
vanilla/
├── README.md
├── INTEGRACION.md
├── .env.example          ← referencia (URL en init)
├── nexus-guard.js        ← script tag / IIFE
├── core/nexus-core.ts    ← si usas bundler TS
└── backend/
```

---

## Sin bundler — HTML

```html
<div id="app" style="display:none">…tu app…</div>

<script src="./nexus-guard.js"></script>
<script>
  NexusGuard.init({
    nexusApiUrl: 'https://cierrelmds.exelixitech.com/nexus-api',
    serviceName: 'Nombre del módulo',
    onActive: function (empresa, submodulo, metadata) {
      document.getElementById('app').style.display = 'block';
      window.__empresa = empresa;
    },
    onBlocked: function (reason) {
      console.warn('Nexus blocked:', reason);
    },
  });
</script>
```

Comportamiento alineado con Svelte/React/Vue:

- Verify al cargar + poll **~30 s**
- Mensajes de loading/blocked idénticos
- `NexusGuard.fetch(url)` = fetch con Bearer + token refrescado

---

## Con bundler (Vite)

Copia `core/nexus-core.ts` e importa:

```typescript
import { startNexusAccessPoll, nexusFetch } from './nexus/core/nexus-core';
```

---

## Backend

Igual que otros kits: `backend/nexus-middleware.ts` + `.env` del servidor.
