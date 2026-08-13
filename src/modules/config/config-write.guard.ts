/**
 * Autoriza escritura de product-config:
 *  - x-api-key del servicio, o
 *  - JWT scope=config-panel (el que abre Nexus admin en ?token=)
 */
import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import { env } from '../../config/env';

type ConfigPanelClaims = {
  empresaId?: number;
  producto?: string;
  modulo?: string;
  scope?: string;
};

function extractConfigToken(req: Request): string | null {
  const auth = req.headers.authorization;
  if (auth && typeof auth === 'string') {
    const m = auth.match(/^Bearer\s+(.+)$/i);
    if (m?.[1]) return m[1].trim();
  }
  const headerTok = req.headers['x-config-token'];
  if (typeof headerTok === 'string' && headerTok.trim()) return headerTok.trim();
  const q = req.query?.token;
  if (typeof q === 'string' && q.trim()) return q.trim();
  return null;
}

export function configWriteGuard(req: Request, res: Response, next: NextFunction): void {
  const apiKey = req.headers['x-api-key'];
  if (apiKey && apiKey === env.API_KEY) {
    next();
    return;
  }

  const token = extractConfigToken(req);
  if (!token) {
    res.status(403).json({
      success: false,
      message:
        'Acceso denegado: falta token del parametrizador (?token=) o x-api-key.',
    });
    return;
  }

  try {
    const payload = jwt.verify(token, env.JWT_SECRET) as ConfigPanelClaims;
    if (payload.scope !== 'config-panel') {
      res.status(403).json({
        success: false,
        message: 'Token inválido: scope distinto de config-panel.',
      });
      return;
    }

    const { empresaId, producto, modulo } = req.params;
    if (
      Number(payload.empresaId) !== Number(empresaId) ||
      String(payload.producto) !== String(producto) ||
      String(payload.modulo) !== String(modulo)
    ) {
      res.status(403).json({
        success: false,
        message: 'Token no autorizado para este producto/módulo.',
      });
      return;
    }

    next();
  } catch {
    res.status(403).json({
      success: false,
      message: 'Token del parametrizador inválido o expirado. Vuelve a abrir desde Nexus Admin.',
    });
  }
}
