import { beforeEach, describe, expect, it, vi } from 'vitest';
import jwt from 'jsonwebtoken';
import {
  AuthController,
  mergeSsoMetadata,
  ssoMetadataSchema,
} from './auth.controller';

/**
 * Flujo de cotización de SysIP en el sso-delegate: `cotizacionID` y `cdepartamento` llegan a la metadata
 * firmada y, con cotización válida, el target ocr/vacío abre Emisión. Sin cotización todo queda igual.
 */

const TENANT_SECRET = 'test-tenant-secret-0123456789-abcdef';

vi.mock('../../config/env', () => ({
  env: { TENANT_TOKEN_SECRET: 'test-tenant-secret-0123456789-abcdef' },
}));
vi.mock('./auth.service', () => ({ AuthService: class {} }));
vi.mock('../../utils/logger', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

/** Submódulos activos de prueba: OCR (id 11) y Emisión (id 13). */
const SUBMODULOS = [
  {
    id: 11,
    url: 'https://cierrelmds.exelixitech.com/ocr/',
    nombre: 'OCR Documentos',
    modulo: { nombre: 'RCV' },
  },
  {
    id: 13,
    url: 'https://cierrelmds.exelixitech.com/emision/',
    nombre: 'Emisión',
    modulo: { nombre: 'RCV' },
  },
];

type SubFilter = { url?: { contains: string }; nombre?: { contains: string } };

vi.mock('../../config/prisma', () => ({
  default: {
    empresa: {
      findUnique: vi.fn(async () => ({ id: 5, nombre: 'SysIP', activo: true })),
    },
    submodulo: {
      findMany: vi.fn(async (args: { where: { OR: SubFilter[] } }) => {
        const hints = args.where.OR.map(
          (f) => f.url?.contains ?? f.nombre?.contains ?? '',
        );
        return SUBMODULOS.filter((s) =>
          hints.some((h) => h && (s.url.includes(h) || s.nombre.includes(h))),
        );
      }),
    },
    empresaSubmodulo: {
      findMany: vi.fn(async () =>
        SUBMODULOS.map((s) => ({ submoduloId: s.id })),
      ),
      findFirst: vi.fn(async () => ({ tenantToken: null, activo: true })),
      update: vi.fn(async () => ({})),
    },
  },
}));

type DelegateResult = { status: number; body: Record<string, unknown> };

async function delegate(
  body: Record<string, unknown>,
): Promise<DelegateResult> {
  const out: DelegateResult = { status: 200, body: {} };
  const res = {
    status(code: number) {
      out.status = code;
      return this;
    },
    json(payload: Record<string, unknown>) {
      out.body = payload;
      return this;
    },
  };
  const req = { body, headers: { 'x-api-key': 'k' } };
  await new AuthController().ssoDelegate(req as never, res as never);
  return out;
}

function tokenOf(redirectUrl: unknown) {
  const url = new URL(String(redirectUrl));
  const token =
    url.searchParams.get('nexus_token') ?? url.searchParams.get('token');
  expect(token).toBeTruthy();
  return jwt.verify(token!, TENANT_SECRET) as {
    submoduloId: number;
    metadata?: Record<string, unknown>;
  };
}

describe('ssoMetadataSchema: cotizacionID y cdepartamento', () => {
  it('conserva cotizacionID de dígitos (texto o número) y cdepartamento', () => {
    expect(
      ssoMetadataSchema.parse({
        cotizacionID: '202600310558',
        cdepartamento: 4,
      }),
    ).toMatchObject({
      cotizacionID: '202600310558',
      cdepartamento: '4',
    });
    expect(
      ssoMetadataSchema.parse({ cotizacionID: 202600310558 }).cotizacionID,
    ).toBe('202600310558');
    expect(
      ssoMetadataSchema.parse({ cotizacionID: ' 123 ' }).cotizacionID,
    ).toBe('123');
  });

  it('omite un cotizacionID inválido sin fallar', () => {
    for (const bad of [
      '',
      'abc',
      '12-34',
      '123456789012345678901',
      -5,
      1.5,
      {},
      null,
    ]) {
      const parsed = ssoMetadataSchema.safeParse({
        cotizacionID: bad,
        cproductor: 80080,
      });
      expect(parsed.success).toBe(true);
      expect(parsed.success && parsed.data.cotizacionID).toBeUndefined();
      expect(parsed.success && parsed.data.cproductor).toBe(80080);
    }
  });

  it('omite un cdepartamento demasiado largo sin fallar', () => {
    const parsed = ssoMetadataSchema.safeParse({
      cdepartamento: 'x'.repeat(30),
    });
    expect(parsed.success).toBe(true);
    expect(parsed.success && parsed.data.cdepartamento).toBeUndefined();
  });

  it('toma cotizacionID y cdepartamento también del root del body', () => {
    const merged = mergeSsoMetadata({
      target: 'ocr',
      cotizacionID: '77',
      cdepartamento: '11',
    });
    expect(merged).toMatchObject({ cotizacionID: '77', cdepartamento: '11' });
  });
});

describe('POST /api/auth/sso-delegate con cotización', () => {
  beforeEach(() => vi.clearAllMocks());

  it('sin cotizacionID abre OCR como siempre', async () => {
    const { status, body } = await delegate({
      target: 'ocr',
      metadata: { cproductor: 80080 },
    });
    expect(status).toBe(200);
    expect(body.modulo).toBe('OCR Documentos');
    const payload = tokenOf(body.redirect_url);
    expect(payload.submoduloId).toBe(11);
    expect(payload.metadata).not.toHaveProperty('cotizacionID');
  });

  it('con cotizacionID válido y target ocr abre OCR (igual que el RCV) con la cotización firmada en el token', async () => {
    const { status, body } = await delegate({
      target: 'ocr',
      metadata: {
        cproductor: 80080,
        cotizacionID: '202600310558',
        cdepartamento: '4',
        otraCosa: 'x',
      },
    });
    expect(status).toBe(200);
    expect(body.modulo).toBe('OCR Documentos');
    const payload = tokenOf(body.redirect_url);
    expect(payload.submoduloId).toBe(11);
    expect(payload.metadata).toMatchObject({
      cotizacionID: '202600310558',
      cdepartamento: '4',
      cproductor: 80080,
    });
    expect(payload.metadata).not.toHaveProperty('otraCosa');
  });

  it('target emision explícito con cotizacionID sigue abriendo Emisión', async () => {
    const { body } = await delegate({
      target: 'emision',
      metadata: { cotizacionID: '202600310558' },
    });
    expect(tokenOf(body.redirect_url).submoduloId).toBe(13);
  });

  it('con cotizacionID inválido sigue en OCR y no lo firma', async () => {
    const { status, body } = await delegate({
      target: 'ocr',
      metadata: { cotizacionID: 'ABC-1' },
    });
    expect(status).toBe(200);
    const payload = tokenOf(body.redirect_url);
    expect(payload.submoduloId).toBe(11);
    expect(payload.metadata).not.toHaveProperty('cotizacionID');
  });
});
