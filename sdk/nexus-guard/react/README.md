# Kit React — Exélixi Nexus

Paquete **autocontenido** para integrar un módulo React/Vite con **Exélixi Nexus** (verify, polling ~30 s, multi-tenant).

**Empieza aquí:** [`INTEGRACION.md`](./INTEGRACION.md)

## Contenido de esta carpeta

| Ruta                          | Uso                                              |
| ----------------------------- | ------------------------------------------------ |
| `NexusGuard.tsx`              | Envuelve la app; bloquea si no hay acceso válido |
| `useNexusAccess.ts`           | Hook interno (polling verify)                    |
| `core/nexus-core.ts`          | Token, verify, poll, `nexusFetch`                |
| `backend/nexus-middleware.ts` | Middleware Express (si el módulo tiene API)      |
| `.env.example`                | Variables del frontend                           |
| `backend/.env.example`        | Variables del backend                            |
| `INTEGRACION.md`              | Guía paso a paso + alta en Nexus Admin           |

## Entrega al equipo

Copia **toda la carpeta `react/`** al repo del módulo (por ejemplo `src/nexus/`) y sigue `INTEGRACION.md`.
