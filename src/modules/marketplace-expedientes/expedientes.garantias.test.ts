/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * Garantía del monitor de expedientes (producción, 12-nov-2026): un documento solo queda
 * «validado» por la IA si la lectura COINCIDE con los datos de la póliza. Cualquier otro
 * resultado (otra persona, licencia vencida, otro tipo de documento, ilegible, lectura parcial,
 * IA caída, timeout, OCR sin modelo) lo deja observado o pendiente de análisis, el expediente
 * sigue incompleto y dentro de la cadencia de recordatorios.
 * Sin BD real ni Gemini: Prisma en memoria y el OCR interno simulado con fetch.
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
  authenticate: (_req: any, res: any) => res.status(401).json({}),
}));
vi.mock('../portal/portal-admin.middleware', () => ({
  requirePortalAdmin: (_req: any, res: any) => res.status(403).json({}),
}));

import prisma from '../../config/prisma';
import router from './expedientes.routes';
import { expedientesService as svc } from './expedientes.service';
import { calcularEstadoDocumental } from './expedientes.domain';
import { ocrTimeoutMs } from './expedientes.env';
import {
  contextoPoliza,
  diagnosticar,
  estadoPorDiagnostico,
  RESULTADOS_IA,
} from './expedientes.ia';

const db = prisma as any;
const app = express();
app.use(express.json());
app.use('/api/expedientes', router);

const REF = {
  cedula: 'La Mundial de Seguros/12345678/2321234-26-11-1100015737/cedula.webp',
  licencia:
    'La Mundial de Seguros/12345678/2321234-26-11-1100015737/licencia.webp',
};
const CEDULA_OK = {
  identificacion: '12345678',
  tipoDoc: 'V',
  nombre: 'MARIA JOSE',
  apellido: 'PEREZ GOMEZ',
};
const LICENCIA_OK = {
  identificacion: '12345678',
  tipoDoc: 'V',
  nombre: 'Maria Jose',
  apellido: 'Perez Gomez',
  numeroLicencia: 'LIC-1',
  vencimiento: '2031-06-30',
};
const PERSONA = {
  tipoDoc: 'V',
  documento: '12345678',
  nombre: 'María José',
  apellido: 'Pérez Gómez',
};
const SNAPSHOT = { tomador: PERSONA, asegurado: PERSONA, plan: 'RCV01' };

/** Respuesta del OCR por ref para /analizar: { status, body } o un error lanzado. */
let ocr: Map<string, { status: number; body: any } | Error>;
let documentoOcr: { status: number; body: any } | Error;
let fetchMock: ReturnType<typeof vi.fn>;

function respuesta(status: number, body: unknown) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function lectura(ref: string, ocrBody: any) {
  return {
    status: 200,
    body: { ok: true, ref, hash: `h-${ref}`, ocr: ocrBody },
  };
}

function timeout(): Error {
  const e = new Error('The operation was aborted due to timeout');
  e.name = 'TimeoutError';
  return e;
}

async function crearRcv(poliza: string, documentos = ['cedula', 'licencia']) {
  const r = await svc.registrarDesdeEmision(
    {
      id: Number(poliza.replace(/\D/g, '')) || 1,
      empresaId: 7,
      polizaNumero: poliza,
      jsonData: { producto: 'rcv' },
    },
    {
      expediente: {
        centidad: 'C',
        ccanalalt: '900',
        producto: 'rcv',
        asegurado: { ...PERSONA, email: 'maria@test.com' },
        snapshot: SNAPSHOT,
        documentos: Object.fromEntries(
          documentos.map((t) => [
            t,
            { recibido: true, ref: (REF as any)[t], url: `/files/${t}` },
          ]),
        ),
      },
    },
  );
  await svc.esperarAnalisisPendientes();
  return r!.id;
}

const req = (id: number, tipo: string) =>
  db.mktExpedienteRequisito
    ._rows()
    .find((x: any) => x.expedienteId === id && x.tipo === tipo);
const exp = (id: number) =>
  db.mktExpediente._rows().find((x: any) => x.id === id);

/** El expediente sigue incompleto y en la cadencia de recordatorios. */
function sigueIncompletoYEnRecordatorios(id: number) {
  expect(exp(id)).toMatchObject({
    estadoDocumental: 'incompleto',
    cadenciaAgotada: false,
  });
}

beforeEach(() => {
  db.$reset();
  process.env.EXPEDIENTES_ENABLED = 'true';
  process.env.OCR_INTERNAL_URL = 'http://ocr.local';
  process.env.EXPEDIENTE_INTERNAL_KEY = 'clave-interna';
  process.env.EXPEDIENTES_PUBLIC_URL = 'https://portal.test/portal-lm';
  delete process.env.EXPEDIENTES_MAIL_WHITELIST;
  delete process.env.EXPEDIENTES_ENTORNO;
  delete process.env.EXPEDIENTES_JOBS_ENABLED;
  delete process.env.EXPEDIENTES_OCR_TIMEOUT_MS;
  ocr = new Map();
  ocr.set(
    REF.cedula,
    lectura(REF.cedula, {
      extraido: CEDULA_OK,
      confianza: 1,
      proveedor: 'gemini',
    }),
  );
  ocr.set(
    REF.licencia,
    lectura(REF.licencia, {
      extraido: LICENCIA_OK,
      confianza: 1,
      proveedor: 'gemini',
    }),
  );
  documentoOcr = { status: 500, body: { ok: false } };
  fetchMock = vi.fn(async (url: string, init: any) => {
    const u = String(url);
    if (u.endsWith('/api/internal/expedientes/analizar')) {
      const { ref } = JSON.parse(init.body);
      const r = ocr.get(ref) ?? {
        status: 404,
        body: { ok: false, code: 'ARCHIVO_NO_ENCONTRADO' },
      };
      if (r instanceof Error) throw r;
      return respuesta(r.status, r.body);
    }
    if (u.endsWith('/api/internal/expedientes/documento')) {
      if (documentoOcr instanceof Error) throw documentoOcr;
      return respuesta(documentoOcr.status, documentoOcr.body);
    }
    return respuesta(200, { status: true, data: { sent: true } });
  });
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(async () => {
  await svc.esperarAnalisisPendientes();
  vi.unstubAllGlobals();
});

describe('reglas puras: solo «coincide» valida', () => {
  it('ningún resultado de la IA distinto de coincide deja el requisito validado', () => {
    for (const resultado of RESULTADOS_IA) {
      const { estado } = estadoPorDiagnostico({
        resultado,
        resumen: 'x',
      } as any);
      if (resultado === 'coincide') expect(estado).toBe('validado');
      else expect(estado).not.toBe('validado');
    }
    // Resultado desconocido (dato corrupto en BD): tampoco valida.
    expect(
      estadoPorDiagnostico({ resultado: 'otro', resumen: 'x' } as any).estado,
    ).toBe('recibido');
  });

  it('el expediente solo es completo si TODOS los requisitos están validados', () => {
    for (const otro of ['faltante', 'recibido', 'observado']) {
      expect(
        calcularEstadoDocumental(
          ['cedula', 'licencia'],
          [
            { tipo: 'cedula', estado: 'validado' },
            { tipo: 'licencia', estado: otro },
          ],
        ),
      ).toBe('incompleto');
    }
    expect(calcularEstadoDocumental([], [])).toBe('incompleto');
  });

  it('diagnóstico: otra persona, vencida, otro tipo, parcial, ilegible, IA caída → nunca validado', () => {
    const ctx = contextoPoliza({ snapshot: SNAPSHOT } as any);
    const ahora = new Date('2026-11-12T12:00:00Z');
    const casos: [string, any][] = [
      [
        'cedula',
        {
          extraido: {
            ...CEDULA_OK,
            identificacion: '87654321',
            nombre: 'PEDRO',
            apellido: 'RAMIREZ',
          },
          confianza: 1,
          proveedor: 'gemini',
        },
      ],
      [
        'licencia',
        {
          extraido: { ...LICENCIA_OK, vencimiento: '2020-01-31' },
          confianza: 1,
          proveedor: 'gemini',
        },
      ],
      [
        'cedula',
        {
          extraido: null,
          confianza: 0,
          proveedor: 'gemini',
          falla: 'tipo_documento',
          motivo: 'Parece una licencia',
        },
      ],
      ['cedula', { extraido: CEDULA_OK, confianza: 0.5, proveedor: 'gemini' }],
      ['cedula', { extraido: null, confianza: 0, proveedor: 'gemini' }],
      [
        'cedula',
        { extraido: null, confianza: 0, proveedor: 'gemini', falla: 'tecnica' },
      ],
      [
        'cedula',
        { extraido: null, confianza: 0, proveedor: 'mock', falla: 'tecnica' },
      ],
      ['cedula', null],
    ];
    for (const [tipo, lect] of casos) {
      const d = diagnosticar(tipo, lect, ctx, { ahora });
      expect(d.resultado).not.toBe('coincide');
      expect(estadoPorDiagnostico(d).estado).not.toBe('validado');
    }
    // Control: la lectura correcta sí coincide (las pruebas de arriba no pasan por vacío).
    expect(
      diagnosticar(
        'cedula',
        { extraido: CEDULA_OK, confianza: 1, proveedor: 'gemini' },
        ctx,
        { ahora },
      ).resultado,
    ).toBe('coincide');
  });
});

describe('validación automática contra la póliza (analizar)', () => {
  it('control: cédula y licencia correctas → validadas; sin certificado sigue incompleto', async () => {
    const id = await crearRcv('P-1');
    expect(req(id, 'cedula').estado).toBe('validado');
    expect(req(id, 'licencia').estado).toBe('validado');
    expect(req(id, 'certificado').estado).toBe('faltante');
    sigueIncompletoYEnRecordatorios(id);
  });

  it('cédula de otra persona → observado (no coincide), expediente incompleto', async () => {
    ocr.set(
      REF.cedula,
      lectura(REF.cedula, {
        extraido: {
          ...CEDULA_OK,
          identificacion: '87654321',
          nombre: 'PEDRO',
          apellido: 'RAMIREZ',
        },
        confianza: 1,
        proveedor: 'gemini',
      }),
    );
    const id = await crearRcv('P-2');
    expect(req(id, 'cedula')).toMatchObject({
      estado: 'observado',
      decision: 'ia',
      validadoEn: null,
    });
    expect(req(id, 'cedula').diagnostico.resultado).toBe('no_coincide');
    sigueIncompletoYEnRecordatorios(id);
  });

  it('licencia vencida → observado, expediente incompleto', async () => {
    ocr.set(
      REF.licencia,
      lectura(REF.licencia, {
        extraido: { ...LICENCIA_OK, vencimiento: '2020-01-31' },
        confianza: 1,
        proveedor: 'gemini',
      }),
    );
    const id = await crearRcv('P-3');
    expect(req(id, 'licencia')).toMatchObject({
      estado: 'observado',
      validadoEn: null,
    });
    expect(req(id, 'licencia').diagnostico.resultado).toBe('no_coincide');
    sigueIncompletoYEnRecordatorios(id);
  });

  it('documento de otro tipo → observado, expediente incompleto', async () => {
    ocr.set(
      REF.cedula,
      lectura(REF.cedula, {
        extraido: null,
        confianza: 0,
        proveedor: 'gemini',
        falla: 'tipo_documento',
        motivo: 'Parece una licencia',
      }),
    );
    const id = await crearRcv('P-4');
    expect(req(id, 'cedula')).toMatchObject({
      estado: 'observado',
      validadoEn: null,
    });
    sigueIncompletoYEnRecordatorios(id);
  });

  it('lectura parcial (confianza 0.5) aunque los datos coincidan → observado para revisar', async () => {
    ocr.set(
      REF.cedula,
      lectura(REF.cedula, {
        extraido: CEDULA_OK,
        confianza: 0.5,
        proveedor: 'gemini',
      }),
    );
    const id = await crearRcv('P-5');
    expect(req(id, 'cedula').estado).toBe('observado');
    expect(req(id, 'cedula').diagnostico.resultado).toBe('sin_certeza');
    sigueIncompletoYEnRecordatorios(id);
  });

  it('IA caída (OCR 503) → pendiente de análisis con reintento, nunca validado', async () => {
    ocr.set(REF.cedula, { status: 503, body: { ok: false, code: 'X' } });
    const id = await crearRcv('P-6');
    const r = req(id, 'cedula');
    expect(r).toMatchObject({
      estado: 'recibido',
      validadoEn: null,
      decision: null,
    });
    expect(r.proximoAnalisis).toBeInstanceOf(Date);
    expect(r.diagnostico.resultado).toBe('error_tecnico');
    sigueIncompletoYEnRecordatorios(id);
  });

  it('timeout del OCR (modelo pro lento) → pendiente de análisis, nunca validado', async () => {
    ocr.set(REF.cedula, timeout());
    const id = await crearRcv('P-7');
    const r = req(id, 'cedula');
    expect(r).toMatchObject({ estado: 'recibido', validadoEn: null });
    expect(r.diagnostico.resultado).toBe('error_tecnico');
    expect(r.diagnostico.resumen).toContain('240 s');
    sigueIncompletoYEnRecordatorios(id);
  });

  it('falla técnica del OCR (flash falló / OCR sin modelo) → recibido y se reintenta; el reintento con el pro valida', async () => {
    ocr.set(
      REF.cedula,
      lectura(REF.cedula, {
        extraido: null,
        confianza: 0,
        proveedor: 'gemini',
        falla: 'tecnica',
        motivo: 'No se pudo leer el documento (OCR no disponible).',
        modelos: [
          { modelo: 'gemini-3.1-pro-preview', resultado: 'error' },
          { modelo: 'gemini-3.6-flash', resultado: 'error' },
        ],
      }),
    );
    const id = await crearRcv('P-8');
    const r = req(id, 'cedula');
    // No es culpa del cliente: no se le marca observado ni se valida.
    expect(r).toMatchObject({ estado: 'recibido', validadoEn: null });
    expect(r.diagnostico).toMatchObject({
      resultado: 'error_tecnico',
      modelos: [
        { modelo: 'gemini-3.1-pro-preview', resultado: 'error' },
        { modelo: 'gemini-3.6-flash', resultado: 'error' },
      ],
    });
    sigueIncompletoYEnRecordatorios(id);

    // Reintento programado: ahora lee el pro y coincide.
    ocr.set(
      REF.cedula,
      lectura(REF.cedula, {
        extraido: CEDULA_OK,
        confianza: 1,
        proveedor: 'gemini',
        modelo: 'gemini-3.1-pro-preview',
        modelos: [{ modelo: 'gemini-3.1-pro-preview', resultado: 'ok' }],
      }),
    );
    await svc.revisarConIa({
      modo: 'recibidos',
      ahora: new Date(r.proximoAnalisis.getTime() + 1000),
    });
    expect(req(id, 'cedula')).toMatchObject({
      estado: 'validado',
      decision: 'ia',
    });
    // Auditoría: el diagnóstico guarda qué modelo validó.
    expect(req(id, 'cedula').diagnostico.modelo).toBe('gemini-3.1-pro-preview');
  });

  it('OCR simulado (sin Gemini) → nunca valida', async () => {
    ocr.set(
      REF.cedula,
      lectura(REF.cedula, {
        extraido: null,
        confianza: 0,
        proveedor: 'mock',
        falla: 'tecnica',
        motivo: 'OCR simulado: sin lectura real.',
      }),
    );
    const id = await crearRcv('P-9');
    expect(req(id, 'cedula').estado).toBe('recibido');
    sigueIncompletoYEnRecordatorios(id);
  });

  it('sin OCR configurado → no analiza, nada se valida solo', async () => {
    delete process.env.OCR_INTERNAL_URL;
    const id = await crearRcv('P-10');
    expect(req(id, 'cedula').estado).not.toBe('validado');
    expect(req(id, 'licencia').estado).not.toBe('validado');
    sigueIncompletoYEnRecordatorios(id);
  });
});

describe('carga del cliente por su enlace', () => {
  const JPG = Buffer.concat([
    Buffer.from([0xff, 0xd8, 0xff, 0xe0]),
    Buffer.alloc(200, 1),
  ]);

  async function subir(id: number) {
    const { token } = await svc.crearEnlace('V12345678', [id]);
    return request(app)
      .post(`/api/expedientes/publico/${token}/upload`)
      .field('tipo', 'cedula')
      .attach('file', JPG, 'c.jpg');
  }

  it('cédula de otra persona subida por el cliente → observado, nunca validado', async () => {
    ocr.set(
      REF.cedula,
      lectura(REF.cedula, {
        extraido: null,
        confianza: 0,
        proveedor: 'gemini',
      }),
    );
    const id = await crearRcv('P-11', ['cedula']);
    expect(req(id, 'cedula').estado).toBe('observado');
    documentoOcr = {
      status: 200,
      body: {
        ok: true,
        ref: 'La Mundial de Seguros/12345678/x/cedula-1.jpg',
        hash: 'h1',
        ocr: {
          extraido: {
            ...CEDULA_OK,
            identificacion: '87654321',
            nombre: 'PEDRO',
            apellido: 'RAMIREZ',
          },
          confianza: 1,
          proveedor: 'gemini',
          modelo: 'gemini-3.1-pro-preview',
        },
      },
    };
    const up = await subir(id);
    expect(up.status).toBe(201);
    expect(up.body.data.estado).toBe('observado');
    expect(req(id, 'cedula')).toMatchObject({
      estado: 'observado',
      validadoEn: null,
      origen: 'publico',
    });
    expect(req(id, 'cedula').diagnostico.modelo).toBe('gemini-3.1-pro-preview');
    sigueIncompletoYEnRecordatorios(id);
  });

  it('IA caída en la carga (falla técnica) → recibido, pendiente de análisis', async () => {
    ocr.set(
      REF.cedula,
      lectura(REF.cedula, {
        extraido: null,
        confianza: 0,
        proveedor: 'gemini',
      }),
    );
    const id = await crearRcv('P-12', ['cedula']);
    documentoOcr = {
      status: 200,
      body: {
        ok: true,
        ref: 'La Mundial de Seguros/12345678/x/cedula-2.jpg',
        hash: 'h2',
        ocr: {
          extraido: null,
          confianza: 0,
          proveedor: 'gemini',
          falla: 'tecnica',
          motivo: 'OCR no disponible',
        },
      },
    };
    const up = await subir(id);
    expect(up.status).toBe(201);
    expect(req(id, 'cedula')).toMatchObject({
      estado: 'recibido',
      validadoEn: null,
    });
    expect(req(id, 'cedula').proximoAnalisis).toBeInstanceOf(Date);
    sigueIncompletoYEnRecordatorios(id);
  });

  it('timeout del OCR en la carga → error al cliente y el requisito no cambia', async () => {
    ocr.set(
      REF.cedula,
      lectura(REF.cedula, {
        extraido: null,
        confianza: 0,
        proveedor: 'gemini',
      }),
    );
    const id = await crearRcv('P-13', ['cedula']);
    const antes = req(id, 'cedula').estado;
    documentoOcr = timeout();
    const up = await subir(id);
    expect(up.status).toBe(502);
    expect(req(id, 'cedula').estado).toBe(antes);
    expect(req(id, 'cedula').estado).not.toBe('validado');
    sigueIncompletoYEnRecordatorios(id);
  });
});

describe('nombre del archivo que se envía al OCR', () => {
  it('la extensión sale del contenido detectado, no del nombre del cliente', async () => {
    ocr.set(
      REF.cedula,
      lectura(REF.cedula, {
        extraido: null,
        confianza: 0,
        proveedor: 'gemini',
      }),
    );
    const id = await crearRcv('P-15', ['cedula']);
    documentoOcr = {
      status: 200,
      body: {
        ok: true,
        ref: 'x/cedula-9.pdf',
        hash: 'h9',
        ocr: {
          extraido: null,
          confianza: 0,
          proveedor: 'gemini',
          falla: 'tecnica',
        },
      },
    };
    const { token } = await svc.crearEnlace('V12345678', [id]);
    const PDF = Buffer.concat([
      Buffer.from('%PDF-1.4\n'),
      Buffer.alloc(200, 0x20),
    ]);
    const up = await request(app)
      .post(`/api/expedientes/publico/${token}/upload`)
      .field('tipo', 'cedula')
      .attach('file', PDF, 'cedula.html');
    expect(up.status).toBe(201);
    const llamada = fetchMock.mock.calls.find(([u]: any[]) =>
      String(u).endsWith('/api/internal/expedientes/documento'),
    );
    const enviado = (llamada![1].body as FormData).get('file') as File;
    expect(enviado.name).toBe('cedula.pdf');
    expect(enviado.type).toBe('application/pdf');
  });
});

describe('timeout Nexus → OCR', () => {
  it('240 s por defecto (el pro tarda hasta ~150 s), configurable y acotado', () => {
    expect(ocrTimeoutMs()).toBe(240_000);
    process.env.EXPEDIENTES_OCR_TIMEOUT_MS = '300000';
    expect(ocrTimeoutMs()).toBe(300_000);
    process.env.EXPEDIENTES_OCR_TIMEOUT_MS = '1000';
    expect(ocrTimeoutMs()).toBe(30_000);
    process.env.EXPEDIENTES_OCR_TIMEOUT_MS = '9999999';
    expect(ocrTimeoutMs()).toBe(600_000);
    process.env.EXPEDIENTES_OCR_TIMEOUT_MS = 'abc';
    expect(ocrTimeoutMs()).toBe(240_000);
  });

  it('las llamadas al OCR usan ese timeout', async () => {
    const spy = vi.spyOn(AbortSignal, 'timeout');
    await crearRcv('P-14', ['cedula']);
    expect(spy).toHaveBeenCalledWith(240_000);
    spy.mockRestore();
  });
});
