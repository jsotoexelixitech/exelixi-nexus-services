import { Router } from 'express';
import { CompanyController } from './company.controller';
import { authenticate } from '../../middlewares/auth.middleware';
import { validate } from '../../middlewares/validate.middleware';
import {
  createCompanySchema,
  updateCompanySchema,
  toggleModuleSchema,
} from './company.schema';

const router = Router();
const controller = new CompanyController();

// Todas las rutas de empresas requieren autenticación
router.use(authenticate);

/**
 * @openapi
 * /api/companies:
 *   get:
 *     tags: [Companies]
 *     summary: Listar todas las empresas
 *     security: [{ apiKeyAuth: [], bearerAuth: [] }]
 *     responses:
 *       200: { description: OK }
 *   post:
 *     tags: [Companies]
 *     summary: Crear una nueva empresa
 *     security: [{ apiKeyAuth: [], bearerAuth: [] }]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [name, slug]
 *             properties:
 *               name: { type: string }
 *               slug: { type: string }
 *     responses:
 *       201: { description: Creado }
 */
router.get('/', controller.list);
router.post('/', validate(createCompanySchema), controller.create);

/**
 * @openapi
 * /api/companies/{id}:
 *   get:
 *     tags: [Companies]
 *     summary: Obtener empresa por ID
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string }
 *     security: [{ apiKeyAuth: [], bearerAuth: [] }]
 *     responses:
 *       200: { description: OK }
 *   put:
 *     tags: [Companies]
 *     summary: Actualizar empresa
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string }
 *     security: [{ apiKeyAuth: [], bearerAuth: [] }]
 *     requestBody:
 *       content:
 *         application/json:
 *           schema: { type: object }
 *     responses:
 *       200: { description: Actualizado }
 *   delete:
 *     tags: [Companies]
 *     summary: Eliminar empresa
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string }
 *     security: [{ apiKeyAuth: [], bearerAuth: [] }]
 *     responses:
 *       200: { description: Eliminado }
 */
router.get('/:id', controller.getById);
router.put('/:id', validate(updateCompanySchema), controller.update);
router.delete('/:id', controller.delete);

/**
 * @openapi
 * /api/companies/toggle-module:
 *   post:
 *     tags: [Companies]
 *     summary: Activar/Desactivar módulo para empresa
 *     security: [{ apiKeyAuth: [], bearerAuth: [] }]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [companyId, moduleId, active]
 *             properties:
 *               companyId: { type: string }
 *               moduleId: { type: string }
 *               active: { type: boolean }
 *     responses:
 *       200: { description: Estado del módulo actualizado }
 */
router.post(
  '/toggle-module',
  validate(toggleModuleSchema),
  controller.toggleModule,
);

export default router;
