import { Router } from 'express';
import { CompanyController } from './company.controller';
import { authenticate } from '../../middlewares/auth.middleware';
import { validate } from '../../middlewares/validate.middleware';
import { createCompanySchema, updateCompanySchema, toggleModuleSchema } from './company.schema';

const router = Router();
const controller = new CompanyController();

// Todas las rutas de empresas requieren autenticación
router.use(authenticate);

router.get('/', controller.list);
router.get('/:id', controller.getById);
router.post('/', validate(createCompanySchema), controller.create);
router.put('/:id', validate(updateCompanySchema), controller.update);
router.delete('/:id', controller.delete);

// Gestión de módulos por empresa
router.post('/toggle-module', validate(toggleModuleSchema), controller.toggleModule);

export default router;
