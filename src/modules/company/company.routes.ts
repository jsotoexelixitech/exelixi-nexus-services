import { Router } from 'express';
import { CompanyController } from './company.controller';
import { authenticate } from '../../middlewares/auth.middleware';
import { validate } from '../../middlewares/validate.middleware';
import { createCompanySchema, toggleModuleSchema, createModuleSchema } from './company.schema';

const router = Router();
const controller = new CompanyController();

// Estas rutas deberían estar protegidas por un middleware de "checkSuperAdmin"
// Por simplicidad para el demo, usamos solo authenticate
router.post('/', authenticate, validate(createCompanySchema), controller.create);
router.get('/', authenticate, controller.list);
router.post('/toggle-module', authenticate, validate(toggleModuleSchema), controller.toggleModule);
router.post('/modules', authenticate, validate(createModuleSchema), controller.createModule);

export default router;
