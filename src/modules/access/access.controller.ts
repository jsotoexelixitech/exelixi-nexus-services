import { Request, Response } from 'express';
import { AccessService } from './access.service';
import { AppError } from '../../utils/app-error';
import { getErrorMessage } from '../../utils/error-handler';

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

    try {
      const result = await service.heartbeat(token);

      if (!result.active) {
        return res
          .status(403)
          .json({ success: false, active: false, reason: result.reason });
      }

      return res.json({
        success: true,
        active: true,
        access_token: result.access_token,
        expires_in: result.expires_in,
      });
    } catch (error: unknown) {
      const statusCode = error instanceof AppError ? error.statusCode : 500;
      return res.status(statusCode).json({
        success: false,
        active: false,
        message: getErrorMessage(error),
      });
    }
  }

  /**
   * POST /api/access/token
   * Endpoint OAuth 2.0 (Client Credentials) para clientes de terceros.
   * Recibe el API Key y retorna un Access Token de 1 hora.
   */
  async exchange(req: Request, res: Response) {
    // Acepta el API Key por el body { api_key: "..." } o por el header Authorization: Bearer
    const apiKey =
      req.body.api_key ||
      (req.headers.authorization &&
        req.headers.authorization.replace(/^Bearer\s+/i, '').trim());

    if (!apiKey) {
      return res.status(400).json({
        success: false,
        error: 'invalid_request',
        error_description: 'El parámetro api_key es requerido.',
      });
    }

    try {
      const result = await service.exchangeToken(apiKey);
      return res.json(result);
    } catch (error: unknown) {
      const err = error as { statusCode?: number; message?: string };
      const statusCode = err.statusCode || 401;
      return res.status(statusCode).json({
        success: false,
        error: statusCode === 401 ? 'invalid_client' : 'access_denied',
        error_description: err.message || 'Error desconocido',
      });
    }
  }
}
