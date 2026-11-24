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
    req.user =
      req.headers['x-test-sso'] === '1'
        ? {
            id: 2,
            email: 'sso.jperez.monitor@sis2000.portal',
            empresaId: 1,
            roleId: 1,
            sisXlogin: 'jperez',
          }
        : { id: 1, email: 'op@test', empresaId: 1, roleId: 1 };
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
import logger from '../../utils/logger';
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
  delete process.env.EXPEDIENTES_ACCESO_LIBRE;
  delete process.env.EXPEDIENTES_USUARIOS;
  process.env.NODE_ENV = 'test';
  vi.mocked(logger.info).mockClear();
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
    const r = await expedientesService.registrarDesdeEmision(
      {
        id: 1,
        empresaId: 7,
        polizaNumero: 'P-1',
        jsonData: { producto: 'rcv' },
      },
      { expediente: { centidad: 'C', ccanalalt: '900', producto: 'rcv' } },
    );
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

    // La lista de acceso deja pasar la sesión: lo que se prueba es el bloqueo de jobs.
    process.env.EXPEDIENTES_USUARIOS = 'op@test';
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

const ADMIN = { ...AUTH, 'x-test-admin': '1' };

async function crearRcvConCedulaRecibida(poliza = 'P-9') {
  return expedientesService.registrarDesdeEmision(
    {
      id: 9,
      empresaId: 7,
      polizaNumero: poliza,
      jsonData: { producto: 'rcv' },
    },
    {
      expediente: {
        centidad: 'C',
        ccanalalt: '900',
        asegurado: {
          tipoDoc: 'V',
          documento: '11222333',
          nombre: 'Luis',
          email: 'luis@test.com',
        },
        documentos: { cedula: { recibido: true } },
      },
    },
  );
}

describe('bloque 2: config, exclusiones y validación manual', () => {
  it('config: solo admin, motivo obligatorio y auditoría anterior/nuevo', async () => {
    expect(
      (await request(app).get('/api/expedientes/config').set(AUTH)).status,
    ).toBe(403);
    const get = await request(app).get('/api/expedientes/config').set(ADMIN);
    expect(get.body.data).toMatchObject({
      validacion: 'automatica',
      cadenciaDias: [0, 3, 7, 14],
      horaDiaria: '08:00',
      horaResumen: '23:00',
      alcance: { canales: true, gestores: true, productores: false },
    });
    const sinMotivo = await request(app)
      .put('/api/expedientes/config')
      .set(ADMIN)
      .send({ horaDiaria: '07:30' });
    expect(sinMotivo.status).toBe(400);
    const malaHora = await request(app)
      .put('/api/expedientes/config')
      .set(ADMIN)
      .send({ horaDiaria: '25:00', motivo: 'prueba' });
    expect(malaHora.status).toBe(400);
    const okPut = await request(app)
      .put('/api/expedientes/config')
      .set(ADMIN)
      .send({
        horaDiaria: '07:30',
        destinatariosResumen: ['qa@test.com'],
        motivo: 'ajuste QA',
      });
    expect(okPut.status).toBe(200);
    expect(okPut.body.data.horaDiaria).toBe('07:30');
    const ev = db.mktExpedienteEvento
      ._rows()
      .find((x: any) => x.tipo === 'config_actualizada');
    expect(ev.actor).toContain('portal:1');
    expect(ev.detalle).toMatchObject({
      anterior: { horaDiaria: '08:00' },
      nuevo: { horaDiaria: '07:30' },
      motivo: 'ajuste QA',
    });
  });

  it('exclusión: motivo obligatorio, no oculta ni cambia el estado documental', async () => {
    const r = await crearRcvConCedulaRecibida();
    const antes = db.mktExpediente._rows()[0].estadoDocumental;
    const sinMotivo = await request(app)
      .post('/api/expedientes/exclusiones')
      .set(ADMIN)
      .send({ alcance: 'asegurado', expedienteId: r!.id });
    expect(sinMotivo.status).toBe(400);
    const crea = await request(app)
      .post('/api/expedientes/exclusiones')
      .set(ADMIN)
      .send({
        alcance: 'asegurado',
        expedienteId: r!.id,
        motivo: 'cliente pidió no recibir correos',
      });
    expect(crea.status).toBe(201);
    expect(db.mktExpediente._rows()[0].estadoDocumental).toBe(antes);
    const lista = await request(app).get('/api/expedientes').set(AUTH);
    expect(lista.body.data.items).toHaveLength(1);
    expect(lista.body.data.items[0].noEnviar).toBe(true);
    expect(lista.body.data.items[0].estadoDocumental).toBe('incompleto');
    const ind = await request(app)
      .get('/api/expedientes/indicadores')
      .set(AUTH);
    expect(ind.body.data.noEnviar).toBe(1);

    const del = await request(app)
      .delete(`/api/expedientes/exclusiones/${crea.body.data.id}`)
      .set(ADMIN)
      .send({ motivo: 'ya acepta correos' });
    expect(del.status).toBe(200);
    const despues = await request(app).get('/api/expedientes').set(AUTH);
    expect(despues.body.data.items[0].noEnviar).toBe(false);
    const todas = await request(app)
      .get('/api/expedientes/exclusiones?todas=true')
      .set(ADMIN);
    expect(todas.body.data[0].activo).toBe(false);
  });

  it('validar/observar: admin, motivo en observar, también con validación automática', async () => {
    const r = await crearRcvConCedulaRecibida();
    const base = `/api/expedientes/${r!.id}/requisitos/cedula`;
    expect((await request(app).post(`${base}/validar`).set(AUTH)).status).toBe(
      403,
    );
    expect(
      (await request(app).post(`${base}/observar`).set(ADMIN).send({})).status,
    ).toBe(400);
    const obs = await request(app)
      .post(`${base}/observar`)
      .set(ADMIN)
      .send({ motivo: 'Imagen ilegible' });
    expect(obs.status).toBe(200);
    let req = db.mktExpedienteRequisito
      ._rows()
      .find((x: any) => x.tipo === 'cedula');
    expect(req).toMatchObject({
      estado: 'observado',
      motivo: 'Imagen ilegible',
    });
    const val = await request(app).post(`${base}/validar`).set(ADMIN);
    expect(val.status).toBe(200);
    req = db.mktExpedienteRequisito
      ._rows()
      .find((x: any) => x.tipo === 'cedula');
    expect(req.estado).toBe('validado');
    expect(db.mktExpediente._rows()[0].estadoDocumental).toBe('incompleto');
    const faltante = await request(app)
      .post(`/api/expedientes/${r!.id}/requisitos/licencia/validar`)
      .set(ADMIN);
    expect(faltante.status).toBe(409);

    // Validación automática: la excepción del administrador sigue disponible y queda auditada.
    expect((await expedientesService.getConfig()).validacion).toBe(
      'automatica',
    );
    const obsAuto = await request(app)
      .post(`${base}/observar`)
      .set(ADMIN)
      .send({ motivo: 'Foto de otra persona' });
    expect(obsAuto.status).toBe(200);
    req = db.mktExpedienteRequisito
      ._rows()
      .find((x: any) => x.tipo === 'cedula');
    expect(req).toMatchObject({ estado: 'observado', decision: 'manual' });
    const val2 = await request(app)
      .post(`${base}/validar`)
      .set(ADMIN)
      .send({ motivo: 'Revisado con el original' });
    expect(val2.status).toBe(200);
    const ev = db.mktExpedienteEvento
      ._rows()
      .filter((x: any) => x.tipo === 'requisito_validado')
      .at(-1);
    expect(ev.detalle).toMatchObject({
      manual: true,
      motivo: 'Revisado con el original',
      validacion: 'automatica',
    });
    const yaValidado = await request(app).post(`${base}/validar`).set(ADMIN);
    expect(yaValidado.status).toBe(409);
  });
});

describe('acceso libre QA (EXPEDIENTES_ACCESO_LIBRE)', () => {
  const JPG = Buffer.concat([
    Buffer.from([0xff, 0xd8, 0xff, 0xe0]),
    Buffer.alloc(200, 1),
  ]);

  async function rutasInternas(id: number) {
    const base = `/api/expedientes/${id}/requisitos/cedula`;
    return [
      await request(app).get('/api/expedientes'),
      await request(app).get('/api/expedientes/indicadores'),
      await request(app).get(`/api/expedientes/${id}`),
      await request(app).get('/api/expedientes/config'),
      await request(app)
        .put('/api/expedientes/config')
        .send({ horaDiaria: '07:30', motivo: 'prueba QA' }),
      await request(app).get('/api/expedientes/exclusiones'),
      await request(app)
        .post('/api/expedientes/exclusiones')
        .send({ alcance: 'asegurado', expedienteId: id, motivo: 'prueba QA' }),
      await request(app)
        .post(`${base}/observar`)
        .send({ motivo: 'Imagen ilegible' }),
      await request(app).post(`${base}/validar`),
      await request(app)
        .post(`/api/expedientes/${id}/upload`)
        .field('tipo', 'licencia')
        .attach('file', JPG, 'licencia.jpg'),
      await request(app).post('/api/expedientes/jobs/conciliacion/ejecutar'),
    ];
  }

  it('QA sin sesión: lee y escribe como administrador y audita qa-acceso-libre', async () => {
    process.env.EXPEDIENTES_ACCESO_LIBRE = 'true';
    const r = await crearRcvConCedulaRecibida();
    const res = await rutasInternas(r!.id);
    expect(res.map((x) => x.status)).toEqual([
      200, 200, 200, 200, 200, 200, 201, 200, 200, 201, 200,
    ]);
    const del = await request(app)
      .delete(`/api/expedientes/exclusiones/${res[6].body.data.id}`)
      .send({ motivo: 'fin de la prueba' });
    expect(del.status).toBe(200);

    const auditado = (tipo: string) =>
      db.mktExpedienteEvento
        ._rows()
        .some((x: any) => x.tipo === tipo && x.actor === 'qa-acceso-libre');
    for (const tipo of [
      'config_actualizada',
      'exclusion_creada',
      'exclusion_eliminada',
      'requisito_observado',
      'requisito_validado',
      'documento_recibido',
    ]) {
      expect(auditado(tipo)).toBe(true);
    }

    const logs = vi
      .mocked(logger.info)
      .mock.calls.map((c) => String(c[0]))
      .filter((m) => m.includes('acceso libre'));
    expect(logs.length).toBeGreaterThanOrEqual(res.length);
    for (const m of logs) expect(m).not.toMatch(/11222333|luis@test|Luis/);
  });

  it('producción declarada: la variable no abre nada', async () => {
    process.env.EXPEDIENTES_ACCESO_LIBRE = 'true';
    const r = await crearRcvConCedulaRecibida();
    process.env.EXPEDIENTES_ENTORNO = 'produccion';
    const res = await rutasInternas(r!.id);
    expect(res.every((x) => x.status === 401)).toBe(true);
    expect(
      db.mktExpedienteEvento
        ._rows()
        .some((x: any) => x.actor === 'qa-acceso-libre'),
    ).toBe(false);
    // Con sesión real en producción, config sigue exigiendo administrador.
    expect(
      (await request(app).get('/api/expedientes/config').set(AUTH)).status,
    ).toBe(403);
  });

  it('NODE_ENV=production exige EXPEDIENTES_ENTORNO=qa explícito', async () => {
    process.env.EXPEDIENTES_ACCESO_LIBRE = 'true';
    process.env.NODE_ENV = 'production';
    expect((await request(app).get('/api/expedientes')).status).toBe(401);
    process.env.EXPEDIENTES_ENTORNO = 'qa';
    expect((await request(app).get('/api/expedientes')).status).toBe(200);
  });

  it('sin la variable, sin sesión da 401; con sesión real se usa la sesión real', async () => {
    expect((await request(app).get('/api/expedientes/config')).status).toBe(
      401,
    );
    process.env.EXPEDIENTES_ACCESO_LIBRE = 'true';
    expect(
      (await request(app).get('/api/expedientes/config').set(AUTH)).status,
    ).toBe(403);
    const put = await request(app)
      .put('/api/expedientes/config')
      .set(ADMIN)
      .send({ horaDiaria: '07:45', motivo: 'sesión real' });
    expect(put.status).toBe(200);
    const ev = db.mktExpedienteEvento
      ._rows()
      .find((x: any) => x.tipo === 'config_actualizada');
    expect(ev.actor).toContain('portal:1');
  });
});

describe('sesión SSO (Sis2000/SysIP): configuración solo lectura', () => {
  const SSO = { ...ADMIN, 'x-test-sso': '1' };
  const MSG = /sesión abierta por SSO/;

  it('escrituras de configuración: 403 con mensaje claro', async () => {
    const res = await Promise.all([
      request(app)
        .put('/api/expedientes/config')
        .set(SSO)
        .send({ horaDiaria: '07:30', motivo: 'x' }),
      request(app)
        .put('/api/expedientes/ocr-por-canal')
        .set(SSO)
        .send({}),
      request(app)
        .post('/api/expedientes/exclusiones')
        .set(SSO)
        .send({ alcance: 'asegurado', expedienteId: 1, motivo: 'x' }),
      request(app)
        .post('/api/expedientes/exclusiones/lote')
        .set(SSO)
        .send({}),
      request(app)
        .delete('/api/expedientes/exclusiones/1')
        .set(SSO)
        .send({ motivo: 'x' }),
    ]);
    for (const r of res) {
      expect(r.status).toBe(403);
      expect(r.body.message).toMatch(MSG);
    }
    expect(
      db.mktExpedienteEvento
        ._rows()
        .some((x: any) => x.tipo === 'config_actualizada'),
    ).toBe(false);
  });

  it('lecturas y bandeja siguen igual', async () => {
    const r = await crearRcvConCedulaRecibida('P-SSO');
    expect(
      (await request(app).get('/api/expedientes/config').set(SSO)).status,
    ).toBe(200);
    expect(
      (await request(app).get('/api/expedientes/exclusiones').set(SSO)).status,
    ).toBe(200);
    expect((await request(app).get('/api/expedientes').set(SSO)).status).toBe(
      200,
    );
    const val = await request(app)
      .post(`/api/expedientes/${r!.id}/requisitos/cedula/validar`)
      .set(SSO);
    expect(val.status).not.toBe(403);
  });

  it('sesión normal del portal: sigue escribiendo', async () => {
    const ok = await request(app)
      .put('/api/expedientes/config')
      .set(ADMIN)
      .send({ horaDiaria: '07:30', motivo: 'ajuste' });
    expect(ok.status).toBe(200);
  });
});
