/**
 * Autoriza lectura/revisión de solicitudes funerario:
 *  - x-api-key del servicio, o
 *  - JWT scope=revision-panel | config-panel (misma empresa)
 */
import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import { env } from '../../config/env';

type RevisionClaims = {
  empresaId?: number;
  producto?: string;
  scope?: string;
};

function extractToken(req: Request): string | null {
  const auth = req.headers.authorization;
  if (auth && typeof auth === 'string') {
    const m = auth.match(/^Bearer\s+(.+)$/i);
    if (m?.[1]) return m[1].trim();
  }
  const headerTok =
    req.headers['x-revision-token'] ?? req.headers['x-config-token'];
  if (typeof headerTok === 'string' && headerTok.trim())
    return headerTok.trim();
  const q = req.query?.token;
  if (typeof q === 'string' && q.trim()) return q.trim();
  return null;
}

export function revisionPanelGuard(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  const apiKey = req.headers['x-api-key'];
  if (apiKey && apiKey === env.API_KEY) {
    next();
    return;
  }

  const token = extractToken(req);
  if (!token) {
    res.status(403).json({
      success: false,
      message:
        'Acceso denegado: falta token de revisión (?token=) o x-api-key.',
    });
    return;
  }

  try {
    const payload = jwt.verify(token, env.JWT_SECRET) as RevisionClaims;
    const scope = String(payload.scope ?? '');
    if (scope !== 'revision-panel' && scope !== 'config-panel') {
      res.status(403).json({
        success: false,
        message: 'Token inválido: scope distinto de revision-panel.',
      });
      return;
    }

    const empresaParam = req.params.empresaId ?? req.query.empresaId;
    if (
      empresaParam != null &&
      Number(payload.empresaId) !== Number(empresaParam)
    ) {
      res.status(403).json({
        success: false,
        message: 'Token no autorizado para esta empresa.',
      });
      return;
    }

    if (payload.producto && String(payload.producto) !== 'funerario') {
      res.status(403).json({
        success: false,
        message: 'Token no autorizado para productos distintos de funerario.',
      });
      return;
    }

    (req as Request & { revisionClaims?: RevisionClaims }).revisionClaims =
      payload;
    next();
  } catch {
    res.status(403).json({
      success: false,
      message: 'Token de revisión inválido o expirado.',
    });
  }
}
