/**
 * Solicitudes funerario — revisión técnica (scoring).
 *
 * POST   /api/funeral-submissions              → crear (x-api-key, emision-api)
 * GET    /api/funeral-submissions              → listar (revision-panel token)
 * GET    /api/funeral-submissions/:id          → detalle
 * POST   /api/funeral-submissions/:id/approve  → aprobar (fase 2: email + checkout)
 * POST   /api/funeral-submissions/:id/reject   → rechazar
 */
import { Router, Request, Response } from 'express';
import { apiKeyGuard } from '../../middlewares/apikey.middleware';
import { revisionPanelGuard } from './revision-panel.guard';
import { FuneralSubmissionService } from './funeral-submission.service';

const router = Router();
const svc = new FuneralSubmissionService();

router.post('/', apiKeyGuard, async (req: Request, res: Response) => {
  const body = req.body ?? {};
  const empresaId = Number(body.empresaId);
  const sessionId = String(body.sessionId ?? '').trim();
  const cplan = String(body.cplan ?? '').trim();

  if (!empresaId || !sessionId || !cplan) {
    res.status(400).json({
      success: false,
      message: 'Se requieren empresaId, sessionId y cplan.',
    });
    return;
  }

  try {
    const created = await svc.create({
      empresaId,
      sessionId,
      canal: body.canal,
      tomadorRif: body.tomadorRif,
      tomadorNombre: body.tomadorNombre,
      tomadorEmail: body.tomadorEmail,
      cplan,
      planName: body.planName,
      cramo: body.cramo != null ? Number(body.cramo) : undefined,
      scoreTotal: Number(body.scoreTotal) || 0,
      scoreBreakdown: Array.isArray(body.scoreBreakdown)
        ? body.scoreBreakdown
        : [],
      healthAnswers:
        body.healthAnswers && typeof body.healthAnswers === 'object'
          ? body.healthAnswers
          : {},
      snapshot:
        body.snapshot && typeof body.snapshot === 'object' ? body.snapshot : {},
    });
    res.status(201).json({ success: true, data: created });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : 'Error al crear solicitud';
    res.status(500).json({ success: false, message: msg });
  }
});

router.get('/', revisionPanelGuard, async (req: Request, res: Response) => {
  const empresaId = Number(req.query.empresaId ?? req.query.empresa);
  if (!empresaId) {
    res.status(400).json({
      success: false,
      message: 'Se requiere empresaId en query.',
    });
    return;
  }

  const estado =
    typeof req.query.estado === 'string' ? req.query.estado.trim() : undefined;

  try {
    const data = await svc.listByEmpresa(empresaId, { estado });
    res.json({ success: true, data, count: data.length });
  } catch (err: unknown) {
    const msg =
      err instanceof Error ? err.message : 'Error al listar solicitudes';
    res.status(500).json({ success: false, message: msg });
  }
});

router.get('/:id', revisionPanelGuard, async (req: Request, res: Response) => {
  const empresaId = req.query.empresaId
    ? Number(req.query.empresaId)
    : undefined;
  try {
    const data = await svc.getById(req.params.id, empresaId);
    if (!data) {
      res
        .status(404)
        .json({ success: false, message: 'Solicitud no encontrada.' });
      return;
    }
    res.json({ success: true, data });
  } catch (err: unknown) {
    const msg =
      err instanceof Error ? err.message : 'Error al obtener solicitud';
    res.status(500).json({ success: false, message: msg });
  }
});

router.post(
  '/:id/approve',
  revisionPanelGuard,
  async (req: Request, res: Response) => {
    const claims = (
      req as Request & { revisionClaims?: { empresaId?: number } }
    ).revisionClaims;
    const reviewedBy =
      typeof req.body?.reviewedBy === 'string'
        ? req.body.reviewedBy.trim()
        : 'tecnico';

    try {
      const data = await svc.approve(req.params.id, {
        reviewedBy,
        empresaId: claims?.empresaId,
      });
      if (!data) {
        res
          .status(404)
          .json({ success: false, message: 'Solicitud no encontrada.' });
        return;
      }
      res.json({ success: true, data });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Error al aprobar';
      res.status(400).json({ success: false, message: msg });
    }
  },
);

router.post(
  '/:id/reject',
  revisionPanelGuard,
  async (req: Request, res: Response) => {
    const claims = (
      req as Request & { revisionClaims?: { empresaId?: number } }
    ).revisionClaims;
    const reviewedBy =
      typeof req.body?.reviewedBy === 'string'
        ? req.body.reviewedBy.trim()
        : 'tecnico';
    const reason =
      typeof req.body?.reason === 'string' ? req.body.reason : undefined;

    try {
      const data = await svc.reject(req.params.id, {
        reviewedBy,
        reason,
        empresaId: claims?.empresaId,
      });
      if (!data) {
        res
          .status(404)
          .json({ success: false, message: 'Solicitud no encontrada.' });
        return;
      }
      res.json({ success: true, data });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Error al rechazar';
      res.status(400).json({ success: false, message: msg });
    }
  },
);

export default router;
