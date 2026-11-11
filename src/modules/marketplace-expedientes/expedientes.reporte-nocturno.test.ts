/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * Reporte nocturno «Control documental diario» (correo 6), versión simple: cuatro cifras en el
 * cuerpo y el detalle en un Excel adjunto (hojas Incompletos, Completados y Resumen), caso cero,
 * respaldo `branded` sin adjunto, tope de tamaño del Excel, reintentos sin duplicar y Productores
 * (intermediarios) apagado hasta su aprobación.
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
import logger from '../../utils/logger';
import { _resetCatalogoCanales } from './expedientes.canales';
import {
  aseguradoProtegido,
  inicialesNombre,
  maskDocumento,
} from './expedientes.domain';
import {
  _resetScheduler,
  ejecutarJob,
  reintentarNocturna,
  tickScheduler,
} from './expedientes.jobs';
import { excelReporteSimple } from './expedientes.excel';
import { correoReporteSimple } from './expedientes.mail';
import { cifrasControl, ReporteSimple } from './expedientes.reporte';
import { expedientesService as svc } from './expedientes.service';
import { enviarRecordatorios, tareaNocturna } from './expedientes.tareas';

const db = prisma as any;
/** 7-nov-2026 10:00 hora de Caracas: emisión «de hoy». */
const HOY = new Date('2026-11-07T14:00:00.000Z');
/** 7-nov-2026 23:00 hora de Caracas: corte del reporte. */
const NOCHE = new Date('2026-11-08T03:00:00.000Z');
const MIN = 60_000;

let fetchMock: ReturnType<typeof vi.fn>;
/** Respuesta de nest-api para el reporte (los demás correos siempre salen). */
let respuestaReporte: (template: string) => number;

function ok(status = 200) {
  return new Response(
    JSON.stringify(
      status === 200
        ? { status: true, data: { sent: true } }
        : { message: 'x' },
    ),
    { status, headers: { 'content-type': 'application/json' } },
  );
}

function reporteCalls() {
  return fetchMock.mock.calls
    .filter(([url]) => String(url).includes('/api/v1/mail/send'))
    .map(([, init]) => JSON.parse(init.body))
    .filter((b) =>
      String(b.data?.subject ?? '').includes('Control documental diario'),
    );
}

async function crear(
  poliza: string,
  opts: {
    documento?: string;
    nombre?: string;
    apellido?: string;
    email?: string | null;
    telefono?: string;
    emitida?: Date;
    centidad?: string;
    cproductor?: string;
  } = {},
) {
  const r = await svc.registrarDesdeEmision(
    {
      id: Number(poliza.replace(/\D/g, '')) || 1,
      empresaId: 7,
      polizaNumero: poliza,
      jsonData: { producto: 'rcv' },
      createdAt: opts.emitida ?? HOY,
    },
    {
      expediente: {
        centidad: opts.centidad ?? 'C',
        ...(opts.centidad === 'P'
          ? { cproductor: opts.cproductor ?? '777' }
          : { ccanalalt: '900' }),
        producto: 'rcv',
        documentosEnWizard: true,
        asegurado: {
          tipoDoc: 'V',
          documento: opts.documento ?? '11222333',
          nombre: opts.nombre ?? 'Luis',
          ...(opts.apellido ? { apellido: opts.apellido } : {}),
          email: opts.email === undefined ? 'luis@test.com' : opts.email,
          ...(opts.telefono ? { telefono: opts.telefono } : {}),
        },
      },
    },
  );
  return r!.id;
}

async function requisito(expedienteId: number, tipo: string, data: any) {
  const row = db.mktExpedienteRequisito
    ._rows()
    .find((r: any) => r.expedienteId === expedienteId && r.tipo === tipo);
  if (row) Object.assign(row, data);
  else
    await db.mktExpedienteRequisito.create({
      data: { expedienteId, tipo, ...data },
    });
}

function expediente(id: number) {
  return db.mktExpediente._rows().find((e: any) => e.id === id);
}

async function destinatarios(lista = ['lm@test.com'], alcance?: any) {
  await svc.updateConfig(
    {
      destinatariosResumen: lista,
      ...(alcance ? { alcance } : {}),
      motivo: 'qa',
    } as any,
    'portal:1',
  );
}

beforeEach(() => {
  db.$reset();
  _resetScheduler();
  process.env.EXPEDIENTES_ENABLED = 'true';
  process.env.EXPEDIENTES_JOBS_ENABLED = 'true';
  process.env.NEST_API_KEY = 'k';
  process.env.EXPEDIENTES_PUBLIC_URL = 'https://nexusqa.test/portal-lm';
  process.env.EXPEDIENTES_MAIL_WHITELIST = 'lm@test.com';
  delete process.env.EXPEDIENTES_ENTORNO;
  delete process.env.EXPEDIENTES_RESUMEN_PRODUCTORES;
  delete process.env.EXPEDIENTES_RESUMEN_PRODUCTORES_DESTINATARIOS;
  _resetCatalogoCanales({
    nombres: new Map([['900', 'Farmatodo']]),
    gestorCanal: new Map(),
    canales: [],
  });
  respuestaReporte = () => 200;
  fetchMock = vi.fn(async (url: unknown, init?: any) => {
    const body = init?.body ? JSON.parse(init.body) : {};
    const esReporte = String(body.data?.subject ?? '').includes(
      'Control documental diario',
    );
    return ok(esReporte ? respuestaReporte(body.template) : 200);
  });
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('asegurado protegido', () => {
  it('solo iniciales y documento parcial', () => {
    expect(inicialesNombre('María José', 'Pérez')).toBe('M. P.');
    expect(inicialesNombre('Ángel Ruiz')).toBe('Á. R.');
    expect(inicialesNombre(null, null)).toBe('');
    expect(maskDocumento('V', '12.345.678')).toBe('V-12•••678');
    expect(maskDocumento('J', '4123')).toBe('J-4•••3');
    expect(maskDocumento(null, null)).toBe('');
    expect(
      aseguradoProtegido({
        aseguradoNombre: 'María',
        aseguradoApellido: 'Pérez',
        aseguradoTipoDoc: 'V',
        aseguradoDocumento: '12345678',
      }),
    ).toBe('M. P. · V-12•••678');
    expect(aseguradoProtegido({})).toBe('—');
  });
});

async function leerExcel(body: any): Promise<ExcelJS.Workbook> {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(
    Buffer.from(body.attachments[0].contentBase64, 'base64') as any,
  );
  return wb;
}

function filas(ws: ExcelJS.Worksheet): any[][] {
  const out: any[][] = [];
  ws.eachRow((row) => out.push((row.values as any[]).slice(1)));
  return out;
}

describe('reporte nocturno simple: cifras y Excel adjunto', () => {
  it('cuatro cifras que suman, Excel con sus 3 hojas y el cuerpo sin datos personales', async () => {
    await destinatarios(['lm@test.com'], { productores: true });
    await crear('P-1', {
      nombre: 'María José',
      apellido: 'Pérez',
      documento: '12345678',
      email: 'maria@test.com',
      telefono: '04141234567',
    });
    const p2 = await crear('P-2', {
      nombre: 'Juan',
      apellido: 'Rojas',
      documento: '84555221',
      email: null,
      emitida: new Date(HOY.getTime() + 60 * MIN),
    });
    await crear('P-3', {
      documento: '99888777',
      emitida: new Date(HOY.getTime() - 3 * 86_400_000),
    });
    const p4 = await crear('P-4', { documento: '55666777' });
    await crear('P-5', { nombre: 'Ana', documento: '33444555' });
    const p9 = await crear('P-9', {
      centidad: 'P',
      cproductor: '777',
      documento: '77666555',
    });
    const p6 = await crear('P-6', { documento: '22333444' });
    const p7 = await crear('P-7', { documento: '66777888' });
    Object.assign(expediente(p4), {
      estadoDocumental: 'completo',
      completadoEn: new Date(HOY.getTime() + 120 * MIN),
    });
    expediente(p9).estadoDocumental = 'completo';
    expediente(p6).area = 'desconocida';
    // Sin información documental: no cuenta en ninguna cifra.
    expediente(p7).estadoDocumental = 'sin_informacion';
    await requisito(p2, 'licencia', {
      estado: 'observado',
      ref: 'r-lic',
      analisisRef: 'r-lic',
      decision: 'ia',
      motivo: 'No se pudo leer el documento.',
      diagnostico: {
        version: 1,
        tipo: 'licencia',
        analizadoEn: HOY.toISOString(),
        proveedor: null,
        confianza: 0,
        resultado: 'ilegible',
        campos: [],
        resumen: 'No se pudo leer el documento.',
      },
    });
    await svc.crearExclusion(
      { alcance: 'asegurado', valor: 'V-33444555', motivo: 'pidió no recibir' },
      'portal:1',
    );
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(HOY.getTime() + 180 * MIN));
    await enviarRecordatorios(new Date(HOY.getTime() + 180 * MIN));
    vi.setSystemTime(NOCHE);

    const r = await tareaNocturna(NOCHE);
    expect(r).toMatchObject({ resultado: 'enviado', reintentar: false });
    expect(r.reportes[0]).toEqual({
      grupo: 'canales',
      resultado: 'enviado',
      plantilla: 'expediente-reporte-diario-simple',
      areas: 'Canales',
      completados: 2,
      incompletos: 5,
      canales: { completos: 1, incompletos: 4 },
      productores: { completos: 1, incompletos: 0 },
      sinDatos: 1,
      excel: true,
      omitidas: { incompletos: 0, completados: 0 },
    });
    const c = r.reportes[0] as any;
    expect(c.completados + c.incompletos).toBe(
      c.canales.completos +
        c.canales.incompletos +
        c.productores.completos +
        c.productores.incompletos +
        c.sinDatos,
    );

    const [body] = reporteCalls();
    expect(body.template).toBe('expediente-reporte-diario-simple');
    expect(body.data).toEqual({
      subject: 'Marketplace | Canales | Control documental diario – 07/11/2026',
      areas: 'Canales',
      fecha: '07/11/2026',
      corte: '07/11/2026 23:00',
      completados: 2,
      incompletos: 5,
      canales: { completos: 1, incompletos: 4 },
      productores: { completos: 1, incompletos: 0 },
      sinDatos: 1,
      adjunto: true,
      omitidas: { incompletos: 0, completados: 0 },
    });
    expect(body.attachments).toHaveLength(1);
    expect(body.attachments[0]).toMatchObject({
      filename: 'control-documental-2026-11-07.xlsx',
      contentType:
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    });
    // El cuerpo no lleva pólizas, nombres ni documentos: solo el adjunto.
    const cuerpo = JSON.stringify({ ...body, attachments: undefined });
    for (const prohibido of [
      'P-1',
      'P-2',
      '12345678',
      '84555221',
      'maria@test.com',
      '04141234567',
      'María',
      'Pérez',
      'Rojas',
      'Farmatodo',
    ])
      expect(cuerpo).not.toContain(prohibido);
    expect(cuerpo.toLowerCase()).not.toMatch(/vendedor|monitor|enlace/);

    const wb = await leerExcel(body);
    expect(wb.worksheets.map((w) => w.name)).toEqual([
      'Incompletos',
      'Completados',
      'Resumen',
    ]);
    const inc = wb.getWorksheet('Incompletos')!;
    const fi = filas(inc);
    expect(fi[0]).toEqual([
      'Póliza',
      'Asegurado',
      'Documento',
      'Producto',
      'Área',
      'Canal o productor',
      'Emitida el',
      'Días',
      'Qué falta / Observación',
      'Intentos de correo',
      'Último correo',
      'No enviar correos',
    ]);
    expect(inc.getCell('A1').font?.bold).toBe(true);
    expect(inc.views[0]).toMatchObject({ state: 'frozen', ySplit: 1 });
    expect(inc.autoFilter).toBeTruthy();
    // Más recientes primero; P-3 (de hace 3 días) al final.
    expect(fi.slice(1).map((f) => f[0])).toEqual([
      'P-2',
      'P-6',
      'P-5',
      'P-1',
      'P-3',
    ]);
    const filaP2 = fi[1];
    expect(filaP2.slice(0, 6)).toEqual([
      'P-2',
      'Juan Rojas',
      'V-84555221',
      'RCV',
      'Canales',
      'Farmatodo (canal 900)',
    ]);
    expect(filaP2[6]).toEqual(new Date(Date.UTC(2026, 10, 7)));
    expect(filaP2.slice(7)).toEqual([
      0,
      'Licencia ilegible; faltan cédula y certificado de circulación',
      0,
      'Sin correo válido · 07/11/2026',
      'No',
    ]);
    expect(fi[2][4]).toBe('Sin datos');
    expect(fi[3]).toEqual(
      expect.arrayContaining(['Excluido · 07/11/2026', 'Sí']),
    );
    expect(fi[4]).toEqual(
      expect.arrayContaining([
        'María José Pérez',
        'V-12345678',
        'Bloqueado · 07/11/2026',
      ]),
    );
    expect(fi[5][7]).toBe(3);

    const fc = filas(wb.getWorksheet('Completados')!);
    expect(fc[0]).toEqual([
      'Póliza',
      'Asegurado',
      'Documento',
      'Producto',
      'Área',
      'Canal o productor',
      'Emitida el',
      'Completado el',
    ]);
    expect(fc.slice(1).map((f) => [f[0], f[4], f[5]])).toEqual([
      ['P-9', 'Productores', 'Productor 777'],
      ['P-4', 'Canales', 'Farmatodo (canal 900)'],
    ]);
    expect(fc[2][7]).toEqual(new Date(Date.UTC(2026, 10, 7)));

    const fr = filas(wb.getWorksheet('Resumen')!);
    expect(fr.slice(0, 6)).toEqual([
      ['Cifra', 'Valor'],
      ['Completados', 2],
      ['Incompletos', 5],
      ['De canales', '1 completos / 4 incompletos'],
      ['De productores', '1 completos / 0 incompletos'],
      ['Sin datos de canal o productor', 1],
    ]);

    // Nunca el correo ni el teléfono del asegurado, tampoco en el Excel.
    const celdas = JSON.stringify(wb.worksheets.map(filas));
    expect(celdas).not.toContain('maria@test.com');
    expect(celdas).not.toContain('04141234567');
    expect(celdas.toLowerCase()).not.toContain('vendedor');
    // Sin datos personales en logs.
    const logs = JSON.stringify([
      (logger as any).warn.mock.calls,
      (logger as any).error.mock.calls,
      (logger as any).info.mock.calls,
    ]);
    for (const prohibido of ['12345678', 'maria@test.com', 'Rojas'])
      expect(logs).not.toContain(prohibido);

    const notif = db.mktExpedienteNotificacion
      ._rows()
      .find((n: any) => n.tipo === 'resumen_nocturno');
    expect(notif).toMatchObject({
      lote: 'nocturna:2026-11-07:canales',
      etapa: 0,
      resultado: 'enviado',
    });
  });

  it('caso cero: sale igual con 0 incompletos y el Excel con sus encabezados', async () => {
    await destinatarios();
    const id = await crear('P-4');
    expediente(id).estadoDocumental = 'completo';
    const r = await tareaNocturna(NOCHE);
    expect(r.resultado).toBe('enviado');
    const [body] = reporteCalls();
    expect(body.data).toMatchObject({
      completados: 1,
      incompletos: 0,
      canales: { completos: 1, incompletos: 0 },
      productores: { completos: 0, incompletos: 0 },
      sinDatos: 0,
    });
    const wb = await leerExcel(body);
    expect(filas(wb.getWorksheet('Incompletos')!)).toHaveLength(1);
    expect(filas(wb.getWorksheet('Completados')!)).toHaveLength(2);
  });

  it.each([400, 413, 422])(
    'nest-api sin la plantilla o sin adjuntos (%i): branded con las cifras y sin adjunto',
    async (status) => {
      await destinatarios();
      await crear('P-1', { documento: '12345678' });
      respuestaReporte = (t) =>
        t === 'expediente-reporte-diario-simple' ? status : 200;
      const r = await tareaNocturna(NOCHE);
      expect(r.resultado).toBe('enviado');
      expect(r.reportes[0].plantilla).toBe('branded');
      const calls = reporteCalls();
      expect(calls.map((x) => x.template)).toEqual([
        'expediente-reporte-diario-simple',
        'branded',
      ]);
      const branded = calls[1];
      expect(branded.attachments).toBeUndefined();
      expect(branded.data.subject).toBe(
        'Marketplace | Canales | Control documental diario – 07/11/2026',
      );
      expect(branded.data.fields).toEqual([
        { label: 'Completados', value: '0' },
        { label: 'Incompletos', value: '1' },
        { label: 'De canales', value: '0 completos / 1 incompletos' },
        { label: 'De productores', value: '0 completos / 0 incompletos' },
      ]);
      const json = JSON.stringify(branded);
      expect(json).not.toContain('P-1');
      expect(json).not.toContain('12345678');
      expect(json.toLowerCase()).not.toMatch(/excel|monitor|vendedor/);
    },
  );

  it('el reporte va en copia oculta (también el respaldo branded)', async () => {
    process.env.EXPEDIENTES_MAIL_WHITELIST = 'lm@test.com,lm2@test.com';
    await destinatarios(['lm@test.com', 'lm2@test.com']);
    await crear('P-1', { documento: '12345678' });
    respuestaReporte = (t) =>
      t === 'expediente-reporte-diario-simple' ? 400 : 200;
    const r = await tareaNocturna(NOCHE);
    expect(r.resultado).toBe('enviado');
    const calls = reporteCalls();
    expect(calls.map((x) => x.template)).toEqual([
      'expediente-reporte-diario-simple',
      'branded',
    ]);
    for (const b of calls) {
      expect(b.ocultarDestinatarios).toBe(true);
      expect([b.to, ...(b.toExtra ?? [])]).toEqual([
        'lm@test.com',
        'lm2@test.com',
      ]);
    }
  });

  it('error de entrega (500): no cae a branded y se reintenta', async () => {
    await destinatarios();
    respuestaReporte = () => 500;
    const r = await tareaNocturna(NOCHE);
    expect(r.reintentar).toBe(true);
    expect(reporteCalls().map((x) => x.template)).toEqual([
      'expediente-reporte-diario-simple',
    ]);
  });
});

describe('Excel del control documental: tope de tamaño', () => {
  const base = {
    poliza: 'P',
    asegurado: 'Nombre Apellido',
    documento: 'V-1',
    producto: 'RCV',
    area: 'Canales' as const,
    canalOProductor: 'Canal',
    emitidaEn: HOY,
  };
  const reporte = (inc: number, comp: number): ReporteSimple => ({
    grupo: 'canales',
    areas: 'Canales',
    fecha: '2026-11-07',
    fechaLocal: '07/11/2026',
    corte: '07/11/2026 23:00',
    cifras: cifrasControl([]),
    incompletos: Array.from({ length: inc }, (_, i) => ({
      ...base,
      poliza: `I-${i}`,
      dias: i,
      observacion: `Falta cédula ${'x'.repeat(40)} ${i}`,
      intentos: 1,
      ultimoCorreo: 'Enviado · 07/11/2026',
      noEnviar: false,
    })),
    completados: Array.from({ length: comp }, (_, i) => ({
      ...base,
      poliza: `C-${i}`,
      completadoEn: HOY,
    })),
  });

  it('quita primero completados y luego las incompletas más antiguas; el correo lo avisa', async () => {
    const r = reporte(1500, 1500);
    const completo = await excelReporteSimple(r);
    expect(completo.omitidas).toEqual({ incompletos: 0, completados: 0 });
    const soloInc = (await excelReporteSimple({ ...r, completados: [] })).buffer
      .length;
    // Cabe sin parte de los completados: las incompletas van todas.
    const tope = Math.floor((completo.buffer.length + soloInc) / 2);
    const x = await excelReporteSimple(r, tope);
    expect(x.buffer.length).toBeLessThanOrEqual(tope);
    expect(x.omitidas.incompletos).toBe(0);
    expect(x.omitidas.completados).toBeGreaterThan(0);
    // Ni sin completados cabe: se van todos y las incompletas más antiguas.
    const tope2 = Math.floor(soloInc * 0.6);
    const muyChico = await excelReporteSimple(r, tope2);
    expect(muyChico.buffer.length).toBeLessThanOrEqual(tope2);
    expect(muyChico.omitidas.completados).toBe(1500);
    expect(muyChico.omitidas.incompletos).toBeGreaterThan(0);
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(muyChico.buffer as any);
    const fi = filas(wb.getWorksheet('Incompletos')!);
    // Se conservan las primeras (las más recientes).
    expect(fi[1][0]).toBe('I-0');
    expect(fi).toHaveLength(1500 - muyChico.omitidas.incompletos + 1);
    const correo = correoReporteSimple(r, muyChico);
    expect(correo.reporteSimple?.data.omitidas).toEqual(muyChico.omitidas);
  });

  it('cifras: gestores en canales, sin información fuera y la suma cuadra', () => {
    expect(
      cifrasControl([
        { area: 'canal', estadoDocumental: 'completo' },
        { area: 'gestor', estadoDocumental: 'incompleto' },
        { area: 'productor', estadoDocumental: 'incompleto' },
        { area: 'desconocida', estadoDocumental: 'completo' },
        { area: 'canal', estadoDocumental: 'sin_informacion' },
      ]),
    ).toEqual({
      completados: 2,
      incompletos: 2,
      canales: { completos: 1, incompletos: 1 },
      productores: { completos: 0, incompletos: 1 },
      sinDatos: 1,
    });
  });
});

describe('reporte nocturno: reintentos', () => {
  function a(min: number) {
    const t = new Date(NOCHE.getTime() + min * MIN);
    vi.setSystemTime(t);
    return t;
  }

  it('si falla, alerta y reintenta en la misma noche sin duplicar el envío', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    await destinatarios();
    let fallar = true;
    respuestaReporte = () => (fallar ? 500 : 200);

    const base = await ejecutarJob('nocturna', { origen: 'auto', ahora: a(0) });
    expect(base).toMatchObject({ omitido: false, estado: 'ok' });
    expect((base as any).resumen).toMatchObject({
      resultado: 'error',
      reintentar: true,
    });
    const alertas = () =>
      db.mktExpedienteEvento
        ._rows()
        .filter((e: any) => e.tipo === 'reporte_nocturno_fallido');
    expect(alertas()).toHaveLength(1);
    expect(alertas()[0].detalle).toMatchObject({
      fecha: '2026-11-07',
      grupo: 'canales',
      intento: 0,
      reintentoPendiente: true,
    });

    // Antes de la espera (5 min) no reintenta.
    expect(await reintentarNocturna(a(2))).toBeNull();
    fallar = false;
    const r1 = await reintentarNocturna(a(5));
    expect(r1).toMatchObject({
      fecha: '2026-11-07~reintento~1',
      omitido: false,
      estado: 'ok',
    });
    expect((r1 as any).resumen).toMatchObject({
      intento: 1,
      resultado: 'enviado',
      reintentar: false,
    });
    expect(reporteCalls()).toHaveLength(2);

    // Ya salió: no hay más reintentos y el mismo reintento no corre dos veces.
    expect(await reintentarNocturna(a(60))).toBeNull();
    const repetido = await ejecutarJob('nocturna', {
      origen: 'auto',
      ahora: a(61),
      reintento: 1,
      fechaReporte: '2026-11-07',
    });
    expect(repetido).toMatchObject({ omitido: true });
    // Un reintento sobre un reporte ya enviado no lo repite.
    const r2 = await tareaNocturna(a(62), { fecha: '2026-11-07', intento: 2 });
    expect(r2.reportes[0].resultado).toBe('ya_enviado');
    expect(reporteCalls()).toHaveLength(2);

    const notifs = db.mktExpedienteNotificacion
      ._rows()
      .filter((n: any) => n.tipo === 'resumen_nocturno')
      .map((n: any) => [n.etapa, n.resultado, n.lote]);
    expect(notifs).toEqual([
      [0, 'error', 'nocturna:2026-11-07:canales'],
      [1, 'enviado', 'nocturna:2026-11-07:canales'],
    ]);
  });

  it('hasta 3 reintentos con espera creciente desde el scheduler; luego se detiene', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    await destinatarios();
    respuestaReporte = () => 500;
    expect(await tickScheduler(a(0))).toEqual(['diaria', 'nocturna']);
    expect(await tickScheduler(a(4))).toEqual([]);
    expect(await tickScheduler(a(5))).toEqual(['nocturna']);
    expect(await tickScheduler(a(19))).toEqual([]);
    expect(await tickScheduler(a(20))).toEqual(['nocturna']);
    expect(await tickScheduler(a(49))).toEqual([]);
    expect(await tickScheduler(a(50))).toEqual(['nocturna']);
    expect(await tickScheduler(a(120))).toEqual([]);
    expect(reporteCalls()).toHaveLength(4);
    const runs = db.mktExpedienteJobRun
      ._rows()
      .filter((r: any) => r.job === 'nocturna')
      .map((r: any) => r.fecha);
    expect(runs).toEqual([
      '2026-11-07',
      '2026-11-07~reintento~1',
      '2026-11-07~reintento~2',
      '2026-11-07~reintento~3',
    ]);
    const ultima = db.mktExpedienteEvento
      ._rows()
      .filter((e: any) => e.tipo === 'reporte_nocturno_fallido')
      .at(-1);
    expect(ultima.detalle).toMatchObject({
      intento: 3,
      reintentoPendiente: false,
    });
  });

  it('sin destinatarios no es un fallo de entrega: no reintenta', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const base = await ejecutarJob('nocturna', { origen: 'auto', ahora: a(0) });
    expect((base as any).resumen).toMatchObject({
      resultado: 'sin_correo',
      reintentar: false,
    });
    expect(await reintentarNocturna(a(30))).toBeNull();
  });

  it('intento que quedó «en curso» (proceso caído): pasados 20 minutos se reintenta', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    await destinatarios();
    await db.mktExpedienteJobRun.create({
      data: { job: 'nocturna', fecha: '2026-11-07', inicio: a(0) },
    });
    expect(await reintentarNocturna(a(10))).toBeNull();
    const r = await reintentarNocturna(a(25));
    expect(r).toMatchObject({ fecha: '2026-11-07~reintento~1', estado: 'ok' });
    expect(reporteCalls()).toHaveLength(1);
  });
});

describe('reporte nocturno: Productores (intermediarios)', () => {
  it('apagado por defecto; con la variable y su alcance sale aparte', async () => {
    await destinatarios(['lm@test.com'], { productores: true });
    await crear('P-1');
    await crear('P-9', {
      centidad: 'P',
      cproductor: '777',
      documento: '77666555',
    });

    const apagado = await tareaNocturna(NOCHE);
    expect(apagado.reportes[1]).toEqual({
      grupo: 'productores',
      resultado: 'deshabilitado',
    });
    let calls = reporteCalls();
    expect(calls).toHaveLength(1);
    // El reporte principal cubre todo el alcance: cuenta canales y productores por separado.
    expect(calls[0].data).toMatchObject({
      canales: { completos: 0, incompletos: 1 },
      productores: { completos: 0, incompletos: 1 },
    });

    process.env.EXPEDIENTES_RESUMEN_PRODUCTORES = 'true';
    process.env.EXPEDIENTES_RESUMEN_PRODUCTORES_DESTINATARIOS = 'prod@test.com';
    process.env.EXPEDIENTES_MAIL_WHITELIST = 'lm@test.com,prod@test.com';
    const encendido = await tareaNocturna(NOCHE);
    expect(encendido.reportes[1]).toMatchObject({
      grupo: 'productores',
      resultado: 'enviado',
      areas: 'Productores',
    });
    calls = reporteCalls();
    expect(calls).toHaveLength(3);
    const prod = calls[2];
    expect(prod.to).toBe('prod@test.com');
    expect(prod.data.subject).toBe(
      'Marketplace | Productores | Control documental diario – 07/11/2026',
    );
    expect(prod.data).toMatchObject({
      canales: { completos: 0, incompletos: 0 },
      productores: { completos: 0, incompletos: 1 },
    });
    const wb = await leerExcel(prod);
    expect(
      filas(wb.getWorksheet('Incompletos')!)
        .slice(1)
        .map((f) => [f[0], f[5]]),
    ).toEqual([['P-9', 'Productor 777']]);

    // Aprobado pero con el alcance de Productores apagado: no se genera.
    await destinatarios(['lm@test.com'], { productores: false });
    const sinAlcance = await tareaNocturna(NOCHE);
    expect(sinAlcance.reportes[1]).toEqual({
      grupo: 'productores',
      resultado: 'fuera_de_alcance',
    });
  });
});
