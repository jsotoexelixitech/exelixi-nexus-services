import { Request, Response } from 'express';
import { CompanyService } from './company.service';
import { getErrorMessage } from '../../utils/error-handler';

const companyService = new CompanyService();

export class CompanyController {
  /**
   * @openapi
   * /api/companies:
   *   get:
   *     tags:
   *       - Companies
   *     summary: Listar todas las empresas (SaaS Admin)
   *     security:
   *       - bearerAuth: []
   *     responses:
   *       200:
   *         description: Lista de empresas
   */
  async list(req: Request, res: Response) {
    try {
      const companies = await companyService.getAllCompanies();
      res.json({
        success: true,
        data: companies
      });
    } catch (error: unknown) {
      res.status(500).json({ success: false, message: getErrorMessage(error) });
    }
  }

  async getById(req: Request, res: Response) {
    try {
      const company = await companyService.getCompanyById(Number(req.params.id));
      res.json({
        success: true,
        data: company
      });
    } catch (error: unknown) {
      res.status(404).json({ success: false, message: getErrorMessage(error) });
    }
  }

  /**
   * @openapi
   * /api/companies:
   *   post:
   *     tags:
   *       - Companies
   *     summary: Crear una nueva empresa
   *     security:
   *       - bearerAuth: []
   *     requestBody:
   *       required: true
   *       content:
   *         application/json:
   *           schema:
   *             type: object
   *             required:
   *               - nombre
   *               - rif
   *             properties:
   *               nombre:
   *                 type: string
   *               rif:
   *                 type: string
   *               tipo:
   *                 type: string
   *     responses:
   *       201:
   *         description: Empresa creada
   */
  async create(req: Request, res: Response) {
    try {
      const { nombre, rif, tipo } = req.body;
      const company = await companyService.createCompany(nombre, rif, tipo);
      res.status(201).json({
        success: true,
        message: 'Empresa creada exitosamente',
        data: company
      });
    } catch (error: unknown) {
      res.status(400).json({ success: false, message: getErrorMessage(error) });
    }
  }

  async update(req: Request, res: Response) {
    try {
      const company = await companyService.updateCompany(Number(req.params.id), req.body);
      res.json({
        success: true,
        message: 'Empresa actualizada exitosamente',
        data: company
      });
    } catch (error: unknown) {
      res.status(400).json({ success: false, message: getErrorMessage(error) });
    }
  }

  async delete(req: Request, res: Response) {
    try {
      await companyService.deleteCompany(Number(req.params.id));
      res.json({
        success: true,
        message: 'Empresa desactivada exitosamente'
      });
    } catch (error: unknown) {
      res.status(400).json({ success: false, message: getErrorMessage(error) });
    }
  }

  async toggleModule(req: Request, res: Response) {
    try {
      const { empresaId, moduloId, active } = req.body;
      const result = await companyService.toggleModule(Number(empresaId), Number(moduloId), active);
      res.json({
        success: true,
        message: `Módulo ${active ? 'activado' : 'desactivado'} exitosamente`,
        data: result
      });
    } catch (error: unknown) {
      res.status(400).json({ success: false, message: getErrorMessage(error) });
    }
  }
}
