import prisma from '../../config/prisma';
import { verifyTenantToken, buildAccessUrl } from '../../utils/tenant-token';
import { AppError } from '../../utils/app-error';
import logger from '../../utils/logger';

export class AccessService {
  async verify(token: string) {
    // 1. Verificar la firma — si alguien modificó el token, esto lanza
    let payload: ReturnType<typeof verifyTenantToken>;
    try {
      payload = verifyTenantToken(token);
    } catch {
      throw new AppError('Token de acceso inválido o manipulado.', 401);
    }

    const { empresaId, submoduloId } = payload;

    // 2. Verificar empresa activa
    const empresa = await prisma.empresa.findUnique({
      where: { id: empresaId },
      select: { id: true, nombre: true, rif: true, activo: true },
    });

    if (!empresa) {
      logger.warn(`verify: empresa ${empresaId} no encontrada`);
      return { active: false, reason: 'Empresa no encontrada.' };
    }

    if (!empresa.activo) {
      logger.info(`verify: empresa ${empresaId} inactiva`);
      return { active: false, reason: 'Empresa inactiva.' };
    }

    // 3. Verificar submódulo global activo
    const submodulo = await prisma.submodulo.findUnique({
      where: { id: submoduloId },
      select: { id: true, nombre: true, url: true, activo: true },
    });

    if (!submodulo || !submodulo.activo) {
      logger.info(`verify: submodulo ${submoduloId} inactivo o no existe`);
      return { active: false, reason: 'Servicio no disponible.' };
    }

    // 4. Verificar que la empresa tenga el módulo padre activo
    const moduloId = (
      await prisma.submodulo.findUnique({
        where: { id: submoduloId },
        select: { moduloId: true },
      })
    )?.moduloId;

    if (moduloId) {
      const empresaModulo = await prisma.empresaModulo.findFirst({
        where: { empresaId, moduloId },
        select: { activo: true },
      });
      if (!empresaModulo || !empresaModulo.activo) {
        logger.info(`verify: modulo ${moduloId} no activado para empresa ${empresaId}`);
        return { active: false, reason: 'Servicio no activado para esta empresa.' };
      }
    }

    // 5. Verificar que la empresa tenga este submódulo activo
    const empresaSubmodulo = await (
      prisma as unknown as {
        empresaSubmodulo: {
          findFirst: (args: {
            where: { empresaId: number; submoduloId: number };
          }) => Promise<{
            id: number;
            activo: boolean;
            tenantToken: string | null;
          } | null>;
        };
      }
    ).empresaSubmodulo.findFirst({
      where: { empresaId, submoduloId },
    });

    if (!empresaSubmodulo || !empresaSubmodulo.activo) {
      logger.info(
        `verify: submodulo ${submoduloId} no activado para empresa ${empresaId}`,
      );
      return { active: false, reason: 'Servicio no activado para esta empresa.' };
    }

    logger.info(`verify: acceso concedido empresa=${empresaId} submodulo=${submoduloId}`);

    return {
      active: true,
      empresa: {
        id: empresa.id,
        nombre: empresa.nombre,
        rif: empresa.rif,
      },
      submodulo: {
        id: submodulo.id,
        nombre: submodulo.nombre,
        url: submodulo.url,
        accessUrl: submodulo.url
          ? buildAccessUrl(submodulo.url, token)
          : null,
      },
    };
  }
}
