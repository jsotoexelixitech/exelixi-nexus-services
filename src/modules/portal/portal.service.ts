import prisma from '../../config/prisma';
import { AppError } from '../../utils/app-error';
import { findSubmoduloForSsoTarget } from './portal-sso-resolver';

export type PortalProductKey = 'rcv' | 'patrimonial' | 'funerario';

export interface PortalCatalogItem {
  key: PortalProductKey;
  label: string;
  description: string;
  target: 'ocr' | 'emision';
  product: 'rcv' | 'funerario' | 'patrimoniales';
  defaultCramo: number;
  moduleLabel: string;
}

const PORTAL_CATALOG: PortalCatalogItem[] = [
  {
    key: 'rcv',
    label: 'RCV',
    description:
      'Responsabilidad Civil Vehículo. Flujo completo: OCR → Formulario → Emisión → Pagos.',
    target: 'ocr',
    product: 'rcv',
    defaultCramo: 18,
    moduleLabel: 'OCR · inicio de flujo',
  },
  {
    key: 'patrimonial',
    label: 'Patrimoniales',
    description:
      'Riesgos patrimoniales: cotización y emisión con ramo y canal Sis2000.',
    target: 'emision',
    product: 'patrimoniales',
    defaultCramo: 20,
    moduleLabel: 'Emisión',
  },
  {
    key: 'funerario',
    label: 'Funerario',
    description:
      'Seguro de vida funerario. Flujo desde OCR con producto funerario activado.',
    target: 'ocr',
    product: 'funerario',
    defaultCramo: 9,
    moduleLabel: 'OCR · inicio de flujo',
  },
];

export interface PortalProductDto extends PortalCatalogItem {
  submoduloId: number;
  submoduloNombre: string;
}

export class PortalService {
  async getSessionContext(userId: number) {
    const user = await prisma.usuario.findUnique({
      where: { id: userId },
      include: {
        empresa: true,
        role: true,
      },
    });

    if (!user) throw new AppError('Usuario no encontrado', 404);
    if (!user.activo) throw new AppError('Usuario inactivo', 403);
    if (!user.empresa.activo) throw new AppError('Empresa inactiva', 403);

    return user;
  }

  /**
   * Flujos lanzables desde el portal según submódulos de la empresa y permisos del rol.
   * La API Key SSO se configura en Admin (empresa); aquí solo Bearer + permisos.
   */
  async getAvailableProducts(userId: number): Promise<PortalProductDto[]> {
    const user = await this.getSessionContext(userId);
    const empresaId = user.empresaId;
    const roleId = user.roleId;

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

    for (const item of PORTAL_CATALOG) {
      const hit = await findSubmoduloForSsoTarget(item.target, {
        empresaId,
        product: item.product,
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
        ...item,
        submoduloId: hit.id,
        submoduloNombre: hit.nombre,
      });
    }

    return out;
  }
}
