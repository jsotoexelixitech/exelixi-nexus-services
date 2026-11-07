/* eslint-disable @typescript-eslint/no-explicit-any */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../config/prisma', async () => {
  const { createFakePrisma } = await import('./test-utils/fake-prisma');
  return { default: createFakePrisma() };
});
vi.mock('../../utils/logger', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import prisma from '../../config/prisma';
import { ExpedientesService } from './expedientes.service';
import { onEmisionRegistrada } from './expedientes.hook';

const db = prisma as any;
const svc = new ExpedientesService();

function emision(
  id: number,
  poliza: string,
  jsonData: Record<string, unknown> = {},
) {
  return {
    id,
    empresaId: 7,
    polizaNumero: poliza,
    jsonData: {
      producto: 'rcv',
      tomadorIdentificacion: 'V-12345678',
      tomadorNombre: 'Ana Pérez',
      ...jsonData,
    },
    createdAt: new Date(),
  };
}

const payloadCanal = (extra: Record<string, unknown> = {}) => ({
  version: 1,
  centidad: 'C',
  citem: '900',
  ccanalalt: '900',
  cusuario: '55',
  xlogin: 'vendedor1',
  producto: 'rcv',
  estadoPago: 'pagada',
  asegurado: {
    tipoDoc: 'V',
    documento: '12345678',
    nombre: 'Ana',
    apellido: 'Pérez',
    email: 'ana@test.com',
  },
  ...extra,
});

beforeEach(() => {
  db.$reset();
  process.env.EXPEDIENTES_ENABLED = 'true';
  delete process.env.EXPEDIENTES_MAIL_WHITELIST;
});

describe('creación desde el feed emision', () => {
  it('es idempotente por empresa + cnpoliza', async () => {
    const e = emision(1, 'P-001');
    const a = await svc.registrarDesdeEmision(e, {
      expediente: payloadCanal(),
    });
    const b = await svc.registrarDesdeEmision(e, {
      expediente: payloadCanal(),
    });
    expect(a?.creado).toBe(true);
    expect(b?.creado).toBe(false);
    expect(b?.id).toBe(a?.id);
    expect(db.mktExpediente._rows()).toHaveLength(1);
    expect(db.mktExpedienteRequisito._rows()).toHaveLength(3);
    const creados = db.mktExpedienteEvento
      ._rows()
      .filter((x: any) => x.tipo === 'expediente_creado');
    expect(creados).toHaveLength(1);
  });

  it('con EXPEDIENTES_ENABLED apagado no hace nada', async () => {
    delete process.env.EXPEDIENTES_ENABLED;
    const r = await svc.registrarDesdeEmision(emision(1, 'P-001'), {
      expediente: payloadCanal(),
    });
    expect(r).toBeNull();
    expect(db.mktExpediente._rows()).toHaveLength(0);
  });

  it('tolera registros sin el campo expediente o con basura', async () => {
    await svc.registrarDesdeEmision(emision(1, 'P-001'));
    await svc.registrarDesdeEmision(emision(2, 'P-002'), {
      expediente: 'basura',
    });
    const rows = db.mktExpediente._rows();
    expect(rows).toHaveLength(2);
    expect(rows[0].area).toBe('desconocida');
    expect(rows[0].aseguradoDocumento).toBe('12345678');
    expect(rows[0].estadoPago).toBe('pagada');
    // Sin campo `expediente` no se sabe qué falta: no es incompleto.
    expect(rows[0].estadoDocumental).toBe('sin_informacion');
    expect(rows[1].estadoDocumental).toBe('sin_informacion');
    const reqs = db.mktExpedienteRequisito._rows();
    expect(reqs.every((r: any) => r.estado === 'sin_informacion')).toBe(true);
    const ind = await svc.indicadores({});
    expect(ind).toMatchObject({ incompletos: 0, sinInformacion: 2 });
  });

  it('personas con documentosEnWizard=false: sin información, no faltante', async () => {
    await svc.registrarDesdeEmision(emision(3, 'P-003', { producto: 'Vida' }), {
      expediente: payloadCanal({
        producto: 'personas',
        documentosEnWizard: false,
        xlogin: null,
        cproductor: '80080',
        cproducto: 'VIDA1',
        documentos: { cedula: { recibido: false, ref: null, url: null } },
        snapshot: { fdesde: null, fhasta: null },
      }),
    });
    const exp = db.mktExpediente._rows()[0];
    expect(exp.infoDocumental).toBe(false);
    expect(exp.estadoDocumental).toBe('sin_informacion');
    expect(exp.area).toBe('canal');
    const lista = await svc.listar({ estadoDoc: 'incompleto' });
    expect(lista.total).toBe(0);
  });

  it('personas: cruza con funeral_submission si el snapshot trae documents', async () => {
    await db.funeralSubmission.create({
      data: {
        empresaId: 7,
        cnpoliza: 'P-004',
        createdAt: new Date(),
        snapshotJson: {
          documents: {
            cedula: { status: 'done', file: { url: 'ocr/x/cedula.jpg' } },
          },
        },
      },
    });
    await svc.registrarDesdeEmision(emision(4, 'P-004', { producto: 'Vida' }), {
      expediente: payloadCanal({
        producto: 'personas',
        documentosEnWizard: false,
      }),
    });
    const exp = db.mktExpediente._rows()[0];
    expect(exp.infoDocumental).toBe(true);
    expect(exp.estadoDocumental).toBe('incompleto');
    const req = db.mktExpedienteRequisito._rows()[0];
    expect(req).toMatchObject({
      estado: 'recibido',
      origen: 'mesa_tecnica',
      ref: 'ocr/x/cedula.jpg',
    });
  });

  it('un registro posterior con documentos pasa sin_informacion a faltante', async () => {
    const e = emision(5, 'P-005');
    await svc.registrarDesdeEmision(e);
    expect(db.mktExpediente._rows()[0].estadoDocumental).toBe(
      'sin_informacion',
    );
    await svc.registrarDesdeEmision(e, {
      expediente: payloadCanal({
        documentosEnWizard: true,
        documentos: { cedula: { recibido: true, url: 'ocr/p5/cedula.jpg' } },
      }),
    });
    const reqs = db.mktExpedienteRequisito._rows();
    expect(reqs.find((r: any) => r.tipo === 'cedula')).toMatchObject({
      estado: 'recibido',
      ref: 'ocr/p5/cedula.jpg',
    });
    expect(reqs.find((r: any) => r.tipo === 'licencia').estado).toBe(
      'faltante',
    );
    expect(db.mktExpediente._rows()[0].estadoDocumental).toBe('incompleto');
  });

  it('documento recibido en la emisión queda recibido, no validado (sigue incompleto)', async () => {
    const r = await svc.registrarDesdeEmision(emision(1, 'P-001'), {
      expediente: payloadCanal({
        documentos: { cedula: { recibido: true, ref: 'ocr/1' } },
      }),
    });
    const req = db.mktExpedienteRequisito
      ._rows()
      .find((x: any) => x.tipo === 'cedula');
    expect(req.estado).toBe('recibido');
    const exp = db.mktExpediente._rows().find((x: any) => x.id === r?.id);
    expect(exp.estadoDocumental).toBe('incompleto');
  });

  it('completa la mano vacía en un segundo registro sin degradar requisitos', async () => {
    const e = emision(1, 'P-001');
    await svc.registrarDesdeEmision(e);
    await svc.registrarDesdeEmision(e, { expediente: payloadCanal() });
    const exp = db.mktExpediente._rows()[0];
    expect(exp.area).toBe('canal');
    expect(exp.aseguradoEmail).toBe('ana@test.com');
  });

  it('área desde el perfil del portal cuando falta centidad', async () => {
    await db.usuarioPortalPerfil.create({
      data: { usuarioId: 3, cusuario: '77', centidad: 'G', cgestor: '12' },
    });
    await svc.registrarDesdeEmision(emision(1, 'P-001'), {
      expediente: { cusuario: '77' },
    });
    expect(db.mktExpediente._rows()[0].area).toBe('gestor');
  });

  it('el hook nunca lanza aunque el servicio falle', () => {
    expect(() => onEmisionRegistrada(null)).not.toThrow();
    expect(() =>
      onEmisionRegistrada({ id: 1, empresaId: 0, polizaNumero: '' } as any),
    ).not.toThrow();
  });
});

describe('estado de pago separado del documental', () => {
  it('pendiente de pago y documentalmente completo', async () => {
    const r = await svc.registrarDesdeEmision(
      emision(1, 'P-010', { producto: 'Vida' }),
      {
        expediente: payloadCanal({
          producto: 'personas',
          estadoPago: 'pendiente',
          documentos: { cedula: { recibido: true } },
        }),
      },
    );
    await svc.validarManual(r!.id, 'cedula', 'validar', 'portal:1');
    const exp = db.mktExpediente._rows()[0];
    expect(exp.estadoDocumental).toBe('completo');
    expect(exp.estadoPago).toBe('pendiente');

    const lista = await svc.listar({
      estadoPago: 'pendiente',
      estadoDoc: 'completo',
    });
    expect(lista.total).toBe(1);
    const otra = await svc.listar({ estadoPago: 'pagada' });
    expect(otra.total).toBe(0);
    const ind = await svc.indicadores({});
    expect(ind.completos).toBe(1);
    expect(ind.pendientesPago).toBe(1);
  });

  it('no se valida un requisito faltante (recibir ≠ validar)', async () => {
    const r = await svc.registrarDesdeEmision(emision(1, 'P-011'), {
      expediente: payloadCanal(),
    });
    await expect(
      svc.validarManual(r!.id, 'cedula', 'validar', 'portal:1'),
    ).rejects.toMatchObject({
      statusCode: 409,
    });
  });
});

describe('alcance configurable', () => {
  it('productores fuera por defecto; se incluyen al activarlos', async () => {
    await svc.registrarDesdeEmision(emision(1, 'P-C'), {
      expediente: payloadCanal(),
    });
    await svc.registrarDesdeEmision(emision(2, 'P-P'), {
      expediente: payloadCanal({
        centidad: 'P',
        cgestor: null,
        citem: '80080',
      }),
    });
    let lista = await svc.listar({});
    expect(lista.items.map((i: any) => i.cnpoliza)).toEqual(['P-C']);

    await svc.updateConfig(
      { alcance: { productores: true } as any, motivo: 'incluir productores' },
      'portal:1',
    );
    lista = await svc.listar({});
    expect(lista.total).toBe(2);
    const auditoria = db.mktExpedienteEvento
      ._rows()
      .find((x: any) => x.tipo === 'config_actualizada');
    expect(auditoria.detalle.anterior.alcance.productores).toBe(false);
    expect(auditoria.detalle.nuevo.alcance.productores).toBe(true);
    expect(auditoria.detalle.motivo).toBe('incluir productores');
  });
});

describe('conciliación', () => {
  it('crea expediente solo para filas de emision que no lo tienen', async () => {
    for (const [id, p] of [
      [1, 'A'],
      [2, 'B'],
      [3, 'C'],
    ] as const) {
      await db.emision.create({
        data: {
          id,
          empresaId: 7,
          polizaNumero: p,
          jsonData: { producto: 'rcv' },
        },
      });
    }
    await svc.registrarDesdeEmision({
      id: 1,
      empresaId: 7,
      polizaNumero: 'A',
      jsonData: {},
    });
    const r1 = await svc.conciliar();
    expect(r1).toMatchObject({ revisadas: 3, creadas: 2, errores: 0 });
    const r2 = await svc.conciliar();
    expect(r2.creadas).toBe(0);
    expect(db.mktExpediente._rows()).toHaveLength(3);
    expect(
      db.mktExpediente._rows().filter((x: any) => x.origen === 'conciliacion'),
    ).toHaveLength(2);
  });
});

describe('lectura', () => {
  it('item con el formato del contrato y agrupación por asegurado', async () => {
    await svc.registrarDesdeEmision(emision(1, 'P-1'), {
      expediente: payloadCanal(),
    });
    await svc.registrarDesdeEmision(emision(2, 'P-2'), {
      expediente: payloadCanal(),
    });
    const lista = await svc.listar({});
    const item: any = lista.items[0];
    expect(Object.keys(item)).toEqual(
      expect.arrayContaining([
        'id',
        'cnpoliza',
        'cnrecibo',
        'producto',
        'area',
        'vendedor',
        'asegurado',
        'estadoPago',
        'estadoDocumental',
        'requisitos',
        'intentos',
        'ultimoEnvio',
        'proximoEnvio',
        'noEnviar',
        'cambiosDetectados',
        'emitidaEn',
      ]),
    );
    expect(item.asegurado.emailMasked).toBe('an***@test.com');
    expect(item.asegurado.email).toBeUndefined();
    // agrupar=asegurado: misma lista plana, ordenada por asegurado.
    await svc.registrarDesdeEmision(emision(3, 'P-3'), {
      expediente: payloadCanal({
        asegurado: { tipoDoc: 'V', documento: '10000000', nombre: 'Beto' },
      }),
    });
    const porAsegurado = await svc.listar({ agrupar: 'asegurado' });
    expect(porAsegurado.total).toBe(3);
    const orden = porAsegurado.items.map((i: any) => i.cnpoliza);
    // V10000000 (Beto) antes que V12345678 (Ana, sus dos pólizas juntas).
    expect(orden[0]).toBe('P-3');
    expect(orden.slice(1).sort()).toEqual(['P-1', 'P-2']);
    // Filtro de área con el código del SSO.
    expect((await svc.listar({ area: 'C' })).total).toBe(3);
    expect((await svc.listar({ area: 'G' })).total).toBe(0);
    const det = await svc.detalle(item.id);
    expect(det.validacion).toBe('manual');
    expect(det.eventos.length).toBeGreaterThan(0);
    expect(Array.isArray(det.notificaciones)).toBe(true);
    expect(Array.isArray(det.cambios)).toBe(true);
  });
});
