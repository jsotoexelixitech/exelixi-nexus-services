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
});

