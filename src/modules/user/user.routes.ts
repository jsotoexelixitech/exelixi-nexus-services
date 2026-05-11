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
 *     summary: Listar usuarios de la empresa actual
 *     description: |
 *       Paginación opcional con `page` y `limit`. Los usuarios pertenecen a la empresa del JWT (no se envía empresaId).
 *     security:
 *       - apiKeyAuth: []
 *       - bearerAuth: []
 *     parameters:
 *       - in: query
 *         name: page
 *         schema: { type: integer, minimum: 1, default: 1 }
 *         description: Número de página (base 1)
 *       - in: query
 *         name: limit
 *         schema: { type: integer, minimum: 1, default: 10 }
 *         description: Tamaño de página
 *     responses:
 *       200:
 *         description: Listado paginado
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 total: { type: integer, example: 42 }
 *                 page: { type: integer, example: 1 }
 *                 limit: { type: integer, example: 10 }
 *                 users:
 *                   type: array
 *                   items:
 *                     type: object
 *                     properties:
 *                       id: { type: integer, example: 5 }
 *                       nombre: { type: string, example: "María Pérez" }
 *                       email: { type: string, example: "maria@empresa.com" }
 *                       role: { type: string, example: "Docente" }
 *                       activo: { type: boolean, example: true }
 *             example:
 *               total: 2
 *               page: 1
 *               limit: 10
 *               users:
 *                 - id: 1
 *                   nombre: "María Pérez"
 *                   email: "maria@empresa.com"
 *                   role: "Administrador"
 *                   activo: true
 *       400:
 *         $ref: '#/components/responses/BadRequestError'
 *       403:
 *         description: Sin empresa en el token o sin permiso
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/MessageError'
 *             example:
 *               message: "Empresa no identificada"
 *   post:
 *     tags:
 *       - Users
 *     summary: Crear usuario
 *     description: |
 *       Si **no** envía `password`, el sistema genera una contraseña temporal y la devuelve en `temporaryPassword` (solo en esta respuesta).
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
 *               email: { type: string, format: email, example: "nuevo@empresa.com" }
 *               password:
 *                 type: string
 *                 minLength: 6
 *                 nullable: true
 *                 description: Opcional. Si se omite, se genera contraseña temporal.
 *               roleId: { type: integer, example: 2 }
 *     responses:
 *       201:
 *         description: Usuario creado (cuerpo plano, sin wrapper `success`)
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 id: { type: integer, example: 15 }
 *                 nombre: { type: string }
 *                 email: { type: string, format: email }
 *                 roleId: { type: integer, example: 2 }
 *                 temporaryPassword:
 *                   type: string
 *                   nullable: true
 *                   description: Solo presente si no envió password en el alta
 *                   example: "Kx9mP2qR7n"
 *             examples:
 *               withTempPassword:
 *                 summary: Alta sin password (temporal generada)
 *                 value:
 *                   id: 15
 *                   nombre: "María Pérez"
 *                   email: "nuevo@empresa.com"
 *                   roleId: 2
 *                   temporaryPassword: "Kx9mP2qR7n"
 *               withChosenPassword:
 *                 summary: Alta con password definido por admin
 *                 value:
 *                   id: 16
 *                   nombre: "Pedro López"
 *                   email: "pedro@empresa.com"
 *                   roleId: 3
 *                   temporaryPassword: null
 *       400:
 *         $ref: '#/components/responses/BadRequestError'
 *       403:
 *         description: Empresa no identificada en sesión
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/MessageError'
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
 *     description: Actualiza datos del usuario si pertenece a la misma empresa que el token.
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: integer, example: 1 }
 *     security:
 *       - apiKeyAuth: []
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               nombre: { type: string, minLength: 3, example: "María Pérez García" }
 *               email: { type: string, format: email }
 *               password: { type: string, minLength: 6, description: "Nueva contraseña (hasheada en servidor)" }
 *               roleId: { type: integer, example: 2 }
 *               activo: { type: boolean, example: true }
 *           example:
 *             nombre: "María Pérez García"
 *             activo: true
 *     responses:
 *       200:
 *         description: Registro actualizado (objeto usuario Prisma; no incluya el hash en clientes)
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               description: Modelo usuario persistido
 *             example:
 *               id: 1
 *               nombre: "María Pérez García"
 *               email: "maria@empresa.com"
 *               empresaId: 2
 *               roleId: 2
 *               activo: true
 *       400:
 *         $ref: '#/components/responses/BadRequestError'
 *       403:
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/MessageError'
 */
router.put('/:id', authenticate, validate(updateUserSchema), controller.update);

/**
 * @openapi
 * /api/users/{id}/status:
 *   patch:
 *     tags:
 *       - Users
 *     summary: Alternar activo/inactivo del usuario
 *     description: Invierte el flag `activo` del usuario en la empresa del token.
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
 *         description: Estado invertido
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 message: { type: string, example: "Estado del usuario actualizado" }
 *                 active: { type: boolean, example: false }
 *             example:
 *               message: "Estado del usuario actualizado"
 *               active: false
 *       400:
 *         $ref: '#/components/responses/BadRequestError'
 *       403:
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/MessageError'
 */
router.patch('/:id/status', authenticate, controller.toggleStatus);

/**
 * @openapi
 * /api/users/change-password:
 *   post:
 *     tags:
 *       - Users
 *     summary: Cambiar contraseña del usuario autenticado
 *     description: |
 *       **No** recibe ID de usuario: el cambio aplica al usuario del JWT (`req.user`).
 *       Debe enviar la contraseña actual correcta.
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
 *               currentPassword:
 *                 type: string
 *                 example: "MiClaveActual1"
 *               newPassword:
 *                 type: string
 *                 minLength: 6
 *                 example: "NuevaClaveSegura2"
 *     responses:
 *       200:
 *         description: Contraseña actualizada
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 message: { type: string, example: "Contraseña actualizada correctamente" }
 *             example:
 *               message: "Contraseña actualizada correctamente"
 *       400:
 *         $ref: '#/components/responses/BadRequestError'
 *       403:
 *         description: Sesión incompleta (sin empresa o usuario en token)
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/MessageError'
 *             example:
 *               message: "Sesión no válida"
 */
router.post(
  '/change-password',
  authenticate,
  validate(changePasswordSchema),
  controller.changePassword,
);

export default router;
