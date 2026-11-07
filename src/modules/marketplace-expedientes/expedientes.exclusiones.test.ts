/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * Exclusiones por lote: asegurado, póliza, canal (ccanalalt), gestor (cgestor) e
 * intermediario (cproductor). Selección múltiple, job de recordatorios y reactivación.
 */
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
import { estaExcluido, expedientesService as svc } from './expedientes.service';
import { enviarRecordatorios } from './expedientes.tareas';

const db = prisma as any;
const DIA = 86_400_000;
/** 7-nov-2026 10:00 hora de Caracas. */
const BASE = new Date('2026-11-07T14:00:00.000Z');

const app = express();
app.use(express.json());
app.use('/api/expedientes', router);
const AUTH = { Authorization: 'Bearer x' };
const ADMIN = { ...AUTH, 'x-test-admin': '1' };

let fetchMock: ReturnType<typeof vi.fn>;
const mailCalls = () =>
  fetchMock.mock.calls.filter(([url]) =>
    String(url).includes('/api/v1/mail/send'),
  );

let seq = 0;
/** Póliza RCV incompleta (sin documentos) con el vendedor indicado. */
async function crear(
  poliza: string,
  vendedor: Record<string, unknown>,
  opts: { documento?: string; email?: string; snapshot?: unknown } = {},
) {
  seq++;
  const r = await svc.registrarDesdeEmision(
    {
      id: seq,
      empresaId: 7,
      polizaNumero: poliza,
      jsonData: { producto: 'rcv' },
      createdAt: BASE,
    },
    {
      expediente: {
        producto: 'rcv',
        documentosEnWizard: true,
        ...vendedor,
        ...(opts.snapshot ? { snapshot: opts.snapshot } : {}),
        asegurado: {
          tipoDoc: 'V',
          documento: opts.documento ?? `1000000${seq}`,
          nombre: 'Ana',
          email: opts.email ?? `aseg${seq}@test.com`,
        },
      },
    },
  );
  return r!.id;
}

const CANAL_900 = { centidad: 'C', citem: '900', ccanalalt: '900' };
const CANAL_901 = { centidad: 'C', citem: '901', ccanalalt: '901' };
const GESTOR_12 = { centidad: 'G', cgestor: '12' };
const GESTOR_13 = { centidad: 'G', cgestor: '13' };

function exp(id: number) {
  return db.mktExpediente._rows().find((e: any) => e.id === id);
}

function notifs(expId: number, resultado?: string) {
  return db.mktExpedienteNotificacion
    ._rows()
    .filter(
      (n: any) =>
        n.expedienteId === expId && (!resultado || n.resultado === resultado),
    );
}

beforeEach(() => {
  db.$reset();
  seq = 0;
  process.env.EXPEDIENTES_ENABLED = 'true';
  process.env.NEST_API_KEY = 'k';
  process.env.EXPEDIENTES_PUBLIC_URL = 'https://nexusqa.test/portal-lm';
  process.env.NODE_ENV = 'test';
  delete process.env.EXPEDIENTES_ENTORNO;
  delete process.env.EXPEDIENTES_ACCESO_LIBRE;
  process.env.EXPEDIENTES_MAIL_WHITELIST = Array.from(
    { length: 20 },
    (_, i) => `aseg${i + 1}@test.com`,
  ).join(',');
  fetchMock = vi.fn(
    async () =>
      new Response(JSON.stringify({ status: true, data: { sent: true } }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
  );
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

/**
 * Para cada alcance: la póliza «dentro» queda excluida y la de «fuera» no.
 * Todas son de áreas en alcance por defecto (canal o gestor).
 */
const CASOS: {
  alcance: string;
  valor: string;
  dentro: Record<string, unknown>;
  fuera: Record<string, unknown>;
  documento?: string;
}[] = [
  { alcance: 'canal', valor: '900', dentro: CANAL_900, fuera: CANAL_901 },
  { alcance: 'gestor', valor: '12', dentro: GESTOR_12, fuera: GESTOR_13 },
  {
    alcance: 'intermediario',
    valor: '80080',
    dentro: { ...CANAL_900, cproductor: '80080' },
    fuera: { ...CANAL_900, cproductor: '80081' },
  },
  {
    alcance: 'asegurado',
    valor: 'V-55666777',
    dentro: CANAL_900,
    fuera: CANAL_900,
    documento: '55666777',
  },
  { alcance: 'poliza', valor: 'P-DENTRO', dentro: CANAL_900, fuera: CANAL_900 },
];

async function crearCaso(c: (typeof CASOS)[number]) {
  const dentro = await crear('P-DENTRO', c.dentro, {
    documento: c.documento,
  });
  const fuera = await crear('P-FUERA', c.fuera);
  return { dentro, fuera };
}

describe('exclusión por cada tipo', () => {
  it.each(CASOS)(
    '$alcance: marca «No enviar» con el alcance y no cambia el estado',
    async (c) => {
      const { dentro, fuera } = await crearCaso(c);
      const x = await svc.crearExclusion(
        { alcance: c.alcance as any, valor: c.valor, motivo: 'pedido LM' },
        'portal:1',
      );
      expect(x.activo).toBe(true);

      const lista = await svc.listar({});
      const d = lista.items.find((i: any) => i.id === dentro)!;
      const f = lista.items.find((i: any) => i.id === fuera)!;
      expect(d.noEnviar).toBe(true);
      expect(d.noEnviarPor[0]).toMatchObject({
        id: x.id,
        alcance: c.alcance,
        motivo: 'pedido LM',
      });
      expect(f.noEnviar).toBe(false);
      expect(f.noEnviarPor).toEqual([]);
      // Excluir no oculta ni cambia el estado documental.
      expect(lista.total).toBe(2);
      expect(exp(dentro).estadoDocumental).toBe('incompleto');

      const det = await svc.detalle(dentro);
      expect(det.exclusiones).toHaveLength(1);
      expect(det.exclusiones[0].alcance).toBe(c.alcance);
      expect((await svc.indicadores({})).noEnviar).toBe(1);
    },
  );

  it('canal/gestor/intermediario guardan el código normalizado', async () => {
    const x = await svc.crearExclusion(
      { alcance: 'canal', valor: ' 45 ', motivo: 'pedido LM' },
      'portal:1',
    );
    expect(x.valor).toBe('45');
    const lista = await svc.listarExclusiones(false, 'canal');
    expect(lista).toHaveLength(1);
    expect(lista[0]).toMatchObject({ alcance: 'canal', valor: '45' });
  });

  it('intermediario de registros viejos: citem con centidad P', async () => {
    const id = await crear('P-VIEJO', { centidad: 'P', citem: '7001' });
    await svc.updateConfig(
      { alcance: { productores: true } as any, motivo: 'incluir productores' },
      'portal:1',
    );
    await svc.crearExclusion(
      { alcance: 'intermediario', valor: '7001', motivo: 'pedido LM' },
      'portal:1',
    );
    const item = (await svc.listar({})).items.find((i: any) => i.id === id)!;
    expect(item.noEnviarPor[0]).toMatchObject({
      alcance: 'intermediario',
      valor: '7001',
    });
  });

  it('desde el expediente: toma el código del actor de la póliza', async () => {
    const id = await crear('P-1', { ...GESTOR_12 });
    const x = await svc.crearExclusion(
      { alcance: 'gestor', expedienteId: id, motivo: 'pedido LM' },
      'portal:1',
    );
    expect(x.valor).toBe('12');
    await expect(
      svc.crearExclusion(
        { alcance: 'canal', expedienteId: id, motivo: 'pedido LM' },
        'portal:1',
      ),
    ).rejects.toMatchObject({ statusCode: 400 });
  });

  it('una póliza con varias exclusiones explica primero la más específica', async () => {
    const id = await crear('P-1', { ...CANAL_900, cproductor: '80080' });
    await svc.crearExclusion(
      { alcance: 'intermediario', valor: '80080', motivo: 'm intermediario' },
      'portal:1',
    );
    await svc.crearExclusion(
      { alcance: 'canal', valor: '900', motivo: 'm canal' },
      'portal:1',
    );
    await svc.crearExclusion(
      { alcance: 'poliza', valor: 'P-1', motivo: 'm poliza' },
      'portal:1',
    );
    const item = (await svc.listar({})).items.find((i: any) => i.id === id)!;
    expect(item.noEnviarPor.map((x: any) => x.alcance)).toEqual([
      'poliza',
      'canal',
      'intermediario',
    ]);
  });
});

describe('selección múltiple (lote)', () => {
  it('varios valores con un motivo: una exclusión propia por valor', async () => {
    const a = await crear('P-1', CANAL_900);
    const b = await crear('P-2', CANAL_901);
    const c = await crear('P-3', { centidad: 'C', ccanalalt: '902' });
    const r = await svc.crearExclusionesLote(
      {
        alcance: 'canal',
        valores: ['900', '901', ' 900 ', '903'],
        motivo: 'canales en piloto',
      },
      'portal:1',
    );
    expect(r.creadas.map((x) => x.valor)).toEqual(['900', '901', '903']);
    expect(r.omitidas).toEqual([]);
    const rows = db.mktExpedienteExclusion._rows();
    expect(rows).toHaveLength(3);
    expect(rows.every((x: any) => x.motivo === 'canales en piloto')).toBe(true);
    // Auditoría: un evento por exclusión, todos con el mismo lote.
    const ev = db.mktExpedienteEvento
      ._rows()
      .filter((e: any) => e.tipo === 'exclusion_creada');
    expect(ev).toHaveLength(3);
    expect(new Set(ev.map((e: any) => e.detalle.lote))).toEqual(
      new Set([r.lote]),
    );
    expect(ev.map((e: any) => e.actor)).toEqual([
      'portal:1',
      'portal:1',
      'portal:1',
    ]);

    const lista = await svc.listar({});
    const noEnviar = (id: number) =>
      lista.items.find((i: any) => i.id === id)!.noEnviar;
    expect([noEnviar(a), noEnviar(b), noEnviar(c)]).toEqual([
      true,
      true,
      false,
    ]);

    // Repetir: no duplica, informa los que ya estaban.
    const otra = await svc.crearExclusionesLote(
      { alcance: 'canal', valores: ['900', '902'], motivo: 'otra vez' },
      'portal:1',
    );
    expect(otra.creadas.map((x) => x.valor)).toEqual(['902']);
    expect(otra.omitidas).toEqual([
      { valor: '900', motivo: 'Ya estaba excluido.' },
    ]);

    // Cada una se reactiva por separado.
    await svc.eliminarExclusion(r.creadas[0].id, 'portal:1', 'volver a enviar');
    const despues = await svc.listar({});
    expect(despues.items.find((i: any) => i.id === a)!.noEnviar).toBe(false);
    expect(despues.items.find((i: any) => i.id === b)!.noEnviar).toBe(true);
  });

  it('asegurados y pólizas en lote', async () => {
    const a = await crear('P-1', CANAL_900, { documento: '11111111' });
    const b = await crear('P-2', CANAL_900, { documento: '22222222' });
    const c = await crear('P-3', CANAL_900, { documento: '33333333' });
    const r1 = await svc.crearExclusionesLote(
      {
        alcance: 'asegurado',
        valores: ['V-11111111', 'V22222222', 'V-11.111.111'],
        motivo: 'entregan en oficina',
      },
      'portal:1',
    );
    expect(r1.creadas).toHaveLength(2);
    const r2 = await svc.crearExclusionesLote(
      { alcance: 'poliza', valores: ['P-3', 'P-NO-EXISTE'], motivo: 'pólizas' },
      'portal:1',
    );
    expect(r2.creadas.map((x) => x.valor)).toEqual(['P-3', 'P-NO-EXISTE']);
    const lista = await svc.listar({});
    expect(lista.items.filter((i: any) => i.noEnviar)).toHaveLength(3);
    expect([a, b, c].map((id) => estaExcluidoDe(id))).toEqual([
      true,
      true,
      true,
    ]);
  });
});

function estaExcluidoDe(id: number) {
  return estaExcluido(
    exp(id),
    db.mktExpedienteExclusion._rows().filter((x: any) => x.activo),
  );
}

describe('job de recordatorios respeta cada alcance', () => {
  it.each(CASOS)(
    '$alcance: no envía a la póliza excluida y sí a la otra',
    async (c) => {
      const { dentro, fuera } = await crearCaso(c);
      await svc.crearExclusionesLote(
        { alcance: c.alcance as any, valores: [c.valor], motivo: 'pedido LM' },
        'portal:1',
      );
      const r = await enviarRecordatorios(BASE);
      expect(r.excluidos).toBe(1);
      expect(notifs(dentro, 'excluido')).toHaveLength(1);
      expect(notifs(dentro, 'enviado')).toHaveLength(0);
      expect(notifs(fuera, 'enviado')).toHaveLength(1);
      expect(mailCalls()).toHaveLength(1);
      expect(exp(dentro).intentos).toBe(0);
      expect(exp(dentro).estadoDocumental).toBe('incompleto');
    },
  );

  it.each(CASOS)(
    '$alcance: al reactivar vuelve a enviar en la siguiente etapa',
    async (c) => {
      const { dentro } = await crearCaso(c);
      const { creadas } = await svc.crearExclusionesLote(
        { alcance: c.alcance as any, valores: [c.valor], motivo: 'pedido LM' },
        'portal:1',
      );
      await enviarRecordatorios(BASE);
      expect(notifs(dentro, 'excluido')).toHaveLength(1);

      await svc.eliminarExclusion(creadas[0].id, 'portal:1', 'reactivar');
      const ev = db.mktExpedienteEvento
        ._rows()
        .find((e: any) => e.tipo === 'exclusion_eliminada');
      expect(ev.detalle).toMatchObject({ alcance: c.alcance });

      fetchMock.mockClear();
      await enviarRecordatorios(new Date(BASE.getTime() + 3 * DIA));
      expect(notifs(dentro, 'enviado')).toHaveLength(1);
      expect(exp(dentro).intentos).toBe(1);
      expect(mailCalls().length).toBeGreaterThanOrEqual(1);
    },
  );
});

describe('actores para elegir', () => {
  it('valores distintos con conteo de pólizas, nombre guardado y si ya está excluido', async () => {
    await crear('P-1', CANAL_900, {
      snapshot: { xcanal: 'Farmacia Centro' },
    });
    await crear('P-2', CANAL_900);
    await crear('P-3', CANAL_901);
    await crear('P-4', { ...GESTOR_12, cproductor: '80080' });
    // Registro viejo de canal: solo centidad C + citem.
    await crear('P-5', { centidad: 'C', citem: '777' });
    await svc.crearExclusion(
      { alcance: 'canal', valor: '901', motivo: 'pedido LM' },
      'portal:1',
    );

    const canales = await svc.actores('canal');
    expect(canales).toEqual([
      {
        tipo: 'canal',
        valor: '900',
        nombre: 'Farmacia Centro',
        polizas: 2,
        excluido: false,
        exclusionId: null,
      },
      expect.objectContaining({ valor: '777', polizas: 1, nombre: null }),
      expect.objectContaining({ valor: '901', polizas: 1, excluido: true }),
    ]);
    expect((await svc.actores('gestor')).map((a) => a.valor)).toEqual(['12']);
    expect((await svc.actores('intermediario')).map((a) => a.valor)).toEqual([
      '80080',
    ]);
    expect(
      (await svc.actores('canal', 'farmacia')).map((a) => a.valor),
    ).toEqual(['900']);
  });
});

describe('rutas', () => {
  it('GET /actores: admin, tipo válido y { status, data }', async () => {
    await crear('P-1', CANAL_900);
    expect(
      (await request(app).get('/api/expedientes/actores?tipo=canal').set(AUTH))
        .status,
    ).toBe(403);
    expect(
      (await request(app).get('/api/expedientes/actores?tipo=otro').set(ADMIN))
        .status,
    ).toBe(400);
    const r = await request(app)
      .get('/api/expedientes/actores?tipo=canal')
      .set(ADMIN);
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({
      status: 'success',
      data: [{ tipo: 'canal', valor: '900', polizas: 1 }],
    });
  });

  it('POST /exclusiones/lote: motivo y valores obligatorios; lista filtrable por tipo', async () => {
    const id = await crear('P-1', GESTOR_12);
    const sinMotivo = await request(app)
      .post('/api/expedientes/exclusiones/lote')
      .set(ADMIN)
      .send({ alcance: 'gestor', valores: ['12'] });
    expect(sinMotivo.status).toBe(400);
    const sinValores = await request(app)
      .post('/api/expedientes/exclusiones/lote')
      .set(ADMIN)
      .send({ alcance: 'gestor', valores: [], motivo: 'pedido LM' });
    expect(sinValores.status).toBe(400);
    const noAdmin = await request(app)
      .post('/api/expedientes/exclusiones/lote')
      .set(AUTH)
      .send({ alcance: 'gestor', valores: ['12'], motivo: 'pedido LM' });
    expect(noAdmin.status).toBe(403);

    const ok = await request(app)
      .post('/api/expedientes/exclusiones/lote')
      .set(ADMIN)
      .send({ alcance: 'gestor', valores: ['12', '13'], motivo: 'pedido LM' });
    expect(ok.status).toBe(201);
    expect(ok.body.data.creadas).toHaveLength(2);

    await request(app)
      .post('/api/expedientes/exclusiones')
      .set(ADMIN)
      .send({ alcance: 'canal', valor: '45', motivo: 'pedido LM' })
      .expect(201);
    const soloGestor = await request(app)
      .get('/api/expedientes/exclusiones?alcance=gestor')
      .set(ADMIN);
    expect(soloGestor.body.data.map((x: any) => x.valor).sort()).toEqual([
      '12',
      '13',
    ]);
    const todas = await request(app)
      .get('/api/expedientes/exclusiones')
      .set(ADMIN);
    expect(todas.body.data).toHaveLength(3);

    const lista = await request(app).get('/api/expedientes').set(AUTH);
    const item = lista.body.data.items.find((i: any) => i.id === id);
    expect(item.noEnviarPor[0]).toMatchObject({
      alcance: 'gestor',
      valor: '12',
    });
  });

  it('POST /exclusiones individual acepta canal con valor y rechaza sin valor', async () => {
    const sinValor = await request(app)
      .post('/api/expedientes/exclusiones')
      .set(ADMIN)
      .send({ alcance: 'canal', motivo: 'pedido LM' });
    expect(sinValor.status).toBe(400);
    const tipoMalo = await request(app)
      .post('/api/expedientes/exclusiones')
      .set(ADMIN)
      .send({ alcance: 'zona', valor: '1', motivo: 'pedido LM' });
    expect(tipoMalo.status).toBe(400);
  });
});
