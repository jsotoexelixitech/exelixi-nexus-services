/**
 * Bypass de validaciones en sso-delegate para el rol admin (roleId 1).
 *
 * Solo se habilita con NEXUS_ALLOW_ADMIN_SSO_BYPASS=true (entornos de desarrollo).
 * Sin la variable (producción) el admin pasa por las mismas reglas que cualquier
 * usuario: empresa activa y submódulo activo para la empresa.
 */
export const ADMIN_SSO_BYPASS_ENV = 'NEXUS_ALLOW_ADMIN_SSO_BYPASS';

export const ADMIN_ROLE_ID = 1;

export function adminPuedeSaltarValidacion(
  roleId: number | undefined,
  env: Record<string, string | undefined> = process.env,
): boolean {
  if (roleId !== ADMIN_ROLE_ID) return false;
  return (env[ADMIN_SSO_BYPASS_ENV] ?? '').trim().toLowerCase() === 'true';
}
