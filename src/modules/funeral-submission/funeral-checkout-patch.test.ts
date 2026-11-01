import { describe, expect, it } from 'vitest';
import { buildFuneralCheckoutPatch } from './funeral-checkout-patch';

describe('buildFuneralCheckoutPatch', () => {
  const snapshot = {
    quote: { mprima: 1000, mprimaext: 10, ptasa: 100 },
    selectedPlan: { name: 'Plan test', cplan: '7' },
    metadataCanal: { canal: 'web', cproductor: '80080' },
    funeral: { frecuencia: 'A' },
  };

  it('deja funeralSubmissionId y originSessionId fuera del filtro por empresa', () => {
    const patch = buildFuneralCheckoutPatch(snapshot, {
      submissionId: 'sub-1',
      originSessionId: '792',
      cplan: '7',
      planName: 'Plan test',
    });

    expect(patch.funeralSubmissionId).toBe('sub-1');
    expect(patch.originSessionId).toBe('792');
    expect(patch.product).toBe('funerario');
    const canal = patch.metadataCanal as Record<string, unknown>;
    expect(canal.funeralSubmissionId).toBe('sub-1');
    expect(canal.originSessionId).toBe('792');
    expect(canal.cproductor).toBe('80080');
  });
  it('frecuencia mensual marca fraccionado para que Pagos domicilie', () => {
    const patch = buildFuneralCheckoutPatch(
      { ...snapshot, funeral: { frecuencia: 'M' } },
      { submissionId: 'sub-2', cplan: '7' },
    );
    expect(patch.fraccionado).toBe(true);
    expect(patch.checkoutPayload).toEqual({ ifrecuencia: 'M', fraccionado: true, requireFirstPayment: true });
    expect((patch.checkoutRules as Record<string, unknown>).fraccionado).toBe(true);
  });

  it('frecuencia anual no es fraccionado', () => {
    const patch = buildFuneralCheckoutPatch(snapshot, { submissionId: 'sub-3', cplan: '7' });
    expect(patch.fraccionado).toBe(false);
    expect((patch.checkoutPayload as Record<string, unknown>).ifrecuencia).toBe('A');
  });

  it('frecuencia anual cobra la prima anual completa (sin cambios)', () => {
    const patch = buildFuneralCheckoutPatch(snapshot, { submissionId: 'sub-4', cplan: '7' });
    const checkout = patch.checkout as Record<string, unknown>;
    expect(checkout.totalVes).toBe(1000);
    expect(checkout.totalUsd).toBe(10);
    expect(checkout.exchangeRate).toBe(100);
    expect(checkout.subtitle).toBe('Seguro funerario · pago en línea');
  });

  it.each([
    ['M', 12, 1, 100],
    ['T', 4, 3, 300],
    ['S', 2, 6, 600],
  ])(
    'frecuencia %s cobra la 1ª de %i cuotas (no la prima anual)',
    (frecuencia, cuotas, cuotaUsd, cuotaVes) => {
      const patch = buildFuneralCheckoutPatch(
        { ...snapshot, quote: { mprima: 1200, mprimaext: 12, ptasa: 100 }, funeral: { frecuencia } },
        { submissionId: 'sub-5', cplan: '7' },
      );
      const checkout = patch.checkout as Record<string, unknown>;
      expect(patch.fraccionado).toBe(true);
      expect(checkout.totalUsd).toBe(cuotaUsd);
      expect(checkout.totalVes).toBe(cuotaVes);
      expect(checkout.subtitle).toBe(`Seguro funerario · 1ª de ${cuotas} cuotas`);
    },
  );

  it('mensual aplica paridad Sis2000 ROUND((ROUND(mprimaext,2)/cuotas)*ptasa,2)', () => {
    const patch = buildFuneralCheckoutPatch(
      { ...snapshot, quote: { mprima: 4567.89, mprimaext: 123.456, ptasa: 36.99 }, funeral: { frecuencia: 'M' } },
      { submissionId: 'sub-6', cplan: '7' },
    );
    const checkout = patch.checkout as Record<string, unknown>;
    // round2(123.456)=123.46 → /12 = 10.288333… → ×36.99 = 380.5654… → 380.57
    expect(checkout.totalVes).toBe(380.57);
    expect(checkout.totalUsd).toBe(10.29);
  });

  it('mensual sin mprimaext ni ptasa divide la prima entre las cuotas (mprimaext cae a mprima)', () => {
    const patch = buildFuneralCheckoutPatch(
      { ...snapshot, quote: { mprima: 1200 }, funeral: { frecuencia: 'M' } },
      { submissionId: 'sub-7', cplan: '7' },
    );
    const checkout = patch.checkout as Record<string, unknown>;
    expect(checkout.totalVes).toBe(100);
    expect(checkout.totalUsd).toBe(100);
    expect(checkout.exchangeRate).toBe(1);
  });
});

