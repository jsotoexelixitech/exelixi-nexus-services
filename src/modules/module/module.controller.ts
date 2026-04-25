import { Response } from 'express';
import { ModuleService } from './module.service';
import { AuthRequest } from '../../middlewares/auth.middleware';

const moduleService = new ModuleService();

export class ModuleController {
  async getActive(req: AuthRequest, res: Response) {
    try {
      const empresaId = req.user?.empresaId;
      if (!empresaId) return res.status(403).json({ message: 'Empresa no identificada' });

      const modules = await moduleService.getActiveModules(empresaId);
      res.json(modules);
    } catch (error: any) {
      res.status(400).json({ message: error.message });
    }
  }
}
