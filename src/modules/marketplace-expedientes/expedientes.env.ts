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
  return flag('EXPEDIENTES_ACCESO_LIBRE') && expedientesJobsManualPermitido();
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
