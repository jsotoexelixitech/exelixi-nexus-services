/* eslint-disable @typescript-eslint/no-explicit-any */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const SUBMODULOS = [
  { id: 17, url: 'https://nexusqa.exelixitech.com/ocr/', nombre: 'OCR Documentos', modulo: { nombre: 'RCV' } },
  { id: 40, url: 'https://endosos.exelixitech.com', nombre: 'Endosos ampliación de plan', modulo: { nombre: 'Endosos' } },
  { id: 41, url: 'https://nexusqa.exelixitech.com/cotizador-rc/', nombre: 'Cotizador RC', modulo: { nombre: 'Cotizador RC' } },
  // Producción: la URL del cotizador no lleva «cotizador-rc»; se encuentra por el nombre.
  { id: 42, url: 'https://cotizador.exelixitech.com/', nombre: 'Cotizador RC', modulo: { nombre: 'Cotizador RC' } },
];
let asignados = new Set<number>([17, 40]);

vi.mock('../../config/prisma', () => ({
  default: {
    submodulo: {
      findMany: vi.fn(async ({ where }: any) => {
        const or: any[] = where?.OR ?? [];
        const matches = (s: any) =>
          or.some((f) => {
            const n = f.nombre?.contains?.toLowerCase();
            const u = f.url?.contains?.toLowerCase();
            return (n && s.nombre.toLowerCase().includes(n)) || (u && s.url.toLowerCase().includes(u));
          });
        return SUBMODULOS.filter(matches);
      }),
    },
    empresaSubmodulo: {
      findMany: vi.fn(async ({ where }: any) =>
        (where.submoduloId.in as number[]).filter((id) => asignados.has(id)).map((submoduloId) => ({ submoduloId })),
      ),
    },
  },
}));
vi.mock('../../utils/logger', () => ({ default: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock('bcrypt', () => ({ default: { hash: vi.fn(), compare: vi.fn() }, hash: vi.fn(), compare: vi.fn() }));
vi.mock('../../config/env', () => ({
  env: { TENANT_TOKEN_SECRET: 'secreto-de-prueba-con-mas-de-32-caracteres', JWT_SECRET: 'jwt-de-prueba-123', NODE_ENV: 'test' },
}));
vi.mock('./auth.service', () => ({ AuthService: class {} }));

import { findSubmoduloForSsoTarget } from './auth.controller';

describe('sso-delegate: target que no es de la cadena (17-nov-2026)', () => {
  beforeEach(() => {
    asignados = new Set([17, 40]);
  });

  it('«endosos» abre su propio submódulo, no OCR', async () => {
    const r = await findSubmoduloForSsoTarget('endosos', { empresaId: 7 });
    expect(r?.id).toBe(40);
  });

  it('«endosos» sin submódulo asignado a la empresa: OCR como antes', async () => {
    asignados = new Set([17]);
    const r = await findSubmoduloForSsoTarget('endosos', { empresaId: 7 });
    expect(r?.id).toBe(17);
  });

  it('«cotizador-rc» abre el submódulo «Cotizador RC» por URL o, si la URL no lo dice, por nombre', async () => {
    asignados = new Set([17, 40, 41]);
    expect((await findSubmoduloForSsoTarget('cotizador-rc', { empresaId: 7 }))?.id).toBe(41);
    asignados = new Set([17, 42]);
    expect((await findSubmoduloForSsoTarget('cotizador-rc', { empresaId: 7 }))?.id).toBe(42);
    // Sin el submódulo asignado a la empresa: OCR como cualquier target desconocido.
    asignados = new Set([17]);
    expect((await findSubmoduloForSsoTarget('cotizador-rc', { empresaId: 7 }))?.id).toBe(17);
  });

  it('ocr y los alias de la cadena siguen abriendo OCR', async () => {
    for (const t of ['ocr', 'rcv', 'funerario', 'patrimoniales']) {
      const r = await findSubmoduloForSsoTarget(t, { empresaId: 7 });
      expect(r?.id).toBe(17);
    }
  });
});
