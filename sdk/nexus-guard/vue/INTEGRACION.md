# Integración Exélixi Nexus — Vue 3 / Vite

Kit **autocontenido**. Copia toda la carpeta `vue/` a tu proyecto.

---

## Contenido del kit

```text
vue/
├── README.md
├── INTEGRACION.md
├── .env.example
├── NexusGuard.vue
├── useNexus.ts
├── core/nexus-core.ts
└── backend/
```

---

## Paso 3 — Envolver la app (`App.vue`)

```vue
<script setup lang="ts">
import NexusGuard from './nexus/NexusGuard.vue';

const nexusApiUrl = import.meta.env.VITE_NEXUS_API_URL;
</script>

<template>
  <NexusGuard
    :nexus-api-url="nexusApiUrl"
    service-name="Nombre del módulo"
    logo-url="/logo.png"
  >
    <RouterView />
  </NexusGuard>
</template>
```

Mismo comportamiento que Svelte/React: verify al cargar + poll **~30 s** + pantalla blocked.

---

## Paso 4 — Datos de empresa

```vue
<script setup lang="ts">
import { useNexus } from './nexus/useNexus';

const { empresa, submodulo, metadata } = useNexus();
</script>
```

---

## Resto de pasos

Igual que [`../react/INTEGRACION.md`](../react/INTEGRACION.md): `.env`, `nexusFetch`, middleware backend, Nexus Admin.
