import swaggerJsdoc from 'swagger-jsdoc';
import { env } from './env';

const options: swaggerJsdoc.Options = {
  definition: {
    openapi: '3.0.0',
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
          description: 'Token no válido o expirado',
          content: {
            'application/json': {
              schema: {
                $ref: '#/components/schemas/ErrorResponse',
              },
            },
          },
        },
        ForbiddenError: {
          description: 'No tiene permisos para realizar esta acción',
          content: {
            'application/json': {
              schema: {
                $ref: '#/components/schemas/ErrorResponse',
              },
            },
          },
        },
      },
      schemas: {
        ErrorResponse: {
          type: 'object',
          properties: {
            success: { type: 'boolean', example: false },
            message: {
              type: 'string',
              example: 'Error detallado del servidor',
            },
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

// Log para verificar que se están encontrando los endpoints
console.log(
  `[Swagger] Documentación generada: ${Object.keys((specs as any).paths || {}).length} endpoints encontrados.`,
);
