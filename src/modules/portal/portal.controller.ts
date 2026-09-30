import { Prisma } from '@prisma/client';
import { Request, Response } from 'express';
import logger from '../../utils/logger';
import prisma from '../../config/prisma';
import { AuthRequest } from '../../middlewares/auth.middleware';
import { PortalService } from './portal.service';
import { AppError } from '../../utils/app-error';
import { getErrorMessage } from '../../utils/error-handler';
import { loginPortalSis2000 } from './portal-sis2000-login.service';
import { startPortalSsoSession } from './portal-sso-session.service';

function portalErrorStatus(error: unknown): number {
  if (error instanceof AppError) return error.statusCode;
  const msg = getErrorMessage(error);
  if (msg.includes('inactiv')) return 403;
  if (msg.includes('no encontrado')) return 404;
  return 500;
}

const portalService = new PortalService();

export class PortalController {
  /**
   * POST /api/portal/login-sis2000
   * Login con usuario/clave Sis2000 (mismos del marketplace). Respuesta igual a /api/auth/login.
   */
  loginSis2000 = async (req: Request, res: Response): Promise<void> => {
    const { xlogin, xcontrasena } = (req.body ?? {}) as {
      xlogin?: unknown;
      xcontrasena?: unknown;
    };
    if (
      typeof xlogin !== 'string' ||
      typeof xcontrasena !== 'string' ||
      !xlogin.trim() ||
      !xcontrasena ||
      xlogin.length > 100 ||
      xcontrasena.length > 100
    ) {
      res
        .status(400)
        .json({ success: false, message: 'Ingrese usuario y contraseña.' });
      return;
    }
    try {
      const result = await loginPortalSis2000(xlogin, xcontrasena);
      res.json(result);
    } catch (error: unknown) {
      const status = error instanceof AppError ? error.statusCode : 500;
      if (status >= 500)
        logger.error(`[portal] login Sis2000: ${getErrorMessage(error)}`);
      res.status(status).json({
        success: false,
        message:
          status >= 500 && !(error instanceof AppError)
            ? 'No se pudo iniciar sesión. Intente de nuevo.'
            : getErrorMessage(error),
      });
    }
  };

  /**
   * POST /api/portal/sso-session
   * Canjea el pase de Sis2000 (sso-delegate target "marketplace") por la sesión del portal.
   */
  ssoSession = async (req: Request, res: Response): Promise<void> => {
    const { nexus_token } = (req.body ?? {}) as { nexus_token?: unknown };
    if (
      typeof nexus_token !== 'string' ||
      !nexus_token.trim() ||
      nexus_token.length > 4096
    ) {
      res
        .status(400)
        .json({ success: false, message: 'Falta el acceso de Sis2000.' });
      return;
    }
    try {
      const result = await startPortalSsoSession(nexus_token.trim());
      res.json(result);
    } catch (error: unknown) {
      const status = error instanceof AppError ? error.statusCode : 500;
      if (status >= 500)
        logger.error(`[portal] SSO Sis2000: ${getErrorMessage(error)}`);
      res.status(status).json({
        success: false,
        message:
          status >= 500 && !(error instanceof AppError)
            ? 'No se pudo abrir el marketplace. Intente de nuevo.'
            : getErrorMessage(error),
      });
    }
  };

  /**
   * GET /api/portal/me
   * Contexto de sesión (usuario + empresa) para el portal.
   */
  getMe = async (req: AuthRequest, res: Response): Promise<void> => {
    try {
      const userId = req.user?.id;
      if (!userId) {
        res.status(401).json({ success: false, message: 'No autorizado.' });
        return;
      }
      const user = await portalService.getSessionContext(userId);
      const canal = await portalService.getResolvedCanal(userId);
      res.json({
        success: true,
        data: {
          user: {
            id: user.id,
            nombre: user.nombre,
            email: user.email,
            role: user.role.nombre,
          },
          empresa: {
            id: user.empresa.id,
            nombre: user.empresa.nombre,
          },
          canal,
          portalPerfil: user.portalPerfil,
          empresaPortalConfig: user.empresa.portalConfig,
        },
      });
    } catch (error: unknown) {
      const msg = getErrorMessage(error);
      res
        .status(portalErrorStatus(error))
        .json({ success: false, message: msg });
    }
  };

  /**
   * GET /api/portal/products
   * Flujos / emisiones disponibles según empresa y permisos (sin API Key en portal).
   */
  getProducts = async (req: AuthRequest, res: Response): Promise<void> => {
    try {
      const userId = req.user?.id;
      if (!userId) {
        res.status(401).json({ success: false, message: 'No autorizado.' });
        return;
      }
      const products = await portalService.getAvailableProducts(userId);
      res.json({ success: true, data: products });
    } catch (error: unknown) {
      const msg = getErrorMessage(error);
      res
        .status(portalErrorStatus(error))
        .json({ success: false, message: msg });
    }
  };

  /**
   * POST /api/portal/audit
   * Registra una acción del portal (launch de producto SSO).
   * Requiere: Bearer token (usuario autenticado en Nexus).
   */
  registerAudit = async (req: Request, res: Response): Promise<void> => {
    try {
      const userId = (req as unknown as { user?: { id: number } }).user?.id;
      if (!userId) {
        res.status(401).json({ success: false, message: 'No autorizado.' });
        return;
      }

      const { accion, producto, detalle } = req.body as {
        accion: string;
        producto?: string;
        detalle?: Record<string, unknown>;
      };

      if (!accion) {
        res
          .status(400)
          .json({ success: false, message: 'Campo "accion" requerido.' });
        return;
      }

      // Buscar sesión activa o crearla en caso de ser primera acción
      let session = await prisma.portalSession.findFirst({
        where: { usuarioId: userId },
        orderBy: { createdAt: 'desc' },
      });

      if (!session) {
        // Crear sesión on-demand
        const expiresAt = new Date(Date.now() + 60 * 60 * 1000); // 1h
        session = await prisma.portalSession.create({
          data: {
            usuarioId: userId,
            ipAddress: req.ip ?? '',
            userAgent: req.headers['user-agent'] ?? null,
            token: req.headers.authorization?.replace('Bearer ', '') ?? '',
            expiresAt,
          },
        });
      }

      await prisma.portalAuditLog.create({
        data: {
          sessionId: session.id,
          accion,
          producto: producto ?? null,
          detalle: detalle ? (detalle as Prisma.InputJsonValue) : undefined,
        },
      });

      logger.info(
        `[portal-audit] usuario=${userId} accion=${accion} producto=${producto ?? '-'}`,
      );
      res.json({ success: true });
    } catch (err) {
      logger.error('[portal-audit] error:', err);
      res.status(500).json({ success: false, message: 'Error interno.' });
    }
  };

  /**
   * GET /api/portal/audit
   * Devuelve el historial de acciones del usuario autenticado.
   */
  getAuditLogs = async (req: Request, res: Response): Promise<void> => {
    try {
      const userId = (req as unknown as { user?: { id: number } }).user?.id;
      if (!userId) {
        res.status(401).json({ success: false, message: 'No autorizado.' });
        return;
      }

      const logs = await prisma.portalAuditLog.findMany({
        where: {
          session: { usuarioId: userId },
        },
        orderBy: { createdAt: 'desc' },
        take: 100,
        select: {
          id: true,
          accion: true,
          producto: true,
          detalle: true,
          createdAt: true,
        },
      });

      res.json(logs);
    } catch (err) {
      logger.error('[portal-audit] get error:', err);
      res.status(500).json({ success: false, message: 'Error interno.' });
    }
  };
}
