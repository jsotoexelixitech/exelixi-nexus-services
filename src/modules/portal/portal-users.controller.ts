import { Response } from 'express';
import { AuthRequest } from '../../middlewares/auth.middleware';
import { UserService } from '../user/user.service';
import { RoleService } from '../role/role.service';
import { getErrorMessage } from '../../utils/error-handler';
import { AppError } from '../../utils/app-error';

const userService = new UserService();
const roleService = new RoleService();

export class PortalUsersController {
  listRoles = async (req: AuthRequest, res: Response): Promise<void> => {
    try {
      const empresaId = req.user?.empresaId;
      if (!empresaId) {
        res
          .status(403)
          .json({ success: false, message: 'Empresa no identificada' });
        return;
      }
      const roles = await roleService.getRolesByEmpresa(empresaId);
      res.json({
        success: true,
        data: roles
          .filter((r) => r.activo)
          .map((r) => ({ id: r.id, nombre: r.nombre })),
      });
    } catch (error: unknown) {
      res.status(400).json({ success: false, message: getErrorMessage(error) });
    }
  };

  listUsers = async (req: AuthRequest, res: Response): Promise<void> => {
    try {
      const empresaId = req.user?.empresaId;
      if (!empresaId) {
        res
          .status(403)
          .json({ success: false, message: 'Empresa no identificada' });
        return;
      }
      const limit = Math.min(
        parseInt(String(req.query.limit ?? '100'), 10) || 100,
        200,
      );
      const { users, total } = await userService.getUsersByEmpresa(
        empresaId,
        0,
        limit,
      );
      res.json({
        success: true,
        data: {
          total,
          users: users.map((u) => ({
            id: u.id,
            nombre: u.nombre,
            email: u.email,
            role: u.role.nombre,
            roleId: u.roleId,
            activo: u.activo,
            portalPerfil: u.portalPerfil,
          })),
        },
      });
    } catch (error: unknown) {
      res.status(400).json({ success: false, message: getErrorMessage(error) });
    }
  };

  createUser = async (req: AuthRequest, res: Response): Promise<void> => {
    try {
      const empresaId = req.user?.empresaId;
      if (!empresaId) {
        res
          .status(403)
          .json({ success: false, message: 'Empresa no identificada' });
        return;
      }
      const result = await userService.createUser(empresaId, req.body);
      const user = result.user;
      res.status(201).json({
        success: true,
        data: {
          id: user.id,
          nombre: user.nombre,
          email: user.email,
          roleId: user.roleId,
          temporaryPassword: result.temporaryPassword,
        },
      });
    } catch (error: unknown) {
      res.status(400).json({ success: false, message: getErrorMessage(error) });
    }
  };

  updateUser = async (req: AuthRequest, res: Response): Promise<void> => {
    try {
      const empresaId = req.user?.empresaId;
      const actorId = req.user?.id;
      if (!empresaId || !actorId) {
        res.status(403).json({ success: false, message: 'Sesión no válida' });
        return;
      }
      const { id } = req.params;
      if (String(id) === String(actorId) && req.body.activo === false) {
        res.status(400).json({
          success: false,
          message: 'No puede desactivar su propia cuenta.',
        });
        return;
      }
      const user = await userService.updateUser(id, empresaId, req.body);
      res.json({ success: true, data: user });
    } catch (error: unknown) {
      const status = error instanceof AppError ? error.statusCode : 400;
      res
        .status(status)
        .json({ success: false, message: getErrorMessage(error) });
    }
  };

  toggleStatus = async (req: AuthRequest, res: Response): Promise<void> => {
    try {
      const empresaId = req.user?.empresaId;
      const actorId = req.user?.id;
      if (!empresaId || !actorId) {
        res.status(403).json({ success: false, message: 'Sesión no válida' });
        return;
      }
      const { id } = req.params;
      if (String(id) === String(actorId)) {
        res.status(400).json({
          success: false,
          message: 'No puede cambiar el estado de su propia cuenta.',
        });
        return;
      }
      const user = await userService.toggleUserStatus(id, empresaId);
      res.json({
        success: true,
        data: { activo: user.activo },
      });
    } catch (error: unknown) {
      res.status(400).json({ success: false, message: getErrorMessage(error) });
    }
  };
}
