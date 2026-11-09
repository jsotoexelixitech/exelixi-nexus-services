/**
 * Correos del monitor de expedientes vía nest-api `POST /api/v1/mail/send`.
 * Al asegurado (correos 1 a 5): plantilla `expediente-documentos` con el texto oficial de
 * La Mundial (de usted, póliza en negrita, documentos pendientes y botón). Si nest-api aún no la conoce (400/422), se
 * reintenta una vez con `branded`. Correo 6 (control documental diario a La Mundial):
 * `expediente-reporte-diario` con respaldo `branded` (solo cifras).
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
// Solo tipos: el servicio importa este archivo y el reporte importa el servicio.
import type { FilaReporte, ReporteDiario } from './expedientes.reporte';

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
  /** false: nest-api no repite la introducción encima de la tarjeta. */
  introArriba?: boolean;
  /** Si viene, se envía con `expediente-documentos` y lo demás queda de respaldo `branded`. */
  expediente?: DatosExpedienteCorreo;
  /** Código de acceso por cédula: plantilla `expediente-codigo` con respaldo `branded`. */
  codigo?: { nombre: string; codigo: string; minutos: number };
  /** Control documental diario: `expediente-reporte-diario` con respaldo `branded` (cifras). */
  reporte?: Record<string, unknown>;
}

export type PlantillaCorreo =
  | 'branded'
  | 'expediente-documentos'
  | 'expediente-codigo'
  | 'expediente-reporte-diario';

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
  /** Plantilla con que salió (o la última intentada). */
  plantilla?: PlantillaCorreo;
}

function recortar(v: string, max: number): string {
  return v.length > max ? `${v.slice(0, max - 1)}…` : v;
}

const EMAIL_EN_TEXTO = /[^\s@<>()"',;:]+@[^\s@<>()"',;:]+\.[a-z]{2,}/gi;

/** Errores del SMTP pueden traer el destinatario: se enmascara antes de guardarlos o loguearlos. */
export function sinCorreosEnTexto(v: string): string {
  return v.replace(EMAIL_EN_TEXTO, (m) => maskEmail(m) ?? '***');
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
  template: PlantillaCorreo,
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
    ...(content.introArriba === false ? { introArriba: false } : {}),
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
): Promise<{ sent: boolean; error?: string; plantilla: PlantillaCorreo }> {
  const propia: [PlantillaCorreo, Record<string, unknown>] | null =
    content.codigo
      ? [
          'expediente-codigo',
          {
            subject: content.subject,
            nombre: recortar(content.codigo.nombre, 80),
            codigo: content.codigo.codigo,
            minutos: content.codigo.minutos,
          },
        ]
      : content.expediente
        ? [
            'expediente-documentos',
            datosExpediente(content.subject, content.expediente),
          ]
        : content.reporte
          ? ['expediente-reporte-diario', content.reporte]
          : null;
  if (propia) {
    const [plantilla, data] = propia;
    const r = await postNest(to, toName, plantilla, data);
    if (r.sent || (r.status !== 400 && r.status !== 422))
      return { ...r, plantilla };
    logger.warn(
      `[expedientes-mail] nest-api rechazó ${plantilla} (HTTP ${r.status}); reintento con branded`,
    );
  }
  const r = await postNest(to, toName, 'branded', datosBranded(content));
  return { ...r, plantilla: 'branded' };
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
    const error = recortar(sinCorreosEnTexto(String(r.error ?? 'error')), 300);
    logger.warn(`[expedientes-mail] envío fallido: ${error}`);
    return {
      resultado: 'error',
      destinatarioMasked: maskedPermitidos,
      error,
      plantilla: r.plantilla,
    };
  }
  return {
    resultado: 'enviado',
    destinatarioMasked: maskedPermitidos,
    plantilla: r.plantilla,
  };
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

export const ASUNTO_CODIGO = `${MARCA} | Código de verificación`;

/**
 * Código de acceso por cédula (de usted). Solo el código y su vigencia: ni pólizas ni
 * documentos, para que el correo no diga nada si lo ve un tercero.
 */
export function correoCodigo(p: {
  nombre: string;
  codigo: string;
  minutos: number;
}): BrandedContent {
  return {
    subject: ASUNTO_CODIGO,
    eyebrow: 'Control documental',
    title: 'Código de verificación',
    intro:
      `Estimado(a) ${p.nombre || 'asegurado(a)'}: recibimos una solicitud para ingresar a su expediente ` +
      `con su documento de identidad. Su código de verificación es ${p.codigo}. Vence en ${p.minutos} minutos ` +
      'y solo puede usarse una vez.',
    fields: [{ label: 'Código', value: p.codigo }],
    extraNote:
      'Si usted no solicitó este código, ignore este mensaje: nadie podrá ingresar sin él. ' +
      'La Mundial de Seguros nunca le pedirá este código por teléfono.',
    codigo: { nombre: p.nombre, codigo: p.codigo, minutos: p.minutos },
  };
}

// ─── Correo 6: control documental diario (a La Mundial) ─────────────────────

/**
 * nest-api acepta 100 KB por petición: con textos largos se quitan filas del final (pasan a
 * «restantes», que se ven en el monitor) hasta que el cuerpo cabe holgado.
 */
export const MAX_BYTES_REPORTE = 90_000;

/** Asunto oficial: «Marketplace | Canales | Control documental diario – DD/MM/AAAA». */
export function asuntoReporteDiario(areas: string, fechaLocal: string): string {
  return `Marketplace | ${areas} | Control documental diario – ${fechaLocal}`;
}

function filaParaCorreo(f: FilaReporte): FilaReporte {
  return {
    poliza: recortar(f.poliza, 40),
    asegurado: recortar(f.asegurado, 40),
    producto: recortar(f.producto, 40),
    emitidaPor: recortar(f.emitidaPor, 80),
    observacion: recortar(f.observacion, 160),
    dias: f.dias,
    intentos: f.intentos,
    ultimoResultado: recortar(f.ultimoResultado, 40),
    noEnviar: f.noEnviar,
    siguienteAccion: recortar(f.siguienteAccion, 80),
  };
}

/** Datos para `expediente-reporte-diario` (nest-api vuelve a validar, recortar y escapar). */
export function datosReporteDiario(
  subject: string,
  r: ReporteDiario,
): Record<string, unknown> {
  const base = {
    subject,
    areas: r.areas,
    fecha: r.fechaLocal,
    corte: r.corte,
    dia: r.dia,
    distribucion: r.distribucion,
    cartera: r.cartera,
    historicos: r.historicos,
    conciliacion: r.conciliacion,
    entregabilidad: r.entregabilidad,
    tecnicos: r.tecnicos,
    ...(r.enlace ? { enlace: r.enlace } : {}),
  };
  let polizas = r.polizas.map(filaParaCorreo);
  let restantes = r.polizasRestantes;
  const medir = () =>
    Buffer.byteLength(
      JSON.stringify({ ...base, polizas, polizasRestantes: restantes }),
      'utf8',
    );
  while (polizas.length && medir() > MAX_BYTES_REPORTE) {
    const quitar = Math.max(1, Math.ceil(polizas.length * 0.1));
    polizas = polizas.slice(0, -quitar);
    restantes += quitar;
  }
  return { ...base, polizas, polizasRestantes: restantes };
}

/**
 * Correo 6: listado de las incompletas de hoy con el asegurado protegido (iniciales y
 * documento parcial) y botón al monitor (requiere sesión). Si nest-api no conoce la plantilla
 * nueva, sale `branded` solo con cifras, como antes.
 */
export function correoResumenNocturno(r: ReporteDiario): BrandedContent {
  const n = (v: number) => String(v);
  const subject = asuntoReporteDiario(r.areas, r.fechaLocal);
  const cero = r.dia.incompletas === 0;
  return {
    subject,
    title: `Control documental diario – ${r.fechaLocal}`,
    // Las cifras van solo en la tabla; la introducción sale una vez.
    intro: cero
      ? `Corte: ${r.corte} (hora de Caracas). 0 pendientes de la emisión del día.`
      : `Corte: ${r.corte} (hora de Caracas). Pólizas emitidas en el Marketplace y estado de sus documentos.`,
    introArriba: false,
    fields: [
      { label: 'Emitidas hoy', value: n(r.dia.emitidas) },
      { label: 'Completas al corte', value: n(r.dia.completas) },
      { label: 'Incompletas de hoy', value: n(r.dia.incompletas) },
      { label: 'Faltantes', value: n(r.distribucion.faltantes) },
      { label: 'Ilegibles', value: n(r.distribucion.ilegibles) },
      { label: 'Inconsistentes', value: n(r.distribucion.inconsistentes) },
      { label: 'Por validar', value: n(r.distribucion.porValidar) },
      { label: 'Correos intentados', value: n(r.entregabilidad.intentos) },
      {
        label: 'Entregados (aceptados por el servidor)',
        value: n(r.entregabilidad.entregados),
      },
      { label: 'Con error o rebotados', value: n(r.entregabilidad.conError) },
      { label: '«No enviar correos»', value: n(r.historicos.noEnviar) },
      {
        label: `Acumulado cartera ${r.areas}`,
        value: `${r.cartera.total} (${r.cartera.completos} completos, ${r.cartera.incompletos} incompletos)`,
      },
      {
        label: 'Conciliación con Nexus',
        value: r.conciliacion.sinVinculo
          ? `${r.conciliacion.sinVinculo} sin vínculo`
          : 'Cuadrada',
      },
      {
        label: 'Errores técnicos',
        value: n(r.tecnicos.documentosNoLeidos + r.tecnicos.fallasTecnicas),
      },
    ],
    reporte: datosReporteDiario(subject, r),
  };
}
