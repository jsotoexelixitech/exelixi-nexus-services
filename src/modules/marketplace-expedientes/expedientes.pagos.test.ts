/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * Sincronización del estado de pago con Sis2000: cobrado, pendiente, anulado, no encontrado,
 * póliza distinta, vista previa sin escribir, nunca regresa a pendiente, error de red, sin correos.
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
import {
  _resetPagos,
  _setDormirPagos,
  claveTandaPagos,
  ejecutarSincronizacionPagos,
  pagosConfig,
  tickPagos,
  urlRecibosEstado,
  vistaPagos,
} from './expedientes.pagos';
import { ExpedientesService } from './expedientes.service';

const db = prisma as any;
const empresaId = 7;

function exp(
  id: number,
  cnpoliza: string,
  cnrecibo: string | null,
  extra: Record<string, unknown> = {},
) {
  return db.mktExpediente.create({
    data: {
      id,
      empresaId,
      cnpoliza,
      cnrecibo,
      producto: 'rcv',
      estadoPago: 'pendiente',
      emitidaEn: new Date(),
      ...extra,
    },
  });
}

function nest(items: Record<string, unknown>[]) {
  return vi.fn().mockResolvedValue({
    ok: true,
    status: 200,
    json: async () => ({ status: true, data: items }),
  });
}

const sis = (
  cnrecibo: string,
  cnpoliza: string,
  iestadorec: string,
  fcobro: string | null = null,
) => ({ cnrecibo, cnpoliza, iestadorec, fcobro });

const estadoPago = (id: number) =>
  db.mktExpediente._rows().find((r: any) => r.id === id).estadoPago;

beforeEach(() => {
  db.$reset();
  _resetPagos();
  _setDormirPagos(async () => undefined);
  process.env.EXPEDIENTES_ENABLED = 'true';
  process.env.EXPEDIENTES_JOBS_ENABLED = 'true';
  process.env.EXPEDIENTES_PAGOS_ENABLED = 'true';
  process.env.EXPEDIENTES_PAGOS_NEST_URL = 'http://nest.local/';
  process.env.EXPEDIENTES_PAGOS_NEST_KEY = 'k-pagos';
});

afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.EXPEDIENTES_PAGOS_ENABLED;
  delete process.env.EXPEDIENTES_PAGOS_NEST_URL;
  delete process.env.EXPEDIENTES_PAGOS_NEST_KEY;
  delete process.env.EXPEDIENTES_PAGOS_CADA_MIN;
});

describe('configuración', () => {
  it('apagada sin flag, URL o key; por defecto cada 60 minutos', () => {
    expect(pagosConfig()?.cadaMin).toBe(60);
    expect(urlRecibosEstado('http://nest.local/api/')).toBe(
      'http://nest.local/api/v1/canal/recibos-estado',
    );
    delete process.env.EXPEDIENTES_PAGOS_ENABLED;
    expect(pagosConfig()).toBeNull();
    process.env.EXPEDIENTES_PAGOS_ENABLED = 'true';
    delete process.env.EXPEDIENTES_PAGOS_NEST_KEY;
    expect(pagosConfig()).toBeNull();
  });
});

describe('sincronización de pagos', () => {
  it('cobrado → pagada con evento Sis2000 y fecha de cobro', async () => {
    await exp(1, '5-1-1000000969', '5-1100385748');
    const f = nest([sis('5-1100385748', '5-1-1000000969', 'C', '2026-11-13')]);
    vi.stubGlobal('fetch', f);
    const r: any = await ejecutarSincronizacionPagos({ vistaPrevia: false });
    expect(r.cobrados).toBe(1);
    expect(r.actualizados).toBe(1);
    expect(estadoPago(1)).toBe('pagada');
    const ev = db.mktExpedienteEvento._rows();
    expect(ev).toHaveLength(1);
    expect(ev[0].tipo).toBe('estado_pago_sis2000');
    expect(ev[0].detalle).toMatchObject({
      origen: 'Sis2000',
      fcobro: '2026-11-13',
    });
    const [url, init] = f.mock.calls[0];
    expect(url).toBe('http://nest.local/api/v1/canal/recibos-estado');
    expect(init.method).toBe('POST');
    expect(init.headers.apikey).toBe('k-pagos');
    expect(JSON.parse(init.body)).toEqual({ recibos: ['5-1100385748'] });
  });

  it('pendiente (P) sin cambio', async () => {
    await exp(1, 'A-1', 'R1');
    vi.stubGlobal('fetch', nest([sis('R1', 'A-1', 'P')]));
    const r: any = await ejecutarSincronizacionPagos({ vistaPrevia: false });
    expect(r.pendientes).toBe(1);
    expect(estadoPago(1)).toBe('pendiente');
    expect(db.mktExpedienteEvento._rows()).toHaveLength(0);
  });

  it('anulado (A) y no encontrado: sin cambio y contados aparte', async () => {
    await exp(1, 'A-1', 'R1');
    await exp(2, 'A-2', 'R2');
    vi.stubGlobal('fetch', nest([sis('R1', 'A-1', 'A')]));
    const r: any = await ejecutarSincronizacionPagos({ vistaPrevia: false });
    expect(r.anulados).toBe(1);
    expect(r.noEncontrados).toBe(1);
    expect(r.actualizados).toBe(0);
    expect(estadoPago(1)).toBe('pendiente');
    expect(estadoPago(2)).toBe('pendiente');
  });

  it('póliza distinta: no marca y lo cuenta; misma póliza con espacios sí', async () => {
    await exp(1, 'A-1', 'R1');
    await exp(2, 'A-2', 'R2');
    vi.stubGlobal(
      'fetch',
      nest([sis('R1', 'OTRA-9', 'C', '2026-11-01'), sis('R2', ' a-2 ', 'C')]),
    );
    const r: any = await ejecutarSincronizacionPagos({ vistaPrevia: false });
    expect(r.polizaDistinta).toBe(1);
    expect(r.actualizados).toBe(1);
    expect(estadoPago(1)).toBe('pendiente');
    expect(estadoPago(2)).toBe('pagada');
  });

  it('vista previa cuenta pero no escribe nada', async () => {
    await exp(1, 'A-1', 'R1');
    vi.stubGlobal('fetch', nest([sis('R1', 'A-1', 'C', '2026-11-13')]));
    const r: any = await ejecutarSincronizacionPagos({ vistaPrevia: true });
    expect(r.vistaPrevia).toBe(true);
    expect(r.cobrados).toBe(1);
    expect(r.actualizados).toBe(0);
    expect(estadoPago(1)).toBe('pendiente');
    expect(db.mktExpedienteEvento._rows()).toHaveLength(0);
    expect(db.mktExpedienteConfig._rows()).toHaveLength(0);
  });

  it('solo toma pendientes con recibo y no descartados', async () => {
    await exp(1, 'A-1', null);
    await exp(2, 'A-2', '');
    await exp(3, 'A-3', 'R3', { estadoDocumental: 'descartada' });
    await exp(4, 'A-4', 'R4', { estadoPago: 'pagada' });
    const f = nest([]);
    vi.stubGlobal('fetch', f);
    await ejecutarSincronizacionPagos({ vistaPrevia: false });
    expect(f).not.toHaveBeenCalled();
  });

  it('lotes de 200 en orden por id con pausa entre lotes', async () => {
    for (let i = 1; i <= 450; i++) await exp(i, `P-${i}`, `R${i}`);
    const f = nest([]);
    vi.stubGlobal('fetch', f);
    const pausa = vi.fn().mockResolvedValue(undefined);
    _setDormirPagos(pausa);
    const r: any = await ejecutarSincronizacionPagos({ vistaPrevia: true });
    expect(f).toHaveBeenCalledTimes(3);
    const tam = f.mock.calls.map((c: any[]) => JSON.parse(c[1].body).recibos);
    expect(tam.map((t: string[]) => t.length)).toEqual([200, 200, 50]);
    expect(tam[0][0]).toBe('R1');
    expect(tam[1][0]).toBe('R201');
    expect(pausa).toHaveBeenCalledTimes(2);
    expect(r.revisados).toBe(450);
  });

  it('error de red: no cambia nada, lo registra y reintenta en la próxima pasada', async () => {
    await exp(1, 'A-1', 'R1');
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('ECONNRESET')));
    const r: any = await ejecutarSincronizacionPagos({ vistaPrevia: false });
    expect(r.errores).toBe(1);
    expect(estadoPago(1)).toBe('pendiente');
    vi.stubGlobal('fetch', nest([sis('R1', 'A-1', 'C')]));
    const r2: any = await ejecutarSincronizacionPagos({ vistaPrevia: false });
    expect(r2.actualizados).toBe(1);
    expect(estadoPago(1)).toBe('pagada');
  });

  it('HTTP de error de nest-api tampoco cambia nada', async () => {
    await exp(1, 'A-1', 'R1');
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({ ok: false, status: 503, json: async () => ({}) }),
    );
    const r: any = await ejecutarSincronizacionPagos({ vistaPrevia: false });
    expect(r.errores).toBe(1);
    expect(estadoPago(1)).toBe('pendiente');
  });

  it('actualización condicional: si ya no está pendiente no la pisa ni deja evento', async () => {
    await exp(1, 'A-1', 'R1');
    // Entre la lectura y la escritura, otro proceso la deja pagada.
    const f = vi.fn().mockImplementation(async () => {
      db.mktExpediente._rows()[0].estadoPago = 'pagada';
      return {
        ok: true,
        status: 200,
        json: async () => ({ status: true, data: [sis('R1', 'A-1', 'C')] }),
      };
    });
    vi.stubGlobal('fetch', f);
    const r: any = await ejecutarSincronizacionPagos({ vistaPrevia: false });
    expect(r.cobrados).toBe(1);
    expect(r.actualizados).toBe(0);
    expect(db.mktExpedienteEvento._rows()).toHaveLength(0);
  });

  it('apagada: no consulta', async () => {
    delete process.env.EXPEDIENTES_PAGOS_ENABLED;
    const f = nest([]);
    vi.stubGlobal('fetch', f);
    const r: any = await ejecutarSincronizacionPagos({ vistaPrevia: false });
    expect(r.omitido).toBe(true);
    expect(f).not.toHaveBeenCalled();
  });

  it('no toca requisitos ni documentos ni envía correos', async () => {
    await exp(1, 'A-1', 'R1');
    await db.mktExpedienteRequisito.create({
      data: { expedienteId: 1, tipo: 'cedula', estado: 'faltante' },
    });
    vi.stubGlobal('fetch', nest([sis('R1', 'A-1', 'C')]));
    await ejecutarSincronizacionPagos({ vistaPrevia: false });
    const req = db.mktExpedienteRequisito._rows();
    expect(req).toHaveLength(1);
    expect(req[0].estado).toBe('faltante');
    const e = db.mktExpediente._rows()[0];
    expect(e.intentos).toBe(0);
    expect(e.etapaEnviada).toBe(-1);
    expect(e.ultimoEnvio).toBeNull();
  });

  it('vistaPagos devuelve el último resumen guardado', async () => {
    await exp(1, 'A-1', 'R1');
    vi.stubGlobal('fetch', nest([sis('R1', 'A-1', 'C')]));
    await ejecutarSincronizacionPagos({ vistaPrevia: false });
    _resetPagos(); // pierde la memoria: lee el guardado
    const v: any = await vistaPagos();
    expect(v.habilitada).toBe(true);
    expect(v.ultimo.actualizados).toBe(1);
  });
});

describe('programación', () => {
  it('una pasada por bloque de CADA_MIN minutos', async () => {
    const f = nest([]);
    vi.stubGlobal('fetch', f);
    await exp(1, 'A-1', 'R1');
    const t0 = new Date('2026-11-24T14:00:00Z');
    expect(await tickPagos(t0)).not.toBeNull();
    expect(await tickPagos(new Date(t0.getTime() + 5 * 60_000))).toBeNull();
    expect(
      await tickPagos(new Date(t0.getTime() + 61 * 60_000)),
    ).not.toBeNull();
    expect(claveTandaPagos(t0, 60)).not.toBe(
      claveTandaPagos(new Date(t0.getTime() + 61 * 60_000), 60),
    );
  });

  it('sin EXPEDIENTES_JOBS_ENABLED no corre', async () => {
    delete process.env.EXPEDIENTES_JOBS_ENABLED;
    expect(await tickPagos()).toBeNull();
  });
});

describe('Emisión no devuelve una pagada a pendiente', () => {
  it('un aviso posterior con pendiente conserva pagada; pendiente → pagada sí pasa', async () => {
    const svc = new ExpedientesService();
    const emision = {
      id: 1,
      empresaId,
      polizaNumero: 'P-777',
      jsonData: { producto: 'rcv', tomadorIdentificacion: 'V-12345678' },
      createdAt: new Date(),
    };
    const payload = (estadoPago: string) => ({
      expediente: {
        version: 1,
        producto: 'rcv',
        estadoPago,
        asegurado: { tipoDoc: 'V', documento: '12345678', nombre: 'Ana' },
      },
    });
    await svc.registrarDesdeEmision(emision as any, payload('pendiente'));
    expect(estadoPago(db.mktExpediente._rows()[0].id)).toBe('pendiente');
    await svc.registrarDesdeEmision(emision as any, payload('pagada'));
    expect(db.mktExpediente._rows()[0].estadoPago).toBe('pagada');
    await svc.registrarDesdeEmision(emision as any, payload('pendiente'));
    expect(db.mktExpediente._rows()[0].estadoPago).toBe('pagada');
  });
});
