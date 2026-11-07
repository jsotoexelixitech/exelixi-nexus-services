/* eslint-disable @typescript-eslint/no-explicit-any */
import { beforeEach, describe, expect, it, vi } from 'vitest';
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
    req.user = { id: 1, email: 'op@test', empresaId: 1, roleId: 1 };
    next();
  },
}));
vi.mock('../portal/portal-admin.middleware', () => ({
  requirePortalAdmin: (req: any, res: any, next: any) =>
    req.headers['x-test-admin'] === '1'
      ? next()
      : res.status(403).json({ success: false }),
}));

import prisma from '../../config/prisma';
import router from './expedientes.routes';
import { expedientesService } from './expedientes.service';

const db = prisma as any;
const app = express();
app.use(express.json());
app.use('/api/expedientes', router);

const AUTH = { Authorization: 'Bearer x' };

beforeEach(() => {
  db.$reset();
  process.env.EXPEDIENTES_ENABLED = 'true';
  delete process.env.EXPEDIENTES_ENTORNO;
  process.env.NODE_ENV = 'test';
});

describe('rutas /api/expedientes', () => {
  it('apagado: 404 en todas las rutas', async () => {
    delete process.env.EXPEDIENTES_ENABLED;
    expect((await request(app).get('/api/expedientes').set(AUTH)).status).toBe(
      404,
    );
    expect(
      (await request(app).get('/api/expedientes/indicadores').set(AUTH)).status,
    ).toBe(404);
  });

  it('lectura requiere sesión del portal', async () => {
    expect((await request(app).get('/api/expedientes')).status).toBe(401);
  });

  it('GET lista, indicadores y detalle con { status, data }', async () => {
    const r = await expedientesService.registrarDesdeEmision({
      id: 1,
      empresaId: 7,
      polizaNumero: 'P-1',
      jsonData: { producto: 'rcv' },
    });
    const lista = await request(app)
      .get('/api/expedientes?estadoDoc=incompleto')
      .set(AUTH);
    expect(lista.status).toBe(200);
    expect(lista.body.status).toBe('success');
    expect(lista.body.data.items).toHaveLength(1);

    const ind = await request(app)
      .get('/api/expedientes/indicadores')
      .set(AUTH);
    expect(ind.body.data).toMatchObject({
      total: 1,
      incompletos: 1,
      completos: 0,
    });

    const det = await request(app).get(`/api/expedientes/${r!.id}`).set(AUTH);
    expect(det.status).toBe(200);
    expect(det.body.data.cnpoliza).toBe('P-1');

    expect(
      (await request(app).get('/api/expedientes/999').set(AUTH)).status,
    ).toBe(404);
    expect(
      (await request(app).get('/api/expedientes?estadoDoc=raro').set(AUTH))
        .status,
    ).toBe(400);
  });

  it('jobs: solo admin y nunca en producción declarada', async () => {
    await db.emision.create({
      data: { empresaId: 7, polizaNumero: 'Z', jsonData: {} },
    });
    const noAdmin = await request(app)
      .post('/api/expedientes/jobs/conciliacion/ejecutar')
      .set(AUTH);
    expect(noAdmin.status).toBe(403);
    const ok = await request(app)
      .post('/api/expedientes/jobs/conciliacion/ejecutar')
      .set({ ...AUTH, 'x-test-admin': '1' });
    expect(ok.status).toBe(200);
    expect(ok.body.data.resumen.conciliacion.creadas).toBe(1);

    process.env.EXPEDIENTES_ENTORNO = 'produccion';
    const prod = await request(app)
      .post('/api/expedientes/jobs/conciliacion/ejecutar')
      .set({ ...AUTH, 'x-test-admin': '1' });
    expect(prod.status).toBe(404);

    delete process.env.EXPEDIENTES_ENTORNO;
    process.env.NODE_ENV = 'production';
    const qaSinDeclarar = await request(app)
      .post('/api/expedientes/jobs/conciliacion/ejecutar')
      .set({ ...AUTH, 'x-test-admin': '1' });
    expect(qaSinDeclarar.status).toBe(404);
    process.env.EXPEDIENTES_ENTORNO = 'qa';
    const qa = await request(app)
      .post('/api/expedientes/jobs/conciliacion/ejecutar')
      .set({ ...AUTH, 'x-test-admin': '1' });
    expect(qa.status).toBe(200);
  });
});
