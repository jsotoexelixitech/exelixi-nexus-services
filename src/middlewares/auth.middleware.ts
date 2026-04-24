import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import { decrypt } from '../utils/crypto';

export interface AuthRequest extends Request {
  user?: {
    id: string;
    email: string;
    empresaId: string;
    roleId: string;
  };
}

export const authenticate = (req: AuthRequest, res: Response, next: NextFunction) => {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ success: false, message: 'Acceso denegado: Token no proporcionado.' });
  }

  const encryptedToken = authHeader.split(' ')[1];

  try {
    // 1. Desencriptar el string para obtener el JWT real
    const token = decrypt(encryptedToken);

    // 2. Verificar el JWT
    const decoded = jwt.verify(token, process.env.JWT_SECRET || 'secret') as any;
    req.user = decoded;
    next();
  } catch (error: any) {
    return res.status(401).json({ 
      success: false, 
      message: 'Token inválido, expirado o corrupto.' 
    });
  }
};
