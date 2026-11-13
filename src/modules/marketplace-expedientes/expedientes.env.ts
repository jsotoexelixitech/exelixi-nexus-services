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
