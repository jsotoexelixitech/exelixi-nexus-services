import logger from '../../utils/logger';
import prisma from '../../config/prisma';
import { AppError } from '../../utils/app-error';

export class CompanyService {
  /**
   * Crea una nueva empresa (Tenant).
   */
  async createCompany(nombre: string, rif: string, tipo: string = 'cliente') {
    try {
      logger.info(`Creando nueva empresa: ${nombre} (${rif})`);
      return await prisma.empresa.create({
        data: { 
          nombre, 
          rif,
          tipo,
          activo: true 
        }
      });
    } catch (error: any) {
      logger.error(`Error al crear empresa: ${error.message}`);
      throw error;
    }
  }

  /**
   * Activa o desactiva un módulo para una empresa específica.
   */
  async toggleModule(empresaId: number, moduloId: number, active: boolean) {
    try {
      logger.info(`${active ? 'Activando' : 'Desactivando'} módulo ${moduloId} para empresa ${empresaId}`);
      
      // Buscamos si ya existe la relación
      const existing = await prisma.empresaModulo.findFirst({
        where: { empresaId, moduloId }
      });

      if (existing) {
        return await prisma.empresaModulo.update({
          where: { id: existing.id },
          data: { activo: active }
        });
      } else {
        return await prisma.empresaModulo.create({
          data: { 
            empresaId, 
            moduloId, 
            activo: active,
            token: `token-${empresaId}-${moduloId}` // Generamos un token por defecto
          }
        });
      }
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
  async createModule(nombre: string) {
    try {
      return await prisma.modulo.create({
        data: { 
          nombre,
          activo: true 
        }
      });
    } catch (error: any) {
      logger.error(`Error al crear módulo: ${error.message}`);
      throw error;
    }
  }
}
