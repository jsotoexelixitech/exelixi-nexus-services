import { Router } from 'express';
import { authenticate } from '../../middlewares/auth.middleware';
import { validate } from '../../middlewares/validate.middleware';
import { PortalController } from './portal.controller';
import { PortalUsersController } from './portal-users.controller';
import { requirePortalAdmin } from './portal-admin.middleware';
import { createUserSchema, updateUserSchema } from '../user/user.schema';

const router = Router();
const controller = new PortalController();
const portalUsers = new PortalUsersController();

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
