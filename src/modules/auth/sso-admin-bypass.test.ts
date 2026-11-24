import { describe, it, expect } from 'vitest';
import {
  adminPuedeSaltarValidacion,
  ADMIN_SSO_BYPASS_ENV,
} from './sso-admin-bypass';

describe('adminPuedeSaltarValidacion (sso-delegate)', () => {
  it('sin la variable de entorno el admin NO salta validaciones', () => {
    expect(adminPuedeSaltarValidacion(1, {})).toBe(false);
    expect(adminPuedeSaltarValidacion(1, { [ADMIN_SSO_BYPASS_ENV]: '' })).toBe(
      false,
    );
    expect(
      adminPuedeSaltarValidacion(1, { [ADMIN_SSO_BYPASS_ENV]: 'false' }),
    ).toBe(false);
    expect(adminPuedeSaltarValidacion(1, { [ADMIN_SSO_BYPASS_ENV]: '1' })).toBe(
      false,
    );
  });

  it('con NEXUS_ALLOW_ADMIN_SSO_BYPASS=true el admin sí salta validaciones', () => {
    expect(
      adminPuedeSaltarValidacion(1, { [ADMIN_SSO_BYPASS_ENV]: 'true' }),
    ).toBe(true);
    expect(
      adminPuedeSaltarValidacion(1, { [ADMIN_SSO_BYPASS_ENV]: ' TRUE ' }),
    ).toBe(true);
  });

  it('usuarios no admin nunca saltan validaciones, aun con la variable', () => {
    expect(
      adminPuedeSaltarValidacion(2, { [ADMIN_SSO_BYPASS_ENV]: 'true' }),
    ).toBe(false);
    expect(
      adminPuedeSaltarValidacion(undefined, {
        [ADMIN_SSO_BYPASS_ENV]: 'true',
      }),
    ).toBe(false);
  });
});
