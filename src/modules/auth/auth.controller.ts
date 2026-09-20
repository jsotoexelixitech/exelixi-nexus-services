import { Request, Response } from 'express';
import { z } from 'zod';
import prisma from '../../config/prisma';
import { AuthService } from './auth.service';
import { AuthRequest } from '../../middlewares/auth.middleware';
import { AppError } from '../../utils/app-error';
import { getErrorMessage } from '../../utils/error-handler';
import logger from '../../utils/logger';
import {
  appendProductToUrl,
  resolveSsoFlowProduct,
} from '../../utils/flow-product';

/** Línea de detalle en checkout Pagos (metadata SSO). */
const ssoCheckoutLineSchema = z.object({
  label: z.string().min(1).max(200),
  amountVes: z.number().positive(),
  amountUsd: z.number().positive().optional(),
});

/** Bloque checkout para abrir Pagos con monto/concepto vía sso-delegate. */
const ssoCheckoutSchema = z.object({
  referenceId: z.string().max(100).optional(),
  title: z.string().min(1).max(200),
  subtitle: z.string().max(300).optional(),
  lines: z.array(ssoCheckoutLineSchema).max(30).optional(),
  totalVes: z.number().positive(),
  totalUsd: z.number().positive().optional(),
  exchangeRate: z.number().positive().optional(),
});

const ssoOnSuccessSchema = z
  .object({
    mode: z.enum(['none', 'redirect', 'webhook', 'emit']).optional(),
    redirectUrl: z.string().max(2048).optional(),
    webhookUrl: z.string().max(2048).optional(),
    target: z.string().max(20).optional(),
  })
  .optional();

const ssoCheckoutRulesSchema = z
  .object({
    requirePayment: z.boolean().optional(),
    methods: z
      .array(z.enum(['mobile', 'otp', 'transfer', 'card', 'domiciliacion']))
      .max(5)
      .optional(),
    fraccionado: z.boolean().optional(),
    requireFirstPayment: z.boolean().optional(),
    requireDomiciliacion: z.boolean().optional(),
    autoRedirect: z.boolean().optional(),
    redirectDelayMs: z.number().int().nonnegative().max(60000).optional(),
    hideNavigation: z.boolean().optional(),
    lockFields: z.boolean().optional(),
    onSuccess: ssoOnSuccessSchema,
  })
  .optional();

const ssoPayerSchema = z
  .object({
    documentType: z.string().max(2).optional(),
    documentNumber: z.string().max(20).optional(),
    name: z.string().max(120).optional(),
    phone: z.string().max(20).optional(),
  })
  .optional();

const ssoActorCode = z.union([z.string(), z.number()]);

/** Schema de metadata permitida en el token SSO.
 *  Campos desconocidos se eliminan con strip() — no quitar actor Sis2000. */
const ssoMetadataSchema = z
  .object({
    cproductor: ssoActorCode.optional(),
    canal: z.string().max(50).optional(),
    /** Tipo de canal emisión RCV (mismo metadata que metadataCanal). */
    ctipocanal: ssoActorCode.optional(),
    cramo: z.preprocess(
      (v) => (v === '' || v == null ? undefined : Number(v)),
      z.number().int().positive().optional(),
    ),
    cusuario: ssoActorCode.optional(),
    ctipo: z.preprocess(
      (v) => (v === '' || v == null ? undefined : Number(v)),
      z.number().int().nonnegative().optional(),
    ),
    ccanalalt_in: ssoActorCode.optional(),
    cscanalalt_in: ssoActorCode.optional(),
    ccanalalt: ssoActorCode.optional(),
    cscanalalt: ssoActorCode.optional(),
    cgestor_in: z.string().max(120).optional(),
    cgestor: z.string().max(80).optional(),
    centidad: z.string().max(4).optional(),
    citem: ssoActorCode.optional(),
    cproducto: ssoActorCode.optional(),
    /** rcv (default) | funerario | patrimoniales — misma cadena SSO, distinta entrada OCR. */
    product: z.enum(['rcv', 'funerario', 'patrimoniales']).optional(),
    /** Checkout Pagos — mismo patrón que canal en emisión, vía sso-delegate. */
    checkout: ssoCheckoutSchema.optional(),
    rules: ssoCheckoutRulesSchema,
    payer: ssoPayerSchema,
    /** Datos opacos devueltos al origen (webhook / emisión). */
    payload: z.record(z.string(), z.unknown()).optional(),
  })
  .strip();

/** Campos SSO que pueden venir en el root del body (apps Angular/La Mundial). */
const SSO_ROOT_METADATA_KEYS = [
  'cproductor',
  'cusuario',
  'cramo',
  'ctipo',
  'canal',
  'ctipocanal',
  'ccanalalt_in',
  'cscanalalt_in',
  'ccanalalt',
  'cscanalalt',
  'cgestor_in',
  'cgestor',
  'centidad',
  'citem',
  'cproducto',
  'product',
] as const;

/**
 * Fusiona metadata anidada + campos en la ra?z del body SSO.
 * Ignora strings vac?os para no pisar defaults del m?dulo.
 */
function mergeSsoMetadata(
  body: Record<string, unknown>,
): Record<string, unknown> {
  const nested =
    body.metadata &&
    typeof body.metadata === 'object' &&
    !Array.isArray(body.metadata)
      ? (body.metadata as Record<string, unknown>)
      : {};

  const fromRoot: Record<string, unknown> = {};
  for (const key of SSO_ROOT_METADATA_KEYS) {
    const value = body[key];
    if (value !== undefined && value !== null && value !== '') {
      fromRoot[key] = value;
    }
  }

  return { ...nested, ...fromRoot };
}

const authService = new AuthService();

/** Puertos dev local en submodulo.url (fallback si la URL es solo dominio HTTPS). */
const SSO_TARGET_PORT: Record<string, string> = {
  ocr: '5181',
  formulario: '5182',
  emision: '5183',
  pagos: '5184',
};

/** Host producción GCIA (Srv-Gcia-proyect — subdominios *.exelixitech.com). */
const SSO_TARGET_HOST: Record<string, string> = {
  ocr: 'ocr.exelixitech.com',
  formulario: 'formulario.exelixitech.com',
  emision: 'emision.exelixitech.com',
  pagos: 'pagos.exelixitech.com',
};

/** Nombre en BD cuando la URL ya no incluye el puerto (ej. cierrelmds.exelixitech.com). */
const SSO_TARGET_NAME: Record<string, string> = {
  ocr: 'OCR Documentos',
  formulario: 'Formulario',
  emision: 'Emisi?n',
  pagos: 'Pagos',
};

function isFuneralSubHint(
  url?: string | null,
  nombre?: string | null,
  moduloNombre?: string | null,
) {
  const blob =
    `${url ?? ''} ${nombre ?? ''} ${moduloNombre ?? ''}`.toLowerCase();
  return blob.includes('funerar') || blob.includes('product=funerario');
}

function isPatrimonialSubHint(
  url?: string | null,
  nombre?: string | null,
  moduloNombre?: string | null,
) {
  const blob =
    `${url ?? ''} ${nombre ?? ''} ${moduloNombre ?? ''}`.toLowerCase();
  return blob.includes('patrimonial') || blob.includes('product=patrimoniales');
}

function ssoSubHintScore(
  product: 'rcv' | 'funerario' | 'patrimoniales',
  url?: string | null,
  nombre?: string | null,
  moduloNombre?: string | null,
) {
  const fun = isFuneralSubHint(url, nombre, moduloNombre);
  const pat = isPatrimonialSubHint(url, nombre, moduloNombre);
  if (product === 'funerario') return fun ? 2 : pat ? -1 : 0;
  if (product === 'patrimoniales') return pat ? 2 : fun ? -1 : 0;
  return fun || pat ? 0 : 1;
}

/**
 * Resuelve el submódulo SSO por puerto/host/nombre.
 * Si hay empresa: solo entre los que ella tiene activos.
 * Si product=funerario/patrimoniales: prioriza esa cadena (no la de RCV).
 */
async function findSubmoduloForSsoTarget(
  target: string,
  opts?: {
    empresaId?: number;
    product?: 'rcv' | 'funerario' | 'patrimoniales';
  },
) {
  const key = target in SSO_TARGET_PORT ? target : 'ocr';
  const puerto = SSO_TARGET_PORT[key];
  const nameHint = SSO_TARGET_NAME[key] ?? SSO_TARGET_NAME.ocr;
  const hostHint = SSO_TARGET_HOST[key];
  const product =
    opts?.product === 'funerario' || opts?.product === 'patrimoniales'
      ? opts.product
      : 'rcv';

  const orFilters = [
    { url: { contains: puerto } },
    { nombre: { contains: nameHint, mode: 'insensitive' as const } },
    ...(hostHint ? [{ url: { contains: hostHint } }] : []),
    ...(key === 'ocr' ? [{ url: { contains: '/ocr' } }] : []),
    ...(key === 'formulario' ? [{ url: { contains: '/formulario' } }] : []),
    ...(key === 'emision' ? [{ url: { contains: '/emision' } }] : []),
    ...(key === 'pagos' ? [{ url: { contains: '/pagos' } }] : []),
  ];

  const rows = await prisma.submodulo.findMany({
    where: {
      activo: true,
      url: { not: null },
      OR: orFilters,
    },
    select: {
      id: true,
      url: true,
      nombre: true,
      modulo: { select: { nombre: true } },
    },
    orderBy: { id: 'asc' },
  });

  if (rows.length === 0) return null;

  let pool = rows;
  if (opts?.empresaId) {
    const links = await prisma.empresaSubmodulo.findMany({
      where: {
        empresaId: opts.empresaId,
        activo: true,
        submoduloId: { in: rows.map((r) => r.id) },
      },
      select: { submoduloId: true },
    });
    const assigned = new Set(links.map((l) => l.submoduloId));
    const onlyAssigned = rows.filter((r) => assigned.has(r.id));
    if (onlyAssigned.length > 0) pool = onlyAssigned;
  }

  const ranked = [...pool].sort((a, b) => {
    const aScore = ssoSubHintScore(product, a.url, a.nombre, a.modulo?.nombre);
    const bScore = ssoSubHintScore(product, b.url, b.nombre, b.modulo?.nombre);
    return bScore - aScore;
  });

  const hit = ranked[0];
  return hit ? { id: hit.id, url: hit.url, nombre: hit.nombre } : null;
}

export class AuthController {
  async login(req: Request, res: Response) {
    try {
      const { email, password } = req.body;
      const result = await authService.login(email, password);
      res.json(result);
    } catch (error: unknown) {
      res.status(401).json({ success: false, message: getErrorMessage(error) });
    }
  }

  async me(req: AuthRequest, res: Response) {
    try {
      const userId = req.user?.id;
      if (!userId) throw new AppError('No autenticado', 401);

      const profile = await authService.getUserProfile(userId);
      res.json({
        success: true,
        data: profile,
      });
    } catch (error: unknown) {
      res.status(500).json({ success: false, message: getErrorMessage(error) });
    }
  }

  async ssoDelegate(req: Request, res: Response) {
    try {
      const { target = 'ocr' } = req.body;
      const apiKey = req.headers['x-api-key'];
      const mergedRaw = mergeSsoMetadata(req.body as Record<string, unknown>);

      let empresaId: number;
      let empresaNombre: string;

      if (apiKey) {
        const empresa = await prisma.empresa.findUnique({
          where: { apiKey: apiKey as string },
          select: { id: true, nombre: true, activo: true },
        });
        if (!empresa) {
          return res.status(401).json({
            success: false,
            message: 'API Key inválida o no registrada.',
          });
        }
        if (!empresa.activo) {
          return res
            .status(403)
            .json({ success: false, message: 'La empresa está inactiva.' });
        }
        empresaId = empresa.id;
        empresaNombre = empresa.nombre;
      } else if (req.headers.authorization?.startsWith('Bearer ')) {
        const { decrypt } = await import('../../utils/crypto');
        const jwt = await import('jsonwebtoken');
        const encryptedToken = req.headers.authorization.split(' ')[1];
        try {
          const token = decrypt(encryptedToken);
          const decoded = jwt.verify(
            token,
            process.env.JWT_SECRET || 'secret',
          ) as { empresaId: number; roleId: number };
          const empresa = await prisma.empresa.findUnique({
            where: { id: decoded.empresaId },
            select: { id: true, nombre: true, activo: true },
          });
          // Allow roleId 1 (admin) to pass even if empresa is inactive or missing, for debugging purposes
          if (!empresa && decoded.roleId !== 1)
            throw new Error('Empresa inactiva');
          if (empresa && !empresa.activo && decoded.roleId !== 1)
            throw new Error('Empresa inactiva');

          empresaId = decoded.empresaId;
          empresaNombre = empresa ? empresa.nombre : 'Admin Bypass';

          // Inject roleId into req for later checks
          (req as any).userRole = decoded.roleId;
        } catch (_err) {
          return res
            .status(401)
            .json({ success: false, message: 'Token de sesión inválido.' });
        }
      } else {
        return res.status(400).json({
          success: false,
          error: 'invalid_request',
          message: 'Falta el header x-api-key o un Bearer token.',
        });
      }

      // Validar y sanitizar metadata con Zod (campos desconocidos descartados)
      const metaParsed = ssoMetadataSchema.safeParse(mergedRaw);
      if (!metaParsed.success) {
        return res.status(400).json({
          success: false,
          error: 'invalid_metadata',
          message: 'Metadata con formato inválido.',
          details: metaParsed.error.issues,
        });
      }
      const metadata = metaParsed.data;

      if (target === 'pagos' && !metadata.checkout) {
        logger.info(
          `[sso-delegate] pagos sin checkout en metadata — flujo legacy/canal empresa=${apiKey ? '***' : 'none'}`,
        );
      }

      // No need to query empresa again, we already have empresaId and empresaNombre

      const productHint = resolveSsoFlowProduct(metadata);
      const submodulo = await findSubmoduloForSsoTarget(target, {
        empresaId,
        product: productHint,
      });

      if (!submodulo) {
        return res.status(404).json({
          success: false,
          message: `No se encontr? un subm?dulo activo para el target "${target}".`,
        });
      }

      // 3. Buscar el tenantToken ya generado para empresa + subm?dulo
      const empresaSubmodulo = await (
        prisma as unknown as {
          empresaSubmodulo: {
            findFirst: (args: {
              where: { empresaId: number; submoduloId: number };
              select: { tenantToken: boolean; activo: boolean };
            }) => Promise<{
              tenantToken: string | null;
              activo: boolean;
            } | null>;
          };
        }
      ).empresaSubmodulo.findFirst({
        where: { empresaId, submoduloId: submodulo.id },
        select: { tenantToken: true, activo: true },
      });

      const isAdmin = (req as any).userRole === 1;

      if (!empresaSubmodulo || !empresaSubmodulo.activo) {
        if (!isAdmin) {
          return res.status(403).json({
            success: false,
            message: `El servicio "${target}" no está activado para esta empresa.`,
          });
        }
      }

      // Renovar ventana de sesión al entrar desde app externa (evita "expirada por inactividad")
      if (empresaSubmodulo) {
        const TOKEN_TTL_MS = 8 * 60 * 60 * 1000;
        await (
          prisma as unknown as {
            empresaSubmodulo: {
              update: (args: {
                where: {
                  empresaId_submoduloId: {
                    empresaId: number;
                    submoduloId: number;
                  };
                };
                data: { tokenExpiresAt: Date };
              }) => Promise<unknown>;
            };
          }
        ).empresaSubmodulo.update({
          where: {
            empresaId_submoduloId: {
              empresaId,
              submoduloId: submodulo.id,
            },
          },
          data: { tokenExpiresAt: new Date(Date.now() + TOKEN_TTL_MS) },
        });
      }

      // 5. Generar token din?mico con metadata
      const { generateSsoToken, buildAccessUrl } =
        await import('../../utils/tenant-token');
      const product = resolveSsoFlowProduct(metadata, {
        submoduloUrl: submodulo.url,
        submoduloNombre: submodulo.nombre,
      });
      const tokenMetadata =
        product !== 'rcv' && metadata.product !== product
          ? { ...metadata, product }
          : metadata;
      const dynamicToken = generateSsoToken(
        empresaId,
        submodulo.id,
        tokenMetadata,
      );
      const redirectUrl = appendProductToUrl(
        buildAccessUrl(submodulo.url!, dynamicToken),
        product,
      );

      const ssoMsg = 'sse ' + empresaId + '/' + target + '/' + submodulo.id;
      logger.info('ssoDelegate ' + ssoMsg);
      logger.info('sso-body ' + JSON.stringify(mergedRaw));

      return res.json({
        success: true,
        redirect_url: redirectUrl,
        empresa: empresaNombre,
        modulo: submodulo.nombre,
      });
    } catch (error: unknown) {
      res.status(500).json({ success: false, message: getErrorMessage(error) });
    }
  }
}
