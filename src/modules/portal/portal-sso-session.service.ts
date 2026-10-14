import crypto from 'crypto';
import bcrypt from 'bcrypt';
import jwt from 'jsonwebtoken';
import prisma from '../../config/prisma';
import { AppError } from '../../utils/app-error';
import logger from '../../utils/logger';
import { encrypt } from '../../utils/crypto';
import { verifyPortalSsoToken } from '../../utils/tenant-token';
import { SIS2000_PORTAL_EMAIL_DOMAIN } from './portal-sis2000-login.service';

/** Pases ya canjeados (jti → expiración ms). Un pase sirve una sola vez. */
const usedPasses = new Map<string, number>();

function consumePass(jti: string, expSec?: number) {
  const now = Date.now();
  for (const [key, exp] of usedPasses) {
    if (exp < now) usedPasses.delete(key);
  }
  if (usedPasses.has(jti)) {
    throw new AppError(
      'Este acceso ya se usó. Vuelva a entrar desde el menú de La Mundial.',
      401,
    );
  }
  usedPasses.set(jti, expSec ? expSec * 1000 : now + 10 * 60 * 1000);
}

function str(v: unknown): string {
  return v == null ? '' : String(v).trim();
}

function slug(v: string): string {
  return v
    .toLowerCase()
    .replace(/@/g, '.at.')
    .replace(/[^a-z0-9._-]/g, '_');
}

function envInt(name: string): number | null {
  const n = Number(process.env[name]);
  return Number.isInteger(n) && n > 0 ? n : null;
}

/**
 * POST /api/portal/sso-session
 * Canjea el pase de sso-delegate (target "marketplace") por la sesión del portal.
 * El usuario espejo se identifica por el usuario de Sis2000 + su canal, y su perfil
 * guarda los datos reales (cusuario, gestor, canal) que luego viajan en cada emisión.
 */
export async function startPortalSsoSession(nexusToken: string) {
  let pass;
  try {
    pass = verifyPortalSsoToken(nexusToken);
  } catch {
    throw new AppError(
      'El acceso venció o no es válido. Vuelva a entrar desde el menú de La Mundial.',
      401,
    );
  }
  consumePass(pass.jti, pass.exp);

  const roleId = envInt('PORTAL_SIS2000_ROLE_ID');
  if (!roleId) {
    throw new AppError(
      'Marketplace no configurado: defina PORTAL_SIS2000_ROLE_ID en nexus-api.',
      500,
    );
  }

  const empresa = await prisma.empresa.findUnique({
    where: { id: pass.empresaId },
  });
  if (!empresa?.activo) {
    throw new AppError('La empresa del portal no está activa.', 403);
  }

  const m = pass.metadata ?? {};
  const ccanalaltIn = str(m.ccanalalt_in) || str(m.ccanalalt);
  const centidad = (str(m.centidad) || (ccanalaltIn ? 'C' : 'P')).toUpperCase();
  const citem =
    str(m.citem) || (centidad === 'C' ? ccanalaltIn : str(m.cproductor));
  if (!citem) {
    throw new AppError('Falta el canal o productor del usuario.', 400);
  }
  const cusuario = str(m.cusuario);
  const cgestor = str(m.csubitem) || str(m.cgestor);
  const xlogin = str(m.xlogin);

  const identity = xlogin || (cusuario ? `u${cusuario}` : 'canal');
  const email = `sso.${slug(identity)}.${slug(centidad + citem)}${
    cgestor ? `.${slug(cgestor)}` : ''
  }@${SIS2000_PORTAL_EMAIL_DOMAIN}`;
  const nombre = (
    str(m.xusuario) ||
    xlogin ||
    (cusuario ? `Usuario ${cusuario}` : `Canal ${citem}`)
  ).slice(0, 150);

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
          empresaId: empresa.id,
          roleId,
          password: await bcrypt.hash(
            crypto.randomBytes(32).toString('hex'),
            10,
          ),
        },
      });

  const perfil = {
    resolverGestorPorEmail: false,
    centidad,
    citem,
    cproductor: str(m.cproductor) || (centidad === 'P' ? citem : null),
    cusuario: cusuario || null,
    cgestor: cgestor || null,
    ccanalaltIn: ccanalaltIn || (centidad === 'C' ? citem : null),
    cscanalaltIn: str(m.cscanalalt_in) || str(m.cscanalalt) || null,
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
    { expiresIn: '8h' },
  );

  logger.info(
    `[portal] SSO Sis2000 ok: ${identity} → usuario ${user.id} (${centidad}/${citem}${cgestor ? ` gestor ${cgestor}` : ''})`,
  );

  return {
    token: encrypt(rawToken),
    user: {
      id: user.id,
      nombre: user.nombre,
      email: user.email,
      empresa: empresa.nombre,
      role: role?.nombre ?? '',
      sso: true,
      /** Nombre del canal enviado por Sis2000 (xcanal); el portal cae al código si no llega. */
      canal: str(m.xcanal) || null,
    },
  };
}
