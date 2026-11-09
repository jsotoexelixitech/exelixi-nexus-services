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
  authenticate: (_req: any, res: any) =>
    res.status(401).json({ success: false }),
}));
vi.mock('../portal/portal-admin.middleware', () => ({
  requirePortalAdmin: (_req: any, res: any) =>
    res.status(403).json({ success: false }),
}));

import prisma from '../../config/prisma';
import logger from '../../utils/logger';
import router from './expedientes.routes';
import { expedientesService } from './expedientes.service';
import {
  CODIGO_MAX_INTENTOS,
  hashCodigo,
  MENSAJE_CODIGO_INVALIDO,
  MENSAJE_VERIFICAR,
  PROPOSITO_CODIGO,
  solicitarCodigo,
  verificarCodigo,
} from './expedientes.acceso';

const db = prisma as any;
const app = express();
app.set('trust proxy', 1);
app.use(express.json());
app.use('/api/expedientes', router);

let fetchMock: ReturnType<typeof vi.fn>;
const okMail = () =>
  new Response(JSON.stringify({ status: true, data: { sent: true } }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
const correos = () =>
  fetchMock.mock.calls.map(([, init]: any) => JSON.parse(init.body));
const ultimoCodigo = () => {
  const c = correos().at(-1);
  return String(c?.data?.codigo ?? '');
};

let ipSeq = 1;
const nuevaIp = () => `10.0.0.${ipSeq++}`;

async function expediente(data: Record<string, unknown>) {
  return db.mktExpediente.create({
    data: {
      empresaId: 7,
      cnpoliza: `P-${Math.random().toString(36).slice(2, 8)}`,
      producto: 'personas',
      area: 'canal',
      aseguradoNombre: 'María Pérez',
      emitidaEn: new Date(),
      ...data,
    },
  });
}

beforeEach(() => {
  db.$reset();
  process.env.EXPEDIENTES_ENABLED = 'true';
  process.env.NEST_API_KEY = 'k';
  process.env.EXPEDIENTES_MAIL_WHITELIST = 'maria@test.com, otro@test.com';
  process.env.EXPEDIENTES_OTP_SECRET = 'secreto-de-pruebas';
  delete process.env.EXPEDIENTES_ENTORNO;
  fetchMock = vi.fn(async () => okMail());
  vi.stubGlobal('fetch', fetchMock);
  vi.mocked(logger.info).mockClear();
});

afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.NEST_API_KEY;
  delete process.env.EXPEDIENTES_MAIL_WHITELIST;
});

describe('acceso por cédula + código', () => {
  it('la respuesta es la misma exista o no el asegurado', async () => {
    await expediente({
      aseguradoKey: 'V12345678',
      aseguradoEmail: 'maria@test.com',
    });
    const ip = nuevaIp();
    const existe = await request(app)
      .post('/api/expedientes/publico/verificar')
      .set('X-Forwarded-For', ip)
      .send({ tipoDoc: 'V', documento: '12.345.678' });
    const noExiste = await request(app)
      .post('/api/expedientes/publico/verificar')
      .set('X-Forwarded-For', ip)
      .send({ tipoDoc: 'V', documento: '99999999' });
    expect(existe.status).toBe(200);
    expect(noExiste.status).toBe(200);
    expect(existe.body).toEqual(noExiste.body);
    expect(existe.body.data.mensaje).toBe(MENSAJE_VERIFICAR);
    // Nada de pólizas, nombres ni correos en la respuesta.
    expect(JSON.stringify(existe.body)).not.toMatch(/María|maria@|P-/);
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const c = correos()[0];
    expect(c.to).toBe('maria@test.com');
    expect(c.template).toBe('expediente-codigo');
    expect(c.data.subject).toBe(
      'La Mundial de Seguros | Código de verificación',
    );
    expect(c.data.codigo).toMatch(/^\d{6}$/);
    expect(JSON.stringify(c)).not.toMatch(/vendedor/i);
  });

  it('el código se guarda solo como hash (HMAC), nunca en claro', async () => {
    await expediente({
      aseguradoKey: 'V12345678',
      aseguradoEmail: 'maria@test.com',
    });
    expect((await solicitarCodigo('V', '12345678')).resultado).toBe('enviado');
    const codigo = ultimoCodigo();
    const filas = db.mktExpedienteEnlace._rows();
    expect(filas).toHaveLength(1);
    expect(filas[0].proposito).toBe(PROPOSITO_CODIGO);
    expect(filas[0].tokenHash).toBe(hashCodigo('V12345678', codigo));
    expect(filas[0].tokenHash).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(filas)).not.toContain(codigo);
    const exp = filas[0].expiraEn.getTime() - filas[0].createdAt.getTime();
    expect(exp).toBe(10 * 60_000);
    // Un código nunca sirve como enlace del asegurado.
    await expect(expedientesService.resolverEnlace(codigo)).rejects.toThrow();
  });

  it('vence a los 10 minutos', async () => {
    await expediente({
      aseguradoKey: 'V12345678',
      aseguradoEmail: 'maria@test.com',
    });
    const ahora = new Date();
    await solicitarCodigo('V', '12345678', ahora);
    const codigo = ultimoCodigo();
    await expect(
      verificarCodigo(
        'V',
        '12345678',
        codigo,
        new Date(ahora.getTime() + 11 * 60_000),
      ),
    ).rejects.toThrow(MENSAJE_CODIGO_INVALIDO);
  });

  it('máximo de intentos: al quinto error se bloquea aunque luego llegue el bueno', async () => {
    await expediente({
      aseguradoKey: 'V12345678',
      aseguradoEmail: 'maria@test.com',
    });
    await solicitarCodigo('V', '12345678');
    const codigo = ultimoCodigo();
    const malo = codigo === '000000' ? '111111' : '000000';
    for (let i = 0; i < CODIGO_MAX_INTENTOS; i++) {
      await expect(verificarCodigo('V', '12345678', malo)).rejects.toThrow(
        MENSAJE_CODIGO_INVALIDO,
      );
    }
    await expect(verificarCodigo('V', '12345678', codigo)).rejects.toThrow(
      MENSAJE_CODIGO_INVALIDO,
    );
    const fila = db.mktExpedienteEnlace._rows()[0];
    expect(fila.accesos).toBe(CODIGO_MAX_INTENTOS);
    expect(fila.revocadoEn).toBeInstanceOf(Date);
    const tipos = db.mktExpedienteEvento._rows().map((e: any) => e.tipo);
    expect(tipos).toContain('acceso_cedula_bloqueado');
  });

  it('un solo uso', async () => {
    await expediente({
      aseguradoKey: 'V12345678',
      aseguradoEmail: 'maria@test.com',
    });
    await solicitarCodigo('V', '12345678');
    const codigo = ultimoCodigo();
    const r = await verificarCodigo('V', '12345678', codigo);
    expect(r.token).toHaveLength(43);
    await expect(verificarCodigo('V', '12345678', codigo)).rejects.toThrow(
      MENSAJE_CODIGO_INVALIDO,
    );
  });

  it('un código nuevo reemplaza al anterior y no se reenvía antes de 60 s', async () => {
    await expediente({
      aseguradoKey: 'V12345678',
      aseguradoEmail: 'maria@test.com',
    });
    const t0 = new Date();
    await solicitarCodigo('V', '12345678', t0);
    const primero = ultimoCodigo();
    expect(
      (await solicitarCodigo('V', '12345678', new Date(t0.getTime() + 30_000)))
        .resultado,
    ).toBe('espera');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await solicitarCodigo('V', '12345678', new Date(t0.getTime() + 61_000));
    const segundo = ultimoCodigo();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    if (primero !== segundo) {
      await expect(
        verificarCodigo(
          'V',
          '12345678',
          primero,
          new Date(t0.getTime() + 62_000),
        ),
      ).rejects.toThrow(MENSAJE_CODIGO_INVALIDO);
    }
    const r = await verificarCodigo(
      'V',
      '12345678',
      segundo,
      new Date(t0.getTime() + 62_000),
    );
    expect(r.token).toBeTruthy();
  });

  it('lista blanca: fuera de ella no sale correo ni queda código vigente', async () => {
    await expediente({
      aseguradoKey: 'V12345678',
      aseguradoEmail: 'fuera@test.com',
    });
    expect((await solicitarCodigo('V', '12345678')).resultado).toBe(
      'bloqueado_whitelist',
    );
    expect(fetchMock).not.toHaveBeenCalled();
    const fila = db.mktExpedienteEnlace._rows()[0];
    expect(fila.revocadoEn).toBeInstanceOf(Date);
  });

  it('exclusión «No enviar» y expediente completo: no se envía código', async () => {
    const e = await expediente({
      aseguradoKey: 'V12345678',
      aseguradoEmail: 'maria@test.com',
    });
    await expediente({
      aseguradoKey: 'V555555',
      aseguradoEmail: 'maria@test.com',
      estadoDocumental: 'completo',
    });
    await db.mktExpedienteExclusion.create({
      data: { alcance: 'poliza', expedienteId: e.id, motivo: 'x' },
    });
    expect((await solicitarCodigo('V', '12345678')).resultado).toBe(
      'sin_coincidencia',
    );
    expect((await solicitarCodigo('V', '555555')).resultado).toBe(
      'sin_coincidencia',
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('el token resultante solo ve los expedientes de ese asegurado', async () => {
    const propio = await expediente({
      aseguradoKey: 'V12345678',
      aseguradoEmail: 'maria@test.com',
    });
    const completo = await expediente({
      aseguradoKey: 'V12345678',
      aseguradoEmail: 'maria@test.com',
      estadoDocumental: 'completo',
    });
    const tercero = await expediente({
      aseguradoKey: 'V87654321',
      aseguradoEmail: 'otro@test.com',
      aseguradoNombre: 'Pedro Gómez',
    });
    await solicitarCodigo('V', '12345678');
    const ip = nuevaIp();
    const res = await request(app)
      .post('/api/expedientes/publico/verificar-codigo')
      .set('X-Forwarded-For', ip)
      .send({ tipoDoc: 'V', documento: '12345678', codigo: ultimoCodigo() });
    expect(res.status).toBe(200);
    const { token, expiraEn } = res.body.data;
    const vigencia = new Date(expiraEn).getTime() - Date.now();
    expect(vigencia).toBeGreaterThan(55 * 60_000);
    expect(vigencia).toBeLessThanOrEqual(60 * 60_000);
    const enlace = db.mktExpedienteEnlace
      ._rows()
      .find((r: any) => r.proposito === 'carga_documental');
    expect(enlace.expedienteIds).toEqual([propio.id]);
    expect(enlace.expedienteIds).not.toContain(completo.id);
    expect(enlace.expedienteIds).not.toContain(tercero.id);
    const vista = await expedientesService.vistaPublica(token);
    expect(vista.polizas).toHaveLength(1);
    expect(JSON.stringify(vista)).not.toContain('Pedro');
  });

  it('código inválido por la ruta: error genérico 400 y cuenta el intento', async () => {
    await expediente({
      aseguradoKey: 'V12345678',
      aseguradoEmail: 'maria@test.com',
    });
    await solicitarCodigo('V', '12345678');
    const malo = ultimoCodigo() === '000000' ? '111111' : '000000';
    const res = await request(app)
      .post('/api/expedientes/publico/verificar-codigo')
      .set('X-Forwarded-For', nuevaIp())
      .send({ tipoDoc: 'V', documento: '12345678', codigo: malo });
    expect(res.status).toBe(400);
    expect(res.body.message).toBe(MENSAJE_CODIGO_INVALIDO);
    expect(db.mktExpedienteEnlace._rows()[0].accesos).toBe(1);
    // Sin asegurado: el mismo error.
    const otro = await request(app)
      .post('/api/expedientes/publico/verificar-codigo')
      .set('X-Forwarded-For', nuevaIp())
      .send({ tipoDoc: 'V', documento: '99999999', codigo: malo });
    expect(otro.status).toBe(400);
    expect(otro.body.message).toBe(MENSAJE_CODIGO_INVALIDO);
  });

  it('rate limit por documento (aunque cambie la IP)', async () => {
    const send = () =>
      request(app)
        .post('/api/expedientes/publico/verificar')
        .set('X-Forwarded-For', nuevaIp())
        .send({ tipoDoc: 'E', documento: '81234567' });
    for (let i = 0; i < 5; i++) expect((await send()).status).toBe(200);
    expect((await send()).status).toBe(429);
  });

  it('rate limit por IP (aunque cambie el documento)', async () => {
    const ip = nuevaIp();
    const send = (n: number) =>
      request(app)
        .post('/api/expedientes/publico/verificar')
        .set('X-Forwarded-For', ip)
        .send({ tipoDoc: 'V', documento: String(30000000 + n) });
    for (let i = 0; i < 10; i++) expect((await send(i)).status).toBe(200);
    const r = await send(99);
    expect(r.status).toBe(429);
    expect(r.body.message).toMatch(/Demasiados intentos/);
  });

  it('nest-api sin la plantilla (400): respaldo branded con el código', async () => {
    await expediente({
      aseguradoKey: 'V12345678',
      aseguradoEmail: 'maria@test.com',
    });
    fetchMock.mockImplementationOnce(
      async () =>
        new Response(JSON.stringify({ message: 'template must be one of' }), {
          status: 400,
          headers: { 'content-type': 'application/json' },
        }),
    );
    expect((await solicitarCodigo('V', '12345678')).resultado).toBe('enviado');
    const [primero, respaldo] = correos();
    expect(primero.template).toBe('expediente-codigo');
    expect(respaldo.template).toBe('branded');
    expect(respaldo.data.subject).toBe(
      'La Mundial de Seguros | Código de verificación',
    );
    expect(respaldo.data.intro).toContain(primero.data.codigo);
    expect(JSON.stringify(respaldo)).not.toMatch(/vendedor|P-/i);
  });

  it('logs sin datos personales', async () => {
    await expediente({
      aseguradoKey: 'V12345678',
      aseguradoEmail: 'maria@test.com',
    });
    await solicitarCodigo('V', '12345678');
    await solicitarCodigo('V', '99999999');
    const codigo = ultimoCodigo();
    await verificarCodigo('V', '12345678', codigo);
    const logs = JSON.stringify([
      ...vi.mocked(logger.info).mock.calls,
      ...vi.mocked(logger.warn).mock.calls,
    ]);
    expect(logs).not.toMatch(/12345678|99999999|maria|María/);
    expect(logs).not.toContain(codigo);
  });
});
