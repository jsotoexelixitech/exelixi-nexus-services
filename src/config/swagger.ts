import swaggerJsdoc from 'swagger-jsdoc';
import { env } from './env';

const options: swaggerJsdoc.Options = {
  definition: {
    openapi: '3.0.0',
    info: {
      title: 'Exelixi Nexus API',
      version: '1.0.0',
      description: 'API robusta para la gestión multi-tenant, roles y permisos.',
      contact: {
        name: 'Soporte Técnico',
        email: 'soporte@exelixi.com'
      }
    },
    servers: [
      {
        url: `http://localhost:${env.PORT}`,
        description: 'Servidor de desarrollo'
      }
    ],
    components: {
      securitySchemes: {
        bearerAuth: {
          type: 'http',
          scheme: 'bearer',
          bearerFormat: 'JWT'
        },
        apiKeyAuth: {
          type: 'apiKey',
          in: 'header',
          name: 'x-api-key'
        }
      }
    },
    security: [
      { bearerAuth: [] },
      { apiKeyAuth: [] }
    ]
  },
  // Rutas donde buscar anotaciones de Swagger
  apis: [
    './src/server.ts',
    './src/modules/**/*.routes.ts',
    './src/schemas/*.ts'
  ]
};

export const specs = swaggerJsdoc(options);
