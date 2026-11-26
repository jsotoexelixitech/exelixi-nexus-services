/**
 * Variables del monitor de expedientes. Todo apagado por defecto:
 * sin variable = el módulo no hace nada (rutas 404, enganche y tareas inactivos).
 */

function flag(name: string): boolean {
  return (
    String(process.env[name] ?? '')
      .trim()
      .toLowerCase() === 'true'
  );
}

export function expedientesEnabled(): boolean {
  return flag('EXPEDIENTES_ENABLED');
}

export function expedientesJobsEnabled(): boolean {
  return expedientesEnabled() && flag('EXPEDIENTES_JOBS_ENABLED');
}

/**
 * Producción solo si se declara explícitamente EXPEDIENTES_ENTORNO=produccion.
 * Los servidores de QA corren con NODE_ENV=production, así que NODE_ENV no basta:
 * si falta la variable, se asume "no producción" (lista blanca obligatoria).
 */
export function expedientesEsProduccion(): boolean {
  return (
    String(process.env.EXPEDIENTES_ENTORNO ?? '')
      .trim()
      .toLowerCase() === 'produccion'
  );
}

/**
 * Endpoint de prueba de tareas: nunca en producción declarada, y con
 * NODE_ENV=production solo si el entorno se declara qa explícitamente.
 */
export function expedientesJobsManualPermitido(): boolean {
  if (expedientesEsProduccion()) return false;
  if (process.env.NODE_ENV !== 'production') return true;
  return (
    String(process.env.EXPEDIENTES_ENTORNO ?? '')
      .trim()
      .toLowerCase() === 'qa'
  );
}

/**
 * QA: monitor completo sin login (administrador ficticio, actor `qa-acceso-libre`).
 * Requiere EXPEDIENTES_ACCESO_LIBRE=true y se ignora siempre en producción declarada.
 * Con NODE_ENV=production (servidores QA) exige además EXPEDIENTES_ENTORNO=qa explícito,
 * la misma regla del endpoint de tareas: si falta la variable de entorno, no abre nada.
 */
export function expedientesAccesoLibre(): boolean {
  if (!flag('EXPEDIENTES_ACCESO_LIBRE')) return false;
  // Producción: solo con la decisión explícita EXPEDIENTES_ACCESO_LIBRE_PRODUCCION=true (pedido del usuario 13-nov-2026).
  // Abre TODO el monitor sin login (expedientes con datos personales incluidos): quitar la variable lo cierra.
  if (expedientesEsProduccion())
    return flag('EXPEDIENTES_ACCESO_LIBRE_PRODUCCION');
  return expedientesJobsManualPermitido();
}

export function mailWhitelist(): string[] {
  return String(process.env.EXPEDIENTES_MAIL_WHITELIST ?? '')
    .split(/[,;\s]+/)
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
}

/**
 * Reporte nocturno de Productores (intermediarios): queda listo pero APAGADO hasta que La Mundial
 * lo apruebe. Para activarlo: EXPEDIENTES_RESUMEN_PRODUCTORES=true, sus destinatarios en
 * EXPEDIENTES_RESUMEN_PRODUCTORES_DESTINATARIOS (separados por coma; no usa los de Canales) y el
 * alcance «Productores» encendido en la configuración del monitor.
 */
export function reporteProductoresHabilitado(): boolean {
  return flag('EXPEDIENTES_RESUMEN_PRODUCTORES');
}

export function destinatariosReporteProductores(): string[] {
  return String(process.env.EXPEDIENTES_RESUMEN_PRODUCTORES_DESTINATARIOS ?? '')
    .split(/[,;\s]+/)
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean)
    .slice(0, 20);
}

export function publicBaseUrl(): string {
  return String(process.env.EXPEDIENTES_PUBLIC_URL ?? '')
    .trim()
    .replace(/\/+$/, '');
}

export function linkDias(): number {
  const n = Number(process.env.EXPEDIENTES_LINK_DIAS);
  return Number.isFinite(n) && n > 0 && n <= 60 ? Math.floor(n) : 7;
}

/**
 * Cada cuántos minutos se concilia durante el día (emisiones nuevas → expediente, documentos
 * del OCR). Sin variable = 60. 0 = solo la tarea diaria. Rango 15 a 720.
 */
export function conciliacionCadaMin(): number {
  const raw = String(
    process.env.EXPEDIENTES_CONCILIACION_CADA_MIN ?? '',
  ).trim();
  if (raw === '') return 60;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return Math.min(720, Math.max(15, Math.floor(n)));
}

/**
 * Timeout de cada llamada Nexus → OCR que lee un documento con IA (/documento y /analizar).
 * El monitor usa el modelo pro primero (gemini-3.1-pro-preview): en GCIA tarda de 13 s a 146 s.
 * Sin variable = 240 s. Rango 30 s a 600 s. Si vence, el documento queda pendiente de análisis
 * (error técnico, se reintenta) y nunca validado.
 */
export function ocrTimeoutMs(): number {
  const raw = String(process.env.EXPEDIENTES_OCR_TIMEOUT_MS ?? '').trim();
  const n = Number(raw);
  if (raw === '' || !Number.isFinite(n) || n <= 0) return 240_000;
  return Math.min(600_000, Math.max(30_000, Math.floor(n)));
}

export function ocrInternalConfig(): { url: string; key: string } | null {
  const url = String(process.env.OCR_INTERNAL_URL ?? '')
    .trim()
    .replace(/\/+$/, '');
  const key = String(process.env.EXPEDIENTE_INTERNAL_KEY ?? '').trim();
  if (!url || !key) return null;
  return { url, key };
}

export function nestMailConfig(): { url: string; apiKey: string } {
  return {
    url: (process.env.NEST_API_URL || 'http://127.0.0.1:3002').replace(
      /\/$/,
      '',
    ),
    apiKey: process.env.NEST_API_KEY || process.env.NEST_SERVICE_API_KEY || '',
  };
}

/**
 * «OCR por canal» escribe product_config.ocrOpcional.canales, que decide si el OCR es
 * obligatorio en la emisión. Solo lectura salvo EXPEDIENTES_OCR_CANAL_ESCRITURA=true explícito.
 */
export function ocrCanalEscrituraHabilitada(): boolean {
  return flag('EXPEDIENTES_OCR_CANAL_ESCRITURA');
}

export const MENSAJE_OCR_CANAL_SOLO_LECTURA =
  'La configuración de OCR por canal está en solo lectura en este ambiente. Los cambios se solicitan al equipo de Exélixi.';

// ─── Carga histórica 2026 (pólizas de Sis2000 vía nest-api) ─────────────────

/** Entero de una variable dentro de [min, max]; vacío o inválido = `def`. */
function entero(name: string, def: number, min: number, max: number): number {
  const raw = String(process.env[name] ?? '').trim();
  const n = Number(raw);
  if (raw === '' || !Number.isFinite(n)) return def;
  return Math.min(max, Math.max(min, Math.floor(n)));
}

export interface HistoricoConfig {
  /** Base de nest-api (sin /api/v1...). */
  nestUrl: string;
  nestKey: string;
  /** 'YYYY-MM-DD', inclusivo. */
  desde: string;
  /** 'YYYY-MM-DD', exclusivo; null = corte fijo el día en que arranca la carga. */
  hasta: string | null;
  /** Pólizas por página de nest-api (1-500). */
  limit: number;
  /** Tope de filas de nest-api leídas por corrida. */
  porCorrida: number;
  /** Pausa entre páginas de nest-api (cada página recorre adpoliza). */
  pausaPaginaMs: number;
  /** Pausa entre consultas al OCR. */
  pausaOcrMs: number;
  /** Ventana horaria de Caracas 'HH:MM-HH:MM' (puede cruzar la medianoche). */
  ventana: { inicio: string; fin: string };
  /** Cada cuántos minutos arranca una tanda dentro de la ventana. */
  cadaMin: number;
  /** Errores seguidos (nest-api u OCR) que detienen la corrida. */
  maxErrores: number;
  /** Duración máxima de una corrida. */
  maxMinutos: number;
}

const PATRON_DIA = /^\d{4}-\d{2}-\d{2}$/;
const PATRON_VENTANA = /^([01]\d|2[0-3]):[0-5]\d-([01]\d|2[0-3]):[0-5]\d$/;

/**
 * Carga histórica: APAGADA salvo EXPEDIENTES_ENABLED + EXPEDIENTES_HISTORICO_ENABLED=true con
 * URL, key (scope expedientes:historico) y fecha de inicio válidas. Nunca envía correos.
 */
export function historicoConfig(): HistoricoConfig | null {
  if (!expedientesEnabled() || !flag('EXPEDIENTES_HISTORICO_ENABLED'))
    return null;
  const nestUrl = String(process.env.EXPEDIENTES_HISTORICO_NEST_URL ?? '')
    .trim()
    .replace(/\/+$/, '');
  const nestKey = String(
    process.env.EXPEDIENTES_HISTORICO_NEST_KEY ?? '',
  ).trim();
  const desde = String(process.env.EXPEDIENTES_HISTORICO_DESDE ?? '').trim();
  if (!nestUrl || !nestKey || !PATRON_DIA.test(desde)) return null;
  const hastaRaw = String(process.env.EXPEDIENTES_HISTORICO_HASTA ?? '').trim();
  const ventanaRaw = String(process.env.EXPEDIENTES_HISTORICO_VENTANA ?? '')
    .trim()
    .replace(/\s+/g, '');
  const [inicio, fin] = (
    PATRON_VENTANA.test(ventanaRaw) ? ventanaRaw : '22:00-05:00'
  ).split('-');
  return {
    nestUrl,
    nestKey,
    desde,
    hasta: PATRON_DIA.test(hastaRaw) && hastaRaw > desde ? hastaRaw : null,
    limit: entero('EXPEDIENTES_HISTORICO_LIMIT', 500, 1, 500),
    porCorrida: entero('EXPEDIENTES_HISTORICO_POR_CORRIDA', 2000, 1, 20_000),
    pausaPaginaMs: entero(
      'EXPEDIENTES_HISTORICO_PAUSA_PAGINA_MS',
      60_000,
      0,
      600_000,
    ),
    pausaOcrMs: entero('EXPEDIENTES_HISTORICO_PAUSA_OCR_MS', 250, 0, 10_000),
    ventana: { inicio, fin },
    cadaMin: entero('EXPEDIENTES_HISTORICO_CADA_MIN', 30, 5, 720),
    maxErrores: entero('EXPEDIENTES_HISTORICO_MAX_ERRORES', 3, 1, 20),
    maxMinutos: entero('EXPEDIENTES_HISTORICO_MAX_MINUTOS', 50, 1, 600),
  };
}

/** Motivo por el que la carga histórica no está disponible (para la pantalla/registro). */
export function historicoMotivoApagado(): string | null {
  if (historicoConfig()) return null;
  if (!expedientesEnabled()) return 'EXPEDIENTES_ENABLED apagado';
  if (!flag('EXPEDIENTES_HISTORICO_ENABLED'))
    return 'EXPEDIENTES_HISTORICO_ENABLED apagado';
  return 'Faltan EXPEDIENTES_HISTORICO_NEST_URL, EXPEDIENTES_HISTORICO_NEST_KEY o EXPEDIENTES_HISTORICO_DESDE (YYYY-MM-DD)';
}

// ─── Conciliación de emisiones perdidas (sesión pagada sin póliza en Nexus) ─

export interface PerdidasConfig {
  /** EXPEDIENTES_PERDIDAS_ENABLED=true (apagada por defecto). */
  enabled: boolean;
  /** EXPEDIENTES_PERDIDAS_ESCRIBIR=true; sin ella solo lista (vista previa). */
  escribir: boolean;
  /** Días hacia atrás de sesiones a revisar (1-30, def. 3). */
  dias: number;
  /** Minutos sin actividad de la sesión antes de revisarla (5-1440, def. 20). */
  edadMin: number;
  /** Cada cuántos minutos corre dentro de la ventana (10-720, def. 30). */
  cadaMin: number;
  /** Ventana horaria de Caracas 'HH:MM-HH:MM' (def. 07:00-20:00). */
  ventana: { inicio: string; fin: string };
  /** Tope de sesiones por corrida (1-1000, def. 200). */
  max: number;
}

export function perdidasConfig(): PerdidasConfig {
  const raw = String(process.env.EXPEDIENTES_PERDIDAS_VENTANA ?? '').trim();
  const m = /^([01]\d|2[0-3]):[0-5]\d-([01]\d|2[0-3]):[0-5]\d$/.exec(raw);
  const [inicio, fin] = (m ? raw : '07:00-20:00').split('-');
  return {
    enabled: expedientesEnabled() && flag('EXPEDIENTES_PERDIDAS_ENABLED'),
    escribir: flag('EXPEDIENTES_PERDIDAS_ESCRIBIR'),
    dias: entero('EXPEDIENTES_PERDIDAS_DIAS', 3, 1, 30),
    edadMin: entero('EXPEDIENTES_PERDIDAS_EDAD_MIN', 20, 5, 1440),
    cadaMin: entero('EXPEDIENTES_PERDIDAS_CADA_MIN', 30, 10, 720),
    ventana: { inicio, fin },
    max: entero('EXPEDIENTES_PERDIDAS_MAX', 200, 1, 1000),
  };
}
