import { Response, NextFunction } from 'express';
import prisma from '../../config/prisma';
import { AuthRequest } from '../../middlewares/auth.middleware';

/** Admin corporativo del portal (La Mundial): roles con admin/administrador en el nombre. */
export async function requirePortalAdmin(
  req: AuthRequest,
  res: Response,
  next: NextFunction,
): Promise<void> {
  const userId = req.user?.id;
  if (!userId) {
    res.status(401).json({ success: false, message: 'No autorizado.' });
    return;
  }

  const user = await prisma.usuario.findUnique({
    where: { id: userId },
    include: { role: true, empresa: true },
  });

  if (!user?.activo || !user.empresa.activo) {
    res.status(403).json({
      success: false,
      message: 'Su cuenta o empresa no está activa.',
    });
    return;
  }

  const roleName = user.role.nombre.toLowerCase();
  const isAdmin =
    roleName.includes('admin') || roleName.includes('administrador');
  if (!isAdmin) {
    res.status(403).json({
      success: false,
      message: 'Solo administradores corporativos pueden gestionar usuarios.',
    });
    return;
  }

  next();
}
