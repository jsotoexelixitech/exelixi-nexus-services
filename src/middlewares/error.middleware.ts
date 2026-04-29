import { Request, Response, NextFunction } from 'express';
import { ZodError } from 'zod';
import logger from '../utils/logger';

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
  // Log the error
  logger.error(`${err.message} - ${req.method} ${req.url} - ${req.ip}`);

  // Zod Validation Errors
  if (err instanceof ZodError) {
    return res.status(400).json({
      success: false,
      error: 'VALIDATION_ERROR',
      message: 'Los datos proporcionados no son válidos.',
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
    });
  }

  // Generic Errors
  const statusCode = err.statusCode || 500;
  const message = err.message || 'Error interno del servidor';

  res.status(statusCode).json({
    success: false,
    error: err.name || 'INTERNAL_SERVER_ERROR',
    message,
    ...(process.env.NODE_ENV === 'development' && { stack: err.stack }),
  });
};
