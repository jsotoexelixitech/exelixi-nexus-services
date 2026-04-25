import { Response, NextFunction } from 'express';
import { PrismaClient } from '@prisma/client';
import { AuthRequest } from './auth.middleware';

const prisma = new PrismaClient();

/**
 * Valida si el rol del usuario tiene permiso para un módulo determinado.
 */
export const checkRolePermission = (moduleName: string) => {
  return async (req: AuthRequest, res: Response, next: NextFunction) => {
    const roleId = req.user?.roleId;

    if (!roleId) {
      return res.status(403).json({ message: 'Contexto de rol no encontrado.' });
    }

    try {
      // En este esquema, buscamos a través de EmpresaModulo
      const permission = await prisma.permission.findFirst({
        where: {
          roleId: Number(roleId),
          empresaModulo: {
            modulo: {
              nombre: moduleName
            },
            activo: true
          },
          activo: true
        }
      });

      if (!permission) {
        return res.status(403).json({ 
          error: 'INSUFFICIENT_PERMISSIONS',
          message: `Su rol no tiene permisos para acceder al módulo '${moduleName}'.` 
        });
      }

      next();
    } catch (error: unknown) {
      return res.status(500).json({ message: 'Error validando permisos de rol.' });
    }
  };
};
