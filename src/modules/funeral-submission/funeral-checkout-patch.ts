/**
 * Construye patch de checkout Pagos desde snapshot de solicitud funerario.
 *
 * Frecuencias M/T/S: el monto a cobrar es la 1ª cuota (prima anual ÷ cuotas, paridad Sis2000
 * ROUND((ROUND(mprimaext,2)/cuotas)×ptasa,2)); Pagos cobra esa cuota y domicilia el resto.
 * Misma fórmula que Emisión (server/src/lib/funeralCheckoutPatch.js).
 */

export const CUOTAS_POR_FRECUENCIA: Record<string, number> = { M: 12, T: 4, S: 2 };

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

export function buildFuneralCheckoutPatch(
  snapshot: Record<string, unknown>,
  opts: {
    planName?: string;
    cplan: string;
    submissionId: string;
    /** SID OCR original (distinto del SID de checkout). */
    originSessionId?: string;
    paymentExpiresAt?: Date;
  },
): Record<string, unknown> {
  const quote = (snapshot.quote ?? {}) as Record<string, unknown>;
  const mprimaext = Number(quote.mprimaext ?? quote.mprima ?? 0);
  const ptasa = Number(quote.ptasa ?? 1) || 1;
  const mprima = Number(quote.mprima ?? mprimaext * ptasa);
  const annualVes = mprima > 0 ? mprima : mprimaext * ptasa;

  if (!Number.isFinite(annualVes) || annualVes <= 0) {
    throw new Error(
      'La cotización del snapshot no tiene prima válida para el checkout.',
    );
  }

  const planLabel =
    opts.planName ||
    String(
      (snapshot.selectedPlan as Record<string, unknown>)?.name ?? '',
    ).trim() ||
    `Plan ${opts.cplan}`;

  // Frecuencia elegida en emisión: M/T/S = fraccionado → Pagos cobra 1ª cuota y domicilia (como RCV).
  const funeral = (snapshot.funeral ?? {}) as Record<string, unknown>;
  const ifrecuencia = String(funeral.frecuencia ?? 'A').trim().toUpperCase().charAt(0) || 'A';
  const cuotas = CUOTAS_POR_FRECUENCIA[ifrecuencia] || 1;
  const fraccionado = cuotas > 1;

  // Fraccionado: Pagos cobra el monto del checkout tal cual como 1ª cuota → enviar la cuota, no la prima anual.
  let totalVes = annualVes;
  let totalUsd = mprimaext > 0 ? mprimaext : undefined;
  if (fraccionado && mprimaext > 0) {
    const cuotaUsd = round2(mprimaext) / cuotas;
    totalVes = round2(cuotaUsd * ptasa);
    totalUsd = round2(cuotaUsd);
  } else if (fraccionado) {
    totalVes = round2(annualVes / cuotas);
  }
  if (!Number.isFinite(totalVes) || totalVes <= 0) {
    throw new Error(
      'La cotización del snapshot no tiene prima válida para el checkout.',
    );
  }

  const prevCanal =
    snapshot.metadataCanal && typeof snapshot.metadataCanal === 'object'
      ? (snapshot.metadataCanal as Record<string, unknown>)
      : {};

  return {
    product: 'funerario',
    tomador: snapshot.tomador,
    asegurado: snapshot.asegurado,
    sameInsured: snapshot.sameInsured,
    hasBeneficiary: snapshot.hasBeneficiary,
    beneficiario: snapshot.beneficiario,
    funeral: snapshot.funeral,
    selectedPlan: snapshot.selectedPlan,
    quote: snapshot.quote,
    quoteState: 'ready',
    metadataCanal: {
      ...prevCanal,
      funeralSubmissionId: opts.submissionId,
      ...(opts.originSessionId
        ? { originSessionId: opts.originSessionId }
        : {}),
    },
    funeralSubmissionId: opts.submissionId,
    originSessionId: opts.originSessionId,
    funeralApprovedCheckout: true,
    fraccionado,
    checkoutPayload: { ifrecuencia, fraccionado, requireFirstPayment: fraccionado },
    checkoutRules: {
      requirePayment: true,
      lockFields: true,
      hideNavigation: true,
      onSuccess: { mode: 'emit' },
      fraccionado,
    },
    checkout: {
      title: planLabel,
      subtitle: fraccionado
        ? `Seguro funerario · 1ª de ${cuotas} cuotas`
        : 'Seguro funerario · pago en línea',
      totalVes,
      totalUsd,
      exchangeRate: ptasa,
    },
    ...(opts.paymentExpiresAt
      ? { funeralPaymentExpiresAt: opts.paymentExpiresAt.toISOString() }
      : {}),
  };
}
