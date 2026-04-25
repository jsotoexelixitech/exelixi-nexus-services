import { Usuario } from '@prisma/client';
import * as bcrypt from 'bcrypt';
import logger from '../../utils/logger';
import prisma from '../../config/prisma';
import { AppError } from '../../utils/app-error';

export class UserService {
  /**
   * Crea un usuario vinculado a una empresa y un rol.
   */
  async createUser(empresaId: string | number, data: Omit<Usuario, 'id' | 'createdAt' | 'empresaId' | 'activo'>) {
    try {
      const eid = Number(empresaId);
      logger.info(`Intentando crear usuario ${data.email} en empresa ${eid}`);
      
      // 1. Validar que el rol pertenezca a la empresa
      const role = await prisma.role.findFirst({
        where: { 
          id: data.roleId, 
          empresaId: eid 
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
          empresaId: eid,
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

  async updateUser(id: string | number, empresaId: string | number, data: Partial<Usuario>) {
    try {
      const uid = Number(id);
      const eid = Number(empresaId);
      logger.info(`Actualizando usuario ${uid}`);
      
      if (data.password) {
        data.password = await bcrypt.hash(data.password, 10);
      }

      return await prisma.usuario.update({
        where: { id: uid, empresaId: eid },
        data
      });
    } catch (error: any) {
      logger.error(`Error al actualizar usuario: ${error.message}`);
      throw new AppError('No se pudo actualizar la información del usuario.', 500);
    }
  }

  async toggleUserStatus(id: string | number, empresaId: string | number) {
    try {
      const uid = Number(id);
      const eid = Number(empresaId);
      const user = await prisma.usuario.findUnique({ where: { id: uid, empresaId: eid } });
      if (!user) throw new AppError('Usuario no encontrado en su empresa.', 404);

      logger.info(`Cambiando estado de usuario ${uid} a ${!user.activo}`);
      return await prisma.usuario.update({
        where: { id: uid, empresaId: eid },
        data: { activo: !user.activo }
      });
    } catch (error: any) {
      if (error instanceof AppError) throw error;
      logger.error(`Error al cambiar estado de usuario: ${error.message}`);
      throw new AppError('No se pudo cambiar el estado del usuario.', 500);
    }
  }

  async changePassword(id: string | number, empresaId: string | number, currentPass: string, newPass: string) {
    try {
      const uid = Number(id);
      const eid = Number(empresaId);
      const user = await prisma.usuario.findUnique({ where: { id: uid, empresaId: eid } });
      if (!user) throw new AppError('Usuario no identificado.', 404);

      const isMatch = await bcrypt.compare(currentPass, user.password);
      if (!isMatch) throw new AppError('La contraseña actual es incorrecta. Verifique e intente de nuevo.', 401);

      const hashedPassword = await bcrypt.hash(newPass, 10);
      return await prisma.usuario.update({
        where: { id: uid, empresaId: eid },
        data: { password: hashedPassword }
      });
    } catch (error: any) {
      if (error instanceof AppError) throw error;
      logger.error(`Error al cambiar contraseña: ${error.message}`);
      throw new AppError('No se pudo actualizar la contraseña.', 500);
    }
  }

  async getUsersByEmpresa(empresaId: string | number, skip: number, take: number) {
    try {
      const eid = Number(empresaId);
      const [users, total] = await Promise.all([
        prisma.usuario.findMany({
          where: { empresaId: eid },
          skip,
          take,
          include: { role: true },
        }),
        prisma.usuario.count({ where: { empresaId: eid } })
      ]);

      return { users, total };
    } catch (error: any) {
      logger.error(`Error al listar usuarios: ${error.message}`);
      throw new AppError('Error al recuperar el listado de usuarios.', 500);
    }
  }
}
