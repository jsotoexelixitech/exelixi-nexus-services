import { Request, Response, NextFunction } from 'express';
import { env } from '../config/env';
import { AppError } from '../utils/app-error';

/**
 * Middleware de seguridad global.
 * Bloquea cualquier petición que no incluya el header 'x-api-key' correcto.
 */
export const apiKeyGuard = (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  // Excluir rutas públicas de la validación de API Key
  const publicPaths = ['/health', '/api-docs', '/api/api-docs'];
  if (publicPaths.some((path) => req.originalUrl.startsWith(path))) {
    return next();
  }

  const apiKey = req.headers['x-api-key'];

  if (!apiKey || apiKey !== env.API_KEY) {
    throw new AppError(
      'Acceso denegado: API Key inválida o ausente en el header x-api-key.',
      403,
    );
  }

  next();
};
