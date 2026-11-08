/**
 * Correos del monitor de expedientes vía nest-api `POST /api/v1/mail/send`.
 * Al asegurado (correos 1 a 5): plantilla `expediente-documentos` con el texto oficial de
 * La Mundial (de usted, póliza en negrita, documentos pendientes y botón). Si nest-api aún no la conoce (400/422), se
 * reintenta una vez con `branded`. Correo 6 (resumen a La Mundial): `branded`.
 * Textos: documento 03_Correos_y_Reporte_Nocturno. Al asegurado nunca se le dice
 * «vendedor» ni se le tutea. Nunca se registran correos ni nombres en logs.
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
    polizas: e.polizas.slice(0, 10).map((x) => recortar(x, 60)),
    documentos: e.documentos.slice(0, 30).map((d) => ({
      nombre: recortar(d.nombre, 120),
      estado: d.estado,
      ...(d.motivo ? { motivo: recortar(d.motivo, 300) } : {}),
      ...(d.poliza ? { poliza: recortar(d.poliza, 60) } : {}),
    })),
    ...(e.enlace ? { enlace: e.enlace } : {}),
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
// Texto oficial de La Mundial, de usted. Cada mensaje va una sola vez: firma y
// pie los pone la plantilla. En `branded` (respaldo) no hay negrita: la póliza
// va en `fields`.

export interface DatosCorreoAsegurado {
  nombre: string;
  polizas: string[];
  documentos: DocumentoCorreo[];
  enlace: string | null;
}

const MARCA = 'La Mundial de Seguros';

/** «N.º X», «N.º X y N.º Y». */
export function listaPolizas(polizas: string[]): string {
  return enLista(polizas.map((p) => `N.º ${p}`));
}

function refPolizas(polizas: string[]): string {
  const su = polizas.length > 1 ? 'sus pólizas' : 'su póliza';
  return polizas.length ? `${su} ${listaPolizas(polizas)}` : su;
}

/** Asunto oficial (el recordatorio lleva «Recordatorio:» delante). */
export function asuntoExpediente(
  tipo: TipoCorreoAsegurado,
  polizas: string[],
): string {
  const ref = refPolizas(polizas);
  switch (tipo) {
    case 'recordatorio':
      return `Recordatorio: ${MARCA} | Complete la documentación de ${ref}`;
    case 'observado':
      return `${MARCA} | Necesitamos corregir un documento de ${ref}`;
    case 'recibido':
      return `${MARCA} | Documento recibido de ${ref}`;
    case 'completo':
      return `${MARCA} | Expediente completo de ${ref}`;
    default:
      return `${MARCA} | Complete la documentación de ${ref}`;
  }
}

/** «Licencia de conducir (La licencia está vencida)». */
function lineaDoc(d: DocumentoCorreo, conPoliza: boolean): string {
  const motivo = d.motivo ? d.motivo.replace(/[.\s]+$/, '') : '';
  const pol = conPoliza && d.poliza ? ` de la póliza N.º ${d.poliza}` : '';
  return `${d.nombre}${pol}${motivo ? ` (${motivo})` : ''}`;
}

function pendientesDeLista(docs: DocumentoCorreo[]): DocumentoCorreo[] {
  return docs.filter(
    (d) => d.estado === 'pendiente' || d.estado === 'corregir',
  );
}

const NOTA_ENTREGADOS =
  '¿Ya entregó estos documentos a La Mundial de Seguros? Si los entregó previamente por alguno de ' +
  'nuestros canales autorizados, no necesita cargarlos nuevamente. Esta gestión no afecta la emisión de su póliza.';
const NO_AFECTA = 'Esta gestión no afecta la emisión de su póliza.';

/** Datos para `expediente-documentos` + respaldo `branded`. */
function armar(
  tipo: TipoCorreoAsegurado,
  p: DatosCorreoAsegurado,
  branded: Pick<BrandedContent, 'title' | 'intro' | 'extraNote'>,
): BrandedContent {
  const enlace = tipo === 'recibido' || tipo === 'completo' ? null : p.enlace;
  const pendientes = pendientesDeLista(p.documentos);
  const fields = [
    ...(p.polizas.length
      ? [
          {
            label: p.polizas.length > 1 ? 'Pólizas' : 'Póliza',
            value: listaPolizas(p.polizas),
          },
        ]
      : []),
    ...(tipo === 'recibido' || tipo === 'completo'
      ? []
      : [{ label: 'Pendientes', value: String(pendientes.length) }]),
  ];
  return {
    subject: asuntoExpediente(tipo, p.polizas),
    eyebrow: 'Control documental',
    ...branded,
    fields,
    ...(enlace ? { ctaLabel: 'Completar mi expediente', ctaUrl: enlace } : {}),
    expediente: {
      tipo,
      nombre: p.nombre,
      polizas: p.polizas,
      documentos: p.documentos,
      enlace,
    },
  };
}

function cuerpoSolicitud(
  tipo: 'solicitud' | 'recordatorio',
  p: DatosCorreoAsegurado,
): BrandedContent {
  const pend = pendientesDeLista(p.documentos);
  const varias = p.polizas.length > 1;
  return armar(tipo, p, {
    title: `Complete la documentación de ${varias ? 'sus pólizas' : 'su póliza'}`,
    intro:
      `Estimado(a) ${p.nombre}: le confirmamos que ${varias ? 'sus pólizas han sido emitidas' : 'su póliza ha sido emitida'} ` +
      'exitosamente. ' +
      (pend.length
        ? `Aún se encuentra pendiente completar la siguiente documentación: ${pend
            .map((d) => lineaDoc(d, varias))
            .join('; ')}.`
        : 'Estamos validando su documentación.'),
    extraNote: NOTA_ENTREGADOS,
  });
}

export function correoSolicitudInicial(
  p: DatosCorreoAsegurado,
): BrandedContent {
  return cuerpoSolicitud('solicitud', p);
}

export function correoRecordatorio(p: DatosCorreoAsegurado): BrandedContent {
  return cuerpoSolicitud('recordatorio', p);
}

export function correoObservado(
  p: DatosCorreoAsegurado & { documento: string; motivo: string },
): BrandedContent {
  const motivo = p.motivo.replace(/[.\s]+$/, '');
  return armar('observado', p, {
    title: 'Necesitamos corregir un documento',
    intro:
      `Estimado(a) ${p.nombre}: revisamos la documentación recibida y necesitamos que cargue ` +
      `nuevamente el siguiente documento: ${p.documento}${motivo ? ` (${motivo})` : ''}.`,
    extraNote: NO_AFECTA,
  });
}

export function correoRecibido(
  p: DatosCorreoAsegurado & { documento: string },
): BrandedContent {
  return armar('recibido', p, {
    title: 'Documento recibido',
    intro:
      `Estimado(a) ${p.nombre}: le confirmamos que recibimos el documento ${p.documento}. ` +
      'Lo estamos verificando y le informaremos si hace falta alguna corrección.',
  });
}

export function correoCompleto(p: DatosCorreoAsegurado): BrandedContent {
  return armar('completo', p, {
    title: 'Su expediente está completo',
    intro:
      `Estimado(a) ${p.nombre}: le confirmamos que hemos completado y validado la documentación ` +
      `de ${p.polizas.length > 1 ? 'sus pólizas' : 'su póliza'}. No necesita realizar ninguna otra gestión para este expediente.`,
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
