/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * Conciliación de emisiones perdidas: sesión pagada sin póliza en Nexus pero emitida en Sis2000
 * (incidente 26-nov-2026, sesión 7311). Coincidencia estricta, vista previa sin escribir, apagada por
 * defecto, idempotente y sin correos al cliente.
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
  _resetPerdidas,
  claveTandaPerdidas,
  conciliarEmisionesPerdidas,
  datosDeSesion,
  polizaCoincide,
  tandaPerdidasDebida,
  type PolizaVehiculo,
} from './expedientes.perdidas';
import { ejecutarJob } from './expedientes.jobs';

const db = prisma as any;
// El prisma falso fija updatedAt con el reloj real: el «ahora» de la tarea va 1 h adelante.
const t0 = Date.now();
const inicio = new Date(t0 - 10 * 60_000);
const ahora = new Date(t0 + 60 * 60_000);
const tarde = new Date('2026-11-26T20:30:00.000Z'); // 16:30 Caracas

const wizard = (over: Record<string, unknown> = {}) => ({
  product: 'rcv',
  paymentVerified: true,
  vehicle: { placa: 'ab-123 cd', serial: 'SERIAL 123' },
  metadataCanal: { cproductor: '80080', ccanalalt: '27' },
  tomador: { identificacion: '12345678' },
  ...over,
});

function sesion(
  id: number,
  jd: Record<string, unknown> = wizard(),
  extra = {},
) {
  return db.cotizacion.create({
    data: {
      id,
      empresaId: 7,
      estado: 'pagada',
      jsonData: jd,
      createdAt: inicio,
      ...extra,
    },
  });
}

const poliza = (over: Partial<PolizaVehiculo> = {}): PolizaVehiculo => ({
  cnpoliza: '18-1-0000147613',
  cnrecibo: '5-1-9',
  placa: 'AB123CD',
  serial: 'SERIAL123',
  cproductor: '80080',
  ccanalalt: 27,
  fingreso: new Date(inicio.getTime() + 3 * 60_000).toISOString(),
  ...over,
});

beforeEach(() => {
  db.$reset();
  _resetPerdidas();
  process.env.EXPEDIENTES_ENABLED = 'true';
  process.env.EXPEDIENTES_JOBS_ENABLED = 'true';
  process.env.EXPEDIENTES_PERDIDAS_ENABLED = 'true';
  delete process.env.EXPEDIENTES_PERDIDAS_ESCRIBIR;
});

afterEach(() => {
  for (const k of Object.keys(process.env))
    if (k.startsWith('EXPEDIENTES_PERDIDAS_')) delete process.env[k];
});

describe('reglas puras', () => {
  it('datosDeSesion normaliza placa y serial y exige ambos', () => {
    expect(datosDeSesion(wizard())).toEqual({
      placa: 'AB123CD',
      serial: 'SERIAL123',
      cproductor: '80080',
      ccanalalt: '27',
    });
    expect(datosDeSesion(wizard({ vehicle: { placa: 'AB123CD' } }))).toBeNull();
    expect(datosDeSesion({})).toBeNull();
  });

  const s = datosDeSesion(wizard())!;
  it('coincide con placa + serial + productor + canal + ingreso posterior al inicio', () => {
    expect(polizaCoincide(poliza(), s, inicio, ahora)).toBe(true);
  });
  it.each([
    ['otra placa', { placa: 'ZZ999ZZ' }],
    ['otro serial', { serial: 'OTRO' }],
    ['otro productor', { cproductor: '1234' }],
    ['otro canal', { ccanalalt: 99 }],
    [
      'ingreso anterior a la sesión',
      { fingreso: new Date(inicio.getTime() - 3_600_000).toISOString() },
    ],
    ['sin fecha', { fingreso: 'x' }],
  ])('no coincide: %s', (_n, over) => {
    expect(polizaCoincide(poliza(over as any), s, inicio, ahora)).toBe(false);
  });
  it('sin productor en la sesión no coincide (no se adivina)', () => {
    const sinProd = datosDeSesion(wizard({ metadataCanal: {} }))!;
    expect(polizaCoincide(poliza(), sinProd, inicio, ahora)).toBe(false);
  });
});

describe('conciliarEmisionesPerdidas', () => {
  it('sin buscador (endpoint inexistente): informa, no escribe', async () => {
    await sesion(1);
    const r = await conciliarEmisionesPerdidas({ ahora, escribir: true });
    expect(r.lookup).toBe('no_disponible');
    expect(r.registradas).toBe(0);
    expect(db.emision._rows()).toHaveLength(0);
  });

  it('vista previa: lista la póliza pero no escribe nada', async () => {
    await sesion(1);
    const buscar = vi.fn().mockResolvedValue([poliza()]);
    const r = await conciliarEmisionesPerdidas({ ahora, buscar });
    expect(r.modo).toBe('vista_previa');
    expect(r.detalle).toEqual([
      { cotizacionId: 1, cnpoliza: '18-1-0000147613', accion: 'registraria' },
    ]);
    expect(buscar).toHaveBeenCalledWith(
      expect.objectContaining({ placa: 'AB123CD', serial: 'SERIAL123' }),
    );
    expect(db.emision._rows()).toHaveLength(0);
    expect(db.mktExpediente._rows()).toHaveLength(0);
    expect(db.cotizacion._rows()[0].estado).toBe('pagada');
  });

  it('modo escribir: registra emision, enlaza la cotización y crea el expediente sin correos', async () => {
    await sesion(1);
    const buscar = vi.fn().mockResolvedValue([poliza()]);
    const r = await conciliarEmisionesPerdidas({
      ahora,
      buscar,
      escribir: true,
    });
    expect(r.registradas).toBe(1);
    const em = db.emision._rows();
    expect(em).toHaveLength(1);
    expect(em[0]).toMatchObject({
      empresaId: 7,
      cotizacionId: 1,
      polizaNumero: '18-1-0000147613',
    });
    expect(em[0].jsonData).toMatchObject({
      origen: 'conciliacion_perdidas',
      producto: 'rcv',
    });
    const cot = db.cotizacion._rows()[0];
    expect(cot.estado).toBe('emitida');
    expect(cot.jsonData.policy.number).toBe('18-1-0000147613');
    const exps = db.mktExpediente._rows();
    expect(exps).toHaveLength(1);
    expect(exps[0]).toMatchObject({
      cnpoliza: '18-1-0000147613',
      origen: 'conciliacion',
      cadenciaAgotada: true, // sin solicitud inicial ni recordatorios al cliente
      etapaEnviada: -1,
    });
    expect(db.mktExpedienteNotificacion._rows()).toHaveLength(0);
  });

  it('idempotente: una segunda corrida no duplica', async () => {
    await sesion(1);
    const buscar = vi.fn().mockResolvedValue([poliza()]);
    await conciliarEmisionesPerdidas({ ahora, buscar, escribir: true });
    const r2 = await conciliarEmisionesPerdidas({
      ahora,
      buscar,
      escribir: true,
    });
    expect(r2.registradas).toBe(0);
    expect(db.emision._rows()).toHaveLength(1);
    expect(db.mktExpediente._rows()).toHaveLength(1);
  });

  it('póliza ya registrada en emision (otra cotización huella) -> no se duplica', async () => {
    await sesion(1);
    await db.emision.create({
      data: { empresaId: 7, cotizacionId: 99, polizaNumero: '18-1-0000147613' },
    });
    const r = await conciliarEmisionesPerdidas({
      ahora,
      escribir: true,
      buscar: async () => [poliza()],
    });
    expect(r.yaRegistradas).toBe(1);
    expect(r.registradas).toBe(0);
    expect(db.emision._rows()).toHaveLength(1);
  });

  it('póliza ajena (otro productor / vieja / otro serial) -> no registra', async () => {
    await sesion(1);
    for (const over of [
      { cproductor: '1234' },
      { serial: 'X' },
      { fingreso: new Date(inicio.getTime() - 86_400_000).toISOString() },
    ]) {
      const r = await conciliarEmisionesPerdidas({
        ahora,
        escribir: true,
        buscar: async () => [poliza(over as any)],
      });
      expect(r.registradas).toBe(0);
      expect(r.sinPoliza).toBe(1);
    }
    expect(db.emision._rows()).toHaveLength(0);
  });

  it('dos pólizas candidatas para una sesión, o una póliza para dos sesiones -> ambigua', async () => {
    await sesion(1);
    const r1 = await conciliarEmisionesPerdidas({
      ahora,
      escribir: true,
      buscar: async () => [poliza(), poliza({ cnpoliza: '18-1-0000999999' })],
    });
    expect(r1.ambiguas).toBe(1);
    expect(db.emision._rows()).toHaveLength(0);

    await sesion(2);
    const r2 = await conciliarEmisionesPerdidas({
      ahora,
      escribir: true,
      buscar: async () => [poliza()],
    });
    expect(r2.ambiguas).toBe(2);
    expect(db.emision._rows()).toHaveLength(0);
  });

  it('no toca sesiones sin pago, con póliza, con emision, de otro producto o sin datos', async () => {
    await sesion(1, wizard({ paymentVerified: false }));
    await sesion(2, wizard({ policy: { number: '18-1-1' } }));
    await sesion(3);
    await db.emision.create({
      data: { empresaId: 7, cotizacionId: 3, polizaNumero: 'X-3' },
    });
    await sesion(5, wizard({ product: 'funerario' }));
    await sesion(6, wizard({ vehicle: {} }));
    const buscar = vi.fn().mockResolvedValue([poliza()]);
    const r = await conciliarEmisionesPerdidas({
      ahora,
      buscar,
      escribir: true,
    });
    expect(buscar).not.toHaveBeenCalled();
    expect(r.registradas).toBe(0);
    expect(r.otroProducto).toBe(1);
    expect(r.sinDatos).toBe(1);
  });

  it('sesión con actividad reciente (menos de EDAD_MIN) no se toca', async () => {
    await sesion(1);
    const buscar = vi.fn().mockResolvedValue([poliza()]);
    const r = await conciliarEmisionesPerdidas({
      ahora: new Date(t0 + 60_000),
      buscar,
      escribir: true,
    });
    expect(buscar).not.toHaveBeenCalled();
    expect(r.revisadas).toBe(0);
  });

  it('error del buscador: cuenta el error y no escribe', async () => {
    await sesion(1);
    const r = await conciliarEmisionesPerdidas({
      ahora,
      escribir: true,
      buscar: async () => {
        throw new Error('nest caído');
      },
    });
    expect(r.errores).toBe(1);
    expect(db.emision._rows()).toHaveLength(0);
  });
});

describe('scheduler y bandera', () => {
  it('apagada por defecto', () => {
    delete process.env.EXPEDIENTES_PERDIDAS_ENABLED;
    expect(tandaPerdidasDebida(tarde)).toBeNull();
  });

  it('encendida: corre dentro del horario y una vez por bloque; fuera de horario no', () => {
    expect(tandaPerdidasDebida(tarde)).toBe(claveTandaPerdidas(tarde, 30));
    const noche = new Date('2026-11-27T05:00:00.000Z'); // 01:00 Caracas
    expect(tandaPerdidasDebida(noche)).toBeNull();
  });

  it('la tarea queda registrada en mkt_expediente_job_run y respeta la vista previa', async () => {
    await sesion(1);
    const r = await ejecutarJob('conciliacion_perdidas', {
      origen: 'auto',
      ahora,
      clave: 'x-prueba',
    });
    expect(r.omitido).toBe(false);
    expect(db.mktExpedienteJobRun._rows()[0]).toMatchObject({
      job: 'conciliacion_perdidas',
      estado: 'ok',
    });
    expect(db.emision._rows()).toHaveLength(0);
  });
});
