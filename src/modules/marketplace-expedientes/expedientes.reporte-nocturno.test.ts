/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * Reporte nocturno «Control documental diario» (correo 6): listado de incompletas de hoy con el
 * asegurado protegido, caso cero, tope de 200 filas, respaldo `branded`, reintentos sin
 * duplicar y Productores (intermediarios) apagado hasta su aprobación.
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

describe('reporte nocturno: listado de incompletas de hoy', () => {
  it('cifras del día, listado ordenado, asegurado protegido y conciliación', async () => {
    await destinatarios();
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
    });
    await crear('P-3', {
      documento: '99888777',
      emitida: new Date(HOY.getTime() - 86_400_000),
    });
    const p4 = await crear('P-4', { documento: '55666777' });
    await crear('P-5', { nombre: 'Ana', documento: '33444555' });
    expediente(p4).estadoDocumental = 'completo';
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
    // Conciliación: una emisión de Nexus de hoy sin expediente.
    await db.emision.create({
      data: {
        empresaId: 7,
        cotizacionId: 1,
        polizaNumero: 'P-1',
        createdAt: HOY,
      },
    });
    await db.emision.create({
      data: {
        empresaId: 7,
        cotizacionId: 2,
        polizaNumero: 'P-X',
        createdAt: HOY,
      },
    });
    // Recordatorios de la mañana: P-1 bloqueado (lista blanca), P-2 sin correo, P-5 excluido.
    // El reloj simulado deja las notificaciones en el día del reporte.
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(HOY.getTime() + 60 * MIN));
    await enviarRecordatorios(new Date(HOY.getTime() + 60 * MIN));
    vi.setSystemTime(NOCHE);

    const r = await tareaNocturna(NOCHE);
    expect(r).toMatchObject({
      fecha: '2026-11-07',
      intento: 0,
      resultado: 'enviado',
      reintentar: false,
    });
    expect(r.reportes).toEqual([
      expect.objectContaining({
        grupo: 'canales',
        resultado: 'enviado',
        plantilla: 'expediente-reporte-diario',
        emitidas: 4,
        incompletas: 3,
        listadas: 3,
        restantes: 0,
      }),
      { grupo: 'productores', resultado: 'deshabilitado' },
    ]);

    const [body] = reporteCalls();
    expect(body.template).toBe('expediente-reporte-diario');
    expect(body.to).toBe('lm@test.com');
    const d = body.data;
    expect(d.subject).toBe(
      'Marketplace | Canales | Control documental diario – 07/11/2026',
    );
    expect(d.corte).toBe('07/11/2026 23:00');
    expect(d.dia).toEqual({
      emitidas: 4,
      completas: 1,
      incompletas: 3,
      sinDatos: 0,
    });
    expect(d.distribucion).toEqual({
      faltantes: 8,
      ilegibles: 1,
      inconsistentes: 0,
      porValidar: 0,
    });
    // Primero lo que está mal (P-2), luego lo que falta.
    expect(d.polizas.map((f: any) => f.poliza)).toEqual(['P-2', 'P-1', 'P-5']);
    expect(d.polizas[0]).toEqual({
      poliza: 'P-2',
      asegurado: 'J. R. · V-84•••221',
      producto: 'RCV',
      emitidaPor: 'Farmatodo',
      observacion:
        'Licencia ilegible; faltan cédula y certificado de circulación',
      dias: 0,
      intentos: 0,
      ultimoResultado: 'Sin correo válido',
      noEnviar: false,
      siguienteAccion: 'Sin correo válido: gestionar por el canal',
    });
    expect(d.polizas[1]).toMatchObject({
      asegurado: 'M. P. · V-12•••678',
      observacion: 'Faltan cédula, licencia y certificado de circulación',
      intentos: 1,
      ultimoResultado: 'Bloqueado',
      noEnviar: false,
      siguienteAccion: 'Recordatorio el 10/11/2026',
    });
    expect(d.polizas[2]).toMatchObject({
      asegurado: 'A. · V-33•••555',
      ultimoResultado: 'Excluido',
      noEnviar: true,
      siguienteAccion: 'Excluido de correos',
    });
    expect(d.cartera).toMatchObject({ total: 5, completos: 1, incompletos: 4 });
    expect(d.cartera.desglose).toEqual(
      expect.arrayContaining([
        { label: 'Con errores', valor: 1 },
        { label: 'Faltan documentos', valor: 3 },
      ]),
    );
    expect(d.historicos).toEqual({
      anteriores: 1,
      sinRespuesta: 0,
      sinCorreoValido: 1,
      noEnviar: 1,
    });
    // Del día (P-3 es de ayer): 4 en el monitor; P-X no tiene expediente.
    expect(d.conciliacion).toEqual({
      emisionesNexus: 2,
      enMonitor: 4,
      noPasaronOcr: 0,
      sinVinculo: 1,
    });
    expect(d.entregabilidad).toMatchObject({
      intentos: 2,
      entregados: 0,
      bloqueados: 2,
      sinCorreo: 1,
      excluidos: 1,
    });
    expect(d.enlace ?? null).toBeNull();

    // Nunca el documento completo, el correo, el teléfono ni el nombre del asegurado.
    const json = JSON.stringify(body);
    for (const prohibido of [
      '12345678',
      '84555221',
      'maria@test.com',
      '04141234567',
      'María',
      'Pérez',
      'Rojas',
    ])
      expect(json).not.toContain(prohibido);
    expect(json.toLowerCase()).not.toMatch(/vendedor|sin información/);

    // Evidencia: notificación del reporte con su lote y el intento.
    const notif = db.mktExpedienteNotificacion
      ._rows()
      .find((n: any) => n.tipo === 'resumen_nocturno');
    expect(notif).toMatchObject({
      lote: 'nocturna:2026-11-07:canales',
      etapa: 0,
      resultado: 'enviado',
      destinatarioMasked: 'l*@test.com',
    });
    // Sin datos personales en logs.
    const logs = JSON.stringify((logger as any).warn.mock.calls);
    expect(logs).not.toContain('12345678');
    expect(logs).not.toContain('maria@test.com');
  });

  it('cero pendientes del día: se envía igual con el total emitido y la conciliación', async () => {
    await destinatarios();
    const vacio = await tareaNocturna(NOCHE);
    expect(vacio.resultado).toBe('enviado');
    const id = await crear('P-4');
    expediente(id).estadoDocumental = 'completo';
    await crear('P-3', { emitida: new Date(HOY.getTime() - 86_400_000) });
    const r = await tareaNocturna(NOCHE);
    expect(r.resultado).toBe('enviado');
    const calls = reporteCalls();
    expect(calls).toHaveLength(2);
    expect(calls[0].data.dia).toMatchObject({ emitidas: 0, incompletas: 0 });
    const d = calls[1].data;
    expect(d.dia).toMatchObject({ emitidas: 1, completas: 1, incompletas: 0 });
    expect(d.polizas).toEqual([]);
    expect(d.polizasRestantes).toBe(0);
    expect(d.historicos.anteriores).toBe(1);
    expect(d.conciliacion).toMatchObject({ sinVinculo: 0 });
  });

  it('más de 200 incompletas: lista 200 y dice cuántas quedan en el monitor', async () => {
    await destinatarios();
    for (let i = 0; i < 205; i++)
      await crear(`P-${1000 + i}`, { documento: String(20000000 + i) });
    const r = await tareaNocturna(NOCHE);
    expect(r.reportes[0]).toMatchObject({
      incompletas: 205,
      listadas: 200,
      restantes: 5,
    });
    const d = reporteCalls()[0].data;
    expect(d.polizas).toHaveLength(200);
    expect(d.polizasRestantes).toBe(5);
    expect(d.dia.incompletas).toBe(205);
  });

  it('nest-api viejo (400): sale con branded solo con cifras', async () => {
    await destinatarios();
    await crear('P-1', { documento: '12345678' });
    respuestaReporte = (t) => (t === 'expediente-reporte-diario' ? 400 : 200);
    const r = await tareaNocturna(NOCHE);
    expect(r.resultado).toBe('enviado');
    expect(r.reportes[0].plantilla).toBe('branded');
    const calls = reporteCalls();
    expect(calls.map((c) => c.template)).toEqual([
      'expediente-reporte-diario',
      'branded',
    ]);
    const branded = calls[1].data;
    expect(branded.subject).toBe(
      'Marketplace | Canales | Control documental diario – 07/11/2026',
    );
    expect(branded.fields.map((f: any) => f.label)).toContain('Emitidas hoy');
    expect(JSON.stringify(branded)).not.toContain('P-1');
    expect(JSON.stringify(branded)).not.toContain('12345678');
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
    // El reporte de Canales no lleva pólizas de productores.
    expect(calls[0].data.polizas.map((f: any) => f.poliza)).toEqual(['P-1']);

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
    expect(prod.data.polizas).toEqual([
      expect.objectContaining({ poliza: 'P-9', emitidaPor: 'Productor 777' }),
    ]);

    // Aprobado pero con el alcance de Productores apagado: no se genera.
    await destinatarios(['lm@test.com'], { productores: false });
    const sinAlcance = await tareaNocturna(NOCHE);
    expect(sinAlcance.reportes[1]).toEqual({
      grupo: 'productores',
      resultado: 'fuera_de_alcance',
    });
  });
});
