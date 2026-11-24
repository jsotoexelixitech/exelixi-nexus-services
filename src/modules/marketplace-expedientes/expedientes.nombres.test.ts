/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * Corrección de nombre y apellido desde Sis2000: solo con documento coincidente; vista previa sin
 * escribir; «requiere decisión» si cambiaría el tipo de documento o la clave; sin correos.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../config/prisma', async () => {
  const { createFakePrisma } = await import('./test-utils/fake-prisma');
  return { default: createFakePrisma() };
});
vi.mock('../../utils/logger', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import prisma from '../../config/prisma';
import { corregirNombres } from './expedientes.nombres';

const db = prisma as any;

async function exp(id: number, cnpoliza: string, extra: Record<string, unknown> = {}) {
  await db.mktExpediente.create({
    data: {
      id,
      empresaId: 7,
      cnpoliza,
      producto: 'rcv',
      aseguradoTipoDoc: 'V',
      aseguradoDocumento: '13307292',
      aseguradoNombre: 'Masculino',
      aseguradoApellido: 'RODRIGUEZ PEÑA',
      aseguradoKey: 'V13307292',
      snapshot: {
        asegurado: { tipoDoc: 'V', documento: '13307292', nombre: 'Masculino', apellido: 'RODRIGUEZ PEÑA' },
      },
      emitidaEn: new Date(),
      ...extra,
    },
  });
}

function nest(data: Record<string, unknown>[]) {
  return vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({ status: true, data }) });
}
const fila = (id: number) => db.mktExpediente._rows().find((r: any) => r.id === id);

beforeEach(() => {
  db.$reset();
  process.env.EXPEDIENTES_ENABLED = 'true';
  process.env.EXPEDIENTES_NOMBRES_ENABLED = 'true';
  process.env.EXPEDIENTES_NOMBRES_NEST_URL = 'http://nest.local/';
  process.env.EXPEDIENTES_NOMBRES_NEST_KEY = 'k';
});
afterEach(() => {
  vi.unstubAllGlobals();
  for (const k of ['EXPEDIENTES_NOMBRES_ENABLED', 'EXPEDIENTES_NOMBRES_NEST_URL', 'EXPEDIENTES_NOMBRES_NEST_KEY'])
    delete process.env[k];
});

const SIS = { cci_rif: '13307292', ipersona: 'N', xnombre: 'JUAN CARLOS', xapellido: 'RODRIGUEZ PEÑA' };

describe('corregir nombres desde Sis2000', () => {
  it('apagada: error', async () => {
    delete process.env.EXPEDIENTES_NOMBRES_ENABLED;
    await expect(corregirNombres({ polizas: ['P-1'], vistaPrevia: true })).rejects.toThrow();
  });

  it('vista previa: propone sin escribir', async () => {
    await exp(1, '18-1-0000139376');
    const f = nest([SIS]);
    vi.stubGlobal('fetch', f);
    const r = await corregirNombres({ polizas: ['18-1-0000139376'], vistaPrevia: true });
    expect(r.propuestas[0]).toMatchObject({ estado: 'corregible', aplicado: false });
    expect(r.propuestas[0].sis2000?.nombre).toBe('JUAN CARLOS');
    expect(fila(1).aseguradoNombre).toBe('Masculino');
    expect(db.mktExpedienteEvento._rows()).toHaveLength(0);
    expect(JSON.parse(f.mock.calls[0][1].body)).toEqual({ documentos: ['13307292'] });
  });

  it('aplica: solo nombre y apellido (y el del snapshot con ese documento); documento y clave intactos', async () => {
    await exp(1, '18-1-0000139376');
    vi.stubGlobal('fetch', nest([SIS]));
    const r = await corregirNombres({ polizas: ['18-1-0000139376'], vistaPrevia: false, actor: 'admin' });
    expect(r.aplicados).toBe(1);
    const e = fila(1);
    expect(e.aseguradoNombre).toBe('JUAN CARLOS');
    expect(e.aseguradoDocumento).toBe('13307292');
    expect(e.aseguradoKey).toBe('V13307292');
    expect(e.snapshot.asegurado.nombre).toBe('JUAN CARLOS');
    expect(db.mktExpedienteEvento._rows()[0].tipo).toBe('nombre_corregido');
    expect(db.mktExpedienteNotificacion._rows()).toHaveLength(0);
  });

  it('el tipo de documento no cuadra con Sis2000: requiere decisión y no aplica', async () => {
    await exp(1, '18-1-0000144583', { aseguradoTipoDoc: 'J' });
    vi.stubGlobal('fetch', nest([SIS]));
    const r = await corregirNombres({ polizas: ['18-1-0000144583'], vistaPrevia: false });
    expect(r.propuestas[0].estado).toBe('requiere_decision');
    expect(r.aplicados).toBe(0);
    expect(fila(1).aseguradoNombre).toBe('Masculino');
  });

  it('documento que Sis2000 no devuelve, póliza inexistente y lista inválida', async () => {
    await exp(1, '18-1-0000139376');
    vi.stubGlobal('fetch', nest([]));
    const r = await corregirNombres({ polizas: ['18-1-0000139376', 'X-9'], vistaPrevia: false });
    expect(r.propuestas.map((p) => p.estado)).toEqual(['no_encontrado', 'poliza_no_encontrada']);
    await expect(corregirNombres({ polizas: [], vistaPrevia: true })).rejects.toThrow();
    await expect(
      corregirNombres({ polizas: Array.from({ length: 21 }, (_, i) => `P-${i}`), vistaPrevia: true }),
    ).rejects.toThrow();
    await expect(corregirNombres({ polizas: ["a'; drop"], vistaPrevia: true })).rejects.toThrow();
  });
});
