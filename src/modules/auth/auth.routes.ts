import { Router } from 'express';
import { AuthController } from './auth.controller';
import { authenticate } from '../../middlewares/auth.middleware';
import { validate } from '../../middlewares/validate.middleware';
import { loginSchema } from './auth.schema';

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
