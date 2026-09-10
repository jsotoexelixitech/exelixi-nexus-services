# Kit Vue 3 — Exélixi Nexus

Paquete **autocontenido** para integrar un módulo Vue 3/Vite con **Exélixi Nexus**.

**Empieza aquí:** [`INTEGRACION.md`](./INTEGRACION.md)

## Contenido

| Ruta                 | Uso                                 |
| -------------------- | ----------------------------------- |
| `NexusGuard.vue`     | Wrapper con loading/blocked         |
| `useNexus.ts`        | Composable `empresa` / `submodulo`  |
| `core/nexus-core.ts` | Token, verify, poll, `nexusFetch`   |
| `backend/`           | Middleware Express + `.env.example` |

Copia **toda la carpeta `vue/`** a `src/nexus/` y sigue `INTEGRACION.md`.
