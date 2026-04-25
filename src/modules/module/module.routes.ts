import { Router } from 'express';
import { ModuleController } from './module.controller';
import { authenticate } from '../../middlewares/auth.middleware';

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
router.post('/submodule', authenticate, controller.createSubmodule);

export default router;
