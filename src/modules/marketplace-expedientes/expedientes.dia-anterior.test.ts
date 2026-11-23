/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * Indicador del día anterior en el «Control documental diario» (pedido de La Mundial,
 * 22/23-nov-2026): de las pólizas del alcance emitidas el día calendario de Caracas anterior a la
 * fecha del reporte, cuántas tienen hoy el expediente completo, incompleto o sin información.
 * Rango en hora de Caracas (00:00 Caracas = 04:00 UTC), conteos, hoja «Resumen» y correo.
 */
import ExcelJS from 'exceljs';
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
import { _resetScheduler } from './expedientes.jobs';
import { filasResumen } from './expedientes.excel';
import {
  correoReporteSimple,
  lineaDiaAnterior,
  valorDiaAnterior,
} from './expedientes.mail';
import {
  cifrasControl,
  cifrasDiaAnterior,
  rangoDiaAnterior,
} from './expedientes.reporte';
import { expedientesService as svc } from './expedientes.service';
import { tareaNocturna } from './expedientes.tareas';

const db = prisma as any;

describe('día anterior: rango en hora de Caracas', () => {
  it('[00:00, 24:00) Caracas del día anterior = [04:00Z, 04:00Z del día del reporte)', () => {
    expect(rangoDiaAnterior('2026-11-23')).toEqual({
      fecha: '2026-11-22',
      desde: new Date('2026-11-22T04:00:00.000Z'),
      hasta: new Date('2026-11-23T04:00:00.000Z'),
    });
  });

  it('cruza mes y año', () => {
    expect(rangoDiaAnterior('2026-12-01').fecha).toBe('2026-11-30');
    expect(rangoDiaAnterior('2027-01-01')).toMatchObject({
      fecha: '2026-12-31',
      desde: new Date('2026-12-31T04:00:00.000Z'),
    });
  });
});

describe('día anterior: conteos', () => {
  const rango = rangoDiaAnterior('2026-11-23');
  const fila = (iso: string, estadoDocumental: string) => ({
    emitidaEn: new Date(iso),
    estadoDocumental,
  });

  it('incluye 00:00 y 23:59 Caracas del día anterior; excluye el día del reporte y el previo', () => {
    const d = cifrasDiaAnterior(
      [
        // 22-nov 00:00 Caracas (borde inferior, entra).
        fila('2026-11-22T04:00:00.000Z', 'completo'),
        // 22-nov 23:59 Caracas (entra).
        fila('2026-11-23T03:59:00.000Z', 'incompleto'),
        // 22-nov 23:59:59.999 Caracas (entra).
        fila('2026-11-23T03:59:59.999Z', 'incompleto'),
        // 23-nov 00:00 Caracas: día del reporte (no entra).
        fila('2026-11-23T04:00:00.000Z', 'completo'),
        // 21-nov 23:59 Caracas: antevíspera (no entra).
        fila('2026-11-22T03:59:00.000Z', 'incompleto'),
        // 22-nov 08:00 Caracas (entra).
        fila('2026-11-22T12:00:00.000Z', 'completo'),
        // Descartada del día: nunca cuenta.
        fila('2026-11-22T15:00:00.000Z', 'descartada'),
        // Sin información en la cartera: se ignora (la cuenta el count aparte).
        fila('2026-11-22T16:00:00.000Z', 'sin_informacion'),
      ],
      rango,
      4,
    );
    expect(d).toEqual({
      fecha: '2026-11-22',
      fechaLocal: '22/11/2026',
      emitidas: 8,
      completas: 2,
      incompletas: 2,
      sinInformacion: 4,
    });
  });

  it('sin emisiones: todo en cero', () => {
    expect(cifrasDiaAnterior([], rango, 0)).toEqual({
      fecha: '2026-11-22',
      fechaLocal: '22/11/2026',
      emitidas: 0,
      completas: 0,
      incompletas: 0,
      sinInformacion: 0,
    });
  });
});

describe('día anterior: Resumen del Excel y correo', () => {
  const diaAnterior = {
    fecha: '2026-11-22',
    fechaLocal: '22/11/2026',
    emitidas: 47,
    completas: 30,
    incompletas: 15,
    sinInformacion: 2,
  };
  const base = cifrasControl([
    { area: 'canal', estadoDocumental: 'completo' },
    { area: 'canal', estadoDocumental: 'incompleto' },
  ] as any[]);

  it('Resumen: bloque del día anterior arriba del acumulado; sin él queda igual', () => {
    const conDia = filasResumen({ ...base, diaAnterior });
    expect(conDia.slice(0, 5)).toEqual([
      ['Emitidas el 22/11/2026 (día anterior)', 47],
      ['· Completas', 30],
      ['· Incompletas', 15],
      ['· Sin información', 2],
      ['Completados', 1],
    ]);
    expect(conDia.slice(4)).toEqual(filasResumen(base));
    expect(filasResumen(base)[0]).toEqual(['Completados', 1]);
  });

  it('textos del correo (sin información solo si hay)', () => {
    expect(lineaDiaAnterior(diaAnterior)).toBe(
      'Emitidas el 22/11/2026: 47 · 30 completas · 15 incompletas · 2 sin información',
    );
    expect(valorDiaAnterior(diaAnterior)).toBe(
      '47 · 30 completas / 15 incompletas / 2 sin información',
    );
    const sinSI = { ...diaAnterior, emitidas: 45, sinInformacion: 0 };
    expect(lineaDiaAnterior(sinSI)).toBe(
      'Emitidas el 22/11/2026: 45 · 30 completas · 15 incompletas',
    );
    expect(valorDiaAnterior(sinSI)).toBe('45 · 30 completas / 15 incompletas');
  });

  it('correo: primer campo del branded y datos aditivos para nest-api', () => {
    const r = {
      areas: 'Canales',
      fechaLocal: '23/11/2026',
      corte: '23/11/2026 09:00',
      cifras: { ...base, diaAnterior },
    };
    const correo = correoReporteSimple(r, null);
    expect(correo.fields?.[0]).toEqual({
      label: 'Emitidas ayer (22/11)',
      value: '47 · 30 completas / 15 incompletas / 2 sin información',
    });
    const data = (correo as any).reporteSimple.data;
    expect(data.diaAnterior).toEqual(diaAnterior);
    expect(data.lineaDiaAnterior).toBe(
      'Emitidas el 22/11/2026: 47 · 30 completas · 15 incompletas · 2 sin información',
    );
    // Sin el indicador el correo queda como antes.
    const viejo = correoReporteSimple({ ...r, cifras: base }, null);
    expect(viejo.fields?.[0]).toEqual({ label: 'Completados', value: '1' });
    expect((viejo as any).reporteSimple.data).not.toHaveProperty('diaAnterior');
    expect((viejo as any).reporteSimple.data).not.toHaveProperty(
      'lineaDiaAnterior',
    );
  });
});

describe('día anterior: reporte de las 09:00 (de punta a punta)', () => {
  /** 23-nov-2026 09:00 hora de Caracas. */
  const REPORTE = new Date('2026-11-23T13:00:00.000Z');
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    db.$reset();
    _resetScheduler();
    process.env.EXPEDIENTES_ENABLED = 'true';
    process.env.EXPEDIENTES_JOBS_ENABLED = 'true';
    process.env.EXPEDIENTES_CONCILIACION_CADA_MIN = '0';
    process.env.NEST_API_KEY = 'k';
    process.env.EXPEDIENTES_PUBLIC_URL = 'https://nexusqa.test/portal-lm';
    process.env.EXPEDIENTES_MAIL_WHITELIST = 'lm@test.com';
    delete process.env.EXPEDIENTES_ENTORNO;
    delete process.env.EXPEDIENTES_RESUMEN_PRODUCTORES;
    _resetCatalogoCanales({
      nombres: new Map([['900', 'Farmatodo']]),
      gestorCanal: new Map(),
      canales: [],
    });
    fetchMock = vi.fn(
      async () =>
        new Response(JSON.stringify({ status: true, data: { sent: true } }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
    );
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  async function crear(poliza: string, emitida: string, productor = false) {
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
          centidad: productor ? 'P' : 'C',
          ...(productor ? { cproductor: '777' } : { ccanalalt: '900' }),
          producto: 'rcv',
          documentosEnWizard: true,
          asegurado: {
            tipoDoc: 'V',
            documento: '11222333',
            nombre: 'Luis',
            email: 'luis@test.com',
          },
        },
      },
    );
    return db.mktExpediente._rows().find((e: any) => e.id === r!.id);
  }

  it('cuenta lo emitido el 22/11 (Caracas) del alcance, con su estado de hoy', async () => {
    await svc.updateConfig(
      { destinatariosResumen: ['lm@test.com'], motivo: 'qa' } as any,
      'portal:1',
    );
    // Día anterior (22-nov Caracas): bordes 00:00 y 23:59.
    (await crear('A-1', '2026-11-22T04:00:00.000Z')).estadoDocumental =
      'completo';
    await crear('A-2', '2026-11-23T03:59:00.000Z'); // incompleto
    await crear('A-3', '2026-11-22T15:00:00.000Z'); // incompleto
    (await crear('A-4', '2026-11-22T16:00:00.000Z')).estadoDocumental =
      'sin_informacion';
    (await crear('A-5', '2026-11-22T17:00:00.000Z')).estadoDocumental =
      'descartada';
    // Productor fuera del alcance por defecto: no cuenta.
    await crear('A-6', '2026-11-22T18:00:00.000Z', true);
    // Antevíspera (21-nov 23:59 Caracas) y día del reporte (23-nov 00:00 Caracas): fuera.
    await crear('A-7', '2026-11-22T03:59:00.000Z');
    (await crear('A-8', '2026-11-23T04:00:00.000Z')).estadoDocumental =
      'completo';

    const r = await tareaNocturna(REPORTE);
    expect(r.resultado).toBe('enviado');
    const esperado = {
      fecha: '2026-11-22',
      fechaLocal: '22/11/2026',
      emitidas: 4,
      completas: 1,
      incompletas: 2,
      sinInformacion: 1,
    };
    expect((r.reportes[0] as any).diaAnterior).toEqual(esperado);

    const body = fetchMock.mock.calls
      .map(([, init]: any) => JSON.parse(init.body))
      .find((b: any) =>
        String(b.data?.subject ?? '').includes('Control documental diario'),
      );
    expect(body.template).toBe('expediente-reporte-diario-simple');
    expect(body.data.fecha).toBe('23/11/2026');
    expect(body.data.diaAnterior).toEqual(esperado);
    expect(body.data.lineaDiaAnterior).toBe(
      'Emitidas el 22/11/2026: 4 · 1 completas · 2 incompletas · 1 sin información',
    );
    // El acumulado no cambia: sigue contando toda la cartera del alcance.
    expect(body.data.total).toBe(5);

    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(
      Buffer.from(body.attachments[0].contentBase64, 'base64') as any,
    );
    const filas: any[][] = [];
    wb.getWorksheet('Resumen')!.eachRow((row) =>
      filas.push((row.values as any[]).slice(1)),
    );
    expect(filas.slice(0, 6)).toEqual([
      ['Cifra', 'Valor'],
      ['Emitidas el 22/11/2026 (día anterior)', 4],
      ['· Completas', 1],
      ['· Incompletas', 2],
      ['· Sin información', 1],
      ['Completados', 2],
    ]);
  });
});
