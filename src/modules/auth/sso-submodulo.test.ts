import { describe, expect, it } from 'vitest';
import { parseSsoSubmoduloId } from './sso-submodulo';

describe('parseSsoSubmoduloId', () => {
  it('ausente → null (comportamiento de siempre)', () => {
    expect(parseSsoSubmoduloId(undefined)).toEqual({ ok: true, submoduloId: null });
    expect(parseSsoSubmoduloId(null)).toEqual({ ok: true, submoduloId: null });
    expect(parseSsoSubmoduloId('')).toEqual({ ok: true, submoduloId: null });
  });
  it('número o texto numérico', () => {
    expect(parseSsoSubmoduloId(17)).toEqual({ ok: true, submoduloId: 17 });
    expect(parseSsoSubmoduloId(' 18 ')).toEqual({ ok: true, submoduloId: 18 });
  });
  it('inválidos', () => {
    for (const v of [0, -1, 1.5, 'abc', {}, []]) {
      expect(parseSsoSubmoduloId(v).ok).toBe(false);
    }
  });
});
