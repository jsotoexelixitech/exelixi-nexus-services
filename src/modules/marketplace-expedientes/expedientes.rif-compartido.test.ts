/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * RIF de empresa compartido: el RIF jurídico ya validado en una póliza cubre las otras pólizas de
 * la MISMA empresa tomadora. Nunca una cédula, nunca otra empresa, nunca decisiones manuales;
 * vista previa sin escribir; sin correos.
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
import { DEFAULT_CONFIG } from './expedientes.domain';
import {
  _resetRifCompartido,
  ejecutarRifCompartido,
} from './expedientes.rif-compartido';

const db = prisma as any;

const RIF_LECTURA = {
  documentoTipo: 'rif',
  tipoDoc: 'J',
  rif: 'J500585039',
  identificacion: '500585039',
  nombre: 'SUPERMERCADO RIO VIDA C.A',
};
const CEDULA_LECTURA = {
  documentoTipo: 'cedula',
  tipoDoc: 'V',
  identificacion: '17671805',
  nombre: 'RAMON',
};

const snap = (ident: string) => ({
  tomador: { nombre: 'EMPRESA', identificacion: ident },
  asegurado: {
    tipoDoc: 'V',
    documento: '17671805',
    nombre: 'RAMON',
    apellido: 'P',
  },
});

async function exp(id: number, ident: string, empresaId = 7) {
  await db.mktExpediente.create({
    data: {
      id,
      empresaId,
      cnpoliza: `P-${id}`,
      producto: 'personas',
      snapshot: snap(ident),
      emitidaEn: new Date(),
    },
  });
}
async function cedula(id: number, extra: Record<string, unknown>) {
  return db.mktExpedienteRequisito.create({
    data: { expedienteId: id, tipo: 'cedula', estado: 'faltante', ...extra },
  });
}
const fila = (id: number) =>
  db.mktExpedienteRequisito._rows().find((r: any) => r.expedienteId === id);

const evento = vi.fn();
const recalcular = vi.fn();
const svc: any = {
  getConfig: async () => DEFAULT_CONFIG,
  contextoDe: async () => ({ personas: [] }),
  evento: async (...a: unknown[]) => {
    evento(...a);
  },
  recalcularEstado: async (...a: unknown[]) => {
    recalcular(...a);
    return { estado: 'x', completadoAhora: false };
  },
};

async function escenario() {
  await exp(1, 'J-50058503-9'); // origen
  await cedula(1, {
    estado: 'validado',
    decision: 'ia',
    ref: 'rio/rif.pdf',
    analisisRef: 'rio/rif.pdf',
    archivoHash: 'hrif',
    ocrDatos: RIF_LECTURA,
    diagnostico: { resultado: 'coincide', comparador: 13 },
    validadoEn: new Date('2026-11-20'),
    validadoPor: 'ia',
  });
  await exp(2, 'J-50058503-9');
  await cedula(2, { estado: 'faltante' });
  await exp(3, 'J-500585039');
  await cedula(3, { estado: 'observado', decision: 'ia', ref: 'x/otro.pdf' });
  await exp(4, 'J-50058503-9');
  await cedula(4, {
    estado: 'validado',
    decision: 'ia',
    ref: 'x/4.pdf',
    analisisRef: 'x/4.pdf',
    archivoHash: 'h4',
    diagnostico: {
      resultado: 'coincide',
      archivoCambiado: { detectadoEn: '2026-11-24T00:00:00Z', motivo: 'otro' },
    },
  });
  await exp(5, 'J-50058503-9');
  await cedula(5, { estado: 'observado', decision: 'manual', ref: 'x/5.pdf' });
  await exp(6, 'J-12345678-0'); // otra empresa
  await cedula(6, { estado: 'faltante' });
  await exp(7, 'J-50058503-9', 99); // mismo RIF, otra empresa de Nexus
  await cedula(7, { estado: 'faltante' });
  await exp(8, 'V-17671805'); // tomador natural
  await cedula(8, { estado: 'faltante' });
}

beforeEach(() => {
  db.$reset();
  _resetRifCompartido();
  evento.mockClear();
  recalcular.mockClear();
  delete process.env.OCR_INTERNAL_URL;
  delete process.env.EXPEDIENTE_INTERNAL_KEY;
});
afterEach(() => vi.unstubAllGlobals());

describe('RIF compartido', () => {
  it('vista previa: cuenta y no escribe', async () => {
    await escenario();
    const r: any = await ejecutarRifCompartido(svc, { vistaPrevia: true });
    expect(r.origenes).toBe(1);
    expect(r.porCubrir).toBe(3); // 2 faltante, 3 observado, 4 validado con archivo cambiado
    expect(r.omitidosManuales).toBe(1);
    expect(r.aplicados).toBe(0);
    expect(fila(2).estado).toBe('faltante');
    expect(evento).not.toHaveBeenCalled();
  });

  it('aplica solo a la misma empresa tomadora y deja evento y texto simple', async () => {
    await escenario();
    const r: any = await ejecutarRifCompartido(svc, { vistaPrevia: false });
    expect(r.aplicados).toBe(3);
    for (const id of [2, 3, 4]) {
      const f = fila(id);
      expect(f.estado).toBe('validado');
      expect(f.ref).toBe('rio/rif.pdf');
      expect(f.archivoHash).toBe('hrif');
      expect(f.motivo).toBe('RIF de la empresa, ya validado en la póliza P-1');
      expect(f.validadoPor).toBe('rif_compartido');
      expect(f.diagnostico.archivoCambiado).toBeUndefined();
    }
    // No tocados: manual, otra empresa del RIF, otra empresa de Nexus, tomador natural.
    expect(fila(5).estado).toBe('observado');
    expect(fila(6).estado).toBe('faltante');
    expect(fila(7).estado).toBe('faltante');
    expect(fila(8).estado).toBe('faltante');
    expect(evento).toHaveBeenCalledTimes(3);
    expect(evento.mock.calls[0][1]).toBe('rif_compartido');
    expect(recalcular).toHaveBeenCalledTimes(3);
    expect(db.mktExpedienteNotificacion._rows().length).toBe(0);
  });

  it('una cédula nunca se comparte', async () => {
    await exp(1, 'J-50058503-9');
    await cedula(1, {
      estado: 'validado',
      decision: 'ia',
      ref: 'c.pdf',
      analisisRef: 'c.pdf',
      archivoHash: 'hc',
      ocrDatos: CEDULA_LECTURA,
      diagnostico: { resultado: 'coincide' },
    });
    await exp(2, 'J-50058503-9');
    await cedula(2, { estado: 'faltante' });
    const r: any = await ejecutarRifCompartido(svc, { vistaPrevia: false });
    expect(r.origenes).toBe(0);
    expect(fila(2).estado).toBe('faltante');
  });

  it('origen con el archivo cambiado no cubre a nadie', async () => {
    await escenario();
    const o = fila(1);
    o.diagnostico = {
      ...o.diagnostico,
      archivoCambiado: {
        detectadoEn: '2026-11-24T00:00:00Z',
        motivo: 'no_existe',
      },
    };
    const r: any = await ejecutarRifCompartido(svc, { vistaPrevia: false });
    expect(r.origenes).toBe(0);
    expect(r.origenesConArchivoCambiado).toBe(1);
    expect(fila(2).estado).toBe('faltante');
  });

  it('con OCR configurado, el origen se verifica por huella', async () => {
    await escenario();
    process.env.OCR_INTERNAL_URL = 'http://ocr.local';
    process.env.EXPEDIENTE_INTERNAL_KEY = 'k';
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({
          ok: true,
          resultados: [{ ref: 'rio/rif.pdf', existe: true, hash: 'otra' }],
        }),
      }),
    );
    const r: any = await ejecutarRifCompartido(svc, { vistaPrevia: false });
    expect(r.origenes).toBe(0);
    expect(fila(2).estado).toBe('faltante');
  });
});
