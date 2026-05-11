import swaggerJsdoc from 'swagger-jsdoc';
import { env } from './env';

const options: swaggerJsdoc.Options = {
  definition: {
    openapi: '3.0.0',
    tags: [
      {
        name: 'Auth',
        description:
          'Autenticación: login con email y contraseña, y perfil del usuario actual (`/me`). Requiere cabecera **x-api-key** en todas las rutas bajo `/api`.',
      },
      {
        name: 'Users',
        description:
          'Gestión de usuarios de la empresa del token JWT. Listado paginado, alta, edición, cambio de estado y cambio de contraseña del propio usuario.',
      },
      {
        name: 'Companies',
        description:
          'Empresas (tenant): listado, alta, detalle con módulos/submódulos y flags por empresa, y activación de módulos o submódulos.',
      },
      {
        name: 'Roles',
        description:
          'Roles por empresa, matriz de permisos para el front y asignación granular (módulo y submódulo).',
      },
      {
        name: 'Modules',
        description:
          'Catálogo global de módulos y submódulos (administración). Distinto del listado de módulos activos de la empresa en el menú.',
      },
    ],
    info: {
      title: 'Exelixi Nexus API',
      version: '1.1.0',
      description: `
## Bienvenido a la documentación de Exelixi Nexus API

Esta API proporciona una base sólida para aplicaciones multi-tenant con un sistema robusto de:
- 🏢 **Gestión de Empresas**: Aislamiento de datos por compañía.
- 🔐 **Autenticación y Autorización**: JWT y Roles dinámicos.
- 👥 **Gestión de Usuarios**: Control total sobre perfiles y estados.
- 🛠️ **Módulos**: Configuración flexible de funcionalidades por empresa.

### Seguridad
La mayoría de los endpoints requieren:
1. **x-api-key**: Validada para acceso a la infraestructura.
2. **Bearer Token**: Token JWT obtenido en el login para identificar al usuario.

---
`,
      contact: {
        name: 'Soporte Exelixi Nexus',
        url: 'https://exelixi.nexus',
        email: 'soporte@exelixi.com',
      },
      license: {
        name: 'MIT',
        url: 'https://opensource.org/licenses/MIT',
      },
    },
    servers: [
      {
        url: `http://localhost:${env.PORT}`,
        description: 'Servidor de desarrollo (Local)',
      },
      {
        url: 'http://192.168.8.120:3091',
        description: 'Servidor de Staging',
      },
    ],
    components: {
      securitySchemes: {
        bearerAuth: {
          type: 'http',
          scheme: 'bearer',
          bearerFormat: 'JWT',
          description: 'Ingrese su token JWT (obtenido en /api/auth/login)',
        },
        apiKeyAuth: {
          type: 'apiKey',
          in: 'header',
          name: 'x-api-key',
          description: 'API Key requerida para todas las peticiones a /api',
        },
      },
      responses: {
        UnauthorizedError: {
          description: 'Token JWT ausente, inválido o expirado',
          content: {
            'application/json': {
              schema: {
                $ref: '#/components/schemas/ErrorResponse',
              },
              example: { success: false, message: 'No autenticado' },
            },
          },
        },
        ForbiddenError: {
          description: 'No tiene permisos para realizar esta acción',
          content: {
            'application/json': {
              schema: {
                oneOf: [
                  { $ref: '#/components/schemas/ErrorResponse' },
                  { $ref: '#/components/schemas/MessageError' },
                ],
              },
              example: { success: false, message: 'No tiene permiso' },
            },
          },
        },
        BadRequestError: {
          description: 'Datos inválidos o regla de negocio no cumplida',
          content: {
            'application/json': {
              schema: {
                oneOf: [
                  { $ref: '#/components/schemas/ErrorResponse' },
                  { $ref: '#/components/schemas/MessageError' },
                ],
              },
              example: { success: false, message: 'Solicitud inválida' },
            },
          },
        },
      },
      schemas: {
        ErrorResponse: {
          type: 'object',
          description: 'Error con bandera success (módulos, empresas, roles)',
          properties: {
            success: { type: 'boolean', example: false },
            message: {
              type: 'string',
              example: 'Descripción del error',
            },
          },
        },
        MessageError: {
          type: 'object',
          description: 'Error simple (algunos endpoints de usuarios)',
          properties: {
            message: {
              type: 'string',
              example: 'Empresa no identificada',
            },
          },
        },
        ApiSuccessWithData: {
          type: 'object',
          properties: {
            success: { type: 'boolean', example: true },
            data: { description: 'Carga útil de la respuesta' },
          },
        },
        ApiSuccessWithMessage: {
          type: 'object',
          properties: {
            success: { type: 'boolean', example: true },
            message: {
              type: 'string',
              example: 'Operación completada',
            },
          },
        },
        ApiSuccessWithMessageAndData: {
          type: 'object',
          properties: {
            success: { type: 'boolean', example: true },
            message: { type: 'string' },
            data: { description: 'Datos adicionales' },
          },
        },
      },
    },
    security: [
      {
        apiKeyAuth: [],
      },
    ],
  },
  // Rutas donde buscar anotaciones de Swagger
  apis: [
    './src/modules/**/*.routes.ts',
    './src/modules/**/*.schema.ts',
    './src/app.ts',
    './dist/modules/**/*.routes.js',
    './dist/modules/**/*.schema.js',
    './dist/app.js',
  ],
};

export const specs = swaggerJsdoc(options);

const swaggerPathCount = Object.keys(
  (specs as { paths?: Record<string, unknown> }).paths ?? {},
).length;
console.info(
  `[Swagger] Documentación generada: ${swaggerPathCount} endpoints encontrados.`,
);
