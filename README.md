# 🚀 Exelixi Nexus - SaaS Multi-Tenant Backend

Exelixi Nexus es una infraestructura backend de grado empresarial diseñada para orquestar sistemas SaaS multi-tenant con un enfoque radical en la **seguridad, observabilidad y robustez del tipado**.

---

## 🌟 Diferenciadores de Grado Producción

### 🛡️ Seguridad y Blindaje (Hardening)

- **Defensa en Profundidad**: Protección mediante **Global API Key** (`x-api-key`) y JWTs con **encriptación simétrica AES-256-CBC**.
- **Aislamiento Multi-tenant Estricto**: Middlewares que garantizan que una empresa NUNCA pueda acceder a datos de otra, incluso con tokens válidos.
- **Validación de Entorno**: El servidor utiliza **Zod** para validar las variables de entorno al arrancar. Si falta una llave secreta o la DB está mal configurada, el sistema falla inmediatamente con un error claro.

### 📡 Observabilidad 360°

- **Trazabilidad Total**: Cada petición genera un `x-request-id` único que viaja a través de todos los logs (Winston) y trazas de error.
- **Sentry Deep Integration**: Captura de errores en tiempo real con filtrado de PII (Datos Sensibles) y breadcrumbs automáticos de base de datos (Prisma).
- **Performance Tracking**: Logs automáticos del tiempo de ejecución de cada endpoint en milisegundos.

### 🧪 Quality Assurance (QA) Suite

- **100% CRUD Coverage**: Suite de pruebas automatizada (`qa_test.sh`) que valida el ciclo de vida completo (Create, Read, Update, Delete) de cada módulo.
- **Zero-Regression Policy**: Pruebas integrales de seguridad (Cross-tenant access attempts) incluidas en cada ejecución.

---

## 🔐 Flujo de Seguridad

1.  **API Key Guard**: Filtro global inicial.
2.  **JWT Encrypted**: Los tokens viajan cifrados, imposibles de leer sin la `ENCRYPTION_KEY`.
3.  **Tenant Context**: `AsyncLocalStorage` propaga el ID de la empresa y el ID de la petición sin contaminar la firma de las funciones.

---

## 📡 Endpoints de Arquitectura

### 🔑 Autenticación (`/api/auth`)

| Método | Endpoint | Descripción                                       |
| :----- | :------- | :------------------------------------------------ |
| `POST` | `/login` | Autenticación + Generación de Token Cifrado.      |
| `GET`  | `/me`    | Perfil del usuario con matriz de permisos actual. |

### 🧩 Gestión de Módulos (`/api/modules`)

| Método | Endpoint     | Descripción                          |
| :----- | :----------- | :----------------------------------- |
| `GET`  | `/`          | Lista módulos activos de la empresa. |
| `POST` | `/`          | Crea un nuevo módulo (Admin).        |
| `POST` | `/submodule` | Crea una sub-funcionalidad.          |

### 👥 Usuarios y Roles (`/api/users`, `/api/roles`)

| Método  | Endpoint             | Descripción                             |
| :------ | :------------------- | :-------------------------------------- |
| `PATCH` | `/users/:id/status`  | Activación/Desactivación (Soft Delete). |
| `POST`  | `/roles/permissions` | Asignación de matriz CRUD granular.     |

---

## 🚀 Instalación y QA

### Configuración

1. `cp .env.example .env`
2. Configura `SENTRY_DSN` para habilitar la monitorización.
3. `pnpm install`

### Base de Datos

```bash
npx prisma db push
npx prisma db seed
```

### Ejecutar Pruebas de Calidad

```bash
# Ejecuta la suite completa de QA v4.3
./qa_test.sh
```

---

## 📊 Monitoreo de Logs

El sistema genera logs estructurados en `combined.log`:

```json
{
  "level": "info",
  "message": "Finished Request: GET /api/roles 200 - 5ms",
  "requestId": "db89...",
  "timestamp": "..."
}
```

---

👉 **Documentación Swagger**: `http://localhost:3021/api-docs`
