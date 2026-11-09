/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * Validación automática con IA del monitor de expedientes (sin BD real ni Gemini:
 * Prisma en memoria y el OCR interno simulado con fetch).
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
  ColaConcurrencia,
  contextoPoliza,
  diagnosticar,
  esperaReintentoMs,
  estadoPorDiagnostico,
  huellaPoliza,
  maskDocumento,
  motivoAnalisis,
  motivoParaAsegurado,
  VERSION_COMPARADOR,
} from './expedientes.ia';
import { ejecutarJob } from './expedientes.jobs';

const db = prisma as any;
const app = express();
app.use(express.json());
app.use('/api/expedientes', router);
const AUTH = { Authorization: 'Bearer x' };

const REF = {
  cedula: 'La Mundial de Seguros/12345678/2321234-26-11-1100015737/cedula.webp',
  licencia:
    'La Mundial de Seguros/12345678/2321234-26-11-1100015737/licencia.webp',
  certificado:
    'La Mundial de Seguros/12345678/2321234-26-11-1100015737/certificado.pdf',
};

const LECTURA_OK: Record<string, any> = {
  cedula: {
    identificacion: '12345678',
    tipoDoc: 'V',
    nombre: 'MARIA',
    apellido: 'PEREZ',
  },
  licencia: {
    identificacion: '12345678',
    tipoDoc: 'V',
    nombre: 'Maria Jose',
    apellido: 'Perez',
    numeroLicencia: 'LIC-1',
    vencimiento: '2031-06-30',
  },
  certificado: {
    placa: 'AB-123-CD',
    marca: 'TOYOTA',
    modelo: 'COROLLA XEI',
    anio: '2020',
    serial: '9BWZZZ377VT004251',
    serialMotor: 'MTR123456',
  },
};

/** Respuesta del OCR por ref: { status, body } o función. */
let ocr: Map<string, { status: number; body: any }>;
let fetchMock: ReturnType<typeof vi.fn>;

function respuesta(status: number, body: unknown) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function lee(ref: string, extraido: any, confianza = 1, extra: any = {}) {
  ocr.set(ref, {
    status: 200,
    body: {
      ok: true,
      ref,
      hash: `h-${ref.length}-${JSON.stringify(extraido).length}`,
      ocr: { extraido, confianza, proveedor: 'gemini', ...extra },
    },
  });
}

function llamadasAnalizar(ref?: string) {
  return fetchMock.mock.calls.filter(
    ([url, init]: any[]) =>
      String(url).endsWith('/api/internal/expedientes/analizar') &&
      (!ref || JSON.parse(init.body).ref === ref),
  );
}

const SNAPSHOT = {
  tomador: {
    tipoDoc: 'V',
    documento: '12345678',
    nombre: 'María José',
    apellido: 'Pérez Gómez',
  },
  asegurado: {
    tipoDoc: 'V',
    documento: '12345678',
    nombre: 'María José',
    apellido: 'Pérez Gómez',
  },
  vehiculo: {
    placa: 'AB123CD',
    marca: 'Toyota',
    modelo: 'Corolla',
    anio: 2020,
    serial: '9BWZZZ377VT004251',
    serialMotor: 'MTR123456',
  },
  plan: 'RCV01',
};

async function crearRcv(
  poliza: string,
  opts: {
    snapshot?: any;
    documentos?: string[];
    ocrLeido?: Record<string, any>;
  } = {},
) {
  const docs = opts.documentos ?? ['cedula', 'licencia', 'certificado'];
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
        asegurado: {
          tipoDoc: 'V',
          documento: '12345678',
          nombre: 'María José',
          apellido: 'Pérez Gómez',
          email: 'maria@test.com',
        },
        snapshot: opts.snapshot ?? SNAPSHOT,
        documentos: Object.fromEntries(
          docs.map((t) => [
            t,
            {
              recibido: true,
              ref: (REF as any)[t],
              url: `/files/${t}`,
              ...(opts.ocrLeido?.[t] ? { ocrLeido: opts.ocrLeido[t] } : {}),
            },
          ]),
        ),
      },
    },
  );
  await svc.esperarAnalisisPendientes();
  return r!.id;
}

function req(id: number, tipo: string) {
  return db.mktExpedienteRequisito
    ._rows()
    .find((x: any) => x.expedienteId === id && x.tipo === tipo);
}

function exp(id: number) {
  return db.mktExpediente._rows().find((x: any) => x.id === id);
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
  ocr = new Map();
  for (const t of ['cedula', 'licencia', 'certificado'])
    lee((REF as any)[t], LECTURA_OK[t]);
  fetchMock = vi.fn(async (url: string, init: any) => {
    if (String(url).endsWith('/api/internal/expedientes/analizar')) {
      const { ref } = JSON.parse(init.body);
      const r = ocr.get(ref) ?? {
        status: 404,
        body: { ok: false, code: 'ARCHIVO_NO_ENCONTRADO' },
      };
      return respuesta(r.status, r.body);
    }
    return respuesta(200, { status: true, data: { sent: true } });
  });
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(async () => {
  await svc.esperarAnalisisPendientes();
  vi.unstubAllGlobals();
});

describe('validación automática al crear el expediente (documentos del wizard)', () => {
  it('cédula, licencia y certificado que coinciden → validados por la IA y expediente completo', async () => {
    const id = await crearRcv('P-1');
    for (const t of ['cedula', 'licencia', 'certificado']) {
      expect(req(id, t)).toMatchObject({
        estado: 'validado',
        validadoPor: 'ia',
        decision: 'ia',
        analisisRef: (REF as any)[t],
      });
      expect(req(id, t).diagnostico).toMatchObject({
        resultado: 'coincide',
        proveedor: 'gemini',
        confianza: 1,
      });
      expect(req(id, t).archivoHash).toMatch(/^h-/);
      expect(req(id, t).huellaPoliza).toMatch(/^[0-9a-f]{64}$/);
    }
    expect(exp(id).estadoDocumental).toBe('completo');
    // Llamada al OCR: endpoint interno, clave y timeout de 90 s.
    const [url, init] = llamadasAnalizar(REF.cedula)[0];
    expect(url).toBe('http://ocr.local/api/internal/expedientes/analizar');
    expect(init.headers['x-expediente-key']).toBe('clave-interna');
    expect(JSON.parse(init.body)).toEqual({ ref: REF.cedula, tipo: 'cedula' });
    expect(init.signal).toBeDefined();
    // Auditoría con el diagnóstico.
    const ev = db.mktExpedienteEvento
      ._rows()
      .find(
        (x: any) =>
          x.tipo === 'requisito_validado' && x.detalle.tipo === 'cedula',
      );
    expect(ev.actor).toBe('ia');
    expect(ev.detalle.diagnostico.resultado).toBe('coincide');
    expect(ev.detalle.anterior).toBe('recibido');
  });

  it('cédula de otra persona → observado con diagnóstico campo por campo y números enmascarados', async () => {
    lee(REF.cedula, {
      identificacion: '87654321',
      tipoDoc: 'V',
      nombre: 'PEDRO',
      apellido: 'GOMEZ',
    });
    const id = await crearRcv('P-2', { documentos: ['cedula'] });
    const r = req(id, 'cedula');
    expect(r.estado).toBe('observado');
    expect(r.decision).toBe('ia');
    expect(r.diagnostico.resultado).toBe('no_coincide');
    expect(r.diagnostico.resumen).toContain(
      'La cédula del documento (V-****4321) no coincide con la del tomador (V-****5678).',
    );
    expect(r.motivo).toBe(r.diagnostico.resumen);
    expect(r.diagnostico.resumen).not.toMatch(/12345678|87654321/);
    const doc = r.diagnostico.campos.find((c: any) => c.campo === 'documento');
    expect(doc).toMatchObject({
      etiqueta: 'Número de cédula',
      enPoliza: 'V-****5678',
      enDocumento: 'V-****4321',
      coincide: false,
    });
    expect(
      r.diagnostico.campos.find((c: any) => c.campo === 'nombre').coincide,
    ).toBe(false);
    expect(exp(id).estadoDocumental).toBe('incompleto');
    const ev = db.mktExpedienteEvento
      ._rows()
      .find((x: any) => x.tipo === 'requisito_observado');
    expect(ev).toMatchObject({ actor: 'ia' });
    expect(ev.detalle.diagnostico.resultado).toBe('no_coincide');
  });

  it('certificado con placa o serial distinto → observado', async () => {
    lee(REF.certificado, { ...LECTURA_OK.certificado, placa: 'XY999ZZ' });
    const a = await crearRcv('P-3', { documentos: ['certificado'] });
    expect(req(a, 'certificado').estado).toBe('observado');
    expect(req(a, 'certificado').diagnostico.resumen).toContain(
      'La placa del certificado (XY999ZZ) no coincide con la del vehículo asegurado (AB123CD).',
    );

    lee(REF.certificado, {
      ...LECTURA_OK.certificado,
      serial: '8AWZZZ111XX000001',
    });
    const b = await crearRcv('P-4', { documentos: ['certificado'] });
    const r = req(b, 'certificado');
    expect(r.estado).toBe('observado');
    expect(r.diagnostico.resultado).toBe('no_coincide');
    expect(
      r.diagnostico.campos.find((c: any) => c.campo === 'serialCarroceria'),
    ).toMatchObject({
      enPoliza: '9BWZZZ377VT004251',
      enDocumento: '8AWZZZ111XX000001',
      coincide: false,
    });
    expect(
      r.diagnostico.campos.find((c: any) => c.campo === 'placa').coincide,
    ).toBe(true);
  });

  it('ilegible → observado con el motivo del OCR', async () => {
    ocr.set(REF.licencia, {
      status: 200,
      body: {
        ok: true,
        ref: REF.licencia,
        hash: 'h1',
        ocr: {
          extraido: null,
          confianza: 0,
          motivo: 'Imagen borrosa',
          proveedor: 'gemini',
        },
      },
    });
    const id = await crearRcv('P-5', { documentos: ['licencia'] });
    expect(req(id, 'licencia')).toMatchObject({
      estado: 'observado',
      motivo: 'Imagen borrosa',
    });
    expect(req(id, 'licencia').diagnostico.resultado).toBe('ilegible');
  });

  it('error técnico → sigue recibido, reintenta con espera creciente y luego valida', async () => {
    ocr.set(REF.cedula, { status: 500, body: { ok: false } });
    const id = await crearRcv('P-6', { documentos: ['cedula'] });
    let r = req(id, 'cedula');
    expect(r.estado).toBe('recibido');
    expect(r.decision).toBeNull();
    expect(r.diagnostico).toMatchObject({
      resultado: 'error_tecnico',
      intento: 1,
    });
    expect(r.analisisIntentos).toBe(1);
    const espera1 = r.proximoAnalisis.getTime() - Date.now();
    expect(espera1).toBeGreaterThan(4 * 60_000);
    expect(espera1).toBeLessThanOrEqual(5 * 60_000);
    expect(exp(id).estadoDocumental).toBe('incompleto');

    // Antes de la espera: no se vuelve a llamar al OCR.
    await svc.revisarConIa({ modo: 'recibidos' });
    expect(llamadasAnalizar(REF.cedula)).toHaveLength(1);

    // Vencida la espera: reintenta; sigue fallando → espera mayor.
    await svc.revisarConIa({
      modo: 'recibidos',
      ahora: new Date(Date.now() + 6 * 60_000),
    });
    expect(llamadasAnalizar(REF.cedula)).toHaveLength(2);
    r = req(id, 'cedula');
    expect(r).toMatchObject({ estado: 'recibido', analisisIntentos: 2 });
    expect(r.proximoAnalisis.getTime() - Date.now()).toBeGreaterThan(
      14 * 60_000,
    );
    expect(esperaReintentoMs(2)).toBeGreaterThan(esperaReintentoMs(1));

    // El OCR vuelve: valida.
    lee(REF.cedula, LECTURA_OK.cedula);
    await svc.revisarConIa({
      modo: 'recibidos',
      ahora: new Date(Date.now() + 60 * 60_000),
    });
    expect(req(id, 'cedula')).toMatchObject({
      estado: 'validado',
      analisisIntentos: 0,
      proximoAnalisis: null,
    });
  });

  it('archivo aún no archivado en el OCR (404) también es error técnico, no observado', async () => {
    ocr.delete(REF.cedula);
    const id = await crearRcv('P-7', { documentos: ['cedula'] });
    expect(req(id, 'cedula').estado).toBe('recibido');
    expect(req(id, 'cedula').diagnostico.resultado).toBe('error_tecnico');
  });
});

describe('ruta vieja de pendiente (mesa técnica)', () => {
  const PENDIENTE = 'La Mundial de Seguros/12345678/pendiente/cedula.webp';

  function conLocalizar(documentos: Record<string, string>) {
    const base = fetchMock.getMockImplementation() as (
      url: string,
      init: any,
    ) => Promise<Response>;
    fetchMock.mockImplementation(async (url: string, init: any) =>
      String(url).endsWith('/api/internal/expedientes/localizar')
        ? respuesta(200, {
            ok: true,
            ubicacion: 'poliza',
            carpeta: 'La Mundial de Seguros/12345678/2321234-26-11-1100015737',
            documentos,
          })
        : base(url, init),
    );
  }
  const llamadasLocalizar = () =>
    fetchMock.mock.calls.filter(([url]: any[]) =>
      String(url).endsWith('/api/internal/expedientes/localizar'),
    );

  async function conRefVieja(ref: string) {
    const id = await crearRcv('P-70', { documentos: ['cedula'] });
    Object.assign(req(id, 'cedula'), {
      ref,
      estado: 'recibido',
      decision: null,
      diagnostico: null,
      analisisRef: null,
      archivoHash: null,
      ocrDatos: null,
    });
    return id;
  }

  it('si el archivo ya no está en pendiente, toma la ruta de la póliza y lo analiza ahí', async () => {
    const id = await conRefVieja(PENDIENTE);
    conLocalizar({ cedula: REF.cedula });
    const r = await svc.revisarConIa({ modo: 'completo' });
    expect(r).toMatchObject({
      analizados: 1,
      erroresTecnicos: 0,
      validados: 1,
    });
    expect(req(id, 'cedula')).toMatchObject({
      ref: REF.cedula,
      estado: 'validado',
    });
    expect(llamadasLocalizar()).toHaveLength(1);
    expect(
      db.mktExpedienteEvento
        ._rows()
        .some((e: any) => e.tipo === 'documento_reubicado'),
    ).toBe(true);
  });

  it('si el OCR no lo encuentra en otra carpeta, queda como error técnico sin tocar la ruta', async () => {
    const id = await conRefVieja(PENDIENTE);
    conLocalizar({});
    const r = await svc.revisarConIa({ modo: 'completo' });
    expect(r.erroresTecnicos).toBe(1);
    expect(req(id, 'cedula').ref).toBe(PENDIENTE);
  });

  it('una ruta de carpeta de póliza que no existe no se reubica', async () => {
    const vieja = 'La Mundial de Seguros/12345678/otra-carpeta/cedula.webp';
    const id = await conRefVieja(vieja);
    conLocalizar({ cedula: REF.cedula });
    await svc.revisarConIa({ modo: 'completo' });
    expect(llamadasLocalizar()).toHaveLength(0);
    expect(req(id, 'cedula').ref).toBe(vieja);
  });
});

describe('no reanaliza sin necesidad', () => {
  it('sin cambios no vuelve a llamar al OCR', async () => {
    const id = await crearRcv('P-10');
    const antes = llamadasAnalizar().length;
    expect(antes).toBe(3);
    const r1 = await svc.revisarConIa({ modo: 'completo' });
    const r2 = await svc.revisarConIa({ modo: 'completo' });
    expect(llamadasAnalizar()).toHaveLength(antes);
    expect(r1).toMatchObject({ analizados: 0, sinCambios: 3 });
    expect(r2.analizados).toBe(0);
    // Volver a registrar la misma emisión tampoco.
    await crearRcv('P-10');
    expect(llamadasAnalizar()).toHaveLength(antes);
    expect(exp(id).estadoDocumental).toBe('completo');
  });

  it('cambio en los datos de la póliza → vuelve a comparar (sin otra lectura OCR)', async () => {
    const id = await crearRcv('P-11');
    expect(req(id, 'certificado').estado).toBe('validado');
    const llamadas = llamadasAnalizar().length;
    // La emisión reenvía el registro con otra placa.
    await crearRcv('P-11', {
      snapshot: {
        ...SNAPSHOT,
        vehiculo: { ...SNAPSHOT.vehiculo, placa: 'AC555XX' },
      },
    });
    const r = req(id, 'certificado');
    expect(r.estado).toBe('observado');
    expect(r.diagnostico).toMatchObject({
      resultado: 'no_coincide',
      motivoAnalisis: 'cambio_poliza',
    });
    expect(llamadasAnalizar()).toHaveLength(llamadas);
    // Cédula y licencia: la persona no cambió, siguen validadas.
    expect(req(id, 'cedula').estado).toBe('validado');
    expect(exp(id).estadoDocumental).toBe('incompleto');
  });

  it('la revisión diaria detecta el cambio de póliza aunque no se reenvíe la emisión', async () => {
    const id = await crearRcv('P-12', { documentos: ['cedula'] });
    expect(req(id, 'cedula').estado).toBe('validado');
    db.mktExpediente._rows()[0].snapshot = {
      ...SNAPSHOT,
      tomador: { ...SNAPSHOT.tomador, documento: '99887766' },
      asegurado: { ...SNAPSHOT.asegurado, documento: '99887766' },
    };
    db.mktExpediente._rows()[0].aseguradoDocumento = '99887766';
    const r = await svc.revisarConIa({ modo: 'completo' });
    expect(r.motivos).toEqual({ cambio_poliza: 1 });
    expect(req(id, 'cedula').estado).toBe('observado');
  });
});

describe('estado documental y decisión manual', () => {
  it('completo solo con todos los requisitos validados', async () => {
    lee(REF.certificado, {
      ...LECTURA_OK.certificado,
      serial: '8AWZZZ111XX000001',
    });
    const id = await crearRcv('P-20');
    expect(req(id, 'cedula').estado).toBe('validado');
    expect(req(id, 'licencia').estado).toBe('validado');
    expect(req(id, 'certificado').estado).toBe('observado');
    expect(exp(id).estadoDocumental).toBe('incompleto');

    // Falta un documento: tampoco es completo.
    const otro = await crearRcv('P-21', { documentos: ['cedula', 'licencia'] });
    expect(req(otro, 'certificado').estado).toBe('faltante');
    expect(exp(otro).estadoDocumental).toBe('incompleto');
  });

  it('la validación manual del administrador prevalece sobre la IA', async () => {
    lee(REF.cedula, { ...LECTURA_OK.cedula, identificacion: '11111111' });
    const id = await crearRcv('P-22');
    expect(req(id, 'cedula').estado).toBe('observado');

    await svc.validarManual(
      id,
      'cedula',
      'validar',
      'portal:9',
      'Revisado con el original',
    );
    expect(req(id, 'cedula')).toMatchObject({
      estado: 'validado',
      validadoPor: 'portal:9',
      decision: 'manual',
    });
    expect(exp(id).estadoDocumental).toBe('completo');
    const ev = db.mktExpedienteEvento
      ._rows()
      .filter((x: any) => x.tipo === 'requisito_validado')
      .at(-1);
    expect(ev.detalle).toMatchObject({
      manual: true,
      sobreIa: true,
      motivo: 'Revisado con el original',
      ia: { resultado: 'no_coincide' },
    });

    // Ni la revisión diaria ni un cambio de póliza la tocan.
    const llamadas = llamadasAnalizar().length;
    await svc.revisarConIa({ modo: 'completo' });
    await crearRcv('P-22', {
      snapshot: {
        ...SNAPSHOT,
        tomador: { ...SNAPSHOT.tomador, nombre: 'Otra' },
      },
    });
    expect(llamadasAnalizar()).toHaveLength(llamadas);
    expect(req(id, 'cedula')).toMatchObject({
      estado: 'validado',
      decision: 'manual',
    });

    // Observar a mano también prevalece.
    await svc.validarManual(
      id,
      'licencia',
      'observar',
      'qa-acceso-libre',
      'Licencia de otra categoría',
    );
    await svc.revisarConIa({ modo: 'completo' });
    expect(req(id, 'licencia')).toMatchObject({
      estado: 'observado',
      decision: 'manual',
      validadoPor: 'qa-acceso-libre',
      motivo: 'Licencia de otra categoría',
    });
  });

  it('validación manual configurada: la IA no corre', async () => {
    await svc.updateConfig(
      { validacion: 'manual', motivo: 'excepción' } as any,
      'portal:1',
    );
    const id = await crearRcv('P-23');
    expect(llamadasAnalizar()).toHaveLength(0);
    expect(req(id, 'cedula').estado).toBe('recibido');
    expect((await svc.revisarConIa()).omitido).toBe('validacion_manual');
  });

  it('sin OCR configurado no hace nada (y no falsea estados)', async () => {
    delete process.env.OCR_INTERNAL_URL;
    const id = await crearRcv('P-24');
    expect(req(id, 'cedula').estado).toBe('recibido');
    expect(req(id, 'cedula').diagnostico).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('exposición: bandeja, detalle, indicadores y página pública', () => {
  it('lista con resultado y resumen; detalle completo; filtro conErrores; indicadores', async () => {
    const ok = await crearRcv('P-30');
    lee(REF.cedula, { ...LECTURA_OK.cedula, identificacion: '22223333' });
    const mal = await crearRcv('P-31', { documentos: ['cedula'] });

    const lista = await request(app).get('/api/expedientes').set(AUTH);
    expect(lista.status).toBe(200);
    const itemMal = lista.body.data.items.find((i: any) => i.id === mal);
    const ced = itemMal.requisitos.find((r: any) => r.tipo === 'cedula');
    expect(ced.diagnostico).toMatchObject({ resultado: 'no_coincide' });
    expect(ced.diagnostico.resumen).toContain('V-****3333');
    expect(ced.diagnostico.campos).toBeUndefined();
    expect(ced.actor).toBe('ia');

    const errados = await request(app)
      .get('/api/expedientes?conErrores=true')
      .set(AUTH);
    expect(errados.body.data.items.map((i: any) => i.id)).toEqual([mal]);

    const det = await request(app).get(`/api/expedientes/${ok}`).set(AUTH);
    const cert = det.body.data.requisitos.find(
      (r: any) => r.tipo === 'certificado',
    );
    expect(cert.diagnostico).toMatchObject({
      resultado: 'coincide',
      confianza: 1,
      proveedor: 'gemini',
    });
    expect(cert.diagnostico.campos.map((c: any) => c.campo)).toEqual([
      'placa',
      'serialCarroceria',
      'serialMotor',
      'marca',
      'modelo',
      'anio',
    ]);
    expect(cert.actor).toBe('ia');

    const ind = await request(app)
      .get('/api/expedientes/indicadores')
      .set(AUTH);
    expect(ind.body.data).toMatchObject({
      completos: 1,
      validadosIa: 1,
      conErrores: 1,
      analizando: 0,
    });
  });

  it('error técnico del OCR: cuenta en noLeidos, no en analizando', async () => {
    ocr.set(REF.cedula, { status: 503, body: { ok: false } });
    await crearRcv('P-32', { documentos: ['cedula'] });
    const ind = await svc.indicadores({});
    expect(ind.noLeidos).toBe(1);
    expect(ind.analizando).toBe(0);
    expect(ind.porValidar).toBe(1);
  });

  it('página pública: solo diagnostico.resultado y motivo sin datos de la póliza', async () => {
    lee(REF.cedula, {
      identificacion: '87654321',
      tipoDoc: 'V',
      nombre: 'PEDRO',
      apellido: 'GOMEZ',
    });
    const id = await crearRcv('P-33', { documentos: ['cedula'] });
    const { token } = await svc.crearEnlace('V12345678', [id]);
    const r = await request(app).get(`/api/expedientes/publico/${token}`);
    expect(r.status).toBe(200);
    const ced = r.body.data.requisitos.find((x: any) => x.tipo === 'cedula');
    expect(ced.diagnostico).toEqual({ resultado: 'no_coincide' });
    expect(ced.motivo).toBe(
      'Los datos del documento no coinciden con la póliza (número de cédula y nombre).',
    );
    const json = JSON.stringify(r.body);
    for (const prohibido of [
      '5678',
      '4321',
      'PEDRO',
      'Pérez',
      'tomador',
      'resumen',
      'campos',
    ])
      expect(json).not.toContain(prohibido);
  });

  it('carga pública con la IA: validado al instante y respuesta sin datos de la póliza', async () => {
    const id = await crearRcv('P-34', { documentos: ['cedula', 'licencia'] });
    const { token } = await svc.crearEnlace('V12345678', [id]);
    fetchMock.mockImplementation(async (url: string) => {
      if (String(url).endsWith('/documento'))
        return respuesta(200, {
          ok: true,
          ref: 'La Mundial de Seguros/12345678/x/certificado-1.pdf',
          hash: 'abc',
          ocr: {
            extraido: { ...LECTURA_OK.certificado, placa: 'ZZ000ZZ' },
            confianza: 1,
            proveedor: 'gemini',
          },
        });
      return respuesta(200, { status: true, data: { sent: true } });
    });
    const JPG = Buffer.concat([
      Buffer.from([0xff, 0xd8, 0xff, 0xe0]),
      Buffer.alloc(200, 1),
    ]);
    const up = await request(app)
      .post(`/api/expedientes/publico/${token}/upload`)
      .field('tipo', 'certificado')
      .attach('file', JPG, 'c.jpg');
    expect(up.status).toBe(201);
    expect(up.body.data).toMatchObject({
      estado: 'observado',
      diagnostico: { resultado: 'no_coincide' },
      motivo: 'Los datos del documento no coinciden con la póliza (placa).',
    });
    expect(JSON.stringify(up.body)).not.toContain('AB123CD');
    expect(req(id, 'certificado')).toMatchObject({
      estado: 'observado',
      archivoHash: 'abc',
      decision: 'ia',
      origen: 'publico',
    });
  });
});

describe('concurrencia y tareas', () => {
  it('nunca más de 2 análisis a la vez', async () => {
    let enCurso = 0;
    let maximo = 0;
    fetchMock.mockImplementation(async (_url: string, init: any) => {
      enCurso++;
      maximo = Math.max(maximo, enCurso);
      await new Promise((r) => setTimeout(r, 5));
      enCurso--;
      const { ref } = JSON.parse(init.body);
      const tipo = ref.includes('licencia')
        ? 'licencia'
        : ref.includes('certificado')
          ? 'certificado'
          : 'cedula';
      return respuesta(200, {
        ok: true,
        ref,
        hash: 'h',
        ocr: { extraido: LECTURA_OK[tipo], confianza: 1, proveedor: 'gemini' },
      });
    });
    await Promise.all(['P-40', 'P-41', 'P-42', 'P-43'].map((p) => crearRcv(p)));
    await svc.esperarAnalisisPendientes();
    expect(fetchMock.mock.calls.length).toBe(12);
    expect(maximo).toBeLessThanOrEqual(2);
    expect(maximo).toBe(2);
  });

  it('la cola respeta el tope y da prioridad a las cargas', async () => {
    const cola = new ColaConcurrencia(2);
    const orden: string[] = [];
    let soltar!: () => void;
    const bloqueo = new Promise<void>((r) => {
      soltar = r;
    });
    const largas = [1, 2].map((n) =>
      cola.ejecutar(async () => {
        await bloqueo;
        orden.push(`larga${n}`);
      }),
    );
    const fondo = cola.ejecutar(async () => {
      orden.push('fondo');
    });
    const carga = cola.ejecutar(async () => {
      orden.push('carga');
    }, true);
    expect(cola.enCurso).toBe(2);
    expect(cola.pendientes).toBe(2);
    soltar();
    await Promise.all([...largas, fondo, carga]);
    expect(orden.indexOf('carga')).toBeLessThan(orden.indexOf('fondo'));
    await cola.vacia();
    expect(cola.enCurso).toBe(0);
  });

  it('la tarea diaria incluye la revisión de la IA (y el job manual validacion_ia)', async () => {
    ocr.set(REF.cedula, { status: 500, body: { ok: false } });
    const id = await crearRcv('P-50', { documentos: ['cedula'] });
    expect(req(id, 'cedula').estado).toBe('recibido');
    lee(REF.cedula, LECTURA_OK.cedula);
    const r = await ejecutarJob('diaria', {
      origen: 'auto',
      ahora: new Date(Date.now() + 10 * 60_000),
    });
    expect((r as any).resumen.validacionIa).toMatchObject({
      analizados: 1,
      validados: 1,
    });
    expect(req(id, 'cedula').estado).toBe('validado');
    const manual = await ejecutarJob('validacion_ia', {
      origen: 'manual',
      forzar: true,
    });
    expect((manual as any).resumen.validacionIa.sinCambios).toBe(1);
  });
});

describe('reglas del diagnóstico', () => {
  const ctxPersona = contextoPoliza({
    producto: 'personas',
    snapshot: {
      asegurado: {
        tipoDoc: 'V',
        documento: '12345678',
        nombre: 'José Luis',
        apellido: 'Ramírez De La Cruz',
      },
    },
  });

  it('nombres sin acentos ni mayúsculas, compuestos y en otro orden', () => {
    for (const [nombre, apellido] of [
      ['JOSE', 'RAMIREZ'],
      ['luis', 'de la cruz'],
      ['RAMIREZ', 'JOSE LUIS'],
      ['JOSE LUIS', 'RAMIRES'],
    ]) {
      const d = diagnosticar(
        'cedula',
        {
          extraido: {
            identificacion: '12.345.678',
            tipoDoc: 'V',
            nombre,
            apellido,
          },
          confianza: 1,
        },
        ctxPersona,
      );
      expect(d.resultado, `${nombre} ${apellido}`).toBe('coincide');
    }
  });

  it('RIF con dígito verificador coincide con la cédula de la póliza', () => {
    const d = diagnosticar(
      'rif',
      {
        extraido: {
          rif: 'V-12345678-9',
          tipoDoc: 'V',
          nombre: 'Jose',
          apellido: 'Ramirez',
        },
        confianza: 1,
      },
      ctxPersona,
    );
    expect(d.resultado).toBe('coincide');
  });

  it('tipo de documento distinto (E vs V) no coincide', () => {
    const d = diagnosticar(
      'cedula',
      {
        extraido: {
          identificacion: '12345678',
          tipoDoc: 'E',
          nombre: 'Jose',
          apellido: 'Ramirez',
        },
        confianza: 1,
      },
      ctxPersona,
    );
    expect(d.resultado).toBe('no_coincide');
    expect(d.resumen).toContain('El tipo de documento (E)');
  });

  it('licencia vencida → no coincide; sin fecha no se exige', () => {
    const vencida = diagnosticar(
      'licencia',
      {
        extraido: {
          identificacion: '12345678',
          nombre: 'Jose',
          apellido: 'Ramirez',
          vencimiento: '2020-01-31',
        },
        confianza: 1,
      },
      ctxPersona,
    );
    expect(vencida.resultado).toBe('no_coincide');
    expect(vencida.resumen).toBe(
      'La licencia está vencida desde el 2020-01-31.',
    );
    expect(motivoParaAsegurado(vencida)).toBe('La licencia está vencida.');
    const sinFecha = diagnosticar(
      'licencia',
      {
        extraido: {
          identificacion: '12345678',
          nombre: 'Jose',
          apellido: 'Ramirez',
        },
        confianza: 1,
      },
      ctxPersona,
    );
    expect(sinFecha.resultado).toBe('coincide');
  });

  it('dato que la póliza no trae: sin_dato_poliza, no cuenta como error', () => {
    const ctx = contextoPoliza({
      producto: 'rcv',
      snapshot: { vehiculo: { placa: 'AB123CD' } },
    });
    const d = diagnosticar(
      'certificado',
      { extraido: LECTURA_OK.certificado, confianza: 1 },
      ctx,
    );
    expect(d.resultado).toBe('coincide');
    expect(d.campos.find((c) => c.campo === 'marca')).toMatchObject({
      coincide: null,
      estado: 'sin_dato_poliza',
    });
    expect(d.resumen).toContain('Sin dato en la póliza');
  });

  it('sin datos para comparar o lectura parcial → sin_certeza (observado «Revisar»)', () => {
    const sinVehiculo = diagnosticar(
      'certificado',
      { extraido: LECTURA_OK.certificado, confianza: 1 },
      contextoPoliza({ producto: 'rcv', snapshot: {} }),
    );
    expect(sinVehiculo.resultado).toBe('sin_certeza');
    const parcial = diagnosticar(
      'cedula',
      {
        extraido: {
          identificacion: '12345678',
          nombre: 'Jose',
          apellido: 'Ramirez',
        },
        confianza: 0.5,
      },
      ctxPersona,
    );
    expect(parcial.resultado).toBe('sin_certeza');
    const serialCasi = diagnosticar(
      'certificado',
      {
        extraido: { ...LECTURA_OK.certificado, serial: '9BWZZZ377VT004252' },
        confianza: 1,
      },
      contextoPoliza({
        producto: 'rcv',
        snapshot: { vehiculo: { serial: '9BWZZZ377VT004251' } },
      }),
    );
    expect(serialCasi.resultado).toBe('sin_certeza');
  });

  it('documento de otro tipo y falla técnica del OCR', () => {
    const tipo = diagnosticar(
      'cedula',
      {
        extraido: null,
        confianza: 0,
        motivo: 'Parece una licencia',
        falla: 'tipo_documento',
      },
      ctxPersona,
    );
    expect(tipo).toMatchObject({
      resultado: 'no_coincide',
      resumen: 'Parece una licencia',
    });
    expect(motivoParaAsegurado(tipo)).toBe(
      'El archivo no corresponde al documento solicitado.',
    );
    const tec = diagnosticar(
      'cedula',
      {
        extraido: null,
        confianza: 0,
        falla: 'tecnica',
        motivo: 'OCR simulado',
      },
      ctxPersona,
    );
    expect(tec.resultado).toBe('error_tecnico');
  });

  it('enmascara: solo los últimos 4', () => {
    expect(maskDocumento('V', '12.345.678')).toBe('V-****5678');
    expect(maskDocumento(null, '123')).toBe('****');
    expect(maskDocumento('J', 'J-40123456-7')).toBe('J-****4567');
  });
});

describe('v2: comparación por rol y recálculo al desplegar (falsos errores en QA)', () => {
  const REF_P = 'La Mundial de Seguros/11225322/2321234-26-11-77/cedula.webp';

  async function crearPersonas(poliza: string, snapshot: any, asegurado: any) {
    const r = await svc.registrarDesdeEmision(
      {
        id: Number(poliza.replace(/\D/g, '')) || 1,
        empresaId: 7,
        polizaNumero: poliza,
        jsonData: { producto: 'personas' },
      },
      {
        expediente: {
          centidad: 'C',
          ccanalalt: '900',
          producto: 'personas',
          asegurado: { ...asegurado, email: 'a@test.com' },
          snapshot,
          documentos: { cedula: { recibido: true, ref: REF_P } },
        },
      },
    );
    await svc.esperarAnalisisPendientes();
    return r!.id;
  }

  const TOMADOR = {
    tipoDoc: 'V',
    documento: '11225322',
    nombre: 'Carlos',
    apellido: 'Mendoza',
  };
  const ASEGURADO = {
    tipoDoc: 'V',
    documento: '20304050',
    nombre: 'Ana',
    apellido: 'Mendoza',
  };
  const LECTURA_TOMADOR = {
    identificacion: '11225322',
    tipoDoc: 'V',
    nombre: 'CARLOS',
    apellido: 'MENDOZA',
  };

  it('personas: la cédula (del tomador) se compara con el tomador, no con el asegurado', async () => {
    lee(REF_P, LECTURA_TOMADOR);
    const id = await crearPersonas(
      'PP-1',
      { tomador: TOMADOR, asegurado: ASEGURADO },
      ASEGURADO,
    );
    const r = req(id, 'cedula');
    expect(r.estado).toBe('validado');
    expect(r.diagnostico).toMatchObject({
      resultado: 'coincide',
      comparadoCon: 'tomador',
      rolEsperado: 'tomador',
      comparador: VERSION_COMPARADOR,
    });
  });

  it('caso 5322: la póliza no trae al tomador → se compara con el asegurado y queda sin_certeza, no no_coincide', async () => {
    lee(REF_P, LECTURA_TOMADOR);
    const id = await crearPersonas('PP-2', { asegurado: ASEGURADO }, ASEGURADO);
    const r = req(id, 'cedula');
    expect(r.estado).toBe('observado');
    expect(r.diagnostico).toMatchObject({
      resultado: 'sin_certeza',
      comparadoCon: 'asegurado',
      rolEsperado: 'tomador',
    });
    expect(r.diagnostico.resumen).toBe(
      'La póliza no trae la cédula del tomador; se comparó con la del asegurado.',
    );
    expect(r.motivo).toMatch(/^Revisar: /);
  });

  it('v4: cédula del asegurado (otra persona natural de la póliza) → coincide con el asegurado', async () => {
    lee(REF_P, {
      identificacion: '20304050',
      tipoDoc: 'V',
      nombre: 'ANA',
      apellido: 'MENDOZA',
    });
    const id = await crearPersonas(
      'PP-3',
      { tomador: TOMADOR, asegurado: ASEGURADO },
      ASEGURADO,
    );
    const d = req(id, 'cedula').diagnostico;
    expect(d.resultado).toBe('coincide');
    expect(d.comparadoCon).toBe('asegurado');
  });

  it('roles: cedula_titular → asegurado; cedula_beneficiario → beneficiario o el siguiente disponible', () => {
    const ctx = contextoPoliza({
      producto: 'personas',
      snapshot: {
        tomador: TOMADOR,
        asegurado: ASEGURADO,
        beneficiarios: [
          {
            tipoDoc: 'V',
            documento: '30111222',
            nombre: 'Luis',
            apellido: 'Mendoza',
          },
        ],
      },
    });
    const lect = (doc: string, nombre: string) => ({
      extraido: {
        identificacion: doc,
        tipoDoc: 'V',
        nombre,
        apellido: 'MENDOZA',
      },
      confianza: 1,
    });
    expect(
      diagnosticar('cedula_titular', lect('20304050', 'ANA'), ctx),
    ).toMatchObject({ resultado: 'coincide', comparadoCon: 'asegurado' });
    expect(
      diagnosticar('cedula_titular', lect('11225322', 'CARLOS'), ctx).resumen,
    ).toBe('El documento corresponde al tomador, no al asegurado.');
    expect(
      diagnosticar('cedula_beneficiario', lect('30111222', 'LUIS'), ctx),
    ).toMatchObject({ resultado: 'coincide', comparadoCon: 'beneficiario' });
    const sinBenef = contextoPoliza({
      producto: 'personas',
      snapshot: { asegurado: ASEGURADO },
    });
    expect(
      diagnosticar('cedula_beneficiario', lect('20304050', 'ANA'), sinBenef),
    ).toMatchObject({
      resultado: 'coincide',
      comparadoCon: 'asegurado',
      rolEsperado: 'beneficiario',
    });
  });

  it('licencia (RCV): vale la del conductor habitual, el tomador o el titular', () => {
    const ctx = contextoPoliza({
      producto: 'rcv',
      snapshot: {
        tomador: TOMADOR,
        asegurado: ASEGURADO,
        conductor: {
          tipoDoc: 'V',
          documento: '15999888',
          nombre: 'Pedro',
          apellido: 'Rojas',
        },
      },
    });
    for (const [doc, nombre, apellido, rol] of [
      ['15999888', 'PEDRO', 'ROJAS', 'conductor'],
      ['11225322', 'CARLOS', 'MENDOZA', 'tomador'],
      ['20304050', 'ANA', 'MENDOZA', 'asegurado'],
    ]) {
      expect(
        diagnosticar(
          'licencia',
          { extraido: { identificacion: doc, nombre, apellido }, confianza: 1 },
          ctx,
        ),
      ).toMatchObject({ resultado: 'coincide', comparadoCon: rol });
    }
  });

  it('caso 274: un dígito distinto (8127 vs 5127) con el mismo nombre → sin_certeza «posible error de lectura»', () => {
    const ctx = contextoPoliza({
      producto: 'personas',
      snapshot: {
        tomador: {
          tipoDoc: 'V',
          documento: '17345127',
          nombre: 'Rosa',
          apellido: 'Díaz',
        },
      },
    });
    const d = diagnosticar(
      'cedula',
      {
        extraido: {
          identificacion: '17348127',
          tipoDoc: 'V',
          nombre: 'ROSA',
          apellido: 'DIAZ',
        },
        confianza: 1,
      },
      ctx,
    );
    expect(d.resultado).toBe('sin_certeza');
    expect(d.resumen).toBe(
      'Posible error de lectura: el número del documento (V-****8127) difiere en un dígito del tomador (V-****5127) y el nombre coincide.',
    );
    expect(d.campos.find((c) => c.campo === 'documento')).toMatchObject({
      coincide: null,
      estado: 'parecido',
    });
    // Con otro nombre es otra persona: v5, sin asegurados en Nexus puede ser uno de ellos → revisar.
    const juan = {
      extraido: {
        identificacion: '17348127',
        tipoDoc: 'V',
        nombre: 'JUAN',
        apellido: 'PEREZ',
      },
      confianza: 1,
    };
    expect(diagnosticar('cedula', juan, ctx).resultado).toBe('sin_certeza');
    // Con los asegurados conocidos y que no es ninguno: no coincide.
    const conTitular = contextoPoliza(
      {
        producto: 'personas',
        snapshot: {
          tomador: {
            tipoDoc: 'V',
            documento: '17345127',
            nombre: 'Rosa',
            apellido: 'Díaz',
          },
        },
      },
      [
        {
          asegurado: {
            tipoDoc: 'V',
            documento: '20111222',
            nombre: 'Luis',
            apellido: 'Díaz',
          },
        },
      ],
    );
    expect(diagnosticar('cedula', juan, conTitular).resultado).toBe(
      'no_coincide',
    );
  });

  it('al desplegar: diagnósticos del comparador anterior se vuelven a comparar con lo ya leído, sin OCR', async () => {
    const id = await crearRcv('P-60');
    const llamadas = llamadasAnalizar().length;
    // Simula lo guardado por la v1 en QA: falso error con el comparador anterior.
    const fila = req(id, 'cedula');
    fila.estado = 'observado';
    fila.motivo = 'falso error v1';
    fila.diagnostico = {
      ...fila.diagnostico,
      comparador: undefined,
      resultado: 'no_coincide',
    };
    const ilegible = req(id, 'licencia');
    ilegible.estado = 'observado';
    ilegible.ocrDatos = null;
    ilegible.diagnostico = {
      ...ilegible.diagnostico,
      comparador: undefined,
      resultado: 'ilegible',
    };
    exp(id).estadoDocumental = 'incompleto';

    const r = await svc.revisarConIa({ modo: 'completo' });
    expect(r.motivos).toEqual({ cambio_comparador: 2 });
    expect(llamadasAnalizar()).toHaveLength(llamadas);
    expect(req(id, 'cedula')).toMatchObject({
      estado: 'validado',
      motivo: null,
    });
    expect(req(id, 'cedula').diagnostico).toMatchObject({
      resultado: 'coincide',
      comparador: VERSION_COMPARADOR,
      motivoAnalisis: 'cambio_comparador',
    });
    // Sin datos leídos: solo se marca con la versión nueva (no queda en bucle).
    expect(req(id, 'licencia').diagnostico.comparador).toBe(VERSION_COMPARADOR);
    expect(req(id, 'licencia').estado).toBe('observado');
    const otra = await svc.revisarConIa({ modo: 'completo' });
    expect(otra.motivos).toEqual({});
    expect(llamadasAnalizar()).toHaveLength(llamadas);
  });

  it('al desplegar no toca decisiones manuales', async () => {
    lee(REF.cedula, { ...LECTURA_OK.cedula, identificacion: '11111111' });
    const id = await crearRcv('P-61', { documentos: ['cedula'] });
    await svc.validarManual(id, 'cedula', 'validar', 'portal:9', 'Visto');
    const fila = req(id, 'cedula');
    fila.diagnostico = { ...fila.diagnostico, comparador: undefined };
    const r = await svc.revisarConIa({ modo: 'completo' });
    expect(r.motivos).toEqual({});
    expect(req(id, 'cedula')).toMatchObject({
      estado: 'validado',
      decision: 'manual',
    });
  });
});

describe('v3: datos cambiados en el formulario (ocrLeido de la emisión)', () => {
  // Caso real QA, expediente 417 (póliza 18-27-0000137414): el OCR leyó del certificado la placa
  // AC124KB y el serial JTEBU5JRXG5303643; el usuario los cambió a mano en el formulario.
  const SNAP_417 = {
    ...SNAPSHOT,
    vehiculo: {
      placa: 'WDSFG3G3',
      marca: 'Toyota',
      modelo: '4Runner',
      anio: 2016,
      serial: '3G34G23FRWDV2EV53G23',
    },
  };
  const CERT_417 = {
    placa: 'AC124KB',
    marca: 'TOYOTA',
    modelo: '4RUNNER',
    anio: '2016',
    serial: 'JTEBU5JRXG5303643',
  };
  const OCR_LEIDO_417 = {
    placa: 'AC124KB',
    serial: 'JTEBU5JRXG5303643',
    marca: 'Toyota',
    modelo: '4Runner',
    anio: '2016',
  };

  it('caso 417: placa y serial cambiados en el formulario → datos_modificados (observado) con lo leído y lo emitido', async () => {
    lee(REF.certificado, CERT_417);
    const id = await crearRcv('18-27-0000137414', {
      snapshot: SNAP_417,
      documentos: ['certificado'],
      ocrLeido: { certificado: OCR_LEIDO_417 },
    });
    const r = req(id, 'certificado');
    expect(r.estado).toBe('observado');
    expect(r.diagnostico.resultado).toBe('datos_modificados');
    expect(r.diagnostico.comparador).toBe(VERSION_COMPARADOR);
    expect(r.diagnostico.resumen).toBe(
      'Datos cambiados en el formulario: el OCR leyó la placa AC124KB del certificado, ' +
        'pero la póliza se emitió con WDSFG3G3; el serial de carrocería JTEBU5JRXG5303643, ' +
        'pero la póliza se emitió con 3G34G23FRWDV2EV53G23.',
    );
    expect(r.motivo).toBe(r.diagnostico.resumen);
    const campo = (c: string) =>
      r.diagnostico.campos.find((x: any) => x.campo === c);
    expect(campo('placa')).toMatchObject({
      estado: 'modificado_en_formulario',
      coincide: false,
      enOcrAlEmitir: 'AC124KB',
      enPoliza: 'WDSFG3G3',
      enDocumento: 'AC124KB',
    });
    expect(campo('serialCarroceria')).toMatchObject({
      estado: 'modificado_en_formulario',
      enOcrAlEmitir: 'JTEBU5JRXG5303643',
      enPoliza: '3G34G23FRWDV2EV53G23',
    });
    expect(campo('marca')).toMatchObject({
      estado: 'coincide',
      enOcrAlEmitir: 'Toyota',
    });
    expect(exp(id).estadoDocumental).toBe('incompleto');

    // Bandeja: indicador propio, filtro y también cuenta en conErrores.
    const lista = await request(app).get('/api/expedientes').set(AUTH);
    const item = lista.body.data.items.find((i: any) => i.id === id);
    expect(item.datosModificados).toBe(true);
    expect(
      item.requisitos.find((x: any) => x.tipo === 'certificado').diagnostico,
    ).toMatchObject({ resultado: 'datos_modificados' });
    const filtro = await request(app)
      .get('/api/expedientes?datosModificados=true')
      .set(AUTH);
    expect(filtro.body.data.items.map((i: any) => i.id)).toEqual([id]);
    const ind = await svc.indicadores({});
    expect(ind).toMatchObject({ datosModificados: 1, conErrores: 1 });

    // Detalle: campo por campo con lo leído al emitir.
    const det = await request(app).get(`/api/expedientes/${id}`).set(AUTH);
    const cert = det.body.data.requisitos.find(
      (x: any) => x.tipo === 'certificado',
    );
    expect(cert.diagnostico.resultado).toBe('datos_modificados');
    expect(
      cert.diagnostico.campos.find((x: any) => x.campo === 'placa'),
    ).toMatchObject({
      estado: 'modificado_en_formulario',
      enOcrAlEmitir: 'AC124KB',
    });

    // El asegurado no ve datos de la póliza ni se le pide reenviar.
    expect(motivoParaAsegurado(r.diagnostico)).not.toMatch(/AC124KB|WDSFG3G3/);
  });

  it('igual a lo leído (el formulario no cambió nada) → validado, con lo leído al emitir a la vista', async () => {
    const id = await crearRcv('P-70', {
      ocrLeido: {
        cedula: {
          tipoDoc: 'V',
          documento: '12345678',
          nombre: 'Maria',
          apellido: 'Perez',
        },
        certificado: {
          placa: 'AB123CD',
          serial: '9BWZZZ377VT004251',
          serialMotor: 'MTR123456',
          marca: 'Toyota',
          modelo: 'Corolla',
          anio: '2020',
        },
      },
    });
    expect(exp(id).estadoDocumental).toBe('completo');
    for (const t of ['cedula', 'licencia', 'certificado'])
      expect(req(id, t).diagnostico.resultado).toBe('coincide');
    const placa = req(id, 'certificado').diagnostico.campos.find(
      (x: any) => x.campo === 'placa',
    );
    expect(placa).toMatchObject({
      estado: 'coincide',
      enOcrAlEmitir: 'AB123CD',
    });
    const doc = req(id, 'cedula').diagnostico.campos.find(
      (x: any) => x.campo === 'documento',
    );
    expect(doc.enOcrAlEmitir).toBe('V-****5678');
    expect((await svc.indicadores({})).datosModificados).toBe(0);
  });

  it('sin ocrLeido (emisiones viejas) → no_coincide como hoy', async () => {
    lee(REF.certificado, CERT_417);
    const id = await crearRcv('P-71', {
      snapshot: SNAP_417,
      documentos: ['certificado'],
    });
    const r = req(id, 'certificado');
    expect(r.estado).toBe('observado');
    expect(r.diagnostico.resultado).toBe('no_coincide');
    expect(r.diagnostico.resumen).toContain(
      'La placa del certificado (AC124KB) no coincide con la del vehículo asegurado (WDSFG3G3).',
    );
    expect(
      r.diagnostico.campos.every((c: any) => !('enOcrAlEmitir' in c)),
    ).toBe(true);
    const lista = await request(app).get('/api/expedientes').set(AUTH);
    expect(
      lista.body.data.items.find((i: any) => i.id === id).datosModificados,
    ).toBe(false);
    const filtro = await request(app)
      .get('/api/expedientes?datosModificados=true')
      .set(AUTH);
    expect(filtro.body.data.items).toEqual([]);
  });

  it('el OCR leyó al emitir algo distinto a lo que lee ahora → no_coincide (no se afirma que se cambió)', async () => {
    lee(REF.certificado, CERT_417);
    const id = await crearRcv('P-72', {
      snapshot: SNAP_417,
      documentos: ['certificado'],
      ocrLeido: {
        certificado: {
          ...OCR_LEIDO_417,
          placa: 'XY999ZZ',
          serial: 'OTRO1234567890XYZ',
        },
      },
    });
    const r = req(id, 'certificado');
    expect(r.diagnostico.resultado).toBe('no_coincide');
    expect(
      r.diagnostico.campos.find((x: any) => x.campo === 'placa'),
    ).toMatchObject({ estado: 'no_coincide', enOcrAlEmitir: 'XY999ZZ' });
  });

  it('dato que la IA no leyó ahora: se usa lo leído al emitir', () => {
    const ctx = contextoPoliza({
      producto: 'rcv',
      snapshot: { ...SNAP_417, ocrLeido: { certificado: OCR_LEIDO_417 } },
    });
    const d = diagnosticar(
      'certificado',
      {
        extraido: { serial: '3G34G23FRWDV2EV53G23', marca: 'TOYOTA' },
        confianza: 1,
      },
      ctx,
    );
    expect(d.resultado).toBe('datos_modificados');
    expect(d.campos.find((x) => x.campo === 'placa')).toMatchObject({
      estado: 'modificado_en_formulario',
      enDocumento: null,
      enOcrAlEmitir: 'AC124KB',
      enPoliza: 'WDSFG3G3',
    });
    // El serial se lee igual a la póliza: ese no se cambió.
    expect(d.campos.find((x) => x.campo === 'serialCarroceria')?.estado).toBe(
      'coincide',
    );
  });

  it('cédula cambiada en el formulario: números enmascarados (últimos 4)', () => {
    const ctx = contextoPoliza({
      producto: 'personas',
      snapshot: {
        tomador: {
          tipoDoc: 'V',
          documento: '99887766',
          nombre: 'María José',
          apellido: 'Pérez Gómez',
        },
        ocrLeido: {
          cedula: {
            tipoDoc: 'V',
            documento: '12345678',
            nombre: 'MARIA JOSE',
            apellido: 'PEREZ GOMEZ',
          },
        },
      },
    });
    const d = diagnosticar(
      'cedula',
      { extraido: LECTURA_OK.cedula, confianza: 1 },
      ctx,
    );
    expect(d.resultado).toBe('datos_modificados');
    expect(d.resumen).toBe(
      'Datos cambiados en el formulario: el OCR leyó el número V-****5678 de la cédula, ' +
        'pero la póliza se emitió con V-****7766.',
    );
    expect(JSON.stringify(d)).not.toMatch(/12345678|99887766/);
  });

  it('al desplegar: la revisión completa recalcula con ocrLeido sin volver a llamar al OCR', async () => {
    lee(REF.certificado, CERT_417);
    const id = await crearRcv('P-73', {
      snapshot: SNAP_417,
      documentos: ['certificado'],
      ocrLeido: { certificado: OCR_LEIDO_417 },
    });
    const llamadas = llamadasAnalizar().length;
    // Como lo dejó el comparador v2 en QA: «no coincide».
    const fila = req(id, 'certificado');
    fila.diagnostico = {
      ...fila.diagnostico,
      comparador: 2,
      resultado: 'no_coincide',
    };
    const r = await svc.revisarConIa({ modo: 'completo' });
    expect(r.motivos).toEqual({ cambio_comparador: 1 });
    expect(llamadasAnalizar()).toHaveLength(llamadas);
    expect(req(id, 'certificado').diagnostico).toMatchObject({
      resultado: 'datos_modificados',
      comparador: VERSION_COMPARADOR,
      motivoAnalisis: 'cambio_comparador',
    });
  });

  it('un reenvío de la emisión sin ocrLeido no borra lo leído al emitir', async () => {
    lee(REF.certificado, CERT_417);
    const id = await crearRcv('P-74', {
      snapshot: SNAP_417,
      documentos: ['certificado'],
      ocrLeido: { certificado: OCR_LEIDO_417 },
    });
    await crearRcv('P-74', {
      snapshot: SNAP_417,
      documentos: ['certificado'],
    });
    expect(exp(id).snapshot.ocrLeido.certificado.placa).toBe('AC124KB');
    expect(req(id, 'certificado').diagnostico.resultado).toBe(
      'datos_modificados',
    );
  });
});

describe('v4: personas — la cédula se compara contra todas las personas de la póliza (prod 9-nov)', () => {
  const REF_V4 = 'La Mundial de Seguros/40111222/2321234-26-11-90/cedula.webp';
  const TOM_V = {
    tipoDoc: 'V',
    documento: '40100984',
    nombre: 'Carlos Eduardo',
    apellido: 'Rojas',
  };
  const TOM_J = {
    tipoDoc: 'J',
    documento: '401118743',
    nombre: 'Minera Ejemplo C.A.',
  };
  const TITULAR = {
    tipoDoc: 'V',
    identificacion: '40118363',
    nombre: 'Noemi',
    apellido: 'Rojas',
  };
  const HIJA = {
    tipoDoc: 'V',
    identificacion: '40121247',
    nombre: 'Mariana Valentina',
    apellido: 'Rojas',
    parentesco: '3',
  };
  /** Snapshot de la mesa técnica (funeral_submission) como lo guarda Emisión. */
  const MESA = (tomador: any) => ({
    tomador,
    asegurado: TITULAR,
    funeral: { asegurados: [TITULAR, HIJA], beneficiarios: [] },
  });
  /** Expediente de prod: llegó por conciliación, el snapshot solo trae al tomador. */
  const expPersonas = (tomador: any) => ({
    producto: 'personas',
    snapshot: {
      tomador: {
        nombre: tomador.nombre,
        identificacion: `${tomador.tipoDoc}-${tomador.documento}`,
      },
    },
    aseguradoTipoDoc: tomador.tipoDoc,
    aseguradoDocumento: tomador.documento,
    aseguradoNombre: tomador.nombre,
  });
  const lectura = (extraido: any) => ({ extraido, confianza: 1 });

  it('caso 1: tomador J y cédula V del titular → coincide con el titular (no con el tomador)', () => {
    const ctx = contextoPoliza(expPersonas(TOM_J), [MESA(TOM_J)]);
    const d = diagnosticar(
      'cedula',
      lectura({
        identificacion: '40118363',
        tipoDoc: 'V',
        nombre: 'NOEMI',
        apellido: 'ROJAS',
      }),
      ctx,
    );
    expect(d.resultado).toBe('coincide');
    expect(d.comparadoCon).toBe('asegurado');
  });

  it('caso 2: tomador V y cédula de otra persona de la póliza (asegurada) → coincide', () => {
    const ctx = contextoPoliza(expPersonas(TOM_V), [MESA(TOM_V)]);
    const d = diagnosticar(
      'cedula',
      lectura({
        identificacion: 'V-40.121.247',
        tipoDoc: 'V',
        nombre: 'MARIANA VALENTINA',
        apellido: 'ROJAS',
      }),
      ctx,
    );
    expect(d.resultado).toBe('coincide');
    // Sigue valiendo la del tomador natural.
    expect(
      diagnosticar(
        'cedula',
        lectura({
          identificacion: '40100984',
          tipoDoc: 'V',
          nombre: 'CARLOS EDUARDO',
          apellido: 'ROJAS',
        }),
        ctx,
      ),
    ).toMatchObject({ resultado: 'coincide', comparadoCon: 'tomador' });
  });

  it('asegurados del jsonData de la emisión también cuentan', () => {
    const ctx = contextoPoliza(expPersonas(TOM_V), [
      { flujo: 'personas', funeral: { asegurados: [HIJA] } },
    ]);
    expect(
      diagnosticar(
        'cedula',
        lectura({
          identificacion: '40121247',
          tipoDoc: 'V',
          nombre: 'MARIANA',
          apellido: 'ROJAS',
        }),
        ctx,
      ).resultado,
    ).toBe('coincide');
  });

  it('caso 3: tomador J y RIF del tomador → coincide (no «se esperaba cédula»)', () => {
    const ctx = contextoPoliza(expPersonas(TOM_J), [MESA(TOM_J)]);
    const d = diagnosticar(
      'cedula',
      lectura({
        rif: 'J-40111874-3',
        tipoDoc: 'J',
        razonSocial: 'MINERA EJEMPLO, C.A.',
      }),
      ctx,
    );
    expect(d.resultado).toBe('coincide');
    expect(d.comparadoCon).toBe('tomador');
  });

  it('negativo: persona ajena a la póliza (otro número y otro nombre) → no_coincide', () => {
    const ctx = contextoPoliza(expPersonas(TOM_V), [MESA(TOM_V)]);
    const d = diagnosticar(
      'cedula',
      lectura({
        identificacion: '55667788',
        tipoDoc: 'V',
        nombre: 'PEDRO',
        apellido: 'GOMEZ',
      }),
      ctx,
    );
    expect(d.resultado).toBe('no_coincide');
    expect(estadoPorDiagnostico(d).estado).toBe('observado');
  });

  it('negativo: número de una persona de la póliza con otro nombre → no_coincide', () => {
    const ctx = contextoPoliza(expPersonas(TOM_V), [MESA(TOM_V)]);
    const d = diagnosticar(
      'cedula',
      lectura({
        identificacion: '40118363',
        tipoDoc: 'V',
        nombre: 'PEDRO',
        apellido: 'GOMEZ',
      }),
      ctx,
    );
    expect(d.resultado).toBe('no_coincide');
  });

  it('negativo: RIF de otra empresa con tomador J → no_coincide', () => {
    const ctx = contextoPoliza(expPersonas(TOM_J), [MESA(TOM_J)]);
    const d = diagnosticar(
      'cedula',
      lectura({ rif: 'J-30999888-1', tipoDoc: 'J', razonSocial: 'OTRA C.A.' }),
      ctx,
    );
    expect(d.resultado).toBe('no_coincide');
  });

  it('tomador J y pasaporte que no es de nadie de la póliza (representante) → sin_certeza, no validado', () => {
    const ctx = contextoPoliza(expPersonas(TOM_J), [MESA(TOM_J)]);
    const d = diagnosticar(
      'cedula',
      lectura({
        numeroPasaporte: 'P-77441551',
        tipoDoc: 'P',
        nombre: 'JUN',
        apellido: 'LI',
      }),
      ctx,
    );
    expect(d.resultado).toBe('sin_certeza');
    expect(estadoPorDiagnostico(d).motivo).toMatch(/^Revisar: .*jurídica/);
  });

  it('datos insuficientes: tomador J sin titular ni asegurados → sin_certeza (revisión), nunca validado', () => {
    const ctx = contextoPoliza(expPersonas(TOM_J));
    const d = diagnosticar(
      'cedula',
      lectura({
        identificacion: '40118363',
        tipoDoc: 'V',
        nombre: 'NOEMI',
        apellido: 'ROJAS',
      }),
      ctx,
    );
    expect(d.resultado).toBe('sin_certeza');
    expect(d.resumen).toMatch(/no trae la cédula del titular/);
  });

  it('el OCR devolvió el rótulo «nombre» → sin_certeza (lectura fallida), no no_coincide', () => {
    const ctx = contextoPoliza(expPersonas(TOM_V), [MESA(TOM_V)]);
    const d = diagnosticar(
      'cedula',
      lectura({
        identificacion: '40118363',
        tipoDoc: 'V',
        nombre: 'nombre',
        apellido: 'apellido',
      }),
      ctx,
    );
    expect(d.resultado).toBe('sin_certeza');
  });

  it('las personas adicionales no cambian la huella (no reabren lo decidido)', () => {
    const sin = contextoPoliza(expPersonas(TOM_V));
    const con = contextoPoliza(expPersonas(TOM_V), [MESA(TOM_V)]);
    expect(huellaPoliza(con)).toBe(huellaPoliza(sin));
  });

  async function expedienteProd(poliza: string, tomador: any, extraido: any) {
    lee(REF_V4, extraido);
    const r = await svc.registrarDesdeEmision(
      {
        id: Number(poliza.replace(/\D/g, '')) || 1,
        empresaId: 7,
        polizaNumero: poliza,
        // Como en prod: la emisión trae al tomador en el jsonData y nada más de la póliza.
        jsonData: {
          producto: 'personas',
          tomadorNombre: tomador.nombre,
          tomadorIdentificacion: `${tomador.tipoDoc}-${tomador.documento}`,
        },
      },
      {
        expediente: {
          centidad: 'C',
          ccanalalt: '900',
          producto: 'personas',
          documentos: { cedula: { recibido: true, ref: REF_V4 } },
        },
      },
    );
    await svc.esperarAnalisisPendientes();
    return r!.id;
  }

  it('al desplegar: lo observado por la IA con la regla vieja se recompara sin OCR y queda validado; lo validado no se toca', async () => {
    const id = await expedienteProd('PV-1', TOM_V, {
      identificacion: '40118363',
      tipoDoc: 'V',
      nombre: 'NOEMI',
      apellido: 'ROJAS',
    });
    // Sin mesa técnica todavía: falso no_coincide contra el tomador (como en prod).
    const fila = req(id, 'cedula');
    expect(fila.estado).toBe('observado');
    fila.diagnostico = { ...fila.diagnostico, comparador: 3 };
    await db.funeralSubmission.create({
      data: {
        empresaId: 7,
        cnpoliza: 'PV-1',
        createdAt: new Date(),
        snapshotJson: MESA(TOM_V),
      },
    });
    // Un validado de la v3 (otra póliza) no se reabre.
    const idOk = await expedienteProd('PV-2', TOM_V, {
      identificacion: '40100984',
      tipoDoc: 'V',
      nombre: 'CARLOS EDUARDO',
      apellido: 'ROJAS',
    });
    const ok = req(idOk, 'cedula');
    expect(ok.estado).toBe('validado');
    ok.diagnostico = { ...ok.diagnostico, comparador: 3 };
    const antes = { ...ok };

    const llamadas = llamadasAnalizar().length;
    const r = await svc.revisarConIa({ modo: 'completo' });
    expect(r.motivos).toEqual({ cambio_comparador: 1 });
    expect(llamadasAnalizar()).toHaveLength(llamadas);
    expect(req(id, 'cedula')).toMatchObject({
      estado: 'validado',
      decision: 'ia',
    });
    expect(req(id, 'cedula').diagnostico).toMatchObject({
      resultado: 'coincide',
      comparador: VERSION_COMPARADOR,
      comparadoCon: 'asegurado',
    });
    expect(req(idOk, 'cedula')).toEqual(antes);
    // Una segunda pasada no vuelve a tocar nada.
    expect((await svc.revisarConIa({ modo: 'completo' })).motivos).toEqual({});
  });

  it('al desplegar: «parece ser un RIF» con tomador J se vuelve a leer aceptando RIF y queda validado', async () => {
    await db.funeralSubmission.create({
      data: {
        empresaId: 7,
        cnpoliza: 'PV-3',
        createdAt: new Date(),
        snapshotJson: MESA(TOM_J),
      },
    });
    const id = await expedienteProd('PV-3', TOM_J, {
      rif: 'J-40111874-3',
      tipoDoc: 'J',
      razonSocial: 'MINERA EJEMPLO C.A.',
    });
    // Simula lo guardado por la v3: el OCR rechazó el RIF y no dejó datos leídos.
    const fila = req(id, 'cedula');
    fila.estado = 'observado';
    fila.decision = 'ia';
    fila.ocrDatos = null;
    fila.diagnostico = {
      ...fila.diagnostico,
      comparador: 3,
      resultado: 'no_coincide',
      campos: [
        {
          campo: 'tipoDocumento',
          etiqueta: 'Tipo de documento',
          enPoliza: 'Cédula de identidad',
          enDocumento: null,
          coincide: false,
          estado: 'no_coincide',
        },
      ],
    };
    const llamadas = llamadasAnalizar(REF_V4).length;
    const r = await svc.revisarConIa({ modo: 'completo' });
    expect(r.motivos).toEqual({ cambio_comparador: 1 });
    await svc.esperarAnalisisPendientes();
    const nuevas = llamadasAnalizar(REF_V4).slice(llamadas);
    expect(nuevas).toHaveLength(1);
    expect(JSON.parse((nuevas[0] as any)[1].body).aceptaRif).toBe(true);
    expect(req(id, 'cedula')).toMatchObject({ estado: 'validado' });
  });

  describe('v5: sin datos de las personas → revisar (prod 9-nov)', () => {
    const AJENA = {
      identificacion: '20990741',
      tipoDoc: 'V',
      nombre: 'DARLING',
      apellido: 'PEREZ',
    };

    it('personas sin asegurados en Nexus: cédula que no es del tomador → sin_certeza, no «Errado»', () => {
      const ctx = contextoPoliza(expPersonas(TOM_V));
      const d = diagnosticar('cedula', lectura(AJENA), ctx);
      expect(d.resultado).toBe('sin_certeza');
      expect(d.comparador).toBe(VERSION_COMPARADOR);
      expect(estadoPorDiagnostico(d)).toEqual({
        estado: 'observado',
        motivo:
          'Revisar: No se pudo comparar: la póliza no trae los asegurados en Nexus y el documento no es del tomador; puede ser de un asegurado.',
      });
      // La del tomador sigue validando.
      expect(
        diagnosticar(
          'cedula',
          lectura({
            identificacion: '40100984',
            tipoDoc: 'V',
            nombre: 'CARLOS EDUARDO',
            apellido: 'ROJAS',
          }),
          ctx,
        ),
      ).toMatchObject({ resultado: 'coincide', comparadoCon: 'tomador' });
    });

    it('pasaporte que no es del tomador y sin asegurados en Nexus → sin_certeza', () => {
      const ctx = contextoPoliza(expPersonas(TOM_V));
      const d = diagnosticar(
        'cedula',
        lectura({
          numeroPasaporte: 'P-77418266',
          tipoDoc: 'P',
          nombre: 'ANDRES ALESSANDRO',
          apellido: 'LOPEZ',
        }),
        ctx,
      );
      expect(d.resultado).toBe('sin_certeza');
    });

    it('negativo: con los asegurados conocidos y el documento no es de nadie → no_coincide', () => {
      const ctx = contextoPoliza(expPersonas(TOM_V), [MESA(TOM_V)]);
      expect(diagnosticar('cedula', lectura(AJENA), ctx).resultado).toBe(
        'no_coincide',
      );
    });

    it('negativo: mismo número del tomador con otro nombre → no_coincide aunque no haya asegurados', () => {
      const ctx = contextoPoliza(expPersonas(TOM_V));
      const d = diagnosticar(
        'cedula',
        lectura({ ...AJENA, identificacion: '40100984' }),
        ctx,
      );
      expect(d.resultado).toBe('no_coincide');
    });

    it('negativo: RIF de una empresa con tomador V y sin asegurados → no_coincide', () => {
      const ctx = contextoPoliza(expPersonas(TOM_V));
      const d = diagnosticar(
        'cedula',
        lectura({
          rif: 'J-30999888-1',
          tipoDoc: 'J',
          razonSocial: 'OTRA C.A.',
        }),
        ctx,
      );
      expect(d.resultado).toBe('no_coincide');
    });

    it('tomador V con su RIF personal (mismo número y nombre) → coincide con el tomador', () => {
      const ctx = contextoPoliza(expPersonas(TOM_V));
      const d = diagnosticar(
        'cedula',
        lectura({
          rif: 'V-40100984-5',
          tipoDoc: 'V',
          razonSocial: 'ROJAS CARLOS EDUARDO',
        }),
        ctx,
      );
      expect(d).toMatchObject({
        resultado: 'coincide',
        comparadoCon: 'tomador',
      });
    });

    it('negativo: RIF personal con el número del tomador y otro nombre → no_coincide', () => {
      const ctx = contextoPoliza(expPersonas(TOM_V));
      const d = diagnosticar(
        'cedula',
        lectura({
          rif: 'V-40100984-5',
          tipoDoc: 'V',
          razonSocial: 'GOMEZ PEDRO',
        }),
        ctx,
      );
      expect(d.resultado).toBe('no_coincide');
    });

    it('al desplegar: «parece ser un RIF» sin datos leídos con tomador V (v3 o v4) se vuelve a leer UNA vez aceptando RIF', async () => {
      const id = await expedienteProd('PV-5', TOM_V, {
        rif: 'V-40100984-5',
        tipoDoc: 'V',
        razonSocial: 'ROJAS CARLOS EDUARDO',
      });
      for (const comparador of [3, 4]) {
        // Como quedó en prod: el OCR rechazó el RIF y no dejó datos leídos.
        const fila = req(id, 'cedula');
        Object.assign(fila, {
          estado: 'observado',
          decision: 'ia',
          ocrDatos: null,
          diagnostico: {
            ...fila.diagnostico,
            comparador,
            resultado: 'no_coincide',
            resumen:
              'El documento subido parece ser un RIF, pero el sistema esperaba una Cédula',
            campos: [
              {
                campo: 'tipoDocumento',
                etiqueta: 'Tipo de documento',
                enPoliza: 'Cédula de identidad',
                enDocumento: null,
                coincide: false,
                estado: 'no_coincide',
              },
            ],
          },
        });
        const llamadas = llamadasAnalizar(REF_V4).length;
        const r = await svc.revisarConIa({ modo: 'completo' });
        expect(r.motivos).toEqual({ cambio_comparador: 1 });
        await svc.esperarAnalisisPendientes();
        const nuevas = llamadasAnalizar(REF_V4).slice(llamadas);
        expect(nuevas).toHaveLength(1);
        expect(JSON.parse((nuevas[0] as any)[1].body).aceptaRif).toBe(true);
        expect(req(id, 'cedula')).toMatchObject({
          estado: 'validado',
          decision: 'ia',
        });
        expect(req(id, 'cedula').diagnostico.comparador).toBe(
          VERSION_COMPARADOR,
        );
        // Una segunda pasada no vuelve a leer.
        await svc.revisarConIa({ modo: 'completo' });
        expect(llamadasAnalizar(REF_V4).slice(llamadas)).toHaveLength(1);
      }
    });

    it('al desplegar: no_coincide v4 contra el tomador sin asegurados se recompara sin OCR y queda sin_certeza', async () => {
      const id = await expedienteProd('PV-6', TOM_V, AJENA);
      const fila = req(id, 'cedula');
      fila.diagnostico = {
        ...fila.diagnostico,
        comparador: 4,
        resultado: 'no_coincide',
      };
      const llamadas = llamadasAnalizar().length;
      const r = await svc.revisarConIa({ modo: 'completo' });
      expect(r.motivos).toEqual({ cambio_comparador: 1 });
      expect(llamadasAnalizar()).toHaveLength(llamadas);
      expect(req(id, 'cedula')).toMatchObject({ estado: 'observado' });
      expect(req(id, 'cedula').motivo).toMatch(
        /^Revisar: No se pudo comparar: la póliza no trae los asegurados/,
      );
      expect(req(id, 'cedula').diagnostico).toMatchObject({
        resultado: 'sin_certeza',
        comparador: VERSION_COMPARADOR,
      });
    });

    describe('RCV: licencia sin datos del conductor', () => {
      const TOM = {
        tipoDoc: 'V',
        documento: '11225322',
        nombre: 'Carlos',
        apellido: 'Mendoza',
      };
      const OTRO = {
        identificacion: '15999888',
        nombre: 'PEDRO',
        apellido: 'ROJAS',
        vencimiento: '2031-01-01',
      };
      const ctxRcv = (conductor?: any) =>
        contextoPoliza({
          producto: 'rcv',
          snapshot: {
            tomador: TOM,
            asegurado: TOM,
            ...(conductor ? { conductor } : {}),
          },
        });

      it('licencia que no es del tomador ni del titular y sin conductor → sin_certeza', () => {
        const d = diagnosticar('licencia', lectura(OTRO), ctxRcv());
        expect(d.resultado).toBe('sin_certeza');
        expect(d.resumen).toMatch(
          /^No se pudo comparar: la póliza no trae los datos del conductor en Nexus/,
        );
      });

      it('negativo: con conductor conocido y la licencia no es de nadie → no_coincide', () => {
        const d = diagnosticar(
          'licencia',
          lectura(OTRO),
          ctxRcv({
            tipoDoc: 'V',
            documento: '18777666',
            nombre: 'Luis',
            apellido: 'Rojas',
          }),
        );
        expect(d.resultado).toBe('no_coincide');
      });

      it('negativo: sin conductor pero la licencia está vencida → no_coincide', () => {
        const d = diagnosticar(
          'licencia',
          lectura({ ...OTRO, vencimiento: '2020-01-31' }),
          ctxRcv(),
        );
        expect(d.resultado).toBe('no_coincide');
        expect(d.resumen).toContain('vencida');
      });

      it('negativo: número del tomador con otro nombre → no_coincide', () => {
        const d = diagnosticar(
          'licencia',
          lectura({ ...OTRO, identificacion: '11225322' }),
          ctxRcv(),
        );
        expect(d.resultado).toBe('no_coincide');
      });

      it('v6: sin conductor y vencida → no_coincide y el motivo empieza por «vencida», no por «No se pudo comparar»', () => {
        const d = diagnosticar(
          'licencia',
          lectura({ ...OTRO, vencimiento: '2020-01-31' }),
          ctxRcv(),
        );
        expect(d.resultado).toBe('no_coincide');
        expect(d.comparador).toBe(VERSION_COMPARADOR);
        expect(d.resumen).toMatch(
          /^La licencia está vencida desde el 2020-01-31./,
        );
        expect(d.resumen).toContain(
          'la póliza no trae los datos del conductor',
        );
        const m = estadoPorDiagnostico(d);
        expect(m.estado).toBe('observado');
        expect(m.motivo).toMatch(/^La licencia está vencida/);
      });

      it('v6: sin conductor y vigente → sin_certeza con «Revisar: No se pudo comparar…»', () => {
        const d = diagnosticar('licencia', lectura(OTRO), ctxRcv());
        expect(d.resultado).toBe('sin_certeza');
        expect(estadoPorDiagnostico(d).motivo).toMatch(
          /^Revisar: No se pudo comparar: la póliza no trae los datos del conductor/,
        );
      });

      it('v6: el observado v5 incoherente se recompara sin OCR; el validado v3+ no se toca', () => {
        const ahora = new Date('2026-11-09T12:00:00Z');
        const fila = (estado: string, comparador: number) => ({
          ref: 'ref-1',
          estado,
          decision: 'ia',
          analisisRef: 'ref-1',
          huellaPoliza: 'h',
          proximoAnalisis: null,
          diagnostico: {
            tipo: 'licencia',
            resultado: estado === 'validado' ? 'coincide' : 'no_coincide',
            comparador,
            campos: [],
            resumen: '',
          },
        });
        expect(motivoAnalisis(fila('observado', 5), 'h', ahora)).toBe(
          'cambio_comparador',
        );
        expect(
          motivoAnalisis(fila('observado', VERSION_COMPARADOR), 'h', ahora),
        ).toBeNull();
        expect(motivoAnalisis(fila('validado', 5), 'h', ahora)).toBeNull();
      });

      it('la licencia del tomador sigue validando', () => {
        const d = diagnosticar(
          'licencia',
          lectura({
            ...OTRO,
            identificacion: '11225322',
            nombre: 'CARLOS',
            apellido: 'MENDOZA',
          }),
          ctxRcv(),
        );
        expect(d.resultado).toBe('coincide');
      });
    });
  });
});
