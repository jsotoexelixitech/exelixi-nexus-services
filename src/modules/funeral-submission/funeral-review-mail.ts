/**
 * Alerta a autorizadores funerario (solicitud referida). No usar en RCV.
 */
import logger from '../../utils/logger';

function nestBaseUrl(): string {
  return (process.env.NEST_API_URL || 'http://127.0.0.1:3002').replace(
    /\/$/,
    '',
  );
}

function nestApiKey(): string {
  return process.env.NEST_API_KEY || process.env.NEST_SERVICE_API_KEY || '';
}

export async function sendFuneralReviewAlertEmail(params: {
  to: string;
  tomadorNombre?: string;
  planName?: string;
  scoreTotal?: string;
}): Promise<{ sent: boolean; error?: string }> {
  const apiKey = nestApiKey();
  if (!apiKey) {
    return { sent: false, error: 'NEST_API_KEY no configurada en nexus-api' };
  }
  const url = `${nestBaseUrl()}/api/v1/mail/funeral-review-alert`;
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        apikey: apiKey,
      },
      body: JSON.stringify({
        to: params.to,
        tomadorNombre: params.tomadorNombre,
        planName: params.planName,
        scoreTotal: params.scoreTotal,
      }),
      signal: AbortSignal.timeout(20000),
    });
    const body = (await res.json().catch(() => ({}))) as {
      sent?: boolean;
      error?: string;
      message?: string;
    };
    if (!res.ok || !body.sent) {
      const err = body.error || body.message || `HTTP ${res.status}`;
      logger.warn(`[funeral-review-mail] fallo a ${params.to}: ${err}`);
      return { sent: false, error: err };
    }
    return { sent: true };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error(`[funeral-review-mail] ${msg}`);
    return { sent: false, error: msg };
  }
}
