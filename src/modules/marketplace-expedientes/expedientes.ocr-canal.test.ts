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
    req.user = { id: 1, email: 'op@test', empresaId: 7, roleId: 1 };
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
import { _resetCatalogoCanales, catalogoCanales } from './expedientes.canales';
import { EVENTO_OCR_POR_CANAL } from './expedientes.ocr-canal';
import { getConfig } from '../config/product-config.service';

const db = prisma as any;
const app = express();
app.use(express.json());
app.use('/api/expedientes', router);

const ADMIN = { Authorization: 'Bearer x', 'x-test-admin': '1' };
const URL = '/api/expedientes/ocr-por-canal';

/** Config del OCR como la deja el parametrizador de Luis (empresa 7, RCV). */
function configRcv() {
  return {
    documentos: [
      { key: 'cedula', label: 'Cédula', activo: true, obligatorio: true },
    ],
    apiMap: [{ internalKey: 'placa', externalKey: 'xplaca' }],
    validarVigencia: false,
    ui: { perProductor: { '123': { hideHeader: true } } },
    ocrOpcional: {
      gestores: ['215-28', '80080-1159-3002'],
      canales: ['1', 99],
      nota: 'clave futura del panel',
    },
  };
}

function fila(empresaId: number, producto: string) {
  return db.productConfig
    ._rows()
    .find(
      (r: any) =>
        r.empresaId === empresaId &&
        r.producto === producto &&
        r.modulo === 'ocr',
    );
}

const eventos = () =>
  db.mktExpedienteEvento
    ._rows()
    .filter((e: any) => e.tipo === EVENTO_OCR_POR_CANAL);

beforeEach(async () => {
  db.$reset();
  process.env.EXPEDIENTES_ENABLED = 'true';
  delete process.env.EXPEDIENTES_ENTORNO;
  delete process.env.EXPEDIENTES_ACCESO_LIBRE;
  delete process.env.PORTAL_SIS2000_EMPRESA_ID;
  process.env.EXPEDIENTES_OCR_CANAL_ESCRITURA = 'true';
  process.env.NODE_ENV = 'test';
  _resetCatalogoCanales({
    nombres: new Map([
      ['1', 'Canal Uno'],
      ['2', 'Canal Dos'],
    ]),
    gestorCanal: new Map([['215-28', '1']]),
    canales: [
      { codigo: '1', nombre: 'Canal Uno' },
      { codigo: '2', nombre: 'Canal Dos' },
      { codigo: '3', nombre: '' },
    ],
    puntos: new Map([
      [
        '1',
        [
          { codigo: '215-28', nombre: 'Punto A' },
          { codigo: '1-1195-4215', nombre: 'Punto B' },
          { codigo: '1-1195-4216', nombre: 'Punto C' },
        ],
      ],
    ]),
  });
  await db.empresa.create({ data: { id: 7, nombre: 'La Mundial' } });
  await db.empresa.create({ data: { id: 8, nombre: 'Otra empresa' } });
  await db.productConfig.create({
    data: {
      empresaId: 7,
      producto: 'rcv',
      modulo: 'ocr',
      configJson: configRcv(),
    },
  });
  // Filas que nunca deben cambiar: otro producto y otra empresa.
  await db.productConfig.create({
    data: {
      empresaId: 7,
      producto: 'funerario',
      modulo: 'ocr',
      configJson: { ocrOpcional: { gestores: [], canales: ['2'] } },
    },
  });
  await db.productConfig.create({
    data: {
      empresaId: 8,
      producto: 'rcv',
      modulo: 'ocr',
      configJson: { ocrOpcional: { gestores: ['9'], canales: ['1'] } },
    },
  });
});

describe('GET /api/expedientes/ocr-por-canal', () => {
  it('lista los canales del catálogo con los que tienen OCR opcional', async () => {
    const r = await request(app).get(`${URL}?producto=rcv`).set(ADMIN);
    expect(r.status).toBe(200);
    const d = r.body.data;
    expect(d).toMatchObject({
      empresaId: 7,
      empresaNombre: 'La Mundial',
      producto: 'rcv',
      opcionales: ['1', '99'],
      gestoresConfigurados: 2,
    });
    expect(d.canales).toEqual([
      {
        codigo: '1',
        nombre: 'Canal Uno',
        enCatalogo: true,
        ocrOpcional: true,
        puntos: 3,
      },
      {
        codigo: '2',
        nombre: 'Canal Dos',
        enCatalogo: true,
        ocrOpcional: false,
        puntos: 0,
      },
      {
        codigo: '3',
        nombre: null,
        enCatalogo: true,
        ocrOpcional: false,
        puntos: 0,
      },
      // Configurado en el OCR pero ya no activo: se muestra para no perderlo.
      {
        codigo: '99',
        nombre: null,
        enCatalogo: false,
        ocrOpcional: true,
        puntos: 0,
      },
    ]);
    // La vista general solo trae conteos: los puntos van bajo demanda por canal.
    expect(JSON.stringify(d)).not.toContain('215-28');
  });

  it('puntos de un canal: paginados, con filtro y solo administradores', async () => {
    const P = `${URL}/puntos`;
    const r = await request(app).get(`${P}?canal=1&porPagina=2`).set(ADMIN);
    expect(r.status).toBe(200);
    expect(r.body.data).toEqual({
      canal: '1',
      total: 3,
      pagina: 1,
      porPagina: 2,
      puntos: [
        { codigo: '215-28', nombre: 'Punto A' },
        { codigo: '1-1195-4215', nombre: 'Punto B' },
      ],
    });
    const p2 = await request(app)
      .get(`${P}?canal=1&porPagina=2&pagina=2`)
      .set(ADMIN);
    expect(p2.body.data.puntos).toEqual([
      { codigo: '1-1195-4216', nombre: 'Punto C' },
    ]);
    const f = await request(app).get(`${P}?canal=1&q=4216`).set(ADMIN);
    expect(f.body.data.total).toBe(1);
    const vacio = await request(app).get(`${P}?canal=2`).set(ADMIN);
    expect(vacio.body.data).toMatchObject({ total: 0, puntos: [] });
    expect((await request(app).get(`${P}?canal=77`).set(ADMIN)).status).toBe(
      404,
    );
    expect((await request(app).get(P).set(ADMIN)).status).toBe(400);
    expect(
      (
        await request(app)
          .get(`${P}?canal=1`)
          .set({ Authorization: 'Bearer x' })
      ).status,
    ).toBe(403);
    _resetCatalogoCanales(null);
    expect((await request(app).get(`${P}?canal=1`).set(ADMIN)).status).toBe(
      502,
    );
  });

  it('el producto por defecto es RCV y cada producto tiene su propia config', async () => {
    const rcv = await request(app).get(URL).set(ADMIN);
    expect(rcv.body.data.producto).toBe('rcv');
    const fun = await request(app).get(`${URL}?producto=funerario`).set(ADMIN);
    expect(fun.body.data.opcionales).toEqual(['2']);
    const pat = await request(app)
      .get(`${URL}?producto=patrimoniales`)
      .set(ADMIN);
    expect(pat.body.data.opcionales).toEqual([]);
    expect(
      (await request(app).get(`${URL}?producto=vida`).set(ADMIN)).status,
    ).toBe(400);
  });

  it('sin catálogo responde 502 con un mensaje claro', async () => {
    _resetCatalogoCanales(null);
    const r = await request(app).get(URL).set(ADMIN);
    expect(r.status).toBe(502);
    expect(r.body.message).toMatch(/catálogo de canales/);
  });
});

describe('catálogo: puntos por canal', () => {
  it('agrupa los puntos por el canal que resuelve nest-api; sin canal (productores) no entran', async () => {
    _resetCatalogoCanales();
    process.env.NEST_API_KEY = 'k';
    const fetchMock = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        data: {
          canales: [{ ccanalalt: 215, xcanalalt: 'Bitácora' }],
          gestores: [
            { cgestor: '215-2-9', xgestor: 'Zeta', ccanalalt: 215 },
            { cgestor: '215-1195-4215 ', xgestor: ' Alfa ', ccanalalt: 215 },
            {
              cgestor: '80080-1159-3002',
              xgestor: 'Productor',
              ccanalalt: null,
            },
          ],
        },
      }),
    }));
    vi.stubGlobal('fetch', fetchMock);
    try {
      const cat = await catalogoCanales();
      expect(cat?.puntos?.get('215')).toEqual([
        { codigo: '215-1195-4215', nombre: 'Alfa' },
        { codigo: '215-2-9', nombre: 'Zeta' },
      ]);
      expect(cat?.puntos?.size).toBe(1);
    } finally {
      vi.unstubAllGlobals();
      delete process.env.NEST_API_KEY;
    }
  });
});

describe('PUT /api/expedientes/ocr-por-canal', () => {
  it('cambia solo ocrOpcional.canales: conserva gestores y el resto de la config', async () => {
    const r = await request(app)
      .put(URL)
      .set(ADMIN)
      .send({
        producto: 'rcv',
        canales: ['99', '2'],
        base: ['1', '99'],
        motivo: 'Piloto del canal 2 sin OCR',
      });
    expect(r.status).toBe(200);
    expect(r.body.data.opcionales).toEqual(['99', '2']);

    const esperado = configRcv();
    esperado.ocrOpcional.canales = ['99', '2'];
    expect(fila(7, 'rcv').configJson).toEqual(esperado);

    // Otras filas intactas.
    expect(fila(7, 'funerario').configJson).toEqual({
      ocrOpcional: { gestores: [], canales: ['2'] },
    });
    expect(fila(8, 'rcv').configJson).toEqual({
      ocrOpcional: { gestores: ['9'], canales: ['1'] },
    });

    // Lo que lee el OCR en tiempo de ejecución (GET /api/config/7/rcv/ocr).
    const runtime = (await getConfig(7, 'rcv', 'ocr')) as any;
    expect(runtime.ocrOpcional).toEqual({
      gestores: ['215-28', '80080-1159-3002'],
      canales: ['99', '2'],
      nota: 'clave futura del panel',
    });
    expect(runtime.documentos).toEqual(esperado.documentos);
  });

  it('registra un evento de auditoría con antes, después, actor y motivo', async () => {
    await request(app)
      .put(URL)
      .set(ADMIN)
      .send({
        producto: 'rcv',
        canales: ['2'],
        motivo: 'Cumplimiento lo pidió',
      })
      .expect(200);
    const ev = eventos();
    expect(ev).toHaveLength(1);
    expect(ev[0].expedienteId).toBeNull();
    expect(ev[0].actor).toBe('portal:1:op@test');
    expect(ev[0].detalle).toMatchObject({
      empresaId: 7,
      producto: 'rcv',
      modulo: 'ocr',
      anterior: ['1', '99'],
      nuevo: ['2'],
      agregados: ['2'],
      quitados: ['1', '99'],
      gestoresConservados: 2,
      motivo: 'Cumplimiento lo pidió',
    });

    const g = await request(app).get(URL).set(ADMIN);
    expect(g.body.data.cambios).toHaveLength(1);
    expect(g.body.data.cambios[0]).toMatchObject({
      actor: 'portal:1:op@test',
      motivo: 'Cumplimiento lo pidió',
      agregados: ['2'],
      quitados: ['1', '99'],
    });
    // El historial es por producto.
    const fun = await request(app).get(`${URL}?producto=funerario`).set(ADMIN);
    expect(fun.body.data.cambios).toHaveLength(0);
  });

  it('el motivo es obligatorio', async () => {
    for (const motivo of [undefined, '', '  ']) {
      const r = await request(app)
        .put(URL)
        .set(ADMIN)
        .send({ producto: 'rcv', canales: ['2'], motivo });
      expect(r.status).toBe(400);
    }
    expect(fila(7, 'rcv').configJson).toEqual(configRcv());
    expect(eventos()).toHaveLength(0);
  });

  it('solo administradores: 403 sin rol admin y 401 sin sesión', async () => {
    const noAdmin = { Authorization: 'Bearer x' };
    expect((await request(app).get(URL).set(noAdmin)).status).toBe(403);
    expect(
      (
        await request(app)
          .put(URL)
          .set(noAdmin)
          .send({ producto: 'rcv', canales: ['2'], motivo: 'Sin permiso' })
      ).status,
    ).toBe(403);
    expect((await request(app).get(URL)).status).toBe(401);
    expect(fila(7, 'rcv').configJson).toEqual(configRcv());
  });

  it('catálogo caído: 502 y no guarda nada', async () => {
    _resetCatalogoCanales(null);
    const r = await request(app)
      .put(URL)
      .set(ADMIN)
      .send({
        producto: 'rcv',
        canales: ['2'],
        motivo: 'Intento sin catálogo',
      });
    expect(r.status).toBe(502);
    expect(r.body.message).toMatch(/No se guardó ningún cambio/);
    expect(fila(7, 'rcv').configJson).toEqual(configRcv());
    expect(eventos()).toHaveLength(0);
  });

  it('rechaza códigos que no están en el catálogo (salvo los ya configurados)', async () => {
    const r = await request(app)
      .put(URL)
      .set(ADMIN)
      .send({
        producto: 'rcv',
        canales: ['1', '99', '555'],
        motivo: 'Código inventado',
      });
    expect(r.status).toBe(400);
    expect(r.body.message).toContain('555');
    expect(fila(7, 'rcv').configJson).toEqual(configRcv());
  });

  it('409 si la config cambió desde que se cargó la pantalla', async () => {
    const r = await request(app)
      .put(URL)
      .set(ADMIN)
      .send({
        producto: 'rcv',
        canales: ['2'],
        base: ['1'],
        motivo: 'Pantalla vieja',
      });
    expect(r.status).toBe(409);
    expect(fila(7, 'rcv').configJson).toEqual(configRcv());
    expect(eventos()).toHaveLength(0);
  });

  it('sin cambios no escribe ni registra evento', async () => {
    const r = await request(app)
      .put(URL)
      .set(ADMIN)
      .send({ producto: 'rcv', canales: ['99', '1'], motivo: 'Mismo estado' });
    expect(r.status).toBe(200);
    expect(r.body.data.sinCambios).toBe(true);
    expect(eventos()).toHaveLength(0);
  });

  it('producto sin fila: la crea solo con ocrOpcional (el resto sigue en los defaults)', async () => {
    const r = await request(app)
      .put(URL)
      .set(ADMIN)
      .send({
        producto: 'patrimoniales',
        canales: ['1'],
        motivo: 'Alta inicial',
      });
    expect(r.status).toBe(200);
    expect(fila(7, 'patrimoniales').configJson).toEqual({
      ocrOpcional: { canales: ['1'] },
    });
    const runtime = (await getConfig(7, 'patrimoniales', 'ocr')) as any;
    expect(runtime.ocrOpcional.canales).toEqual(['1']);
    expect(runtime.documentos).toBeDefined();
  });

  it('si falla el registro de auditoría no queda el cambio guardado', async () => {
    const original = db.mktExpedienteEvento.create;
    db.mktExpedienteEvento.create = vi.fn().mockRejectedValue(new Error('bd'));
    try {
      const r = await request(app)
        .put(URL)
        .set(ADMIN)
        .send({
          producto: 'rcv',
          canales: ['2'],
          motivo: 'Falla de auditoría',
        });
      expect(r.status).toBe(500);
    } finally {
      db.mktExpedienteEvento.create = original;
    }
    expect(fila(7, 'rcv').configJson).toEqual(configRcv());
  });
});

describe('empresa de la config', () => {
  it('no toca otra empresa: si el portal declara su empresa y la sesión es de otra, 403', async () => {
    process.env.PORTAL_SIS2000_EMPRESA_ID = '8';
    const r = await request(app)
      .put(URL)
      .set(ADMIN)
      .send({ producto: 'rcv', canales: ['2'], motivo: 'Empresa cruzada' });
    expect(r.status).toBe(403);
    expect(fila(8, 'rcv').configJson).toEqual({
      ocrOpcional: { gestores: ['9'], canales: ['1'] },
    });
    expect(fila(7, 'rcv').configJson).toEqual(configRcv());
  });

  it('QA sin sesión (acceso libre): usa la empresa del portal y queda el actor de QA', async () => {
    process.env.EXPEDIENTES_ACCESO_LIBRE = 'true';
    process.env.PORTAL_SIS2000_EMPRESA_ID = '7';
    const g = await request(app).get(URL);
    expect(g.status).toBe(200);
    expect(g.body.data.empresaId).toBe(7);
    await request(app)
      .put(URL)
      .send({ producto: 'rcv', canales: ['1', '99', '2'], motivo: 'Prueba QA' })
      .expect(200);
    expect(eventos()[0].actor).toBe('qa-acceso-libre');

    delete process.env.PORTAL_SIS2000_EMPRESA_ID;
    expect((await request(app).get(URL)).status).toBe(500);
  });
});

describe('OCR opcional por productor (ocrOpcional.productores)', () => {
  const BASE = { producto: 'rcv', canales: ['1', '99'], base: ['1', '99'] };

  it('config anterior sin la clave: ningún productor opcional', async () => {
    const r = await request(app).get(`${URL}?producto=rcv`).set(ADMIN);
    expect(r.status).toBe(200);
    expect(r.body.data.productores).toEqual([]);
    expect(r.body.data.productoresOpcionales).toEqual([]);
  });

  it('agrega productores por código + nombre sin tocar canales, gestores ni el resto', async () => {
    const r = await request(app)
      .put(URL)
      .set(ADMIN)
      .send({
        ...BASE,
        productores: ['1234', 555],
        productoresNombres: { '1234': ' Productor Uno ' },
        baseProductores: [],
        motivo: 'Productores piloto sin OCR',
      });
    expect(r.status).toBe(200);
    expect(r.body.data.opcionales).toEqual(['1', '99']);
    expect(r.body.data.productoresOpcionales).toEqual(['1234', '555']);
    expect(r.body.data.productores).toEqual([
      { codigo: '1234', nombre: 'Productor Uno', ocrOpcional: true },
      { codigo: '555', nombre: null, ocrOpcional: true },
    ]);

    const esperado: any = configRcv();
    esperado.ocrOpcional.canales = ['1', '99'];
    esperado.ocrOpcional.productores = ['1234', '555'];
    esperado.ocrOpcional.productoresNombres = { '1234': 'Productor Uno' };
    expect(fila(7, 'rcv').configJson).toEqual(esperado);

    // Lo que lee el OCR en tiempo de ejecución.
    const runtime = (await getConfig(7, 'rcv', 'ocr')) as any;
    expect(runtime.ocrOpcional.productores).toEqual(['1234', '555']);
    expect(runtime.ocrOpcional.gestores).toEqual(['215-28', '80080-1159-3002']);

    const [ev] = eventos();
    expect(ev.detalle).toMatchObject({
      agregados: [],
      quitados: [],
      productoresAnterior: [],
      productoresNuevo: ['1234', '555'],
      productoresAgregados: ['1234', '555'],
      productoresQuitados: [],
    });
    expect(r.body.data.cambios[0]).toMatchObject({
      productoresAgregados: ['1234', '555'],
      productoresQuitados: [],
    });

    // Otras filas intactas.
    expect(fila(7, 'funerario').configJson).toEqual({
      ocrOpcional: { gestores: [], canales: ['2'] },
    });
  });

  it('quita un productor (vuelve a obligatorio) y conserva el nombre de los que siguen', async () => {
    await request(app)
      .put(URL)
      .set(ADMIN)
      .send({
        ...BASE,
        productores: ['1234', '555'],
        productoresNombres: { '1234': 'Productor Uno', '555': 'Productor Dos' },
        motivo: 'Alta de productores',
      });
    const r = await request(app)
      .put(URL)
      .set(ADMIN)
      .send({
        ...BASE,
        productores: ['555'],
        baseProductores: ['555', '1234'],
        motivo: 'El 1234 vuelve a OCR obligatorio',
      });
    expect(r.status).toBe(200);
    expect(r.body.data.productores).toEqual([
      { codigo: '555', nombre: 'Productor Dos', ocrOpcional: true },
    ]);
    const oc = fila(7, 'rcv').configJson.ocrOpcional;
    expect(oc.productores).toEqual(['555']);
    expect(oc.productoresNombres).toEqual({ '555': 'Productor Dos' });
    expect(oc.gestores).toEqual(['215-28', '80080-1159-3002']);
    expect(oc.nota).toBe('clave futura del panel');
    expect(eventos()[1].detalle).toMatchObject({
      productoresAgregados: [],
      productoresQuitados: ['1234'],
    });
  });

  it('un guardado que no manda productores (cliente anterior) no los toca', async () => {
    await request(app)
      .put(URL)
      .set(ADMIN)
      .send({ ...BASE, productores: ['1234'], motivo: 'Alta de productor' });
    const r = await request(app)
      .put(URL)
      .set(ADMIN)
      .send({
        producto: 'rcv',
        canales: ['1', '99', '2'],
        base: ['1', '99'],
        motivo: 'Canal 2 sin OCR',
      });
    expect(r.status).toBe(200);
    expect(r.body.data.productoresOpcionales).toEqual(['1234']);
    const oc = fila(7, 'rcv').configJson.ocrOpcional;
    expect(oc.canales).toEqual(['1', '99', '2']);
    expect(oc.productores).toEqual(['1234']);
  });

  it('409 si los productores cambiaron desde que se cargó la pantalla', async () => {
    await request(app)
      .put(URL)
      .set(ADMIN)
      .send({ ...BASE, productores: ['1234'], motivo: 'Alta de productor' });
    const r = await request(app)
      .put(URL)
      .set(ADMIN)
      .send({
        ...BASE,
        productores: ['777'],
        baseProductores: [],
        motivo: 'Pantalla vieja',
      });
    expect(r.status).toBe(409);
    expect(fila(7, 'rcv').configJson.ocrOpcional.productores).toEqual(['1234']);
  });

  it('sin cambios no escribe ni registra evento; código inválido: 400', async () => {
    const igual = await request(app)
      .put(URL)
      .set(ADMIN)
      .send({ ...BASE, productores: [], motivo: 'Nada que cambiar' });
    expect(igual.status).toBe(200);
    expect(igual.body.data.sinCambios).toBe(true);
    expect(eventos()).toHaveLength(0);
    expect(fila(7, 'rcv').configJson).toEqual(configRcv());

    const malo = await request(app)
      .put(URL)
      .set(ADMIN)
      .send({ ...BASE, productores: ['12 34;'], motivo: 'Código raro' });
    expect(malo.status).toBe(400);
    expect(eventos()).toHaveLength(0);
  });

  it('solo lectura sin EXPEDIENTES_OCR_CANAL_ESCRITURA: 403 y no guarda', async () => {
    delete process.env.EXPEDIENTES_OCR_CANAL_ESCRITURA;
    const r = await request(app)
      .put(URL)
      .set(ADMIN)
      .send({ ...BASE, productores: ['1234'], motivo: 'Sin permiso' });
    expect(r.status).toBe(403);
    expect(fila(7, 'rcv').configJson).toEqual(configRcv());
  });
});
