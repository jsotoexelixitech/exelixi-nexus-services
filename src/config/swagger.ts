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
      {
        name: 'Flow',
        description:
          'Bridge inter-módulo: sesiones `sid`, checkout directo a Pagos y auto-arranque desde `nexus_token`.',
      },
      {
        name: 'Access',
        description:
          'Verificación pública de tokens tenant, heartbeat y canje API Key → access_token (OAuth-like).',
      },
      {
        name: 'Integración externa',
        description:
          'Guía SSO para QASys2000 / terceros: ver `docs/INTEGRACION-SSO-Y-PAGOS.md`.',
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

### Integración para terceros (SSO seguro)

**Flujo RCV (recomendado):** \`POST /api/auth/sso-delegate\` con \`x-api-key\` + metadata (\`cproductor\`, \`cusuario\`, canal…) → redirigir al usuario a \`redirect_url\`.

**Pagos standalone:** mismo endpoint con \`target: "pagos"\` y \`metadata.checkout.totalVes\` + \`metadata.payload.notifyUrl\`.

**Alternativa server-to-server:** \`POST /api/flow/checkout-link\`.

Documentación completa: \`docs/INTEGRACION-SSO-Y-PAGOS.md\`.

### OAuth-like (API Key → access_token)
1. Solicite su **API Key** al administrador Nexus.
2. \`POST /api/access/token\` con la API Key.
3. Use \`Authorization: Bearer <access_token>\` hacia módulos que lo requieran.

### Seguridad General
La mayoría de los endpoints administrativos requieren:
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
        url: 'https://cierrelmds.exelixitech.com/nexus-api',
        description: 'Producción — cierrelmds (prefijo /nexus-api/)',
      },
      {
        url: `http://localhost:${env.PORT}`,
        description: 'Desarrollo local',
      },
      {
        url: 'http://192.168.8.120:3092',
        description: 'Servidor interno srv001',
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
        SsoMetadataCanal: {
          type: 'object',
          description:
            'Canal Sis2000 embebido en el JWT. **cproductor** debe ser entero ≥ 1 (no string vacío).',
          properties: {
            cproductor: {
              type: 'string',
              example: '80080',
              description:
                'Código productor La Mundial (obligatorio para planes RCV)',
            },
            cusuario: { type: 'string', example: '7' },
            cramo: {
              type: 'integer',
              example: 18,
              description: '18 = automóvil RCV',
            },
            ctipo: {
              type: 'integer',
              example: 1,
              description: '1=particular, 2=rústico, 3=carga',
            },
            ccanalalt_in: { type: 'string', example: '27' },
            cscanalalt_in: { type: 'integer', example: 0 },
            cgestor_in: { type: 'string', example: 'GESTOR-01' },
            canal: { type: 'string', maxLength: 50 },
          },
        },
        SsoCheckoutLine: {
          type: 'object',
          required: ['label', 'amountVes'],
          properties: {
            label: { type: 'string', example: 'Prima RCV anual' },
            amountVes: { type: 'number', example: 120000 },
            amountUsd: { type: 'number', example: 336 },
          },
        },
        SsoCheckout: {
          type: 'object',
          required: ['title', 'totalVes'],
          properties: {
            referenceId: { type: 'string', example: 'POL-2026-001' },
            title: { type: 'string', example: 'Pago póliza RCV' },
            subtitle: { type: 'string', example: 'La Mundial de Seguros' },
            lines: {
              type: 'array',
              items: { $ref: '#/components/schemas/SsoCheckoutLine' },
            },
            totalVes: { type: 'number', example: 125000.5 },
            totalUsd: { type: 'number', example: 350 },
            exchangeRate: { type: 'number', example: 357.14 },
          },
        },
        SsoCheckoutRules: {
          type: 'object',
          properties: {
            requirePayment: { type: 'boolean', example: true },
            methods: {
              type: 'array',
              items: {
                type: 'string',
                enum: ['mobile', 'otp', 'transfer', 'card'],
              },
              example: ['mobile', 'otp'],
            },
            onSuccess: {
              type: 'object',
              properties: {
                mode: {
                  type: 'string',
                  enum: ['none', 'redirect', 'webhook', 'emit'],
                },
                redirectUrl: { type: 'string', format: 'uri' },
                webhookUrl: { type: 'string', format: 'uri' },
              },
            },
          },
        },
        SsoPayer: {
          type: 'object',
          properties: {
            documentType: { type: 'string', example: 'V' },
            documentNumber: { type: 'string', example: '12345678' },
            name: { type: 'string', example: 'JUAN PEREZ' },
            phone: { type: 'string', example: '04141234567' },
          },
        },
        SsoMetadataPagos: {
          allOf: [
            { $ref: '#/components/schemas/SsoMetadataCanal' },
            {
              type: 'object',
              properties: {
                checkout: { $ref: '#/components/schemas/SsoCheckout' },
                rules: { $ref: '#/components/schemas/SsoCheckoutRules' },
                payer: { $ref: '#/components/schemas/SsoPayer' },
                payload: {
                  type: 'object',
                  description:
                    'Datos opacos; incluir notifyUrl para webhook post-pago',
                  properties: {
                    notifyUrl: {
                      type: 'string',
                      format: 'uri',
                      example: 'https://tu-app.com/api/pago-callback',
                    },
                  },
                  additionalProperties: true,
                },
              },
            },
          ],
        },
        SsoDelegateResponse: {
          type: 'object',
          properties: {
            success: { type: 'boolean', example: true },
            redirect_url: {
              type: 'string',
              format: 'uri',
              example:
                'https://cierrelmds.exelixitech.com/ocr/?nexus_token=eyJhbGciOiJIUzI1NiIs...',
            },
            empresa: { type: 'string', example: 'Cooperativa Demo' },
            modulo: { type: 'string', example: 'OCR Documentos' },
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
