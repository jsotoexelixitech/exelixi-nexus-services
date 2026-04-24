import { Request, Response, NextFunction } from 'express';
import { env } from '../config/env';
import { AppError } from '../utils/app-error';

/**
 * Middleware de seguridad global. 
 * Bloquea cualquier petición que no incluya el header 'x-api-key' correcto.
 */
export const apiKeyGuard = (req: Request, res: Response, next: NextFunction) => {
  // Permitir health check y docs sin API Key si se desea, 
  // pero el usuario pidió "ninguno de los endpoints".
  const apiKey = req.headers['x-api-key'];

  if (!apiKey || apiKey !== env.API_KEY) {
    throw new AppError('Acceso denegado: API Key inválida o ausente en el header x-api-key.', 403);
  }

  next();
};
