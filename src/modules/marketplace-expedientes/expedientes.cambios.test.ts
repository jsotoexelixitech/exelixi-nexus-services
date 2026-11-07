/* eslint-disable @typescript-eslint/no-explicit-any */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../config/prisma', async () => {
  const { createFakePrisma } = await import('./test-utils/fake-prisma');
  return { default: createFakePrisma() };
});
vi.mock('../../utils/logger', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import prisma from '../../config/prisma';
import { expedientesService as svc } from './expedientes.service';
import { compararSnapshot, revisarCambios } from './expedientes.cambios';

const db = prisma as any;

beforeEach(() => {
  db.$reset();
  process.env.EXPEDIENTES_ENABLED = 'true';
});

describe('fase 2: monitor de cambios (preparado, sin Sis2000)', () => {
  it('compara solo campos presentes en ambos lados', () => {
    const cambios = compararSnapshot(
      {
        vehiculo: { placa: 'AB123CD' },
        plan: 'Plan A',
        tomador: { nombre: 'Ana' },
      },
      { vehiculo: { placa: 'ab-123-cd' }, plan: 'Plan B', tomador: null },
    );
    expect(cambios).toEqual([
      { campo: 'plan', anterior: 'Plan A', nuevo: 'Plan B' },
    ]);
  });

  it('el proveedor por defecto no hace nada; uno real marca cambios', async () => {
    const r = await svc.registrarDesdeEmision(
      {
        id: 1,
        empresaId: 7,
        polizaNumero: 'P-1',
        jsonData: { producto: 'rcv' },
      },
      { expediente: { centidad: 'C', snapshot: { plan: 'Plan A' } } },
    );
    expect(await revisarCambios()).toMatchObject({
      conCambios: 0,
      sinDatos: 1,
    });
    const res = await revisarCambios({
      fetchPolicyCurrentData: async () => ({ plan: 'Plan B' }),
    });
    expect(res.conCambios).toBe(1);
    expect(db.mktExpediente._rows()[0].cambiosDetectados).toBe(true);
    const det = await svc.detalle(r!.id);
    expect(det.cambios).toMatchObject([
      { campo: 'plan', anterior: 'Plan A', nuevo: 'Plan B' },
    ]);
  });
});
