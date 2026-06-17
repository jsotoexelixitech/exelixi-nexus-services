import { Router } from 'express';
import { CompanyController } from './company.controller';
import { authenticate } from '../../middlewares/auth.middleware';
import { validate } from '../../middlewares/validate.middleware';
import {
  createCompanySchema,
  updateCompanySchema,
  toggleModuleSchema,
  toggleSubmoduleSchema,
} from './company.schema';

const router = Router();
const controller = new CompanyController();

router.use(authenticate);

/**
 * @openapi
 * /api/companies:
 *   get:
 *     tags: [Companies]
 *     summary: Listar empresas
 *     description: Devuelve todas las empresas registradas (uso típico administración SaaS).
 *     security: [{ apiKeyAuth: [], bearerAuth: [] }]
 *     responses:
 *       200:
 *         description: Lista obtenida correctamente
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ApiSuccessWithData'
 *             example:
 *               success: true
 *               data:
 *                 - id: 1
 *                   nombre: "Colegio San Martín"
 *                   rif: "J-12345678-9"
 *                   tipo: "Colegio"
 *                   activo: true
 *                 - id: 2
 *                   nombre: "Otra Empresa"
 *                   rif: "J-87654321-0"
 *                   tipo: "SaaS"
 *                   activo: true
 *       500:
 *         description: Error interno
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
 *   post:
 *     tags: [Companies]
 *     summary: Crear empresa
 *     description: Solo **nombre** es obligatorio por validación; `rif` y `tipo` son opcionales.
 *     security: [{ apiKeyAuth: [], bearerAuth: [] }]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [nombre]
 *             properties:
 *               nombre: { type: string, minLength: 3, example: "Colegio San Martín" }
 *               rif: { type: string, example: "J-12345678-9" }
 *               tipo: { type: string, example: "Colegio" }
 *           example:
 *             nombre: "Colegio San Martín"
 *             rif: "J-12345678-9"
 *             tipo: "Colegio"
 *     responses:
 *       201:
 *         description: Empresa persistida
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success: { type: boolean, example: true }
 *                 message: { type: string }
 *                 data: { type: object }
 *             example:
 *               success: true
 *               message: "Empresa creada exitosamente"
 *               data:
 *                 id: 32
 *                 nombre: "Colegio San Martín"
 *                 rif: "J-12345678-9"
 *                 tipo: "Colegio"
 *                 activo: true
 *       400:
 *         $ref: '#/components/responses/BadRequestError'
 */
router.get('/', controller.list);
router.post('/', validate(createCompanySchema), controller.create);

/**
 * @openapi
 * /api/companies/{id}:
 *   get:
 *     tags: [Companies]
 *     summary: Detalle de empresa con módulos y submódulos
 *     description: |
 *       Incluye `modulos` como lista de relaciones empresa–módulo mezcladas con el catálogo:
 *       cada ítem trae `activo`, `modulo` anidado y en `modulo.submodulos` el flag **`activoEmpresa`**
 *       según la tabla empresa–submódulo.
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: integer, example: 1 }
 *     security: [{ apiKeyAuth: [], bearerAuth: [] }]
 *     responses:
 *       200:
 *         description: Empresa encontrada
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success: { type: boolean, example: true }
 *                 data:
 *                   type: object
 *                   properties:
 *                     id: { type: integer }
 *                     rif: { type: string }
 *                     nombre: { type: string }
 *                     activo: { type: boolean }
 *                     tipo: { type: string }
 *                     createdAt: { type: string, nullable: true }
 *                     modulos:
 *                       type: array
 *                       items:
 *                         type: object
 *                         properties:
 *                           id: { type: integer, nullable: true }
 *                           empresaId: { type: integer }
 *                           moduloId: { type: integer }
 *                           token: { type: string, nullable: true }
 *                           activo: { type: boolean }
 *                           modulo:
 *                             type: object
 *                             properties:
 *                               id: { type: integer }
 *                               nombre: { type: string }
 *                               submodulos:
 *                                 type: array
 *                                 items:
 *                                   type: object
 *                                   properties:
 *                                     id: { type: integer }
 *                                     nombre: { type: string }
 *                                     url: { type: string, nullable: true }
 *                                     activo: { type: boolean }
 *                                     activoEmpresa: { type: boolean }
 *       404:
 *         description: Empresa no encontrada
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
 *             example:
 *               success: false
 *               message: "Empresa no encontrada"
 *       500:
 *         description: Error interno
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
 *   put:
 *     tags: [Companies]
 *     summary: Actualizar empresa
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
 *               nombre: { type: string, minLength: 3 }
 *               rif: { type: string }
 *               tipo: { type: string }
 *               activo: { type: boolean }
 *           example:
 *             nombre: "Colegio San Martín Actualizado"
 *             activo: true
 *     responses:
 *       200:
 *         description: Cambios guardados
 *         content:
 *           application/json:
 *             example:
 *               success: true
 *               message: "Empresa actualizada exitosamente"
 *               data:
 *                 id: 1
 *                 nombre: "Colegio San Martín Actualizado"
 *                 rif: "J-12345678-9"
 *                 activo: true
 *       400:
 *         $ref: '#/components/responses/BadRequestError'
 *   delete:
 *     tags: [Companies]
 *     summary: Desactivar empresa
 *     description: Baja lógica (`activo` false), no borrado físico.
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: integer, example: 1 }
 *     security: [{ apiKeyAuth: [], bearerAuth: [] }]
 *     responses:
 *       200:
 *         description: Empresa desactivada
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ApiSuccessWithMessage'
 *             example:
 *               success: true
 *               message: "Empresa desactivada exitosamente"
 *       400:
 *         $ref: '#/components/responses/BadRequestError'
 */
router.get('/:id', controller.getById);
router.put('/:id', validate(updateCompanySchema), controller.update);
router.delete('/:id', controller.delete);

/**
 * @openapi
 * /api/companies/toggle-module:
 *   post:
 *     tags: [Companies]
 *     summary: Activar o desactivar un módulo para una empresa
 *     description: |
 *       Si no existía relación `empresa_modulo`, se crea con un `token` generado.
 *       Si ya existía, solo actualiza `activo`.
 *     security: [{ apiKeyAuth: [], bearerAuth: [] }]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [empresaId, moduloId, active]
 *             properties:
 *               empresaId: { type: number, example: 1 }
 *               moduloId: { type: number, example: 3 }
 *               active: { type: boolean, example: true }
 *           example:
 *             empresaId: 1
 *             moduloId: 3
 *             active: true
 *     responses:
 *       200:
 *         description: Registro empresa–módulo actualizado o creado
 *         content:
 *           application/json:
 *             example:
 *               success: true
 *               message: "Módulo activado exitosamente"
 *               data:
 *                 id: 79
 *                 empresaId: 1
 *                 moduloId: 3
 *                 activo: true
 *                 token: "token-1-3"
 *       400:
 *         $ref: '#/components/responses/BadRequestError'
 */
router.post(
  '/toggle-module',
  validate(toggleModuleSchema),
  controller.toggleModule,
);

/**
 * @openapi
 * /api/companies/toggle-submodule:
 *   post:
 *     tags: [Companies]
 *     summary: Activar o desactivar un submódulo para una empresa
 *     description: |
 *       Requiere modelo `EmpresaSubmodulo` en base de datos. Si el despliegue no aplicó migraciones,
 *       puede responder error indicando que la funcionalidad no está disponible.
 *     security: [{ apiKeyAuth: [], bearerAuth: [] }]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [empresaId, submoduloId, active]
 *             properties:
 *               empresaId: { type: number, example: 1 }
 *               submoduloId: { type: number, example: 99 }
 *               active: { type: boolean, example: false }
 *           example:
 *             empresaId: 1
 *             submoduloId: 99
 *             active: false
 *     responses:
 *       200:
 *         description: Relación empresa–submódulo actualizada o creada
 *         content:
 *           application/json:
 *             example:
 *               success: true
 *               message: "Submódulo desactivado exitosamente"
 *               data:
 *                 id: 12
 *                 empresaId: 1
 *                 submoduloId: 99
 *                 activo: false
 *       400:
 *         $ref: '#/components/responses/BadRequestError'
 */
router.post(
  '/toggle-submodule',
  validate(toggleSubmoduleSchema),
  controller.toggleSubmodule,
);

/**
 * @openapi
 * /api/companies/{id}/generate-api-key:
 *   post:
 *     tags: [Companies]
 *     summary: Regenerar o crear API Key para una empresa
 *     description: Solo accesible por administradores. Devuelve una llave segura de 64 caracteres hex.
 *     security: [{ apiKeyAuth: [], bearerAuth: [] }]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: integer, example: 1 }
 *     responses:
 *       200:
 *         description: API Key generada
 *         content:
 *           application/json:
 *             example:
 *               success: true
 *               message: "API Key generada exitosamente"
 *               apiKey: "abcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890"
 *               data: { id: 1, apiKey: "..." }
 *       400:
 *         $ref: '#/components/responses/BadRequestError'
 */
router.post('/:id/generate-api-key', controller.generateApiKey);

export default router;
