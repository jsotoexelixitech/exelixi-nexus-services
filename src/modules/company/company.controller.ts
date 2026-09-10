import { Request, Response } from 'express';
import crypto from 'crypto';
import { CompanyService } from './company.service';
import { getErrorMessage } from '../../utils/error-handler';
import { AppError } from '../../utils/app-error';

const companyService = new CompanyService();

export class CompanyController {
  async list(req: Request, res: Response) {
    try {
      const companies = await companyService.getAllCompanies();
      res.json({
        success: true,
        data: companies,
      });
    } catch (error: unknown) {
      res.status(500).json({ success: false, message: getErrorMessage(error) });
    }
  }

  async getById(req: Request, res: Response) {
    try {
      const company = await companyService.getCompanyById(
        Number(req.params.id),
      );
      res.json({
        success: true,
        data: company,
      });
    } catch (error: unknown) {
      const statusCode = error instanceof AppError ? error.statusCode : 500;
      res
        .status(statusCode)
        .json({ success: false, message: getErrorMessage(error) });
    }
  }

  async create(req: Request, res: Response) {
    try {
      const { nombre, rif, tipo } = req.body;
      const company = await companyService.createCompany(nombre, rif, tipo);
      res.status(201).json({
        success: true,
        message: 'Empresa creada exitosamente',
        data: company,
      });
    } catch (error: unknown) {
      res.status(400).json({ success: false, message: getErrorMessage(error) });
    }
  }

  async update(req: Request, res: Response) {
    try {
      const company = await companyService.updateCompany(
        Number(req.params.id),
        req.body,
      );
      res.json({
        success: true,
        message: 'Empresa actualizada exitosamente',
        data: company,
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
        message: 'Empresa desactivada exitosamente',
      });
    } catch (error: unknown) {
      res.status(400).json({ success: false, message: getErrorMessage(error) });
    }
  }

  async toggleModule(req: Request, res: Response) {
    try {
      const { empresaId, moduloId, active } = req.body;
      const result = await companyService.toggleModule(
        Number(empresaId),
        Number(moduloId),
        active,
      );
      res.json({
        success: true,
        message: `Módulo ${active ? 'activado' : 'desactivado'} exitosamente`,
        data: result,
      });
    } catch (error: unknown) {
      res.status(400).json({ success: false, message: getErrorMessage(error) });
    }
  }

  async toggleSubmodule(req: Request, res: Response) {
    try {
      const { empresaId, submoduloId, active } = req.body;
      const result = await companyService.toggleSubmodule(
        Number(empresaId),
        Number(submoduloId),
        active,
      );
      res.json({
        success: true,
        message: `Submódulo ${active ? 'activado' : 'desactivado'} exitosamente`,
        data: result,
      });
    } catch (error: unknown) {
      res.status(400).json({ success: false, message: getErrorMessage(error) });
    }
  }

  async generateApiKey(req: Request, res: Response) {
    try {
      const empresaId = Number(req.params.id);
      if (isNaN(empresaId)) {
        return res
          .status(400)
          .json({ success: false, message: 'ID de empresa inválido' });
      }

      // Generar llave de 64 caracteres (32 bytes hex)
      const newApiKey = crypto.randomBytes(32).toString('hex');

      const company = await companyService.updateCompany(empresaId, {
        apiKey: newApiKey,
      } as any);

      res.json({
        success: true,
        message: 'API Key generada exitosamente',
        apiKey: newApiKey,
        data: company,
      });
    } catch (error: unknown) {
      res.status(400).json({ success: false, message: getErrorMessage(error) });
    }
  }

  /**
   * GET /api/companies/:id/connection-tokens
   * Devuelve los tokens de conexión de todos los submódulos de una empresa.
   * Solo accesible desde el admin (requiere authenticate via router).
   */
  async getConnectionTokens(req: Request, res: Response) {
    try {
      const empresaId = Number(req.params.id);
      const data = await companyService.getConnectionTokens(empresaId);
      res.json({ success: true, data });
    } catch (error: unknown) {
      const statusCode = error instanceof AppError ? error.statusCode : 500;
      res
        .status(statusCode)
        .json({ success: false, message: getErrorMessage(error) });
    }
  }
}
