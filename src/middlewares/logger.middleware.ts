import { Request, Response, NextFunction } from 'express';
import logger from '../utils/logger';

export const requestLogger = (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  const start = Date.now();

  // Log inicial
  logger.info(`Incoming Request: ${req.method} ${req.originalUrl}`);

  // Escuchar cuando termine la respuesta
  res.on('finish', () => {
    try {
      const duration = Date.now() - start;
      const message = `${req.method} ${req.originalUrl} ${res.statusCode} - ${duration}ms`;

      if (res.statusCode >= 400) {
        logger.warn(`Finished Request: ${message}`);
      } else {
        logger.info(`Finished Request: ${message}`);
      }
    } catch (err) {
      console.error('Error in requestLogger finish handler:', err);
    }
  });

  next();
};
