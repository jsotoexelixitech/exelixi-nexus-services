import { Request, Response } from 'express';
import * as jwt from 'jsonwebtoken';
import prisma from '../../config/prisma';
import { AuthService } from './auth.service';
import { AuthRequest } from '../../middlewares/auth.middleware';
import { AppError } from '../../utils/app-error';
import { getErrorMessage } from '../../utils/error-handler';

const authService = new AuthService();

export class AuthController {
  async login(req: Request, res: Response) {
    try {
      const { email, password } = req.body;
      const result = await authService.login(email, password);
      res.json(result);
    } catch (error: unknown) {
      res.status(401).json({ success: false, message: getErrorMessage(error) });
    }
  }

  async me(req: AuthRequest, res: Response) {
    try {
      const userId = req.user?.id;
      if (!userId) throw new AppError('No autenticado', 401);

      const profile = await authService.getUserProfile(userId);
      res.json({
        success: true,
        data: profile,
      });
    } catch (error: unknown) {
      res.status(500).json({ success: false, message: getErrorMessage(error) });
    }
  }

  async ssoDelegate(req: Request, res: Response) {
    try {
      const { correo, metadata } = req.body;
      const apiKey = req.headers['x-api-key'];

      // Basic validation
      if (!correo || !metadata || !apiKey) {
        return res.status(400).json({
          success: false,
          message:
            'Faltan campos obligatorios (correo, metadata) o el header x-api-key.',
        });
      }

      // Simulamos la resolución del empresaId a partir del API Key (puedes reemplazar con tu lógica real)
      // Asumimos que la empresa dueña del API Key es la ID 1 para este ejemplo.
      const empresaIdDelApiKey = 1;

      // Buscar al usuario en la BD
      const usuario = await prisma.usuario.findUnique({
        where: { email: correo },
        include: { empresa: true, role: true },
      });

      if (!usuario) {
        return res.status(401).json({
          success: false,
          message: 'Acceso denegado: Usuario no encontrado.',
        });
      }

      if (usuario.empresaId !== empresaIdDelApiKey) {
        return res.status(403).json({
          success: false,
          message:
            'Acceso denegado: El usuario no pertenece a la empresa de este API Key.',
        });
      }

      // Generar JWT de corta duración inyectando datos del usuario y metadata
      const jwtSecret = process.env.JWT_SECRET || 'fallback-secret';
      const token = jwt.sign(
        {
          id: usuario.id,
          empresaId: usuario.empresaId,
          roleId: usuario.roleId,
          metadata,
        },
        jwtSecret,
        { expiresIn: '15m' },
      );

      // URL del frontend a donde vamos a redirigir (obtenido de env, o fallback)
      const frontendUrl =
        process.env.SSO_FRONTEND_URL || 'http://192.168.8.120:5182';

      // Construir url
      const redirectUrl = new URL(frontendUrl);
      redirectUrl.searchParams.set('session_token', token);

      res.json({ success: true, redirect_url: redirectUrl.toString() });
    } catch (error: unknown) {
      res.status(500).json({ success: false, message: getErrorMessage(error) });
    }
  }
}
