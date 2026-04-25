import bcrypt from 'bcrypt';
import jwt from 'jsonwebtoken';
import { AppError } from '../../utils/app-error';
import logger from '../../utils/logger';
import prisma from '../../config/prisma';
import { getErrorMessage } from '../../utils/error-handler';
import { encrypt } from '../../utils/crypto';

export class AuthService {
  /**
   * Autentica a un usuario y genera un token JWT con el contexto de su empresa y rol.
   */
  async login(email: string, password: string) {
    try {
      logger.info(`Intento de login para: ${email}`);

      const user = await prisma.usuario.findUnique({
        where: { email },
        include: {
          empresa: true,
          role: true
        }
      });

      if (!user) {
        logger.warn(`Login fallido: Usuario no encontrado (${email})`);
        throw new AppError('El correo electrónico no está registrado.', 401);
      }

      if (!user.activo) {
        logger.warn(`Login bloqueado: Cuenta inactiva (${email})`);
        throw new AppError('Su cuenta ha sido desactivada. Por favor, contacte con soporte técnico.', 403);
      }

      // Verificar contraseña
      const isPasswordValid = await bcrypt.compare(password, user.password);

      if (!isPasswordValid) {
        logger.warn(`Login fallido: Contraseña incorrecta (${email})`);
        throw new AppError('La contraseña ingresada es incorrecta.', 401);
      }

      logger.info(`Login exitoso: ${email} [Empresa: ${user.empresa.nombre}]`);

      // Firmar token con contexto de multi-tenencia
      const rawToken = jwt.sign(
        {
          id: user.id,
          email: user.email,
          empresaId: user.empresaId,
          roleId: user.roleId
        },
        process.env.JWT_SECRET || 'secret',
        { expiresIn: '12h' }
      );

      // --- ENCRIPTACIÓN DEL TOKEN ---
      // Esto hace que el JWT no sea legible por el cliente (privacidad total)
      const token = encrypt(rawToken);

      return {
        token,
        user: {
          id: user.id,
          nombre: user.nombre,
          email: user.email,
          empresa: user.empresa.nombre,
          role: user.role.nombre
        }
      };
    } catch (error: unknown) {
      if (error instanceof AppError) throw error;
      logger.error(`Error crítico en AuthService.login: ${getErrorMessage(error)}`);
      throw new AppError('Error interno durante la autenticación. Intente más tarde.', 500);
    }
  }
}
