/**
 * Revisión de punta a punta del monitor (24-nov-2026), con BD simulada:
 *  1. Validado con el archivo de OTRA persona (7-7-7000003109 y 9-7-7000002320 quedaron validadas
 *     con la huella de la cédula de un tercero): se detecta sin IA (misma huella en pólizas de
 *     personas distintas y lo leído no es de la póliza) y sale de «validado». Sin correos; lo
 *     validado a mano no se toca.
 *  2. Ningún cambio de regla ni relectura dispara correos: al subir el comparador, decenas de
 *     requisitos cambian de estado (y expedientes pasan a completos) sin un solo correo.
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
import { VERSION_COMPARADOR } from './expedientes.ia';
import {
  expedientesService as svc,
  MOTIVO_SOBRESCRITO,
} from './expedientes.service';

const db = prisma as any;
let fetchMock: ReturnType<typeof vi.fn>;

const esAnalizar = (url: unknown) =>
  String(url).endsWith('/api/internal/expedientes/analizar');
const llamadasAnalizar = () =>
  fetchMock.mock.calls.filter(([url]: any[]) => esAnalizar(url));
const llamadasCorreo = () =>
  fetchMock.mock.calls.filter(([url]: any[]) => !esAnalizar(url));
const req = (id: number, tipo: string) =>
  db.mktExpedienteRequisito
    ._rows()
    .find((x: any) => x.expedienteId === id && x.tipo === tipo);
const exp = (id: number) =>
  db.mktExpediente._rows().find((x: any) => x.id === id);

beforeEach(() => {
  db.$reset();
  process.env.EXPEDIENTES_ENABLED = 'true';
  process.env.OCR_INTERNAL_URL = 'http://ocr.local';
  process.env.EXPEDIENTE_INTERNAL_KEY = 'clave-interna';
  process.env.EXPEDIENTES_PUBLIC_URL = 'https://portal.test/portal-lm';
  process.env.NEST_API_KEY = 'k';
  process.env.EXPEDIENTES_MAIL_WHITELIST = 'cliente@test.com';
  delete process.env.EXPEDIENTES_ENTORNO;
  delete process.env.EXPEDIENTES_JOBS_ENABLED;
  fetchMock = vi.fn(async (url: string) => {
    if (esAnalizar(url))
      return new Response(
        JSON.stringify({ ok: false, code: 'ARCHIVO_NO_ENCONTRADO' }),
        { status: 404, headers: { 'content-type': 'application/json' } },
      );
    return new Response(
      JSON.stringify({ status: true, data: { sent: true } }),
      {
        status: 200,
        headers: { 'content-type': 'application/json' },
      },
    );
  });
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(async () => {
  await svc.esperarAnalisisPendientes();
  vi.unstubAllGlobals();
});

async function registrar(
  poliza: string,
  producto: 'personas' | 'rcv',
  persona: any,
  snapshotExtra: Record<string, unknown> = {},
) {
  const r = await svc.registrarDesdeEmision(
    {
      id: Number(poliza.replace(/\D/g, '')) || 1,
      empresaId: 7,
      polizaNumero: poliza,
      jsonData: { producto },
    },
    {
      expediente: {
        centidad: 'C',
        ccanalalt: '900',
        producto,
        estadoPago: 'pagada',
        asegurado: {
          ...persona,
          email: 'cliente@test.com',
        },
        snapshot: {
          tomador: persona,
          asegurado: persona,
          planNombre: 'PLAN',
          ...snapshotExtra,
        },
        documentos: {},
      },
    },
  );
  await svc.esperarAnalisisPendientes();
  return r!.id;
}

describe('validado con el archivo de otra persona (sin IA)', () => {
  const HUMBERTO = {
    tipoDoc: 'V',
    documento: '8000111',
    nombre: 'HUMBERTO',
    apellido: 'ROJAS',
  };
  const YUSMARI = {
    tipoDoc: 'V',
    documento: '15000222',
    nombre: 'YUSMARI',
    apellido: 'MEDINA',
  };
  const FLOR = {
    tipoDoc: 'V',
    documento: '16000333',
    nombre: 'FLOR',
    apellido: 'SUAREZ',
  };
  const HUELLA = `80adab${'0'.repeat(58)}`;
  /** Lo leído del archivo: la cédula de Humberto. */
  const CEDULA_HUMBERTO = {
    documentoTipo: 'cedula',
    tipoDoc: 'V',
    identificacion: '8000111',
    nombre: 'HUMBERTO',
    apellido: 'ROJAS',
  };

  async function validadoConElArchivo(
    poliza: string,
    persona: any,
    extra: Record<string, unknown> = {},
  ) {
    const id = await registrar(poliza, 'personas', persona);
    const ref = `La Mundial de Seguros/${persona.documento}/${poliza}/cedula.pdf`;
    Object.assign(req(id, 'cedula'), {
      estado: 'validado',
      decision: 'ia',
      validadoPor: 'ia',
      validadoEn: new Date('2026-11-12T12:00:00Z'),
      ref,
      analisisRef: ref,
      archivoHash: HUELLA,
      origen: 'emision',
      ocrDatos: CEDULA_HUMBERTO,
      ocrConfianza: 1,
      huellaPoliza: 'vieja',
      motivo: null,
      diagnostico: {
        version: 1,
        tipo: 'cedula',
        resultado: 'coincide',
        comparador: 4,
        resumen: 'Coincide con la póliza.',
        campos: [],
      },
      ...extra,
    });
    await svc.recalcularEstado(id);
    return id;
  }

  it('Yusmari y Flor salen de validado; el dueño del archivo sigue validado; sin OCR ni correos', async () => {
    const humberto = await validadoConElArchivo('7-7-7000003001', HUMBERTO);
    const yusmari = await validadoConElArchivo('7-7-7000003109', YUSMARI);
    const flor = await validadoConElArchivo('9-7-7000002320', FLOR);
    expect(exp(yusmari).estadoDocumental).toBe('completo');
    const correosAntes = llamadasCorreo().length;

    const r = await svc.revisarConIa({ modo: 'completo' });

    expect(r.sobrescritos).toBe(2);
    for (const id of [yusmari, flor]) {
      expect(req(id, 'cedula').estado).toBe('sobrescrito');
      expect(req(id, 'cedula').motivo.startsWith(MOTIVO_SOBRESCRITO)).toBe(
        true,
      );
      expect(req(id, 'cedula').motivo).toContain('V-****0111');
      expect(exp(id).estadoDocumental).toBe('incompleto');
    }
    expect(req(humberto, 'cedula').estado).toBe('validado');
    expect(exp(humberto).estadoDocumental).toBe('completo');
    expect(llamadasAnalizar()).toHaveLength(0);
    expect(llamadasCorreo()).toHaveLength(correosAntes);
    expect(db.mktExpedienteNotificacion._rows()).toHaveLength(0);

    // Segunda pasada: nada más que hacer.
    const r2 = await svc.revisarConIa({ modo: 'completo' });
    expect(r2.sobrescritos).toBeUndefined();
    expect(llamadasAnalizar()).toHaveLength(0);
  });

  it('una validación manual con ese archivo no se toca', async () => {
    await validadoConElArchivo('7-7-7000003001', HUMBERTO);
    const yusmari = await validadoConElArchivo('7-7-7000003109', YUSMARI, {
      decision: 'manual',
      validadoPor: 'analista@test',
    });
    const r = await svc.revisarConIa({ modo: 'completo' });
    expect(r.sobrescritos).toBeUndefined();
    expect(req(yusmari, 'cedula')).toMatchObject({
      estado: 'validado',
      decision: 'manual',
    });
  });

  it('el mismo archivo en dos pólizas de la MISMA persona sigue validado', async () => {
    const a = await validadoConElArchivo('7-7-7000003001', HUMBERTO);
    const b = await validadoConElArchivo('9-7-7000003002', HUMBERTO);
    const r = await svc.revisarConIa({ modo: 'completo' });
    expect(r.sobrescritos).toBeUndefined();
    expect(req(a, 'cedula').estado).toBe('validado');
    expect(req(b, 'cedula').estado).toBe('validado');
  });
});

describe('correos: un cambio de regla o una relectura nunca envía correos', () => {
  const N = 30;

  it(`al subir el comparador, ${N} observados pasan a validado y sus expedientes a completos sin un solo correo`, async () => {
    const ids: number[] = [];
    for (let i = 0; i < N; i++) {
      const persona = {
        tipoDoc: 'V',
        documento: String(13_000_000 + i),
        // Registro con el nombre «Masculino» (falsa alarma que corrige el comparador 13).
        nombre: 'Masculino',
        apellido: `RODRIGUEZ PEÑA`,
      };
      const id = await registrar(
        `18-1-00001${String(i).padStart(5, '0')}`,
        'rcv',
        persona,
      );
      const ref = `La Mundial de Seguros/${persona.documento}/p${i}/cedula.jpg`;
      Object.assign(req(id, 'cedula'), {
        estado: 'observado',
        decision: 'ia',
        validadoPor: 'ia',
        ref,
        analisisRef: ref,
        archivoHash: `h${i}`,
        origen: 'emision',
        ocrDatos: {
          documentoTipo: 'cedula',
          tipoDoc: 'V',
          identificacion: persona.documento,
          nombre: 'DANRY FERNANDO',
          apellido: 'RODRIGUEZ PEÑA',
        },
        ocrConfianza: 1,
        huellaPoliza: 'vieja',
        motivo: 'El nombre del documento (DANRY FERNANDO) no coincide…',
        diagnostico: {
          version: 1,
          tipo: 'cedula',
          resultado: 'no_coincide',
          comparador: VERSION_COMPARADOR - 1,
          resumen: 'El nombre del documento (DANRY FERNANDO) no coincide…',
          campos: [],
        },
      });
      // Los demás documentos ya validados a mano: al validar la cédula el expediente se completa.
      for (const fila of db.mktExpedienteRequisito._rows()) {
        if (fila.expedienteId === id && fila.tipo !== 'cedula')
          Object.assign(fila, {
            estado: 'validado',
            decision: 'manual',
            validadoPor: 'analista@test',
            ref: `${ref}.${fila.tipo}`,
          });
      }
      await svc.recalcularEstado(id);
      expect(exp(id).estadoDocumental).toBe('incompleto');
      ids.push(id);
    }
    const correosAntes = llamadasCorreo().length;
    const notifsAntes = db.mktExpedienteNotificacion._rows().length;

    const r = await svc.revisarConIa({ modo: 'completo' });

    expect(r.motivos.cambio_comparador).toBe(N);
    expect(r.validados).toBe(N);
    for (const id of ids) {
      expect(req(id, 'cedula').estado).toBe('validado');
      expect(exp(id).estadoDocumental).toBe('completo');
    }
    // Ni una lectura nueva ni un correo (ni «completo», ni «observado», ni recordatorio).
    expect(llamadasAnalizar()).toHaveLength(0);
    expect(llamadasCorreo()).toHaveLength(correosAntes);
    expect(db.mktExpedienteNotificacion._rows()).toHaveLength(notifsAntes);
  });

  it('control: el aviso de un evento real sí envía (la prueba anterior no pasa por tener el correo apagado)', async () => {
    const id = await registrar('18-1-0000199999', 'rcv', {
      tipoDoc: 'V',
      documento: '13999999',
      nombre: 'Ana',
      apellido: 'Pérez',
    });
    const antes = llamadasCorreo().length;
    await svc.notificarEvento(exp(id), 'completo');
    expect(llamadasCorreo().length).toBeGreaterThan(antes);
    expect(db.mktExpedienteNotificacion._rows().at(-1)).toMatchObject({
      tipo: 'completo',
      resultado: 'enviado',
    });
  });
});
