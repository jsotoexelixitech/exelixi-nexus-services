# 🚀 Exelixi Nexus - SaaS Multi-Tenant Backend

Exelixi Nexus es una infraestructura backend de grado empresarial diseñada para orquestar sistemas SaaS multi-tenant con un enfoque radical en la **seguridad, escalabilidad y robustez del tipado**.

## 🌟 Diferenciadores Clave

- **🛡️ Seguridad de Doble Capa**: Protección mediante Global API Key y JWTs encriptados (AES-256-CBC).
- **💪 Tipado Estricto (Zero-Any Policy)**: Base de código 100% TypeScript con política estricta de cero uso de `any`.
- **🏢 Compatibilidad Legacy**: Integración con bases de datos preexistentes (IDs enteros, mapeos `snake_case`).
- **🧩 Sistema de Módulos Dinámicos**: Control total sobre qué funcionalidades tiene activas cada empresa.

---

## 🔐 Flujo de Seguridad y Autenticación

El sistema implementa una **Defensa en Profundidad** con el siguiente flujo:

1.  **Capa de Infraestructura (API Key)**: Todas las peticiones deben incluir el header `x-api-key`. Sin esto, el servidor rechaza la conexión antes de procesar lógica.
2.  **Capa de Autenticación (Login)**: Al loguearse, el sistema genera un JWT que es **encriptado simétricamente (AES-256-CBC)** antes de enviarse al cliente.
3.  **Capa de Sesión (Bearer Token)**: Para rutas protegidas, se debe enviar el token en el header `Authorization: Bearer <token_encriptado>`.
4.  **Capa de Aislamiento (Multi-tenancy)**: El sistema extrae el `empresaId` del token y garantiza que el usuario NUNCA pueda ver o modificar datos de otra empresa.

---

## 📡 Guía de API (Endpoints Principales)

### 🔑 Autenticación (`/api/auth`)
| Método | Endpoint | Descripción | Payload |
| :--- | :--- | :--- | :--- |
| `POST` | `/login` | Inicia sesión y devuelve un token encriptado. | `{ "email": "...", "password": "..." }` |
| `GET` | `/me` | Devuelve el perfil completo, empresa y permisos. | Requiere Bearer Token |

### 🏢 Empresas (`/api/companies`)
| Método | Endpoint | Descripción | Payload |
| :--- | :--- | :--- | :--- |
| `GET` | `/` | Lista todas las empresas (SaaS Admin). | - |
| `POST` | `/toggle-module` | Activa/Desactiva un módulo para una empresa. | `{ "empresaId": 1, "moduloId": 2, "active": true }` |

### 🧩 Módulos y Roles (`/api/modules`, `/api/roles`)
| Método | Endpoint | Descripción | Payload |
| :--- | :--- | :--- | :--- |
| `GET` | `/modules/active` | Módulos que la empresa actual tiene contratados. | - |
| `POST` | `/modules/submodule`| Crea una sub-funcionalidad dentro de un módulo. | `{ "moduloId": 1, "nombre": "..." }` |
| `POST` | `/roles` | Crea un rol (ej. "Vendedor") para la empresa. | `{ "nombre": "Vendedor" }` |
| `POST` | `/roles/assign` | Asigna permisos de módulos a un rol. | `{ "roleId": 1, "permissions": [1, 2] }` |

---

## 🚦 Límites y Funcionalidades

### 🛡️ Rate Limiting (Protección Anti-DDoS)
El sistema tiene un límite estricto por IP:
- **Límite**: 100 peticiones.
- **Ventana de tiempo**: 15 minutos.
- **Identificador**: Dirección IP del cliente.
- **Respuesta**: HTTP 429 (Too Many Requests).

### 📊 Matriz de Permisos (RBAC)
El acceso no es solo por "URL", sino por **Módulo**. 
1. Una empresa "contrata" un módulo.
2. El administrador crea un Rol.
3. El Rol se vincula a los módulos activos.
4. El usuario, al heredar el Rol, solo puede operar en los módulos permitidos.

---

## 🚀 Instalación Rápida

1.  **Configurar Entorno**: `cp .env.example .env` (Asegúrate de poner una `ENCRYPTION_KEY` de 32 caracteres).
2.  **Instalar**: `pnpm install`
3.  **Base de Datos**: `npx prisma db push && npx prisma db seed`
4.  **Desarrollo**: `npm run dev`

---
👉 **Documentación Interactiva**: `http://localhost:3000/api-docs`
