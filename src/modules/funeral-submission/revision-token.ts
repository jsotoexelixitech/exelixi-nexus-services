/**
 * JWT de la vista técnica funerario. 12 h + refresh mientras el tab está abierto.
 */
import jwt from 'jsonwebtoken';
import { env } from '../../config/env';

export const REVISION_TOKEN_TTL = '12h';
export const REVISION_TOKEN_EXPIRES_SEC = 12 * 60 * 60;
/** Permite refrescar un token vencido con la pestaña abierta (todo el día). */
const EXPIRED_GRACE_MS = 12 * 60 * 60 * 1000;

export type RevisionTokenClaims = {
  empresaId: number;
  empresaNombre?: string;
  producto?: string;
  modulo?: string;
  scope: string;
  canal?: string;
  cproductor?: string;
  cusuario?: string;
  metadata?: Record<string, unknown>;
};

function isPanelScope(scope: string): boolean {
  return scope === 'revision-panel' || scope === 'config-panel';
}

/**
 * Verifica JWT de vista técnica / parametrizador.
 * Acepta vencido si está dentro de la gracia (pestaña abierta).
 */
export function verifyPanelToken(current: string): jwt.JwtPayload {
  try {
    return jwt.verify(current, env.JWT_SECRET) as jwt.JwtPayload;
  } catch (err) {
    const expired =
      err instanceof jwt.TokenExpiredError ||
      (err instanceof Error && err.name === 'TokenExpiredError');
    if (!expired) {
      throw new Error('Token de revisión inválido.', { cause: err });
    }
    const payload = jwt.verify(current, env.JWT_SECRET, {
      ignoreExpiration: true,
    }) as jwt.JwtPayload;
    const expMs = Number(payload.exp ?? 0) * 1000;
    if (!expMs || Date.now() - expMs > EXPIRED_GRACE_MS) {
      throw new Error(
        'Token de revisión expirado. Genera un enlace nuevo desde Nexus.',
        { cause: err },
      );
    }
    return payload;
  }
}

export function signRevisionToken(claims: RevisionTokenClaims): {
  token: string;
  expiresIn: number;
} {
  const token = jwt.sign(
    { ...claims, scope: 'revision-panel' },
    env.JWT_SECRET,
    { expiresIn: REVISION_TOKEN_TTL },
  );
  return { token, expiresIn: REVISION_TOKEN_EXPIRES_SEC };
}

export function refreshRevisionToken(current: string): {
  token: string;
  expiresIn: number;
} {
  const payload = verifyPanelToken(current);
  const scope = String(payload.scope ?? '');
  if (!isPanelScope(scope)) {
    throw new Error('Token inválido: scope distinto de revision-panel.');
  }

  return signRevisionToken({
    empresaId: Number(payload.empresaId),
    empresaNombre:
      typeof payload.empresaNombre === 'string'
        ? payload.empresaNombre
        : undefined,
    producto:
      typeof payload.producto === 'string' ? payload.producto : 'funerario',
    modulo: typeof payload.modulo === 'string' ? payload.modulo : 'emision',
    scope: 'revision-panel',
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
