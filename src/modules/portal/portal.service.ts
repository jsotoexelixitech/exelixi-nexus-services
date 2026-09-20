import prisma from '../../config/prisma';
import { AppError } from '../../utils/app-error';
import { findSubmoduloForSsoTarget } from './portal-sso-resolver';
import { PortalChannelService } from './portal-channel.service';
import { fetchValrepProductos } from './nest-valrep.client';
import { mapSisProductRow } from './portal-sis-product.mapper';
import logger from '../../utils/logger';

export interface PortalProductDto {
  key: string;
  label: string;
  description: string;
  target: 'ocr' | 'emision' | 'formulario' | 'pagos';
  product: 'rcv' | 'funerario' | 'patrimoniales';
  defaultCramo: number;
  moduleLabel: string;
  submoduloId: number;
  submoduloNombre: string;
  cproducto: string;
  cramo: number;
  xform?: string;
  xlogo?: string;
  cproductor?: string;
  cusuario?: string;
  centidad?: string;
  citem?: string;
  ccanalaltIn?: string;
  cscanalaltIn?: string;
}

const channelService = new PortalChannelService();

export class PortalService {
  async getSessionContext(userId: number) {
    const user = await prisma.usuario.findUnique({
      where: { id: userId },
      include: {
        empresa: { include: { portalConfig: true } },
        role: true,
        portalPerfil: true,
      },
    });

    if (!user) throw new AppError('Usuario no encontrado', 404);
    if (!user.activo) throw new AppError('Usuario inactivo', 403);
    if (!user.empresa.activo) throw new AppError('Empresa inactiva', 403);

    return user;
  }

  async getResolvedCanal(userId: number) {
    return channelService.resolveForUser(userId);
  }

  /**
   * Catálogo marketplace (Sis2000) filtrado por submódulos y permisos Nexus.
   */
  async getAvailableProducts(userId: number): Promise<PortalProductDto[]> {
    const user = await this.getSessionContext(userId);
    const empresaId = user.empresaId;
    const roleId = user.roleId;

    const canal = await channelService.resolveForUser(userId);
    const valrepBody = channelService.buildValrepRequest(canal, user.email);

    let rows: Record<string, unknown>[];
    try {
      rows = await fetchValrepProductos(valrepBody);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error(`[portal] catálogo Sis2000: ${msg}`);
      throw new AppError(
        `No se pudo cargar el catálogo de productos (${msg}). Verifique NEST_API_KEY y canal del operador en Admin.`,
        502,
      );
    }

    let granular: { submoduloId: number | null; canRead: boolean }[];
    try {
      granular = await prisma.rolePermissionDetail.findMany({
        where: { roleId },
        select: { submoduloId: true, canRead: true },
      });
    } catch {
      granular = [];
    }
    const useGranular = granular.length > 0;

    const empresaLinkCount = await prisma.empresaSubmodulo.count({
      where: { empresaId, activo: true },
    });

    const out: PortalProductDto[] = [];
    const seen = new Set<string>();

    for (const row of rows) {
      const mapped = mapSisProductRow(row, canal);
      if (!mapped || seen.has(mapped.key)) continue;
      seen.add(mapped.key);

      const hit = await findSubmoduloForSsoTarget(mapped.target, {
        empresaId,
        product: mapped.product,
      });
      if (!hit) continue;

      if (empresaLinkCount > 0) {
        const link = await prisma.empresaSubmodulo.findFirst({
          where: {
            empresaId,
            submoduloId: hit.id,
            activo: true,
          },
        });
        if (!link && user.roleId !== 1) continue;
      }

      if (useGranular) {
        const perm = granular.find((g) => g.submoduloId === hit.id);
        if (!perm?.canRead && user.roleId !== 1) continue;
      }

      out.push({
        key: mapped.key,
        label: mapped.label,
        description: mapped.description,
        target: mapped.target,
        product: mapped.product,
        defaultCramo: mapped.defaultCramo,
        moduleLabel: mapped.moduleLabel,
        submoduloId: hit.id,
        submoduloNombre: hit.nombre,
        cproducto: mapped.cproducto,
        cramo: mapped.cramo,
        xform: mapped.xform,
        xlogo: mapped.xlogo,
        cproductor: canal.cproductor,
        cusuario: canal.cusuario,
        centidad: canal.centidad,
        citem: canal.citem,
        ccanalaltIn: canal.ccanalaltIn,
        cscanalaltIn: canal.cscanalaltIn,
      });
    }

    return out;
  }
}
