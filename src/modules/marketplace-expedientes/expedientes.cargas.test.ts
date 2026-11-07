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
vi.mock('../../middlewares/auth.middleware', () => ({
  authenticate: (req: any, res: any, next: any) => {
    if (!req.headers.authorization)
      return res.status(401).json({ success: false });
    req.user = { id: 2, email: 'vendedor@test', empresaId: 1, roleId: 2 };
    next();
  },
}));
vi.mock('../portal/portal-admin.middleware', () => ({
  requirePortalAdmin: (_req: any, res: any) =>
    res.status(403).json({ success: false }),
}));

import prisma from '../../config/prisma';
import router from './expedientes.routes';
import { expedientesService as svc } from './expedientes.service';
import {
  formatoTokenValido,
  generarToken,
  hashToken,
} from './expedientes.files';

const db = prisma as any;
const app = express();
app.use(express.json());
app.use('/api/expedientes', router);
const AUTH = { Authorization: 'Bearer x' };

const JPG = Buffer.concat([
  Buffer.from([0xff, 0xd8, 0xff, 0xe0]),
  Buffer.alloc(200, 1),
]);
const PDF = Buffer.concat([Buffer.from('%PDF-1.7\n'), Buffer.alloc(200, 1)]);

let fetchMock: ReturnType<typeof vi.fn>;
let ocrRespuesta: { status: number; body: any };

function respuesta(status: number, body: unknown) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

async function crear(
  poliza: string,
  producto = 'rcv',
  doc = '11222333',
  email = 'luis@test.com',
) {
  const r = await svc.registrarDesdeEmision(
    {
      id: Number(poliza.replace(/\D/g, '')) || 1,
      empresaId: 7,
      polizaNumero: poliza,
      jsonData: { producto },
    },
    {
      expediente: {
        centidad: 'C',
        ccanalalt: '900',
        producto,
        asegurado: {
          tipoDoc: 'V',
          documento: doc,
          nombre: 'Luis',
          apellido: 'Pérez',
          email,
        },
        snapshot: { vehiculo: { placa: 'AB123CD' } },
      },
    },
  );
  return r!.id;
}

function req(id: number, tipo: string) {
  return db.mktExpedienteRequisito
    ._rows()
    .find((x: any) => x.expedienteId === id && x.tipo === tipo);
}

beforeEach(() => {
  db.$reset();
  process.env.EXPEDIENTES_ENABLED = 'true';
  process.env.EXPEDIENTES_PUBLIC_URL = 'https://portal.test/portal-lm';
  delete process.env.EXPEDIENTES_MAIL_WHITELIST;
  delete process.env.EXPEDIENTES_ENTORNO;
  delete process.env.OCR_INTERNAL_URL;
  delete process.env.EXPEDIENTE_INTERNAL_KEY;
  ocrRespuesta = {
    status: 200,
    body: {
      ok: true,
      ref: 'exp/P-1/cedula.jpg',
      ocr: {
        extraido: {
          documento: 'V-11.222.333',
          nombre: 'LUIS',
          apellido: 'PEREZ',
        },
        confianza: 1,
        proveedor: 'test',
      },
    },
  };
  fetchMock = vi.fn(async (url: string) => {
    if (String(url).includes('/api/internal/expedientes/documento')) {
      return respuesta(ocrRespuesta.status, ocrRespuesta.body);
    }
    return respuesta(200, { status: true, data: { sent: true } });
  });
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function conOcr() {
  process.env.OCR_INTERNAL_URL = 'http://ocr.local';
  process.env.EXPEDIENTE_INTERNAL_KEY = 'clave-interna';
}

describe('carga del vendedor', () => {
  it('sin OCR configurado: queda recibido (no validado) y evento técnico', async () => {
    const id = await crear('P-1');
    const r = await request(app)
      .post(`/api/expedientes/${id}/upload`)
      .set(AUTH)
      .field('tipo', 'cedula')
      .attach('file', JPG, 'cedula.jpg');
    expect(r.status).toBe(201);
    expect(req(id, 'cedula').estado).toBe('recibido');
    expect(fetchMock).not.toHaveBeenCalled();
    const tec = db.mktExpedienteEvento
      ._rows()
      .find((x: any) => x.tipo === 'error_tecnico');
    expect(tec.detalle.motivo).toBe('ocr_no_configurado');
  });

  it('reenvía al OCR con la clave interna; manual deja recibido aunque el OCR coincida', async () => {
    conOcr();
    await svc.updateConfig(
      { validacion: 'manual', motivo: 'probar manual' } as any,
      'portal:1',
    );
    const id = await crear('P-2');
    const r = await request(app)
      .post(`/api/expedientes/${id}/upload`)
      .set(AUTH)
      .field('tipo', 'cedula')
      .attach('file', PDF, 'cedula.pdf');
    expect(r.status).toBe(201);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('http://ocr.local/api/internal/expedientes/documento');
    expect(init.headers['x-expediente-key']).toBe('clave-interna');
    const form = init.body as FormData;
    expect(form.get('tipo')).toBe('cedula');
    expect(form.get('cnpoliza')).toBe('P-2');
    expect(form.get('documento')).toBe('11222333');
    expect(req(id, 'cedula')).toMatchObject({
      estado: 'recibido',
      ref: 'exp/P-1/cedula.jpg',
    });
  });

  it('automática: coincide → validado; no coincide → observado con motivo', async () => {
    conOcr();
    await svc.updateConfig(
      { validacion: 'automatica', motivo: 'probar' } as any,
      'portal:1',
    );
    const a = await crear('P-3');
    await request(app)
      .post(`/api/expedientes/${a}/upload`)
      .set(AUTH)
      .field('tipo', 'cedula')
      .attach('file', JPG, 'c.jpg');
    expect(req(a, 'cedula')).toMatchObject({
      estado: 'validado',
      validadoPor: 'ia',
      decision: 'ia',
    });
    expect(req(a, 'cedula').diagnostico.resultado).toBe('coincide');

    ocrRespuesta.body.ocr.extraido = {
      documento: '99999999',
      nombre: 'OTRA',
      apellido: 'PERSONA',
    };
    const b = await crear('P-4', 'rcv', '11222333', 'otro@test.com');
    await request(app)
      .post(`/api/expedientes/${b}/upload`)
      .set(AUTH)
      .field('tipo', 'cedula')
      .attach('file', JPG, 'c.jpg');
    expect(req(b, 'cedula').estado).toBe('observado');
    expect(req(b, 'cedula').motivo).toBeTruthy();

    ocrRespuesta.body.ocr = { extraido: {}, confianza: 0 };
    await request(app)
      .post(`/api/expedientes/${b}/upload`)
      .set(AUTH)
      .field('tipo', 'licencia')
      .attach('file', JPG, 'l.jpg');
    expect(req(b, 'licencia').estado).toBe('observado');
  });

  it('automática: confianza 0.5 con datos que coinciden → observado «Revisar» (sin certeza)', async () => {
    conOcr();
    await svc.updateConfig(
      { validacion: 'automatica', motivo: 'probar' } as any,
      'portal:1',
    );
    ocrRespuesta.body.ocr.confianza = 0.5;
    const id = await crear('P-7');
    await request(app)
      .post(`/api/expedientes/${id}/upload`)
      .set(AUTH)
      .field('tipo', 'cedula')
      .attach('file', JPG, 'c.jpg');
    expect(req(id, 'cedula').estado).toBe('observado');
    expect(req(id, 'cedula').motivo).toMatch(/^Revisar: /);
    expect(req(id, 'cedula').diagnostico.resultado).toBe('sin_certeza');
    ocrRespuesta.body.ocr = {
      extraido: {},
      confianza: 0,
      motivo: 'Imagen borrosa',
    };
    await request(app)
      .post(`/api/expedientes/${id}/upload`)
      .set(AUTH)
      .field('tipo', 'licencia')
      .attach('file', JPG, 'l.jpg');
    expect(req(id, 'licencia')).toMatchObject({
      estado: 'observado',
      motivo: 'Imagen borrosa',
    });
  });

  it('OCR rechaza el archivo (422): se informa al usuario y no cambia nada', async () => {
    conOcr();
    ocrRespuesta = {
      status: 422,
      body: { ok: false, message: 'No es un documento' },
    };
    const id = await crear('P-8');
    const r = await request(app)
      .post(`/api/expedientes/${id}/upload`)
      .set(AUTH)
      .field('tipo', 'cedula')
      .attach('file', JPG, 'c.jpg');
    expect(r.status).toBe(422);
    expect(r.body.message).toBe('No es un documento');
    expect(req(id, 'cedula').estado).toBe('faltante');
  });

  it('OCR caído: 502 y el requisito no cambia', async () => {
    conOcr();
    ocrRespuesta = { status: 500, body: { ok: false } };
    const id = await crear('P-5');
    const r = await request(app)
      .post(`/api/expedientes/${id}/upload`)
      .set(AUTH)
      .field('tipo', 'cedula')
      .attach('file', JPG, 'c.jpg');
    expect(r.status).toBe(502);
    expect(req(id, 'cedula').estado).toBe('faltante');
  });

  it('rechaza tipo de archivo no permitido, tipo inválido y más de 25 MB', async () => {
    const id = await crear('P-6');
    const txt = await request(app)
      .post(`/api/expedientes/${id}/upload`)
      .set(AUTH)
      .field('tipo', 'cedula')
      .attach('file', Buffer.from('hola mundo, esto no es imagen'), 'c.jpg');
    expect(txt.status).toBe(415);
    const sinTipo = await request(app)
      .post(`/api/expedientes/${id}/upload`)
      .set(AUTH)
      .attach('file', JPG, 'c.jpg');
    expect(sinTipo.status).toBe(400);
    const grande = Buffer.concat([JPG, Buffer.alloc(25 * 1024 * 1024)]);
    const big = await request(app)
      .post(`/api/expedientes/${id}/upload`)
      .set(AUTH)
      .field('tipo', 'cedula')
      .attach('file', grande, 'c.jpg');
    expect(big.status).toBe(413);
    expect(req(id, 'cedula').estado).toBe('faltante');
  });
});

describe('enlace público del asegurado', () => {
  it('token aleatorio de 32 bytes; en BD solo el hash', async () => {
    const id = await crear('P-10', 'personas');
    const { url, token } = await svc.crearEnlace('V11222333', [id]);
    expect(formatoTokenValido(token)).toBe(true);
    expect(url).toBe(`https://portal.test/portal-lm/expediente?t=${token}`);
    const fila = db.mktExpedienteEnlace._rows()[0];
    expect(fila.tokenHash).toBe(hashToken(token));
    expect(JSON.stringify(fila)).not.toContain(token);
  });

  it('vista mínima: sin documento, correo ni póliza completa', async () => {
    const id = await crear('P-12345678', 'rcv');
    const { token } = await svc.crearEnlace('V11222333', [id]);
    const r = await request(app).get(`/api/expedientes/publico/${token}`);
    expect(r.status).toBe(200);
    expect(r.body.data.nombre).toBe('Luis');
    expect(r.body.data.polizaMasked).toMatch(/\*+5678$/);
    expect(r.body.data.requisitos.map((x: any) => [x.tipo, x.estado])).toEqual([
      ['cedula', 'faltante'],
      ['licencia', 'faltante'],
      ['certificado', 'faltante'],
    ]);
    const json = JSON.stringify(r.body);
    expect(json).not.toContain('11222333');
    expect(json).not.toContain('luis@test.com');
    expect(json).not.toContain('P-12345678');
  });

  it('la cédula sola nunca da acceso (ni un token inventado)', async () => {
    await crear('P-13', 'personas');
    expect(
      (await request(app).get('/api/expedientes/publico/11222333')).status,
    ).toBe(404);
    expect(
      (await request(app).get('/api/expedientes/publico/V-11222333')).status,
    ).toBe(404);
    const inventado = generarToken().token;
    expect(
      (await request(app).get(`/api/expedientes/publico/${inventado}`)).status,
    ).toBe(404);
    const up = await request(app)
      .post('/api/expedientes/publico/11222333/upload')
      .field('tipo', 'cedula')
      .attach('file', JPG, 'c.jpg');
    expect(up.status).toBe(404);
  });

  it('módulo apagado: la página pública recibe 503', async () => {
    delete process.env.EXPEDIENTES_ENABLED;
    const r = await request(app).get(
      `/api/expedientes/publico/${generarToken().token}`,
    );
    expect(r.status).toBe(503);
  });

  it('enlace vencido → 410', async () => {
    const id = await crear('P-14', 'personas');
    const { token } = await svc.crearEnlace('V11222333', [id]);
    db.mktExpedienteEnlace._rows()[0].expiraEn = new Date(Date.now() - 1000);
    const r = await request(app).get(`/api/expedientes/publico/${token}`);
    expect(r.status).toBe(410);
  });

  it('enlace reutilizado: tras cargar todo lo pendiente queda consumido (410)', async () => {
    const id = await crear('P-15', 'personas');
    const { token } = await svc.crearEnlace('V11222333', [id]);
    const up = await request(app)
      .post(`/api/expedientes/publico/${token}/upload`)
      .field('tipo', 'cedula')
      .attach('file', JPG, 'c.jpg');
    expect(up.status).toBe(201);
    expect(up.body.data.enlaceConsumido).toBe(true);
    expect(req(id, 'cedula').estado).toBe('recibido');
    expect(db.mktExpediente._rows()[0].estadoDocumental).toBe('incompleto');
    expect(
      (await request(app).get(`/api/expedientes/publico/${token}`)).status,
    ).toBe(410);
    const otra = await request(app)
      .post(`/api/expedientes/publico/${token}/upload`)
      .field('tipo', 'cedula')
      .attach('file', JPG, 'c.jpg');
    expect(otra.status).toBe(410);
  });

  it('documento ya recibido no se puede volver a subir por el enlace', async () => {
    const id = await crear('P-16', 'rcv');
    const { token } = await svc.crearEnlace('V11222333', [id]);
    await request(app)
      .post(`/api/expedientes/publico/${token}/upload`)
      .field('tipo', 'cedula')
      .attach('file', JPG, 'c.jpg');
    const rep = await request(app)
      .post(`/api/expedientes/publico/${token}/upload`)
      .field('tipo', 'cedula')
      .attach('file', JPG, 'c.jpg');
    expect(rep.status).toBe(409);
  });

  it('nunca muestra pólizas de otro asegurado aunque el enlace las liste', async () => {
    const propio = await crear('P-17', 'personas');
    const ajeno = await crear('P-18', 'personas', '55666777', 'otra@test.com');
    const { token } = await svc.crearEnlace('V11222333', [propio, ajeno]);
    const r = await request(app).get(`/api/expedientes/publico/${token}`);
    expect(r.body.data.polizas).toHaveLength(1);
  });
});
