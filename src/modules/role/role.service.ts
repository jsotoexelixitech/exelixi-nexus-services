import logger from "../../utils/logger";
import prisma from "../../config/prisma";
import { AppError } from "../../utils/app-error";
import { getErrorMessage } from "../../utils/error-handler";

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
          activo: true,
        },
      });
    } catch (error: unknown) {
      logger.error(`Error al crear rol: ${getErrorMessage(error)}`);
      throw new AppError("No se pudo crear el rol.", 500);
    }
  }

  async updateRole(
    id: string | number,
    empresaId: string | number,
    nombre: string,
  ) {
    try {
      const rid = Number(id);
      const eid = Number(empresaId);
      logger.info(`Actualizando rol ${rid} a '${nombre}'`);
      return await prisma.role.update({
        where: { id: rid, empresaId: eid },
        data: { nombre },
      });
    } catch (error: unknown) {
      logger.error(`Error al actualizar rol: ${getErrorMessage(error)}`);
      throw new AppError("No se pudo actualizar el rol.", 500);
    }
  }

  async deleteRole(id: string | number, empresaId: string | number) {
    try {
      const rid = Number(id);
      const eid = Number(empresaId);
      logger.info(`Intentando eliminar rol ${rid}`);

      // Validar si tiene usuarios asignados
      const usersCount = await prisma.usuario.count({
        where: { roleId: rid },
      });

      if (usersCount > 0) {
        throw new AppError(
          "No se puede eliminar un rol que tiene usuarios asignados.",
          400,
        );
      }

      return await prisma.role.delete({
        where: { id: rid, empresaId: eid },
      });
    } catch (error: unknown) {
      if (error instanceof AppError) throw error;
      logger.error(`Error al eliminar rol: ${getErrorMessage(error)}`);
      throw new AppError("No se pudo eliminar el rol.", 500);
    }
  }

  /**
   * Asigna permisos granulares a un rol.
   * Maneja tanto la tabla legacy (rol_modulo) como la nueva (rol_permiso_detalle).
   */
  async assignPermissions(
    empresaId: string | number,
    roleId: string | number,
    permissions: any[],
  ) {
    const eid = Number(empresaId);
    const rid = Number(roleId);
    logger.info(`Asignando permisos granulares al rol ${rid}`);

    // Preparar transacción
    return await prisma.$transaction(async (tx) => {
      // 1. Limpiar permisos actuales
      await tx.permission.deleteMany({ where: { roleId: rid } });
      await tx.rolePermissionDetail.deleteMany({ where: { roleId: rid } });

      for (const p of permissions) {
        // A. Validar y Activar en tabla legacy (rol_modulo)
        // Buscamos el ID de EmpresaModulo que corresponde a este moduloId
        const emmo = await tx.empresaModulo.findFirst({
          where: { empresaId: eid, moduloId: p.moduloId },
        });

        if (emmo) {
          await tx.permission.create({
            data: {
              roleId: rid,
              empresaModuloId: emmo.id,
              activo: true,
            },
          });

          // B. Guardar detalle granular del Módulo
          await tx.rolePermissionDetail.create({
            data: {
              roleId: rid,
              moduloId: p.moduloId,
              canCreate: p.canCreate ?? false,
              canRead: p.canRead ?? true,
              canUpdate: p.canUpdate ?? false,
              canDelete: p.canDelete ?? false,
            },
          });

          // C. Guardar detalle granular de Submódulos (si hay)
          if (p.submodulos && Array.isArray(p.submodulos)) {
            for (const sm of p.submodulos) {
              await tx.rolePermissionDetail.create({
                data: {
                  roleId: rid,
                  moduloId: p.moduloId,
                  submoduloId: sm.submoduloId,
                  canCreate: sm.canCreate ?? false,
                  canRead: sm.canRead ?? true,
                  canUpdate: sm.canUpdate ?? false,
                  canDelete: sm.canDelete ?? false,
                },
              });
            }
          }
        }
      }

      return { success: true };
    });
  }

  async getRolesByEmpresa(empresaId: string | number) {
    return prisma.role.findMany({
      where: { empresaId: Number(empresaId) },
    });
  }

  async getPermissionMatrix(
    empresaId: string | number,
    roleId: string | number,
  ) {
    const eid = Number(empresaId);
    const rid = Number(roleId);

    // 1. Obtener los módulos que la empresa tiene activos
    const activeModules = await prisma.empresaModulo.findMany({
      where: { empresaId: eid, activo: true },
      include: {
        modulo: {
          include: { submodulos: true },
        },
      },
    });

    // 2. Obtener el detalle granular actual del rol
    const granularDetails = await prisma.rolePermissionDetail.findMany({
      where: { roleId: rid },
    });

    // 3. Cruzar información para el frontend
    return activeModules.map((am) => {
      const moduleDetail = granularDetails.find(
        (d) => d.moduloId === am.moduloId && !d.submoduloId,
      );

      return {
        moduloId: am.moduloId,
        nombre: am.modulo.nombre,
        activo: !!moduleDetail,
        canCreate: moduleDetail?.canCreate || false,
        canRead: moduleDetail?.canRead || false,
        canUpdate: moduleDetail?.canUpdate || false,
        canDelete: moduleDetail?.canDelete || false,
        submodulos: am.modulo.submodulos.map((sm) => {
          const smDetail = granularDetails.find((d) => d.submoduloId === sm.id);
          return {
            submoduloId: sm.id,
            nombre: sm.nombre,
            activo: !!smDetail,
            canCreate: smDetail?.canCreate || false,
            canRead: smDetail?.canRead || false,
            canUpdate: smDetail?.canUpdate || false,
            canDelete: smDetail?.canDelete || false,
          };
        }),
      };
    });
  }
}
