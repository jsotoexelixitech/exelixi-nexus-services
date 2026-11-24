/**
 * Marca por empresa (logo y colores) que toman los portales de los módulos.
 * La configura el administrador en Nexus; los módulos la reciben en /api/access/verify
 * (campo `marca`) y el logo se sirve en /api/access/marca/:empresaId/logo.
 */
import prisma from '../../config/prisma';
import { AppError } from '../../utils/app-error';
import logger from '../../utils/logger';
import { coloresValidos, type ColoresMarca } from './marca.colores';

export const LOGO_TAMANO_MAXIMO = 1024 * 1024;

type FilaMarca = ColoresMarca & {
  empresaId: number;
  logoMime: string | null;
  logoTamano: number | null;
  actualizadoPor: string | null;
  updatedAt: Date;
};

const SIN_LOGO = {
  empresaId: true,
  colorPrincipal: true,
  colorSecundario: true,
  colorTerciario: true,
  logoMime: true,
  logoTamano: true,
  actualizadoPor: true,
  updatedAt: true,
} as const;

/** Tipo real del archivo por su firma. SVG no: puede llevar scripts. */
export function tipoDeImagen(buffer: Buffer): string | null {
  if (buffer.length < 12) return null;
  if (
    buffer
      .subarray(0, 8)
      .equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
  )
    return 'image/png';
  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff)
    return 'image/jpeg';
  if (
    buffer.subarray(0, 4).toString('latin1') === 'RIFF' &&
    buffer.subarray(8, 12).toString('latin1') === 'WEBP'
  )
    return 'image/webp';
  return null;
}

/** Ruta pública del logo; la versión cambia al guardar, así ningún navegador muestra uno viejo. */
export function rutaLogo(
  fila: Pick<FilaMarca, 'empresaId' | 'logoMime' | 'updatedAt'> | null,
) {
  if (!fila?.logoMime) return null;
  return `/api/access/marca/${fila.empresaId}/logo?v=${fila.updatedAt.getTime()}`;
}

function vista(fila: FilaMarca | null, empresaId: number) {
  return {
    empresaId,
    colorPrincipal: fila?.colorPrincipal ?? null,
    colorSecundario: fila?.colorSecundario ?? null,
    colorTerciario: fila?.colorTerciario ?? null,
    logoUrl: rutaLogo(fila),
    logoTamano: fila?.logoTamano ?? null,
    actualizadoPor: fila?.actualizadoPor ?? null,
    actualizadoAt: fila ? fila.updatedAt : null,
  };
}

async function exigirEmpresa(empresaId: number) {
  if (!Number.isInteger(empresaId) || empresaId <= 0) {
    throw new AppError('Empresa inválida.', 400);
  }
  const empresa = await prisma.empresa.findUnique({
    where: { id: empresaId },
    select: { id: true },
  });
  if (!empresa) throw new AppError('Empresa no encontrada.', 404);
}

async function leer(empresaId: number): Promise<FilaMarca | null> {
  return prisma.empresaMarca.findUnique({
    where: { empresaId },
    select: SIN_LOGO,
  });
}

export class MarcaService {
  async obtener(empresaId: number) {
    await exigirEmpresa(empresaId);
    return vista(await leer(empresaId), empresaId);
  }

  async guardarColores(
    empresaId: number,
    body: Record<string, unknown>,
    usuario: string | null,
  ) {
    await exigirEmpresa(empresaId);
    let colores: ColoresMarca;
    try {
      colores = coloresValidos(body);
    } catch (err) {
      throw new AppError((err as Error).message, 400);
    }
    const fila = await prisma.empresaMarca.upsert({
      where: { empresaId },
      create: { empresaId, ...colores, actualizadoPor: usuario },
      update: { ...colores, actualizadoPor: usuario },
      select: SIN_LOGO,
    });
    logger.info(
      `marca: colores de la empresa ${empresaId} guardados por ${usuario ?? 'sin usuario'}`,
    );
    return vista(fila, empresaId);
  }

  /** Logo en base64 (con o sin prefijo data:). PNG, JPG o WEBP de hasta 1 MB. */
  async guardarLogo(
    empresaId: number,
    base64: unknown,
    usuario: string | null,
  ) {
    await exigirEmpresa(empresaId);
    const crudo = String(base64 ?? '').replace(/^data:[^;]+;base64,/, '');
    if (!crudo) throw new AppError('Adjunta el logo.', 400);
    const archivo = Buffer.from(crudo, 'base64');
    if (archivo.length > LOGO_TAMANO_MAXIMO) {
      throw new AppError('El logo supera 1 MB.', 400);
    }
    const mime = tipoDeImagen(archivo);
    if (!mime) throw new AppError('El logo debe ser PNG, JPG o WEBP.', 400);
    const fila = await prisma.empresaMarca.upsert({
      where: { empresaId },
      create: {
        empresaId,
        logo: archivo,
        logoMime: mime,
        logoTamano: archivo.length,
        actualizadoPor: usuario,
      },
      update: {
        logo: archivo,
        logoMime: mime,
        logoTamano: archivo.length,
        actualizadoPor: usuario,
      },
      select: SIN_LOGO,
    });
    logger.info(
      `marca: logo de la empresa ${empresaId} guardado por ${usuario ?? 'sin usuario'}`,
    );
    return vista(fila, empresaId);
  }

  async quitarLogo(empresaId: number, usuario: string | null) {
    await exigirEmpresa(empresaId);
    const actual = await leer(empresaId);
    if (!actual) return vista(null, empresaId);
    const fila = await prisma.empresaMarca.update({
      where: { empresaId },
      data: {
        logo: null,
        logoMime: null,
        logoTamano: null,
        actualizadoPor: usuario,
      },
      select: SIN_LOGO,
    });
    logger.info(
      `marca: logo de la empresa ${empresaId} quitado por ${usuario ?? 'sin usuario'}`,
    );
    return vista(fila, empresaId);
  }

  /** Vuelve a la marca por defecto de cada aplicación: borra logo y colores. */
  async restablecer(empresaId: number, usuario: string | null) {
    await exigirEmpresa(empresaId);
    await prisma.empresaMarca.deleteMany({ where: { empresaId } });
    logger.info(
      `marca: marca de la empresa ${empresaId} restablecida por ${usuario ?? 'sin usuario'}`,
    );
    return vista(null, empresaId);
  }

  /** Logo para servir en público, o null. */
  async logo(empresaId: number) {
    if (!Number.isInteger(empresaId) || empresaId <= 0) return null;
    const fila = await prisma.empresaMarca.findUnique({
      where: { empresaId },
      select: { logo: true, logoMime: true },
    });
    return fila?.logo && fila.logoMime
      ? { archivo: Buffer.from(fila.logo), mime: fila.logoMime }
      : null;
  }

  /** Marca que viaja en /api/access/verify; null si la empresa no la configuró. */
  async publica(empresaId: number) {
    const fila = await leer(empresaId);
    if (!fila) return null;
    const v = vista(fila, empresaId);
    if (
      !v.logoUrl &&
      !v.colorPrincipal &&
      !v.colorSecundario &&
      !v.colorTerciario
    ) {
      return null;
    }
    return {
      colorPrincipal: v.colorPrincipal,
      colorSecundario: v.colorSecundario,
      colorTerciario: v.colorTerciario,
      logoUrl: v.logoUrl,
      version: fila.updatedAt.getTime(),
    };
  }
}

export const marcaService = new MarcaService();
