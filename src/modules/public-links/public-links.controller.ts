import { Request, Response } from 'express';
import { z } from 'zod';
import prisma from '../../config/prisma';
import logger from '../../utils/logger';
import { generateSsoToken, buildAccessUrl } from '../../utils/tenant-token';
import {
  appendProductToUrl,
  resolveSsoFlowProduct,
} from '../../utils/flow-product';
import {
  findSubmoduloForSsoTarget,
  ssoMetadataSchema,
} from '../auth/auth.controller';

/**
 * Links directos de emisión (sin API key en el cliente).
 *
 * Lista blanca en el env `NEXUS_LINKS_DIRECTOS` (JSON):
 *   { "<slug>": { "empresaId": 7, "target": "ocr", "product": "funerario", "metadata": {...} } }
 *
 * Cada visita genera un nexus_token nuevo (misma firma que sso-delegate, 1 h)
 * y responde 302 al módulo. Si el env no existe → 404 (deploy inocuo).
 */
const directLinkSchema = z.object({
  empresaId: z.number().int().positive(),
  target: z.enum(['ocr', 'formulario', 'emision', 'pagos']).default('ocr'),
  product: z.enum(['rcv', 'funerario', 'patrimoniales']).optional(),
  metadata: z.record(z.string(), z.unknown()).default({}),
});

const directLinksSchema = z.record(
  z.string().regex(/^[a-z0-9][a-z0-9_-]{0,39}$/),
  directLinkSchema,
);

export type DirectLink = z.infer<typeof directLinkSchema>;

/** Lee y valida la lista blanca. Devuelve null si no está configurada o es inválida. */
export function loadDirectLinks(): Record<string, DirectLink> | null {
  const raw = process.env.NEXUS_LINKS_DIRECTOS?.trim();
  if (!raw) return null;
  try {
    const parsed = directLinksSchema.safeParse(JSON.parse(raw));
    if (!parsed.success) {
      logger.warn(
        `[links-directos] NEXUS_LINKS_DIRECTOS inválido: ${JSON.stringify(parsed.error.issues)}`,
      );
      return null;
    }
    return parsed.data;
  } catch (err) {
    logger.warn(`[links-directos] NEXUS_LINKS_DIRECTOS no es JSON: ${err}`);
    return null;
  }
}

export class PublicLinksController {
  async emitir(req: Request, res: Response) {
    const slug = String(req.params.slug ?? '').toLowerCase();
    const links = loadDirectLinks();
    const link = links?.[slug];

    if (!link) {
      return res
        .status(404)
        .json({ success: false, message: 'Link no disponible.' });
    }

    // La metadata sale SOLO del servidor; la query del cliente (utm_*, etc.) se ignora.
    const metaParsed = ssoMetadataSchema.safeParse({
      ...link.metadata,
      ...(link.product ? { product: link.product } : {}),
    });
    if (!metaParsed.success) {
      logger.warn(
        `[links-directos] metadata inválida slug=${slug}: ${JSON.stringify(metaParsed.error.issues)}`,
      );
      return res
        .status(404)
        .json({ success: false, message: 'Link no disponible.' });
    }
    const metadata = metaParsed.data;

    const empresa = await prisma.empresa.findUnique({
      where: { id: link.empresaId },
      select: { id: true, activo: true },
    });
    if (!empresa || !empresa.activo) {
      return res
        .status(404)
        .json({ success: false, message: 'Link no disponible.' });
    }

    const submodulo = await findSubmoduloForSsoTarget(link.target, {
      empresaId: link.empresaId,
      product: resolveSsoFlowProduct(metadata),
    });
    if (!submodulo?.url) {
      return res
        .status(404)
        .json({ success: false, message: 'Link no disponible.' });
    }

    const empresaSubmodulo = await prisma.empresaSubmodulo.findFirst({
      where: { empresaId: link.empresaId, submoduloId: submodulo.id },
      select: { activo: true },
    });
    if (!empresaSubmodulo?.activo) {
      return res
        .status(404)
        .json({ success: false, message: 'Link no disponible.' });
    }

    // Misma firma y armado de URL que sso-delegate (utils/tenant-token).
    const product = resolveSsoFlowProduct(metadata, {
      submoduloUrl: submodulo.url,
      submoduloNombre: submodulo.nombre,
    });
    const tokenMetadata =
      product !== 'rcv' && metadata.product !== product
        ? { ...metadata, product }
        : metadata;
    const token = generateSsoToken(
      link.empresaId,
      submodulo.id,
      tokenMetadata,
    );
    const redirectUrl = appendProductToUrl(
      buildAccessUrl(submodulo.url, token),
      product,
    );

    logger.info(
      `[links-directos] ${slug} → empresa ${link.empresaId}/${link.target}/${submodulo.id} ip=${req.ip}`,
    );
    res.setHeader('Cache-Control', 'no-store');
    return res.redirect(302, redirectUrl);
  }
}
