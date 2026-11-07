/**
 * Correos del monitor de expedientes vía nest-api `POST /api/v1/mail/send`
 * (plantilla `branded`), igual que los correos de la mesa técnica.
 * Textos: documento 03_Correos_y_Reporte_Nocturno (correos 1 a 6).
 * Nunca se registran correos ni nombres en logs.
 */
import logger from '../../utils/logger';
import { nestMailAccepted } from '../funeral-submission/nest-mail-result';
import { emailValido, maskEmail, whitelistPermite } from './expedientes.domain';
import {
  expedientesEsProduccion,
  mailWhitelist,
  nestMailConfig,
} from './expedientes.env';

export interface BrandedContent {
  subject: string;
  title: string;
  intro: string;
  fields?: { label: string; value: string }[];
  ctaLabel?: string;
  ctaUrl?: string;
  extraNote?: string;
}

export type ResultadoEnvio =
  | 'enviado'
  | 'fallido'
  | 'bloqueado_whitelist'
  | 'sin_correo'
  | 'sin_destinatarios'
  | 'excluido';

export interface EntregaResultado {
  resultado: ResultadoEnvio;
  destinatarioMasked: string | null;
  error?: string;
}

const FIRMA = 'La Mundial de Seguros.';

function recortar(v: string, max: number): string {
  return v.length > max ? `${v.slice(0, max - 1)}…` : v;
}

async function postBranded(
  to: string[],
  toName: string | undefined,
  content: BrandedContent,
): Promise<{ sent: boolean; error?: string }> {
  const { url, apiKey } = nestMailConfig();
  if (!apiKey) return { sent: false, error: 'NEST_API_KEY no configurada' };
  try {
    const res = await fetch(`${url}/api/v1/mail/send`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        apikey: apiKey,
      },
      body: JSON.stringify({
        to: to[0],
        ...(to.length > 1 ? { toExtra: to.slice(1, 21) } : {}),
        ...(toName ? { toName: recortar(toName, 120) } : {}),
        template: 'branded',
        data: {
          subject: content.subject,
          eyebrow: 'La Mundial de Seguros',
          title: content.title,
          intro: content.intro,
          fields: (content.fields ?? []).map((f) => ({
            label: recortar(f.label, 80),
            value: recortar(f.value, 250),
          })),
          ...(content.ctaLabel ? { ctaLabel: content.ctaLabel } : {}),
          ...(content.ctaUrl ? { ctaUrl: content.ctaUrl } : {}),
          ...(content.extraNote ? { extraNote: content.extraNote } : {}),
        },
      }),
      signal: AbortSignal.timeout(20000),
    });
    const body = await res.json().catch(() => ({}));
    return nestMailAccepted(res, body);
  } catch (err) {
    return { sent: false, error: err instanceof Error ? err.message : 'error' };
  }
}

/**
 * Compuerta única de envío: correo válido → lista blanca (fuera de producción)
 * → nest-api. Con la lista vacía fuera de producción no sale nada.
 */
export async function entregarCorreo(
  destinatarios: (string | null | undefined)[],
  toName: string | undefined,
  content: BrandedContent,
): Promise<EntregaResultado> {
  const validos = Array.from(
    new Set(
      destinatarios
        .map((d) =>
          String(d ?? '')
            .trim()
            .toLowerCase(),
        )
        .filter((d) => emailValido(d)),
    ),
  );
  if (!validos.length) {
    return { resultado: 'sin_correo', destinatarioMasked: null };
  }
  const masked = validos.map((v) => maskEmail(v)).join(', ');
  const prod = expedientesEsProduccion();
  const wl = mailWhitelist();
  const permitidos = validos.filter((v) => whitelistPermite(v, prod, wl));
  if (!permitidos.length) {
    return { resultado: 'bloqueado_whitelist', destinatarioMasked: masked };
  }
  const r = await postBranded(permitidos, toName, content);
  const maskedPermitidos = permitidos.map((v) => maskEmail(v)).join(', ');
  if (!r.sent) {
    logger.warn(
      `[expedientes-mail] envío fallido: ${r.error ?? 'sin detalle'}`,
    );
    return {
      resultado: 'fallido',
      destinatarioMasked: maskedPermitidos,
      error: recortar(String(r.error ?? 'error'), 300),
    };
  }
  return { resultado: 'enviado', destinatarioMasked: maskedPermitidos };
}

// ─── Plantillas (correos 1 a 6) ────────────────────────────────────────────

export function correoSolicitudInicial(p: {
  nombre: string;
  polizaOResumen: string;
  pendientes: string[];
  enlace: string | null;
}): BrandedContent {
  return {
    subject: 'La Mundial | Completa la documentación de tu póliza',
    title: 'Completa la documentación de tu póliza',
    intro:
      `Hola ${p.nombre}. Tu póliza ${p.polizaOResumen} ya fue emitida. Tenemos pendiente completar tu ` +
      `expediente con: ${p.pendientes.join('; ')}. ` +
      (p.enlace
        ? 'Puedes cargar los documentos desde este enlace seguro. '
        : 'Puedes facilitarlos a tu vendedor autorizado. ') +
      'Si ya los entregaste a tu vendedor, no necesitas duplicar la gestión; estamos validándolos. ' +
      `Este correo es automático y no significa que tu póliza no esté emitida. ${FIRMA}`,
    ...(p.enlace ? { ctaLabel: 'Cargar documentos', ctaUrl: p.enlace } : {}),
  };
}

export function correoRecordatorio(p: {
  nombre: string;
  pendientes: string[];
  enlace: string | null;
}): BrandedContent {
  return {
    subject: 'La Mundial | Aún necesitamos un documento de tu expediente',
    title: 'Aún necesitamos un documento de tu expediente',
    intro:
      `Hola ${p.nombre}. Continúa pendiente la siguiente documentación para completar tu expediente: ` +
      `${p.pendientes.join('; ')}. ` +
      (p.enlace
        ? 'Puedes adjuntarla desde el enlace seguro o facilitarla a tu vendedor autorizado. '
        : 'Puedes facilitarla a tu vendedor autorizado. ') +
      `Si ya la entregaste, podría encontrarse en validación. ${FIRMA}`,
    ...(p.enlace ? { ctaLabel: 'Adjuntar documentos', ctaUrl: p.enlace } : {}),
  };
}

export function correoObservado(p: {
  nombre: string;
  documento: string;
  motivo: string;
  poliza: string;
  enlace: string | null;
}): BrandedContent {
  return {
    subject: 'La Mundial | Necesitamos corregir un documento',
    title: 'Necesitamos corregir un documento',
    intro:
      `Hola ${p.nombre}. Revisamos la documentación recibida y necesitamos que actualices: ${p.documento}. ` +
      `Motivo: ${p.motivo}. ` +
      (p.enlace
        ? 'Ingresa al enlace seguro para adjuntarlo nuevamente. '
        : '') +
      `Tu póliza ${p.poliza} ya está emitida. ${FIRMA}`,
    ...(p.enlace ? { ctaLabel: 'Adjuntar de nuevo', ctaUrl: p.enlace } : {}),
  };
}

export function correoRecibido(p: {
  nombre: string;
  documento: string;
}): BrandedContent {
  return {
    subject: 'La Mundial | Documento recibido',
    title: 'Documento recibido',
    intro:
      `Hola ${p.nombre}. Recibimos correctamente ${p.documento} para tu expediente. Lo estamos verificando. ` +
      `Te informaremos si hace falta alguna corrección. ${FIRMA}`,
  };
}

export function correoCompleto(p: {
  nombre: string;
  polizaOResumen: string;
}): BrandedContent {
  return {
    subject: 'La Mundial | Tu expediente está completo',
    title: 'Tu expediente está completo',
    intro:
      `Hola ${p.nombre}. Hemos completado y validado la documentación aplicable a ${p.polizaOResumen}. ` +
      `No necesitas realizar otra gestión por este expediente. ${FIRMA}`,
  };
}

export interface ResumenNocturno {
  fechaLocal: string;
  fechaHoraCaracas: string;
  areasLabel: string;
  emitidas: number;
  completas: number;
  incompletas: number;
  sinDocumentos: number;
  ilegibles: number;
  inconsistentes: number;
  porValidar: number;
  intentos: number;
  entregados: number;
  rebotes: number;
  excluidos: number;
  totalCartera: number;
  totalCompletos: number;
  totalIncompletos: number;
  sinVinculo: number;
  errores: number;
  pendientesPago: number;
  enlaceReporte: string | null;
}

/** Correo 6: sin datos personales; el detalle va por enlace autenticado. */
export function correoResumenNocturno(r: ResumenNocturno): BrandedContent {
  const n = (v: number) => String(v);
  return {
    subject: `Marketplace | ${r.areasLabel} | Control documental diario – ${r.fechaLocal}`,
    title: `Control documental diario – ${r.fechaLocal}`,
    intro:
      `Corte: ${r.fechaHoraCaracas}. Emitidas hoy: ${r.emitidas}. Completas al corte: ${r.completas}. ` +
      `Incompletas de hoy: ${r.incompletas}. El reporte se envía aun si hay cero incompletos.`,
    fields: [
      { label: 'Emitidas hoy', value: n(r.emitidas) },
      { label: 'Completas al corte', value: n(r.completas) },
      { label: 'Incompletas de hoy', value: n(r.incompletas) },
      { label: 'Pendientes de pago (hoy)', value: n(r.pendientesPago) },
      { label: 'Sin documentos', value: n(r.sinDocumentos) },
      { label: 'Ilegibles', value: n(r.ilegibles) },
      { label: 'Inconsistentes', value: n(r.inconsistentes) },
      { label: 'Por validar', value: n(r.porValidar) },
      { label: 'Correos intentados', value: n(r.intentos) },
      {
        label: 'Entregados (aceptados por el servidor)',
        value: n(r.entregados),
      },
      { label: 'Fallidos', value: n(r.rebotes) },
      { label: '«No enviar correos»', value: n(r.excluidos) },
      {
        label: `Acumulado cartera ${r.areasLabel}`,
        value: `${r.totalCartera} (${r.totalCompletos} completos, ${r.totalIncompletos} incompletos)`,
      },
      { label: 'Sin vínculo documental', value: n(r.sinVinculo) },
      { label: 'Errores técnicos', value: n(r.errores) },
    ],
    ...(r.enlaceReporte
      ? { ctaLabel: 'Ver detalle', ctaUrl: r.enlaceReporte }
      : {}),
    extraNote:
      'Detalle de la emisión incompleta del día en el monitor (requiere sesión).',
  };
}
