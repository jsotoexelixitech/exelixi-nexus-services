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
import { ExpedientesService } from './expedientes.service';

const db = prisma as any;
const svc = new ExpedientesService();
const DIA = 86_400_000;
const ahora = Date.now();
const haceDias = (d: number) => new Date(ahora - d * DIA);

let n = 0;
async function exp(over: Record<string, any> = {}) {
  n++;
  return db.mktExpediente.create({
    data: {
      empresaId: 7,
      cnpoliza: `P-${n}`,
      producto: 'rcv',
      area: 'canal',
      emitidaEn: haceDias(1),
      ...over,
    },
  });
}
const req = (expedienteId: number, tipo: string, estado: string) =>
  db.mktExpedienteRequisito.create({ data: { expedienteId, tipo, estado } });
const notif = (
  expedienteId: number,
  resultado: string,
  tipo = 'recordatorio',
) =>
  db.mktExpedienteNotificacion.create({
    data: { expedienteId, tipo, resultado },
  });

beforeEach(() => {
  db.$reset();
  n = 0;
  process.env.EXPEDIENTES_ENABLED = 'true';
});

describe('indicadores.kpis', () => {
  it('sin expedientes: tasas y tiempo en null, listas vacías, 30 días de tendencia', async () => {
    const ind = await svc.indicadores({});
    expect(ind.total).toBe(0);
    const k = ind.kpis;
    expect(k.tasaCompletitud).toBeNull();
    expect(k.tiempoMedioCompletarDias).toBeNull();
    expect(k.tasaRecuperacion).toBeNull();
    expect(k.completadosUltimos7Dias).toBe(0);
    expect(k.porProducto).toEqual([]);
    expect(k.porDocumento).toEqual([]);
    expect(k.topIncompletos).toEqual({
      canales: [],
      gestores: [],
      productores: [],
    });
    expect(k.tendencia).toHaveLength(30);
    expect(
      k.tendencia.every((d) => d.emitidas === 0 && d.completadas === 0),
    ).toBe(true);
  });

  it('completitud, tiempo medio, 7 días y producto (sin_informacion no cuenta en la tasa)', async () => {
    await exp({
      estadoDocumental: 'completo',
      emitidaEn: haceDias(10),
      completadoEn: haceDias(8), // 2 días
    });
    await exp({
      estadoDocumental: 'completo',
      emitidaEn: haceDias(5),
      completadoEn: haceDias(1), // 4 días
      producto: 'personas',
    });
    await exp({ estadoDocumental: 'incompleto' });
    await exp({ estadoDocumental: 'sin_informacion' });
    // Completo sin fecha de completado: cuenta en la tasa, no en el tiempo.
    await exp({ estadoDocumental: 'completo', completadoEn: null });
    const k = (await svc.indicadores({})).kpis;
    expect(k.tasaCompletitud).toBe(0.75);
    expect(k.tiempoMedioCompletarDias).toBe(3);
    expect(k.completadosUltimos7Dias).toBe(1);
    expect(k.porProducto).toEqual([
      { producto: 'rcv', total: 4, completos: 2, incompletos: 1 },
      { producto: 'personas', total: 1, completos: 1, incompletos: 0 },
    ]);
  });

  it('respeta el filtro de área y fechas', async () => {
    await exp({ estadoDocumental: 'completo', area: 'canal' });
    await exp({ estadoDocumental: 'incompleto', area: 'gestor' });
    await exp({ estadoDocumental: 'incompleto', area: 'gestor' });
    // Productores fuera del alcance por defecto: nunca cuentan.
    await exp({ estadoDocumental: 'incompleto', area: 'productor' });
    await exp({
      estadoDocumental: 'incompleto',
      area: 'canal',
      emitidaEn: new Date('2026-01-10T12:00:00Z'),
    });
    expect((await svc.indicadores({ area: 'G' })).kpis.tasaCompletitud).toBe(0);
    expect((await svc.indicadores({ area: 'C' })).kpis.tasaCompletitud).toBe(
      0.5,
    );
    const enero = await svc.indicadores({
      desde: '2026-01-01',
      hasta: '2026-01-31',
    });
    expect(enero.total).toBe(1);
    expect(enero.kpis.porProducto).toEqual([
      { producto: 'rcv', total: 1, completos: 0, incompletos: 1 },
    ]);
    // La tendencia termina en `hasta`: el 10 de enero aparece como emitida.
    expect(enero.kpis.tendencia.at(-1)?.fecha).toBe('2026-01-31');
    expect(
      enero.kpis.tendencia.find((d) => d.fecha === '2026-01-10')?.emitidas,
    ).toBe(1);
  });

  it('recordatorios por expediente distinto; prueba y avisos de evento no cuentan', async () => {
    const a = await exp({ estadoDocumental: 'completo', intentos: 2 });
    const b = await exp({ estadoDocumental: 'incompleto', intentos: 1 });
    const c = await exp({
      estadoDocumental: 'incompleto',
      cadenciaAgotada: true,
    });
    const d = await exp({ estadoDocumental: 'incompleto' });
    await notif(a.id, 'enviado', 'solicitud_inicial');
    await notif(a.id, 'enviado');
    await notif(b.id, 'enviado');
    await notif(b.id, 'error');
    await notif(c.id, 'bloqueado_whitelist');
    await notif(c.id, 'sin_correo');
    await notif(d.id, 'excluido');
    await notif(d.id, 'enviado', 'prueba');
    await notif(d.id, 'enviado', 'observado');
    const k = (await svc.indicadores({})).kpis;
    expect(k.recordatorios).toEqual({
      recibieron: 2,
      recuperados: 1,
      enviados: 2,
      error: 1,
      bloqueados: 1,
      sinCorreo: 1,
      agotados: 1,
      excluidos: 1,
      noEnviar: 0,
    });
    expect(k.tasaRecuperacion).toBe(0.5);
  });

  it('documentos por estado y top de incompletos (5 por grupo, sin códigos vacíos)', async () => {
    const a = await exp({ ccanalalt: '900', cgestor: '12' });
    const b = await exp({ ccanalalt: '900' });
    await exp({ ccanalalt: '901', estadoDocumental: 'completo' });
    for (let i = 0; i < 6; i++)
      await exp({ cproductor: `P${i}`, area: 'canal' });
    await req(a.id, 'cedula', 'faltante');
    await req(a.id, 'licencia', 'observado');
    await req(b.id, 'cedula', 'validado');
    await req(b.id, 'licencia', 'sin_informacion');
    const k = (await svc.indicadores({})).kpis;
    expect(k.porDocumento).toEqual(
      expect.arrayContaining([
        { tipo: 'cedula', faltante: 1, recibido: 0, observado: 0, validado: 1 },
        {
          tipo: 'licencia',
          faltante: 0,
          recibido: 0,
          observado: 1,
          validado: 0,
        },
      ]),
    );
    expect(k.topIncompletos.canales).toEqual([
      { codigo: '900', incompletos: 2, total: 2 },
    ]);
    expect(k.topIncompletos.gestores).toEqual([
      { codigo: '12', incompletos: 1, total: 1 },
    ]);
    expect(k.topIncompletos.productores).toHaveLength(5);
  });

  it('tendencia en hora Caracas: 02:00 UTC cuenta para el día anterior', async () => {
    const hoy = new Date(ahora - 4 * 3_600_000).toISOString().slice(0, 10);
    const ayer = new Date(ahora - 4 * 3_600_000 - DIA)
      .toISOString()
      .slice(0, 10);
    // 02:00 UTC de hoy (UTC) = 22:00 de ayer en Caracas.
    const madrugadaUtc = new Date(`${hoy}T02:00:00.000Z`);
    await exp({
      emitidaEn: madrugadaUtc,
      estadoDocumental: 'completo',
      completadoEn: madrugadaUtc,
    });
    const t = (await svc.indicadores({})).kpis.tendencia;
    expect(t.at(-1)?.fecha).toBe(hoy);
    const dia = new Date(madrugadaUtc.getTime() - 4 * 3_600_000)
      .toISOString()
      .slice(0, 10);
    expect(dia).toBe(ayer);
    expect(t.find((d) => d.fecha === dia)).toMatchObject({
      emitidas: 1,
      completadas: 1,
    });
  });
});
