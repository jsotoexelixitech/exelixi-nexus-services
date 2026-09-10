import { Router, Request, Response } from 'express';
import { EmisionService } from './emision.service';
import { apiKeyGuard } from '../../middlewares/apikey.middleware';

const router = Router();
const svc = new EmisionService();

/**
 * POST /api/emisiones
 * Registra una póliza emitida exitosamente.
 * Requiere x-api-key (llamado desde emision-api / pagos-api).
 *
 * Body: {
 *   empresaId, producto, polizaNumero,
 *   cnrecibo?, urlpoliza?, tomadorNombre?, tomadorIdentificacion?,
 *   planNombre?, frecuencia?, monto?, jsonData?
 * }
 */
router.post('/', apiKeyGuard, async (req: Request, res: Response) => {
  const {
    empresaId,
    producto,
    polizaNumero,
    cnrecibo,
    urlpoliza,
    tomadorNombre,
    tomadorIdentificacion,
    planNombre,
    frecuencia,
    monto,
    jsonData,
  } = req.body || {};

  if (!empresaId || !producto || !polizaNumero) {
    res.status(400).json({
      success: false,
      message: 'Se requieren empresaId, producto y polizaNumero.',
    });
    return;
  }

  try {
    const emision = await svc.registrar({
      empresaId: Number(empresaId),
      producto,
      polizaNumero,
      cnrecibo,
      urlpoliza,
      tomadorNombre,
      tomadorIdentificacion,
      planNombre,
      frecuencia,
      monto: monto != null ? Number(monto) : undefined,
      jsonData,
    });
    res.status(201).json({ success: true, data: emision });
  } catch (err: unknown) {
    const msg =
      err instanceof Error ? err.message : 'Error al registrar emisión';
    res.status(500).json({ success: false, message: msg });
  }
});

/**
 * GET /api/emisiones/trafico?desde=YYYY-MM-DD&hasta=YYYY-MM-DD
 * Devuelve el tráfico de pólizas agrupado por empresa.
 * Requiere x-api-key.
 */
router.get('/trafico', apiKeyGuard, async (req: Request, res: Response) => {
  const { desde, hasta } = req.query as { desde?: string; hasta?: string };
  try {
    const data = await svc.trafico(desde, hasta);
    res.json({ success: true, data });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : 'Error al obtener tráfico';
    res.status(500).json({ success: false, message: msg });
  }
});

/**
 * GET /api/emisiones/empresa/:id?desde=YYYY-MM-DD&hasta=YYYY-MM-DD
 * Emisiones de una empresa específica.
 * Requiere x-api-key.
 */
router.get('/empresa/:id', apiKeyGuard, async (req: Request, res: Response) => {
  const { desde, hasta } = req.query as { desde?: string; hasta?: string };
  const empresaId = Number(req.params.id);
  if (isNaN(empresaId)) {
    res.status(400).json({ success: false, message: 'empresaId inválido.' });
    return;
  }
  try {
    const data = await svc.porEmpresa(empresaId, desde, hasta);
    res.json({ success: true, data });
  } catch (err: unknown) {
    const msg =
      err instanceof Error ? err.message : 'Error al obtener emisiones';
    res.status(500).json({ success: false, message: msg });
  }
});

export default router;
