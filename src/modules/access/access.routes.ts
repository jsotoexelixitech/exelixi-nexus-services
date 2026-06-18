import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { AccessController } from './access.controller';

/**
 * @swagger
 * tags:
 *   name: Access
 *   description: Verificación de acceso para servicios externos (submódulos)
 */

const router = Router();
const controller = new AccessController();

/**
 * Rate limit dedicado para este endpoint público.
 * Más permisivo que el global porque los submódulos lo llaman en cada carga.
 */
const accessLimiter = rateLimit({
  windowMs: 1 * 60 * 1000, // 1 minuto
  max: 120,
  message: {
    success: false,
    active: false,
    message: 'Demasiadas solicitudes de verificación. Intente en un momento.',
  },
  standardHeaders: true,
  legacyHeaders: false,
});

/**
 * @swagger
 * /api/access/verify:
 *   get:
 *     summary: Verifica si un tenant token es válido y el servicio está activo
 *     tags: [Access]
 *     description: >
 *       Endpoint público (sin x-api-key). El submódulo lo llama al iniciar
 *       enviando su nexus_token como Bearer. Retorna active:true/false y
 *       datos de empresa/submódulo si está activo.
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Resultado de verificación
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success: { type: boolean }
 *                 active:  { type: boolean }
 *                 empresa:
 *                   type: object
 *                   properties:
 *                     id:     { type: integer }
 *                     nombre: { type: string }
 *                     rif:    { type: string }
 *                 submodulo:
 *                   type: object
 *                   properties:
 *                     id:        { type: integer }
 *                     nombre:    { type: string }
 *                     url:       { type: string }
 *                     accessUrl: { type: string }
 *       401:
 *         description: Token ausente, inválido o manipulado
 */
router.get('/verify', accessLimiter, (req, res) => controller.verify(req, res));

/**
 * @swagger
 * /api/access/heartbeat:
 *   post:
 *     summary: Renovar ventana de acceso activo (heartbeat)
 *     tags: [Access]
 *     description: >
 *       Llamado por el backend de cada módulo en cada petición del usuario.
 *       Verifica que empresa y módulo sigan activos y renueva tokenExpiresAt +8h en BD.
 *       Si empresa.activo=true el token SIEMPRE se renueva — ningún flujo activo se corta.
 *       Si empresa.activo=false responde 403 inmediatamente.
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Token renovado, acceso activo
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success: { type: boolean, example: true }
 *                 active:  { type: boolean, example: true }
 *       401:
 *         description: Token inválido o manipulado
 *       403:
 *         description: Empresa o módulo inactivo
 */
router.post('/heartbeat', accessLimiter, (req, res) =>
  controller.heartbeat(req, res),
);

export default router;
