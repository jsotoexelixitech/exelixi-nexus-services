# Kit Svelte — Exélixi Nexus

Paquete **autocontenido** para integrar un módulo Svelte/SvelteKit con **Exélixi Nexus** (verify, heartbeat, multi-tenant).

**Empieza aquí:** [`INTEGRACION.md`](./INTEGRACION.md)

## Contenido de esta carpeta

| Ruta                          | Uso                                              |
| ----------------------------- | ------------------------------------------------ |
| `NexusGuard.svelte`           | Envuelve la app; bloquea si no hay acceso válido |
| `core/nexus-core.ts`          | Token, verify, heartbeat, `nexusFetch`           |
| `backend/nexus-middleware.ts` | Middleware Express (si el módulo tiene API)      |
| `.env.example`                | Variables del frontend                           |
| `backend/.env.example`        | Variables del backend                            |
| `INTEGRACION.md`              | Guía paso a paso + alta en Nexus Admin           |

## Entrega al equipo

Copia **toda la carpeta `svelte/`** al repo del módulo (por ejemplo `src/lib/nexus/` o `src/nexus/`) y sigue `INTEGRACION.md`.

Con `.env` correcto y el submódulo activo en Nexus Admin, el front se conecta a la API Nexus al abrir la URL con `?nexus_token=…`.
