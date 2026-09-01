/**
 * JWT del parametrizador (?token= en /config). 12 h + refresh con la pestaña abierta.
 * Scope distinto de revision-panel: no se intercambian.
 */
import jwt from 'jsonwebtoken';
import { env } from '../../config/env';

export const CONFIG_TOKEN_TTL = '12h';
export const CONFIG_TOKEN_EXPIRES_SEC = 12 * 60 * 60;
const EXPIRED_GRACE_MS = 2 * 60 * 60 * 1000;

export type ConfigPanelTokenClaims = {
  empresaId: number;
  empresaNombre?: string;
  producto: string;
  modulo: string;
  scope: string;
  canal?: string;
  cproductor?: string;
  cusuario?: string;
  metadata?: Record<string, unknown>;
};

export function signConfigPanelToken(claims: ConfigPanelTokenClaims): {
  token: string;
  expiresIn: number;
} {
  const token = jwt.sign({ ...claims, scope: 'config-panel' }, env.JWT_SECRET, {
    expiresIn: CONFIG_TOKEN_TTL,
  });
  return { token, expiresIn: CONFIG_TOKEN_EXPIRES_SEC };
}

export function refreshConfigPanelToken(current: string): {
  token: string;
  expiresIn: number;
} {
  let payload: jwt.JwtPayload;
  try {
    payload = jwt.verify(current, env.JWT_SECRET) as jwt.JwtPayload;
  } catch (err) {
    const expired =
      err instanceof jwt.TokenExpiredError ||
      (err instanceof Error && err.name === 'TokenExpiredError');
    if (!expired) {
      throw new Error('Token del parametrizador inválido.', { cause: err });
    }
    payload = jwt.verify(current, env.JWT_SECRET, {
      ignoreExpiration: true,
    }) as jwt.JwtPayload;
    const expMs = Number(payload.exp ?? 0) * 1000;
    if (!expMs || Date.now() - expMs > EXPIRED_GRACE_MS) {
      throw new Error(
        'Token del parametrizador expirado. Abre de nuevo la URL desde Nexus.',
        { cause: err },
      );
    }
  }

  if (String(payload.scope ?? '') !== 'config-panel') {
    throw new Error('Token inválido: no es del parametrizador.');
  }

  return signConfigPanelToken({
    empresaId: Number(payload.empresaId),
    empresaNombre:
      typeof payload.empresaNombre === 'string'
        ? payload.empresaNombre
        : undefined,
    producto:
      typeof payload.producto === 'string' ? payload.producto : 'funerario',
    modulo: typeof payload.modulo === 'string' ? payload.modulo : 'emision',
    scope: 'config-panel',
    canal: typeof payload.canal === 'string' ? payload.canal : undefined,
    cproductor:
      typeof payload.cproductor === 'string' ? payload.cproductor : undefined,
    cusuario:
      typeof payload.cusuario === 'string' ? payload.cusuario : undefined,
    metadata:
      payload.metadata && typeof payload.metadata === 'object'
        ? (payload.metadata as Record<string, unknown>)
        : undefined,
  });
}
