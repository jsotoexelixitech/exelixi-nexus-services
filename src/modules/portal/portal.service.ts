import prisma from '../../config/prisma';
import { AppError } from '../../utils/app-error';
import { findSubmoduloForSsoTarget } from './portal-sso-resolver';
import {
  PortalChannelService,
  type ResolvedPortalCanal,
} from './portal-channel.service';
import {
  fetchValrepProductos,
  fetchValrepProductosMarketplace,
} from './nest-valrep.client';
import {
  mapSisProductRow,
  type MappedSisProduct,
} from './portal-sis-product.mapper';
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
  mmontoInicial?: string;
  xfraccionamiento?: string;
  xurlPresentacion?: string;
  marketplaceUrl?: string;
  marketplaceQr?: string;
  /** sso = módulo Exélixi vía sso-delegate · sysip = formulario nativo en marketplace SysIP (marketplaceUrl). */
  launchMode: 'sso' | 'sysip';
}

/** Igual que el marketplace SysIP: xform con nexus/ext/external abre módulo Exélixi (iframe). */
function isExelixiForm(xform?: string): boolean {
  return /nexus|ext/i.test(xform ?? '');
}

function marketplaceEmissionUrlPrefix(): string | undefined {
  const raw =
    process.env.PORTAL_MARKETPLACE_EMISSION_URL?.trim() ||
    process.env.PORTAL_MARKETPLACE_URL?.trim();
  return raw || undefined;
}

function useMarketplaceCatalog(): boolean {
  return process.env.PORTAL_USE_LEGACY_PRODUCTOS !== 'true';
}

async function loadSisProductRows(
  valrepBody: Parameters<typeof fetchValrepProductos>[0],
): Promise<Record<string, unknown>[]> {
  if (!useMarketplaceCatalog()) {
    return fetchValrepProductos(valrepBody);
  }
  const urlPrefix = marketplaceEmissionUrlPrefix();
  try {
    const { productos } = await fetchValrepProductosMarketplace({
      ...valrepBody,
      ...(urlPrefix ? { url: urlPrefix } : {}),
    });
    if (productos.length > 0) return productos;
    logger.warn('[portal] marketplace vacío; fallback valrep/productos (SP)');
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.warn(
      `[portal] marketplace falló (${msg}); fallback valrep/productos`,
    );
  }
  return fetchValrepProductos(valrepBody);
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
      rows = await loadSisProductRows(valrepBody);
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

    // maproductos trae una fila por formulario (SysIP nativo y Exélixi): una tarjeta por producto.
    const byProducto = new Map<string, MappedSisProduct>();
    for (const row of rows) {
      const mapped = mapSisProductRow(row, canal);
      if (!mapped) continue;
      const prev = byProducto.get(mapped.cproducto);
      if (
        !prev ||
        (!isExelixiForm(prev.xform) && isExelixiForm(mapped.xform))
      ) {
        byProducto.set(mapped.cproducto, mapped);
      }
    }

    const out: PortalProductDto[] = [];
    // Catálogo legacy (SP) sin xform: todo va a módulos Exélixi como antes.
    const splitByForm = [...byProducto.values()].some((m) => m.xform);

    for (const mapped of byProducto.values()) {
      if (splitByForm && !isExelixiForm(mapped.xform)) {
        if (!mapped.marketplaceUrl) continue;
        out.push({
          ...this.toDto(mapped, canal),
          submoduloId: 0,
          submoduloNombre: 'Marketplace La Mundial',
          moduleLabel: 'Marketplace La Mundial',
          launchMode: 'sysip',
        });
        continue;
      }

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
        ...this.toDto(mapped, canal),
        submoduloId: hit.id,
        submoduloNombre: hit.nombre,
        launchMode: 'sso',
      });
    }

    return out;
  }

  private toDto(
    mapped: MappedSisProduct,
    canal: ResolvedPortalCanal,
  ): Omit<PortalProductDto, 'submoduloId' | 'submoduloNombre' | 'launchMode'> {
    return {
      key: mapped.key,
      label: mapped.label,
      description: mapped.description,
      target: mapped.target,
      product: mapped.product,
      defaultCramo: mapped.defaultCramo,
      moduleLabel: mapped.moduleLabel,
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
      mmontoInicial: mapped.mmontoInicial,
      xfraccionamiento: mapped.xfraccionamiento,
      xurlPresentacion: mapped.xurlPresentacion,
      marketplaceUrl: mapped.marketplaceUrl,
      marketplaceQr: mapped.marketplaceQr,
    };
  }
}
