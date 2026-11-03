import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import logger from '../../utils/logger';
import { PublicLinksController } from './public-links.controller';

/** 30 visitas por minuto por IP (mismo criterio que sso-delegate). */
const directLinkLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 30,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: {
    success: false,
    message:
      'Demasiadas peticiones. Por favor espere un momento antes de reintentar.',
  },
  handler: (req, res, _next, options) => {
    logger.warn(`[links-directos] rate limit excedido — IP: ${req.ip}`);
    res.status(429).json(options.message);
  },
});

const router = Router();
const controller = new PublicLinksController();

/**
 * @openapi
 * /api/public/emitir/{slug}:
 *   get:
 *     tags: [Public]
 *     summary: Link directo de emisión (302 al módulo con nexus_token nuevo)
 *     description: Slug definido en el env NEXUS_LINKS_DIRECTOS. Sin env o slug no listado → 404.
 *     parameters:
 *       - in: path
 *         name: slug
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       302: { description: Redirige al módulo con nexus_token (1 h) }
 *       404: { description: Link no disponible }
 *       429: { description: Rate limit }
 */
router.get('/emitir/:slug', directLinkLimiter, (req, res) =>
  controller.emitir(req, res),
);

export default router;
