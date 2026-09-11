/**
 * Autoriza escritura de product-config:
 *  - x-api-key del servicio, o
 *  - JWT scope=config-panel (parametrizador), o
 *  - JWT scope=revision-panel solo en funerario/emisión (correos de mesa)
 */
import { Request, Response, NextFunction } from 'express';
import { env } from '../../config/env';
import { verifyPanelToken } from '../funeral-submission/revision-token';

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
  const headerTok =
    req.headers['x-config-token'] ?? req.headers['x-revision-token'];
  if (typeof headerTok === 'string' && headerTok.trim())
    return headerTok.trim();
  const q = req.query?.token;
  if (typeof q === 'string' && q.trim()) return q.trim();
  return null;
}

function allowsRevisionWrite(
  payload: ConfigPanelClaims,
  producto: string,
  modulo: string,
): boolean {
  return (
    payload.scope === 'revision-panel' &&
    String(producto) === 'funerario' &&
    String(modulo) === 'emision' &&
    (!payload.producto || String(payload.producto) === 'funerario') &&
    (!payload.modulo || String(payload.modulo) === 'emision')
  );
}

export function configWriteGuard(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  const apiKey = req.headers['x-api-key'];
  if (apiKey && apiKey === env.API_KEY) {
    (req as Request & { configWriter?: string }).configWriter = 'api-key';
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
    const payload = verifyPanelToken(token) as ConfigPanelClaims;
    const { empresaId, producto, modulo } = req.params;
    const isConfig = payload.scope === 'config-panel';
    const isRevision = allowsRevisionWrite(
      payload,
      String(producto),
      String(modulo),
    );
    if (!isConfig && !isRevision) {
      res.status(403).json({
        success: false,
        message: 'Token inválido: scope distinto de config-panel.',
      });
      return;
    }

    if (Number(payload.empresaId) !== Number(empresaId)) {
      res.status(403).json({
        success: false,
        message: 'Token no autorizado para esta empresa.',
      });
      return;
    }

    if (
      isConfig &&
      (String(payload.producto) !== String(producto) ||
        String(payload.modulo) !== String(modulo))
    ) {
      res.status(403).json({
        success: false,
        message: 'Token no autorizado para este producto/módulo.',
      });
      return;
    }

    (req as Request & { configWriter?: string }).configWriter = String(
      payload.scope ?? '',
    );
    next();
  } catch {
    res.status(403).json({
      success: false,
      message:
        'Token del parametrizador inválido o expirado. Vuelve a abrir desde Nexus Admin.',
    });
  }
}
