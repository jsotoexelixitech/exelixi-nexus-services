import { Request, Response } from 'express';
import { AccessService } from './access.service';

const service = new AccessService();

export class AccessController {
  /**
   * GET /api/access/verify
   * Verifica si un tenant token es válido y el servicio está activo.
   * Llamado desde el frontend de cada submódulo al cargar la app.
   * No requiere x-api-key — es un endpoint público (protegido por firma JWT).
   */
  async verify(req: Request, res: Response) {
    const authHeader = req.headers.authorization;

    if (!authHeader?.startsWith('Bearer ')) {
      return res.status(401).json({
        success: false,
        active: false,
        message:
          'Token no proporcionado. Incluya: Authorization: Bearer <nexus_token>',
      });
    }

    const token = authHeader.split(' ')[1];
    const result = await service.verify(token);

    return res.json({ success: true, ...result });
  }

  /**
   * POST /api/access/heartbeat
   * Llamado por el backend de cada módulo en cada petición del usuario.
   * Verifica empresa/módulo activos y renueva tokenExpiresAt en BD.
   * Acepta el token via Authorization: Bearer o x-nexus-token header.
   * No requiere x-api-key.
   */
  async heartbeat(req: Request, res: Response) {
    const authHeader =
      (req.headers.authorization as string) ||
      (req.headers['x-nexus-token'] as string);

    if (!authHeader) {
      return res.status(401).json({
        success: false,
        active: false,
        message: 'Token no proporcionado.',
      });
    }

    const token = authHeader.replace(/^Bearer\s+/i, '').trim();
    const result = await service.heartbeat(token);

    if (!result.active) {
      return res.status(403).json({ success: false, ...result });
    }

    return res.json({ success: true, ...result });
  }
}
