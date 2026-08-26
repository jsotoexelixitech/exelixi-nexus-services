import logger from '../../utils/logger';
import prisma from '../../config/prisma';
import { AppError } from '../../utils/app-error';
import { generateTenantToken, buildAccessUrl } from '../../utils/tenant-token';
import { filterModulosForAdminCatalog } from '../../utils/submodulo-environment';

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
    const [catalogoRaw, empresaModulos, empresaSubmodulos] = await Promise.all([
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

    const catalogo = filterModulosForAdminCatalog(catalogoRaw);

    const byModuloId = new Map<number, (typeof empresaModulos)[number]>();
    for (const em of empresaModulos) byModuloId.set(em.moduloId, em);

    const bySubmoduloId = new Map<number, EmpresaSubmoduloRow>();
    for (const esm of empresaSubmodulos) {
      bySubmoduloId.set(esm.submoduloId, esm);
    }

    const modulos = await Promise.all(
      catalogo.map(
        async (m: {
          id: number;
          submodulos?: unknown;
          [key: string]: unknown;
        }) => {
          const em = byModuloId.get(m.id);
          const submodulos = Array.isArray(m.submodulos)
            ? await Promise.all(
                (
                  m.submodulos as Array<{
                    id: number;
                    nombre: string;
                    url: string | null;
                    activo: boolean;
                    moduloId: number;
                    [key: string]: unknown;
                  }>
                ).map(async (sm) => {
                  let esm = bySubmoduloId.get(sm.id);
                  if (!esm && sm.url) {
                    esm = await this.ensureEmpresaSubmoduloToken(id, sm.id);
                    if (esm) bySubmoduloId.set(sm.id, esm);
                  }
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
                }),
              )
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
      ),
    );

    return {
      ...company,
      modulos,
    };
  }

  async updateCompany(
    id: number,
    data: {
      nombre?: string;
      rif?: string;
      tipo?: string;
      activo?: boolean;
      feeTransaccion?: number;
    },
  ) {
    try {
      logger.info(`Actualizando empresa ${id}`);

      if (data.activo === false) {
        await this.expireCompanyTokens(id);
      }

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

  /** Invalida tokens SSO de todos los submódulos de la empresa (bloqueo inmediato en verify). */
  private async expireCompanyTokens(empresaId: number): Promise<void> {
    await prisma.$executeRaw`
      UPDATE empresa_submodulo
      SET emsm_token_expires_at = NOW()
      WHERE emsm_empresa_id = ${empresaId}
    `;
  }

  async deleteCompany(id: number) {
    try {
      logger.info(`Desactivando empresa ${id}`);

      await this.expireCompanyTokens(id);

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

      let result;
      if (existing) {
        result = await prisma.empresaModulo.update({
          where: { id: existing.id },
          data: { activo: active },
        });
      } else {
        result = await prisma.empresaModulo.create({
          data: {
            empresaId,
            moduloId,
            activo: active,
            token: `token-${empresaId}-${moduloId}`,
          },
        });
      }

      if (active) {
        await this.provisionModuleSubmodulesForCompany(empresaId, moduloId);
      }

      return result;
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

  /**
   * Retorna los tokens de conexión (tenantToken) de todos los submódulos
   * habilitados para una empresa. Usado por el admin para distribuir el
   * API Key a las aplicaciones cliente.
   */
  async getConnectionTokens(empresaId: number) {
    try {
      const empresa = await prisma.empresa.findUnique({
        where: { id: empresaId },
        select: { id: true, nombre: true },
      });
      if (!empresa) throw new AppError('Empresa no encontrada.', 404);

      const esCm = getEmpresaSubmoduloDelegate(prisma);
      if (!esCm)
        throw new AppError('Función no disponible en este entorno.', 503);

      type TokenRow = EmpresaSubmoduloRow & { tokenExpiresAt?: Date | null };
      const rows = await (
        esCm as unknown as {
          findMany(args: {
            where: { empresaId: number };
            include: {
              submodulo: {
                select: { nombre: boolean; url: boolean; activo: boolean };
              };
            };
          }): Promise<
            (TokenRow & {
              submodulo: {
                nombre: string;
                url: string | null;
                activo: boolean;
              };
            })[]
          >;
        }
      ).findMany({
        where: { empresaId },
        include: {
          submodulo: { select: { nombre: true, url: true, activo: true } },
        },
      });

      const now = new Date();
      return rows.map((r) => ({
        submoduloId: r.submoduloId,
        nombre: r.submodulo.nombre,
        url: r.submodulo.url,
        submoduloActivo: r.submodulo.activo,
        conexionActiva: r.activo,
        tenantToken: r.activo ? (r.tenantToken ?? null) : null,
        tokenExpiresAt: (r as TokenRow).tokenExpiresAt ?? null,
        estado: !r.activo
          ? 'inactivo'
          : !(r as TokenRow).tokenExpiresAt
            ? 'sin_conexion'
            : (r as TokenRow).tokenExpiresAt! < now
              ? 'expirado'
              : 'activo',
      }));
    } catch (error: unknown) {
      if (error instanceof AppError) throw error;
      const message =
        error instanceof Error ? error.message : 'Error desconocido';
      logger.error(`Error al obtener tokens de conexión: ${message}`);
      throw new AppError('Error al recuperar los tokens de conexión.', 500);
    }
  }

  /** Crea EmpresaSubmodulo + tenantToken si falta (p. ej. submódulo nuevo en catálogo). */
  async ensureEmpresaSubmoduloToken(
    empresaId: number,
    submoduloId: number,
  ): Promise<EmpresaSubmoduloRow | null> {
    const esCm = getEmpresaSubmoduloDelegate(prisma);
    if (!esCm) return null;

    const existing = await esCm.findFirst({
      where: { empresaId, submoduloId },
    });
    if (existing) return existing;

    const tenantToken = generateTenantToken(empresaId, submoduloId);
    logger.info(
      `Token provisionado empresa=${empresaId} submodulo=${submoduloId}`,
    );
    return esCm.create({
      data: {
        empresaId,
        submoduloId,
        activo: false,
        tenantToken,
      },
    });
  }

  /** Tras crear un submódulo: tokens para todas las empresas activas. */
  async provisionSubmoduleForAllCompanies(submoduloId: number) {
    const empresas = await prisma.empresa.findMany({
      where: { activo: true },
      select: { id: true },
    });
    await Promise.all(
      empresas.map((e) => this.ensureEmpresaSubmoduloToken(e.id, submoduloId)),
    );
    logger.info(
      `Submódulo ${submoduloId}: tokens provisionados para ${empresas.length} empresa(s)`,
    );
  }

  /** Al activar un módulo en una empresa: asegura tokens de todos sus submódulos. */
  async provisionModuleSubmodulesForCompany(
    empresaId: number,
    moduloId: number,
  ) {
    const subs = await prisma.submodulo.findMany({
      where: { moduloId, activo: true },
      select: { id: true },
    });
    await Promise.all(
      subs.map((s) => this.ensureEmpresaSubmoduloToken(empresaId, s.id)),
    );
  }
}
