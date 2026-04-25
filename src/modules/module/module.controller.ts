import { Response } from 'express';
import { ModuleService } from './module.service';
import { AuthRequest } from '../../middlewares/auth.middleware';
import { getErrorMessage } from '../../utils/error-handler';

const moduleService = new ModuleService();

export class ModuleController {
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
}
