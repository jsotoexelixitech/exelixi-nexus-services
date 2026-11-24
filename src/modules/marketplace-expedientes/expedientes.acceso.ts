/**
 * Acceso del asegurado por cédula + código al correo registrado (segundo factor).
 * /publico/verificar dice si el documento no es asegurado, si no tiene documentos pendientes
 * o si su póliza no tiene correo (pedido de La Mundial, 16-nov-2026: no prometer un código que
 * no va a llegar); el correo destino va enmascarado. Los límites por IP y por documento frenan
 * el barrido de cédulas. El código se guarda solo como HMAC en mkt_expediente_enlace
 * (proposito `codigo_cedula`, que resolverEnlace nunca acepta como enlace), vence a los
 * 10 minutos, admite 5 intentos y un solo uso. Al validarlo se crea un enlace
 * `carga_documental` de 60 minutos limitado a los expedientes incompletos de ese asegurado.
 * Exclusiones «No enviar» y lista blanca de QA: las mismas del resto de correos.
 * Sin datos personales en logs.
 */
import { createHmac, randomInt, timingSafeEqual } from 'crypto';
import type { MktExpediente, Prisma } from '@prisma/client';
import { z } from 'zod';
import prisma from '../../config/prisma';
import logger from '../../utils/logger';
import { AppError } from '../../utils/app-error';
import {
  areasEnAlcance,
  aseguradoKey,
  emailValido,
  esPendiente,
  requisitosAplicables,
  estadoSinFila,
} from './expedientes.domain';
import { correoCodigo, entregarCorreo } from './expedientes.mail';
import {
  estaExcluido,
  expedientesService as svc,
  primerNombre,
} from './expedientes.service';

export const PROPOSITO_CODIGO = 'codigo_cedula';
export const CODIGO_MINUTOS = 10;
export const CODIGO_MAX_INTENTOS = 5;
export const CODIGO_REENVIO_SEGUNDOS = 60;
export const ENLACE_CEDULA_MINUTOS = 60;

export const MENSAJE_NO_ASEGURADO =
  'Este documento no corresponde a un asegurado con póliza registrada. Verifique el tipo y el número de documento.';
export const MENSAJE_SIN_PENDIENTES =
  'Su póliza no tiene documentos pendientes. No necesita realizar ninguna otra gestión.';
export const MENSAJE_SIN_CORREO =
  'Su póliza no tiene un correo registrado. Comuníquese con su asesor de seguros para actualizarlo.';
export const MENSAJE_NO_DISPONIBLE =
  'Por ahora no podemos enviarle el código. Comuníquese con su asesor de seguros.';
export const MENSAJE_ENVIO_FALLIDO =
  'No pudimos enviar el código en este momento. Intente de nuevo en unos minutos.';
export const MENSAJE_CODIGO_INVALIDO =
  'El código no es válido o ya venció. Revise el correo más reciente o solicite un código nuevo.';

export const TIPOS_DOC_PORTAL = ['V', 'E', 'J', 'P'] as const;

const tipoDocSchema = z.preprocess(
  (v) =>
    String(v ?? '')
      .trim()
      .toUpperCase(),
  z.enum(TIPOS_DOC_PORTAL),
);
const documentoSchema = z.preprocess(
  (v) => String(v ?? '').replace(/\D/g, ''),
  z.string().regex(/^\d{5,12}$/, 'Indique un número de documento válido.'),
);

export const verificarIdentidadSchema = z.object({
  tipoDoc: tipoDocSchema,
  documento: documentoSchema,
});

export const verificarCodigoSchema = verificarIdentidadSchema.extend({
  codigo: z.preprocess(
    (v) => String(v ?? '').replace(/\s/g, ''),
    z.string().regex(/^\d{6}$/, 'El código tiene 6 dígitos.'),
  ),
});

/** Misma clave que usa crearEnlace / el registro de la emisión. */
export function claveAsegurado(
  tipoDoc: unknown,
  documento: unknown,
): string | null {
  const doc = String(documento ?? '').replace(/\D/g, '');
  if (!doc) return null;
  return aseguradoKey({
    tipoDoc: String(tipoDoc ?? 'V')
      .trim()
      .toUpperCase()
      .slice(0, 1),
    documento: doc,
  });
}

function secreto(): string {
  return (
    String(
      process.env.EXPEDIENTES_OTP_SECRET || process.env.JWT_SECRET || '',
    ).trim() || 'expedientes-codigo'
  );
}

/** HMAC con secreto del servidor: 6 dígitos con sha256 a secas se revierten en segundos. */
export function hashCodigo(key: string, codigo: string): string {
  return createHmac('sha256', secreto())
    .update(`codigo|${key}|${codigo}`, 'utf8')
    .digest('hex');
}

function iguales(a: string, b: string): boolean {
  const x = Buffer.from(a, 'hex');
  const y = Buffer.from(b, 'hex');
  return x.length === y.length && timingSafeEqual(x, y);
}

function invalido(): AppError {
  return new AppError(MENSAJE_CODIGO_INVALIDO, 400);
}

/** Expedientes incompletos, en alcance, no excluidos y con algo pendiente del asegurado. */
export async function expedientesAccesibles(
  key: string,
): Promise<MktExpediente[]> {
  const config = await svc.getConfig();
  const exps = await prisma.mktExpediente.findMany({
    where: {
      aseguradoKey: key,
      estadoDocumental: 'incompleto',
      area: { in: areasEnAlcance(config.alcance) },
    },
    orderBy: { emitidaEn: 'desc' },
  });
  if (!exps.length) return [];
  const exclusiones = await svc.exclusionesActivas();
  const activos = exps.filter((e) => !estaExcluido(e, exclusiones));
  if (!activos.length) return [];
  const reqs = await prisma.mktExpedienteRequisito.findMany({
    where: { expedienteId: { in: activos.map((e) => e.id) } },
  });
  return activos.filter((e) =>
    requisitosAplicables(e.producto, config).some((t) =>
      esPendiente(
        reqs.find((r) => r.expedienteId === e.id && r.tipo === t)?.estado ??
          estadoSinFila(t),
      ),
    ),
  );
}

async function eventos(
  exps: Pick<MktExpediente, 'id'>[],
  tipo: string,
  detalle: Record<string, unknown>,
) {
  for (const e of exps) await svc.evento(e.id, tipo, 'asegurado', detalle);
}

function idsDe(raw: unknown): { id: number }[] {
  return (Array.isArray(raw) ? raw : [])
    .map(Number)
    .filter((n) => Number.isInteger(n))
    .map((id) => ({ id }));
}

export type ResultadoSolicitud =
  | 'enviado'
  | 'no_asegurado'
  | 'sin_pendientes'
  | 'espera'
  | 'error'
  | 'bloqueado_whitelist'
  | 'sin_correo'
  | 'excluido';

export interface SolicitudCodigo {
  resultado: ResultadoSolicitud;
  /** Correo al que salió el código, enmascarado (j***@gmail.com). */
  destinatarioMasked?: string | null;
}

/**
 * Genera y envía el código si hay expedientes incompletos con correo válido. Nunca lanza
 * por «no existe»: devuelve el motivo y la ruta lo traduce con `respuestaSolicitud`.
 */
export async function solicitarCodigo(
  tipoDoc: string,
  documento: string,
  ahora: Date = new Date(),
): Promise<SolicitudCodigo> {
  const key = claveAsegurado(tipoDoc, documento);
  if (!key) return { resultado: 'no_asegurado' };
  const exps = await expedientesAccesibles(key);
  if (!exps.length) {
    // Con pólizas pero ya completas, excluidas o fuera de alcance: no hay nada que cargar.
    const alguna = await prisma.mktExpediente.findFirst({
      where: { aseguradoKey: key },
      select: { id: true },
    });
    logger.info(
      `[expedientes] acceso por cédula: ${alguna ? 'sin documentos pendientes' : 'no es asegurado'}`,
    );
    return { resultado: alguna ? 'sin_pendientes' : 'no_asegurado' };
  }
  const email = exps.map((e) => e.aseguradoEmail).find((v) => emailValido(v));
  if (!email) {
    logger.info('[expedientes] acceso por cédula: póliza sin correo');
    return { resultado: 'sin_correo' };
  }

  const ultimo = await prisma.mktExpedienteEnlace.findFirst({
    where: { proposito: PROPOSITO_CODIGO, aseguradoKey: key },
    orderBy: { id: 'desc' },
  });
  if (
    ultimo &&
    ahora.getTime() - ultimo.createdAt.getTime() <
      CODIGO_REENVIO_SEGUNDOS * 1000
  ) {
    return { resultado: 'espera' };
  }

  // Un solo código vigente por asegurado: el nuevo reemplaza a los anteriores.
  await prisma.mktExpedienteEnlace.updateMany({
    where: {
      proposito: PROPOSITO_CODIGO,
      aseguradoKey: key,
      usadoEn: null,
      revocadoEn: null,
    },
    data: { revocadoEn: ahora },
  });

  let codigo = '';
  let filaId: number | null = null;
  for (let i = 0; i < 3 && filaId == null; i++) {
    codigo = String(randomInt(0, 1_000_000)).padStart(6, '0');
    try {
      const fila = await prisma.mktExpedienteEnlace.create({
        data: {
          tokenHash: hashCodigo(key, codigo),
          proposito: PROPOSITO_CODIGO,
          aseguradoKey: key,
          expedienteIds: exps.map(
            (e) => e.id,
          ) as unknown as Prisma.InputJsonValue,
          expiraEn: new Date(ahora.getTime() + CODIGO_MINUTOS * 60_000),
          createdAt: ahora,
        },
      });
      filaId = fila.id;
    } catch (err) {
      // El mismo código ya salió antes para este asegurado (índice único): otro.
      if ((err as { code?: string }).code !== 'P2002') throw err;
    }
  }
  if (filaId == null) throw new Error('no se pudo generar el código');

  const nombre = primerNombre(exps[0]);
  const r = await entregarCorreo(
    [email],
    nombre,
    correoCodigo({ nombre, codigo, minutos: CODIGO_MINUTOS }),
  );
  if (r.resultado !== 'enviado') {
    await prisma.mktExpedienteEnlace.update({
      where: { id: filaId },
      data: { revocadoEn: ahora },
    });
  }
  await eventos(exps, 'acceso_cedula_codigo', {
    resultado: r.resultado,
    destinatario: r.destinatarioMasked,
  });
  logger.info(`[expedientes] acceso por cédula: código ${r.resultado}`);
  return { resultado: r.resultado, destinatarioMasked: r.destinatarioMasked };
}

/**
 * Respuesta de /publico/verificar: mensaje para pasar al paso del código, o AppError con el
 * motivo (422/409 los muestra el portal tal cual) cuando no hay a quién enviarlo.
 */
export function respuestaSolicitud(s: SolicitudCodigo): { mensaje: string } {
  switch (s.resultado) {
    case 'enviado':
      return {
        mensaje: s.destinatarioMasked
          ? `Enviamos un código de verificación a ${s.destinatarioMasked}, el correo registrado en su póliza.`
          : 'Enviamos un código de verificación al correo registrado en su póliza.',
      };
    case 'espera':
      return {
        mensaje:
          'Ya le enviamos un código hace menos de un minuto al correo registrado en su póliza. Revise su correo.',
      };
    case 'no_asegurado':
      throw new AppError(MENSAJE_NO_ASEGURADO, 422);
    case 'sin_pendientes':
      throw new AppError(MENSAJE_SIN_PENDIENTES, 409);
    case 'sin_correo':
      throw new AppError(MENSAJE_SIN_CORREO, 422);
    case 'excluido':
    case 'bloqueado_whitelist':
      throw new AppError(MENSAJE_NO_DISPONIBLE, 422);
    default:
      throw new AppError(MENSAJE_ENVIO_FALLIDO, 502);
  }
}

/**
 * Código correcto → enlace `carga_documental` de 60 minutos con los expedientes incompletos
 * de ese asegurado. Cualquier fallo responde el mismo error genérico y cuenta el intento.
 */
export async function verificarCodigo(
  tipoDoc: string,
  documento: string,
  codigo: string,
  ahora: Date = new Date(),
): Promise<{ token: string; expiraEn: Date }> {
  const key = claveAsegurado(tipoDoc, documento);
  if (!key || !/^\d{6}$/.test(codigo)) throw invalido();
  const fila = await prisma.mktExpedienteEnlace.findFirst({
    where: {
      proposito: PROPOSITO_CODIGO,
      aseguradoKey: key,
      usadoEn: null,
      revocadoEn: null,
      expiraEn: { gt: ahora },
    },
    orderBy: { id: 'desc' },
  });
  if (!fila) throw invalido();
  const afectados = idsDe(fila.expedienteIds);

  if (fila.accesos >= CODIGO_MAX_INTENTOS) {
    await prisma.mktExpedienteEnlace.update({
      where: { id: fila.id },
      data: { revocadoEn: ahora },
    });
    throw invalido();
  }

  if (!iguales(fila.tokenHash, hashCodigo(key, codigo))) {
    const upd = await prisma.mktExpedienteEnlace.update({
      where: { id: fila.id },
      data: { accesos: { increment: 1 }, ultimoAccesoEn: ahora },
    });
    const agotado = upd.accesos >= CODIGO_MAX_INTENTOS;
    if (agotado) {
      await prisma.mktExpedienteEnlace.update({
        where: { id: fila.id },
        data: { revocadoEn: ahora },
      });
    }
    await eventos(
      afectados,
      agotado ? 'acceso_cedula_bloqueado' : 'acceso_cedula_codigo_invalido',
      { intentos: upd.accesos },
    );
    logger.info(
      `[expedientes] acceso por cédula: código inválido (intento ${upd.accesos})`,
    );
    throw invalido();
  }

  // Un solo uso, también con dos peticiones simultáneas.
  const { count } = await prisma.mktExpedienteEnlace.updateMany({
    where: { id: fila.id, usadoEn: null, revocadoEn: null },
    data: { usadoEn: ahora, ultimoAccesoEn: ahora },
  });
  if (count !== 1) throw invalido();

  const exps = await expedientesAccesibles(key);
  if (!exps.length) {
    throw new AppError(
      'Su expediente ya no tiene documentos pendientes. No necesita realizar ninguna otra gestión.',
      409,
    );
  }
  const link = await svc.crearEnlace(
    key,
    exps.map((e) => e.id),
    { minutos: ENLACE_CEDULA_MINUTOS },
  );
  await eventos(exps, 'acceso_cedula_validado', {
    vigenciaMinutos: ENLACE_CEDULA_MINUTOS,
  });
  logger.info('[expedientes] acceso por cédula: código validado');
  return { token: link.token, expiraEn: link.expiraEn };
}
