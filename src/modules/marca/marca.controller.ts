import { Request, Response } from 'express';
import type { AuthRequest } from '../../middlewares/auth.middleware';
import { AppError } from '../../utils/app-error';
import { marcaService } from './marca.service';

function fallo(res: Response, error: unknown) {
  const statusCode = error instanceof AppError ? error.statusCode : 500;
  const message =
    error instanceof AppError
      ? error.message
      : 'No se pudo procesar la marca de la empresa.';
  res.status(statusCode).json({ success: false, message });
}

/** Quién hizo el cambio (queda en la marca y en el log). */
function usuarioDe(req: AuthRequest): string | null {
  const u = req.user;
  if (!u) return null;
  return (u.email || `usuario ${u.id}`).slice(0, 160);
}

export class MarcaController {
  obtener = async (req: Request, res: Response) => {
    try {
      const data = await marcaService.obtener(Number(req.params.id));
      res.json({ success: true, data });
    } catch (error) {
      fallo(res, error);
    }
  };

  guardarColores = async (req: AuthRequest, res: Response) => {
    try {
      const data = await marcaService.guardarColores(
        Number(req.params.id),
        req.body ?? {},
        usuarioDe(req),
      );
      res.json({ success: true, message: 'Colores guardados', data });
    } catch (error) {
      fallo(res, error);
    }
  };

  guardarLogo = async (req: AuthRequest, res: Response) => {
    try {
      const data = await marcaService.guardarLogo(
        Number(req.params.id),
        req.body?.logo,
        usuarioDe(req),
      );
      res.json({ success: true, message: 'Logo guardado', data });
    } catch (error) {
      fallo(res, error);
    }
  };

  quitarLogo = async (req: AuthRequest, res: Response) => {
    try {
      const data = await marcaService.quitarLogo(
        Number(req.params.id),
        usuarioDe(req),
      );
      res.json({ success: true, message: 'Logo quitado', data });
    } catch (error) {
      fallo(res, error);
    }
  };

  restablecer = async (req: AuthRequest, res: Response) => {
    try {
      const data = await marcaService.restablecer(
        Number(req.params.id),
        usuarioDe(req),
      );
      res.json({ success: true, message: 'Marca restablecida', data });
    } catch (error) {
      fallo(res, error);
    }
  };
}

/** GET /api/access/marca/:empresaId — público: { success, data: marca | null }. */
export async function servirMarcaPublica(req: Request, res: Response) {
  try {
    const empresaId = Number(req.params.empresaId);
    if (!Number.isInteger(empresaId) || empresaId <= 0) {
      return res
        .status(400)
        .json({ success: false, message: 'Empresa inválida.' });
    }
    const data = await marcaService.publica(empresaId);
    res.setHeader('Cache-Control', 'public, max-age=60');
    return res.json({ success: true, data });
  } catch {
    return res
      .status(500)
      .json({ success: false, message: 'Marca no disponible.' });
  }
}

/** GET /api/access/marca/:empresaId/logo — público, sin API key. */
export async function servirLogoMarca(req: Request, res: Response) {
  try {
    const logo = await marcaService.logo(Number(req.params.empresaId));
    if (!logo) return res.status(404).end();
    res.setHeader('Content-Type', logo.mime);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Security-Policy', "default-src 'none'");
    res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
    res.setHeader('Cache-Control', 'public, max-age=86400');
    return res.send(logo.archivo);
  } catch {
    return res.status(500).end();
  }
}
