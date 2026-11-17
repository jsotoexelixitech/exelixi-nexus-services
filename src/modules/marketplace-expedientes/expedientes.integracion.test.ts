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
  MAX_CONDUCTORES_TRAYECTO,
  personaPorDocumento,
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

const FLOTA = 'flota:7d1c3a52-0000-4000-8000-000000000001';

function conductor(documento: string, nombre: string) {
  return { tipoDoc: documento.slice(0, 1), documento, nombre };
}

function registroTrayecto(
  conductores = [
    conductor('V-12345678', 'José Pérez'),
    conductor('E-81234567', 'Luis Gómez'),
  ],
  extra: Record<string, unknown> = {},
) {
  return {
    integrador: FLOTA,
    producto: 'trayecto',
    cnpoliza: '18-1-1130480881',
    cramo: 18,
    cplan: 'RIDER1',
    canal: { xcanalVenta: 'TRAYECTO SEGURO' },
    tomador: {
      tipoDoc: 'J',
      documento: 'J-50123456-7',
      nombre: 'Transporte Ejemplo C.A.',
    },
    personas: conductores,
    ...extra,
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

  it('trayecto: RIF de la empresa + un requisito estable por conductor', () => {
    const r = armarRequisitos(
      'trayecto',
      registroTrayecto().tomador,
      [
        ...registroTrayecto().personas,
        // Repetido con otro formato: un solo requisito.
        conductor('V-12.345.678', 'José'),
        { tipoDoc: 'P', documento: 'P-EM2849387', nombre: 'John' },
      ],
    );
    expect(r.requisitos).toEqual([
      'rif',
      'conductor_12345678',
      'conductor_81234567',
      'conductor_EM2849387',
    ]);
    expect(r.personas[0]).toMatchObject({ requisito: 'rif', tipoDoc: 'J' });
    // Sin la empresa el RIF igual se exige.
    expect(armarRequisitos('trayecto', null, []).requisitos).toEqual(['rif']);
    // Tope propio de la flota (Viajero sigue en 20).
    const muchos = Array.from({ length: 600 }, (_, i) =>
      conductor(`V-${10000000 + i}`, `C${i}`),
    );
    expect(armarRequisitos('trayecto', null, muchos).requisitos).toHaveLength(
      MAX_CONDUCTORES_TRAYECTO + 1,
    );
    expect(armarRequisitos('viajero', null, muchos).requisitos).toHaveLength(20);

    expect(requisitoLabel('conductor_12345678')).toBe(
      'Cédula o pasaporte del conductor 12345678',
    );
    expect(requisitoLabel('rif', 'trayecto')).toBe('RIF de la empresa');
    // Fuera de Trayecto Seguro el RIF se llama como siempre.
    expect(requisitoLabel('rif')).toBe('RIF');
    expect(requisitoLabel('rif', 'pastora')).toBe('RIF');
    expect(normalizarProducto(null, 'trayecto')).toBe('trayecto');

    const exp = {
      snapshot: {
        integracion: {
          integrador: FLOTA,
          producto: 'trayecto',
          requisitos: r.requisitos,
          personas: r.personas,
          recibidos: {},
        },
      },
    };
    expect(tipoDocumentoDeRequisito(exp, 'rif')).toBe('rif');
    expect(tipoDocumentoDeRequisito(exp, 'conductor_12345678')).toBe('cedula');
    expect(tipoDocumentoDeRequisito(exp, 'conductor_EM2849387')).toBe(
      'pasaporte',
    );
    const ctx = { personas: [], vehiculo: null, producto: 'trayecto' };
    expect(
      contextoDeRequisito(ctx, exp, 'conductor_81234567').personas,
    ).toMatchObject([{ documento: '81234567', nombre: 'Luis Gómez' }]);
    expect(contextoDeRequisito(ctx, exp, 'rif').personas).toMatchObject([
      { tipoDoc: 'J', nombre: 'Transporte Ejemplo C.A.' },
    ]);
    // La empresa no es un conductor: su número no ubica ningún requisito de cédula.
    const integ = {
      version: 1 as const,
      integrador: FLOTA,
      apiKeyId: null,
      producto: 'trayecto' as const,
      requisitos: r.requisitos,
      personas: r.personas,
      recibidos: {},
    };
    expect(personaPorDocumento(integ, 'J-50123456-7')).toBeNull();
    expect(personaPorDocumento(integ, 'V12345678')?.requisito).toBe(
      'conductor_12345678',
    );
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

  it('Trayecto Seguro: RIF de la empresa y cédula de cada conductor contra SU conductor', async () => {
    conOcr();
    const r = await registrar(registroTrayecto());
    expect(r.status).toBe(201);
    expect(r.body.data.creado).toBe(true);
    const exp = db.mktExpediente._rows()[0];
    expect(exp).toMatchObject({
      producto: 'trayecto',
      origen: 'integracion',
      aseguradoNombre: 'Transporte Ejemplo C.A.',
    });
    expect(exp.snapshot.correos).toEqual([]);
    const inicial = await estado(FLOTA, '18-1-1130480881');
    expect(inicial.body.data.documentos).toEqual([
      { tipo: 'rif', estado: 'pendiente' },
      { tipo: 'cedula', documento: '12345678', estado: 'pendiente' },
      { tipo: 'cedula', documento: '81234567', estado: 'pendiente' },
    ]);
    // Monitor: etiquetas legibles.
    const lista = await svc.listar({ page: 1, pageSize: 20 } as any);
    expect(JSON.stringify(lista)).toContain('RIF de la empresa');
    expect(JSON.stringify(lista)).toContain(
      'Cédula o pasaporte del conductor 12345678',
    );

    const sinDoc = await subir(FLOTA, '18-1-1130480881', { tipo: 'cedula' });
    expect(sinDoc.status).toBe(400);
    expect(sinDoc.body.message).toMatch(/obligatorio/);
    const ajeno = await subir(FLOTA, '18-1-1130480881', {
      tipo: 'cedula',
      documento: '99888777',
    });
    expect(ajeno.status).toBe(400);
    const empresaComoCedula = await subir(FLOTA, '18-1-1130480881', {
      tipo: 'cedula',
      documento: 'J-50123456-7',
    });
    expect(empresaComoCedula.status).toBe(400);
    const tipoMal = await subir(FLOTA, '18-1-1130480881', {
      tipo: 'licencia',
    });
    expect(tipoMal.status).toBe(400);
    expect(
      (await subir(OTRO, '18-1-1130480881', { tipo: 'rif' })).status,
    ).toBe(404);

    ocrExtraido = {
      rif: 'J-50123456-7',
      razonSocial: 'TRANSPORTE EJEMPLO C.A.',
      tipoDoc: 'J',
    };
    const rif = await subir(FLOTA, '18-1-1130480881', { tipo: 'rif' });
    expect(rif.status).toBe(201);
    expect(rif.body.data).toEqual({ tipo: 'rif', estado: 'recibido' });
    await esperar();

    // Cédula de Luis subida como la de José: no coincide con SU conductor aunque Luis esté en la póliza.
    ocrExtraido = { documento: 'E-81.234.567', nombre: 'LUIS', apellido: 'GOMEZ' };
    const jose = await subir(FLOTA, '18-1-1130480881', {
      tipo: 'cedula',
      documento: 'V-12345678',
    });
    expect(jose.status).toBe(201);
    expect(jose.body.data).toEqual({
      tipo: 'cedula',
      documento: '12345678',
      estado: 'recibido',
    });
    await esperar();
    ocrExtraido = { documento: 'E-81.234.567', nombre: 'LUIS', apellido: 'GOMEZ' };
    await subir(FLOTA, '18-1-1130480881', {
      tipo: 'cedula',
      documento: '81234567',
    });
    await esperar();

    const fin = await estado(FLOTA, '18-1-1130480881');
    const [docRif, docJose, docLuis] = fin.body.data.documentos;
    expect(docRif.tipo).toBe('rif');
    expect(['validado', 'por_corregir']).toContain(docRif.estado);
    expect(docJose).toMatchObject({ documento: '12345678', estado: 'por_corregir' });
    expect(docLuis).toMatchObject({ documento: '81234567', estado: 'validado' });
    // El OCR recibió el tipo real de cada requisito.
    const tipos = fetchMock.mock.calls
      .filter(([u]) => String(u).includes('/documento'))
      .map(([, init]) => (init.body as FormData).get('tipo'));
    expect(tipos).toEqual(['rif', 'cedula', 'cedula']);
  });

  it('Trayecto Seguro: re-registro del mismo integrador actualiza conductores y conserva lo cargado', async () => {
    conOcr();
    await registrar(registroTrayecto());
    ocrExtraido = { documento: 'E-81.234.567', nombre: 'LUIS', apellido: 'GOMEZ' };
    await subir(FLOTA, '18-1-1130480881', {
      tipo: 'cedula',
      documento: 'E-81234567',
    });
    await esperar();
    const antes = await estado(FLOTA, '18-1-1130480881');
    const luisAntes = antes.body.data.documentos[2];
    expect(luisAntes.estado).toBe('validado');
    const id = db.mktExpediente._rows()[0].id;

    // Sale José (desactivado), entra Ana; Luis sigue.
    const otra = await registrar(
      registroTrayecto([
        conductor('E-81234567', 'Luis Gómez'),
        conductor('V-20111222', 'Ana Ruiz'),
      ]),
    );
    expect(otra.status).toBe(201);
    expect(otra.body.data).toEqual({ id, creado: false, actualizado: true });
    expect(db.mktExpediente._rows()).toHaveLength(1);
    const despues = await estado(FLOTA, '18-1-1130480881');
    expect(despues.body.data.documentos).toEqual([
      { tipo: 'rif', estado: 'pendiente' },
      luisAntes,
      { tipo: 'cedula', documento: '20111222', estado: 'pendiente' },
    ]);
    expect(despues.body.data.estado).toBe('incompleto');
    const snap = db.mktExpediente._rows()[0].snapshot.integracion;
    expect(snap.recibidos.conductor_81234567).toMatchObject({ tipo: 'cedula' });
    // José ya no se exige ni recibe documentos.
    const jose = await subir(FLOTA, '18-1-1130480881', {
      tipo: 'cedula',
      documento: 'V-12345678',
    });
    expect(jose.status).toBe(400);

    // Mismo registro otra vez: sin cambios.
    const igual = await registrar(
      registroTrayecto([
        conductor('E-81234567', 'Luis Gómez'),
        conductor('V-20111222', 'Ana Ruiz'),
      ]),
    );
    expect(igual.body.data).toEqual({ id, creado: false, actualizado: false });
    // Otro integrador no la toca.
    const ajena = await registrar({ ...registroTrayecto(), integrador: OTRO });
    expect(ajena.status).toBe(409);
    expect(
      db.mktExpediente._rows()[0].snapshot.integracion.requisitos,
    ).toEqual(['rif', 'conductor_81234567', 'conductor_20111222']);
  });

  it('Trayecto Seguro admite más de 50 conductores; los demás productos no', async () => {
    const muchos = Array.from({ length: 120 }, (_, i) =>
      conductor(`V-${10000000 + i}`, `Conductor ${i}`),
    );
    const flota = await registrar(registroTrayecto(muchos));
    expect(flota.status).toBe(201);
    const e = await estado(FLOTA, '18-1-1130480881');
    expect(e.body.data.documentos).toHaveLength(121);
    const viajero = await registrar({
      ...registroViajero(),
      personas: muchos.slice(0, 51),
    });
    expect(viajero.status).toBe(400);
    const pastora = await registrar(
      registroPastora({ personas: muchos.slice(0, 51) }),
    );
    expect(pastora.status).toBe(400);
  });

  it('Pastora y Viajero siguen idempotentes: el re-registro no cambia sus requisitos', async () => {
    await registrar(registroViajero());
    const r = await registrar({
      ...registroViajero(),
      personas: [{ tipoDoc: 'V', documento: '30111222', nombre: 'Otro' }],
    });
    expect(r.body.data).toEqual({
      id: db.mktExpediente._rows()[0].id,
      creado: false,
    });
    expect(
      db.mktExpediente._rows()[0].snapshot.integracion.requisitos,
    ).toEqual(['viajero_1', 'viajero_2']);
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
