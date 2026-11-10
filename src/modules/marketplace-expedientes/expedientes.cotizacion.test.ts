/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * v7: datos de la cotización del wizard (`cotizacion.cotizacion_json_data`) en la validación con IA
 * y en el área / «emitida por» del expediente. Prisma en memoria y OCR simulado con fetch.
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
import {
  contextoPoliza,
  huellaPoliza,
  VERSION_COMPARADOR,
} from './expedientes.ia';
import {
  actorDeCotizacion,
  datosDeCotizacion,
  elegirCotizacion,
} from './expedientes.cotizacion';

const db = prisma as any;

const REF = {
  cedula: 'LM/12345678/2321234-26-11-1100015737/cedula.webp',
  licencia: 'LM/12345678/2321234-26-11-1100015737/licencia.webp',
  certificado: 'LM/12345678/2321234-26-11-1100015737/certificado.pdf',
};

const TOMADOR = {
  tipoDoc: 'V',
  identificacion: '12345678',
  nombre: 'María José',
  apellido: 'Pérez Gómez',
};
const CONDUCTOR = {
  tipoDoc: 'V',
  identificacion: '20990741',
  nombre: 'Pedro',
  apellido: 'López',
};
const BENEFICIARIO = {
  tipoDoc: 'V',
  identificacion: '17555444',
  nombre: 'Ana',
  apellido: 'Rivas',
};
const HIJA = {
  tipoDoc: 'V',
  identificacion: '40121247',
  nombre: 'Mariana Valentina',
  apellido: 'Rojas',
};
const VEHICULO = {
  placa: 'AB123CD',
  serial: '9BWZZZ377VT004251',
  serialMotor: 'MTR123456',
  marca: 'TOYOTA',
  modelo: 'COROLLA',
  año: '2020',
};
const CERTIFICADO_OK = {
  placa: 'AB-123-CD',
  marca: 'TOYOTA',
  modelo: 'COROLLA XEI',
  anio: '2020',
  serial: '9BWZZZ377VT004251',
  serialMotor: 'MTR123456',
};

let ocr: Map<string, any>;
let fetchMock: ReturnType<typeof vi.fn>;

function lee(ref: string, extraido: any) {
  ocr.set(ref, {
    ok: true,
    ref,
    hash: `h-${ref.length}-${JSON.stringify(extraido).length}`,
    ocr: { extraido, confianza: 1, proveedor: 'gemini' },
  });
}

function llamadasAnalizar() {
  return fetchMock.mock.calls.filter(([url]: any[]) =>
    String(url).endsWith('/api/internal/expedientes/analizar'),
  );
}

/** Cotización del wizard ya emitida (como la guarda flow.service). */
async function cotizacion(poliza: string, data: Record<string, any>) {
  await db.cotizacion.create({
    data: {
      empresaId: 7,
      estado: 'emitida',
      jsonData: {
        _flowMeta: { moduloGroupId: 1, current: 4, history: [1, 2, 3] },
        product: 'rcv',
        tomador: TOMADOR,
        sameInsured: true,
        hasDriver: false,
        hasBeneficiary: false,
        policy: { number: poliza, cnpoliza: poliza },
        ...data,
      },
    },
  });
}

/** RCV como en prod: el snapshot del expediente no trae el vehículo ni el conductor. */
async function crearRcv(poliza: string, docs: string[]) {
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
        },
        snapshot: {
          tomador: {
            tipoDoc: 'V',
            documento: '12345678',
            nombre: 'María José',
            apellido: 'Pérez Gómez',
          },
        },
        documentos: Object.fromEntries(
          docs.map((t) => [t, { recibido: true, ref: (REF as any)[t] }]),
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
  delete process.env.EXPEDIENTES_JOBS_ENABLED;
  ocr = new Map();
  fetchMock = vi.fn(async (url: string, init: any) => {
    if (String(url).endsWith('/api/internal/expedientes/analizar')) {
      const { ref } = JSON.parse(init.body);
      const body = ocr.get(ref);
      return new Response(
        JSON.stringify(body ?? { ok: false, code: 'ARCHIVO_NO_ENCONTRADO' }),
        { status: body ? 200 : 404 },
      );
    }
    return new Response(JSON.stringify({ status: true }), { status: 200 });
  });
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(async () => {
  await svc.esperarAnalisisPendientes();
  vi.unstubAllGlobals();
});

describe('v7: enlace con la cotización del wizard', () => {
  it('una sola cotización del wizard con ese cnpoliza y producto → se usa', () => {
    const jd = {
      _flowMeta: {},
      product: 'rcv',
      tomador: TOMADOR,
      policy: { cnpoliza: 'P-1' },
    };
    expect(
      elegirCotizacion([{ id: 3, jsonData: jd }], {
        cnpoliza: 'P-1',
        producto: 'rcv',
      }),
    ).toMatchObject({ estado: 'unica', id: 3 });
  });

  it('varias cotizaciones con el mismo cnpoliza → ambigua (no se usa)', () => {
    const jd = {
      _flowMeta: {},
      product: 'rcv',
      tomador: TOMADOR,
      policy: { cnpoliza: 'P-1' },
    };
    expect(
      elegirCotizacion(
        [
          { id: 3, jsonData: jd },
          { id: 4, jsonData: jd },
        ],
        { cnpoliza: 'P-1', producto: 'rcv' },
      ),
    ).toEqual({ estado: 'ambigua', cantidad: 2 });
  });

  it('la cotización «huella» de POST /api/emisiones y otro producto no cuentan', () => {
    expect(
      elegirCotizacion(
        [{ id: 1, jsonData: { producto: 'rcv', cnrecibo: 'R-1' } }],
        { cnpoliza: 'P-1', producto: 'rcv' },
      ),
    ).toEqual({ estado: 'sin_cotizacion' });
    expect(
      elegirCotizacion(
        [
          {
            id: 2,
            jsonData: {
              _flowMeta: {},
              product: 'funerario',
              tomador: TOMADOR,
              policy: { number: 'P-1' },
            },
          },
        ],
        { cnpoliza: 'P-1', producto: 'rcv' },
      ),
    ).toEqual({ estado: 'otro_producto' });
  });

  it('respeta las banderas del wizard (conductor, beneficiario, asegurado aparte)', () => {
    const d = datosDeCotizacion(
      {
        tomador: TOMADOR,
        sameInsured: true,
        asegurado: HIJA,
        hasDriver: false,
        conductor: CONDUCTOR,
        hasBeneficiary: true,
        beneficiario: BENEFICIARIO,
        vehicle: VEHICULO,
      },
      'rcv',
    );
    expect(d.personas.map(([, rol]) => rol)).toEqual([
      'tomador',
      'asegurado',
      'beneficiario',
    ]);
    expect(d.vehiculo).toMatchObject({
      placa: 'AB123CD',
      serial: '9BWZZZ377VT004251',
      anio: '2020',
    });
  });

  it('la cotización no cambia la huella de la póliza', () => {
    const e = {
      producto: 'rcv',
      snapshot: { tomador: { tipoDoc: 'V', documento: '12345678' } },
    };
    const cot = datosDeCotizacion(
      {
        tomador: TOMADOR,
        hasDriver: true,
        conductor: CONDUCTOR,
        vehicle: VEHICULO,
        documents: { certificado: { ocr: { placa: 'AB-123-CD' } } },
      },
      'rcv',
    );
    expect(huellaPoliza(contextoPoliza(e, [], cot))).toBe(
      huellaPoliza(contextoPoliza(e)),
    );
  });

  it('quién emitió: metadataCanal, metadata y raíz (ccanalalt_in)', () => {
    expect(
      actorDeCotizacion({
        metadataCanal: { centidad: 'c' },
        metadata: { cusuario: 'U1' },
        ccanalalt_in: '900',
      }),
    ).toEqual({ centidad: 'C', cusuario: 'U1', ccanalalt: '900' });
    expect(
      actorDeCotizacion({ metadataCanal: { centidad: 'P', cproductor: '55' } }),
    ).toEqual({ centidad: 'P', cproductor: '55', citem: '55' });
  });
});

describe('v7: validación con los datos de la cotización', () => {
  it('certificado RCV: validado con el vehículo de la cotización', async () => {
    lee(REF.certificado, CERTIFICADO_OK);
    await cotizacion('P-10', { vehicle: VEHICULO });
    const id = await crearRcv('P-10', ['certificado']);
    expect(req(id, 'certificado')).toMatchObject({
      estado: 'validado',
      decision: 'ia',
    });
    expect(req(id, 'certificado').diagnostico).toMatchObject({
      resultado: 'coincide',
      comparador: VERSION_COMPARADOR,
      comparadoCon: 'vehiculo',
    });
  });

  it('certificado RCV: otra placa y otro serial que la cotización → no coincide', async () => {
    lee(REF.certificado, CERTIFICADO_OK);
    await cotizacion('P-11', {
      vehicle: { ...VEHICULO, placa: 'ZZ999ZZ', serial: '8AJZZZ111XX000001' },
    });
    const id = await crearRcv('P-11', ['certificado']);
    expect(req(id, 'certificado').estado).toBe('observado');
    expect(req(id, 'certificado').diagnostico.resultado).toBe('no_coincide');
    expect(req(id, 'certificado').motivo).toMatch(/placa del certificado/);
  });

  it('certificado RCV sin cotización: sigue «la póliza no trae los datos del vehículo»', async () => {
    lee(REF.certificado, CERTIFICADO_OK);
    const id = await crearRcv('P-12', ['certificado']);
    expect(req(id, 'certificado').motivo).toBe(
      'Revisar: La póliza no trae los datos del vehículo para comparar.',
    );
  });

  it('cotización ambigua (dos con el mismo cnpoliza) → no se usa', async () => {
    lee(REF.certificado, CERTIFICADO_OK);
    await cotizacion('P-13', { vehicle: VEHICULO });
    await cotizacion('P-13', { vehicle: VEHICULO });
    const id = await crearRcv('P-13', ['certificado']);
    expect(req(id, 'certificado').diagnostico.resultado).toBe('sin_certeza');
    expect(req(id, 'certificado').motivo).toMatch(
      /no trae los datos del vehículo/,
    );
  });

  it('licencia RCV del conductor habitual de la cotización → validada', async () => {
    lee(REF.licencia, {
      identificacion: '20990741',
      tipoDoc: 'V',
      nombre: 'PEDRO',
      apellido: 'LOPEZ',
      vencimiento: '2031-06-30',
    });
    await cotizacion('P-14', { hasDriver: true, conductor: CONDUCTOR });
    const id = await crearRcv('P-14', ['licencia']);
    expect(req(id, 'licencia').estado).toBe('validado');
    expect(req(id, 'licencia').diagnostico).toMatchObject({
      resultado: 'coincide',
      comparadoCon: 'conductor',
    });
  });

  it('cédula que es del beneficiario de la cotización → sin_certeza (no válida)', async () => {
    lee(REF.cedula, {
      identificacion: '17555444',
      tipoDoc: 'V',
      nombre: 'ANA',
      apellido: 'RIVAS',
    });
    await cotizacion('P-15', {
      hasBeneficiary: true,
      beneficiario: BENEFICIARIO,
    });
    const id = await crearRcv('P-15', ['cedula']);
    expect(req(id, 'cedula').estado).toBe('observado');
    expect(req(id, 'cedula').diagnostico.resultado).toBe('sin_certeza');
    expect(req(id, 'cedula').motivo).toMatch(/corresponde al beneficiario/);
  });

  it('datos cambiados en el formulario con lo que leyó el OCR al escanear (documents)', async () => {
    // El OCR leyó AC124KB al escanear y hoy lee lo mismo; la póliza se emitió con otra placa.
    lee(REF.certificado, { ...CERTIFICADO_OK, placa: 'AC124KB' });
    await cotizacion('P-16', {
      vehicle: { ...VEHICULO, placa: 'WDS123G' },
      documents: {
        certificado: {
          status: 'done',
          file: { url: '/files/certificado' },
          ocr: { placa: 'AC-124-KB', serial: '9BWZZZ377VT004251' },
        },
      },
    });
    const id = await crearRcv('P-16', ['certificado']);
    const d = req(id, 'certificado').diagnostico;
    expect(d.resultado).toBe('datos_modificados');
    expect(d.resumen).toMatch(
      /^Datos cambiados en el formulario: el OCR leyó la placa AC124KB del certificado, pero la póliza se emitió con WDS123G/,
    );
  });

  it('personas: cédula de un asegurado de la cotización → coincide', async () => {
    const ref = 'LM/40121247/pendiente/cedula.webp';
    lee(ref, {
      identificacion: '40121247',
      tipoDoc: 'V',
      nombre: 'MARIANA VALENTINA',
      apellido: 'ROJAS',
    });
    const crear = async (poliza: string) => {
      const r = await svc.registrarDesdeEmision(
        {
          id: Number(poliza.replace(/\D/g, '')),
          empresaId: 7,
          polizaNumero: poliza,
          jsonData: {
            producto: 'personas',
            tomadorNombre: 'María José',
            tomadorIdentificacion: 'V-12345678',
          },
        },
        {
          expediente: {
            centidad: 'C',
            ccanalalt: '900',
            producto: 'personas',
            documentos: { cedula: { recibido: true, ref } },
          },
        },
      );
      await svc.esperarAnalisisPendientes();
      return r!.id;
    };
    // Sin cotización: Nexus no conoce a los asegurados (v5).
    const sin = await crear('P-20');
    expect(req(sin, 'cedula').motivo).toMatch(/no trae los asegurados/);
    await cotizacion('P-21', {
      product: 'funerario',
      sameInsured: false,
      asegurado: HIJA,
    });
    const con = await crear('P-21');
    expect(req(con, 'cedula')).toMatchObject({ estado: 'validado' });
    expect(req(con, 'cedula').diagnostico.resultado).toBe('coincide');
  });

  it('al desplegar: el observado v6 se recompara sin OCR con la cotización; lo validado no se toca', async () => {
    lee(REF.certificado, CERTIFICADO_OK);
    lee(REF.cedula, {
      identificacion: '12345678',
      tipoDoc: 'V',
      nombre: 'MARIA JOSE',
      apellido: 'PEREZ',
    });
    const id = await crearRcv('P-30', ['certificado', 'cedula']);
    const cert = req(id, 'certificado');
    expect(cert.estado).toBe('observado');
    cert.diagnostico = { ...cert.diagnostico, comparador: 6 };
    const ced = req(id, 'cedula');
    expect(ced.estado).toBe('validado');
    ced.diagnostico = { ...ced.diagnostico, comparador: 6 };
    const antes = { ...ced };
    await cotizacion('P-30', { vehicle: VEHICULO });

    const llamadas = llamadasAnalizar().length;
    const r = await svc.revisarConIa({ modo: 'completo' });
    expect(r.motivos).toEqual({ cambio_comparador: 1 });
    expect(llamadasAnalizar()).toHaveLength(llamadas);
    expect(req(id, 'certificado')).toMatchObject({ estado: 'validado' });
    expect(req(id, 'certificado').diagnostico.comparador).toBe(
      VERSION_COMPARADOR,
    );
    expect(req(id, 'cedula')).toEqual(antes);
  });
});

describe('v7: área y «emitida por» desde la cotización', () => {
  it('expediente sin área: la conciliación la completa sin correos y sin reabrir lo validado', async () => {
    lee(REF.certificado, CERTIFICADO_OK);
    await cotizacion('P-40', {
      vehicle: VEHICULO,
      metadataCanal: { centidad: 'C' },
      ccanalalt_in: '900',
      cusuario: 'U77',
    });
    const r = await svc.registrarDesdeEmision(
      { id: 40, empresaId: 7, polizaNumero: 'P-40', jsonData: {} },
      {
        expediente: {
          producto: 'rcv',
          documentos: { certificado: { recibido: true, ref: REF.certificado } },
        },
      },
    );
    await svc.esperarAnalisisPendientes();
    const id = r!.id;
    expect(exp(id).area).toBe('desconocida');
    expect(req(id, 'certificado').estado).toBe('validado');
    const reqAntes = { ...req(id, 'certificado') };
    const fetchAntes = fetchMock.mock.calls.length;

    const c = await svc.conciliar();
    expect(c.actoresCotizacion).toMatchObject({
      revisados: 1,
      actualizados: 1,
    });
    expect(exp(id)).toMatchObject({
      area: 'canal',
      centidad: 'C',
      ccanalalt: '900',
      cusuario: 'U77',
    });
    expect(req(id, 'certificado')).toEqual(reqAntes);
    expect(fetchMock.mock.calls.length).toBe(fetchAntes);
    // Segunda pasada: ya no es «desconocida»; nada que hacer.
    expect((await svc.conciliar()).actoresCotizacion.revisados).toBe(0);
  });

  it('con cotización ambigua no cambia el área', async () => {
    await cotizacion('P-41', { metadataCanal: { centidad: 'C' } });
    await cotizacion('P-41', { metadataCanal: { centidad: 'P' } });
    const r = await svc.registrarDesdeEmision(
      { id: 41, empresaId: 7, polizaNumero: 'P-41', jsonData: {} },
      { expediente: { producto: 'rcv' } },
    );
    const c = await svc.conciliar();
    expect(c.actoresCotizacion).toMatchObject({ ambiguas: 1, actualizados: 0 });
    expect(exp(r!.id).area).toBe('desconocida');
  });
});
