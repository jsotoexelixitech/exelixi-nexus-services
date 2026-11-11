/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * «Emitida por»: solo Canales y Productores. El gestor se muestra como su canal con el número
 * del gestor («Nombre (canal 27-749)»); nunca la palabra «gestor» ni «vendedor». El cusuario de
 * Sis2000 («Usuario 3391») queda solo como último recurso.
 */
import { describe, expect, it, vi } from 'vitest';

vi.mock('../../config/prisma', async () => {
  const { createFakePrisma } = await import('./test-utils/fake-prisma');
  return { default: createFakePrisma() };
});
vi.mock('../../utils/logger', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { esCodigoGestor, textoCanal, textoEmisor } from './expedientes.domain';
import { canalSinIdentificar, emitidaPor } from './expedientes.reporte';

const nombres = {
  canal: new Map([['27', 'OS_LMDS']]),
  gestor: new Map([['749', 'GUTIERREZ ARDILA, JORGE GREGORIO.']]),
  gestorCanal: new Map([['12', '27']]),
};
const texto = (e: any, n: any = nombres, s: any = {}) => textoEmisor(e, n, s).texto;

describe('textoEmisor', () => {
  it('canal alterno sin gestor: «Nombre (canal 27)» como hoy', () => {
    expect(texto({ centidad: 'C', citem: '27', ccanalalt: '27' })).toBe(
      'OS_LMDS (canal 27)',
    );
    expect(texto({ centidad: 'C', ccanalalt: '99' })).toBe('Canal 99');
  });

  it('gestor: el canal de la póliza con el número del gestor, no su nombre', () => {
    expect(texto({ centidad: 'G', cgestor: '749', ccanalalt: '27' })).toBe(
      'OS_LMDS (canal 27-749)',
    );
    expect(texto({ centidad: 'P', cgestor: '749', ccanalalt: '99' })).toBe(
      'Canal 99-749',
    );
  });

  it('gestor sin ccanalalt: el canal del catálogo de nest-api (magestor.ccanalalt)', () => {
    expect(texto({ centidad: 'G', cgestor: '12' })).toBe('OS_LMDS (canal 27-12)');
    expect(texto({ centidad: 'G', citem: '12' })).toBe('OS_LMDS (canal 27-12)');
    // Compuesto productor-gestor: el número del gestor es el último tramo.
    expect(texto({ cgestor: '348-12' })).toBe('OS_LMDS (canal 27-12)');
  });

  it('gestor sin canal por ninguna vía: «Canal sin identificar (-N)» y se marca', () => {
    const r = textoEmisor({ centidad: 'G', cgestor: '749' }, nombres);
    expect(r.texto).toBe('Canal sin identificar (-749)');
    expect(r.canalSinIdentificar).toBe(true);
    expect(texto({ cgestor: '736' }, null)).toBe('Canal sin identificar (-736)');
  });

  it('cgestor que es un login del SSO: canal si se deduce; si no, el login', () => {
    expect(esCodigoGestor('AGONZALE@LAM')).toBe(false);
    expect(esCodigoGestor('749')).toBe(true);
    expect(esCodigoGestor('348-342')).toBe(true);
    expect(
      texto({ centidad: 'P', cgestor: 'agonzale@lam', ccanalalt: '27' }),
    ).toBe('OS_LMDS (canal 27)');
    const r = textoEmisor({ centidad: 'P', cgestor: 'AGONZALE@LAM' }, nombres);
    expect(r.texto).toBe('AGONZALE@LAM');
    expect(r.canalSinIdentificar).toBe(true);
  });

  it('productor: sin cambios; con canal en la póliza, el canal primero', () => {
    expect(texto({ centidad: 'P', cproductor: '80080' }, null)).toBe(
      'Productor 80080',
    );
    expect(
      texto({ centidad: 'P', citem: '80081' }, null, { productor: 'CORRETAJE ABC' }),
    ).toBe('CORRETAJE ABC (productor 80081)');
    expect(
      texto({ area: 'productor', centidad: 'P', cproductor: '80080', ccanalalt: '27' }),
    ).toBe('OS_LMDS (canal 27) · Productor 80080');
  });

  it('sin actor: null (el caller decide el último recurso)', () => {
    expect(texto({})).toBeNull();
    expect(textoEmisor({}, nombres).canalSinIdentificar).toBe(false);
  });

  it('nunca la palabra «gestor» ni «vendedor»', () => {
    for (const e of [
      { centidad: 'G', cgestor: '749' },
      { centidad: 'G', cgestor: '12' },
      { cgestor: 'AGONZALE@LAM' },
      { centidad: 'C', ccanalalt: '27' },
    ])
      expect(String(texto(e))).not.toMatch(/gestor|vendedor/i);
  });

  it('textoCanal con y sin nombre', () => {
    expect(textoCanal('27', nombres)).toBe('OS_LMDS (canal 27)');
    expect(textoCanal('99', nombres)).toBe('Canal 99');
  });
});

describe('emitidaPor (reporte nocturno y Excel)', () => {
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
    gestorCanal: nombres.gestorCanal,
    gestorNombre: nombres.gestor,
  };

  it('gestor: su canal con el número del gestor, no «Usuario N» ni el nombre del gestor', () => {
    expect(
      emitidaPor({ ...base, area: 'gestor', centidad: 'G', cgestor: '12' }, catalogo),
    ).toBe('OS_LMDS (canal 27-12)');
    expect(
      emitidaPor({ ...base, area: 'gestor', centidad: 'G', cgestor: '749' }, catalogo),
    ).toBe('Canal sin identificar (-749)');
  });

  it('canal alterno: nombre y código', () => {
    expect(
      emitidaPor({ ...base, area: 'canal', centidad: 'C', ccanalalt: '27' }, catalogo),
    ).toBe('OS_LMDS (canal 27)');
  });

  it('área desconocida con productor: «Productor N»', () => {
    expect(
      emitidaPor({ ...base, area: 'desconocida', cproductor: '80080' }, catalogo),
    ).toBe('Productor 80080');
  });

  it('sin actor: «Usuario N» como último recurso; nunca «vendedor»', () => {
    const t = emitidaPor({ ...base, area: 'desconocida' }, catalogo);
    expect(t).toBe('Usuario 3391');
    expect(t).not.toMatch(/vendedor/i);
  });

  it('canalSinIdentificar cuenta los gestores sin canal', () => {
    expect(
      canalSinIdentificar({ ...base, area: 'gestor', cgestor: '749' }, catalogo),
    ).toBe(true);
    expect(
      canalSinIdentificar({ ...base, area: 'gestor', cgestor: '12' }, catalogo),
    ).toBe(false);
  });
});
