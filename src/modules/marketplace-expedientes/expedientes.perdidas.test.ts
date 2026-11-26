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
  canalEmitePendiente,
  crearBuscadorNest,
  llegoAEmision,
  mapearFilaNest,
  sesionCandidata,
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

describe('sesiones con emisión pendiente del canal (sin pago verificado)', () => {
  // Sesión 7311 (26-nov-2026): RCV, canal 30/subcanal 23, punto Autovial 490, productor 80080.
  // Avanzó a Emisión 16:19:37 y a Pagos 16:19:45 sin pago verificado; póliza emitida 16:19:49 UTC.
  const jd7311 = () =>
    wizard({
      paymentVerified: false,
      vehicle: { placa: 'AK9C34D', serial: '8YZRGV6C9TD000027' },
      metadata: {
        cproductor: '80080',
        ccanalalt: '30',
        cscanalalt: '23',
        allowPendingEmission: 'true',
        tipoEmision: 'emit',
      },
      metadataCanal: undefined,
      _flowMeta: { moduloGroupId: 1, current: 4, history: [1, 2, 3] },
    });
  // Relativos al reloj real: el prisma falso fija updatedAt con Date.now().
  const inicio7311 = inicio; // 16:19:37 del caso real
  const ahora7311 = ahora;
  const p7311 = () =>
    poliza({
      cnpoliza: '18-1-0000147613',
      placa: 'AK9C34D',
      serial: '8YZRGV6C9TD000027',
      cproductor: 80080,
      ccanalalt: 30,
      fingreso: new Date(inicio.getTime() + 12_000).toISOString(), // 16:19:49 (12 s después)
    });

  it('helpers: pendiente del canal y llegó a Emisión', () => {
    expect(canalEmitePendiente(jd7311())).toBe(true);
    expect(canalEmitePendiente(wizard())).toBe(false);
    expect(llegoAEmision(jd7311())).toBe(true);
    expect(llegoAEmision({ _flowMeta: { current: 2, history: [1, 2] } })).toBe(
      false,
    );
    expect(sesionCandidata(wizard({ paymentVerified: false }))).toBe(false);
  });

  it('caso 7311: sin pago verificado pero con emisión pendiente en Emisión -> registra la póliza', async () => {
    await sesion(7311, jd7311(), { createdAt: inicio7311 });
    const buscar = vi.fn().mockResolvedValue([p7311()]);
    const r = await conciliarEmisionesPerdidas({
      ahora: ahora7311,
      buscar,
      escribir: true,
      edadMin: 0,
    });
    expect(buscar).toHaveBeenCalledWith(
      expect.objectContaining({
        placa: 'AK9C34D',
        serial: '8YZRGV6C9TD000027',
      }),
    );
    expect(r.registradas).toBe(1);
    expect(r.detalle[0]).toMatchObject({
      cotizacionId: 7311,
      cnpoliza: '18-1-0000147613',
    });
    expect(
      await db.emision.findFirst({
        where: { polizaNumero: '18-1-0000147613' },
      }),
    ).toBeTruthy();
  });

  it('sin la bandera del canal o sin haber llegado a Emisión no es candidata', async () => {
    await sesion(
      1,
      { ...jd7311(), metadata: { cproductor: '80080', ccanalalt: '30' } },
      { createdAt: inicio7311 },
    );
    await sesion(
      2,
      { ...jd7311(), _flowMeta: { current: 2, history: [1, 2] } },
      { createdAt: inicio7311 },
    );
    const buscar = vi.fn().mockResolvedValue([p7311()]);
    const r = await conciliarEmisionesPerdidas({
      ahora: ahora7311,
      buscar,
      escribir: true,
      edadMin: 0,
    });
    expect(buscar).not.toHaveBeenCalled();
    expect(r.registradas).toBe(0);
  });
});

describe('buscador real de nest-api', () => {
  it('mapea xplaca/xsercar y fingreso de Caracas', () => {
    const p = mapearFilaNest({
      cnpoliza: '18-1-0000147613',
      cnrecibo: '18-1100000001',
      xplaca: 'AK9C34D',
      xsercar: '8YZRGV6C9TD000027',
      cproductor: 80080,
      ccanalalt: 30,
      fingreso: '2026-11-26 12:19:49.000',
    });
    expect(p).toMatchObject({
      placa: 'AK9C34D',
      serial: '8YZRGV6C9TD000027',
      cproductor: '80080',
      ccanalalt: '30',
    });
    expect(new Date(p.fingreso).toISOString()).toBe('2026-11-26T16:19:49.000Z');
  });

  it('llama a poliza-por-vehiculo con la apikey y devuelve las filas mapeadas', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        status: true,
        data: [
          {
            cnpoliza: 'X-1',
            xplaca: 'A1',
            xsercar: 'S1',
            fingreso: '2026-11-26 12:00:00.000',
          },
        ],
      }),
    });
    vi.stubGlobal('fetch', fetchMock);
    try {
      const out = await crearBuscadorNest({
        url: 'http://nest:3002/api/',
        key: 'nest_k',
      })({
        placa: 'A1',
        serial: 'S1',
        desde: new Date('2026-11-26T16:00:00Z'),
      });
      const [url, init] = fetchMock.mock.calls[0];
      expect(String(url)).toMatch(
        /^http:\/\/nest:3002\/api\/v1\/canal\/poliza-por-vehiculo\?/,
      );
      expect(String(url)).toContain('placa=A1');
      expect(init.headers.apikey).toBe('nest_k');
      expect(out[0].cnpoliza).toBe('X-1');
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('con la bandera y la key, la tarea consulta; sin bandera informa no_disponible', async () => {
    await sesion(1);
    process.env.NEST_API_KEY = 'nest_k';
    const sin = await conciliarEmisionesPerdidas({ ahora });
    expect(sin.lookup).toBe('no_disponible');
    process.env.EXPEDIENTES_PERDIDAS_BUSCADOR = 'true';
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ status: true, data: [] }),
    });
    vi.stubGlobal('fetch', fetchMock);
    try {
      const con = await conciliarEmisionesPerdidas({ ahora });
      expect(con.lookup).toBe('ok');
      expect(fetchMock).toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
      delete process.env.NEST_API_KEY;
    }
  });
});
