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
        message: 'Token no proporcionado. Incluya: Authorization: Bearer <nexus_token>',
      });
    }

    const token = authHeader.split(' ')[1];
    const result = await service.verify(token);

    return res.json({ success: true, ...result });
  }
}
