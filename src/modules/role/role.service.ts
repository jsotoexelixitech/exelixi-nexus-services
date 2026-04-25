import logger from '../../utils/logger';
import prisma from '../../config/prisma';
import { AppError } from '../../utils/app-error';
import { getErrorMessage } from '../../utils/error-handler';

export class RoleService {
  /**
   * Crea un rol vinculado a una empresa específica.
   */
  async createRole(empresaId: string | number, nombre: string) {
    try {
      const eid = Number(empresaId);
      logger.info(`Creando rol '${nombre}' para empresa ${eid}`);
      return await prisma.role.create({
        data: {
          nombre,
          empresaId: eid,
          activo: true
        }
      });
    } catch (error: unknown) {
      logger.error(`Error al crear rol: ${getErrorMessage(error)}`);
      throw new AppError('No se pudo crear el rol.', 500);
    }
  }

  async updateRole(id: string | number, empresaId: string | number, nombre: string) {
    try {
      const rid = Number(id);
      const eid = Number(empresaId);
      logger.info(`Actualizando rol ${rid} a '${nombre}'`);
      return await prisma.role.update({
        where: { id: rid, empresaId: eid },
        data: { nombre }
      });
    } catch (error: unknown) {
      logger.error(`Error al actualizar rol: ${getErrorMessage(error)}`);
      throw new AppError('No se pudo actualizar el rol.', 500);
    }
  }

  async deleteRole(id: string | number, empresaId: string | number) {
    try {
      const rid = Number(id);
      const eid = Number(empresaId);
      logger.info(`Intentando eliminar rol ${rid}`);
      
      // Validar si tiene usuarios asignados
      const usersCount = await prisma.usuario.count({
        where: { roleId: rid }
      });

      if (usersCount > 0) {
        throw new AppError('No se puede eliminar un rol que tiene usuarios asignados.', 400);
      }

      return await prisma.role.delete({
        where: { id: rid, empresaId: eid }
      });
    } catch (error: unknown) {
      if (error instanceof AppError) throw error;
      logger.error(`Error al eliminar rol: ${getErrorMessage(error)}`);
      throw new AppError('No se pudo eliminar el rol.', 500);
    }
  }

  /**
   * Asigna permisos a un rol. 
   * En este esquema, vinculamos el Rol con el EmpresaModulo.
   */
  async assignPermissions(empresaId: string | number, roleId: string | number, empresaModuloIds: number[]) {
    const eid = Number(empresaId);
    const rid = Number(roleId);
    logger.info(`Asignando ${empresaModuloIds.length} permisos al rol ${rid}`);

    // 1. Validar que los EmpresaModulo pertenezcan a la empresa
    const validModules = await prisma.empresaModulo.findMany({
      where: { 
        id: { in: empresaModuloIds },
        empresaId: eid 
      }
    });

    if (validModules.length !== empresaModuloIds.length) {
      throw new AppError('Uno o más módulos no pertenecen a esta empresa.', 400);
    }

    // 2. Eliminar permisos anteriores y crear los nuevos (simplificado)
    return await prisma.$transaction([
      prisma.permission.deleteMany({ where: { roleId: rid } }),
      prisma.permission.createMany({
        data: empresaModuloIds.map(emid => ({
          roleId: rid,
          empresaModuloId: emid,
          activo: true
        }))
      })
    ]);
  }

  async getRolesByEmpresa(empresaId: string | number) {
    return prisma.role.findMany({
      where: { empresaId: Number(empresaId) },
      include: { 
        permisos: { 
          include: { 
            empresaModulo: { 
              include: { modulo: true } 
            } 
          } 
        } 
      }
    });
  }

  async getPermissionMatrix(empresaId: string | number, roleId: string | number) {
    const eid = Number(empresaId);
    const rid = Number(roleId);

    // 1. Obtener los módulos que la empresa tiene activos
    const activeModules = await prisma.empresaModulo.findMany({
      where: { empresaId: eid, activo: true },
      include: { modulo: true }
    });

    // 2. Obtener los permisos actuales del rol
    const currentPermissions = await prisma.permission.findMany({
      where: { roleId: rid }
    });

    // 3. Cruzar información para el frontend
    return activeModules.map(am => {
      const perm = currentPermissions.find(p => p.empresaModuloId === am.id);
      return {
        empresaModuloId: am.id,
        moduloId: am.moduloId,
        nombre: am.modulo.nombre,
        activo: perm?.activo || false
      };
    });
  }
}
