# 🚀 Exelixi Nexus - SaaS Multi-Tenant Backend

Exelixi Nexus es una infraestructura backend de alto rendimiento diseñada para orquestar sistemas SaaS multi-tenant. Implementa una arquitectura modular de "Vertical Slices", control de acceso granular (RBAC) y una capa de seguridad de doble factor (API Key + JWT).

## 🛠️ Tech Stack

- **Runtime**: Node.js v20+
- **Framework**: Express.js con TypeScript
- **ORM**: Prisma (PostgreSQL)
- **Validación**: Zod
- **Seguridad**:
  - **Auth**: JWT (Stateless)
  - **Hardening**: Helmet, CORS, Rate Limiting
  - **Shield**: Global API Key protection
- **Observabilidad**: Winston Logger (Nivel de Auditoría)
- **Documentación**: Swagger / OpenAPI 3.0

## 🏗️ Arquitectura: Modularidad Total

El proyecto sigue un patrón de **Vertical Slices**. A diferencia de la arquitectura tradicional por capas (MVC), aquí cada carpeta en `src/modules` es una unidad de negocio autónoma que contiene su propia lógica, controladores, rutas y esquemas de validación.

```text
src/
├── config/         # Configuraciones globales (DB, Swagger, Env)
├── middlewares/    # Guardias de seguridad y validación
├── utils/          # Utilidades puras y Logger
└── modules/        # Unidades de negocio (Slices)
    ├── auth/       # Gestión de sesiones y seguridad
    ├── company/    # Gestión de Tenants (Empresas) y Módulos
    ├── user/       # Gestión de Usuarios y Contraseñas
    ├── role/       # RBAC (Roles y Permisos dinámicos)
    └── sales/      # Módulo funcional de ejemplo (Ventas)
```

## 🔒 Seguridad de "Defensa en Profundidad"

1.  **Capa 1: Global API Key**: Todas las peticiones deben incluir el header `x-api-key`.
2.  **Capa 2: JWT Authentication**: Las rutas protegidas requieren un token válido.
3.  **Capa 3: Tenant Isolation**: Las consultas a la base de datos están filtradas por `empresaId`.
4.  **Capa 4: RBAC**: Validación dinámica de permisos (`canRead`, `canWrite`, `canDelete`) basada en la matriz de roles.

## 🚀 Instalación y Uso

### 1. Clonar y Configurar
```bash
cp .env.example .env
npm install
```

### 2. Base de Datos
```bash
npx prisma generate
npx prisma migrate dev
npx prisma db seed
```

### 3. Ejecución
```bash
npm run dev
```

## 📝 Documentación API

Una vez que el servidor esté corriendo, puedes acceder a la documentación interactiva en:
👉 `http://localhost:3000/api-docs`

> [!IMPORTANT]
> Para probar los endpoints en Swagger, haz clic en **Authorize** e introduce tu `API_KEY` configurada en el `.env`.

---
Desarrollado con foco en **escalabilidad, seguridad y observabilidad**.
