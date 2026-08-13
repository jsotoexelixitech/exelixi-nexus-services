/**
 * product-config.routes.ts
 *
 * Endpoints para leer y escribir la configuración paramétrica de cada módulo.
 *
 * GET  /api/config/:empresaId/:producto/:modulo  → retorna config activa (público para módulos)
 * PUT  /api/config/:empresaId/:producto/:modulo  → guarda (API key o JWT config-panel)
 * POST /api/config/:empresaId/:producto/:modulo/reset → restaura default (API key o JWT)
 */

import { Router, Request, Response } from 'express';
import jwt from 'jsonwebtoken';
import { getConfig, saveConfig, resetConfig } from './product-config.service';
import { apiKeyGuard } from '../../middlewares/apikey.middleware';
import { configWriteGuard } from './config-write.guard';
import type { Producto, Modulo } from './product-config.defaults';
import { env } from '../../config/env';
import prisma from '../../config/prisma';

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
 * Protegido con API key o JWT del parametrizador (?token= desde Nexus Admin).
 */
router.put(
  '/:empresaId/:producto/:modulo',
  configWriteGuard,
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
 * Protegido con API key o JWT del parametrizador.
 */
router.post(
  '/:empresaId/:producto/:modulo/reset',
  configWriteGuard,
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
 * Genera un JWT de 1h para el parametrizador.
 * Query opcional (viaja en el token y se refleja en la URL del panel):
 *   canal, cproductor, cusuario, ctipocanal, ccanalalt_in, cscanalalt_in
 */
router.get(
  '/token/:empresaId/:producto/:modulo',
  apiKeyGuard,
  async (req: Request, res: Response) => {
    const { empresaId, producto, modulo } = req.params;
    if (!validateParams(res, producto, modulo)) return;

    const q = req.query;
    const pick = (key: string): string | undefined => {
      const v = q[key];
      if (typeof v !== 'string') return undefined;
      const t = v.trim();
      return t || undefined;
    };

    const canal = pick('canal') || 'default';
    const metadata: Record<string, string> = { canal };
    for (const key of [
      'cproductor',
      'cusuario',
      'ctipocanal',
      'ccanalalt_in',
      'cscanalalt_in',
      'cramo',
    ] as const) {
      const v = pick(key);
      if (v !== undefined) metadata[key] = v;
    }

    const eid = Number(empresaId);
    let empresaNombre = pick('empresaNombre');
    if (!empresaNombre && Number.isInteger(eid) && eid > 0) {
      try {
        const emp = await prisma.empresa.findUnique({
          where: { id: eid },
          select: { nombre: true },
        });
        if (emp?.nombre?.trim()) empresaNombre = emp.nombre.trim();
      } catch {
        /* nombre opcional */
      }
    }

    const token = jwt.sign(
      {
        empresaId: eid,
        ...(empresaNombre ? { empresaNombre } : {}),
        producto,
        modulo,
        scope: 'config-panel',
        canal,
        ...(metadata.cproductor ? { cproductor: metadata.cproductor } : {}),
        ...(metadata.cusuario ? { cusuario: metadata.cusuario } : {}),
        metadata,
      },
      env.JWT_SECRET,
      { expiresIn: '1h' },
    );
    res.json({
      success: true,
      token,
      expiresIn: 3600,
      canal,
      empresaId: eid,
      empresaNombre: empresaNombre || null,
      metadata,
    });
  },
);

export default router;
