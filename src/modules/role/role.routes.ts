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
 *             required: [name, companyId]
 *             properties:
 *               name: { type: string }
 *               description: { type: string }
 *               companyId: { type: string }
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
 *         schema: { type: string }
 *     security: [{ apiKeyAuth: [], bearerAuth: [] }]
 *     responses:
 *       200: { description: Actualizado }
 *   delete:
 *     tags: [Roles]
 *     summary: Eliminar rol
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string }
 *     security: [{ apiKeyAuth: [], bearerAuth: [] }]
 *     responses:
 *       200: { description: Eliminado }
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
 *         schema: { type: string }
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
 *               roleId: { type: string }
 *               permissions:
 *                 type: array
 *                 items:
 *                   type: object
 *                   properties:
 *                     moduleId: { type: string }
 *                     action: { type: string, enum: [create, read, update, delete] }
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
