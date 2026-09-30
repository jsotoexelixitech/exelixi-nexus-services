import crypto from 'crypto';
import bcrypt from 'bcrypt';
import jwt from 'jsonwebtoken';
import prisma from '../../config/prisma';
import { AppError } from '../../utils/app-error';
import logger from '../../utils/logger';
import { encrypt } from '../../utils/crypto';
import { nestPortalLogin, NestPortalLoginError } from './nest-valrep.client';

/** Dominio de los usuarios espejo (login real en Sis2000, no en Nexus). */
export const SIS2000_PORTAL_EMAIL_DOMAIN = 'sis2000.portal';

export function isSis2000PortalEmail(email: string): boolean {
  return email.toLowerCase().endsWith(`@${SIS2000_PORTAL_EMAIL_DOMAIN}`);
}

function sis2000Email(xlogin: string): string {
  const slug = xlogin
    .trim()
    .toLowerCase()
    .replace(/@/g, '.at.')
    .replace(/[^a-z0-9._-]/g, '_');
  return `${slug}@${SIS2000_PORTAL_EMAIL_DOMAIN}`;
}

function envInt(name: string): number | null {
  const n = Number(process.env[name]);
  return Number.isInteger(n) && n > 0 ? n : null;
}

/**
 * Login del portal con usuarios Sis2000 (mismos del marketplace / SysIP).
 * nest-api valida usuario+clave; Nexus guarda un usuario espejo (sin clave usable)
 * con el perfil de canal para reutilizar permisos, SSO y auditoría del portal.
 */
export async function loginPortalSis2000(xlogin: string, xcontrasena: string) {
  const empresaId = envInt('PORTAL_SIS2000_EMPRESA_ID');
  const roleId = envInt('PORTAL_SIS2000_ROLE_ID');
  if (!empresaId || !roleId) {
    throw new AppError(
      'Login Sis2000 no configurado: defina PORTAL_SIS2000_EMPRESA_ID y PORTAL_SIS2000_ROLE_ID en nexus-api.',
      500,
    );
  }

  let result;
  try {
    result = await nestPortalLogin(xlogin.trim(), xcontrasena);
  } catch (err) {
    if (err instanceof NestPortalLoginError) {
      if (err.status === 401)
        logger.warn(`[portal] login Sis2000 rechazado: ${xlogin}`);
      throw new AppError(err.message, err.status);
    }
    throw err;
  }

  const { usuario, catalogo } = result;
  if (!catalogo) {
    throw new AppError(
      'Su usuario no tiene un canal o productor activo para emitir. Contacte a La Mundial.',
      403,
    );
  }

  const email = sis2000Email(xlogin);
  const nombre = String(usuario.xusuario || xlogin)
    .trim()
    .slice(0, 150);
  const empresa = await prisma.empresa.findUnique({ where: { id: empresaId } });
  if (!empresa?.activo) {
    throw new AppError('La empresa del portal no está activa.', 403);
  }

  const existing = await prisma.usuario.findUnique({ where: { email } });
  if (existing && !existing.activo) {
    throw new AppError(
      'Su acceso al portal fue desactivado. Contacte al administrador.',
      403,
    );
  }

  const user = existing
    ? await prisma.usuario.update({
        where: { id: existing.id },
        data: { nombre },
      })
    : await prisma.usuario.create({
        data: {
          email,
          nombre,
          empresaId,
          roleId,
          password: await bcrypt.hash(
            crypto.randomBytes(32).toString('hex'),
            10,
          ),
        },
      });

  const perfil = {
    resolverGestorPorEmail: false,
    centidad: catalogo.centidad,
    citem: catalogo.citem,
    cproductor: catalogo.centidad === 'P' ? catalogo.citem : null,
    cgestor: catalogo.filtrar_gestor ? catalogo.cgestor : null,
    ccanalaltIn: catalogo.centidad === 'C' ? catalogo.citem : null,
    cscanalaltIn: usuario.cscanalalt ? String(usuario.cscanalalt) : null,
  };
  await prisma.usuarioPortalPerfil.upsert({
    where: { usuarioId: user.id },
    create: { usuarioId: user.id, ...perfil },
    update: perfil,
  });

  const role = await prisma.role.findUnique({ where: { id: user.roleId } });
  const rawToken = jwt.sign(
    {
      id: user.id,
      email: user.email,
      empresaId: user.empresaId,
      roleId: user.roleId,
    },
    process.env.JWT_SECRET || 'secret',
    { expiresIn: '12h' },
  );

  logger.info(
    `[portal] login Sis2000 ok: ${xlogin} → usuario ${user.id} (${catalogo.centidad}/${catalogo.citem})`,
  );

  return {
    token: encrypt(rawToken),
    user: {
      id: user.id,
      nombre: user.nombre,
      email: user.email,
      empresa: empresa.nombre,
      role: role?.nombre ?? '',
      xlogin: usuario.xlogin ?? xlogin,
      bcambioclave: Boolean(usuario.bcambioclave),
    },
  };
}
