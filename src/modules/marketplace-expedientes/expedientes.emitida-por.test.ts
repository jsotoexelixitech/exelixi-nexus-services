/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * «Emitida por»: gestor (con su canal) o productor antes que el cusuario de Sis2000
 * («Usuario 3391»), que queda solo como último recurso. Nunca la palabra «vendedor».
 */
import { describe, expect, it, vi } from 'vitest';

vi.mock('../../config/prisma', async () => {
  const { createFakePrisma } = await import('./test-utils/fake-prisma');
  return { default: createFakePrisma() };
});
vi.mock('../../utils/logger', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { textoActorEmisor, textoCanal } from './expedientes.domain';
import { emitidaPor } from './expedientes.reporte';

const nombres = {
  canal: new Map([['27', 'REPUESTOS LOS SAMANES']]),
  gestor: new Map([['12', 'PUNTO CENTRO']]),
  gestorCanal: new Map([['12', '27']]),
};

describe('textoActorEmisor', () => {
  it('gestor con nombre y canal del catálogo', () => {
    expect(textoActorEmisor({ centidad: 'G', cgestor: '12' }, nombres)).toBe(
      'PUNTO CENTRO (gestor 12) · REPUESTOS LOS SAMANES (canal 27)',
    );
  });

  it('gestor sin catálogo: código del gestor y canal de la póliza si vino', () => {
    expect(textoActorEmisor({ centidad: 'G', citem: '44' }, null)).toBe(
      'Gestor 44',
    );
    expect(
      textoActorEmisor({ cgestor: '44', ccanalalt: '27' }, null),
    ).toBe('Gestor 44 · Canal 27');
  });

  it('gestor con nombre en el snapshot cuando el catálogo no lo trae', () => {
    expect(
      textoActorEmisor({ centidad: 'G', cgestor: '50' }, nombres, {
        gestor: 'TAQUILLA ESTE',
      }),
    ).toBe('TAQUILLA ESTE (gestor 50)');
  });

  it('productor: código y nombre del snapshot si lo hay', () => {
    expect(textoActorEmisor({ centidad: 'P', cproductor: '80080' }, null)).toBe(
      'Productor 80080',
    );
    expect(
      textoActorEmisor({ centidad: 'P', citem: '80081' }, null, {
        productor: 'CORRETAJE ABC',
      }),
    ).toBe('CORRETAJE ABC (productor 80081)');
  });

  it('sin gestor ni productor: null (el caller decide el último recurso)', () => {
    expect(textoActorEmisor({ centidad: 'C', ccanalalt: '27' }, nombres)).toBeNull();
    expect(textoActorEmisor({}, nombres)).toBeNull();
  });

  it('textoCanal con y sin nombre', () => {
    expect(textoCanal('27', nombres)).toBe('REPUESTOS LOS SAMANES (canal 27)');
    expect(textoCanal('99', nombres)).toBe('Canal 99');
  });
});

describe('emitidaPor (reporte nocturno)', () => {
  const base = {
    centidad: null,
    citem: null,
    cgestor: null,
    ccanalalt: null,
    cproductor: null,
    xlogin: null,
    cusuario: '3391',
    snapshot: {},
  } as any;
  const catalogo = {
    nombres: nombres.canal,
    gestorCanal: new Map<string, string>(),
    gestorNombre: nombres.gestor,
  };

  it('gestor sin canal resuelto: el gestor, no «Usuario N»', () => {
    expect(
      emitidaPor(
        { ...base, area: 'gestor', centidad: 'G', cgestor: '12' },
        catalogo,
      ),
    ).toBe('PUNTO CENTRO (gestor 12)');
  });

  it('área desconocida con productor: «Productor N»', () => {
    expect(
      emitidaPor(
        { ...base, area: 'desconocida', cproductor: '80080' },
        catalogo,
      ),
    ).toBe('Productor 80080');
  });

  it('sin actor: «Usuario N» como último recurso; nunca «vendedor»', () => {
    const t = emitidaPor({ ...base, area: 'desconocida' }, catalogo);
    expect(t).toBe('Usuario 3391');
    expect(t).not.toMatch(/vendedor/i);
  });
});
