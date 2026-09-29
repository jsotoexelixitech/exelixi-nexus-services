/**
 * Construye patch de checkout Pagos desde snapshot de solicitud funerario.
 */
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
  const totalVes = mprima > 0 ? mprima : mprimaext * ptasa;

  if (!Number.isFinite(totalVes) || totalVes <= 0) {
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
  const fraccionado = ['M', 'T', 'S'].includes(ifrecuencia);

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
      subtitle: 'Seguro funerario · pago en línea',
      totalVes,
      totalUsd: mprimaext > 0 ? mprimaext : undefined,
      exchangeRate: ptasa,
    },
    ...(opts.paymentExpiresAt
      ? { funeralPaymentExpiresAt: opts.paymentExpiresAt.toISOString() }
      : {}),
  };
}
