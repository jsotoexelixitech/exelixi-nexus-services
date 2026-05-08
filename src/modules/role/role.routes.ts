import { Router } from 'express';
import { RoleController } from './role.controller';
import { authenticate } from '../../middlewares/auth.middleware';
import { validate } from '../../middlewares/validate.middleware';
import { createRoleSchema, assignPermissionsSchema } from './role.schema';

const router = Router();
const controller = new RoleController();

/**
 * @openapi
 * /api/roles:
 *   get:
 *     tags: [Roles]
 *     summary: Listar roles
 *     security: [{ apiKeyAuth: [], bearerAuth: [] }]
 *     responses:
 *       200: { description: OK }
 *   post:
 *     tags: [Roles]
 *     summary: Crear rol
 *     security: [{ apiKeyAuth: [], bearerAuth: [] }]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [nombre]
 *             properties:
 *               nombre: { type: string, example: "Admin" }
 *     responses:
 *       201: { description: Creado }
 */
router.get('/', authenticate, controller.list);
router.post('/', authenticate, validate(createRoleSchema), controller.create);

/**
 * @openapi
 * /api/roles/{id}:
 *   put:
 *     tags: [Roles]
 *     summary: Actualizar rol
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: integer, example: 2 }
 *     security: [{ apiKeyAuth: [], bearerAuth: [] }]
 *     responses:
 *       200: { description: Actualizado }
 *   delete:
 *     tags: [Roles]
 *     summary: Desactivar rol
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: integer, example: 2 }
 *     security: [{ apiKeyAuth: [], bearerAuth: [] }]
 *     responses:
 *       200: { description: Desactivado }
 */
router.put('/:id', authenticate, validate(createRoleSchema), controller.update);
router.delete('/:id', authenticate, controller.delete);

/**
 * @openapi
 * /api/roles/matrix/{roleId}:
 *   get:
 *     tags: [Roles]
 *     summary: Obtener matriz de permisos para un rol
 *     parameters:
 *       - in: path
 *         name: roleId
 *         required: true
 *         schema: { type: integer, example: 2 }
 *     security: [{ apiKeyAuth: [], bearerAuth: [] }]
 *     responses:
 *       200: { description: OK }
 */
router.get('/matrix/:roleId', authenticate, controller.getPermissionMatrix);

/**
 * @openapi
 * /api/roles/permissions:
 *   post:
 *     tags: [Roles]
 *     summary: Asignar permisos a rol
 *     security: [{ apiKeyAuth: [], bearerAuth: [] }]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [roleId, permissions]
 *             properties:
 *               roleId: { type: number, example: 2 }
 *               permissions:
 *                 type: array
 *                 items:
 *                   type: object
 *                   properties:
 *                     moduloId: { type: number, example: 3 }
 *                     canCreate: { type: boolean, example: true }
 *                     canRead: { type: boolean, example: true }
 *                     canUpdate: { type: boolean, example: false }
 *                     canDelete: { type: boolean, example: false }
 *                     submodulos:
 *                       type: array
 *                       items:
 *                         type: object
 *                         properties:
 *                           submoduloId: { type: number, example: 10 }
 *                           canCreate: { type: boolean, example: true }
 *                           canRead: { type: boolean, example: true }
 *                           canUpdate: { type: boolean, example: false }
 *                           canDelete: { type: boolean, example: false }
 *     responses:
 *       200: { description: Permisos asignados }
 */
router.post(
  '/permissions',
  authenticate,
  validate(assignPermissionsSchema),
  controller.assignPermissions,
);

export default router;
