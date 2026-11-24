/**
 * JWT de la vista técnica funerario.
 * Vigencia larga (365 d). Si la firma es válida, se acepta aunque `exp` ya pasó
 * para que refresh-token y el listado no corten la mesa técnica.
 */
import jwt from 'jsonwebtoken';
import { env } from '../../config/env';
import { decrypt } from '../../utils/crypto';

export const REVISION_TOKEN_TTL = '365d';
export const REVISION_TOKEN_EXPIRES_SEC = 365 * 24 * 60 * 60;

export type RevisionTokenClaims = {
  empresaId: number;
  empresaNombre?: string;
  producto?: string;
  modulo?: string;
  scope: string;
  canal?: string;
  cproductor?: string;
  cusuario?: string;
  reviewerEmail?: string;
  reviewerNombre?: string;
  metadata?: Record<string, unknown>;
};

function isPanelScope(scope: string): boolean {
  return scope === 'revision-panel' || scope === 'config-panel';
}

/** Quita Bearer, espacios y desencripta el JWT de login Nexus si vino cifrado. */
export function normalizePanelToken(raw: string): string {
  let t = String(raw || '')
    .replace(/^Bearer\s+/i, '')
    .replace(/\s+/g, '')
    .trim();
  if (!t) return '';
  try {
    if (/%[0-9A-Fa-f]{2}/.test(t) && t.split('.').length < 3) {
      t = decodeURIComponent(t);
    }
  } catch {
    /* ignore */
  }
  if (t.includes(':') && t.split('.').length < 3) {
    try {
      t = decrypt(t);
    } catch {
      /* token plano inválido: lo verifica jwt.verify */
    }
  }
  return t;
}

/**
 * Verifica JWT de vista técnica / parametrizador.
 * Firma válida ⇒ se acepta aunque esté vencido (la mesa no debe caerse).
 */
export function verifyPanelToken(current: string): jwt.JwtPayload {
  const token = normalizePanelToken(current);
  if (!token) {
    throw new Error('Token de revisión inválido o expirado.');
  }
  const opts: jwt.VerifyOptions = { clockTolerance: 86400 };
  try {
    return jwt.verify(token, env.JWT_SECRET, opts) as jwt.JwtPayload;
  } catch (err) {
    try {
      return jwt.verify(token, env.JWT_SECRET, {
        ...opts,
        ignoreExpiration: true,
      }) as jwt.JwtPayload;
    } catch {
      throw new Error('Token de revisión inválido o expirado.', { cause: err });
    }
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
    reviewerEmail:
      typeof payload.reviewerEmail === 'string'
        ? payload.reviewerEmail
        : undefined,
    reviewerNombre:
      typeof payload.reviewerNombre === 'string'
        ? payload.reviewerNombre
        : undefined,
    metadata:
      payload.metadata && typeof payload.metadata === 'object'
        ? (payload.metadata as Record<string, unknown>)
        : undefined,
  });
}
