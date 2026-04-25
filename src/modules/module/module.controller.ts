import { Response } from 'express';
import { ModuleService } from './module.service';
import { AuthRequest } from '../../middlewares/auth.middleware';
import { getErrorMessage } from '../../utils/error-handler';

const moduleService = new ModuleService();

export class ModuleController {
  /**
   * @openapi
   * /api/modules/active:
   *   get:
   *     tags:
   *       - Modules
   *     summary: Obtener módulos activos de la empresa actual
   *     security:
   *       - bearerAuth: []
   *     responses:
   *       200:
   *         description: Lista de módulos
   */
  async getActive(req: AuthRequest, res: Response) {
    try {
      const empresaId = req.user?.empresaId;
      if (!empresaId) return res.status(403).json({ message: 'Empresa no identificada' });

      const modules = await moduleService.getActiveModules(empresaId.toString());
      res.json({
        success: true,
        data: modules
      });
    } catch (error: unknown) {
      res.status(400).json({ success: false, message: getErrorMessage(error) });
    }
  }

  /**
   * @openapi
   * /api/modules/all:
   *   get:
   *     tags:
   *       - Modules
   *     summary: Listar todos los módulos y submódulos (Admin)
   *     security:
   *       - bearerAuth: []
   *     responses:
   *       200:
   *         description: Lista completa
   */
  async listAll(req: AuthRequest, res: Response) {
    try {
      const modules = await moduleService.getAllModules();
      res.json({
        success: true,
        data: modules
      });
    } catch (error: unknown) {
      res.status(400).json({ success: false, message: getErrorMessage(error) });
    }
  }

  async createModule(req: AuthRequest, res: Response) {
    try {
      const { nombre } = req.body;
      const result = await moduleService.createModule(nombre);
      res.status(201).json({ success: true, data: result });
    } catch (error: unknown) {
      res.status(400).json({ success: false, message: getErrorMessage(error) });
    }
  }

  async updateModule(req: AuthRequest, res: Response) {
    try {
      const { id } = req.params;
      const result = await moduleService.updateModule(Number(id), req.body);
      res.json({ success: true, data: result });
    } catch (error: unknown) {
      res.status(400).json({ success: false, message: getErrorMessage(error) });
    }
  }

  async deleteModule(req: AuthRequest, res: Response) {
    try {
      const { id } = req.params;
      await moduleService.deleteModule(Number(id));
      res.json({ success: true, message: 'Módulo desactivado correctamente' });
    } catch (error: unknown) {
      res.status(400).json({ success: false, message: getErrorMessage(error) });
    }
  }

  /**
   * @openapi
   * /api/modules/submodule:
   *   post:
   *     tags:
   *       - Modules
   *     summary: Crear un nuevo submódulo
   *     security:
   *       - bearerAuth: []
   *     requestBody:
   *       required: true
   *       content:
   *         application/json:
   *           schema:
   *             type: object
   *             required:
   *               - moduloId
   *               - nombre
   *             properties:
   *               moduloId:
   *                 type: number
   *               nombre:
   *                 type: string
   *     responses:
   *       201:
   *         description: Submódulo creado
   */
  async createSubmodule(req: AuthRequest, res: Response) {
    try {
      const { moduloId, nombre } = req.body;
      const submodule = await moduleService.createSubmodule(Number(moduloId), nombre);
      res.status(201).json({
        success: true,
        data: submodule
      });
    } catch (error: unknown) {
      res.status(400).json({ success: false, message: getErrorMessage(error) });
    }
  }

  async updateSubmodule(req: AuthRequest, res: Response) {
    try {
      const { id } = req.params;
      const result = await moduleService.updateSubmodule(Number(id), req.body);
      res.json({ success: true, data: result });
    } catch (error: unknown) {
      res.status(400).json({ success: false, message: getErrorMessage(error) });
    }
  }

  async deleteSubmodule(req: AuthRequest, res: Response) {
    try {
      const { id } = req.params;
      await moduleService.deleteSubmodule(Number(id));
      res.json({ success: true, message: 'Submódulo eliminado correctamente' });
    } catch (error: unknown) {
      res.status(400).json({ success: false, message: getErrorMessage(error) });
    }
  }
}
