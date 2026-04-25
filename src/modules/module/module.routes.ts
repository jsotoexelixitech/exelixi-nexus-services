import { Router } from 'express';
import { ModuleController } from './module.controller';
import { authenticate } from '../../middlewares/auth.middleware';
import { validate } from '../../middlewares/validate.middleware';
import { createSubmoduleSchema } from './module.schema';

const router = Router();
const controller = new ModuleController();

// Módulos
router.get('/active', authenticate, controller.getActive);
router.get('/all', authenticate, controller.listAll);
router.post('/', authenticate, controller.createModule);
router.put('/:id', authenticate, controller.updateModule);
router.delete('/:id', authenticate, controller.deleteModule);

// Submódulos
router.post('/submodule', authenticate, validate(createSubmoduleSchema), controller.createSubmodule);
router.put('/submodule/:id', authenticate, controller.updateSubmodule);
router.delete('/submodule/:id', authenticate, controller.deleteSubmodule);

export default router;
