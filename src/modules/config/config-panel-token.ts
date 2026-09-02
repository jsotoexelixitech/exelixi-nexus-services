/**
 * JWT del parametrizador (?token= en /config). 12 h + refresh con la pestaña abierta.
 * panel=preguntas → 365 días (URL de larga duración para solo cuestionario).
 * Scope distinto de revision-panel: no se intercambian.
 */
import jwt from 'jsonwebtoken';
import { env } from '../../config/env';

export const CONFIG_TOKEN_TTL = '12h';
export const CONFIG_TOKEN_EXPIRES_SEC = 12 * 60 * 60;
const EXPIRED_GRACE_MS = 12 * 60 * 60 * 1000;

export const CONFIG_PREGUNTAS_TOKEN_TTL = '365d';
export const CONFIG_PREGUNTAS_TOKEN_EXPIRES_SEC = 365 * 24 * 60 * 60;
const PREGUNTAS_EXPIRED_GRACE_MS = 90 * 24 * 60 * 60 * 1000;

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
  longLived?: boolean;
};

export type SignConfigPanelTokenOptions = {
  longLived?: boolean;
};

export function signConfigPanelToken(
  claims: ConfigPanelTokenClaims,
  options?: SignConfigPanelTokenOptions,
): {
  token: string;
  expiresIn: number;
} {
  const longLived = options?.longLived === true || claims.longLived === true;
  const ttl = longLived ? CONFIG_PREGUNTAS_TOKEN_TTL : CONFIG_TOKEN_TTL;
  const expiresIn = longLived
    ? CONFIG_PREGUNTAS_TOKEN_EXPIRES_SEC
    : CONFIG_TOKEN_EXPIRES_SEC;
  const token = jwt.sign(
    {
      ...claims,
      scope: 'config-panel',
      ...(longLived ? { longLived: true } : {}),
    },
    env.JWT_SECRET,
    { expiresIn: ttl },
  );
  return { token, expiresIn };
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
    const longLived = payload.longLived === true;
    const graceMs = longLived ? PREGUNTAS_EXPIRED_GRACE_MS : EXPIRED_GRACE_MS;
    const expMs = Number(payload.exp ?? 0) * 1000;
    if (!expMs || Date.now() - expMs > graceMs) {
      throw new Error(
        longLived
          ? 'Token del parametrizador (preguntas) expirado. Genera una nueva URL desde Nexus.'
          : 'Token del parametrizador expirado. Abre de nuevo la URL desde Nexus.',
        { cause: err },
      );
    }
  }

  if (String(payload.scope ?? '') !== 'config-panel') {
    throw new Error('Token inválido: no es del parametrizador.');
  }

  const longLived = payload.longLived === true;

  return signConfigPanelToken(
    {
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
      longLived,
    },
    { longLived },
  );
}
