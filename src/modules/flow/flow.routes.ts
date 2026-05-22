/**
 * flow.routes.ts
 *
 * Endpoints del bridge inter-módulo:
 *   POST /api/flow/start                 → inicia un flujo (requiere API key)
 *   GET  /api/flow/session/:sid          → rehidratación (público para módulos)
 *   POST /api/flow/save/:sid             → guarda estado parcial (público)
 *   POST /api/flow/done/:sid?from=N      → avanza al siguiente módulo (público)
 */

import { Router, Request, Response } from 'express';
import { startFlow, getSession, saveSession, advanceSession } from './flow.service';
import { apiKeyGuard } from '../../middlewares/apikey.middleware';

const router = Router();

/**
 * POST /api/flow/start
 * Inicia el flujo para una empresa + grupo de módulos.
 * Requiere x-api-key (llamado desde el admin panel).
 *
 * Body: { empresaId: number, moduloGroupId: number }
 */
router.post('/start', apiKeyGuard, async (req: Request, res: Response) => {
  const { empresaId, moduloGroupId } = req.body as { empresaId?: number; moduloGroupId?: number };

  if (!empresaId || !moduloGroupId) {
    res.status(400).json({ success: false, message: 'Se requiere empresaId y moduloGroupId.' });
    return;
  }

  const result = await startFlow(Number(empresaId), Number(moduloGroupId));

  if ('error' in result) {
    res.status(400).json({ success: false, message: result.error });
    return;
  }

  res.json({ success: true, data: result });
});

/**
 * GET /api/flow/session/:sid
 * Rehidratación del wizard store al cargar un módulo.
 * Público (llamado desde los frontends de módulos).
 */
router.get('/session/:sid', async (req: Request, res: Response) => {
  const session = getSession(req.params.sid);
  if (!session) {
    res.status(404).json({ success: false, message: 'Sesión no encontrada o expirada.' });
    return;
  }
  res.json({ success: true, data: session });
});

/**
 * POST /api/flow/save/:sid
 * Guarda estado parcial del wizard (autosave o save manual).
 * Público (llamado desde los frontends de módulos).
 */
router.post('/save/:sid', async (req: Request, res: Response) => {
  const patch = (req.body && typeof req.body === 'object') ? req.body as Record<string, unknown> : {};
  const result = saveSession(req.params.sid, patch);
  if (!result) {
    res.status(404).json({ success: false, message: 'Sesión no encontrada.' });
    return;
  }
  res.json({ success: true, data: result });
});

/**
 * POST /api/flow/done/:sid?from=N
 * Marca el módulo actual (order=N) como completado y retorna la URL del siguiente.
 * Público (llamado desde los frontends de módulos).
 */
router.post('/done/:sid', async (req: Request, res: Response) => {
  const fromOrder = Number(req.query.from ?? 0);
  const patch = (req.body && typeof req.body === 'object') ? req.body as Record<string, unknown> : {};
  const result = advanceSession(req.params.sid, fromOrder, patch);
  if (!result) {
    res.status(404).json({ success: false, message: 'Sesión no encontrada.' });
    return;
  }
  res.json({ success: true, data: result });
});

export default router;
