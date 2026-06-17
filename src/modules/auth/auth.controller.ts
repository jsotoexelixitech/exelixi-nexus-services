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
      const { metadata } = req.body;
      const apiKey = req.headers['x-api-key'];

      // Basic validation
      if (!metadata || !apiKey) {
        return res.status(400).json({
          success: false,
          message:
            'Faltan campos obligatorios (metadata) o el header x-api-key.',
        });
      }

      // Buscar la empresa por apiKey
      const empresa = await prisma.empresa.findUnique({
        where: { apiKey: apiKey as string },
      });

      if (!empresa) {
        return res.status(401).json({
          success: false,
          message: 'Acceso denegado: API Key inválida o no registrada.',
        });
      }

      // Generar JWT de corta duración inyectando datos de la empresa y metadata
      // Al ser integración server-to-server usamos datos ficticios para el usuario
      const jwtSecret = process.env.JWT_SECRET || 'fallback-secret';
      const token = jwt.sign(
        {
          id: -1, // ID Ficticio de sistema
          email: `integracion@empresa-${empresa.id}.local`,
          empresaId: empresa.id,
          roleId: 3, // Asignamos rol genérico (ej: Operador/Integrador)
          metadata,
        },
        jwtSecret,
        { expiresIn: '15m' },
      );

      // Manejo de redirección según el target solicitado
      const target = req.body.target || 'formulario';
      let frontendUrl =
        process.env.SSO_FRONTEND_URL || 'http://192.168.8.120:5182'; // Por defecto Formulario

      if (target === 'ocr') {
        frontendUrl = 'http://192.168.8.120:5181';
      } else if (target === 'emision') {
        frontendUrl = 'http://192.168.8.120:5183';
      } else if (target === 'pagos') {
        frontendUrl = 'http://192.168.8.120:5184';
      }

      // Construir url (usando nexus_token en lugar de session_token)
      const redirectUrl = new URL(frontendUrl);
      redirectUrl.searchParams.set('nexus_token', token);

      res.json({ success: true, redirect_url: redirectUrl.toString() });
    } catch (error: unknown) {
      res.status(500).json({ success: false, message: getErrorMessage(error) });
    }
  }
}
