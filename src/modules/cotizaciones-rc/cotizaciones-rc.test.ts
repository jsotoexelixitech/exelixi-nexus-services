import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';

// Antes de importar la app: config/env valida las variables al cargarse.
vi.hoisted(() => {
  process.env.NODE_ENV = 'test';
  process.env.DATABASE_URL = 'postgresql://u:p@localhost:5432/test';
  process.env.JWT_SECRET = 'jwt-secret-de-prueba';
  process.env.API_KEY = 'api-key-de-prueba-con-mas-de-20-chars';
  process.env.ENCRYPTION_KEY = '12345678901234567890123456789012';
  process.env.TENANT_TOKEN_SECRET =
    'test-tenant-secret-con-al-menos-32-caracteres!!';
  process.env.COTIZACIONES_RC_EMPRESA_ID = '5';
  process.env.COTIZACIONES_RC_MODULO_GROUP_ID = '1';
  process.env.COTIZACIONES_RC_NOTIFY_BASE_URL = 'https://nexus.test/nexus-api';
});

vi.mock('bcrypt', () => {
  const stub = { hash: vi.fn(), compare: vi.fn(), genSalt: vi.fn() };
  return { default: stub, ...stub };
});
vi.mock('../../config/prisma', () => ({ default: {} }));
vi.mock('./cotizaciones-rc.repo');
vi.mock('./cotizaciones-rc.nest', async (orig) => ({
  ...(await orig<typeof import('./cotizaciones-rc.nest')>()),
  tasaBcv: vi.fn(),
  emitir: vi.fn(),
  cobrarRecibo: vi.fn(),
  descargarPdf: vi.fn(),
  enviarCorreo: vi.fn(),
}));
vi.mock('../flow/flow.service', () => ({
  startCheckoutLink: vi.fn(),
  startFlow: vi.fn(),
  startFlowFromToken: vi.fn(),
  getSession: vi.fn(),
  saveSession: vi.fn(),
  advanceSession: vi.fn(),
  navigateSession: vi.fn(),
}));

import app from '../../app';
import * as repo from './cotizaciones-rc.repo';
import * as nest from './cotizaciones-rc.nest';
import { startCheckoutLink } from '../flow/flow.service';
import {
  MAX_ADJUNTOS_BYTES,
  adjuntosQueCaben,
  alternativaDe,
  anexosDeCheckout,
  aRespuesta,
  armarCorreoPoliza,
  emisionDeOpcion,
  evaluarRegistros,
  generarCodigo,
  normalizarCodigo,
  pagoDeNotificacion,
  sha256,
  validarCotizacionNueva,
  type FilaCotizacion,
} from './cotizaciones-rc.domain';

const KEY = { 'x-api-key': process.env.API_KEY as string };
const CODIGO = 'RCG-2026-000123-7KQ4';
const TOKEN = 'token-del-intento';

const emision = (prima: number) => ({
  modo: 'cotizador',
  cotizador: 'rcg',
  cramo: 28,
  cplan: 'PBT1',
  apartamento: 1,
  prima_total: prima,
  coberturas: [{ ccober: '2801', suma: 10000, prima }],
});
const datos = {
  tomador: {
    nombre: 'ACME C.A.',
    tipoDoc: 'J',
    documento: '123456789',
    correo: 'a@acme.com',
  },
  moneda: 'USD',
  alternativas: [
    { opcion: 'I', limite: 10000, prima: 100 },
    { opcion: 'II', limite: 20000, prima: 180 },
    { opcion: 'III', limite: 30000, prima: 250 },
  ],
  emisiones: { I: emision(100), II: emision(180), III: emision(250) },
};
const intento = {
  tokenHash: sha256(TOKEN),
  opcion: 'II',
  prima: 180,
  moneda: 'USD',
  tasa: 100,
  totalVes: 18000,
  sid: '9',
  checkoutUrl: 'https://pagos.test/?sid=9',
  creadoEn: '2026-11-13T00:00:00.000Z',
};
const fila = (x: Partial<FilaCotizacion> = {}): FilaCotizacion => ({
  id: 123,
  codigo: CODIGO,
  producto: 'rcg',
  estado: 'cotizada',
  origen: 'cliente',
  tomadorNombre: 'ACME C.A.',
  tomadorDocumento: '123456789',
  tomadorCorreo: 'a@acme.com',
  moneda: 'USD',
  opcion: null,
  datos,
  pago: null,
  poliza: null,
  error: null,
  correoPoliza: null,
  expiraEn: new Date(Date.now() + 86_400_000),
  createdAt: new Date(),
  updatedAt: null,
  ...x,
});
const aviso = (payment: Record<string, unknown> = {}) => ({
  status: 'ok',
  paymentVerified: true,
  payment: {
    method: 'mobile',
    reference: '219551279300',
    amount: 18000,
    paidOn: '2026-11-13',
    bankCode: '0134',
    ...payment,
  },
});
const espera = () => new Promise((r) => setTimeout(r, 20));

beforeEach(() => {
  vi.resetAllMocks();
  delete process.env.COTIZACIONES_RC_VERIFICAR_PAGO;
  vi.mocked(repo.referenciaUsada).mockResolvedValue(false);
});

describe('cotizaciones-rc · dominio', () => {
  it('código correlativo con sufijo, y lo normaliza como lo escribe el cliente', () => {
    expect(generarCodigo('rcg', 2026, 123, '7KQ4')).toBe(CODIGO);
    expect(normalizarCodigo(' rcg-2026-000123-7kq4 ')).toBe(CODIGO);
    expect(normalizarCodigo('RCG-2026-000123')).toBeNull();
    expect(normalizarCodigo("x' OR 1=1")).toBeNull();
  });

  it('valida la cotización nueva', () => {
    expect(validarCotizacionNueva({ producto: 'rcg', datos })).toMatchObject({
      producto: 'rcg',
      tomadorNombre: 'ACME C.A.',
      tomadorDocumento: '123456789',
      moneda: 'USD',
      origen: 'admin',
    });
    expect(() => validarCotizacionNueva({ producto: 'auto', datos })).toThrow(
      /producto/,
    );
    expect(() =>
      validarCotizacionNueva({
        producto: 'rcg',
        datos: { ...datos, alternativas: [] },
      }),
    ).toThrow(/alternativas/);
    expect(() =>
      validarCotizacionNueva({
        producto: 'rcg',
        datos: { ...datos, tomador: {} },
      }),
    ).toThrow(/tomador/);
  });

  it('solo emite la opción con datos de prima informada y la misma prima', () => {
    expect(emisionDeOpcion(datos, alternativaDe(datos, 'II')).prima_total).toBe(
      180,
    );
    expect(() => alternativaDe(datos, 'IV')).toThrow(/opción/);
    expect(() =>
      emisionDeOpcion({ ...datos, emisiones: {} }, alternativaDe(datos, 'I')),
    ).toThrow(/pago en línea/);
    const barata = { ...datos, emisiones: { I: emision(1) } };
    expect(() => emisionDeOpcion(barata, alternativaDe(datos, 'I'))).toThrow(
      /no coincide/,
    );
    const otroRamo = {
      ...datos,
      emisiones: { I: { ...emision(100), cramo: 18 } },
    };
    expect(() => emisionDeOpcion(otroRamo, alternativaDe(datos, 'I'))).toThrow(
      /prima informada/,
    );
  });

  it('verifica el pago como nest-api: SyPago solo en ACCP y monto dentro de la tolerancia', () => {
    expect(evaluarRegistros([], 100)).toEqual({
      verified: false,
      reason: 'not_found',
    });
    expect(
      evaluarRegistros(
        [{ proveedor: 'sypago', estado: 'PEND', monto: 100 }],
        100,
      ).reason,
    ).toBe('pending');
    expect(
      evaluarRegistros(
        [{ proveedor: 'sypago', estado: 'ACCP', monto: 100 }],
        100,
      ).verified,
    ).toBe(true);
    expect(
      evaluarRegistros(
        [{ proveedor: 'bancamiga', estado: null, monto: 50 }],
        100,
      ).reason,
    ).toBe('amount_mismatch');
  });

  it('arma el pago del aviso y nunca expone los tokens', () => {
    expect(pagoDeNotificacion(aviso())).toMatchObject({
      referencia: '219551279300',
      monto: 18000,
      fecha: '2026-11-13',
      detalle: { cbanco_ref: '0134' },
    });
    expect(() => pagoDeNotificacion({ payment: { amount: 5 } })).toThrow(
      /referencia/,
    );
    const r = aRespuesta(
      fila({ estado: 'pendiente_pago', pago: { intentos: [intento] } }),
    );
    expect(JSON.stringify(r)).not.toContain(intento.tokenHash);
    expect(r.pago).toMatchObject({ opcion: 'II', totalVes: 18000 });
  });
});

describe('cotizaciones-rc · rutas', () => {
  it('exige x-api-key salvo en el aviso de pago', async () => {
    expect(
      (await request(app).get(`/api/cotizaciones-rc/${CODIGO}`)).status,
    ).toBe(403);
    expect(
      (await request(app).post('/api/cotizaciones-rc').send({})).status,
    ).toBe(403);
    vi.mocked(repo.porCodigo).mockResolvedValue(
      fila({ estado: 'pendiente_pago', pago: { intentos: [intento] } }),
    );
    expect(
      (
        await request(app)
          .post(`/api/cotizaciones-rc/pago-callback/${CODIGO}?t=malo`)
          .send(aviso())
      ).status,
    ).toBe(403);
  });

  it('guarda la cotización; el origen lo marca el proxy, no el cuerpo', async () => {
    vi.mocked(repo.crear).mockResolvedValue(fila());
    const res = await request(app)
      .post('/api/cotizaciones-rc')
      .set(KEY)
      .set('x-cotizador-origen', 'cliente')
      .send({ producto: 'rcg', origen: 'admin', datos });
    expect(res.status).toBe(201);
    expect(res.body.data.codigo).toBe(CODIGO);
    expect(vi.mocked(repo.crear).mock.calls[0][0]).toMatchObject({
      origen: 'cliente',
      producto: 'rcg',
    });
  });

  it('404 si no existe, 410 si venció y 400 con un código mal escrito', async () => {
    vi.mocked(repo.porCodigo).mockResolvedValueOnce(null);
    expect(
      (await request(app).get(`/api/cotizaciones-rc/${CODIGO}`).set(KEY))
        .status,
    ).toBe(404);
    vi.mocked(repo.porCodigo).mockResolvedValueOnce(
      fila({ expiraEn: new Date(Date.now() - 1000) }),
    );
    const vencida = await request(app)
      .get(`/api/cotizaciones-rc/${CODIGO}`)
      .set(KEY);
    expect(vencida.status).toBe(410);
    expect(vencida.body.message).toMatch(/venció/);
    expect(
      (await request(app).get('/api/cotizaciones-rc/RCG-1').set(KEY)).status,
    ).toBe(400);
    // El canal sí consulta el historial vencido.
    vi.mocked(repo.porCodigo).mockResolvedValueOnce(
      fila({ expiraEn: new Date(Date.now() - 1000) }),
    );
    const admin = await request(app)
      .get(`/api/cotizaciones-rc/${CODIGO}?admin=1`)
      .set(KEY);
    expect(admin.status).toBe(200);
    expect(admin.body.data.vencida).toBe(true);
  });

  it('manda a pagar por la prima de la opción a la tasa del día', async () => {
    vi.mocked(repo.porCodigo).mockResolvedValue(fila());
    vi.mocked(nest.tasaBcv).mockResolvedValue(100);
    vi.mocked(startCheckoutLink).mockResolvedValue({
      sid: '9',
      checkoutUrl: 'https://pagos.test/?sid=9',
      pagosModule: { order: 4, nombre: 'Pagos' },
    });
    vi.mocked(repo.guardarCheckout).mockResolvedValue(true);
    const res = await request(app)
      .post(`/api/cotizaciones-rc/${CODIGO}/checkout`)
      .set(KEY)
      .send({
        opcion: 'II',
        returnUrl: 'https://cotizador.test/?vista=cliente',
      });
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({
      opcion: 'II',
      totalVes: 18000,
      tasa: 100,
      checkoutUrl: 'https://pagos.test/?sid=9',
    });
    const [empresa, grupo, patch] = vi.mocked(startCheckoutLink).mock
      .calls[0] as [number, number, any];
    expect([empresa, grupo]).toEqual([5, 1]);
    expect(patch.checkout.totalVes).toBe(18000);
    expect(patch.rules.requirePayment).toBe(true);
    expect(patch.payload.notifyUrl).toMatch(
      new RegExp(
        `^https://nexus\\.test/nexus-api/api/cotizaciones-rc/pago-callback/${CODIGO}\\?t=[0-9a-f]{48}$`,
      ),
    );
    expect(patch.payload.successUrl).toContain(`cotizacion=${CODIGO}`);
    const [, opcion, pago] = vi.mocked(repo.guardarCheckout).mock.calls[0] as [
      string,
      string,
      any,
    ];
    expect(opcion).toBe('II');
    expect(pago.intentos[0].tokenHash).toBe(
      sha256(patch.payload.notifyUrl.split('t=')[1]),
    );
  });

  it('no manda a pagar una cotización emitida ni una sin datos de emisión', async () => {
    vi.mocked(repo.porCodigo).mockResolvedValueOnce(
      fila({ estado: 'emitida' }),
    );
    expect(
      (
        await request(app)
          .post(`/api/cotizaciones-rc/${CODIGO}/checkout`)
          .set(KEY)
          .send({ opcion: 'I' })
      ).status,
    ).toBe(409);
    vi.mocked(repo.porCodigo).mockResolvedValueOnce(
      fila({ datos: { ...datos, emisiones: undefined } }),
    );
    expect(
      (
        await request(app)
          .post(`/api/cotizaciones-rc/${CODIGO}/checkout`)
          .set(KEY)
          .send({ opcion: 'I' })
      ).status,
    ).toBe(409);
    expect(startCheckoutLink).not.toHaveBeenCalled();
  });

  it('pago confirmado y verificado: emite con la opción pagada y cobra el recibo', async () => {
    vi.mocked(repo.porCodigo).mockResolvedValue(
      fila({
        estado: 'pendiente_pago',
        pago: {
          intentos: [intento],
          pagado: {
            referencia: '219551279300',
            monto: 18000,
            fecha: '2026-11-13',
            opcion: 'II',
            detalle: { cbanco_ref: '0134' },
          },
        },
      }),
    );
    vi.mocked(repo.registrosDePago).mockResolvedValue([
      { proveedor: 'bancamiga', estado: null, monto: 18000 },
    ]);
    vi.mocked(repo.marcarPagada).mockResolvedValue(true);
    vi.mocked(repo.reclamarEmision).mockResolvedValue(true);
    vi.mocked(nest.emitir).mockResolvedValue({
      cnpoliza: '28-1-0001',
      cnrecibo: '28-100',
      urlpoliza: 'https://pdf',
    });
    vi.mocked(nest.cobrarRecibo).mockResolvedValue({
      ingresoCaja: 'https://caja',
      transaccion: 77,
    });

    const res = await request(app)
      .post(`/api/cotizaciones-rc/pago-callback/${CODIGO}?t=${TOKEN}`)
      .send(aviso());
    expect(res.status).toBe(202);
    await espera();
    expect(vi.mocked(repo.marcarPagada).mock.calls[0][1]).toBe('II');
    expect(vi.mocked(nest.emitir).mock.calls[0][0]).toMatchObject({
      modo: 'cotizador',
      prima_total: 180,
      ncotizacion: CODIGO,
    });
    expect(vi.mocked(nest.cobrarRecibo).mock.calls[0][0]).toMatchObject({
      cnrecibo: '28-100',
      mpago: 18000,
      xreferencia: '219551279300',
      fpago: '2026-11-13',
      cbanco_ref: '0134',
    });
    expect(vi.mocked(repo.guardarPoliza).mock.calls[0][1]).toMatchObject({
      cnpoliza: '28-1-0001',
      cobro: { ok: true, ingresoCaja: 'https://caja' },
    });
  });

  it('no emite si el pago no está verificado en Pagos, si el monto no alcanza o si no hay pago', async () => {
    vi.mocked(repo.porCodigo).mockResolvedValue(
      fila({ estado: 'pendiente_pago', pago: { intentos: [intento] } }),
    );
    vi.mocked(repo.registrosDePago).mockResolvedValue([]);
    const url = `/api/cotizaciones-rc/pago-callback/${CODIGO}?t=${TOKEN}`;
    expect((await request(app).post(url).send(aviso())).status).toBe(409);
    expect(
      (
        await request(app)
          .post(url)
          .send(aviso({ amount: 100 }))
      ).status,
    ).toBe(400);
    const fallido = await request(app)
      .post(url)
      .send({ status: 'error', paymentVerified: false });
    expect(fallido.body.data.procesado).toBe(false);
    // BD de Pagos sin la tabla: en enforce tampoco se emite.
    vi.mocked(repo.registrosDePago).mockRejectedValue(
      new Error('relation "pagos.registros_pago" does not exist'),
    );
    expect((await request(app).post(url).send(aviso())).status).toBe(409);
    await espera();
    expect(repo.marcarPagada).not.toHaveBeenCalled();
    expect(nest.emitir).not.toHaveBeenCalled();
  });

  it('un aviso repetido no emite dos veces', async () => {
    vi.mocked(repo.porCodigo).mockResolvedValue(
      fila({ estado: 'pagada', pago: { intentos: [intento] } }),
    );
    const res = await request(app)
      .post(`/api/cotizaciones-rc/pago-callback/${CODIGO}?t=${TOKEN}`)
      .send(aviso());
    expect(res.status).toBe(200);
    expect(res.body.data.motivo).toBe('ya_procesado');
    await espera();
    expect(nest.emitir).not.toHaveBeenCalled();
  });

  it('póliza vigente con la misma unidad: prueba la siguiente; si la emisión falla queda pagada con el error', async () => {
    const pagada = fila({
      estado: 'pagada',
      pago: {
        intentos: [intento],
        pagado: {
          referencia: '1',
          monto: 18000,
          fecha: '2026-11-13',
          opcion: 'II',
          detalle: {},
        },
      },
    });
    vi.mocked(repo.porCodigo).mockResolvedValue(pagada);
    vi.mocked(repo.reclamarEmision).mockResolvedValue(true);
    vi.mocked(nest.emitir)
      .mockRejectedValueOnce(new nest.NestError('duplicada', 409))
      .mockResolvedValueOnce({ cnpoliza: 'P', cnrecibo: 'R', urlpoliza: '' });
    vi.mocked(nest.cobrarRecibo).mockRejectedValue(
      new Error('referencia ya usada'),
    );
    const res = await request(app)
      .post(`/api/cotizaciones-rc/${CODIGO}/reintentar`)
      .set(KEY);
    expect(res.status).toBe(200);
    expect(
      vi.mocked(nest.emitir).mock.calls.map((c) => c[0].apartamento),
    ).toEqual([1, 2]);
    expect(vi.mocked(repo.guardarPoliza).mock.calls[0][1]).toMatchObject({
      cnpoliza: 'P',
      cobro: { ok: false, error: 'referencia ya usada' },
    });

    vi.mocked(nest.emitir)
      .mockReset()
      .mockRejectedValue(new nest.NestError('Sis2000 caído', 500));
    await request(app)
      .post(`/api/cotizaciones-rc/${CODIGO}/reintentar`)
      .set(KEY);
    expect(vi.mocked(repo.guardarError).mock.calls[0]).toEqual([
      CODIGO,
      'Sis2000 caído',
    ]);
  });

  it('registra la emisión con recibo pendiente hecha por el canal y no acepta marcarla pagada', async () => {
    vi.mocked(repo.porCodigo).mockResolvedValue(fila());
    vi.mocked(repo.marcarEmitidaPendiente).mockResolvedValue(true);
    const ok = await request(app)
      .patch(`/api/cotizaciones-rc/${CODIGO}/estado`)
      .set(KEY)
      .send({
        estado: 'emitida',
        opcion: 'I',
        poliza: { cnpoliza: '28-1-9', cnrecibo: '28-9' },
      });
    expect(ok.status).toBe(200);
    expect(
      vi.mocked(repo.marcarEmitidaPendiente).mock.calls[0][2],
    ).toMatchObject({
      cnpoliza: '28-1-9',
      cobro: { ok: false, pendiente: true },
    });
    expect(
      (
        await request(app)
          .patch(`/api/cotizaciones-rc/${CODIGO}/estado`)
          .set(KEY)
          .send({ estado: 'pagada' })
      ).status,
    ).toBe(400);
  });

  it('lista sin el JSON completo, con filtros saneados: vigentes por defecto y el historial completo a pedido', async () => {
    vi.mocked(repo.listar).mockResolvedValue([fila({ datos: null })]);
    const res = await request(app)
      .get(
        '/api/cotizaciones-rc?codigo=rcg-2026&q=acme&desde=2026-11-01&hasta=ayer',
      )
      .set(KEY);
    expect(res.status).toBe(200);
    expect(res.body.data[0]).not.toHaveProperty('datos');
    expect(vi.mocked(repo.listar).mock.calls[0][0]).toEqual({
      codigo: 'RCG-2026',
      texto: 'acme',
      estado: null,
      vigencia: 'vigentes',
      desde: '2026-11-01',
      hasta: null,
    });
    await request(app).get('/api/cotizaciones-rc?estado=vencida').set(KEY);
    expect(vi.mocked(repo.listar).mock.calls[1][0]).toMatchObject({
      estado: null,
      vigencia: 'vencidas',
    });
    await request(app)
      .get('/api/cotizaciones-rc?vigencia=todas&estado=emitida')
      .set(KEY);
    expect(vi.mocked(repo.listar).mock.calls[2][0]).toMatchObject({
      estado: 'emitida',
      vigencia: 'todas',
    });
  });
});

describe('cotizaciones-rc · correo automático de la póliza', () => {
  const PDF = Buffer.from('%PDF-1.7 anexos');
  const POLIZA_PDF = new Uint8Array(Buffer.from('%PDF-1.7 poliza'));
  const pagado = {
    referencia: '219551279300',
    monto: 18000,
    fecha: '2026-11-13',
    opcion: 'II',
    detalle: {},
  };
  const emitida = (x: Partial<FilaCotizacion> = {}) =>
    fila({
      estado: 'emitida',
      opcion: 'II',
      pago: { intentos: [intento], pagado },
      poliza: {
        cnpoliza: '28-1-1100018992',
        cnrecibo: '900',
        urlpoliza: 'https://sis.test/p.pdf',
        cobro: { ok: true },
      },
      ...x,
    });

  it('acepta solo un PDF dentro del tope como anexos del checkout', () => {
    expect(
      anexosDeCheckout({
        nombre: 'Condicionado y anexos <RCG>',
        base64: PDF.toString('base64'),
      }),
    ).toEqual({ nombre: 'Condicionado y anexos _RCG_.pdf', pdf: PDF });
    expect(anexosDeCheckout(undefined)).toBeNull();
    expect(
      anexosDeCheckout({ base64: Buffer.from('<html>').toString('base64') }),
    ).toBeNull();
    expect(
      anexosDeCheckout({ base64: 'A'.repeat(MAX_ADJUNTOS_BYTES * 2) }),
    ).toBeNull();
  });

  it('si los adjuntos pasan del tope sale sin el PDF de la póliza (queda el enlace)', () => {
    const poliza = { nombre: 'Poliza.pdf', pdf: new Uint8Array(6) };
    const recibo = { nombre: 'Recibo.pdf', pdf: new Uint8Array(2) };
    const anexos = { nombre: 'Anexos.pdf', pdf: new Uint8Array(6) };
    expect(adjuntosQueCaben({ poliza, recibo, anexos }, 14)).toEqual({
      adjuntos: [poliza, recibo, anexos],
      sinPdfPoliza: false,
      total: 14,
    });
    // Prioridad: anexos, póliza y recibo.
    expect(adjuntosQueCaben({ poliza, recibo, anexos }, 12)).toMatchObject({
      adjuntos: [poliza, anexos],
      sinPdfPoliza: false,
    });
    expect(adjuntosQueCaben({ poliza, recibo, anexos }, 10)).toMatchObject({
      adjuntos: [recibo, anexos],
      sinPdfPoliza: true,
    });
    expect(adjuntosQueCaben({ poliza }, 10)).toMatchObject({
      adjuntos: [poliza],
      sinPdfPoliza: false,
    });
    expect(adjuntosQueCaben({}, 10)).toEqual({
      adjuntos: [],
      sinPdfPoliza: true,
      total: 0,
    });
  });

  it('arma el correo branded con el botón «Ver mi póliza» y los adjuntos, sin el enlace como dato suelto', () => {
    const body = armarCorreoPoliza(
      fila({ datos: { ...datos, nombreProducto: 'RC General' } }),
      {
        cnpoliza: '28-1-1',
        cnrecibo: '900',
        urlpoliza: 'https://sis.test/p.pdf',
      },
      180,
      [{ nombre: 'Poliza_28-1-1.pdf', pdf: POLIZA_PDF }],
      false,
    ) as {
      to: string;
      template: string;
      data: Record<string, string>;
      fields: { label: string; value: string }[];
      attachments: { filename: string; contentBase64: string }[];
    };
    expect(body.to).toBe('a@acme.com');
    expect(body.template).toBe('branded');
    expect(body.data).toMatchObject({
      subject: 'La Mundial de Seguros | Póliza N.º 28-1-1',
      ctaLabel: 'Ver mi póliza',
      ctaUrl: 'https://sis.test/p.pdf',
    });
    expect(body.fields.map((f) => f.label)).toEqual([
      'Póliza',
      'Producto',
      'Prima total',
      'Recibo',
    ]);
    expect(body.fields[1].value).toBe('RC General');
    expect(JSON.stringify(body.fields)).not.toContain('sis.test');
    expect(body.attachments).toEqual([
      {
        filename: 'Poliza_28-1-1.pdf',
        contentBase64: Buffer.from(POLIZA_PDF).toString('base64'),
        contentType: 'application/pdf',
      },
    ]);
  });

  it('el checkout guarda el PDF de anexos de la opción; uno inválido no frena el pago', async () => {
    vi.mocked(repo.porCodigo).mockResolvedValue(fila());
    vi.mocked(nest.tasaBcv).mockResolvedValue(100);
    vi.mocked(startCheckoutLink).mockResolvedValue({
      sid: '9',
      checkoutUrl: 'https://pagos.test/?sid=9',
    } as never);
    vi.mocked(repo.guardarCheckout).mockResolvedValue(true);
    vi.mocked(repo.guardarAnexos).mockResolvedValue();
    const res = await request(app)
      .post(`/api/cotizaciones-rc/${CODIGO}/checkout`)
      .set(KEY)
      .send({
        opcion: 'II',
        anexos: { nombre: 'Anexos.pdf', base64: PDF.toString('base64') },
      });
    expect(res.status).toBe(200);
    expect(vi.mocked(repo.guardarAnexos).mock.calls[0]).toEqual([
      CODIGO,
      'II',
      'Anexos.pdf',
      PDF,
    ]);

    vi.mocked(repo.guardarAnexos).mockClear();
    const sinPdf = await request(app)
      .post(`/api/cotizaciones-rc/${CODIGO}/checkout`)
      .set(KEY)
      .send({ opcion: 'II', anexos: { base64: 'bm8gZXMgcGRm' } });
    expect(sinPdf.status).toBe(200);
    expect(repo.guardarAnexos).not.toHaveBeenCalled();
  });

  it('el checkout acepta un cuerpo de varios MB (anexos en base64) solo con la API key', async () => {
    vi.mocked(repo.porCodigo).mockResolvedValue(fila());
    vi.mocked(nest.tasaBcv).mockResolvedValue(100);
    vi.mocked(startCheckoutLink).mockResolvedValue({
      sid: '9',
      checkoutUrl: 'https://pagos.test/?sid=9',
    } as never);
    vi.mocked(repo.guardarCheckout).mockResolvedValue(true);
    vi.mocked(repo.guardarAnexos).mockResolvedValue();
    const grande = Buffer.concat([PDF, Buffer.alloc(3 * 1024 * 1024, 32)]);
    const cuerpo = {
      opcion: 'II',
      anexos: { nombre: 'Anexos.pdf', base64: grande.toString('base64') },
    };
    // Sin la key no se llega a leer el cuerpo.
    const sinKey = await request(app)
      .post(`/api/cotizaciones-rc/${CODIGO}/checkout`)
      .send({ opcion: 'II' });
    expect(sinKey.status).toBe(403);
    const res = await request(app)
      .post(`/api/cotizaciones-rc/${CODIGO}/checkout`)
      .set(KEY)
      .send(cuerpo);
    expect(res.status).toBe(200);
    expect(vi.mocked(repo.guardarAnexos).mock.calls[0][3]).toHaveLength(
      grande.length,
    );
  });

  it('al emitir la pagada envía una vez el correo con la póliza y los anexos y deja el envío registrado', async () => {
    const pagada = fila({
      estado: 'pagada',
      pago: { intentos: [intento], pagado },
    });
    vi.mocked(repo.porCodigo)
      .mockResolvedValueOnce(pagada) // reintentar → obtener
      .mockResolvedValueOnce(pagada) // emitirPagada
      .mockResolvedValue(
        emitida({
          poliza: {
            cnpoliza: '28-1-1100018992',
            cnrecibo: '900',
            urlpoliza: 'https://sis.test/p.pdf',
            cobro: {
              ok: true,
              ingresoCaja: 'https://sis.test/ingreso_caja/1/',
            },
          },
        }),
      );
    vi.mocked(repo.reclamarEmision).mockResolvedValue(true);
    vi.mocked(nest.emitir).mockResolvedValue({
      cnpoliza: '28-1-1100018992',
      cnrecibo: '900',
      urlpoliza: 'https://sis.test/p.pdf',
    });
    vi.mocked(nest.cobrarRecibo).mockResolvedValue({
      ingresoCaja: 'https://sis.test/ingreso_caja/1/',
      transaccion: 1,
    });
    vi.mocked(repo.reclamarCorreoPoliza).mockResolvedValue(true);
    vi.mocked(repo.anexosDe).mockResolvedValue({
      nombre: 'Condicionado_y_anexos.pdf',
      pdf: PDF,
    });
    vi.mocked(nest.descargarPdf).mockResolvedValue(POLIZA_PDF);
    vi.mocked(nest.enviarCorreo).mockResolvedValue({ sent: true });

    const res = await request(app)
      .post(`/api/cotizaciones-rc/${CODIGO}/reintentar`)
      .set(KEY);
    expect(res.status).toBe(200);
    expect(vi.mocked(repo.anexosDe).mock.calls[0]).toEqual([CODIGO, 'II']);
    expect(nest.enviarCorreo).toHaveBeenCalledTimes(1);
    const body = vi.mocked(nest.enviarCorreo).mock.calls[0][0] as {
      to: string;
      attachments: { filename: string }[];
    };
    expect(body.to).toBe('a@acme.com');
    expect(vi.mocked(nest.descargarPdf).mock.calls.map((c) => c[0])).toEqual([
      'https://sis.test/p.pdf',
      'https://sis.test/ingreso_caja/1/',
    ]);
    expect(body.attachments.map((x) => x.filename)).toEqual([
      'Poliza_28-1-1100018992.pdf',
      'Recibo_900.pdf',
      'Condicionado_y_anexos.pdf',
    ]);
    expect(vi.mocked(repo.guardarCorreoPoliza).mock.calls[0][1]).toMatchObject({
      a: 'a@acme.com',
      enviadoEn: expect.any(String),
      adjuntos: [
        'Poliza_28-1-1100018992.pdf',
        'Recibo_900.pdf',
        'Condicionado_y_anexos.pdf',
      ],
    });
  });

  it('si el correo falla la póliza sigue emitida y el error queda registrado; sin PDF de póliza va solo el enlace', async () => {
    vi.mocked(repo.porCodigo).mockResolvedValue(emitida());
    vi.mocked(repo.reclamarCorreoPoliza).mockResolvedValue(true);
    vi.mocked(repo.anexosDe).mockResolvedValue(null);
    vi.mocked(nest.descargarPdf).mockResolvedValue(null);
    vi.mocked(nest.enviarCorreo).mockResolvedValue({
      sent: false,
      error: 'SMTP caído',
    });
    const res = await request(app)
      .post(`/api/cotizaciones-rc/${CODIGO}/reintentar`)
      .set(KEY);
    expect(res.status).toBe(200);
    expect(res.body.data.estado).toBe('emitida');
    const body = vi.mocked(nest.enviarCorreo).mock.calls[0][0] as {
      attachments?: unknown;
      data: { ctaUrl: string };
    };
    expect(body.attachments).toBeUndefined();
    expect(body.data.ctaUrl).toBe('https://sis.test/p.pdf');
    expect(vi.mocked(repo.guardarCorreoPoliza).mock.calls[0][1]).toMatchObject({
      error: 'SMTP caído',
      a: 'a@acme.com',
    });
    expect(repo.guardarError).not.toHaveBeenCalled();
    expect(repo.guardarPoliza).not.toHaveBeenCalled();
  });

  it('no reenvía un correo ya enviado ni uno que otro proceso está enviando, y lo expone sin el reclamo interno', async () => {
    const enviada = emitida({
      correoPoliza: {
        enviadoEn: '2026-11-13T15:00:00.000Z',
        a: 'a@acme.com',
        enviandoEn: '2026-11-13T14:59:00.000Z',
      },
    });
    vi.mocked(repo.porCodigo).mockResolvedValue(enviada);
    const res = await request(app)
      .post(`/api/cotizaciones-rc/${CODIGO}/reintentar`)
      .set(KEY);
    expect(res.status).toBe(409);
    expect(repo.reclamarCorreoPoliza).not.toHaveBeenCalled();
    expect(aRespuesta(enviada).correoPoliza).toEqual({
      enviadoEn: '2026-11-13T15:00:00.000Z',
      a: 'a@acme.com',
      error: null,
    });
    expect(
      aRespuesta(emitida({ correoPoliza: { enviandoEn: 'x' } })).correoPoliza,
    ).toBeNull();

    // Reclamo perdido (otro envío en curso): no se manda nada.
    vi.mocked(repo.porCodigo).mockResolvedValue(emitida());
    vi.mocked(repo.reclamarCorreoPoliza).mockResolvedValue(false);
    await request(app)
      .post(`/api/cotizaciones-rc/${CODIGO}/reintentar`)
      .set(KEY);
    expect(nest.enviarCorreo).not.toHaveBeenCalled();
  });

  it('una emisión del canal sin pago no manda correo automático', async () => {
    vi.mocked(repo.porCodigo).mockResolvedValue(
      emitida({ pago: null, correoPoliza: null }),
    );
    const res = await request(app)
      .post(`/api/cotizaciones-rc/${CODIGO}/reintentar`)
      .set(KEY);
    expect(res.status).toBe(409);
    expect(nest.enviarCorreo).not.toHaveBeenCalled();
  });
});
