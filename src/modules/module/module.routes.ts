import { Router } from 'express';
import { ModuleController } from './module.controller';
import { authenticate } from '../../middlewares/auth.middleware';
import { validate } from '../../middlewares/validate.middleware';
import { createSubmoduleSchema } from './module.schema';

const router = Router();
const controller = new ModuleController();

/**
 * @route GET /api/modules/active
 * @desc Obtener módulos activos para la empresa actual
 */
router.get('/active', authenticate, controller.getActive);

/**
 * @route GET /api/modules/all
 * @desc Listar todos los módulos y sus submódulos
 */
router.get('/all', authenticate, controller.listAll);

/**
 * @route POST /api/modules/submodule
 * @desc Crear un nuevo submódulo
 */
router.post('/submodule', authenticate, validate(createSubmoduleSchema), controller.createSubmodule);

export default router;
