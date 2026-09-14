/**
 * JWT del parametrizador (?token= en /config).
 * panel=preguntas → 365 días. Refresh acepta vencido si la firma es válida.
 * Scope distinto de revision-panel: no se intercambian.
 */
import jwt from 'jsonwebtoken';
import { env } from '../../config/env';
import { verifyPanelToken } from '../funeral-submission/revision-token';

export const CONFIG_TOKEN_TTL = '7d';
export const CONFIG_TOKEN_EXPIRES_SEC = 7 * 24 * 60 * 60;

export const CONFIG_PREGUNTAS_TOKEN_TTL = '365d';
export const CONFIG_PREGUNTAS_TOKEN_EXPIRES_SEC = 365 * 24 * 60 * 60;

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
  const payload = verifyPanelToken(current);

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
