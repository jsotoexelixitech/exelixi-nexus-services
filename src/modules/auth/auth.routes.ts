import { Router } from 'express';
import { AuthController } from './auth.controller';
import { authenticate } from '../../middlewares/auth.middleware';
import { validate } from '../../middlewares/validate.middleware';
import { loginSchema } from './auth.schema';

const router = Router();
const controller = new AuthController();

/**
 * @route POST /api/auth/login
 * @desc Iniciar sesión y obtener token
 */
router.post('/login', validate(loginSchema), controller.login);

/**
 * @route GET /api/auth/me
 * @desc Obtener perfil del usuario actual
 */
router.get('/me', authenticate, controller.me);

export default router;
