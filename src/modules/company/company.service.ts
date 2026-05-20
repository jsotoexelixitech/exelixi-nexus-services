import logger from '../../utils/logger';
import prisma from '../../config/prisma';
import { AppError } from '../../utils/app-error';
import {
  generateTenantToken,
  buildAccessUrl,
} from '../../utils/tenant-token';

type TxClient = Omit<
  typeof prisma,
  '$extends' | '$transaction' | '$disconnect' | '$connect' | '$on' | '$use'
>;

type EmpresaSubmoduloRow = {
  id: number;
  empresaId: number;
  submoduloId: number;
  activo: boolean;
  tenantToken: string | null;
  createdAt: Date | null;
};

type EmpresaSubmoduloDelegate = {
  findMany(args: {
    where: { empresaId: number };
  }): Promise<EmpresaSubmoduloRow[]>;
  findFirst(args: {
    where: { empresaId: number; submoduloId: number };
  }): Promise<EmpresaSubmoduloRow | null>;
  create(args: {
    data: {
      empresaId: number;
      submoduloId: number;
      activo: boolean;
      tenantToken: string;
    };
  }): Promise<EmpresaSubmoduloRow>;
  update(args: {
    where: { id: number };
    data: { activo: boolean };
  }): Promise<EmpresaSubmoduloRow>;
};

function getEmpresaSubmoduloDelegate(
  client: unknown,
): EmpresaSubmoduloDelegate | null {
  const delegate = (client as { empresaSubmodulo?: EmpresaSubmoduloDelegate })
    .empresaSubmodulo;
  return delegate ?? null;
}

export class CompanyService {
  /**
   * Crea una nueva empresa y genera tokens de acceso para TODOS los
   * submódulos activos existentes. Los tokens se crean con activo:false —
   * el admin los activa manualmente desde el panel.
   */
  async createCompany(nombre: string, rif?: string, tipo: string = 'cliente') {
    try {
      logger.info(`Creando nueva empresa: ${nombre} (${rif || 'S/R'})`);
      return await prisma.$transaction(async (tx: TxClient) => {
        const empresa = await tx.empresa.create({
          data: {
            nombre,
            rif: rif || '',
            tipo,
            activo: true,
          },
        });

        // Generar registros EmpresaSubmodulo para todos los submódulos activos.
        // activo:false por defecto — el admin los activa explícitamente.
        const esCm = getEmpresaSubmoduloDelegate(tx);
        if (esCm) {
          const allSubmodulos = await tx.submodulo.findMany({
            where: { activo: true },
          });

          await Promise.all(
            allSubmodulos.map((sub) => {
              const tenantToken = generateTenantToken(empresa.id, sub.id);
              return esCm.create({
                data: {
                  empresaId: empresa.id,
                  submoduloId: sub.id,
                  activo: false,
                  tenantToken,
                },
              });
            }),
          );

          logger.info(
            `Tokens de acceso generados para ${allSubmodulos.length} submódulos → empresa ${empresa.id}`,
          );
        }

        return empresa;
      });
    } catch (error: unknown) {
      const message =
        error instanceof Error ? error.message : 'Error desconocido';
      logger.error(`Error al crear empresa: ${message}`);
      throw new AppError('No se pudo crear la empresa.', 500);
    }
  }

  /**
   * Obtiene una empresa por su ID incluyendo URLs de acceso por submódulo.
   */
  async getCompanyById(id: number) {
    const company = await prisma.empresa.findUnique({
      where: { id },
    });

    if (!company) {
      throw new AppError('Empresa no encontrada.', 404);
    }

    const empresaSubmodulo = getEmpresaSubmoduloDelegate(prisma);
    const [catalogo, empresaModulos, empresaSubmodulos] = await Promise.all([
      prisma.modulo.findMany({
        include: { submodulos: true },
      }),
      prisma.empresaModulo.findMany({
        where: { empresaId: id },
      }),
      empresaSubmodulo
        ? empresaSubmodulo.findMany({ where: { empresaId: id } })
        : Promise.resolve([]),
    ]);

    const byModuloId = new Map<number, (typeof empresaModulos)[number]>();
    for (const em of empresaModulos) byModuloId.set(em.moduloId, em);

    const bySubmoduloId = new Map<number, EmpresaSubmoduloRow>();
    for (const esm of empresaSubmodulos) {
      bySubmoduloId.set(esm.submoduloId, esm);
    }

    const modulos = catalogo.map(
      (m: { id: number; submodulos?: unknown; [key: string]: unknown }) => {
        const em = byModuloId.get(m.id);
        const submodulos = Array.isArray(m.submodulos)
          ? (
              m.submodulos as Array<{
                id: number;
                nombre: string;
                url: string | null;
                activo: boolean;
                moduloId: number;
                [key: string]: unknown;
              }>
            ).map((sm) => {
              const esm = bySubmoduloId.get(sm.id);
              const tenantToken = esm?.tenantToken ?? null;
              const accessUrl =
                tenantToken && sm.url
                  ? buildAccessUrl(sm.url, tenantToken)
                  : null;
              return {
                ...sm,
                activoEmpresa: esm?.activo ?? false,
                tenantToken,
                accessUrl,
              };
            })
          : m.submodulos;

        return {
          id: em?.id ?? null,
          empresaId: id,
          moduloId: m.id,
          token: em?.token ?? null,
          activo: em?.activo ?? false,
          createdAt: em?.createdAt ?? null,
          modulo: {
            ...m,
            submodulos,
          },
        };
      },
    );

    return {
      ...company,
      modulos,
    };
  }

  async updateCompany(
    id: number,
    data: { nombre?: string; rif?: string; tipo?: string; activo?: boolean },
  ) {
    try {
      logger.info(`Actualizando empresa ${id}`);
      return await prisma.empresa.update({
        where: { id },
        data,
      });
    } catch (error: unknown) {
      const message =
        error instanceof Error ? error.message : 'Error desconocido';
      logger.error(`Error al actualizar empresa: ${message}`);
      throw new AppError('No se pudo actualizar la empresa.', 500);
    }
  }

  async deleteCompany(id: number) {
    try {
      logger.info(`Desactivando empresa ${id}`);
      return await prisma.empresa.update({
        where: { id },
        data: { activo: false },
      });
    } catch (error: unknown) {
      const message =
        error instanceof Error ? error.message : 'Error desconocido';
      logger.error(`Error al desactivar empresa: ${message}`);
      throw new AppError('No se pudo desactivar la empresa.', 500);
    }
  }

  async toggleModule(empresaId: number, moduloId: number, active: boolean) {
    try {
      logger.info(
        `${active ? 'Activando' : 'Desactivando'} módulo ${moduloId} para empresa ${empresaId}`,
      );

      const existing = await prisma.empresaModulo.findFirst({
        where: { empresaId, moduloId },
      });

      if (existing) {
        return await prisma.empresaModulo.update({
          where: { id: existing.id },
          data: { activo: active },
        });
      } else {
        return await prisma.empresaModulo.create({
          data: {
            empresaId,
            moduloId,
            activo: active,
            token: `token-${empresaId}-${moduloId}`,
          },
        });
      }
    } catch (error: unknown) {
      const message =
        error instanceof Error ? error.message : 'Error desconocido';
      logger.error(`Error al modificar módulo: ${message}`);
      throw new AppError('No se pudo actualizar el estado del módulo.', 500);
    }
  }

  /**
   * Activa o desactiva un submódulo para una empresa.
   * Si no existe el registro, lo crea con un token firmado permanente.
   * El token no cambia al desactivar/reactivar — la URL siempre es la misma.
   */
  async toggleSubmodule(
    empresaId: number,
    submoduloId: number,
    active: boolean,
  ) {
    try {
      logger.info(
        `${active ? 'Activando' : 'Desactivando'} submódulo ${submoduloId} para empresa ${empresaId}`,
      );

      const empresaSubmodulo = getEmpresaSubmoduloDelegate(prisma);
      if (!empresaSubmodulo) {
        throw new AppError(
          'La funcionalidad de submódulos por empresa no está disponible en este ambiente.',
          400,
        );
      }

      const existing = await empresaSubmodulo.findFirst({
        where: { empresaId, submoduloId },
      });

      if (existing) {
        // Solo actualiza el estado activo — el token no cambia nunca
        return await empresaSubmodulo.update({
          where: { id: existing.id },
          data: { activo: active },
        });
      }

      // Primer toggle: crear con token firmado
      const tenantToken = generateTenantToken(empresaId, submoduloId);
      logger.info(
        `Nuevo token de acceso generado para empresa=${empresaId} submodulo=${submoduloId}`,
      );

      return await empresaSubmodulo.create({
        data: {
          empresaId,
          submoduloId,
          activo: active,
          tenantToken,
        },
      });
    } catch (error: unknown) {
      const message =
        error instanceof Error ? error.message : 'Error desconocido';
      logger.error(`Error al modificar submódulo: ${message}`);
      throw new AppError('No se pudo actualizar el estado del submódulo.', 500);
    }
  }

  async getAllCompanies() {
    try {
      return await prisma.empresa.findMany({
        include: {
          modulos: {
            include: { modulo: true },
          },
        },
      });
    } catch (error: unknown) {
      const message =
        error instanceof Error ? error.message : 'Error desconocido';
      logger.error(`Error al listar empresas: ${message}`);
      throw new AppError('Error al recuperar el listado de empresas.', 500);
    }
  }
}
