import { Request, Response } from 'express';
import { AuthService } from './auth.service';
import { AuthRequest } from '../../middlewares/auth.middleware';

const authService = new AuthService();

export class AuthController {
  async login(req: Request, res: Response) {
    try {
      const { email, password } = req.body;
      const result = await authService.login(email, password);
      res.json(result);
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : 'Error de autenticación';
      res.status(401).json({ message });
    }
  }

  async me(req: AuthRequest, res: Response) {
    // Retorna el usuario actual del token (ya validado por middleware)
    res.json(req.user);
  }
}
