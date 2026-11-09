/**
 * Lista de acceso del monitor de expedientes (EXPEDIENTES_USUARIOS).
 *
 * En producción las sesiones SSO del marketplace entran con el rol «Administrador»
 * (PORTAL_SIS2000_ROLE_ID), así que el rol no distingue a quién puede ver el monitor.
 * La lista sí: valores separados por coma, sin distinguir mayúsculas, que se comparan con
 * el usuario de Sis2000 (xlogin / xusuario / correo que envía Sis2000 en el SSO) o con el
 * correo del usuario Nexus.
 *
 * Lista vacía: cerrado para todos, salvo fuera de producción (desarrollo, o servidor QA con
 * EXPEDIENTES_ENTORNO=qa explícito), donde se conserva el acceso con cualquier sesión.
 */
import { Response, NextFunction } from 'express';
import { AuthRequest } from '../../middlewares/auth.middleware';
import { expedientesJobsManualPermitido } from './expedientes.env';

/** Mismo dominio que portal-sis2000-login.service (no se importa: arrastra bcrypt). */
const SIS2000_PORTAL_EMAIL_DOMAIN = 'sis2000.portal';

export const MENSAJE_SIN_ACCESO_MONITOR =
  'No tiene acceso al monitor de expedientes.';

function norm(v: unknown): string {
  return v == null ? '' : String(v).trim().toLowerCase();
}

/** Mismo slug que usan los correos espejo de Sis2000 en el portal. */
function slug(v: string): string {
  return v
    .toLowerCase()
    .replace(/@/g, '.at.')
    .replace(/[^a-z0-9._-]/g, '_');
}

export function usuariosMonitor(): string[] {
  return String(process.env.EXPEDIENTES_USUARIOS ?? '')
    .split(',')
    .map(norm)
    .filter(Boolean);
}

/** Sin lista: abierto solo fuera de producción (nunca con NODE_ENV=production sin ENTORNO=qa). */
export function monitorSinListaAbierto(): boolean {
  return expedientesJobsManualPermitido();
}

/** ¿Alguna de estas identidades está en la lista? (lista vacía → regla de entorno). */
export function identidadPermitida(
  identidades: Array<string | null | undefined>,
): boolean {
  const lista = usuariosMonitor();
  if (!lista.length) return monitorSinListaAbierto();
  const set = new Set(lista);
  return identidades.some((v) => {
    const n = norm(v);
    return n !== '' && set.has(n);
  });
}

/** Claims de Sis2000 que la sesión SSO del portal guarda en el JWT. */
export interface SesionSis2000Claims {
  sisXlogin?: string | null;
  sisXusuario?: string | null;
  sisEmail?: string | null;
}

/** Identidades de la sesión del portal (req.user = JWT decodificado). */
export function identidadesDeSesion(
  user: (AuthRequest['user'] & SesionSis2000Claims) | undefined,
): string[] {
  if (!user) return [];
  const ids: string[] = [];
  const email = norm(user.email);
  if (email) ids.push(email);
  if (user.sisXlogin) ids.push(String(user.sisXlogin));
  if (user.sisXusuario) ids.push(String(user.sisXusuario));
  if (user.sisEmail) ids.push(String(user.sisEmail));
  return ids;
}

/**
 * Login del portal con usuario/clave de Sis2000: el correo espejo es `slug(xlogin)@sis2000.portal`.
 * Se compara el slug de cada valor de la lista (las sesiones SSO llevan el xlogin en el JWT).
 */
function permitidoPorCorreoSis2000(email: string): boolean {
  const dominio = `@${SIS2000_PORTAL_EMAIL_DOMAIN}`;
  if (!email.endsWith(dominio)) return false;
  const local = email.slice(0, -dominio.length);
  if (!local || local.startsWith('sso.')) return false;
  return usuariosMonitor().some((u) => slug(u) === local);
}

export function sesionPermitida(
  user: (AuthRequest['user'] & SesionSis2000Claims) | undefined,
): boolean {
  if (!user) return false;
  if (identidadPermitida(identidadesDeSesion(user))) return true;
  return permitidoPorCorreoSis2000(norm(user.email));
}

/** Middleware tras `authenticate`: 403 si la sesión no está en la lista del monitor. */
export function requireListaMonitor(
  req: AuthRequest,
  res: Response,
  next: NextFunction,
): void {
  if (sesionPermitida(req.user)) {
    next();
    return;
  }
  res.status(403).json({
    status: 'error',
    success: false,
    message: MENSAJE_SIN_ACCESO_MONITOR,
  });
}
