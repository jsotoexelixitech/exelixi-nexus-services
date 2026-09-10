/**
 * Envía correo de link de pago funerario vía nest-api (SMTP).
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

export async function sendFuneralPaymentLinkEmail(params: {
  to: string;
  name?: string;
  planName?: string;
  paymentUrl: string;
  expiresAt?: Date;
}): Promise<{ sent: boolean; error?: string }> {
  const apiKey = nestApiKey();
  if (!apiKey) {
    return { sent: false, error: 'NEST_API_KEY no configurada en nexus-api' };
  }

  const url = `${nestBaseUrl()}/api/v1/mail/funeral-payment-link`;
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
        name: params.name,
        planName: params.planName,
        paymentUrl: params.paymentUrl,
        expiresAt: params.expiresAt?.toISOString(),
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
      logger.warn(`[funeral-mail] fallo envío a ${params.to}: ${err}`);
      return { sent: false, error: err };
    }
    logger.info(`[funeral-mail] link pago enviado a ${params.to}`);
    return { sent: true };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error(`[funeral-mail] error: ${msg}`);
    return { sent: false, error: msg };
  }
}
