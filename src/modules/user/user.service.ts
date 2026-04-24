import { Usuario } from '@prisma/client';
import bcrypt from 'bcrypt';
import logger from '../../utils/logger';
import prisma from '../../config/prisma';
import { AppError } from '../../utils/app-error';

export class UserService {
  /**
   * Crea un usuario vinculado a una empresa y un rol.
   */
  async createUser(empresaId: string, data: Omit<Usuario, 'id' | 'createdAt' | 'updatedAt' | 'empresaId' | 'activo'>) {
    try {
      logger.info(`Intentando crear usuario ${data.email} en empresa ${empresaId}`);
      // 1. Validar que el rol pertenezca a la empresa
      const role = await prisma.role.findFirst({
        where: { 
          id: data.roleId, 
          empresaId 
        }
      });

      if (!role) {
        throw new AppError('El rol seleccionado no es válido para su empresa.', 400);
      }

      // 2. Hash de contraseña
      const hashedPassword = await bcrypt.hash(data.password, 10);

      // 3. Crear usuario
      return await prisma.usuario.create({
        data: {
          ...data,
          password: hashedPassword,
          empresaId,
          activo: true
        }
      });
    } catch (error: any) {
      if (error.code === 'P2002') {
        throw new AppError('Este correo electrónico ya está registrado en el sistema.', 400);
      }
      if (error instanceof AppError) throw error;
      logger.error(`Error al crear usuario: ${error.message}`);
      throw new AppError('No se pudo crear el usuario. Verifique los datos.', 500);
    }
  }

  async updateUser(id: string, empresaId: string, data: Partial<Usuario>) {
    try {
      logger.info(`Actualizando usuario ${id}`);
      
      if (data.password) {
        data.password = await bcrypt.hash(data.password, 10);
      }

      return await prisma.usuario.update({
        where: { id, empresaId },
        data
      });
    } catch (error: any) {
      logger.error(`Error al actualizar usuario: ${error.message}`);
      throw new AppError('No se pudo actualizar la información del usuario.', 500);
    }
  }

  async toggleUserStatus(id: string, empresaId: string) {
    try {
      const user = await prisma.usuario.findUnique({ where: { id, empresaId } });
      if (!user) throw new AppError('Usuario no encontrado en su empresa.', 404);

      logger.info(`Cambiando estado de usuario ${id} a ${!user.activo}`);
      return await prisma.usuario.update({
        where: { id, empresaId },
        data: { activo: !user.activo }
      });
    } catch (error: any) {
      if (error instanceof AppError) throw error;
      logger.error(`Error al cambiar estado de usuario: ${error.message}`);
      throw new AppError('No se pudo cambiar el estado del usuario.', 500);
    }
  }

  async changePassword(id: string, empresaId: string, currentPass: string, newPass: string) {
    try {
      const user = await prisma.usuario.findUnique({ where: { id, empresaId } });
      if (!user) throw new AppError('Usuario no identificado.', 404);

      const isMatch = await bcrypt.compare(currentPass, user.password);
      if (!isMatch) throw new AppError('La contraseña actual es incorrecta. Verifique e intente de nuevo.', 401);

      const hashedPassword = await bcrypt.hash(newPass, 10);
      return await prisma.usuario.update({
        where: { id, empresaId },
        data: { password: hashedPassword }
      });
    } catch (error: any) {
      if (error instanceof AppError) throw error;
      logger.error(`Error al cambiar contraseña: ${error.message}`);
      throw new AppError('No se pudo actualizar la contraseña.', 500);
    }
  }

  async getUsersByEmpresa(empresaId: string, skip: number, take: number) {
    try {
      const [users, total] = await Promise.all([
        prisma.usuario.findMany({
          where: { empresaId },
          skip,
          take,
          include: { role: true },
        }),
        prisma.usuario.count({ where: { empresaId } })
      ]);

      return { users, total };
    } catch (error: any) {
      logger.error(`Error al listar usuarios: ${error.message}`);
      throw new AppError('Error al recuperar el listado de usuarios.', 500);
    }
  }
}
