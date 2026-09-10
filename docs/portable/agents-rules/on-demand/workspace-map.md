---
trigger: always_on
priority: 2
---

# Mapa del Workspace (Estático)

Ruta base: `c:\Users\javier.soto\Desktop\all-projects\`

| Proyecto                 | Stack                                  | Carpetas clave                                                       | Agentes                          |
| ------------------------ | -------------------------------------- | -------------------------------------------------------------------- | -------------------------------- |
| `auto-casa-inspeccion`   | React + NestJS (backend/)              | `src/` `backend/`                                                    | front · back · db · orchestrator |
| `backend-api-sys`        | Express + Sequelize                    | `src/` `nest-api/`                                                   | front · back · db                |
| `BDLaMundialSeguros`     | SQL puro                               | `schemas/` `utils/`                                                  | db                               |
| `exelixi-api`            | React (frontend/) + Express (backend/) | `frontend/` `backend/`                                               | front · back · db                |
| `exelixi-modulos`        | Node multi-módulo                      | `modulo-emision/` `modulo-formulario/` `modulo-ocr/` `modulo-pagos/` | front · back · db                |
| `exelixi-nexus`          | React 18 + Vite + TypeScript           | `src/`                                                               | front · back · db                |
| `exelixi-nexus-services` | Express + Prisma + PostgreSQL          | `src/` `prisma/`                                                     | front · back · db                |
| `SysIP-backend`          | Express + Sequelize                    | `src/`                                                               | back · db                        |

**Agentes en:** `<proyecto>/.antigravity/<tipo>_agent.md`

> Este mapa se actualiza ejecutando `node generate-map.js` en la raíz del workspace.
