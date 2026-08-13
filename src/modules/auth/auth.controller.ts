import { Request, Response } from 'express';
import { z } from 'zod';
import prisma from '../../config/prisma';
import { AuthService } from './auth.service';
import { AuthRequest } from '../../middlewares/auth.middleware';
import { AppError } from '../../utils/app-error';
import { getErrorMessage } from '../../utils/error-handler';
import logger from '../../utils/logger';

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
  })
  .optional();

const ssoCheckoutRulesSchema = z
  .object({
    requirePayment: z.boolean().optional(),
    methods: z
      .array(z.enum(['mobile', 'otp', 'transfer', 'card']))
      .max(4)
      .optional(),
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

/** Schema de metadata permitida en el token SSO.
 *  Campos desconocidos se eliminan con strip(). */
const ssoMetadataSchema = z
  .object({
    cproductor: z.union([z.string(), z.number()]).optional(),
    canal: z.string().max(50).optional(),
    /** Tipo de canal emisión RCV (mismo metadata que metadataCanal). */
    ctipocanal: z.union([z.string(), z.number()]).optional(),
    cramo: z.number().int().positive().optional(),
    cusuario: z.union([z.string(), z.number()]).optional(),
    ctipo: z.number().int().nonnegative().optional(),
    ccanalalt_in: z.union([z.string(), z.number()]).optional(),
    cscanalalt_in: z.union([z.string(), z.number()]).optional(),
    cgestor_in: z.string().max(120).optional(),
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
  'cgestor_in',
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

/** Nombre en BD cuando la URL ya no incluye el puerto (ej. cierrelmds.exelixitech.com). */
const SSO_TARGET_NAME: Record<string, string> = {
  ocr: 'OCR Documentos',
  formulario: 'Formulario',
  emision: 'Emisi?n',
  pagos: 'Pagos',
};

/**
 * Resuelve el subm?dulo destino del SSO: primero por puerto en URL, luego por nombre.
 */
async function findSubmoduloForSsoTarget(target: string) {
  const key = target in SSO_TARGET_PORT ? target : 'ocr';
  const puerto = SSO_TARGET_PORT[key];
  const nameHint = SSO_TARGET_NAME[key] ?? SSO_TARGET_NAME.ocr;
  const select = { id: true, url: true, nombre: true } as const;

  const byPort = await prisma.submodulo.findFirst({
    where: { url: { contains: puerto }, activo: true },
    select,
  });
  if (byPort) return byPort;

  return prisma.submodulo.findFirst({
    where: {
      activo: true,
      url: { not: null },
      nombre: { contains: nameHint, mode: 'insensitive' },
    },
    orderBy: { id: 'asc' },
    select,
  });
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

      if (!apiKey) {
        return res.status(400).json({
          success: false,
          error: 'invalid_request',
          message: 'Falta el header x-api-key.',
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

      // 1. Buscar la empresa por apiKey
      const empresa = await prisma.empresa.findUnique({
        where: { apiKey: apiKey as string },
        select: { id: true, nombre: true, activo: true },
      });

      if (!empresa) {
        return res.status(401).json({
          success: false,
          message: 'Acceso denegado: API Key inv?lida o no registrada.',
        });
      }

      if (!empresa.activo) {
        return res.status(403).json({
          success: false,
          message: 'Acceso denegado: La empresa est? inactiva.',
        });
      }

      // 2. Resolver subm?dulo por target (puerto en URL o nombre ? soporta dominios sin :5181)
      const submodulo = await findSubmoduloForSsoTarget(target);

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
        where: { empresaId: empresa.id, submoduloId: submodulo.id },
        select: { tenantToken: true, activo: true },
      });

      if (!empresaSubmodulo || !empresaSubmodulo.activo) {
        return res.status(403).json({
          success: false,
          message: `El servicio "${target}" no est? activado para esta empresa.`,
        });
      }

      // Renovar ventana de sesi?n al entrar desde app externa (evita "expirada por inactividad")
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
            empresaId: empresa.id,
            submoduloId: submodulo.id,
          },
        },
        data: { tokenExpiresAt: new Date(Date.now() + TOKEN_TTL_MS) },
      });

      // 5. Generar token din?mico con metadata
      const { generateSsoToken, buildAccessUrl } =
        await import('../../utils/tenant-token');
      const dynamicToken = generateSsoToken(empresa.id, submodulo.id, metadata);
      const redirectUrl = buildAccessUrl(submodulo.url!, dynamicToken);

      const ssoMsg = 'sse ' + empresa.id + '/' + target + '/' + submodulo.id;
      logger.info('ssoDelegate ' + ssoMsg);
      logger.info('sso-body ' + JSON.stringify(mergedRaw));

      return res.json({
        success: true,
        redirect_url: redirectUrl,
        empresa: empresa.nombre,
        modulo: submodulo.nombre,
      });
    } catch (error: unknown) {
      res.status(500).json({ success: false, message: getErrorMessage(error) });
    }
  }
}
