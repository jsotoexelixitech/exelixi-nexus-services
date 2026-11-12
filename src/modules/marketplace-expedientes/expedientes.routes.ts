/**
 * /api/expedientes — Monitor de expedientes Marketplace.
 * Interno: sesión del portal (Bearer, mismo esquema que /api/portal/*).
 * Admin (config, exclusiones, validar, jobs): requirePortalAdmin.
 * Todas las rutas internas exigen además la lista de acceso EXPEDIENTES_USUARIOS
 * (vacía = cerrado en producción; ver expedientes.usuarios.ts). GET /acceso informa si la
 * sesión entra, para que el portal oculte el monitor a quien no está en la lista.
 * Con EXPEDIENTES_ENABLED apagado todas las rutas responden 404.
 * QA con EXPEDIENTES_ACCESO_LIBRE (nunca en producción): sin Authorization, todas las rutas
 * internas entran como administrador ficticio (actor `qa-acceso-libre`). Con sesión real,
 * se usa la sesión real. Las rutas públicas no cambian.
 * Sesión abierta por SSO (Sis2000/SysIP): las rutas que ESCRIBEN configuración (config,
 * OCR por canal, exclusiones) responden 403 (`sinSso`); las lecturas no cambian.
 */
import { NextFunction, Request, Response, Router } from 'express';
import rateLimit from 'express-rate-limit';
import { ZodError } from 'zod';
import { authenticate, AuthRequest } from '../../middlewares/auth.middleware';
import { requirePortalAdmin } from '../portal/portal-admin.middleware';
import { AppError } from '../../utils/app-error';
import logger from '../../utils/logger';
import {
  expedientesAccesoLibre,
  expedientesEnabled,
  expedientesJobsManualPermitido,
  MENSAJE_OCR_CANAL_SOLO_LECTURA,
  ocrCanalEscrituraHabilitada,
} from './expedientes.env';
import {
  requireListaMonitor,
  requireSinSso,
  sesionPermitida,
} from './expedientes.usuarios';
import { expedientesService as svc } from './expedientes.service';
import {
  actoresQuerySchema,
  configUpdateSchema,
  exclusionCreateSchema,
  exclusionesQuerySchema,
  exclusionLoteSchema,
  indicadoresQuerySchema,
  JOBS,
  JobName,
  listQuerySchema,
  observarSchema,
  ocrPorCanalQuerySchema,
  ocrPorCanalUpdateSchema,
  puntosCanalQuerySchema,
  validarSchema,
} from './expedientes.schema';
import {
  empresaOcrPorCanal,
  guardarOcrPorCanal,
  obtenerOcrPorCanal,
  puntosDeCanal,
} from './expedientes.ocr-canal';
import { ejecutarJob } from './expedientes.jobs';
import { leerMultipart } from './expedientes.files';
import { crearRouterIntegracion } from './expedientes.integracion.routes';
import {
  claveAsegurado,
  CODIGO_MINUTOS,
  CODIGO_REENVIO_SEGUNDOS,
  MENSAJE_VERIFICAR,
  solicitarCodigo,
  verificarCodigo,
  verificarCodigoSchema,
  verificarIdentidadSchema,
} from './expedientes.acceso';

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

export const ACTOR_ACCESO_LIBRE = 'qa-acceso-libre';

type ExpedientesRequest = AuthRequest & { accesoLibre?: boolean };

/**
 * Sesión del portal. En QA con acceso libre, una petición SIN Authorization entra como
 * administrador ficticio; si trae Authorization se valida la sesión real como siempre.
 * Con `lista` (todas las rutas internas), la sesión real debe estar en EXPEDIENTES_USUARIOS.
 */
function sesionBase(lista: boolean) {
  return (req: Request, res: Response, next: NextFunction) => {
    if (!req.headers.authorization && expedientesAccesoLibre()) {
      (req as ExpedientesRequest).accesoLibre = true;
      // Solo método y ruta (ids internos): sin query, sin datos personales.
      logger.info(
        `[expedientes] acceso libre QA sin sesión: ${req.method} ${req.baseUrl}${req.path}`,
      );
      return next();
    }
    return authenticate(req as AuthRequest, res, () =>
      lista ? requireListaMonitor(req as AuthRequest, res, next) : next(),
    );
  };
}

const sesion = sesionBase(true);
const sesionSinLista = sesionBase(false);

function admin(req: Request, res: Response, next: NextFunction) {
  if ((req as ExpedientesRequest).accesoLibre) return next();
  return requirePortalAdmin(req as AuthRequest, res, next);
}

/** Escritura de configuración: no desde una sesión SSO (la pestaña tampoco se muestra). */
function sinSso(req: Request, res: Response, next: NextFunction) {
  if ((req as ExpedientesRequest).accesoLibre) return next();
  return requireSinSso(req as AuthRequest, res, next);
}

export function actorDe(req: AuthRequest): string {
  if ((req as ExpedientesRequest).accesoLibre) return ACTOR_ACCESO_LIBRE;
  const u = req.user;
  return u ? `portal:${u.id}:${u.email ?? ''}`.slice(0, 128) : 'desconocido';
}

function idParam(req: Request): number {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) throw new AppError('id inválido.', 400);
  return id;
}

// Apagado por defecto: sin la variable, el módulo no existe (404). La página
// pública recibe 503 para mostrar "servicio no disponible" en vez de "enlace inválido".
router.use((req: Request, res: Response, next: NextFunction) => {
  if (!expedientesEnabled()) {
    return req.path.startsWith('/publico/')
      ? fail(res, 503, 'Servicio no disponible')
      : fail(res, 404, 'Ruta no encontrada');
  }
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

// ─── API de documentos para integradores (interno nest-api → Nexus) ───────
// Clave interna propia (x-expediente-key); no usa la sesión del portal ni la lista del monitor.
router.use('/integracion', crearRouterIntegracion(h, ok));

// ─── Jobs (solo fuera de producción) ───────────────────────────────────────

// QA: correo de prueba con enlace real a un correo de la lista blanca (nunca en producción).
router.post(
  '/:id(\\d+)/enviar-prueba',
  internoLimiter,
  sesion,
  admin,
  h(async (req, res) => {
    if (!expedientesJobsManualPermitido())
      return fail(res, 404, 'Ruta no encontrada');
    const email = typeof req.body?.email === 'string' ? req.body.email : '';
    return ok(res, await svc.enviarPrueba(idParam(req), email, actorDe(req)));
  }),
);

router.post(
  '/jobs/:job/ejecutar',
  internoLimiter,
  sesion,
  admin,
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

// ─── Acceso (el portal decide si muestra el monitor) ───────────────────────

router.get(
  '/acceso',
  internoLimiter,
  sesionSinLista,
  h(async (req, res) => {
    const libre = (req as ExpedientesRequest).accesoLibre === true;
    return ok(res, {
      acceso: libre || sesionPermitida(req.user),
      ocrPorCanalEscritura: ocrCanalEscrituraHabilitada(),
    });
  }),
);

// ─── Lectura (sesión del portal en la lista EXPEDIENTES_USUARIOS) ──────────

router.get(
  '/',
  internoLimiter,
  sesion,
  h(async (req, res) => {
    const q = listQuerySchema.parse(req.query);
    return ok(res, await svc.listar(q));
  }),
);

router.get(
  '/indicadores',
  internoLimiter,
  sesion,
  h(async (req, res) => {
    const q = indicadoresQuerySchema.parse(req.query);
    return ok(res, await svc.indicadores(q));
  }),
);

router.get(
  '/:id(\\d+)',
  internoLimiter,
  sesion,
  h(async (req, res) => ok(res, await svc.detalle(idParam(req)))),
);

// ─── Configuración (admin; cada cambio con motivo y auditoría) ────────────

router.get(
  '/config',
  internoLimiter,
  sesion,
  admin,
  h(async (_req, res) => ok(res, await svc.getConfigConCambios())),
);

router.put(
  '/config',
  internoLimiter,
  sesion,
  admin,
  sinSso,
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

// ─── OCR por canal (admin; misma config que el parametrizador del OCR) ─────

function empresaOcrDe(req: AuthRequest): number {
  return empresaOcrPorCanal(
    (req as ExpedientesRequest).accesoLibre === true,
    req.user?.empresaId,
  );
}

router.get(
  '/ocr-por-canal',
  internoLimiter,
  sesion,
  admin,
  h(async (req, res) => {
    const q = ocrPorCanalQuerySchema.parse(req.query);
    const vista = await obtenerOcrPorCanal(empresaOcrDe(req), q.producto);
    return ok(res, {
      ...vista,
      escrituraHabilitada: ocrCanalEscrituraHabilitada(),
    });
  }),
);

/** Puntos de comercialización de un canal (solo lectura; siguen la config del canal). */
router.get(
  '/ocr-por-canal/puntos',
  internoLimiter,
  sesion,
  admin,
  h(async (req, res) => {
    const q = puntosCanalQuerySchema.parse(req.query);
    return ok(res, await puntosDeCanal(q));
  }),
);

router.put(
  '/ocr-por-canal',
  internoLimiter,
  sesion,
  admin,
  sinSso,
  h(async (req, res) => {
    // Cambia si el OCR es obligatorio en la emisión: solo con la variable explícita.
    if (!ocrCanalEscrituraHabilitada())
      return fail(res, 403, MENSAJE_OCR_CANAL_SOLO_LECTURA);
    const body = ocrPorCanalUpdateSchema.parse(req.body ?? {});
    return ok(
      res,
      await guardarOcrPorCanal(empresaOcrDe(req), body, actorDe(req)),
    );
  }),
);

// ─── Exclusiones «No enviar correos» (admin; no cambian el estado) ─────────

router.get(
  '/exclusiones',
  internoLimiter,
  sesion,
  admin,
  h(async (req, res) => {
    const q = exclusionesQuerySchema.parse(req.query);
    return ok(res, await svc.listarExclusiones(q.todas === 'true', q.alcance));
  }),
);

router.post(
  '/exclusiones',
  internoLimiter,
  sesion,
  admin,
  sinSso,
  h(async (req, res) => {
    const body = exclusionCreateSchema.shape.body.parse(req.body ?? {});
    return ok(res, await svc.crearExclusion(body, actorDe(req)), 201);
  }),
);

/** Selección múltiple: { alcance, motivo, valores[] } → una exclusión por valor. */
router.post(
  '/exclusiones/lote',
  internoLimiter,
  sesion,
  admin,
  sinSso,
  h(async (req, res) => {
    const body = exclusionLoteSchema.shape.body.parse(req.body ?? {});
    return ok(res, await svc.crearExclusionesLote(body, actorDe(req)), 201);
  }),
);

/** Valores para elegir en exclusiones: canal | gestor | intermediario (sin Sis2000). */
router.get(
  '/actores',
  internoLimiter,
  sesion,
  admin,
  h(async (req, res) => {
    const q = actoresQuerySchema.parse(req.query);
    return ok(res, await svc.actores(q.tipo, q.q));
  }),
);

router.delete(
  '/exclusiones/:id(\\d+)',
  internoLimiter,
  sesion,
  admin,
  sinSso,
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

// ─── Validación manual (admin; excepción auditada que prevalece sobre la IA) ─

router.post(
  '/:id(\\d+)/requisitos/:tipo/validar',
  internoLimiter,
  sesion,
  admin,
  h(async (req, res) => {
    const { body } = validarSchema.parse({ body: req.body ?? {} });
    return ok(
      res,
      await svc.validarManual(
        idParam(req),
        String(req.params.tipo),
        'validar',
        actorDe(req),
        body.motivo || undefined,
      ),
    );
  }),
);

router.post(
  '/:id(\\d+)/requisitos/:tipo/observar',
  internoLimiter,
  sesion,
  admin,
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

// ─── Cargas ────────────────────────────────────────────────────────────────

const TIPO_RE = /^[a-z_]{2,32}$/;

function tipoCampo(fields: Record<string, string>): string {
  const tipo = String(fields.tipo ?? '').trim();
  if (!TIPO_RE.test(tipo))
    throw new AppError('Indique el tipo de documento.', 400);
  return tipo;
}

const cargaLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 30,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: {
    status: 'error',
    success: false,
    message: 'Demasiadas cargas. Espere un minuto.',
  },
});

/** Carga del vendedor autenticado desde el detalle (multipart file, tipo). */
router.post(
  '/:id(\\d+)/upload',
  cargaLimiter,
  sesion,
  h(async (req, res) => {
    const id = idParam(req);
    const { file, fields } = await leerMultipart(req);
    const tipo = tipoCampo(fields);
    return ok(res, await svc.cargarVendedor(id, tipo, file, actorDe(req)), 201);
  }),
);

// ─── Público: enlace firmado del asegurado (sin sesión) ───────────────────

const publicoLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 60,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: {
    status: 'error',
    success: false,
    message: 'Demasiadas peticiones.',
  },
});

const publicoCargaLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 15,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: {
    status: 'error',
    success: false,
    message: 'Demasiadas cargas. Espere un minuto.',
  },
});

// ─── Público: acceso por cédula + código al correo registrado ─────────────

const QUINCE_MIN = 15 * 60 * 1000;
const MSG_ESPERA = {
  status: 'error',
  success: false,
  message: 'Demasiados intentos. Espere unos minutos e intente de nuevo.',
};

/** Clave por documento (no por IP): frena el reparto del ataque entre muchas IP. */
function claveDocumento(req: Request): string {
  const b = (req.body ?? {}) as Record<string, unknown>;
  return `doc:${claveAsegurado(b.tipoDoc, b.documento) ?? 'invalido'}`;
}

const verificarIpLimiter = rateLimit({
  windowMs: QUINCE_MIN,
  max: 10,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: MSG_ESPERA,
});

const verificarDocLimiter = rateLimit({
  windowMs: QUINCE_MIN,
  max: 5,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  keyGenerator: claveDocumento,
  message: MSG_ESPERA,
});

const codigoIpLimiter = rateLimit({
  windowMs: QUINCE_MIN,
  max: 20,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: MSG_ESPERA,
});

const codigoDocLimiter = rateLimit({
  windowMs: QUINCE_MIN,
  max: 10,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  keyGenerator: claveDocumento,
  message: MSG_ESPERA,
});

/**
 * Siempre la misma respuesta, existan o no pólizas. El envío del código corre fuera de la
 * petición para que el tiempo tampoco delate si el asegurado existe.
 */
router.post(
  '/publico/verificar',
  verificarIpLimiter,
  verificarDocLimiter,
  h(async (req, res) => {
    const body = verificarIdentidadSchema.parse(req.body ?? {});
    void solicitarCodigo(body.tipoDoc, body.documento).catch((err) =>
      logger.warn(
        `[expedientes] acceso por cédula: envío fallido: ${err instanceof Error ? err.message : 'error'}`,
      ),
    );
    return ok(res, {
      mensaje: MENSAJE_VERIFICAR,
      vigenciaMinutos: CODIGO_MINUTOS,
      reenvioSegundos: CODIGO_REENVIO_SEGUNDOS,
    });
  }),
);

/** Código válido → token de un enlace `carga_documental` de 60 minutos. */
router.post(
  '/publico/verificar-codigo',
  codigoIpLimiter,
  codigoDocLimiter,
  h(async (req, res) => {
    const body = verificarCodigoSchema.parse(req.body ?? {});
    return ok(
      res,
      await verificarCodigo(body.tipoDoc, body.documento, body.codigo),
    );
  }),
);

/** Solo nombre, póliza enmascarada y requisitos pendientes/recibidos. */
router.get(
  '/publico/:token',
  publicoLimiter,
  h(async (req, res) =>
    ok(res, await svc.vistaPublica(String(req.params.token))),
  ),
);

router.post(
  '/publico/:token/upload',
  publicoCargaLimiter,
  h(async (req, res) => {
    const token = String(req.params.token);
    // Enlace inválido/vencido/usado se rechaza antes de leer el archivo.
    await svc.resolverEnlace(token);
    const { file, fields } = await leerMultipart(req);
    const tipo = tipoCampo(fields);
    const poliza = fields.poliza ? String(fields.poliza).trim() : undefined;
    return ok(res, await svc.cargaPublica(token, tipo, poliza, file), 201);
  }),
);

export default router;
