import jwt from 'jsonwebtoken';
import { env } from '../config/env';

export interface TenantTokenPayload {
  type: 'tenant_access';
  empresaId: number;
  submoduloId: number;
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
  const base = submoduloUrl.replace(/\/$/, '');
  const sep = base.includes('?') ? '&' : '?';
  return `${base}${sep}nexus_token=${tenantToken}`;
}
