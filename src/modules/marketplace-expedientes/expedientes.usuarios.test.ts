/* eslint-disable @typescript-eslint/no-explicit-any */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import request from 'supertest';

vi.mock('../../config/env', () => ({
  env: {
    TENANT_TOKEN_SECRET: 'secreto-de-prueba-con-mas-de-32-caracteres',
    JWT_SECRET: 'jwt-de-prueba-123',
    NODE_ENV: 'test',
  },
}));
vi.mock('../../config/prisma', async () => {
  const { createFakePrisma } = await import('./test-utils/fake-prisma');
  const db: any = createFakePrisma();
  db.empresa = { findUnique: vi.fn() };
  db.usuario = { findUnique: vi.fn(), create: vi.fn(), update: vi.fn() };
  db.usuarioPortalPerfil = { upsert: vi.fn() };
  db.role = { findUnique: vi.fn() };
  return { default: db };
});
vi.mock('bcrypt', () => ({ default: { hash: vi.fn(async () => 'hash') } }));
vi.mock('../../utils/crypto', () => ({
  encrypt: (s: string) => s,
  decrypt: (s: string) => s,
}));
vi.mock('../../utils/logger', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
/** El JWT de la sesión viaja como JSON en Authorization: así se prueban sus claims. */
vi.mock('../../middlewares/auth.middleware', () => ({
  authenticate: (req: any, res: any, next: any) => {
    if (!req.headers.authorization)
      return res.status(401).json({ success: false });
    req.user = JSON.parse(String(req.headers.authorization).slice(7));
    next();
  },
}));
vi.mock('../portal/portal-admin.middleware', () => ({
  requirePortalAdmin: (_req: any, _res: any, next: any) => next(),
}));

import jwt from 'jsonwebtoken';
import prisma from '../../config/prisma';
import router from './expedientes.routes';
import { esSesionSso, identidadPermitida } from './expedientes.usuarios';
import { startPortalSsoSession } from '../portal/portal-sso-session.service';
import {
  generatePortalSsoToken,
  verifyPortalSsoToken,
} from '../../utils/tenant-token';
import { AuthController } from '../auth/auth.controller';

const db = prisma as any;
const app = express();
app.use(express.json());
app.use('/api/expedientes', router);

function auth(user: Record<string, unknown>) {
  return {
    Authorization: `Bearer ${JSON.stringify({
      id: 5,
      email: 'sso.x.c1@sis2000.portal',
      empresaId: 7,
      roleId: 1,
      ...user,
    })}`,
  };
}

const RUTAS_INTERNAS: [string, string][] = [
  ['get', '/api/expedientes'],
  ['get', '/api/expedientes/indicadores'],
  ['get', '/api/expedientes/1'],
  ['get', '/api/expedientes/config'],
  ['get', '/api/expedientes/exclusiones'],
  ['get', '/api/expedientes/ocr-por-canal?producto=rcv'],
  ['put', '/api/expedientes/ocr-por-canal'],
  ['post', '/api/expedientes/1/upload'],
];

function produccion() {
  process.env.NODE_ENV = 'production';
  process.env.EXPEDIENTES_ENTORNO = 'produccion';
}

beforeEach(() => {
  db.$reset();
  process.env.EXPEDIENTES_ENABLED = 'true';
  delete process.env.EXPEDIENTES_ENTORNO;
  delete process.env.EXPEDIENTES_ACCESO_LIBRE;
  delete process.env.EXPEDIENTES_USUARIOS;
  delete process.env.EXPEDIENTES_OCR_CANAL_ESCRITURA;
  process.env.NODE_ENV = 'test';
});

describe('lista de acceso EXPEDIENTES_USUARIOS', () => {
  it('producción sin lista: 403 en todas las rutas internas', async () => {
    produccion();
    for (const [m, url] of RUTAS_INTERNAS) {
      const r = await (request(app) as any)
        [m](url)
        .set(auth({ sisXlogin: 'luis' }));
      expect(r.status, `${m} ${url}`).toBe(403);
    }
  });

  it('NODE_ENV=production sin EXPEDIENTES_ENTORNO y sin lista: cerrado', async () => {
    process.env.NODE_ENV = 'production';
    const r = await request(app)
      .get('/api/expedientes')
      .set(auth({ sisXlogin: 'luis' }));
    expect(r.status).toBe(403);
    expect(r.body.message).toBe('No tiene acceso al monitor de expedientes.');
  });

  it('QA declarado sin lista: se conserva el acceso con cualquier sesión', async () => {
    process.env.NODE_ENV = 'production';
    process.env.EXPEDIENTES_ENTORNO = 'qa';
    const r = await request(app).get('/api/expedientes').set(auth({}));
    expect(r.status).toBe(200);
  });

  it('con lista: entra el xlogin de Sis2000 sin distinguir mayúsculas; otro no', async () => {
    produccion();
    process.env.EXPEDIENTES_USUARIOS = ' LPerez , yennifer@lamundial.test ';
    expect(
      (
        await request(app)
          .get('/api/expedientes')
          .set(auth({ sisXlogin: 'lperez' }))
      ).status,
    ).toBe(200);
    expect(
      (
        await request(app)
          .get('/api/expedientes')
          .set(auth({ sisXlogin: 'otro' }))
      ).status,
    ).toBe(403);
  });

  it('con lista: entra el correo del usuario Nexus o el correo Sis2000 del SSO', async () => {
    produccion();
    process.env.EXPEDIENTES_USUARIOS =
      'luis@exelixi.test,yennifer@lamundial.test';
    expect(
      (
        await request(app)
          .get('/api/expedientes')
          .set(auth({ email: 'Luis@Exelixi.test' }))
      ).status,
    ).toBe(200);
    expect(
      (
        await request(app)
          .get('/api/expedientes')
          .set(auth({ sisEmail: 'yennifer@lamundial.test' }))
      ).status,
    ).toBe(200);
  });

  it('login del portal con clave Sis2000: el correo espejo es el xlogin', async () => {
    produccion();
    process.env.EXPEDIENTES_USUARIOS = 'LPEREZ';
    const ok = await request(app)
      .get('/api/expedientes')
      .set(auth({ email: 'lperez@sis2000.portal' }));
    expect(ok.status).toBe(200);
    // Un correo SSO (sso.<login>.<canal>) no se interpreta por prefijo: necesita el claim.
    const sso = await request(app)
      .get('/api/expedientes')
      .set(auth({ email: 'sso.lperez.c1@sis2000.portal' }));
    expect(sso.status).toBe(403);
  });

  it('GET /acceso informa sin 403 y expone la escritura de OCR por canal', async () => {
    produccion();
    process.env.EXPEDIENTES_USUARIOS = 'lperez';
    const no = await request(app)
      .get('/api/expedientes/acceso')
      .set(auth({ sisXlogin: 'otro' }));
    expect(no.status).toBe(200);
    expect(no.body.data).toEqual({
      acceso: false,
      ocrPorCanalEscritura: false,
    });
    const si = await request(app)
      .get('/api/expedientes/acceso')
      .set(auth({ sisXlogin: 'LPEREZ' }));
    expect(si.body.data.acceso).toBe(true);
    expect((await request(app).get('/api/expedientes/acceso')).status).toBe(
      401,
    );
  });

  it('las rutas públicas del asegurado no piden lista ni sesión', async () => {
    produccion();
    const r = await request(app).get('/api/expedientes/publico/token-x');
    expect([401, 403]).not.toContain(r.status);
    const v = await request(app)
      .post('/api/expedientes/publico/verificar')
      .send({ tipoDoc: 'V', documento: '12345678' });
    expect(v.status).toBe(200);
  });

  it('identidadPermitida ignora vacíos', () => {
    process.env.EXPEDIENTES_USUARIOS = 'a';
    expect(identidadPermitida([null, undefined, '', '  '])).toBe(false);
    expect(identidadPermitida([' A '])).toBe(true);
  });
});

describe('OCR por canal en solo lectura', () => {
  it('PUT responde 403 con mensaje claro sin EXPEDIENTES_OCR_CANAL_ESCRITURA', async () => {
    const r = await request(app)
      .put('/api/expedientes/ocr-por-canal')
      // Sesión propia del portal (una SSO recibe antes el 403 de config sin SSO).
      .set(auth({ email: 'op@exelixi.test' }))
      .send({ producto: 'rcv', canales: [], motivo: 'x' });
    expect(r.status).toBe(403);
    expect(r.body.message).toMatch(/solo lectura/);
  });
});

describe('SSO monitor-expedientes', () => {
  function resMock() {
    const res: any = {};
    res.status = vi.fn(() => res);
    res.json = vi.fn(() => res);
    return res;
  }

  beforeEach(() => {
    db.empresa.findUnique.mockReset();
    db.usuario.findUnique.mockReset();
    db.usuario.create.mockReset();
    db.usuario.update.mockReset();
    db.usuarioPortalPerfil.upsert.mockReset();
    db.role.findUnique.mockReset();
    process.env.PORTAL_PUBLIC_URL = 'https://portal.test/';
    process.env.PORTAL_SIS2000_ROLE_ID = '1';
    db.empresa.findUnique.mockResolvedValue({
      id: 7,
      nombre: 'La Mundial',
      activo: true,
    });
  });

  async function delegar(body: Record<string, unknown>) {
    const res = resMock();
    await new AuthController().ssoDelegate(
      { body, headers: { 'x-api-key': 'k' } } as any,
      res,
    );
    return res;
  }

  it('sin canal/productor y en la lista (xlogin en la raíz o en metadata): redirige a /sso con next', async () => {
    produccion();
    process.env.EXPEDIENTES_USUARIOS = 'lperez';
    for (const body of [
      { target: 'monitor-expedientes', xlogin: 'LPEREZ', crol: 3 },
      {
        target: 'monitor-expedientes',
        metadata: { xlogin: 'lperez', cdepartamento: '9', xnombre: 'Luis' },
      },
    ]) {
      const res = await delegar(body);
      expect(res.status).not.toHaveBeenCalled();
      const out = res.json.mock.calls[0][0];
      expect(out.redirect_url).toMatch(
        /^https:\/\/portal\.test\/sso\?nexus_token=[^&]+&next=\/monitor-expedientes$/,
      );
      const token = new URL(out.redirect_url).searchParams.get('nexus_token')!;
      expect(verifyPortalSsoToken(token).destino).toBe('monitor-expedientes');
    }
  });

  it('fuera de la lista: 403 «No tiene acceso al monitor de expedientes»', async () => {
    produccion();
    process.env.EXPEDIENTES_USUARIOS = 'lperez';
    const res = await delegar({
      target: 'monitor-expedientes',
      xlogin: 'otro',
    });
    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.json.mock.calls[0][0].message).toBe(
      'No tiene acceso al monitor de expedientes.',
    );
  });

  it('producción con lista vacía: 403', async () => {
    produccion();
    const res = await delegar({ target: 'monitor-expedientes', xlogin: 'x' });
    expect(res.status).toHaveBeenCalledWith(403);
  });

  it('monitor apagado: 404', async () => {
    delete process.env.EXPEDIENTES_ENABLED;
    const res = await delegar({ target: 'monitor-expedientes', xlogin: 'x' });
    expect(res.status).toHaveBeenCalledWith(404);
  });

  it('la sesión del pase de monitor no exige canal, no guarda perfil y lleva el xlogin en el JWT', async () => {
    produccion();
    process.env.EXPEDIENTES_USUARIOS = 'lperez';
    db.usuario.findUnique.mockResolvedValue(null);
    db.usuario.create.mockImplementation(async ({ data }: any) => ({
      id: 11,
      activo: true,
      ...data,
    }));
    db.role.findUnique.mockResolvedValue({ nombre: 'Administrador' });
    const pase = generatePortalSsoToken(
      7,
      { xlogin: 'LPerez', xusuario: 'Luis Perez' },
      'monitor-expedientes',
    );
    const s = await startPortalSsoSession(pase);
    expect(db.usuario.create.mock.calls[0][0].data.email).toBe(
      'sso.lperez.monitor@sis2000.portal',
    );
    expect(db.usuarioPortalPerfil.upsert).not.toHaveBeenCalled();
    const claims = jwt.decode(s.token) as any;
    expect(claims.sisXlogin).toBe('LPerez');
    // El JWT del canje SSO se reconoce como sesión SSO (config solo lectura).
    expect(esSesionSso(claims)).toBe(true);
  });

  it('esSesionSso: correo espejo sso.* o claims Sis2000; login propio no', () => {
    const base = { id: 1, empresaId: 1, roleId: 1 };
    expect(
      esSesionSso({ ...base, email: 'sso.lperez.c900@sis2000.portal' }),
    ).toBe(true);
    expect(
      esSesionSso({ ...base, email: 'x@test', sisXusuario: 'Luis' } as any),
    ).toBe(true);
    // Login con clave Sis2000 (correo espejo sin «sso.») y login Nexus: no son SSO.
    expect(esSesionSso({ ...base, email: 'lperez@sis2000.portal' })).toBe(
      false,
    );
    expect(esSesionSso({ ...base, email: 'admin@exelixi.com' })).toBe(false);
    expect(esSesionSso(undefined)).toBe(false);
  });

  it('el pase de monitor se rechaza en la sesión si el usuario salió de la lista', async () => {
    produccion();
    process.env.EXPEDIENTES_USUARIOS = 'otro';
    const pase = generatePortalSsoToken(
      7,
      { xlogin: 'lperez' },
      'monitor-expedientes',
    );
    await expect(startPortalSsoSession(pase)).rejects.toMatchObject({
      statusCode: 403,
    });
  });

  it('el pase del marketplace sigue exigiendo canal o productor', async () => {
    const pase = generatePortalSsoToken(7, { xlogin: 'lperez' });
    await expect(startPortalSsoSession(pase)).rejects.toMatchObject({
      statusCode: 400,
    });
  });
});
