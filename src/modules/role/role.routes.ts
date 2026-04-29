import { Router } from 'express';
import { RoleController } from './role.controller';
import { authenticate } from '../../middlewares/auth.middleware';
import { validate } from '../../middlewares/validate.middleware';
import { createRoleSchema, assignPermissionsSchema } from './role.schema';

const router = Router();
const controller = new RoleController();

router.get('/', authenticate, controller.list);
router.post('/', authenticate, validate(createRoleSchema), controller.create);
router.put('/:id', authenticate, validate(createRoleSchema), controller.update);
router.delete('/:id', authenticate, controller.delete);
router.get('/matrix/:roleId', authenticate, controller.getPermissionMatrix);
router.post(
  '/permissions',
  authenticate,
  validate(assignPermissionsSchema),
  controller.assignPermissions,
);

export default router;
