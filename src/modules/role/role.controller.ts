import { Response } from 'express';
import { RoleService } from './role.service';
import { AuthRequest } from '../../middlewares/auth.middleware';

const roleService = new RoleService();

export class RoleController {
  async create(req: AuthRequest, res: Response) {
    try {
      const empresaId = req.user?.empresaId;
      if (!empresaId) return res.status(403).json({ message: 'Empresa no identificada' });

      const { nombre } = req.body;
      const role = await roleService.createRole(empresaId, nombre);
      res.status(201).json(role);
    } catch (error: any) {
      res.status(400).json({ message: error.message });
    }
  }

  async update(req: AuthRequest, res: Response) {
    try {
      const empresaId = req.user?.empresaId;
      if (!empresaId) return res.status(403).json({ message: 'Empresa no identificada' });

      const { id } = req.params;
      const { nombre } = req.body;
      const role = await roleService.updateRole(id, empresaId, nombre);
      res.json(role);
    } catch (error: any) {
      res.status(400).json({ message: error.message });
    }
  }

  async delete(req: AuthRequest, res: Response) {
    try {
      const empresaId = req.user?.empresaId;
      if (!empresaId) return res.status(403).json({ message: 'Empresa no identificada' });

      const { id } = req.params;
      await roleService.deleteRole(id, empresaId);
      res.json({ message: 'Rol eliminado correctamente' });
    } catch (error: any) {
      res.status(400).json({ message: error.message });
    }
  }

  async assignPermissions(req: AuthRequest, res: Response) {
    try {
      const empresaId = req.user?.empresaId;
      if (!empresaId) return res.status(403).json({ message: 'Empresa no identificada' });

      const { roleId, permissions } = req.body;
      const result = await roleService.assignPermissions(empresaId, roleId, permissions);
      res.json({ message: 'Permisos asignados correctamente', result });
    } catch (error: any) {
      res.status(400).json({ message: error.message });
    }
  }

  async list(req: AuthRequest, res: Response) {
    const empresaId = req.user?.empresaId;
    if (!empresaId) return res.status(403).json({ message: 'Empresa no identificada' });

    const roles = await roleService.getRolesByEmpresa(empresaId);
    res.json(roles);
  }

  async getPermissionMatrix(req: AuthRequest, res: Response) {
    try {
      const empresaId = req.user?.empresaId;
      if (!empresaId) return res.status(403).json({ message: 'Empresa no identificada' });

      const { roleId } = req.params;
      const matrix = await roleService.getPermissionMatrix(empresaId, roleId);
      res.json(matrix);
    } catch (error: any) {
      res.status(400).json({ message: error.message });
    }
  }
}
