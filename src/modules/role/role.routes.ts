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
 *     summary: Listar roles de la empresa del token
 *     description: |
 *       Opcionalmente `?empresaId=` debe coincidir con la empresa del JWT; si pide otra empresa, responde 403.
 *     security: [{ apiKeyAuth: [], bearerAuth: [] }]
 *     parameters:
 *       - in: query
 *         name: empresaId
 *         required: false
 *         schema: { type: integer }
 *         description: Debe ser la misma empresa que la del usuario autenticado
 *     responses:
 *       200:
 *         description: Colección de roles
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success: { type: boolean, example: true }
 *                 data:
 *                   type: array
 *                   items:
 *                     type: object
 *                     properties:
 *                       id: { type: integer, example: 2 }
 *                       nombre: { type: string, example: "Administrador" }
 *                       empresaId: { type: integer, example: 1 }
 *                       activo: { type: boolean, example: true }
 *             example:
 *               success: true
 *               data:
 *                 - id: 1
 *                   nombre: "Administrador"
 *                   empresaId: 1
 *                   activo: true
 *                 - id: 2
 *                   nombre: "Docente"
 *                   empresaId: 1
 *                   activo: true
 *       400:
 *         $ref: '#/components/responses/BadRequestError'
 *       403:
 *         $ref: '#/components/responses/ForbiddenError'
 *   post:
 *     tags: [Roles]
 *     summary: Crear rol
 *     description: El rol queda asociado a la empresa del JWT.
 *     security: [{ apiKeyAuth: [], bearerAuth: [] }]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [nombre]
 *             properties:
 *               nombre: { type: string, example: "Coordinador Académico" }
 *           example:
 *             nombre: "Coordinador Académico"
 *     responses:
 *       201:
 *         description: Rol creado
 *         content:
 *           application/json:
 *             example:
 *               success: true
 *               data:
 *                 id: 5
 *                 nombre: "Coordinador Académico"
 *                 empresaId: 1
 *                 activo: true
 *       400:
 *         $ref: '#/components/responses/BadRequestError'
 *       403:
 *         $ref: '#/components/responses/ForbiddenError'
 */
router.get('/', authenticate, controller.list);
router.post('/', authenticate, validate(createRoleSchema), controller.create);

/**
 * @openapi
 * /api/roles/{id}:
 *   put:
 *     tags: [Roles]
 *     summary: Renombrar rol
 *     security: [{ apiKeyAuth: [], bearerAuth: [] }]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: integer, example: 2 }
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [nombre]
 *             properties:
 *               nombre: { type: string, example: "Admin (renombrado)" }
 *           example:
 *             nombre: "Admin (renombrado)"
 *     responses:
 *       200:
 *         description: Rol actualizado
 *         content:
 *           application/json:
 *             example:
 *               success: true
 *               data:
 *                 id: 2
 *                 nombre: "Admin (renombrado)"
 *                 empresaId: 1
 *                 activo: true
 *       400:
 *         $ref: '#/components/responses/BadRequestError'
 *       403:
 *         $ref: '#/components/responses/ForbiddenError'
 *   delete:
 *     tags: [Roles]
 *     summary: Desactivar rol (baja lógica)
 *     description: No elimina filas; pone `activo` en false por integridad referencial.
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: integer, example: 2 }
 *     security: [{ apiKeyAuth: [], bearerAuth: [] }]
 *     responses:
 *       200:
 *         description: Rol desactivado
 *         content:
 *           application/json:
 *             example:
 *               success: true
 *               message: "Rol desactivado correctamente"
 *       400:
 *         $ref: '#/components/responses/BadRequestError'
 *       403:
 *         $ref: '#/components/responses/ForbiddenError'
 */
router.put('/:id', authenticate, validate(createRoleSchema), controller.update);
router.delete('/:id', authenticate, controller.delete);

/**
 * @openapi
 * /api/roles/matrix/{roleId}:
 *   get:
 *     tags: [Roles]
 *     summary: Matriz de permisos para un rol
 *     description: |
 *       Solo considera módulos que la empresa tiene activos en `empresa_modulo`.
 *       Cada fila incluye flags CRUD a nivel módulo y lista de submódulos con sus flags.
 *     security: [{ apiKeyAuth: [], bearerAuth: [] }]
 *     parameters:
 *       - in: path
 *         name: roleId
 *         required: true
 *         schema: { type: integer, example: 2 }
 *     responses:
 *       200:
 *         description: Matriz lista para pintar checkboxes en el front
 *         content:
 *           application/json:
 *             example:
 *               success: true
 *               data:
 *                 - moduloId: 3
 *                   nombre: "Ventas"
 *                   activo: true
 *                   canCreate: true
 *                   canRead: true
 *                   canUpdate: false
 *                   canDelete: false
 *                   submodulos:
 *                     - submoduloId: 10
 *                       nombre: "Cotizaciones"
 *                       activo: true
 *                       canCreate: false
 *                       canRead: true
 *                       canUpdate: false
 *                       canDelete: false
 *       400:
 *         $ref: '#/components/responses/BadRequestError'
 *       403:
 *         $ref: '#/components/responses/ForbiddenError'
 */
router.get('/matrix/:roleId', authenticate, controller.getPermissionMatrix);

/**
 * @openapi
 * /api/roles/permissions:
 *   post:
 *     tags: [Roles]
 *     summary: Reemplazar permisos granulares del rol
 *     description: |
 *       Borra permisos anteriores del rol y vuelve a escribir detalle por módulo y submódulo.
 *       Solo aplica a módulos que la empresa tenga contratados (`empresa_modulo`).
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
 *                   required: [moduloId]
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
 *           example:
 *             roleId: 2
 *             permissions:
 *               - moduloId: 3
 *                 canRead: true
 *                 canCreate: true
 *                 submodulos:
 *                   - submoduloId: 10
 *                     canRead: true
 *     responses:
 *       200:
 *         description: Permisos guardados
 *         content:
 *           application/json:
 *             example:
 *               success: true
 *               message: "Permisos asignados correctamente"
 *               data:
 *                 success: true
 *       400:
 *         $ref: '#/components/responses/BadRequestError'
 *       403:
 *         $ref: '#/components/responses/ForbiddenError'
 */
router.post(
  '/permissions',
  authenticate,
  validate(assignPermissionsSchema),
  controller.assignPermissions,
);

export default router;
