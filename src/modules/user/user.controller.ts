import { Response } from 'express';
import { UserService } from './user.service';
import { AuthRequest } from '../../middlewares/auth.middleware';

const userService = new UserService();

export class UserController {
  async create(req: AuthRequest, res: Response) {
    try {
      const empresaId = req.user?.empresaId;
      if (!empresaId) return res.status(403).json({ message: 'Empresa no identificada' });

      const user = await userService.createUser(empresaId, req.body);
      res.status(201).json({
        id: user.id,
        nombre: user.nombre,
        email: user.email,
        roleId: user.roleId
      });
    } catch (error: any) {
      res.status(400).json({ message: error.message });
    }
  }

  async update(req: AuthRequest, res: Response) {
    try {
      const empresaId = req.user?.empresaId;
      if (!empresaId) return res.status(403).json({ message: 'Empresa no identificada' });

      const { id } = req.params;
      const user = await userService.updateUser(id, empresaId, req.body);
      res.json(user);
    } catch (error: any) {
      res.status(400).json({ message: error.message });
    }
  }

  async toggleStatus(req: AuthRequest, res: Response) {
    try {
      const empresaId = req.user?.empresaId;
      if (!empresaId) return res.status(403).json({ message: 'Empresa no identificada' });

      const { id } = req.params;
      const user = await userService.toggleUserStatus(id, empresaId);
      res.json({ message: 'Estado del usuario actualizado', active: user.activo });
    } catch (error: any) {
      res.status(400).json({ message: error.message });
    }
  }

  async changePassword(req: AuthRequest, res: Response) {
    try {
      const empresaId = req.user?.empresaId;
      const userId = req.user?.id;
      if (!empresaId || !userId) return res.status(403).json({ message: 'Sesión no válida' });

      const { currentPassword, newPassword } = req.body;
      await userService.changePassword(userId, empresaId, currentPassword, newPassword);
      res.json({ message: 'Contraseña actualizada correctamente' });
    } catch (error: any) {
      res.status(400).json({ message: error.message });
    }
  }

  async list(req: AuthRequest, res: Response) {
    const empresaId = req.user?.empresaId;
    if (!empresaId) return res.status(403).json({ message: 'Empresa no identificada' });

    const users = await userService.getUsersByEmpresa(empresaId);
    res.json(users.map(u => ({
      id: u.id,
      nombre: u.nombre,
      email: u.email,
      role: u.role.nombre,
      activo: u.activo
    })));
  }
}
