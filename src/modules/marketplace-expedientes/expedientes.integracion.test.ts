/* eslint-disable @typescript-eslint/no-explicit-any */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import request from 'supertest';

vi.mock('../../config/prisma', async () => {
  const { createFakePrisma } = await import('./test-utils/fake-prisma');
  return { default: createFakePrisma() };
});
vi.mock('../../utils/logger', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
// Sin sesión del portal: la API de integradores usa su propia clave interna.
vi.mock('../../middlewares/auth.middleware', () => ({
  authenticate: (_req: any, res: any) =>
    res.status(401).json({ success: false }),
}));
vi.mock('../portal/portal-admin.middleware', () => ({
  requirePortalAdmin: (_req: any, res: any) =>
    res.status(403).json({ success: false }),
}));

import prisma from '../../config/prisma';
import router from './expedientes.routes';
import {
  DEFAULT_CONFIG,
  normalizarProducto,
  requisitoLabel,
  requisitosAplicables,
} from './expedientes.domain';
import {
  armarRequisitos,
  contextoDeRequisito,
  documentoComparable,
  estadoContrato,
  tipoDocumentoDeRequisito,
} from './expedientes.integracion.domain';
import { detectarTipoArchivo } from './expedientes.files';
import { expedientesService as svc } from './expedientes.service';

const db = prisma as any;
const app = express();
app.use(express.json());
app.use('/api/expedientes', router);

const KEY = { 'x-expediente-key': 'clave-integracion' };
const PASTORA = 'key:pastora-0001';
const VIAJERO = 'key:viajero-0001';
const OTRO = 'key:otro-integrador';

const JPG = Buffer.concat([
  Buffer.from([0xff, 0xd8, 0xff, 0xe0]),
  Buffer.alloc(200, 1),
]);
const WEBP = Buffer.concat([
  Buffer.from('RIFF'),
  Buffer.from([0x10, 0, 0, 0]),
  Buffer.from('WEBPVP8 '),
  Buffer.alloc(200, 1),
]);

let fetchMock: ReturnType<typeof vi.fn>;
let ocrExtraido: Record<string, unknown>;

function respuesta(status: number, body: unknown) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

const esperar = () => new Promise((r) => setTimeout(r, 30));

function registroPastora(extra: Record<string, unknown> = {}) {
  return {
    integrador: PASTORA,
    apiKeyId: 'pastora-0001',
    producto: 'pastora',
    cnpoliza: '2501-000123',
    cnrecibo: '9001',
    cramo: 25,
    cplan: 'PAS06',
    canal: { ccanalalt: '27', xcanalVenta: 'PASTORA' },
    tomador: {
      tipoDoc: 'J',
      documento: '412345678',
      nombre: 'Agropecuaria La Pastora',
    },
    ...extra,
  };
}

function registroViajero() {
  return {
    integrador: VIAJERO,
    producto: 'viajero',
    cnpoliza: '2501-000777',
    cramo: 25,
    cplan: 'VIAJE4',
    canal: { xcanalVenta: 'MARGARITA TOURS' },
    tomador: { tipoDoc: 'V', documento: '11222333', nombre: 'Ana' },
    personas: [
      { tipoDoc: 'V', documento: '11222333', nombre: 'Ana', apellido: 'Díaz' },
      {
        tipoDoc: 'P',
        documento: 'P-EM2849387',
        nombre: 'John',
        apellido: 'Smith',
      },
      // Repetido: un solo requisito por persona.
      { tipoDoc: 'V', documento: 'V-11.222.333', nombre: 'Ana' },
    ],
  };
}

async function registrar(body: object) {
  return request(app)
    .post('/api/expedientes/integracion/registro')
    .set(KEY)
    .send(body);
}

function estado(integrador: string, poliza: string) {
  return request(app)
    .get(`/api/expedientes/integracion/polizas/${poliza}`)
    .set(KEY)
    .set('x-integrador', integrador);
}

function subir(
  integrador: string,
  poliza: string,
  campos: Record<string, string>,
  archivo: Buffer = JPG,
  nombre = 'doc.jpg',
) {
  let r = request(app)
    .post(`/api/expedientes/integracion/polizas/${poliza}/documentos`)
    .set(KEY)
    .set('x-integrador', integrador);
  for (const [k, v] of Object.entries(campos)) r = r.field(k, v);
  return r.attach('file', archivo, nombre);
}

beforeEach(() => {
  db.$reset();
  process.env.EXPEDIENTES_ENABLED = 'true';
  process.env.EXPEDIENTES_INTEGRACION_KEY = 'clave-integracion';
  process.env.EXPEDIENTES_INTEGRACION_EMPRESA_ID = '7';
  delete process.env.PORTAL_SIS2000_EMPRESA_ID;
  delete process.env.OCR_INTERNAL_URL;
  delete process.env.EXPEDIENTE_INTERNAL_KEY;
  ocrExtraido = {};
  fetchMock = vi.fn(async (url: string) => {
    if (String(url).includes('/api/internal/expedientes/documento'))
      return respuesta(200, {
        ok: true,
        ref: `exp/${Math.random()}.jpg`,
        ocr: { extraido: ocrExtraido, confianza: 1, proveedor: 'test' },
      });
    return respuesta(200, { status: true, data: { sent: true } });
  });
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function conOcr() {
  process.env.OCR_INTERNAL_URL = 'http://ocr.local';
  process.env.EXPEDIENTE_INTERNAL_KEY = 'clave-ocr';
}

describe('reglas puras de integración', () => {
  it('productos nuevos sin romper RCV/personas', () => {
    expect(normalizarProducto(null, 'pastora')).toBe('pastora');
    expect(normalizarProducto(null, 'viajero')).toBe('viajero');
    expect(normalizarProducto('RCV moto', null)).toBe('rcv');
    expect(normalizarProducto('funerario', null)).toBe('personas');
    expect(requisitosAplicables('rcv', DEFAULT_CONFIG)).toEqual([
      'cedula',
      'licencia',
      'certificado',
    ]);
    expect(requisitosAplicables('pastora', DEFAULT_CONFIG)).toEqual([
      'cedula',
    ]);
    // Expediente de RCV sin integración: la lista de siempre.
    expect(
      requisitosAplicables(
        { producto: 'rcv', snapshot: { vehiculo: {} } },
        DEFAULT_CONFIG,
      ),
    ).toEqual(['cedula', 'licencia', 'certificado']);
  });

  it('viajero: un requisito por persona, sin repetir documento', () => {
    const r = armarRequisitos('viajero', null, registroViajero().personas);
    expect(r.requisitos).toEqual(['viajero_1', 'viajero_2']);
    expect(r.personas[1]).toMatchObject({
      tipoDoc: 'P',
      documento: 'EM2849387',
    });
    expect(
      requisitosAplicables(
        {
          producto: 'viajero',
          snapshot: { integracion: { requisitos: r.requisitos } },
        },
        DEFAULT_CONFIG,
      ),
    ).toEqual(['viajero_1', 'viajero_2']);
    expect(requisitoLabel('viajero_2')).toBe(
      'Cédula o pasaporte del viajero 2',
    );
    expect(requisitoLabel('cedula')).toBe('Cédula de identidad');
  });

  it('tipo de documento y contexto por requisito', () => {
    const { requisitos, personas } = armarRequisitos(
      'viajero',
      null,
      registroViajero().personas,
    );
    const exp = {
      snapshot: {
        integracion: {
          integrador: VIAJERO,
          producto: 'viajero',
          requisitos,
          personas,
          recibidos: { viajero_1: { tipo: 'cedula', en: 'x' } },
        },
      },
    };
    expect(tipoDocumentoDeRequisito(exp, 'viajero_1')).toBe('cedula');
    expect(tipoDocumentoDeRequisito(exp, 'viajero_2')).toBe('pasaporte');
    // Fuera de integración: el mismo requisito.
    expect(tipoDocumentoDeRequisito({ snapshot: {} }, 'licencia')).toBe(
      'licencia',
    );
    const ctx = contextoDeRequisito(
      { personas: [], vehiculo: null, producto: 'viajero' },
      exp,
      'viajero_2',
    );
    expect(ctx.personas).toHaveLength(1);
    expect(ctx.personas[0]).toMatchObject({
      documento: 'EM2849387',
      roles: ['tomador', 'asegurado'],
    });
    expect(documentoComparable('P-EM2849387')).toBe('EM2849387');
    expect(documentoComparable('V-11.222.333')).toBe('11222333');
  });

  it('estados del contrato', () => {
    expect(estadoContrato('faltante')).toBe('pendiente');
    expect(estadoContrato('sin_informacion')).toBe('pendiente');
    expect(estadoContrato('recibido')).toBe('recibido');
    expect(estadoContrato('validado')).toBe('validado');
    expect(estadoContrato('observado')).toBe('por_corregir');
  });

  it('WEBP solo cuando se pide', () => {
    expect(detectarTipoArchivo(WEBP)).toBeNull();
    expect(detectarTipoArchivo(WEBP, { webp: true })).toBe('image/webp');
  });
});

describe('/api/expedientes/integracion', () => {
  it('sin clave configurada 503; clave errada 401', async () => {
    delete process.env.EXPEDIENTES_INTEGRACION_KEY;
    const sin = await registrar(registroPastora());
    expect(sin.status).toBe(503);
    process.env.EXPEDIENTES_INTEGRACION_KEY = 'clave-integracion';
    const mala = await request(app)
      .post('/api/expedientes/integracion/registro')
      .set('x-expediente-key', 'otra')
      .send(registroPastora());
    expect(mala.status).toBe(401);
  });

  it('registra Pastora en el monitor (área canal) y es idempotente', async () => {
    const r = await registrar(registroPastora());
    expect(r.status).toBe(201);
    expect(r.body.data.creado).toBe(true);
    const exp = db.mktExpediente._rows()[0];
    expect(exp).toMatchObject({
      empresaId: 7,
      producto: 'pastora',
      area: 'canal',
      ccanalalt: '27',
      origen: 'integracion',
      estadoDocumental: 'incompleto',
    });
    expect(exp.snapshot.correos).toEqual([]);
    const reqs = db.mktExpedienteRequisito._rows();
    expect(reqs.map((x: any) => [x.tipo, x.estado])).toEqual([
      ['cedula', 'faltante'],
    ]);
    // Aparece en el listado del monitor como cualquier otra.
    const lista = await svc.listar({ page: 1, pageSize: 20 } as any);
    expect(JSON.stringify(lista)).toContain('2501-000123');

    const otra = await registrar(registroPastora());
    expect(otra.status).toBe(201);
    expect(otra.body.data.creado).toBe(false);
    // Otro integrador no se apropia de la póliza.
    const ajena = await registrar(registroPastora({ integrador: OTRO }));
    expect(ajena.status).toBe(409);
  });

  it('estado: pendiente con el tipo esperado; otra apikey 404', async () => {
    await registrar(registroPastora());
    const r = await estado(PASTORA, '2501-000123');
    expect(r.status).toBe(200);
    expect(r.body.data).toEqual({
      cnpoliza: '2501-000123',
      estado: 'incompleto',
      documentos: [{ tipo: 'rif', estado: 'pendiente' }],
    });
    expect((await estado(OTRO, '2501-000123')).status).toBe(404);
    expect((await estado(PASTORA, '2501-999999')).status).toBe(404);
  });

  it('Pastora: tipo no pedido 400; RIF recibido y validado por la IA', async () => {
    conOcr();
    await registrar(registroPastora());
    const mal = await subir(PASTORA, '2501-000123', { tipo: 'licencia' });
    expect(mal.status).toBe(400);
    expect(mal.body.message).toMatch(/no se pide/);

    ocrExtraido = {
      rif: 'J-41234567-8',
      razonSocial: 'AGROPECUARIA LA PASTORA',
      tipoDoc: 'J',
    };
    const r = await subir(PASTORA, '2501-000123', { tipo: 'rif' });
    expect(r.status).toBe(201);
    expect(r.body.data).toEqual({ tipo: 'rif', estado: 'recibido' });
    await esperar();
    // El OCR recibió el tipo declarado.
    const [, init] = fetchMock.mock.calls.find(([u]) =>
      String(u).includes('/documento'),
    )!;
    expect((init.body as FormData).get('tipo')).toBe('rif');
    const e = await estado(PASTORA, '2501-000123');
    expect(e.body.data.documentos[0].tipo).toBe('rif');
    expect(['validado', 'por_corregir']).toContain(
      e.body.data.documentos[0].estado,
    );
  });

  it('Viajero: documento obligatorio, uno por viajero y por_corregir con motivo', async () => {
    conOcr();
    await registrar(registroViajero());
    const inicial = await estado(VIAJERO, '2501-000777');
    expect(inicial.body.data.documentos).toEqual([
      { tipo: 'cedula', documento: '11222333', estado: 'pendiente' },
      { tipo: 'pasaporte', documento: 'EM2849387', estado: 'pendiente' },
    ]);

    const sinDoc = await subir(VIAJERO, '2501-000777', { tipo: 'cedula' });
    expect(sinDoc.status).toBe(400);
    expect(sinDoc.body.message).toMatch(/obligatorio en Viajero/);
    const ajeno = await subir(VIAJERO, '2501-000777', {
      tipo: 'cedula',
      documento: '99888777',
    });
    expect(ajeno.status).toBe(400);
    const tipoMal = await subir(VIAJERO, '2501-000777', {
      tipo: 'rif',
      documento: '11222333',
    });
    expect(tipoMal.status).toBe(400);

    // Cédula de Ana correcta.
    ocrExtraido = { documento: 'V-11.222.333', nombre: 'ANA', apellido: 'DIAZ' };
    const ok1 = await subir(VIAJERO, '2501-000777', {
      tipo: 'cedula',
      documento: 'V-11222333',
    });
    expect(ok1.status).toBe(201);
    expect(ok1.body.data).toEqual({
      tipo: 'cedula',
      documento: '11222333',
      estado: 'recibido',
    });
    await esperar();

    // Pasaporte de John con el número de otra persona: no coincide con SU viajero.
    ocrExtraido = {
      numeroPasaporte: 'XX0000001',
      nombre: 'JOHN',
      apellido: 'SMITH',
    };
    const ok2 = await subir(
      VIAJERO,
      '2501-000777',
      { tipo: 'pasaporte', documento: 'P-EM2849387' },
      WEBP,
      'pas.webp',
    );
    expect(ok2.status).toBe(201);
    await esperar();

    const fin = await estado(VIAJERO, '2501-000777');
    const [ana, john] = fin.body.data.documentos;
    expect(ana).toMatchObject({ tipo: 'cedula', estado: 'validado' });
    expect(john).toMatchObject({
      tipo: 'pasaporte',
      documento: 'EM2849387',
      estado: 'por_corregir',
    });
    expect(john.motivo).toMatch(/no coinciden/);
    expect(fin.body.data.estado).toBe('incompleto');

    // Reenvío correcto: reemplaza al anterior y la póliza queda completa.
    ocrExtraido = {
      numeroPasaporte: 'EM2849387',
      nombre: 'JOHN',
      apellido: 'SMITH',
    };
    await subir(VIAJERO, '2501-000777', {
      tipo: 'pasaporte',
      documento: 'EM2849387',
    });
    await esperar();
    const completo = await estado(VIAJERO, '2501-000777');
    expect(completo.body.data.documentos[1].estado).toBe('validado');
    expect(completo.body.data.estado).toBe('completo');
  });

  it('OCR caído: el documento queda por corregir para reenviarlo', async () => {
    conOcr();
    fetchMock.mockImplementation(async () => respuesta(500, { ok: false }));
    await registrar(registroPastora());
    const r = await subir(PASTORA, '2501-000123', { tipo: 'cedula' });
    expect(r.status).toBe(201);
    await esperar();
    const e = await estado(PASTORA, '2501-000123');
    expect(e.body.data.documentos[0]).toMatchObject({
      estado: 'por_corregir',
    });
    expect(e.body.data.documentos[0].motivo).toBeTruthy();
  });
});
