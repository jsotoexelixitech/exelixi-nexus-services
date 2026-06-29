---
trigger: always_on
---

# Protocolo de Pruebas por Proyecto

| Proyecto                 | Testing                                               |
| ------------------------ | ----------------------------------------------------- |
| `auto-casa-inspeccion`   | Manual (Postman/browser) + visual RN                  |
| `backend-api-sys`        | Manual (Postman/curl)                                 |
| `BDLaMundialSeguros`     | Consultas SQL manuales                                |
| `exelixi-api`            | Manual (Postman/curl)                                 |
| `exelixi-modulos`        | Manual por módulo                                     |
| `exelixi-nexus`          | Visual browser + Jasmine/Karma si hay lógica compleja |
| `exelixi-nexus-services` | Manual (Postman/curl)                                 |
| `SysIP-backend`          | Manual (Postman/curl)                                 |

Documenta resultados de pruebas en `walkthrough.md` del proyecto correspondiente.
