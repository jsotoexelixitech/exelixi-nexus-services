import { Request, Response } from 'express';
import { CompanyService } from './company.service';

const companyService = new CompanyService();

export class CompanyController {
  async create(req: Request, res: Response) {
    try {
      const { nombre, slug } = req.body;
      const company = await companyService.createCompany(nombre, slug);
      res.status(201).json(company);
    } catch (error: any) {
      res.status(400).json({ message: error.message });
    }
  }

  async toggleModule(req: Request, res: Response) {
    try {
      const { empresaId, moduloId, active } = req.body;
      const result = await companyService.toggleModule(empresaId, moduloId, active);
      res.json(result);
    } catch (error: any) {
      res.status(400).json({ message: error.message });
    }
  }

  async list(req: Request, res: Response) {
    const companies = await companyService.getAllCompanies();
    res.json(companies);
  }

  async createModule(req: Request, res: Response) {
    try {
      const { nombre, key, descripcion } = req.body;
      const modulo = await companyService.createModule(nombre);
      res.status(201).json(modulo);
    } catch (error: any) {
      res.status(400).json({ message: error.message });
    }
  }
}
