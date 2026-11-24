/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * Conciliación con el OCR (pólizas registradas sin datos del expediente) y regla de áreas:
 * solo Canales y Productores; gestores y puntos de comercialización cuentan en su canal.
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
import { areaDesdeVendedor, mergeConfig } from './expedientes.domain';
import {
  cedulasCandidatas,
  documentosDesdeOcr,
  ExpedientesService,
} from './expedientes.service';
import { tareaNocturna } from './expedientes.tareas';

const db = prisma as any;
const svc = new ExpedientesService();

/** Respuestas de /localizar por número de póliza; null = OCR caído (HTTP 503). */
let ocr: Record<string, any> | null;
let fetchMock: ReturnType<typeof vi.fn>;
const llamadasLocalizar = () =>
  fetchMock.mock.calls.filter(([u]) => String(u).endsWith('/localizar'));

beforeEach(() => {
  db.$reset();
  _resetCatalogoCanales();
  process.env.EXPEDIENTES_ENABLED = 'true';
  process.env.OCR_INTERNAL_URL = 'http://ocr.local';
  process.env.EXPEDIENTE_INTERNAL_KEY = 'k';
  delete process.env.NEST_API_KEY;
  delete process.env.NEST_SERVICE_API_KEY;
  ocr = {};
  fetchMock = vi.fn(async (url: string, init: any) => {
    if (String(url).endsWith('/localizar')) {
      if (!ocr) return new Response('{}', { status: 503 });
      const body = JSON.parse(init.body);
      const r = ocr[body.cnpoliza] ?? {
        ubicacion: null,
        carpeta: null,
        documentos: {},
      };
      return new Response(JSON.stringify({ ok: true, ...r }), { status: 200 });
    }
    // Validación con IA en segundo plano: error técnico (no interesa aquí).
    return new Response(JSON.stringify({ ok: false }), { status: 500 });
  });
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.OCR_INTERNAL_URL;
  delete process.env.EXPEDIENTE_INTERNAL_KEY;
});

async function emisionDb(id: number, poliza: string, jd: any = {}) {
  return db.emision.create({
    data: {
      id,
      empresaId: 7,
      polizaNumero: poliza,
      createdAt: new Date(),
      jsonData: {
        producto: 'rcv',
        tomadorIdentificacion: 'V-12345678',
        tomadorNombre: 'Ana Pérez',
        ...jd,
      },
    },
  });
}

const carpeta = 'La Mundial de Seguros/12345678/1-26-10-1100000001';
const conDocs = {
  ubicacion: 'poliza',
  carpeta,
  documentos: {
    cedula: `${carpeta}/cedula.webp`,
    licencia: `${carpeta}/licencia.jpg`,
  },
};

describe('conciliación con el OCR', () => {
  it('con documentos en el OCR: expediente con lo recibido y origen conciliacion_ocr', async () => {
    await emisionDb(1, '1100000001');
    ocr = { '1100000001': conDocs };
    const r = await svc.conciliar();
    expect(r).toMatchObject({ creadas: 1, errores: 0 });
    expect(r.ocr).toMatchObject({ conExpediente: 1, descartadas: 0 });
    const [body] = llamadasLocalizar().map(([, i]) => JSON.parse(i.body));
    expect(body.cedulas).toContain('12345678');
    const [exp] = db.mktExpediente._rows();
    expect(exp).toMatchObject({
      origen: 'conciliacion_ocr',
      infoDocumental: true,
      estadoDocumental: 'incompleto',
      carpetaExpediente: carpeta,
    });
    const reqs = db.mktExpedienteRequisito._rows();
    const por = Object.fromEntries(reqs.map((x: any) => [x.tipo, x]));
    expect(por.cedula).toMatchObject({
      estado: 'recibido',
      origen: 'conciliacion_ocr',
      ref: `${carpeta}/cedula.webp`,
    });
    expect(por.licencia.estado).toBe('recibido');
    expect(por.certificado.estado).toBe('faltante');
  });

  it('sin rastro en el OCR: descartada (fila conservada) y fuera de bandeja, indicadores y resumen', async () => {
    await emisionDb(1, '1100000001');
    await emisionDb(2, '1100000002');
    ocr = { '1100000001': conDocs };
    const r = await svc.conciliar();
    expect(r.ocr).toMatchObject({ conExpediente: 1, descartadas: 1 });
    const filas = db.mktExpediente._rows();
    expect(filas).toHaveLength(2);
    expect(
      filas.find((x: any) => x.cnpoliza === '1100000002').estadoDocumental,
    ).toBe('descartada');
    expect((await svc.listar({})).total).toBe(1);
    const ind = await svc.indicadores({});
    expect(ind.total).toBe(1);
    expect(ind.kpis.porProducto.reduce((a, x) => a + x.total, 0)).toBe(1);
    // Segunda corrida: ya tiene fila; no se vuelve a preguntar al OCR.
    fetchMock.mockClear();
    await svc.conciliar();
    expect(llamadasLocalizar()).toHaveLength(0);
    // Resumen nocturno: la descartada no cuenta.
    db.mktExpedienteConfig.create({
      data: { clave: 'global', valor: { destinatariosResumen: [] } },
    });
    const noct: any = await tareaNocturna(new Date());
    expect(JSON.stringify(noct)).not.toContain('descartada');
  });

  it('OCR sin respuesta: no se descarta nada y se reprocesa en la próxima corrida', async () => {
    await emisionDb(1, '1100000001');
    await emisionDb(2, '1100000002');
    ocr = null;
    const r = await svc.conciliar();
    expect(r.ocr.descartadas).toBe(0);
    expect(r.ocr.sinRespuesta).toBeGreaterThan(0);
    // Tras la primera falla no se insiste en la misma corrida.
    expect(llamadasLocalizar()).toHaveLength(1);
    const filas = db.mktExpediente._rows();
    expect(filas.map((x: any) => x.estadoDocumental)).toEqual([
      'sin_informacion',
      'sin_informacion',
    ]);
    // Vuelve el OCR: se reprocesan las sin_informacion.
    ocr = { '1100000001': conDocs };
    const r2 = await svc.conciliar();
    expect(r2.ocr).toMatchObject({ reprocesadas: 2, descartadas: 1 });
    const por = Object.fromEntries(
      db.mktExpediente._rows().map((x: any) => [x.cnpoliza, x]),
    );
    expect(por['1100000001']).toMatchObject({
      infoDocumental: true,
      origen: 'conciliacion_ocr',
      estadoDocumental: 'incompleto',
    });
    expect(por['1100000002'].estadoDocumental).toBe('descartada');
    expect(
      db.mktExpedienteEvento
        ._rows()
        .some((e: any) => e.tipo === 'expediente_descartado'),
    ).toBe(true);
  });

  it('pendiente sin archivos también es rastro del OCR: expediente con todo faltante', async () => {
    await emisionDb(1, '1100000003');
    ocr = {
      '1100000003': {
        ubicacion: 'pendiente',
        carpeta: 'La Mundial de Seguros/12345678/pendiente',
        documentos: {},
      },
    };
    await svc.conciliar();
    const [exp] = db.mktExpediente._rows();
    expect(exp).toMatchObject({
      infoDocumental: true,
      estadoDocumental: 'incompleto',
      carpetaExpediente: null,
    });
  });

  it('una descartada vuelve al monitor si después llega el bloque expediente', async () => {
    await emisionDb(1, '1100000002');
    await svc.conciliar();
    expect(db.mktExpediente._rows()[0].estadoDocumental).toBe('descartada');
    await svc.registrarDesdeEmision(
      { id: 1, empresaId: 7, polizaNumero: '1100000002', jsonData: {} },
      { expediente: { version: 1, centidad: 'C', ccanalalt: '900' } },
    );
    expect(db.mktExpediente._rows()[0].estadoDocumental).toBe('incompleto');
  });

  it('el registro con bloque expediente no consulta al OCR', async () => {
    await emisionDb(1, '1100000009', {
      expediente: { version: 1, centidad: 'C', ccanalalt: '900' },
    });
    await svc.conciliar();
    expect(llamadasLocalizar()).toHaveLength(0);
    expect(db.mktExpediente._rows()[0].origen).toBe('conciliacion');
  });

  it('cédulas candidatas del jsonData y documentos del OCR por requisito', () => {
    expect(
      cedulasCandidatas(['V-12.345.678', null], {
        tomador: { identificacion: '7654321' },
        rif: 'V-12345678-9',
        monto: 123456,
        expediente: { asegurado: { documento: '99999999' } },
      }),
    ).toEqual(['12345678', '7654321', '123456789']);
    expect(
      documentosDesdeOcr({ cedula_titular: 'a/cedula_titular.webp' }),
    ).toEqual({
      cedula_titular: { recibido: true, ref: 'a/cedula_titular.webp' },
      cedula: { recibido: true, ref: 'a/cedula_titular.webp' },
    });
  });
});

describe('áreas: Canales y Productores (gestores cuentan en su canal)', () => {
  let n = 0;
  beforeEach(() => {
    n = 0;
  });
  async function exp(over: Record<string, any> = {}) {
    n++;
    return db.mktExpediente.create({
      data: {
        empresaId: 7,
        cnpoliza: `X-${n}`,
        producto: 'rcv',
        area: 'canal',
        emitidaEn: new Date(Date.now() - 86_400_000),
        ...over,
      },
    });
  }

  it('una póliza de gestor incompleta suma al incompleto de su canal', async () => {
    await exp({ ccanalalt: '900', estadoDocumental: 'completo' });
    await exp({
      area: 'gestor',
      centidad: 'G',
      citem: '12',
      cgestor: '12',
      ccanalalt: '900',
    });
    const ind = await svc.indicadores({});
    expect(ind.incompletos).toBe(1);
    expect(ind.kpis.porCanal).toEqual([
      {
        codigo: '900',
        nombre: null,
        total: 2,
        completos: 1,
        incompletos: 1,
        pctIncompletos: 0.5,
      },
    ]);
    // El área visible del gestor es canal.
    const lista = await svc.listar({ area: 'C' });
    expect(lista.total).toBe(2);
    expect(lista.items.every((i: any) => i.area === 'canal')).toBe(true);
    expect(lista.items.every((i: any) => i.areaCodigo === 'C')).toBe(true);
    // El dato guardado no cambia.
    expect(db.mktExpediente._rows()[1].area).toBe('gestor');
  });

  it('gestor sin ccanalalt: canal del catálogo de nest-api; si no, «Canal sin identificar»', async () => {
    await exp({ area: 'gestor', centidad: 'G', citem: '12', cgestor: '12' });
    await exp({ area: 'gestor', centidad: 'G', citem: '77', cgestor: '77' });
    _resetCatalogoCanales({
      nombres: new Map([['900', 'CANAL DIGITAL']]),
      gestorCanal: new Map([['12', '900']]),
    });
    const k = (await svc.indicadores({})).kpis;
    expect(k.porCanal.map((x) => [x.codigo, x.nombre, x.incompletos])).toEqual([
      ['900', 'CANAL DIGITAL', 1],
      ['SIN_IDENTIFICAR', 'Canal sin identificar', 1],
    ]);
    // Clic en el canal del ranking: la bandeja se filtra por ese canal.
    const del900 = await svc.listar({ canal: '900' });
    expect(del900.items.map((i: any) => i.cnpoliza)).toEqual(['X-1']);
    const sinId = await svc.listar({ canal: 'SIN_IDENTIFICAR' });
    expect(sinId.items.map((i: any) => i.cnpoliza)).toEqual(['X-2']);
  });

  it('ranking ordenado por % de incompletos y luego por cantidad; productores aparte', async () => {
    await db.mktExpedienteConfig.create({
      data: {
        clave: 'global',
        valor: {
          alcance: {
            canales: true,
            productores: true,
            desconocida: true,
          },
        },
      },
    });
    await exp({ ccanalalt: 'A', estadoDocumental: 'completo' });
    await exp({ ccanalalt: 'A' });
    await exp({ ccanalalt: 'B' });
    await exp({ ccanalalt: 'C' });
    await exp({ ccanalalt: 'C' });
    await exp({ area: 'productor', centidad: 'P', citem: '501' });
    const k = (await svc.indicadores({})).kpis;
    expect(k.porCanal.map((x) => x.codigo)).toEqual(['C', 'B', 'A']);
    expect(k.porProductor).toEqual([
      {
        codigo: '501',
        nombre: null,
        total: 1,
        completos: 0,
        incompletos: 1,
        pctIncompletos: 1,
      },
    ]);
    expect((await svc.listar({ productor: '501' })).total).toBe(1);
  });

  it('alcance: los gestores siguen a los canales; otras entidades de canal cuentan en canales', () => {
    expect(
      mergeConfig({ alcance: { canales: false, gestores: true } }).alcance
        .gestores,
    ).toBe(false);
    expect(mergeConfig({ alcance: { canales: true } }).alcance.gestores).toBe(
      true,
    );
    expect(areaDesdeVendedor({ centidad: 'S' })).toBe('canal');
    expect(areaDesdeVendedor({ centidad: 'P' })).toBe('productor');
    expect(areaDesdeVendedor({})).toBe('desconocida');
  });
});
