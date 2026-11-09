/* eslint-disable @typescript-eslint/no-explicit-any */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../config/prisma', async () => {
  const { createFakePrisma } = await import('./test-utils/fake-prisma');
  return { default: createFakePrisma() };
});
vi.mock('../../utils/logger', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import prisma from '../../config/prisma';
import { expedientesService as svc } from './expedientes.service';
import { enviarRecordatorios, tareaNocturna } from './expedientes.tareas';
import {
  _resetScheduler,
  ejecutarJob,
  tickScheduler,
} from './expedientes.jobs';

const db = prisma as any;
const DIA = 86_400_000;
/** 7-nov-2026 10:00 hora de Caracas. */
const BASE = new Date('2026-11-07T14:00:00.000Z');

let fetchMock: ReturnType<typeof vi.fn>;

function mailCalls() {
  return fetchMock.mock.calls.filter(([url]) =>
    String(url).includes('/api/v1/mail/send'),
  );
}

function bodyDe(call: any[]) {
  return JSON.parse(call[1].body);
}

async function crear(
  poliza: string,
  opts: {
    email?: string | null;
    documento?: string;
    emitida?: Date;
    centidad?: string;
    sinPayload?: boolean;
  } = {},
) {
  const r = await svc.registrarDesdeEmision(
    {
      id: Number(poliza.replace(/\D/g, '')) || 1,
      empresaId: 7,
      polizaNumero: poliza,
      jsonData: { producto: 'rcv' },
      createdAt: opts.emitida ?? BASE,
    },
    opts.sinPayload
      ? {}
      : {
          expediente: {
            centidad: opts.centidad ?? 'C',
            ccanalalt: '900',
            producto: 'rcv',
            documentosEnWizard: true,
            asegurado: {
              tipoDoc: 'V',
              documento: opts.documento ?? '11222333',
              nombre: 'Luis',
              email: opts.email === undefined ? 'luis@test.com' : opts.email,
            },
          },
        },
  );
  return r!.id;
}

function notifs(resultado?: string) {
  return db.mktExpedienteNotificacion
    ._rows()
    .filter((n: any) => !resultado || n.resultado === resultado);
}

beforeEach(() => {
  db.$reset();
  _resetScheduler();
  process.env.EXPEDIENTES_ENABLED = 'true';
  process.env.EXPEDIENTES_JOBS_ENABLED = 'true';
  process.env.NEST_API_KEY = 'k';
  process.env.EXPEDIENTES_PUBLIC_URL = 'https://nexusqa.test/portal-lm';
  delete process.env.EXPEDIENTES_MAIL_WHITELIST;
  delete process.env.EXPEDIENTES_ENTORNO;
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

describe('lista blanca', () => {
  it('fuera de producción con la lista vacía no sale ningún correo', async () => {
    await crear('P-1');
    await enviarRecordatorios(BASE);
    expect(mailCalls()).toHaveLength(0);
    expect(notifs('bloqueado_whitelist')).toHaveLength(1);
    expect(db.mktExpediente._rows()[0].intentos).toBe(1);
  });

  it('solo envía a correos de la lista; el correo nunca queda en claro en BD', async () => {
    process.env.EXPEDIENTES_MAIL_WHITELIST = 'qa@test.com, luis@test.com';
    await crear('P-1');
    await crear('P-2', { documento: '55666777', email: 'ajeno@test.com' });
    await enviarRecordatorios(BASE);
    expect(mailCalls()).toHaveLength(1);
    const body = bodyDe(mailCalls()[0]);
    expect(body.to).toBe('luis@test.com');
    expect(body.template).toBe('expediente-documentos');
    expect(body.data.tipo).toBe('solicitud');
    expect(body.data.subject).toBe(
      'La Mundial de Seguros | Complete la documentación de su póliza N.º P-1',
    );
    expect(body.data.polizas).toEqual(['P-1']);
    expect(body.data.documentos.length).toBeGreaterThan(0);
    expect(body.data.enlace).toMatch(
      /^https:\/\/nexusqa\.test\/portal-lm\/expediente\?t=[\w-]{43}$/,
    );
    expect(notifs('enviado')).toHaveLength(1);
    expect(notifs('bloqueado_whitelist')).toHaveLength(1);
    expect(JSON.stringify(notifs())).not.toContain('luis@test.com');
  });

  it('en producción declarada no aplica la lista blanca', async () => {
    process.env.EXPEDIENTES_ENTORNO = 'produccion';
    await crear('P-1');
    await enviarRecordatorios(BASE);
    expect(mailCalls()).toHaveLength(1);
  });

  it('error de nest-api queda como "error"', async () => {
    process.env.EXPEDIENTES_MAIL_WHITELIST = 'luis@test.com';
    fetchMock.mockResolvedValueOnce(new Response('{}', { status: 500 }));
    await crear('P-1');
    await enviarRecordatorios(BASE);
    expect(notifs('error')).toHaveLength(1);
  });
});

describe('cadencia 0/3/7/14', () => {
  it('una vez por etapa, sin repetir aunque la tarea corra dos veces', async () => {
    process.env.EXPEDIENTES_MAIL_WHITELIST = 'luis@test.com';
    await crear('P-1');
    await enviarRecordatorios(BASE);
    await enviarRecordatorios(new Date(BASE.getTime() + 60_000));
    expect(mailCalls()).toHaveLength(1);

    await enviarRecordatorios(new Date(BASE.getTime() + 1 * DIA));
    await enviarRecordatorios(new Date(BASE.getTime() + 2 * DIA));
    expect(mailCalls()).toHaveLength(1);

    await enviarRecordatorios(new Date(BASE.getTime() + 3 * DIA));
    await enviarRecordatorios(new Date(BASE.getTime() + 3 * DIA + 1000));
    expect(mailCalls()).toHaveLength(2);
    expect(bodyDe(mailCalls()[1]).data.subject).toBe(
      'Recordatorio: La Mundial de Seguros | Complete la documentación de su póliza N.º P-1',
    );

    await enviarRecordatorios(new Date(BASE.getTime() + 7 * DIA));
    await enviarRecordatorios(new Date(BASE.getTime() + 14 * DIA));
    await enviarRecordatorios(new Date(BASE.getTime() + 15 * DIA));
    expect(mailCalls()).toHaveLength(4);
    expect(notifs().map((n: any) => n.etapa)).toEqual([0, 1, 2, 3]);

    await enviarRecordatorios(new Date(BASE.getTime() + 20 * DIA));
    expect(mailCalls()).toHaveLength(4);
    expect(db.mktExpediente._rows()[0].cadenciaAgotada).toBe(true);
  });

  it('pólizas viejas (conciliación) no disparan correos fuera de su ventana', async () => {
    process.env.EXPEDIENTES_MAIL_WHITELIST = 'luis@test.com';
    await crear('P-9', { emitida: new Date(BASE.getTime() - 60 * DIA) });
    await enviarRecordatorios(BASE);
    expect(mailCalls()).toHaveLength(0);
    expect(db.mktExpediente._rows()[0].cadenciaAgotada).toBe(true);
  });

  it('sin información documental no recibe recordatorios', async () => {
    process.env.EXPEDIENTES_MAIL_WHITELIST = 'luis@test.com';
    await crear('P-1', { sinPayload: true });
    await enviarRecordatorios(BASE);
    expect(mailCalls()).toHaveLength(0);
    expect(notifs()).toHaveLength(0);
  });
});

describe('agrupación, exclusiones y sin correo', () => {
  it('un solo correo por asegurado con todas sus pólizas', async () => {
    process.env.EXPEDIENTES_MAIL_WHITELIST = 'luis@test.com';
    await crear('P-1');
    await crear('P-2');
    await enviarRecordatorios(BASE);
    expect(mailCalls()).toHaveLength(1);
    const data = bodyDe(mailCalls()[0]).data;
    expect(data.polizas).toEqual(['P-1', 'P-2']);
    const polizasDocs = new Set(data.documentos.map((d: any) => d.poliza));
    expect([...polizasDocs].sort()).toEqual(['P-1', 'P-2']);
    const enviados = notifs('enviado');
    expect(enviados).toHaveLength(2);
    expect(enviados[0].lote).toBe(enviados[1].lote);
    const enlace = db.mktExpedienteEnlace._rows()[0];
    expect(enlace.expedienteIds).toHaveLength(2);
  });

  it('exclusión: no envía, registra "excluido" y no cambia el estado', async () => {
    process.env.EXPEDIENTES_MAIL_WHITELIST = 'luis@test.com';
    const id = await crear('P-1');
    await svc.crearExclusion(
      { alcance: 'asegurado', valor: 'V-11222333', motivo: 'pidió no recibir' },
      'portal:1',
    );
    await enviarRecordatorios(BASE);
    expect(mailCalls()).toHaveLength(0);
    expect(notifs('excluido')).toHaveLength(1);
    const exp = db.mktExpediente._rows().find((e: any) => e.id === id);
    expect(exp.estadoDocumental).toBe('incompleto');
    expect(exp.intentos).toBe(0);
  });

  it('sin correo válido registra "sin_correo"', async () => {
    await crear('P-1', { email: null });
    await enviarRecordatorios(BASE);
    expect(notifs('sin_correo')).toHaveLength(1);
    expect(mailCalls()).toHaveLength(0);
  });
});

describe('job_run y scheduler', () => {
  it('la tarea automática corre una sola vez por día', async () => {
    const a = await ejecutarJob('diaria', { origen: 'auto', ahora: BASE });
    const b = await ejecutarJob('diaria', { origen: 'auto', ahora: BASE });
    expect(a.omitido).toBe(false);
    expect(b).toMatchObject({ omitido: true, motivo: 'ya_ejecutado_hoy' });
    const c = await ejecutarJob('diaria', {
      origen: 'auto',
      ahora: new Date(BASE.getTime() + DIA),
    });
    expect(c.omitido).toBe(false);
    expect(db.mktExpedienteJobRun._rows()).toHaveLength(2);
  });

  it('manual con forzar corre aparte, pero la cadencia no repite correos', async () => {
    process.env.EXPEDIENTES_MAIL_WHITELIST = 'luis@test.com';
    await crear('P-1');
    await ejecutarJob('diaria', { origen: 'auto', ahora: BASE });
    const f = await ejecutarJob('diaria', {
      origen: 'manual',
      forzar: true,
      ahora: BASE,
    });
    expect(f.omitido).toBe(false);
    expect(mailCalls()).toHaveLength(1);
  });

  it('scheduler: respeta la hora de Caracas y no repite en el día', async () => {
    const antes = new Date('2026-11-07T11:59:00.000Z'); // 07:59 Caracas
    expect(await tickScheduler(antes)).toEqual([]);
    const ocho = new Date('2026-11-07T12:00:00.000Z'); // 08:00 Caracas
    expect(await tickScheduler(ocho)).toEqual(['diaria']);
    expect(await tickScheduler(new Date(ocho.getTime() + 60_000))).toEqual([]);
    const once = new Date('2026-11-08T03:00:00.000Z'); // 23:00 Caracas del 7
    expect(await tickScheduler(once)).toEqual(['nocturna']);
    process.env.EXPEDIENTES_JOBS_ENABLED = 'false';
    _resetScheduler();
    expect(await tickScheduler(new Date('2026-11-08T12:30:00.000Z'))).toEqual(
      [],
    );
  });
});

describe('resumen nocturno', () => {
  it('se envía aunque haya cero y sin datos personales', async () => {
    process.env.EXPEDIENTES_MAIL_WHITELIST = 'lm@test.com';
    await svc.updateConfig(
      {
        destinatariosResumen: ['lm@test.com', 'otro@test.com'],
        motivo: 'qa',
      } as any,
      'portal:1',
    );
    const vacio = await tareaNocturna(BASE);
    expect(vacio).toMatchObject({ resultado: 'enviado' });
    expect(vacio.reportes[0]).toMatchObject({
      grupo: 'canales',
      completados: 0,
      incompletos: 0,
    });
    expect(mailCalls()).toHaveLength(1);
    expect(bodyDe(mailCalls()[0]).to).toBe('lm@test.com');
    expect(bodyDe(mailCalls()[0]).toExtra).toBeUndefined();

    await crear('P-1');
    const r = await tareaNocturna(BASE);
    expect(r.reportes[0]).toMatchObject({ completados: 0, incompletos: 1 });
    const body = bodyDe(mailCalls()[1]);
    expect(body.data.canales).toEqual({ completos: 0, incompletos: 1 });
    // El cuerpo solo lleva cifras: la póliza y el asegurado van en el Excel adjunto.
    const json = JSON.stringify({ ...body, attachments: undefined });
    expect(body.attachments).toHaveLength(1);
    expect(json).not.toContain('P-1');
    expect(json).not.toContain('11222333');
    expect(json).not.toContain('luis@test.com');
    expect(json).not.toContain('Luis');
    expect(json).not.toContain('monitor-expedientes');
  });

  it('sin destinatarios queda registrado como "sin_correo"', async () => {
    const r = await tareaNocturna(BASE);
    expect(r.resultado).toBe('sin_correo');
    expect(mailCalls()).toHaveLength(0);
  });
});
