import logger from '../../utils/logger';
import prisma from '../../config/prisma';
import { AppError } from '../../utils/app-error';

export class RoleService {
  /**
   * Crea un rol vinculado a una empresa específica.
   */
  async createRole(empresaId: string, nombre: string) {
    try {
      logger.info(`Creando rol '${nombre}' para empresa ${empresaId}`);
      return await prisma.role.create({
        data: {
          nombre,
          empresaId,
        }
      });
    } catch (error: any) {
      logger.error(`Error al crear rol: ${error.message}`);
      throw new AppError('No se pudo crear el rol.', 500);
    }
  }

  async updateRole(id: string, empresaId: string, nombre: string) {
    try {
      logger.info(`Actualizando rol ${id} a '${nombre}'`);
      return await prisma.role.update({
        where: { id, empresaId },
        data: { nombre }
      });
    } catch (error: any) {
      logger.error(`Error al actualizar rol: ${error.message}`);
      throw new AppError('No se pudo actualizar el rol.', 500);
    }
  }

  async deleteRole(id: string, empresaId: string) {
    try {
      logger.info(`Intentando eliminar rol ${id}`);
      
      // Validar si tiene usuarios asignados
      const usersCount = await prisma.usuario.count({
        where: { roleId: id }
      });

      if (usersCount > 0) {
        throw new AppError('No se puede eliminar un rol que tiene usuarios asignados.', 400);
      }

      return await prisma.role.delete({
        where: { id, empresaId }
      });
    } catch (error: any) {
      if (error instanceof AppError) throw error;
      logger.error(`Error al eliminar rol: ${error.message}`);
      throw new AppError('No se pudo eliminar el rol.', 500);
    }
  }

  /**
   * Asigna permisos a un rol. 
   */
  async assignPermissions(empresaId: string, roleId: string, permissions: { moduloId: string, canRead: boolean, canWrite: boolean, canDelete: boolean }[]) {
    logger.info(`Asignando matriz de ${permissions.length} permisos al rol ${roleId}`);
    // 1. Obtener los módulos activos de la empresa
    const activeModules = await prisma.empresaModulo.findMany({
      where: { empresaId, activo: true },
      select: { moduloId: true }
    });

    const activeModuleIds = activeModules.map(m => m.moduloId);

    // 2. Filtrar o validar que todos los módulos en 'permissions' estén en 'activeModuleIds'
    for (const p of permissions) {
      if (!activeModuleIds.includes(p.moduloId)) {
        throw new Error(`La empresa no tiene activo el módulo con ID ${p.moduloId}. No se puede asignar al rol.`);
      }
    }

    // 3. Guardar los permisos (Upsert para actualizar si ya existen)
    const operations = permissions.map(p => 
      prisma.permission.upsert({
        where: {
          roleId_moduloId: {
            roleId,
            moduloId: p.moduloId
          }
        },
        update: {
          canRead: p.canRead,
          canWrite: p.canWrite,
          canDelete: p.canDelete
        },
        create: {
          roleId,
          moduloId: p.moduloId,
          canRead: p.canRead,
          canWrite: p.canWrite,
          canDelete: p.canDelete
        }
      })
    );

    return prisma.$transaction(operations);
  }

  async getRolesByEmpresa(empresaId: string) {
    return prisma.role.findMany({
      where: { empresaId },
      include: { permisos: { include: { modulo: true } } }
    });
  }

  async getPermissionMatrix(empresaId: string, roleId: string) {
    // 1. Obtener los módulos que la empresa tiene activos
    const activeModules = await prisma.empresaModulo.findMany({
      where: { empresaId, activo: true },
      include: { modulo: true }
    });

    // 2. Obtener los permisos actuales del rol
    const currentPermissions = await prisma.permission.findMany({
      where: { roleId }
    });

    // 3. Cruzar información para el frontend
    return activeModules.map(am => {
      const perm = currentPermissions.find(p => p.moduloId === am.moduloId);
      return {
        moduloId: am.moduloId,
        nombre: am.modulo.nombre,
        key: am.modulo.key,
        canRead: perm?.canRead || false,
        canWrite: perm?.canWrite || false,
        canDelete: perm?.canDelete || false
      };
    });
  }
}
