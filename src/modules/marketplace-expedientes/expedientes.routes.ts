/**
 * /api/expedientes — Monitor de expedientes Marketplace.
 * Interno: sesión del portal (Bearer, mismo esquema que /api/portal/*).
 * Admin (config, exclusiones, validar, jobs): requirePortalAdmin.
 * Con EXPEDIENTES_ENABLED apagado todas las rutas responden 404.
 */
import { NextFunction, Request, Response, Router } from 'express';
import rateLimit from 'express-rate-limit';
import { ZodError } from 'zod';
import { authenticate, AuthRequest } from '../../middlewares/auth.middleware';
import { requirePortalAdmin } from '../portal/portal-admin.middleware';
import { AppError } from '../../utils/app-error';
import logger from '../../utils/logger';
import {
  expedientesEnabled,
  expedientesJobsManualPermitido,
} from './expedientes.env';
import { expedientesService as svc } from './expedientes.service';
import {
  configUpdateSchema,
  exclusionCreateSchema,
  indicadoresQuerySchema,
  JOBS,
  JobName,
  listQuerySchema,
  observarSchema,
} from './expedientes.schema';
import { ejecutarJob } from './expedientes.jobs';

const router = Router();

type Handler = (req: AuthRequest, res: Response) => Promise<unknown>;

export function ok(res: Response, data: unknown, status = 200) {
  res.status(status).json({ status: 'success', success: true, data });
}

function fail(
  res: Response,
  status: number,
  message: string,
  details?: unknown,
) {
  res.status(status).json({
    status: 'error',
    success: false,
    message,
    ...(details ? { details } : {}),
  });
}

export function h(fn: Handler) {
  return async (req: Request, res: Response) => {
    try {
      await fn(req as AuthRequest, res);
    } catch (err) {
      if (err instanceof AppError)
        return fail(res, err.statusCode, err.message);
      if (err instanceof ZodError) {
        return fail(
          res,
          400,
          'Los datos proporcionados no son válidos.',
          err.errors.map((e) => ({
            field: e.path.join('.'),
            message: e.message,
          })),
        );
      }
      logger.error(
        `[expedientes] ${req.method} ${req.baseUrl}${req.route?.path ?? ''}: ${
          err instanceof Error ? err.message : 'error'
        }`,
      );
      return fail(res, 500, 'Error interno del monitor de expedientes.');
    }
  };
}

export function actorDe(req: AuthRequest): string {
  const u = req.user;
  return u ? `portal:${u.id}:${u.email ?? ''}`.slice(0, 128) : 'desconocido';
}

function idParam(req: Request): number {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) throw new AppError('id inválido.', 400);
  return id;
}

// Apagado por defecto: sin la variable, el módulo no existe.
router.use((_req: Request, res: Response, next: NextFunction) => {
  if (!expedientesEnabled()) return fail(res, 404, 'Ruta no encontrada');
  res.setHeader('Cache-Control', 'no-store');
  next();
});

const internoLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 300,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: {
    status: 'error',
    success: false,
    message: 'Demasiadas peticiones.',
  },
});

// ─── Jobs (solo fuera de producción) ───────────────────────────────────────

router.post(
  '/jobs/:job/ejecutar',
  internoLimiter,
  authenticate,
  requirePortalAdmin,
  h(async (req, res) => {
    if (!expedientesJobsManualPermitido())
      return fail(res, 404, 'Ruta no encontrada');
    const job = String(req.params.job) as JobName;
    if (!(JOBS as readonly string[]).includes(job)) {
      throw new AppError(`Tarea desconocida. Use: ${JOBS.join(', ')}.`, 400);
    }
    const forzar = req.body?.forzar === true || req.query.forzar === 'true';
    const r = await ejecutarJob(job, {
      origen: 'manual',
      forzar,
      actor: actorDe(req),
    });
    return ok(res, r);
  }),
);

// ─── Lectura (cualquier sesión del portal) ────────────────────────────────

router.get(
  '/',
  internoLimiter,
  authenticate,
  h(async (req, res) => {
    const q = listQuerySchema.parse(req.query);
    return ok(res, await svc.listar(q));
  }),
);

router.get(
  '/indicadores',
  internoLimiter,
  authenticate,
  h(async (req, res) => {
    const q = indicadoresQuerySchema.parse(req.query);
    return ok(res, await svc.indicadores(q));
  }),
);

router.get(
  '/:id(\\d+)',
  internoLimiter,
  authenticate,
  h(async (req, res) => ok(res, await svc.detalle(idParam(req)))),
);

// ─── Configuración (admin; cada cambio con motivo y auditoría) ────────────

router.get(
  '/config',
  internoLimiter,
  authenticate,
  requirePortalAdmin,
  h(async (_req, res) => ok(res, await svc.getConfig())),
);

router.put(
  '/config',
  internoLimiter,
  authenticate,
  requirePortalAdmin,
  h(async (req, res) => {
    const body = configUpdateSchema.shape.body.parse(req.body ?? {});
    return ok(
      res,
      await svc.updateConfig(
        body as Parameters<typeof svc.updateConfig>[0],
        actorDe(req),
      ),
    );
  }),
);

// ─── Exclusiones «No enviar correos» (admin; no cambian el estado) ─────────

router.get(
  '/exclusiones',
  internoLimiter,
  authenticate,
  requirePortalAdmin,
  h(async (req, res) =>
    ok(res, await svc.listarExclusiones(req.query.todas === 'true')),
  ),
);

router.post(
  '/exclusiones',
  internoLimiter,
  authenticate,
  requirePortalAdmin,
  h(async (req, res) => {
    const body = exclusionCreateSchema.shape.body.parse(req.body ?? {});
    return ok(res, await svc.crearExclusion(body, actorDe(req)), 201);
  }),
);

router.delete(
  '/exclusiones/:id(\\d+)',
  internoLimiter,
  authenticate,
  requirePortalAdmin,
  h(async (req, res) => {
    const motivoRaw = req.body?.motivo ?? req.query.motivo;
    const motivo =
      typeof motivoRaw === 'string' ? motivoRaw.trim().slice(0, 500) : '';
    return ok(
      res,
      await svc.eliminarExclusion(
        idParam(req),
        actorDe(req),
        motivo || undefined,
      ),
    );
  }),
);

// ─── Validación manual (admin; solo si validacion=manual) ─────────────────

router.post(
  '/:id(\\d+)/requisitos/:tipo/validar',
  internoLimiter,
  authenticate,
  requirePortalAdmin,
  h(async (req, res) =>
    ok(
      res,
      await svc.validarManual(
        idParam(req),
        String(req.params.tipo),
        'validar',
        actorDe(req),
      ),
    ),
  ),
);

router.post(
  '/:id(\\d+)/requisitos/:tipo/observar',
  internoLimiter,
  authenticate,
  requirePortalAdmin,
  h(async (req, res) => {
    const { body } = observarSchema.parse({ body: req.body ?? {} });
    return ok(
      res,
      await svc.validarManual(
        idParam(req),
        String(req.params.tipo),
        'observar',
        actorDe(req),
        body.motivo,
      ),
    );
  }),
);

export default router;
