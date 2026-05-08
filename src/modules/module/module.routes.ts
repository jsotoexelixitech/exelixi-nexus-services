import { Router } from 'express';
import { ModuleController } from './module.controller';
import { authenticate } from '../../middlewares/auth.middleware';
import { validate } from '../../middlewares/validate.middleware';
import { createSubmoduleSchema } from './module.schema';

const router = Router();
const controller = new ModuleController();

// Módulos
/**
 * @openapi
 * /api/modules:
 *   get:
 *     tags: [Modules]
 *     summary: Listar módulos activos
 *     security: [{ apiKeyAuth: [], bearerAuth: [] }]
 *     responses:
 *       200: { description: OK }
 *   post:
 *     tags: [Modules]
 *     summary: Crear nuevo módulo
 *     security: [{ apiKeyAuth: [], bearerAuth: [] }]
 *     responses:
 *       201: { description: Creado }
 */
router.get('/', authenticate, controller.getActive);
router.get('/active', authenticate, controller.getActive);

/**
 * @openapi
 * /api/modules/all:
 *   get:
 *     tags: [Modules]
 *     summary: Listar todos los módulos (incluyendo inactivos)
 *     security: [{ apiKeyAuth: [], bearerAuth: [] }]
 *     responses:
 *       200: { description: OK }
 */
router.get('/all', authenticate, controller.listAll);
router.post('/', authenticate, controller.createModule);

/**
 * @openapi
 * /api/modules/{id}:
 *   put:
 *     tags: [Modules]
 *     summary: Actualizar módulo
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: integer, example: 1 }
 *     security: [{ apiKeyAuth: [], bearerAuth: [] }]
 *     responses:
 *       200: { description: OK }
 *   delete:
 *     tags: [Modules]
 *     summary: Eliminar módulo
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: integer, example: 1 }
 *     security: [{ apiKeyAuth: [], bearerAuth: [] }]
 *     responses:
 *       200: { description: OK }
 */
router.put('/:id', authenticate, controller.updateModule);
router.delete('/:id', authenticate, controller.deleteModule);

/**
 * @openapi
 * /api/modules/submodule:
 *   post:
 *     tags: [Modules]
 *     summary: Crear submódulo
 *     security: [{ apiKeyAuth: [], bearerAuth: [] }]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [moduloId, nombre]
 *             properties:
 *               moduloId: { type: number, example: 1 }
 *               nombre: { type: string, example: "Pagos" }
 *     responses:
 *       201: { description: Creado }
 */
router.post(
  '/submodule',
  authenticate,
  validate(createSubmoduleSchema),
  controller.createSubmodule,
);

/**
 * @openapi
 * /api/modules/submodule/{id}:
 *   put:
 *     tags: [Modules]
 *     summary: Actualizar submódulo
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: integer, example: 10 }
 *     security: [{ apiKeyAuth: [], bearerAuth: [] }]
 *     responses:
 *       200: { description: OK }
 *   delete:
 *     tags: [Modules]
 *     summary: Desactivar submódulo
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: integer, example: 10 }
 *     security: [{ apiKeyAuth: [], bearerAuth: [] }]
 *     responses:
 *       200: { description: OK }
 */
router.put('/submodule/:id', authenticate, controller.updateSubmodule);
router.delete('/submodule/:id', authenticate, controller.deleteSubmodule);

export default router;
