import jwt from 'jsonwebtoken';
import { env } from '../config/env';

export interface TenantTokenPayload {
  type: 'tenant_access';
  empresaId: number;
  submoduloId: number;
  metadata?: any;
}

/**
 * Genera un JWT permanente (sin expiración) que identifica la combinación
 * empresa + submódulo. Es el "pase de acceso" que va en la URL del servicio.
 * Firmado con TENANT_TOKEN_SECRET — distinto al JWT de sesión de usuarios.
 */
export function generateTenantToken(
  empresaId: number,
  submoduloId: number,
): string {
  const payload: TenantTokenPayload = {
    type: 'tenant_access',
    empresaId,
    submoduloId,
  };
  // Sin expiración: el token es una licencia permanente.
  // La revocación se gestiona desactivando el registro en BD.
  return jwt.sign(payload, env.TENANT_TOKEN_SECRET);
}

/**
 * Genera un JWT de corta duración (Access Token) para el protocolo OAuth.
 * Este token se usa para las llamadas a los módulos y expira en 1 hora.
 */
export function generateAccessToken(
  empresaId: number,
  submoduloId: number,
): string {
  const payload: TenantTokenPayload = {
    type: 'tenant_access',
    empresaId,
    submoduloId,
  };
  return jwt.sign(payload, env.TENANT_TOKEN_SECRET, { expiresIn: '1h' });
}

/**
 * Genera un JWT de corta duración dinámico para SSO Delegate,
 * inyectando la metadata (ej. cproductor, etc.) para que viaje en la URL.
 * Expira en 1 hora.
 */
export function generateSsoToken(
  empresaId: number,
  submoduloId: number,
  metadata?: any,
): string {
  const payload: TenantTokenPayload = {
    type: 'tenant_access',
    empresaId,
    submoduloId,
    ...(metadata && { metadata }),
  };
  return jwt.sign(payload, env.TENANT_TOKEN_SECRET, { expiresIn: '1h' });
}

/**
 * Verifica la firma del tenant token y retorna el payload.
 * Lanza un error si la firma es inválida o el tipo no coincide.
 */
export function verifyTenantToken(token: string): TenantTokenPayload {
  const decoded = jwt.verify(
    token,
    env.TENANT_TOKEN_SECRET,
  ) as TenantTokenPayload;

  if (decoded.type !== 'tenant_access') {
    throw new Error('Tipo de token inválido');
  }

  return decoded;
}

/**
 * Normaliza la URL base del submódulo para redirects con prefijo Apache (/ocr/, etc.).
 * Paths con segmento reciben barra final; host:puerto sin path (/) no cambia.
 */
export function normalizeSubmoduloAccessBase(submoduloUrl: string): string {
  const trimmed = submoduloUrl.trim();
  try {
    const url = new URL(trimmed);
    const search = url.search;
    url.search = '';
    url.hash = '';

    const path = url.pathname.replace(/\/+$/, '');
    if (path.length > 0) {
      url.pathname = `${path}/`;
    }

    return `${url.origin}${url.pathname}${search}`;
  } catch {
    const q = trimmed.indexOf('?');
    const pathPart = q >= 0 ? trimmed.slice(0, q) : trimmed;
    const queryPart = q >= 0 ? trimmed.slice(q) : '';
    const normalized =
      pathPart.length > 0 && !pathPart.endsWith('/')
        ? `${pathPart}/`
        : pathPart;
    return `${normalized}${queryPart}`;
  }
}

/**
 * Construye la URL de acceso completa para un submódulo:
 *   {baseUrl}?nexus_token={tenantToken}
 *
 * Query-aware: si la URL configurada ya trae query string (ej.
 * `https://ocr.app/?product=funerario`), agrega el token con `&` en vez de `?`
 * para no romper la URL. Así el admin puede definir el identificador de producto
 * (rcv | funerario) directamente en la URL del submódulo.
 */
export function buildAccessUrl(
  submoduloUrl: string,
  tenantToken: string,
): string {
  const base = normalizeSubmoduloAccessBase(submoduloUrl);
  const sep = base.includes('?') ? '&' : '?';
  return `${base}${sep}nexus_token=${tenantToken}`;
}
