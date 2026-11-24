/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, expect, it, vi } from 'vitest';

vi.mock('../../config/prisma', async () => {
  const { createFakePrisma } = await import('./test-utils/fake-prisma');
  return { default: createFakePrisma() };
});
vi.mock('../../utils/logger', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { DEFAULT_CONFIG } from './expedientes.domain';
import { documentosCorreo } from './expedientes.service';

const exp = (id: number, cnpoliza: string) =>
  ({ id, cnpoliza, producto: 'rcv' }) as any;
const req = (expedienteId: number, tipo: string, estado: string, extra = {}) =>
  ({ expedienteId, tipo, estado, ...extra }) as any;

describe('documentosCorreo', () => {
  it('lista cada documento aplicable con su estado visible, sin datos internos', () => {
    const reqs = new Map([
      [
        1,
        [
          req(1, 'cedula', 'validado'),
          req(1, 'licencia', 'observado', {
            decision: 'ia',
            ref: 'r1',
            analisisRef: 'r1',
            motivo: 'Resumen interno: placa AC124KB no coincide',
            diagnostico: {
              resultado: 'no_coincide',
              resumen: 'placa AC124KB',
              campos: [{ campo: 'vencimiento', coincide: false }],
              analizadoEn: '2026-11-07T10:00:00Z',
              proveedor: 'gemini',
              confianza: 1,
            },
          }),
          req(1, 'certificado', 'recibido'),
        ],
      ],
    ]);
    const docs = documentosCorreo([exp(1, 'P-1')], reqs, DEFAULT_CONFIG);
    expect(docs).toEqual([
      { nombre: 'Cédula de identidad', estado: 'aprobado' },
      {
        nombre: 'Licencia de conducir',
        estado: 'corregir',
        motivo: 'La licencia está vencida.',
      },
      { nombre: 'Certificado de circulación', estado: 'en_revision' },
    ]);
    expect(JSON.stringify(docs)).not.toContain('AC124KB');
  });

  it('observación manual: usa el motivo escrito por el administrador', () => {
    const reqs = new Map([
      [
        1,
        [
          req(1, 'cedula', 'observado', {
            decision: 'manual',
            motivo: 'Está cortada.',
          }),
        ],
      ],
    ]);
    const docs = documentosCorreo([exp(1, 'P-1')], reqs, DEFAULT_CONFIG);
    expect(docs[0]).toEqual({
      nombre: 'Cédula de identidad',
      estado: 'corregir',
      motivo: 'Está cortada.',
    });
  });

  it('recién cargado se muestra «recibido»; varias pólizas llevan su número', () => {
    const reqs = new Map([[2, [req(2, 'cedula', 'recibido')]]]);
    const docs = documentosCorreo(
      [exp(1, 'P-1'), exp(2, 'P-2')],
      reqs,
      DEFAULT_CONFIG,
      'cedula',
    );
    expect(docs.filter((d) => d.poliza === 'P-2')[0]).toEqual({
      nombre: 'Cédula de identidad',
      estado: 'recibido',
      poliza: 'P-2',
    });
    expect(
      docs
        .filter((d) => d.poliza === 'P-1')
        .every((d) => d.estado === 'pendiente'),
    ).toBe(true);
  });
});
