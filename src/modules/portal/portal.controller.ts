import { Request, Response } from 'express';
import { PrismaClient } from '@prisma/client';
import logger from '../../utils/logger';

const prisma = new PrismaClient();

export class PortalController {
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
          detalle: detalle ?? null,
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
