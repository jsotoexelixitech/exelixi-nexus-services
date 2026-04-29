import { Request, Response, NextFunction } from 'express';
import { ZodError } from 'zod';
import logger from '../utils/logger';
import { getRequestContext } from '../utils/request-context';
import { captureError } from '../config/sentry';

interface CustomError extends Error {
  statusCode?: number;
  code?: string;
  meta?: {
    target?: string[];
  };
}

export const errorHandler = (
  err: CustomError,
  req: Request,
  res: Response,
  _next: NextFunction,
) => {
  const ctx = getRequestContext();
  const requestId = ctx?.requestId || 'no-context';

  // Log the error con requestId (Winston lo inyecta automáticamente via el contexto)
  logger.error(`${err.message} - ${req.method} ${req.url} - ${req.ip}`);

  // Capturar en Sentry con contexto enriquecido
  captureError(err, {
    userId: ctx?.userId,
    empresaId: ctx?.empresaId,
    requestId,
    extra: {
      method: req.method,
      url: req.originalUrl,
      statusCode: err.statusCode,
      errorCode: err.code,
    },
  });

  // Zod Validation Errors
  if (err instanceof ZodError) {
    return res.status(400).json({
      success: false,
      error: 'VALIDATION_ERROR',
      message: 'Los datos proporcionados no son válidos.',
      requestId,
      details: err.errors.map((e) => ({
        field: e.path.join('.'),
        message: e.message,
      })),
    });
  }

  // Prisma Errors (e.g., Unique constraint)
  if (err.code === 'P2002') {
    return res.status(409).json({
      success: false,
      error: 'DUPLICATE_ENTRY',
      message: `Ya existe un registro con ese valor en el campo: ${err.meta?.target}`,
      requestId,
    });
  }

  // Prisma Not Found
  if (err.code === 'P2025') {
    return res.status(404).json({
      success: false,
      error: 'NOT_FOUND',
      message: 'El registro solicitado no existe.',
      requestId,
    });
  }

  // Generic Errors
  const statusCode = err.statusCode || 500;
  const message = err.message || 'Error interno del servidor';

  res.status(statusCode).json({
    success: false,
    error: err.name || 'INTERNAL_SERVER_ERROR',
    message,
    requestId,
    ...(process.env.NODE_ENV === 'development' && { stack: err.stack }),
  });
};
