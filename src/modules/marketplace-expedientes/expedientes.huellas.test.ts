/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * Archivo cambiado después de analizarse: huella del disco vs archivoHash. Solo aviso en el
 * diagnóstico y evento; nunca cambia el estado ni envía correos; vista previa sin escribir.
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
import {
  _resetHuellas,
  _setDormirHuellas,
  huellasConfig,
  marcaArchivoCambiado,
  revisarHuellas,
  tickHuellas,
} from './expedientes.huellas';

const db = prisma as any;

async function req(
  id: number,
  ref: string,
  hash: string | null,
  extra: Record<string, unknown> = {},
) {
  await db.mktExpediente.create({
    data: {
      id,
      empresaId: 7,
      cnpoliza: `P-${id}`,
      producto: 'personas',
      emitidaEn: new Date(),
    },
  });
  return db.mktExpedienteRequisito.create({
    data: {
      expedienteId: id,
      tipo: 'cedula',
      estado: 'validado',
      decision: 'ia',
      ref,
      analisisRef: ref,
      archivoHash: hash,
      diagnostico: { resultado: 'coincide', comparador: 13 },
      ...extra,
    },
  });
}

function ocr(res: Record<string, { existe: boolean; hash: string | null }>) {
  return vi.fn().mockImplementation(async (_u: string, init: any) => {
    const { refs } = JSON.parse(init.body);
    return {
      ok: true,
      status: 200,
      json: async () => ({
        ok: true,
        resultados: refs.map((r: string) => ({
          ref: r,
          ...(res[r] ?? { existe: false, hash: null }),
        })),
      }),
    };
  });
}

const fila = (id: number) =>
  db.mktExpedienteRequisito._rows().find((r: any) => r.expedienteId === id);

beforeEach(() => {
  db.$reset();
  _resetHuellas();
  _setDormirHuellas(async () => undefined);
  process.env.EXPEDIENTES_ENABLED = 'true';
  process.env.EXPEDIENTES_JOBS_ENABLED = 'true';
  process.env.EXPEDIENTES_HUELLAS_ENABLED = 'true';
  process.env.EXPEDIENTES_HUELLAS_AUTO = 'true';
  process.env.OCR_INTERNAL_URL = 'http://ocr.local';
  process.env.EXPEDIENTE_INTERNAL_KEY = 'k';
});
afterEach(() => {
  vi.unstubAllGlobals();
  for (const k of [
    'EXPEDIENTES_HUELLAS_ENABLED',
    'EXPEDIENTES_HUELLAS_AUTO',
    'EXPEDIENTES_HUELLAS_HORA',
    'OCR_INTERNAL_URL',
    'EXPEDIENTE_INTERNAL_KEY',
  ])
    delete process.env[k];
});

describe('revisión de huellas', () => {
  it('apagada sin flag u OCR', () => {
    expect(huellasConfig()).not.toBeNull();
    delete process.env.EXPEDIENTES_HUELLAS_ENABLED;
    expect(huellasConfig()).toBeNull();
  });

  it('otra huella o inexistente: marca informativa y evento, sin cambiar el estado', async () => {
    await req(1, 'a/1.pdf', 'h1');
    await req(2, 'a/2.pdf', 'h2');
    await req(3, 'a/3.pdf', 'h3');
    vi.stubGlobal(
      'fetch',
      ocr({
        'a/1.pdf': { existe: true, hash: 'h1' },
        'a/2.pdf': { existe: true, hash: 'otra' },
      }),
    );
    const r: any = await revisarHuellas({ vistaPrevia: false });
    expect(r.revisados).toBe(3);
    expect(r.coinciden).toBe(1);
    expect(r.nuevosCambiados).toBe(2);
    expect(r.noExisten).toBe(1);
    expect(r.actualizados).toBe(2);
    expect(fila(1).diagnostico.archivoCambiado).toBeUndefined();
    expect(fila(2).diagnostico.archivoCambiado.motivo).toBe('otro');
    expect(fila(3).diagnostico.archivoCambiado.motivo).toBe('no_existe');
    expect(fila(2).estado).toBe('validado');
    expect(fila(3).decision).toBe('ia');
    expect(marcaArchivoCambiado(fila(2))).not.toBeNull();
    const ev = db.mktExpedienteEvento._rows().filter((e: any) => e.tipo === 'archivo_cambiado');
    expect(ev).toHaveLength(2);
    expect(db.mktExpedienteNotificacion._rows().length).toBe(0);
  });

  it('vista previa cuenta y no escribe', async () => {
    await req(1, 'a/1.pdf', 'h1');
    vi.stubGlobal('fetch', ocr({ 'a/1.pdf': { existe: true, hash: 'x' } }));
    const r: any = await revisarHuellas({ vistaPrevia: true });
    expect(r.nuevosCambiados).toBe(1);
    expect(r.actualizados).toBe(0);
    expect(fila(1).diagnostico.archivoCambiado).toBeUndefined();
    expect(db.mktExpedienteEvento._rows()).toHaveLength(0);
  });

  it('la marca se quita sola si la huella vuelve a coincidir', async () => {
    await req(1, 'a/1.pdf', 'h1', {
      diagnostico: {
        resultado: 'coincide',
        archivoCambiado: { detectadoEn: '2026-11-24T00:00:00Z', motivo: 'otro' },
      },
    });
    vi.stubGlobal('fetch', ocr({ 'a/1.pdf': { existe: true, hash: 'h1' } }));
    const r: any = await revisarHuellas({ vistaPrevia: false });
    expect(r.restituidos).toBe(1);
    expect(fila(1).diagnostico.archivoCambiado).toBeUndefined();
    expect(fila(1).diagnostico.resultado).toBe('coincide');
  });

  it('ignora filas cuyo diagnóstico no es del archivo actual', async () => {
    await req(1, 'a/1.pdf', 'h1', { analisisRef: 'a/viejo.pdf' });
    const f = vi.fn();
    vi.stubGlobal('fetch', f);
    const r: any = await revisarHuellas({ vistaPrevia: false });
    expect(r.revisados).toBe(0);
    expect(f).not.toHaveBeenCalled();
  });

  it('error del OCR: no cambia nada', async () => {
    await req(1, 'a/1.pdf', 'h1');
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 500, json: async () => ({}) }));
    const r: any = await revisarHuellas({ vistaPrevia: false });
    expect(r.errores).toBe(1);
    expect(fila(1).diagnostico.archivoCambiado).toBeUndefined();
  });

  it('nocturna: una vez al día, a la hora; solo con AUTO', async () => {
    await req(1, 'a/1.pdf', 'h1');
    vi.stubGlobal('fetch', ocr({ 'a/1.pdf': { existe: true, hash: 'h1' } }));
    process.env.EXPEDIENTES_HUELLAS_HORA = '3';
    const tres = new Date('2026-11-24T07:30:00Z'); // 03:30 Caracas
    expect(await tickHuellas(new Date('2026-11-24T12:00:00Z'))).toBeNull();
    expect(await tickHuellas(tres)).not.toBeNull();
    expect(await tickHuellas(tres)).toBeNull();
    delete process.env.EXPEDIENTES_HUELLAS_AUTO;
    _resetHuellas();
    expect(await tickHuellas(tres)).toBeNull();
  });
});
