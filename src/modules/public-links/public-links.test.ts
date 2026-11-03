import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest';
import request from 'supertest';
import jwt from 'jsonwebtoken';

const TENANT_SECRET = 'test-tenant-secret-con-al-menos-32-caracteres!!';

process.env.NODE_ENV = 'test';
process.env.DATABASE_URL = 'postgresql://u:p@localhost:5432/test';
process.env.JWT_SECRET = 'jwt-secret-de-prueba';
process.env.API_KEY = 'api-key-de-prueba-con-mas-de-20-chars';
process.env.ENCRYPTION_KEY = '12345678901234567890123456789012';
process.env.TENANT_TOKEN_SECRET = TENANT_SECRET;

// bcrypt (nativo) no interviene en esta ruta; evita cargar el binario en CI/local.
vi.mock('bcrypt', () => {
  const stub = { hash: vi.fn(), compare: vi.fn(), genSalt: vi.fn() };
  return { default: stub, ...stub };
});

vi.mock('../../config/prisma', () => ({
  default: {
    empresa: {
      findUnique: vi.fn(async () => ({ id: 7, activo: true })),
    },
    empresaSubmodulo: {
      findFirst: vi.fn(async () => ({ activo: true, tenantToken: null })),
      findMany: vi.fn(async () => [{ submoduloId: 11 }]),
    },
    submodulo: {
      findMany: vi.fn(async () => [
        {
          id: 11,
          url: 'https://ocr.exelixitech.com/ocr/',
          nombre: 'OCR Documentos',
          modulo: { nombre: 'Personas' },
        },
      ]),
    },
  },
}));

const LINKS = {
  vida: {
    empresaId: 7,
    target: 'ocr',
    product: 'funerario',
    metadata: {
      cproducto: '76',
      xproducto: 'Póliza de Vida',
      cproductor: '80080',
      cusuario: '7',
      centidad: 'C',
      citem: '27',
      ccanalalt_in: '27',
    },
  },
};

let app: import('express').Express;

beforeAll(async () => {
  app = (await import('../../app')).default;
});

beforeEach(() => {
  process.env.NEXUS_LINKS_DIRECTOS = JSON.stringify(LINKS);
});

describe('GET /api/public/emitir/:slug', () => {
  it('slug válido → 302 con nexus_token firmado y metadata del servidor', async () => {
    const res = await request(app).get(
      '/api/public/emitir/vida?utm_source=lamundial&cproducto=99',
    );
    expect(res.status).toBe(302);
    const location = res.headers.location;
    expect(location).toMatch(/^https:\/\/ocr\.exelixitech\.com\/ocr\/\?/);
    expect(location).toContain('product=funerario');

    const token = new URL(location).searchParams.get('nexus_token');
    expect(token).toBeTruthy();
    const payload = jwt.verify(token!, TENANT_SECRET) as any;
    expect(payload.type).toBe('tenant_access');
    expect(payload.empresaId).toBe(7);
    expect(payload.submoduloId).toBe(11);
    expect(payload.metadata.cproducto).toBe('76'); // query del cliente ignorada
    expect(payload.metadata.product).toBe('funerario');
    expect(payload.exp - payload.iat).toBe(3600);
  });

  it('slug no listado → 404', async () => {
    const res = await request(app).get('/api/public/emitir/otro');
    expect(res.status).toBe(404);
    expect(res.body.success).toBe(false);
  });

  it('sin NEXUS_LINKS_DIRECTOS → 404', async () => {
    delete process.env.NEXUS_LINKS_DIRECTOS;
    const res = await request(app).get('/api/public/emitir/vida');
    expect(res.status).toBe(404);
  });

  it('env con JSON inválido → 404', async () => {
    process.env.NEXUS_LINKS_DIRECTOS = '{no-json';
    const res = await request(app).get('/api/public/emitir/vida');
    expect(res.status).toBe(404);
  });
});
