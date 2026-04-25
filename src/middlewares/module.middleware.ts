import { Response, NextFunction } from 'express';
import { PrismaClient } from '@prisma/client';
import { AuthRequest } from './auth.middleware';

const prisma = new PrismaClient();

/**
 * Valida si la empresa tiene el módulo activo en la tabla empresa_modulo.
 */
export const checkModuleAccess = (moduleName: string) => {
  return async (req: AuthRequest, res: Response, next: NextFunction) => {
    const empresaId = req.user?.empresaId;

    if (!empresaId) {
      return res.status(403).json({ message: 'Contexto de empresa no encontrado en el token.' });
    }

    try {
      const moduleAccess = await prisma.empresaModulo.findFirst({
        where: {
          empresaId: Number(empresaId),
          modulo: {
            nombre: moduleName
          },
          activo: true
        }
      });

      if (!moduleAccess) {
        return res.status(403).json({ 
          error: 'MODULE_INACTIVE',
          message: `El módulo '${moduleName}' no está contratado o activo para su empresa.` 
        });
      }

      next();
    } catch (error: unknown) {
      return res.status(500).json({ message: 'Error validando acceso al módulo.' });
    }
  };
};
