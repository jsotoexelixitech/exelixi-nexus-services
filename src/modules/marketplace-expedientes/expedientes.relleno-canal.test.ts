/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * Canal siempre identificado (12-nov-2026): el canal o productor sale de la póliza en Sis2000
 * (nest-api /v1/canal/polizas-emisor), del catálogo o de la cotización; se guarda en el
 * expediente y el relleno es idempotente. Nunca un login ni correo en «emitida por».
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
import { emitidaPor } from './expedientes.reporte';
import {
  contarPendientesCanal,
  rellenoCanales,
} from './expedientes.relleno-canal';

const db = prisma as any;
const HOY = new Date('2026-11-12T12:00:00Z');
let sis2000: Record<string, Record<string, unknown>> = {};
let fetchMock: ReturnType<typeof vi.fn>;

async function exp(cnpoliza: string, over: Record<string, any> = {}) {
  return db.mktExpediente.create({
    data: {
      empresaId: 7,
      cnpoliza,
      producto: 'rcv',
      area: 'gestor',
      estadoDocumental: 'incompleto',
      emitidaEn: HOY,
      ...over,
    },
  });
}

const leer = async (cnpoliza: string) =>
  (await db.mktExpediente.findMany({ where: {} })).find(
    (e: any) => e.cnpoliza === cnpoliza,
  );

beforeEach(() => {
  db.$reset();
  process.env.NEST_API_KEY = 'k';
  _resetCatalogoCanales({
    nombres: new Map([['27', 'OS_LMDS']]),
    gestorCanal: new Map(),
    canales: [],
  });
  sis2000 = {};
  fetchMock = vi.fn(async (url: unknown) => {
    const u = new URL(String(url));
    const pols = (u.searchParams.get('cnpoliza') ?? '').split(',');
    const data = pols.filter((p) => sis2000[p]).map((p) => ({ cnpoliza: p, ...sis2000[p] }));
    return new Response(JSON.stringify({ status: true, data }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  });
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('relleno de canal desde Sis2000', () => {
  it('vista previa: cuenta por fuente sin escribir; ejecutar guarda y es idempotente', async () => {
    // Gestor sin canal en magestor: el canal está en la póliza.
    await exp('P-1', { centidad: 'G', cgestor: '749' });
    // Gestor sin canal y la póliza solo trae el productor: Productores.
    await exp('P-2', { centidad: 'P', cgestor: '80058' });
    // Login del SSO como cgestor y nada en Sis2000: pendiente, nunca el login.
    await exp('P-3', { centidad: 'P', cgestor: 'usuario@ejemplo.com', xlogin: 'usuario@ejemplo.com' });
    // Ya identificado: no se consulta.
    await exp('P-4', { area: 'canal', centidad: 'C', ccanalalt: '27' });
    sis2000 = {
      'P-1': { ccanalalt: 27, xcanalalt: 'OS_LMDS', cproductor: 80080, xproductor: 'X' },
      'P-2': { ccanalalt: null, cproductor: 215, xproductor: 'CORRETAJE ABC' },
    };

    const previa = await rellenoCanales();
    expect(previa).toMatchObject({
      ejecutado: false,
      revisados: 4,
      yaIdentificados: 1,
      resueltos: { poliza_sis2000: 2, catalogo: 0, cotizacion: 0 },
      resueltosPorGrupo: { canal: 1, productor: 1 },
      sinCanal: 1,
      polizasSinCanal: ['P-3'],
      actualizados: 0,
      sis2000Disponible: true,
    });
    expect((await leer('P-1')).ccanalalt ?? null).toBeNull();
    // Solo pide las pólizas pendientes.
    const pedidas = String(fetchMock.mock.calls[0][0]);
    expect(pedidas).toContain('polizas-emisor');
    expect(decodeURIComponent(pedidas)).not.toContain('P-4');

    const hecho = await rellenoCanales({ ejecutar: true });
    expect(hecho.actualizados).toBe(2);
    const p1 = await leer('P-1');
    expect(p1.ccanalalt).toBe('27');
    expect(p1.snapshot.emisorResuelto.fuente).toBe('poliza_sis2000');
    expect(emitidaPor(p1)).toBe('OS_LMDS (canal 27-749)');
    const p2 = await leer('P-2');
    expect(p2.cproductor).toBe('215');
    expect(emitidaPor(p2)).toBe('CORRETAJE ABC (productor 215)');
    expect(emitidaPor(await leer('P-3'))).toBe('Pendiente de identificar canal');

    // Idempotente: lo resuelto no se vuelve a consultar ni a escribir.
    fetchMock.mockClear();
    const otra = await rellenoCanales({ ejecutar: true });
    expect(otra.actualizados).toBe(0);
    expect(otra.yaIdentificados).toBe(3);
    expect(decodeURIComponent(String(fetchMock.mock.calls[0]?.[0] ?? ''))).not.toContain('P-1');

    expect(await contarPendientesCanal()).toEqual({ pendientes: 1, polizas: ['P-3'] });
  });

  it('desconocida: con canal en Sis2000 pasa a Canales; nest-api sin la ruta (404) no rompe', async () => {
    await exp('P-9', { area: 'desconocida' });
    sis2000 = { 'P-9': { ccanalalt: 27, xcanalalt: 'OS_LMDS' } };
    await rellenoCanales({ ejecutar: true });
    const p9 = await leer('P-9');
    expect(p9.area).toBe('canal');
    expect(emitidaPor(p9)).toBe('OS_LMDS (canal 27)');

    await exp('P-10', { area: 'desconocida' });
    fetchMock.mockImplementation(async () => new Response('{}', { status: 404 }));
    const r = await rellenoCanales({ ejecutar: true });
    expect(r.sis2000Disponible).toBe(false);
    expect(r.polizasSinCanal).toEqual(['P-10']);
  });
});
