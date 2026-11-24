/**
 * Revisión de punta a punta (24-nov-2026): para el mismo filtro (alcance) y la misma fecha de
 * emisión, la bandeja, los indicadores, el Excel del control diario («día anterior») y el correo del
 * reporte diario deben dar la MISMA cifra de completas, incompletas y sin información. Las
 * descartadas y lo que está fuera del alcance nunca cuentan en ninguna. También el acumulado.
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
import { _resetCatalogoCanales } from './expedientes.canales';
import { filasDiaAnterior, filasResumen } from './expedientes.excel';
import { lineaDiaAnterior } from './expedientes.mail';
import { armarReporteSimple } from './expedientes.reporte';
import { expedientesService as svc } from './expedientes.service';

const db = prisma as any;
const DIA = '2026-11-22';
/** 23-nov-2026 09:00 Caracas: corte del Excel (día anterior = 22-nov). */
const CORTE_EXCEL = new Date('2026-11-23T13:00:00.000Z');

type Actor = 'canal' | 'gestor' | 'productor' | 'sin';

async function crear(
  poliza: string,
  emitida: string,
  estado: string,
  actor: Actor = 'canal',
) {
  const quien =
    actor === 'productor'
      ? { centidad: 'P', cproductor: '777' }
      : actor === 'gestor'
        ? { centidad: 'G', cgestor: '749', ccanalalt: '900' }
        : actor === 'canal'
          ? { centidad: 'C', ccanalalt: '900' }
          : {};
  const r = await svc.registrarDesdeEmision(
    {
      id: Number(poliza.replace(/\D/g, '')) || 1,
      empresaId: 7,
      polizaNumero: poliza,
      jsonData: { producto: 'rcv' },
      createdAt: new Date(emitida),
    },
    {
      expediente: {
        ...quien,
        producto: 'rcv',
        documentosEnWizard: true,
        asegurado: {
          tipoDoc: 'V',
          documento: String(10_000_000 + Number(poliza.replace(/\D/g, ''))),
          nombre: 'Luis',
          email: 'luis@test.com',
        },
      },
    },
  );
  const fila = db.mktExpediente._rows().find((e: any) => e.id === r!.id);
  fila.estadoDocumental = estado;
  return fila;
}

/** Las cuatro salidas para lo emitido el 22-nov (Caracas). */
async function cuatroSalidas() {
  const config = await svc.getConfig();
  const filtro = { desde: DIA, hasta: DIA };
  const bandeja = async (estadoDoc: string) =>
    (await svc.listar({ ...filtro, estadoDoc, pageSize: 200 } as any)).total;
  const ind = await svc.indicadores(filtro);
  // El control diario (correo + Excel) de Canales cubre todo el alcance.
  const reporte = await armarReporteSimple('canales', {
    config,
    fecha: '2026-11-23',
    ahora: CORTE_EXCEL,
    exclusiones: [],
  });
  // Excel: las filas de la hoja Resumen tal como se escriben.
  const filas = new Map(
    filasDiaAnterior(reporte.cifras).map(([k, v]) => [k, v]),
  );
  const excel = {
    completas: filas.get('· Completas'),
    incompletas: filas.get('· Incompletas'),
    sinInformacion: filas.get('· Sin información'),
  };
  // Correo: la línea del día anterior tal como se envía.
  const linea = lineaDiaAnterior(reporte.cifras.diaAnterior!);
  const n = (re: RegExp) => Number(re.exec(linea)?.[1] ?? 0);
  const diario = {
    completas: n(/(\d+) completas/),
    incompletas: n(/(\d+) incompletas/),
    sinInformacion: n(/(\d+) sin información/),
  };
  // Acumulado (sin filtro de fecha): Excel frente a indicadores y bandeja.
  const indTodo = await svc.indicadores({});
  const resumen = new Map(filasResumen(reporte.cifras).map(([k, v]) => [k, v]));
  const total = async (estadoDoc: string) =>
    (await svc.listar({ estadoDoc, pageSize: 200 } as any)).total;
  const acumulado = {
    bandeja: {
      completas: await total('completo'),
      incompletas: await total('incompleto'),
      sinInformacion: await total('sin_informacion'),
    },
    indicadores: {
      completas: indTodo.completos,
      incompletas: indTodo.incompletos,
      sinInformacion: indTodo.sinInformacion,
    },
    excel: {
      completas: resumen.get('Completados'),
      incompletas: reporte.cifras.incompletos,
      sinInformacion: reporte.nota?.sinInformacion,
    },
  };
  return {
    acumulado,
    bandeja: {
      completas: await bandeja('completo'),
      incompletas: await bandeja('incompleto'),
      sinInformacion: await bandeja('sin_informacion'),
    },
    indicadores: {
      completas: ind.completos,
      incompletas: ind.incompletos,
      sinInformacion: ind.sinInformacion,
    },
    excel: {
      completas: excel.completas,
      incompletas: excel.incompletas,
      sinInformacion: excel.sinInformacion,
    },
    diario,
  };
}

async function sembrar() {
  // 22-nov Caracas (bordes 00:00 y 23:59) en cada estado y con cada tipo de emisor.
  await crear('P-1', '2026-11-22T04:00:00.000Z', 'completo', 'canal');
  await crear('P-2', '2026-11-23T03:59:00.000Z', 'incompleto', 'canal');
  await crear('P-3', '2026-11-22T15:00:00.000Z', 'incompleto', 'gestor');
  await crear('P-4', '2026-11-22T16:00:00.000Z', 'sin_informacion', 'canal');
  await crear('P-5', '2026-11-22T16:30:00.000Z', 'sin_informacion', 'gestor');
  await crear('P-6', '2026-11-22T17:00:00.000Z', 'descartada', 'canal');
  await crear('P-7', '2026-11-22T18:00:00.000Z', 'incompleto', 'productor');
  await crear(
    'P-8',
    '2026-11-22T18:30:00.000Z',
    'sin_informacion',
    'productor',
  );
  await crear('P-9', '2026-11-22T19:00:00.000Z', 'completo', 'productor');
  await crear('P-10', '2026-11-22T20:00:00.000Z', 'incompleto', 'sin');
  await crear('P-11', '2026-11-22T20:30:00.000Z', 'sin_informacion', 'sin');
  // Fuera de la fecha: antevíspera y día siguiente.
  await crear('P-12', '2026-11-22T03:59:00.000Z', 'incompleto', 'canal');
  await crear('P-13', '2026-11-23T04:00:00.000Z', 'sin_informacion', 'canal');
}

describe('cuadre de salidas: misma cifra en bandeja, indicadores, Excel y reporte diario', () => {
  beforeEach(() => {
    db.$reset();
    process.env.EXPEDIENTES_ENABLED = 'true';
    delete process.env.EXPEDIENTES_JOBS_ENABLED;
    delete process.env.OCR_INTERNAL_URL;
    _resetCatalogoCanales({
      nombres: new Map([['900', 'Farmatodo']]),
      gestorCanal: new Map([['749', '900']]),
      canales: [],
    });
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(JSON.stringify({ status: true, data: {} }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          }),
      ),
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('alcance por defecto', async () => {
    await sembrar();
    const s = await cuatroSalidas();
    expect(s.indicadores).toEqual(s.bandeja);
    expect(s.excel).toEqual(s.bandeja);
    expect(s.diario).toEqual(s.bandeja);
    expect(s.acumulado.indicadores).toEqual(s.acumulado.bandeja);
    expect(s.acumulado.excel).toEqual(s.acumulado.bandeja);
    // Hay datos de verdad (no es 0 = 0).
    expect(s.bandeja.incompletas).toBeGreaterThan(0);
    expect(s.bandeja.sinInformacion).toBeGreaterThan(0);
  });

  it('alcance con canales, productores y sin canal identificado', async () => {
    await svc.updateConfig(
      {
        alcance: { canales: true, productores: true, desconocida: true },
        motivo: 'prueba de cuadre',
      } as any,
      'portal:1',
    );
    await sembrar();
    const s = await cuatroSalidas();
    expect(s.indicadores).toEqual(s.bandeja);
    expect(s.excel).toEqual(s.bandeja);
    expect(s.diario).toEqual(s.bandeja);
    expect(s.acumulado.indicadores).toEqual(s.acumulado.bandeja);
    expect(s.acumulado.excel).toEqual(s.acumulado.bandeja);
    expect(s.bandeja).toEqual({
      completas: 2,
      incompletas: 4,
      sinInformacion: 4,
    });
  });
});
