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

/*
 * Campos de cuadre de los indicadores: descartadas, emisionesNexus, porArea, noLeidos
 * (separado de analizando) y validacion.
 */

const db = prisma as any;
const svc = new ExpedientesService();
const ENERO = new Date('2026-01-10T12:00:00Z');
const MARZO = new Date('2026-03-10T12:00:00Z');

let n = 0;
async function exp(over: Record<string, any> = {}) {
  n++;
  return db.mktExpediente.create({
    data: {
      empresaId: 7,
      cnpoliza: `P-${n}`,
      producto: 'rcv',
      area: 'canal',
      estadoDocumental: 'incompleto',
      emitidaEn: ENERO,
      ...over,
    },
  });
}

const emision = (createdAt: Date, empresaId = 7) =>
  db.emision.create({
    data: {
      empresaId,
      cotizacionId: 1,
      polizaNumero: `E-${++n}`,
      createdAt,
    },
  });

/** Requisito recibido con archivo; `diag` = resultado del diagnóstico vigente de la IA. */
const recibido = (
  expedienteId: number,
  tipo: string,
  diag?: string,
  over: Record<string, any> = {},
) =>
  db.mktExpedienteRequisito.create({
    data: {
      expedienteId,
      tipo,
      estado: 'recibido',
      ref: `ref-${expedienteId}-${tipo}`,
      ...(diag
        ? {
            analisisRef: `ref-${expedienteId}-${tipo}`,
            diagnostico: {
              version: 1,
              tipo,
              analizadoEn: '2026-01-10T12:00:00.000Z',
              resultado: diag,
              resumen: 'x',
              campos: [],
            },
          }
        : {}),
      ...over,
    },
  });

beforeEach(() => {
  db.$reset();
  n = 0;
  process.env.EXPEDIENTES_ENABLED = 'true';
});

describe('indicadores: cuadre con Nexus', () => {
  it('descartadas: fuera del total, con los mismos filtros de fecha y área', async () => {
    await exp();
    await exp({ estadoDocumental: 'descartada' });
    await exp({ estadoDocumental: 'descartada', area: 'desconocida' });
    await exp({ estadoDocumental: 'descartada', emitidaEn: MARZO });
    const todo = await svc.indicadores({});
    expect(todo.total).toBe(1);
    expect(todo.descartadas).toBe(3);
    expect((await svc.indicadores({ area: 'C' })).descartadas).toBe(2);
    expect(
      (await svc.indicadores({ desde: '2026-03-01', hasta: '2026-03-31' }))
        .descartadas,
    ).toBe(1);
  });

  it('emisionesNexus: filas de emision del rango (todas las empresas), sin filtro de área', async () => {
    await emision(ENERO, 7);
    await emision(ENERO, 5);
    await emision(MARZO, 7);
    // Borde: 31-ene 23:30 hora Caracas cuenta en enero (hasta inclusive).
    await emision(new Date('2026-02-01T03:30:00Z'), 7);
    expect((await svc.indicadores({})).emisionesNexus).toBe(4);
    expect(
      (await svc.indicadores({ desde: '2026-01-01', hasta: '2026-01-31' }))
        .emisionesNexus,
    ).toBe(3);
    expect(
      (await svc.indicadores({ area: 'C', desde: '2026-03-01' }))
        .emisionesNexus,
    ).toBe(1);
  });

  it('porArea: suma el total; el gestor cuenta en canales; sin datos aparte', async () => {
    await svc.updateConfig(
      { alcance: { productores: true }, motivo: 'prueba' } as any,
      'portal:1',
    );
    await exp({ area: 'canal', centidad: 'C', ccanalalt: '27' });
    await exp({ area: 'gestor', centidad: 'G', cgestor: '749', ccanalalt: '27' });
    await exp({ area: 'productor', centidad: 'P', cproductor: '80080' });
    // Gestor de un productor («80080-1219», sin canal en magestor): cuenta en Productores.
    await exp({ area: 'gestor', centidad: 'P', cgestor: '80080-1219' });
    await exp({ area: 'desconocida' });
    await exp({ area: 'desconocida', xlogin: 'usuario@ejemplo.com' });
    await exp({ area: 'desconocida', estadoDocumental: 'descartada' });
    const ind = await svc.indicadores({});
    expect(ind.porArea).toEqual({ canales: 2, productores: 2, sinDatos: 2 });
    expect(ind.pendientesCanal).toBe(2);
    expect(
      ind.porArea.canales + ind.porArea.productores + ind.porArea.sinDatos,
    ).toBe(ind.total);
    // Filtro Canales (área guardada canal/gestor): el gestor de productor se ve en Productores.
    expect((await svc.indicadores({ area: 'C' })).porArea).toEqual({
      canales: 2,
      productores: 1,
      sinDatos: 0,
    });
  });

  it('noLeidos: error técnico vigente; analizando ya no lo incluye; porValidar igual', async () => {
    const a = await exp(); // solo error técnico
    await recibido(a.id, 'cedula', 'error_tecnico');
    const b = await exp(); // recibido sin diagnóstico: la IA lo analiza
    await recibido(b.id, 'cedula');
    const c = await exp(); // uno de cada: cuenta en los dos
    await recibido(c.id, 'cedula', 'error_tecnico');
    await recibido(c.id, 'licencia');
    const d = await exp(); // error técnico de OTRO archivo: ya no es vigente
    await recibido(d.id, 'cedula', 'error_tecnico', { analisisRef: 'viejo' });
    const e = await exp(); // decisión manual: ni la IA ni el no leído
    await recibido(e.id, 'cedula', 'error_tecnico', { decision: 'manual' });
    const ind = await svc.indicadores({});
    expect(ind.validacion).toBe('automatica');
    expect(ind.noLeidos).toBe(2); // a, c
    expect(ind.analizando).toBe(3); // b, c, d
    expect(ind.porValidar).toBe(5);
  });

  it('validación manual: noLeidos y analizando en 0, porValidar sigue contando', async () => {
    await svc.updateConfig(
      { validacion: 'manual', motivo: 'prueba' } as any,
      'portal:1',
    );
    const a = await exp();
    await recibido(a.id, 'cedula', 'error_tecnico');
    const ind = await svc.indicadores({});
    expect(ind).toMatchObject({
      validacion: 'manual',
      noLeidos: 0,
      analizando: 0,
      porValidar: 1,
    });
  });
});

describe('indicadores: desglose de incompletos (una categoría por póliza)', () => {
  const req = (expedienteId: number, tipo: string, estado: string) =>
    db.mktExpedienteRequisito.create({
      data: {
        expedienteId,
        tipo,
        estado,
        ...(estado === 'validado' ? { validadoPor: 'ia', ref: 'r' } : {}),
      },
    });
  const sumar = (d: Record<string, number>) =>
    Object.values(d).reduce((a, x) => a + x, 0);

  it('la suma del desglose es incompletos y completos + incompletos es el total', async () => {
    const ok = await exp({ estadoDocumental: 'completo' });
    for (const t of ['cedula', 'licencia', 'certificado'])
      await req(ok.id, t, 'validado');
    // Mixto: error + no leído → solo «con errores».
    const a = await exp();
    await recibido(a.id, 'cedula', 'no_coincide', { estado: 'observado' });
    await recibido(a.id, 'licencia', 'error_tecnico');
    // Datos cambiados + faltante → «datos cambiados».
    const b = await exp();
    await recibido(b.id, 'cedula', 'datos_modificados', {
      estado: 'observado',
    });
    await req(b.id, 'licencia', 'faltante');
    // No leído + faltante → «no se pudo leer».
    const c = await exp();
    await recibido(c.id, 'cedula', 'error_tecnico');
    await req(c.id, 'licencia', 'faltante');
    // La IA lo revisa → «analizando».
    const d = await exp();
    await recibido(d.id, 'cedula');
    // Solo faltan documentos (con y sin filas de requisito).
    const e = await exp();
    await req(e.id, 'cedula', 'validado');
    await req(e.id, 'licencia', 'faltante');
    await exp();
    // Recibido sin archivo: la IA no puede leerlo → «por validar».
    const g = await exp();
    await recibido(g.id, 'cedula', undefined, { ref: null });

    const ind = await svc.indicadores({});
    expect(ind.desglose).toEqual({
      conErrores: 1,
      datosCambiados: 1,
      noLeidos: 1,
      porValidar: 1,
      analizando: 1,
      faltanDocumentos: 2,
      otros: 0,
    });
    expect(ind.incompletos).toBe(7);
    expect(sumar(ind.desglose)).toBe(ind.incompletos);
    expect(ind.completos + ind.incompletos + ind.sinInformacion).toBe(
      ind.total,
    );
    expect(ind.completos + ind.incompletos).toBe(ind.total);
    // Los contadores sueltos se mantienen («con algún documento en X»: se pisan).
    expect(ind.conErrores).toBe(2); // a, b
    expect(ind.noLeidos).toBe(2); // a, c
  });

  it('con filtro de área el desglose sigue sumando sus incompletos', async () => {
    const a = await exp({ area: 'canal' });
    await recibido(a.id, 'cedula', 'ilegible', { estado: 'observado' });
    await exp({ area: 'gestor' });
    await exp({ area: 'desconocida' });
    const canal = await svc.indicadores({ area: 'C' });
    expect(canal.incompletos).toBe(2);
    expect(canal.desglose).toMatchObject({
      conErrores: 1,
      faltanDocumentos: 1,
    });
    expect(sumar(canal.desglose)).toBe(canal.incompletos);
    const todo = await svc.indicadores({});
    expect(sumar(todo.desglose)).toBe(todo.incompletos);
  });
});
