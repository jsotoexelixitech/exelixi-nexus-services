/**
 * cotizaciones-rc.routes.ts — cotizaciones del cotizador RC (registro permanente; 15 días de vigencia para el
 * cliente), pago en línea y emisión pagada.
 *
 *   POST  /api/cotizaciones-rc                         → guarda la cotización y devuelve el código (x-api-key)
 *   GET   /api/cotizaciones-rc                         → búsqueda del admin: vigentes, vencidas o todo el historial (x-api-key)
 *   GET   /api/cotizaciones-rc/:codigo                 → trae una cotización; 404 no existe, 410 vencida; ?admin=1 también vencidas
 *   PATCH /api/cotizaciones-rc/:codigo/estado          → registra la emisión con recibo pendiente (x-api-key)
 *   POST  /api/cotizaciones-rc/:codigo/checkout        → manda a pagar: URL del módulo de Pagos; acepta `anexos`
 *                                                        { nombre, base64 } (PDF de condicionado y anexos) (x-api-key)
 *   POST  /api/cotizaciones-rc/:codigo/reintentar      → reintenta emisión, cobro o correo de la póliza (x-api-key)
 *   POST  /api/cotizaciones-rc/pago-callback/:codigo   → aviso de pagos-api (notifyUrl); token por intento, sin API key
 *
 * La API key la pone el servidor del cotizador (proxy /nexus); nunca llega al navegador.
 */
import { Router, Request, Response } from 'express';
import rateLimit from 'express-rate-limit';
import { apiKeyGuard } from '../../middlewares/apikey.middleware';
import logger from '../../utils/logger';
import { aRespuesta } from './cotizaciones-rc.domain';
import * as svc from './cotizaciones-rc.service';

const mensajeLimite = {
  success: false,
  message: 'Demasiadas peticiones. Espera un momento y vuelve a intentar.',
};

// El cliente consulta el estado mientras se emite la póliza: margen amplio, todo llega desde el servidor del cotizador.
const limiter = rateLimit({
  windowMs: 60 * 1000,
  max: 300,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: mensajeLimite,
});

const callbackLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 30,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: mensajeLimite,
  handler: (req, res, _next, options) => {
    logger.warn(
      `[cotizaciones-rc] rate limit del callback de pago — IP: ${req.ip}`,
    );
    res.status(429).json(options.message);
  },
});

const router = Router();

// Aviso de pago: pagos-api no tiene la API key de Nexus; se autentica con el token del intento de checkout.
router.post(
  '/pago-callback/:codigo',
  callbackLimiter,
  async (req: Request, res: Response) => {
    const data = await svc.confirmarPago(
      req.params.codigo,
      req.query.t,
      req.body,
    );
    res.status(data.procesado ? 202 : 200).json({ success: true, data });
  },
);

router.use(limiter, apiKeyGuard);

router.post('/', async (req: Request, res: Response) => {
  // El proxy del cotizador marca lo que entra por el link del cliente; el cuerpo no decide el origen.
  const origen =
    req.headers['x-cotizador-origen'] === 'cliente' ? 'cliente' : 'admin';
  const fila = await svc.crear({ ...(req.body ?? {}), origen });
  res.status(201).json({ success: true, data: aRespuesta(fila) });
});

router.get('/', async (req: Request, res: Response) => {
  const filas = await svc.listar(req.query as Record<string, unknown>);
  res.json({ success: true, data: filas.map((f) => aRespuesta(f, false)) });
});

router.get('/:codigo', async (req: Request, res: Response) => {
  // ?admin=1 (detalle del historial): el proxy del cotizador no lo deja pasar por el link del cliente.
  res.json({
    success: true,
    data: aRespuesta(
      await svc.obtener(req.params.codigo, req.query.admin === '1'),
    ),
  });
});

router.patch('/:codigo/estado', async (req: Request, res: Response) => {
  res.json({
    success: true,
    data: aRespuesta(
      await svc.registrarEmisionPendiente(req.params.codigo, req.body),
    ),
  });
});

router.post('/:codigo/checkout', async (req: Request, res: Response) => {
  res.json({
    success: true,
    data: await svc.crearCheckout(req.params.codigo, req.body),
  });
});

router.post('/:codigo/reintentar', async (req: Request, res: Response) => {
  res.json({
    success: true,
    data: aRespuesta(await svc.reintentar(req.params.codigo)),
  });
});

export default router;
