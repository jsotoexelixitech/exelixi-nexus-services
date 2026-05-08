import { Response } from 'express';
import { RoleService } from './role.service';
import { AuthRequest } from '../../middlewares/auth.middleware';
import { getErrorMessage } from '../../utils/error-handler';

const roleService = new RoleService();

export class RoleController {
  /**
   * @openapi
   * /api/roles:
   *   post:
   *     tags:
   *       - Roles
   *     summary: Crear un nuevo rol para la empresa actual
   *     security:
   *       - bearerAuth: []
   *     requestBody:
   *       required: true
   *       content:
   *         application/json:
   *           schema:
   *             type: object
   *             properties:
   *               nombre:
   *                 type: string
   *     responses:
   *       201:
   *         description: Rol creado
   */
  async create(req: AuthRequest, res: Response) {
    try {
      const empresaId = req.user?.empresaId;
      if (!empresaId)
        return res.status(403).json({ message: 'Empresa no identificada' });

      const { nombre } = req.body;
      const role = await roleService.createRole(empresaId, nombre);
      res.status(201).json({
        success: true,
        data: role,
      });
    } catch (error: unknown) {
      res.status(400).json({ success: false, message: getErrorMessage(error) });
    }
  }

  async update(req: AuthRequest, res: Response) {
    try {
      const empresaId = req.user?.empresaId;
      if (!empresaId)
        return res.status(403).json({ message: 'Empresa no identificada' });

      const { id } = req.params;
      const { nombre } = req.body;
      const role = await roleService.updateRole(id, empresaId, nombre);
      res.json({
        success: true,
        data: role,
      });
    } catch (error: unknown) {
      res.status(400).json({ success: false, message: getErrorMessage(error) });
    }
  }

  async delete(req: AuthRequest, res: Response) {
    try {
      const empresaId = req.user?.empresaId;
      if (!empresaId)
        return res.status(403).json({ message: 'Empresa no identificada' });

      const { id } = req.params;
      await roleService.deleteRole(id, empresaId);
      res.json({
        success: true,
        message: 'Rol desactivado correctamente',
      });
    } catch (error: unknown) {
      res.status(400).json({ success: false, message: getErrorMessage(error) });
    }
  }

  async assignPermissions(req: AuthRequest, res: Response) {
    try {
      const empresaId = req.user?.empresaId;
      if (!empresaId)
        return res.status(403).json({ message: 'Empresa no identificada' });

      const { roleId, permissions } = req.body;
      const result = await roleService.assignPermissions(
        empresaId,
        roleId,
        permissions,
      );
      res.json({
        success: true,
        message: 'Permisos asignados correctamente',
        data: result,
      });
    } catch (error: unknown) {
      res.status(400).json({ success: false, message: getErrorMessage(error) });
    }
  }

  /**
   * @openapi
   * /api/roles:
   *   get:
   *     tags:
   *       - Roles
   *     summary: Listar roles de la empresa actual
   *     security:
   *       - bearerAuth: []
   *     responses:
   *       200:
   *         description: Lista de roles
   */
  async list(req: AuthRequest, res: Response) {
    try {
      const empresaId = req.user?.empresaId;
      if (!empresaId)
        return res.status(403).json({ message: 'Empresa no identificada' });

      // QA: Verificar si intentan acceder a otra empresa
      const queryEmpresaId = req.query.empresaId;
      if (queryEmpresaId && Number(queryEmpresaId) !== empresaId) {
        return res.status(403).json({
          success: false,
          message: 'No tienes permiso para acceder a los datos de otra empresa',
        });
      }

      const roles = await roleService.getRolesByEmpresa(empresaId);
      res.json({
        success: true,
        data: roles,
      });
    } catch (error: unknown) {
      res.status(400).json({ success: false, message: getErrorMessage(error) });
    }
  }

  async getPermissionMatrix(req: AuthRequest, res: Response) {
    try {
      const empresaId = req.user?.empresaId;
      if (!empresaId)
        return res.status(403).json({ message: 'Empresa no identificada' });

      const { roleId } = req.params;
      const matrix = await roleService.getPermissionMatrix(empresaId, roleId);
      res.json({
        success: true,
        data: matrix,
      });
    } catch (error: unknown) {
      res.status(400).json({ success: false, message: getErrorMessage(error) });
    }
  }
}
