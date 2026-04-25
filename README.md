# 🚀 Exelixi Nexus - SaaS Multi-Tenant Backend

Exelixi Nexus es una infraestructura backend de grado empresarial diseñada para orquestar sistemas SaaS multi-tenant con un enfoque radical en la **seguridad, escalabilidad y robustez del tipado**.

Implementa una arquitectura modular de "Vertical Slices", control de acceso granular (RBAC) y una capa de seguridad híbrida de vanguardia.

## 🌟 Diferenciadores Clave

- **🛡️ Seguridad de Doble Capa**: Protección mediante Global API Key y JWTs encriptados (AES-256-CBC).
- **💪 Tipado Estricto (Zero-Any Policy)**: Base de código 100% TypeScript con política estricta de cero uso de `any`, garantizando estabilidad en producción.
- **🏢 Compatibilidad Legacy**: Diseñado para integrarse con bases de datos preexistentes (IDs enteros, mapeos `snake_case`) sin perder la elegancia del código moderno.
- **🧩 Arquitectura de Módulos y Submódulos**: Sistema dinámico para habilitar/deshabilitar funcionalidades por cliente.

## 🛠️ Tech Stack

- **Runtime**: Node.js v20+ (Ejecución optimizada con `tsx`)
- **Framework**: Express.js + TypeScript
- **ORM**: Prisma (PostgreSQL) con mapeo avanzado de esquemas legacy.
- **Validación**: Zod para esquemas de entrada y salida.
- **Seguridad**:
  - **Auth**: JWT con capa extra de obfuscación mediante cifrado simétrico.
  - **Hardening**: Helmet, CORS, Rate Limiting.
  - **Shield**: Global API Key protection (Capa de infraestructura).
- **Observabilidad**: Winston Logger con niveles de auditoría configurables.
- **Documentación**: Swagger / OpenAPI 3.0 con soporte para autorización por Header.

## 🏗️ Estructura del Proyecto

El proyecto sigue un patrón de **Vertical Slices**. Cada carpeta en `src/modules` es una unidad de negocio autónoma.

```text
src/
├── config/         # Configuraciones globales (DB, Swagger, Env)
├── middlewares/    # Guardias de seguridad (Auth, Role, API Key)
├── utils/          # Utilidades tipadas (Crypto, Pagination, Error Handling)
└── modules/        # Unidades de negocio (Slices)
    ├── auth/       # Sesiones y perfil detallado (/me)
    ├── company/    # Gestión de Tenants, Módulos y Submódulos
    ├── user/       # Gestión de Usuarios y Seguridad de cuentas
    ├── role/       # Matriz de permisos dinámicos (RBAC)
    └── module/     # Definición global de capacidades del sistema
```

## 🔒 Capas de Seguridad

1.  **Capa de Infraestructura**: Validación de `x-api-key` para prevenir tráfico no autorizado.
2.  **Capa de Sesión**: JWT encriptado. El cliente nunca ve el contenido real del token, evitando ingeniería inversa del payload.
3.  **Capa de Tenant**: Aislamiento forzado por `empresaId` en todas las consultas al ORM.
4.  **Capa de Permisos**: Validación por Módulo y Submódulo antes de ejecutar lógica de negocio.

## 🚀 Instalación y Uso

### 1. Requisitos
- Node.js 20+
- PostgreSQL

### 2. Configuración
```bash
cp .env.example .env
npm install
```

### 3. Sincronización y Seed
```bash
npx prisma generate
npx prisma db seed
```

### 4. Ejecución en Desarrollo
```bash
npm run dev
```

## 📝 Documentación API

Accede a la documentación interactiva y sandbox de pruebas:
👉 `http://localhost:3000/api-docs`

> [!IMPORTANT]
> El proyecto utiliza **IDs enteros** para los parámetros de ruta (`/api/companies/1`) para mantener compatibilidad con el esquema legacy.

---
Desarrollado con foco en **cero deuda técnica y máxima seguridad**.
