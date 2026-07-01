import { Request, Response } from 'express';
import { z } from 'zod';
import prisma from '../../config/prisma';
import { AuthService } from './auth.service';
import { AuthRequest } from '../../middlewares/auth.middleware';
import { AppError } from '../../utils/app-error';
import { getErrorMessage } from '../../utils/error-handler';
import logger from '../../utils/logger';

/** Schema de metadata permitida en el token SSO.
 *  Campos desconocidos se eliminan con strip(). */
const ssoMetadataSchema = z
  .object({
    cproductor: z.string().max(20).optional(),
    canal: z.string().max(50).optional(),
    cramo: z.number().int().positive().optional(),
    cusuario: z.string().max(60).optional(),
    ctipo: z.number().int().nonnegative().optional(),
  })
  .strip();

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
  emision: 'Emisión',
  pagos: 'Pagos',
};

/**
 * Resuelve el submódulo destino del SSO: primero por puerto en URL, luego por nombre.
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
      const { metadata: rawMetadata, target = 'ocr' } = req.body;
      const apiKey = req.headers['x-api-key'];

      if (!rawMetadata || !apiKey) {
        return res.status(400).json({
          success: false,
          error: 'invalid_request',
          message:
            'Faltan campos obligatorios (metadata) o el header x-api-key.',
        });
      }

      // Validar y sanitizar metadata con Zod (campos desconocidos descartados)
      const metaParsed = ssoMetadataSchema.safeParse(rawMetadata);
      if (!metaParsed.success) {
        return res.status(400).json({
          success: false,
          error: 'invalid_metadata',
          message: 'Metadata con formato inválido.',
          details: metaParsed.error.issues,
        });
      }
      const metadata = metaParsed.data;

      // 1. Buscar la empresa por apiKey
      const empresa = await prisma.empresa.findUnique({
        where: { apiKey: apiKey as string },
        select: { id: true, nombre: true, activo: true },
      });

      if (!empresa) {
        return res.status(401).json({
          success: false,
          message: 'Acceso denegado: API Key inválida o no registrada.',
        });
      }

      if (!empresa.activo) {
        return res.status(403).json({
          success: false,
          message: 'Acceso denegado: La empresa está inactiva.',
        });
      }

      // 2. Resolver submódulo por target (puerto en URL o nombre — soporta dominios sin :5181)
      const submodulo = await findSubmoduloForSsoTarget(target);

      if (!submodulo) {
        return res.status(404).json({
          success: false,
          message: `No se encontró un submódulo activo para el target "${target}".`,
        });
      }

      // 3. Buscar el tenantToken ya generado para empresa + submódulo
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
          message: `El servicio "${target}" no está activado para esta empresa.`,
        });
      }

      // Renovar ventana de sesión al entrar desde app externa (evita "expirada por inactividad")
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

      // 5. Generar token dinámico con metadata
      const { generateSsoToken, buildAccessUrl } =
        await import('../../utils/tenant-token');
      const dynamicToken = generateSsoToken(empresa.id, submodulo.id, metadata);

      const redirectUrl = buildAccessUrl(submodulo.url!, dynamicToken);

      logger.info(
        `ssoDelegate: empresa=${empresa.id} target=${target} sub=${submodulo.id} metadata=${JSON.stringify(metadata)}`,
      );

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
