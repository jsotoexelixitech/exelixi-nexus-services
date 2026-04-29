import { Router } from 'express';
import { UserController } from './user.controller';
import { authenticate } from '../../middlewares/auth.middleware';
import { validate } from '../../middlewares/validate.middleware';
import {
  createUserSchema,
  updateUserSchema,
  changePasswordSchema,
} from './user.schema';

const router = Router();
const controller = new UserController();

router.get('/', authenticate, controller.list);
router.post('/', authenticate, validate(createUserSchema), controller.create);
router.put('/:id', authenticate, validate(updateUserSchema), controller.update);
router.patch('/:id/status', authenticate, controller.toggleStatus);
router.post(
  '/change-password',
  authenticate,
  validate(changePasswordSchema),
  controller.changePassword,
);

export default router;
