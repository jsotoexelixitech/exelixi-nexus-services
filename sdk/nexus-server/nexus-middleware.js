/**
 * nexus-middleware.js — SDK server-side para módulos Exélixi Nexus (Node.js / Express)
 *
 * ▸ CÓMO USAR (módulo nuevo): copia este archivo a `src/middleware/nexusAuth.js`
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
 * ▸ Qué inyecta en req:
 * ─────────────────────────────────────────────────────────────────────────────
 *   req.empresa        { id: number }         — tenant activo
 *   req.submoduloId    number                 — submódulo del token
 *   req.nexusToken     string                 — token activo (renovado si heartbeat lo dio)
 *   req.nexusMetadata  object                 — metadata del token SSO (cproductor, canal…)
 *
 * ▸ Headers que expone al cliente frontend:
 * ─────────────────────────────────────────────────────────────────────────────
 *   X-Nexus-Token-Refreshed        Nuevo access_token si fue renovado en este ciclo
 *   Access-Control-Expose-Headers  X-Nexus-Token-Refreshed (para lectura desde browser)
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * Versión del SDK: 1.2.0
 * Compatible con: nexus-api >= 1.4.0
 * ─────────────────────────────────────────────────────────────────────────────
 */

'use strict';

const jwt = require('jsonwebtoken');

// ── Configuración desde entorno ──────────────────────────────────────────────
const ENABLED = process.env.NEXUS_AUTH_ENABLED !== 'false'; // activo por defecto
const SECRET = process.env.TENANT_TOKEN_SECRET || '';
const NEXUS_API = (
  process.env.NEXUS_API_URL || 'http://192.168.8.120:3092'
).replace(/\/$/, '');
const BYPASS_EMPRESA_ID = parseInt(
  process.env.NEXUS_BYPASS_EMPRESA_ID || '1',
  10,
);

const EXPECTED_SUBMODS = (
  process.env.NEXUS_EXPECTED_SUBMODULO_IDS ||
  process.env.NEXUS_EXPECTED_SUBMODULO_ID ||
  ''
)
  .split(',')
  .map((s) => parseInt(s.trim(), 10))
  .filter((n) => Number.isInteger(n) && n > 0);

const WHITELISTED = (process.env.WHITELISTED_ORIGINS || '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

// ── Helpers ──────────────────────────────────────────────────────────────────

function extractToken(req) {
  const auth = req.headers.authorization || req.headers['x-nexus-token'];
  if (auth && typeof auth === 'string') {
    return auth.replace(/^Bearer\s+/i, '').trim();
  }
  if (req.query && req.query.nexus_token) {
    return String(req.query.nexus_token);
  }
  return null;
}

function getRemoteAddr(req) {
  return req.socket?.remoteAddress ?? req.connection?.remoteAddress ?? '';
}

function isOriginWhitelisted(req) {
  if (!WHITELISTED.length) return false;
  const origin = req.headers.origin || '';
  const referer = req.headers.referer || '';
  const addr = getRemoteAddr(req);
  return WHITELISTED.some(
    (w) => origin.includes(w) || referer.includes(w) || addr.includes(w),
  );
}

function isInternalProxy(req) {
  const addr = getRemoteAddr(req);
  return addr === '127.0.0.1' || addr === '::ffff:127.0.0.1';
}

async function callHeartbeat(token, req, res) {
  try {
    const hbRes = await fetch(`${NEXUS_API}/api/access/heartbeat`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      signal: AbortSignal.timeout(5000),
    });

    if (!hbRes.ok) return true; // fail-open si nexus-api responde con error no-auth

    const hb = await hbRes.json();

    if (hb.active === false) {
      res.status(403).json({
        success: false,
        code: 'ACCESS_SUSPENDED',
        message: hb.reason || 'Acceso suspendido. Contacte a su administrador.',
      });
      return false; // cortar el pipeline
    }

    if (hb.access_token) {
      req.nexusToken = hb.access_token;
      res.setHeader('X-Nexus-Token-Refreshed', hb.access_token);
      res.setHeader('Access-Control-Expose-Headers', 'X-Nexus-Token-Refreshed');
    }

    return true;
  } catch {
    return true; // fail-open: fallo temporal de nexus-api no corta el flujo
  }
}

// ── Middleware principal ─────────────────────────────────────────────────────

/**
 * nexusAuth — middleware Express que valida y renueva el Nexus token.
 * Incluye:
 *   - Validación de firma JWT
 *   - Verificación de submódulo correcto
 *   - Heartbeat automático con renovación de token
 *   - Bypass por origen/whitelist para dev/QA
 *   - Proxy interno (127.0.0.1) sin verificación de submódulo
 */
async function nexusAuth(req, res, next) {
  const token = extractToken(req);

  // ── Bypass de origen (dev / QA) ──────────────────────────────────────────
  if (isOriginWhitelisted(req)) {
    req.empresa = { id: BYPASS_EMPRESA_ID };
    req.submoduloId = EXPECTED_SUBMODS[0] ?? 0;
    req.nexusToken = token || '';
    req.nexusMetadata = {};

    if (token) {
      try {
        const decoded = jwt.decode(token);
        if (decoded && typeof decoded === 'object') {
          req.nexusMetadata = decoded.metadata || {};
        }
      } catch {
        /* token malformado ignorado en bypass */
      }
    }

    return next();
  }

  // ── Modo sin autenticación (NEXUS_AUTH_ENABLED=false) ───────────────────
  if (!ENABLED) {
    if (token) {
      try {
        const decoded = jwt.decode(token);
        if (decoded && typeof decoded === 'object') {
          req.empresa = { id: decoded.empresaId };
          req.submoduloId = decoded.submoduloId;
          req.nexusMetadata = decoded.metadata || {};
        }
      } catch {
        /* ignorar */
      }
    }
    return next();
  }

  // ── Validaciones de config ───────────────────────────────────────────────
  if (!SECRET) {
    return res.status(500).json({
      success: false,
      code: 'NEXUS_AUTH_MISCONFIGURED',
      message: 'TENANT_TOKEN_SECRET no está configurado en el backend.',
    });
  }

  if (!token) {
    if (isInternalProxy(req)) return next();
    return res.status(401).json({
      success: false,
      code: 'NEXUS_TOKEN_MISSING',
      message: 'Token de acceso requerido (Authorization: Bearer <token>).',
    });
  }

  // ── Verificación JWT ─────────────────────────────────────────────────────
  let payload;
  try {
    payload = jwt.verify(token, SECRET);
  } catch {
    return res.status(401).json({
      success: false,
      code: 'NEXUS_TOKEN_INVALID',
      message: 'Token inválido o expirado.',
    });
  }

  if (payload.type !== 'tenant_access') {
    return res.status(401).json({
      success: false,
      code: 'NEXUS_TOKEN_INVALID_TYPE',
      message: 'Tipo de token inválido.',
    });
  }

  if (!payload.empresaId || !payload.submoduloId) {
    return res.status(401).json({
      success: false,
      code: 'NEXUS_TOKEN_INCOMPLETE',
      message: 'El token no contiene empresaId/submoduloId.',
    });
  }

  // Verificar submódulo (proxy interno lo omite)
  if (
    !isInternalProxy(req) &&
    EXPECTED_SUBMODS.length > 0 &&
    !EXPECTED_SUBMODS.includes(payload.submoduloId)
  ) {
    return res.status(403).json({
      success: false,
      code: 'NEXUS_TOKEN_WRONG_SUBMODULE',
      message: `Token emitido para submódulo ${payload.submoduloId}, este backend espera ${EXPECTED_SUBMODS.join(', ')}.`,
    });
  }

  // Inyectar en req
  req.empresa = { id: payload.empresaId };
  req.submoduloId = payload.submoduloId;
  req.nexusToken = token;
  req.nexusMetadata = payload.metadata || {};

  // ── Heartbeat ────────────────────────────────────────────────────────────
  const continued = await callHeartbeat(token, req, res);
  if (!continued) return; // res ya fue enviada por callHeartbeat

  return next();
}

module.exports = nexusAuth;
