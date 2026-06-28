import prisma from '../../config/prisma';
import {
  verifyTenantToken,
  buildAccessUrl,
  generateAccessToken,
  generateSsoToken,
} from '../../utils/tenant-token';
import { AppError } from '../../utils/app-error';
import logger from '../../utils/logger';

/** 8 horas — ventana de renovación por cada petición activa */
const TOKEN_TTL_MS = 8 * 60 * 60 * 1000;

export class AccessService {
  /**
   * GET /api/access/verify
   * Verifica token, empresa y submódulo activos.
   * Llamado por el frontend de cada módulo al cargar la app.
   */
  async verify(token: string) {
    let payload: ReturnType<typeof verifyTenantToken>;
    try {
      payload = verifyTenantToken(token);
    } catch {
      throw new AppError('Token de acceso inválido o manipulado.', 401);
    }

    const { empresaId, submoduloId } = payload;

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

    const submodulo = await prisma.submodulo.findUnique({
      where: { id: submoduloId },
      select: { id: true, nombre: true, url: true, activo: true },
    });

    if (!submodulo || !submodulo.activo) {
      logger.info(`verify: submodulo ${submoduloId} inactivo o no existe`);
      return { active: false, reason: 'Servicio no disponible.' };
    }

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
        logger.info(
          `verify: modulo ${moduloId} no activado para empresa ${empresaId}`,
        );
        return {
          active: false,
          reason: 'Servicio no activado para esta empresa.',
        };
      }
    }

    const empresaSubmodulo = await (
      prisma as unknown as {
        empresaSubmodulo: {
          findFirst: (args: {
            where: { empresaId: number; submoduloId: number };
          }) => Promise<{
            id: number;
            activo: boolean;
            tenantToken: string | null;
            tokenExpiresAt: Date | null;
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
      return {
        active: false,
        reason: 'Servicio no activado para esta empresa.',
      };
    }

    // Corte por inactividad: si tokenExpiresAt venció, la sesión expiró
    if (
      empresaSubmodulo.tokenExpiresAt &&
      empresaSubmodulo.tokenExpiresAt < new Date()
    ) {
      logger.info(
        `verify: sesión expirada por inactividad empresa=${empresaId} sub=${submoduloId}`,
      );
      return {
        active: false,
        reason: 'Sesión expirada por inactividad. Reconecte la aplicación.',
      };
    }

    logger.info(
      `verify: acceso concedido empresa=${empresaId} submodulo=${submoduloId}`,
    );

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
        accessUrl: submodulo.url ? buildAccessUrl(submodulo.url, token) : null,
      },
    };
  }

  /**
   * POST /api/auth/token
   * Intercambia un API Key permanente (tenantToken original) por un Access Token temporal (1h).
   * Implementa el protocolo OAuth 2.0 (Client Credentials Grant).
   */
  async exchangeToken(apiKey: string) {
    // 1. Validar la firma del API Key (que es un tenantToken permanente válido)
    let payload;
    try {
      payload = verifyTenantToken(apiKey);
    } catch {
      throw new AppError('API Key inválido o manipulado.', 401);
    }

    const { empresaId, submoduloId } = payload;

    // 2. Verificar que la empresa y el submódulo estén activos en BD
    const esm = await (
      prisma as unknown as {
        empresaSubmodulo: {
          findFirst: (args: {
            where: { empresaId: number; submoduloId: number };
            select: {
              id: boolean;
              activo: boolean;
              empresa: { select: { activo: boolean } };
            };
          }) => Promise<{
            id: number;
            activo: boolean;
            empresa: { activo: boolean };
          } | null>;
        };
      }
    ).empresaSubmodulo.findFirst({
      where: { empresaId, submoduloId },
      select: {
        id: true,
        activo: true,
        empresa: { select: { activo: true } },
      },
    });

    if (!esm) {
      throw new AppError('Registro de acceso no encontrado.', 403);
    }
    if (!esm.empresa.activo) {
      throw new AppError('Empresa inactiva. Contacte a su administrador.', 403);
    }
    if (!esm.activo) {
      throw new AppError('Módulo inactivo para esta empresa.', 403);
    }

    // 3. Generar el nuevo Access Token temporal usando la misma combinación
    const accessToken = generateAccessToken(empresaId, submoduloId);

    logger.info(
      `exchangeToken: emitido access_token para empresa=${empresaId} sub=${submoduloId}`,
    );

    return {
      access_token: accessToken,
      token_type: 'Bearer',
      expires_in: 3600, // 1 hora en segundos
    };
  }

  /**
   * POST /api/access/heartbeat
   *
   * Llamado por el backend de cada módulo en CADA petición del usuario.
   * Verifica que la empresa y el submódulo sigan activos y desliza
   * la ventana de tokenExpiresAt +8h en BD.
   *
   * Regla de oro:
   *   empresa.activo = TRUE  → token SIEMPRE se renueva → acceso garantizado
   *   empresa.activo = FALSE → 403 inmediato sin importar nada más
   *
   * Esto garantiza que ningún flujo activo sea interrumpido por expiración
   * de token. La única razón de bloqueo es la desactivación explícita por admin.
   */
  async heartbeat(token: string): Promise<{
    active: boolean;
    reason?: string;
    access_token?: string;
    expires_in?: number;
  }> {
    // 1. Verificar firma JWT (local, sin red)
    let payload: ReturnType<typeof verifyTenantToken>;
    try {
      payload = verifyTenantToken(token);
    } catch {
      throw new AppError('Token inválido o manipulado.', 401);
    }

    const { empresaId, submoduloId } = payload;

    // 2. Una sola query: empresa_submodulo + empresa activa
    const esm = await (
      prisma as unknown as {
        empresaSubmodulo: {
          findFirst: (args: {
            where: { empresaId: number; submoduloId: number };
            select: {
              id: boolean;
              activo: boolean;
              tokenExpiresAt: boolean;
              empresa: { select: { activo: boolean; nombre: boolean } };
            };
          }) => Promise<{
            id: number;
            activo: boolean;
            tokenExpiresAt: Date | null;
            empresa: { activo: boolean; nombre: string };
          } | null>;
        };
      }
    ).empresaSubmodulo.findFirst({
      where: { empresaId, submoduloId },
      select: {
        id: true,
        activo: true,
        tokenExpiresAt: true,
        empresa: { select: { activo: true, nombre: true } },
      },
    });

    // 3. Validaciones de estado
    if (!esm) {
      logger.warn(
        `heartbeat: empresa_submodulo no encontrado empresa=${empresaId} sub=${submoduloId}`,
      );
      return { active: false, reason: 'Registro de acceso no encontrado.' };
    }

    if (!esm.empresa.activo) {
      logger.info(`heartbeat: empresa ${empresaId} inactiva — acceso denegado`);
      return {
        active: false,
        reason: 'Empresa inactiva. Contacte a su administrador.',
      };
    }

    if (!esm.activo) {
      logger.info(
        `heartbeat: submodulo ${submoduloId} inactivo para empresa ${empresaId}`,
      );
      return { active: false, reason: 'Módulo inactivo para esta empresa.' };
    }

    // 4. Renovar la ventana en BD (siempre que empresa esté activa)
    //    No importa si tokenExpiresAt ya venció — empresa activa = renovación garantizada
    const newExpiry = new Date(Date.now() + TOKEN_TTL_MS);

    await (
      prisma as unknown as {
        empresaSubmodulo: {
          update: (args: {
            where: { id: number };
            data: { tokenExpiresAt: Date };
          }) => Promise<unknown>;
        };
      }
    ).empresaSubmodulo.update({
      where: { id: esm.id },
      data: { tokenExpiresAt: newExpiry },
    });

    // Emitir nuevo access_token con la misma metadata que trajo el original
    // (preserva cproductor/canal si venía en el payload SSO)
    const newToken = payload.metadata
      ? generateSsoToken(empresaId, submoduloId, payload.metadata)
      : generateAccessToken(empresaId, submoduloId);

    logger.info(
      `heartbeat: renovado empresa=${empresaId} sub=${submoduloId} expires=${newExpiry.toISOString()}`,
    );

    return { active: true, access_token: newToken, expires_in: 3600 };
  }
}
