/**
 * Construye patch de checkout Pagos desde snapshot de solicitud funerario.
 */
export function buildFuneralCheckoutPatch(
  snapshot: Record<string, unknown>,
  opts: {
    planName?: string;
    cplan: string;
    submissionId: string;
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
    metadataCanal: snapshot.metadataCanal,
    funeralSubmissionId: opts.submissionId,
    funeralApprovedCheckout: true,
    checkoutRules: {
      requirePayment: true,
      lockFields: true,
      hideNavigation: true,
      onSuccess: { mode: 'emit' },
    },
    checkout: {
      title: `Póliza funerario — ${planLabel}`,
      subtitle: 'Pago autorizado tras revisión técnica',
      totalVes,
      totalUsd: mprimaext > 0 ? mprimaext : undefined,
      exchangeRate: ptasa,
    },
    ...(opts.paymentExpiresAt
      ? { funeralPaymentExpiresAt: opts.paymentExpiresAt.toISOString() }
      : {}),
  };
}
