# Onboarding rápido y seguro — módulo nuevo + Nexus Admin

Objetivo: conectar un microfrontend (Svelte, React, etc.) con **Exélixi Nexus** en el menor tiempo posible, sin atajos inseguros.

---

## Flujo recomendado (~15 minutos)

| Paso | Quién          | Acción                                                                   |
| ---- | -------------- | ------------------------------------------------------------------------ |
| 1    | Admin Nexus    | **Módulos** → nuevo módulo + submódulo con **URL HTTPS**                 |
| 2    | Admin Nexus    | Botón **Integración** en el submódulo → copiar `.env` y **Submódulo ID** |
| 3    | Dev del módulo | Copiar `sdk/nexus-guard/svelte/` (o React/Vue del SDK) + pegar `.env`    |
| 4    | Admin Nexus    | **Empresas** → activar módulo/submódulo por tenant                       |
| 5    | QA             | Entrar con enlace `?nexus_token=` o flujo SSO / API Key (Conexiones)     |

---

## Admin: una sola fuente de verdad

- **Catálogo global:** Módulos → activar/desactivar módulo y submódulo.
- **Por empresa:** Empresas → toggles (no saltarse este paso en producción).
- **Credenciales standalone:** Empresas → Conexiones (API Key + heartbeat).

El panel **Integración** del admin genera:

- `NEXUS_EXPECTED_SUBMODULO_IDS` (= id numérico del submódulo)
- `VITE_NEXUS_API_URL` / `NEXUS_API_URL`
- Recordatorio del kit SDK

---

## Dev del módulo: mínimo seguro

**Frontend**

1. Kit: [`nexus-guard/svelte/`](./nexus-guard/svelte/) (autocontenido).
2. `VITE_NEXUS_API_URL` apuntando a **nexus-api**, no al admin.
3. Envolver la app con `NexusGuard` → verify + heartbeat automático.

**Backend (si aplica)**

1. Copiar `nexus-middleware.ts` sin editar.
2. `TENANT_TOKEN_SECRET` = mismo secreto que `exelixi-nexus-services` (canal privado).
3. `NEXUS_EXPECTED_SUBMODULO_IDS` = id del submódulo del paso 2.
4. **Producción:** `NEXUS_AUTH_ENABLED=true`, evitar `WHITELISTED_ORIGINS` amplios.

---

## Alternativa CLI (servidor / CI)

Sin UI, con variables editadas:

```bash
cd exelixi-nexus-services
npm run register-modulo -- --modulo "Mi Módulo" --submodulo "Web" --url "https://cierrelmds.exelixitech.com/mi-modulo/"
```

Equivalente a crear filas en `modulo` / `submodulo`. Luego usar el admin para activar por empresa.

---

## Qué no hacer (seguridad)

| Riesgo                                      | Mitigación                                              |
| ------------------------------------------- | ------------------------------------------------------- |
| Mismo submódulo ID en varias apps distintas | Un submódulo por app desplegada                         |
| Secret en Git                               | Solo `.env` local / vault del servidor                  |
| Bypass permanente en prod                   | Quitar whitelist; usar token real                       |
| Módulo visible sin activar empresa          | Usuario no debe recibir URL productiva hasta activación |

---

## Referencias

- SDK Svelte: [`nexus-guard/svelte/INTEGRACION.md`](./nexus-guard/svelte/INTEGRACION.md)
- Middleware server: [`nexus-server/README.md`](./nexus-server/README.md)
- SSO / pagos: [`../docs/INTEGRACION-SSO-Y-PAGOS.md`](../docs/INTEGRACION-SSO-Y-PAGOS.md)
