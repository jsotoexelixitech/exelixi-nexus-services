/**
 * /api/expedientes/integracion — interno nest-api → Nexus (API de documentos del expediente para
 * integradores). Sin sesión del portal: header `x-expediente-key` (EXPEDIENTES_INTEGRACION_KEY o, si
 * falta, EXPEDIENTE_INTERNAL_KEY, la misma clave interna de Nexus ↔ OCR). Sin clave: 503.
 * El integrador (dueño de la póliza) llega en `x-integrador`; lo calcula nest-api desde su apikey.
 *
 * POST /registro                          JSON: póliza emitida por una API de integración.
 * GET  /polizas/:cnpoliza                 estado del expediente (contrato publicado).
 * POST /polizas/:cnpoliza/documentos      multipart: file, tipo, documento?.
 */
import { createHash, timingSafeEqual } from 'crypto';
import { NextFunction, Request, Response, Router } from 'express';
import rateLimit from 'express-rate-limit';
import { AppError } from '../../utils/app-error';
import { leerMultipart } from './expedientes.files';
import {
  cargaIntegracionSchema,
  cargarIntegracion,
  estadoIntegracion,
  integradorSchema,
  MAX_ARCHIVO_INTEGRACION,
  registrarIntegracion,
  registroIntegracionSchema,
} from './expedientes.integracion';

/** Clave del canal interno nest-api → Nexus. */
export function claveIntegracion(): string | null {
  const k = String(
    process.env.EXPEDIENTES_INTEGRACION_KEY ||
      process.env.EXPEDIENTE_INTERNAL_KEY ||
      '',
  ).trim();
  return k || null;
}

function sha(v: string): Buffer {
  return createHash('sha256').update(v, 'utf8').digest();
}

export function requireClaveIntegracion(
  req: Request,
  res: Response,
  next: NextFunction,
) {
  const clave = claveIntegracion();
  if (!clave)
    return res.status(503).json({
      status: 'error',
      success: false,
      message: 'API de expedientes no configurada en Nexus.',
    });
  const got = String(req.headers['x-expediente-key'] ?? '');
  if (!got || !timingSafeEqual(sha(got), sha(clave)))
    return res
      .status(401)
      .json({ status: 'error', success: false, message: 'No autorizado.' });
  return next();
}

const PATRON_POLIZA = /^[A-Za-z0-9._-]{1,64}$/;

function polizaParam(req: Request): string {
  const p = String(req.params.cnpoliza ?? '').trim();
  if (!PATRON_POLIZA.test(p))
    throw new AppError('cnpoliza con formato inválido.', 400);
  return p;
}

function integradorHeader(req: Request): string {
  const r = integradorSchema.safeParse(req.headers['x-integrador']);
  if (!r.success) throw new AppError('Falta el integrador.', 400);
  return r.data;
}

const integracionLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 600,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: {
    status: 'error',
    success: false,
    message: 'Demasiadas peticiones.',
  },
});

type Handler = (req: Request, res: Response) => Promise<unknown>;

/**
 * Crea el router con el envoltorio de errores del monitor (`h`) y la respuesta `ok`, que se
 * reciben desde expedientes.routes para no duplicarlos ni crear un ciclo de imports.
 */
export function crearRouterIntegracion(
  h: (fn: Handler) => (req: Request, res: Response) => Promise<void>,
  ok: (res: Response, data: unknown, status?: number) => void,
): Router {
  const router = Router();
  router.use(integracionLimiter, requireClaveIntegracion);

  router.post(
    '/registro',
    h(async (req, res) => {
      const body = registroIntegracionSchema.parse(req.body ?? {});
      return ok(res, await registrarIntegracion(body), 201);
    }),
  );

  router.get(
    '/polizas/:cnpoliza',
    h(async (req, res) =>
      ok(res, await estadoIntegracion(integradorHeader(req), polizaParam(req))),
    ),
  );

  router.post(
    '/polizas/:cnpoliza/documentos',
    h(async (req, res) => {
      const integrador = integradorHeader(req);
      const cnpoliza = polizaParam(req);
      const declared = Number(req.headers['content-length'] ?? 0);
      if (declared > MAX_ARCHIVO_INTEGRACION + 1024 * 1024)
        throw new AppError('El archivo supera el máximo de 10 MB.', 413);
      const { file, fields } = await leerMultipart(req, { webp: true });
      const parsed = cargaIntegracionSchema.safeParse({
        integrador,
        tipo: String(fields.tipo ?? '').trim(),
        documento: fields.documento,
      });
      if (!parsed.success)
        throw new AppError(
          parsed.error.errors[0]?.message ?? 'Datos inválidos.',
          400,
        );
      const campos = parsed.data;
      return ok(
        res,
        await cargarIntegracion({
          integrador,
          cnpoliza,
          tipo: campos.tipo,
          documento: campos.documento,
          file,
        }),
        201,
      );
    }),
  );

  return router;
}
