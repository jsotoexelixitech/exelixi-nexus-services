/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * Carga histórica 2026: mapeo de origen, idempotencia, reanudación por cursor, vista previa sin
 * escrituras, cero correos y resumen por mes/origen (tabla liviana mkt_poliza_historica).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import ExcelJS from 'exceljs';

vi.mock('../../config/prisma', async () => {
  const { createFakePrisma } = await import('./test-utils/fake-prisma');
  return { default: createFakePrisma() };
});
vi.mock('../../utils/logger', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import prisma from '../../config/prisma';
import {
  _resetHistorico,
  _setDormirHistorico,
  armarResumenHistorico,
  claveTandaHistorica,
  dentroDeVentana,
  ejecutarCargaHistorica,
  fechaIngreso,
  leerEstadoHistorico,
  mesDe,
  origenDe,
  reanudarCargaHistorica,
  reiniciarCargaHistorica,
  resumenHistorico,
  urlPolizasHistoricas,
  vistaHistorico,
  vistaPreviaHistorica,
} from './expedientes.historico';
import { _resetScheduler, tickHistorico } from './expedientes.jobs';
import {
  excelReporteSimple,
  filasHistoricoExcel,
  nombreHojaHistorico,
} from './expedientes.excel';
import type { ReporteSimple } from './expedientes.reporte';

const db = prisma as any;

/** Páginas de nest-api por cursor ('' = primera). */
let paginas: Record<string, { items: any[]; nextCursor: string | null }>;
let nestFalla: boolean;
/** Respuestas de /localizar por cnpoliza; null = OCR caído (503). */
let ocr: Record<string, any> | null;
let fetchMock: ReturnType<typeof vi.fn>;

const llamadas = (frag: string) =>
  fetchMock.mock.calls.filter(([u]) => String(u).includes(frag));
const llamadasNest = () => llamadas('/api/v1/canal/polizas-historicas');
const llamadasOcr = () => llamadas('/localizar');
const filas = () => db.mktPolizaHistorica._rows() as any[];
const fila = (cn: string) => filas().find((r) => r.cnpoliza === cn);

function pol(
  cnpoliza: string,
  fingreso = '2026-01-15 10:00:00.000',
  cprog = 'TEmision_Auto_RCV2',
) {
  return {
    cnpoliza,
    cramo: 28,
    cprog,
    fingreso,
    fdesde: fingreso.slice(0, 10),
    iestado: 'V',
    cusuario: 1,
    tomador: {
      tipoDocumento: 'V',
      numeroDocumento: '12345678',
      nombre: 'NOMBRE PRIVADO',
    },
    ccanalalt: 900,
    xcanalalt: 'CANAL',
    cproductor: null,
    xproductor: null,
    cgestor: null,
  };
}

beforeEach(() => {
  db.$reset();
  _resetHistorico();
  _resetScheduler();
  _setDormirHistorico(async () => undefined);
  process.env.EXPEDIENTES_ENABLED = 'true';
  process.env.EXPEDIENTES_JOBS_ENABLED = 'true';
  process.env.EXPEDIENTES_HISTORICO_ENABLED = 'true';
  process.env.EXPEDIENTES_HISTORICO_NEST_URL = 'http://nest.local';
  process.env.EXPEDIENTES_HISTORICO_NEST_KEY = 'k-historico';
  process.env.EXPEDIENTES_HISTORICO_DESDE = '2026-01-01';
  process.env.EXPEDIENTES_HISTORICO_HASTA = '2026-11-23';
  process.env.EXPEDIENTES_HISTORICO_VENTANA = '00:00-00:00';
  process.env.EXPEDIENTES_HISTORICO_PAUSA_PAGINA_MS = '0';
  process.env.EXPEDIENTES_HISTORICO_PAUSA_OCR_MS = '0';
  delete process.env.EXPEDIENTES_HISTORICO_POR_CORRIDA;
  delete process.env.EXPEDIENTES_HISTORICO_MAX_ERRORES;
  process.env.OCR_INTERNAL_URL = 'http://ocr.local';
  process.env.EXPEDIENTE_INTERNAL_KEY = 'k';
  paginas = {};
  nestFalla = false;
  ocr = {};
  fetchMock = vi.fn(async (url: string, init: any) => {
    const u = String(url);
    if (u.includes('/api/v1/canal/polizas-historicas')) {
      if (nestFalla) return new Response('{}', { status: 500 });
      const cursor = new URL(u).searchParams.get('cursor') ?? '';
      const p = paginas[cursor] ?? { items: [], nextCursor: null };
      return new Response(JSON.stringify({ status: true, data: p }), {
        status: 200,
      });
    }
    if (u.endsWith('/localizar')) {
      if (!ocr) return new Response('{}', { status: 503 });
      const body = JSON.parse(init.body);
      const r = ocr[body.cnpoliza] ?? {
        ubicacion: null,
        carpeta: null,
        documentos: {},
      };
      return new Response(JSON.stringify({ ok: true, ...r }), { status: 200 });
    }
    // Cualquier otra llamada (correo incluido) se registra y responde ok: la prueba la detecta.
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  });
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
  _resetScheduler();
  for (const k of Object.keys(process.env))
    if (k.startsWith('EXPEDIENTES_HISTORICO_')) delete process.env[k];
});

describe('reglas puras', () => {
  it('origen: nexus si ya está en Nexus; MarkPl = MarketPlace SysIP; el resto nest-api', () => {
    expect(origenDe('TEmision_Auto_RCV2', true)).toBe('nexus');
    expect(origenDe('MarkPl', true)).toBe('nexus');
    expect(origenDe('MarkPl', false)).toBe('marketplace_sysip');
    expect(origenDe(' MARKPL ', false)).toBe('marketplace_sysip');
    expect(origenDe('TEMISION_PER_GE', false)).toBe('nest_api');
    expect(origenDe(null, false)).toBe('nest_api');
  });

  it('mes y fingreso (hora local de Sis2000 sin zona)', () => {
    expect(mesDe('2026-03-09 23:59:59.997')).toBe('2026-03');
    expect(mesDe('basura')).toBeNull();
    expect(fechaIngreso('2026-03-09 23:59:59.997')?.toISOString()).toBe(
      '2026-03-09T23:59:59.997Z',
    );
  });

  it('ventana nocturna que cruza la medianoche', () => {
    const v = { inicio: '22:00', fin: '05:00' };
    expect(dentroDeVentana('23:10', v)).toBe(true);
    expect(dentroDeVentana('04:59', v)).toBe(true);
    expect(dentroDeVentana('05:00', v)).toBe(false);
    expect(dentroDeVentana('12:00', v)).toBe(false);
    expect(dentroDeVentana('10:00', { inicio: '09:00', fin: '11:00' })).toBe(
      true,
    );
  });

  it('URL de nest-api con y sin /api al final; clave de tanda por bloque', () => {
    const cfg = {
      nestUrl: 'http://n:3002/api',
      desde: '2026-01-01',
      limit: 500,
    };
    expect(urlPolizasHistoricas(cfg, '2026-11-23', 'abc')).toBe(
      'http://n:3002/api/v1/canal/polizas-historicas?desde=2026-01-01&hasta=2026-11-23&limit=500&cursor=abc',
    );
    expect(
      urlPolizasHistoricas({ ...cfg, nestUrl: 'http://n:3002' }, null, null),
    ).toBe(
      'http://n:3002/api/v1/canal/polizas-historicas?desde=2026-01-01&limit=500',
    );
    // 23:10 Caracas = 03:10 UTC; bloques de 30 min → 46.
    expect(claveTandaHistorica(new Date('2026-11-24T03:10:00Z'), 30)).toBe(
      '2026-11-23~h46',
    );
  });
});

describe('ejecutar', () => {
  it('apagada sin las variables: no llama a nest-api', async () => {
    delete process.env.EXPEDIENTES_HISTORICO_NEST_KEY;
    const r = await ejecutarCargaHistorica();
    expect(r.omitido).toBe(true);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('clasifica una vez por cnpoliza, mapea el origen y no guarda datos personales', async () => {
    await db.mktExpediente.create({
      data: {
        empresaId: 7,
        cnpoliza: 'P-DESC',
        producto: 'rcv',
        estadoDocumental: 'descartada',
        emitidaEn: new Date(),
      },
    });
    const conDocs = await db.mktExpediente.create({
      data: {
        empresaId: 7,
        cnpoliza: 'P-DOCS',
        producto: 'rcv',
        estadoDocumental: 'incompleto',
        emitidaEn: new Date(),
      },
    });
    await db.mktExpedienteRequisito.create({
      data: {
        expedienteId: conDocs.id,
        tipo: 'cedula',
        estado: 'recibido',
        ref: 'a/b.pdf',
      },
    });
    await db.emision.create({
      data: { empresaId: 7, polizaNumero: 'P-EMI', jsonData: {} },
    });
    paginas[''] = {
      items: [
        pol('P-DESC'),
        pol('P-DOCS'),
        pol('P-EMI'),
        pol('P-MKT', '2026-03-02 08:00:00.000', 'MarkPl'),
        pol('P-NEST', '2026-03-05 08:00:00.000', 'TEmision_Salud'),
        // Renovación/otra versión de la misma póliza: se cuenta una sola vez.
        pol('P-NEST', '2026-04-01 08:00:00.000', 'TEmision_Salud'),
      ],
      nextCursor: null,
    };
    ocr = { 'P-EMI': { ubicacion: 'poliza', carpeta: 'x', documentos: {} } };

    const r: any = await ejecutarCargaHistorica();
    expect(r.omitido).toBe(false);
    expect(r.motivoFin).toBe('completada');
    expect(filas()).toHaveLength(5);
    expect(fila('P-DESC')).toMatchObject({
      origen: 'nexus',
      resultado: 'no_paso_ocr',
      ubicacionOcr: 'monitor',
    });
    expect(fila('P-DOCS')).toMatchObject({
      origen: 'nexus',
      resultado: 'paso_ocr',
      ubicacionOcr: 'monitor',
      expedienteId: conDocs.id,
    });
    expect(fila('P-EMI')).toMatchObject({
      origen: 'nexus',
      resultado: 'paso_ocr',
      ubicacionOcr: 'poliza',
      intentos: 1,
    });
    expect(fila('P-MKT')).toMatchObject({
      origen: 'marketplace_sysip',
      resultado: 'no_paso_ocr',
      mes: '2026-03',
    });
    expect(fila('P-NEST')).toMatchObject({
      origen: 'nest_api',
      mes: '2026-03',
      ccanalalt: '900',
    });
    // Solo se pregunta al OCR por lo que el monitor no sabe ya.
    expect(llamadasOcr()).toHaveLength(3);
    const enviado = JSON.parse(llamadasOcr()[0][1].body);
    expect(enviado.cedulas).toContain('12345678');
    // Sin nombre ni documento del tomador en la tabla.
    const json = JSON.stringify(filas());
    expect(json).not.toContain('NOMBRE PRIVADO');
    expect(json).not.toContain('12345678');
    // apikey en cabecera y corte fijo.
    const [url, init] = llamadasNest()[0];
    expect(init.headers.apikey).toBe('k-historico');
    expect(String(url)).toContain('hasta=2026-11-23');
    const estado = await leerEstadoHistorico();
    expect(estado).toMatchObject({
      estado: 'completada',
      paginas: 1,
      filasLeidas: 6,
      nuevas: 5,
    });
  });

  it('idempotente: re-correr desde el inicio no duplica ni vuelve a consultar lo clasificado', async () => {
    paginas[''] = { items: [pol('A1'), pol('A2')], nextCursor: null };
    ocr = { A1: { ubicacion: 'pendiente', carpeta: 'x', documentos: {} } };
    await ejecutarCargaHistorica();
    expect(llamadasOcr()).toHaveLength(2);
    expect((await ejecutarCargaHistorica()).omitido).toBe(true); // completada

    await reiniciarCargaHistorica('admin');
    const r: any = await ejecutarCargaHistorica();
    expect(r.motivoFin).toBe('completada');
    expect(r.conteo.yaClasificadas).toBe(2);
    expect(filas()).toHaveLength(2);
    expect(llamadasOcr()).toHaveLength(2);
    expect(fila('A1')).toMatchObject({
      resultado: 'paso_ocr',
      ubicacionOcr: 'pendiente',
      intentos: 1,
    });
  });

  it('reanuda por cursor: el tope por corrida corta y la siguiente sigue donde quedó', async () => {
    process.env.EXPEDIENTES_HISTORICO_POR_CORRIDA = '2';
    paginas[''] = { items: [pol('B1'), pol('B2')], nextCursor: 'c1' };
    paginas.c1 = { items: [pol('B3')], nextCursor: 'c2' };
    paginas.c2 = { items: [pol('B4')], nextCursor: null };

    const r1: any = await ejecutarCargaHistorica();
    expect(r1.motivoFin).toBe('tope_corrida');
    expect((await leerEstadoHistorico()).cursor).toBe('c1');
    expect(filas().map((f) => f.cnpoliza)).toEqual(['B1', 'B2']);

    const r2: any = await ejecutarCargaHistorica();
    expect(r2.motivoFin).toBe('completada');
    const cursores = llamadasNest().map(([u]) =>
      new URL(String(u)).searchParams.get('cursor'),
    );
    expect(cursores).toEqual([null, 'c1', 'c2']);
    expect(filas()).toHaveLength(4);
  });

  it('OCR caído: se detiene sin avanzar el cursor y, tras corridas seguidas con error, queda detenida', async () => {
    process.env.EXPEDIENTES_HISTORICO_MAX_ERRORES = '2';
    paginas[''] = {
      items: [pol('C1'), pol('C2'), pol('C3')],
      nextCursor: 'c1',
    };
    ocr = null;
    const r: any = await ejecutarCargaHistorica();
    expect(r.motivoFin).toBe('error_ocr');
    expect(llamadasOcr()).toHaveLength(2);
    const e = await leerEstadoHistorico();
    expect(e.cursor).toBeNull();
    expect(e.corridasConError).toBe(1);
    expect(fila('C1').resultado).toBe('error');

    await ejecutarCargaHistorica();
    await ejecutarCargaHistorica();
    expect((await leerEstadoHistorico()).estado).toBe('detenida');
    expect((await ejecutarCargaHistorica()).omitido).toBe(true);

    // Vuelve el OCR: reanudar reconsulta las que quedaron con error, sin duplicar.
    ocr = {};
    await reanudarCargaHistorica('admin');
    const r2: any = await ejecutarCargaHistorica();
    expect(r2.motivoFin).toBe('completada');
    expect(filas()).toHaveLength(3);
    expect(filas().every((f) => f.resultado === 'no_paso_ocr')).toBe(true);
  });

  it('nest-api con errores seguidos: corta la corrida sin tocar filas', async () => {
    nestFalla = true;
    const r: any = await ejecutarCargaHistorica();
    expect(r.motivoFin).toBe('error_nest');
    expect(llamadasNest()).toHaveLength(3);
    expect(filas()).toHaveLength(0);
  });

  it('fuera de la ventana nocturna no corre (salvo prueba manual)', async () => {
    process.env.EXPEDIENTES_HISTORICO_VENTANA = '22:00-05:00';
    paginas[''] = { items: [pol('D1')], nextCursor: null };
    // 12:00 Caracas.
    const ahora = new Date('2026-11-23T16:00:00Z');
    expect(await ejecutarCargaHistorica({ ahora })).toEqual({
      omitido: true,
      motivo: 'fuera_de_ventana',
    });
    const r: any = await ejecutarCargaHistorica({
      ahora,
      ignorarVentana: true,
    });
    expect(r.motivoFin).toBe('completada');
  });
});

describe('nunca correos', () => {
  it('no crea expedientes, no toca la cadencia ni llama al servicio de correo', async () => {
    const exp = await db.mktExpediente.create({
      data: {
        empresaId: 7,
        cnpoliza: 'E1',
        producto: 'rcv',
        estadoDocumental: 'sin_informacion',
        infoDocumental: false,
        aseguradoEmail: 'cliente@test.com',
        emitidaEn: new Date(),
      },
    });
    paginas[''] = {
      items: [pol('E1'), pol('E2'), pol('E3', undefined, 'MarkPl')],
      nextCursor: null,
    };
    ocr = {
      E2: { ubicacion: 'poliza', carpeta: 'x', documentos: { cedula: 'r' } },
    };
    await ejecutarCargaHistorica();

    expect(db.mktExpediente._rows()).toHaveLength(1);
    const despues = db.mktExpediente._rows()[0];
    expect(despues).toMatchObject({
      id: exp.id,
      etapaEnviada: -1,
      intentos: 0,
      ultimoEnvio: null,
      cadenciaAgotada: false,
      estadoDocumental: 'sin_informacion',
    });
    expect(db.mktExpedienteNotificacion._rows()).toHaveLength(0);
    expect(db.mktExpedienteEnlace._rows()).toHaveLength(0);
    const otras = fetchMock.mock.calls.filter(
      ([u]) =>
        !String(u).includes('/api/v1/canal/polizas-historicas') &&
        !String(u).endsWith('/localizar'),
    );
    expect(otras).toHaveLength(0);
    expect(fila('E2')).toMatchObject({
      resultado: 'paso_ocr',
      origen: 'nest_api',
    });
  });
});

describe('vista previa', () => {
  it('cuenta sin escribir nada (ni filas, ni estado, ni registro de tareas)', async () => {
    paginas[''] = {
      items: [
        pol('V1'),
        pol('V2', '2026-02-01 00:00:00.000', 'MarkPl'),
        pol('V2'),
      ],
      nextCursor: 'c1',
    };
    paginas.c1 = {
      items: [pol('V3', '2026-02-03 00:00:00.000')],
      nextCursor: null,
    };
    const v = await vistaPreviaHistorica({ maxPaginas: 5, muestraOcr: 1 });
    expect(v.paginas).toBe(2);
    expect(v.hayMas).toBe(false);
    expect(v.conteo).toMatchObject({
      filas: 4,
      polizas: 3,
      nuevas: 3,
      consultasOcr: 1,
    });
    expect(v.conteo.porMes).toEqual({ '2026-01': 1, '2026-02': 2 });
    expect(v.conteo.porOrigen).toEqual({ nest_api: 2, marketplace_sysip: 1 });
    expect(llamadasOcr()).toHaveLength(1);
    expect(filas()).toHaveLength(0);
    expect(db.mktExpedienteConfig._rows()).toHaveLength(0);
    expect(db.mktExpedienteJobRun._rows()).toHaveLength(0);
    expect(db.mktExpedienteEvento._rows()).toHaveLength(0);
  });

  it('sin muestra no consulta al OCR y respeta el tope de páginas', async () => {
    paginas[''] = { items: [pol('W1')], nextCursor: 'c1' };
    paginas.c1 = { items: [pol('W2')], nextCursor: null };
    const v = await vistaPreviaHistorica();
    expect(v.paginas).toBe(1);
    expect(v.hayMas).toBe(true);
    expect(v.conteo.pendientes).toBe(1);
    expect(llamadasOcr()).toHaveLength(0);
  });
});

describe('resumen por mes y origen', () => {
  it('arma totales, por mes, por origen y mes × origen con el % sobre lo clasificado', () => {
    const r = armarResumenHistorico([
      { mes: '2026-02', origen: 'nest_api', resultado: 'paso_ocr', n: 3 },
      { mes: '2026-02', origen: 'nest_api', resultado: 'no_paso_ocr', n: 1 },
      {
        mes: '2026-01',
        origen: 'marketplace_sysip',
        resultado: 'no_paso_ocr',
        n: 2,
      },
      { mes: '2026-01', origen: 'nexus', resultado: 'paso_ocr', n: 1 },
      { mes: '2026-01', origen: 'nexus', resultado: 'pendiente', n: 4 },
      { mes: '2026-01', origen: 'nexus', resultado: 'error', n: 1 },
    ]);
    expect(r.totales).toEqual({
      total: 12,
      pasoOcr: 4,
      noPasoOcr: 3,
      pendientes: 4,
      errores: 1,
      pctPasoOcr: 4 / 7,
    });
    expect(r.porMes.map((m) => [m.mes, m.total, m.pctPasoOcr])).toEqual([
      ['2026-01', 8, 1 / 3],
      ['2026-02', 4, 0.75],
    ]);
    expect(r.porOrigen.map((o) => o.origen)).toEqual([
      'nexus',
      'nest_api',
      'marketplace_sysip',
    ]);
    expect(r.filas.map((f) => `${f.mes}|${f.origen}`)).toEqual([
      '2026-01|nexus',
      '2026-01|marketplace_sysip',
      '2026-02|nest_api',
    ]);
    expect(r.filas[1].pctPasoOcr).toBe(0);
  });

  it('desde la tabla y en GET /historico (sin cursor)', async () => {
    paginas[''] = {
      items: [pol('R1'), pol('R2', '2026-05-01 00:00:00.000', 'MarkPl')],
      nextCursor: null,
    };
    ocr = { R1: { ubicacion: 'poliza', carpeta: 'x', documentos: {} } };
    await ejecutarCargaHistorica();
    const r = await resumenHistorico();
    expect(r.totales).toMatchObject({
      total: 2,
      pasoOcr: 1,
      noPasoOcr: 1,
      pctPasoOcr: 0.5,
    });
    const v: any = await vistaHistorico();
    expect(v.habilitada).toBe(true);
    expect(v.carga.estado).toBe('completada');
    expect(v.carga).not.toHaveProperty('cursor');
    expect(v.porMes.map((m: any) => m.mes)).toEqual(['2026-01', '2026-05']);
  });

  it('hoja «Histórico 2026» del Excel: por mes, «Todos» y total general', async () => {
    const historico = armarResumenHistorico([
      { mes: '2026-01', origen: 'nexus', resultado: 'paso_ocr', n: 2 },
      { mes: '2026-01', origen: 'nest_api', resultado: 'no_paso_ocr', n: 2 },
      { mes: '2026-02', origen: 'nest_api', resultado: 'paso_ocr', n: 1 },
    ]);
    expect(nombreHojaHistorico(historico)).toBe('Histórico 2026');
    const f = filasHistoricoExcel(historico);
    expect(f.map((x) => `${x.mes}|${x.origen}|${x.total}`)).toEqual([
      '2026-01|Nexus (flujo Exélixi)|2',
      '2026-01|nest-api (SysIP e integradores)|2',
      '2026-01|Todos|4',
      '2026-02|nest-api (SysIP e integradores)|1',
      '2026-02|Todos|1',
      'Total|Todos|5',
    ]);
    const reporte = {
      grupo: 'canales',
      areas: 'Canales',
      fecha: '2026-11-23',
      fechaLocal: '23/11/2026',
      corte: '23/11/2026 20:00',
      cifras: {
        completados: 0,
        incompletos: 0,
        canales: { completos: 0, incompletos: 0 },
        productores: { completos: 0, incompletos: 0 },
        sinCanal: { completos: 0, incompletos: 0 },
        sinDatos: 0,
        total: 0,
      },
      incompletos: [],
      completados: [],
      historico,
    } as unknown as ReporteSimple;
    const x = await excelReporteSimple(reporte);
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(x.buffer as any);
    const ws = wb.getWorksheet('Histórico 2026');
    expect(ws).toBeDefined();
    expect(ws!.rowCount).toBe(7);
    expect(ws!.getRow(7).getCell(3).value).toBe(5);
  });
});

describe('scheduler', () => {
  it('solo dentro de la ventana, una tanda por bloque y nada si está completada', async () => {
    process.env.EXPEDIENTES_HISTORICO_VENTANA = '22:00-05:00';
    paginas[''] = { items: [pol('S1')], nextCursor: null };
    // 12:00 Caracas: fuera.
    expect(await tickHistorico(new Date('2026-11-23T16:00:00Z'))).toBeNull();
    expect(llamadasNest()).toHaveLength(0);
    // La tanda corre con el reloj real: se abre la ventana para la ejecución.
    process.env.EXPEDIENTES_HISTORICO_VENTANA = '00:00-00:00';
    const t = new Date('2026-11-24T03:10:00Z'); // 23:10 Caracas
    const r: any = await tickHistorico(t);
    expect(r).toMatchObject({
      job: 'carga_historica',
      omitido: false,
      estado: 'ok',
    });
    expect(db.mktExpedienteJobRun._rows()).toHaveLength(1);
    // Mismo bloque: no repite. Completada: no corre ni deja registro.
    expect(await tickHistorico(t)).toBeNull();
    expect(await tickHistorico(new Date('2026-11-24T04:10:00Z'))).toBeNull();
    expect(db.mktExpedienteJobRun._rows()).toHaveLength(1);
    expect(llamadasNest()).toHaveLength(1);
  });

  it('sin EXPEDIENTES_JOBS_ENABLED el scheduler no la corre', async () => {
    delete process.env.EXPEDIENTES_JOBS_ENABLED;
    expect(await tickHistorico(new Date('2026-11-24T03:10:00Z'))).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
