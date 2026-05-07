import logger from '../../utils/logger';
import prisma from '../../config/prisma';
import { AppError } from '../../utils/app-error';

export class CompanyService {
  /**
   * Crea una nueva empresa (Tenant).
   */
  async createCompany(nombre: string, rif?: string, tipo: string = 'cliente') {
    try {
      logger.info(`Creando nueva empresa: ${nombre} (${rif || 'S/R'})`);
      return await prisma.$transaction(async (tx) => {
        const empresa = await tx.empresa.create({
          data: {
            nombre,
            rif: rif || '',
            tipo,
            activo: true,
          },
        });

        // Provisionar módulos por defecto: si existen módulos globales activos,
        // se activan para la nueva empresa para evitar que /api/modules retorne [].
        const globalModules = await tx.modulo.findMany({
          where: { activo: true },
          select: { id: true },
        });

        if (globalModules.length > 0) {
          await tx.empresaModulo.createMany({
            data: globalModules.map((m) => ({
              empresaId: empresa.id,
              moduloId: m.id,
              activo: true,
              token: `token-${empresa.id}-${m.id}`,
            })),
            skipDuplicates: true,
          });
        }

        return empresa;
      });
    } catch (error: unknown) {
      const message =
        error instanceof Error ? error.message : 'Error desconocido';
      logger.error(`Error al crear empresa: ${message}`);
      throw new AppError('No se pudo crear la empresa.', 500);
    }
  }

  /**
   * Obtiene una empresa por su ID.
   */
  async getCompanyById(id: number) {
    const company = await prisma.empresa.findUnique({
      where: { id },
    });

    if (!company) {
      throw new AppError('Empresa no encontrada.', 404);
    }

    // Para el dashboard admin: retornar siempre el catálogo global de módulos,
    // mezclado con la configuración específica de la empresa.
    const [catalogo, empresaModulos] = await Promise.all([
      prisma.modulo.findMany({
        include: { submodulos: true },
      }),
      prisma.empresaModulo.findMany({
        where: { empresaId: id },
      }),
    ]);

    const byModuloId = new Map<number, (typeof empresaModulos)[number]>();
    for (const em of empresaModulos) byModuloId.set(em.moduloId, em);

    const modulos = catalogo.map((m) => {
      const em = byModuloId.get(m.id);
      return {
        id: em?.id ?? null,
        empresaId: id,
        moduloId: m.id,
        token: em?.token ?? null,
        activo: em?.activo ?? false,
        createdAt: em?.createdAt ?? null,
        modulo: m,
      };
    });

    return {
      ...company,
      modulos,
    };
  }

  /**
   * Actualiza los datos de una empresa.
   */
  async updateCompany(
    id: number,
    data: { nombre?: string; rif?: string; tipo?: string; activo?: boolean },
  ) {
    try {
      logger.info(`Actualizando empresa ${id}`);
      return await prisma.empresa.update({
        where: { id },
        data,
      });
    } catch (error: unknown) {
      const message =
        error instanceof Error ? error.message : 'Error desconocido';
      logger.error(`Error al actualizar empresa: ${message}`);
      throw new AppError('No se pudo actualizar la empresa.', 500);
    }
  }

  /**
   * Eliminación lógica (desactivación) de una empresa.
   */
  async deleteCompany(id: number) {
    try {
      logger.info(`Desactivando empresa ${id}`);
      return await prisma.empresa.update({
        where: { id },
        data: { activo: false },
      });
    } catch (error: unknown) {
      const message =
        error instanceof Error ? error.message : 'Error desconocido';
      logger.error(`Error al desactivar empresa: ${message}`);
      throw new AppError('No se pudo desactivar la empresa.', 500);
    }
  }

  /**
   * Activa o desactiva un módulo para una empresa específica.
   */
  async toggleModule(empresaId: number, moduloId: number, active: boolean) {
    try {
      logger.info(
        `${active ? 'Activando' : 'Desactivando'} módulo ${moduloId} para empresa ${empresaId}`,
      );

      const existing = await prisma.empresaModulo.findFirst({
        where: { empresaId, moduloId },
      });

      if (existing) {
        return await prisma.empresaModulo.update({
          where: { id: existing.id },
          data: { activo: active },
        });
      } else {
        return await prisma.empresaModulo.create({
          data: {
            empresaId,
            moduloId,
            activo: active,
            token: `token-${empresaId}-${moduloId}`,
          },
        });
      }
    } catch (error: unknown) {
      const message =
        error instanceof Error ? error.message : 'Error desconocido';
      logger.error(`Error al modificar módulo: ${message}`);
      throw new AppError('No se pudo actualizar el estado del módulo.', 500);
    }
  }

  async getAllCompanies() {
    try {
      // Mantener el retorno existente (con modulos reales) para listados,
      // y dejar el merge completo para getCompanyById.
      return await prisma.empresa.findMany({
        include: {
          modulos: {
            include: { modulo: true },
          },
        },
      });
    } catch (error: unknown) {
      const message =
        error instanceof Error ? error.message : 'Error desconocido';
      logger.error(`Error al listar empresas: ${message}`);
      throw new AppError('Error al recuperar el listado de empresas.', 500);
    }
  }
}
