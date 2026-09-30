import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { authenticate } from '../../middlewares/auth.middleware';
import { validate } from '../../middlewares/validate.middleware';
import { PortalController } from './portal.controller';
import { PortalUsersController } from './portal-users.controller';
import { requirePortalAdmin } from './portal-admin.middleware';
import { createUserSchema, updateUserSchema } from '../user/user.schema';

const router = Router();
const controller = new PortalController();
const portalUsers = new PortalUsersController();

/** Login Sis2000: 10 intentos por minuto por IP. */
const sis2000LoginLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 10,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: {
    success: false,
    message: 'Demasiados intentos. Espere un minuto antes de reintentar.',
  },
});

/**
 * @openapi
 * /api/portal/login-sis2000:
 *   post:
 *     tags:
 *       - Portal
 *     summary: Login portal con usuario Sis2000 (marketplace / canales)
 *     description: |
 *       Valida xlogin/xcontrasena contra Sis2000 vía nest-api (`POST /api/v1/portal/login`)
 *       y devuelve el mismo token de sesión que `/api/auth/login`. El canal del usuario queda
 *       en su perfil del portal y define el catálogo de productos.
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [xlogin, xcontrasena]
 *             properties:
 *               xlogin:
 *                 type: string
 *               xcontrasena:
 *                 type: string
 *     responses:
 *       200:
 *         description: Sesión iniciada (token + user)
 *       401:
 *         description: Usuario o contraseña inválidos
 *       403:
 *         description: Usuario sin canal activo o desactivado en el portal
 */
router.post('/login-sis2000', sis2000LoginLimiter, controller.loginSis2000);

/** Entrada desde el menú de Sis2000: 30 canjes por minuto por IP. */
const ssoSessionLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 30,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: {
    success: false,
    message: 'Demasiados intentos. Espere un minuto antes de reintentar.',
  },
});

/**
 * @openapi
 * /api/portal/sso-session:
 *   post:
 *     tags:
 *       - Portal
 *     summary: Canjea el pase de Sis2000 por la sesión del marketplace
 *     description: |
 *       Sis2000 llama a `POST /api/auth/sso-delegate` con `target: "marketplace"`, x-api-key y los
 *       datos del usuario logueado; recibe `redirect_url` = `{PORTAL_PUBLIC_URL}/sso?nexus_token=…`.
 *       El portal canjea ese pase (10 min, un solo uso) aquí y entra sin pantalla de login.
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [nexus_token]
 *             properties:
 *               nexus_token:
 *                 type: string
 *     responses:
 *       200:
 *         description: Sesión iniciada (token + user, igual que /api/auth/login)
 *       401:
 *         description: Pase vencido, inválido o ya usado
 */
router.post('/sso-session', ssoSessionLimiter, controller.ssoSession);

/**
 * @openapi
 * /api/portal/audit:
 *   post:
 *     tags:
 *       - Portal
 *     summary: Registrar acción del portal La Mundial
 *     description: |
 *       Registra una acción del usuario en el portal (ej. lanzamiento de un módulo SSO).
 *       Requiere Bearer token de sesión Nexus.
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [accion]
 *             properties:
 *               accion:
 *                 type: string
 *                 example: launch_rcv
 *               producto:
 *                 type: string
 *                 example: rcv
 *               detalle:
 *                 type: object
 *     responses:
 *       200:
 *         description: Acción registrada
 *       401:
 *         description: No autorizado
 */
router.get('/me', authenticate, controller.getMe);
router.get('/products', authenticate, controller.getProducts);

router.post('/audit', authenticate, controller.registerAudit);

/**
 * @openapi
 * /api/portal/audit:
 *   get:
 *     tags:
 *       - Portal
 *     summary: Historial de acciones del portal
 *     description: |
 *       Devuelve las últimas 100 acciones del usuario autenticado en el portal.
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Lista de acciones
 *       401:
 *         description: No autorizado
 */
router.get('/audit', authenticate, controller.getAuditLogs);

router.get('/roles', authenticate, requirePortalAdmin, portalUsers.listRoles);
router.get('/users', authenticate, requirePortalAdmin, portalUsers.listUsers);
router.post(
  '/users',
  authenticate,
  requirePortalAdmin,
  validate(createUserSchema),
  portalUsers.createUser,
);
router.put(
  '/users/:id',
  authenticate,
  requirePortalAdmin,
  validate(updateUserSchema),
  portalUsers.updateUser,
);
router.patch(
  '/users/:id/status',
  authenticate,
  requirePortalAdmin,
  portalUsers.toggleStatus,
);

export default router;
