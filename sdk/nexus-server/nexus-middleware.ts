/**
 * nexus-middleware.ts — SDK server-side para módulos Exélixi Nexus (TypeScript / Express)
 *
 * ▸ CÓMO USAR (módulo nuevo): copia este archivo a `src/middleware/nexusAuth.ts`
 *   y configura únicamente tu `.env`. NO modifiques este archivo.
 *
 * ▸ Variables de entorno requeridas (.env):
 * ─────────────────────────────────────────────────────────────────────────────
 *   NEXUS_API_URL                  URL del servidor nexus-api
 *                                  Ej: http://192.168.8.120:3092
 *
 *   TENANT_TOKEN_SECRET            Secreto JWT compartido con nexus-api
 *
 *   NEXUS_EXPECTED_SUBMODULO_IDS   ID(s) del submódulo asignado en Nexus Admin
 *                                  Un valor: 17   · Varios: 17,23
 *
 * ▸ Variables de entorno opcionales:
 * ─────────────────────────────────────────────────────────────────────────────
 *   NEXUS_AUTH_ENABLED=true        Activar/desactivar la validación (default: true)
 *
 *   WHITELISTED_ORIGINS            Lista de orígenes que pasan sin token (dev/QA)
 *                                  Ej: 192.168.0.5,localhost
 *
 *   NEXUS_BYPASS_EMPRESA_ID=1      empresaId a usar cuando un origen está en whitelist
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * Versión del SDK: 1.2.0
 * Compatible con: nexus-api >= 1.4.0
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';

// ── Extensión de tipos para req ──────────────────────────────────────────────
declare global {
  namespace Express {
    interface Request {
      empresa?: { id: number };
      submoduloId?: number;
      nexusToken?: string;
      nexusMetadata?: Record<string, unknown>;
    }
  }
}

interface NexusJwtPayload extends jwt.JwtPayload {
  type: string;
  empresaId: number;
  submoduloId: number;
  metadata?: Record<string, unknown>;
}

// ── Configuración desde entorno ──────────────────────────────────────────────
const ENABLED = process.env.NEXUS_AUTH_ENABLED !== 'false';
const SECRET = process.env.TENANT_TOKEN_SECRET ?? '';
const NEXUS_API = (
  process.env.NEXUS_API_URL ?? 'http://192.168.8.120:3092'
).replace(/\/$/, '');
const BYPASS_EMPRESA_ID = parseInt(
  process.env.NEXUS_BYPASS_EMPRESA_ID ?? '1',
  10,
);

const EXPECTED_SUBMODS: number[] = (
  process.env.NEXUS_EXPECTED_SUBMODULO_IDS ??
  process.env.NEXUS_EXPECTED_SUBMODULO_ID ??
  ''
)
  .split(',')
  .map((s) => parseInt(s.trim(), 10))
  .filter((n) => Number.isInteger(n) && n > 0);

const WHITELISTED: string[] = (process.env.WHITELISTED_ORIGINS ?? '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

// ── Helpers ──────────────────────────────────────────────────────────────────

function extractToken(req: Request): string | null {
  const auth =
    req.headers.authorization ??
    (req.headers['x-nexus-token'] as string | undefined);
  if (auth) return auth.replace(/^Bearer\s+/i, '').trim();
  if (req.query.nexus_token) return String(req.query.nexus_token);
  return null;
}

function getRemoteAddr(req: Request): string {
  return (
    req.socket?.remoteAddress ??
    (req.connection as { remoteAddress?: string })?.remoteAddress ??
    ''
  );
}

function isOriginWhitelisted(req: Request): boolean {
  if (!WHITELISTED.length) return false;
  const origin = req.headers.origin ?? '';
  const referer = req.headers.referer ?? '';
  const addr = getRemoteAddr(req);
  return WHITELISTED.some(
    (w) => origin.includes(w) || referer.includes(w) || addr.includes(w),
  );
}

function isInternalProxy(req: Request): boolean {
  const addr = getRemoteAddr(req);
  return addr === '127.0.0.1' || addr === '::ffff:127.0.0.1';
}

async function callHeartbeat(
  token: string,
  req: Request,
  res: Response,
): Promise<boolean> {
  try {
    const hbRes = await fetch(`${NEXUS_API}/api/access/heartbeat`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      signal: AbortSignal.timeout(5000),
    });

    if (!hbRes.ok) return true; // fail-open

    const hb = (await hbRes.json()) as {
      active?: boolean;
      reason?: string;
      access_token?: string;
    };

    if (hb.active === false) {
      res.status(403).json({
        success: false,
        code: 'ACCESS_SUSPENDED',
        message: hb.reason ?? 'Acceso suspendido. Contacte a su administrador.',
      });
      return false;
    }

    if (hb.access_token) {
      req.nexusToken = hb.access_token;
      res.setHeader('X-Nexus-Token-Refreshed', hb.access_token);
      res.setHeader('Access-Control-Expose-Headers', 'X-Nexus-Token-Refreshed');
    }

    return true;
  } catch {
    return true; // fail-open
  }
}

// ── Middleware principal ─────────────────────────────────────────────────────

export async function nexusAuth(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  const token = extractToken(req);

  // ── Bypass de origen (dev / QA) ──────────────────────────────────────────
  if (isOriginWhitelisted(req)) {
    req.empresa = { id: BYPASS_EMPRESA_ID };
    req.submoduloId = EXPECTED_SUBMODS[0] ?? 0;
    req.nexusToken = token ?? '';
    req.nexusMetadata = {};

    if (token) {
      try {
        const decoded = jwt.decode(token);
        if (decoded && typeof decoded === 'object') {
          req.nexusMetadata = (decoded as NexusJwtPayload).metadata ?? {};
        }
      } catch {
        /* ignorar */
      }
    }

    next();
    return;
  }

  // ── Modo sin autenticación ───────────────────────────────────────────────
  if (!ENABLED) {
    if (token) {
      try {
        const decoded = jwt.decode(token);
        if (decoded && typeof decoded === 'object') {
          const p = decoded as NexusJwtPayload;
          req.empresa = { id: p.empresaId };
          req.submoduloId = p.submoduloId;
          req.nexusMetadata = p.metadata ?? {};
        }
      } catch {
        /* ignorar */
      }
    }
    next();
    return;
  }

  // ── Validaciones de config ───────────────────────────────────────────────
  if (!SECRET) {
    res.status(500).json({
      success: false,
      code: 'NEXUS_AUTH_MISCONFIGURED',
      message: 'TENANT_TOKEN_SECRET no está configurado en el backend.',
    });
    return;
  }

  if (!token) {
    if (isInternalProxy(req)) {
      next();
      return;
    }
    res.status(401).json({
      success: false,
      code: 'NEXUS_TOKEN_MISSING',
      message: 'Token de acceso requerido (Authorization: Bearer <token>).',
    });
    return;
  }

  // ── Verificación JWT ─────────────────────────────────────────────────────
  let payload: NexusJwtPayload;
  try {
    payload = jwt.verify(token, SECRET) as NexusJwtPayload;
  } catch {
    res.status(401).json({
      success: false,
      code: 'NEXUS_TOKEN_INVALID',
      message: 'Token inválido o expirado.',
    });
    return;
  }

  if (payload.type !== 'tenant_access') {
    res
      .status(401)
      .json({
        success: false,
        code: 'NEXUS_TOKEN_INVALID_TYPE',
        message: 'Tipo de token inválido.',
      });
    return;
  }

  if (!payload.empresaId || !payload.submoduloId) {
    res
      .status(401)
      .json({
        success: false,
        code: 'NEXUS_TOKEN_INCOMPLETE',
        message: 'El token no contiene empresaId/submoduloId.',
      });
    return;
  }

  if (
    !isInternalProxy(req) &&
    EXPECTED_SUBMODS.length > 0 &&
    !EXPECTED_SUBMODS.includes(payload.submoduloId)
  ) {
    res.status(403).json({
      success: false,
      code: 'NEXUS_TOKEN_WRONG_SUBMODULE',
      message: `Token emitido para submódulo ${payload.submoduloId}, este backend espera ${EXPECTED_SUBMODS.join(', ')}.`,
    });
    return;
  }

  req.empresa = { id: payload.empresaId };
  req.submoduloId = payload.submoduloId;
  req.nexusToken = token;
  req.nexusMetadata = payload.metadata ?? {};

  // ── Heartbeat ────────────────────────────────────────────────────────────
  const continued = await callHeartbeat(token, req, res);
  if (!continued) return;

  next();
}

export default nexusAuth;
