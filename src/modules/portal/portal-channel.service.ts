import prisma from '../../config/prisma';
import type { EmpresaPortalConfig, UsuarioPortalPerfil } from '@prisma/client';

export type ResolvedPortalCanal = {
  centidad: string;
  citem: string;
  cproductor: string;
  cusuario: string;
  cgestor?: string;
  ccanalaltIn?: string;
  cscanalaltIn?: string;
  resolverGestorPorEmail: boolean;
  source: 'usuario' | 'empresa' | 'env';
};

const DEFAULT_CENTIDAD = process.env.PORTAL_DEFAULT_CENTIDAD || 'P';
const DEFAULT_CITEM =
  process.env.PORTAL_DEFAULT_CITEM ||
  process.env.LAMUNDIAL_PRODUCTOR ||
  '80080';
const DEFAULT_CPRODUCTOR =
  process.env.PORTAL_DEFAULT_CPRODUCTOR ||
  process.env.LAMUNDIAL_PRODUCTOR ||
  '80080';
const DEFAULT_CUSUARIO =
  process.env.PORTAL_DEFAULT_CUSUARIO || process.env.LAMUNDIAL_CUSUARIO || '4';

function pickStr(...vals: (string | null | undefined)[]): string | undefined {
  for (const v of vals) {
    const t = String(v ?? '').trim();
    if (t) return t;
  }
  return undefined;
}

function mergePerfil(
  perfil: UsuarioPortalPerfil | null,
  empresaCfg: EmpresaPortalConfig | null,
): Omit<ResolvedPortalCanal, 'source'> & {
  source: ResolvedPortalCanal['source'];
} {
  const resolverGestorPorEmail =
    perfil?.resolverGestorPorEmail ??
    empresaCfg?.resolverGestorPorEmail ??
    true;

  const centidad =
    pickStr(perfil?.centidad, empresaCfg?.centidad) || DEFAULT_CENTIDAD;
  const citem = pickStr(perfil?.citem, empresaCfg?.citem) || DEFAULT_CITEM;
  const cproductor =
    pickStr(perfil?.cproductor, empresaCfg?.cproductor) || DEFAULT_CPRODUCTOR;
  const cusuario =
    pickStr(perfil?.cusuario, empresaCfg?.cusuario) || DEFAULT_CUSUARIO;
  const cgestor = pickStr(perfil?.cgestor);
  const ccanalaltIn = pickStr(perfil?.ccanalaltIn, empresaCfg?.ccanalaltIn);
  const cscanalaltIn = pickStr(perfil?.cscanalaltIn, empresaCfg?.cscanalaltIn);

  const source: ResolvedPortalCanal['source'] =
    perfil?.centidad || perfil?.citem
      ? 'usuario'
      : empresaCfg
        ? 'empresa'
        : 'env';

  return {
    centidad: centidad.toUpperCase(),
    citem,
    cproductor,
    cusuario,
    cgestor,
    ccanalaltIn,
    cscanalaltIn,
    resolverGestorPorEmail,
    source,
  };
}

export class PortalChannelService {
  async resolveForUser(userId: number): Promise<ResolvedPortalCanal> {
    const user = await prisma.usuario.findUnique({
      where: { id: userId },
      include: {
        portalPerfil: true,
        empresa: { include: { portalConfig: true } },
      },
    });
    if (!user) throw new Error('Usuario no encontrado');
    return mergePerfil(user.portalPerfil, user.empresa.portalConfig);
  }

  buildValrepRequest(
    canal: ResolvedPortalCanal,
    email: string,
  ): {
    centidad?: string;
    citem?: string;
    cgestor_in?: string;
    cgestor?: string;
    cproductor?: string;
  } {
    const hasExplicit =
      canal.source === 'usuario' ||
      (canal.source === 'empresa' && Boolean(canal.centidad && canal.citem));

    if (hasExplicit && !canal.resolverGestorPorEmail) {
      return {
        centidad: canal.centidad,
        citem: canal.citem,
        cproductor: canal.cproductor,
        cgestor: canal.cgestor,
      };
    }

    if (canal.resolverGestorPorEmail && email.trim()) {
      return {
        cgestor_in: email.trim().toLowerCase(),
        cproductor: canal.cproductor,
        centidad: canal.centidad,
        citem: canal.citem,
      };
    }

    return {
      centidad: canal.centidad,
      citem: canal.citem,
      cproductor: canal.cproductor,
      cgestor: canal.cgestor,
    };
  }
}

export async function upsertUsuarioPortalPerfil(
  usuarioId: number,
  input:
    | {
        resolverGestorPorEmail?: boolean;
        centidad?: string | null;
        citem?: string | null;
        cproductor?: string | null;
        cusuario?: string | null;
        cgestor?: string | null;
        ccanalaltIn?: string | null;
        cscanalaltIn?: string | null;
      }
    | null
    | undefined,
) {
  if (input == null) return null;
  const empty =
    input.centidad == null &&
    input.citem == null &&
    input.cproductor == null &&
    input.cusuario == null &&
    input.cgestor == null &&
    input.ccanalaltIn == null &&
    input.cscanalaltIn == null &&
    input.resolverGestorPorEmail == null;
  if (empty) return null;

  return prisma.usuarioPortalPerfil.upsert({
    where: { usuarioId },
    create: {
      usuarioId,
      resolverGestorPorEmail: input.resolverGestorPorEmail ?? true,
      centidad: input.centidad ?? null,
      citem: input.citem ?? null,
      cproductor: input.cproductor ?? null,
      cusuario: input.cusuario ?? null,
      cgestor: input.cgestor ?? null,
      ccanalaltIn: input.ccanalaltIn ?? null,
      cscanalaltIn: input.cscanalaltIn ?? null,
    },
    update: {
      resolverGestorPorEmail: input.resolverGestorPorEmail ?? true,
      centidad: input.centidad ?? null,
      citem: input.citem ?? null,
      cproductor: input.cproductor ?? null,
      cusuario: input.cusuario ?? null,
      cgestor: input.cgestor ?? null,
      ccanalaltIn: input.ccanalaltIn ?? null,
      cscanalaltIn: input.cscanalaltIn ?? null,
    },
  });
}

export async function upsertEmpresaPortalConfig(
  empresaId: number,
  input: {
    centidad?: string;
    citem?: string;
    cproductor?: string | null;
    cusuario?: string | null;
    resolverGestorPorEmail?: boolean;
    ccanalaltIn?: string | null;
    cscanalaltIn?: string | null;
  },
) {
  return prisma.empresaPortalConfig.upsert({
    where: { empresaId },
    create: {
      empresaId,
      centidad: (input.centidad || DEFAULT_CENTIDAD).toUpperCase(),
      citem: input.citem || DEFAULT_CITEM,
      cproductor: input.cproductor ?? null,
      cusuario: input.cusuario ?? null,
      resolverGestorPorEmail: input.resolverGestorPorEmail ?? true,
      ccanalaltIn: input.ccanalaltIn ?? null,
      cscanalaltIn: input.cscanalaltIn ?? null,
    },
    update: {
      ...(input.centidad != null
        ? { centidad: input.centidad.toUpperCase() }
        : {}),
      ...(input.citem != null ? { citem: input.citem } : {}),
      ...(input.cproductor !== undefined
        ? { cproductor: input.cproductor }
        : {}),
      ...(input.cusuario !== undefined ? { cusuario: input.cusuario } : {}),
      ...(input.resolverGestorPorEmail !== undefined
        ? { resolverGestorPorEmail: input.resolverGestorPorEmail }
        : {}),
      ...(input.ccanalaltIn !== undefined
        ? { ccanalaltIn: input.ccanalaltIn }
        : {}),
      ...(input.cscanalaltIn !== undefined
        ? { cscanalaltIn: input.cscanalaltIn }
        : {}),
    },
  });
}
