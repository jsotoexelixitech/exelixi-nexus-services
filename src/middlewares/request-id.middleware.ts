import { Request, Response, NextFunction } from 'express';
import {
  requestContext,
  generateRequestId,
  RequestContext,
} from '../utils/request-context';

/**
 * Middleware que genera un x-request-id único por petición.
 *
 * - Si el cliente envía un x-request-id, lo reutiliza (para trazabilidad cross-service).
 * - Si no, genera uno nuevo.
 * - Lo inyecta en el response header para que el frontend pueda correlacionar.
 * - Lo almacena en AsyncLocalStorage para que todo el código downstream lo use.
 */
export const requestIdMiddleware = (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  const requestId =
    (req.headers['x-request-id'] as string) || generateRequestId();

  // Devolver el ID al cliente en el response
  res.setHeader('x-request-id', requestId);

  // Crear contexto para esta petición
  const context: RequestContext = {
    requestId,
    method: req.method,
    url: req.originalUrl,
  };

  // Ejecutar el resto del pipeline dentro del contexto
  requestContext.run(context, () => {
    next();
  });
};
