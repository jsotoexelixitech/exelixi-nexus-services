import { Router } from 'express';
import { authenticate } from '../../middlewares/auth.middleware';
import { PortalController } from './portal.controller';

const router = Router();
const controller = new PortalController();

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

export default router;
