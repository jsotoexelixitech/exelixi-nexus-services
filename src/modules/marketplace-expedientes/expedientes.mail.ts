/**
 * Correos del monitor de expedientes vía nest-api `POST /api/v1/mail/send`.
 * Al asegurado (correos 1 a 5): plantilla `expediente-documentos` (lista de documentos con
 * su estado, botón y vencimiento del enlace). Si nest-api aún no la conoce (400/422), se
 * reintenta una vez con `branded`. Correo 6 (resumen a La Mundial): `branded`.
 * Textos: documento 03_Correos_y_Reporte_Nocturno. Al asegurado nunca se le dice
 * «vendedor» (es «asesor de seguros»). Nunca se registran correos ni nombres en logs.
 */
import logger from '../../utils/logger';
import { nestMailAccepted } from '../funeral-submission/nest-mail-result';
import { emailValido, maskEmail, whitelistPermite } from './expedientes.domain';
import {
  expedientesEsProduccion,
  mailWhitelist,
  nestMailConfig,
} from './expedientes.env';

export type TipoCorreoAsegurado =
  | 'solicitud'
  | 'recordatorio'
  | 'observado'
  | 'recibido'
  | 'completo';

/** Estado del documento tal como lo ve el asegurado. */
export type EstadoDocCorreo =
  | 'pendiente'
  | 'corregir'
  | 'en_revision'
  | 'recibido'
  | 'aprobado';

export interface DocumentoCorreo {
  nombre: string;
  estado: EstadoDocCorreo;
  /** Solo en `corregir`: motivo ya preparado para el asegurado (nunca el resumen de la IA). */
  motivo?: string;
  /** Cuando el correo cubre varias pólizas. */
  poliza?: string;
}

export interface DatosExpedienteCorreo {
  tipo: TipoCorreoAsegurado;
  nombre: string;
  polizas: string[];
  documentos: DocumentoCorreo[];
  enlace: string | null;
  expiraEn: Date | null;
}

export interface BrandedContent {
  subject: string;
  eyebrow?: string;
  title: string;
  intro: string;
  fields?: { label: string; value: string }[];
  ctaLabel?: string;
  ctaUrl?: string;
  extraNote?: string;
  /** Si viene, se envía con `expediente-documentos` y lo demás queda de respaldo `branded`. */
  expediente?: DatosExpedienteCorreo;
}

export type ResultadoEnvio =
  | 'enviado'
  | 'error'
  | 'bloqueado_whitelist'
  | 'sin_correo'
  | 'excluido';

export interface EntregaResultado {
  resultado: ResultadoEnvio;
  destinatarioMasked: string | null;
  error?: string;
}

function recortar(v: string, max: number): string {
  return v.length > max ? `${v.slice(0, max - 1)}…` : v;
}

/** Estado de la BD → estado visible; `sin_informacion` no se muestra. */
export function estadoDocCorreo(estado: string): EstadoDocCorreo | null {
  switch (estado) {
    case 'faltante':
      return 'pendiente';
    case 'observado':
      return 'corregir';
    case 'recibido':
      return 'en_revision';
    case 'validado':
      return 'aprobado';
    default:
      return null;
  }
}

/** "sábado, 14 de noviembre de 2026" en hora de Caracas. */
export function fechaVence(d: Date, corta = false): string {
  try {
    if (corta)
      return d.toLocaleDateString('es-VE', {
        day: '2-digit',
        month: '2-digit',
        year: 'numeric',
        timeZone: 'America/Caracas',
      });
    return d.toLocaleDateString('es-VE', {
      weekday: 'long',
      day: 'numeric',
      month: 'long',
      year: 'numeric',
      timeZone: 'America/Caracas',
    });
  } catch {
    return d.toISOString().slice(0, 10);
  }
}

function enLista(items: string[]): string {
  if (items.length <= 1) return items.join('');
  return `${items.slice(0, -1).join(', ')} y ${items.at(-1)}`;
}

async function postNest(
  to: string[],
  toName: string | undefined,
  template: 'branded' | 'expediente-documentos',
  data: Record<string, unknown>,
): Promise<{ sent: boolean; error?: string; status?: number }> {
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
        template,
        data,
      }),
      signal: AbortSignal.timeout(20000),
    });
    const body = await res.json().catch(() => ({}));
    return { ...nestMailAccepted(res, body), status: res.status };
  } catch (err) {
    return { sent: false, error: err instanceof Error ? err.message : 'error' };
  }
}

function datosBranded(content: BrandedContent): Record<string, unknown> {
  return {
    subject: content.subject,
    eyebrow: content.eyebrow ?? 'La Mundial de Seguros',
    title: content.title,
    intro: content.intro,
    fields: (content.fields ?? []).map((f) => ({
      label: recortar(f.label, 80),
      value: recortar(f.value, 250),
    })),
    ...(content.ctaLabel ? { ctaLabel: content.ctaLabel } : {}),
    ...(content.ctaUrl ? { ctaUrl: content.ctaUrl } : {}),
    ...(content.extraNote ? { extraNote: content.extraNote } : {}),
  };
}

function datosExpediente(
  subject: string,
  e: DatosExpedienteCorreo,
): Record<string, unknown> {
  return {
    subject,
    tipo: e.tipo,
    nombre: recortar(e.nombre, 80),
    poliza: recortar(e.polizas.join(', '), 200),
    documentos: e.documentos.slice(0, 30).map((d) => ({
      nombre: recortar(d.nombre, 120),
      estado: d.estado,
      ...(d.motivo ? { motivo: recortar(d.motivo, 300) } : {}),
      ...(d.poliza ? { poliza: recortar(d.poliza, 60) } : {}),
    })),
    ...(e.enlace ? { enlace: e.enlace } : {}),
    ...(e.enlace && e.expiraEn ? { venceEn: e.expiraEn.toISOString() } : {}),
  };
}

/** Plantilla nueva y, si nest-api no la conoce (400/422), una sola vez `branded`. */
async function postCorreo(
  to: string[],
  toName: string | undefined,
  content: BrandedContent,
): Promise<{ sent: boolean; error?: string }> {
  if (content.expediente) {
    const r = await postNest(
      to,
      toName,
      'expediente-documentos',
      datosExpediente(content.subject, content.expediente),
    );
    if (r.sent || (r.status !== 400 && r.status !== 422)) return r;
    logger.warn(
      `[expedientes-mail] nest-api rechazó expediente-documentos (HTTP ${r.status}); reintento con branded`,
    );
  }
  return postNest(to, toName, 'branded', datosBranded(content));
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
  const r = await postCorreo(permitidos, toName, content);
  const maskedPermitidos = permitidos.map((v) => maskEmail(v)).join(', ');
  if (!r.sent) {
    logger.warn(
      `[expedientes-mail] envío fallido: ${r.error ?? 'sin detalle'}`,
    );
    return {
      resultado: 'error',
      destinatarioMasked: maskedPermitidos,
      error: recortar(String(r.error ?? 'error'), 300),
    };
  }
  return { resultado: 'enviado', destinatarioMasked: maskedPermitidos };
}

// ─── Plantillas (correos 1 a 6) ────────────────────────────────────────────
//
// Cada mensaje va una sola vez: la firma y el aviso de correo automático ya los
// pone el pie de la plantilla; la póliza va en `fields` (sale en negrita en
// `branded`) y en el texto de `expediente-documentos`.

export interface DatosCorreoAsegurado {
  nombre: string;
  polizas: string[];
  documentos: DocumentoCorreo[];
  enlace: string | null;
  expiraEn?: Date | null;
}

const NOTA_ASESOR_CON_ENLACE =
  'Si ya los entregaste a tu asesor de seguros, no tienes que enviarlos de nuevo: los estamos validando.';
const NOTA_ASESOR_SIN_ENLACE =
  'Puedes entregarlos a tu asesor de seguros. Si ya lo hiciste, no tienes que enviarlos de nuevo: los estamos validando.';

function pendientesDeLista(docs: DocumentoCorreo[]): DocumentoCorreo[] {
  return docs.filter(
    (d) => d.estado === 'pendiente' || d.estado === 'corregir',
  );
}

function cuantos(n: number): string {
  return n === 1 ? '1 documento' : `${n} documentos`;
}

/** Datos para `expediente-documentos` + campos del respaldo `branded`. */
function armar(
  tipo: TipoCorreoAsegurado,
  p: DatosCorreoAsegurado,
  branded: Omit<BrandedContent, 'fields' | 'expediente'>,
): BrandedContent {
  const enlace = tipo === 'recibido' || tipo === 'completo' ? null : p.enlace;
  const expiraEn = enlace ? (p.expiraEn ?? null) : null;
  const pendientes = pendientesDeLista(p.documentos);
  const fields = [
    ...(p.polizas.length
      ? [
          {
            label: p.polizas.length > 1 ? 'Pólizas' : 'Póliza',
            value: p.polizas.join(', '),
          },
        ]
      : []),
    ...(tipo === 'recibido' || tipo === 'completo'
      ? []
      : [{ label: 'Pendientes', value: String(pendientes.length) }]),
    ...(expiraEn
      ? [{ label: 'Vence', value: fechaVence(expiraEn, true) }]
      : []),
  ];
  return {
    ...branded,
    fields,
    ...(enlace
      ? { ctaLabel: 'Subir mis documentos', ctaUrl: enlace }
      : { ctaLabel: undefined, ctaUrl: undefined }),
    expediente: {
      tipo,
      nombre: p.nombre,
      polizas: p.polizas,
      documentos: p.documentos,
      enlace,
      expiraEn,
    },
  };
}

export function correoSolicitudInicial(
  p: DatosCorreoAsegurado,
): BrandedContent {
  const pend = pendientesDeLista(p.documentos);
  return armar('solicitud', p, {
    subject: 'La Mundial | Completa la documentación de tu póliza',
    eyebrow: 'Documentos de tu póliza',
    title: pend.length
      ? `Completa tu expediente: falta${pend.length === 1 ? '' : 'n'} ${cuantos(pend.length)}`
      : 'Completa la documentación de tu póliza',
    intro:
      `Hola ${p.nombre}. Tu póliza ya está emitida. ` +
      (pend.length
        ? `Para completar tu expediente necesitamos: ${enLista(pend.map((d) => d.nombre))}.`
        : 'Estamos validando tus documentos.'),
    extraNote: p.enlace ? NOTA_ASESOR_CON_ENLACE : NOTA_ASESOR_SIN_ENLACE,
  });
}

export function correoRecordatorio(p: DatosCorreoAsegurado): BrandedContent {
  const pend = pendientesDeLista(p.documentos);
  return armar('recordatorio', p, {
    subject: 'La Mundial | Aún necesitamos un documento de tu expediente',
    eyebrow: 'Recordatorio',
    title: pend.length
      ? `Aún falta${pend.length === 1 ? '' : 'n'} ${cuantos(pend.length)} de tu expediente`
      : 'Aún necesitamos un documento de tu expediente',
    intro:
      `Hola ${p.nombre}. ` +
      (pend.length
        ? `Todavía necesitamos: ${enLista(pend.map((d) => d.nombre))}.`
        : 'Estamos validando tus documentos.'),
    extraNote: p.enlace ? NOTA_ASESOR_CON_ENLACE : NOTA_ASESOR_SIN_ENLACE,
  });
}

export function correoObservado(
  p: DatosCorreoAsegurado & { documento: string; motivo: string },
): BrandedContent {
  return armar('observado', p, {
    subject: 'La Mundial | Necesitamos corregir un documento',
    eyebrow: 'Revisión de documentos',
    title: 'Necesitamos que envíes un documento de nuevo',
    intro:
      `Hola ${p.nombre}. Envía de nuevo: ${p.documento}. Motivo: ${p.motivo}. ` +
      'Tu póliza sigue emitida.',
  });
}

export function correoRecibido(
  p: DatosCorreoAsegurado & { documento: string },
): BrandedContent {
  return armar('recibido', p, {
    subject: 'La Mundial | Documento recibido',
    eyebrow: 'Documento recibido',
    title: 'Recibimos tu documento',
    intro:
      `Hola ${p.nombre}. Recibimos ${p.documento}. Lo estamos revisando y te avisaremos ` +
      'si hace falta corregir algo.',
  });
}

export function correoCompleto(p: DatosCorreoAsegurado): BrandedContent {
  return armar('completo', p, {
    subject: 'La Mundial | Tu expediente está completo',
    eyebrow: 'Expediente completo',
    title: 'Tu expediente está completo',
    intro: `Hola ${p.nombre}. Validamos toda la documentación de tu póliza. No necesitas hacer nada más.`,
  });
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
  sinInformacion: number;
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
      { label: 'Con error o rebotados', value: n(r.rebotes) },
      { label: '«No enviar correos»', value: n(r.excluidos) },
      {
        label: `Acumulado cartera ${r.areasLabel}`,
        value: `${r.totalCartera} (${r.totalCompletos} completos, ${r.totalIncompletos} incompletos)`,
      },
      { label: 'Sin información documental', value: n(r.sinInformacion) },
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
