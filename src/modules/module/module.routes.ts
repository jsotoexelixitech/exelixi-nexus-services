import { Router } from 'express';
import { ModuleController } from './module.controller';
import { authenticate } from '../../middlewares/auth.middleware';
import { validate } from '../../middlewares/validate.middleware';
import { createSubmoduleSchema, updateSubmoduleSchema } from './module.schema';

const router = Router();
const controller = new ModuleController();

/**
 * @openapi
 * /api/modules:
 *   get:
 *     tags: [Modules]
 *     summary: Módulos activos de la empresa actual
 *     description: |
 *       Equivalente a `GET /api/modules/active`: lista solo módulos marcados activos en `empresa_modulo`
 *       para la empresa del JWT. Útil para el menú de la aplicación.
 *     security: [{ apiKeyAuth: [], bearerAuth: [] }]
 *     responses:
 *       200:
 *         description: Lista de módulos (sin submódulos anidados en este endpoint)
 *         content:
 *           application/json:
 *             example:
 *               success: true
 *               data:
 *                 - id: 1
 *                   nombre: "Ventas"
 *                   activo: true
 *       400:
 *         $ref: '#/components/responses/BadRequestError'
 *       403:
 *         description: Sin empresa en sesión
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
 *             example:
 *               success: false
 *               message: "Empresa no identificada"
 *   post:
 *     tags: [Modules]
 *     summary: Crear módulo global
 *     description: Alta en catálogo `modulo` (afecta a todas las empresas cuando asignen el módulo).
 *     security: [{ apiKeyAuth: [], bearerAuth: [] }]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [nombre]
 *             properties:
 *               nombre: { type: string, example: "Inventario" }
 *           example:
 *             nombre: "Inventario"
 *     responses:
 *       201:
 *         description: Módulo creado (`activo` true por defecto)
 *         content:
 *           application/json:
 *             example:
 *               success: true
 *               data:
 *                 id: 12
 *                 nombre: "Inventario"
 *                 activo: true
 *       400:
 *         $ref: '#/components/responses/BadRequestError'
 */
router.get('/', authenticate, controller.getActive);

/**
 * @openapi
 * /api/modules/active:
 *   get:
 *     tags: [Modules]
 *     summary: Alias de módulos activos por empresa
 *     description: Misma respuesta que `GET /api/modules`.
 *     security: [{ apiKeyAuth: [], bearerAuth: [] }]
 *     responses:
 *       200:
 *         description: OK
 *         content:
 *           application/json:
 *             example:
 *               success: true
 *               data:
 *                 - id: 1
 *                   nombre: "Ventas"
 *                   activo: true
 *       403:
 *         content:
 *           application/json:
 *             example:
 *               success: false
 *               message: "Empresa no identificada"
 */
router.get('/active', authenticate, controller.getActive);

/**
 * @openapi
 * /api/modules/all:
 *   get:
 *     tags: [Modules]
 *     summary: Catálogo completo de módulos y submódulos
 *     description: Incluye módulos inactivos y todos los submódulos anidados (administración / Swagger).
 *     security: [{ apiKeyAuth: [], bearerAuth: [] }]
 *     responses:
 *       200:
 *         description: Árbol módulo → submódulos
 *         content:
 *           application/json:
 *             example:
 *               success: true
 *               data:
 *                 - id: 1
 *                   nombre: "Ventas"
 *                   activo: true
 *                   submodulos:
 *                     - id: 10
 *                       nombre: "Cotizaciones"
 *                       url: "https://app.example.com/ventas/cotizaciones"
 *                       activo: true
 *                       moduloId: 1
 *       400:
 *         $ref: '#/components/responses/BadRequestError'
 */
router.get('/all', authenticate, controller.listAll);
router.post('/', authenticate, controller.createModule);

/**
 * @openapi
 * /api/modules/{id}:
 *   put:
 *     tags: [Modules]
 *     summary: Actualizar módulo global
 *     security: [{ apiKeyAuth: [], bearerAuth: [] }]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: integer, example: 1 }
 *     requestBody:
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               nombre: { type: string, example: "Ventas y CRM" }
 *               activo: { type: boolean, example: true }
 *           example:
 *             nombre: "Ventas y CRM"
 *             activo: true
 *     responses:
 *       200:
 *         description: Módulo actualizado
 *         content:
 *           application/json:
 *             example:
 *               success: true
 *               data:
 *                 id: 1
 *                 nombre: "Ventas y CRM"
 *                 activo: true
 *       400:
 *         $ref: '#/components/responses/BadRequestError'
 *   delete:
 *     tags: [Modules]
 *     summary: Desactivar módulo global
 *     description: Baja lógica (`activo` false).
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: integer, example: 1 }
 *     security: [{ apiKeyAuth: [], bearerAuth: [] }]
 *     responses:
 *       200:
 *         description: Módulo desactivado
 *         content:
 *           application/json:
 *             example:
 *               success: true
 *               message: "Módulo desactivado correctamente"
 *       400:
 *         $ref: '#/components/responses/BadRequestError'
 */
router.put('/:id', authenticate, controller.updateModule);
router.delete('/:id', authenticate, controller.deleteModule);

/**
 * @openapi
 * /api/modules/submodule:
 *   post:
 *     tags: [Modules]
 *     summary: Crear submódulo bajo un módulo
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
 *               url:
 *                 type: string
 *                 format: uri
 *                 nullable: true
 *                 description: URL opcional (ruta o enlace externo)
 *                 example: "https://app.example.com/ventas/pagos"
 *           example:
 *             moduloId: 1
 *             nombre: "Pagos"
 *             url: "https://app.example.com/ventas/pagos"
 *     responses:
 *       201:
 *         description: Submódulo creado
 *         content:
 *           application/json:
 *             example:
 *               success: true
 *               data:
 *                 id: 20
 *                 nombre: "Pagos"
 *                 url: "https://app.example.com/ventas/pagos"
 *                 activo: true
 *                 moduloId: 1
 *       400:
 *         $ref: '#/components/responses/BadRequestError'
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
 *     description: Debe enviar al menos uno de `nombre`, `activo` o `url`. Cadena vacía o `null` en `url` la borra.
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: integer, example: 10 }
 *     security: [{ apiKeyAuth: [], bearerAuth: [] }]
 *     requestBody:
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               nombre: { type: string, example: "Pagos en línea" }
 *               activo: { type: boolean, example: true }
 *               url:
 *                 type: string
 *                 format: uri
 *                 nullable: true
 *           example:
 *             nombre: "Pagos en línea"
 *             activo: true
 *     responses:
 *       200:
 *         description: Submódulo actualizado
 *         content:
 *           application/json:
 *             example:
 *               success: true
 *               data:
 *                 id: 10
 *                 nombre: "Pagos en línea"
 *                 url: "https://app.example.com/ventas/pagos"
 *                 activo: true
 *                 moduloId: 1
 *       400:
 *         $ref: '#/components/responses/BadRequestError'
 *   delete:
 *     tags: [Modules]
 *     summary: Desactivar submódulo
 *     security: [{ apiKeyAuth: [], bearerAuth: [] }]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: integer, example: 10 }
 *     responses:
 *       200:
 *         description: Submódulo desactivado
 *         content:
 *           application/json:
 *             example:
 *               success: true
 *               message: "Submódulo desactivado correctamente"
 *       400:
 *         $ref: '#/components/responses/BadRequestError'
 */
router.put(
  '/submodule/:id',
  authenticate,
  validate(updateSubmoduleSchema),
  controller.updateSubmodule,
);
router.delete('/submodule/:id', authenticate, controller.deleteSubmodule);

export default router;
