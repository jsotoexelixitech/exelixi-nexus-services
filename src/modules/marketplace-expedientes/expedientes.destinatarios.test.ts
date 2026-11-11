/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * v1.4 (11-nov-2026): avisos a tomador Y asegurado/titular, relleno de correos desde la cotización
 * del wizard, bloqueo por lista blanca sin consumir la etapa y puesta en marcha de rezagados.
 */
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
import { enviarRecordatorios } from './expedientes.tareas';
import { puestaEnMarcha } from './expedientes.puesta-en-marcha';
import { clasificarExpediente } from './expedientes.clasificacion';
import { contactosDeWizard } from './expedientes.correos';
import { calcularEstadoDocumental, DEFAULT_CONFIG } from './expedientes.domain';

const db = prisma as any;
const DIA = 86_400_000;
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
function destinatarios(call: any[]) {
  const b = bodyDe(call);
  return [b.to, ...(b.toExtra ?? [])];
}
function notifs(resultado?: string) {
  return db.mktExpedienteNotificacion
    ._rows()
    .filter((n: any) => !resultado || n.resultado === resultado);
}
function exp(id: number) {
  return db.mktExpediente._rows().find((e: any) => e.id === id);
}

async function crear(
  poliza: string,
  opts: {
    email?: string | null;
    correos?: string[];
    documento?: string;
    emitida?: Date;
    sinCorreos?: boolean;
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
    {
      expediente: {
        centidad: 'C',
        ccanalalt: '900',
        producto: 'rcv',
        documentosEnWizard: true,
        asegurado: {
          tipoDoc: 'V',
          documento: opts.documento ?? '11222333',
          nombre: 'Luis',
          email: opts.email === undefined ? 'luis@test.com' : opts.email,
        },
        ...(opts.correos ? { correos: opts.correos } : {}),
      },
    },
  );
  return r!.id as number;
}

async function marcar(id: number, tipo: string, data: Record<string, any>) {
  await db.mktExpedienteRequisito.updateMany({
    where: { expedienteId: id, tipo },
    data,
  });
}

function diag(resultado: string) {
  return {
    estado: 'observado',
    ref: 'r1',
    analisisRef: 'r1',
    decision: 'ia',
    diagnostico: {
      resultado,
      resumen: 'x',
      campos: [],
      analizadoEn: BASE.toISOString(),
    },
  };
}

beforeEach(() => {
  db.$reset();
  process.env.EXPEDIENTES_ENABLED = 'true';
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

describe('correos de tomador y asegurado (v1.4)', () => {
  it('guarda los correos en el snapshot y la solicitud sale a los dos en una sola entrega', async () => {
    process.env.EXPEDIENTES_ENTORNO = 'produccion';
    const id = await crear('P-1', {
      email: 'titular@test.com',
      correos: ['tomador@test.com', 'TITULAR@test.com', 'malo'],
    });
    expect(exp(id).aseguradoEmail).toBe('titular@test.com');
    expect(exp(id).snapshot.correos).toEqual([
      'titular@test.com',
      'tomador@test.com',
    ]);
    await enviarRecordatorios(BASE);
    expect(mailCalls()).toHaveLength(1);
    expect(destinatarios(mailCalls()[0]).sort()).toEqual([
      'titular@test.com',
      'tomador@test.com',
    ]);
    expect(JSON.stringify(notifs())).not.toContain('tomador@test.com');
  });

  it('fuera de producción solo salen los de la lista blanca', async () => {
    process.env.EXPEDIENTES_MAIL_WHITELIST = 'tomador@test.com';
    await crear('P-1', {
      email: 'titular@test.com',
      correos: ['tomador@test.com'],
    });
    await enviarRecordatorios(BASE);
    expect(destinatarios(mailCalls()[0])).toEqual(['tomador@test.com']);
  });

  it('el aviso por evento (recibido) también va a los dos', async () => {
    process.env.EXPEDIENTES_ENTORNO = 'produccion';
    const id = await crear('P-1', {
      email: 'titular@test.com',
      correos: ['tomador@test.com'],
    });
    await svc.notificarEvento(exp(id), 'recibido', { tipo: 'cedula' });
    expect(destinatarios(mailCalls()[0]).sort()).toEqual([
      'titular@test.com',
      'tomador@test.com',
    ]);
  });

  it('expediente sin correo: lo recupera de la cotización del wizard y completa aseguradoEmail', async () => {
    process.env.EXPEDIENTES_ENTORNO = 'produccion';
    const id = await crear('P-9', { email: null, documento: '44555666' });
    await db.cotizacion.create({
      data: {
        empresaId: 7,
        jsonData: {
          product: 'rcv',
          tomador: { email: 'Tom@Test.com', nombre: 'Tom' },
          sameInsured: false,
          asegurado: { email: 'aseg@test.com' },
          policy: { cnpoliza: 'P-9' },
        },
      },
    });
    const previa = await svc.rellenarCorreos();
    expect(previa.recuperados).toBe(1);
    expect(exp(id).aseguradoEmail).toBeNull();
    await enviarRecordatorios(BASE);
    expect(destinatarios(mailCalls()[0]).sort()).toEqual([
      'aseg@test.com',
      'tom@test.com',
    ]);
    // Regla de Emisión: el principal es el del asegurado (titular), no el del tomador.
    expect(exp(id).aseguradoEmail).toBe('aseg@test.com');
    expect(exp(id).snapshot.correos).toEqual(['aseg@test.com', 'tom@test.com']);
    const otra = await svc.rellenarCorreos({ ejecutar: true });
    expect(otra.recuperados).toBe(0);
    expect(otra.yaResueltos).toBe(1);
  });

  it('contactosDeWizard: personas toma el titular como principal (también bajo data)', () => {
    expect(
      contactosDeWizard({
        data: {
          tomador: { email: 't@test.com' },
          funeral: { asegurados: [{ email: 'titu@test.com' }] },
        },
      }),
    ).toEqual({
      principal: 'titu@test.com',
      correos: ['t@test.com', 'titu@test.com'],
    });
  });
});

describe('lista blanca no consume la etapa', () => {
  it('bloqueado → la etapa queda libre; al declarar producción sale la solicitud inicial', async () => {
    const id = await crear('P-1');
    await enviarRecordatorios(BASE);
    expect(notifs('bloqueado_whitelist')).toHaveLength(1);
    expect(exp(id).etapaEnviada).toBe(-1);
    process.env.EXPEDIENTES_ENTORNO = 'produccion';
    await enviarRecordatorios(new Date(BASE.getTime() + DIA));
    expect(mailCalls()).toHaveLength(1);
    expect(bodyDe(mailCalls()[0]).data.tipo).toBe('solicitud');
    expect(exp(id).etapaEnviada).toBe(0);
  });
});

describe('qué se le pide al cliente', () => {
  it('documento que no coincide → incompleto y el correo lo lista como «corregir»', async () => {
    process.env.EXPEDIENTES_ENTORNO = 'produccion';
    const id = await crear('P-1');
    for (const t of ['licencia', 'certificado'])
      await marcar(id, t, { estado: 'validado' });
    await marcar(id, 'cedula', diag('no_coincide'));
    const reqs = db.mktExpedienteRequisito
      ._rows()
      .filter((r: any) => r.expedienteId === id);
    expect(
      calcularEstadoDocumental(DEFAULT_CONFIG.requisitosPorProducto.rcv, reqs),
    ).toBe('incompleto');
    expect(clasificarExpediente('rcv', reqs, DEFAULT_CONFIG)).toBe('corregir');
    await enviarRecordatorios(BASE);
    const docs = bodyDe(mailCalls()[0]).data.documentos;
    expect(
      docs.find((d: any) => d.nombre === 'Cédula de identidad').estado,
    ).toBe('corregir');
  });

  it('solo «datos_modificados» → no se le escribe al cliente ni se consume la etapa', async () => {
    process.env.EXPEDIENTES_ENTORNO = 'produccion';
    const id = await crear('P-1');
    for (const t of ['licencia', 'certificado'])
      await marcar(id, t, { estado: 'validado' });
    await marcar(id, 'cedula', diag('datos_modificados'));
    const r = await enviarRecordatorios(BASE);
    expect(r.soloDatosModificados).toBe(1);
    expect(mailCalls()).toHaveLength(0);
    expect(exp(id).etapaEnviada).toBe(-1);
  });

  it('clasificación: faltan, corregir, ambos, en revisión', () => {
    const c = (reqs: any[]) =>
      clasificarExpediente('rcv', reqs, DEFAULT_CONFIG);
    expect(c([])).toBe('faltan_documentos');
    expect(
      c([
        { tipo: 'cedula', ...diag('ilegible') },
        { tipo: 'licencia', estado: 'faltante' },
      ]),
    ).toBe('ambos');
    expect(
      c([
        { tipo: 'cedula', estado: 'recibido' },
        { tipo: 'licencia', estado: 'validado' },
        { tipo: 'certificado', estado: 'validado' },
      ]),
    ).toBe('solo_en_revision');
    // Observación manual del administrador: el cliente corrige aunque la IA dijera datos_modificados.
    expect(
      c([
        { tipo: 'cedula', ...diag('datos_modificados'), decision: 'manual' },
        { tipo: 'licencia', estado: 'validado' },
        { tipo: 'certificado', estado: 'validado' },
      ]),
    ).toBe('corregir');
  });
});

describe('puesta en marcha', () => {
  async function escenario() {
    // 1) Rezagado: 20 días, cadencia agotada y etapas marcadas por el bloqueo.
    const viejo = await crear('P-1', {
      emitida: new Date(BASE.getTime() - 20 * DIA),
      correos: ['tomador@test.com'],
    });
    await db.mktExpediente.update({
      where: { id: viejo },
      data: { etapaEnviada: 3, cadenciaAgotada: true },
    });
    // 2) Documento que no coincide (5 días).
    const obs = await crear('P-2', {
      documento: '22333444',
      email: 'ana@test.com',
      emitida: new Date(BASE.getTime() - 5 * DIA),
    });
    await marcar(obs, 'licencia', { estado: 'validado' });
    await marcar(obs, 'certificado', { estado: 'validado' });
    await marcar(obs, 'cedula', diag('no_coincide'));
    // 3) Solo datos modificados: no sale.
    const dm = await crear('P-3', {
      documento: '33444555',
      email: 'b@test.com',
    });
    await marcar(dm, 'licencia', { estado: 'validado' });
    await marcar(dm, 'certificado', { estado: 'validado' });
    await marcar(dm, 'cedula', diag('datos_modificados'));
    // 4) Ya notificado con éxito: no sale.
    const ya = await crear('P-4', {
      documento: '44555666',
      email: 'c@test.com',
    });
    await svc.registrarNotificacion({
      expedienteId: ya,
      tipo: 'solicitud_inicial',
      resultado: 'enviado',
    });
    await db.mktExpediente.update({
      where: { id: ya },
      data: { etapaEnviada: 0 },
    });
    // 5) Sin correo en ningún lado: no sale.
    await crear('P-5', { documento: '55666777', email: null });
    // 6) Excluido: no sale.
    const exc = await crear('P-6', {
      documento: '66777888',
      email: 'd@test.com',
    });
    await db.mktExpedienteExclusion.create({
      data: { alcance: 'poliza', expedienteId: exc, activo: true },
    });
    return { viejo, obs, dm };
  }

  it('vista previa: cifras por motivo, producto y área sin enviar ni escribir', async () => {
    process.env.EXPEDIENTES_ENTORNO = 'produccion';
    await escenario();
    const antes = JSON.stringify(db.mktExpediente._rows());
    const r: any = await puestaEnMarcha({ ahora: BASE });
    expect(r.modo).toBe('vista_previa');
    expect(r.seEnvian.expedientes).toBe(2);
    expect(r.seEnvian.correos).toBe(2);
    expect(r.seEnvian.destinatarios).toBe(3);
    expect(r.seEnvian.porMotivo).toEqual({
      faltan_documentos: 1,
      corregir: 1,
      ambos: 0,
    });
    expect(r.seEnvian.porProducto).toEqual({ rcv: 2 });
    expect(r.seEnvian.porArea).toEqual({ canal: 2 });
    expect(r.noSeEnvian).toEqual({
      excluidos: 1,
      yaNotificados: 1,
      soloDatosModificados: 1,
      soloEnRevision: 0,
      sinCorreo: 1,
    });
    expect(mailCalls()).toHaveLength(0);
    expect(JSON.stringify(db.mktExpediente._rows())).toBe(antes);
    expect(JSON.stringify(r)).not.toContain('@');
  });

  it('ejecutar: una sola solicitud por rezagado, idempotente y la cadencia sigue sin cascada', async () => {
    process.env.EXPEDIENTES_ENTORNO = 'produccion';
    const { viejo, obs } = await escenario();
    const dormir = vi.fn(async () => {});
    const r: any = await puestaEnMarcha({
      ejecutar: true,
      ahora: BASE,
      tamanoLote: 1,
      pausaMs: 10,
      dormir,
    });
    expect(r.resultado.enviados).toBe(2);
    expect(mailCalls()).toHaveLength(2);
    expect(dormir).toHaveBeenCalledTimes(2);
    expect(mailCalls().every((c) => bodyDe(c).data.tipo === 'solicitud')).toBe(
      true,
    );
    // Etapa según días: 20 días → se mantiene 3 (agotada); 5 días → etapa 1 (día 3).
    expect(exp(viejo).etapaEnviada).toBe(3);
    expect(exp(obs).etapaEnviada).toBe(1);

    const otra: any = await puestaEnMarcha({ ejecutar: true, ahora: BASE });
    expect(otra.seEnvian.expedientes).toBe(0);
    expect(mailCalls()).toHaveLength(2);

    // La diaria no reenvía etapas viejas; la próxima (día 7) sale cuando toca.
    await enviarRecordatorios(BASE);
    expect(mailCalls()).toHaveLength(2);
    await enviarRecordatorios(new Date(BASE.getTime() + 2 * DIA));
    expect(mailCalls()).toHaveLength(3);
    expect(bodyDe(mailCalls()[2]).data.tipo).toBe('recordatorio');
  });
});
