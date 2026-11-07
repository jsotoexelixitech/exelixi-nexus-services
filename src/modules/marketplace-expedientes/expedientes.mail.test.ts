import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../utils/logger', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import {
  BrandedContent,
  correoCompleto,
  correoObservado,
  correoRecibido,
  correoRecordatorio,
  correoSolicitudInicial,
  DatosCorreoAsegurado,
  entregarCorreo,
  estadoDocCorreo,
} from './expedientes.mail';

const ENLACE = 'https://nexusqa.test/portal-lm/expediente?t=abc';
const VENCE = new Date('2026-11-14T15:00:00.000Z');

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
    expiraEn: VENCE,
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

  it('envía la plantilla nueva con tipo, nombre, póliza, documentos, enlace y vencimiento', async () => {
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
      poliza: '18-1-0000078926',
      enlace: ENLACE,
      venceEn: VENCE.toISOString(),
    });
    expect(b.data.documentos[1]).toEqual({
      nombre: 'Licencia de conducir',
      estado: 'corregir',
      motivo: 'La licencia está vencida.',
    });
  });

  it('recibido y completo no llevan enlace ni vencimiento', () => {
    const [, , , recibido, completo] = todos(ENLACE);
    for (const c of [recibido, completo]) {
      expect(c.expediente!.enlace).toBeNull();
      expect(c.expediente!.expiraEn).toBeNull();
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
      expect(b.data.eyebrow).toBe('Documentos de tu póliza');
      expect(b.data.title).toBe('Completa tu expediente: faltan 2 documentos');
      expect(b.data.fields).toEqual([
        { label: 'Póliza', value: '18-1-0000078926' },
        { label: 'Pendientes', value: '2' },
        { label: 'Vence', value: '14/11/2026' },
      ]);
      expect(b.data.ctaLabel).toBe('Subir mis documentos');
      expect(b.data.ctaUrl).toBe(ENLACE);
      expect(b.data.extraNote).toContain('asesor de seguros');
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
        value: '18-1-0000078926',
      });
    }
  });
});

describe('vocabulario al asegurado', () => {
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
