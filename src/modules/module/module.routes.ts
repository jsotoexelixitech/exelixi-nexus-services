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

export default router;
