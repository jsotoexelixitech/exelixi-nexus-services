import { Router } from 'express';
import { AuthController } from './auth.controller';
import { authenticate } from '../../middlewares/auth.middleware';
import { validate } from '../../middlewares/validate.middleware';
import { loginSchema } from './auth.schema';
import rateLimit from 'express-rate-limit';
import logger from '../../utils/logger';

/** Rate limiter para el endpoint SSO: 30 peticiones por minuto por IP */
const ssoDelegateLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minuto
  max: 30, // máximo 30 peticiones por ventana
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: {
    success: false,
    message:
      'Demasiadas peticiones. Por favor espere un momento antes de reintentar.',
  },
  handler: (req, res, _next, options) => {
    logger.warn(`[sso-delegate] rate limit excedido — IP: ${req.ip}`);
    res.status(429).json(options.message);
  },
});

const router = Router();
const controller = new AuthController();

/**
 * @openapi
 * /api/auth/login:
 *   post:
 *     tags:
 *       - Auth
 *     summary: Iniciar sesión
 *     description: |
 *       Autentica por email y contraseña. Devuelve un **token cifrado** (no es un JWT en claro) y un resumen del usuario.
 *       Requiere cabecera **x-api-key** (igual que el resto de `/api`).
 *     security:
 *       - apiKeyAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - email
 *               - password
 *             properties:
 *               email:
 *                 type: string
 *                 format: email
 *                 example: admin@exelixi.com
 *               password:
 *                 type: string
 *                 format: password
 *                 example: admin123
 *     responses:
 *       200:
 *         description: Credenciales correctas; token listo para enviar como Bearer en rutas protegidas.
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               required: [token, user]
 *               properties:
 *                 token:
 *                   type: string
 *                   description: Token cifrado (hex) para la cabecera Authorization Bearer
 *                   example: "5d9f8e7a2b1c3d4e5f6a7b8c9d0e1f2a:a1b2c3d4e5f6f7e8d9c0b1a29384756b5"
 *                 user:
 *                   type: object
 *                   properties:
 *                     id: { type: integer, example: 1 }
 *                     nombre: { type: string, example: "Admin" }
 *                     email: { type: string, example: "admin@exelixi.com" }
 *                     empresa: { type: string, example: "Mi Empresa" }
 *                     role: { type: string, example: "Administrador" }
 *             example:
 *               token: "abc123:def456"
 *               user:
 *                 id: 1
 *                 nombre: "Admin"
 *                 email: "admin@exelixi.com"
 *                 empresa: "Exelixi Demo"
 *                 role: "Administrador"
 *       401:
 *         description: |
 *           No se pudo autenticar (email inexistente, contraseña incorrecta, cuenta desactivada, etc.).
 *           El controlador usa siempre el código **401** con `{ success, message }`.
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
 *             examples:
 *               passwordWrong:
 *                 summary: Contraseña incorrecta
 *                 value:
 *                   success: false
 *                   message: "La contraseña ingresada es incorrecta."
 *               inactive:
 *                 summary: Cuenta desactivada
 *                 value:
 *                   success: false
 *                   message: "Su cuenta ha sido desactivada. Por favor, contacte con soporte técnico."
 */
router.post('/login', validate(loginSchema), controller.login);

/**
 * @openapi
 * /api/auth/sso-delegate:
 *   post:
 *     tags:
 *       - Auth
 *       - Integración externa
 *     summary: Delegar sesión SSO (RCV, Pagos, OCR…)
 *     description: |
 *       **Integración segura server-to-server** para apps externas (QASys2000, Angular La Mundial).
 *
 *       1. Valida **`x-api-key`** → identifica la empresa tenant.
 *       2. Sanitiza **`metadata`** (Zod; campos desconocidos descartados).
 *       3. Genera JWT **`nexus_token`** (1 h) con `empresaId`, `submoduloId` y metadata.
 *       4. Devuelve **`redirect_url`** para abrir en el navegador del usuario.
 *
 *       ### Flujo RCV
 *       `target: "ocr"` (default) + metadata canal: **`cproductor`** (≥1, obligatorio), `cusuario`, `cramo`, canal alterno.
 *
 *       ### Pagos standalone
 *       `target: "pagos"` + `metadata.checkout.totalVes` + `metadata.payload.notifyUrl`.
 *
 *       Guía: `docs/INTEGRACION-SSO-Y-PAGOS.md`
 *
 *       **Rate limit:** 30 peticiones/minuto por IP.
 *     security:
 *       - apiKeyAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               target:
 *                 type: string
 *                 enum: [ocr, formulario, emision, pagos]
 *                 default: ocr
 *                 description: Primer submódulo al que entra el usuario
 *               metadata:
 *                 oneOf:
 *                   - $ref: '#/components/schemas/SsoMetadataCanal'
 *                   - $ref: '#/components/schemas/SsoMetadataPagos'
 *               cproductor:
 *                 type: string
 *                 example: '80080'
 *                 description: Alternativa legacy en raíz (strings vacíos se ignoran)
 *               cusuario:
 *                 type: string
 *                 example: '7'
 *               cramo:
 *                 type: integer
 *                 example: 18
 *               ctipo:
 *                 type: integer
 *                 example: 1
 *               ccanalalt_in:
 *                 type: string
 *                 example: '27'
 *               cscanalalt_in:
 *                 type: integer
 *                 example: 0
 *               cgestor_in:
 *                 type: string
 *           examples:
 *             rcvQaSys2000:
 *               summary: Entrada flujo RCV (QASys2000)
 *               value:
 *                 target: ocr
 *                 cproductor: '80080'
 *                 cusuario: '7'
 *                 cramo: 18
 *                 ccanalalt_in: '27'
 *                 cscanalalt_in: 0
 *             pagosStandalone:
 *               summary: Pagos solo cobro (webhook)
 *               value:
 *                 target: pagos
 *                 metadata:
 *                   checkout:
 *                     title: Pago póliza RCV
 *                     totalVes: 125000.5
 *                   rules:
 *                     methods: [mobile, otp]
 *                   payload:
 *                     notifyUrl: https://tu-app.com/api/pago-callback
 *                     polizaId: POL-2026-001
 *     responses:
 *       200:
 *         description: URL de redirección con nexus_token
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/SsoDelegateResponse'
 *       400:
 *         description: Falta x-api-key o metadata inválida
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
 *       401:
 *         description: API Key inválida
 *       403:
 *         description: Empresa inactiva o submódulo no activado
 *       404:
 *         description: Submódulo destino no encontrado
 *       429:
 *         description: Rate limit excedido
 */
router.post('/sso-delegate', ssoDelegateLimiter, controller.ssoDelegate);

/**
 * @openapi
 * /api/auth/me:
 *   get:
 *     tags:
 *       - Auth
 *     summary: Perfil del usuario autenticado
 *     description: |
 *       Devuelve usuario, empresa, y permisos agregados por módulo/submódulo según el rol.
 *       El usuario se identifica **solo por el JWT** (no se envía ID en la URL).
 *     security:
 *       - apiKeyAuth: []
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Perfil y permisos para armar el menú y vistas
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success: { type: boolean, example: true }
 *                 data:
 *                   type: object
 *                   properties:
 *                     user:
 *                       type: object
 *                       properties:
 *                         id: { type: integer, example: 1 }
 *                         nombre: { type: string }
 *                         email: { type: string, format: email }
 *                         role: { type: string, example: "Administrador" }
 *                     empresa:
 *                       type: object
 *                       properties:
 *                         id: { type: integer }
 *                         nombre: { type: string }
 *                         rif: { type: string }
 *                     permissions:
 *                       type: array
 *                       description: Módulos activos de la empresa con flags CRUD y submódulos
 *                       items:
 *                         type: object
 *                         properties:
 *                           id: { type: integer, description: "ID del módulo" }
 *                           nombre: { type: string }
 *                           hasAccess: { type: boolean }
 *                           canCreate: { type: boolean }
 *                           canRead: { type: boolean }
 *                           canUpdate: { type: boolean }
 *                           canDelete: { type: boolean }
 *                           submodulos:
 *                             type: array
 *                             items:
 *                               type: object
 *                               properties:
 *                                 id: { type: integer }
 *                                 nombre: { type: string }
 *                                 hasAccess: { type: boolean }
 *                                 canCreate: { type: boolean }
 *                                 canRead: { type: boolean }
 *                                 canUpdate: { type: boolean }
 *                                 canDelete: { type: boolean }
 *             example:
 *               success: true
 *               data:
 *                 user:
 *                   id: 1
 *                   nombre: "María"
 *                   email: "maria@empresa.com"
 *                   role: "Admin"
 *                 empresa:
 *                   id: 2
 *                   nombre: "Colegio Demo"
 *                   rif: "J-12345678-9"
 *                 permissions:
 *                   - id: 1
 *                     nombre: "Ventas"
 *                     hasAccess: true
 *                     canRead: true
 *                     canCreate: false
 *                     canUpdate: false
 *                     canDelete: false
 *                     submodulos:
 *                       - id: 10
 *                         nombre: "Cotizaciones"
 *                         hasAccess: true
 *                         canRead: true
 *                         canCreate: false
 *                         canUpdate: false
 *                         canDelete: false
 *       401:
 *         $ref: '#/components/responses/UnauthorizedError'
 *       500:
 *         description: Error interno al resolver el perfil
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
 */
router.get('/me', authenticate, controller.me);

export default router;
