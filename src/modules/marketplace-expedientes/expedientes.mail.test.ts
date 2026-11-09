import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../utils/logger', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import {
  asuntoExpediente,
  BrandedContent,
  correoCompleto,
  correoObservado,
  correoRecibido,
  correoRecordatorio,
  correoResumenNocturno,
  correoSolicitudInicial,
  DatosCorreoAsegurado,
  datosReporteDiario,
  entregarCorreo,
  estadoDocCorreo,
  MAX_BYTES_REPORTE,
} from './expedientes.mail';
import type { FilaReporte, ReporteDiario } from './expedientes.reporte';

const ENLACE = 'https://nexusqa.test/portal-lm/expediente?t=abc';

function datos(enlace: string | null = ENLACE): DatosCorreoAsegurado {
  return {
    nombre: 'Luis',
    polizas: ['18-1-0000078926'],
    documentos: [
      { nombre: 'Cédula de identidad', estado: 'pendiente' },
      {
        nombre: 'Licencia de conducir',
        estado: 'corregir',
        motivo: 'La licencia está vencida.',
      },
      { nombre: 'Certificado de circulación', estado: 'aprobado' },
    ],
    enlace,
  };
}

function todos(enlace: string | null): BrandedContent[] {
  const d = datos(enlace);
  return [
    correoSolicitudInicial(d),
    correoRecordatorio(d),
    correoObservado({
      ...d,
      documento: 'Licencia de conducir',
      motivo: 'La licencia está vencida.',
    }),
    correoRecibido({ ...d, documento: 'Cédula de identidad' }),
    correoCompleto(d),
  ];
}

let fetchMock: ReturnType<typeof vi.fn>;
const ok = () =>
  new Response(JSON.stringify({ status: true, data: { sent: true } }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
const status = (s: number) =>
  new Response(JSON.stringify({ message: 'template must be one of …' }), {
    status: s,
    headers: { 'content-type': 'application/json' },
  });
const bodies = () =>
  fetchMock.mock.calls.map(([, init]) => JSON.parse(init.body));

beforeEach(() => {
  process.env.NEST_API_KEY = 'k';
  process.env.EXPEDIENTES_MAIL_WHITELIST = 'luis@test.com';
  delete process.env.EXPEDIENTES_ENTORNO;
  fetchMock = vi.fn(async () => ok());
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.NEST_API_KEY;
  delete process.env.EXPEDIENTES_MAIL_WHITELIST;
});

describe('correos al asegurado: datos para expediente-documentos', () => {
  it('mapea los estados de la BD a los que ve el asegurado', () => {
    expect(estadoDocCorreo('faltante')).toBe('pendiente');
    expect(estadoDocCorreo('observado')).toBe('corregir');
    expect(estadoDocCorreo('recibido')).toBe('en_revision');
    expect(estadoDocCorreo('validado')).toBe('aprobado');
    expect(estadoDocCorreo('sin_informacion')).toBeNull();
  });

  it('envía la plantilla nueva con tipo, nombre, pólizas, documentos y enlace', async () => {
    const r = await entregarCorreo(
      ['luis@test.com'],
      'Luis',
      correoSolicitudInicial(datos()),
    );
    expect(r.resultado).toBe('enviado');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [b] = bodies();
    expect(b.template).toBe('expediente-documentos');
    expect(b.data).toMatchObject({
      tipo: 'solicitud',
      nombre: 'Luis',
      polizas: ['18-1-0000078926'],
      enlace: ENLACE,
    });
    expect(b.data.venceEn).toBeUndefined();
    expect(b.data.subject).toBe(
      'La Mundial de Seguros | Complete la documentación de su póliza N.º 18-1-0000078926',
    );
    expect(b.data.documentos[1]).toEqual({
      nombre: 'Licencia de conducir',
      estado: 'corregir',
      motivo: 'La licencia está vencida.',
    });
  });

  it('recibido y completo no llevan enlace', () => {
    const [, , , recibido, completo] = todos(ENLACE);
    for (const c of [recibido, completo]) {
      expect(c.expediente!.enlace).toBeNull();
      expect(c.ctaUrl).toBeUndefined();
    }
  });

  it('el asunto de la prueba de QA se respeta en la plantilla nueva y en el respaldo', async () => {
    const base = correoSolicitudInicial(datos());
    fetchMock.mockResolvedValueOnce(status(400));
    await entregarCorreo(['luis@test.com'], 'Luis', {
      ...base,
      subject: `[Prueba QA] ${base.subject}`,
    });
    const [nuevo, respaldo] = bodies();
    expect(nuevo.data.subject).toBe(`[Prueba QA] ${base.subject}`);
    expect(respaldo.data.subject).toBe(`[Prueba QA] ${base.subject}`);
  });
});

describe('respaldo branded', () => {
  it.each([400, 422])(
    'nest-api responde %i: reintenta una sola vez con branded',
    async (s) => {
      fetchMock.mockResolvedValueOnce(status(s));
      const r = await entregarCorreo(
        ['luis@test.com'],
        'Luis',
        correoSolicitudInicial(datos()),
      );
      expect(r.resultado).toBe('enviado');
      expect(fetchMock).toHaveBeenCalledTimes(2);
      const [, b] = bodies();
      expect(b.template).toBe('branded');
      expect(b.data.eyebrow).toBe('Control documental');
      expect(b.data.title).toBe('Complete la documentación de su póliza');
      expect(b.data.intro).toBe(
        'Estimado(a) Luis: le confirmamos que su póliza ha sido emitida exitosamente. ' +
          'Aún se encuentra pendiente completar la siguiente documentación: ' +
          'Cédula de identidad; Licencia de conducir (La licencia está vencida).',
      );
      expect(b.data.fields).toEqual([
        { label: 'Póliza', value: 'N.º 18-1-0000078926' },
        { label: 'Pendientes', value: '2' },
      ]);
      expect(b.data.ctaLabel).toBe('Completar mi expediente');
      expect(b.data.ctaUrl).toBe(ENLACE);
      expect(b.data.extraNote).toContain(
        '¿Ya entregó estos documentos a La Mundial de Seguros?',
      );
    },
  );

  it('si el respaldo también falla, queda como error (sin más reintentos)', async () => {
    fetchMock.mockResolvedValue(status(400));
    const r = await entregarCorreo(
      ['luis@test.com'],
      'Luis',
      correoRecordatorio(datos()),
    );
    expect(r.resultado).toBe('error');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('otros errores (500, red) no reintentan con branded', async () => {
    fetchMock.mockResolvedValueOnce(status(500));
    const r = await entregarCorreo(
      ['luis@test.com'],
      'Luis',
      correoSolicitudInicial(datos()),
    );
    expect(r.resultado).toBe('error');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('cada mensaje una sola vez: sin firma en el texto y la póliza solo en fields', () => {
    for (const c of [...todos(ENLACE), ...todos(null)]) {
      expect(c.intro).not.toContain('La Mundial de Seguros');
      expect(c.intro).not.toContain('18-1-0000078926');
      expect(c.extraNote ?? '').not.toContain(c.intro);
      expect(c.fields![0]).toEqual({
        label: 'Póliza',
        value: 'N.º 18-1-0000078926',
      });
    }
  });
});

describe('vocabulario al asegurado', () => {
  it('asuntos oficiales de usted; el recordatorio lleva «Recordatorio:» delante', () => {
    const [sol, rec] = todos(ENLACE);
    expect(sol.subject).toBe(
      'La Mundial de Seguros | Complete la documentación de su póliza N.º 18-1-0000078926',
    );
    expect(rec.subject).toBe(`Recordatorio: ${sol.subject}`);
    expect(asuntoExpediente('solicitud', ['A', 'B'])).toBe(
      'La Mundial de Seguros | Complete la documentación de sus pólizas N.º A y N.º B',
    );
  });

  it('ningún correo al asegurado tutea (de usted)', async () => {
    for (const enlace of [ENLACE, null]) {
      for (const c of todos(enlace)) {
        fetchMock.mockClear();
        fetchMock.mockResolvedValueOnce(status(400));
        await entregarCorreo(['luis@test.com'], 'Luis', c);
        const enviado = JSON.stringify(bodies());
        expect(enviado).not.toMatch(
          /\btu\s|\btus\s|envíanos|Toma una foto|Subir mis|\bpuedes\b|\bnecesitas\b|\bCompleta\b/i,
        );
      }
    }
  });

  it('ningún correo al asegurado dice «vendedor»', async () => {
    for (const enlace of [ENLACE, null]) {
      for (const c of todos(enlace)) {
        fetchMock.mockClear();
        fetchMock.mockResolvedValueOnce(status(400));
        await entregarCorreo(['luis@test.com'], 'Luis', c);
        // Lo que sale en ambas plantillas (nueva y respaldo).
        const enviado = JSON.stringify(bodies()).toLowerCase();
        expect(enviado).not.toContain('vendedor');
        expect(JSON.stringify(c).toLowerCase()).not.toContain('vendedor');
      }
    }
  });
});

describe('control documental diario', () => {
  const fila: FilaReporte = {
    poliza: '18-27-0000137414',
    asegurado: 'M. P. · V-12•••678',
    producto: 'RCV',
    emitidaPor: 'Farmatodo',
    observacion: 'Falta licencia',
    dias: 0,
    intentos: 1,
    ultimoResultado: 'Enviado',
    noEnviar: false,
    siguienteAccion: 'Recordatorio el 11/11/2026',
  };
  const reporte = (extra: Partial<ReporteDiario> = {}): ReporteDiario => ({
    grupo: 'canales',
    areas: 'Canales',
    fecha: '2026-11-08',
    fechaLocal: '08/11/2026',
    corte: '08/11/2026 23:00',
    dia: { emitidas: 7, completas: 3, incompletas: 4, sinDatos: 0 },
    distribucion: {
      faltantes: 2,
      ilegibles: 0,
      inconsistentes: 0,
      porValidar: 1,
    },
    polizas: [fila],
    polizasRestantes: 3,
    cartera: {
      total: 10,
      completos: 5,
      incompletos: 5,
      sinDatos: 0,
      desglose: [{ label: 'Faltan documentos', valor: 5 }],
    },
    historicos: {
      anteriores: 1,
      sinRespuesta: 0,
      sinCorreoValido: 0,
      noEnviar: 0,
    },
    conciliacion: {
      emisionesNexus: 7,
      enMonitor: 7,
      noPasaronOcr: 0,
      sinVinculo: 0,
    },
    entregabilidad: {
      intentos: 0,
      entregados: 0,
      conError: 0,
      sinCorreo: 0,
      bloqueados: 0,
      excluidos: 0,
    },
    tecnicos: { documentosNoLeidos: 0, fallasTecnicas: 0 },
    enlace: null,
    ...extra,
  });

  it('asunto oficial y datos para expediente-reporte-diario', () => {
    const c = correoResumenNocturno(reporte());
    expect(c.subject).toBe(
      'Marketplace | Canales | Control documental diario – 08/11/2026',
    );
    expect(c.reporte).toMatchObject({
      subject: c.subject,
      areas: 'Canales',
      fecha: '08/11/2026',
      corte: '08/11/2026 23:00',
      polizas: [fila],
      polizasRestantes: 3,
    });
  });

  it('respaldo branded: solo cifras, introducción una vez y sin «vendedor»', () => {
    const c = correoResumenNocturno(reporte());
    expect(c.introArriba).toBe(false);
    expect(c.intro).not.toMatch(/Emitidas hoy|Completas|Incompletas/);
    const labels = (c.fields ?? []).map((x) => x.label);
    expect(labels).toEqual(
      expect.arrayContaining([
        'Emitidas hoy',
        'Completas al corte',
        'Incompletas de hoy',
        'Faltantes',
        'Ilegibles',
        'Inconsistentes',
        'Por validar',
        'Conciliación con Nexus',
      ]),
    );
    expect(JSON.stringify(c.fields)).not.toContain('18-27-0000137414');
    expect(JSON.stringify(c).toLowerCase()).not.toMatch(
      /vendedor|sin información/,
    );
  });

  it('cero pendientes: la introducción del respaldo lo dice', () => {
    const c = correoResumenNocturno(
      reporte({
        dia: { emitidas: 2, completas: 2, incompletas: 0, sinDatos: 0 },
        polizas: [],
        polizasRestantes: 0,
      }),
    );
    expect(c.intro).toContain('0 pendientes de la emisión del día');
  });

  it('con textos largos recorta filas para no pasar el límite de nest-api', () => {
    const largas = Array.from({ length: 200 }, (_, i) => ({
      ...fila,
      poliza: `P-${i}`,
      emitidaPor: 'x'.repeat(200),
      observacion: 'y'.repeat(400),
    }));
    const data = datosReporteDiario(
      'Asunto',
      reporte({ polizas: largas, polizasRestantes: 0 }),
    ) as { polizas: FilaReporte[]; polizasRestantes: number };
    expect(Buffer.byteLength(JSON.stringify(data))).toBeLessThanOrEqual(
      MAX_BYTES_REPORTE,
    );
    expect(data.polizas.length).toBeLessThan(200);
    expect(data.polizas.length + data.polizasRestantes).toBe(200);
    expect(data.polizas[0].observacion.length).toBeLessThanOrEqual(160);
  });
});
