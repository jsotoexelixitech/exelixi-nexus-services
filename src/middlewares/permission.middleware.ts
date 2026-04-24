import { Response, NextFunction } from 'express';
import { PrismaClient } from '@prisma/client';
import { AuthRequest } from './auth.middleware';

const prisma = new PrismaClient();

type PermissionAction = 'canRead' | 'canWrite' | 'canDelete';

/**
 * Valida si el rol del usuario tiene permiso específico (lectura, escritura, borrado) 
 * para un módulo determinado.
 */
export const checkRolePermission = (moduleKey: string, action: PermissionAction) => {
  return async (req: AuthRequest, res: Response, next: NextFunction) => {
    const roleId = req.user?.roleId;

    if (!roleId) {
      return res.status(403).json({ message: 'Contexto de rol no encontrado.' });
    }

    try {
      const permission = await prisma.permission.findFirst({
        where: {
          roleId,
          modulo: {
            key: moduleKey
          },
          [action]: true
        }
      });

      if (!permission) {
        return res.status(403).json({ 
          error: 'INSUFFICIENT_PERMISSIONS',
          message: `Su rol no tiene permisos de ${action.replace('can', '').toLowerCase()} para el módulo '${moduleKey}'.` 
        });
      }

      next();
    } catch (error) {
      return res.status(500).json({ message: 'Error validando permisos de rol.' });
    }
  };
};
