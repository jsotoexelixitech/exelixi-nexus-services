import { Request, Response } from 'express';
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
      const { metadata, target = 'ocr' } = req.body;
      const apiKey = req.headers['x-api-key'];

      // Validación básica
      if (!metadata || !apiKey) {
        return res.status(400).json({
          success: false,
          message:
            'Faltan campos obligatorios (metadata) o el header x-api-key.',
        });
      }

      // 1. Buscar la empresa por apiKey
      const empresa = await prisma.empresa.findUnique({
        where: { apiKey: apiKey as string },
        select: { id: true, nombre: true, activo: true },
      });

      if (!empresa) {
        return res.status(401).json({
          success: false,
          message: 'Acceso denegado: API Key inválida o no registrada.',
        });
      }

      if (!empresa.activo) {
        return res.status(403).json({
          success: false,
          message: 'Acceso denegado: La empresa está inactiva.',
        });
      }

      // 2. Mapear el target al puerto del submódulo
      const targetPortMap: Record<string, string> = {
        ocr: '5181',
        formulario: '5182',
        emision: '5183',
        pagos: '5184',
      };

      const puerto = targetPortMap[target] ?? targetPortMap['ocr'];

      // 3. Buscar el submódulo cuya URL contenga el puerto correspondiente
      const submodulo = await prisma.submodulo.findFirst({
        where: {
          url: { contains: puerto },
          activo: true,
        },
        select: { id: true, url: true, nombre: true },
      });

      if (!submodulo) {
        return res.status(404).json({
          success: false,
          message: `No se encontró un submódulo activo para el target "${target}".`,
        });
      }

      // 4. Buscar el tenantToken ya generado para empresa + submódulo
      const empresaSubmodulo = await (
        prisma as unknown as {
          empresaSubmodulo: {
            findFirst: (args: {
              where: { empresaId: number; submoduloId: number };
              select: { tenantToken: boolean; activo: boolean };
            }) => Promise<{
              tenantToken: string | null;
              activo: boolean;
            } | null>;
          };
        }
      ).empresaSubmodulo.findFirst({
        where: { empresaId: empresa.id, submoduloId: submodulo.id },
        select: { tenantToken: true, activo: true },
      });

      if (!empresaSubmodulo || !empresaSubmodulo.activo) {
        return res.status(403).json({
          success: false,
          message: `El servicio "${target}" no está activado para esta empresa.`,
        });
      }

      if (!empresaSubmodulo.tenantToken) {
        return res.status(500).json({
          success: false,
          message:
            'El token de acceso no ha sido generado. Contacte al administrador.',
        });
      }

      // 5. Construir la URL de redirección con el tenantToken real
      const baseUrl = submodulo.url!.replace(/\/$/, '');
      const sep = baseUrl.includes('?') ? '&' : '?';
      const redirectUrl = `${baseUrl}${sep}nexus_token=${empresaSubmodulo.tenantToken}`;

      return res.json({
        success: true,
        redirect_url: redirectUrl,
        empresa: empresa.nombre,
        modulo: submodulo.nombre,
      });
    } catch (error: unknown) {
      res.status(500).json({ success: false, message: getErrorMessage(error) });
    }
  }
}
