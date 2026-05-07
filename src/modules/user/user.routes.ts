import { Router } from 'express';
import { UserController } from './user.controller';
import { authenticate } from '../../middlewares/auth.middleware';
import { validate } from '../../middlewares/validate.middleware';
import {
  createUserSchema,
  updateUserSchema,
  changePasswordSchema,
} from './user.schema';

const router = Router();
const controller = new UserController();

/**
 * @openapi
 * /api/users:
 *   get:
 *     tags:
 *       - Users
 *     summary: Listar usuarios
 *     security:
 *       - apiKeyAuth: []
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Lista de usuarios obtenida exitosamente
 *   post:
 *     tags:
 *       - Users
 *     summary: Crear nuevo usuario
 *     security:
 *       - apiKeyAuth: []
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [nombre, email, roleId]
 *             properties:
 *               nombre: { type: string, example: "María Pérez" }
 *               email: { type: string, format: email }
 *               password:
 *                 type: string
 *                 minLength: 6
 *                 nullable: true
 *                 description: Si no se envía, el backend genera una contraseña temporal y la devuelve en la respuesta.
 *               roleId: { type: number, example: 2 }
 *     responses:
 *       201:
 *         description: Usuario creado
 */
router.get('/', authenticate, controller.list);
router.post('/', authenticate, validate(createUserSchema), controller.create);

/**
 * @openapi
 * /api/users/{id}:
 *   put:
 *     tags:
 *       - Users
 *     summary: Actualizar usuario
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: integer, example: 1 }
 *     security:
 *       - apiKeyAuth: []
 *       - bearerAuth: []
 *     requestBody:
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *     responses:
 *       200:
 *         description: Usuario actualizado
 */
router.put('/:id', authenticate, validate(updateUserSchema), controller.update);

/**
 * @openapi
 * /api/users/{id}/status:
 *   patch:
 *     tags:
 *       - Users
 *     summary: Alternar estado del usuario
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: integer, example: 1 }
 *     security:
 *       - apiKeyAuth: []
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Estado actualizado
 */
router.patch('/:id/status', authenticate, controller.toggleStatus);

/**
 * @openapi
 * /api/users/change-password:
 *   post:
 *     tags:
 *       - Users
 *     summary: Cambiar contraseña
 *     security:
 *       - apiKeyAuth: []
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [currentPassword, newPassword]
 *             properties:
 *               currentPassword: { type: string }
 *               newPassword: { type: string, minLength: 6 }
 *     responses:
 *       200:
 *         description: Contraseña cambiada
 */
router.post(
  '/change-password',
  authenticate,
  validate(changePasswordSchema),
  controller.changePassword,
);

export default router;
