import { afterEach, describe, expect, it } from 'vitest';
import { expedientesAccesoLibre } from './expedientes.env';

const VARS = [
  'EXPEDIENTES_ACCESO_LIBRE',
  'EXPEDIENTES_ACCESO_LIBRE_PRODUCCION',
  'EXPEDIENTES_ENTORNO',
] as const;

describe('acceso libre en producción (EXPEDIENTES_ACCESO_LIBRE_PRODUCCION)', () => {
  afterEach(() => {
    for (const v of VARS) delete process.env[v];
  });

  it('en producción sigue cerrado sin la variable explícita', () => {
    process.env.EXPEDIENTES_ENTORNO = 'produccion';
    process.env.EXPEDIENTES_ACCESO_LIBRE = 'true';
    expect(expedientesAccesoLibre()).toBe(false);
  });

  it('en producción abre solo con ambas variables', () => {
    process.env.EXPEDIENTES_ENTORNO = 'produccion';
    process.env.EXPEDIENTES_ACCESO_LIBRE = 'true';
    process.env.EXPEDIENTES_ACCESO_LIBRE_PRODUCCION = 'true';
    expect(expedientesAccesoLibre()).toBe(true);
    delete process.env.EXPEDIENTES_ACCESO_LIBRE;
    expect(expedientesAccesoLibre()).toBe(false);
  });
});
