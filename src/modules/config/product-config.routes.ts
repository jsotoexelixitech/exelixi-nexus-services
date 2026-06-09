/**
 * product-config.routes.ts
 *
 * Endpoints para leer y escribir la configuración paramétrica de cada módulo.
 *
 * GET  /api/config/:empresaId/:producto/:modulo  → retorna config activa (público para módulos)
 * PUT  /api/config/:empresaId/:producto/:modulo  → guarda config personalizada (requiere API key)
 * POST /api/config/:empresaId/:producto/:modulo/reset → restaura default (requiere API key)
 */

import { Router, Request, Response } from 'express';
import jwt from 'jsonwebtoken';
import { getConfig, saveConfig, resetConfig } from './product-config.service';
import { apiKeyGuard } from '../../middlewares/apikey.middleware';
import type { Producto, Modulo } from './product-config.defaults';
import { env } from '../../config/env';

const router = Router();

const VALID_PRODUCTOS: Producto[] = ['rcv', 'funerario'];
const VALID_MODULOS: Modulo[] = ['ocr', 'formulario', 'pagos', 'emision'];

function validateParams(
  res: Response,
  producto: string,
  modulo: string,
): boolean {
  if (!VALID_PRODUCTOS.includes(producto as Producto)) {
    res.status(400).json({
      success: false,
      message: `Producto inválido: ${producto}. Válidos: rcv, funerario`,
    });
    return false;
  }
  if (!VALID_MODULOS.includes(modulo as Modulo)) {
    res.status(400).json({
      success: false,
      message: `Módulo inválido: ${modulo}. Válidos: ocr, formulario, pagos, emision`,
    });
    return false;
  }
  return true;
}

/**
 * GET /api/config/:empresaId/:producto/:modulo
 * Público — los módulos lo llaman al cargar para conocer su configuración activa.
 */
router.get(
  '/:empresaId/:producto/:modulo',
  async (req: Request, res: Response) => {
    const { empresaId, producto, modulo } = req.params;
    if (!validateParams(res, producto, modulo)) return;

    const config = await getConfig(
      Number(empresaId),
      producto as Producto,
      modulo as Modulo,
    );
    res.json({ success: true, data: config });
  },
);

/**
 * PUT /api/config/:empresaId/:producto/:modulo
 * Protegido con API key — el panel de configuración lo llama al guardar.
 */
router.put(
  '/:empresaId/:producto/:modulo',
  apiKeyGuard,
  async (req: Request, res: Response) => {
    const { empresaId, producto, modulo } = req.params;
    if (!validateParams(res, producto, modulo)) return;

    const configJson = req.body;
    if (!configJson || typeof configJson !== 'object') {
      res.status(400).json({
        success: false,
        message: 'El body debe ser un objeto JSON con la configuración.',
      });
      return;
    }

    const saved = await saveConfig(
      Number(empresaId),
      producto as Producto,
      modulo as Modulo,
      configJson,
    );
    res.json({ success: true, data: saved });
  },
);

/**
 * POST /api/config/:empresaId/:producto/:modulo/reset
 * Protegido con API key — restaura la config al default hardcoded.
 */
router.post(
  '/:empresaId/:producto/:modulo/reset',
  apiKeyGuard,
  async (req: Request, res: Response) => {
    const { empresaId, producto, modulo } = req.params;
    if (!validateParams(res, producto, modulo)) return;

    const defaults = await resetConfig(
      Number(empresaId),
      producto as Producto,
      modulo as Modulo,
    );
    res.json({
      success: true,
      message: 'Configuración reseteada a valores por defecto.',
      data: defaults,
    });
  },
);

/**
 * GET /api/config/token/:empresaId/:producto/:modulo
 * Protegido con API key del admin.
 * Genera un JWT de 1h para acceder al parametrizador de ese módulo/empresa.
 */
router.get(
  '/token/:empresaId/:producto/:modulo',
  apiKeyGuard,
  (req: Request, res: Response) => {
    const { empresaId, producto, modulo } = req.params;
    if (!validateParams(res, producto, modulo)) return;

    const token = jwt.sign(
      { empresaId: Number(empresaId), producto, modulo, scope: 'config-panel' },
      env.JWT_SECRET,
      { expiresIn: '1h' },
    );
    res.json({ success: true, token, expiresIn: 3600 });
  },
);

export default router;
