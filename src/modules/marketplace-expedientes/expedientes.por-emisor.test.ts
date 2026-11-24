/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * Indicador «Por emisor» («Emitida por») y clasificación por OCR (pasaron / no pasaron), en el
 * monitor (GET /indicadores) y en el Excel del «Control documental diario».
 * Reglas de La Mundial: nunca un login ni correo como emisor, nunca «vendedor», y los gestores
 * cuentan dentro de Canales.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../config/prisma', async () => {
  const { createFakePrisma } = await import('./test-utils/fake-prisma');
  return { default: createFakePrisma() };
});
vi.mock('../../utils/logger', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import prisma from '../../config/prisma';
import { _resetCatalogoCanales } from './expedientes.canales';
import { textoCifraPct } from './expedientes.cuadre';
import { textoEmisor } from './expedientes.domain';
import { COLUMNAS_EMISOR, filasResumen } from './expedientes.excel';
import {
  clasificacionOcr,
  contextoEmisor,
  EMISOR_SIN_IDENTIFICAR,
  rankingPorEmisor,
} from './expedientes.kpis';
import { cifrasControl } from './expedientes.reporte';
import { ExpedientesService } from './expedientes.service';

const db = prisma as any;
const svc = new ExpedientesService();

const nombres = {
  canal: new Map([
    ['27', 'OS_LMDS'],
    ['900', 'Farmatodo'],
  ]),
  gestorCanal: new Map([['749', '27']]),
};
const emisorDe = (r: any) => textoEmisor(r, nombres);

describe('rankingPorEmisor (puro)', () => {
  const rows = [
    // Canal 900 directo: 3 pólizas, 2 incompletas.
    {
      area: 'canal',
      centidad: 'C',
      ccanalalt: '900',
      estadoDocumental: 'incompleto',
    },
    {
      area: 'canal',
      centidad: 'C',
      ccanalalt: '900',
      estadoDocumental: 'incompleto',
    },
    {
      area: 'canal',
      centidad: 'C',
      ccanalalt: '900',
      estadoDocumental: 'completo',
    },
    // Gestor 749 del canal 27: su propia fila, en Canales (nunca un área aparte).
    {
      area: 'gestor',
      centidad: 'G',
      cgestor: '749',
      estadoDocumental: 'incompleto',
    },
    {
      area: 'gestor',
      centidad: 'G',
      cgestor: '749',
      estadoDocumental: 'sin_informacion',
    },
    // Productor 215.
    {
      area: 'productor',
      centidad: 'P',
      cproductor: '215',
      estadoDocumental: 'completo',
    },
    // Solo login / correo: nunca se muestra; va a «Emisor sin identificar».
    {
      area: 'desconocida',
      xlogin: 'agonzale@lam.com',
      estadoDocumental: 'incompleto',
    },
    {
      area: 'desconocida',
      cgestor: 'AGONZALE@LAM',
      estadoDocumental: 'completo',
    },
    // Descartada: no pasó por el OCR, no cuenta.
    {
      area: 'canal',
      centidad: 'C',
      ccanalalt: '900',
      estadoDocumental: 'descartada',
    },
  ];

  it('agrupa por el texto «Emitida por» de la bandeja, con contexto y % incompletas', () => {
    expect(rankingPorEmisor(rows, emisorDe)).toEqual([
      {
        emisor: 'Farmatodo (canal 900)',
        grupo: 'canal',
        contexto: 'Canal 900',
        total: 3,
        completos: 1,
        incompletos: 2,
        pctIncompletos: 0.6667,
      },
      // Empate en incompletas y total: orden alfabético.
      {
        emisor: EMISOR_SIN_IDENTIFICAR,
        grupo: null,
        contexto: null,
        total: 2,
        completos: 1,
        incompletos: 1,
        pctIncompletos: 0.5,
      },
      {
        emisor: 'OS_LMDS (canal 27-749)',
        grupo: 'canal',
        contexto: 'Canal 27',
        total: 2,
        completos: 0,
        incompletos: 1,
        pctIncompletos: 0.5,
      },
      {
        emisor: 'Productor 215',
        grupo: 'productor',
        contexto: 'Productor 215',
        total: 1,
        completos: 1,
        incompletos: 0,
        pctIncompletos: 0,
      },
    ]);
  });

  it('nunca muestra login, correo ni la palabra «vendedor»', () => {
    const json = JSON.stringify(rankingPorEmisor(rows, emisorDe));
    expect(json).not.toMatch(/@|agonzale/i);
    expect(json.toLowerCase()).not.toContain('vendedor');
    expect(json.toLowerCase()).not.toContain('gestor');
  });

  it('orden: incompletas desc, luego total; respeta el tope', () => {
    const muchos = Array.from({ length: 60 }, (_, i) => ({
      area: 'canal',
      centidad: 'C',
      ccanalalt: String(100 + i),
      estadoDocumental: i < 5 ? 'incompleto' : 'completo',
    }));
    const r = rankingPorEmisor(muchos, emisorDe);
    expect(r).toHaveLength(50);
    expect(r.slice(0, 5).every((x) => x.incompletos === 1)).toBe(true);
    expect(rankingPorEmisor(muchos, emisorDe, 3)).toHaveLength(3);
    // Empate en incompletas: gana el de más emitidas.
    const empate = rankingPorEmisor(
      [
        { area: 'canal', ccanalalt: '1', estadoDocumental: 'incompleto' },
        { area: 'canal', ccanalalt: '2', estadoDocumental: 'incompleto' },
        { area: 'canal', ccanalalt: '2', estadoDocumental: 'completo' },
      ],
      emisorDe,
    );
    expect(empate.map((x) => x.emisor)).toEqual(['Canal 2', 'Canal 1']);
  });

  it('contexto: canal o productor resuelto; nada si no se conoce', () => {
    expect(contextoEmisor({ texto: 'x', grupo: 'canal', canal: '27' })).toBe(
      'Canal 27',
    );
    expect(
      contextoEmisor({
        texto: 'x',
        grupo: 'productor',
        canal: null,
        productor: '80080',
      }),
    ).toBe('Productor 80080');
    expect(
      contextoEmisor({ texto: null, grupo: null, canal: null }),
    ).toBeNull();
    // Gestor compuesto de un productor («80080-1219»): cuenta en Productores.
    const [g] = rankingPorEmisor(
      [
        {
          area: 'gestor',
          centidad: 'P',
          cgestor: '80080-1219',
          estadoDocumental: 'incompleto',
        },
      ],
      emisorDe,
    );
    expect(g).toMatchObject({
      grupo: 'productor',
      contexto: 'Productor 80080',
    });
  });
});

describe('clasificación por OCR', () => {
  it('pasaron / no pasaron con porcentajes; sin pólizas, porcentajes null', () => {
    expect(clasificacionOcr(8, 2)).toEqual({
      pasaron: 8,
      noPasaron: 2,
      total: 10,
      pctPasaron: 0.8,
      pctNoPasaron: 0.2,
    });
    expect(clasificacionOcr(0, 0)).toEqual({
      pasaron: 0,
      noPasaron: 0,
      total: 0,
      pctPasaron: null,
      pctNoPasaron: null,
    });
  });

  it('texto con cifra y porcentaje', () => {
    expect(textoCifraPct(8, 0.8889)).toBe('8 (88,9 %)');
    expect(textoCifraPct(1, 1)).toBe('1 (100,0 %)');
    expect(textoCifraPct(0, null)).toBe('0');
  });
});

describe('Excel: hoja «Por emisor» y filas del Resumen', () => {
  it('encabezados «Emitida por», sin «vendedor»', () => {
    expect(COLUMNAS_EMISOR.map((c) => c.header)).toEqual([
      'Emitida por',
      'Canal/Productor',
      'Emitidas',
      'Completas',
      'Incompletas',
      '% incompletas',
    ]);
    expect(
      COLUMNAS_EMISOR.map((c) =>
        c.valor({
          emisor: EMISOR_SIN_IDENTIFICAR,
          grupo: null,
          contexto: null,
          total: 2,
          completos: 1,
          incompletos: 1,
          pctIncompletos: 0.5,
        }),
      ),
    ).toEqual([EMISOR_SIN_IDENTIFICAR, '', 2, 1, 1, 0.5]);
    expect(
      JSON.stringify(COLUMNAS_EMISOR.map((c) => c.header)).toLowerCase(),
    ).not.toContain('vendedor');
  });

  it('Resumen: «Pasaron por el OCR» y «No pasaron por el OCR» solo si hay cifras de OCR', () => {
    const base = cifrasControl([
      { area: 'canal', estadoDocumental: 'completo' },
    ]);
    expect(filasResumen(base).map((f) => f[0])).not.toContain(
      'Pasaron por el OCR',
    );
    const conOcr = filasResumen({ ...base, ocr: clasificacionOcr(3, 1) });
    expect(conOcr.slice(-2)).toEqual([
      ['Pasaron por el OCR', '3 (75,0 %)'],
      ['No pasaron por el OCR', '1 (25,0 %)'],
    ]);
  });
});

describe('GET /indicadores: porEmisor y ocr', () => {
  let n = 0;
  const exp = (over: Record<string, any> = {}) => {
    n++;
    return db.mktExpediente.create({
      data: {
        empresaId: 7,
        cnpoliza: `E-${n}`,
        producto: 'rcv',
        area: 'canal',
        emitidaEn: new Date('2026-11-10T15:00:00Z'),
        ...over,
      },
    });
  };

  beforeEach(() => {
    db.$reset();
    n = 0;
    process.env.EXPEDIENTES_ENABLED = 'true';
    _resetCatalogoCanales({
      nombres: nombres.canal,
      gestorCanal: nombres.gestorCanal,
      canales: [],
    });
  });

  it('mismos filtros que el resto (área, fechas) y excluye descartadas', async () => {
    await exp({
      centidad: 'C',
      ccanalalt: '900',
      estadoDocumental: 'incompleto',
    });
    await exp({
      centidad: 'C',
      ccanalalt: '900',
      estadoDocumental: 'completo',
    });
    await exp({
      area: 'gestor',
      centidad: 'G',
      cgestor: '749',
      estadoDocumental: 'incompleto',
    });
    await exp({
      xlogin: 'alguien@ejemplo.com',
      estadoDocumental: 'sin_informacion',
    });
    await exp({
      centidad: 'C',
      ccanalalt: '900',
      estadoDocumental: 'descartada',
    });
    // Fuera del rango de fechas.
    await exp({
      centidad: 'C',
      ccanalalt: '27',
      estadoDocumental: 'incompleto',
      emitidaEn: new Date('2026-01-10T15:00:00Z'),
    });

    const ind = await svc.indicadores({
      desde: '2026-11-01',
      hasta: '2026-11-30',
    });
    expect(ind.ocr).toEqual({
      pasaron: 4,
      noPasaron: 1,
      total: 5,
      pctPasaron: 0.8,
      pctNoPasaron: 0.2,
    });
    expect(ind.ocr.noPasaron).toBe(ind.descartadas);
    expect(ind.porEmisor).toEqual([
      {
        emisor: 'Farmatodo (canal 900)',
        grupo: 'canal',
        contexto: 'Canal 900',
        total: 2,
        completos: 1,
        incompletos: 1,
        pctIncompletos: 0.5,
      },
      {
        emisor: 'OS_LMDS (canal 27-749)',
        grupo: 'canal',
        contexto: 'Canal 27',
        total: 1,
        completos: 0,
        incompletos: 1,
        pctIncompletos: 1,
      },
      {
        emisor: EMISOR_SIN_IDENTIFICAR,
        grupo: null,
        contexto: null,
        total: 1,
        completos: 0,
        incompletos: 0,
        pctIncompletos: 0,
      },
    ]);
    expect(JSON.stringify(ind.porEmisor)).not.toContain('@');

    // Sin fechas: entra la de enero (canal 27).
    const todo = await svc.indicadores({});
    expect(todo.porEmisor.map((x) => x.emisor)).toContain('OS_LMDS (canal 27)');
    expect(todo.ocr.pasaron).toBe(5);
  });
});
