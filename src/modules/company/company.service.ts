import logger from '../../utils/logger';
import prisma from '../../config/prisma';
import { AppError } from '../../utils/app-error';

export class CompanyService {
  /**
   * Crea una nueva empresa (Tenant).
   */
  async createCompany(nombre: string, slug: string) {
    try {
      logger.info(`Creando nueva empresa: ${nombre} (${slug})`);
      return await prisma.empresa.create({
        data: { nombre, slug }
      });
    } catch (error: any) {
      if (error.code === 'P2002') {
        throw new AppError(`El slug '${slug}' ya está en uso por otra empresa.`, 400);
      }
      logger.error(`Error al crear empresa: ${error.message}`);
      throw error;
    }
  }

  /**
   * Activa o desactiva un módulo para una empresa específica.
   */
  async toggleModule(empresaId: string, moduloId: string, active: boolean) {
    try {
      logger.info(`${active ? 'Activando' : 'Desactivando'} módulo ${moduloId} para empresa ${empresaId}`);
      return await prisma.empresaModulo.upsert({
        where: {
          empresaId_moduloId: { empresaId, moduloId }
        },
        update: { activo: active },
        create: { empresaId, moduloId, activo: active }
      });
    } catch (error: any) {
      logger.error(`Error al modificar módulo: ${error.message}`);
      throw new AppError('No se pudo actualizar el estado del módulo.', 500);
    }
  }

  async getAllCompanies() {
    try {
      return await prisma.empresa.findMany({
        include: {
          modulos: {
            include: { modulo: true }
          }
        }
      });
    } catch (error: any) {
      logger.error(`Error al listar empresas: ${error.message}`);
      throw new AppError('Error al recuperar el listado de empresas.', 500);
    }
  }

  /**
   * Obtiene los módulos disponibles en el sistema.
   */
  async getSystemModules() {
    try {
      return await prisma.modulo.findMany();
    } catch (error: any) {
      logger.error(`Error al obtener módulos del sistema: ${error.message}`);
      throw new AppError('Error al recuperar módulos globales.', 500);
    }
  }

  /**
   * Crea un módulo en el sistema (Super Admin).
   */
  async createModule(nombre: string, key: string, descripcion?: string) {
    try {
      return await prisma.modulo.create({
        data: { nombre, key, descripcion }
      });
    } catch (error: any) {
      if (error.code === 'P2002') {
        throw new AppError(`La key de módulo '${key}' ya existe.`, 400);
      }
      logger.error(`Error al crear módulo: ${error.message}`);
      throw error;
    }
  }
}
